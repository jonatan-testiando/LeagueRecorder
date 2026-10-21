# Especificación de movimiento

La versión visual está en la página **Movimiento** del fichero de Figma: principios, tokens, curvas dibujadas, la coreografía de cada interacción en milisegundos y seis demos animadas que se reproducen con Presentar.

Este documento es la versión para implementar. Criterio: las skills `emil-design-eng`, `animate`, `animation-performance` y `review-animations` (Emil Kowalski) e `impeccable/animate`. Encima van tus reglas, que mandan: **sin rebote ni overshoot**, nada de overlays en partida, y contraste y legibilidad por delante del adorno.

## Objetivo

Que la app **se sienta rápida**. Eso no se consigue acortando animaciones, sino haciendo que el primer fotograma después del gesto ya responda. Tres consecuencias:

1. Respuesta en `pointerdown`, no en `click`.
2. Solo se anima lo que explica un cambio de estado que ha provocado el sistema. Lo que mueve la mano (scrub, arrastre) va sin transición.
3. Lo que se hace cien veces al día (navegar, filtrar, cambiar de pestaña o de suceso) lleva un fundido corto o nada.

## Tokens

Sustituyen a los de `src/index.css:240-252`. Los nombres viejos se quedan como alias durante la migración.

```css
:root {
  /* Duraciones */
  --t-press: 100ms;       /* pulsar: scale(.97) */
  --t-hover: 120ms;       /* hover de color y fondo (antes --t-instant 80) */
  --t-quick: 160ms;       /* tooltip, popover, menú, selector: entrada */
  --t-quick-exit: 100ms;  /* ...y su salida */
  --t-base: 200ms;        /* indicador de pestaña/segmentado, acordeón, toast */
  --t-slow: 260ms;        /* diálogo, panel lateral, plegar el rail */
  --t-slow-exit: 160ms;
  --t-nav: 120ms;         /* fundido al cambiar de sección */
  --t-stagger: 30ms;      /* escalonado, máximo 6 elementos */

  /* Curvas: ninguna con rebote */
  --e-out: cubic-bezier(0.16, 1, 0.3, 1);   /* entrar: rápido y se posa */
  --e-move: cubic-bezier(0.2, 0, 0, 1);     /* lo que ya existe va de A a B */
  --e-color: ease;                          /* color, fondo, borde */

  /* Distancias: el movimiento reducido las pone a cero */
  --rise: 4px;            /* asentarse (tarjetas, primera visita) */
  --rise-toast: 8px;
  --pop-scale: 0.97;      /* popover/menú/pulsar */

  /* Alias heredados, se borran al acabar la migración */
  --t-instant: var(--t-hover);
  --e-in: var(--e-out);   /* nunca ease-in: las salidas usan --e-out, más cortas */
}
```

- **Prohibido:** `bounce > 0`, `EASE_OUT_BACK`, springs subamortiguados y `transition: all`.
- Si se usa un spring de framer-motion, va con `{ type: "spring", bounce: 0, duration: … }`. Las skills de Emil recomiendan `bounce: 0.2`; aquí no se usa.

## Coreografía

Las barras dibujadas están en Figma. «Antes» describe lo que hay hoy en el código.

