# Auditoría de la interfaz (2026-10-20)

Base: `main` en 82e4163 a través del arnés (`dev-harness.html`, datos simulados) y la **app instalada v1.2.36 con tus datos reales**, abierta por CDP. Se capturaron 31 vistas en tema oscuro y claro, a 1280×800 y a 1920×1080 (124 capturas), y 20 más de la app real. Todo está en [`capturas/`](capturas/).

Las cifras salen de un censo hecho en la propia página, sin estimar a ojo ([`herramientas/shots.mjs`](herramientas/shots.mjs) → [`medidas/censo-arnes.json`](medidas/censo-arnes.json)):

- contraste WCAG de cada texto visible contra su fondo real, mezclando las capas translúcidas;
- tamaños, pesos y familias de letra;
- paddings, márgenes y huecos fuera de la rejilla de 4 px;
- radios;
- textos recortados;
- objetivos de clic de menos de 24 px;
- animaciones en curso y CLS.

La app real se midió con [`herramientas/realperf.mjs`](herramientas/realperf.mjs): recarga y muestreo cada 40 ms de qué se ve.

Criterio: las skills instaladas (Impeccable `audit`/`critique`/`layout`/`typeset`, y las de Emil Kowalski para el movimiento) y tus restricciones, que mandan sobre cualquier regla genérica:
- texto a 10-11:1, nunca negro ni blanco puros;
- sin rebote;
- EN/ES;
- nada de overlays durante la partida.

> **Dato que cambia el diseño:** la app instalada está en **tema claro**. El claro no es el tema secundario, es el que usas. Además, la piel vigente no es «Grafito y naranja», que duró solo la v1.2.26, sino **«Marino y oro, suave»** (`src/index.css`, desde la v1.2.27).

Severidad:
- **P0**: rompe o confunde a todo el mundo.
- **P1**: molesta a diario o incumple una restricción tuya.
- **P2**: pule.
- **P3**: detalle.

## Resumen: los diez que más pesan

| # | Problema | Sev. | Categoría |
|---|---|---|---|
| R1 | Al arrancar se ven entre 150 y 300 ms la app **en inglés y en oscuro**, y después cambia a español y claro: un fogonazo oscuro de pantalla completa para quien usa el tema claro | P0 | Rendimiento percibido |
| R2 | Mientras carga, Hoy y la Biblioteca enseñan el **estado vacío** («Juega una partida, se graba sola», «Sin clasificar») a un usuario con 27 partidas | P0 | Rendimiento percibido |
| R3 | No hay `ErrorBoundary`: un `null` en un panel deja **la ventana entera en negro**, barra de título incluida, sin poder ni cerrarla | P0 | Rendimiento percibido |
| R4 | El texto principal del oscuro está a **12,7:1** sobre el fondo y **11,8:1** sobre el panel, por encima de tu tope de 11. En claro, `--faint` **suspende AA** (4,23) en subtítulos, grupos y metadatos | P1 | Accesibilidad / visualización |
| R5 | La mitad del texto que se lee es secundario: la mediana del cuerpo es **7,8:1 en oscuro y 6,4:1 en claro**, no los 10-11 que pediste para leer | P1 | Visualización |
| R6 | Se filtra un id interno: **«Te mata minion_t200l1s07n0026»** | P1 | Información |
| R7 | Escala tipográfica y de espaciado sin disciplina: **10 tamaños de letra** en Hoy (12/12,5/13/13,5…), **11 radios**, el **52 %** de los paddings fuera de la rejilla de 4 px y 685 espaciados literales frente a 110 con token | P1 | Consistencia / espaciado |
| R8 | A 1920 nada tiene ancho máximo: el héroe de Hoy mide 1.640 px con un hueco de 700 px en medio, y en la Biblioteca las cifras se van 900 px a la derecha del nombre | P1 | Espaciado |
| R9 | Una partida sin sincronizar repite «no sincronizada» en 4-6 bloques con «Reintentar», que no arregla nada. El héroe de Hoy dedica la parte de arriba a «Sin resultado» y a tres guiones | P1 | Información |
| R10 | Seis controles segmentados y siete chips distintos que hacen lo mismo. El movimiento reducido es un interruptor a 0,01 ms que congela spinners y quita incluso los fundidos | P1 | Consistencia / movimiento |

