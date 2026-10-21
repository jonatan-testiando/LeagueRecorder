import { useEffect, useState } from "react";
import { getMatchTitles, type PlayerTitle } from "./tauri-ipc";
import { formatMetricValue, metricLabel } from "./benchmarkFormat";

/**
 * El texto de los títulos del marcador (fila 3.6 del coach). Qué métrica le
 * toca a cada jugador lo decide `titulos.rs`; aquí sólo se nombra.
 *
 * Las claves son `métrica:lado` y tienen que cubrir `TITULOS` de `titulos.rs`
 * entero: una que falte sale como «Sin estridencias» y miente.
 *
 * Los títulos nombran la jugada o el rasgo, no a la persona («Mina de oro»,
 * no «El banquero»): en español el sustantivo de agente lleva género, y del
 * marcador no se sabe quién es nadie.
 */
const TITLES: Record<string, string> = {
  "kill_participation:low": "The ghost",
  "jungler_deaths:high": "Jungler's prey",
  "deaths_per_game:high": "Gold bag",
  "deaths_per_game:low": "Hard to kill",
  "gold_diff_15:high": "Owned the lane",
  "gold_diff_15:low": "Lost the lane",
  "damage_share:high": "Carried the damage",
  "kill_participation:high": "In every fight",
  "vision_score_per_min:high": "The lighthouse",
  "vision_score_per_min:low": "In the dark",
  "solo_kills:high": "Duelist",
  "turret_damage_per_min:high": "Demolition crew",
  "cs_per_min:high": "The harvester",
  "cs_per_min:low": "Allergic to minions",
  "damage_per_min:high": "The artillery",
  "damage_per_min:low": "Pacifist",
  "kda:high": "Surgical",
  "kda:low": "Rough night",
  "xp_diff_15:high": "A level up",
  "xp_diff_15:low": "Starved of XP",
  "cs_diff_15:high": "Won the farm",
  "cs_diff_15:low": "Lost the farm",
  "gold_per_min:high": "Gold mine",
  "gold_per_min:low": "Empty pockets",
  "kills_per_game:high": "Trigger-happy",
  "assists_per_game:high": "Assist machine",
  "wards_per_min:high": "Eyes everywhere",
  "control_wards:high": "Paranoia",
  "damage_share:low": "Along for the ride",
};

/** Sin ningún extremo. */
export const NO_TITLE = "Steady game";

/** Lo que sale bien o mal en un título, para su tono. Las muertes van al
 *  revés: morir mucho es el lado alto. */
const BAD = new Set([
  "kill_participation:low",
  "jungler_deaths:high",
  "deaths_per_game:high",
  "gold_diff_15:low",
  "vision_score_per_min:low",
  "cs_per_min:low",
  "damage_per_min:low",
  "kda:low",
  "xp_diff_15:low",
  "cs_diff_15:low",
  "gold_per_min:low",
  "damage_share:low",
]);

/** Etiquetas de las métricas que no están en el baremo de `benchmarkFormat`. */
const EXTRA_LABEL: Record<string, string> = {
  jungler_deaths: "Deaths with the enemy jungler",
};

export interface TitleView {
  /** Clave de i18n. */
  title: string;
  tone: "good" | "bad" | "none";
  /** Etiqueta de la métrica (clave de i18n) y su valor ya escrito. */
  metric: string | null;
  value: string | null;
  percentile: number | null;
}

export function titleView(p: PlayerTitle): TitleView {
  if (!p.metric || !p.side) return { title: NO_TITLE, tone: "none", metric: null, value: null, percentile: null };
  const key = `${p.metric}:${p.side}`;
  return {
    title: TITLES[key] ?? NO_TITLE,
    tone: BAD.has(key) ? "bad" : "good",
    metric: EXTRA_LABEL[p.metric] ?? metricLabel(p.metric),
    // Las de fuera del baremo son recuentos: «6», no «6,0».
    value: p.value == null ? null : p.metric in EXTRA_LABEL ? String(Math.round(p.value)) : formatMetricValue(p.metric, p.value),
    percentile: p.percentile == null ? null : Math.round(p.percentile),
  };
}

/** Los títulos de una partida, por `participant_id`. Se piden sólo con
 *  `enabled` (el marcador abierto): leen la partida entera de Riot. */
export function useMatchTitles(matchId: string, enabled: boolean): Map<number, PlayerTitle> | null {
  const [data, setData] = useState<{ id: string; m: Map<number, PlayerTitle> } | null>(null);
  useEffect(() => {
    if (!enabled || data?.id === matchId) return;
    let vivo = true;
    getMatchTitles(matchId)
      .then((ts) => vivo && setData({ id: matchId, m: new Map(ts.map((x) => [x.participant_id, x])) }))
      .catch(() => vivo && setData({ id: matchId, m: new Map() }));
    return () => {
      vivo = false;
    };
  }, [matchId, enabled, data?.id]);
  return data?.id === matchId ? data.m : null;
}
