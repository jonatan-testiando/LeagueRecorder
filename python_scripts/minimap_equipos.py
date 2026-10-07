"""Lectura de minimap_positions.json para las herramientas de desarrollo.

Va aparte de `minimap_positions.py` porque ese se empaqueta solo (un fichero) y
arrastra cv2; esto es Python puro.
"""
import json


def cargar_posiciones(ruta):
    """Lee un minimap_positions.json con `team` en teamId de verdad.

    Los ficheros anteriores al 2026-10-07 (sin `team_from`) ponían aro azul =
    100; en lado rojo eso es al revés. Misma corrección que
    `Positions::from_json` en Rust (minimap.rs).
    """
    with open(ruta, encoding="utf-8") as f:
        pos = json.load(f)
    if not pos.get("team_from") and pos.get("self_team_id") == 200:
        for s in pos.get("samples", []):
            for i in s["icons"]:
                if i.get("team"):
                    i["team"] = 200 if i["team"] == 100 else 100
    pos["team_from"] = "ally_ring"
    return pos