---

## 1. Visualización

**V1. El texto principal pasa de 11:1 en oscuro. P1.**
- `--text #D4D0CA` da 12,67 sobre `--ground` y 11,81 sobre `--panel`; sobre `--sunken` (los campos) llega a 13,12.
- Tu regla es 10-11 en los dos temas. En claro sí se cumple: `#2D333D` da 11,0 sobre el panel y 10,2 sobre el fondo.
- Dónde: `src/index.css:69` (`--text`) y `:61` (`--sunken`).
- Propuesta: `--text #C6C2BC`, que da 10,97 sobre el fondo y 10,23 sobre el panel. Es la palanca que dejaste escrita: si vuelve a molestar, se toca el texto y no el fondo.

**V2. Los campos son casi negros. P1.**
- `--sunken #04070E` (L 0,128) está por debajo del fondo de la ventana. Los inputs, selects y cajas de tiempo se leen como agujeros negros: «CABLE Output», la región del asistente, la clave de Riot, los chips de tiempo de Ctrl K y «Temporal · 72 h» en Clips.
- Capturas: [Ajustes](capturas/dark-1280/ajustes-recording.jpg), [asistente](capturas/dark-1280/onboarding-1.jpg), [Clips](capturas/dark-1280/clips.jpg).
- Dónde: `src/index.css:61`. En Clips, además, el `<select>` nativo trae su propio fondo (`ClipsGallery.tsx:623`).
- Propuesta: `--sunken #0B111B`, entre el fondo y el panel, con la sombra interior de siempre, y selects con estilo propio.

**V3. El escenario del vídeo es gris en tema claro. P2.**
- La franja de letterbox es gris claro (`#D9DCE2`) alrededor de un vídeo oscuro, y el marco claro hace que el vídeo parezca apagado.
- Captura: [real, claro](capturas/real/light-1280-reproductor-revision.jpg).
- Dónde: `VideoPlayer.css:171` (`.vp-stage`) y `:238` (`.vp-video`).
- Propuesta: token `--stage`, siempre marino (`#080D16`) en los dos temas. Es lo único oscuro del tema claro, y es a propósito.

**V4. El tinte de resultado hace persiana en claro. P2.**
- En la Biblioteca real, 26 filas seguidas alternan franjas verdes y rosas a todo lo ancho.
- Captura: [real, claro, 1920](capturas/real/light-1920-biblioteca.jpg).
- Dónde: `--tint-win`/`--tint-loss` (`index.css:121-122`); en claro se ven más porque el mismo 16 % pesa más sobre papel.
- Propuesta: el resultado va en una barra vertical de 3 px y en la palabra «Victoria»/«Derrota». El tinte, solo al pasar el ratón o al seleccionar.

**V5. Los botones fantasma pequeños apenas se ven. P1.**
- «Descargar», «Quitar» y «Campeón»: 3,8:1 en oscuro y 2,7-2,2:1 en claro.
- Dónde: `.btn--ghost.btn--sm` en `index.css` (sección de primitivos). En Training, la opción «Campeón» además parece desactivada sin estarlo.
- Propuesta: el fantasma usa `--muted`, que da 7,2 sobre el panel, y el desactivado se marca con un icono de candado o un tooltip, no solo con el color.

**V6. La línea de tiempo amontona retratos. P2.**
- Dos filas de retratos de 20 px que se pisan en los momentos de pelea, con guías de líneas cruzadas. Con 30 o más eventos (el arnés tiene 33) no se distingue qué es qué.
- Captura: [reproductor](capturas/dark-1280/reproductor-revision.jpg).
- Dónde: `VideoPlayer.tsx`, carril de eventos.
- Propuesta: marcas de 8 px por tipo (punto o rombo con el color del tinte) que se agrupan en un racimo con número cuando se tocan. El retrato aparece al pasar por encima.

## 2. Información y jerarquía

