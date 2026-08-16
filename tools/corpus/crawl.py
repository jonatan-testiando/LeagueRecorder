"""Rastreador de partidas para el corpus de entrenamiento del score de MVP.

Guarda cada partida en crudo y comprimida (match + timeline en un solo .json.gz,
~70 KB por partida: 100k partidas caben en 7 GB). Se guarda el crudo a propósito
y no un extracto: todavía no sabemos qué features necesitará el modelo de
probabilidad de victoria, y volver a rastrear cuesta días.

Siembra estratificada por elo con league-exp-v4 y luego expande por los puuid de
los participantes de cada partida encontrada, así que la muestra no se queda
pegada al rango del que siembra.

Reanudable: el estado vive en SQLite junto a los datos. Matarlo y relanzarlo con
los mismos argumentos continúa donde iba.

    python crawl.py --key RGAPI-... --out D:/lol-corpus --target 100000

Cuota: con clave personal (100 peticiones / 2 min) salen ~1.500 partidas/hora.
"""
import argparse
import collections
import gzip
import json
import os
import random
import sqlite3
import sys
import time
import urllib.error
import urllib.request

# Cloudflare rechaza el User-Agent por defecto de urllib con "error code: 1010",
# que se parece a un problema de clave y no lo es.
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD",
         "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER"]
DIVISIONES = ["I", "II", "III", "IV"]
QUEUE_SOLO = 420


class Cuota:
    """Ventanas deslizantes para los dos límites que publica Riot a la vez.

    `margen` reserva una fracción de la cuota para el resto: la clave es la misma
    que usa la app del usuario, y un rastreador a tope la deja sin sincronizar
    partidas durante los días que dure.
    """

    def __init__(self, margen=0.2, limites=((20, 1.0), (100, 120.0))):
        self.limites = [(max(1, int(n * (1 - margen))), seg, collections.deque())
                        for n, seg in limites]

    def esperar(self):
        while True:
            ahora = time.monotonic()
            espera = 0.0
            for n, seg, hist in self.limites:
                while hist and ahora - hist[0] > seg:
                    hist.popleft()
                if len(hist) >= n:
                    espera = max(espera, seg - (ahora - hist[0]) + 0.05)
            if espera <= 0:
                for _, _, hist in self.limites:
                    hist.append(ahora)
                return
            time.sleep(espera)


class Api:
    def __init__(self, key, plataforma, region, margen=0.2, desde=0):
        self.key, self.plataforma, self.region = key, plataforma, region
        self.cuota = Cuota(margen)
        self.desde = desde
        self.peticiones = 0

    def _get(self, host, path):
        for intento in range(6):
            self.cuota.esperar()
            req = urllib.request.Request(
                f"https://{host}.api.riotgames.com{path}",
                headers={"X-Riot-Token": self.key, "User-Agent": UA},
            )
            try:
                with urllib.request.urlopen(req, timeout=45) as r:
                    self.peticiones += 1
                    return r.read()
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    # Riot manda cuánto esperar; si no, se sube por tramos.
                    espera = int(e.headers.get("Retry-After", 0)) or (5 * 2 ** intento)
                    log(f"    429, esperando {espera}s")
                    time.sleep(espera)
                    continue
                if e.code in (500, 502, 503, 504):
                    time.sleep(2 ** intento)
                    continue
                if e.code == 404:
                    return None
                if e.code in (401, 403):
                    raise SystemExit(f"Clave rechazada ({e.code}). Genera una nueva.")
                raise
            except (urllib.error.URLError, TimeoutError):
                time.sleep(2 ** intento)
        return None

    def puuids_por_rango(self, tier, division, pagina):
        d = self._get(self.plataforma,
                      f"/lol/league-exp/v4/entries/RANKED_SOLO_5x5/{tier}/{division}"
                      f"?page={pagina}")
        return [e["puuid"] for e in json.loads(d)] if d else []

    def partidas_de(self, puuid, cuantas=20):
        # `startTime` acota en origen: sin esto salían partidas del parche 15.5
        # mezcladas con las del 16.16, y los valores de objetivos cambiaron entre
        # medias. Filtrar aquí ahorra la cuota de descargarlas para tirarlas.
        desde = f"&startTime={self.desde}" if self.desde else ""
        d = self._get(self.region, f"/lol/match/v5/matches/by-puuid/{puuid}/ids"
                                   f"?queue={QUEUE_SOLO}&start=0&count={cuantas}{desde}")
        return json.loads(d) if d else []

    def partida(self, mid):
        return self._get(self.region, f"/lol/match/v5/matches/{mid}")

    def timeline(self, mid):
        return self._get(self.region, f"/lol/match/v5/matches/{mid}/timeline")


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def abrir_estado(out):
    os.makedirs(out, exist_ok=True)
    db = sqlite3.connect(os.path.join(out, "estado.db"))
    db.executescript("""
        CREATE TABLE IF NOT EXISTS partidas (id TEXT PRIMARY KEY, guardada INT DEFAULT 0);
        CREATE TABLE IF NOT EXISTS jugadores (puuid TEXT PRIMARY KEY, visto INT DEFAULT 0);
        CREATE INDEX IF NOT EXISTS ix_j ON jugadores(visto);
    """)
    db.commit()
    return db


