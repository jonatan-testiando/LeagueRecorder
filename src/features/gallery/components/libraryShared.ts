import { MatchMetadata, Participant } from "../../../types";
import { type KDA } from "../../../core/matchStats";
import type { Translate } from "../../../core/eventText";
import type { MatchPlays, Play } from "../../../core/tauri-ipc";
import type { Moment } from "../../player/components/ReviewQueue";

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

/* ---------------------------------------------------------------- fechas */

const localeOf = (lang: string): string => (lang === "es" ? "es-ES" : "en-US");

const fechaDe = (iso: string): Date | null => {
  const d = new Date(iso.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Días naturales entre la fecha y hoy (0 = hoy, 1 = ayer). */
const diasAtras = (d: Date): number => {
  const inicio = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((inicio(new Date()) - inicio(d)) / 86400000);
};

/**
 * Encabezado de un grupo de la lista: «Hoy», «Ayer» o el día con nombre,
 * «Sábado, 5 sept» / «Saturday, Sep 5» (con el año si no es el actual).
 *
 * No es `relativeDay`: ese dice «hace 3d», que sirve en una frase pero no
 * como rótulo de un grupo, donde se busca el día y no la distancia.
 */
export const dayLabel = (iso: string, t: Translate, lang: string): string => {
  const d = fechaDe(iso);
  if (!d) return iso.split(" ")[0];
  const n = diasAtras(d);
  if (n <= 0) return cap(t("today"));
  if (n === 1) return cap(t("yesterday"));
  return cap(
    new Intl.DateTimeFormat(localeOf(lang), {
      weekday: "long",
      day: "numeric",
      month: "short",
      year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    }).format(d)
  );
};

/**
 * El día en corto para una línea de metadatos: «hoy 18:32», «ayer 21:10» y,
 * más atrás, «sáb 5 sept» / «Sat Sep 5», donde la hora ya no ubica.
 */
export const shortDay = (iso: string, t: Translate, lang: string): string => {
  const d = fechaDe(iso);
  if (!d) return iso.split(" ")[0];
  const n = diasAtras(d);
  const hora = hourOf(iso);
  if (n <= 1) {
    const dia = t(n <= 0 ? "today" : "yesterday");
    return hora ? `${dia} ${hora}` : dia;
  }
  return new Intl.DateTimeFormat(localeOf(lang), {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  })
    .formatToParts(d)
    .filter((p) => p.type !== "literal")
    .map((p) => p.value)
    .join(" ");
};

/* ------------------------------------------- ΔWP de un momento por revisar */

/**
 * Cuánto pueden separarse la hora de un suceso grabado (eje del vídeo) y la de
 * su jugada en la timeline de Riot (eje de la partida), ya descontado el
 * desfase. Las muertes usan los 3 s de «Tus muertes»; los objetivos llegan
 * por la API en directo con algo más de holgura.
 */
const MISMA_JUGADA_S = 3;
const MISMO_OBJETIVO_S = 6;

/** Suceso grabado → tipo de jugada de `winprob.rs`. */
const JUGADA_DE: Record<string, string> = {
  DragonKill: "dragon",
  BaronKill: "baron",
  HeraldKill: "herald",
  TowerKill: "tower",
  InhibKill: "inhibitor",
};

/**
 * Lo que un momento de la cola movió TU probabilidad de victoria (−0,06 =
 * «−6 %»), o null si no se sabe.
 *
 * No se inventa: sale de la jugada de Riot que cae en el mismo instante
 * (`get_match_plays`), y solo para lo que tiene jugada propia: tus muertes
 * (víctima = tú) y los objetivos y estructuras. Un error marcado a mano o un
 * salto de cámara no son jugadas y se quedan sin cifra.
 */
export const momentWpa = (
  m: Moment,
  plays: MatchPlays | null | undefined,
  videoOffset: number,
  myTeam: number | null
): number | null => {
  if (!plays || myTeam == null || m.source !== "event") return null;
  const [origen, , type = "", subtype = ""] = m.id.split(":");
  if (origen !== "event") return null;

  let es: (p: Play) => boolean;
  let tol = MISMA_JUGADA_S;
  if (type === "ChampionKill" && subtype === "death") {
    const yo = plays.self_participant_id;
    if (yo == null) return null;
    es = (p) => (p.kind === "kill" || p.kind === "execution") && p.victim === yo;
  } else if (JUGADA_DE[type]) {
    const kind = JUGADA_DE[type];
    es = (p) => p.kind === kind;
    tol = MISMO_OBJETIVO_S;
  } else {
    return null;
  }

  let mejor: Play | null = null;
  let dist = Infinity;
  for (const p of plays.plays) {
    if (!es(p)) continue;
    const d = Math.abs(p.time + videoOffset - m.time);
    if (d <= tol && d < dist) {
      mejor = p;
      dist = d;
    }
  }
  if (!mejor) return null;
  // `wpa` va desde la óptica de `team_id`: se gira si la jugada es del rival.
  return mejor.team_id === myTeam ? mejor.wpa : -mejor.wpa;
};

/**
 * «−6 %», «+5 %», «−0,4 %»: el ΔWP en puntos, entero salvo por debajo de 1,
 * con el signo siempre a la vista (menos tipográfico) y el espacio fino antes
 * del % en español.
 */
export const wpaText = (delta: number, lang: string): string => {
  const pct = delta * 100;
  const digits = Math.abs(pct) < 0.95 ? 1 : 0;
  const r = Number(pct.toFixed(digits));
  const sign = r > 0 ? "+" : r < 0 ? "−" : "±";
  return `${sign}${fmtDec(Math.abs(r), digits, lang)}${lang === "es" ? " %" : "%"}`;
};
