// Utilidades sueltas del reproductor de review: rutas de recursos, el espacio de coordenadas de
// la estela del ratón y el suavizado de las curvas del timeline.

import { MatchMetadata } from "../../../types";

// Retratos de campeón: bundleados localmente en public/champions (script scripts/download-champions.ps1).
export const champIcon = (champion: string) => `/champions/${champion}.png`;

// Los iconos de items sí se piden a Data Dragon (conjunto grande y volátil). Versión de fallback.
export const DDRAGON_VER = "16.13.1";
export const itemIcon = (ver: string, id: number) =>
  `https://ddragon.leagueoflegends.com/cdn/${ver}/img/item/${id}.png`;

export const streamUrl = (path: string): string =>
  `http://stream.localhost/${encodeURIComponent(path)}`;

/** Segundos que un clip de error coge antes y después del instante marcado. */
export const CLIP_BEFORE = 5;
export const CLIP_AFTER = 10;

/**
 * Espacio de coordenadas en el que están guardados los `mouse_events`.
 *
 * El hook global (rdev) entrega coordenadas del ESCRITORIO. Si se graba a una
 * resolución distinta a la del monitor, escalar por las dimensiones del vídeo
 * descuadra la estela proporcionalmente a la distancia al origen.
 */
export const mouseSpace = (
  m: MatchMetadata,
  videoW: number,
  videoH: number
): [number, number] => {
  // Partidas grabadas con la corrección: el espacio viene explícito.
  if (m.mouse_space_w && m.mouse_space_h) return [m.mouse_space_w, m.mouse_space_h];
  // Los VOD analizados detectan el cursor SOBRE el vídeo: ya están en su espacio.
  if (m.is_vod) return [videoW, videoH];
  // Partidas antiguas, que no guardaron el dato: la mejor aproximación es el
  // monitor actual, que es casi con seguridad donde se grabaron. Si el usuario
  // cambió de monitor desde entonces, esas partidas seguirán descuadradas.
  const w = Math.round(window.screen.width * (window.devicePixelRatio || 1));
  const h = Math.round(window.screen.height * (window.devicePixelRatio || 1));
  return w > 0 && h > 0 ? [w, h] : [videoW, videoH];
};

/** Curva suave (Catmull-Rom a Bézier) que pasa por todos los puntos dados. */
export function smoothLinePath(pts: [number, number][]): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${cp1x.toFixed(2)} ${cp1y.toFixed(2)} ${cp2x.toFixed(2)} ${cp2y.toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d;
}
