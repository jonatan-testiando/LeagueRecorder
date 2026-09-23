/**
 * Formato de las cifras de presión absorbida, compartido por la tarjeta de
 * episodio, Hoy y Patrones: si cada pantalla redondea a su manera, el mismo
 * episodio sale con dos cifras distintas y deja de ser creíble.
 */

/** "+708", "−1.250", "0". Con `sign`, los positivos llevan "+". */
export function formatGold(n: number, sign = false): string {
  const r = Math.round(n);
  const abs = Math.abs(r).toLocaleString("es-ES");
  if (r < 0) return `−${abs}`;
  if (r > 0 && sign) return `+${abs}`;
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
