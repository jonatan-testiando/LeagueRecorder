import { MatchEvent } from "../types";

export interface KDA {
  kills: number;
  deaths: number;
  assists: number;
}

/** Cuenta K/D/A del jugador a partir de los eventos de la partida. */
export function computeKDA(events: MatchEvent[]): KDA {
  let kills = 0, deaths = 0, assists = 0;
  for (const e of events) {
    if (e.type === "ChampionKill") {
      if (e.subtype === "kill") kills++;
      else if (e.subtype === "death") deaths++;
      else if (e.subtype === "assist") assists++;
    }
  }
  return { kills, deaths, assists };
}

/**
 * Ratio KDA = (K + A) / D.
 *
 * Sin muertes no hay ratio, y ahí devuelve la CLAVE en inglés ("Perfect"), no
 * el texto ya en español: esta función no sabe en qué idioma está la interfaz.
 * Quien la pinta la pasa por `t()`; para el resto de valores (una cifra) `t()`
 * devuelve la propia cifra.
 */
export function kdaRatio(kda: KDA): string {
  if (kda.deaths === 0) return "Perfect";
  return ((kda.kills + kda.assists) / kda.deaths).toFixed(2);
}

/** Cuenta objetivos relevantes (dragones, barones, heraldos tomados por tu equipo). */
export function countObjectives(events: MatchEvent[]): number {
  return events.filter(
    (e) => (e.type === "DragonKill" || e.type === "BaronKill" || e.type === "HeraldKill") && e.subtype === "ally"
  ).length;
}

export type Outcome = "victory" | "defeat" | "unknown";

export function outcome(result: string): Outcome {
  const r = result.toLowerCase();
  if (r.includes("vict") || r.includes("win")) return "victory";
  if (r.includes("defe") || r.includes("lose") || r.includes("derrot")) return "defeat";
  return "unknown";
}

/** Iniciales del campeón para el avatar tipo monograma. */
export function championInitials(champion: string): string {
  const clean = champion.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ' ]/g, "").trim();
  if (!clean || clean.toLowerCase() === "unknown") return "?";
  const parts = clean.split(/[\s']+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Posición en una escalera continua de LP: cada división son 100 y Maestro,
 * Gran Maestro y Aspirante comparten la misma cuenta desde el final de
 * Diamante I. Así la resta vale también al cruzar un ascenso o un descenso
 * (de Diamante I 90 a Maestro 16 son +26). null si el rango no se reconoce.
 */
const LADDER_TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND"];
const LADDER_DIVS = ["IV", "III", "II", "I"];
function ladderLp(tier?: string | null, division?: string | null, lp?: number | null): number | null {
  if (lp == null || !tier) return null;
  const T = tier.toUpperCase();
  if (T === "MASTER" || T === "GRANDMASTER" || T === "CHALLENGER") return LADDER_TIERS.length * 400 + lp;
  const ti = LADDER_TIERS.indexOf(T);
  const di = LADDER_DIVS.indexOf((division ?? "").toUpperCase());
  return ti < 0 || di < 0 ? null : ti * 400 + di * 100 + lp;
}

/** Más que esto en una partida no lo da ni lo quita LoL: entre medias hubo
 *  partidas sin grabar y la resta sería de varias. */
const MAX_LP_PER_GAME = 60;

/**
 * LP que dio o quitó cada partida: la resta con la partida anterior que tenga
 * rango guardado, sobre la escalera continua (`ladderLp`).
 *
 * Solo se apunta lo que es de verdad el LP de ESA partida, para que lo que se
 * enseñe lleve siempre signo («+20 LP», «−18 LP»):
 *  - solo en Solo/Dúo (420), que es el rango que se guarda; una normal o una
 *    flexible no te mueve ese LP, aunque la partida lleve el rango estampado;
 *  - nada con 0: el rango se estampa al sincronizar, y las partidas viejas se
 *    estamparon todas con el de un mismo día (`riot_api.rs`), así que un 0 es
 *    «no se sabe», no «no te movió»;
 *  - nada de más de ±60: hubo partidas sin grabar entre medias.
 * Devuelve un mapa id → delta; las partidas sin dato no están, y quien pinta
 * NO pone en su lugar el LP absoluto: «Victoria 16 LP» al lado de «+20 LP» se
 * leía como una ganancia.
 *
 * Vivía dentro de la biblioteca, que era el único sitio que lo pintaba. "Hoy"
 * necesita exactamente el mismo número para la última partida, y copiarlo era
 * garantizar que un día dijeran cosas distintas del mismo dato.
 */
export function lpDeltas(
  matches: {
    id: string;
    date: string;
    queue?: number;
    rank_lp?: number | null;
    rank_tier?: string | null;
    rank_division?: string | null;
  }[]
): Map<string, number> {
  const orden = matches
    .map((m) => ({ m, pos: ladderLp(m.rank_tier, m.rank_division, m.rank_lp) }))
    .filter((x): x is { m: (typeof matches)[number]; pos: number } => x.pos != null)
    .sort((a, b) => (a.m.date < b.m.date ? -1 : 1));
  const out = new Map<string, number>();
  for (let i = 1; i < orden.length; i++) {
    const cur = orden[i];
    if (cur.m.queue != null && cur.m.queue !== 420) continue;
    const d = cur.pos - orden[i - 1].pos;
    if (d !== 0 && Math.abs(d) <= MAX_LP_PER_GAME) out.set(cur.m.id, d);
  }
  return out;
}

/**
 * queueId de Riot → CLAVE del nombre de la cola. Se traduce al pintar (y al
 * buscar): las entradas viven en i18n.ts.
 *
 * Estaba dentro de la biblioteca, que era quien la pintaba. "Hoy" enseña ahora
 * la última partida con su cola, y una segunda tabla de colas era la forma
 * segura de que dentro de un mes una pantalla dijera "Clasificatoria" y la otra
 * "Otra cola" del mismo 420.
 */
export const queueKey = (q?: number): string => {
  switch (q) {
    case 420: return "Ranked Solo/Duo";
    case 440: return "Ranked Flex";
    case 400: return "Normal Draft";
    case 430: return "Normal Blind";
    case 490: return "Normal";
    case 450: return "ARAM";
    case 700: return "Clash";
    case 830: case 840: case 850: return "Co-op vs AI";
    case 900: case 1010: case 1900: return "URF";
    case 0: return "Custom";
    // "Synced" decía de dónde salió el dato, no qué partida es: una cola que no
    // reconocemos es otra cola, y eso es lo que hay que poner.
    default: return "Other queue";
  }
};
