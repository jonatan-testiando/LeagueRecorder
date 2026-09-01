import { MatchMetadata } from "../types";
import { outcome } from "./matchStats";

/**
 * Agregación entre partidas.
 *
 * Es lo único de la app que mira más de una partida a la vez. Todo lo demás
 * —biblioteca, reproductor, errores— trabaja sobre una sola, y por eso datos
 * como "en qué minuto te mueres" llevaban meses en disco sin que nadie los
 * enseñara.
 *
 * Funciones puras sobre `MatchMetadata[]`: sin estado, sin IPC, sin React. Así
 * se pueden probar y reutilizar desde cualquier pantalla.
 */

/** Tamaño del tramo del reloj de muertes, en segundos. */
export const BUCKET_SECONDS = 300;

export interface DeathBucket {
  /** Minuto en que empieza el tramo. */
  from: number;
  /** Minuto en que acaba. */
  to: number;
  total: number;
  inWins: number;
  inLosses: number;
}

export interface DeathClock {
  buckets: DeathBucket[];
  total: number;
  /** Tramo con más muertes, o null si no hay ninguna. */
  peak: DeathBucket | null;
  wins: number;
  losses: number;
  deathsPerWin: number | null;
  deathsPerLoss: number | null;
}

const isDeath = (type: string, subtype?: string) =>
  type === "ChampionKill" && subtype === "death";

/* ========================================================================
   Rol / posición.
   ======================================================================== */

/** Clave normalizada de puesto. Riot dice "MIDDLE"/"BOTTOM"/"UTILITY"; la UI
 *  habla de mid/bot(ADC)/support. */
export type RoleKey = "top" | "jungle" | "mid" | "bot" | "support";

/** Filtro de rol de las pantallas: todos, o uno concreto. */
export type RoleFilter = "all" | RoleKey;

/** Orden y etiqueta de las píldoras de filtro, compartidos entre pantallas. */
export const ROLE_FILTERS: { key: RoleFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "top", label: "Top" },
  { key: "jungle", label: "Jungle" },
  { key: "mid", label: "Mid" },
  { key: "bot", label: "ADC" },
  { key: "support", label: "Support" },
];

/** "MIDDLE" → "mid", "UTILITY" → "support"… Acepta también los ya
 *  normalizados, y devuelve null para vacío o desconocido. */
export function normalizeRole(raw?: string | null): RoleKey | null {
  switch ((raw ?? "").trim().toUpperCase()) {
    case "TOP": return "top";
    case "JUNGLE": return "jungle";
    case "MIDDLE": case "MID": return "mid";
    case "BOTTOM": case "BOT": case "ADC": return "bot";
    case "UTILITY": case "SUPPORT": return "support";
    default: return null;
  }
}

/** El puesto en que se jugó una partida: el del participante `is_self`.
 *  Null si aún no está sincronizada o es anterior al campo. */
export function matchRole(m: MatchMetadata): RoleKey | null {
  const yo = m.participants?.find((p) => p.is_self);
  return normalizeRole(yo?.role);
}

/** Aplica el filtro de rol. Las partidas sin rol conocido solo aparecen en
 *  "all": meterlas en un rol concreto sería inventárselo. */
export function filterByRole(matches: MatchMetadata[], filter: RoleFilter): MatchMetadata[] {
  if (filter === "all") return matches;
  return matches.filter((m) => matchRole(m) === filter);
}

/**
 * En qué minuto de partida mueres, agregado.
 *
 * Los tiempos están en el eje del vídeo, que incluye la pantalla de carga. Se
 * descuenta `video_offset` cuando existe para que el tramo sea de reloj de
 * partida y no de reloj de grabación; sin él, una partida con 40 s de carga
 * desplazaría todas sus muertes casi un tramo entero.
 */
export function deathClock(matches: MatchMetadata[]): DeathClock {
  const counts = new Map<number, { total: number; w: number; l: number }>();
  let total = 0;
  let wins = 0;
  let losses = 0;
  let deathsInWins = 0;
  let deathsInLosses = 0;

  for (const m of matches) {
    const res = outcome(m.result);
    if (res === "victory") wins++;
    else if (res === "defeat") losses++;

    const offset = m.video_offset ?? 0;

    for (const ev of m.events) {
      if (!isDeath(ev.type, ev.subtype)) continue;
      const gameTime = Math.max(0, ev.time - offset);
      const from = Math.floor(gameTime / BUCKET_SECONDS) * (BUCKET_SECONDS / 60);
      const slot = counts.get(from) ?? { total: 0, w: 0, l: 0 };
      slot.total++;
      if (res === "victory") { slot.w++; deathsInWins++; }
      else if (res === "defeat") { slot.l++; deathsInLosses++; }
      counts.set(from, slot);
      total++;
    }
  }

  const buckets: DeathBucket[] = [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([from, v]) => ({
      from,
      to: from + BUCKET_SECONDS / 60,
      total: v.total,
      inWins: v.w,
      inLosses: v.l,
    }));

  const peak = buckets.reduce<DeathBucket | null>(
    (best, b) => (best === null || b.total > best.total ? b : best),
    null
  );

  return {
    buckets,
    total,
    peak,
    wins,
    losses,
    deathsPerWin: wins > 0 ? deathsInWins / wins : null,
    deathsPerLoss: losses > 0 ? deathsInLosses / losses : null,
  };
}

/**
 * Cuánta confianza merece una agregación.
 *
 * Con quince partidas una diferencia de dos muertes entre tramos no significa
 * nada, y una herramienta que la presenta como un hallazgo miente. La pantalla
 * usa esto para decir "indicio" en vez de "patrón" mientras la muestra sea
 * pequeña, en lugar de afirmar con la misma seguridad siempre.
 */
export type Confidence = "low" | "medium" | "good";

