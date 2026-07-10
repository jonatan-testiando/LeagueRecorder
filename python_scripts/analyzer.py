"""Analizador de VODs de League of Legends: detecta el cursor y los clics.

Arquitectura (misma lógica que la versión monolítica anterior, sólo reorganizada):

    Config          -> todos los tunables, leídos de env en un único sitio
    TemplateLibrary -> carga/recorta/escala los cursores (ROI + global a 1/2)
    TrackerState    -> estado mutable del seguimiento, agrupado en un objeto
    CursorTracker   -> DÓNDE está el cursor (ROI, sticky, global, teleport, coasting)
    ClickDetector   -> SI hubo clic (HSV + freno físico + tipo de asset + cooldown)
    Metrics         -> acumula y emite METRICS: para A/B objetivo
    VideoAnalyzer   -> orquesta el bucle de frames y exporta el JSON

El comportamiento por defecto es idéntico al anterior (mismos umbrales), de modo
que `VOD_DIAGNOSTIC=1` debe dar las mismas métricas antes/después del refactor.
"""

import cv2
import numpy as np
import sys
import json
import os
import math
import statistics
from dataclasses import dataclass
from typing import List, Optional, Tuple


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


# ------------------ CONFIGURACIÓN (TUNABLES) ------------------
@dataclass
class Config:
    """Todos los ajustes en un único objeto. Antes eran globales sueltas y
    "números mágicos" repartidos por el código; ahora se leen de env en
    `from_env()` y viajan explícitos a cada componente."""

    # --- muestreo / matching ---
    target_fps: float = 30.0          # FPS del análisis (estela). 30 = original.
    match_threshold: float = 0.85     # confianza mínima para aceptar el cursor.
    rescan_threshold: float = 0.88    # por debajo de esto se re-escanea la librería.
    early_exit_match: float = 0.95    # coincidencia "suficiente" para cortar el re-escaneo.

    # --- clics ---
    cooldown_frames: int = 8          # anti-spam de clics (en frames analizados).
    bright_pixels_min: int = 30       # píxeles brillantes mínimos = "explosión de color".

    # --- ROI / búsqueda ---
    search_padding: int = 150         # radio de búsqueda alrededor del último punto.
    roi_extra: int = 50               # margen extra der/abajo (antes el "+50" mágico).
    teleport_max_jump: float = 600.0  # salto máx. entre frames sin confianza altísima.
    teleport_trust: float = 0.93      # confianza a partir de la cual se perdona el salto.
    global_search_stride: int = 2     # backoff del escaneo global a pantalla completa.
    grace_frames: int = 4             # frames de coasting inercial antes de rendirse.

    # --- detección de clic por física (antes números mágicos) ---
    click_box_half: int = 30          # medio lado del recorte HSV bajo la punta (60x60).
    brake_fast_speed: float = 15.0    # velocidad media "venía rápido".
    brake_stop_speed: float = 4.0     # velocidad instantánea "frenó en seco".
    velocity_window: int = 10         # nº de muestras para la velocidad media.

    # --- backend / estrategia ---
    match_method: int = cv2.TM_CCORR_NORMED
    match_lower_better: bool = False
    scales: Tuple[float, ...] = (1.0,)
    # Usar la máscara de transparencia es MUY lento en OpenCV y anula casi toda la
    # aceleración por GPU. A 0 acelera el escaneo ~x4 pero ROMPE la precisión si el
    # fondo no es negro. Por defecto activada.
    use_mask: bool = True
    use_opencl: bool = True           # VOD_USE_OPENCL=0 -> path 100% CPU (sin UMat) para A/B.
    adaptive_roi: bool = False        # VOD_ADAPTIVE_ROI=1 -> ROI según velocidad (más rápido).
    diagnostic: bool = False

    @classmethod
    def from_env(cls) -> "Config":
        # Método de matching. 'sqdiff' es más robusto frente a VFX brillantes que
        # el 'ccorr' clásico, pero enmascarado resulta inestable (ver calibración).
        m = os.environ.get("VOD_MATCH_METHOD", "ccorr").strip().lower()
        if m in ("sqdiff", "sqdiff_normed"):
            method, lower = cv2.TM_SQDIFF_NORMED, True
        else:
            method, lower = cv2.TM_CCORR_NORMED, False

        # Escalas de template (multi-escala). Crucial si el VOD no está a la misma
        # resolución/DPI que los cursores base. "1.0" = original.
        scales: List[float] = []
        for p in os.environ.get("VOD_SCALES", "1.0").split(","):
            p = p.strip()
            if not p:
                continue
            try:
                v = float(p)
                if v > 0:
                    scales.append(v)
            except ValueError:
                pass
        if not scales:
            scales = [1.0]

        return cls(
            target_fps=_envf("VOD_TARGET_FPS", 30.0),
            match_threshold=_envf("VOD_MATCH_THRESHOLD", 0.85),
            rescan_threshold=_envf("VOD_RESCAN_THRESHOLD", 0.88),
            early_exit_match=_envf("VOD_EARLY_EXIT", 0.95),
            cooldown_frames=_envi("VOD_COOLDOWN_FRAMES", 8),
            bright_pixels_min=_envi("VOD_BRIGHT_PIXELS", 30),
            search_padding=_envi("VOD_SEARCH_PADDING", 150),
            roi_extra=_envi("VOD_ROI_EXTRA", 50),
            teleport_max_jump=_envf("VOD_TELEPORT_JUMP", 600.0),
            teleport_trust=_envf("VOD_TELEPORT_TRUST", 0.93),
            global_search_stride=_envi("VOD_GLOBAL_STRIDE", 2),
            grace_frames=_envi("VOD_GRACE_FRAMES", 4),
            click_box_half=_envi("VOD_CLICK_BOX", 30),
            brake_fast_speed=_envf("VOD_BRAKE_FAST", 15.0),
            brake_stop_speed=_envf("VOD_BRAKE_STOP", 4.0),
            velocity_window=_envi("VOD_VELOCITY_WINDOW", 10),
            match_method=method,
            match_lower_better=lower,
            scales=tuple(scales),
            use_mask=_envb("VOD_USE_MASK", True),
            use_opencl=_envb("VOD_USE_OPENCL", True),
            adaptive_roi=_envb("VOD_ADAPTIVE_ROI", False),
            diagnostic=_envb("VOD_DIAGNOSTIC", False),
        )


