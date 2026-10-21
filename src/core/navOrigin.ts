/**
 * De dónde viene una navegación, para animarla o no.
 *
 * Lo que empieza en el teclado (Ctrl K, Intro sobre el rail, atajos) no se
 * anima: quien navega con el teclado ya sabe adónde va, y un fundido solo le
 * hace esperar. Con el ratón, el contenido nuevo se funde en 120 ms
 * (movimiento.md). El CSS lo lee de `<html data-nav>`.
 */
export type NavOrigin = "kbd" | "ptr";

export function setNavOrigin(origin: NavOrigin): void {
  document.documentElement.dataset.nav = origin;
}

/** Un `click` lanzado con Intro o Espacio llega con `detail === 0`. */
export const originOf = (e: { detail: number }): NavOrigin => (e.detail === 0 ? "kbd" : "ptr");
