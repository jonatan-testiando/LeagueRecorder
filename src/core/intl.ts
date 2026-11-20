/**
 * Formateadores de `Intl` reutilizados.
 *
 * Crear un `Intl.NumberFormat` o un `Intl.DateTimeFormat` es caro (carga los
 * datos del idioma y compila el patrón), y `x.toLocaleString(locale, opciones)`
 * crea uno nuevo en CADA llamada. Medido el 2026-11-19 con un perfil de CPU del
 * arranque: las cifras de presión y las fechas relativas de Hoy se llevaban
 * ~78 ms de los ~200 ms de JavaScript, casi todo en crear formateadores. Aquí
 * se crean una vez por idioma y opciones y se guardan.
 */

const numeros = new Map<string, Intl.NumberFormat>();
const fechas = new Map<string, Intl.DateTimeFormat>();

/** El formateador de números para ese idioma y esas opciones. */
export function numberFormat(locale: string, opciones: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const clave = locale + JSON.stringify(opciones);
  let f = numeros.get(clave);
  if (!f) {
    f = new Intl.NumberFormat(locale, opciones);
    numeros.set(clave, f);
  }
  return f;
}

/** El formateador de fechas para ese idioma y esas opciones. */
export function dateFormat(locale: string, opciones: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormat {
  const clave = locale + JSON.stringify(opciones);
  let f = fechas.get(clave);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opciones);
    fechas.set(clave, f);
  }
  return f;
}

/** `n` con `digits` decimales fijos: "2,33" / "2.33". */
export const fixedDigits = (n: number, locale: string, digits: number): string =>
  numberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
