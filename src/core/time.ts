/**
 * Segundos → texto de reloj.
 *
 * Había nueve copias de esto repartidas por la interfaz, en dos variantes que
 * nadie había puesto nombre: una rellena los minutos con cero y otra no. La
 * diferencia importa y por eso se conservan las dos, pero como decisión
 * explícita y en un solo sitio:
 *
 * - `clock` para el reloj del reproductor y las duraciones: los dígitos no
 *   bailan al pasar de 9:59 a 10:00, que es lo que hace saltar la maquetación.
 * - `mmss` para una hora citada dentro de una frase o una fila, donde el cero
 *   de relleno sobra ("12:02", no "05:00" cuando quieres decir 5:00).
 *
 * Las dos truncan, no redondean: un instante de 59,6 s es el segundo 59, y
 * enseñar 1:00 mandaría a saltar a un sitio donde no está lo que buscas.
 */

const partes = (secs: number): [number, number] => {
  const s = isFinite(secs) && secs > 0 ? Math.floor(secs) : 0;
  return [Math.floor(s / 60), s % 60];
};

/** "mm:ss" con relleno. Reloj del reproductor y duraciones. */
export const clock = (secs: number): string => {
  const [m, s] = partes(secs);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

/** "m:ss" sin relleno en los minutos. Horas citadas dentro de una línea. */
export const mmss = (secs: number): string => {
  const [m, s] = partes(secs);
  return `${m}:${String(s).padStart(2, "0")}`;
};

/**
 * Fecha de una partida → "hoy", "ayer", "hace 3d" o la fecha suelta.
 *
 * Recibe `t` en vez de devolver una clave porque el "3d" lleva un número dentro:
 * traducirlo fuera obligaba a buscar en el diccionario la cadena ya formada
 * («3d ago»), que **nunca acertaba** — esa entrada no existe, así que se quedaba
 * en inglés dentro de una interfaz en español. Así la frase se compone en el
 * idioma bueno, y quien llama recibe el texto final, que además es lo que se
 * compara para agrupar por días.
 */
export const relativeDay = (
  iso: string,
  t: (key: string, vars?: Record<string, string | number>) => string
): string => {
  const d = new Date(iso.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return iso.split(" ")[0];
  const inicio = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dias = Math.round((inicio(new Date()) - inicio(d)) / 86400000);
  if (dias <= 0) return t("today");
  if (dias === 1) return t("yesterday");
  if (dias < 7) return t("{d}d ago", { d: dias });
  return iso.split(" ")[0];
};
