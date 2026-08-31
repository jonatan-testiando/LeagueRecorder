"""Texto de la interfaz que no llega traducido a pantalla.

Dos agujeros distintos, y el segundo es el que no se ve venir:

1. **Cadenas que pasan por `t()` y no están en el diccionario**: salen en inglés
   dentro de la interfaz en español.
2. **Texto escrito directamente en el JSX**, que no pasa por `t()` siquiera. Este
   no lo detecta nadie mirando el diccionario, porque nunca llega a preguntar. Es
   peor que el anterior: no se puede traducir sin tocar el componente, y va en los
   dos sentidos (inglés clavado en la interfaz en español, y español clavado que
   no cambia al poner la interfaz en inglés).

    python tools/i18n_huecos.py
"""
import io
import os
import re

RAIZ = "src"

# --- 1. Las claves del diccionario -------------------------------------------
dic = io.open("src/core/i18n.ts", encoding="utf-8").read()
claves = set(re.findall(r'^\s{2}"((?:[^"\\]|\\.)*)":', dic, re.M))

usadas = {}
# --- 2. Texto suelto dentro del JSX ------------------------------------------
# Un nodo de texto entre etiquetas, con al menos dos palabras y una letra: se
# descartan números, signos y las claves de una sola palabra, que casi siempre
# son variables o iconos.
TEXTO_JSX = re.compile(r">\s*\n?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ][^<>{}\n]{6,})\s*\n?\s*<")
# Entre "<" y ">" también cae código (`a > b ? x : y`, `new Set`, `dur / s`).
# La prosa no lleva paréntesis, ni igual, ni punto y coma, ni llamadas a método.
CODIGO = re.compile(r"[(){}\[\];=|&]|\w\.\w")
sueltas = {}

for base, _, ficheros in os.walk(RAIZ):
    for f in ficheros:
        if not f.endswith((".ts", ".tsx")) or f.endswith("i18n.ts"):
            continue
        p = os.path.join(base, f)
        s = io.open(p, encoding="utf-8").read()
        for m in re.finditer(r"\bt\(\s*\"((?:[^\"\\]|\\.)+)\"", s):
            usadas.setdefault(m.group(1), []).append(p)
        if not f.endswith(".tsx"):
            continue
        # Fuera comentarios, que también viven entre "<" y ">" del JSX.
        limpio = re.sub(r"\{/\*.*?\*/\}", "", s, flags=re.S)
        limpio = re.sub(r"^\s*//.*$", "", limpio, flags=re.M)
        limpio = re.sub(r"/\*.*?\*/", "", limpio, flags=re.S)
        for m in TEXTO_JSX.finditer(limpio):
            txt = m.group(1).strip()
            if len(txt.split()) < 2 or CODIGO.search(txt):
                continue
            sueltas.setdefault(txt, []).append(p)

faltan = {k: v for k, v in usadas.items() if k not in claves}


def informe(titulo, d):
    print(f"\n{titulo}: {len(d)}")
    for k in sorted(d):
        sitios = sorted({os.path.relpath(x, RAIZ).replace(os.sep, "/") for x in d[k]})
        corto = k if len(k) <= 66 else k[:63] + "..."
        print('  "%s"\n      %s' % (corto, ", ".join(sitios)))


print(f"cadenas que pasan por t(): {len(usadas)} | traducidas: {len(usadas) - len(faltan)}")
informe("SIN TRADUCIR (pasan por t() y no están en el diccionario)", faltan)
informe("SIN PASAR POR t() (texto clavado en el JSX)", sueltas)
