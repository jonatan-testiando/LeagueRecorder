import { useLayoutEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";

/**
 * El movimiento de la app (2026-11-19). Sustituye a `enterMotion.ts`.
 *
 * Medido con clics reales en la app de release (pantalla de 240 Hz): cambiar de
 * pantalla daba saltos de 17-50 ms y abrir una partida, cinco de 13-50 ms. La
 * entrada escalonada de antes recorría el árbol con `getComputedStyle` y
 * `getBoundingClientRect` en el mismo fotograma en que React montaba la
 * pantalla, y luego animaba hasta 23 piezas, cada una en su capa. La animación
 * arrancaba con el hilo principal ocupado: eso eran los tirones.
 *
 * Ahora:
 * - Cambiar de pantalla, abrir y cerrar una partida van con View Transitions:
 *   el navegador congela lo de antes, monta lo nuevo sin que se vea y anima
 *   las dos instantáneas en el compositor. Nada se mide a mano. El vuelo del
 *   retrato se rehace solo con `transform` (`vueloEnCompositor`): el del
 *   navegador cambia ancho y alto, y eso va por el hilo principal.
 * - La entrada escalonada solo en la PRIMERA visita a cada pantalla, sobre
 *   cinco bloques como mucho y sin medir nada (`data-e` o, si no hay, los hijos
 *   del primer contenedor con varios). Lo que se ve decenas de veces al día no
 *   hace esperar.
 * - Lo que se sustituye en el mismo sitio (una pestaña, un bloque) se funde
 *   con 2 px de desenfoque (`cambio`).
 * - Nada se anima si la acción vino del teclado (`<html data-nav="kbd">`).
 * - Movimiento reducido: quedan los fundidos; desplazamientos y escalas, no.
 *
 * Tiempos y curvas: los tokens de movimiento de index.css; aquí los mismos
 * valores para la Web Animations API.
 */

const E_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const ENTRADA_MS = 240;
const PASO_MS = 40;
const MAX_BLOQUES = 5;
const MAX_FILAS = 10;
const PASO_FILA_MS = 20;
const CAMBIO_MS = 160;
/** --t-share de index.css: el vuelo del retrato. */
const DUR_COMPARTIDO = 340;

const html = () => document.documentElement;
export const movimientoReducido = (): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const conTeclado = () => html().dataset.nav === "kbd";

// ─────────────────────────────────────────────────────── origen de la acción
// Quien navega con el teclado ya sabe adónde va: sin animación. El último
// gesto decide; un clic lanzado con Intro llega con `detail === 0` y también
// cuenta como teclado (ver navOrigin.ts).
if (typeof window !== "undefined") {
  // Solo si cambia: un atributo de <html> que se reescribe invalida estilos.
  const marcar = (v: "ptr" | "kbd") => {
    if (html().dataset.nav !== v) html().dataset.nav = v;
  };
  window.addEventListener("pointerdown", () => marcar("ptr"), true);
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
      const t = e.target as HTMLElement | null;
      // Escribir en un campo no es navegar.
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) && e.key !== "Enter" && e.key !== "Escape") return;
      marcar("kbd");
    },
    true
  );
}

// ─────────────────────────────────────────────────────────── View Transitions
export type Transicion = "nav" | "open" | "back";

type Pendiente = {
  tipo: Transicion;
  cambios: Array<() => void>;
  origen: Element | null;
  destino: (() => Element | null) | null;
  dir: "down" | "up" | null;
};
let pendiente: Pendiente | null = null;
const PESO: Record<Transicion, number> = { nav: 0, back: 1, open: 2 };

/**
 * Hace `cambio` dentro de una View Transition del `tipo` dado.
 *
 * Varias llamadas en la misma tarea (abrir una partida desde Hoy es elegirla y
 * navegar a la Biblioteca) se juntan en UNA transición, con el tipo de más
 * peso. Sin la API, con el teclado, con la ventana oculta o con movimiento
 * reducido en un `open`/`back`, el cambio se aplica al momento.
 *
 * `origen` y `destino` son el elemento compartido (el retrato): se le da el
 * nombre `retrato` antes de capturar y, en el estado nuevo, al de destino.
 */
