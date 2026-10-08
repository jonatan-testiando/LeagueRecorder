"""Las barras de vida que flotan sobre los campeones, leídas de fotogramas sueltos.

Cada campeón visible lleva encima su barra: la tuya amarilla, las aliadas
azules, las rivales rojas, con la caja del nivel a la izquierda. De ahí sale
dónde está cada uno EN PANTALLA y cuánta vida le queda, que es lo que hace
falta para:

  - saber hacia dónde te movías respecto a quien te disparó (la cámara suele ir
    suelta: el centro de la pantalla no es tu campeón);
  - juzgar cómo apuntas: dónde estaba el rival y hacia dónde iba cuando
    lanzaste, y si perdió vida después.

No se pasa por el vídeo entero: quien llama da los instantes que le
interesan (las aperturas de pelea, las pulsaciones de habilidad) y se leen
ventanas cortas alrededor de cada uno.

Geometría medida en 1440p y en fracciones del ALTO (como el resto del HUD):
relleno de 13 px (0,009), barra de 127 px (0,088), caja de nivel de 25 px
a la izquierda con su número en blanco.

    python barras.py --video <mp4> --salida <json> --ffmpeg <ffmpeg> --wh 2560x1440
                     --ventanas <json con [[t0, t1], ...]> [--fps 10]
"""
import argparse
import json
import os
import subprocess
import sys

import cv2
import numpy as np

RELLENO = 0.009       # alto del relleno de vida
BARRA = 0.088         # largo de la barra entera
CAJA = 0.0175         # ancho de la caja del nivel
# De la barra al centro del campeón (los pies quedan más abajo; el centro del
# cuerpo es lo que importa para direcciones).
AL_CUERPO = 0.075

# Colores del relleno (HSV de OpenCV), medidos: tuya (45,180,220) BGR,
# aliada (202,139,43), rival (27,39,131)-(60,60,200).
COLORES = {
    "self": ((18, 150, 150), (30, 255, 255)),
    "ally": ((96, 150, 140), (106, 255, 255)),
    "enemy": ((0, 140, 90), (7, 255, 255)),
}


