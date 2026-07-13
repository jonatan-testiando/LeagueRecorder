"""Harness de validación de detección de CLICS para VOD Analysis.

Corre el backend YOLO (yolo_backend.YoloVideoAnalyzer) sobre una partida propia
que SÍ trae `<match>.json`, y compara los clics detectados contra el JSON como
ground truth -> precision / recall / F1. Así se calibra a ciegas nunca más.

El JSON registra cada clic real {t,x,y,evt}. Sincronización: el frame del vídeo
que corresponde a un evento del JSON está en `video_t = json_t + sync`
(sync = -0.6s, verificado). Se replican los mismos filtros que el dataset de
entreno (gt_click_dataset.py): fase inicial, HUD/tienda, bordes y espaciado.

Uso:
  python eval_clicks.py <video_or_matchdir> [--minutes M] [--ab]
                        [--tol 0.5] [--dist 0] [--sync -0.6]
                        [--model PATH] [--imgsz 960] [--conf 0.30]
                        [--batch 48] [--workers 8]

  --minutes M : analiza solo los primeros M minutos (VOD_MAX_FRAMES). Rápido para iterar.
  --ab        : corre DOS veces (compensación de cámara OFF vs ON) y compara.
  --tol S     : ventana temporal de match en segundos (default 0.5).
  --dist PX   : tolerancia espacial en px (0 = ignorar posición, solo tiempo).

Todo corre en el .venv-train (torch cu128 + onnxruntime-gpu), igual que la app.
"""

import os
import sys
import glob
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# --- ground truth para EVALUAR (NO el filtro de entreno) ----------------------
# OJO: gt_click_dataset.py filtra agresivo (spacing 1.2s, t>=90) para SUBSAMPLEAR
# ejemplos de entreno. Para EVALUAR eso está MAL: descarta clics reales que el
# detector sí acierta -> los contaría como falsos positivos y hunde la precisión
# artificialmente (medido: P real 0.96 vs 0.26 con el filtro de entreno).
# Aquí el GT es COMPLETO, deduplicado solo a la resolución del detector (COOLDOWN
# ~0.4s, no puede disparar más rápido), y se excluye lo NO detectable en el frame
# (HUD/tienda/minimapa/bordes: esos clics no dibujan anillo en el mundo visible).
MIN_SPACING = 0.35     # s entre clics GT = resolución del detector (no penaliza ráfagas que fusiona)
Y_MAX_FRAC = 0.80      # descarta HUD inferior (tienda/barra/minimapa) — sin anillo visible
Y_MIN = 200            # descarta zona superior (marcador/objetivos)
X_MARGIN = 60          # descarta bordes laterales
T_MIN = 0.0            # sin recorte temporal (los clics de tienda ya caen por el filtro de HUD)
CLICK_EVTS = ("left_click", "right_click")


def _arg(flag, default, cast):
    if flag in sys.argv:
        try:
            return cast(sys.argv[sys.argv.index(flag) + 1])
        except (IndexError, ValueError):
            pass
    return default


def _flag(flag):
    return flag in sys.argv


def resolve_video(path):
    """Acepta un .mp4 o un directorio de match; devuelve (video, json)."""
    if os.path.isdir(path):
        vids = glob.glob(os.path.join(path, "*.mp4"))
        if not vids:
            raise SystemExit(f"No hay .mp4 en {path}")
        video = vids[0]
    else:
        video = path
    js = os.path.splitext(video)[0] + ".json"
    if not os.path.exists(js):
        raise SystemExit(f"No existe el JSON hermano: {js}")
    return video, js


def gt_clicks(js_path, fw, fh, sync, t_max):
    """Clics reales del JSON en TIEMPO DE VÍDEO, filtrados y espaciados."""
    d = json.load(open(js_path, encoding="utf-8"))
    me = d.get("mouse_events", [])
    y_max = fh * Y_MAX_FRAC
    out = []
    last = -99.0
    for e in me:
        if e.get("evt") not in CLICK_EVTS:
            continue
        t, x, y = float(e["t"]), float(e["x"]), float(e["y"])
        if t < T_MIN or (t - last) < MIN_SPACING:
            continue
        if not (X_MARGIN < x < fw - X_MARGIN and Y_MIN < y < y_max):
            continue
        vt = t + sync
        if t_max and vt > t_max:
            continue
        out.append({"t": vt, "x": x, "y": y, "evt": e["evt"]})
        last = t
    return out


