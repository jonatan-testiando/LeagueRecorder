import { MatchMetadata, Participant } from "../../../types";
import { type KDA } from "../../../core/matchStats";
import type { Translate } from "../../../core/eventText";

/**
 * Lo que la lista de la biblioteca y su panel de detalle leen igual de una
 * partida. Vive aparte para que la fila y el panel no puedan decir dos cosas
 * distintas del mismo dato (el ratio de una, el rival de otra).
 */

/** El KDA guardado ("9/3/12") o el contado de los eventos, como números. */
export const kdaDe = (m: MatchMetadata, contado: KDA): KDA => {
  if (m.kda) {
    const [k, d, a] = m.kda.split("/").map((x) => parseInt(x, 10));
    if ([k, d, a].every(Number.isFinite)) return { kills: k, deaths: d, assists: a };
  }
  return contado;
};

/** Tu fila del marcador, si la partida está sincronizada. */
export const selfOf = (m: MatchMetadata): Participant | null =>
  m.participants?.find((p) => p.is_self) ?? null;

/**
 * El rival de tu ROL: Riot ordena 1-5 azul / 6-10 rojo por posición, así que
 * es el espejo de tu índice (el mismo truco que usa el backend para el gank y
 * el impacto). Solo con el marcador completo: con menos filas el espejo cae en
 * cualquiera.
 */
export const laneRival = (m: MatchMetadata): Participant | null => {
  const ps = m.participants;
  if (!ps || ps.length !== 10) return null;
  const i = ps.findIndex((p) => p.is_self);
  return i >= 0 ? ps[(i + 5) % 10] : null;
};

/** "+23 LP", "−17 LP" (signo menos tipográfico, no guion). */
export const lpText = (n: number): string =>
  `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n)} LP`;

/** Cifra con los decimales y la coma del idioma: "4,67" en español. */
export const fmtDec = (x: number, digits: number, lang: string): string =>
  x.toLocaleString(lang === "es" ? "es-ES" : "en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

/**
 * Tono del ratio KDA: jade desde 4, texto normal entre 3 y 4, apagado por
 * debajo. Sin muertes es "perfecto", que es lo mejor que hay.
 */
export type RatioTone = "high" | "mid" | "low";
export const ratioTone = (k: KDA): RatioTone => {
  if (k.deaths === 0) return "high";
  const r = (k.kills + k.assists) / k.deaths;
  return r >= 4 ? "high" : r >= 3 ? "mid" : "low";
};

/** El ratio para pintar: "4,67" o "Perfecto". */
export const ratioLabel = (k: KDA, t: Translate, lang: string): string =>
  k.deaths === 0 ? t("Perfect") : fmtDec((k.kills + k.assists) / k.deaths, 2, lang);

/**
 * Puesto de impacto como ordinal: "7th" / "7.º". El inglés necesita el sufijo
 * bueno, así que son cuatro claves; en español las cuatro dicen lo mismo.
 */
export const ordinal = (n: number, t: Translate): string => {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return t("{n}st", { n });
  if (d === 2 && dd !== 12) return t("{n}nd", { n });
  if (d === 3 && dd !== 13) return t("{n}rd", { n });
  return t("{n}th", { n });
};

/** Primera letra en mayúscula: las etiquetas van en tipo oración. */
export const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "18:32" de la fecha de la partida ("YYYY-MM-DD HH:MM:SS"). */
export const hourOf = (iso: string): string | null => {
  const m = /\s(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}:${m[2]}` : null;
};