| Interacción | Qué se mueve | Duración y curva | Antes |
|---|---|---|---|
| Cambio de sección desde el rail | Opacidad del contenido, de 0 a 1 | `--t-nav` 120, `--e-out` | 220 ms + `translateY(6px)` (`index.css:1332`). En Patrones, dos a la vez |
| Cambio de sección desde el teclado (Ctrl K, atajos) | Nada | instantáneo | igual que con ratón |
| Pestañas del inspector y segmentados | Indicador: `transform` + `width`. Contenido: sin animación | `--t-base` 200, `--e-move` | el subrayado salta |
| Abrir Ctrl K con el teclado | Velo, solo opacidad | 100, `--e-out` | — |
| Abrir Ctrl K con un clic | Panel: opacidad + `scale(.98 → 1)` | `--t-quick` 160 | — |
| Cerrar Ctrl K | Opacidad | `--t-quick-exit` 100 | — |
| Menú, selector, popover | Opacidad + `scale(var(--pop-scale) → 1)` desde el disparador | entra 160, sale 100 | `pop-in` 140 + 4 px |
| Tooltip | Tras 400 ms en reposo: opacidad + scale 0,97. El siguiente sale al instante | 120 | — |
| Toast | Entra: `translateY(var(--rise-toast) → 0)` + opacidad. Sale: opacidad | entra 200, sale 150 | `toast-left` |
| Esqueleto → contenido | Esqueleto a los 150 ms; contenido con fundido cruzado | 120 / 160, mínimo 300 ms visible | spinners sueltos y estado vacío |
| Pulsar un botón o una fila | `scale(.97)` en el `pointerdown`; al soltar vuelve | 100 / 160, `--e-out` | sin respuesta al pulsar |
| Hover | Fondo y color, solo con `(hover: hover) and (pointer: fine)` | 120, `--e-color` | 80 |
| Primera visita a Hoy (una vez por sesión) | Héroe y momentos: opacidad + `translateY(var(--rise))`, escalonados 30 ms | 200 c/u, 290 en total | `card-in` en cada tarjeta y cada vez |
| Abrir una partida (el rail se pliega) | Rail con `clip-path`. Etiquetas: opacidad. El vídeo salta al tamaño final al acabar | 260 / 100 | `width` animado (reflujo) |
| Indicador de grabación | Halo: `transform: scale` + opacidad en bucle de 2 s | 2 s | `box-shadow` animado (`index.css:1347`) |
| Barras de progreso | `transform: scaleX(var(--p))` | `--t-base`, `--e-move` | `transition: width` (`index.css:679, 727, 2015, 2032, 2214`) |

## Lo que nunca se anima

- Scrub y cursor de reproducción: los mueve la mano, con latencia cero.
- Listas virtualizadas (Biblioteca, sucesos, clips): sin animación de entrada, porque se redispara al hacer scroll. Ya está escrito en `index.css:940`; se mantiene.
- Cifras: nada de contadores que suben. Los datos están para leerlos.
- Gráficos (ventaja, WP, APM): aparecen ya dibujados.
- Todo lo que dispara el teclado: atajos, Ctrl K, ↑↓ en listas y Enter.
- El suceso activo mientras se reproduce: lo mueve el vídeo.
- El cambio de tema: inmediato y sin fundido. Animar el color de cientos de nodos cuesta más de lo que aporta.

## Movimiento reducido

Hoy, `index.css:965` pone todas las duraciones a 0,01 ms. Eso congela los spinners (parece que la app se ha colgado) y quita también los fundidos, que no marean a nadie. Hay que sustituirlo por:

```css
@media (prefers-reduced-motion: reduce) {
  :root {
    --rise: 0px;
    --rise-toast: 0px;
    --pop-scale: 1;
    --t-base: 150ms;
    --t-slow: 150ms;
  }
  /* Bucles parados */
  .rec-dot::after,
  .skeleton { animation: none; }
  .skeleton { opacity: 0.7; }
  /* El spinner del botón se sustituye por un texto de progreso */
  .btn[data-loading] .btn__spinner { display: none; }
  .btn[data-loading] .btn__label::after { content: "…"; }
  /* Plegar el rail: sin recorte animado */
  .rail { transition: none; }
}

@media (prefers-reduced-transparency: reduce) {
  :root {
    --glass: var(--panel);
    --glass-blur: none;
  }
}
```

- Se quedan los fundidos de 150 ms como máximo y los cambios de color. Se van los desplazamientos, las escalas y los bucles.
- **Verificación:** con el arnés y `reducedMotion: 'reduce'` (`herramientas/a11y.mjs` ya lo emula):
  - el cambio de sección se funde, pero no se mueve;
  - el punto de grabación queda fijo;
  - ningún spinner gira.

