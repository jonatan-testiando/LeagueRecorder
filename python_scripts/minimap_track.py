"""Detector de campeones en el minimapa, en tres pasos.

Sustituye a los dos intentos anteriores, que están documentados con sus números
en `minimap_detect.py` y `minimap_ring.py`. El orden importa y llegar a él costó
dos fracasos medidos:

1. **Quitar lo que no se mueve.** Torres, terreno, marcadores del HUD y textos
   están ahí toda la partida; los campeones no. La mediana de unos cuantos
   fotogramas repartidos da un "minimapa vacío", y restarlo elimina de golpe la
   clase entera de falsos positivos en vez de perseguirlos con umbrales.

2. **Encontrar los círculos**, sin saber de quién son. Un aro de color sobrevive
   a que le tapen media cara; una cara de 26 píxeles medio tapada, no.

3. **Repartir los retratos** entre los círculos encontrados. Aquí sí entran las
   imágenes de Data Dragon, pero comparando 5 caras contra 5 sitios en vez de
   buscarlas por los 150.000 píxeles del minimapa. Y se resuelve como asignación,
   no eligiendo el mejor para cada uno por separado: eso permitía que dos
   campeones cayeran en el mismo píxel, que es exactamente lo que pasaba.

## ESTADO: TAMPOCO FUNCIONA. Tercer intento fallido, medido.

    paso 1+2 (encontrar circulos) : 2/20 aliados  (10%)
    tuberia completa              : 1/20          ( 5%)
    error mediano                 : 6.270 unidades

Peor que el intento del aro (30% de cobertura) y mucho peor que el estimador
solo-API (940 de error).

**Causa, vista en el volcado**: al restar el fondo, lo que más destaca no son los
campeones sino **los temporizadores de reaparición de las torres** — los números
"1:48", "1:25"… que cambian cada segundo. Todas las detecciones caían sobre
texto.

## Conclusión tras tres intentos

Los tres fracasos tienen la misma forma: el minimapa está visualmente cargado
(temporizadores, escudos de torre, puntos de guardián, el recuadro de la cámara,
pings) y cada arreglo por reglas resuelve una clase de falso positivo y tropieza
con la siguiente. No parece que se gane persiguiendo la cuarta.

**Recomendación: entrenar un detector en lugar de programar reglas.** El proyecto
ya tiene la infraestructura montada para otra cosa (`.venv-train` con torch,
`yolo_backend.py`, `autolabel.py`, `train_*.py`), y aquí las etiquetas salen
gratis: la API da la posición exacta de los diez en cada borde de minuto, así que
cada partida grabada aporta ~30 fotogramas × 5 aliados ya etiquetados sin tocar
nada a mano. Es el mismo patrón de auto-etiquetado que ya se usó para el
detector de clics.

La validación sigue siendo gratis: en los bordes de minuto la API da las
posiciones exactas.

    python minimap_track.py --video X.mp4 --match Y.json --timeline Z.json --offset 97
"""
import argparse
import json

import cv2
import numpy as np

from minimap_detect import MAPA, frame_en, icono, recorte


def fondo(video, duracion, n=14):
    """Minimapa 'vacío': la mediana de varios fotogramas repartidos.

    Un píxel de torre o de terreno es igual en todos, así que su mediana es él
    mismo. Un campeón sólo está en unos pocos, así que la mediana lo borra.
    """
    muestras = []
    for i in range(n):
        t = duracion * (i + 0.5) / n
        fr = frame_en(video, t)
        if fr is not None:
            muestras.append(recorte(fr).astype(np.uint8))
    if not muestras:
        return None
    return np.median(np.stack(muestras), axis=0).astype(np.uint8)


def circulos(mm, bg, radio, umbral=32):
    """Candidatos a icono: lo que difiere del fondo y tiene forma de icono."""
    dif = cv2.absdiff(mm, bg)
    gris = cv2.cvtColor(dif, cv2.COLOR_BGR2GRAY)
    _, mask = cv2.threshold(gris, umbral, 255, cv2.THRESH_BINARY)

    # Cerrar une el aro con su interior; abrir se lleva el polvo de un píxel.
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k, iterations=3)

    n, _, stats, cent = cv2.connectedComponentsWithStats(mask, 8)
    out = []
    for i in range(1, n):
        w, h = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]
        area = stats[i, cv2.CC_STAT_AREA]
        if area < radio * radio * 0.5:
            continue
        # Una mancha muy alargada es el recuadro de la cámara o una línea, no
        # un icono. Una enorme es una zona de niebla que cambió.
        if max(w, h) > 3.0 * max(1, min(w, h)):
            continue
        if max(w, h) > radio * 5:
            continue
        out.append((float(cent[i][0]), float(cent[i][1]), int(area)))
    return out, mask


