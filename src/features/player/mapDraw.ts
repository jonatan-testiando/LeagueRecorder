/**
 * Lo que el Mapa (RouteReplay.tsx) pinta encima del minimapa de la grabación:
 * el choque de oleadas de cada carril, el aro de "encima" y las marcas de un
 * foco (ver mapFocus.ts).
 *
 * El fondo es el minimapa REAL, con calles beige, jungla verde e iconos: cada
 * trazo lleva debajo un halo del color del fondo de la app y cada texto va en
 * su píldora, o se pierde. Los colores salen de los tokens (`leerPaleta`): un
 * lienzo no entiende `var()`, así que se leen una vez y se releen al cambiar
 * de tema, nunca en cada fotograma.
 */
import { laneAt, lanePath, laneSpan, type Lane } from "./laneGeometry";
import type { MapMark } from "./mapFocus";

/** Extensión del mapa en coordenadas de juego: la misma que usa el detector. */
export const MAPA = 14870;

export type RGB = [number, number, number];

export interface Paleta {
  cool: string;
  loss: string;
  win: string;
  muted: string;
  brand: string;
  flag: string;
  text: string;
  panel: string;
  ground: string;
  font: string;
  coolRGB: RGB;
  brandRGB: RGB;
}

/** "#3CB787" → [60, 183, 135]. */
export function rgb(hex: string): RGB {
  const h = hex.trim().replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6), 16);
  return Number.isNaN(n) ? [200, 170, 110] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function leerPaleta(): Paleta {
  const css = getComputedStyle(document.documentElement);
  const c = (k: string, def: string) => css.getPropertyValue(k).trim() || def;
  const cool = c("--cool", "#5aa9f2");
  const brand = c("--brand", "#d1a856");
  return {
    cool,
    loss: c("--loss", "#ff5a6e"),
    win: c("--win", cool),
    muted: c("--muted", "#a0a0a8"),
    brand,
    flag: c("--flag", "#A589F1"),
    text: c("--text", "#c6c6cb"),
    panel: c("--panel", "#1b1b1f"),
    ground: c("--ground", "#111114"),
    font: c("--font-sans", "system-ui, sans-serif"),
    coolRGB: rgb(cool),
    brandRGB: rgb(brand),
  };
}

/** Dónde cae el minimapa dentro del lienzo (píxeles de dispositivo). `u` es
 *  la unidad de grosor (la de la estela) y `fs` el cuerpo de los rótulos. */
export interface Vista {
  ox: number;
  oy: number;
  dw: number;
  dh: number;
  cw: number;
  ch: number;
  u: number;
  fs: number;
}

/** Misma conversión que el detector, al revés. */
export const vx = (v: Vista, x: number) => v.ox + (x / MAPA) * v.dw;
export const vy = (v: Vista, y: number) => v.oy + (1 - y / MAPA) * v.dh;

/** Un texto que pintar al final, por encima de todos los trazos. La píldora
 *  sale desde (x, y) en la dirección (dx, dy); `mx` es la x de la marca, para
 *  ponerla al otro lado si no cabe. */
export interface Rotulo {
  texto: string;
  x: number;
  y: number;
  dx: number;
  dy: number;
  tono: string;
  alpha: number;
  mx?: number;
}

/** El tono del choque: jade empujado a tu favor, rojo en tu lado, gris en medio
 *  (los mismos cortes que las reglas de `oleadas.rs`). */
export function tonoEmpuje(push: number, pal: Paleta): string {
  return push >= 0.5 ? pal.cool : push <= 0.45 ? pal.loss : pal.muted;
}

/** Traza el camino ya abierto dos veces: halo ancho del fondo y luego el color. */
function trazo(cx: CanvasRenderingContext2D, pal: Paleta, w: number, color: string, alpha: number) {
  cx.globalAlpha = alpha * 0.6;
  cx.strokeStyle = pal.ground;
  cx.lineWidth = w * 2.2;
  cx.stroke();
  cx.globalAlpha = alpha;
  cx.strokeStyle = color;
  cx.lineWidth = w;
  cx.stroke();
}

/** Rellena el camino ya abierto con su halo alrededor. */
function relleno(cx: CanvasRenderingContext2D, pal: Paleta, v: Vista, color: string, alpha: number) {
  cx.globalAlpha = alpha * 0.7;
  cx.strokeStyle = pal.ground;
  cx.lineWidth = v.u * 1.4;
  cx.stroke();
  cx.globalAlpha = alpha;
  cx.fillStyle = color;
  cx.fill();
}

