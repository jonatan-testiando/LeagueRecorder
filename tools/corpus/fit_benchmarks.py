"""Baremos de población: "la media de tu rango en tu puesto".

Hasta ahora la app sólo sabía comparar al jugador consigo mismo o con los otros
nueve de su lobby. Las dos comparaciones son pobres: la primera no dice si vas
bien o mal en términos absolutos, y la segunda depende de si te tocó un lobby
flojo. Lo que el jugador quiere saber es **"un jungla de mi rango hace 6,2 de CS
por minuto; yo hago 4,8"**, y eso sólo sale de un corpus grande.

Este script recorre el corpus y saca, para cada celda (tramo de rango x puesto)
y también para cada puesto entero, los nueve deciles de 17 métricas por partida.
Imprime una tabla de Rust lista para pegar en `src-tauri/src/benchmarks.rs`,
igual que `fit_winprob.py` imprime coeficientes: ajustar es offline, puntuar
tiene que correr dentro de la app.

Los tramos son los de `fetch_tiers.py`, que es la fuente de la verdad:
bajo = Hierro..Plata, medio = Oro..Esmeralda, alto = Diamante en adelante.

    python tools/corpus/fit_benchmarks.py --corpus D:/lol-corpus
"""
import argparse
import array
import glob
import gzip
import json
import multiprocessing
import os
import time

ROLES = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]
TRAMOS = ["bajo", "medio", "alto"]

# Las 17 métricas, en el orden en que se emiten a Rust. El orden importa: la
# tabla generada y el `const` de Rust se leen en paralelo.
METRICAS = [
    "cs_per_min",
    "kill_participation",
    "deaths_per_game",
    "kda",
    "gold_per_min",
    "damage_per_min",
    "damage_share",
    "vision_score_per_min",
    "wards_per_min",
    "control_wards",
    "gold_diff_15",
    "xp_diff_15",
    "cs_diff_15",
    "solo_kills",
    "turret_damage_per_min",
    "kills_per_game",
    "assists_per_game",
]

# Partidas más cortas que esto no cuentan para nada por partida: un remake
# (< 300 s) no tiene estadísticas, y una rendición temprana (< 900 s) las tiene
# a medias — nadie llega a minuto 15, así que los diffs no existen y las tasas
# por minuto salen infladas por la fase de líneas.
MIN_DURACION = 900

# Muestra mínima para publicar una celda. Por debajo, los deciles son ruido.
MIN_MUESTRA = 200


def es_nan(x):
    return x != x


def frame_15(frames):
    """El frame de minuto 15, elegido igual que `riot_api.rs`.

    Se busca por marca de tiempo y no por índice porque la timeline puede tener
    huecos; el rango 870-930 s es el mismo que usa la app para `gold_diff_15`,
    y conviene que el baremo y el número que se compara contra él salgan del
    mismo sitio.
    """
    for f in frames:
        t = f.get("timestamp", 0)
        if 870_000 <= t <= 930_000:
            return f
    if len(frames) > 15:
        return frames[15]
    return None


