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
import time
from collections import deque

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyzer import Config, _envi, _envf


def _letterbox(img, new_shape):
    """Redimensiona manteniendo aspecto y rellena al destino.

    `new_shape` puede ser un entero (destino cuadrado, comportamiento histórico) o
    una tupla (tw, th) para un destino rectangular.

    Con vídeo 16:9 y destino cuadrado, la escala la fija SIEMPRE el ancho
    (r = imgsz/W < imgsz/H), así que pasar a un destino 16:9 no cambia el tamaño
    con el que la red ve el cursor: solo elimina las barras grises de arriba y
    abajo, que son ~43% del tensor.
    """
    h, w = img.shape[:2]
    tw, th = (new_shape, new_shape) if isinstance(new_shape, int) else new_shape
    r = min(th / h, tw / w)
    nh, nw = int(round(h * r)), int(round(w * r))
    resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((th, tw, 3), 114, dtype=np.uint8)
    dw, dh = (tw - nw) // 2, (th - nh) // 2
    canvas[dh:dh + nh, dw:dw + nw] = resized
    return canvas, r, (dw, dh)


_HANN_CACHE = {}


def _hann(shape):
    """Ventana de Hanning cacheada por forma (reduce artefactos de borde en la
    correlación de fase)."""
    w = _HANN_CACHE.get(shape)
    if w is None:
        w = cv2.createHanningWindow((shape[1], shape[0]), cv2.CV_32F)
        _HANN_CACHE[shape] = w
    return w


