"""Auto-etiquetador de cursores para entrenar un detector YOLO.

Reutiliza el tracker clásico (template matching) de analyzer.py como "profesor":
recorre un VOD, y en cada frame donde el tracker acepta el cursor con alta
confianza, guarda la imagen + una etiqueta YOLO (caja del cursor + clase). Así
generamos miles de frames etiquetados sin anotar a mano.

Clases:
    0 = cursor_move    (mano / preciso)
    1 = cursor_attack  (espada / hover enemigo)

Uso:
    python autolabel.py <video> <cursors_dir> <out_dir> [--every N] [--max M]
                        [--min-conf C] [--val-split V]

Diseño de muestreo:
- Se guarda SIEMPRE el frame de un clic (son los más valiosos y escasos).
- Fuera de clics, 1 de cada `--every` frames aceptados (evita miles de frames
  casi idénticos consecutivos, que sobreajustan y no aportan).
- Solo se etiqueta con confianza >= `--min-conf` (más estricto que el análisis
  normal: un dataset "sucio" envenena el entrenamiento).
"""

import cv2
import os
import sys
import json

# Importamos la maquinaria ya verificada del analizador.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyzer import Config, TemplateLibrary, CursorTracker, ClickDetector

CLASS_OF = {"move": 0, "attack": 1, "right_click": 0, "left_click": 1}


def _arg(flag, default, cast):
    if flag in sys.argv:
        try:
            return cast(sys.argv[sys.argv.index(flag) + 1])
        except (IndexError, ValueError):
            pass
    return default