function polilinea(cx: CanvasRenderingContext2D, v: Vista, pts: readonly [number, number][]) {
  cx.beginPath();
  pts.forEach(([x, y], i) => (i ? cx.lineTo(vx(v, x), vy(v, y)) : cx.moveTo(vx(v, x), vy(v, y))));
}

/**
 * Un carril con su choque de oleadas.
 *
 * El eje entero, tenue, para saber de qué carril se habla; desde TU base hasta
 * el choque, una banda ancha y translúcida del tono (lo que es tuyo del
 * carril: se lee como territorio, no como la estela, que es fina y sólida); y
 * en el choque una barra perpendicular, la marca que se mira. Sin dato
 * (`along` null) queda el eje con un «?» en medio.
 *
 * `along` va en la escala del eje (0 = base azul); `propioAlInicio` dice si tu
 * base es la azul.
 */
export function dibujarCarril(
  cx: CanvasRenderingContext2D,
  v: Vista,
  pal: Paleta,
  lane: Lane,
  along: number | null,
  propioAlInicio: boolean,
  tono: string,
  texto: string,
  rotulos: Rotulo[],
) {
  cx.lineCap = "round";
  cx.lineJoin = "round";
  polilinea(cx, v, lanePath(lane));
  cx.globalAlpha = 0.22;
  cx.strokeStyle = pal.text;
  cx.lineWidth = v.u * 0.9;
  cx.stroke();

  if (along == null) {
    const m = laneAt(lane, 0.5);
    rotulos.push({ texto: `${texto} ?`, x: vx(v, m.x), y: vy(v, m.y), dx: 0, dy: 0, tono: pal.muted, alpha: 0.9 });
    return;
  }

  polilinea(cx, v, propioAlInicio ? laneSpan(lane, 0, along) : laneSpan(lane, along, 1));
  cx.lineCap = "butt";
  cx.globalAlpha = 0.32;
  cx.strokeStyle = tono;
  cx.lineWidth = v.u * 3.4;
  cx.stroke();
  cx.lineCap = "round";

  // La barra, perpendicular al tramo en la pantalla (el recorte no es del
  // todo cuadrado: la dirección se pasa a píxeles antes de girarla).
  const p = laneAt(lane, along);
  const X = vx(v, p.x);
  const Y = vy(v, p.y);
  let ax = p.dx * v.dw;
  let ay = -p.dy * v.dh;
  const n = Math.hypot(ax, ay) || 1;
  ax /= n;
  ay /= n;
  let nx = -ay;
  let ny = ax;
  // El rótulo, hacia fuera del mapa (top y bot) o hacia arriba (mid, que pasa
  // por el centro y no tiene "fuera").
  const fuera = lane === "mid" ? ny <= 0 : nx * (X - (v.ox + v.dw / 2)) + ny * (Y - (v.oy + v.dh / 2)) >= 0;
  if (!fuera) {
    nx = -nx;
    ny = -ny;
  }
  const half = Math.max(v.u * 4, (560 / MAPA) * v.dw);
  cx.beginPath();
  cx.moveTo(X - nx * half, Y - ny * half);
  cx.lineTo(X + nx * half, Y + ny * half);
  trazo(cx, pal, v.u * 1.5, tono, 1);
  cx.beginPath();
  cx.arc(X, Y, v.u * 1.25, 0, Math.PI * 2);
  relleno(cx, pal, v, tono, 1);
  rotulos.push({ texto, x: X + nx * (half + v.u * 1.5), y: Y + ny * (half + v.u * 1.5), dx: nx, dy: ny, tono, alpha: 1 });
}

/** El aro de "encima" alrededor de tu posición: rojo translúcido y discontinuo,
 *  que no tape lo que hay dentro (los rivales que cuentan). */
