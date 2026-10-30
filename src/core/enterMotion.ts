import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Entrada escalonada de lo que aparece: una pantalla al llegar a ella, una
 * partida al abrirla, una pestaña o la hoja de estadísticas.
 *
 * El usuario (2026-10-29): «todo aparece de golpe… sigue pareciendo muy
 * estático». Navegar era un fundido de 120 ms del panel entero. Ahora los
 * bloques visibles entran uno detrás de otro, en orden de lectura: suben 8 px
 * y se funden en 220 ms con una ease-out fuerte, 35 ms entre uno y el
 * siguiente. Toda la cascada cabe en menos de medio segundo y nunca bloquea:
 * se puede pulsar mientras entra.
 *
 * Va con la Web Animations API y no con clases: cada pantalla tiene su propia
 * estructura, y esto encuentra sus bloques sola. Recorre desde la raíz y baja
 * por los contenedores altos (más de media pantalla) hasta dar con piezas que
 * se leen como una: una tarjeta, una sección, la cabecera de una lista. Las
 * filas de una lista entran aparte, más deprisa, si llevan `data-enter-item`
 * (las de una lista virtualizada se mueven con `transform`, así que se anima
 * la fila de dentro, no su envoltorio).
 *
 * Reglas (movimiento.md y la skill de Emil Kowalski):
 * - Solo lo que se ve: lo que queda por debajo del borde de la ventana no se
 *   anima, no hay nada que mirar.
 * - Nada si se llegó con el teclado (`<html data-nav="kbd">`): quien navega con
 *   el teclado ya sabe adónde va.
 * - Movimiento reducido: el fundido se queda, el desplazamiento no.
 * - `fill: backwards` y no `both`: al acabar no deja un `transform` puesto, que
 *   convertiría cada bloque en el contenedor de sus `position: fixed`.
 */

const DURACION = 220;
const PASO = 35;
const PASO_FILA = 22;
const MAX_BLOQUES = 9;
const MAX_FILAS = 14;
const SUBIDA = 8;
/** Ease-out fuerte (Emil): arranca rápido, se posa. */
const CURVA = "cubic-bezier(0.23, 1, 0.32, 1)";

/** Las animaciones en curso por elemento, para cortar la anterior si se repite. */
const enCurso = new WeakMap<Element, Animation>();

const reducido = () =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Los hijos que ocupan sitio: ni ocultos, ni fuera del flujo (un asa de
 *  redimensionar, una etiqueta flotante), ni vacíos. Una barra de pestañas
 *  tampoco: es el control con el que se cambia lo de al lado, y si volviera a
 *  entrar en cada cambio parecería que se ha pulsado otra cosa. */
function enFlujo(el: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const c of Array.from(el.children)) {
    if (!(c instanceof HTMLElement)) continue;
    if (c.getAttribute("role") === "tablist" || c.hasAttribute("data-enter-skip")) continue;
    const cs = getComputedStyle(c);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    if (cs.position === "absolute" || cs.position === "fixed") continue;
    const r = c.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    out.push(c);
  }
  return out;
}

/** Si dentro hay varias piezas, atravesando envoltorios de un solo hijo (el
 *  bloque abierto de la hoja va dentro de su sección). */
function abrible(el: HTMLElement): boolean {
  let cur: HTMLElement = el;
  for (let i = 0; i < 6; i++) {
    const hijos = enFlujo(cur);
    if (hijos.length >= 2) return true;
    if (hijos.length === 0) return false;
    cur = hijos[0];
  }
  return false;
}

/**
 * `prof` cuenta los contenedores que se han ABIERTO; los envoltorios de un
 * solo hijo se atraviesan sin gastar nivel (cada pantalla tiene dos o tres
 * antes de llegar a algo), con `paso` como tope de seguridad.
 */
function bloques(el: HTMLElement, out: HTMLElement[], prof: number, alto: number, paso = 0) {
  const hijos = enFlujo(el);
  if (hijos.length === 0) {
    out.push(el);
    return;
  }
  // Un envoltorio de un solo hijo no es un bloque: se atraviesa.
  if (hijos.length === 1) {
    if (paso < 12) bloques(hijos[0], out, prof, alto, paso + 1);
    else out.push(hijos[0]);
    return;
  }
  for (const h of hijos) {
    // Un contenedor de casi un tercio de pantalla o más, con varias piezas
    // dentro, se abre (la rejilla de Hoy, sus dos columnas); lo demás es un
    // bloque. Tres niveles como mucho: más abajo ya son frases sueltas.
    const grande = h.getBoundingClientRect().height > alto * 0.3;
    if (grande && prof < 3 && !h.hasAttribute("data-enter-atomic") && abrible(h)) {
      bloques(h, out, prof + 1, alto, paso + 1);
    } else {
      out.push(h);
    }
  }
}