def label_video(video_path, cursors_dir, out_dir,
                sample_every=20, max_per_video=1500, min_conf=0.90, val_split=0.15,
                target=0):
    # Config independiente del análisis normal: forzamos calidad máxima para
    # etiquetar (máscara ON, sin ROI adaptativo). OpenCL da igual aquí.
    os.environ.setdefault("VOD_USE_MASK", "1")
    os.environ["VOD_ADAPTIVE_ROI"] = "0"
    cfg = Config.from_env()

    library = TemplateLibrary(cursors_dir, cfg)
    tracker = CursorTracker(library, cfg)
    clicker = ClickDetector(cfg)

    img_tr = os.path.join(out_dir, "images", "train")
    img_va = os.path.join(out_dir, "images", "val")
    lbl_tr = os.path.join(out_dir, "labels", "train")
    lbl_va = os.path.join(out_dir, "labels", "val")
    for d in (img_tr, img_va, lbl_tr, lbl_va):
        os.makedirs(d, exist_ok=True)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        sys.stderr.write(f"[WARN] No se pudo abrir {video_path}\n")
        return 0

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    fh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    skip = max(1, int(round(fps / cfg.target_fps)))

    # Modo objetivo: repartir ~`target` capturas a lo largo de TODO el vídeo en
    # vez de sesgar hacia el inicio (calculamos el espaciado con los frames que se
    # llegarán a analizar).
    if target > 0:
        analyzable = max(1, total // skip)
        sample_every = max(1, analyzable // target)

    vid = os.path.splitext(os.path.basename(video_path))[0]
    frame_count = 0
    accepted = 0
    saved = 0

    while True:
        if not cap.grab():
            break
        frame_count += 1
        if frame_count % skip != 0:
            continue
        ok, frame = cap.retrieve()
        if not ok:
            continue

        if not tracker.should_analyze():
            continue

        m = tracker.locate(frame, fw, fh)
        if m.val <= cfg.match_threshold:
            tracker.coast_or_lose(m.is_global, fw, fh)
            continue
        if tracker.is_teleport(m):
            tracker.drop_track()
            continue

        evt = clicker.classify(frame, m.x, m.y, m.hotspot, m.evt_type)
        tracker.accept(m)
        accepted += 1

        is_click = evt in ("left_click", "right_click")
        # Muestreo: siempre los clics; el resto, 1 de cada `sample_every`, y solo
        # con confianza alta (dataset limpio).
        if not is_click and (accepted % sample_every != 0 or m.val < min_conf):
            continue

        w, h = m.size
        if w <= 0 or h <= 0:
            continue
        # Caja del cursor en coords de vídeo: (real_x, real_y) es la esquina
        # superior izquierda del match; el template ocupa w x h.
        x0 = max(0.0, float(m.x))
        y0 = max(0.0, float(m.y))
        x1 = min(float(fw), m.x + w)
        y1 = min(float(fh), m.y + h)
        cx = ((x0 + x1) / 2.0) / fw
        cy = ((y0 + y1) / 2.0) / fh
        nw = (x1 - x0) / fw
        nh = (y1 - y0) / fh
        if nw <= 0 or nh <= 0:
            continue

        cls = CLASS_OF.get(m.evt_type, 0)
        stem = f"{vid}_{frame_count:07d}"
        # Reparto train/val determinista por hash del nombre (sin aleatoriedad,
        # reproducible entre corridas).
        is_val = (hash(stem) % 1000) / 1000.0 < val_split
        img_dir, lbl_dir = (img_va, lbl_va) if is_val else (img_tr, lbl_tr)

        cv2.imwrite(os.path.join(img_dir, stem + ".jpg"), frame,
                    [cv2.IMWRITE_JPEG_QUALITY, 92])
        with open(os.path.join(lbl_dir, stem + ".txt"), "w") as f:
            f.write(f"{cls} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}\n")
        saved += 1

        if saved % 100 == 0:
            pct = (frame_count / total * 100) if total else 0
            sys.stderr.write(f"[{vid}] guardados={saved} ({pct:.1f}%)\n")
            sys.stderr.flush()

        if saved >= max_per_video:
            break

    cap.release()
    sys.stderr.write(f"[{vid}] TOTAL guardados={saved} (aceptados={accepted})\n")
    return saved


def label_video_fast(video_path, cursors_dir, out_dir,
                     num=400, min_conf=0.92, val_split=0.15):
    """Etiquetado RÁPIDO por muestreo uniforme: en vez de rastrear cada frame,
    saltamos (seek) a `num` posiciones repartidas por todo el vídeo y hacemos un
    match global independiente en cada una. Ideal para el dataset de un DETECTOR
    (cobertura temporal uniforme, coste proporcional a `num`, no a la duración)."""
    os.environ.setdefault("VOD_USE_MASK", "1")
    cfg = Config.from_env()
    library = TemplateLibrary(cursors_dir, cfg)
    tracker = CursorTracker(library, cfg)

    for d in ("images/train", "images/val", "labels/train", "labels/val"):
        os.makedirs(os.path.join(out_dir, d), exist_ok=True)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        sys.stderr.write(f"[WARN] No se pudo abrir {video_path}\n")
        return 0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    fh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if total <= 0:
        cap.release()
        return 0

    vid = os.path.splitext(os.path.basename(video_path))[0]
    step = max(1, total // num)
    saved = 0
    for idx in range(0, total, step):
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if not ok:
            continue
        tracker.drop_track()               # fuerza búsqueda global (frame independiente)
        m = tracker.locate(frame, fw, fh)
        if m.val < min_conf:
            continue
        w, h = m.size
        if w <= 0 or h <= 0:
            continue
        x0 = max(0.0, float(m.x)); y0 = max(0.0, float(m.y))
        x1 = min(float(fw), m.x + w); y1 = min(float(fh), m.y + h)
        nw = (x1 - x0) / fw; nh = (y1 - y0) / fh
        if nw <= 0 or nh <= 0:
            continue
        cx = ((x0 + x1) / 2.0) / fw; cy = ((y0 + y1) / 2.0) / fh
        cls = CLASS_OF.get(m.evt_type, 0)
        stem = f"{vid}_{idx:07d}"
        is_val = (hash(stem) % 1000) / 1000.0 < val_split
        sub = "val" if is_val else "train"
        cv2.imwrite(os.path.join(out_dir, "images", sub, stem + ".jpg"), frame,
                    [cv2.IMWRITE_JPEG_QUALITY, 92])
        with open(os.path.join(out_dir, "labels", sub, stem + ".txt"), "w") as f:
            f.write(f"{cls} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}\n")
        saved += 1
    cap.release()
    sys.stderr.write(f"[{vid}] fast: guardados={saved}/{num}\n")
    return saved


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python autolabel.py <video> <cursors_dir> <out_dir> "
              "[--every N] [--max M] [--min-conf C] [--val-split V]")
        sys.exit(1)

    os.environ["OPENCV_LOG_LEVEL"] = "OFF"
    video = sys.argv[1]
    cursors = sys.argv[2]
    out = sys.argv[3]
    n = label_video(
        video, cursors, out,
        sample_every=_arg("--every", 20, int),
        max_per_video=_arg("--max", 1500, int),
        min_conf=_arg("--min-conf", 0.90, float),
        val_split=_arg("--val-split", 0.15, float),
        target=_arg("--target", 0, int),
    )
    print(json.dumps({"saved": n, "out": out}))