def metricas_de_partida(d):
    """Devuelve [(rol, [17 valores o None])] para los 10 participantes."""
    info = d["match"]["info"]
    dur = info.get("gameDuration", 0)
    if dur < MIN_DURACION:
        return []
    minutos = dur / 60.0
    ps = info["participants"]
    if len(ps) != 10:
        return []

    # Daño a campeones por equipo, para el reparto (`damage_share`).
    dano_equipo = {100: 0.0, 200: 0.0}
    for p in ps:
        dano_equipo[p.get("teamId", 100)] = dano_equipo.get(p.get("teamId", 100), 0.0) + float(
            p.get("totalDamageDealtToChampions", 0))

    # Rival de línea: el mismo `teamPosition` en el otro equipo.
    por_puesto = {}
    for i, p in enumerate(ps):
        por_puesto.setdefault((p.get("teamPosition", ""), p.get("teamId", 0)), []).append(i)

    fr = frame_15(d["timeline"]["info"]["frames"])
    pf = fr["participantFrames"] if fr else {}

    out = []
    for i, p in enumerate(ps):
        rol = p.get("teamPosition", "")
        if rol not in ROLES:
            continue
        ch = p.get("challenges") or {}
        equipo = p.get("teamId", 100)
        rival = por_puesto.get((rol, 200 if equipo == 100 else 100), [])
        # Sólo hay diff si el emparejamiento es 1 a 1: en partidas con roles
        # repetidos (autofill raro, `teamPosition` vacío en el rival) no se
        # sabe contra quién comparar y la métrica se deja sin valor.
        rival = rival[0] if len(rival) == 1 else None

        gd = xd = cd = None
        if rival is not None and pf:
            a = pf.get(str(i + 1))
            b = pf.get(str(rival + 1))
            if a and b:
                gd = float(a["totalGold"] - b["totalGold"])
                xd = float(a["xp"] - b["xp"])
                cd = float((a["minionsKilled"] + a["jungleMinionsKilled"])
                           - (b["minionsKilled"] + b["jungleMinionsKilled"]))

        cs = p.get("totalMinionsKilled", 0) + p.get("neutralMinionsKilled", 0)
        muertes = p.get("deaths", 0)
        kp = ch.get("killParticipation")
        dano = float(p.get("totalDamageDealtToChampions", 0))
        total_eq = dano_equipo.get(equipo, 0.0)

        vals = [
            cs / minutos,
            None if kp is None or es_nan(kp) else float(kp),
            float(muertes),
            (p.get("kills", 0) + p.get("assists", 0)) / max(1.0, float(muertes)),
            p.get("goldEarned", 0) / minutos,
            dano / minutos,
            None if total_eq <= 0 else dano / total_eq,
            p.get("visionScore", 0) / minutos,
            p.get("wardsPlaced", 0) / minutos,
            float(ch.get("controlWardsPlaced", 0)),
            gd,
            xd,
            cd,
            float(ch.get("soloKills", 0)),
            p.get("damageDealtToTurrets", 0) / minutos,
            float(p.get("kills", 0)),
            float(p.get("assists", 0)),
        ]
        out.append((rol, vals))
    return out


def procesar_lote(args):
    """Un subdirectorio del corpus. Devuelve {(tramo, rol, metrica): array('d')}."""
    carpeta, tramos = args
    acc = {}
    n = 0
    for gz in glob.iglob(os.path.join(carpeta, "*.json.gz")):
        mid = os.path.basename(gz)[:-len(".json.gz")]
        try:
            with gzip.open(gz, "rt", encoding="utf-8") as f:
                d = json.load(f)
        except (EOFError, OSError, ValueError, KeyError):
            continue  # el rastreador puede estar escribiéndolo ahora mismo
        try:
            filas = metricas_de_partida(d)
        except (KeyError, TypeError, ZeroDivisionError):
            continue
        if not filas:
            continue
        n += 1
        tramo = tramos.get(mid)
        if tramo == "sin":
            tramo = None
        for rol, vals in filas:
            for m, v in zip(METRICAS, vals):
                if v is None:
                    continue
                # La fila "todos los rangos" incluye TAMBIÉN las partidas sin
                # etiquetar: es el reparto del corpus entero y es el que se usa
                # cuando no se conoce el rango de la partida.
                acc.setdefault(("", rol, m), array.array("d")).append(v)
                if tramo:
                    acc.setdefault((tramo, rol, m), array.array("d")).append(v)
    return n, acc


def deciles(v):
    """Los nueve cortes del 10% al 90%.

    Índice `floor(n*q/10)` sobre la lista ordenada, sin interpolar: es el mismo
    criterio que `baselines.rs`, y hace falta que Rust pueda reproducir el
    número exacto en su prueba contra el corpus.
    """
    v = sorted(v)
    n = len(v)
    return [v[int(n * q / 10.0)] for q in range(1, 10)]