export function dibujarAro(
  cx: CanvasRenderingContext2D,
  v: Vista,
  pal: Paleta,
  x: number,
  y: number,
  radio: number,
  texto: string,
  rotulos: Rotulo[],
) {
  const X = vx(v, x);
  const Y = vy(v, y);
  const rx = (radio / MAPA) * v.dw;
  const ry = (radio / MAPA) * v.dh;
  cx.beginPath();
  cx.ellipse(X, Y, rx, ry, 0, 0, Math.PI * 2);
  cx.globalAlpha = 0.1;
  cx.fillStyle = pal.loss;
  cx.fill();
  cx.setLineDash([v.u * 2.2, v.u * 1.6]);
  trazo(cx, pal, v.u * 1.1, pal.loss, 0.9);
  cx.setLineDash([]);
  rotulos.push({ texto, x: X, y: Y - ry - v.u, dx: 0, dy: -1, tono: pal.loss, alpha: 0.95 });
}

export type MarkKind = MapMark["kind"];

function poligono(cx: CanvasRenderingContext2D, X: number, Y: number, pts: [number, number][]) {
  cx.beginPath();
  pts.forEach(([a, b], i) => (i ? cx.lineTo(X + a, Y + b) : cx.moveTo(X + a, Y + b)));
  cx.closePath();
}

/** Una marca del foco, con su símbolo. Devuelve el radio que ocupa, para
 *  poner el rótulo al lado sin pisarla. */
export function dibujarMarca(
  cx: CanvasRenderingContext2D,
  v: Vista,
  pal: Paleta,
  kind: MarkKind,
  x: number,
  y: number,
  tono: string,
  alpha: number,
): number {
  const X = vx(v, x);
  const Y = vy(v, y);
  const r = v.u * 2.4;
  cx.lineCap = "round";
  cx.lineJoin = "round";
  switch (kind) {
    case "tower":
      // Una casita: se lee como estructura sin parecerse a ningún icono del juego.
      poligono(cx, X, Y, [[0, -1.2 * r], [r, -0.3 * r], [r, r], [-r, r], [-r, -0.3 * r]]);
      relleno(cx, pal, v, tono, alpha);
      return r;
    case "plate":
      poligono(cx, X, Y, [[-0.65 * r, -0.65 * r], [0.65 * r, -0.65 * r], [0.65 * r, 0.65 * r], [-0.65 * r, 0.65 * r]]);
      trazo(cx, pal, v.u * 0.9, tono, alpha);
      return r * 0.8;
    case "inhibitor":
      // Un aro grueso, como el inhibidor en el propio minimapa.
      cx.beginPath();
      cx.arc(X, Y, r * 0.9, 0, Math.PI * 2);
      trazo(cx, pal, v.u * 1.2, tono, alpha);
      return r;
    case "epic": {
      const pts: [number, number][] = [];
      for (let k = 0; k < 10; k++) {
        const a = -Math.PI / 2 + (k * Math.PI) / 5;
        const rr = k % 2 ? r * 0.55 : r * 1.35;
        pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
      }
      poligono(cx, X, Y, pts);
      relleno(cx, pal, v, tono, alpha);
      return r * 1.3;
    }
    case "objective": {
      const pts: [number, number][] = [];
      for (let k = 0; k < 6; k++) {
        const a = Math.PI / 6 + (k * Math.PI) / 3;
        pts.push([Math.cos(a) * r * 1.1, Math.sin(a) * r * 1.1]);
      }
      poligono(cx, X, Y, pts);
      relleno(cx, pal, v, tono, alpha);
      return r * 1.1;
    }
    case "camp":
      cx.beginPath();
      cx.arc(X, Y, r * 0.85, 0, Math.PI * 2);
      relleno(cx, pal, v, tono, alpha);
      return r;
    case "kill":
      poligono(cx, X, Y, [[0, -1.15 * r], [1.15 * r, 0], [0, 1.15 * r], [-1.15 * r, 0]]);
      relleno(cx, pal, v, tono, alpha);
      return r * 1.15;
    case "death":
      cx.beginPath();
      cx.moveTo(X - r, Y - r); cx.lineTo(X + r, Y + r);
      cx.moveTo(X + r, Y - r); cx.lineTo(X - r, Y + r);
      trazo(cx, pal, v.u * 1.3, tono, alpha);
      return r;
    case "ally_death": {
      // La de un aliado, más pequeña y dentro de un aro: que no se confunda
      // con la tuya, que es la que más se mira.
      const k = r * 0.55;
      cx.beginPath();
      cx.moveTo(X - k, Y - k); cx.lineTo(X + k, Y + k);
      cx.moveTo(X + k, Y - k); cx.lineTo(X - k, Y + k);
      cx.moveTo(X + r, Y);
      cx.arc(X, Y, r, 0, Math.PI * 2);
      trazo(cx, pal, v.u * 0.85, tono, alpha);
      return r;
    }
    case "gank": {
      // Una mira: el sitio al que se fue.
      cx.beginPath();
      cx.arc(X, Y, r * 0.8, 0, Math.PI * 2);
      for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        cx.moveTo(X + a * r * 0.45, Y + b * r * 0.45);
        cx.lineTo(X + a * r * 1.45, Y + b * r * 1.45);
      }
      trazo(cx, pal, v.u * 0.9, tono, alpha);
      return r * 1.45;
    }
  }
}

