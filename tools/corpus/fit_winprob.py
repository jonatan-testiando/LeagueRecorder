"""Ajusta P(victoria | estado de la partida) sobre el corpus.

Es la pieza que convierte todo lo demás a una moneda común. Hasta ahora el valor
se medía en oro, que no sabe cotizar aguantar daño, poner visión ni atraer a
cuatro rivales. La probabilidad de victoria sí: todo lo que la mueve vale, y lo
que no la mueve no.

La etiqueta es gratis —quién ganó— así que no hace falta anotar nada a mano.
Y ese es justamente el motivo de elegir este camino: **no existe una etiqueta de
MVP en la API de Riot**, pero sí existe el resultado de cada partida.

Modelo: regresión logística desde el punto de vista del equipo 100, con el
estado tomado en cada minuto. Se entrena en Python y los coeficientes se llevan
a Rust, igual que se hizo con los pesos de objetivos: entrenar es offline y
puntuar tiene que correr dentro de la app.

    python fit_winprob.py D:/lol-corpus
"""
import glob
import gzip
import json
import math
import os
import sys

# Nombres de las columnas, en el mismo orden que las construye `estado`.
COLUMNAS = [
    "sesgo",
    "minuto",
    "oro_dif",           # en miles, equipo 100 menos equipo 200
    "oro_dif_x_minuto",  # una ventaja vale más cuanto más tarde
    "xp_dif",
    "torres_dif",
    "inhibs_dif",
    "dragones_dif",
    "baron_activo",      # barón tomado en los últimos 3 minutos
    "kills_dif",
]


