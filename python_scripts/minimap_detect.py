"""Detecta a los campeones en el minimapa del vídeo.

Es la pieza que da posiciones densas donde la API sólo da una por minuto. Con
ella, el estimador de `occupancy.rs` deja de validarse contra sí mismo y los
tramos de presión dejan de tener una duración que es sólo cota inferior.

El método es template matching contra los retratos de Data Dragon, sin IA: los
iconos del minimapa son el mismo retrato reescalado, así que no hay nada que
aprender. Lo único con truco es que van recortados en círculo y con un aro del
color del equipo, así que la plantilla se enmascara igual.

**La validación es gratis**: en cada borde de minuto la API da las posiciones
exactas de los diez, así que el error se mide sin etiquetar nada a mano.

## ESTADO: este método NO funciona todavía. Medido, no supuesto.

Error medio **2.718 unidades** validando solo contra aliados (los rivales en
niebla no salen en el minimapa, exigirlos mide la niebla y no el detector). El
estimador solo-API de `occupancy.rs` da ~940 de error mediano, así que esto es
**peor que lo que ya teníamos** y no debe usarse.

La causa está diagnosticada: el comparador converge al mismo píxel para campeones
distintos (Riven e Irelia dieron ambos (212,187) en la prueba). A 26 px, el
círculo central sin enmascarar son ~300 píxeles de cara borrosa, y eso no basta
para distinguir un campeón de otro.

Lo que hay que hacer en su lugar, y no es un ajuste de parámetros sino otro
diseño:

1. **Primero encontrar los iconos**, sin saber de quién son: son círculos con un
   aro de color de equipo, y detectar eso es mucho más fácil que identificar a
   quién pertenece.
2. **Luego asignar** campeones a esos candidatos como un problema de asignación
   (húngaro), aprovechando una restricción fuerte que ahora se ignora: hay
   exactamente cinco aliados en el mapa, y cada uno está en un sitio distinto.
   Buscar el máximo por campeón de forma independiente permite que dos caigan
   en el mismo píxel, que es justo el fallo observado.

    python minimap_detect.py --video X.mp4 --match Y.json --timeline Z.json \
        --offset 97.02 --minutos 8,10,12,14,16
"""
import argparse
import json
import os
import subprocess
import urllib.request

import cv2
import numpy as np

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# Mismo ROI que `camera_snaps.py`, ya afinado contra grabaciones reales.
MM = (0.787, 0.995, 0.622, 0.972)
MAPA = 14870.0

# Data Dragon usa nombres internos que no siempre son el `championName` de
# Match-V5. Estos son los que difieren.
ALIAS = {
    "FiddleSticks": "Fiddlesticks",
    "Nunu&Willump": "Nunu",
    "Wukong": "MonkeyKing",
    "RenataGlasc": "Renata",
}


def icono(nombre, version, cache):
    """Retrato cuadrado del campeón, cacheado en disco."""
    os.makedirs(cache, exist_ok=True)
    ruta = os.path.join(cache, f"{nombre}.png")
    if not os.path.exists(ruta):
        dd = ALIAS.get(nombre, nombre)
        url = f"https://ddragon.leagueoflegends.com/cdn/{version}/img/champion/{dd}.png"
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            open(ruta, "wb").write(r.read())
    return cv2.imread(ruta, cv2.IMREAD_COLOR)


