"""Fase 1 del CLASIFICADOR TEMPORAL de clics (verificador de 2 etapas).

Extrae stacks de frames etiquetados para entrenar un clasificador que, dado un
CANDIDATO de clic del generador de color, decida clic-real / falso-positivo
mirando la ANIMACIÓN (varias frames), no un frame plano.

Etiquetas (gratis, del JSON de la partida):
  - POSITIVO (1): candidato que coincide con un clic real del JSON  -> anillo real
  - NEGATIVO duro (0): candidato que NO coincide -> falso positivo del heurístico
  - NEGATIVO fácil (0): frames 'move' lejos de cualquier clic -> sin anillo

Cada muestra = stack (T, S, S, 3) uint8 centrado en la punta del cursor (así en
inferencia se recorta igual). Se guarda un .npz por corrida con X,y,meta.

Uso:
  python click_verifier_dataset.py <out.npz> [--matches a b c] [--minutes 5]
        [--crop 160] [--size 64] [--tol 0.4] [--dist 200] [--easy-per 200]
"""

import os
import sys
import json
import glob

os.environ.setdefault("VOD_USE_OPENCL", "0")
os.environ.setdefault("OPENCV_LOG_LEVEL", "OFF")
import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from eval_clicks import run_once, gt_clicks, match, CLICK_EVTS

# offsets temporales del stack, en frames de ANÁLISIS (skip ~33ms). La animación
# dura ~0.5s: onset -> convergencia -> anillo -> EXPANSIÓN (crecimiento radial, la
# firma que los FP estáticos no tienen). Ventana ANCHA no uniforme: densa al
# principio (convergencia rápida), espaciada al final (para llegar a la expansión
# sin explotar el nº de frames). -33ms .. +366ms.
K_OFFSETS = [-1, 1, 3, 5, 8, 11]


def _arg(flag, default, cast=str):
    if flag in sys.argv:
        try:
            return cast(sys.argv[sys.argv.index(flag) + 1])
        except (IndexError, ValueError):
            pass
    return default


def _argmulti(flag):
    if flag not in sys.argv:
        return None
    i = sys.argv.index(flag) + 1
    out = []
    while i < len(sys.argv) and not sys.argv[i].startswith("--"):
        out.append(sys.argv[i]); i += 1
    return out


def _patch(img, cx, cy, crop, size):
    p = cv2.getRectSubPix(img, (crop, crop), (float(cx), float(cy)))  # borde replicado
    if p.shape[0] != size:
        p = cv2.resize(p, (size, size), interpolation=cv2.INTER_AREA)
    return p


def build_stacks(video, samples, skip, crop, size):
    """UNA sola pasada secuencial: decodifica el vídeo de corrido y recorta, para
    cada muestra, sus T frames. `samples` = lista de dicts con fidx,cx,cy.
    Devuelve dict sid -> stack (T,size,size,3) para las muestras completas."""
    cap = cv2.VideoCapture(video)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    # mapa frame_idx -> [(sid, slot, cx, cy)]
    needs = {}
    for sid, s in enumerate(samples):
        for slot, k in enumerate(K_OFFSETS):
            f = s["fidx"] + k * skip
            if f < 0 or f >= total:
                needs.pop(sid, None)
                break
            needs.setdefault(f, []).append((sid, slot, s["cx"], s["cy"]))
    if not needs:
        cap.release(); return {}
    last_needed = max(needs)
    stacks = {}
    fc = -1
    while fc < last_needed:
        if not cap.grab():
            break
        fc += 1
        reqs = needs.get(fc)
        if not reqs:
            continue
        ok, img = cap.retrieve()
        if not ok:
            continue
        for sid, slot, cx, cy in reqs:
            stacks.setdefault(sid, [None] * len(K_OFFSETS))[slot] = _patch(img, cx, cy, crop, size)
    cap.release()
    T = len(K_OFFSETS)
    return {sid: np.stack(sl, 0) for sid, sl in stacks.items()
            if all(p is not None for p in sl) and len(sl) == T}