def sigmoide(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    e = math.exp(z)
    return e / (1.0 + e)


def estados(frames, eventos_por_minuto):
    """Un vector de estado por minuto, desde la óptica del equipo 100."""
    torres = inhibs = dragones = kills = 0
    baron_min = -99
    for i, fr in enumerate(frames):
        pf = fr["participantFrames"]
        try:
            oro = sum(pf[str(p)]["totalGold"] for p in range(1, 6)) - sum(
                pf[str(p)]["totalGold"] for p in range(6, 11))
            xp = sum(pf[str(p)]["xp"] for p in range(1, 6)) - sum(
                pf[str(p)]["xp"] for p in range(6, 11))
        except KeyError:
            continue

        yield [
            1.0,
            i / 10.0,
            oro / 1000.0,
            (oro / 1000.0) * (i / 10.0),
            xp / 1000.0,
            float(torres),
            float(inhibs),
            float(dragones),
            1.0 if i - baron_min <= 3 else 0.0,
            float(kills),
        ]

        # El estado del minuto siguiente incorpora lo ocurrido en éste.
        for e, signo in eventos_por_minuto.get(i, ()):
            if e == "torre":
                torres += signo
            elif e == "inhib":
                inhibs += signo
            elif e == "dragon":
                dragones += signo
            elif e == "baron" and signo > 0:
                baron_min = i
            elif e == "baron":
                baron_min = -99 if baron_min == i else baron_min
            elif e == "kill":
                kills += signo


def eventos(frames, equipo_de):
    """Eventos agrupados por minuto, con signo +1 si los hizo el equipo 100."""
    out = {}
    for i, fr in enumerate(frames):
        lista = []
        for e in fr["events"]:
            t = e["type"]
            if t == "CHAMPION_KILL":
                eq = equipo_de.get(e.get("killerId"))
                if eq:
                    lista.append(("kill", 1 if eq == 100 else -1))
            elif t == "BUILDING_KILL":
                eq = equipo_de.get(e.get("killerId"))
                if not eq:
                    continue
                s = 1 if eq == 100 else -1
                lista.append(("inhib" if e.get("buildingType") == "INHIBITOR_BUILDING"
                              else "torre", s))
            elif t == "ELITE_MONSTER_KILL":
                eq = e.get("killerTeamId") or equipo_de.get(e.get("killerId"))
                if not eq:
                    continue
                s = 1 if eq == 100 else -1
                m = e.get("monsterType")
                if m == "DRAGON":
                    lista.append(("dragon", s))
                elif m == "BARON_NASHOR":
                    lista.append(("baron", s))
        if lista:
            out[i] = lista
    return out


def cargar(corpus, limite=None):
    X, y, grupo = [], [], []
    ficheros = sorted(glob.iglob(os.path.join(corpus, "partidas", "*", "*.json.gz")))
    for n, gz in enumerate(ficheros):
        if limite and n >= limite:
            break
        try:
            with gzip.open(gz, "rt", encoding="utf-8") as f:
                d = json.load(f)
        except (EOFError, OSError, ValueError):
            continue  # el rastreador puede estar escribiéndolo ahora mismo
        info, frames = d["match"]["info"], d["timeline"]["info"]["frames"]
        equipo_de = {i + 1: p["teamId"] for i, p in enumerate(info["participants"])}
        gano100 = 1.0 if info["participants"][0]["win"] else 0.0
        evs = eventos(frames, equipo_de)
        for v in estados(frames, evs):
            X.append(v)
            y.append(gano100)
            grupo.append(n)
    return X, y, grupo


def entrenar(X, y, pasos=400, lr=0.35, l2=0.05):
    """Descenso de gradiente. Sin numpy: no está instalado y no merece la pena
    añadir una dependencia para un ajuste que corre una vez.

    `l2 = 0.05` está fijado por medición, y es alto a propósito. Con
    regularización débil el modelo predice igual de bien pero los coeficientes
    salen **con el signo cambiado**: torres −0,057 y barón −0,165, o sea que
    tirar torres y tener barón te harían perder. Es colinealidad — `oro_dif` ya
    contiene el valor de todo eso, y las demás columnas acaban absorbiendo
    residuos.

    Para predecir da igual, pero este modelo no es para predecir: es para
    **atribuir**. El WPA de un evento es la diferencia de probabilidad que
    provoca, así que un coeficiente con el signo cambiado convertiría tirar una
    torre en un demérito. Con L2 = 0,05 todos los signos quedan sanos y el AUC
    incluso sube un poco (0,7967 frente a 0,7958)."""
    n, d = len(X), len(X[0])
    # Estandarizar acelera muchísimo la convergencia con features de escalas
    # tan distintas (minuto vs oro en miles vs contadores).
    med = [sum(r[j] for r in X) / n for j in range(d)]
    dev = [max(1e-9, (sum((r[j] - med[j]) ** 2 for r in X) / n) ** 0.5) for j in range(d)]
    med[0], dev[0] = 0.0, 1.0  # el sesgo se deja tal cual
    Z = [[(r[j] - med[j]) / dev[j] for j in range(d)] for r in X]

    w = [0.0] * d
    for paso in range(pasos):
        g = [0.0] * d
        for r, obj in zip(Z, y):
            err = sigmoide(sum(wi * ri for wi, ri in zip(w, r))) - obj
            for j in range(d):
                g[j] += err * r[j]
        for j in range(d):
            w[j] = w[j] - lr * (g[j] / n + l2 * w[j])
        if paso % 100 == 0:
            print(f"    paso {paso}: perdida {perdida(Z, y, w):.4f}", flush=True)
    return w, med, dev


def perdida(Z, y, w):
    s = 0.0
    for r, obj in zip(Z, y):
        p = min(max(sigmoide(sum(wi * ri for wi, ri in zip(w, r))), 1e-9), 1 - 1e-9)
        s -= obj * math.log(p) + (1 - obj) * math.log(1 - p)
    return s / len(y)


def auc(probs, y):
    pares = sorted(zip(probs, y))
    rango, i = {}, 0
    while i < len(pares):
        j = i
        while j + 1 < len(pares) and pares[j + 1][0] == pares[i][0]:
            j += 1
        r = (i + j) / 2.0 + 1
        for k in range(i, j + 1):
            rango[k] = r
        i = j + 1
    pos = sum(1 for _, t in pares if t == 1)
    neg = len(pares) - pos
    if pos == 0 or neg == 0:
        return float("nan")
    suma = sum(rango[k] for k, (_, t) in enumerate(pares) if t == 1)
    return (suma - pos * (pos + 1) / 2) / (pos * neg)


def main(corpus):
    print("cargando corpus…", flush=True)
    X, y, grupo = cargar(corpus)
    partidas = len(set(grupo))
    print(f"{len(X)} estados de {partidas} partidas\n")

    # Separación POR PARTIDA, no por estado: dos minutos de la misma partida
    # comparten resultado, y mezclarlos entre entreno y prueba inflaría el
    # acierto sin que el modelo hubiera aprendido nada.
    corte = int(partidas * 0.75)
    tr = [i for i, g in enumerate(grupo) if g < corte]
    te = [i for i, g in enumerate(grupo) if g >= corte]
    Xtr, ytr = [X[i] for i in tr], [y[i] for i in tr]
    Xte, yte = [X[i] for i in te], [y[i] for i in te]
    print(f"entreno {len(Xtr)} estados / prueba {len(Xte)} estados", flush=True)

    w, med, dev = entrenar(Xtr, ytr)

    def prob(r):
        z = sum(wi * ((v - m) / s) for wi, v, m, s in zip(w, r, med, dev))
        return sigmoide(z)

    pte = [prob(r) for r in Xte]
    print(f"\n  AUC (prueba)     : {auc(pte, yte):.4f}")
    Zte = [[(r[j] - med[j]) / dev[j] for j in range(len(r))] for r in Xte]
    print(f"  pérdida (prueba) : {perdida(Zte, yte, w):.4f}")
    print(f"  (una moneda al aire daría AUC 0.5 y pérdida 0.693)")

    print("\n  calibración — de cada 10 veces que dice X%, ¿gana X%?")
    for lo in range(0, 100, 10):
        hi = lo + 10
        sel = [(p, t) for p, t in zip(pte, yte) if lo / 100 <= p < hi / 100]
        if len(sel) < 30:
            continue
        real = 100 * sum(t for _, t in sel) / len(sel)
        pred = 100 * sum(p for p, _ in sel) / len(sel)
        print(f"    dice {pred:5.1f}%  ->  gana {real:5.1f}%   (n={len(sel)})")

    print("\n  acierto por minuto de partida:")
    for lo, hi in ((0, 10), (10, 20), (20, 30), (30, 99)):
        sel = [(p, t) for r, p, t in zip(Xte, pte, yte) if lo <= r[1] * 10 < hi]
        if len(sel) < 50:
            continue
        print(f"    min {lo:2}-{hi:2}: AUC {auc([p for p, _ in sel], [t for _, t in sel]):.3f}"
              f"  (n={len(sel)})")

    # Coeficientes en la escala original, listos para llevarlos a Rust.
    print("\n  coeficientes (escala original, para Rust):")
    sesgo = w[0] - sum(wi * m / s for wi, m, s in list(zip(w, med, dev))[1:])
    print(f"    {'sesgo':20} {sesgo:10.5f}")
    for nombre, wi, m, s in list(zip(COLUMNAS, w, med, dev))[1:]:
        print(f"    {nombre:20} {wi / s:10.5f}")


if __name__ == "__main__":
    main(sys.argv[1])
