"""Fabrica imágenes de minimapa con iconos pegados, para entrenar el detector.

El modelo entrenado sólo con datos reales se quedó en 51% de cobertura, y el
diagnóstico fue claro: el error de entrenamiento seguía bajando mientras el de
validación se estancaba. Sobreajuste — 376 imágenes son muy pocas para
detección de objetos.

Aquí se fabrican miles. Las dos piezas ya existen:

- **Fondos**: el "minimapa vacío" que sale de la mediana de varios fotogramas,
  con sus torres, terreno y temporizadores pero sin campeones. Se toma la mediana
  **por tramos** de la partida y no de toda: así aparecen estados distintos del
  mapa (torres que ya cayeron, niebla que cambió), que es variedad gratis.
- **Iconos**: los retratos de Data Dragon, recortados en círculo con su aro.

La etiqueta es exacta por construcción: sabemos dónde pegamos cada uno.

Y resuelve dos cosas que el conjunto real no puede:

1. **Rivales de verdad.** Con datos reales sólo hay aros azules (a un rival en
   niebla no se le ve), y se dependía de revolver el tono para que el modelo
   generalizara. Aquí se pintan aros rojos directamente.
2. **Los casos difíciles a propósito**: iconos encimados, tapados por el
   recuadro de la cámara, o pegados sobre los números de los temporizadores.
   Justo donde fallaban las reglas.

    python minimap_synth.py --n 4000 --out D:/lol-corpus/minimapa_synth
"""
import argparse
import glob
import json
import os
import random

import cv2
import numpy as np

from minimap_detect import frame_en, icono, recorte

LADO = 26

# Colores de aro en BGR, muestreados de iconos reales: el aliado tira a
# azul-cian y el rival a rojo.
ARO_ALIADO = (235, 175, 90)
ARO_RIVAL = (70, 70, 230)


