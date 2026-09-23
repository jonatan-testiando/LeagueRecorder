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
  /**
   * La palanca, dicha como lo que harías ("farming better"): remata la frase
   * "Where you gain most: …" de la tarjeta de Patrones. Sin ella, la métrica
   * no se propone como palanca (kills y asistencias no traen percentil).
   */
  lever?: string;
}

/**
 * Las 17 métricas del baremo. Las claves son las de `benchmarks.rs`.
 *
 * `rate0` para las tasas que van en cientos (oro, daño): un decimal ahí no
 * informa de nada y sólo alarga la cifra.
 */
export const METRIC_META: Record<string, MetricMeta> = {
  cs_per_min: { label: "CS / min", short: "CS", fmt: "rate1", lever: "farming better" },
  kill_participation: { label: "Kill participation", short: "kill participation", fmt: "pct", lever: "joining more of your team's fights" },
  deaths_per_game: { label: "Deaths", short: "deaths", fmt: "int", lever: "dying less" },
  kda: { label: "KDA", short: "KDA", fmt: "rate1", lever: "trading better in fights" },
  gold_per_min: { label: "Gold / min", short: "gold", fmt: "rate0", lever: "earning more gold" },
  damage_per_min: { label: "Damage / min", short: "damage", fmt: "rate0", lever: "dealing more damage" },
  damage_share: { label: "Damage share", short: "damage share", fmt: "pct", lever: "a bigger share of your team's damage" },
  vision_score_per_min: { label: "Vision / min", short: "vision", fmt: "rate1", lever: "more vision" },
  wards_per_min: { label: "Wards / min", short: "wards", fmt: "rate1", lever: "placing more wards" },
  control_wards: { label: "Control wards", short: "control wards", fmt: "int", lever: "buying control wards" },
  gold_diff_15: { label: "Gold @15", short: "gold @15", fmt: "diff", lever: "a stronger lane to minute 15" },
  xp_diff_15: { label: "XP @15", short: "XP @15", fmt: "diff", lever: "more experience by minute 15" },
  cs_diff_15: { label: "CS @15", short: "CS @15", fmt: "diff", lever: "out-farming your lane opponent" },
  solo_kills: { label: "Solo kills", short: "solo kills", fmt: "int", lever: "winning more one-on-ones" },
  turret_damage_per_min: { label: "Turret damage / min", short: "turret damage", fmt: "rate0", lever: "hitting towers more" },
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
/**
 * Decimal en el idioma de la interfaz: "8,7" en español, "8.7" en inglés. Hoy
 * escribía "8,6" y Patrones "8.7" para la misma cifra; con dos formatos las
 * cifras parecen de sitios distintos aunque no lo sean.
 */
export const formatDecimal = (value: number, digits = 1): string =>
  value.toLocaleString(document.documentElement.lang === "en" ? "en-US" : "es-ES", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

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
      return Number.isInteger(value) ? String(value) : formatDecimal(value);
    default:
      return formatDecimal(value);
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

/**
 * Las cuatro filas que se leen de un vistazo, según el puesto.
 *
 * La tarjeta de la última partida no puede enseñar diecisiete barras sin
 * volver a ser una tabla; estas cuatro son las que un jugador de ese puesto
 * mira primero. La lista entera sigue en la ficha de la media.
 */
export const headlineMetrics = (role?: string | null): string[] => {
  switch (roleLabel(role)) {
    case "Jungle": return ["kill_participation", "cs_per_min", "kda", "deaths_per_game"];
    case "Support": return ["vision_score_per_min", "kill_participation", "kda", "deaths_per_game"];
    default: return ["cs_per_min", "kill_participation", "kda", "deaths_per_game"];
  }
};

/** Etiqueta de la palanca (clave de i18n), o null si la métrica no la tiene. */
export const metricLever = (metric: string): string | null =>
  METRIC_META[metric]?.lever ?? null;