def parecido(mm, cx, cy, plantilla_img, lado):
    """Cuánto se parece el trozo centrado en (cx,cy) a ese retrato. 0 = idéntico."""
    r = lado // 2
    x0, y0 = int(cx) - r, int(cy) - r
    alto, ancho = mm.shape[:2]
    if x0 < 0 or y0 < 0 or x0 + lado > ancho or y0 + lado > alto:
        return 1e9
    trozo = mm[y0:y0 + lado, x0:x0 + lado]
    t = cv2.resize(plantilla_img, (lado, lado), interpolation=cv2.INTER_AREA)
    mask = np.zeros((lado, lado), np.uint8)
    cv2.circle(mask, (r, r), int(lado * 0.34), 255, -1)
    a = cv2.cvtColor(trozo, cv2.COLOR_BGR2GRAY).astype(np.float32)
    b = cv2.cvtColor(t, cv2.COLOR_BGR2GRAY).astype(np.float32)
    sel = mask > 0
    a, b = a[sel], b[sel]
    # Se normaliza cada uno: el minimapa está más oscuro que el retrato original
    # y sin esto la diferencia mide brillo en vez de parecido.
    a = (a - a.mean()) / (a.std() + 1e-6)
    b = (b - b.mean()) / (b.std() + 1e-6)
    return float(np.mean((a - b) ** 2))


def asignar(coste):
    """Asignación de coste mínimo (húngaro), escrito a mano porque scipy no está.

    Para 5x5 la fuerza bruta sobre permutaciones es instantánea y no merece la
    pena algo más elaborado.
    """
    import itertools
    n_f, n_c = len(coste), len(coste[0]) if coste else 0
    if n_f == 0 or n_c == 0:
        return {}
    mejor, mejor_coste = None, float("inf")
    columnas = range(n_c)
    for perm in itertools.permutations(columnas, min(n_f, n_c)):
        c = sum(coste[i][perm[i]] for i in range(len(perm)))
        if c < mejor_coste:
            mejor_coste, mejor = c, perm
    return {i: mejor[i] for i in range(len(mejor))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--match", required=True)
    ap.add_argument("--timeline", required=True)
    ap.add_argument("--offset", type=float, required=True)
    ap.add_argument("--minutos", default="6,8,10,12,14,16,18,20")
    ap.add_argument("--radio", type=int, default=13)
    ap.add_argument("--lado", type=int, default=26)
    ap.add_argument("--version", default="16.16.1")
    ap.add_argument("--cache", default="D:/lol-corpus/iconos")
    ap.add_argument("--dump")
    a = ap.parse_args()

    partida = json.load(open(a.match, encoding="utf-8"))
    tl = json.load(open(a.timeline, encoding="utf-8"))
    champs = [p["championName"] for p in partida["info"]["participants"]]
    teams = [p["teamId"] for p in partida["info"]["participants"]]
    propio = teams[0]
    aliados = [i + 1 for i, t in enumerate(teams) if t == propio]

    dur = tl["info"]["frames"][-1]["timestamp"] / 1000.0 + a.offset
    print("construyendo el minimapa vacío…", flush=True)
    bg = fondo(a.video, dur)
    if bg is None:
        raise SystemExit("no se pudo leer el vídeo")
    if a.dump:
        cv2.imwrite(f"{a.dump}/fondo.png", bg)

    n_cand, aciertos, total = [], 0, 0
    errores = []
    for minuto in [int(m) for m in a.minutos.split(",")]:
        if minuto >= len(tl["info"]["frames"]):
            continue
        fr_api = tl["info"]["frames"][minuto]
        fr = frame_en(a.video, fr_api["timestamp"] / 1000.0 + a.offset)
        if fr is None:
            continue
        mm = recorte(fr)
        alto, ancho = mm.shape[:2]
        cand, mask = circulos(mm, bg, a.radio)
        n_cand.append(len(cand))
        if not cand:
            continue

        # Paso 3: repartir los retratos de los aliados entre los candidatos.
        coste = [[parecido(mm, cx, cy, icono(champs[pid - 1], a.version, a.cache), a.lado)
                  for cx, cy, _ in cand] for pid in aliados]
        elegido = asignar(coste)

        vis = cv2.resize(mm, (ancho * 2, alto * 2), interpolation=cv2.INTER_NEAREST)
        for cx, cy, _ in cand:
            cv2.circle(vis, (int(cx * 2), int(cy * 2)), 14, (0, 140, 255), 1)

        for i, pid in enumerate(aliados):
            pos = fr_api["participantFrames"].get(str(pid), {}).get("position")
            if not pos:
                continue
            total += 1
            vx, vy = pos["x"] / MAPA * ancho, (1 - pos["y"] / MAPA) * alto
            cv2.circle(vis, (int(vx * 2), int(vy * 2)), 15, (0, 255, 0), 2)
            j = elegido.get(i)
            if j is None:
                continue
            cx, cy, _ = cand[j]
            err = (((cx - vx) ** 2 + (cy - vy) ** 2) ** 0.5) / ancho * MAPA
            errores.append(err)
            if err <= 700:
                aciertos += 1
            cv2.circle(vis, (int(cx * 2), int(cy * 2)), 15, (0, 0, 255), 2)
            cv2.putText(vis, champs[pid - 1][:4], (int(cx * 2) - 12, int(cy * 2) - 18),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)
        if a.dump:
            cv2.imwrite(f"{a.dump}/track_min{minuto}.png", vis)

    print(f"\ncandidatos por fotograma: {n_cand}  (deberían rondar 5-10)")
    print(f"aliados bien situados: {aciertos}/{total} "
          f"({100 * aciertos / max(1, total):.0f}%)")
    if errores:
        errores.sort()
        print(f"error: mediana {errores[len(errores)//2]:.0f} | "
              f"media {sum(errores)/len(errores):.0f} unidades")
        print("referencia: el estimador solo-API da ~940 de error mediano")


if __name__ == "__main__":
    main()
