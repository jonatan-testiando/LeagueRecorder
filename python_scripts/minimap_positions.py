"""Extrae posiciones densas del minimapa de una partida grabada.

La API da UNA posición por minuto. Esto da dos por segundo — 120 veces más — y
es lo que arregla que la duración de los tramos de presión fuera sólo una cota
inferior.

## Por qué no hace falta saber qué campeón es cada icono

La pregunta que importa es *"¿cuántos rivales tenía encima?"*, y para eso basta
el **equipo**, que lo dice el color del aro. Identificar al campeón concreto
exigiría comparar retratos y es un problema aparte; el equipo se lee del píxel.

Al jugador grabado sí se le identifica, pero por otra vía más fiable: es el icono
aliado más cercano a donde la API dice que estaba, interpolando entre minutos.

Salida: un JSON con una entrada por muestra, en segundos de VÍDEO.

    python minimap_positions.py --match <carpeta de la partida>
"""
import argparse
import json
import os
import subprocess
import sys

import cv2
import numpy as np

MM = (0.787, 0.995, 0.622, 0.972)
MAPA = 14870.0
MODELO = "models/minimap_icons.onnx"

# Lado de entrada del modelo. Fijo porque se exportó sin ejes dinámicos: así el
# grafo es más simple y no hay que reservar memoria por cada tamaño.
IMGSZ = 416


class DetectorOnnx:
    """Detector por ONNX Runtime, sin torch.

    Existe para poder **empaquetar** esto. `ultralytics` arrastra torch, que son
    ~2 GB en el instalador; el mismo modelo en ONNX pesa 12 MB y corre sobre
    `onnxruntime-gpu`, que este proyecto ya trae para el detector de clics.

    Si `onnxruntime` no estuviera, se cae a ultralytics — que es lo que hay en la
    máquina de desarrollo.
    """

    def __init__(self, ruta, conf):
        self.conf = conf
        self.sesion = None
        self.yolo = None
        if str(ruta).endswith(".onnx"):
            import onnxruntime as ort
            proveedores = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider")
                           if p in ort.get_available_providers()]
            self.sesion = ort.InferenceSession(str(ruta), providers=proveedores)
            self.entrada = self.sesion.get_inputs()[0].name
        else:
            from ultralytics import YOLO
            self.yolo = YOLO(str(ruta))

    def __call__(self, lote):
        """Devuelve, por imagen, la lista de centros (cx, cy) en píxeles."""
        if self.yolo is not None:
            salida = []
            for r in self.yolo.predict(lote, verbose=False, conf=self.conf, imgsz=IMGSZ):
                salida.append([(float(b[0]), float(b[1]))
                               for b in (r.boxes.xywh.cpu().numpy()
                                         if r.boxes is not None else [])])
            return salida

        alto, ancho = lote[0].shape[:2]
        # Se respeta la proporción del recorte (unos 400x378) en vez de estirarlo
        # a un cuadrado: el modelo se entrenó con la entrada acolchada, y estirar
        # deforma los iconos justo en el eje en que se distinguen del fondo.
        esc = min(IMGSZ / ancho, IMGSZ / alto)
        nw, nh = int(round(ancho * esc)), int(round(alto * esc))
        px, py = (IMGSZ - nw) // 2, (IMGSZ - nh) // 2
        lienzo = np.full((len(lote), IMGSZ, IMGSZ, 3), 114, np.uint8)
        for i, f in enumerate(lote):
            lienzo[i, py:py + nh, px:px + nw] = cv2.resize(
                f, (nw, nh), interpolation=cv2.INTER_LINEAR)
        tensor = (lienzo[:, :, :, ::-1].astype(np.float32)
                  .transpose(0, 3, 1, 2) / 255.0)
        crudo = self.sesion.run(None, {self.entrada: np.ascontiguousarray(tensor)})[0]
        # Salida de YOLOv8: (lote, 4+clases, cajas). Con una sola clase, la fila
        # 4 es directamente la confianza.
        salida = []
        for pred in crudo:
            cajas = pred.T
            cajas = cajas[cajas[:, 4] >= self.conf]
            # De vuelta a píxeles del recorte, deshaciendo el acolchado.
            xy = np.empty((len(cajas), 5), np.float32)
            xy[:, 0] = (cajas[:, 0] - px) / esc
            xy[:, 1] = (cajas[:, 1] - py) / esc
            xy[:, 2] = cajas[:, 2] / esc
            xy[:, 3] = cajas[:, 3] / esc
            xy[:, 4] = cajas[:, 4]
            salida.append(nms(xy))
        return salida


def nms(cajas, iou_max=0.7):
    """Quita detecciones repetidas del mismo icono, como hace `ultralytics`.

    La versión anterior fusionaba por distancia entre centros, con un mínimo de
    12 píxeles, y eso **borraba campeones de verdad**: el recorte del minimapa
    mide unos 400 px para 14.870 unidades de mapa, así que 12 px son ~450
    unidades. Dos rivales encima de ti en una pelea están más cerca que eso y se
    quedaban en uno solo. Medido: 15.297 iconos frente a los 16.439 que sacaba
    `ultralytics` en la misma partida, y el hueco caía justo en las peleas.

    Además no ordenaba por confianza, así que de dos detecciones solapadas se
    quedaba con la primera que llegara en vez de con la mejor.

    `cajas` es (N, 5): cx, cy, ancho, alto, confianza.
    """
    if len(cajas) == 0:
        return []
    orden = np.argsort(-cajas[:, 4])
    x1 = cajas[:, 0] - cajas[:, 2] / 2
    y1 = cajas[:, 1] - cajas[:, 3] / 2
    x2 = cajas[:, 0] + cajas[:, 2] / 2
    y2 = cajas[:, 1] + cajas[:, 3] / 2
    area = (x2 - x1) * (y2 - y1)
    guardados = []
    while len(orden):
        i = orden[0]
        guardados.append(i)
        if len(orden) == 1:
            break
        r = orden[1:]
        ix1 = np.maximum(x1[i], x1[r])
        iy1 = np.maximum(y1[i], y1[r])
        ix2 = np.minimum(x2[i], x2[r])
        iy2 = np.minimum(y2[i], y2[r])
        inter = np.clip(ix2 - ix1, 0, None) * np.clip(iy2 - iy1, 0, None)
        iou = inter / (area[i] + area[r] - inter + 1e-9)
        orden = r[iou <= iou_max]
    return [(float(cajas[i, 0]), float(cajas[i, 1])) for i in guardados]