**I1. Se filtra un id interno de Riot. P1.**
- «Te mata minion_t200l1s07n0026», en la Revisión y en el panel de la Biblioteca.
- Captura: [real](capturas/real/light-1280-reproductor-revision.jpg).
- Dónde: `src/core/eventText.ts:96-97` usa `ev.actor` tal cual. Los asesinos que no son campeones (súbditos, torres, monstruos) necesitan un nombre: «Te matan los súbditos», «Te mata la torre».

**I2. Con la última partida sin sincronizar, el héroe de Hoy no dice nada. P1.**
- «Sin resultado» a 40 px, tres guiones y «falta sincronizar». Es la parte más valiosa de la pantalla gastada en una partida de «Otra cola» de 11 minutos.
- Captura: [real](capturas/real/light-1280-hoy.jpg).
- Dónde: `HomePanel.tsx` (cálculo de `ultima`, cerca de `:323`).
- Propuesta: el héroe enseña la última partida **con datos**. Si hay una más nueva sin sincronizar, va encima en una línea: «Annie · hace 39 min · sin sincronizar · Sincronizar».

**I3. Una partida sin sincronizar repite el mismo aviso en seis sitios. P1.**
- En Partida: «Aún no hay baremos», «No moriste», «Lee antes el vídeo», «No se pudieron leer las oleadas», «Sincroniza la partida para verlas».
- En Impacto: cuatro bloques, y dos de ellos con «Reintentar» y errores encadenados, como «No se pudo calcular el reparto de crédito: Esta partida aún no está sincronizada con Riot».
- Capturas: [Partida](capturas/real/light-1280-reproductor-partida.jpg), [Impacto](capturas/real/light-1280-reproductor-impacto.jpg).
- Dónde: `ImpactTab.tsx:244`, `:451` (`String(e)` metido en la frase) y `MatchTab.tsx`.
- Propuesta: un único aviso arriba («Esta partida no está sincronizada con Riot» + **Sincronizar**), y debajo solo los bloques que tienen datos. Fuera el «Reintentar» cuando la causa es la sincronización.

**I4. Las fechas de los grupos salen en ISO. P2.**
- Pasados 7 días, los grupos de la Biblioteca dicen «2026-09-05 · 3 partidas» al lado de «Hoy» y «Ayer».
- Dónde: `src/core/time.ts:56`, que devuelve `iso.split(" ")[0]`.
- Propuesta: «Viernes, 5 sep» con `Intl.DateTimeFormat`, en el idioma de la interfaz.

**I5. Signo y decimales sin unificar. P2.**
- «Victoria 16 LP» en una fila y «+20 LP» en la siguiente (Biblioteca real).
- «48.0 MB» con punto en una interfaz en español (`ClipsGallery.tsx:108-110`, `toFixed`).
- Ya existe `formatDecimal`: hay que usarlo en todas partes.

**I6. La columna «Revisión» repite lo mismo 26 veces. P2.**
- 26 chips dorados de «Por revisar» seguidos: el estado por defecto ocupa una columna entera.
- Propuesta: marcar solo lo excepcional (✓ Revisada) y que «Por revisar» sea el filtro de arriba, que ya existe.

**I7. La cabecera del reproductor se recorta a 1280. P2.**
- «Clasif. Solo/Dúo · 26:45 · hoy 01:17 · 7.º de 10 por…».
- En el transporte, «Movi…»/«Came…» se recortan, y en la v1.2.36 se salían el menú y la pantalla completa.
- Dónde: `VideoPlayer.tsx` (cabecera) y `VideoPlayer.css:526-547`. El segmentado de velocidad (5 botones, unos 230 px) es lo que más ocupa.
- Propuesta: la velocidad en un solo botón «1×» con menú, y el detalle de la cola en un tooltip.

**I8. Cada pantalla tiene un ancho de contenido distinto. P2.**
- Training se corta a 820-1068 px, Ajustes a 770, y Hoy y la Biblioteca van a todo lo ancho.
- Propuesta: dos anchos máximos y nada más: **1360** para paneles de datos y **960** para formularios.

## 3. Espaciado y densidad

