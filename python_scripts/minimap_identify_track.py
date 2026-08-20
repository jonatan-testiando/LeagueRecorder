"""Identifica a los diez siguiéndolos, en vez de reconociendo su cara.

Comparar retratos no funciona: a 26 píxeles la señal no distingue un campeón de
otro, y el intento sale **por debajo del azar** (20% frente a 29%). Los números y
el diagnóstico están en `minimap_identify.py`.

Lo que sí funciona es la misma idea que ya resolvió localizar al jugador grabado:

- En cada **borde de minuto** la API dice exactamente dónde está cada uno de los
  diez. Ahí la identidad se conoce **sin reconocer nada**: basta emparejar cada
  detección con la posición que da la API.
- **Entre minutos** se propaga por continuidad. En medio segundo nadie se va
  lejos, así que la detección más cercana a donde estaba es él.

Convierte "reconocer una cara borrosa" en "seguir un punto que se mueve poco".

Y hay una asimetría que conviene tener presente: **los aliados salen siempre en
el minimapa, los rivales sólo cuando los ves**. Así que a un rival se le sigue
mientras esté visible y se le pierde al entrar en niebla — que es exactamente lo
que pasa en la partida, y por eso no es un defecto sino el dato correcto.

## ESTADO: sirve para seguir, NO para poner nombres en la interfaz

Cobertura, tras añadir el rescate por posición de la API:

    rivales cerca de ti en un momento de presión: 138
    de esos, con nombre asignado: 86 (62%)      antes del rescate: 18%

Pero cobertura no es acierto, y el acierto **no se puede acotar bien**: la única
verdad disponible está en los bordes de minuto, y ahí es donde se ancla. Las dos
cotas que se pudieron medir:

    46%  suelo   — anclando sólo en minutos pares y comprobando en los impares
    79%  techo   — con todas las anclas, pero contaminado: el rescate elige la
                   detección más cercana a la interpolación, que apunta justo
                   hacia el minuto con el que luego se comprueba

Entre 46% y 79% de nombres correctos no da para escribir "te vinieron Vladimir,
Jinx y Bard" como un hecho: un nombre equivocado se detecta al instante y tumba
la confianza en todo lo demás. Estrecharlo exigiría etiquetar vídeo a mano.

Se intentó también la vía sin inferir nada —contar con el vídeo y nombrar con la
API en los minutos que rodean el momento, donde los nombres son exactos— y no
cubre: la API nombra a suficientes sólo en el **57%** de los instantes (n=2.007,
17 partidas). Es esperable: el gank pasa *entre* minutos, que es justo el hueco
por el que hizo falta el vídeo.

Así que esto se queda como infraestructura de seguimiento, no como fuente de
nombres para la interfaz.

    python minimap_identify_track.py --match <carpeta>
"""
import argparse
import json
import math
import os

# Lo que alguien puede recorrer por segundo sin romper la física del juego.
VELOCIDAD_MAX = 1800.0

# Cuánto se aguanta sin ver a alguien antes de darlo por perdido. El detector ve
# el 75% de los iconos, así que abandonar al primer fallo dejaría el seguimiento
# a la mitad.
HUECO_MAX = 3.0

# A qué distancia una detección puede ser la persona que dice la API.
ANCLA_MAX = 900.0

# Lo mismo, pero para el rescate entre minutos. Más holgado a propósito: ahí la
# posición de la API es una interpolación con ~940 de error típico, y el objetivo
# no es acertar el punto sino elegir entre cinco rivales.
RESCATE_MAX = 2500.0


def interpolar_api(anclas, pid, sec):
    """Dónde estaría alguien según la API, interpolando entre minutos.

    Su error tipico es de ~940 unidades, demasiado para usarla como POSICION.
    Pero para decidir IDENTIDAD basta y sobra: no hay que acertar el punto, sólo
    distinguir entre cinco rivales que suelen estar en zonas distintas del mapa.
    Y a diferencia del vídeo, **la API no tiene niebla**: sabe dónde está un
    rival aunque no se le vea.
    """
    secs = sorted(t for t in anclas if pid in anclas[t])
    if not secs:
        return None
    antes = [t for t in secs if t <= sec]
    despues = [t for t in secs if t >= sec]
    if not antes or not despues:
        t = (antes or despues)[-1 if antes else 0]
        return anclas[t][pid]
    t0, t1 = antes[-1], despues[0]
    if t1 == t0:
        return anclas[t0][pid]
    f = (sec - t0) / (t1 - t0)
    (x0, y0), (x1, y1) = anclas[t0][pid], anclas[t1][pid]
    return (x0 + (x1 - x0) * f, y0 + (y1 - y0) * f)


