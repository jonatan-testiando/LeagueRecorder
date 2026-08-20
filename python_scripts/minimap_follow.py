"""Sigue al jugador grabado a través de las detecciones del minimapa.

Identificar "cuál de los iconos eres tú" eligiendo el aliado más cercano a la
posición que da la API no funciona: entre fotogramas de minuto esa posición es
una interpolación, y es precisamente lo que no se sabe. Con ese criterio el
seguimiento saltaba 6.600 unidades en dos segundos, que es imposible.

Lo correcto es **seguir**:

- En cada **borde de minuto** la API da la posición exacta, así que ahí se
  reancla sin dudas.
- **Entre bordes** se propaga por continuidad: de una muestra a la siguiente
  pasa medio segundo, y en medio segundo nadie se va muy lejos. Se acepta el
  icono más cercano al anterior, y sólo si el salto es físicamente posible.

Cuando no hay ningún icono compatible (te tapan, mueres, sales del mapa) el
seguimiento se marca como perdido hasta el siguiente ancla, en vez de inventarse
una posición.
"""
import json
import math
import os

# Cuánto puede moverse alguien por segundo sin romper la física. Unos 400 de
# velocidad base, más margen para destellos y desplazamientos.
VELOCIDAD_MAX = 1800.0

# Cuántos segundos se aguanta sin ver el icono antes de dar el rastro por
# perdido. El detector ve el 75% de los iconos, así que uno de cada cuatro
# fotogramas no trae el tuyo; abandonar al primer fallo dejaba el seguimiento en
# el 50%. Se tolera el hueco ampliando el radio de búsqueda con el tiempo
# transcurrido, que es justo lo que permite la física.
HUECO_MAX = 3.0


def seguir(positions, timeline):
    """Devuelve [(t_juego, x, y, anclado)] con la posición del jugador."""
    off = positions["video_offset"]
    yo = str(positions["self_participant_id"])
    mi_eq = positions["self_team_id"]

    # Posiciones exactas de la API, por segundo de juego.
    anclas = {}
    for f in timeline["info"]["frames"]:
        pf = f["participantFrames"].get(yo)
        if pf and pf.get("position"):
            anclas[round(f["timestamp"] / 1000.0)] = (pf["position"]["x"],
                                                      pf["position"]["y"])

    out = []
    actual = None
    t_visto = None
    for s in positions["samples"]:
        tg = s["t"] - off
        aliados = [i for i in s["icons"] if i["team"] == mi_eq]

        # ¿Hay ancla de la API cerca de este instante? Si la hay, manda ella.
        cerca = [a for a in anclas if abs(a - tg) <= 0.5]
        if cerca and aliados:
            ax, ay = anclas[cerca[0]]
            actual = min(aliados, key=lambda i: (i["x"] - ax) ** 2 + (i["y"] - ay) ** 2)
            t_visto = tg
            out.append((tg, actual["x"], actual["y"], True))
            continue

        if actual is None or not aliados:
            continue

        dt = tg - t_visto
        if dt > HUECO_MAX:
            actual = None  # demasiado rato sin verte: mejor perderte que seguir a otro
            continue

        cand = min(aliados, key=lambda i: math.dist((i["x"], i["y"]),
                                                    (actual["x"], actual["y"])))
        # El radio crece con el hueco: si hace 2 s que no te veo, pudiste
        # recorrer el doble.
        if math.dist((cand["x"], cand["y"]),
                     (actual["x"], actual["y"])) > VELOCIDAD_MAX * max(dt, 0.5):
            continue  # ninguno encaja: se espera, no se abandona
        actual = cand
        t_visto = tg
        out.append((tg, actual["x"], actual["y"], False))
    return out


def rivales_cerca(positions, pista, radio=2200.0):
    """Cuántos rivales había dentro del radio en cada instante seguido."""
    mi_eq = positions["self_team_id"]
    por_t = {round(s["t"] - positions["video_offset"], 2): s["icons"]
             for s in positions["samples"]}
    out = []
    for tg, x, y, anc in pista:
        iconos = por_t.get(round(tg, 2), [])
        n = sum(1 for i in iconos
                if i["team"] and i["team"] != mi_eq
                and math.dist((i["x"], i["y"]), (x, y)) <= radio)
        out.append((tg, n, anc))
    return out


if __name__ == "__main__":
    import sys
    d = sys.argv[1]
    P = json.load(open(os.path.join(d, "minimap_positions.json"), encoding="utf-8"))
    T = json.load(open(os.path.join(d, "riot_timeline.json"), encoding="utf-8"))
    pista = seguir(P, T)
    tot = len(P["samples"])
    print(f"seguimiento: {len(pista)}/{tot} muestras ({100*len(pista)/tot:.0f}%)")
    saltos = [math.dist(pista[i][1:3], pista[i-1][1:3])
              for i in range(1, len(pista)) if pista[i][0] - pista[i-1][0] < 1.0]
    if saltos:
        saltos.sort()
        print(f"salto entre muestras: mediana {saltos[len(saltos)//2]:.0f} | "
              f"p95 {saltos[int(len(saltos)*0.95)]:.0f} unidades")
    desde = float(sys.argv[2]) if len(sys.argv) > 2 else None
    if desde is not None:
        hasta = float(sys.argv[3])
        print(f"\n{'juego':>7} {'rivales':>8}")
        for tg, n, anc in rivales_cerca(P, pista):
            if desde <= tg <= hasta and int(tg * 2) % 4 == 0:
                print(f"  {int(tg//60)}:{int(tg%60):02d} {n:>6} {'#'*n}"
                      f"{'   <- ancla API' if anc else ''}")
