"""Fase 3: mide el VERIFICADOR temporal sobre partidas HELD-OUT.

Corre el generador (candidatos de color), extrae el stack de cada candidato,
lo pasa por click_verifier.onnx y filtra por umbral de probabilidad. Reporta
P/R/F1 vs el JSON, barriendo el umbral, y lo compara con el baseline (sin filtrar).

Uso: python eval_verifier.py <match_or_video> [--onnx models/click_verifier.onnx]
                             [--minutes 5] [--crop 160] [--size 64]
"""

import os
import sys
import json

os.environ.setdefault("VOD_USE_OPENCL", "0")
os.environ.setdefault("OPENCV_LOG_LEVEL", "OFF")
import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from eval_clicks import run_once, gt_clicks, match, prf, CLICK_EVTS, resolve_video
from click_verifier_dataset import build_stacks, K_OFFSETS


def _arg(flag, default, cast=str):
    if flag in sys.argv:
        try:
            return cast(sys.argv[sys.argv.index(flag) + 1])
        except (IndexError, ValueError):
            pass
    return default


def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    onnx = _arg("--onnx", os.path.join(repo, "models", "click_verifier.onnx"))
    minutes = _arg("--minutes", 5.0, float)
    crop = _arg("--crop", 200, int)
    size = _arg("--size", 64, int)
    video, js = resolve_video(sys.argv[1])

    if minutes > 0:
        os.environ["VOD_MAX_FRAMES"] = str(int(minutes * 60 * 60))
    model = os.path.join(repo, "models", "cursor_multi_fp32.onnx")
    res = run_once(video, 960, 0.30, 48, 8, model)
    fw, fh = res["width"], res["height"]
    gt = gt_clicks(js, fw, fh, -0.6, minutes * 60 if minutes > 0 else 0.0)
    cands = [e for e in res["events"] if e["evt"] in CLICK_EVTS]

    cap = cv2.VideoCapture(video); fps = cap.get(cv2.CAP_PROP_FPS) or 60.0; cap.release()
    skip = max(1, int(round(fps / 30.0)))
    samples = [{"fidx": int(c["t"] * fps), "cx": c["x"], "cy": c["y"]} for c in cands]
    stacks = build_stacks(video, samples, skip, crop, size)

    import onnxruntime as ort
    sess = ort.InferenceSession(onnx, providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    C = len(K_OFFSETS) * 3
    # arma batch de los candidatos con stack; los sin stack (borde) se aceptan (prob=1)
    probs = np.ones(len(cands), dtype=np.float32)
    sids = [sid for sid in range(len(cands)) if sid in stacks]
    if sids:
        batch = np.stack([np.transpose(stacks[sid], (0, 3, 1, 2)).reshape(C, size, size)
                          for sid in sids]).astype(np.float32) / 255.0
        logits = sess.run(None, {"stack": batch})[0].reshape(-1)
        p = 1.0 / (1.0 + np.exp(-logits))
        for sid, pv in zip(sids, p):
            probs[sid] = pv

    print(f"[eval-verifier] {os.path.basename(video)}  cand={len(cands)} con_stack={len(sids)} GT={len(gt)}")
    # baseline (sin verificador)
    for lbl, keep in [("BASELINE (sin verif)", np.ones(len(cands), bool))] + \
                     [(f"thr={t:.2f}", probs > t) for t in (0.3, 0.4, 0.5, 0.6, 0.7)]:
        dc = [c for c, k in zip(cands, keep) if k]
        line = f"  {lbl:20s} det={len(dc):4d}"
        for tol, dist in [(0.4, 0), (0.4, 200)]:
            tp, fp, fn, _ = match(dc, gt, tol, dist)
            pp, rr, ff = prf(tp, fp, fn)
            line += f"  |{'temp' if dist==0 else '200px'}: P{pp:.2f} R{rr:.2f} F1{ff:.2f}"
        print(line)


if __name__ == "__main__":
    main()
