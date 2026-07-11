"""Backend de análisis de VODs por DETECTOR YOLO en GPU (onnxruntime).

Sustituye el template matching por un YOLO (1 clase: "cursor") corriendo en la
GPU vía onnxruntime (CUDA EP, con fallback a CPU). La clave de rendimiento es el
**batching**: decodificamos N frames y los inferimos de golpe → la 5070 Ti se
satura, a diferencia del matchTemplate secuencial.

Reutiliza `ClickDetector` de analyzer.py para los clics (HSV rojo/verde + freno),
así que el tipo de clic (ataque/movimiento) se sigue distinguiendo sin que el
detector tenga que aprender la clase rara del cursor de ataque.

Emite el MISMO JSON que el analizador clásico: {events:[{t,x,y,evt}],duration,width,height}.
"""

import cv2
import numpy as np
import sys
import json
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyzer import Config, ClickDetector


def _letterbox(img, new_shape):
    """Redimensiona manteniendo aspecto y rellena a (new_shape,new_shape).
    Devuelve (img_padded, ratio, (dw, dh))."""
    h, w = img.shape[:2]
    r = min(new_shape / h, new_shape / w)
    nh, nw = int(round(h * r)), int(round(w * r))
    resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((new_shape, new_shape, 3), 114, dtype=np.uint8)
    dw, dh = (new_shape - nw) // 2, (new_shape - nh) // 2
    canvas[dh:dh + nh, dw:dw + nw] = resized
    return canvas, r, (dw, dh)


def _add_cuda_dll_dirs():
    """Hace que onnxruntime-gpu encuentre las DLLs de CUDA 12 / cuDNN 9.

    Registrar el directorio con os.add_dll_directory NO basta (onnxruntime no
    resuelve la cadena de dependencias por esa vía). Lo que funciona de verdad es
    **importar torch**, que hace LoadLibrary de las DLLs CUDA/cuDNN en el proceso;
    onnxruntime las encuentra ya cargadas. El venv reusado por la app tiene torch.
    (env VOD_CUDA_DLL_DIR se mantiene como pista para un futuro runtime empaquetado
    sin torch, donde habría que cargar las DLLs explícitamente.)"""
    for d in os.environ.get("VOD_CUDA_DLL_DIR", "").split(os.pathsep):
        if d and os.path.isdir(d):
            try:
                os.add_dll_directory(d)
            except Exception:
                pass
    try:
        import torch  # noqa: F401  (fuerza la carga de las DLLs CUDA en el proceso)
    except Exception:
        pass


