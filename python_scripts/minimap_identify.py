"""Pone nombre a cada icono detectado en el minimapa.

Hasta ahora se sabía *cuántos* rivales tenías encima (el color del aro da el
equipo). Esto añade *quiénes*: pasar de "3 rivales" a "Vladimir, Jinx y Bard".

## ESTADO: comparar retratos NO funciona. Medido, y descartado.

    aliados identificados correctamente: 7/35 (20%)
    al azar entre los candidatos seria:       ~29%

**Por debajo del azar.** La matriz de costes de un instante cualquiera lo
explica: los valores caen todos en una banda estrecha y un mismo candidato atrae
a casi todos los campeones (1,54 / 1,44 / 1,19 para tres distintos). A 26 píxeles
la distancia mide contraste y textura genérica, no identidad.

Restringir la búsqueda a 4 candidatos en vez de a 150.000 píxeles **no arregla el
problema**: la hipótesis era que fallaba por el espacio de búsqueda, y falla por
falta de señal.

## Lo que sí funciona: seguir, no reconocer

Es el mismo camino que ya funcionó para localizar al jugador grabado
(`minimap_follow.py`, 74% de cobertura): en los **bordes de minuto** la API dice
exactamente dónde está cada uno de los diez, así que la identidad ahí se conoce
sin reconocer nada. Entre medias se propaga por continuidad, porque en medio
segundo nadie se va lejos.

Eso convierte "reconocer una cara borrosa" —que no funciona— en "seguir un punto
que se mueve poco" —que sí—. Ver `minimap_identify_track.py`.

## Por qué se intentó comparar retratos

El primer intento de todo esto (`minimap_detect.py`) buscaba cada retrato **por
todo el minimapa** y fracasó: unos 150.000 sitios donde equivocarse por campeón,
con una cara de 26 píxeles medio tapada. Dos campeones distintos acababan en el
mismo pixel.

Aquí los retratos sólo tienen que **decidir entre los pocos candidatos que el
detector ya encontró** — unos 5, no 150.000. Y se resuelve como un problema de
asignación, no eligiendo el mejor para cada campeón por separado: eso es lo que
permitía que dos cayeran encima.

Además hay dos restricciones fuertes que se aprovechan:

- Cada campeón está **en un sitio y sólo uno**.
- En los bordes de minuto la API dice dónde estaba cada uno, así que la
  asignación de ese instante se conoce y sirve para **medir el acierto sin
  etiquetar nada**.

    python minimap_identify.py --match <carpeta>
"""
import argparse
import itertools
import json
import math
import os

import cv2
import numpy as np

from minimap_detect import MAPA, frame_en, icono, recorte

LADO = 26


def parecido(mm, cx, cy, retrato, lado=LADO):
    """Distancia entre el trozo del minimapa y un retrato. 0 = idéntico.

    Se normaliza cada uno por su media y desviación: el icono del minimapa está
    más oscuro y con menos contraste que el retrato original, y sin normalizar
    la distancia mediría brillo en vez de parecido.
    """
    r = lado // 2
    x0, y0 = int(cx) - r, int(cy) - r
    alto, ancho = mm.shape[:2]
    if x0 < 0 or y0 < 0 or x0 + lado > ancho or y0 + lado > alto:
        return 1e9
    trozo = cv2.cvtColor(mm[y0:y0 + lado, x0:x0 + lado], cv2.COLOR_BGR2GRAY)
    plant = cv2.cvtColor(
        cv2.resize(retrato, (lado, lado), interpolation=cv2.INTER_AREA),
        cv2.COLOR_BGR2GRAY)
    mask = np.zeros((lado, lado), np.uint8)
    # Sólo el interior: el aro cambia de color según el equipo y no identifica.
    cv2.circle(mask, (r, r), int(lado * 0.34), 255, -1)
    sel = mask > 0
    a = trozo[sel].astype(np.float32)
    b = plant[sel].astype(np.float32)
    a = (a - a.mean()) / (a.std() + 1e-6)
    b = (b - b.mean()) / (b.std() + 1e-6)
    return float(np.mean((a - b) ** 2))


