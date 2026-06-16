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

/** Ratio KDA = (K + A) / D (o perfecto si no hay muertes). */
export function kdaRatio(kda: KDA): string {
  if (kda.deaths === 0) return "Perfecto";
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
