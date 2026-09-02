/**
 * Cómo se escribe un baremo de población.
 *
 * Las tablas viven aquí y no dentro de la tarjeta que las usa porque hay dos
 * sitios que enseñan lo mismo con formas distintas: la sección "Frente a tu
 * rango" del reproductor (una partida) y la de Patrones (la media de varias).
 * Si cada una se inventa sus etiquetas, la misma métrica acaba llamándose de
 * dos maneras en la misma app — y en español, de tres.
 *
 * Lo único que hay que respetar al pintar: el `percentile` que manda el backend
 * es SIEMPRE el crudo, también donde lo bueno es tener menos. En
 * `deaths_per_game` un 90 significa "mueres más que el 90%". Para eso está
 * [`effectivePercentile`]: devuelve el percentil tal y como se LEE, con el 100
 * siempre en el lado bueno.
 */

import { roleLabel } from "./roles";
import type { MetricComparison } from "./tauri-ipc";

/**
 * Los tres tramos del baremo, con la etiqueta que se enseña.
 *
 * Los nombres de los tramos y qué rangos caen en cada uno los define
 * `src-tauri/src/benchmarks.rs`: bajo = Hierro/Bronce/Plata, medio =
 * Oro/Platino/Esmeralda (ojo con el Oro, que va en medio), alto = Diamante y
 * arriba. Las claves internas siguen siendo las suyas; esto es sólo el rótulo.
 */
export const BAND_LABELS: Record<string, string> = {
  bajo: "Iron–Silver",
  medio: "Gold–Emerald",
  alto: "Diamond+",
};

/** Etiqueta del tramo (clave de i18n), o null si no se conoce el rango. */
export const bandLabel = (bucket?: string | null): string | null =>
  bucket ? BAND_LABELS[bucket] ?? null : null;

/** Cómo se escribe el valor de cada métrica. */
export type MetricFmt = "rate1" | "rate0" | "pct" | "diff" | "int";

export interface MetricMeta {
  /** Etiqueta de la fila (clave de i18n). */
  label: string;
  /** Nombre corto para los resúmenes en prosa ("fuerte: visión, …"). */
  short: string;
  fmt: MetricFmt;
}

/**
 * Las 17 métricas del baremo. Las claves son las de `benchmarks.rs`.
 *
 * `rate0` para las tasas que van en cientos (oro, daño): un decimal ahí no
 * informa de nada y sólo alarga la cifra.
 */
export const METRIC_META: Record<string, MetricMeta> = {
  cs_per_min: { label: "CS / min", short: "CS", fmt: "rate1" },
  kill_participation: { label: "Kill participation", short: "kill participation", fmt: "pct" },
  deaths_per_game: { label: "Deaths", short: "deaths", fmt: "int" },
  kda: { label: "KDA", short: "KDA", fmt: "rate1" },
  gold_per_min: { label: "Gold / min", short: "gold", fmt: "rate0" },
  damage_per_min: { label: "Damage / min", short: "damage", fmt: "rate0" },
  damage_share: { label: "Damage share", short: "damage share", fmt: "pct" },
  vision_score_per_min: { label: "Vision / min", short: "vision", fmt: "rate1" },
  wards_per_min: { label: "Wards / min", short: "wards", fmt: "rate1" },
  control_wards: { label: "Control wards", short: "control wards", fmt: "int" },
  gold_diff_15: { label: "Gold @15", short: "gold @15", fmt: "diff" },
  xp_diff_15: { label: "XP @15", short: "XP @15", fmt: "diff" },
  cs_diff_15: { label: "CS @15", short: "CS @15", fmt: "diff" },
  solo_kills: { label: "Solo kills", short: "solo kills", fmt: "int" },
  turret_damage_per_min: { label: "Turret damage / min", short: "turret damage", fmt: "rate0" },
  kills_per_game: { label: "Kills", short: "kills", fmt: "int" },
  assists_per_game: { label: "Assists", short: "assists", fmt: "int" },
};