def match(det, gt, tol, dist):
    """Empareja 1:1 clics detectados con GT por cercanía temporal (greedy).
    Devuelve (tp, fp, fn, pairs)."""
    det = sorted(det, key=lambda e: e["t"])
    gt = sorted(gt, key=lambda e: e["t"])
    used = [False] * len(gt)
    tp = 0
    pairs = []
    for de in det:
        best, bestdt = -1, tol + 1e9
        for i, g in enumerate(gt):
            if used[i]:
                continue
            dt = abs(g["t"] - de["t"])
            if dt > tol:
                continue
            if dist and ((g["x"] - de["x"]) ** 2 + (g["y"] - de["y"]) ** 2) ** 0.5 > dist:
                continue
            if dt < bestdt:
                best, bestdt = i, dt
        if best >= 0:
            used[best] = True
            tp += 1
            pairs.append((de, gt[best]))
    fp = len(det) - tp
    fn = used.count(False)
    return tp, fp, fn, pairs


def prf(tp, fp, fn):
    p = tp / (tp + fp) if (tp + fp) else 0.0
    r = tp / (tp + fn) if (tp + fn) else 0.0
    f = 2 * p * r / (p + r) if (p + r) else 0.0
    return p, r, f


def run_once(video, imgsz, conf, batch, workers, model):
    import io
    import contextlib
    from analyzer import Config
    from yolo_backend import YoloVideoAnalyzer
    cfg = Config.from_env()
    cfg.use_opencl = False
    # run() imprime el JSON completo de eventos a stdout; lo silenciamos para no
    # ensuciar el reporte (nos quedamos con el valor de retorno).
    with contextlib.redirect_stdout(io.StringIO()):
        res = YoloVideoAnalyzer(cfg, model, imgsz, conf, batch, workers=workers).run(video)
    return res


def report(label, det_clicks, gt, tol, dist):
    tp, fp, fn, _ = match(det_clicks, gt, tol, dist)
    p, r, f = prf(tp, fp, fn)
    print(f"\n=== {label} ===")
    print(f"  detectados={len(det_clicks)}  GT={len(gt)}  "
          f"TP={tp} FP={fp} FN={fn}")
    print(f"  precision={p:.3f}  recall={r:.3f}  F1={f:.3f}")
    return p, r, f


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    os.environ["OPENCV_LOG_LEVEL"] = "OFF"
    os.environ.setdefault("VOD_USE_OPENCL", "0")

    video, js = resolve_video(sys.argv[1])
    minutes = _arg("--minutes", 0.0, float)
    tol = _arg("--tol", 0.5, float)
    dist = _arg("--dist", 0.0, float)
    sync = _arg("--sync", -0.6, float)
    imgsz = _arg("--imgsz", 960, int)
    conf = _arg("--conf", 0.30, float)
    batch = _arg("--batch", 48, int)
    workers = _arg("--workers", 8, int)
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    model = _arg("--model", os.path.join(repo, "models", "cursor_multi_fp32.onnx"), str)
    ab = _flag("--ab")

    if minutes > 0:
        # a 60fps analizamos ~ minutes*60*60 frames de vídeo (el skip lo maneja el backend)
        os.environ["VOD_MAX_FRAMES"] = str(int(minutes * 60 * 60))
    t_max = minutes * 60 if minutes > 0 else 0.0

    print(f"[eval] video={os.path.basename(video)} modelo={os.path.basename(model)} "
          f"minutos={minutes or 'todo'} tol={tol}s dist={dist or 'off'}px sync={sync}")

    modes = [("STABILIZE OFF", "0"), ("STABILIZE ON", "1")] if ab \
        else [("actual", os.environ.get("VOD_CLICK_STABILIZE", "1"))]

    results = {}
    gt = None
    for label, stab in modes:
        os.environ["VOD_CLICK_STABILIZE"] = stab
        res = run_once(video, imgsz, conf, batch, workers, model)
        if gt is None:
            gt = gt_clicks(js, res["width"], res["height"], sync, t_max)
        det_clicks = [e for e in res["events"] if e["evt"] in CLICK_EVTS]
        results[label] = report(label, det_clicks, gt, tol, dist)

    if ab:
        (po, ro, fo), (pn, rn, fn_) = results["STABILIZE OFF"], results["STABILIZE ON"]
        print("\n=== A/B (ON - OFF) ===")
        print(f"  precision {po:.3f} -> {pn:.3f}  ({pn - po:+.3f})")
        print(f"  recall    {ro:.3f} -> {rn:.3f}  ({rn - ro:+.3f})")
        print(f"  F1        {fo:.3f} -> {fn_:.3f}  ({fn_ - fo:+.3f})")


if __name__ == "__main__":
    main()
