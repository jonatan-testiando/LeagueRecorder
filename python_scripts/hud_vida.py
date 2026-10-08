"""Lee del HUD de una partida grabada tu vida y los efectos que te ponen.

Dos cosas, ocho veces por segundo:

  - **Tu vida**, como fracción de la barra verde de abajo. Es el único sitio del
    que sale CADA golpe que te comes con su instante: la API de Riot sólo
    desglosa el daño en los eventos de muerte (muestra, no censo) y sin
    instante propio. Medido contra el número que pinta el propio HUD
    ("737 / 1298"): ±15 de vida, en 1080p y en 1440p.
  - **Qué te los puso**, cuando se puede decir. Al enraizarte la E de LeBlanc,
    su icono aparece con borde rojo en tu fila de efectos, encima de las
    habilidades. Se compara con los iconos de los cinco rivales
    (CommunityDragon, `hud/icons2d`). Sólo se apuntan los parecidos claros:
    en las pruebas la E de LeBlanc da 0,66-0,78, la W de Varus 0,62, y lo que
    no es de un campeón (objetos, runas, torres) se queda por debajo de 0,55.
    Que no salga nada NO quiere decir que no te dieran nada.

El HUD escala con el ALTO de la pantalla y va centrado abajo, así que las
posiciones se dan en fracciones del alto respecto al centro (medidas en 1440p y
comprobadas en 1080p). Con otra escala de HUD en el juego la barra no se
encuentra y `hud_ok` sale bajo: quien lee el fichero lo trata como "no hay HUD
legible" en vez de inventar golpes.

    python hud_vida.py --video <mp4> --salida <json> --ffmpeg <ffmpeg> --wh 2560x1440
                       [--iconos <dir> --rivales zed,akali,...] [--duracion s]

Progreso por stderr (`PROGRESS:<0-100>`), como el resto de los analizadores.
"""
import argparse
import glob
import json
import os
import subprocess
import sys

import cv2
import numpy as np

FPS = 8.0

# Geometría del HUD en fracciones del ALTO: x respecto al centro, y desde abajo.
BARRA_X = (-0.17083, 0.08403)
BARRA_Y = (0.02986, 0.02361)
EFECTO_DCHA = 0.09167      # borde derecho de la fila de efectos
EFECTO_Y = (0.11806, 0.09514)
EFECTO_LADO = 0.02292
EFECTO_PASO = 0.02431
HUECOS = 6                 # efectos que se miran, de derecha a izquierda
REGION_X = (-0.18, 0.10)
REGION_Y = (0.125, 0.02)

# Parecido mínimo para dar un efecto por identificado (ver docstring).
PARECIDO_MIN = 0.62
# Ventaja mínima sobre el mejor icono DISTINTO.
VENTAJA_MIN = 0.06


def decodificacion_por_gpu(ffmpeg, vid):
    """`-hwaccel d3d11va` para AV1 (lo que graba libobs), CPU para el resto.

    La misma regla y los mismos motivos que en `minimap_positions.py`: en AV1
    1440p60, 120 s de vídeo salen en 18 s por la GPU; en H.264 la copia de
    vuelta de cada fotograma se come la ventaja.
    """
    forzado = os.environ.get("VOD_MINIMAP_HWACCEL", "").strip().lower()
    if forzado == "off":
        return []
    try:
        info = subprocess.run([ffmpeg, "-hide_banner", "-i", vid],
                              capture_output=True, text=True, timeout=30,
                              errors="replace").stderr
    except Exception:
        return []
    if forzado:
        return ["-hwaccel", forzado]
    return ["-hwaccel", "d3d11va"] if "Video: av1" in info else []


def rasgo(im):
    """Vector normalizado de un icono: 24x24, sin media. Correlación = producto."""
    im = cv2.resize(im, (24, 24), interpolation=cv2.INTER_AREA).astype(np.float32)
    im -= im.mean()
    return im / (np.linalg.norm(im) + 1e-6)


def cargar_iconos(directorio, rivales):
    """Iconos de los rivales, agrupando los que son la misma imagen.

    CommunityDragon repite dibujos (`leblancr` y `leblancrr`): sin agruparlos,
    la "ventaja sobre el segundo" saldría cero justo en los que están claros.
    """
    iconos = []
    for c in rivales:
        for f in sorted(glob.glob(os.path.join(directorio, c, "*.png"))):
            im = cv2.imread(f, cv2.IMREAD_UNCHANGED)
            if im is None:
                continue
            if im.ndim == 3 and im.shape[2] == 4:
                # Transparente sobre el fondo oscuro del HUD.
                alfa = im[..., 3:4].astype(np.float32) / 255.0
                im = (im[..., :3].astype(np.float32) * alfa).astype(np.uint8)
            elif im.ndim == 2:
                im = cv2.cvtColor(im, cv2.COLOR_GRAY2BGR)
            nombre = c + "/" + os.path.splitext(os.path.basename(f))[0]
            iconos.append([nombre, rasgo(im), None])
    for i, a in enumerate(iconos):
        for b in iconos[:i]:
            if b[2] is None and float((a[1] * b[1]).sum()) > 0.95:
                a[2] = b[0]
                break
    return [(n, r, g or n) for n, r, g in iconos]