class YoloCursorDetector:
    """Carga el ONNX y detecta el cursor en lotes de frames."""

    def __init__(self, model_path, imgsz=1280, conf=0.30, providers=None):
        _add_cuda_dll_dirs()
        import onnxruntime as ort
        self.imgsz = imgsz
        self.conf = conf
        if providers is None:
            # HEURISTIC evita la búsqueda EXHAUSTIVE de cuDNN en el primer batch
            # (que costaba ~80s de warmup con FP16); el steady-state apenas cambia.
            providers = [
                ("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"}),
                "CPUExecutionProvider",
            ]
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.sess = ort.InferenceSession(model_path, sess_options=so, providers=providers)
        self.input_name = self.sess.get_inputs()[0].name
        self.active = self.sess.get_providers()
        # ¿fp16? miramos el tipo del input del modelo.
        it = self.sess.get_inputs()[0].type
        self.dtype = np.float16 if "float16" in it else np.float32

    def preprocess_one(self, frame):
        """Letterbox + normalize + swapRB + CHW de UN frame, TODO en C (cv2, que
        libera el GIL) para que el pool de hilos lo paralelice de verdad. Antes el
        transpose/astype/div de numpy retenían el GIL y serializaban el preproceso."""
        pad, r, (dw, dh) = _letterbox(frame, self.imgsz)
        blob = cv2.dnn.blobFromImage(pad, scalefactor=1.0 / 255.0, swapRB=True)  # [1,3,H,W] f32
        row = blob[0]
        if self.dtype == np.float16:
            row = row.astype(np.float16)
        return row, (r, dw, dh)

    def _preprocess(self, frames):
        batch = np.empty((len(frames), 3, self.imgsz, self.imgsz), dtype=self.dtype)
        metas = []
        for i, f in enumerate(frames):
            chw, meta = self.preprocess_one(f)
            batch[i] = chw
            metas.append(meta)
        return batch, metas

    def _decode(self, outs, metas):
        """Devuelve por frame (cx, cy, bw, bh, score, cls) de la mejor detección, en
        coords del vídeo original. Funciona con 1 o N clases (single/multi)."""
        outs = np.asarray(outs, dtype=np.float32)
        results = []
        nc = outs.shape[1] - 4  # filas: 4 de caja + nc de clase
        for i in range(outs.shape[0]):
            pred = outs[i]                        # [4+nc, A]
            cls_scores = pred[4:4 + nc, :]        # [nc, A]
            cls_idx = cls_scores.argmax(axis=0)   # clase por anchor
            scores = cls_scores.max(axis=0)       # score por anchor
            a = int(np.argmax(scores))
            s = float(scores[a])
            if s < self.conf:
                results.append(None)
                continue
            cx, cy, bw, bh = pred[:4, a]
            r, dw, dh = metas[i]
            cx = (cx - dw) / r; cy = (cy - dh) / r
            bw = bw / r; bh = bh / r
            results.append((cx, cy, bw, bh, s, int(cls_idx[a])))
        return results

    def infer_prepared(self, batch, metas):
        """Infiere un batch YA preprocesado (np array [B,3,H,W]) y decodifica."""
        outs = self.sess.run(None, {self.input_name: batch})[0]
        return self._decode(outs, metas)

    def detect(self, frames):
        """Ruta simple (sin pipeline): preprocesa + infiere una lista de frames."""
        batch, metas = self._preprocess(frames)
        return self.infer_prepared(batch, metas)