def seguir_a_todos(pos, tl, participantes):
    """Devuelve {participant_id: [(sec, x, y, anclado)]} para los diez."""
    offset = pos["video_offset"]
    equipo = {i + 1: p["teamId"] for i, p in enumerate(participantes)}

    # Posiciones exactas de la API, por segundo de partida redondeado.
    anclas = {}
    for fr in tl["info"]["frames"]:
        sec = round(fr["timestamp"] / 1000.0)
        for k, pf in fr["participantFrames"].items():
            p = pf.get("position")
            if p:
                anclas.setdefault(sec, {})[int(k)] = (p["x"], p["y"])

    pistas = {pid: [] for pid in equipo}
    actual = {}          # pid -> (x, y)
    visto = {}           # pid -> segundo

    for s in pos["samples"]:
        sec = s["t"] - offset
        cerca = [a for a in anclas if abs(a - sec) <= 0.5]

        # --- Reanclado en el borde de minuto ---
        if cerca:
            reales = anclas[cerca[0]]
            libres = list(s["icons"])
            # Se asigna del más cercano al más lejano: si dos comparten
            # detección, se la queda quien esté más cerca de verdad.
            pares = []
            for pid, (ax, ay) in reales.items():
                for j, ic in enumerate(libres):
                    if ic["team"] is not None and ic["team"] != equipo.get(pid):
                        continue
                    pares.append((math.dist((ic["x"], ic["y"]), (ax, ay)), pid, j))
            pares.sort()
            usados, puestos = set(), set()
            for d, pid, j in pares:
                if d > ANCLA_MAX or pid in puestos or j in usados:
                    continue
                ic = libres[j]
                actual[pid] = (ic["x"], ic["y"])
                visto[pid] = sec
                pistas[pid].append((sec, ic["x"], ic["y"], True))
                usados.add(j)
                puestos.add(pid)
            continue

        # --- Propagación por continuidad ---
        libres = list(range(len(s["icons"])))
        pares = []
        for pid, (px, py) in actual.items():
            dt = sec - visto.get(pid, sec)
            if dt > HUECO_MAX:
                continue
            for j in libres:
                ic = s["icons"][j]
                if ic["team"] is not None and ic["team"] != equipo.get(pid):
                    continue
                d = math.dist((ic["x"], ic["y"]), (px, py))
                # El radio admisible crece con el hueco: si hace dos segundos
                # que no se le ve, pudo recorrer el doble.
                if d <= VELOCIDAD_MAX * max(dt, 0.5):
                    pares.append((d, pid, j))
        pares.sort()
        usados, puestos = set(), set()
        for d, pid, j in pares:
            if pid in puestos or j in usados:
                continue
            ic = s["icons"][j]
            actual[pid] = (ic["x"], ic["y"])
            visto[pid] = sec
            pistas[pid].append((sec, ic["x"], ic["y"], False))
            usados.add(j)
            puestos.add(pid)

        # --- Rescate por la posición que da la API ---
        #
        # Un rival entra y sale de la niebla constantemente, así que su rastro se
        # rompe y con sólo continuidad se le pierde el nombre: medido, sólo el
        # 18% de los rivales que te rodean quedaba identificado.
        #
        # La API sí sabe dónde está aunque no se le vea. Su posición interpolada
        # es mala como POSICIÓN (~940 de error) pero sirve para elegir entre cinco
        # rivales, que casi nunca están juntos. Se usa sólo para los que no se
        # pudo emparejar por continuidad.
        sueltos = [j for j in range(len(s["icons"])) if j not in usados]
        if sueltos:
            rescate = []
            for pid in pistas:
                if pid in puestos:
                    continue
                ref = interpolar_api(anclas, pid, sec)
                if ref is None:
                    continue
                for j in sueltos:
                    ic = s["icons"][j]
                    if ic["team"] is not None and ic["team"] != equipo.get(pid):
                        continue
                    d = math.dist((ic["x"], ic["y"]), ref)
                    if d <= RESCATE_MAX:
                        rescate.append((d, pid, j))
            rescate.sort()
            for d, pid, j in rescate:
                if pid in puestos or j in usados:
                    continue
                ic = s["icons"][j]
                actual[pid] = (ic["x"], ic["y"])
                visto[pid] = sec
                pistas[pid].append((sec, ic["x"], ic["y"], False))
                usados.add(j)
                puestos.add(pid)

        # Quien lleva demasiado sin aparecer se suelta, en vez de arrastrar una
        # posición inventada.
        for pid in [p for p in actual if sec - visto.get(p, sec) > HUECO_MAX]:
            actual.pop(pid, None)

    return pistas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--match", required=True)
    a = ap.parse_args()
    d = a.match
    mt = json.load(open(os.path.join(d, "riot_match.json"), encoding="utf-8"))
    tl = json.load(open(os.path.join(d, "riot_timeline.json"), encoding="utf-8"))
    pos = json.load(open(os.path.join(d, "minimap_positions.json"), encoding="utf-8"))
    ps = mt["info"]["participants"]
    mi_equipo = pos["self_team_id"]

    pistas = seguir_a_todos(pos, tl, ps)
    total_muestras = len(pos["samples"])

    # Acierto medido contra los bordes de minuto que NO se usaron para anclar:
    # se comprueba que la posición propagada desde el minuto anterior coincide
    # con la que dice la API en el siguiente.
    offset = pos["video_offset"]
    aciertos = comprobados = 0
    for fr in tl["info"]["frames"]:
        sec = fr["timestamp"] / 1000.0
        for k, pf in fr["participantFrames"].items():
            p = pf.get("position")
            pid = int(k)
            if not p:
                continue
            # La muestra JUSTO ANTES del ancla: viene propagada, no anclada.
            previas = [f for f in pistas[pid] if sec - 3.0 <= f[0] < sec - 0.6 and not f[3]]
            if not previas:
                continue
            comprobados += 1
            _, x, y, _ = previas[-1]
            if math.dist((x, y), (p["x"], p["y"])) < 1500:
                aciertos += 1

    print(f"{total_muestras} muestras de vídeo")
    print(f"{'jugador':14} {'equipo':>7} {'seguido':>9}")
    for i, p in enumerate(ps):
        pid = i + 1
        lado = "tuyo" if p["teamId"] == mi_equipo else "rival"
        print(f"{p['championName']:14} {lado:>7} {100*len(pistas[pid])/total_muestras:>8.0f}%")
    print(f"\nposición propagada correcta al llegar al siguiente minuto: "
          f"{aciertos}/{comprobados} ({100*aciertos/max(1,comprobados):.0f}%)")


if __name__ == "__main__":
    main()
