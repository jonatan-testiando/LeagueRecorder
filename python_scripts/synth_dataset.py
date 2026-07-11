"""Dataset multi-clase de cursores por SÍNTESIS.

Pega los sprites de cursor (assets/cursors, con alfa) sobre frames reales de los
VODs, en posiciones aleatorias. Así obtenemos datos etiquetados y balanceados para
TODAS las familias de cursor (incluidas las que no aparecen en tus partidas), con
la punta (hotspot) exacta porque controlamos dónde se pega.

Clases: 0=hand (manita legacy), 1=arrow (flecha 'precise'), 2=sword (ataque),
        3=target (cruz/diana sobre objetivo).

Además etiqueta el cursor REAL presente en cada frame de fondo (vía el matcher
clásico) para que no quede como positivo sin etiquetar.

Uso:
    python synth_dataset.py <out_dir> [--per-vod N] [--videos-dir DIR]
                            [--paste-min 1] [--paste-max 3] [--val-split 0.15]
"""

import cv2
import numpy as np
import os
import sys
import glob
import json
import random

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyzer import Config, TemplateLibrary, CursorTracker

CLASSES = ["hand", "arrow", "sword", "target", "click_move", "click_attack"]
CLASS_IDX = {c: i for i, c in enumerate(CLASSES)}

# Mapeo archivo -> clase (familias comunes de CURSOR).
FILE_CLASS = {
    "hand1": "hand", "hand2": "hand", "hand1_tco": "hand",
    "hover_precise": "arrow", "hover_ally_precise": "arrow",
    "hoverenemy": "sword", "hoverenemy_colorblind": "sword",
    "hover_enemy_precise": "sword", "hover_enemy_precise_colorblind": "sword",
    "hoverfriendly": "sword",
    "singletarget": "target", "singletarget_colorblind": "target",
    "singletargetally": "target", "singletargetenemy": "target",
    "singletargetenemy_colorblind": "target",
    "target_enemy_precise": "target", "target_enemy_precise_colorblind": "target",
}
# Arcos de feedback de CLIC (assets/click_arrows). verde/azul=mover, rojo/naranja=atacar.
CLICK_FILE_CLASS = {
    "movement_indicator_green": "click_move",
    "movement_indicator_colorblind": "click_move",   # azul (daltónico)
    "movement_indicator_red": "click_attack",
    "movement_indicator_orange": "click_attack",      # naranja (daltónico)
}
CLICK_CLASSES = {"click_move", "click_attack"}
# Alto en px del arco al pegar (medido en juego ~55, rango por la animación).
CLICK_H_MIN, CLICK_H_MAX = 40, 95

HOTSPOT_RULE = {"hand": "topleft", "arrow": "topleft", "sword": "topleft", "target": "center",
                "click_move": "bottom", "click_attack": "bottom"}

# Pesos de síntesis: hand ya abunda (cursor real de fondo) -> menos; clics con buena
# presencia (son la señal valiosa).
SYNTH_WEIGHTS = {"hand": 0.08, "arrow": 0.16, "sword": 0.14, "target": 0.15,
                 "click_move": 0.24, "click_attack": 0.23}

random.seed(1234)  # reproducible (Math.random del entorno JS no aplica aquí)


def _arg(flag, default, cast):
    if flag in sys.argv:
        try:
            return cast(sys.argv[sys.argv.index(flag) + 1])
        except (IndexError, ValueError):
            pass
    return default


def _hotspot(alpha, rule):
    h, w = alpha.shape
    if rule == "center":
        ys, xs = np.where(alpha > 128)
        if len(xs) == 0:
            return (w / 2.0, h / 2.0)
        return (float(xs.mean()), float(ys.mean()))
    if rule == "bottom":
        # punta del arco de clic: apunta abajo -> x centro, y máximo opaco.
        ys, xs = np.where(alpha > 128)
        if len(xs) == 0:
            return (w / 2.0, h - 1.0)
        return (float(xs.mean()), float(ys.max()))
    # topleft: la punta debe caer en la parte SÓLIDA del sprite (no en el glow),
    # así que exigimos alfa alto; si no hay, bajamos el umbral.
    for thr in (200, 128, 60):
        ys, xs = np.where(alpha > thr)
        if len(xs):
            x0, y0 = xs.min(), ys.min()
            i = int(np.argmin((xs - x0) + (ys - y0)))
            return (float(xs[i]), float(ys[i]))
    return (w / 2.0, h / 2.0)