def plantilla(img, lado):
    """Retrato al tamaño del minimapa y recortado en círculo.

    El recorte importa: el icono real lleva un aro del color del equipo, y sin
    enmascarar la plantilla las esquinas cuadradas del retrato compiten con ese
    aro y ensucian la correlación.
    """
    t = cv2.resize(img, (lado, lado), interpolation=cv2.INTER_AREA)
    mask = np.zeros((lado, lado), np.uint8)
    # Radio algo menor que el icono: se descarta el aro, que cambia de color
    # según el equipo y no aporta a la identificación del campeón.
    cv2.circle(mask, (lado // 2, lado // 2), int(lado * 0.38), 255, -1)
    return t, mask


def frame_en(video, sec):
    cmd = ["ffmpeg", "-loglevel", "error", "-ss", str(sec), "-i", video,
           "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]
    out = subprocess.run(cmd, capture_output=True).stdout
    if not out:
        return None
    return cv2.imdecode(np.frombuffer(out, np.uint8), cv2.IMREAD_COLOR)


def recorte(frame):
    h, w = frame.shape[:2]
    x0, x1, y0, y1 = MM
    return frame[int(h * y0):int(h * y1), int(w * x0):int(w * x1)]


def a_juego(px, py, ancho, alto):
    return px / ancho * MAPA, (1.0 - py / alto) * MAPA


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--match", required=True)
    ap.add_argument("--timeline", required=True)
    ap.add_argument("--offset", type=float, required=True)
    ap.add_argument("--minutos", default="8,10,12,14,16,18")
    ap.add_argument("--version", default="16.16.1")
    ap.add_argument("--cache", default="D:/lol-corpus/iconos")
    ap.add_argument("--umbral", type=float, default=0.25)
    ap.add_argument("--lados", default="20,22,24,26,28",
                    help="tamaños de icono a probar, en píxeles")
    ap.add_argument("--equipo", type=int, default=0,
                    help="validar solo con este equipo (100/200). 0 = ambos")
    a = ap.parse_args()

    partida = json.load(open(a.match, encoding="utf-8"))
    tl = json.load(open(a.timeline, encoding="utf-8"))
    campeones = [p["championName"] for p in partida["info"]["participants"]]
    equipos = [p["teamId"] for p in partida["info"]["participants"]]
    iconos = {c: icono(c, a.version, a.cache) for c in set(campeones)}

    minutos = [int(m) for m in a.minutos.split(",")]
    lados = [int(s) for s in a.lados.split(",")]

    # Se barre el tamaño de icono porque depende de la resolución de captura y
    # de la escala del HUD, y no hay forma fiable de deducirlo del vídeo.
    print(f"{'lado':>5} {'detectados':>11} {'error medio':>12} {'p90':>8}")
    mejor = None
    for lado in lados:
        errores = []
        detectados = 0
        total = 0
        for minuto in minutos:
            if minuto >= len(tl["info"]["frames"]):
                continue
            fr_api = tl["info"]["frames"][minuto]
            t_video = fr_api["timestamp"] / 1000.0 + a.offset
            fr = frame_en(a.video, t_video)
            if fr is None:
                continue
            mm = recorte(fr)
            alto, ancho = mm.shape[:2]
            for pid_str, pf in fr_api["participantFrames"].items():
                pos = pf.get("position")
                if not pos:
                    continue
                pid = int(pid_str)
                # Sólo se valida contra aliados: un rival en niebla NO aparece
                # en el minimapa, así que exigir su detección mide la niebla, no
                # el detector. Los aliados están siempre visibles.
                if a.equipo and equipos[pid - 1] != a.equipo:
                    continue
                champ = campeones[pid - 1]
                total += 1
                t, mask = plantilla(iconos[champ], lado)
                # SQDIFF y no CCORR: con correlación normalizada casi todo pasa
                # de 0,9 y el umbral no filtraba nada. Aquí el mejor es el
                # mínimo, y la distancia sí discrimina.
                res = cv2.matchTemplate(mm, t, cv2.TM_SQDIFF_NORMED, mask=mask)
                res = np.nan_to_num(res, nan=1.0, posinf=1.0, neginf=1.0)
                minv, _, minloc, _ = cv2.minMaxLoc(res)
                if minv > a.umbral:
                    continue
                cx, cy = minloc[0] + lado / 2, minloc[1] + lado / 2
                gx, gy = a_juego(cx, cy, ancho, alto)
                err = ((gx - pos["x"]) ** 2 + (gy - pos["y"]) ** 2) ** 0.5
                errores.append(err)
                detectados += 1
        if not errores:
            print(f"{lado:>5} {'0':>11}")
            continue
        errores.sort()
        media = sum(errores) / len(errores)
        p90 = errores[int(len(errores) * 0.9)]
        print(f"{lado:>5} {f'{detectados}/{total}':>11} {media:>12.0f} {p90:>8.0f}")
        if mejor is None or media < mejor[1]:
            mejor = (lado, media)

    if mejor:
        print(f"\nmejor tamaño de icono: {mejor[0]} px (error medio {mejor[1]:.0f} unidades)")
        print("referencia: el estimador solo-API da ~940 de error mediano")


if __name__ == "__main__":
    main()