export function conTransicion(
  tipo: Transicion,
  cambio: () => void,
  opciones: { origen?: Element | null; destino?: () => Element | null; dir?: "down" | "up" | null } = {}
): void {
  const d = document as Document & {
    startViewTransition?: (cb: () => void) => { finished: Promise<void>; ready: Promise<void> };
  };
  if (!d.startViewTransition || conTeclado() || document.hidden || (movimientoReducido() && tipo !== "nav")) {
    cambio();
    return;
  }
  if (pendiente) {
    pendiente.cambios.push(cambio);
    if (PESO[tipo] > PESO[pendiente.tipo]) pendiente.tipo = tipo;
    pendiente.origen ??= opciones.origen ?? null;
    pendiente.destino ??= opciones.destino ?? null;
    pendiente.dir ??= opciones.dir ?? null;
    return;
  }
  pendiente = { tipo, cambios: [cambio], origen: opciones.origen ?? null, destino: opciones.destino ?? null, dir: opciones.dir ?? null };
  queueMicrotask(() => {
    const p = pendiente;
    pendiente = null;
    if (!p) return;
    const raiz = html();
    // Una marca de primera visita que quedara de antes (una entrada sin
    // transición) no es de esta: la pone, si toca, el cambio de dentro.
    delete raiz.dataset.primera;
    raiz.dataset.vt = p.tipo;
    if (p.dir && raiz.dataset.dir !== p.dir) raiz.dataset.dir = p.dir;
    const origen = p.origen as HTMLElement | null;
    if (origen) origen.style.viewTransitionName = "retrato";
    let destino: HTMLElement | null = null;
    const t = d.startViewTransition!(() => {
      if (origen) origen.style.viewTransitionName = "";
      flushSync(() => p.cambios.forEach((c) => c()));
      destino = (p.destino?.() as HTMLElement | null) ?? null;
      if (destino && origen) destino.style.viewTransitionName = "retrato";
    });
    if (origen) t.ready.then(() => vueloEnCompositor("retrato")).catch(() => {});
    t.finished.finally(() => {
      if (destino) destino.style.viewTransitionName = "";
      if (origen) origen.style.viewTransitionName = "";
      if (raiz.dataset.vt === p.tipo) delete raiz.dataset.vt;
      delete raiz.dataset.primera;
    });
  });
}

/**
 * El vuelo de un elemento compartido, solo con `transform`.
 *
 * El que pone el navegador anima también el ancho y el alto del grupo (el
 * retrato mide 36 px en la fila, 72 en Hoy y 22 en la miga), y eso el
 * compositor no lo sabe hacer: cada fotograma del vuelo esperaba al hilo
 * principal, que justo entonces está montando el reproductor, y el retrato
 * daba saltos (medido en una traza: `width`/`height` sin componer). Aquí el
 * grupo se queda con su tamaño final y empieza escalado al de salida: a la
 * vista es lo mismo, y va entero en el compositor. Las imágenes de dentro
 * ocupan el ancho del grupo, así que escalan con él.
 *
 * Con `transform-origin: 0 0` en el grupo (index.css): la matriz del
 * navegador es una traslación y la escala tiene que salir de la esquina.
 */
function vueloEnCompositor(nombre: string): void {
  const raiz = html();
  const pseudo = `::view-transition-group(${nombre})`;
  const a = document.getAnimations().find((x) => (x.effect as KeyframeEffect | null)?.pseudoElement === pseudo);
  const ef = a?.effect as KeyframeEffect | undefined;
  if (!a || !ef) return;
  const desde = ef.getKeyframes()[0];
  const w0 = parseFloat(String(desde?.width));
  const h0 = parseFloat(String(desde?.height));
  if (!desde?.transform || !(w0 > 0 && h0 > 0)) return;
  const { duration, delay } = ef.getTiming();
  const easing = desde.easing && desde.easing !== "linear" ? desde.easing : ef.getTiming().easing;
  // Sin la animación, el estilo del grupo es el del final.
  a.cancel();
  const fin = getComputedStyle(raiz, pseudo);
  const w1 = parseFloat(fin.width);
  const h1 = parseFloat(fin.height);
  if (!(w1 > 0 && h1 > 0) || fin.transform === "none") {
    a.play();
    return;
  }
  raiz.animate(
    [{ transform: `${desde.transform} scale(${w0 / w1}, ${h0 / h1})` }, { transform: fin.transform }],
    { pseudoElement: pseudo, duration: Number(duration) || DUR_COMPARTIDO, delay: Number(delay) || 0, easing, fill: "both" }
  );
}

/** El retrato de una partida que se ve ahora mismo (fila, héroe de Hoy). */
export function retratoVisible(id: string | undefined | null): Element | null {
  if (!id) return null;
  for (const el of Array.from(document.querySelectorAll(`[data-retrato="${CSS.escape(id)}"]`))) {
    if ((el as HTMLElement).offsetParent !== null) return el;
  }
  return null;
}
/** El retrato de la miga del reproductor que está a la vista. */
export function retratoDelReproductor(): Element | null {
  for (const el of Array.from(document.querySelectorAll("[data-retrato-destino]"))) {
    if ((el as HTMLElement).offsetParent !== null) return el;
  }
  return null;
}