**E1. Sin rejilla. P1.**
- En Hoy, 88 de los 168 paddings y márgenes (52 %) no son múltiplos de 4. Hay 19 valores de padding distintos y huecos de 2, 5, 6, 10 y 14 px.
- En el código: 685 declaraciones de espaciado literales frente a 110 con `var(--space-*)`. Los tokens de espaciado existen (`index.css:205-212`), pero casi no se usan.
- Propuesta: escala de 4 (4/8/12/16/20/24/32/40/48/64) y tres ritmos fijos:
  - 12 dentro de una tarjeta;
  - 20 de padding de tarjeta;
  - 32 entre secciones.

**E2. Huecos a 1920. P1.**
- En el héroe de Hoy, las cifras ocupan el 40 % izquierdo y el resto es degradado. Las tarjetas de momento se estiran hasta 400 px con media tarjeta vacía.
- En la Biblioteca, la columna «Partida» es `minmax(0, 1fr)` (`MatchGallery.css:299`): todo el ancho sobrante va al nombre y las cifras quedan a 900 px.
- Capturas: [Hoy, 1920](capturas/dark-1920/hoy.jpg), [Biblioteca real, 1920](capturas/real/light-1920-biblioteca.jpg).
- Propuesta: ancho máximo 1360 centrado en Hoy, Patrones y Coach. En la Biblioteca, la columna de nombre se limita a 360 px y la tabla se centra.

**E3. El inspector del reproductor es un rollo de tres pantallas. P2.**
- La pestaña Partida mide 1.779 px en un hueco de 638 (2,8 pantallas) con nueve bloques plegables.
- Propuesta: arriba, «Lo que decidió la partida» con 3 líneas. El resto en acordeón con solo el primero abierto, y una barra de anclas.

## 4. Consistencia

**C1. Diez tamaños de letra en una pantalla. P1.**
- En Hoy: 11, 12, 12,5, 13, 14, 15, 16, 24, 26 y 40. En el reproductor: 11, 12, 12,5, 13, 13,5, 14 y 16, con 16 textos a 11 px.
- En el CSS: 111 × 13 px, 88 × 12, 44 × 12,5, 18 × 13,5…
- Los tokens `--font-*` se usan 4 veces en toda la app.
- Propuesta: seis tamaños de texto (12/13/14/16/20/28) y dos de cifra (22/40). Fuera los medios puntos.

**C2. Trece radios. P2.**
- En el CSS: 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16 y 999 px. En Hoy se ven 11 a la vez.
- Lo que ya decidiste en el lienzo de Refero era dos radios más la píldora (`rediseno-refero-2026-09`), y no llegó a aplicarse.
- Propuesta: 4 para kbd y marcas, 8 para controles, 12 para tarjetas y 999 para chips.

**C3. Seis controles segmentados y siete chips. P1.**
- Segmentados: `tp-seg`, `cg-seg`, `lib-seg`, `pp-seg`, el de Calidad en Ajustes y las pestañas de Training, que son botones con borde.
- Chips: `lib-pill`, `home-pill`, `home-chip`, `cg-chips`, `vp-chip`, `pp-chip` y `lc-chip`.
- Pestañas: el subrayado de `vp-tabs` y la lista vertical de Ajustes.
- Captura: [Training](capturas/dark-1280/training-ejercicios.jpg) frente a [Clips](capturas/dark-1280/clips.jpg).
- Propuesta: **un** `Segmented`, **un** `Tabs` y **un** `Chip` en `src/components/ui/` (ver «Componentes» en Figma).

**C4. 307 `style={{…}}` en línea. P2.**
- Los valores de los estilos en línea no pasan por los tokens, así que cada pantalla deriva por su cuenta. Es la causa de raíz de C1 y E1.
- Propuesta: mover los estilos en línea a CSS con tokens a medida que se toque cada pantalla. No hace falta hacerlo todo de golpe.

