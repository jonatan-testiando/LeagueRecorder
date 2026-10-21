import type { CoachPlan, CoachPlay, CoachRow, CoachSummary } from "./tauri-ipc";

/**
 * Lo que la UI necesita para contar el coach (`coach.rs`): nombres de las
 * categorías y los tramos, las frases del foco y su lista de reproducción.
 *
 * El foco lo elige el backend (la categoría × tramo con más pérdida por
 * encima de su baremo, con al menos `min_games` partidas). Sustituye al de
 * `patterns.ts`, que era «el bloque de 5 min en que más mueres».
 */

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Inicio de cada tramo, en minutos: los cortes de `muertes::CORTES_TRAMO`. */
export const TRAMO_FROM = [0, 7, 14, 21, 28] as const;

export function tramoWindow(tramo: number): { from: number; to: number | null } {
  return { from: TRAMO_FROM[tramo] ?? 0, to: TRAMO_FROM[tramo + 1] ?? null };
}

/** "entre el minuto 7 y el 14", "desde el minuto 28". */
export function tramoText(tramo: number, t: Translate): string {
  const { from, to } = tramoWindow(tramo);
  return to == null ? t("from minute {a}", { a: from }) : t("between minutes {a} and {b}", { a: from, b: to });
}

/** "7-14'", "28'+": para un eje. */
export function tramoShort(tramo: number): string {
  const { from, to } = tramoWindow(tramo);
  return to == null ? `${from}'+` : `${from}-${to}'`;
}

const NAMES: Record<string, string> = {
  jungla: "Deaths to the enemy jungler",
  fuera_de_zona: "Deaths away from your lane",
  bajo_torre_pre14: "Deaths at a tower",
  poco_dano_devuelto: "Deaths dealing little damage back",
  sin_mirar_mapa: "Deaths without looking at the map",
  desde_niebla: "Fights opened on you from the fog",
  antes_de_objetivo: "Deaths right before an enemy objective",
  ausente_objetivo: "Enemy objectives taken without you",
  tirada: "Deaths with the game in hand",
};

const HELP: Record<string, string> = {
  jungla: "The enemy jungler killed you or assisted.",
  fuera_de_zona: "Before 14:00, more than 2,500 units from your lane.",
  bajo_torre_pre14: "Before 14:00, next to a standing tower (yours or theirs), or their tower hit you.",
  poco_dano_devuelto: "What you dealt before dying is in the lowest 10% for your role at that point of the game.",
  sin_mirar_mapa: "No look at the map in the 10 s before dying.",
  desde_niebla: "The fight that killed you was opened with no enemy in sight.",
  antes_de_objetivo: "Your share of what the enemy took in the 60 s after your death.",
  ausente_objetivo:
    "A dragon, Baron, Herald or grubs the enemy took while you were far from the pit, in base or dead. It is shared among the allies who were missing.",
  tirada: "You died with your team at 65% win chance or more.",
};

export const categoryName = (cat: string, t: Translate): string => t(NAMES[cat] ?? cat);
export const categoryHelp = (cat: string, t: Translate): string => (HELP[cat] ? t(HELP[cat]) : "");

/** Una categoría que sólo sale del vídeo: se compara con tu propia media. */
export const isOwnBaseline = (row: CoachRow): boolean => row.baseline === "own";

