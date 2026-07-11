"""Entrena el detector YOLO de cursores en la GPU y exporta a ONNX.

Requiere (SOLO para entrenar; NO se empaqueta en la app):
    pip install ultralytics

El cursor es un objeto MUY pequeño (~30 px) en un frame de 1440p, así que
entrenamos a resolución alta (imgsz grande) para no perderlo al reescalar.

Uso:
    python train_cursor.py <data_yaml> [--epochs N] [--imgsz S] [--batch B]
                           [--model yolov8n.pt] [--out runs/cursor]
"""

import sys
import os


def _arg(flag, default, cast):
    if flag in sys.argv:
        try:
            return cast(sys.argv[sys.argv.index(flag) + 1])
        except (IndexError, ValueError):
            pass
    return default


def main():
    if len(sys.argv) < 2:
        print("Usage: python train_cursor.py <data_yaml> [--epochs N] [--imgsz S] "
              "[--batch B] [--model yolov8n.pt] [--out runs/cursor]")
        sys.exit(1)

    try:
        from ultralytics import YOLO
    except ImportError:
        print("Falta ultralytics. Instala (solo para entrenar):\n"
              "    pip install ultralytics")
        sys.exit(1)

    data_yaml = sys.argv[1]
    epochs = _arg("--epochs", 100, int)
    imgsz = _arg("--imgsz", 1280, int)   # alto: el cursor es diminuto en 1440p
    batch = _arg("--batch", 12, int)
    model_name = _arg("--model", "yolov8n.pt", str)
    out = os.path.abspath(_arg("--out", "runs/cursor", str))  # abs: evita el nesting runs/detect/

    # 1 sola clase "cursor": el cursor de ataque es rarísimo (desbalanceo brutal),
    # así que detectamos el cursor a secas; el tipo de clic (ataque/mov) lo decide
    # la lógica HSV aguas abajo, no el detector.
    single_cls = _arg("--single-cls", 1, int) == 1

    model = YOLO(model_name)
    model.train(
        data=data_yaml,
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        device=0,            # RTX 5070 Ti
        project=out,
        name="train",
        patience=25,
        single_cls=single_cls,
        # el cursor no rota ni cambia de escala salvo por resolución: augment suave
        degrees=0.0, shear=0.0, perspective=0.0, flipud=0.0, fliplr=0.0,
        mosaic=0.5, scale=0.2, hsv_v=0.3,
    )

    # Exportar a ONNX para la inferencia por onnxruntime-gpu.
    # dynamic=True -> permite batching (clave para saturar la GPU en el análisis).
    # Ruta real del best.pt según ultralytics (evita adivinar el save_dir).
    best = str(model.trainer.best)
    m = YOLO(best)
    onnx_path = m.export(format="onnx", dynamic=True, half=True, imgsz=imgsz, opset=12)
    print(f"\nModelo entrenado: {best}\nONNX exportado:   {onnx_path}")


if __name__ == "__main__":
    main()