function animar(el: HTMLElement, retraso: number, subida: number) {
  enCurso.get(el)?.cancel();
  const a = el.animate(
    [
      { opacity: 0, transform: `translateY(${subida}px)` },
      { opacity: 1, transform: "translateY(0)" },
    ],
    { duration: DURACION, delay: retraso, easing: CURVA, fill: "backwards" }
  );
  enCurso.set(el, a);
  a.onfinish = a.oncancel = () => {
    if (enCurso.get(el) === a) enCurso.delete(el);
  };
}

/**
 * Si aún no hay nada que hacer entrar: un esqueleto que ocupa media pantalla o
 * más, o una pantalla vacía (Coach mientras llegan sus datos). Una línea de
 * esqueleto suelta (la lista de momentos del panel de la Biblioteca) no cuenta:
 * esperarla retrasaba toda la entrada.
 */
function sinContenido(root: HTMLElement): boolean {
  // Contra lo que mide el propio contenedor, no la pantalla: el panel de la
  // derecha con un aviso y un botón ya tiene contenido aunque sea poco.
  const caja = root.getBoundingClientRect();
  const vista = Math.max(1, Math.min(caja.width, window.innerWidth) * Math.min(caja.height, window.innerHeight));
  let esqueleto = 0;
  for (const s of Array.from(root.querySelectorAll(".skeleton"))) {
    const r = s.getBoundingClientRect();
    esqueleto += r.width * r.height;
  }
  if (esqueleto > vista * 0.08) return true;
  const lista: HTMLElement[] = [];
  bloques(root, lista, 0, window.innerHeight);
  // Un contenedor sin nada dentro (la caja de una pantalla que aún no ha
  // pintado sus datos) no es contenido aunque mida media pantalla.
  const ocupado = lista.reduce((s, el) => {
    if (el === root || (el.childElementCount === 0 && !el.textContent?.trim())) return s;
    const r = el.getBoundingClientRect();
    return s + r.width * r.height;
  }, 0);
  return ocupado < vista * 0.04;
}

/**
 * Hace entrar escalonado lo que se ve de `root`. Devuelve en cuánto acaba
 * (ms), por si alguien quiere encadenar algo detrás.
 */
export function enterBlocks(root: HTMLElement | null): number {
  if (!root || typeof root.animate !== "function") return 0;
  if (document.documentElement.dataset.nav === "kbd") return 0;
  const alto = window.innerHeight;
  const subida = reducido() ? 0 : SUBIDA;

  const lista: HTMLElement[] = [];
  bloques(root, lista, 0, alto);
  // En orden de lectura: de arriba abajo y, en la misma altura, de izquierda
  // a derecha (las dos columnas de Hoy entran a la par, no una y luego otra).
  const vistos = lista
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.bottom > 0 && r.top < alto)
    .sort((a, b) => Math.round(a.r.top / 24) - Math.round(b.r.top / 24) || a.r.left - b.r.left);

  vistos.forEach(({ el }, i) => animar(el, Math.min(i, MAX_BLOQUES - 1) * PASO, subida));

  // Las filas de las listas, detrás de su bloque y más deprisa.
  const desde = Math.min(vistos.length, 3) * PASO;
  const filas = Array.from(root.querySelectorAll<HTMLElement>("[data-enter-item]"))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.bottom > 0 && r.top < alto;
    })
    .slice(0, MAX_FILAS);
  filas.forEach((el, i) => animar(el, desde + i * PASO_FILA, subida / 2));

  return Math.max(Math.min(vistos.length, MAX_BLOQUES) * PASO, desde + filas.length * PASO_FILA) + DURACION;
}

/**
 * Lanza `enterBlocks` sobre `ref` cada vez que `key` cambia a un valor que no
 * es `false`/`null` (una pantalla que pasa a verse, una partida que se abre,
 * una pestaña elegida). Si aún no hay contenido (`sinContenido`), espera a
 * que llegue, hasta 3 s: animar el esqueleto y que luego el contenido
 * saltara de golpe era justo lo que no se quería. El observador salta en el
 * mismo commit que pinta el contenido, antes de que se vea.
 */
export function useEnterOnChange(
  ref: RefObject<HTMLElement | null>,
  key: unknown,
  { skipInitial = false }: { skipInitial?: boolean } = {}
): void {
  const primera = useRef(true);
  // Antes de pintar: si no, el primer fotograma sale entero y luego se apaga
  // para volver a entrar.
  useLayoutEffect(() => {
    const esPrimera = primera.current;
    primera.current = false;
    if (skipInitial && esPrimera) return;
    if (key === false || key === null || key === undefined) return;
    const el = ref.current;
    if (!el) return;
    if (!sinContenido(el)) {
      enterBlocks(el);
      return;
    }
    let hecho = false;
    const mo = new MutationObserver(() => {
      if (hecho || sinContenido(el)) return;
      hecho = true;
      mo.disconnect();
      enterBlocks(el);
    });
    mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-busy", "class"] });
    const t = window.setTimeout(() => mo.disconnect(), 3000);
    return () => {
      mo.disconnect();
      window.clearTimeout(t);
    };
    // `ref` es estable; lo que manda es `key`.
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}
