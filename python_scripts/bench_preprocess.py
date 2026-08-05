"""Micro-benchmark del preproceso del analizador de VODs.

El perfilado de `yolo_backend.py` (VOD_PROFILE=1) mostró que el preproceso pesa
MÁS que la inferencia. Este script desglosa a dónde se va ese tiempo y prueba dos
hipótesis:

  1. El ensamblado del batch (`batch[j] = chw`) mueve cientos de MB por lote y
     puede dominar sobre el resize.
  2. Letterbox a 960x960 desde 16:9 deja el 44% del tensor en relleno gris. Si el
     ONNX acepta entrada rectangular (se exportó con dynamic=True), alimentarlo a
     960x544 ahorraría ese 44% en preproceso Y en inferencia.

Uso:  python bench_preprocess.py <video> <model.onnx> [imgsz]
"""

import os
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from yolo_backend import _letterbox, _add_cuda_dll_dirs  # noqa: E402

N = 200          # frames a medir
BATCH = 48


def _grab_frames(video, n):
    cap = cv2.VideoCapture(video)
    frames = []
    while len(frames) < n:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f)
    cap.release()
    return frames


def _letterbox_rect(img, tw, th):
    """Letterbox a un destino RECTANGULAR (tw x th) en vez de cuadrado."""
    h, w = img.shape[:2]
    r = min(th / h, tw / w)
    nh, nw = int(round(h * r)), int(round(w * r))
    resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((th, tw, 3), 114, dtype=np.uint8)
    dw, dh = (tw - nw) // 2, (th - nh) // 2
    canvas[dh:dh + nh, dw:dw + nw] = resized
    return canvas, r, (dw, dh)


def bench(label, fn, frames):
    fn(frames[0])                      # calentar
    t0 = time.perf_counter()
    for f in frames:
        fn(f)
    dt = time.perf_counter() - t0
    print(f"  {label:<34} {dt / len(frames) * 1000:7.2f} ms/frame")
    return dt / len(frames)


def main():
    video, model = sys.argv[1], sys.argv[2]
    imgsz = int(sys.argv[3]) if len(sys.argv) > 3 else 960

    frames = _grab_frames(video, N)
    h, w = frames[0].shape[:2]
    # alto rectangular equivalente, múltiplo de 32 (requisito de la red)
    rect_h = int(round(imgsz * h / w / 32)) * 32
    waste = 1 - (imgsz * rect_h) / (imgsz * imgsz)
    print(f"\nvídeo {w}x{h} · {len(frames)} frames · imgsz={imgsz}")
    print(f"letterbox cuadrado {imgsz}x{imgsz} -> {waste * 100:.0f}% del tensor es relleno")
    print(f"alternativa rectangular: {imgsz}x{rect_h}\n")

    print("[1] Etapas del preproceso actual (por frame, 1 hilo)")
    bench("letterbox (resize+pad)", lambda f: _letterbox(f, imgsz), frames)
    pads = [_letterbox(f, imgsz)[0] for f in frames[:8]]
    bench("blobFromImage (norm+swapRB+CHW)",
          lambda f: cv2.dnn.blobFromImage(pads[0], scalefactor=1 / 255.0, swapRB=True), frames)
    bench("letterbox RECTANGULAR", lambda f: _letterbox_rect(f, imgsz, rect_h), frames)

    print("\n[2] Ensamblado del batch (copia a tensor contiguo)")
    chw = cv2.dnn.blobFromImage(pads[0], scalefactor=1 / 255.0, swapRB=True)[0]
    mb = BATCH * chw.nbytes / 1024 / 1024
    batch = np.empty((BATCH, 3, imgsz, imgsz), dtype=np.float32)
    t0 = time.perf_counter()
    reps = 20
    for _ in range(reps):
        for j in range(BATCH):
            batch[j] = chw
    dt = (time.perf_counter() - t0) / reps
    print(f"  batch de {BATCH} = {mb:.0f} MB -> {dt * 1000:7.2f} ms/lote "
          f"({dt / BATCH * 1000:.2f} ms/frame, {mb / dt / 1024:.1f} GB/s)")

    print("\n[3] ¿Acepta el ONNX entrada rectangular?")
    _add_cuda_dll_dirs()
    import onnxruntime as ort
    sess = ort.InferenceSession(model, providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    inp = sess.get_inputs()[0]
    print(f"  input '{inp.name}' shape declarada: {inp.shape}  tipo: {inp.type}")
    dt_np = np.float16 if "float16" in inp.type else np.float32
    for (bh, bw) in [(imgsz, imgsz), (rect_h, imgsz)]:
        x = np.zeros((2, 3, bh, bw), dtype=dt_np)
        try:
            t0 = time.perf_counter()
            for _ in range(10):
                sess.run(None, {inp.name: x})
            print(f"  OK  {bw}x{bh}: {(time.perf_counter() - t0) / 10 * 1000:6.1f} ms/lote de 2")
        except Exception as e:
            print(f"  FALLA {bw}x{bh}: {str(e).splitlines()[0][:110]}")


if __name__ == "__main__":
    os.environ["OPENCV_LOG_LEVEL"] = "OFF"
    main()