def _to_umat(arr, use_opencl: bool):
    """Envuelve en UMat sólo si OpenCL está activo. Con VOD_USE_OPENCL=0 se queda
    en numpy (path 100% CPU) para poder medir si OpenCL ayuda o penaliza."""
    return cv2.UMat(arr) if use_opencl else arr


def _match_score(search, tmpl: "Template", cfg: Config):
    """Devuelve (score, loc) con score en [0..1] donde MÁS ALTO = MEJOR, sea cual
    sea el método. Unifica CCORR (max) y SQDIFF (min)."""
    if cfg.use_mask:
        res = cv2.matchTemplate(search, tmpl.bgr, cfg.match_method, mask=tmpl.mask)
    else:
        res = cv2.matchTemplate(search, tmpl.bgr, cfg.match_method)

    res_cpu = res.get() if hasattr(res, "get") else res
    if cfg.match_lower_better:
        # SQDIFF enmascarado puede dar NaN/inf en bordes: sólo entonces limpiamos.
        res_cpu = np.nan_to_num(res_cpu, nan=1.0, posinf=1.0, neginf=0.0)
        min_v, _, min_l, _ = cv2.minMaxLoc(res_cpu)
        return (1.0 - min_v), min_l
    _, max_v, _, max_l = cv2.minMaxLoc(res_cpu)
    return max_v, max_l


# ------------------ LIBRERÍA DE TEMPLATES ------------------
@dataclass
class Template:
    bgr: object                    # UMat o ndarray según use_opencl
    mask: object
    evt_type: str
    hotspot: Tuple[float, float]


