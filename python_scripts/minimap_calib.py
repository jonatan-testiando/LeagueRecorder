"""Calibra la correspondencia minimapa del vídeo <-> coordenadas de juego.

Es el primer paso para sacar posiciones densas del VOD. La idea que lo hace
barato: **en cada borde de minuto la API ya da las posiciones exactas de los
diez**, así que no hace falta etiquetar nada a mano — esas posiciones son la
verdad de campo con la que se ajusta la transformación.

Una vez ajustada, cualquier icono detectado en el minimapa se convierte a
coordenadas de juego y se puede contrastar contra el estimador de `occupancy.rs`,
que hoy solo se valida contra sí mismo.

    python minimap_calib.py --video X.mp4 --timeline Y.json --offset 97.02

Salida: los parámetros de la transformación y el error de reproyección.
"""
import argparse
import json
import subprocess
import sys

import cv2
import numpy as np

# ROI del minimapa en fracciones del frame. Mismos valores que usa
# `camera_snaps.py`, que ya están afinados contra grabaciones reales.
MM = (0.787, 0.995, 0.622, 0.972)

# El mapa de la Grieta va de 0 a ~14 870 en ambos ejes, con el origen abajo a la
# izquierda. En pantalla el eje Y crece hacia abajo, así que se invierte.
MAPA = 14870.0


def frame_en(video, sec):
    """Un fotograma como array BGR, por ffmpeg (evita depender del seek de cv2)."""
    cmd = ["ffmpeg", "-loglevel", "error", "-ss", str(sec), "-i", video,
           "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]
    out = subprocess.run(cmd, capture_output=True).stdout
    if not out:
        return None
    return cv2.imdecode(np.frombuffer(out, np.uint8), cv2.IMREAD_COLOR)


def recorte_minimapa(frame):
    h, w = frame.shape[:2]
    x0, x1, y0, y1 = MM
    return frame[int(h * y0):int(h * y1), int(w * x0):int(w * x1)]


def juego_a_minimapa(x, y, ancho, alto):
    """Coordenadas de juego -> píxel del recorte, con la hipótesis de partida:
    el recorte cubre el mapa completo y el eje Y está invertido."""
    return (x / MAPA) * ancho, (1.0 - y / MAPA) * alto


def posiciones_api(timeline, minuto):
    """Posiciones de los diez en el fotograma de ese minuto."""
    fr = timeline["info"]["frames"][minuto]
    out = {}
    for k, pf in fr["participantFrames"].items():
        p = pf.get("position")
        if p:
            out[int(k)] = (float(p["x"]), float(p["y"]))
    return out, fr["timestamp"] / 1000.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--timeline", required=True)
    ap.add_argument("--offset", type=float, required=True,
                    help="segundos de vídeo antes del 0:00 de la partida")
    ap.add_argument("--minutos", default="10,12,14,16")
    ap.add_argument("--dump", help="carpeta donde dejar los recortes anotados")
    a = ap.parse_args()

    tl = json.load(open(a.timeline, encoding="utf-8"))
    for minuto in [int(m) for m in a.minutos.split(",")]:
        pos, t_juego = posiciones_api(tl, minuto)
        if not pos:
            continue
        t_video = t_juego + a.offset
        fr = frame_en(a.video, t_video)
        if fr is None:
            print(f"minuto {minuto}: no se pudo extraer el fotograma")
            continue
        mm = recorte_minimapa(fr)
        alto, ancho = mm.shape[:2]
        print(f"\nminuto {minuto}: vídeo {t_video:.1f}s, recorte {ancho}x{alto} px")

        # Dónde CAERÍAN los diez con la hipótesis de partida. Si el mapeo es
        # correcto, cada punto debe caer sobre un icono de campeón.
        anotado = mm.copy()
        for pid, (x, y) in sorted(pos.items()):
            px, py = juego_a_minimapa(x, y, ancho, alto)
            color = (255, 120, 0) if pid <= 5 else (0, 80, 255)
            cv2.circle(anotado, (int(px), int(py)), 9, color, 2)
            cv2.putText(anotado, str(pid), (int(px) - 4, int(py) + 4),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.35, (255, 255, 255), 1)
        if a.dump:
            ruta = f"{a.dump}/mm_min{minuto}.png"
            cv2.imwrite(ruta, cv2.resize(anotado, (ancho * 2, alto * 2),
                                         interpolation=cv2.INTER_NEAREST))
            print(f"  anotado -> {ruta}")


if __name__ == "__main__":
    sys.exit(main())
