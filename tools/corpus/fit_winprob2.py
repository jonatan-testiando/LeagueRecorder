"""Ajusta P(victoria | estado) sobre el corpus completo. Versión con numpy.

Reemplaza a `fit_winprob.py`, que se escribió en Python puro porque numpy no
estaba en el intérprete del sistema — pero sí está en el entorno de entreno. Con
9.258 partidas eso es la diferencia entre horas y segundos, y permite además
meter más variables.

## Qué cambia respecto al primer ajuste (1.400 partidas)

Variables nuevas, todas para atacar el mismo problema: **el barón salía con
coeficiente ≈0 porque su valor se lo llevaba el oro**. Si el modelo no puede
distinguir "voy 5k arriba" de "voy 5k arriba *con alma de dragón y dos
inhibidores abiertos*", todo lo que no sea oro se queda sin coeficiente.

- `alma`            : el equipo tiene el alma (4 dragones). Permanente y decisiva.
- `ancestral`       : dragón ancestral activo (2,5 min).
- `inhibs_abiertos` : inhibidores caídos **ahora**, no acumulados. Un inhibidor
  reaparece a los 5 minutos, y contar los históricos mezcla dos cosas distintas.
- `minuto2`         : la ventaja no escala linealmente con el reloj.

    .venv-train/Scripts/python.exe tools/corpus/fit_winprob2.py D:/lol-corpus
"""
import glob
import gzip
import json
import os
import sys

import numpy as np

COLUMNAS = [
    "sesgo", "minuto", "minuto2",
    "oro_dif", "oro_dif_x_minuto", "xp_dif",
    "torres_dif", "inhibs_abiertos_dif", "dragones_dif",
    "alma_dif", "ancestral", "baron_activo", "kills_dif",
]

INHIB_RESPAWN = 5.0
ELDER_DURA = 2.5
BARON_DURA = 3.0


def estados_de(d):
    """Vectores de estado por minuto, desde la óptica del equipo 100."""
    info, frames = d["match"]["info"], d["timeline"]["info"]["frames"]
    equipo = {i + 1: p["teamId"] for i, p in enumerate(info["participants"])}
    gano100 = 1.0 if info["participants"][0]["win"] else 0.0

    torres = {100: 0, 200: 0}
    dragones = {100: 0, 200: 0}
    kills = {100: 0, 200: 0}
    inhibs = {100: [], 200: []}
    baron = {100: -99.0, 200: -99.0}
    elder = {100: -99.0, 200: -99.0}
    alma = {100: 0.0, 200: 0.0}

    filas = []
    for i, fr in enumerate(frames):
        pf = fr["participantFrames"]
        try:
            oro = sum(pf[str(p)]["totalGold"] for p in range(1, 6)) - sum(
                pf[str(p)]["totalGold"] for p in range(6, 11))
            xp = sum(pf[str(p)]["xp"] for p in range(1, 6)) - sum(
                pf[str(p)]["xp"] for p in range(6, 11))
        except KeyError:
            continue
        m = i / 10.0
        abiertos = {t: sum(1 for x in inhibs[t] if i - x < INHIB_RESPAWN)
                    for t in (100, 200)}
        filas.append([
            1.0, m, m * m,
            oro / 1000.0, (oro / 1000.0) * m, xp / 1000.0,
            float(torres[100] - torres[200]),
            float(abiertos[200] - abiertos[100]),
            float(dragones[100] - dragones[200]),
            alma[100] - alma[200],
            (1.0 if i - elder[100] <= ELDER_DURA else 0.0)
            - (1.0 if i - elder[200] <= ELDER_DURA else 0.0),
            (1.0 if i - baron[100] <= BARON_DURA else 0.0)
            - (1.0 if i - baron[200] <= BARON_DURA else 0.0),
            float(kills[100] - kills[200]),
        ])

        for e in fr["events"]:
            t = e["type"]
            if t == "CHAMPION_KILL":
                eq = equipo.get(e.get("killerId"))
                if eq:
                    kills[eq] += 1
            elif t == "BUILDING_KILL":
                eq = equipo.get(e.get("killerId"))
                if not eq:
                    continue
                rival = 200 if eq == 100 else 100
                if e.get("buildingType") == "INHIBITOR_BUILDING":
                    inhibs[rival].append(i)
                else:
                    torres[eq] += 1
            elif t == "ELITE_MONSTER_KILL":
                eq = e.get("killerTeamId") or equipo.get(e.get("killerId"))
                if not eq:
                    continue
                mt = e.get("monsterType")
                if mt == "BARON_NASHOR":
                    baron[eq] = i
                elif mt == "DRAGON":
                    if e.get("monsterSubType") == "ELDER_DRAGON":
                        elder[eq] = i
                    else:
                        dragones[eq] += 1
                        if dragones[eq] >= 4:
                            alma[eq] = 1.0
            elif t == "DRAGON_SOUL_GIVEN":
                eq = e.get("teamId")
                if eq in alma:
                    alma[eq] = 1.0
    return filas, gano100


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
            continue
        filas, gano = estados_de(d)
        X.extend(filas)
        y.extend([gano] * len(filas))
        grupo.extend([n] * len(filas))
        if (n + 1) % 2000 == 0:
            print(f"  {n+1} partidas...", flush=True)
    return np.array(X), np.array(y), np.array(grupo)