def asignar(coste):
    """Asignación de coste mínimo por fuerza bruta.

    Son 5 campeones contra un puñado de candidatos: las permutaciones son pocas
    y no compensa un húngaro de verdad (además scipy no está en el entorno).
    """
    n_f = len(coste)
    n_c = len(coste[0]) if n_f else 0
    if not n_f or not n_c:
        return {}
    if n_c > 8:   # cota de seguridad: 8! ya son 40.320
        n_c = 8
    mejor, mejor_coste = None, float("inf")
    for perm in itertools.permutations(range(n_c), min(n_f, n_c)):
        c = sum(coste[i][perm[i]] for i in range(len(perm)))
        if c < mejor_coste:
            mejor_coste, mejor = c, perm
    return {i: mejor[i] for i in range(len(mejor))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--match", required=True)
    ap.add_argument("--version", default="16.16.1")
    ap.add_argument("--iconos", default="D:/lol-corpus/iconos")
    ap.add_argument("--minutos", type=int, default=12,
                    help="cuántos bordes de minuto usar para medir")
    a = ap.parse_args()

    d = a.match
    nombre = os.path.basename(d.rstrip("/\\"))
    vid = os.path.join(d, nombre + ".mp4")
    mt = json.load(open(os.path.join(d, "riot_match.json"), encoding="utf-8"))
    tl = json.load(open(os.path.join(d, "riot_timeline.json"), encoding="utf-8"))
    pos = json.load(open(os.path.join(d, "minimap_positions.json"), encoding="utf-8"))
    offset = pos["video_offset"]
    mi_equipo = pos["self_team_id"]

    champs = [p["championName"] for p in mt["info"]["participants"]]
    teams = [p["teamId"] for p in mt["info"]["participants"]]
    retratos = {c: icono(c, a.version, a.iconos) for c in set(champs)}

    # Aliados: siempre visibles, así que su asignación se puede medir entera.
    aliados = [i + 1 for i, t in enumerate(teams) if t == mi_equipo]

    aciertos = total = 0
    por_muestra = []
    frames = tl["info"]["frames"]
    paso = max(1, len(frames) // a.minutos)

    for minuto in range(2, len(frames), paso):
        fr_api = frames[minuto]
        sec = fr_api["timestamp"] / 1000.0
        t_video = sec + offset
        # Detecciones ya calculadas para ese instante.
        muestra = min(pos["samples"], key=lambda s: abs(s["t"] - t_video))
        if abs(muestra["t"] - t_video) > 1.0:
            continue
        cand = [i for i in muestra["icons"] if i["team"] == mi_equipo]
        if not cand:
            continue
        fr = frame_en(vid, t_video)
        if fr is None:
            continue
        mm = recorte(fr)
        alto, ancho = mm.shape[:2]

        # Verdad de campo: dónde estaba cada aliado según la API.
        verdad = {}
        for pid in aliados:
            p = fr_api["participantFrames"].get(str(pid), {}).get("position")
            if p:
                verdad[pid] = (p["x"], p["y"])

        px = [(c["x"] / MAPA * ancho, (1 - c["y"] / MAPA) * alto) for c in cand]
        coste = [[parecido(mm, cx, cy, retratos[champs[pid - 1]])
                  for cx, cy in px] for pid in aliados]
        elegido = asignar(coste)

        for i, pid in enumerate(aliados):
            if pid not in verdad or i not in elegido:
                continue
            total += 1
            c = cand[elegido[i]]
            if math.dist((c["x"], c["y"]), verdad[pid]) < 700:
                aciertos += 1
        por_muestra.append(len(cand))

    print(f"{len(por_muestra)} instantes, {sum(por_muestra)/max(1,len(por_muestra)):.1f} candidatos de media")
    print(f"aliados identificados correctamente: {aciertos}/{total} "
          f"({100*aciertos/max(1,total):.0f}%)")
    print("referencia: al azar entre los candidatos seria ~"
          f"{100/max(1, sum(por_muestra)/max(1,len(por_muestra))):.0f}%")


if __name__ == "__main__":
    main()