def barras(fr):
    """Barras de campeón de un fotograma: `[{team, x, y, hp}]`.

    `x, y`: centro aproximado del campeón en píxeles del vídeo. `hp`: 0..1.
    """
    H = fr.shape[0]
    alto = RELLENO * H
    largo = BARRA * H
    caja = CAJA * H
    hsv = cv2.cvtColor(fr, cv2.COLOR_BGR2HSV)
    # Las marcas negras de cada 100 de vida parten el relleno: se cierran.
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, int(alto * 0.35)), 1))
    out = []
    for team, (lo, hi) in COLORES.items():
        m = cv2.inRange(hsv, lo, hi)
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k)
        n, _, st, _ = cv2.connectedComponentsWithStats(m, 8)
        for i in range(1, n):
            x, y, w, h, area = st[i]
            if not (0.55 * alto <= h <= 1.35 * alto) or w > 1.08 * largo or area < 0.5 * w * h:
                continue
            # La caja del nivel: oscura, con el número en blanco, justo a la izquierda.
            cx0, cx1 = int(x - caja - 0.004 * H), int(x - 0.002 * H)
            cy0, cy1 = int(y - 0.003 * H), int(y + h + 0.004 * H)
            if cx0 < 0 or cy0 < 0 or cy1 > H:
                continue
            c = hsv[cy0:cy1, cx0:cx1]
            if c.size == 0:
                continue
            blanco = ((c[..., 2] > 190) & (c[..., 1] < 70)).mean()
            # Un "1" son pocos píxeles blancos: el mínimo es bajo a propósito.
            if not (0.015 <= blanco <= 0.45) or c[..., 2].mean() > 140:
                continue
            # El marco gris que rodea la barra entera, encima del relleno y
            # entre la vida y el recurso. El texto azul del chat y la barra de
            # maná del HUD pasaban todo lo anterior y no tienen marco.
            # Medido en 1440p: una fila negra pegada al relleno y, tras ella,
            # dos de gris (S < 30, V ~80-110). Se busca la mejor fila de gris
            # por encima y por debajo, a menos de 0,004 del alto.
            x1 = min(fr.shape[1], int(x + largo))
            margen = max(3, int(round(0.004 * H)))

            def mejor_gris(filas):
                if filas.size == 0:
                    return 0.0
                g = (filas[..., 1] < 90) & (filas[..., 2] > 25) & (filas[..., 2] < 150)
                return float(g.mean(axis=1).max())

            def recurso(filas):
                # En 1080p no queda fila gris entre la vida y el recurso: lo
                # que hay debajo es la barra de maná/energía, de color lleno
                # (o su parte vacía, negra).
                if filas.size == 0:
                    return 0.0
                g = ((filas[..., 1] > 100) & (filas[..., 2] > 80)) | (filas[..., 2] < 40)
                return float(g.mean(axis=1).max())

            arriba = mejor_gris(hsv[max(0, y - margen):y, x:x1])
            debajo = hsv[y + h:y + h + margen + 2, x:x1]
            abajo = max(mejor_gris(debajo), 0.8 * recurso(debajo))
            if min(arriba, abajo) < 0.5:
                continue
            # Lo que falta de vida es negro. El indicador azul de cada clic de
            # movimiento pasaba como una barra aliada casi vacía, con suelo a
            # la derecha en vez de barra vacía.
            if w < 0.85 * largo:
                vacio = hsv[y + 2:y + h - 2, x + w + 2:x1, 2]
                if vacio.size and float(np.median(vacio)) > 60:
                    continue
            # El borde derecho del relleno, en esa franja, da la vida.
            fila = m[y:y + h, x:int(x + largo)]
            cols = np.flatnonzero(fila.mean(axis=0) > 127)
            hp = min(1.0, (cols[-1] + 1) / largo) if len(cols) else 0.0
            out.append({
                "team": team,
                "x": round(float(x + largo / 2.0), 1),
                "y": round(float(y + AL_CUERPO * H), 1),
                "hp": round(hp, 3),
            })
    # Un mismo campeón no puede dar dos barras: si dos caen encima, la más larga.
    out.sort(key=lambda b: -b["hp"])
    final = []
    for b in out:
        if all(abs(b["x"] - o["x"]) > 0.3 * largo or abs(b["y"] - o["y"]) > 2 * alto for o in final):
            final.append(b)
    return final


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--salida", required=True)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--wh", required=True)
    ap.add_argument("--ventanas", required=True, help="JSON con [[t0, t1], ...] en segundos de vídeo")
    ap.add_argument("--fps", type=float, default=10.0)
    a = ap.parse_args()

    W, H = [int(v) for v in a.wh.lower().split("x")[:2]]
    with open(a.ventanas, encoding="utf-8") as f:
        ventanas = json.load(f)
    tam = W * H * 3
    salida = []
    for n, (t0, t1) in enumerate(ventanas):
        dur = max(0.05, t1 - t0)
        cmd = [a.ffmpeg, "-loglevel", "error", "-ss", f"{max(0.0, t0):.3f}", "-i", a.video,
               "-t", f"{dur:.3f}", "-vf", f"fps={a.fps}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
        p = subprocess.run(cmd, capture_output=True)
        raw = p.stdout
        k = 0
        while (k + 1) * tam <= len(raw):
            fr = np.frombuffer(raw[k * tam:(k + 1) * tam], np.uint8).reshape(H, W, 3)
            salida.append({"t": round(max(0.0, t0) + k / a.fps, 3), "bars": barras(fr)})
            k += 1
        print(f"PROGRESS:{min(99, int(100 * (n + 1) / max(1, len(ventanas))))}", file=sys.stderr, flush=True)

    tmp = a.salida + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"v": 1, "width": W, "height": H, "frames": salida}, fh, separators=(",", ":"))
    os.replace(tmp, a.salida)
    print("PROGRESS:100", file=sys.stderr, flush=True)
    print(f"{len(salida)} fotogramas en {len(ventanas)} ventanas -> {a.salida}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