def entrenar(X, y, pasos=3000, lr=0.5, l2=0.05):
    """Descenso de gradiente con las columnas estandarizadas.

    `l2` alto a propósito: con poca regularización, torres y barón salen con
    coeficiente **negativo** por colinealidad con el oro. Para predecir da
    igual, pero este modelo es para *atribuir*, y un signo cambiado convertiría
    tirar una torre en un demérito.
    """
    med, dev = X.mean(0), X.std(0)
    med[0], dev[0] = 0.0, 1.0
    dev[dev < 1e-9] = 1.0
    Z = (X - med) / dev
    w = np.zeros(Z.shape[1])
    for paso in range(pasos):
        p = 1.0 / (1.0 + np.exp(-Z @ w))
        g = Z.T @ (p - y) / len(y) + l2 * w
        w -= lr * g
        if paso % 1000 == 0:
            print(f"    paso {paso}: perdida {perdida(Z, y, w):.4f}", flush=True)
    return w, med, dev


def perdida(Z, y, w):
    p = np.clip(1.0 / (1.0 + np.exp(-Z @ w)), 1e-9, 1 - 1e-9)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def isotonica(z, y, bins=24):
    """Calibra P(victoria) con una función monótona, no con un solo factor.

    Un factor de escala sólo puede estirar o encoger la curva entera. Aquí la
    desviación tiene forma de S —el modelo dice 65% y se gana el 71%, pero en el
    centro acierta— y ninguna escala arregla eso: lo que sobra en un tramo falta
    en otro.

    La isotónica no supone forma: sólo exige que a más puntuación, más
    probabilidad. Se ajusta con PAV (pool adjacent violators), que es promediar
    los tramos que se salen del orden hasta que ninguno lo hace.

    Devuelve `bins` cortes (z, p) para interpolar. Se resume en pocos cortes a
    propósito: la tabla tiene que caber en el código de Rust y una isotónica
    cruda tiene tantos escalones como datos.
    """
    orden = np.argsort(z)
    zz, yy = z[orden], y[orden]
    # PAV sobre medias de bloques.
    val = list(yy.astype(float))
    peso = [1.0] * len(val)
    corte = list(range(len(val)))
    i = 0
    while i < len(val) - 1:
        if val[i] <= val[i + 1]:
            i += 1
            continue
        # Se funden los dos bloques que rompen el orden y se retrocede.
        v = (val[i] * peso[i] + val[i + 1] * peso[i + 1]) / (peso[i] + peso[i + 1])
        val[i:i + 2] = [v]
        peso[i:i + 2] = [peso[i] + peso[i + 1]]
        corte[i:i + 2] = [corte[i]]
        if i > 0:
            i -= 1
    # De bloques a puntos, y se resume en `bins` cortes equiespaciados en rango.
    ajust = np.empty(len(zz))
    pos = 0
    for v, w in zip(val, peso):
        ajust[pos:pos + int(w)] = v
        pos += int(w)
    idx = np.linspace(0, len(zz) - 1, bins).astype(int)
    return list(zip(zz[idx].tolist(), ajust[idx].tolist()))


