import { useLayoutEffect, type RefObject } from "react";

/**
 * Coloca el indicador de un segmentado o de unas pestañas debajo de la opción
 * activa, escribiendo `--ind-x` y `--ind-w` en el carril.
 *
 * - Las opciones se marcan con `data-ind-opt`; el carril tiene que ser
 *   `position: relative` para que `offsetLeft` cuente desde él.
 * - Un ResizeObserver vuelve a medir si cambia el ancho de una etiqueta (otro
 *   idioma, la fuente que llega tarde) o si el panel estaba oculto: la app
 *   monta las rutas ocultas con `display: none` y ahí todo mide 0.
 * - Sin medida (oculto, o ninguna opción activa) el carril pierde
 *   `data-measured` y la opción activa pinta su propio fondo.
 * - `data-ready` se pone un fotograma después de la primera medida: si la
 *   transición estuviera activa desde el principio, el indicador «llegaría»
 *   deslizándose al abrir la pantalla.
 */
export function useIndicator(railRef: RefObject<HTMLElement | null>, activeIndex: number, deps: unknown[] = []) {
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    let raf = 0;
    const opts = () => Array.from(rail.querySelectorAll<HTMLElement>("[data-ind-opt]"));
    const place = () => {
      const el = opts()[activeIndex];
      if (!el || el.offsetWidth === 0) {
        rail.removeAttribute("data-measured");
        return;
      }
      rail.style.setProperty("--ind-x", `${el.offsetLeft}px`);
      rail.style.setProperty("--ind-w", `${el.offsetWidth}px`);
      rail.setAttribute("data-measured", "");
      if (!rail.hasAttribute("data-ready")) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => rail.setAttribute("data-ready", ""));
      }
    };
    place();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    ro?.observe(rail);
    opts().forEach((el) => ro?.observe(el));
    return () => {
      ro?.disconnect();
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, ...deps]);
}
