/**
 * Zonas de la Grieta, para decir en una frase dónde se acumulan tus muertes.
 *
 * Trabaja en coordenadas normalizadas del mapa: `u` de izquierda a derecha y
 * `v` de abajo arriba (0,0 es la base azul), que es como las manda Riot
 * divididas por el tamaño del mapa. Los cortes están medidos sobre la geometría
 * real: las calles de los lados corren a ~7-12 % del borde, el río es la
 * diagonal u + v = 1 y el foso del Barón cae en (0,34, 0,70).
 *
 * Una zona "caliente" no es la zona con más muertes a secas: es un grupo de
 * muertes APRETADAS. Se busca en una rejilla con vecindad de 3×3 y sólo se
 * nombra si el grupo pesa de verdad (≥ 3 muertes y ≥ 20 % de las que se ven):
 * con cuatro muertes repartidas por el mapa, llamar "zona caliente" a la casilla
 * que tiene dos sería inventarse el patrón.
 */

export type ZoneKey =
  | "topLane"
  | "midLane"
  | "botLane"
  | "topRiver"
  | "botRiver"
  | "jungleBlue"
  | "jungleRed"
  | "baseBlue"
  | "baseRed";

/** Lado del mapa en que jugaste esa partida (100 = azul, abajo a la izquierda). */
export type Side = "blue" | "red" | null;

export interface ZonePoint {
  u: number;
  v: number;
  side: Side;
}

/** Ancho del mapa de Riot en unidades de juego (x e y). */
export const RIFT_W = 14820;
export const RIFT_H = 14881;

export function zoneOf(u: number, v: number): ZoneKey {
  if (Math.hypot(u, v) < 0.29) return "baseBlue";
  if (Math.hypot(1 - u, 1 - v) < 0.29) return "baseRed";
  if ((u < 0.14 && v > 0.2) || (v > 0.86 && u < 0.8)) return "topLane";
  if ((v < 0.14 && u > 0.2) || (u > 0.86 && v < 0.8)) return "botLane";
  if (Math.abs(u - v) < 0.075) return "midLane";
  if (Math.abs(u + v - 1) < 0.1) return v > u ? "topRiver" : "botRiver";
  return u + v < 1 ? "jungleBlue" : "jungleRed";
}

/**
 * Nombre de la zona (clave de i18n). Jungla y base se dicen desde TU lado
 * cuando se sabe en cuál jugaste ("tu jungla", no "la jungla azul"): es como
 * lo piensa un jugador. Sin lado, se dicen por color.
 */
export function zoneName(zone: ZoneKey, side: Side): string {
  switch (zone) {
    case "topLane": return "top lane";
    case "midLane": return "mid lane";
    case "botLane": return "bot lane";
    case "topRiver": return "top river, near Baron";
    case "botRiver": return "bottom river, near Dragon";
    case "jungleBlue":
      return side === null ? "blue-side jungle" : side === "blue" ? "your jungle" : "enemy jungle";
    case "jungleRed":
      return side === null ? "red-side jungle" : side === "red" ? "your jungle" : "enemy jungle";
    case "baseBlue":
      return side === null ? "blue base" : side === "blue" ? "your base" : "enemy base";
    case "baseRed":
      return side === null ? "red base" : side === "red" ? "your base" : "enemy base";
  }
}

export interface HotSpot {
  /** Centro del grupo, normalizado. */
  u: number;
  v: number;
  count: number;
  /** Nombre de la zona (clave de i18n), por mayoría dentro del grupo. */
  name: string;
}

const CELDAS = 12;

/** Un grupo: la casilla con más muertes contando sus ocho vecinas. */
function mejorGrupo(pts: ZonePoint[]): ZonePoint[] {
  const grid: ZonePoint[][][] = Array.from({ length: CELDAS }, () =>
    Array.from({ length: CELDAS }, () => [])
  );
  const celda = (x: number) => Math.max(0, Math.min(CELDAS - 1, Math.floor(x * CELDAS)));
  for (const p of pts) grid[celda(p.u)][celda(p.v)].push(p);
  let mejor: ZonePoint[] = [];
  for (let i = 0; i < CELDAS; i++) {
    for (let j = 0; j < CELDAS; j++) {
      const grupo: ZonePoint[] = [];
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const a = i + di;
          const b = j + dj;
          if (a >= 0 && b >= 0 && a < CELDAS && b < CELDAS) grupo.push(...grid[a][b]);
        }
      }
      if (grupo.length > mejor.length) mejor = grupo;
    }
  }
  return mejor;
}

function aHotSpot(grupo: ZonePoint[]): HotSpot {
  const u = grupo.reduce((a, p) => a + p.u, 0) / grupo.length;
  const v = grupo.reduce((a, p) => a + p.v, 0) / grupo.length;
  // El nombre, por mayoría de las muertes del grupo, cada una leída desde su
  // propio lado: dos partidas en lados distintos pueden caer en la misma
  // jungla "absoluta" y ser, para ti, la tuya y la enemiga.
  const votos = new Map<string, number>();
  for (const p of grupo) {
    const n = zoneName(zoneOf(p.u, p.v), p.side);
    votos.set(n, (votos.get(n) ?? 0) + 1);
  }
  const name = [...votos.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { u, v, count: grupo.length, name };
}

/**
 * Hasta dos zonas calientes: la primera se nombra en la leyenda; la segunda
 * sólo se pinta si pesa casi como la primera (≥ 60 %).
 */
export function hotSpots(pts: ZonePoint[]): HotSpot[] {
  if (pts.length < 3) return [];
  const g1 = mejorGrupo(pts);
  if (g1.length < 3 || g1.length < pts.length * 0.2) return [];
  const out = [aHotSpot(g1)];
  const usados = new Set(g1);
  const resto = pts.filter((p) => !usados.has(p));
  const g2 = mejorGrupo(resto);
  if (g2.length >= 3 && g2.length >= g1.length * 0.6) out.push(aHotSpot(g2));
  return out;
}
