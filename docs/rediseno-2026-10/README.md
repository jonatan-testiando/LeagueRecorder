# Rediseño «Ritmo» (2026-10)

Investigación y diseño. **No toca el código de la app**: lo que se implemente lo decides tú después de ver el diseño.

- **Fichero de Figma:** https://www.figma.com/design/hSOlqgyKswyLO9jtn3yo8c. Está en el equipo «Testiando» (plan Pro), el único donde tu cuenta puede crear ficheros y que es tuyo.
- **Auditoría:** [auditoria.md](auditoria.md). Problemas por categoría, con captura, medida y ubicación en el código.
- **Movimiento:** [movimiento.md](movimiento.md). Tokens, coreografía, movimiento reducido, rendimiento y recetas.
- **Plan por fases:** [plan-de-implementacion.md](plan-de-implementacion.md). Ficheros, esfuerzo y orden.
- **Capturas:** [capturas/](capturas/). Son 124 del arnés (31 vistas × oscuro/claro × 1280/1920), 18 de la app instalada con tus datos (`real/`) y dos de foco de teclado.
- **Medidas y herramientas:** [medidas/censo-arnes.json](medidas/censo-arnes.json) y [herramientas/](herramientas/). Con estos scripts se repite todo.

## Qué hay en el fichero de Figma

| Página | Contenido |
|---|---|
| Portada | Qué cambia, qué se queda y cómo leer el fichero |
| Fundamentos | Color en oscuro y claro con contraste medido, tipografía (12 estilos), espaciado y ritmos, radios, elevación y vidrio |
| Componentes | 67 iconos (los `lucide` de la app) y 23 componentes con variantes ligados a variables: botón (24 variantes), chip, tecla, segmento, pestaña, campo, selector, métrica, navegación, píldora de captura, progreso, esqueleto, toast, estado vacío, marca de línea de tiempo, tooltip, avatar, fila de partida, fila de suceso, barra de título y rail |
| Pantallas | Hoy, Biblioteca, Reproductor (Revisión e Impacto), Patrones y Ajustes; los estados de carga, vacío, Ctrl K, primer arranque y fallo de sección; y Hoy a 1920. Todo en oscuro (izquierda) y claro (derecha) |
| Coach | Plan en curso, cierre del plan y pocas partidas, en oscuro y en claro |
| Movimiento | Principios, duraciones, curvas dibujadas, coreografía en milisegundos de nueve interacciones, reglas y **seis demos animadas** (selecciona el marco y pulsa Presentar) |

Las variables tienen dos modos, Oscuro y Claro, con sintaxis de código `var(--token)`. Por eso las pantallas en claro son las mismas que las oscuras con el modo cambiado. El escenario del vídeo fuerza el modo Oscuro dentro de las dos.

## Lo más importante que salió

1. **Usas el tema claro.** Lo dice la app instalada (v1.2.36). Así que el claro no es secundario.
2. **La piel vigente es «Marino y oro, suave»**, no «Grafito y naranja», que duró solo la v1.2.26. El diseño la conserva y la afina.
3. **Al arrancar se ve 150-300 ms la app en inglés y en oscuro.** Para quien usa el claro es un fogonazo.
4. **Mientras carga, Hoy enseña el estado vacío**, «Juega una partida», a quien tiene 27.
5. **Sin `ErrorBoundary`**, un fallo en un panel deja toda la ventana en negro.
6. **El texto del oscuro pasa de tu tope de 11:1** (11,8-12,7) y **`--faint` suspende AA en claro** (4,23).
7. Se filtra **«Te mata minion_t200l1s07n0026»**.

## Skills instaladas para este proyecto

Las skills están en `.claude/skills/` del repo, no a nivel de usuario. Antes de instalar se leyeron enteras: cada SKILL.md y todos sus ficheros (las revisiones las hicieron tres agentes en paralelo, sin ejecutar nada).