/** Probabilidad (0-1) en puntos: "9", "1,2". Un decimal por debajo de 10. */
export function wpPoints(x: number, lang: string): string {
  const p = Math.abs(x) * 100;
  const d = p < 10 ? 1 : 0;
  return p.toLocaleString(lang === "es" ? "es-ES" : "en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** "Muertes al jungla rival entre el minuto 7 y el 14". */
export const focusTitle = (row: CoachRow, t: Translate): string =>
  row.tramo == null ? categoryName(row.category, t) : `${categoryName(row.category, t)} ${tramoText(row.tramo, t)}`;

/**
 * La frase del foco: lo que te cuesta frente a su baremo, diciendo cuál es.
 * «En tu rango» sólo cuando todas tus partidas son de la misma franja; si no,
 * cada partida se compara con la suya y se dice así.
 */
export function focusWhy(row: CoachRow, summary: CoachSummary, t: Translate, lang: string): string {
  const vars = { user: wpPoints(row.user, lang), base: wpPoints(row.base ?? 0, lang) };
  if (isOwnBaseline(row)) return t("They cost you {user}% win chance per game; at your usual rate they would cost {base}%.", vars);
  if (summary.band && summary.band_uniform) return t("They cost you {user}% win chance per game; in your rank, {base}%.", vars);
  return t("They cost you {user}% win chance per game; your role in the rank of each game, {base}%.", vars);
}

/** Lo que dice el lift de una categoría de vídeo, en una frase. */
export function liftText(row: CoachRow, t: Translate, lang: string): string | null {
  if (row.rate_deaths == null || row.rate_any == null) return null;
  const vars = { a: wpPoints(row.rate_deaths, lang), b: wpPoints(row.rate_any, lang) };
  if (row.category === "sin_mirar_mapa") return t("Before dying you had gone 10 s without a look {a}% of the time; at any moment, {b}%.", vars);
  if (row.category === "desde_niebla") return t("{a}% of the fights that killed you came from the fog; of all the fights started on you, {b}%.", vars);
  return null;
}

const OBJECTIVE: Record<string, string> = {
  dragon: "Dragon",
  baron: "Baron Nashor",
  herald: "Rift Herald",
  grubs: "Void Grubs",
  tower: "Tower",
  inhibitor: "Inhibitor",
  plate: "Plate",
};

const STATE: Record<string, string> = {
  far: "far from the pit",
  base: "in base",
  dead: "dead",
};

/** "Te mató Zed · −3,2% de victoria", "Dragón sin ti (en base) · −1,1% de victoria". */
export function coachPlayLabel(p: CoachPlay, t: Translate, lang: string): string {
  const cost = t("−{p}% win chance", { p: wpPoints(p.lost, lang) });
  if (p.kind === "objective") {
    const what = t("{objective} without you ({where})", {
      objective: t(OBJECTIVE[p.objective ?? ""] ?? p.objective ?? "Objective"),
      where: t(STATE[p.state ?? ""] ?? "far from the pit"),
    });
    return `${what} · ${cost}`;
  }
  const who = p.killer ? t("Killed by {champion}", { champion: p.killer }) : t("Death");
  return `${who} · ${cost}`;
}

/** La lista de reproducción de una fila: sus peores jugadas con vídeo. */
export function coachPlaylist(row: CoachRow, t: Translate, lang: string): { matchId: string; time: number; label: string }[] {
  return row.worst
    .filter((p) => p.video_time != null)
    .map((p) => ({ matchId: p.match_id, time: p.video_time as number, label: coachPlayLabel(p, t, lang) }));
}

/** Las filas de una categoría por tramo, en orden: las barras de la tarjeta. */
export const rowsByTramo = (summary: CoachSummary, category: string): CoachRow[] =>
  summary.rows.filter((r) => r.category === category && r.tramo != null).sort((a, b) => (a.tramo ?? 0) - (b.tramo ?? 0));

/* ------------------------------------------------------------ el plan */

/** Partidas del plan que cuentan para las diez: las que miden el foco. */
export const planCounted = (plan: CoachPlan): number => plan.games.filter((g) => g.cost != null).length;

/** ¿Es este plan sobre esta fila (categoría × tramo)? */
export const planIsRow = (plan: CoachPlan, row: CoachRow): boolean =>
  plan.category === row.category && plan.tramo === row.tramo;

/** "Muertes al jungla rival entre el minuto 7 y el 14", del foco de un plan. */
export const planTitle = (plan: CoachPlan, t: Translate): string =>
  `${categoryName(plan.category, t)} ${tramoText(plan.tramo, t)}`;

const PLAN_ERRORS: Record<string, string> = {
  active_plan: "There's already a plan in progress.",
  no_active_plan: "There's no plan in progress.",
  few_games: "A plan needs {n} earlier games that measure this focus.",
  no_focus: "There's no focus to start a plan with yet.",
  bad_focus: "That focus doesn't exist.",
  newer_schema: "Your plans were saved by a newer version of the app. Update it to see them.",
};

/** El fallo de `startCoachPlan`/`abandonCoachPlan`, en una frase. */
export function planErrorText(code: string, t: Translate, minBefore: number): string {
  const key = PLAN_ERRORS[code];
  return key ? t(key, { n: minBefore }) : t("Couldn't save the plan: {error}", { error: code });
}
