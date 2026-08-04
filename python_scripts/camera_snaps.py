"""Detector de saltos de cámara en un VOD de League of Legends.

Un salto de cámara (tecla de aliado) tiene que cumplir DOS cosas a la vez. Exigir
las dos es lo que separa un salto real de todo lo que se le parece:

1. **El rectángulo del viewport en el minimapa se teletransporta.** Es la señal
   principal, porque es literalmente dónde está mirando la cámara. Se mide
   comparando los píxeles blancos del minimapa entre dos muestras: los que
   *desaparecen* marcan de dónde venía el rectángulo y los que *aparecen*, adónde
   fue. La distancia entre ambos centroides es el tamaño del salto. Restar así
   cancela de forma exacta el blanco estático del minimapa (temporizadores,
   iconos, texto), que si no contaminaría la medida.

2. **La vista del mundo se rompe.** Se mide con correlación de fase: en un paneo
   suave existe UNA traslación que explica el cambio y la respuesta es alta; en un
   salto no la hay y se desploma.

Con una sola de las dos señales el detector se equivoca mucho, y se comprobó contra
footage real: los efectos de una pelea o un recall rompen la vista del mundo sin
mover la cámara (falso positivo de la señal 2), y el minimapa se mueve solo por
caminar si la cámara va enganchada al campeón (falso positivo de la señal 1).

Salida por stdout (JSON) y progreso por stderr como `PROGRESS:<pct>`, igual que
`analyzer.py`, para que el lado Rust pueda reutilizar el mismo lector.

Uso:
    camera_snaps.py <video> [directorio_de_stills]
"""

import cv2
import numpy as np
import sys
import json
import os


# ------------------ HELPERS DE ENTORNO ------------------
def _envf(name, default):
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _envi(name, default):
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _envb(name, default):
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() not in ("0", "", "false", "no", "off")


class Config:
    """Tunables. Todos por env con el prefijo VOD_SNAP_, como el resto del pipeline."""

    def __init__(self):
        # Muestreo: 10 fps basta. El salto dura 1 frame, pero la discontinuidad
        # entre dos muestras separadas 100 ms sigue siendo enorme.
        self.sample_fps = _envf("VOD_SNAP_FPS", 10.0)
        # Resolución de trabajo: minúscula a propósito. Buscamos un cambio global
        # de escena, no detalle, y así el análisis va en tiempo real.
        self.work_w = _envi("VOD_SNAP_W", 192)
        self.work_h = _envi("VOD_SNAP_H", 108)
        # Recorte vertical: fuera la barra superior (marcador) y el HUD inferior
        # con el minimapa, que cambian por su cuenta y ensucian la señal.
        self.crop_top = _envf("VOD_SNAP_CROP_TOP", 0.06)
        self.crop_bottom = _envf("VOD_SNAP_CROP_BOTTOM", 0.24)
        # Umbrales de decisión de la vista del mundo.
        self.mad_thresh = _envf("VOD_SNAP_MAD", 0.085)
        self.resp_thresh = _envf("VOD_SNAP_RESP", 0.30)
        # ROI del minimapa, en fracciones del frame (HUD de LoL por defecto).
        self.mm_x0 = _envf("VOD_SNAP_MM_X0", 0.787)
        self.mm_x1 = _envf("VOD_SNAP_MM_X1", 0.995)
        self.mm_y0 = _envf("VOD_SNAP_MM_Y0", 0.622)
        self.mm_y1 = _envf("VOD_SNAP_MM_Y1", 0.972)
        # Salto mínimo del viewport, como fracción del ancho del minimapa. Caminar
        # con la cámara enganchada mueve el rectángulo muy poco entre muestras.
        self.mm_jump = _envf("VOD_SNAP_MM_JUMP", 0.12)
        # Píxeles que como mínimo tienen que aparecer/desaparecer para fiarnos.
        self.mm_min_px = _envi("VOD_SNAP_MM_MIN_PX", 40)
        # Permite desactivar la confirmación por minimapa (p.ej. HUD no estándar).
        self.use_minimap = _envb("VOD_SNAP_USE_MINIMAP", True)
        # Dos muestras dentro de esta ventana son el mismo salto.
        self.min_gap = _envf("VOD_SNAP_MIN_GAP", 0.45)
        # Stills para el drill de lectura.
        self.stills = _envb("VOD_SNAP_STILLS", True)
        self.still_offset = _envf("VOD_SNAP_STILL_OFFSET", 0.25)
        self.still_width = _envi("VOD_SNAP_STILL_W", 960)
        self.still_quality = _envi("VOD_SNAP_STILL_Q", 82)
        self.max_stills = _envi("VOD_SNAP_MAX_STILLS", 150)