export function confidenceOf(sampleGames: number): Confidence {
  if (sampleGames < 15) return "low";
  if (sampleGames < 40) return "medium";
  return "good";
}

export interface CategoryCount {
  category: string;
  count: number;
}

/** Reparto de las categorías que tú mismo has marcado en tus errores. */
export function errorCategories(
  clips: { events?: { category: string }[] }[]
): CategoryCount[] {
  const counts = new Map<string, number>();
  for (const c of clips) {
    for (const e of c.events ?? []) {
      counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

export interface Focus {
  /** Tramo problemático. */
  bucket: DeathBucket;
  /** Porcentaje de todas tus muertes que caen ahí. */
  share: number;
  /** En cuántas partidas distintas ocurre. */
  games: number;
  confidence: Confidence;
}

/**
 * La debilidad en la que tocaría trabajar.
 *
 * Ahora mismo es simplemente el tramo con más muertes, que es la señal más
 * fuerte que hay con los datos que existen. Deliberadamente simple: es mejor
 * una regla que se entiende que una puntuación compuesta que nadie puede
 * discutir.
 */
export function currentFocus(matches: MatchMetadata[]): Focus | null {
  const clock = deathClock(matches);
  if (!clock.peak || clock.total === 0) return null;

  const { from, to } = clock.peak;
  let games = 0;
  for (const m of matches) {
    const offset = m.video_offset ?? 0;
    const hit = m.events.some((ev) => {
      if (!isDeath(ev.type, ev.subtype)) return false;
      const t = Math.max(0, ev.time - offset) / 60;
      return t >= from && t < to;
    });
    if (hit) games++;
  }

  return {
    bucket: clock.peak,
    share: clock.peak.total / clock.total,
    games,
    confidence: confidenceOf(matches.length),
  };
}

/* ========================================================================
   La escalera de rango y la predicción.
   ======================================================================== */

const TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND"];
const DIVS = ["IV", "III", "II", "I"];

/** Posición absoluta en la escalera: 100 LP por división, 400 por rango;
 *  Master+ es LP puro sobre el tope de Diamante I (2800). */
export function ladderLp(tier: string, division: string | null | undefined, lp: number): number {
  const ti = TIERS.indexOf(tier);
  if (ti < 0) return 2800 + lp; // MASTER / GRANDMASTER / CHALLENGER
  const di = Math.max(0, DIVS.indexOf(division ?? "IV"));
  return ti * 400 + di * 100 + lp;
}

/** La vuelta: de LP absoluto a rango legible. Por encima de 2800 se dice
 *  Master a secas — los cortes de GM/Challenger son de ladder, no de LP,
 *  y fingirlos sería mentir. */
export function ladderRank(abs: number): { tier: string; division: string | null; lp: number } {
  const a = Math.max(0, Math.round(abs));
  if (a >= 2800) return { tier: "MASTER", division: null, lp: a - 2800 };
  const ti = Math.min(6, Math.floor(a / 400));
  const resto = a - ti * 400;
  return { tier: TIERS[ti], division: DIVS[Math.min(3, Math.floor(resto / 100))], lp: resto % 100 };
}

export interface RankForecast {
  wins: number;
  losses: number;
  /** Winrate ponderado por recencia (las 10 últimas pesan doble). */
  wr: number;
  /** Nota media de rendimiento (estilo AI-Score), recencia ponderada. Null
   *  si las partidas no traen nota. */
  avgScore: number | null;
  /** LP netos por partida a este ritmo. */
  netPerGame: number;
  pred: { tier: string; division: string | null; lp: number };
}

/**
 * Proyección de rango a 20 partidas vista, estilo deeplol pero sin humo.
 *
 * Dos señales, no una — que era lo simplista que señaló el usuario:
 *  - lo que PASÓ: winrate reciente (recencia ponderada, las 10 últimas doble);
 *  - lo que MERECIÓ pasar: la nota media de rendimiento dentro de cada lobby
 *    (estilo AI-Score). La nota es un percentil entre los 10 de la partida,
 *    así que /100 ya es una probabilidad de "juegas como quien gana".
 * Se mezclan 60/40 — el marcador manda, el juego corrige: quien pierde
 * jugando como el mejor del lobby proyecta subir; quien gana siendo llevado,
 * menos de lo que dice su racha. LP por partida de los deltas medidos.
 * Con menos de 8 partidas no hay forma que proyectar: null.
 */
export function forecastRank(
  games: { win: boolean; score?: number }[],
  tier: string | null | undefined,
  division: string | null | undefined,
  lp: number | null | undefined,
  avgGain: number | null | undefined,
  avgLoss: number | null | undefined
): RankForecast | null {
  if (!tier || lp == null || games.length < 8) return null;
  let ganadas = 0;
  let total = 0;
  let nota = 0;
  let notaPeso = 0;
  games.forEach((g, i) => {
    const peso = i < 10 ? 2 : 1; // recientes primero: la forma de AHORA
    total += peso;
    if (g.win) ganadas += peso;
    if (g.score != null && g.score > 0) {
      nota += g.score * peso;
      notaPeso += peso;
    }
  });
  const wr = ganadas / total;
  const avgScore = notaPeso >= 8 ? nota / notaPeso : null;
  const wrEfectiva = avgScore != null ? 0.6 * wr + 0.4 * (avgScore / 100) : wr;
  const gain = avgGain ?? 25;
  const loss = avgLoss ?? 25;
  const net = wrEfectiva * gain - (1 - wrEfectiva) * loss;
  const abs = ladderLp(tier, division, lp) + net * 20;
  const wins = games.filter((g) => g.win).length;
  return { wins, losses: games.length - wins, wr, avgScore, netPerGame: net, pred: ladderRank(abs) };
}
