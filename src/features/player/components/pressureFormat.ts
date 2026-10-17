/**
 * Formato de las cifras de presión absorbida, compartido por la tarjeta de
 * episodio, Hoy y Patrones: si cada pantalla redondea a su manera, el mismo
 * episodio sale con dos cifras distintas y deja de ser creíble. También lo usa
 * el resto de la pestaña Impacto (impacto, tú contra tu rival), por lo mismo.
 */

/** El separador de miles del idioma de la interfaz: "1.250" en español y
 *  "1,250" en inglés. Iba clavado a es-ES, y en inglés "1.250" se lee "uno
 *  coma veinticinco". Sale de <html lang>, como `formatDecimal`. */
const locale = (): string =>
  typeof document !== "undefined" && document.documentElement.lang === "en" ? "en-US" : "es-ES";

/** "1.250" / "1,250", sin signo. */
export function formatNumber(n: number): string {
  // `useGrouping: "always"`: en es-ES las cifras de cuatro dígitos salen sin
  // punto por norma (4256, pero 14.256), y en la misma columna se leía "4256"
  // al lado de "1.584". El tipo de TS aún sólo acepta booleano.
  return Math.abs(Math.round(n)).toLocaleString(locale(), { useGrouping: "always" } as unknown as Intl.NumberFormatOptions);
}

/** "+708", "−1.250", "0". Con `sign`, los positivos llevan "+". */
export function formatGold(n: number, sign = false): string {
  const r = Math.round(n);
  const abs = formatNumber(r);
  if (r < 0) return `−${abs}`;
  if (r > 0 && sign) return `+${abs}`;
  return abs;
}

/** "+36,4", "−7,5", "0,0": una cifra con decimales y el signo siempre a la
 *  vista. El WPA (×100) se compara por el signo antes que por el tamaño. */
export function formatSigned(n: number, digits = 1): string {
  const f = Math.pow(10, digits);
  const r = Math.round(n * f) / f;
  const abs = Math.abs(r).toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (r < 0) return `−${abs}`;
  if (r > 0) return `+${abs}`;
  return abs;
}

/** "52 s", "2 min 06 s", "38 min". */
export function formatSeconds(s: number): string {
  const total = Math.max(0, Math.round(s));
  if (total < 60) return `${total} s`;
  const m = Math.floor(total / 60);
  const r = total % 60;
  if (m >= 10 || r === 0) return `${m} min`;
  return `${m} min ${String(r).padStart(2, "0")} s`;
}

/** "Diana", "Diana y Kassadin", "Diana, Kassadin y Lee Sin". La conjunción
 *  sale del diccionario ("{a} and {b}"); `Intl.ListFormat` no está en el
 *  `lib` del proyecto. */
export function joinList(items: string[], t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (items.length <= 1) return items[0] ?? "";
  return t("{a} and {b}", { a: items.slice(0, -1).join(", "), b: items[items.length - 1] });
}