def _load_one(path, cls, sprites, frac_acc):
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None or img.ndim != 3 or img.shape[2] < 4:
        return
    a = img[:, :, 3]
    ys, xs = np.where(a > 10)
    if len(xs) == 0:
        return
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    bgr = img[y0:y1, x0:x1, :3].copy()
    al = img[y0:y1, x0:x1, 3].copy()
    hx, hy = _hotspot(al, HOTSPOT_RULE[cls])
    h, w = al.shape
    hfx, hfy = hx / w, hy / h
    sprites[cls].append((bgr, al, (hfx, hfy)))
    frac_acc[cls].append((hfx, hfy))


def load_sprites():
    """Devuelve {clase: [(bgr_crop, alpha_crop, (hfx,hfy)), ...]} y la tabla de
    fracción de hotspot media por clase (para el backend de inferencia)."""
    sprites = {c: [] for c in CLASSES}
    frac_acc = {c: [] for c in CLASSES}
    for fname, cls in FILE_CLASS.items():
        _load_one(f"assets/cursors/{fname}.png", cls, sprites, frac_acc)
    for fname, cls in CLICK_FILE_CLASS.items():
        _load_one(f"assets/click_arrows/{fname}.png", cls, sprites, frac_acc)
    table = {}
    for c in CLASSES:
        if frac_acc[c]:
            fx = sum(f[0] for f in frac_acc[c]) / len(frac_acc[c])
            fy = sum(f[1] for f in frac_acc[c]) / len(frac_acc[c])
            table[c] = (round(fx, 3), round(fy, 3))
    return sprites, table


def _overlaps(box, boxes, margin=6):
    x, y, w, h = box
    for (bx, by, bw, bh) in boxes:
        if x < bx + bw + margin and x + w + margin > bx and \
           y < by + bh + margin and y + h + margin > by:
            return True
    return False


def _paste(frame, bgr, al, x, y):
    h, w = al.shape
    roi = frame[y:y + h, x:x + w].astype(np.float32)
    a = (al.astype(np.float32) / 255.0)[..., None]
    frame[y:y + h, x:x + w] = (bgr.astype(np.float32) * a + roi * (1 - a)).astype(np.uint8)


