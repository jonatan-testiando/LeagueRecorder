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