def auc(p, y):
    orden = np.argsort(p)
    rangos = np.empty(len(p), float)
    rangos[orden] = np.arange(1, len(p) + 1)
    pos, neg = y.sum(), len(y) - y.sum()
    if pos == 0 or neg == 0:
        return float("nan")
    return float((rangos[y == 1].sum() - pos * (pos + 1) / 2) / (pos * neg))


def main(corpus):
    print("cargando...", flush=True)
    X, y, g = cargar(corpus)
    print(f"{len(X)} estados de {len(set(g))} partidas")

    # Separación POR PARTIDA: dos minutos de la misma comparten resultado, y
    # repartirlos entre entreno y prueba inflaría el acierto.
    corte = int(g.max() * 0.75)
    tr, te = g < corte, g >= corte
    w, med, dev = entrenar(X[tr], y[tr])

    Zte = (X[te] - med) / dev

    # --- Recalibrado por temperatura ---
    #
    # La regularizacion alta hace falta para que los signos salgan sanos (sin
    # ella, torres y baron salen negativos por colinealidad con el oro). Pero de
    # paso encoge las magnitudes, y el modelo se vuelve POCO CONFIADO: comprime
    # las probabilidades hacia el 50%.
    #
    # Para predecir da igual —el orden no cambia, el AUC tampoco— pero el WPA es
    # una DIFERENCIA de probabilidades, asi que comprimidas dan valores
    # sistematicamente pequenos. La calibracion importa mas que el acierto aqui.
    #
    # Se separan las dos cosas: L2 decide la DIRECCION de los coeficientes, y un
    # unico factor de escala ajustado aparte corrige la MAGNITUD. El factor se
    # ajusta sobre datos que el modelo no vio.
    zval = Zte @ w
    mitad = len(zval) // 2       # mitad para calibrar, mitad para medir
    def perdida_escala(a, b, sel):
        pp = np.clip(1.0 / (1.0 + np.exp(-(a * zval[sel] + b))), 1e-9, 1 - 1e-9)
        yy = y[te][sel]
        return float(-(yy * np.log(pp) + (1 - yy) * np.log(1 - pp)).mean())
    cal = np.zeros(len(zval), bool); cal[:mitad] = True
    mejor = (1.0, 0.0, perdida_escala(1.0, 0.0, cal))
    for a in np.arange(0.8, 3.01, 0.05):
        for b in np.arange(-0.3, 0.31, 0.05):
            l = perdida_escala(a, b, cal)
            if l < mejor[2]:
                mejor = (float(a), float(b), l)
    esc_a, esc_b, _ = mejor
    print("  escala de recalibrado: x%.2f %+.2f" % (esc_a, esc_b))

    medir = ~cal
    Zte, zval = Zte[medir], zval[medir]
    y_te = y[te][medir]
    pte = 1.0 / (1.0 + np.exp(-(esc_a * zval + esc_b)))
    pc = np.clip(pte, 1e-9, 1 - 1e-9)
    print("  AUC (prueba)     : %.4f" % auc(pte, y_te))
    print("  perdida (prueba) : %.4f"
          % float(-(y_te * np.log(pc) + (1 - y_te) * np.log(1 - pc)).mean()))

    print("\n  calibracion:")
    for lo in range(0, 100, 10):
        sel = (pte >= lo / 100) & (pte < (lo + 10) / 100)
        if sel.sum() < 50:
            continue
        dice = 100 * pte[sel].mean()
        gana = 100 * y_te[sel].mean()
        print(f"    dice {dice:5.1f}%  ->  gana {gana:5.1f}%   (n={sel.sum()})")

    # --- Calibrado isotonico ---
    #
    # El factor unico de arriba solo puede estirar o encoger la curva entera, y
    # la desviacion que queda tiene forma de S: en el centro acierta, pero dice
    # 64,7% y se gana el 70,7%, y dice 85% y se gana el 83%. Ninguna escala
    # arregla eso, porque lo que sobra en un tramo falta en otro.
    #
    # La isotonica no supone forma, solo que a mas puntuacion mas probabilidad.
    #
    # Se ajusta en una mitad y se comprueba en la otra. Ajustar y medir sobre los
    # mismos datos daria una tabla que se calibra a si misma: con 24 escalones
    # sobre 38.000 puntos el sobreajuste es pequeno, pero "pequeno" no es "cero"
    # y la fiabilidad es justo lo que se esta midiendo.
    # La tabla se indexa por la puntuacion **que calcula Rust**, que ya lleva la
    # escala dentro (los coeficientes se multiplican por `esc_a` mas abajo y el
    # sesgo absorbe `esc_b`). Indexarla por `zval` crudo daria una tabla en otras
    # unidades y la calibracion seria ruido.
    zr = esc_a * zval + esc_b
    mitad = np.zeros(len(zr), bool)
    mitad[::2] = True
    tabla_val = isotonica(zr[mitad], y_te[mitad])
    zi = np.array([t[0] for t in tabla_val])
    pi = np.array([t[1] for t in tabla_val])
    p_iso = np.interp(zr[~mitad], zi, pi)
    y_te_iso = y_te[~mitad]
    pte_iso = pte[~mitad]

    # La tabla que se publica usa las dos mitades: ya se sabe que generaliza, y
    # con el doble de datos los escalones quedan mejor puestos.
    tabla = isotonica(zr, y_te)
    print("  desvio medio de calibracion (fuera de muestra):")
    def desvio(p, y):
        d, n = 0.0, 0
        for lo in range(0, 100, 5):
            sel = (p >= lo / 100) & (p < (lo + 5) / 100)
            if sel.sum() < 50:
                continue
            d += sel.sum() * abs(p[sel].mean() - y[sel].mean())
            n += sel.sum()
        return 100 * d / max(1, n)
    print("    escala unica %.2f puntos  ->  isotonica %.2f puntos"
          % (desvio(pte_iso, y_te_iso), desvio(p_iso, y_te_iso)))
    print("  calibracion tras la isotonica (fuera de muestra):")
    for lo in range(0, 100, 10):
        sel = (p_iso >= lo / 100) & (p_iso < (lo + 10) / 100)
        if sel.sum() < 50:
            continue
        print(f"    dice {100*p_iso[sel].mean():5.1f}%  ->  gana {100*y_te_iso[sel].mean():5.1f}%   (n={sel.sum()})")
    print("")
    print("  tabla isotonica (para Rust):")
    print("pub const CALIBRACION: [(f64, f64); %d] = [" % len(tabla))
    for zz, pp in tabla:
        print("    (%.5f, %.5f)," % (zz, pp))
    print("];")

    print("\n  coeficientes (escala original, para Rust):")
    # Los coeficientes ya llevan la escala dentro, para que Rust no tenga que
    # aplicarla aparte.
    w = w * esc_a
    sesgo = w[0] + esc_b - float((w[1:] * med[1:] / dev[1:]).sum())
    print(f"    SESGO                  {sesgo:10.5f}")
    for nombre, wi, s in zip(COLUMNAS[1:], w[1:], dev[1:]):
        print(f"    {nombre.upper():22} {wi/s:10.5f}")


if __name__ == "__main__":
    main(sys.argv[1])
