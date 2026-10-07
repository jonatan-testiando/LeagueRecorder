/**
 * Nombres y colores de la ruta de jungla, compartidos por el reproductor y
 * Patrones. Las claves son las de `jungle_route.rs`.
 */

type T = (k: string, v?: Record<string, string | number>) => string;

const CAMP_LABEL: Record<string, string> = {
  blue: "Blue buff",
  red: "Red buff",
  gromp: "Gromp",
  wolves: "Wolves",
  raptors: "Raptors",
  krugs: "Krugs",
  scuttle_top: "Scuttle (top)",
  scuttle_bot: "Scuttle (bot)",
};

export const campLabel = (camp: string, t: T): string => t(CAMP_LABEL[camp] ?? camp);

/** Tono por lado: lo tuyo en jade, lo del rival en rojo, el río en violeta.
 *  (`--accent-blue` no vale: es un alias de `--cool` y saldría igual que lo tuyo.) */
export const SIDE_TONE: Record<string, string> = {
  own: "var(--cool)",
  enemy: "var(--loss)",
  river: "var(--flag)",
};

const ACTIVITY_LABEL: Record<string, string> = {
  farming: "farming your jungle",
  invading: "invading",
  scuttle: "on the scuttle",
  lane: "in a lane",
  river: "in the river",
  own_jungle: "walking your jungle",
  enemy_jungle: "in the enemy jungle",
  base: "in your base",
};

export const activityLabel = (a: string, t: T): string => t(ACTIVITY_LABEL[a] ?? a);

/** Orden en que se enseñan las actividades al morir: de "estabas farmeando"
 *  a "estabas en otra parte". */
export const ACTIVITY_ORDER = ["farming", "invading", "scuttle", "own_jungle", "enemy_jungle", "river", "lane", "base"];

/** Reparto del tiempo, en el orden de la barra. */
export const BUDGET_PARTS: { key: "farming" | "moving" | "lane" | "base" | "dead" | "unknown"; label: string; tone: string }[] = [
  { key: "farming", label: "Farming", tone: "var(--cool)" },
  // Pariente del farmeo (los dos son jungla), pero apagado: se lee distinto.
  { key: "moving", label: "Moving (jungle, river)", tone: "color-mix(in srgb, var(--cool) 40%, var(--sunken))" },
  { key: "lane", label: "In lane", tone: "var(--brand)" },
  { key: "base", label: "Base", tone: "var(--muted)" },
  { key: "dead", label: "Dead", tone: "var(--loss)" },
  { key: "unknown", label: "Not tracked", tone: "var(--hair-strong)" },
];