def fmt(x):
    return f"{x:.4f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="D:/lol-corpus")
    ap.add_argument("--procesos", type=int, default=max(1, (os.cpu_count() or 4) - 1))
    a = ap.parse_args()

    with open(os.path.join(a.corpus, "tiers.json"), encoding="utf-8") as f:
        tramos = json.load(f)
    print(f"tiers.json: {len(tramos)} partidas etiquetadas", flush=True)

    carpetas = sorted(d for d in glob.glob(os.path.join(a.corpus, "partidas", "*"))
                      if os.path.isdir(d))
    print(f"{len(carpetas)} carpetas, {a.procesos} procesos", flush=True)

    t0 = time.time()
    total = 0
    datos = {}
    with multiprocessing.Pool(a.procesos) as pool:
        tareas = [(c, tramos) for c in carpetas]
        for k, (n, acc) in enumerate(pool.imap_unordered(procesar_lote, tareas)):
            total += n
            for clave, arr in acc.items():
                datos.setdefault(clave, array.array("d")).extend(arr)
            if (k + 1) % 10 == 0:
                print(f"  {k+1}/{len(carpetas)} carpetas, {total} partidas "
                      f"({time.time()-t0:.0f}s)", flush=True)

    print(f"\n{total} partidas válidas (>= {MIN_DURACION}s) en {time.time()-t0:.0f}s\n")

    # --- Muestras por celda -------------------------------------------------
    print("muestras por celda (participantes; las métricas de diff tienen menos):")
    print(f"  {'':10} {'TODOS':>9} " + " ".join(f"{t:>9}" for t in TRAMOS))
    for rol in ROLES:
        fila = [len(datos.get((t, rol, "cs_per_min"), ())) for t in [""] + TRAMOS]
        print(f"  {rol:10} " + " ".join(f"{n:>9}" for n in fila))
    print()
    print("  cobertura de las métricas de minuto 15 (rival de línea identificado):")
    for rol in ROLES:
        a_ = len(datos.get(("", rol, "cs_per_min"), ()))
        b_ = len(datos.get(("", rol, "gold_diff_15"), ()))
        print(f"    {rol:10} {b_}/{a_}  ({100.0*b_/max(1,a_):.1f}%)")

    # --- Tabla para Rust ----------------------------------------------------
    print("\n\n// ---- pegar en src-tauri/src/benchmarks.rs ----\n")
    print("/// (métrica, rol, deciles 10%..90%) sobre el corpus entero.")
    print("const DECILES_POR_ROL: &[(&str, &str, [f64; 9])] = &[")
    for m in METRICAS:
        for rol in ROLES:
            v = datos.get(("", rol, m))
            if not v or len(v) < MIN_MUESTRA:
                print(f"    // {m}/{rol}: sólo {len(v or ())} muestras, se omite")
                continue
            d = deciles(v)
            print(f'    ("{m}", "{rol}", [{", ".join(fmt(x) for x in d)}]),'
                  f"   // n={len(v)}")
    print("];")

    print("\n/// (métrica, tramo, rol, deciles 10%..90%).")
    print("const DECILES_POR_TRAMO: &[(&str, &str, &str, [f64; 9])] = &[")
    for m in METRICAS:
        for tramo in TRAMOS:
            for rol in ROLES:
                v = datos.get((tramo, rol, m))
                if not v or len(v) < MIN_MUESTRA:
                    print(f"    // {m}/{tramo}/{rol}: sólo {len(v or ())} muestras, se omite")
                    continue
                d = deciles(v)
                print(f'    ("{m}", "{tramo}", "{rol}", [{", ".join(fmt(x) for x in d)}]),'
                      f"   // n={len(v)}")
    print("];")

    # --- Medianas, para leerlas de un vistazo -------------------------------
    print("\n\nmedianas por tramo (bajo / medio / alto) y rol:")
    for m in METRICAS:
        print(f"\n  {m}")
        for rol in ROLES:
            trozos = []
            for t in [""] + TRAMOS:
                v = datos.get((t, rol, m))
                trozos.append("     -" if not v or len(v) < MIN_MUESTRA
                              else f"{deciles(v)[4]:9.3f}")
            print(f"    {rol:10} todos={trozos[0]}  " + "  ".join(trozos[1:]))


if __name__ == "__main__":
    main()
