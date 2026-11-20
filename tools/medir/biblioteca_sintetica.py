"""Biblioteca sintética para medir cómo escala la app (fase 0 del plan de almacenamiento).

Copia las carpetas de partida de una biblioteca real hasta llegar a N partidas,
SIN los vídeos ni las imágenes: solo los JSON, que es lo que la app lee para
listar, analizar y pintar. Cada réplica recibe un id nuevo con el mismo formato
(`match_YYYYMMDD_HHMMSS`), desplazado hacia atrás en el tiempo, y se reescriben
el id y la fecha dentro de los ficheros que los llevan.

Las fechas de modificación se conservan: varias cachés (coach, presión, ruta de
jungla) se dan por frescas comparando mtimes, y una réplica con mtimes nuevos
parecería una biblioteca entera por recalcular, que no es lo que se quiere medir.
Para medir el caso sin cachés está `--sin-caches`.

Uso:
    python tools/medir/biblioteca_sintetica.py --origen "C:\\Users\\X\\Videos\\LeagueRecorder" \\
        --destino D:\\medir\\bib300 --n 300
"""

import argparse
import datetime as dt
import os
import shutil
import sys
from pathlib import Path

# Lo que nunca se copia: pesa gigas y la app no lo lee para listar ni analizar.
EXCLUIR_EXT = {".mp4", ".jpg", ".png", ".part", ".tmp"}
EXCLUIR_DIR = {"snaps", "dataset", "recortes"}
# Cachés derivadas que `--sin-caches` deja fuera para forzar el recálculo.
CACHES = ("coach_v", "plays_v", "pressure_v", "jungle_route_v")
FORMATO_ID = "match_%Y%m%d_%H%M%S"


def partidas(origen: Path) -> list[Path]:
    return sorted(
        p for p in origen.iterdir()
        if p.is_dir() and p.name.startswith("match_") and (p / f"{p.name}.json").exists()
    )


def copiar(src: Path, dst: Path, viejo: str, nuevo: str, delta: dt.timedelta, sin_caches: bool):
    dst.mkdir(parents=True, exist_ok=True)
    fecha_vieja = dt.datetime.strptime(viejo, FORMATO_ID)
    fecha_nueva = fecha_vieja - delta
    for f in src.iterdir():
        if f.is_dir() or f.suffix.lower() in EXCLUIR_EXT or f.name in EXCLUIR_DIR:
            continue
        if sin_caches and f.name.startswith(CACHES):
            continue
        nombre = f.name.replace(viejo, nuevo)
        destino = dst / nombre
        if viejo == nuevo:
            shutil.copy2(f, destino)
            continue
        datos = f.read_bytes()
        if viejo.encode() in datos:
            datos = datos.replace(viejo.encode(), nuevo.encode())
            # La fecha legible del metadata ("2026-08-31 22:02:54").
            datos = datos.replace(
                fecha_vieja.strftime("%Y-%m-%d %H:%M:%S").encode(),
                fecha_nueva.strftime("%Y-%m-%d %H:%M:%S").encode(),
            )
            destino.write_bytes(datos)
            st = f.stat()
            os.utime(destino, ns=(st.st_atime_ns, st.st_mtime_ns))
        else:
            shutil.copy2(f, destino)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--origen", required=True, type=Path)
    ap.add_argument("--destino", required=True, type=Path)
    ap.add_argument("--n", required=True, type=int)
    ap.add_argument("--sin-caches", action="store_true")
    a = ap.parse_args()

    base = partidas(a.origen)
    if not base:
        print("no hay partidas en el origen", file=sys.stderr)
        return 1
    if a.destino.exists() and any(a.destino.iterdir()):
        print(f"el destino {a.destino} no está vacío", file=sys.stderr)
        return 1
    a.destino.mkdir(parents=True, exist_ok=True)

    for i in range(a.n):
        src = base[i % len(base)]
        vuelta = i // len(base)
        viejo = src.name
        # Cada vuelta, 30 días y unos minutos hacia atrás: ids únicos y orden de
        # fechas verosímil (las réplicas son más antiguas que las reales).
        delta = dt.timedelta(days=30 * vuelta, minutes=7 * vuelta)
        nuevo = (dt.datetime.strptime(viejo, FORMATO_ID) - delta).strftime(FORMATO_ID)
        copiar(src, a.destino / nuevo, viejo, nuevo, delta, a.sin_caches)
        if (i + 1) % 100 == 0:
            print(f"{i + 1}/{a.n}", file=sys.stderr)
    print(f"{a.n} partidas en {a.destino}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