def fondos(videos_dir, cache, por_partida=4):
    """Minimapas vacíos, varios por partida para tener estados distintos."""
    os.makedirs(cache, exist_ok=True)
    guardados = sorted(glob.glob(os.path.join(cache, "*.png")))
    if guardados:
        return [cv2.imread(p) for p in guardados]

    out = []
    for meta in sorted(glob.glob(os.path.join(videos_dir, "*", "*.json"))):
        d = os.path.dirname(meta)
        try:
            m = json.load(open(meta, encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(m, dict) or m.get("video_offset") is None:
            continue
        vid = os.path.join(d, os.path.basename(d) + ".mp4")
        tl_p = os.path.join(d, "riot_timeline.json")
        if not (os.path.exists(vid) and os.path.exists(tl_p)):
            continue
        tl = json.load(open(tl_p, encoding="utf-8"))
        dur = tl["info"]["frames"][-1]["timestamp"] / 1000.0
        off = m["video_offset"]
        for t in range(por_partida):
            ini, fin = dur * t / por_partida, dur * (t + 1) / por_partida
            # 12 muestras y no 6: con pocas, un campeón que aparece en la mitad
            # de ellas sobrevive a la mediana y deja un fantasma borroso. Esos
            # fantasmas son iconos sin etiqueta, o sea justo lo contrario de lo
            # que se quiere enseñar.
            muestras = []
            for i in range(12):
                fr = frame_en(vid, ini + (fin - ini) * (i + 0.5) / 12 + off)
                if fr is not None:
                    muestras.append(recorte(fr))
            if len(muestras) < 7:
                continue
            bg = np.median(np.stack(muestras), axis=0).astype(np.uint8)
            ruta = os.path.join(cache, f"{os.path.basename(d)}_t{t}.png")
            cv2.imwrite(ruta, bg)
            out.append(bg)
        print(f"  fondos de {os.path.basename(d)}: {len(out)} acumulados", flush=True)
    return out


def hacer_icono(retrato, lado, aliado):
    """Retrato recortado en círculo con su aro, como se ve en el minimapa."""
    t = cv2.resize(retrato, (lado, lado), interpolation=cv2.INTER_AREA)
    alpha = np.zeros((lado, lado), np.uint8)
    r = lado // 2
    cv2.circle(alpha, (r, r), int(lado * 0.42), 255, -1)
    color = ARO_ALIADO if aliado else ARO_RIVAL
    cv2.circle(t, (r, r), int(lado * 0.42), color, 2)
    cv2.circle(alpha, (r, r), int(lado * 0.42), 255, 2)
    return t, alpha


def pegar(lienzo, img, alpha, cx, cy):
    lado = img.shape[0]
    x0, y0 = int(cx - lado / 2), int(cy - lado / 2)
    h, w = lienzo.shape[:2]
    if x0 < 0 or y0 < 0 or x0 + lado > w or y0 + lado > h:
        return False
    roi = lienzo[y0:y0 + lado, x0:x0 + lado]
    a = (alpha.astype(np.float32) / 255.0)[..., None]
    lienzo[y0:y0 + lado, x0:x0 + lado] = (img * a + roi * (1 - a)).astype(np.uint8)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", default="C:/Users/Alejandro/Videos/LeagueRecorder")
    ap.add_argument("--out", default="D:/lol-corpus/minimapa_synth")
    ap.add_argument("--fondos", default="D:/lol-corpus/fondos")
    ap.add_argument("--iconos", default="D:/lol-corpus/iconos")
    ap.add_argument("--version", default="16.16.1")
    ap.add_argument("--n", type=int, default=4000)
    ap.add_argument("--val", type=float, default=0.15)
    ap.add_argument("--muestra", help="carpeta donde dejar unos ejemplos para mirarlos")
    a = ap.parse_args()

    print("preparando fondos…", flush=True)
    bgs = fondos(a.videos, a.fondos)
    if not bgs:
        raise SystemExit("no se pudo construir ningún fondo")
    print(f"{len(bgs)} fondos")

    # Todos los campeones, no sólo los de sus partidas: el detector tiene que
    # servir para cualquier composición.
    nombres = [os.path.splitext(os.path.basename(p))[0]
               for p in glob.glob(os.path.join(a.iconos, "*.png"))]
    if len(nombres) < 20:
        import urllib.request
        req = urllib.request.Request(
            f"https://ddragon.leagueoflegends.com/cdn/{a.version}/data/en_US/champion.json",
            headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            nombres = list(json.load(r)["data"].keys())
        print(f"descargando {len(nombres)} retratos…", flush=True)
    retratos = []
    for n in nombres:
        try:
            im = icono(n, a.version, a.iconos)
            if im is not None:
                retratos.append(im)
        except Exception:
            continue
    print(f"{len(retratos)} retratos")

    rnd = random.Random(11)
    for sub in ("train", "val"):
        os.makedirs(f"{a.out}/images/{sub}", exist_ok=True)
        os.makedirs(f"{a.out}/labels/{sub}", exist_ok=True)
    if a.muestra:
        os.makedirs(a.muestra, exist_ok=True)

    for i in range(a.n):
        sub = "val" if i < a.n * a.val else "train"
        bg = rnd.choice(bgs).copy()
        alto, ancho = bg.shape[:2]

        # El recuadro de la cámara: es blanco, se mueve y tapa iconos. Sin él en
        # el entrenamiento, el modelo no aprende a ver a través de él.
        if rnd.random() < 0.8:
            rw, rh = int(ancho * 0.28), int(alto * 0.22)
            rx, ry = rnd.randint(0, ancho - rw), rnd.randint(0, alto - rh)
            cv2.rectangle(bg, (rx, ry), (rx + rw, ry + rh), (245, 245, 245), 1)

        lineas = []
        n_iconos = rnd.randint(1, 10)
        centros = []
        for _ in range(n_iconos):
            lado = rnd.randint(LADO - 3, LADO + 3)
            aliado = rnd.random() < 0.5
            img, alpha = hacer_icono(rnd.choice(retratos), lado, aliado)
            # Un 25% se colocan pegados a otro: los iconos encimados son
            # frecuentes en peleas y es donde más se equivocaba.
            if centros and rnd.random() < 0.25:
                bx, by = rnd.choice(centros)
                cx = bx + rnd.randint(-lado, lado)
                cy = by + rnd.randint(-lado, lado)
            else:
                cx = rnd.randint(lado, ancho - lado)
                cy = rnd.randint(lado, alto - lado)
            if not pegar(bg, img, alpha, cx, cy):
                continue
            centros.append((cx, cy))
            lineas.append(f"0 {cx/ancho:.6f} {cy/alto:.6f} "
                          f"{lado/ancho:.6f} {lado/alto:.6f}")

        if not lineas:
            continue
        base = f"synth_{i:05d}"
        cv2.imwrite(f"{a.out}/images/{sub}/{base}.png", bg)
        open(f"{a.out}/labels/{sub}/{base}.txt", "w").write("\n".join(lineas))
        if a.muestra and i < 6:
            vis = bg.copy()
            for ln in lineas:
                _, x, y, w, h = [float(v) for v in ln.split()]
                cv2.rectangle(vis, (int((x - w / 2) * ancho), int((y - h / 2) * alto)),
                              (int((x + w / 2) * ancho), int((y + h / 2) * alto)),
                              (0, 255, 0), 1)
            cv2.imwrite(f"{a.muestra}/{base}.png", vis)
        if (i + 1) % 500 == 0:
            print(f"  {i+1}/{a.n}", flush=True)

    with open(f"{a.out}/dataset.yaml", "w", encoding="utf-8") as f:
        f.write(f"path: {a.out}\ntrain: images/train\nval: images/val\n"
                "names:\n  0: icono\n")
    print(f"\nlisto -> {a.out}/dataset.yaml")
    print("OJO: para entrenar hay que MEZCLAR esto con el conjunto real. Sólo con"
          " sintético, el modelo aprende a ver pegatinas, no iconos de verdad.")


if __name__ == "__main__":
    main()