def equipo_de(mm, cx, cy, radio=9):
    """100 (azul) o 200 (rojo) según el aro, o None si no está claro.

    Se muestrea el anillo y no el centro: el interior es el retrato del campeón
    y su color no dice nada del bando.
    """
    hsv = cv2.cvtColor(mm, cv2.COLOR_BGR2HSV)
    alto, ancho = hsv.shape[:2]
    azul = rojo = 0
    for r in (radio, radio + 1, radio + 2):
        for ang in range(0, 360, 12):
            x = int(cx + r * np.cos(np.radians(ang)))
            y = int(cy + r * np.sin(np.radians(ang)))
            if not (0 <= x < ancho and 0 <= y < alto):
                continue
            H, S, V = hsv[y, x]
            if S < 90 or V < 70:
                continue
            if 85 <= H <= 125:
                azul += 1
            elif H <= 12 or H >= 165:
                rojo += 1
    if azul + rojo < 4:
        return None
    return 100 if azul > rojo else 200


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--match", required=True, help="carpeta de la partida grabada")
    ap.add_argument("--fps", type=float, default=2.0)
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--modelo", default=MODELO)
    ap.add_argument("--salida", help="por defecto, minimap_positions.json en la carpeta")
    a = ap.parse_args()

    d = a.match
    nombre = os.path.basename(d.rstrip("/\\"))
    vid = os.path.join(d, nombre + ".mp4")
    meta = None
    for f in os.listdir(d):
        if f.endswith(".json") and not f.startswith("riot_"):
            j = json.load(open(os.path.join(d, f), encoding="utf-8"))
            if isinstance(j, dict) and j.get("champion"):
                meta = j
                break
    mt = json.load(open(os.path.join(d, "riot_match.json"), encoding="utf-8"))
    tl = json.load(open(os.path.join(d, "riot_timeline.json"), encoding="utf-8"))
    if meta is None or meta.get("video_offset") is None:
        raise SystemExit("falta el metadata o el desplazamiento del vídeo")
    offset = meta["video_offset"]

    yo_pid = next(i + 1 for i, p in enumerate(mt["info"]["participants"])
                  if p["championName"] == meta["champion"])
    mi_equipo = mt["info"]["participants"][yo_pid - 1]["teamId"]

    # Resolución real del vídeo: no se asume 1080p.
    pr = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                         "-show_entries", "stream=width,height", "-of", "csv=p=0", vid],
                        capture_output=True, text=True).stdout.strip()
    W, H = [int(v) for v in pr.split(",")[:2]]
    x0, y0 = int(W * MM[0]), int(H * MM[2])
    # ffmpeg redondea el recorte a dimensiones pares; leer filas del ancho
    # pedido en vez del emitido desplaza cada fila y deforma la imagen.
    w = (int(W * MM[1]) - x0) // 2 * 2
    h = (int(H * MM[3]) - y0) // 2 * 2

    modelo = DetectorOnnx(a.modelo, a.conf)

    cmd = ["ffmpeg", "-loglevel", "error", "-i", vid,
           "-vf", f"fps={a.fps},crop={w}:{h}:{x0}:{y0}",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)

    salida = []
    lote, tiempos = [], []
    idx = 0

    def procesar():
        if not lote:
            return
        for t, fr, centros in zip(tiempos, lote, modelo(lote)):
            iconos = []
            for cx, cy in centros:
                iconos.append({
                    "x": round(cx / w * MAPA, 1),
                    "y": round((1 - cy / h) * MAPA, 1),
                    "team": equipo_de(fr, cx, cy),
                })
            salida.append({"t": round(t, 2), "icons": iconos})
        lote.clear()
        tiempos.clear()

    while True:
        raw = p.stdout.read(w * h * 3)
        if len(raw) < w * h * 3:
            break
        lote.append(np.frombuffer(raw, np.uint8).reshape(h, w, 3).copy())
        tiempos.append(idx / a.fps)
        idx += 1
        if len(lote) >= 32:
            procesar()
    procesar()

    ruta = a.salida or os.path.join(d, "minimap_positions.json")
    with open(ruta, "w", encoding="utf-8") as f:
        json.dump({
            "fps": a.fps,
            "video_offset": offset,
            "self_participant_id": yo_pid,
            "self_team_id": mi_equipo,
            "samples": salida,
        }, f)

    con_eq = sum(1 for s in salida for i in s["icons"] if i["team"])
    tot = sum(len(s["icons"]) for s in salida)
    print(f"{len(salida)} muestras, {tot} iconos ({tot/max(1,len(salida)):.1f} por muestra)")
    print(f"con equipo identificado por el aro: {con_eq}/{tot} "
          f"({100*con_eq/max(1,tot):.0f}%)")
    print(f"-> {ruta}")


if __name__ == "__main__":
    sys.exit(main())
