"""Lectura de `estela.bin`, la estela del ratón de una partida.

Desde la fase 2 del plan de almacenamiento la estela ya no va dentro del
metadata (`{id}.json`) sino en `estela.bin`, al lado. El formato está descrito
en `src-tauri/src/estela.rs`. Para las partidas aún sin migrar, `de_metadata`
cae a la lista `mouse_events` del JSON, que es donde estaba antes.
"""

import os
import struct

FICHERO = "estela.bin"


def leer(carpeta):
    """Lista de dicts {t, x, y, evt}, o None si la carpeta no tiene estela.bin."""
    ruta = os.path.join(carpeta, FICHERO)
    if not os.path.exists(ruta):
        return None
    datos = open(ruta, "rb").read()
    if datos[:4] != b"WDES":
        raise ValueError(f"{ruta}: no es un fichero de estela")
    version, n_tipos = struct.unpack_from("<II", datos, 4)
    if version != 1:
        raise ValueError(f"{ruta}: versión de estela desconocida {version}")
    pos = 12
    tipos = []
    for _ in range(n_tipos):
        n = datos[pos]
        tipos.append(datos[pos + 1:pos + 1 + n].decode("utf-8", "replace"))
        pos += 1 + n
    (n,) = struct.unpack_from("<I", datos, pos)
    pos += 4
    pos += (8 - pos % 8) % 8
    t = struct.unpack_from(f"<{n}d", datos, pos)
    x = struct.unpack_from(f"<{n}d", datos, pos + 8 * n)
    y = struct.unpack_from(f"<{n}d", datos, pos + 16 * n)
    evt = datos[pos + 24 * n:pos + 25 * n]
    return [{"t": t[i], "x": x[i], "y": y[i], "evt": tipos[evt[i]] if evt[i] < len(tipos) else ""}
            for i in range(n)]


def de_metadata(json_path, metadata):
    """La estela de una partida: de estela.bin si existe, si no del JSON viejo."""
    desde_fichero = leer(os.path.dirname(os.path.abspath(json_path)))
    if desde_fichero is not None:
        return desde_fichero
    return metadata.get("mouse_events", [])