def _prep(frame, cfg, hann):
    """Recorta el HUD, pasa a gris, reduce y aplica la ventana de Hann.

    La ventana de Hann es imprescindible: sin ella los bordes del recorte generan
    un pico artificial en la correlación y todo parece un desplazamiento válido.
    """
    h = frame.shape[0]
    y0 = int(h * cfg.crop_top)
    y1 = int(h * (1.0 - cfg.crop_bottom))
    if y1 <= y0:
        y0, y1 = 0, h
    roi = frame[y0:y1]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (cfg.work_w, cfg.work_h), interpolation=cv2.INTER_AREA)
    f = small.astype(np.float32)
    return small, f * hann


def _minimap_mask(frame, cfg):
    """Máscara de los píxeles casi blancos del minimapa.

    El borde del rectángulo del viewport es lo más blanco que hay ahí; el resto
    (temporizadores, iconos) es estático y se cancela al comparar dos muestras.
    """
    h, w = frame.shape[:2]
    roi = frame[
        int(h * cfg.mm_y0) : int(h * cfg.mm_y1),
        int(w * cfg.mm_x0) : int(w * cfg.mm_x1),
    ]
    if roi.size == 0:
        return None
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    return cv2.inRange(hsv, (0, 0, 205), (180, 45, 255))


def _viewport_jump(prev_mask, mask, cfg):
    """Cuánto se movió el rectángulo del viewport entre dos muestras.

    Devuelve la distancia entre el centroide de lo que desapareció y el de lo que
    apareció, normalizada al ancho del minimapa. `None` si no hay suficiente señal.
    """
    if prev_mask is None or mask is None or prev_mask.shape != mask.shape:
        return None
    gone = cv2.bitwise_and(prev_mask, cv2.bitwise_not(mask))
    came = cv2.bitwise_and(mask, cv2.bitwise_not(prev_mask))
    gy, gx = np.nonzero(gone)
    cy, cx = np.nonzero(came)
    if len(gx) < cfg.mm_min_px or len(cx) < cfg.mm_min_px:
        return None
    d = float(np.hypot(np.mean(cx) - np.mean(gx), np.mean(cy) - np.mean(gy)))
    return d / max(1, mask.shape[1])