def ruta_partida(out, mid):
    # Un nivel de subcarpetas: 100k ficheros en un solo directorio hace lento
    # hasta un `dir` en Windows.
    sub = os.path.join(out, "partidas", mid[-2:])
    os.makedirs(sub, exist_ok=True)
    return os.path.join(sub, f"{mid}.json.gz")


def sembrar(api, db, por_division):
    """Mete puuids de todos los rangos, para que el corpus no sea de un solo elo."""
    ya = db.execute("SELECT COUNT(*) FROM jugadores").fetchone()[0]
    if ya > 0:
        log(f"semilla ya puesta ({ya} jugadores)")
        return
    for tier in TIERS:
        # Master y por encima no tienen divisiones reales: todo cae en I.
        divs = ["I"] if tier in ("MASTER", "GRANDMASTER", "CHALLENGER") else DIVISIONES
        for div in divs:
            puuids = api.puuids_por_rango(tier, div, 1)[:por_division]
            db.executemany("INSERT OR IGNORE INTO jugadores(puuid) VALUES (?)",
                           [(p,) for p in puuids])
            db.commit()
            log(f"  semilla {tier} {div}: {len(puuids)} jugadores")
    total = db.execute("SELECT COUNT(*) FROM jugadores").fetchone()[0]
    log(f"semilla lista: {total} jugadores de {len(TIERS)} rangos")


def guardar(out, mid, partida, timeline):
    with gzip.open(ruta_partida(out, mid), "wt", encoding="utf-8", compresslevel=6) as f:
        json.dump({"match": json.loads(partida), "timeline": json.loads(timeline)}, f)


def rastrear(api, db, out, objetivo):
    guardadas = db.execute("SELECT COUNT(*) FROM partidas WHERE guardada=1").fetchone()[0]
    log(f"arrancando en {guardadas}/{objetivo} partidas")
    t0, base = time.time(), guardadas

    while guardadas < objetivo:
        fila = db.execute("SELECT puuid FROM jugadores WHERE visto=0 LIMIT 1").fetchone()
        if not fila:
            log("sin jugadores por explorar; se acabó la frontera")
            return
        puuid = fila[0]
        db.execute("UPDATE jugadores SET visto=1 WHERE puuid=?", (puuid,))

        for mid in api.partidas_de(puuid):
            if db.execute("SELECT 1 FROM partidas WHERE id=?", (mid,)).fetchone():
                continue
            db.execute("INSERT OR IGNORE INTO partidas(id) VALUES (?)", (mid,))
            partida = api.partida(mid)
            if not partida:
                continue
            info = json.loads(partida)["info"]
            # Fuera remakes y modos que no son Grieta clasificatoria.
            if info.get("queueId") != QUEUE_SOLO or info.get("gameDuration", 0) < 600:
                continue
            timeline = api.timeline(mid)
            if not timeline:
                continue
            guardar(out, mid, partida, timeline)
            db.execute("UPDATE partidas SET guardada=1 WHERE id=?", (mid,))
            guardadas += 1

            # Los participantes alimentan la frontera: así la muestra se abre
            # sola más allá del rango sembrado.
            db.executemany("INSERT OR IGNORE INTO jugadores(puuid) VALUES (?)",
                           [(p["puuid"],) for p in info["participants"]])

            if guardadas % 25 == 0:
                db.commit()
                mins = (time.time() - t0) / 60
                ritmo = (guardadas - base) / mins if mins > 0 else 0
                queda = (objetivo - guardadas) / ritmo / 60 if ritmo > 0 else 0
                log(f"{guardadas}/{objetivo} partidas | {ritmo:.0f}/min "
                    f"| faltan ~{queda:.1f} h | {api.peticiones} peticiones")
            if guardadas >= objetivo:
                break
        db.commit()
    log(f"objetivo alcanzado: {guardadas} partidas")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", default=os.environ.get("RIOT_KEY", ""))
    ap.add_argument("--out", default="D:/lol-corpus")
    ap.add_argument("--target", type=int, default=100_000)
    ap.add_argument("--plataforma", default="la1", help="la1, na1, euw1…")
    ap.add_argument("--region", default="americas", help="americas, europe, asia")
    ap.add_argument("--por-division", type=int, default=40)
    ap.add_argument("--dias", type=int, default=30,
                    help="sólo partidas de los últimos N días (0 = sin límite)")
    ap.add_argument("--margen", type=float, default=0.2,
                    help="fracción de cuota que se deja libre para la app")
    a = ap.parse_args()
    if not a.key:
        raise SystemExit("Falta --key (o la variable RIOT_KEY)")

    desde = int(time.time() - a.dias * 86400) if a.dias else 0
    if desde:
        log(f"sólo partidas desde {time.strftime('%Y-%m-%d', time.localtime(desde))}")
    api = Api(a.key, a.plataforma, a.region, a.margen, desde)
    db = abrir_estado(a.out)
    try:
        sembrar(api, db, a.por_division)
        rastrear(api, db, a.out, a.target)
    except KeyboardInterrupt:
        log("interrumpido; el estado queda guardado, relánzalo igual para seguir")
    finally:
        db.commit()
        db.close()


if __name__ == "__main__":
    main()
