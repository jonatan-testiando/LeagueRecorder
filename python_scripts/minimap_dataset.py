"""Genera el conjunto de entrenamiento para el detector de iconos del minimapa.

Tres intentos de detectarlos con reglas fallaron (ver `minimap_detect.py`,
`minimap_ring.py` y `minimap_track.py`, cada uno con sus números). El minimapa
está demasiado cargado —temporizadores que cambian cada segundo, escudos de
torre, guardianes, el recuadro de la cámara— y cada regla que arregla una clase
de falso positivo tropieza con la siguiente.

Lo que hace viable entrenar en su lugar es que **las etiquetas salen gratis**: la
API da la posición exacta de los diez en cada borde de minuto, y el mapeo a
píxeles ya está verificado (`minimap_calib.py`). Ninguna imagen se marca a mano.

## Decisiones, y por qué

**Una sola clase, "icono de campeón".** No 170 clases (una por campeón): con
~2.700 ejemplos no hay para eso, y además no hace falta. El detector sólo tiene
que decir *dónde* hay un icono; *de quién* es se resuelve después comparando los
retratos contra los pocos candidatos encontrados, que es fácil.

**Sólo se etiquetan aliados.** Un rival en niebla no aparece en el minimapa, así
que etiquetar su posición enseñaría al modelo a ver algo que no está. Los aliados
son siempre visibles.

**Al entrenar hace falta aumento de tono (hue).** Si no, el modelo aprende "aro
azul" y no reconoce a los rivales, que lo llevan rojo. Con el tono aleatorizado
aprende la forma, que es lo que comparten.

**Se descartan los muertos.** Un campeón muerto no está en el minimapa, y la API
sigue dando una posición para él. Sin este filtro entrarían etiquetas sobre
terreno vacío.

    python minimap_dataset.py --out D:/lol-corpus/minimapa
"""
import argparse
import glob
import json
import os
import random

import cv2

from minimap_detect import MAPA, frame_en, recorte

# Lado del recuadro del icono, en píxeles del recorte. Medido ampliando iconos
# reales en `minimap_detect.py`: rondan los 26 px.
LADO = 26

# Un campeón que murió hace menos de esto probablemente siga muerto, así que su
# posición no corresponde a ningún icono visible. Es el temporizador más largo
# del juego, redondeado hacia arriba: se pierde alguna etiqueta buena, pero
# ninguna mala entra.
MUERTO_S = 80.0