class YoloVideoAnalyzer:
    def __init__(self, cfg: Config, model_path, imgsz=1280, conf=0.30, batch=32, workers=4):
        self.cfg = cfg
        self.model_path = model_path
        self.imgsz = imgsz
        self.conf = conf
        self.batch = batch
        self.workers = workers

    def run(self, video_path):
        import threading
        import queue
        from concurrent.futures import ThreadPoolExecutor

        cfg = self.cfg
        detector = YoloCursorDetector(self.model_path, self.imgsz, self.conf)
        gpu = any("CUDA" in p or "Tensorrt" in p for p in detector.active)
        sys.stderr.write(f"[YOLO] modelo={os.path.basename(self.model_path)} imgsz={self.imgsz} "
                         f"batch={self.batch} workers={self.workers} providers={detector.active}\n")
        sys.stderr.write(f"[HARDWARE] Aceleracion GPU Activa: {gpu}\n")
        if gpu:
            sys.stderr.write("[HARDWARE] Dispositivo: onnxruntime CUDA (GPU)\n")
        sys.stderr.flush()

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            print(json.dumps({"events": [], "duration": 0.0, "width": 0, "height": 0}))
            return

        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        fh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        skip = max(1, int(round(fps / cfg.target_fps)))

        clicker = ClickDetector(cfg)
        events = []

        # Pipeline: un hilo PRODUCTOR decodifica frames (en orden) a una cola
        # acotada; el hilo principal preprocesa cada batch EN PARALELO (pool), lo
        # infiere en GPU y hace la detección de clic SECUENCIAL (el ClickDetector
        # tiene estado y exige orden). Así se solapan CPU (decode+preproceso) y GPU.
        raw_q = queue.Queue(maxsize=self.batch)
        STOP = object()
        state = {"last_fc": 0}

        def producer():
            fc = 0
            while True:
                if not cap.grab():
                    break
                fc += 1
                if fc % skip != 0:
                    continue
                ok, frame = cap.retrieve()
                if not ok:
                    continue
                raw_q.put((fc / fps, frame, fc))
            state["last_fc"] = fc
            raw_q.put(STOP)

        th = threading.Thread(target=producer, daemon=True)
        th.start()
        pool = ThreadPoolExecutor(max_workers=self.workers)

        # Hotspot (punta) por clase, como fracción de la caja. Calculado de los
        # sprites (ver synth_dataset.py): punteros/espadas -> pico sup-izq;
        # cruces de target -> centro. La estela y el recuadro HSV del clic se anclan
        # en la punta. Clases: 0=hand 1=arrow 2=sword 3=target.
        HOTSPOT = {0: (0.06, 0.01), 1: (0.07, 0.05), 2: (0.03, 0.01), 3: (0.49, 0.49)}
        ATTACK_CLS = {2, 3}  # espada / target = cursor de ataque -> señal de clic
        DEFAULT_HS = (0.06, 0.01)

        def process_batch(items):
            frames = [it[1] for it in items]
            pre = list(pool.map(detector.preprocess_one, frames))  # orden preservado
            batch = np.empty((len(frames), 3, self.imgsz, self.imgsz), dtype=detector.dtype)
            metas = []
            for j, (chw, meta) in enumerate(pre):
                batch[j] = chw
                metas.append(meta)
            dets = detector.infer_prepared(batch, metas)
            for (t_sec, frame, fc), det in zip(items, dets):
                if det is None:
                    continue
                cx, cy, bw, bh, score, cls = det
                fx, fy = HOTSPOT.get(cls, DEFAULT_HS)
                tipx = cx - bw * 0.5 + fx * bw
                tipy = cy - bh * 0.5 + fy * bh
                best_type = "attack" if cls in ATTACK_CLS else "move"
                evt = clicker.classify(frame, tipx, tipy, (0, 0), best_type)
                events.append({"t": t_sec, "x": int(tipx), "y": int(tipy), "evt": evt})

        batch_items = []
        while True:
            item = raw_q.get()
            if item is STOP:
                break
            batch_items.append(item)
            if len(batch_items) >= self.batch:
                process_batch(batch_items)
                if total > 0:
                    progress = batch_items[-1][2] / total * 100
                    sys.stderr.write(f"PROGRESS:{progress:.1f}\n")
                    sys.stderr.write(f"Analizando VOD (GPU): {batch_items[-1][0]/60:.1f} min ({progress:.1f}%)\n")
                    sys.stderr.flush()
                batch_items = []
        if batch_items:
            process_batch(batch_items)

        th.join()
        pool.shutdown()
        cap.release()
        duration = (state["last_fc"] / fps) if fps > 0 else 0.0
        sys.stderr.write(f"[YOLO] Analisis finalizado. eventos={len(events)}\n")
        print(json.dumps({"events": events, "duration": duration, "width": fw, "height": fh}))


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python yolo_backend.py <video> <model.onnx> [imgsz] [conf] [batch]")
        sys.exit(1)
    os.environ["OPENCV_LOG_LEVEL"] = "OFF"
    cfg = Config.from_env()
    # Los recortes HSV del ClickDetector son diminutos (60x60): OpenCL ahí es puro
    # overhead y contiende con el contexto CUDA de onnxruntime. CPU puro es mejor.
    cfg.use_opencl = False
    imgsz = int(sys.argv[3]) if len(sys.argv) > 3 else 1280
    conf = float(sys.argv[4]) if len(sys.argv) > 4 else 0.30
    batch = int(sys.argv[5]) if len(sys.argv) > 5 else 32
    workers = int(sys.argv[6]) if len(sys.argv) > 6 else 4
    YoloVideoAnalyzer(cfg, sys.argv[2], imgsz, conf, batch, workers=workers).run(sys.argv[1])