/** Anchos ya medidos: `measureText` en cada fotograma, con veinte rótulos a
 *  170 fps, se nota. Se vacía si crece (cambia el cuerpo al redimensionar). */
const anchos = new Map<string, number>();

function medir(cx: CanvasRenderingContext2D, texto: string): number {
  const k = `${cx.font}|${texto}`;
  let w = anchos.get(k);
  if (w === undefined) {
    if (anchos.size > 400) anchos.clear();
    w = cx.measureText(texto).width;
    anchos.set(k, w);
  }
  return w;
}

function caja(cx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  cx.beginPath();
  cx.moveTo(x + r, y);
  cx.arcTo(x + w, y, x + w, y + h, r);
  cx.arcTo(x + w, y + h, x, y + h, r);
  cx.arcTo(x, y + h, x, y, r);
  cx.arcTo(x, y, x + w, y, r);
  cx.closePath();
}

/** Los rótulos, al final y por encima de todo: píldora del color del panel,
 *  texto del de la app (nada de blanco puro) y un canto del tono a la
 *  izquierda que la ata a su marca. */
export function dibujarRotulos(cx: CanvasRenderingContext2D, v: Vista, pal: Paleta, rotulos: Rotulo[]) {
  if (rotulos.length === 0) return;
  cx.font = `600 ${v.fs}px ${pal.font}`;
  cx.textBaseline = "middle";
  cx.textAlign = "left";
  const h = v.fs * 1.45;
  const pad = v.fs * 0.45;
  const canto = Math.max(2, v.fs * 0.14);
  for (const r of rotulos) {
    const w = medir(cx, r.texto) + pad * 2;
    let { x, dx } = r;
    if (r.mx != null && ((dx > 0 && x + w > v.cw - 2) || (dx < 0 && x - w < 2))) {
      x = 2 * r.mx - x;
      dx = -dx;
    }
    // El centro, tan lejos del ancla en (dx, dy) como mide la píldora en esa
    // dirección: queda entera al otro lado, sin pisar la marca, en cualquier
    // ángulo (el de un carril en diagonal también).
    const lejos = Math.abs(dx) * (w / 2) + Math.abs(r.dy) * (h / 2);
    const x0 = Math.min(v.cw - w - 2, Math.max(2, x + dx * lejos - w / 2));
    const y0 = Math.min(v.ch - h - 2, Math.max(2, r.y + r.dy * lejos - h / 2));
    caja(cx, x0, y0, w, h, h / 2.6);
    cx.globalAlpha = r.alpha * 0.9;
    cx.fillStyle = pal.panel;
    cx.fill();
    cx.globalAlpha = r.alpha;
    cx.fillStyle = r.tono;
    cx.fillRect(x0 + h / 5, y0 + h * 0.22, canto, h * 0.56);
    cx.fillStyle = pal.text;
    cx.fillText(r.texto, x0 + pad + canto * 0.6, y0 + h / 2 + v.fs * 0.04);
  }
  cx.globalAlpha = 1;
}

/** Tu posición en el segundo `s` (interpolada entre muestras de tu rastro),
 *  o null si en ese momento no se te seguía (base, icono perdido). */
export function posicionEn(me: [number, number, number][], s: number, corteS: number, corteU: number): [number, number] | null {
  if (me.length === 0 || s < me[0][0]) return null;
  let lo = 0;
  let hi = me.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (me[mid][0] <= s) lo = mid;
    else hi = mid - 1;
  }
  const a = me[lo];
  if (s - a[0] > corteS) return null;
  const b = me[lo + 1];
  if (b && b[0] - a[0] <= corteS && Math.hypot(b[1] - a[1], b[2] - a[2]) <= corteU && b[0] > a[0]) {
    const f = (s - a[0]) / (b[0] - a[0]);
    return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  return [a[1], a[2]];
}