def es_efecto(s, fuera):
    """¿Hay un efecto negativo en este hueco? Su marco es de un rojo apagado.

    Mirar sólo "el borde tira a rojo" no basta: la fila de efectos flota sobre
    el juego, y el fuego del campamento rojo o la pantalla de carga pasaban
    por efecto (en una partida de prueba, 38 "E de Tryndamere" falsas, una de
    ellas antes del 0:00). Medido en efectos de verdad: marco (55, 59, 104) en
    BGR, por dentro y por fuera mucho más oscuro. En los falsos el marco es
    naranja vivo y lo de fuera es igual que el marco.
    """
    borde = np.concatenate([s[:2].reshape(-1, 3), s[-2:].reshape(-1, 3),
                            s[:, :2].reshape(-1, 3), s[:, -2:].reshape(-1, 3)]).mean(axis=0)
    b, g, r = borde
    if not (25 <= r - max(g, b) <= 90 and r < 170):
        return False
    if fuera.size and r - fuera.reshape(-1, 3)[:, 2].mean() < 30:
        return False
    dentro = s[3:5, 3:-3].reshape(-1, 3)[:, 2].mean()
    return r - dentro >= 15


class Hueco:
    """Un hueco de la fila de efectos y el efecto que lo ocupa ahora."""

    def __init__(self):
        self.ultimo = None
        self.desde = None
        self.votos = []

    def cerrar(self):
        """El efecto se fue: ¿se identificó? Devuelve (t, nombre, parecido)."""
        votos, desde = self.votos, self.desde
        self.ultimo, self.desde, self.votos = None, None, []
        if not votos:
            return None
        cuenta = {}
        for parecido, grupo, nombre in votos:
            c = cuenta.setdefault(grupo, [0, 0.0, nombre])
            c[0] += 1
            if parecido > c[1]:
                c[1], c[2] = parecido, nombre
        grupo, (n, mejor, nombre) = max(cuenta.items(), key=lambda kv: (kv[1][0], kv[1][1]))
        # Un fotograma suelto sólo vale si es muy claro.
        if mejor >= PARECIDO_MIN and (n >= 2 or mejor >= 0.70):
            return (desde, nombre, round(mejor, 3))
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--salida", required=True)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--wh", required=True, help="ANCHOxALTO del vídeo")
    ap.add_argument("--duracion", type=float, help="segundos de vídeo, para el progreso")
    ap.add_argument("--iconos", help="carpeta con una subcarpeta de iconos por campeón")
    ap.add_argument("--rivales", default="", help="campeones rivales, separados por comas")
    a = ap.parse_args()

    VW, VH = [int(v) for v in a.wh.lower().split("x")[:2]]
    cx = VW / 2.0

    def X(k):
        return int(round(cx + k * VH))

    def Y(k):
        return int(round(VH - k * VH))

    # ffmpeg redondea el recorte a pares: pedirlo ya par evita leer filas
    # desplazadas (pasó en la primera prueba y daba vidas inventadas).
    rx0, ry0 = X(REGION_X[0]), Y(REGION_Y[0])
    rx0 -= rx0 % 2
    ry0 -= ry0 % 2
    w = (X(REGION_X[1]) - rx0) // 2 * 2
    h = (Y(REGION_Y[1]) - ry0) // 2 * 2

    bx0, bx1 = X(BARRA_X[0]) - rx0, X(BARRA_X[1]) - rx0
    by0, by1 = Y(BARRA_Y[0]) - ry0, Y(BARRA_Y[1]) - ry0
    by1 = max(by1, by0 + 2)
    ey0, ey1 = Y(EFECTO_Y[0]) - ry0, Y(EFECTO_Y[1]) - ry0
    lado, paso = EFECTO_LADO * VH, EFECTO_PASO * VH
    margen = max(2, int(lado * 0.09))
    huecos_x = []
    for k in range(HUECOS):
        x1 = int(round(X(EFECTO_DCHA) - rx0 - k * paso))
        huecos_x.append((int(round(x1 - lado)), x1))

    rivales = [r.strip().lower() for r in a.rivales.split(",") if r.strip()]
    iconos = cargar_iconos(a.iconos, rivales) if a.iconos and rivales else []
    matriz = np.stack([r.ravel() for _, r, _ in iconos]) if iconos else None

    def vida(fr):
        g = fr[by0:by1, bx0:bx1].astype(np.int16)
        verde = ((g[..., 1] > 80) & (g[..., 1] > g[..., 2] + 35)
                 & (g[..., 1] > g[..., 0] + 25)).mean(axis=0) > 0.5
        xs = np.flatnonzero(verde)
        return int(round(1000 * (xs[-1] + 1) / (bx1 - bx0))) if len(xs) else 0

    def mejor_icono(recorte):
        r = rasgo(recorte).ravel()
        s = matriz @ r
        orden = np.argsort(-s)
        i0 = int(orden[0])
        grupo0 = iconos[i0][2]
        segundo = next((float(s[j]) for j in orden[1:] if iconos[int(j)][2] != grupo0), -1.0)
        return float(s[i0]), grupo0, iconos[i0][0], float(s[i0]) - segundo

    cmd = [a.ffmpeg, "-loglevel", "error"] + decodificacion_por_gpu(a.ffmpeg, a.video)
    cmd += ["-i", a.video, "-vf", f"fps={FPS},crop={w}:{h}:{rx0}:{ry0}",
            "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)

    vidas, efectos = [], []
    huecos = [Hueco() for _ in range(HUECOS)]
    vistos = {}
    ultimo_pct = -1
    idx = 0

    def apuntar(res):
        if not res:
            return
        t, nombre, parecido = res
        # El mismo efecto salta de hueco cuando aparece otro a su lado: no es
        # un golpe nuevo si ya se apuntó hace menos de 2 s.
        if t - vistos.get(nombre, -99.0) < 2.0:
            return
        vistos[nombre] = t
        efectos.append({"t": round(t, 3), "icon": nombre, "score": parecido})

    tam = w * h * 3
    while True:
        raw = p.stdout.read(tam)
        if len(raw) < tam:
            break
        fr = np.frombuffer(raw, np.uint8).reshape(h, w, 3)
        t = idx / FPS
        idx += 1
        vidas.append(vida(fr))

        if matriz is not None:
            for k, (x0, x1) in enumerate(huecos_x):
                s = fr[ey0:ey1, x0:x1].astype(np.int16)
                hu = huecos[k]
                if not es_efecto(s, fr[max(0, ey0 - 3):max(1, ey0 - 1), x0:x1]):
                    apuntar(hu.cerrar())
                    continue
                dentro = s[margen:-margen, margen:-margen].astype(np.uint8)
                r = rasgo(dentro)
                if hu.ultimo is not None and float((r * hu.ultimo).sum()) < 0.6:
                    apuntar(hu.cerrar())
                if hu.desde is None:
                    hu.desde = t
                hu.ultimo = r
                parecido, grupo, nombre, ventaja = mejor_icono(dentro)
                if parecido >= 0.55 and ventaja >= VENTAJA_MIN:
                    hu.votos.append((parecido, grupo, nombre))

        if a.duracion and a.duracion > 0 and idx % 80 == 0:
            pct = min(99, int(100 * t / a.duracion))
            if pct != ultimo_pct:
                ultimo_pct = pct
                print(f"PROGRESS:{pct}", file=sys.stderr, flush=True)

    for hu in huecos:
        apuntar(hu.cerrar())

    codigo = p.wait()
    if codigo != 0:
        print(f"ffmpeg terminó con código {codigo}: el vídeo se leyó a medias",
              file=sys.stderr, flush=True)
        return 1

    con_barra = sum(1 for v in vidas if v > 0) / max(1, len(vidas))
    efectos.sort(key=lambda e: e["t"])
    salida = {
        "v": 1,
        "fps": FPS,
        "width": VW,
        "height": VH,
        # Fracción de fotogramas con barra verde. Muerto también da 0, pero
        # nadie pasa más de la mitad de la partida muerto: por debajo de 0,5
        # es que el HUD no está donde se le busca.
        "hud_ok": round(con_barra, 3),
        "rivals": rivales,
        "hp": vidas,
        "debuffs": efectos,
    }
    tmp = a.salida + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(salida, f, separators=(",", ":"))
    os.replace(tmp, a.salida)
    print("PROGRESS:100", file=sys.stderr, flush=True)
    print(f"{len(vidas)} lecturas, barra en el {100 * con_barra:.0f}%, "
          f"{len(efectos)} efectos identificados -> {a.salida}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