**C5. La miniatura del clip es el reproductor nativo de Chromium. P2.**
- Barra gris con play, volumen y pantalla completa del navegador, distinta de todo lo demás.
- Dónde: `ClipsGallery.tsx:517` (`<video controls>`).
- Propuesta: un póster con el primer fotograma, la duración en `--font-mono` y un botón de play propio. Al pulsarlo se abre el reproductor de la app.

## 5. Rendimiento percibido

**P1. Fogonazo de inglés y tema oscuro al arrancar. P0.**
- Medido en la app real, en tres rutas: inglés y `data-theme` vacío u oscuro hasta los 146-304 ms, y después español y claro.
- `LanguageProvider` arranca con `"en"` (`src/core/LanguageProvider.tsx:32`) y `ThemeProvider` con `"dark"` (`src/core/ThemeProvider.tsx:33`) hasta que llega `get_config`. `index.html` dice `lang="en"`.
- Propuesta: guardar tema e idioma en `localStorage` como pista de arranque y aplicarlos en un `<script>` en línea de `index.html`, antes de montar React. La configuración en disco sigue mandando.

**P2. El estado vacío aparece durante la carga. P0.**
- En la app real, «Juega una partida» se ve entre los 135 y los 292 ms y las filas llegan a los 328.
- En el arnés con el IPC lento sale lo mismo, y además el rail dice «Sin clasificar».
- Capturas: [cargando Hoy](capturas/dark-1280/carga-hoy.jpg), [cargando la Biblioteca](capturas/dark-1280/carga-biblioteca.jpg).
- Dónde: `HomePanel.tsx:323` (`own.length === 0`) no mira `isLoading`, que `useGallery` sí tiene (`useGallery.ts:15`).
- Propuesta: tres estados distintos (cargando, vacío y con datos), y un esqueleto con la forma final, que solo aparece si la carga pasa de 150 ms.

**P3. Sin `ErrorBoundary`. P0.**
- En el arnés, la falta de un doble de `get_jungle_routes` devuelve `null`, `rutas.filter` revienta y la ventana entera queda en negro.
- Captura: [Patrones en negro](capturas/dark-1280/patrones.jpg).
- Dónde: `src/main.tsx:19-43` (nada envuelve `<App/>`) y `PatternsPanel.tsx`, en `rutas.filter`.
- En la app real `get_jungle_routes` devuelve `[]`, pero un fallo de cualquier panel tendría el mismo efecto.
- Propuesta: un `ErrorBoundary` por panel que mantenga la barra de título y el rail, y enseñe «Esta sección falló» + Recargar sección.

**P4. Hay esqueletos y spinners mezclados. P2.**
- 11 spinners (`Loader2`/`spin`) frente a 7 esqueletos. Patrones carga con 16 esqueletos y un spinner a la vez.
- El shimmer anima `background-position` (pinta en cada fotograma, `index.css:1098`).
- Propuesta: la regla de la especificación de movimiento:
  - esqueleto para el contenido;
  - spinner solo dentro del botón que lanzó la acción;
  - barra con porcentaje para lo que tarda más de 2 s.

**P5. CLS al abrir el asistente y la pestaña Partida. P3.**
- El asistente marca de 0,028 a 0,041 y la pestaña Partida 0,072. Es bajo, pero se nota: un bloque que llega tarde empuja lo de abajo.
- Propuesta: reservar la altura de los gráficos y de los mensajes de ayuda.

## 6. Movimiento

Lo que hay hoy (`index.css:240-252`): cuatro duraciones (80/140/220/320), tres curvas y ningún rebote. La base es buena. Fallan el uso y la accesibilidad.

**M1. Cada cambio de sección entra con 220 ms y 6 px. P1.**
- La navegación es lo que más se hace, y también se dispara al saltar desde Ctrl K o con atajos de teclado. La regla de Emil Kowalski es no animar lo que se hace cien veces al día ni lo que empieza en el teclado.
- Dónde: `App.tsx`, en `panel()`, y `.panel-enter` en `index.css:1332`.
- En Patrones corren **dos** `panel-in` a la vez (censo: dos animaciones de 220 ms).
- Propuesta: un fundido de 120 ms solo de opacidad, sin desplazamiento, y ninguno si la navegación viene del teclado.

