/**
 * Mezcla un color con transparencia.
 *
 * Existe porque el código traía un patrón que deja de funcionar en cuanto los
 * colores pasan a ser tokens: concatenar el alfa al hex (`${color}60`). Eso solo
 * vale si `color` es literalmente un hex de 6 dígitos, así que ataba cada color
 * interpolado a un valor escrito a mano.
 *
 * `color-mix()` acepta cualquier color CSS, incluido `var(--win)`, así que el
 * mismo código sirve para tokens y para hex sueltos.
 *
 * Equivalencias con el patrón viejo (el sufijo es alfa sobre 255):
 *   `${c}15` -> mix(c, 8)    `${c}22` -> mix(c, 13)
 *   `${c}30` -> mix(c, 19)   `${c}60` -> mix(c, 38)
 */
export const mix = (color: string, percent: number): string =>
  `color-mix(in srgb, ${color} ${percent}%, transparent)`;