def main():
    if len(sys.argv) < 2:
        print("Usage: python synth_dataset.py <out_dir> [--per-vod N] [--videos-dir DIR]")
        sys.exit(1)
    os.environ["OPENCV_LOG_LEVEL"] = "OFF"
    os.environ.setdefault("VOD_USE_OPENCL", "0")

    out_dir = os.path.abspath(sys.argv[1])
    per_vod = _arg("--per-vod", 150, int)
    paste_min = _arg("--paste-min", 1, int)
    paste_max = _arg("--paste-max", 3, int)
    val_split = _arg("--val-split", 0.15, float)
    videos_dir = _arg("--videos-dir",
                      os.path.join(os.path.expanduser("~"), "Videos", "LeagueRecorder"), str)

    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cursors = os.path.join(repo, "assets", "cursors")

    sprites, hotspot_table = load_sprites()
    sys.stderr.write("[SYNTH] sprites por clase: " +
                     json.dumps({c: len(sprites[c]) for c in CLASSES}) + "\n")
    sys.stderr.write("[SYNTH] tabla hotspot (fracción de la caja): " +
                     json.dumps(hotspot_table) + "\n")
    sys.stderr.flush()

    cfg = Config.from_env()
    lib = TemplateLibrary(cursors, cfg)
    tracker = CursorTracker(lib, cfg)

    for d in ("images/train", "images/val", "labels/train", "labels/val"):
        os.makedirs(os.path.join(out_dir, d), exist_ok=True)

    vods = sorted(glob.glob(os.path.join(videos_dir, "**", "*.mp4"), recursive=True))
    weighted = [c for c in CLASSES for _ in range(int(SYNTH_WEIGHTS[c] * 100))]
    saved = 0

    for vi, vod in enumerate(vods, 1):
        cap = cv2.VideoCapture(vod)
        if not cap.isOpened():
            continue
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        fh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if total <= 0:
            cap.release()
            continue
        vid = os.path.splitext(os.path.basename(vod))[0]
        step = max(1, total // per_vod)
        sys.stderr.write(f"[SYNTH] ({vi}/{len(vods)}) {vid}\n")
        sys.stderr.flush()

        for idx in range(0, total, step):
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ok, frame = cap.read()
            if not ok:
                continue

            labels = []      # (cls_idx, cx, cy, w, h) en px
            occupied = []

            # 1) etiquetar el cursor REAL del frame (para no dejarlo sin etiqueta)
            tracker.drop_track()
            m = tracker.locate(frame, fw, fh)
            if m.val >= 0.90:
                w, h = m.size
                if w > 0 and h > 0:
                    cls = "sword" if m.evt_type == "attack" else "hand"
                    labels.append((CLASS_IDX[cls], m.x, m.y, w, h))
                    occupied.append((m.x, m.y, w, h))

            # 2) pegar cursores sintéticos en huecos aleatorios
            k = random.randint(paste_min, paste_max)
            for _ in range(k):
                cls = random.choice(weighted)
                if not sprites[cls]:
                    continue
                bgr, al, _ = random.choice(sprites[cls])
                if cls in CLICK_CLASSES:
                    # arco de clic: escalar a un alto objetivo (animación) + desvanecido
                    th = random.randint(CLICK_H_MIN, CLICK_H_MAX)
                    sc = th / al.shape[0]
                    nw, nh = max(8, int(al.shape[1] * sc)), max(8, int(al.shape[0] * sc))
                    bgr = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_AREA)
                    al = cv2.resize(al, (nw, nh), interpolation=cv2.INTER_AREA)
                    fade = random.uniform(0.45, 1.0)
                    if fade < 0.99:
                        al = (al.astype(np.float32) * fade).astype(np.uint8)
                else:
                    sc = random.uniform(0.9, 1.15)
                    if abs(sc - 1.0) > 1e-3:
                        nw, nh = max(6, int(al.shape[1] * sc)), max(6, int(al.shape[0] * sc))
                        bgr = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_LINEAR)
                        al = cv2.resize(al, (nw, nh), interpolation=cv2.INTER_LINEAR)
                h, w = al.shape
                placed = False
                for _try in range(10):
                    x = random.randint(2, max(3, fw - w - 2))
                    y = random.randint(2, max(3, fh - h - 2))
                    if not _overlaps((x, y, w, h), occupied):
                        _paste(frame, bgr, al, x, y)
                        labels.append((CLASS_IDX[cls], float(x), float(y), w, h))
                        occupied.append((x, y, w, h))
                        placed = True
                        break
                if not placed:
                    continue

            if not labels:
                continue

            stem = f"synth_{vid}_{idx:07d}"
            is_val = (hash(stem) % 1000) / 1000.0 < val_split
            sub = "val" if is_val else "train"
            cv2.imwrite(os.path.join(out_dir, "images", sub, stem + ".jpg"), frame,
                        [cv2.IMWRITE_JPEG_QUALITY, 90])
            with open(os.path.join(out_dir, "labels", sub, stem + ".txt"), "w") as f:
                for cls_i, x, y, w, h in labels:
                    cx = (x + w / 2.0) / fw
                    cy = (y + h / 2.0) / fh
                    f.write(f"{cls_i} {cx:.6f} {cy:.6f} {w / fw:.6f} {h / fh:.6f}\n")
            saved += 1
            if saved % 200 == 0:
                sys.stderr.write(f"[SYNTH] guardados={saved}\n")
                sys.stderr.flush()
        cap.release()

    # data.yaml
    with open(os.path.join(out_dir, "data.yaml"), "w") as f:
        f.write(f"path: {out_dir}\n")
        f.write("train: images/train\nval: images/val\n")
        f.write(f"nc: {len(CLASSES)}\nnames:\n")
        for i, c in enumerate(CLASSES):
            f.write(f"  {i}: {c}\n")

    sys.stderr.write(f"[SYNTH] LISTO. imágenes sintéticas={saved}\n")
    print(json.dumps({"saved": saved, "hotspot_table": hotspot_table}))


if __name__ == "__main__":
    main()
