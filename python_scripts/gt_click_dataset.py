"""Etiqueta clics REALES usando el JSON de tus partidas como ground truth.

La app registra cada clic con {t, x, y, evt}. Para cada right_click válido:
 - extrae el frame del vídeo (con el desfase de sincronización -0.6s),
 - etiqueta el CLIC (clase 4) en la posición exacta del JSON (sin detectar nada),
 - etiqueta el CURSOR (clases 0-3) auto-detectado por el matcher clásico, para
   que no quede como positivo sin etiquetar.

Salida: dataset YOLO que se combina con el sintético de cursores. Con esto el
modelo aprende a detectar el clic real (anillo/chevrons) para usarlo en VOD
Analysis (vídeos importados de otros jugadores, que no traen JSON).

Uso: python gt_click_dataset.py <out_dir> [--videos-dir DIR] [--per-match N]
                                [--sync -0.6] [--click-box 72]
"""

import cv2
import os
import sys
import json
import glob

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyzer import Config, TemplateLibrary, CursorTracker

CLICK_CLS = 4                 # nueva clase (0-3 = cursores, 4 = clic)
CURSOR_MOVE, CURSOR_ATTACK = 0, 2   # hand / sword (tipo del cursor real)
MIN_SPACING = 1.2             # s entre clics (evita ráfagas casi idénticas)
Y_MAX_FRAC = 0.80             # descarta clics en el HUD inferior (tienda/barra)
X_MARGIN = 60                 # descarta clics pegados a los bordes
T_MIN = 90.0                  # salta la fase inicial (compras en tienda)


def _arg(flag, default, cast):
    if flag in sys.argv:
        try:
            return cast(sys.argv[sys.argv.index(flag) + 1])
        except (IndexError, ValueError):
            pass
    return default


def process_match(video, js_path, out_dir, tracker, cfg,
                  sync, per_match, click_box, val_split=0.15):
    try:
        d = json.load(open(js_path, encoding="utf-8"))
    except Exception:
        return 0
    me = d.get("mouse_events", [])
    if not me:
        return 0

    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        return 0
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    fw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    fh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total <= 0:
        cap.release()
        return 0
    y_max = fh * Y_MAX_FRAC

    # right_clicks válidos, espaciados
    rcs = []
    last = -99.0
    for e in me:
        if e.get("evt") != "right_click":
            continue
        x, y, t = e["x"], e["y"], e["t"]
        if t < T_MIN or t - last < MIN_SPACING:
            continue
        if not (X_MARGIN < x < fw - X_MARGIN and 200 < y < y_max):
            continue
        rcs.append(e)
        last = t

    vid = os.path.splitext(os.path.basename(video))[0]
    saved = 0
    for e in rcs[:per_match]:
        fidx = int((e["t"] + sync) * fps)
        if fidx < 0 or fidx >= total:
            continue
        cap.set(cv2.CAP_PROP_POS_FRAMES, fidx)
        ok, frame = cap.read()
        if not ok:
            continue

        labels = []  # (cls, cx, cy, w, h) en px
        # cursor real (auto): matcher clásico busca la manita/espada del jugador
        tracker.drop_track()
        m = tracker.locate(frame, fw, fh)
        if m.val >= 0.85:
            w, h = m.size
            if w > 0 and h > 0:
                cls = CURSOR_ATTACK if m.evt_type == "attack" else CURSOR_MOVE
                labels.append((cls, m.x + w / 2.0, m.y + h / 2.0, float(w), float(h)))
        # clic (JSON): el anillo aparece centrado en el punto del clic
        labels.append((CLICK_CLS, float(e["x"]), float(e["y"]), float(click_box), float(click_box)))

        stem = f"gtclick_{vid}_{fidx:07d}"
        is_val = (hash(stem) % 1000) / 1000.0 < val_split
        sub = "val" if is_val else "train"
        cv2.imwrite(os.path.join(out_dir, "images", sub, stem + ".jpg"), frame,
                    [cv2.IMWRITE_JPEG_QUALITY, 90])
        with open(os.path.join(out_dir, "labels", sub, stem + ".txt"), "w") as f:
            for cls, cx, cy, w, h in labels:
                f.write(f"{cls} {cx / fw:.6f} {cy / fh:.6f} {w / fw:.6f} {h / fh:.6f}\n")
        saved += 1
    cap.release()
    return saved


def main():
    if len(sys.argv) < 2:
        print("Usage: python gt_click_dataset.py <out_dir> [--videos-dir DIR] "
              "[--per-match N] [--sync -0.6] [--click-box 72]")
        sys.exit(1)
    os.environ["OPENCV_LOG_LEVEL"] = "OFF"
    os.environ.setdefault("VOD_USE_OPENCL", "0")

    out_dir = os.path.abspath(sys.argv[1])
    per_match = _arg("--per-match", 200, int)
    sync = _arg("--sync", -0.6, float)
    click_box = _arg("--click-box", 72, int)
    videos_dir = _arg("--videos-dir",
                      os.path.join(os.path.expanduser("~"), "Videos", "LeagueRecorder"), str)

    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cursors = os.path.join(repo, "assets", "cursors")
    for sub in ("images/train", "images/val", "labels/train", "labels/val"):
        os.makedirs(os.path.join(out_dir, sub), exist_ok=True)

    cfg = Config.from_env()
    lib = TemplateLibrary(cursors, cfg)
    tracker = CursorTracker(lib, cfg)

    # empareja cada vídeo con su JSON hermano
    vids = sorted(glob.glob(os.path.join(videos_dir, "**", "*.mp4"), recursive=True))
    total = 0
    for i, v in enumerate(vids, 1):
        js = os.path.splitext(v)[0] + ".json"
        if not os.path.exists(js):
            continue
        n = process_match(v, js, out_dir, tracker, cfg, sync, per_match, click_box)
        total += n
        sys.stderr.write(f"[GT] ({i}/{len(vids)}) {os.path.basename(v)} -> {n} (total {total})\n")
        sys.stderr.flush()

    sys.stderr.write(f"[GT] LISTO. frames de clic={total}\n")
    print(json.dumps({"saved": total}))


if __name__ == "__main__":
    main()
