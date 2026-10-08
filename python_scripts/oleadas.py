"""Dónde están las oleadas de súbditos, leído del minimapa de una partida grabada.

Los súbditos se pintan en el minimapa como puntitos: azules los de tu equipo
(SIEMPRE visibles) y rojos los rivales (sólo con visión). La punta de tu
oleada en cada carril dice dónde está el choque, y con eso se sabe qué
carriles estaban empujados a tu favor en cada momento: lo que hace falta para
juzgar una invasión, un gank o un objetivo.

**Sólo se descodifican los fotogramas clave** (`-skip_frame nokey`): uno cada
~4 s en las grabaciones del usuario. Una oleada anda ~325 u/s, así que en 4 s
avanza menos de un décimo de carril: basta para saber de qué lado está. A
cambio la partida entera se lee en segundos (600 s de AV1 1440p en 0,9 s,
medido) en vez de los 4 min de una pasada completa.

    python oleadas.py --video <mp4> --salida <json> --ffmpeg <ffmpeg> --wh 2560x1440

Salida: por fotograma clave, su instante (segundos de VÍDEO) y los puntos de
cada color en coordenadas de juego (0..14870, y hacia arriba).
"""
import argparse
import json
import os
import re
import subprocess
import sys
import threading

import cv2
import numpy as np

# Las mismas fracciones que minimap_positions.py: mismas coordenadas.
MM = (0.787, 0.995, 0.622, 0.972)
MAPA = 14870.0

# Diámetro de un súbdito en fracción del ancho del minimapa (10 px de 532 en 1440p).
PUNTO = 0.0188

# Colores medidos en el minimapa (HSV de OpenCV): azul (206,147,74) BGR, tono
# 104 (las torres aliadas son 97-98: se quedan fuera por el tono); rojo
# (37,43,159)-(45,53,205), igual que las torres rivales: esas se quitan por
# posición al analizar (`oleadas.rs`).
AZUL = ((100, 120, 140), (112, 235, 255))
ROJO_1 = ((0, 140, 100), (7, 255, 255))
ROJO_2 = ((172, 140, 100), (180, 255, 255))


def puntos(mascara, d):
    """Centros de súbdito de una máscara de color.

    Los súbditos de una oleada se tocan y forman cadenas: una mancha delgada
    (de grosor ~ un punto) y larga se trocea en puntos cada `d`. Lo que es
    grueso (torres, iconos de campeón) o hueco (aros, inhibidores) se descarta.
    """
    n, _, st, _ = cv2.connectedComponentsWithStats(mascara, 8)
    out = []
    for i in range(1, n):
        x, y, bw, bh, area = st[i]
        menor, mayor = min(bw, bh), max(bw, bh)
        if menor < 0.5 * d or menor > 1.45 * d or mayor > 9 * d:
            continue
        if area < 0.35 * d * d or area / float(bw * bh) < 0.5:
            continue
        k = max(1, int(round(mayor / d)))
        for j in range(k):
            f = (j + 0.5) / k
            if bw >= bh:
                out.append((x + f * bw, y + bh / 2.0))
            else:
                out.append((x + bw / 2.0, y + f * bh))
    return out


def detectar(fr, d):
    hsv = cv2.cvtColor(fr, cv2.COLOR_BGR2HSV)
    azul = cv2.inRange(hsv, AZUL[0], AZUL[1])
    rojo = cv2.inRange(hsv, ROJO_1[0], ROJO_1[1]) | cv2.inRange(hsv, ROJO_2[0], ROJO_2[1])
    return puntos(azul, d), puntos(rojo, d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--salida", required=True)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--wh", required=True)
    ap.add_argument("--duracion", type=float)
    a = ap.parse_args()

    W, H = [int(v) for v in a.wh.lower().split("x")[:2]]
    x0, y0 = int(W * MM[0]), int(H * MM[2])
    w = (int(W * MM[1]) - x0) // 2 * 2
    h = (int(H * MM[3]) - y0) // 2 * 2
    d = PUNTO * w

    # `showinfo` dice el instante de cada fotograma: con sólo los clave, el
    # paso no es fijo y no se puede contar fotogramas.
    cmd = [a.ffmpeg, "-hide_banner", "-loglevel", "info", "-skip_frame", "nokey", "-i", a.video,
           "-vf", f"crop={w}:{h}:{x0}:{y0},showinfo", "-fps_mode", "passthrough",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    tiempos = []
    patron = re.compile(rb"pts_time:\s*([0-9.]+)")

    def leer_err():
        for linea in p.stderr:
            m = patron.search(linea)
            if m:
                tiempos.append(float(m.group(1)))

    hilo = threading.Thread(target=leer_err, daemon=True)
    hilo.start()

    frames = []
    tam = w * h * 3
    ultimo_pct = -1
    while True:
        raw = p.stdout.read(tam)
        if len(raw) < tam:
            break
        fr = np.frombuffer(raw, np.uint8).reshape(h, w, 3)
        aliados, rivales = detectar(fr, d)
        frames.append({
            "a": [[round(cx / w * MAPA), round((1 - cy / h) * MAPA)] for cx, cy in aliados],
            "e": [[round(cx / w * MAPA), round((1 - cy / h) * MAPA)] for cx, cy in rivales],
        })
        if a.duracion and tiempos:
            pct = min(99, int(100 * tiempos[-1] / a.duracion))
            if pct != ultimo_pct:
                ultimo_pct = pct
                print(f"PROGRESS:{pct}", file=sys.stderr, flush=True)
    codigo = p.wait()
    hilo.join(timeout=5)
    if codigo != 0 or len(tiempos) < len(frames):
        print(f"ffmpeg terminó con código {codigo} ({len(frames)} fotogramas, {len(tiempos)} instantes)",
              file=sys.stderr, flush=True)
        return 1
    for f, t in zip(frames, tiempos):
        f["t"] = round(t, 2)

    salida = {"v": 1, "width": W, "height": H, "frames": frames}
    tmp = a.salida + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(salida, fh, separators=(",", ":"))
    os.replace(tmp, a.salida)
    print("PROGRESS:100", file=sys.stderr, flush=True)
    n_a = sum(len(f["a"]) for f in frames)
    n_e = sum(len(f["e"]) for f in frames)
    print(f"{len(frames)} fotogramas clave, {n_a / max(1, len(frames)):.1f} súbditos aliados y "
          f"{n_e / max(1, len(frames)):.1f} rivales por fotograma -> {a.salida}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
