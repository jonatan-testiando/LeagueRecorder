/**
 * Los tres carriles de la Grieta y dónde está el choque de oleadas en ellos.
 *
 * Los ejes son COPIA de `Lane::path` en `src-tauri/src/gank.rs` (coordenadas
 * de juego, 0..14870, origen abajo a la izquierda; de la base azul a la roja,
 * con las torres reales como vértices). Las oleadas de `oleadas.rs` miden el
 * choque como progreso a lo largo de ESE eje, normalizado por su longitud
 * (`project` en gank.rs): si allí cambia un vértice hay que cambiarlo aquí, o
 * la marca del Mapa caería en otro punto del carril que el que dice el número.
 */

export type Lane = "top" | "mid" | "bot";

export const LANES: Lane[] = ["top", "mid", "bot"];

/** Clave de i18n del nombre de cada carril (ya existen en i18n.ts). */
export const LANE_NAME: Record<Lane, string> = { top: "Top", mid: "Mid", bot: "Bot" };

/** Por encima, el choque está en su mitad: empujado a tu favor (= `EMPUJADO`). */
export const A_FAVOR = 0.5;
/** Por debajo, la oleada está en tu lado (= `LADO_PROPIO` en oleadas.rs). */
export const EN_TU_LADO = 0.45;

const PATHS: Record<Lane, [number, number][]> = {
  top: [
    [1169, 4287],
    [1512, 6699],
    [981, 10441],
    [2300, 12700],
    [4318, 13875],
    [7943, 13411],
    [10481, 13650],
  ],
  mid: [
    [3651, 3696],
    [5048, 4812],
    [5846, 6396],
    [7450, 7450],
    [8955, 8510],
    [9767, 10113],
    [11134, 11207],
  ],
  bot: [
    [4281, 1253],
    [6919, 1483],
    [10504, 1029],
    [12700, 2300],
    [13866, 4505],
    [13327, 8226],
    [13624, 10572],
  ],
};

/** Longitud acumulada en cada vértice: se calcula una vez, no en cada fotograma. */
interface Eje {
  pts: [number, number][];
  acc: number[];
  total: number;
}

const EJES: Record<Lane, Eje> = Object.fromEntries(
  LANES.map((l) => {
    const pts = PATHS[l];
    const acc = [0];
    for (let i = 1; i < pts.length; i++) {
      acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    return [l, { pts, acc, total: acc[acc.length - 1] }];
  }),
) as Record<Lane, Eje>;

export const lanePath = (lane: Lane): readonly [number, number][] => EJES[lane].pts;

/** Punto a la fracción `f` del eje (0 = base azul, 1 = base roja), medida por
 *  longitud como en `project`, y la dirección unitaria del tramo en ese punto
 *  (para la barra perpendicular del choque). */
export function laneAt(lane: Lane, f: number): { x: number; y: number; dx: number; dy: number } {
  const e = EJES[lane];
  const d = Math.min(1, Math.max(0, f)) * e.total;
  let i = 1;
  while (i < e.pts.length - 1 && e.acc[i] < d) i++;
  const [ax, ay] = e.pts[i - 1];
  const [bx, by] = e.pts[i];
  const len = e.acc[i] - e.acc[i - 1] || 1;
  const u = (d - e.acc[i - 1]) / len;
  return { x: ax + (bx - ax) * u, y: ay + (by - ay) * u, dx: (bx - ax) / len, dy: (by - ay) / len };
}

/** El trozo del eje entre dos fracciones (`a < b`), con sus vértices. */
export function laneSpan(lane: Lane, a: number, b: number): [number, number][] {
  const e = EJES[lane];
  const ini = laneAt(lane, a);
  const fin = laneAt(lane, b);
  const out: [number, number][] = [[ini.x, ini.y]];
  const da = a * e.total;
  const db = b * e.total;
  for (let i = 1; i < e.pts.length - 1; i++) if (e.acc[i] > da && e.acc[i] < db) out.push(e.pts[i]);
  out.push([fin.x, fin.y]);
  return out;
}

/** Del «0 = tu base» de las oleadas al «0 = base azul» del eje. */
export const toAxis = (push: number, selfTeam: number): number => (selfTeam === 200 ? 1 - push : push);

/** `[t_partida, top, mid, bot]` como los da `get_waves` (-1 = no vista). */
export type WaveSeries = [number, number, number, number][];

/**
 * La serie con cada lectura sustituida por la mediana con sus vecinas (~4 s a
 * cada lado). Una lectura suelta salta de un lado a otro de la mitad (lo mismo
 * que hacía parpadear la franja de la pestaña Partida): en el Mapa la marca
 * daba saltos. Se hace una vez al llegar los datos, no en cada fotograma.
 */
export function smoothWaves(s: WaveSeries): WaveSeries {
  return s.map((p, k) => {
    const out: [number, number, number, number] = [p[0], -1, -1, -1];
    for (let i = 1; i <= 3; i++) {
      if (p[i] < 0) continue;
      const v = [s[k - 1], p, s[k + 1]]
        .map((q) => (q ? q[i] : -1))
        .filter((x) => x >= 0)
        .sort((a, b) => a - b);
      // Con dos lecturas (un extremo, o una vecina sin ver) no hay mediana
      // que valga: se queda la suya, no la mayor de las dos.
      out[i] = v.length === 3 ? v[1] : p[i];
    }
    return out;
  });
}

/**
 * El choque de un carril (`i`: 1 top, 2 mid, 3 bot) en el instante `g` de
 * partida: interpolado entre las dos lecturas que lo rodean si las dos son de
 * la misma oleada (cerca una de otra), o la más cercana si no. Una lectura a
 * más de `maxGap` s no vale: la oleada se habrá movido medio carril.
 */
export function waveAt(s: WaveSeries, g: number, i: 1 | 2 | 3, maxGap = 6): number | null {
  if (s.length === 0) return null;
  let lo = 0;
  let hi = s.length - 1;
  if (g < s[0][0]) hi = -1;
  else {
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid][0] <= g) lo = mid;
      else hi = mid - 1;
    }
  }
  const a = hi >= 0 ? s[hi] : undefined;
  const b = s[hi + 1];
  const va = a && a[i] >= 0 && g - a[0] <= maxGap ? a[i] : null;
  const vb = b && b[i] >= 0 && b[0] - g <= maxGap ? b[i] : null;
  if (va != null && vb != null && a && b) {
    if (Math.abs(va - vb) < 0.25) {
      const f = b[0] > a[0] ? (g - a[0]) / (b[0] - a[0]) : 0;
      return va + (vb - va) * f;
    }
    return g - a[0] <= b[0] - g ? va : vb;
  }
  return va ?? vb;
}
