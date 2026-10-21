# Plan de implementación por fases

Cada cambio va con sus ficheros, su esfuerzo y su lugar en el orden. Los identificadores (P1, V2, C3…) remiten a la [auditoría](auditoria.md), y el diseño de destino está en el [fichero de Figma](https://www.figma.com/design/hSOlqgyKswyLO9jtn3yo8c).

**Nada de esto está implementado.** El plan está pensado para repartirse entre sesiones o agentes con ficheros disjuntos, como en los rediseños anteriores.

Esfuerzo, para una sesión de agente:
- **S**: menos de medio día.
- **M**: uno o dos días.
- **L**: de tres a cinco días.

## Resumen del orden

```
Fase 0  Arreglos de confianza (sin cambio visual)    ── paralelizable, va primero
Fase 1  Tokens en index.css                          ── un solo agente, bloquea 2-5
Fase 2  Primitivos en components/ui                  ── bloquea 3
Fase 3  Pantallas (3a-3g)                            ── paralelizable por ficheros
Fase 4  Coach                                        ── backend ya en main; falta guardar el plan
Fase 5  Movimiento                                   ── después de 3 (toca index.css)
Fase 6  Verificación con datos reales                ── al final de cada fase
```

## Fase 0: arreglos de confianza

No cambian el aspecto. Son lo primero porque son los P0 y cada uno es independiente.

| # | Cambio | Ficheros | Esf. | Auditoría |
|---|---|---|---|---|
| 0.1 | `ErrorBoundary` por panel: la barra de título y el rail sobreviven; «Esta sección falló» + Recargar sección + Copiar detalles (Figma: *Error de sección*) | nuevo `src/components/ui/ErrorBoundary.tsx`; `src/App.tsx` (`panel()` envuelve cada ruta); `src/main.tsx` | S | P3 |
| 0.2 | Arranque sin fogonazo: script en línea en `index.html` que lee `localStorage["lr-boot"]` (`{theme, lang}`) y pone `data-theme` y `lang` antes de React. Los providers escriben esa pista al cambiar. `AppConfig` sigue mandando | `index.html`; `src/core/ThemeProvider.tsx:33`; `src/core/LanguageProvider.tsx:32` | S | P1 |
| 0.3 | Tres estados (cargando, vacío y con datos). `HomePanel` y la galería miran `isLoading`. El rail muestra el último rango conocido, no «Sin clasificar». Hook `useDelayedLoading(150, 300)` | `src/features/gallery/useGallery.ts:15`; `src/features/home/components/HomePanel.tsx:323`; `src/features/gallery/components/MatchGallery.tsx`; `src/components/RailProfile.tsx`; nuevo `src/core/useDelayedLoading.ts` | S | P2 |
| 0.4 | Nombres de asesinos que no son campeones: «Te matan los súbditos», «Te mata la torre», «Te mata Barón Nashor» | `src/core/eventText.ts:96-97`; si hace falta, mapear `minion_*`/`turret_*` en el backend que rellena `actor` | S | I1 |
| 0.5 | Fechas y números en el idioma de la interfaz: grupos «Viernes, 5 sep», `formatDecimal` en tamaños («48,0 MB») y signo siempre en el LP | `src/core/time.ts:56`; `src/features/gallery/components/ClipsGallery.tsx:108-110`; `src/core/matchStats.ts` (`lpDeltas`) y su uso en `MatchGallery.tsx` | S | I4, I5 |
| 0.6 | `<main>` en el contenido | `src/App.tsx` (`styles.mainContent`) | S | A4 |

## Fase 1: tokens

Todo en `src/index.css`, cabecera y bloque `[data-theme="light"]`. Un solo agente, porque el fichero lo tocan todos.

| # | Cambio | Esf. | Auditoría |
|---|---|---|---|
| 1.1 | **Color**, valores del lienzo *Fundamentos · Color*. Contraste medido con `herramientas/contrast.mjs`. Oscuro: `--text #C6C2BC`, `--muted #A6A39E`, `--faint #8E9398`, `--sunken #0B111B`, `--raised #18212E` y un nuevo `--overlay #1E2735`. Claro: `--muted #474D56`, `--faint #5A6069`, `--sunken #DCE0E6`. Nuevos: `--stage` (marino en los dos temas), `--glass`, `--scrim`, `--brand-soft`, `--flag-soft` | M | V1, V2, A1, A2 |
| 1.2 | **Tipografía:** `--fs-12/13/14/16/20/28` + `--fs-metric 22` y `--fs-hero 40`, con sus `line-height`. Utilidades `.t-*` que reflejen los estilos de texto de Figma. Los 12,5 y 13,5 pasan a 12 o 13 | M | C1 |
| 1.3 | **Espaciado y radios:** se mantienen `--space-*`; `--radius-sm 4`, `--radius-md 8`, `--radius-lg 12` y `--radius-full` como únicos radios; anchos `--content-max 1360` y `--form-max 960` | S | E1, C2, I8 |
| 1.4 | **Movimiento:** tokens de [movimiento.md](movimiento.md) con alias de los viejos, y el bloque de movimiento y transparencia reducidos en lugar del de `index.css:965` | S | M2 |
| 1.5 | **Tinte de resultado:** `--tint-win`/`--tint-loss` solo en `:hover` y `[aria-selected]`; fila en reposo con barra de 3 px | S | V4 |

Al cerrar la fase, el censo de `herramientas/shots.mjs` tiene que dar:
- 0 suspensos de AA;
- texto principal entre 10 y 11:1;
- como mucho 8 tamaños por pantalla.

## Fase 2: primitivos

En `src/components/ui/`. El de Figma correspondiente está en *Componentes*.

| # | Primitivo | Sustituye a | Ficheros que lo adoptan | Esf. |
|---|---|---|---|---|
| 2.1 | `Segmented` (carril-píldora con indicador que se desliza; `tp-seg` ya es casi esto) | `cg-seg`, `lib-seg`, `pp-seg`, las pestañas-botón de Training y la «Calidad» de Ajustes | `ClipsGallery.tsx/.css`, `ErrorsGallery.tsx`, `MatchGallery.tsx/.css`, `PatternsPanel.tsx/.css`, `TrainingPanel.tsx`, `SettingsPanel.tsx`, y los usos actuales de `tp-seg` (`OnboardingWizard`, `LeadChart`, `RivalCard`, `RouteReplay`, `SpellDietWidget`, `ErrorPlayer`) | M |
| 2.2 | `Tabs` con indicador en CSS | `vp-tabs` | `VideoPlayer.tsx/.css` | S |
| 2.3 | `Chip` (tonos: neutro, victoria, derrota, hallazgo, oro y contorno) | `lib-pill`, `home-pill`, `home-chip`, `cg-chips`, `vp-chip`, `pp-chip`, `lc-chip` y parte de `Badge` | `MatchGallery`, `HomePanel`, `ClipsGallery`, `ErrorsGallery`, `VideoPlayer`, `PatternsPanel`, `LeadChart`, `ui/Badge.tsx` | M |
| 2.4 | `Button`: pulsación a 0,97 en `pointerdown`, hover solo con `(hover: hover)`, estado `loading` con spinner dentro y verbo; el fantasma pequeño con `--muted` | ajustes en `.btn*` | `ui/Button.tsx`, `index.css` (primitivos) | S |
| 2.5 | `Select` propio (con el menú de Elevación 1) | `<select>` nativo | `ClipsGallery.tsx:623`, `SettingsPanel.tsx`, `OnboardingWizard.tsx` | M |
| 2.6 | `Skeleton` (línea, bloque y círculo) y `EmptyState` revisado | spinners de contenido | `ui/EmptyState.tsx`, nuevo `ui/Skeleton.tsx`; los 11 `Loader2` de contenido en `HomePanel`, `PatternsPanel`, `MatchTab`, `MatchDetailPanel`… | S |
| 2.7 | `Toast` sobre vidrio con apilado por `transform` | `toast-left` | `ui/Toaster.tsx`, `index.css:1263` | S |

## Fase 3: pantallas

Se pueden repartir entre agentes porque cada una tiene sus ficheros.

| # | Pantalla | Qué cambia (destino en Figma) | Ficheros | Esf. |
|---|---|---|---|---|
| 3a | **Hoy** | Héroe con la última partida *con datos* y franja de una línea si la más nueva está sin sincronizar. Momentos con ΔWP («−6 %»). «Tu foco» del Coach con barras por tramo. Ancho máximo 1360. Primera visita escalonada | `features/home/components/HomePanel.tsx/.css`, `MomentCard.tsx`, `features/home/moments.ts` | M |
| 3b | **Biblioteca** | Fila nueva (barra de resultado, columna de nombre de 360 como máximo, «Revisada» como marca y no como columna). Grupos con fecha. Selector de puesto en vez de iconos. Panel lateral con «Momentos por revisar» y ΔWP | `features/gallery/components/MatchGallery.tsx/.css` (`FILA_GRID`, `:299`), `MatchDetailPanel.tsx/.css`, `libraryShared.ts` | M |
| 3c | **Reproductor** | Cabecera sin cortes (detalle en tooltip). Transporte con la velocidad en un menú «1×». Línea de tiempo con marcas de 8-10 px y racimos. Escenario `--stage` con HUD en vidrio. Inspector: Revisión con el segmentado nuevo; Partida e Impacto con **un solo aviso** de sincronización; «Lo que te costó esta partida» en Impacto | `features/player/components/VideoPlayer.tsx/.css`, `MatchTab.tsx/.css`, `ImpactTab.tsx/.css` (`:244`, `:451`), `DeathsSection`, `eventMeta.tsx` | L |
| 3d | **Patrones** | «Tu foco» pasa a resumen del Coach con antes y después. Barras frente a tu rango con carril visible | `features/patterns/components/PatternsPanel.tsx/.css`, `RankBenchmarkCard.tsx` | M |
| 3e | **Ajustes** | Categoría «Apariencia» (tema e idioma). Selectores propios. Diagnóstico arriba con una sola acción oro | `features/settings/components/SettingsPanel.tsx/.css` | S |
| 3f | **Clips y Errores** | Póster con el primer fotograma y duración en mono, en vez de `<video controls>` | `features/gallery/components/ClipsGallery.tsx:517/.css`, `ErrorsGallery.tsx` | S |
| 3g | **Training y Análisis de vídeo** | Segmentado común y anchos de formulario | `features/training/components/TrainingPanel.tsx`, `features/vod/components/VodGallery.tsx` | S |

## Fase 4: Coach

Diseño en la página **Coach** de Figma, según `docs/coach-de-macro-diseno.md` §2.4-2.5.

| # | Cambio | Ficheros | Esf. |
|---|---|---|---|
| 4.1 | Ruta `/coach` y entrada «Coach» en el grupo «Mejorar» del rail (icono `graduation-cap`) | `src/App.tsx` (`NAV_GROUPS`, `panel()`) | S |
| 4.2 | `CoachPanel`: plan en curso (10 casillas, línea de la última partida, «Ver tus 5 peores jugadas» como única acción oro, ejercicio de Training enlazado), categorías ordenadas por coste con raya de baremo y origen («corpus» o «tu media»), nota por tramo y historial | nuevo `src/features/coach/components/CoachPanel.tsx/.css`; `src/core/coach.ts` y `useCoachSummary.ts` (ya en main) | L |
| 4.3 | Persistencia del plan: `%APPDATA%\LeagueRecorder\coach\sessions.json` y cierre a las 10 partidas con intervalo de confianza («mejoró», «igual», «muestra corta»). Estados *Cierre del plan* y *Pocas partidas* | backend nuevo en `src-tauri/src/coach.rs` + comando; tipos en `core/tauri-ipc.ts` | M |
| 4.4 | Bloque «Lo que te costó esta partida» en Impacto (si no entró en 3c) | `ImpactTab.tsx` | S |

**Dependencia:** resuelta mientras se hacía este diseño. `coach.rs`, `coach_baremos.rs`, `core/coach.ts` y `useCoachSummary.ts` ya están en `main` (merge 8531c93). Falta la persistencia del plan (4.3).

## Fase 5: movimiento

Se hace después de la fase 3 porque comparte `index.css` y los componentes de pantalla. Detalle en [movimiento.md](movimiento.md).

| # | Cambio | Ficheros | Esf. |
|---|---|---|---|
| 5.1 | Navegación: fundido de 120 ms solo de opacidad; nada si viene del teclado (`data-nav`). Fuera el doble `panel-in` de Patrones | `src/App.tsx`, `src/components/CommandPalette.tsx`, `index.css:1332`, `PatternsPanel.tsx` | S |
| 5.2 | Indicadores deslizantes en `Segmented` y `Tabs`, con `data-ready` tras el primer pintado | `ui/Segmented.tsx`, `ui/Tabs.tsx` | S |
| 5.3 | Popover, menú y tooltip con origen en el disparador; Ctrl K sin animación si se abre con el teclado | `index.css` (`.tp-pop`, `pop-in`), `CommandPalette.tsx` | S |
| 5.4 | Punto de grabación con pseudo-elemento; barras con `scaleX`; shimmer con `transform` | `index.css:1347`, `:679`, `:727`, `:1098`, `:2015`, `:2032`, `:2214`; `CaptureStatus.tsx` | S |
| 5.5 | Primera visita a Hoy escalonada (una vez por sesión) | `HomePanel.tsx/.css` | S |
| 5.6 | Rail que se pliega con `clip-path` sin reflujo del vídeo | `index.css` (`.rail--collapsed`), `App.tsx` | M |

## Fase 6: verificación

Al final de cada fase, no solo al final de todo. Lo dice tu memoria `mirar-la-app-corriendo`: compilar limpio no es verificar.

1. **Arnés:** `node docs/rediseno-2026-10/herramientas/shots.mjs <salida>` con el servidor de desarrollo levantado. Hace las 31 vistas × 2 temas × 2 anchos y el censo `metrics.json`. Umbrales:
   - contraste: 0 suspensos de AA, mediana del cuerpo ≥ 9 y texto principal ≤ 11;
   - tipografía: ≤ 8 tamaños por vista y 0 textos por debajo de 12 salvo `.u-kbd`;
   - espaciado: 0 paddings fuera de la rejilla en las pantallas tocadas.
2. **App real por CDP:** `realshots.mjs` y `realperf.mjs`. Lanzar la instalada o el exe de depuración con `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`. Umbrales:
   - `firstEs` y `firstLight` en el primer muestreo, sin inglés ni oscuro;
   - `emptyShown` vacío mientras carga.
3. **Movimiento reducido:** `a11y.mjs` emula `reducedMotion: 'reduce'`. Ningún bucle activo y la navegación sin desplazamiento.
4. **i18n:** las cadenas nuevas, en español en `src/core/i18n.ts`. La cadena inglesa es la clave: si se cambia un texto en inglés, se cambia también su entrada.

Los scripts de `herramientas/` apuntan al `playwright-core` de la caché de `npx` de esta máquina (`…/npm-cache/_npx/9833c18b2d85bc59/`). En otra máquina basta con cambiar esa ruta del `import`.

## Qué queda fuera

- **Overlays en partida:** ninguno (memoria `sin-overlays-en-partida`). El recordatorio del Coach vive en la selección de campeón, en la ventana de la app.
- **Cambio de piel:** no lo propongo. «Marino y oro, suave» es lo que elegiste tras diez paletas medidas. El problema no era la paleta, sino el contraste del texto, la escala y la consistencia.
- **Marcador de 10 jugadores y títulos para los 10** (3.6 del diseño del coach): no están diseñados aquí.