| Skill | Origen | Para qué |
|---|---|---|
| `impeccable` | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) v4.7.0, commit e7d0f58 | Criterio de diseño con 24 comandos (`audit`, `critique`, `layout`, `typeset`, `animate`, `polish`, `harden`, `onboard`…). **Solo la guía**: se quitó `scripts/`, porque su lanzador descarga y ejecuta un binario en `~/.impeccable/bin` y manda telemetría. Tampoco van sus hooks ni sus agentes. Sin el lanzador no funcionan `live`, `generate`, `hooks`, `pin`, `doctor` ni el detector automático |
| `emil-design-eng` | [emilkowalski/skills](https://github.com/emilkowalski/skills), commit 2d22863 | Filosofía de pulido, componentes y decisiones de animación |
| `animate` | ídem | Construir una animación: si animar o no, qué propiedad, qué curva, qué duración, cómo se interrumpe |
| `animation-performance` | ídem | Animaciones que pierden fotogramas: composición, `will-change`, desenfoque, React por fotograma |
| `review-animations` | ídem | Revisión estricta del movimiento. Solo se invoca a mano (`/review-animations`) |
| `improve-animations` | ídem | Auditoría del movimiento de todo el código con planes por pasos (los escribe en `plans/`) |
| `find-animation-opportunities` | ídem | Dónde sí y dónde no animar. Solo lectura |
| `break-ui` | ídem | Romper la interfaz con datos extremos; útil para los textos largos en español |

**Ajustes locales.** Las skills de movimiento y la de Impeccable llevan, al principio, una nota «Ajuste local de LeagueRecorder (manda sobre lo de abajo)» con tus reglas:
- sin rebote: `bounce: 0` aunque la skill sugiera 0,2;
- contraste entre 10 y 11:1;
- EN/ES, donde la cadena inglesa es la clave;
- escritorio, no móvil;
- nada de overlays en partida.

A `emil-design-eng` se le añadió además un «Use when» a la descripción, para que se cargue sola.

**No instaladas:**
- De Emil: `animate-expo`, `mobile-native` y `write-swift` (React Native, móvil y Swift), `ask-sonner` (la app tiene su propio Toaster), `pick-ui-library` (empuja Sonner, base-ui y Tailwind), `apple-design` (táctil y con rebote) y `prototype` y `animation-vocabulary` (poco valor aquí).
- **Taste Skill:** su original es [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) (MIT, unas 99,5 mil estrellas, v2.1.3). **No se instaló**:
  - escribe en `~/.taste-skill/` (fuera del proyecto);
  - llama a APIs externas (Openverse, Wikimedia…) y a CDN (GSAP, Lenis, Google Fonts);
  - todas sus paletas van a 15-20:1, con `#fff` sobre `#000`, lo contrario de tu regla de contraste;
  - prohíbe la mono y el vidrio;
  - está pensada para webs de marketing;
  - en sus propias pruebas a ciegas pierde contra no usar ninguna skill en 4 de 5 rondas.

## MCP de este proyecto

- **Playwright:**
  - Añadido con `claude mcp add --scope local playwright -- cmd /c npx -y @playwright/mcp@latest`. Ámbito local: va en `~/.claude.json` bajo este proyecto, no en git.
  - `claude mcp get playwright` → `√ Connected`.
  - Probado con una llamada real por JSON-RPC: 25 herramientas, y `browser_navigate` al arnés devolvió el título de la página.
  - **Sus herramientas aparecen en la siguiente sesión que abras en este proyecto**; en esta no se cargan.
- **Figma:**
  - El conector oficial de Figma (claude.ai) ya estaba en la sesión y funciona: `whoami` respondió como «Testiando» y con él se creó y se llenó el fichero. No hizo falta añadir otro servidor.
  - Aparte, el servidor `plugin:figma:figma` del plugin de Figma figura como **pendiente de autenticación**. No hace falta: duplica lo que ya da el conector. Si lo quieres de todos modos, se autoriza desde `/mcp` en un terminal `claude`.

## Cómo se midió

- **Arnés** (`npm run dev`, `dev-harness.html`) con Playwright y Chrome:
  - capturas;
  - censo de cada texto visible: contraste WCAG contra su fondo real, mezclando las capas translúcidas;
  - tamaños, pesos, paddings, radios, recortes, objetivos pequeños, animaciones en curso y CLS.
  - Al arnés le falta el doble de `get_jungle_routes`, y por eso Patrones salía en negro. El script lo suple sin tocar el repo.
- **App instalada** por CDP (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`):
  - capturas con tus partidas;
  - recarga con muestreo cada 40 ms para ver el idioma, el tema y el estado vacío durante la carga.
  - El tema solo se alternó con el atributo `data-theme`: tu configuración no se tocó.
  - La app no estaba abierta antes: se cerró al acabar y el puerto 9222 quedó cerrado.
- **Paleta:** `herramientas/contrast.mjs` (WCAG + OKLCH).

## Pendiente o a tener en cuenta

- **Nada está commiteado.** Son ficheros nuevos: `docs/rediseno-2026-10/` (unos 14 MB de capturas; `capturas/real/` lleva tus datos de partidas y rango) y `.claude/skills/`.
- El fichero de Figma está en tus borradores del equipo Testiando; se puede mover a un proyecto.
- La fase 4 (Coach) ya tiene el backend en `main` (8531c93). Falta guardar el plan de 10 partidas.