## Esqueleto, spinner o barra

| Qué carga | Qué se enseña |
|---|---|
| Contenido que se va a pintar (paneles, listas, héroe) | **Esqueleto** con la geometría final |
| Acción lanzada desde un botón que tarda menos de 2 s («Comprobar la clave», «Sincronizar») | **Spinner dentro del botón**, con el verbo en gerundio («Comprobando…») |
| Proceso de más de 2 s (análisis, subida, actualización) | **Barra con porcentaje** y lo que queda |

Nunca: un spinner a pantalla completa, el estado vacío mientras carga, ni un esqueleto que aparezca y desaparezca en menos de 300 ms.

```ts
// src/core/useDelayedLoading.ts (propuesto)
// true solo si la carga pasa de `delay` ms y, una vez visible, lo sigue al menos `min` ms.
export function useDelayedLoading(loading: boolean, delay = 150, min = 300): boolean
```

## Rendimiento

- **Qué se anima:**
  - Solo `transform` y `opacity`.
  - `clip-path` solo para plegar el rail.
  - `width` solo en el indicador de pestaña: es pequeño, va en posición absoluta y no tiene hijos.
- **Qué no se anima:** `box-shadow`, `background-position`, `width`/`height` de contenedores ni `filter: blur` en listas.
- **`will-change`:** solo mientras dura la animación, y nunca en `*` ni en contenedores grandes.
- **Desenfoque:**
  - Máximo 16 px.
  - Solo en superficies estructurales: barra de título, HUD del reproductor, lista de reproducción, toasts y Ctrl K.
  - En una lista se paga por cada fila (`ui-design-system`).
- **Sin `setState` por fotograma:** estilos por `ref` o valores de movimiento.
- **Indicadores de pestañas en CSS:** con `layoutId` de framer-motion pierden fotogramas al navegar (skill `animation-performance`). Hoy `framer-motion` solo se usa en `ErrorPlayer.tsx`; si ese uso se va, la dependencia también.
- **Activar transiciones tras el primer pintado.** Las transiciones de los indicadores se activan después del primer pintado (`data-ready`). Si no, la pestaña inicial «llega» deslizándose al abrir la app.

## Cómo se aplica en el código

Recetas cortas. Los ficheros exactos y el orden están en el [plan de implementación](plan-de-implementacion.md).

```css
/* Navegación: solo opacidad, y nada si vino del teclado */
.panel-enter { animation: panel-fade var(--t-nav) var(--e-out) both; }
@keyframes panel-fade { from { opacity: 0; } to { opacity: 1; } }
:root[data-nav="kbd"] .panel-enter { animation: none; }

/* Pulsar */
.btn { transition: transform var(--t-press) var(--e-out), background-color var(--t-hover) var(--e-color); }
.btn:active:not(:disabled) { transform: scale(var(--pop-scale)); }
@media (hover: hover) and (pointer: fine) {
  .btn--secondary:hover { background: var(--overlay); }
}

/* Punto de grabación: halo con transform, no con box-shadow */
.rec-dot { position: relative; }
.rec-dot::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--signal);
  animation: rec-ring 2s var(--e-out) infinite;
}
@keyframes rec-ring {
  from { transform: scale(1);   opacity: 0.5; }
  to   { transform: scale(2.4); opacity: 0; }
}

/* Barras de progreso */
.bar__fill {
  transform-origin: left;
  transform: scaleX(var(--p));
  transition: transform var(--t-base) var(--e-move);
}
```

- **Origen de la navegación:** `CommandPalette.tsx` y los atajos ponen `document.documentElement.dataset.nav = "kbd"` antes de `navigate()`. El rail lo pone a `"ptr"`.
- **Primera visita a Hoy:** `HomePanel` marca `sessionStorage["hoy-visto"]` (con try/catch) y solo la primera vez añade `.hoy--entrada`, que escalona héroe y momentos con `animation-delay: calc(var(--i) * var(--t-stagger))`.