/** Etiqueta de la métrica (clave de i18n). La propia clave si es desconocida. */
export const metricLabel = (metric: string): string =>
  METRIC_META[metric]?.label ?? metric;

/** Nombre corto de la métrica, para meterla dentro de una frase. */
export const metricShort = (metric: string): string =>
  METRIC_META[metric]?.short ?? metric;

/**
 * El valor, escrito.
 *
 * `int` se escribe con decimal cuando lo tiene: en una partida "8 muertes" es
 * entero, pero la media de veinte es 6,4 y redondearla a 6 se come justo la
 * diferencia que la fila existe para enseñar.
 */
export const formatMetricValue = (metric: string, value: number): string => {
  switch (METRIC_META[metric]?.fmt ?? "rate1") {
    case "pct":
      return `${Math.round(value * 100)}%`;
    case "diff":
      // El signo se enseña siempre: un "@15" sin signo no se puede leer.
      return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(Math.round(value))}`;
    case "rate0":
      return String(Math.round(value));
    case "int":
      return Number.isInteger(value) ? String(value) : value.toFixed(1);
    default:
      return value.toFixed(1);
  }
};

/** El percentil tal y como hay que LEERLO: 100 = mejor, siempre. */
export const effectivePercentile = (c: MetricComparison): number | null =>
  c.percentile == null ? null : c.lower_is_better ? 100 - c.percentile : c.percentile;

/**
 * En qué orden importan las métricas según el puesto.
 *
 * No es cosmético: la lista es larga y lo primero que se lee decide si merece
 * la pena seguir bajando. A un support el CS/min le sobra arriba y la visión le
 * falta; a un carril es justo al revés.
 */
export const ORDER_LANE: string[] = [
  "cs_per_min", "gold_diff_15", "xp_diff_15", "cs_diff_15", "damage_per_min",
  "solo_kills", "deaths_per_game", "kill_participation", "damage_share", "kda",
  "gold_per_min", "turret_damage_per_min", "vision_score_per_min", "wards_per_min",
  "control_wards", "kills_per_game", "assists_per_game",
];

const ORDER_JUNGLE: string[] = [
  "kill_participation", "cs_per_min", "gold_diff_15", "deaths_per_game", "damage_share",
  "vision_score_per_min", "kda", "damage_per_min", "gold_per_min", "kills_per_game",
  "assists_per_game", "turret_damage_per_min", "wards_per_min", "control_wards",
  "solo_kills", "xp_diff_15", "cs_diff_15",
];

const ORDER_SUPPORT: string[] = [
  "vision_score_per_min", "wards_per_min", "control_wards", "kill_participation",
  "deaths_per_game", "assists_per_game", "kda", "damage_share", "gold_per_min",
  "damage_per_min", "gold_diff_15", "xp_diff_15", "kills_per_game", "cs_per_min",
  "solo_kills", "turret_damage_per_min", "cs_diff_15",
];

/**
 * El orden de relevancia de un puesto. Acepta los dos vocabularios (el de Riot,
 * "UTILITY", y el de la app, "support"): lo normaliza [`roleLabel`].
 */
export const metricOrder = (role?: string | null): string[] => {
  switch (roleLabel(role)) {
    case "Jungle": return ORDER_JUNGLE;
    case "Support": return ORDER_SUPPORT;
    default: return ORDER_LANE;
  }
};

/**
 * Ordena claves de métrica por relevancia para un puesto. Las que no estén en
 * la lista van al final, en el orden en que llegaron.
 */
export const sortByRelevance = <T extends { metric: string }>(
  rows: T[],
  role?: string | null
): T[] => {
  const orden = metricOrder(role);
  const peso = (m: string) => {
    const i = orden.indexOf(m);
    return i < 0 ? orden.length : i;
  };
  return [...rows].sort((a, b) => peso(a.metric) - peso(b.metric));
};
