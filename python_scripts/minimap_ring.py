"""Paso 1 del detector de minimapa: encontrar los iconos sin saber de quién son.

El intento anterior (`minimap_detect.py`) buscaba directamente a cada campeón por
su retrato y falló: a 26 px el trozo de cara no distingue un campeón de otro, y
dos campeones distintos caían en el mismo píxel. Error medio 2.718 unidades,
peor que el estimador solo-API.

Este enfoque invierte el orden, que es como se resuelven estos problemas:

1. **Localizar** los iconos por su aro de color de equipo. Un aro es una señal
   mucho más fuerte y uniforme que una cara borrosa, y no hay que saber de quién
   es para verlo.
2. **Repartir** después los campeones entre los candidatos encontrados,
   aprovechando que hay exactamente cinco aliados y cada uno está en un sitio.

Aquí está el paso 1. Se mide con lo de siempre: en los bordes de minuto la API da
las posiciones exactas, así que la cobertura se calcula sin etiquetar nada.

## ESTADO: precisión buena, cobertura mala. Medido.

    candidatos por fotograma : 10-17   (deberían ser 5)
    aliados encontrados      : 6/20  (30%)
    error de los encontrados : mediana 433 unidades

Ese 433 es la buena noticia y justifica seguir por aquí: **es menos de la mitad
del error del estimador solo-API (940)**. Cuando encuentra un icono, lo sitúa
mucho mejor que lo que teníamos.

El fallo está diagnosticado mirando el volcado: los candidatos caen sobre **las
torres y las estructuras de la base**, que también son azules y de tamaño
parecido al de un icono. El filtro por tono no puede distinguirlas.

## Lo que hay que hacer, y no es tocar el rango de color

**Restar el fondo estático.** Las torres, el terreno y los marcadores del HUD no
se mueven en toda la partida; los campeones sí. Tomando la mediana de N
fotogramas repartidos por la partida se obtiene un "minimapa vacío", y lo que
difiere de él son los campeones. Es el método clásico para esto y elimina de
golpe toda la clase de falsos positivos que se ve en el volcado, en vez de
perseguirlos uno a uno con umbrales.

Después de eso viene el paso 2 (repartir los campeones entre los candidatos como
problema de asignación), que sigue pendiente. Ojo: `scipy` no está instalado en
el venv, así que el húngaro habrá que escribirlo a mano — para 5x5 es corto.

    python minimap_ring.py --video X.mp4 --match Y.json --timeline Z.json --offset 97
"""
import argparse
import json

import cv2
import numpy as np

from minimap_detect import MAPA, MM, frame_en, recorte

# Tono del aro aliado en HSV de OpenCV (H va de 0 a 179). Medido muestreando el
# anillo alrededor de posiciones conocidas: los cinco aliados dieron entre 90 y
# 115, o sea azul-cian.
ALIADO_H = (85, 125)
# El aro rival es rojo, que en HSV está partido en los dos extremos del círculo.
RIVAL_H = ((0, 12), (165, 179))

SAT_MIN = 110
VAL_MIN = 90


def candidatos(mm, rango_h, radio_px):
    """Centros de los iconos cuyo aro cae en ese rango de tono."""
    hsv = cv2.cvtColor(mm, cv2.COLOR_BGR2HSV)
    if isinstance(rango_h[0], tuple):
        mask = np.zeros(hsv.shape[:2], np.uint8)
        for lo, hi in rango_h:
            mask |= cv2.inRange(hsv, (lo, SAT_MIN, VAL_MIN), (hi, 255, 255))
    else:
        mask = cv2.inRange(hsv, (rango_h[0], SAT_MIN, VAL_MIN), (rango_h[1], 255, 255))

    # El aro es una circunferencia, no un disco: cerrarlo lo convierte en mancha
    # y así cada icono es una sola componente en vez de un anillo roto.
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k, iterations=2)

    n, _, stats, cent = cv2.connectedComponentsWithStats(mask, 8)
    area_min = (radio_px ** 2) * 0.8
    area_max = (radio_px ** 2) * 12.0
    out = []
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        w, h = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]
        if not (area_min <= area <= area_max):
            continue
        # Un icono es aproximadamente cuadrado en su caja: descarta las líneas
        # del HUD y los bordes de carril, que son alargados.
        if max(w, h) > 2.2 * min(w, h):
            continue
        if not (radio_px * 0.9 <= max(w, h) <= radio_px * 3.5):
            continue
        out.append((float(cent[i][0]), float(cent[i][1]), int(area)))
    return out, mask


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--match", required=True)
    ap.add_argument("--timeline", required=True)
    ap.add_argument("--offset", type=float, required=True)
    ap.add_argument("--minutos", default="6,8,10,12,14,16,18,20")
    ap.add_argument("--radio", type=int, default=13, help="radio del icono en px")
    ap.add_argument("--tolerancia", type=float, default=700.0,
                    help="a cuántas unidades de juego se considera acertado")
    ap.add_argument("--dump")
    a = ap.parse_args()

    partida = json.load(open(a.match, encoding="utf-8"))
    tl = json.load(open(a.timeline, encoding="utf-8"))
    teams = [p["teamId"] for p in partida["info"]["participants"]]
    # El equipo del jugador grabado: sus aliados llevan el aro azul.
    propio = next((t for i, t in enumerate(teams)
                   if partida["info"]["participants"][i].get("teamId")), 100)

    encontrados = alliados_total = 0
    errores = []
    n_cand = []

    for minuto in [int(m) for m in a.minutos.split(",")]:
        if minuto >= len(tl["info"]["frames"]):
            continue
        fr_api = tl["info"]["frames"][minuto]
        fr = frame_en(a.video, fr_api["timestamp"] / 1000.0 + a.offset)
        if fr is None:
            continue
        mm = recorte(fr)
        alto, ancho = mm.shape[:2]
        cand, mask = candidatos(mm, ALIADO_H, a.radio)
        n_cand.append(len(cand))

        vis = cv2.resize(mm, (ancho * 2, alto * 2), interpolation=cv2.INTER_NEAREST)
        for cx, cy, _ in cand:
            cv2.circle(vis, (int(cx * 2), int(cy * 2)), 15, (0, 0, 255), 2)

        for pid_str, pf in fr_api["participantFrames"].items():
            pid = int(pid_str)
            pos = pf.get("position")
            if not pos or teams[pid - 1] != propio:
                continue
            alliados_total += 1
            vx = pos["x"] / MAPA * ancho
            vy = (1 - pos["y"] / MAPA) * alto
            cv2.circle(vis, (int(vx * 2), int(vy * 2)), 15, (0, 255, 0), 2)
            if not cand:
                continue
            d_px = min(((cx - vx) ** 2 + (cy - vy) ** 2) ** 0.5 for cx, cy, _ in cand)
            d_juego = d_px / ancho * MAPA
            if d_juego <= a.tolerancia:
                encontrados += 1
                errores.append(d_juego)

        if a.dump:
            cv2.imwrite(f"{a.dump}/ring_min{minuto}.png", vis)

    print(f"\ncandidatos por fotograma: {n_cand}  (deberían rondar 5)")
    print(f"aliados con un candidato a menos de {a.tolerancia:.0f} unidades: "
          f"{encontrados}/{alliados_total} ({100 * encontrados / max(1, alliados_total):.0f}%)")
    if errores:
        errores.sort()
        print(f"error de los encontrados: mediana {errores[len(errores)//2]:.0f} | "
              f"media {sum(errores)/len(errores):.0f} unidades")
        print("referencia: el estimador solo-API da ~940 de error mediano")


if __name__ == "__main__":
    main()