def muertos_en(tl, sec):
    """Participantes que murieron en los `MUERTO_S` segundos previos a `sec`."""
    out = set()
    for fr in tl["info"]["frames"]:
        for e in fr["events"]:
            if e.get("type") != "CHAMPION_KILL":
                continue
            t = e["timestamp"] / 1000.0
            if sec - MUERTO_S <= t <= sec:
                out.add(e.get("victimId"))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", default="C:/Users/Alejandro/Videos/LeagueRecorder")
    ap.add_argument("--out", default="D:/lol-corpus/minimapa")
    ap.add_argument("--val", type=float, default=0.25,
                    help="fracción de PARTIDAS (no de fotogramas) para validar")
    a = ap.parse_args()

    partidas = []
    for meta in sorted(glob.glob(os.path.join(a.videos, "*", "*.json"))):
        d = os.path.dirname(meta)
        try:
            m = json.load(open(meta, encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(m, dict) or m.get("video_offset") is None:
            continue
        tl_p = os.path.join(d, "riot_timeline.json")
        mt_p = os.path.join(d, "riot_match.json")
        vid = os.path.join(d, os.path.basename(d) + ".mp4")
        if all(os.path.exists(p) for p in (tl_p, mt_p, vid)):
            # El campeón viaja en la tupla a propósito: usar `m` dentro del
            # segundo bucle leía el valor que quedó del primero (Python no acota
            # las variables al bucle), así que se comparaba contra el campeón de
            # otra partida y se saltaban las 17.
            partidas.append((os.path.basename(d), vid, mt_p, tl_p,
                             m["video_offset"], m.get("champion")))

    if not partidas:
        raise SystemExit("no hay partidas con vídeo, timeline y desplazamiento medido")

    # La separación es POR PARTIDA: dos fotogramas de la misma partida comparten
    # HUD, campeones y estilo de juego, y repartirlos entre entreno y validación
    # daría un acierto inflado.
    random.Random(7).shuffle(partidas)
    corte = max(1, int(len(partidas) * a.val))
    reparto = {p[0]: ("val" if i < corte else "train") for i, p in enumerate(partidas)}

    for sub in ("train", "val"):
        os.makedirs(f"{a.out}/images/{sub}", exist_ok=True)
        os.makedirs(f"{a.out}/labels/{sub}", exist_ok=True)

    n_img = n_lab = n_muertos = 0
    for nombre, vid, mt_p, tl_p, offset, mi_campeon in partidas:
        sub = reparto[nombre]
        mt = json.load(open(mt_p, encoding="utf-8"))
        tl = json.load(open(tl_p, encoding="utf-8"))
        teams = [p["teamId"] for p in mt["info"]["participants"]]
        # OJO: el equipo del JUGADOR GRABADO, no el del participante 0 (que es
        # siempre el equipo 100). Con `teams[0]` se etiquetaba al equipo azul
        # como "aliados siempre visibles" incluso cuando el usuario jugaba en
        # rojo — o sea, se etiquetaban RIVALES, que pasan media partida en
        # niebla y no aparecen en el minimapa.
        #
        # Ese fallo de una línea hundía la cobertura del detector del 90% al 35%
        # en las partidas de lado rojo, y como son ~la mitad, el total se quedaba
        # clavado en 51% por muchos datos que se le echaran.
        propio = next((p["teamId"] for p in mt["info"]["participants"]
                       if p["championName"] == mi_campeon), None)
        if propio is None:
            print(f"  {nombre}: no encuentro a {mi_campeon}, se salta", flush=True)
            continue

        for minuto, fr_api in enumerate(tl["info"]["frames"]):
            sec = fr_api["timestamp"] / 1000.0
            if sec < 60:
                continue  # el minuto 0 es la fase de carga y salida de base
            fr = frame_en(vid, sec + offset)
            if fr is None:
                continue
            mm = recorte(fr)
            alto, ancho = mm.shape[:2]
            muertos = muertos_en(tl, sec)

            lineas = []
            for pid_str, pf in fr_api["participantFrames"].items():
                pid = int(pid_str)
                pos = pf.get("position")
                if not pos or teams[pid - 1] != propio:
                    continue
                if pid in muertos:
                    n_muertos += 1
                    continue
                cx = pos["x"] / MAPA * ancho
                cy = (1 - pos["y"] / MAPA) * alto
                # Un icono pegado al borde sale cortado y su recuadro mentiría.
                if not (LADO / 2 <= cx <= ancho - LADO / 2):
                    continue
                if not (LADO / 2 <= cy <= alto - LADO / 2):
                    continue
                lineas.append(f"0 {cx/ancho:.6f} {cy/alto:.6f} "
                              f"{LADO/ancho:.6f} {LADO/alto:.6f}")

            if not lineas:
                continue
            base = f"{nombre}_min{minuto:03d}"
            cv2.imwrite(f"{a.out}/images/{sub}/{base}.png", mm)
            open(f"{a.out}/labels/{sub}/{base}.txt", "w").write("\n".join(lineas))
            n_img += 1
            n_lab += len(lineas)
        print(f"  {nombre} ({sub}): {n_img} imágenes acumuladas", flush=True)

    with open(f"{a.out}/dataset.yaml", "w", encoding="utf-8") as f:
        f.write(f"path: {a.out}\ntrain: images/train\nval: images/val\n"
                "names:\n  0: icono\n")

    print(f"\n{n_img} imágenes, {n_lab} iconos etiquetados")
    print(f"descartados por estar muertos: {n_muertos}")
    print(f"partidas de validación: {[k for k, v in reparto.items() if v == 'val']}")
    print(f"\nconfiguración -> {a.out}/dataset.yaml")


if __name__ == "__main__":
    main()