// ───────────────────────────────────────────────────────────── primera visita
/** Los bloques que entran: los marcados con `data-e` o, si no hay, los hijos
 *  del primer contenedor que tenga varios. Sin medir nada. */
function bloquesDe(root: HTMLElement): HTMLElement[] {
  const marcados = Array.from(root.querySelectorAll<HTMLElement>("[data-e]"));
  if (marcados.length) return marcados.slice(0, MAX_BLOQUES);
  let el: Element = root;
  for (let i = 0; i < 8 && el.children.length === 1; i++) el = el.children[0];
  return Array.from(el.children)
    .filter((c): c is HTMLElement => c instanceof HTMLElement && !c.hasAttribute("data-enter-skip") && c.getAttribute("role") !== "tablist")
    .slice(0, MAX_BLOQUES);
}

function animar(el: HTMLElement, retraso: number, duracion: number, subida: number) {
  el.animate(
    [
      { opacity: 0, transform: `translateY(${subida}px)` },
      { opacity: 1, transform: "none" },
    ],
    // `backwards` y no `both`: al acabar no deja un `transform` puesto, que
    // convertiría el bloque en contenedor de sus `position: fixed`.
    { duration: duracion, delay: retraso, easing: E_OUT, fill: "backwards" }
  );
}

/** La entrada de una pantalla la primera vez que se ve. */
export function entradaPrimeraVez(root: HTMLElement): void {
  if (typeof root.animate !== "function" || conTeclado()) return;
  const subida = movimientoReducido() ? 0 : 6;
  const bloques = bloquesDe(root);
  bloques.forEach((el, i) => animar(el, i * PASO_MS, ENTRADA_MS, subida));
  Array.from(root.querySelectorAll<HTMLElement>("[data-enter-item]"))
    .slice(0, MAX_FILAS)
    .forEach((el, i) => animar(el, 80 + i * PASO_FILA_MS, ENTRADA_MS, subida / 2));
  // La transición de la pantalla, si la hay, se limita a fundir: el
  // movimiento ya lo ponen los bloques (index.css, `data-primera`).
  html().dataset.primera = "";
}

/**
 * La entrada de la primera visita cuando `visible` pasa a verdadero por primera
 * vez. Si lo que hay es un esqueleto, espera a que llegue el contenido (hasta
 * 3 s): animar el esqueleto y que luego los datos saltaran de golpe era peor.
 */
export function useEntradaPrimeraVez(
  ref: RefObject<HTMLElement | null>,
  visible: boolean,
  { saltarPrimera = false }: { saltarPrimera?: boolean } = {}
): void {
  const hecha = useRef(false);
  useLayoutEffect(() => {
    if (!visible || hecha.current) return;
    hecha.current = true;
    if (saltarPrimera) return;
    const el = ref.current;
    if (!el) return;
    const cargando = () => !!el.querySelector(".skeleton, [aria-busy='true']");
    if (!cargando()) {
      entradaPrimeraVez(el);
      return;
    }
    const mo = new MutationObserver(() => {
      if (cargando()) return;
      mo.disconnect();
      entradaPrimeraVez(el);
    });
    mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-busy", "class"] });
    const t = window.setTimeout(() => mo.disconnect(), 3000);
    return () => {
      mo.disconnect();
      window.clearTimeout(t);
    };
    // `ref` es estable; manda `visible`.
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ──────────────────────────────────────────────────── lo que cambia en su sitio
/** Fundido con 2 px de desenfoque para lo que se sustituye en el mismo sitio:
 *  disimula el cruce entre lo viejo y lo nuevo. */
export function cambio(elementos: Iterable<Element>): void {
  if (conTeclado()) return;
  const reducido = movimientoReducido();
  for (const el of elementos) {
    if (!(el instanceof HTMLElement) || typeof el.animate !== "function") continue;
    el.animate(
      [
        { opacity: 0, filter: reducido ? "none" : "blur(2px)", transform: reducido ? "none" : "translateY(3px)" },
        { opacity: 1, filter: "none", transform: "none" },
      ],
      { duration: CAMBIO_MS, easing: E_OUT, fill: "backwards" }
    );
  }
}

/**
 * `cambio` sobre `ref` (o sobre los hijos que casen con `selector`) cada vez
 * que `clave` cambia, menos la primera. Para pestañas y bloques.
 */
export function useCambio(ref: RefObject<HTMLElement | null>, clave: unknown, selector?: string): void {
  const primera = useRef(true);
  useLayoutEffect(() => {
    if (primera.current) {
      primera.current = false;
      return;
    }
    if (clave === null || clave === undefined || clave === false) return;
    const el = ref.current;
    if (!el) return;
    cambio(selector ? Array.from(el.querySelectorAll(selector)) : [el]);
  }, [clave]); // eslint-disable-line react-hooks/exhaustive-deps
}