def process_match(video, js, out_X, out_y, out_meta, minutes, crop, size,
                  tol, dist, easy_per):
    name = os.path.splitext(os.path.basename(video))[0]
    if minutes > 0:
        os.environ["VOD_MAX_FRAMES"] = str(int(minutes * 60 * 60))
    else:
        os.environ.pop("VOD_MAX_FRAMES", None)
    model = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "models", "cursor_multi_fp32.onnx")
    res = run_once(video, 960, 0.30, 48, 8, model)      # generador baseline (alto recall)
    fw, fh = res["width"], res["height"]
    t_max = minutes * 60 if minutes > 0 else 0.0
    gt = gt_clicks(js, fw, fh, -0.6, t_max)
    cands = [e for e in res["events"] if e["evt"] in CLICK_EVTS]
    moves = [e for e in res["events"] if e["evt"] == "move"]
    tp, fp, fn, pairs = match(cands, gt, tol, dist)
    pos_ids = set(id(de) for de, _ in pairs)

    cap0 = cv2.VideoCapture(video)
    fps = cap0.get(cv2.CAP_PROP_FPS) or 60.0
    cap0.release()
    skip = max(1, int(round(fps / 30.0)))

    import bisect
    gt_ts = sorted(g["t"] for g in gt)
    NEG_GAP = 0.5   # un candidato es negativo solo si NO hay clic real a <0.5s (limpia duplicados)

    def _near_gt(t):
        i = bisect.bisect_left(gt_ts, t)
        return min([abs(gt_ts[j] - t) for j in (i - 1, i) if 0 <= j < len(gt_ts)] or [9])

    # arma la lista de muestras (candidatos + negativos fáciles)
    samples = []
    for c in cands:
        if id(c) in pos_ids:
            kind, label = "pos", 1
        elif _near_gt(c["t"]) >= NEG_GAP:
            kind, label = "neg_hard", 0
        else:
            continue        # duplicado cerca de un clic real -> ni pos ni neg
        samples.append({"fidx": int(c["t"] * fps), "cx": c["x"], "cy": c["y"], "label": label,
                        "meta": {"match": name, "t": c["t"], "x": c["x"], "y": c["y"],
                                 "evt": c["evt"], "kind": kind}})
    # negativos fáciles: 'move' lejos de cualquier clic (sin anillo)
    rng = np.random.RandomState(hash(name) & 0x7fffffff)
    cand_moves = [m for m in moves if m["t"] > 5.0]
    rng.shuffle(cand_moves)
    picked = 0
    for m in cand_moves:
        if picked >= easy_per:
            break
        if _near_gt(m["t"]) < 0.6:
            continue
        samples.append({"fidx": int(m["t"] * fps), "cx": m["x"], "cy": m["y"], "label": 0,
                        "meta": {"match": name, "t": m["t"], "x": m["x"], "y": m["y"],
                                 "evt": "move", "kind": "neg_easy"}})
        picked += 1

    stacks = build_stacks(video, samples, skip, crop, size)   # UNA pasada secuencial
    npos = nneg_hard = nneg_easy = 0
    for sid, s in enumerate(samples):
        st = stacks.get(sid)
        if st is None:
            continue
        out_X.append(st); out_y.append(s["label"]); out_meta.append(s["meta"])
        k = s["meta"]["kind"]
        if k == "pos": npos += 1
        elif k == "neg_hard": nneg_hard += 1
        else: nneg_easy += 1
    sys.stderr.write(f"[DS] {name}: pos={npos} neg_hard={nneg_hard} neg_easy={nneg_easy} "
                     f"(cand={len(cands)} gt={len(gt)} TP={tp} FP={fp})\n")
    sys.stderr.flush()


def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    out_path = os.path.abspath(sys.argv[1])
    minutes = _arg("--minutes", 5.0, float)
    crop = _arg("--crop", 200, int)
    size = _arg("--size", 64, int)
    tol = _arg("--tol", 0.4, float)
    dist = _arg("--dist", 200.0, float)
    easy_per = _arg("--easy-per", 200, int)
    base = os.path.join(os.path.expanduser("~"), "Videos", "LeagueRecorder")

    names = _argmulti("--matches")
    if names:
        vids = [os.path.join(base, n, n + ".mp4") for n in names]
    else:
        vids = sorted(glob.glob(os.path.join(base, "**", "*.mp4"), recursive=True))

    X, y, meta = [], [], []
    for v in vids:
        js = os.path.splitext(v)[0] + ".json"
        if not os.path.exists(js):
            continue
        process_match(v, js, X, y, meta, minutes, crop, size, tol, dist, easy_per)

    X = np.asarray(X, dtype=np.uint8)
    y = np.asarray(y, dtype=np.int64)
    np.savez_compressed(out_path, X=X, y=y, meta=json.dumps(meta),
                        T=len(K_OFFSETS), size=size, crop=crop)
    pos = int((y == 1).sum()); neg = int((y == 0).sum())
    sys.stderr.write(f"[DS] GUARDADO {out_path}  X={X.shape} pos={pos} neg={neg}\n")
    print(json.dumps({"path": out_path, "n": int(len(y)), "pos": pos, "neg": neg,
                      "shape": list(X.shape)}))


if __name__ == "__main__":
    main()
