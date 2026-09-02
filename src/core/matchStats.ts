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
 * LP que dio o quitó cada partida: la resta con la clasificatoria anterior.
 *
 * Solo entre partidas del mismo rango y división: cruzar un ascenso o un
 * descenso haría mentir a la resta (de Esmeralda IV 8 LP a Esmeralda III 75
 * no son +67). Devuelve un mapa id → delta; las partidas sin anterior
 * comparable simplemente no están.
 *
 * Vivía dentro de la biblioteca, que era el único sitio que lo pintaba. "Hoy"
 * necesita exactamente el mismo número para la última partida, y copiarlo era
 * garantizar que un día dijeran cosas distintas del mismo dato.
 */
export function lpDeltas(
  matches: { id: string; date: string; rank_lp?: number | null; rank_tier?: string | null; rank_division?: string | null }[]
): Map<string, number> {
  const orden = matches
    .filter((m) => m.rank_lp != null)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const out = new Map<string, number>();
  for (let i = 1; i < orden.length; i++) {
    const ant = orden[i - 1];
    const cur = orden[i];
    if (ant.rank_tier === cur.rank_tier && ant.rank_division === cur.rank_division) {
      out.set(cur.id, (cur.rank_lp as number) - (ant.rank_lp as number));
    }
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
