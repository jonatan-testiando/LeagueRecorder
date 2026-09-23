import type { Translate } from "../../core/eventText";
import type { Language } from "../../core/i18n";
import { normalizePosition } from "../../components/PositionIcon";

/**
 * Frases y cifras de «Hoy». Cada texto pasa por `t()` con la clave LITERAL (no
 * a través de una tabla), para que `tools/i18n_huecos.py` la vea.
 */

const locale = (lang: Language) => (lang === "es" ? "es-ES" : "en-US");

/** Cifra con los decimales fijos y la coma del idioma ("2,33" / "2.33"). */
export const fmtNum = (n: number, lang: Language, digits = 0): string =>
  n.toLocaleString(locale(lang), { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** "7th" / "7.º". */
export function ordinal(n: number, lang: Language): string {
  if (lang === "es") return `${n}.º`;
  const d = n % 10;
  const dd = n % 100;
  const suf = dd >= 11 && dd <= 13 ? "th" : d === 1 ? "st" : d === 2 ? "nd" : d === 3 ? "rd" : "th";
  return `${n}${suf}`;
}

/** "Monday, September 22" / "Lunes, 22 de septiembre". */
export function longDate(lang: Language, d = new Date()): string {
  const s = d.toLocaleDateString(locale(lang), { weekday: "long", day: "numeric", month: "long" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Mismo día de calendario LOCAL que hoy (la fecha de la partida es hora local). */
export function isToday(iso: string, now = new Date()): boolean {
  const p = (n: number) => String(n).padStart(2, "0");
  return iso.startsWith(`${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`);
}

/* -------------------------------------------------------------------- rango */

const TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND"];
const DIVS = ["IV", "III", "II", "I"];
const APEX = ["MASTER", "GRANDMASTER", "CHALLENGER"];

export function tierName(tier: string, t: Translate): string {
  switch (tier.toUpperCase()) {
    case "IRON": return t("Iron");
    case "BRONZE": return t("Bronze");
    case "SILVER": return t("Silver");
    case "GOLD": return t("Gold");
    case "PLATINUM": return t("Platinum");
    case "EMERALD": return t("Emerald");
    case "DIAMOND": return t("Diamond");
    case "MASTER": return t("Master");
    case "GRANDMASTER": return t("Grandmaster");
    case "CHALLENGER": return t("Challenger");
    default: return tier.charAt(0) + tier.slice(1).toLowerCase();
  }
}

export const isApex = (tier: string) => APEX.includes(tier.toUpperCase());

/** "Emerald II"; en Master+ la división no dice nada. */
export function rankText(tier: string, division: string | null | undefined, t: Translate): string {
  return isApex(tier) || !division ? tierName(tier, t) : `${tierName(tier, t)} ${division}`;
}

/** La división siguiente ("Emerald I", "Diamond IV", "Master"), o null en Master+. */
export function nextRank(tier: string, division: string | null | undefined, t: Translate): string | null {
  const T = tier.toUpperCase();
  if (isApex(T)) return null;
  const ti = TIERS.indexOf(T);
  const di = DIVS.indexOf(division ?? "");
  if (ti < 0 || di < 0) return null;
  if (di < DIVS.length - 1) return rankText(T, DIVS[di + 1], t);
  return ti < TIERS.length - 1 ? rankText(TIERS[ti + 1], "IV", t) : tierName("MASTER", t);
}

/* ----------------------------------------------------------------- carriles */

/** El punto ciego dicho como se dice en la partida: "La calle de arriba". */
export function laneTitle(lane: string, t: Translate): string {
  switch (lane.toLowerCase()) {
    case "top": return t("The top lane");
    case "mid": return t("The mid lane");
    case "bot": return t("The bottom lane");
    default: return lane;
  }
}

/** "Por encima del 40 % de los top": el percentil de impacto dentro de tu puesto. */
export function impactPhrase(role: string | null | undefined, p: number, t: Translate): string {
  switch (normalizePosition(role)) {
    case "TOP": return t("Above {p}% of top laners", { p });
    case "JUNGLE": return t("Above {p}% of junglers", { p });
    case "MIDDLE": return t("Above {p}% of mid laners", { p });
    case "BOTTOM": return t("Above {p}% of ADCs", { p });
    case "UTILITY": return t("Above {p}% of supports", { p });
    default: return t("Above {p}% of players in your role", { p });
  }
}

/** Nombre corto del puesto ya traducido: "Top", "Jungla", "Mid", "ADC", "Soporte". */
export function positionName(role: string | null | undefined, t: Translate): string | null {
  switch (normalizePosition(role)) {
    case "TOP": return t("Top");
    case "JUNGLE": return t("Jungle");
    case "MIDDLE": return t("Mid");
    case "BOTTOM": return t("ADC");
    case "UTILITY": return t("Support");
    default: return null;
  }
}
