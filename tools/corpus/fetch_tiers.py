"""Etiqueta cada partida del corpus con el rango en que se jugó.

Hace falta para la otra mitad de "un MVP justo": el rol ya está normalizado, pero
un MVP en Hierro no es un MVP en Máster y ahora mismo se comparan igual.

**Una petición por partida, no diez.** El emparejamiento de clasificatoria junta
rangos parecidos, así que el rango de un participante etiqueta la partida entera.
Pedir los diez costaría 30 horas de cuota para ganar precisión que se pierde de
todos modos al agrupar en tramos.

Va despacio a propósito: comparte la clave con el rastreador del corpus y con la
app del usuario. Es reanudable, así que puede correr días sin vigilancia.

    python fetch_tiers.py --key RGAPI-... --out D:/lol-corpus
"""
import argparse
import glob
import gzip
import json
import os
import sqlite3
import time
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# Tramos de rango. Se agrupa en tres y no en diez porque cada celda del baremo
# es (tramo x rol): con diez tramos harían falta 50 celdas con muestra
# suficiente, y el corpus no da para eso todavía.
TRAMOS = {
    "IRON": "bajo", "BRONZE": "bajo", "SILVER": "bajo",
    "GOLD": "medio", "PLATINUM": "medio", "EMERALD": "medio",
    "DIAMOND": "alto", "MASTER": "alto", "GRANDMASTER": "alto", "CHALLENGER": "alto",
}


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def abrir(out):
    db = sqlite3.connect(os.path.join(out, "tiers.db"))
    db.execute("""CREATE TABLE IF NOT EXISTS partidas (
                    id TEXT PRIMARY KEY, tier TEXT, tramo TEXT)""")
    db.commit()
    return db


def pedir(key, plataforma, puuid, espera):
    url = (f"https://{plataforma}.api.riotgames.com"
           f"/lol/league/v4/entries/by-puuid/{puuid}")
    for intento in range(5):
        time.sleep(espera)
        req = urllib.request.Request(url, headers={"X-Riot-Token": key, "User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                for e in json.load(r):
                    if e.get("queueType") == "RANKED_SOLO_5x5":
                        return e.get("tier")
                return "SIN_RANGO"
        except urllib.error.HTTPError as e:
            if e.code == 429:
                s = int(e.headers.get("Retry-After", 0)) or 30
                log(f"  429, esperando {s}s")
                time.sleep(s)
                continue
            if e.code in (500, 502, 503, 504):
                time.sleep(2 ** intento)
                continue
            if e.code == 404:
                return "SIN_RANGO"
            if e.code in (401, 403):
                raise SystemExit(f"Clave rechazada ({e.code})")
            return None
        except (urllib.error.URLError, TimeoutError):
            time.sleep(2 ** intento)
    return None


def volcar(db, out):
    """Vuelca `id -> tramo` a JSON plano.

    Rust lee de aquí para calcular los baremos por rango. La alternativa era
    meter una dependencia de SQLite en el crate sólo para las pruebas, que no
    compensa por un diccionario de cadenas.
    """
    datos = {i: t for i, t in db.execute("SELECT id, tramo FROM partidas")}
    tmp = os.path.join(out, "tiers.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(datos, f)
    os.replace(tmp, os.path.join(out, "tiers.json"))  # atómico: Rust puede estar leyendo


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", default=os.environ.get("RIOT_KEY", ""))
    ap.add_argument("--out", default="D:/lol-corpus")
    ap.add_argument("--plataforma", default="la1")
    ap.add_argument("--por-minuto", type=float, default=8.0,
                    help="ritmo; bajo a propósito, la cuota se comparte")
    a = ap.parse_args()
    if not a.key:
        raise SystemExit("Falta --key")
    espera = 60.0 / a.por_minuto

    db = abrir(a.out)
    hechas = {r[0] for r in db.execute("SELECT id FROM partidas")}
    log(f"ya etiquetadas: {len(hechas)}")

    pendientes = []
    for gz in glob.iglob(os.path.join(a.out, "partidas", "*", "*.json.gz")):
        mid = os.path.basename(gz).replace(".json.gz", "")
        if mid not in hechas:
            pendientes.append((mid, gz))
    log(f"pendientes: {len(pendientes)}  (~{len(pendientes)/a.por_minuto/60:.1f} h)")

    n = 0
    for mid, gz in pendientes:
        try:
            with gzip.open(gz, "rt", encoding="utf-8") as f:
                ps = json.load(f)["match"]["info"]["participants"]
        except (EOFError, OSError, ValueError):
            continue
        tier = pedir(a.key, a.plataforma, ps[0]["puuid"], espera)
        if tier is None:
            continue
        db.execute("INSERT OR REPLACE INTO partidas(id, tier, tramo) VALUES (?,?,?)",
                   (mid, tier, TRAMOS.get(tier, "sin")))
        n += 1
        if n % 25 == 0:
            db.commit()
            volcar(db, a.out)
            reparto = dict(db.execute(
                "SELECT tramo, COUNT(*) FROM partidas GROUP BY tramo").fetchall())
            log(f"{n}/{len(pendientes)}  reparto: {reparto}")
    db.commit()
    volcar(db, a.out)
    db.close()
    log(f"terminado: {n} partidas etiquetadas")


if __name__ == "__main__":
    main()
