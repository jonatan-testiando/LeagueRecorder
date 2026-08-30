"""Cadenas que pasan por t() y no están en el diccionario español.

Es lo que en pantalla sale en inglés dentro de una interfaz en español.
"""
import io
import os
import re

RAIZ = "src"

# Las claves del diccionario: "clave": "valor" o "clave":\n  "valor"
dic = io.open("src/core/i18n.ts", encoding="utf-8").read()
claves = set(re.findall(r'^\s{2}"((?:[^"\\]|\\.)*)":', dic, re.M))

usadas = {}
for base, _, ficheros in os.walk(RAIZ):
    for f in ficheros:
        if not f.endswith((".ts", ".tsx")) or f.endswith("i18n.ts"):
            continue
        p = os.path.join(base, f)
        s = io.open(p, encoding="utf-8").read()
        # t("...") y t('...'), con o sin segundo argumento
        for m in re.finditer(r"\bt\(\s*\"((?:[^\"\\]|\\.)+)\"", s):
            usadas.setdefault(m.group(1), []).append(p)

faltan = {k: v for k, v in usadas.items() if k not in claves}
print(f"cadenas que pasan por t(): {len(usadas)}")
print(f"traducidas: {len(usadas) - len(faltan)}")
print(f"SIN TRADUCIR: {len(faltan)}\n")
for k in sorted(faltan):
    sitios = sorted({os.path.relpath(x, RAIZ).replace(os.sep, "/") for x in faltan[k]})
    print('  "%s"  <- %s' % (k, ", ".join(sitios)))