class TemplateLibrary:
    """Carga las variantes de cursor y prepara dos juegos de templates:
    `roi` (multi-escala, para el seguimiento fino) y `global_` (media resolución,
    escala única, para el escaneo global ultrarrápido)."""

    TARGET_FILES = [
        # (filename, event_type, hotspot_x, hotspot_y)
        ("hand1.png", "move", 9, 9),
        ("hand2.png", "move", 9, 9),
        ("hoverenemy.png", "attack", 2, 2),
        ("hover_precise.png", "move", 24, 24),
        ("hover_enemy_precise_colorblind.png", "attack", 24, 24),
    ]

    def __init__(self, cursors_dir: str, cfg: Config):
        self.roi: List[Template] = []
        self.global_: List[Template] = []
        self._load(cursors_dir, cfg)

    @staticmethod
    def _load_image(path: str):
        """Lee el PNG con alfa y recorta los bordes transparentes para que el
        template sea más pequeño y rápido."""
        img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
        if img is None:
            return None, None
        if img.shape[2] == 4:
            bgr = img[:, :, :3]
            alpha = img[:, :, 3]
            ys, xs = np.where(alpha > 0)
            if len(ys) == 0 or len(xs) == 0:
                return bgr, alpha
            y0, y1 = ys.min(), ys.max()
            x0, x1 = xs.min(), xs.max()
            return bgr[y0:y1 + 1, x0:x1 + 1], alpha[y0:y1 + 1, x0:x1 + 1]
        return img, None

    def _load(self, cursors_dir: str, cfg: Config):
        for fname, evt, hx, hy in self.TARGET_FILES:
            for folder in [cursors_dir, os.path.join(cursors_dir, "upscaled")]:
                path = os.path.join(folder, fname)
                if not os.path.exists(path):
                    continue
                b, m = self._load_image(path)
                if b is None:
                    continue

                # Multi-escala para el seguimiento por ROI: una variante por escala
                # configurada. El hotspot escala igual, tolerando cursores más
                # grandes/pequeños que el template (resoluciones/DPI distintos).
                for s in cfg.scales:
                    if abs(s - 1.0) < 1e-6:
                        bs, ms = b, m
                    else:
                        interp = cv2.INTER_AREA if s < 1.0 else cv2.INTER_LINEAR
                        bs = cv2.resize(b, (0, 0), fx=s, fy=s, interpolation=interp)
                        ms = cv2.resize(m, (0, 0), fx=s, fy=s, interpolation=cv2.INTER_NEAREST)
                    self.roi.append(Template(
                        _to_umat(bs, cfg.use_opencl), _to_umat(ms, cfg.use_opencl),
                        evt, (hx * s, hy * s)))

                # Versión a media resolución (escala única) para el escaneo global.
                b_half = cv2.resize(b, (0, 0), fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
                m_half = cv2.resize(m, (0, 0), fx=0.5, fy=0.5, interpolation=cv2.INTER_NEAREST)
                self.global_.append(Template(
                    _to_umat(b_half, cfg.use_opencl), _to_umat(m_half, cfg.use_opencl),
                    evt, (hx / 2.0, hy / 2.0)))


# ------------------ RESULTADO DE UN MATCH ------------------
@dataclass
class Match:
    val: float
    x: float
    y: float
    evt_type: str
    hotspot: Tuple[float, float]
    is_global: bool


# ------------------ ESTADO DEL SEGUIMIENTO ------------------
@dataclass
class TrackerState:
    """Agrupa el estado mutable que antes vivía suelto en el scope de analyze()."""
    last_loc: Optional[Tuple[int, int]] = None
    last_best_template_idx: int = 0    # sticky template index
    lost_frames: int = 0               # frames consecutivos sin rastro (para el backoff)
    last_vel: Tuple[float, float] = (0.0, 0.0)  # velocidad estimada (predicción inercial)
    grace_left: int = 0                # colchón de coasting restante


class CursorTracker:
    """Responde a "¿dónde está el cursor?". Encapsula selección de ROI, sticky
    template, re-escaneo, escaneo global, rechazo de teleports y coasting."""

    def __init__(self, library: TemplateLibrary, cfg: Config):
        self.lib = library
        self.cfg = cfg
        self.s = TrackerState()

    def should_analyze(self) -> bool:
        """Backoff del escaneo global: cuando hemos perdido el rastro, el barrido a
        pantalla completa es lo más caro. Intentamos en el 1.er frame perdido y luego
        sólo cada GLOBAL_STRIDE, para aligerar tramos de menú/cinemática sin cursor."""
        if self.s.last_loc is None:
            self.s.lost_frames += 1
            if self.cfg.global_search_stride > 1 and \
               ((self.s.lost_frames - 1) % self.cfg.global_search_stride) != 0:
                return False
        return True

    def _roi_padding(self) -> int:
        """Radio del ROI. Con adaptive_roi lo estrechamos cuando el cursor se mueve
        poco (la mayoría de frames), reduciendo el área de matchTemplate. Nunca
        supera search_padding, así que con la opción desactivada es idéntico."""
        if not self.cfg.adaptive_roi:
            return self.cfg.search_padding
        v = math.hypot(self.s.last_vel[0], self.s.last_vel[1])
        if v < 10:
            pad = 60
        elif v < 30:
            pad = 100
        else:
            pad = 150
        return min(self.cfg.search_padding, pad)

    def locate(self, frame, fw: int, fh: int) -> Match:
        """Busca el cursor en el frame y devuelve el mejor Match (aún sin decidir si
        supera el umbral). No muta last_loc: eso lo hace accept()/coast_or_lose()."""
        s, cfg = self.s, self.cfg

        if s.last_loc is not None:
            pad = self._roi_padding()
            lx, ly = int(s.last_loc[0]), int(s.last_loc[1])
            x_min = max(0, lx - pad)
            y_min = max(0, ly - pad)
            x_max = min(fw, lx + cfg.roi_extra + pad)
            y_max = min(fh, ly + cfg.roi_extra + pad)
            search = _to_umat(frame[y_min:y_max, x_min:x_max], cfg.use_opencl)
            templates = self.lib.roi
            off_x, off_y = x_min, y_min
            is_global = False
        else:
            # Scaled Global Search: buscar a media resolución es ~4x más rápido.
            frame_half = cv2.resize(frame, (0, 0), fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
            search = _to_umat(frame_half, cfg.use_opencl)
            templates = self.lib.global_
            off_x, off_y = 0, 0
            is_global = True

        # --- FASE 1: STICKY TEMPLATE MATCHING ---
        # Sólo comparamos con el cursor activo en el frame anterior. El índice sticky
        # se comparte entre las listas ROI/global (de distinto tamaño): lo acotamos.
        sticky = s.last_best_template_idx if s.last_best_template_idx < len(templates) else 0
        best_val, best_loc = _match_score(search, templates[sticky], cfg)
        best = templates[sticky]
        s.last_best_template_idx = sticky

        # --- FASE 2: CLASIFICACIÓN (sólo si el cursor cambió de forma / perdió calidad) ---
        if best_val < cfg.rescan_threshold:
            best_val = 0
            for i, t in enumerate(templates):
                if i == sticky:
                    continue  # ya lo probamos
                mv, ml = _match_score(search, t, cfg)
                if mv > best_val:
                    best_val = mv
                    best_loc = ml
                    best = t
                    s.last_best_template_idx = i
                if best_val > cfg.early_exit_match:
                    break  # coincidencia altísima: no hace falta seguir

        hx, hy = best.hotspot
        if is_global:
            # Restaurar coordenada/hotspot a la escala nativa del vídeo.
            best_loc = (int(best_loc[0] * 2), int(best_loc[1] * 2))
            hx, hy = int(hx * 2), int(hy * 2)

        real_x = float(best_loc[0]) + off_x
        real_y = float(best_loc[1]) + off_y
        return Match(best_val, real_x, real_y, best.evt_type, (hx, hy), is_global)

    def is_teleport(self, m: Match) -> bool:
        """En seguimiento continuo (no global), si el cursor salta una distancia
        inverosímil sin confianza altísima, lo tratamos como falso positivo."""
        s, cfg = self.s, self.cfg
        if s.last_loc is not None and not m.is_global and m.val < cfg.teleport_trust:
            jump = math.hypot(m.x - s.last_loc[0], m.y - s.last_loc[1])
            return jump > cfg.teleport_max_jump
        return False

    def drop_track(self):
        """Soltar el rastro (tras un teleport). El siguiente frame hará búsqueda global."""
        self.s.last_loc = None
        self.s.lost_frames = 0

    def accept(self, m: Match):
        """Fijar una posición válida: actualiza velocidad, punto y recarga el coasting."""
        s = self.s
        new_loc = (int(m.x), int(m.y))
        if s.last_loc is not None:
            s.last_vel = (new_loc[0] - s.last_loc[0], new_loc[1] - s.last_loc[1])
        s.last_loc = new_loc
        s.lost_frames = 0           # rastro recuperado: reinicia el backoff global
        s.grace_left = self.cfg.grace_frames  # recargamos el colchón de coasting

    def coast_or_lose(self, is_global: bool, fw: int, fh: int) -> bool:
        """Cuando no hay match: predecimos por velocidad (coasting) unos frames antes
        de rendirnos. Devuelve True si realmente se perdió el rastro (para métricas)."""
        s = self.s
        if s.last_loc is not None and not is_global and s.grace_left > 0:
            s.grace_left -= 1
            px = max(0, min(fw, s.last_loc[0] + s.last_vel[0]))
            py = max(0, min(fh, s.last_loc[1] + s.last_vel[1]))
            s.last_loc = (int(px), int(py))
            return False
        lost = s.last_loc is not None
        s.last_loc = None
        return lost


# ------------------ DETECCIÓN DE CLICS ------------------
class ClickDetector:
    """Responde a "¿esto fue un clic?". Combina tres señales redundantes: explosión
    de color HSV, freno físico (venía rápido y paró en seco) y tipo de asset (espada)."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        # Rangos de color de las partículas del juego (HSV).
        self.lower_green = np.array([40, 150, 150]); self.upper_green = np.array([85, 255, 255])
        self.lower_cyan = np.array([85, 150, 150]);  self.upper_cyan = np.array([105, 255, 255])
        # El rojo cruza el 0 en HSV -> dos rangos (bajo y alto).
        self.lower_red1 = np.array([0, 180, 180]);   self.upper_red1 = np.array([15, 255, 255])
        self.lower_red2 = np.array([165, 180, 180]); self.upper_red2 = np.array([180, 255, 255])

        self.prev_x = -1
        self.prev_y = -1
        self.velocities: List[float] = []
        self.frames_since_last_click = 0

    def classify(self, frame, real_x: float, real_y: float,
                 hotspot: Tuple[float, float], best_type: str) -> str:
        cfg = self.cfg
        evt = "move"

        # Recorte pequeño (60x60) justo bajo la punta del cursor (hotspot).
        click_x = int(real_x + hotspot[0])
        click_y = int(real_y + hotspot[1])
        half = cfg.click_box_half
        cy1 = max(0, click_y - half); cy2 = min(frame.shape[0], click_y + half)
        cx1 = max(0, click_x - half); cx2 = min(frame.shape[1], click_x + half)
        particle_roi = frame[cy1:cy2, cx1:cx2]

        # Cooldown anti-spam: se incrementa UNA vez por frame aceptado.
        self.frames_since_last_click += 1

        if particle_roi.size > 0:
            roi = _to_umat(particle_roi, cfg.use_opencl)
            hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
            mask_green = cv2.inRange(hsv, self.lower_green, self.upper_green)
            mask_cyan = cv2.inRange(hsv, self.lower_cyan, self.upper_cyan)
            mask_red1 = cv2.inRange(hsv, self.lower_red1, self.upper_red1)
            mask_red2 = cv2.inRange(hsv, self.lower_red2, self.upper_red2)
            mask_red = cv2.bitwise_or(mask_red1, mask_red2)
            combined = cv2.bitwise_or(cv2.bitwise_or(mask_green, mask_cyan), mask_red)
            bright = cv2.countNonZero(combined)

            # Freno físico: venía rápido (media) y cayó en seco (instantánea).
            is_brake = False
            if self.prev_x != -1:
                speed = math.hypot(real_x - self.prev_x, real_y - self.prev_y)
                self.velocities.append(speed)
                if len(self.velocities) > cfg.velocity_window:
                    self.velocities.pop(0)
                avg = sum(self.velocities) / len(self.velocities)
                if avg > cfg.brake_fast_speed and speed < cfg.brake_stop_speed:
                    is_brake = True
            self.prev_x, self.prev_y = real_x, real_y

            # Si el jugador forzó el cursor de espada (Attack), cuenta como clic.
            asset_is_click = best_type in ("attack", "right_click")

            # TRIPLE REDUNDANCIA: color OR freno OR asset, respetando el cooldown.
            if (bright > cfg.bright_pixels_min or is_brake or asset_is_click) \
               and self.frames_since_last_click >= cfg.cooldown_frames:
                green_cyan = cv2.countNonZero(cv2.bitwise_or(mask_green, mask_cyan))
                red = cv2.countNonZero(mask_red)
                if red > green_cyan or best_type == "attack":
                    evt = "left_click"   # ataque
                else:
                    evt = "right_click"  # movimiento
                self.frames_since_last_click = 0

        # Si el tracker visual detectó un sprite distinto de "move", forzamos ese tipo.
        if evt == "move" and best_type != "move":
            evt = best_type
        return evt


# ------------------ MÉTRICAS ------------------
class Metrics:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.frames_analyzed = 0
        self.frames_tracked = 0
        self.track_losses = 0
        self.n_clicks = 0
        self.confidences: List[float] = []

    def summary_line(self) -> str:
        c = self.confidences
        mean_c = (sum(c) / len(c)) if c else 0.0
        med_c = statistics.median(c) if c else 0.0
        tracked_pct = (100.0 * self.frames_tracked / self.frames_analyzed) if self.frames_analyzed else 0.0
        return "METRICS:" + json.dumps({
            "method": "sqdiff" if self.cfg.match_lower_better else "ccorr",
            "scales": list(self.cfg.scales),
            "frames_analyzed": self.frames_analyzed,
            "tracked_pct": round(tracked_pct, 1),
            "mean_conf": round(mean_c, 4),
            "median_conf": round(med_c, 4),
            "track_losses": self.track_losses,
            "clicks": self.n_clicks,
        })


# ------------------ ORQUESTADOR ------------------
class VideoAnalyzer:
    def __init__(self, cfg: Config):
        self.cfg = cfg

    def run(self, video_path: str, cursors_dir: Optional[str] = None):
        cfg = self.cfg
        cv2.ocl.setUseOpenCL(cfg.use_opencl)

        # El directorio de cursores llega por argumento (robusto al empaquetado).
        # Si no, caemos a la ruta relativa al script (modo desarrollo).
        if not cursors_dir or not os.path.isdir(cursors_dir):
            base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            cursors_dir = os.path.join(base_dir, "assets", "cursors")
        sys.stderr.write(f"[INFO] Usando cursores en: {cursors_dir}\n")
        sys.stderr.flush()

        library = TemplateLibrary(cursors_dir, cfg)
        sys.stderr.write(
            f"[INFO] Método: {'sqdiff' if cfg.match_lower_better else 'ccorr'} | "
            f"escalas: {list(cfg.scales)} | templates ROI: {len(library.roi)} | "
            f"global: {len(library.global_)} | mask: {cfg.use_mask} | "
            f"opencl: {cfg.use_opencl} | adaptive_roi: {cfg.adaptive_roi}\n")
        sys.stderr.flush()

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            print(json.dumps({"events": [], "duration": 0.0, "width": 0, "height": 0}))
            return

        fps = cap.get(cv2.CAP_PROP_FPS)
        if fps <= 0:
            fps = 30.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        sys.stderr.write(f"Iniciando analisis... Total frames: {total_frames}\n")

        uses_ocl = cv2.ocl.useOpenCL()
        sys.stderr.write(f"[HARDWARE] Aceleracion GPU Activa: {uses_ocl}\n")
        if uses_ocl:
            try:
                device = cv2.ocl.Device.getDefault()
                sys.stderr.write(f"[HARDWARE] Dispositivo: {device.name()} ({device.vendorName()})\n")
            except Exception:
                pass
        sys.stderr.flush()

        frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        # Submuestreo a TARGET_FPS para la estela (30 = comportamiento original).
        skip_frames = max(1, int(round(fps / cfg.target_fps)))

        tracker = CursorTracker(library, cfg)
        clicker = ClickDetector(cfg)
        metrics = Metrics(cfg)

        events = []
        frame_count = 0

        while True:
            # grab() salta frames sin decodificarlos (mucho más rápido).
            if not cap.grab():
                break
            frame_count += 1
            if frame_count % skip_frames != 0:
                continue
            ret, frame = cap.retrieve()
            if not ret:
                continue
            time_sec = frame_count / fps

            if not tracker.should_analyze():
                continue
            metrics.frames_analyzed += 1

            m = tracker.locate(frame, frame_width, frame_height)

            # Umbral estricto para evitar falsos positivos.
            if m.val > cfg.match_threshold:
                if tracker.is_teleport(m):
                    tracker.drop_track()
                    metrics.track_losses += 1
                    continue

                metrics.frames_tracked += 1
                metrics.confidences.append(m.val)

                # Detección de clic ANTES de fijar la nueva posición (usa su propio
                # historial de velocidad, independiente del estado del tracker).
                evt = clicker.classify(frame, m.x, m.y, m.hotspot, m.evt_type)
                tracker.accept(m)

                # Corregimos la coordenada exportada con el hotspot para dibujar el
                # punto justo en la punta de la espada/mano.
                final_x = int(m.x + m.hotspot[0])
                final_y = int(m.y + m.hotspot[1])
                events.append({"t": time_sec, "x": final_x, "y": final_y, "evt": evt})
                if evt in ("left_click", "right_click"):
                    metrics.n_clicks += 1
            else:
                if tracker.coast_or_lose(m.is_global, frame_width, frame_height):
                    metrics.track_losses += 1

            # Progreso (línea legible + línea estructurada para la barra).
            if frame_count % (skip_frames * 20) == 0 and total_frames > 0:
                progress = (frame_count / total_frames) * 100
                sys.stderr.write(f"Analizando VOD: {time_sec / 60:.1f} min ({progress:.1f}%)\n")
                sys.stderr.write(f"PROGRESS:{progress:.1f}\n")
                sys.stderr.flush()

        sys.stderr.write("Analisis finalizado, exportando JSON...\n")
        if cfg.diagnostic:
            sys.stderr.write(metrics.summary_line() + "\n")
        sys.stderr.flush()
        cap.release()

        # Duración real del VOD a partir de los frames realmente recorridos.
        video_duration = (frame_count / fps) if fps > 0 else 0.0
        print(json.dumps({
            "events": events,
            "duration": video_duration,
            "width": frame_width,
            "height": frame_height,
        }))


def analyze(video_path: str, cursors_dir: Optional[str] = None):
    """Punto de entrada de compatibilidad (misma firma que antes)."""
    VideoAnalyzer(Config.from_env()).run(video_path, cursors_dir)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyzer.py <video_path> [cursors_dir]")
        sys.exit(1)

    # Desactivar logs de opencv si el backend C++ los emite.
    os.environ["OPENCV_LOG_LEVEL"] = "OFF"

    cursors_dir = sys.argv[2] if len(sys.argv) > 2 else None
    analyze(sys.argv[1], cursors_dir)