**M2. El movimiento reducido es un interruptor. P1.**
- `animation-duration: 0.01ms !important` sobre `*` (`index.css:965`, medido en el censo: `1e-05s`).
- Congela los spinners, que parecen colgados, y quita incluso los fundidos, que no marean. Impeccable y Emil coinciden: con movimiento reducido hay menos movimiento, no ninguno.
- Propuesta: que se queden la opacidad y el color, y que se quiten los desplazamientos y las escalas. Los bucles (punto de grabación, shimmer) pasan a estáticos.

**M3. Se animan propiedades caras. P2.**
- El punto de grabación anima `box-shadow` en bucle (`index.css:1347`) y el shimmer anima `background-position`.
- Las barras de progreso hacen `transition: width` (`index.css:679, 727, 2015, 2032, 2214`).
- Propuesta: un pseudo-elemento con `transform: scale` y `opacity` para el punto, un shimmer con `transform`, y `transform: scaleX` para las barras.

**M4. Al pulsar no pasa nada. P2.**
- Los botones cambian de color al pasar el ratón, pero al pulsarlos no responden. La sensación de que la app va rápida empieza en el `pointerdown`.
- Propuesta: `:active { transform: scale(.97) }` con 100 ms en los botones, y el hover solo con `@media (hover: hover)`.

**M5. Las pestañas no tienen indicador que se mueva. P3.**
- En Revisión, Partida e Impacto el subrayado salta de golpe.
- Propuesta: un indicador que se desliza en 200 ms con `--e-move`, hecho en CSS (no con `layoutId` de framer-motion, que pierde fotogramas al navegar), mientras el contenido cambia al instante.

## 7. Accesibilidad

**A1. `--faint` suspende AA en claro. P1.**
- 4,23 sobre `--ground` y 3,85 sobre `--sunken`, en el subtítulo de cada pantalla, los grupos de Ctrl K, «Orden», la versión y «Falta el fichero de vídeo».
- El censo da de 12 a 18 textos suspensos por vista en el reproductor y en Ctrl K, en claro.
- Dónde: `index.css`, `--faint: #666C75` del bloque claro.
- Propuesta: `#5A6069`, que da 5,07 sobre el fondo y 5,49 sobre el panel.

**A2. `--faint` suspende sobre las superficies elevadas en oscuro. P2.**
- 4,15 sobre `--raised`: las cuentas de los filtros («9») y el KDA del panel lateral.
- Propuesta: `#8E9398`, que da 4,85 sobre la superficie más elevada.

**A3. Texto a 11 px en el reproductor. P2.**
- 16 textos a 11 px (kbd y etiquetas de la regla). Tu norma era nada por debajo de 12 salvo el kbd.
- Propuesta: las etiquetas de la regla a 12 en mono.

**A4. Sin `<main>`. P3.**
- Hay `<nav>` y un `<h1>` por pantalla, pero el contenido no está marcado como región principal (`App.tsx`, `mainContent`).

**A5. El foco está bien.**
- Los 14 primeros tabuladores de Hoy tienen un anillo de 2 px jade visible en los dos temas ([captura](capturas/foco-dark.jpg)). Hay que conservarlo.

**A6. Objetivos de clic pequeños en el reproductor. P3.**
- 45 elementos de menos de 24 px: retratos de la línea de tiempo y casillas de revisión.
- En escritorio con ratón no es grave, pero las casillas de 14 px de la lista cuestan.
- Propuesta: área de clic de 24 px aunque el dibujo siga en 16.

---

## Qué se queda tal cual

- La **paleta marino y oro** con los cuatro tintes de un solo trabajo. La medí: todos los tintes pasan AA sobre el panel en los dos temas, y el jade frente al rojo se distingue con deuteranopia.
- El **anillo de foco** jade.
- **Ctrl K**: rápido, agrupado y con la ayuda del teclado abajo ([captura](capturas/dark-1280/ctrl-k-busqueda.jpg)).
- El **maestro-detalle** de la Biblioteca y su barra de atajos.
- Las **cuatro duraciones sin rebote**. Solo se ajustan valores y uso.
