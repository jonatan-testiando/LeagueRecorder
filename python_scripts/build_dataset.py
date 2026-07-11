"""Construye el dataset YOLO de cursores a partir de TODOS los VODs grabados.

Recorre las grabaciones en Videos/LeagueRecorder, auto-etiqueta una muestra
uniforme de frames de cada una (usando el tracker clásico como profesor) y
escribe el `data.yaml` listo para entrenar con ultralytics.

Uso:
    python build_dataset.py <out_dir> [--num N] [--videos-dir DIR] [--min-conf C]
"""

import os
import sys
import glob
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from autolabel import label_video_fast

CLASS_NAMES = {0: "cursor_move", 1: "cursor_attack"}


def _arg(flag, default, cast):
    if flag in sys.argv:
        try:
            return cast(sys.argv[sys.argv.index(flag) + 1])
        except (IndexError, ValueError):
            pass
    return default


def main():
    if len(sys.argv) < 2:
        print("Usage: python build_dataset.py <out_dir> [--num N] "
              "[--videos-dir DIR] [--min-conf C]")
        sys.exit(1)

    os.environ["OPENCV_LOG_LEVEL"] = "OFF"
    os.environ.setdefault("VOD_USE_OPENCL", "0")  # más rápido en este equipo

    out_dir = os.path.abspath(sys.argv[1])
    num = _arg("--num", 400, int)
    min_conf = _arg("--min-conf", 0.92, float)
    videos_dir = _arg("--videos-dir",
                      os.path.join(os.path.expanduser("~"), "Videos", "LeagueRecorder"),
                      str)

    # cursores: relativo al repo (analyzer.py resuelve la ruta por defecto igual)
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cursors = os.path.join(repo, "assets", "cursors")

    vods = sorted(glob.glob(os.path.join(videos_dir, "**", "*.mp4"), recursive=True))
    if not vods:
        print(json.dumps({"error": f"No se encontraron VODs en {videos_dir}"}))
        sys.exit(1)

    sys.stderr.write(f"[BUILD] {len(vods)} VODs | num/vod={num} | out={out_dir}\n")
    sys.stderr.flush()

    total = 0
    for i, v in enumerate(vods, 1):
        sys.stderr.write(f"[BUILD] ({i}/{len(vods)}) {os.path.basename(v)}\n")
        sys.stderr.flush()
        total += label_video_fast(v, cursors, out_dir, num=num, min_conf=min_conf)

    # data.yaml para ultralytics
    yaml_path = os.path.join(out_dir, "data.yaml")
    with open(yaml_path, "w") as f:
        f.write(f"path: {out_dir}\n")
        f.write("train: images/train\n")
        f.write("val: images/val\n")
        f.write(f"nc: {len(CLASS_NAMES)}\n")
        f.write("names:\n")
        for k in sorted(CLASS_NAMES):
            f.write(f"  {k}: {CLASS_NAMES[k]}\n")

    n_tr = len(glob.glob(os.path.join(out_dir, "images", "train", "*.jpg")))
    n_va = len(glob.glob(os.path.join(out_dir, "images", "val", "*.jpg")))
    sys.stderr.write(f"[BUILD] LISTO. total={total} (train={n_tr}, val={n_va})\n")
    print(json.dumps({"total": total, "train": n_tr, "val": n_va, "data_yaml": yaml_path}))


if __name__ == "__main__":
    main()