def _estimate_shift(prev_bgr, now_bgr):
    """Traslación global (px, subpíxel) del fondo entre `prev` y `now` vía
    correlación de fase. warpAffine(prev, [[1,0,dx],[0,1,dy]]) alinea prev->now.
    `resp` (0..1) mide la confianza del pico; bajo = escena sin textura o cambio
    no traslacional (no conviene compensar)."""
    gp = cv2.cvtColor(prev_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gn = cv2.cvtColor(now_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    (dx, dy), resp = cv2.phaseCorrelate(gp, gn, _hann(gp.shape))
    return dx, dy, resp


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
    # TensorRT: sus DLLs (nvinfer_10.dll y compañía) viven en el paquete
    # `tensorrt_libs`. El proveedor de onnxruntime las busca por el cargador del
    # sistema, así que hay que meter esa carpeta en el PATH del proceso.
    try:
        import tensorrt_libs
        d = os.path.dirname(tensorrt_libs.__file__)
        os.add_dll_directory(d)
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        pass


# --- Perfilado (opt-in con VOD_PROFILE=1) -----------------------------------
# Acumula segundos por etapa. El decode corre en su propio hilo y se solapa con
# GPU, así que la suma de etapas es MAYOR que el wall clock: lo que interesa es
# comparar el tiempo del hilo productor contra el del hilo principal, porque el
# techo del pipeline es el mayor de los dos.
PROFILE = os.environ.get("VOD_PROFILE", "0") not in ("0", "", "false")
_T = {"decode": 0.0, "preprocess": 0.0, "infer": 0.0, "decode_out": 0.0, "click": 0.0}


class _Timer:
    """Cronómetro de bloque. Sin coste apreciable cuando PROFILE está apagado."""

    __slots__ = ("key", "t0")

    def __init__(self, key):
        self.key = key

    def __enter__(self):
        if PROFILE:
            self.t0 = time.perf_counter()
        return self

    def __exit__(self, *exc):
        if PROFILE:
            _T[self.key] += time.perf_counter() - self.t0
        return False


def _build_providers():
    """Proveedor de ejecución según VOD_EP: trt | cuda | cpu (por defecto cuda).

    TensorRT compila un motor específico para ESTA GPU la primera vez (de decenas
    de segundos a varios minutos). La caché lo evita en ejecuciones posteriores,
    pero no es portable entre GPUs, drivers ni versiones de TensorRT, así que solo
    sirve para la máquina que la genera.
    """
    ep = os.environ.get("VOD_EP", "cuda").lower()
    cuda = ("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"})
    if ep == "cpu":
        return ["CPUExecutionProvider"]
    if ep == "trt":
        cache = os.environ.get("VOD_TRT_CACHE", os.path.join(os.path.dirname(
            os.path.abspath(__file__)), "..", "models", "trt_cache"))
        os.makedirs(cache, exist_ok=True)
        trt = ("TensorrtExecutionProvider", {
            "trt_engine_cache_enable": True,
            "trt_engine_cache_path": cache,
            "trt_timing_cache_enable": True,
            "trt_fp16_enable": os.environ.get("VOD_TRT_FP16", "1") not in ("0", "", "false"),
        })
        return [trt, cuda, "CPUExecutionProvider"]
    return [cuda, "CPUExecutionProvider"]


class YoloCursorDetector:
    """Carga el ONNX y detecta el cursor en lotes de frames."""

    def __init__(self, model_path, imgsz=1280, conf=0.30, providers=None):
        _add_cuda_dll_dirs()
        import onnxruntime as ort
        self.imgsz = imgsz
        # Destino del letterbox (ancho, alto). Cuadrado por defecto; `set_frame_size`
        # lo ajusta al aspecto real del vídeo si VOD_RECT está activo.
        self.tw = self.th = imgsz
        self.conf = conf
        if providers is None:
            # HEURISTIC evita la búsqueda EXHAUSTIVE de cuDNN en el primer batch
            # (que costaba ~80s de warmup con FP16); el steady-state apenas cambia.
            providers = _build_providers()
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.sess = ort.InferenceSession(model_path, sess_options=so, providers=providers)
        self.input_name = self.sess.get_inputs()[0].name
        self.active = self.sess.get_providers()
        # Si un proveedor pedido no carga sus DLLs (típico: TensorRT sin nvinfer),
        # onnxruntime NO cae al siguiente de la lista: se queda SOLO en CPU, que
        # aquí es ~27x más lento por frame. Detectarlo y rehacer la sesión con CUDA
        # explícito evita una degradación silenciosa de minutos.
        if self.active == ["CPUExecutionProvider"] and providers != ["CPUExecutionProvider"]:
            sys.stderr.write(
                "[EP] El proveedor pedido no cargó; onnxruntime se quedó en CPU. "
                "Reintentando con CUDA.\n")
            self.sess = ort.InferenceSession(
                model_path, sess_options=so,
                providers=[("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"}),
                           "CPUExecutionProvider"])
            self.active = self.sess.get_providers()
        # ¿fp16? miramos el tipo del input del modelo.
        it = self.sess.get_inputs()[0].type
        self.dtype = np.float16 if "float16" in it else np.float32

    def set_frame_size(self, w, h):
        """Fija el destino del letterbox al aspecto del vídeo si VOD_RECT=1.

        El alto se redondea a múltiplo de 32 (el stride de la red). Con 1920x1080 e
        imgsz=960 sale 960x544: mismo factor de escala, 43% menos de tensor.
        """
        if os.environ.get("VOD_RECT", "0") in ("0", "", "false") or not w or not h:
            return
        self.tw = self.imgsz
        self.th = max(32, int(round(self.imgsz * h / w / 32)) * 32)

    def preprocess_one(self, frame):
        """Letterbox + normalize + swapRB + CHW de UN frame, TODO en C (cv2, que
        libera el GIL) para que el pool de hilos lo paralelice de verdad. Antes el
        transpose/astype/div de numpy retenían el GIL y serializaban el preproceso."""
        pad, r, (dw, dh) = _letterbox(frame, (self.tw, self.th))
        blob = cv2.dnn.blobFromImage(pad, scalefactor=1.0 / 255.0, swapRB=True)  # [1,3,H,W] f32
        row = blob[0]
        if self.dtype == np.float16:
            row = row.astype(np.float16)
        return row, (r, dw, dh)

    def _preprocess(self, frames):
        batch = np.empty((len(frames), 3, self.th, self.tw), dtype=self.dtype)
        metas = []
        for i, f in enumerate(frames):
            chw, meta = self.preprocess_one(f)
            batch[i] = chw
            metas.append(meta)
        return batch, metas

    def _decode(self, outs, metas):
        """Devuelve por frame una LISTA de detecciones (cx,cy,bw,bh,score,cls) en
        coords del vídeo, tras NMS. Multi-detección: en un mismo frame conviven el
        cursor y los arcos de clic. Funciona con 1 o N clases."""
        outs = np.asarray(outs, dtype=np.float32)
        nc = outs.shape[1] - 4
        frames = []
        for i in range(outs.shape[0]):
            pred = outs[i]                        # [4+nc, A]
            cls_scores = pred[4:4 + nc, :]
            cls_idx = cls_scores.argmax(axis=0)
            scores = cls_scores.max(axis=0)
            keep = scores > self.conf
            if not keep.any():
                frames.append([])
                continue
            boxes = pred[:4, keep].T              # [K,4] xywh letterbox
            cidx = cls_idx[keep]
            sc = scores[keep]
            r, dw, dh = metas[i]
            xywh = []                             # x,y,w,h (esquina) para NMSBoxes
            for (bx, by, bw, bh) in boxes:
                x = (bx - dw) / r; y = (by - dh) / r
                w = bw / r; h = bh / r
                xywh.append([x - w / 2, y - h / 2, w, h])
            idxs = cv2.dnn.NMSBoxes(xywh, sc.tolist(), self.conf, 0.5)
            dets = []
            for j in (np.array(idxs).flatten() if len(idxs) else []):
                x, y, w, h = xywh[j]
                dets.append((x + w / 2, y + h / 2, w, h, float(sc[j]), int(cidx[j])))
            frames.append(dets)
        return frames

    def infer_prepared(self, batch, metas):
        """Infiere un batch YA preprocesado (np array [B,3,H,W]) y decodifica."""
        with _Timer("infer"):
            outs = self.sess.run(None, {self.input_name: batch})[0]
        with _Timer("decode_out"):
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
            empty = {"events": [], "duration": 0.0, "width": 0, "height": 0}
            print(json.dumps(empty))
            return empty

        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        fh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        skip = max(1, int(round(fps / cfg.target_fps)))
        max_frames = _envi("VOD_MAX_FRAMES", 0)  # 0 = sin límite; >0 acota (harness/A-B)
        detector.set_frame_size(fw, fh)
        sys.stderr.write(f"[YOLO] entrada de red: {detector.tw}x{detector.th}\n")

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
                if max_frames and fc >= max_frames:
                    break
                with _Timer("decode"):
                    got = cap.grab()
                if not got:
                    break
                fc += 1
                if fc % skip != 0:
                    continue
                with _Timer("decode"):
                    ok, frame = cap.retrieve()
                if not ok:
                    continue
                raw_q.put((fc / fps, frame, fc))
            state["last_fc"] = fc
            raw_q.put(STOP)

        th = threading.Thread(target=producer, daemon=True)
        th.start()
        pool = ThreadPoolExecutor(max_workers=self.workers)

        # Hotspot (punta) por clase, fracción de la caja. Cursores 0-3.
        HOTSPOT = {0: (0.06, 0.01), 1: (0.07, 0.05), 2: (0.03, 0.01), 3: (0.49, 0.49)}
        DEFAULT_HS = (0.06, 0.01)

        # Detección de clic por explosión de color RESTRINGIDA a la punta del cursor
        # (que YOLO localiza). Restringir a la punta es lo que mata los falsos
        # positivos del entorno (agua/flores/iconos). Cubre normal y daltónico:
        # verde/azul = mover, rojo/naranja = atacar.
        # verde->azul (mover, cubre normal verde y daltónico azul)
        MOVE_RANGES = [((40, 90, 110), (130, 255, 255))]
        # rojo + naranja (atacar). El dorado del cursor se excluye aparte.
        ATK_RANGES = [((0, 150, 140), (12, 255, 255)),
                      ((13, 150, 140), (26, 255, 255)),
                      ((160, 150, 140), (180, 255, 255))]
        # Defaults calibrados (mejor precisión/recall medido vs JSON: ~0.50/0.83).
        # Los clics de VOD Analysis son APROXIMADOS (pistas), no exactos.
        CLICK_HALF = _envi("VOD_CLICK_HALF", 70)           # recuadro amplio (anillo)
        BRIGHT_MIN = _envi("VOD_CLICK_BRIGHT", 120)        # área mínima del blob nuevo
        COOLDOWN = _envi("VOD_CLICK_COOLDOWN", 12)         # frames analizados entre clics
        DFRAMES = _envi("VOD_CLICK_DFRAMES", 2)            # frames de referencia atrás (menos = menos deriva de cámara)
        # Compensación de movimiento de cámara: alinea el frame de referencia al
        # actual (correlación de fase) ANTES de restar, para que la hierba/agua
        # que se desplaza por el paneo se cancele y solo quede el anillo real.
        # MEDIDO (eval_clicks.py, A/B 5min): NO mejora precisión (0.256->0.253) —
        # el paneo no es la fuente de falsos positivos, así que va OFF por defecto.
        # Se deja cableado (VOD_CLICK_STABILIZE=1) por si ayuda en otros VODs.
        STABILIZE = _envi("VOD_CLICK_STABILIZE", 0)
        STAB_PAD = _envi("VOD_CLICK_STAB_PAD", 24)         # margen de contexto para estimar el shift
        STAB_MIN_RESP = _envf("VOD_CLICK_STAB_RESP", 0.05) # confianza mínima del pico para compensar
        # Verificador de CONVERGENCIA RADIAL: el indicador de clic de LoL son
        # flechas/chevrons convergiendo hacia un centro (patrón radial y HUECO en
        # el medio), no un blob macizo. Exigimos que los píxeles nuevos (1) se
        # repartan en varios sectores angulares (rechaza manchas de un solo lado)
        # y (2) dejen el centro relativamente vacío (rechaza blobs macizos de
        # efecto/terreno). Además el CENTROIDE = punto exacto del clic (mejor que
        # la punta, que ya se movió). VOD_CLICK_RADIAL=0 lo desactiva (A/B).
        RADIAL = _envi("VOD_CLICK_RADIAL", 0)
        RAD_SECTORS = _envi("VOD_CLICK_RAD_SECTORS", 8)    # nº de sectores angulares
        RAD_MIN_SEC = _envi("VOD_CLICK_RAD_MINSEC", 4)     # sectores ocupados mínimos
        RAD_INNER_MAX = _envf("VOD_CLICK_RAD_INNER", 0.22) # fracción máx de píxeles en el disco interior (hueco)
        RAD_MIN_PIX = _envi("VOD_CLICK_RAD_MINPIX", 40)    # píxeles nuevos mínimos para evaluar
        RAD_DIAG = _envi("VOD_CLICK_RAD_DIAG", 0)          # emite features sin filtrar (para calibrar el harness)
        click_state = {"since": 999}
        frame_hist = deque(maxlen=DFRAMES + 2)             # frames analizados recientes

        def _tip(cx, cy, bw, bh, cls):
            fx, fy = HOTSPOT.get(cls, DEFAULT_HS)
            return cx - bw * 0.5 + fx * bw, cy - bh * 0.5 + fy * bh

        def _masks(hsv, ranges):
            out = None
            for lo, hi in ranges:
                m = cv2.inRange(hsv, np.array(lo, np.uint8), np.array(hi, np.uint8))
                out = m if out is None else cv2.bitwise_or(out, m)
            return out

        def _click_kind(frame, prev, tx, ty, cur_w, cur_h):
            """Cuenta píxeles de color de clic que son NUEVOS respecto a `prev`
            (el anillo aparece de golpe; la hierba/agua estática se cancela).

            El clic se ancla al ONSET: al restar contra un frame MUY reciente
            (DFRAMES=2, ~66ms atrás) el anillo dispara el pico justo cuando aparece
            pegado a la punta; los frames posteriores de la animación ya no son
            "nuevos" y el COOLDOWN los suprime. La compensación de cámara alinea
            el fondo antes de restar para no confundir el paneo con el anillo."""
            H, W = frame.shape[:2]
            # Contexto con margen: estimamos el shift de cámara sobre una ventana
            # algo mayor y luego analizamos solo la caja interna (± CLICK_HALF),
            # de modo que el borde inválido del warp queda fuera del análisis.
            pad = STAB_PAD if STABILIZE else 0
            cx0 = max(0, int(tx) - CLICK_HALF - pad); cx1 = min(W, int(tx) + CLICK_HALF + pad)
            cy0 = max(0, int(ty) - CLICK_HALF - pad); cy1 = min(H, int(ty) + CLICK_HALF + pad)
            ctx = frame[cy0:cy1, cx0:cx1]
            ctx_p = prev[cy0:cy1, cx0:cx1]
            if ctx.size == 0 or ctx.shape != ctx_p.shape:
                return None
            if STABILIZE:
                dx, dy, resp = _estimate_shift(ctx_p, ctx)
                if resp >= STAB_MIN_RESP and (abs(dx) > 0.5 or abs(dy) > 0.5):
                    M = np.float32([[1, 0, dx], [0, 1, dy]])
                    ctx_p = cv2.warpAffine(ctx_p, M, (ctx_p.shape[1], ctx_p.shape[0]),
                                           borderMode=cv2.BORDER_REPLICATE)
            # caja interna (± CLICK_HALF) relativa al contexto
            ix0 = int(tx) - CLICK_HALF - cx0; iy0 = int(ty) - CLICK_HALF - cy0
            roi = ctx[max(0, iy0):iy0 + 2 * CLICK_HALF, max(0, ix0):ix0 + 2 * CLICK_HALF]
            roi_p = ctx_p[max(0, iy0):iy0 + 2 * CLICK_HALF, max(0, ix0):ix0 + 2 * CLICK_HALF]
            x0 = cx0 + max(0, ix0); y0 = cy0 + max(0, iy0)
            if roi.size == 0 or roi.shape != roi_p.shape:
                return None
            hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
            hsv_p = cv2.cvtColor(roi_p, cv2.COLOR_BGR2HSV)
            # esquina sup-izq = cursor: se excluye para no contar su dorado
            cxr, cyr = int(tx) - x0, int(ty) - y0
            ex, ey = int(cur_w) + 6, int(cur_h) + 6

            def _newmask(ranges):
                now = _masks(hsv, ranges)
                old = _masks(hsv_p, ranges)
                nm = cv2.bitwise_and(now, cv2.bitwise_not(old))   # píxeles NUEVOS
                nm[max(0, cyr - 6):cyr + ey, max(0, cxr - 6):cxr + ex] = 0  # excluir cursor
                return nm
            mv_m = _newmask(MOVE_RANGES)
            at_m = _newmask(ATK_RANGES)
            combined = cv2.bitwise_or(mv_m, at_m)
            # El anillo es UN blob compacto; el ruido de cámara son píxeles dispersos.
            # Nos quedamos con la componente conexa MAYOR y exigimos que sea grande.
            n, lab, stats, _ = cv2.connectedComponentsWithStats(combined, 8)
            if n <= 1:
                return None
            areas = stats[1:, cv2.CC_STAT_AREA]
            i = int(np.argmax(areas))
            if int(areas[i]) < BRIGHT_MIN:
                return None
            comp = lab == (i + 1)
            mv = int(np.count_nonzero(mv_m[comp]))
            at = int(np.count_nonzero(at_m[comp]))
            kind = "left_click" if at > mv else "right_click"
            px, py = float(tx), float(ty)   # por defecto: punta del cursor

            if RADIAL or RAD_DIAG:
                occ, inner_frac, ok = 0, 1.0, False
                ys, xs = np.nonzero(combined)
                if len(xs) >= RAD_MIN_PIX:
                    ux, uy = float(xs.mean()), float(ys.mean())   # centro de convergencia
                    dx = xs - ux; dy = ys - uy
                    rr = np.sqrt(dx * dx + dy * dy)
                    rmax = float(rr.max())
                    if rmax >= 8:                                  # no todo apiñado
                        # (1) reparto angular: rechaza manchas de un solo lado
                        ang = np.arctan2(dy, dx)
                        sec = np.clip(((ang + np.pi) / (2 * np.pi) * RAD_SECTORS).astype(np.int32),
                                      0, RAD_SECTORS - 1)
                        occ = int(np.unique(sec).size)
                        # (2) centro hueco: rechaza blobs macizos (efectos/terreno)
                        inner_frac = float(np.count_nonzero(rr < 0.4 * rmax)) / len(rr)
                        ok = (occ >= RAD_MIN_SEC and inner_frac <= RAD_INNER_MAX)
                        px, py = x0 + ux, y0 + uy                  # punto EXACTO del clic
                if RADIAL and not ok:
                    return None
                if RAD_DIAG:
                    return kind, int(px), int(py), {"occ": occ, "inner": round(inner_frac, 3)}
            return kind, int(px), int(py), {}

        def process_batch(items):
            frames = [it[1] for it in items]
            with _Timer("preprocess"):
                pre = list(pool.map(detector.preprocess_one, frames))  # orden preservado
                batch = np.empty((len(frames), 3, detector.th, detector.tw), dtype=detector.dtype)
                metas = []
                for j, (chw, meta) in enumerate(pre):
                    batch[j] = chw
                    metas.append(meta)
            frame_dets = detector.infer_prepared(batch, metas)
            with _Timer("click"):
                _click_pass(items, frame_dets)

        def _click_pass(items, frame_dets):
            for (t_sec, frame, fc), dets in zip(items, frame_dets):
                click_state["since"] += 1
                if not dets:
                    continue
                # CURSOR: mejor detección -> punto de estela ("move").
                cursors = [d for d in dets if d[5] < 4]
                if not cursors:
                    continue
                cx, cy, bw, bh, sc, cls = max(cursors, key=lambda d: d[4])
                tx, ty = _tip(cx, cy, bw, bh, cls)
                events.append({"t": t_sec, "x": int(tx), "y": int(ty), "evt": "move"})
                # CLIC: explosión de color NUEVA (vs frame de referencia atrás) en la
                # punta -> el anillo aparece de golpe; la hierba estática se cancela.
                if len(frame_hist) >= DFRAMES:
                    hit = _click_kind(frame, frame_hist[-DFRAMES], tx, ty, bw, bh)
                    if hit and click_state["since"] >= COOLDOWN:
                        kind, kx, ky, feat = hit
                        ev = {"t": t_sec, "x": kx, "y": ky, "evt": kind}
                        ev.update(feat)
                        events.append(ev)
                        click_state["since"] = 0
                frame_hist.append(frame)

        t_wall0 = time.perf_counter()
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
        wall = time.perf_counter() - t_wall0
        cap.release()
        duration = (state["last_fc"] / fps) if fps > 0 else 0.0

        if PROFILE:
            analyzed = state["last_fc"] // skip if skip else state["last_fc"]
            main = _T["preprocess"] + _T["infer"] + _T["decode_out"] + _T["click"]
            sys.stderr.write(
                "\n[PROFILE] ---------------------------------------------\n"
                f"[PROFILE] vídeo            {duration:7.1f} s ({state['last_fc']} frames, "
                f"{analyzed} analizados a 1/{skip})\n"
                f"[PROFILE] wall clock       {wall:7.2f} s   -> {analyzed / wall:6.1f} frames analizados/s\n"
                f"[PROFILE] x tiempo real    {duration / wall:7.2f}\n"
                "[PROFILE]\n"
                f"[PROFILE] hilo DECODE      {_T['decode']:7.2f} s  ({_T['decode'] / wall * 100:5.1f}% del wall)\n"
                f"[PROFILE] hilo PRINCIPAL   {main:7.2f} s  ({main / wall * 100:5.1f}% del wall)\n"
                f"[PROFILE]   · preproceso   {_T['preprocess']:7.2f} s  ({_T['preprocess'] / wall * 100:5.1f}%)\n"
                f"[PROFILE]   · inferencia   {_T['infer']:7.2f} s  ({_T['infer'] / wall * 100:5.1f}%)\n"
                f"[PROFILE]   · post-NMS     {_T['decode_out']:7.2f} s  ({_T['decode_out'] / wall * 100:5.1f}%)\n"
                f"[PROFILE]   · clics (HSV)  {_T['click']:7.2f} s  ({_T['click'] / wall * 100:5.1f}%)\n"
                "[PROFILE]\n"
                f"[PROFILE] techo = {'DECODE' if _T['decode'] > main else 'HILO PRINCIPAL'}"
                " (decode se solapa con el resto, por eso la suma pasa del 100%)\n"
                "[PROFILE] ---------------------------------------------\n"
            )
            sys.stderr.flush()

        sys.stderr.write(f"[YOLO] Analisis finalizado. eventos={len(events)}\n")
        result = {"events": events, "duration": duration, "width": fw, "height": fh}
        print(json.dumps(result))
        return result


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
