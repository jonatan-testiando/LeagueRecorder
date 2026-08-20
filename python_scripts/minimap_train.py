"""Entrena el detector de iconos del minimapa.

El conjunto lo genera `minimap_dataset.py` con etiquetas que da la propia API,
sin marcar nada a mano.

## Dos ajustes que no son los de por defecto, y por qué

**`hsv_h` muy alto (0,5 en vez de 0,015).** Es el aumento de tono. Sólo se
etiquetan aliados, que llevan el aro azul; sin aleatorizar el color el modelo
aprendería "mancha azul" y no vería a los rivales, que lo llevan rojo. Con el
tono revuelto tiene que aprender la **forma** del icono, que es lo que ambos
comparten. Es la diferencia entre un detector que sirve y uno que sólo ve a tu
equipo.

**Sin volteos ni rotaciones.** `fliplr` y `degrees` a cero: el minimapa siempre
se ve en la misma orientación, y un icono espejado no existe en el juego. Meter
esas variaciones sólo gasta capacidad del modelo en casos imposibles.

    python minimap_train.py --datos D:/lol-corpus/minimapa/dataset.yaml
"""
import argparse


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datos", default="D:/lol-corpus/minimapa/dataset.yaml")
    ap.add_argument("--epocas", type=int, default=120)
    ap.add_argument("--modelo", default="yolov8n.pt",
                    help="el más pequeño: los iconos son simples y hay ~2.700")
    ap.add_argument("--imgsz", type=int, default=416,
                    help="el recorte del minimapa ronda 400x380 px")
    ap.add_argument("--salida", default="D:/lol-corpus/minimapa/runs")
    a = ap.parse_args()

    from ultralytics import YOLO

    modelo = YOLO(a.modelo)
    modelo.train(
        data=a.datos,
        epochs=a.epocas,
        imgsz=a.imgsz,
        batch=16,
        project=a.salida,
        name="iconos",
        exist_ok=True,
        patience=30,
        # --- aumento ---
        hsv_h=0.5,      # ver la nota de arriba: es lo que hace que vea rivales
        hsv_s=0.5,
        hsv_v=0.3,
        degrees=0.0,
        fliplr=0.0,
        flipud=0.0,
        mosaic=0.0,     # el minimapa es una escena fija; pegar trozos no aporta
        translate=0.05,
        scale=0.15,
    )

    m = modelo.val(data=a.datos, imgsz=a.imgsz)
    print("\n--- validación (partidas que no se usaron para entrenar) ---")
    print(f"  precisión : {m.box.mp:.3f}   (de lo que dice que es icono, cuánto lo es)")
    print(f"  cobertura : {m.box.mr:.3f}   (de los iconos que hay, cuántos ve)")
    print(f"  mAP50     : {m.box.map50:.3f}")
    print("\nreferencia de los intentos con reglas: 30% de cobertura como mucho")


if __name__ == "__main__":
    main()