def analyze(video_path, stills_dir=None):
    cfg = Config()
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(json.dumps({"error": "No se pudo abrir el vídeo", "snaps": []}))
        return 1

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    if fps <= 0 or fps > 1000:
        fps = 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    duration = total_frames / fps if total_frames > 0 else 0.0

    step = max(1, int(round(fps / max(1.0, cfg.sample_fps))))
    offset_frames = max(1, int(round(cfg.still_offset * fps)))

    sys.stderr.write(
        f"[HARDWARE] camera_snaps: {width}x{height} @ {fps:.1f}fps, "
        f"muestreo 1/{step} ({fps / step:.1f} fps efectivos)\n"
    )

    hann = cv2.createHanningWindow((cfg.work_w, cfg.work_h), cv2.CV_32F)

    if cfg.stills and stills_dir:
        os.makedirs(stills_dir, exist_ok=True)

    prev_small = None
    prev_win = None
    prev_mm = None
    snaps = []
    rejected_vfx = 0
    last_snap_t = -1e9
    # Fotogramas pendientes de guardar como still: {n_frame: indice_del_snap}
    pending = {}
    stills_written = 0
    stills_skipped = 0

    idx = -1
    last_progress = -1.0

    while True:
        ok = cap.grab()
        if not ok:
            break
        idx += 1

        # Un still pendiente: hay que decodificar este fotograma aunque no toque muestra.
        want_still = idx in pending
        if idx % step != 0 and not want_still:
            continue

        ok, frame = cap.retrieve()
        if not ok or frame is None:
            continue

        if want_still:
            si = pending.pop(idx)
            if stills_written < cfg.max_stills and stills_dir:
                name = f"snap_{si:04d}.jpg"
                out = frame
                if width > cfg.still_width:
                    scale = cfg.still_width / float(width)
                    out = cv2.resize(
                        frame,
                        (cfg.still_width, int(height * scale)),
                        interpolation=cv2.INTER_AREA,
                    )
                if cv2.imwrite(
                    os.path.join(stills_dir, name),
                    out,
                    [int(cv2.IMWRITE_JPEG_QUALITY), cfg.still_quality],
                ):
                    snaps[si]["still"] = name
                    stills_written += 1
            else:
                stills_skipped += 1

        if idx % step != 0:
            continue

        small, win = _prep(frame, cfg, hann)
        mm = _minimap_mask(frame, cfg) if cfg.use_minimap else None
        t = idx / fps

        if prev_small is not None:
            mad = float(np.mean(np.abs(small.astype(np.int16) - prev_small.astype(np.int16)))) / 255.0
            # Escena prácticamente idéntica: ni miramos la correlación (sería ruido).
            if mad >= cfg.mad_thresh:
                _, response = cv2.phaseCorrelate(prev_win, win)
                if response < cfg.resp_thresh and (t - last_snap_t) >= cfg.min_gap:
                    # Confirmación por minimapa: la vista del mundo se ha roto, pero
                    # eso también lo hace un ulti a pantalla completa. Solo es un
                    # salto si además el viewport se ha ido a otra parte del mapa.
                    jump = _viewport_jump(prev_mm, mm, cfg) if cfg.use_minimap else None
                    if cfg.use_minimap and (jump is None or jump < cfg.mm_jump):
                        rejected_vfx += 1
                    else:
                        last_snap_t = t
                        snaps.append(
                            {
                                "t": round(t, 3),
                                "mad": round(mad, 4),
                                "response": round(float(response), 4),
                                "jump": round(jump, 4) if jump is not None else None,
                                "still": None,
                            }
                        )
                        if cfg.stills and stills_dir:
                            pending[idx + offset_frames] = len(snaps) - 1

        prev_small = small
        prev_win = win
        prev_mm = mm

        if total_frames > 0:
            pct = (idx / total_frames) * 100.0
            if pct - last_progress >= 1.0:
                last_progress = pct
                sys.stderr.write(f"PROGRESS:{pct:.1f}\n")
                sys.stderr.flush()

    cap.release()

    if duration <= 0.0 and idx >= 0:
        duration = (idx + 1) / fps

    if stills_skipped:
        sys.stderr.write(
            f"[HARDWARE] camera_snaps: {stills_skipped} stills omitidos "
            f"(tope VOD_SNAP_MAX_STILLS={cfg.max_stills})\n"
        )

    print(
        json.dumps(
            {
                "duration": round(duration, 3),
                "fps": round(fps, 3),
                "width": width,
                "height": height,
                "sampled_fps": round(fps / step, 2),
                "snaps": snaps,
                "stills_written": stills_written,
                "stills_skipped": stills_skipped,
                # Cortes que rompieron la vista del mundo pero NO movieron la cámara:
                # efectos de peleas, recalls, ultis. Útil para calibrar los umbrales.
                "rejected_vfx": rejected_vfx,
            }
        )
    )
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Falta la ruta del vídeo", "snaps": []}))
        sys.exit(1)
    os.environ["OPENCV_LOG_LEVEL"] = "OFF"
    sys.exit(analyze(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None))
