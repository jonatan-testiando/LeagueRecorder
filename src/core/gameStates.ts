import { useEffect, useState } from "react";
import type { MatchMetadata } from "../types";
import { getGameStates, type GameState, type GameStateCorpus, type GameStates, type LaneState } from "./tauri-ipc";
import { computeKDA } from "./matchStats";
import { useAppStore } from "../store/useAppStore";

/**
 * Por delante, igualada o por detrás; tiradas y remontadas; y la nota frente
 * al resultado (filas 3.3 y 3.4 del coach, `estado_partida.rs`).
 *
 * El backend da cada partida ya clasificada (su estado al 14 y si fue tirada o
 * remontada) y las líneas del corpus. Aquí sólo se cuenta, sobre las partidas
 * que dejan pasar los filtros de Patrones: la regla de cada partida se decide
 * y se prueba en Rust, no aquí.
 */

export const LANE_STATES: LaneState[] = ["ahead", "even", "behind"];
const INDICE: Record<LaneState, number> = { ahead: 0, even: 1, behind: 2 };

/** El estado y el rumbo de tus partidas. Como `useCoachSummary`: se vuelve a
 *  pedir al refrescarse la biblioteca; `undefined` mientras carga y `null` si
 *  falló. */
export function useGameStates(): GameStates | null | undefined {
  const matches = useAppStore((s) => s.matches);
  const [data, setData] = useState<GameStates | null | undefined>(undefined);
  useEffect(() => {
    let vivo = true;
    getGameStates()
      .then((d) => vivo && setData(d))
      .catch(() => vivo && setData(null));
    return () => {
      vivo = false;
    };
  }, [matches]);
  return data;
}

/** Una fila de la tabla por estado. */
export interface StateRow {
  state: LaneState;
  games: number;
  wins: number;
  /** Muertes por partida (las del directo, como la cabecera de Patrones). */
  deathsPerGame: number | null;
  /** Lo que ganaría el corpus con tu misma mezcla de roles en ese estado. */
  corpusWin: number | null;
}

/** Las tres filas, en orden, sobre las partidas que tengan estado. */
export function stateRows(matches: MatchMetadata[], byId: Map<string, GameState>, corpus: GameStateCorpus): StateRow[] {
  const acc = LANE_STATES.map((state) => ({ state, games: 0, wins: 0, deaths: 0, corpus: 0, conCorpus: 0 }));
  for (const m of matches) {
    const g = byId.get(m.id);
    if (!g?.state) continue;
    const fila = acc[INDICE[g.state]];
    fila.games += 1;
    fila.wins += g.win ? 1 : 0;
    fila.deaths += computeKDA(m.events).deaths;
    const linea = corpus.win_by_state[g.role];
    if (linea) {
      fila.corpus += linea[INDICE[g.state]];
      fila.conCorpus += 1;
    }
  }
  return acc.map((f) => ({
    state: f.state,
    games: f.games,
    wins: f.wins,
    deathsPerGame: f.games > 0 ? f.deaths / f.games : null,
    // Una línea a medias (alguna partida de un rol sin baremo) no se compara.
    corpusWin: f.games > 0 && f.conCorpus === f.games ? f.corpus / f.games : null,
  }));
}

/** Las tiradas y las remontadas de un conjunto de partidas. */
export interface CourseRates {
  /** Partidas con curva (de 15 minutos o más, con jugadas). */
  measured: number;
  /** Las que tuviste al 65 % o más, y de ellas las que perdiste. */
  withLead: number;
  thrown: GameState[];
  /** Las que tuviste al 35 % o menos, y de ellas las que ganaste. */
  behind: number;
  comebacks: GameState[];
  /** La tasa de vuelco del corpus para tu franja más frecuente. */
  corpusFlip: number | null;
}

/**
 * Misma cuenta que `Tasas` en las pruebas de `estado_partida.rs`: la tasa es
 * sobre las partidas en que se dio la condición, no sobre todas.
 */
export function courseRates(matches: MatchMetadata[], byId: Map<string, GameState>, corpus: GameStateCorpus): CourseRates {
  const out: CourseRates = { measured: 0, withLead: 0, thrown: [], behind: 0, comebacks: [], corpusFlip: null };
  const franjas = new Map<string, number>();
  for (const m of matches) {
    const g = byId.get(m.id);
    if (!g?.course) continue;
    out.measured += 1;
    if (g.course.had_lead) out.withLead += 1;
    if (g.course.thrown) out.thrown.push(g);
    if (g.course.was_behind) out.behind += 1;
    if (g.course.comeback) out.comebacks.push(g);
    const b = m.tier_bucket ?? "";
    franjas.set(b, (franjas.get(b) ?? 0) + 1);
  }
  // La franja que más se repite; si el corpus no la tiene, el corpus entero.
  const mayor = [...franjas.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  out.corpusFlip = corpus.flip[mayor] ?? corpus.flip[""] ?? null;
  return out;
}

/** Un tramo de nota (`impact_percentile`): de `from` a `to`. */
export interface ScoreBin {
  from: number;
  to: number;
  games: number;
  wins: number;
  /** Lo que gana el corpus en ese tramo. */
  corpus: number;
}

export interface ScoreCalibration {
  bins: ScoreBin[];
  /** Partidas en que saliste MVP (el mejor percentil de los diez). */
  mvpGames: number;
  mvpWins: number;
  corpusMvp: number;
  /** Partidas con nota. */
  games: number;
}

/**
 * Tu winrate por tramo de nota frente al corpus. Sólo las partidas que el
 * backend midió (de la Grieta, de 15 minutos o más), igual que el corpus.
 */
export function scoreCalibration(
  matches: MatchMetadata[],
  byId: Map<string, GameState>,
  corpus: GameStateCorpus
): ScoreCalibration {
  const n = corpus.win_by_score.length || 5;
  const paso = 100 / n;
  const bins: ScoreBin[] = Array.from({ length: n }, (_, i) => ({
    from: i * paso,
    to: (i + 1) * paso,
    games: 0,
    wins: 0,
    corpus: corpus.win_by_score[i] ?? 0,
  }));
  let mvpGames = 0;
  let mvpWins = 0;
  let games = 0;
  for (const m of matches) {
    const g = byId.get(m.id);
    if (!g?.course || m.impact_percentile == null) continue;
    games += 1;
    const b = bins[Math.min(n - 1, Math.max(0, Math.floor(m.impact_percentile / paso)))];
    b.games += 1;
    b.wins += g.win ? 1 : 0;
    if (m.impact_rank === 1) {
      mvpGames += 1;
      mvpWins += g.win ? 1 : 0;
    }
  }
  return { bins, mvpGames, mvpWins, corpusMvp: corpus.mvp_win, games };
}
