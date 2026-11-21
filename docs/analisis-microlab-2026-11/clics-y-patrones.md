# MicroLab 1.5.17: captura de clics, teclas y ratón, métricas y «patrones»

Ingeniería inversa estática del `app.asar` extraído (`scratchpad/ml/app`). No se ejecutó nada del objetivo.
Todas las rutas `archivo:línea` son relativas a `ml/app`.

Etiquetas: **[O]** observado leyendo el código (con archivo:línea) · **[I]** inferido · **[D]** desconocido.

---

## 0. Evidencia REA

| Qué | evidence_id |
|---|---|
| Análisis de aplicación (28 fuentes seleccionadas con `--source-path`, 28 JS parseados, 0 fallos, 65.011 nodos AST, 159 hallazgos; 3.009 ficheros fuera de la selección) | `ev_0e5cbdd9f26298d743b44228d7008eee11af09f6c0e6ad141200c43ff593f9fb` (padre) |
| Vista resumen de ese análisis | `ev_635ade59f3e8b769ed05dc124758b89f56fbb83890eafdc999ee9ab312698772` |
| Hechos de `native/index.js` (cargador NAPI-RS multiplataforma; 17 exportaciones, entre ellas `getMouseButtonState`, `checkGameFocused`, `getGameWindowRect`, `getFirstFrameTime`, `configureRecorder`) | `ev_408ef912aeeffc467cd9a8ce1eeb6b786a6779e9d3c35948fce1babeab6dd33e` |
| Hechos de `main/services/mouse-tracker.js` (requiere `uiohook-napi`, `electron`, `../../native/index`, la ruta de respaldo `resourcesPath/native/microlab-recorder.win32-x64-msvc.node`, `./session-health`, `./window-manager`, `../sentry`) | `ev_fb2b98ff32875b14ff2c819b37c8114194e33b68632bc11df7323ef3fdfe9101` |
| Binario nativo: tabla de exportaciones PE (solo `napi_register_module_v1`) | `ev_e9c4cc7adc7e2346be7e5232f521c1c9f73d29d440b3f7c37245fa4963309a44` |
| Binario nativo: importaciones PE (user32: `GetAsyncKeyState`, `GetForegroundWindow`, `FindWindowW`, `EnumWindows`, `GetWindowRect`, `GetClientRect`, `GetDpiForWindow`, `GetWindowTextW`, `IsWindow`, `IsWindowVisible`, `GetWindowThreadProcessId`; **no** hay `SetWindowsHookEx`, `GetCursorPos` ni Raw Input) | `ev_18476c3b226f534fcc96912813602970f6f29fc36811c3c85283949637b5aab7` |
| Binario nativo: es Rust (commit de rustc `254b5960…`) | `ev_d3595c85479a56306a984c1d340de45a98e9daa6c7503cb1c2a9e9d27a9f0fcb` |

Bundle completo: `ml/rea-clics/analisis-inputs.json`.

Limitación: el resumen de REA cuenta 0 canales IPC y 0 bindings nativos. Es porque `preload.js`, `ipc-handlers.js`, `background.js` y `game-detector.js` quedaron fuera de la selección y el `require` del `.node` es dinámico. Esos tramos los leí a mano y los cito por línea, sin evidence_id.

---

## 1. Captura

### 1.1 Recorrido completo [O]

```
proceso main (Node)                                      ventana oculta "background" (renderer)
────────────────────────────────────────────────         ─────────────────────────────────────────────
uiohook-napi (hooks globales de bajo nivel)
  mousedown / mouseup / mousemove / keydown / keyup
      │  filtros: foco, límites, dedupe 8 ms/1 px
      ▼
mouse-tracker.js ── 'mouse:click' (cada clic, al momento) ─►  clicks[]    (+ el clic también va a positions[])
                 ── 'mouse:data'  (lote cada 100 ms)      ─►  positions[]
                 ── 'key:event'   (pulsar / soltar+dwell)  ─►  keypresses[]
                 ── 'mouse:drag'  (botón central)          ─►  drags[]
setInterval 16 ms:
  screen.getCursorScreenPoint()  → posiciones en modo polling y diagnóstico
  addon.getMouseButtonState()    → sonda de salud de uiohook / clics de respaldo
game-detector.js (cada 250 ms): addon.checkGameFocused('RiotWindowClass')
game-events.js: Live Client API https://127.0.0.1:2999 (allgamedata cada 2 s, eventdata cada 0,5 s)
                                                         ─►  gameTimeOffset, gameEvents[], abilitySnapshots[]
                                                         al acabar: recalcula gameTime, descarta <0, ordena
                                                         ─►  IndexedDB 'lol_mouse_tracker'
```

Archivos: `main/services/mouse-tracker.js`, `pages/background.js:440-517`, `main/preload.js:96-117`, `main/ipc-handlers.js:31-48, 318-325`, `main/services/game-detector.js`, `main/services/game-events.js:55, 128-136, 324-328`.

### 1.2 Librería y modos

- **uiohook-napi 1.5.4** (`package.json:12`, `node_modules/uiohook-napi/package.json`). [O] Se escuchan `mousedown`, `mouseup`, `mousemove`, `keydown` y `keyup` (`mouse-tracker.js:664-668`). No se escuchan rueda, botones 4/5 ni el evento `click`. [I] libuiohook en Windows usa `WH_MOUSE_LL` y `WH_KEYBOARD_LL`.
- Códigos de botón de uiohook: 1 izquierdo, 2 derecho, 3 central (`mouse-tracker.js:573-583`).
- `clickMode` es `'uiohook' | 'polling' | 'none'` y `positionMode` es `'uiohook' | 'polling'` (`:29-30`).
- **Sonda de salud** [O] (`:336-382`, constantes `:38-39`). Con uiohook vivo, el intervalo de 16 ms lee `GetAsyncKeyState` (vía `addon.getMouseButtonState()`) y detecta flancos de pulsación. Un flanco sin `mousedown` de uiohook en los 120 ms anteriores cuenta un fallo (solo uno por tick). Con 2 fallos (`UIOHOOK_MISS_SWITCH_THRESHOLD`) pasa a **polling** para clics y posiciones, quita los listeners de ratón de uiohook (mantiene el teclado) y emite el clic del primer fallo con su hora original.
- **Respaldo** [O] (`:692-710`): si uiohook no carga, los clics salen del flanco de `GetAsyncKeyState` cada 16 ms (solo izquierdo y derecho) y la posición de `screen.getCursorScreenPoint()` cada 16 ms.

### 1.3 Qué se guarda (esquema) [O]

| Array | Campos | Origen | Notas |
|---|---|---|---|
| `positions` | `{x, y, time, gameTime}` | lotes `mouse:data` (`background.js:440-451`) **y cada clic** (`background.js:487`) | ordenado por `gameTime` al guardar |
| `clicks` | `{x, y, time, gameTime, button: 'left'|'right'}` | `mouse:click` (`background.js:464-488`) | hora = **pulsar** (no hay mouseup para izquierdo/derecho) |
| `keypresses` | `{key, time, gameTime, dwell?}` | `key:event` (`background.js:498-517`) | `key` = keycode de uiohook (scancode set 1: Q=16, W=17, E=18, R=19, D=32, F=33, B=48, A=30, S=31, P=25, Espacio=57, Enter=28, Esc=1, «1»…«7»=2…8; `js/utils/keycodes.js`, `position-track.js:8`) |
| `drags` | `{x0, y0, x1, y1, time, gameTime, duration}` | botón central: pulsar→soltar como un único evento (`mouse-tracker.js:573-578, 648-662`; `background.js:490-496`) | arrastre de cámara con el botón central |
| `abilitySnapshots` | `{gameTime, Q, W, E, R, abilityHaste}` | Live Client API cada 2 s (`game-events.js:125-136`) | niveles de habilidad |
| `cameraPans` | `{gameTime, duration, direction}` | calculado al guardar desde `positions` (`background.js:2838`) | ver §3.10 |
| `resolution` | `{left, top, width, height, logicalWidth, logicalHeight, scaleFactor}` | game-detector | `width/height` físicos, `logical*` en DIP |
| `stats` | `{clickCount, keypressCount, positionCount, duration}` | `background.js:2841-2846` | `duration` = última `position.time` − primera |

Registro completo en `background.js:2800-2848`. También se guardan `gameEvents` (kill/death/assist/multikill/objetivos con `gameTime` = `EventTime·1000` de Riot), `liveStats` y `playerSnapshots`.

**Filtros en la captura** [O]:
- **Foco**: las posiciones solo se encolan con `gameFocused` (`mouse-tracker.js:214, 593`). El foco sale de `checkGameFocused('RiotWindowClass')` cada 250 ms (`game-detector.js:10, 224-241`). En un `mousedown` sin foco hay una comprobación nativa síncrona para no perder el clic que devuelve el foco al juego (`mouse-tracker.js:548-564`). Al perder el foco se vacía el lote y se reinicia la referencia de dedupe (`:198-202`). Al recuperarlo se toma una muestra inmediata (`:204-210`).
- **Límites**: un punto vale si `left ≤ x ≤ left+width` y `top ≤ y ≤ top+height` (inclusivo; `:148-154`). Un clic fuera se descarta y se cuenta (`droppedBounds`, `:248-257`). Una posición fuera se descarta sin más (`:219-221`).
- **Dedupe de posiciones**: se descarta la muestra si `dt < 8 ms` **y** `|dx| ≤ 1` **y** `|dy| ≤ 1` respecto a la última encolada (`:40-41, 224-232`).
- **Tope**: como mucho 600 muestras por lote de 100 ms (`:17, 234`).
- **Clics**: dedupe de 5 ms **global**, sin mirar el botón (`background.js:221, 474-477`). Solo se guardan izquierdo y derecho.
- **Teclas**: la repetición automática se filtra con el `Set` `keysDown` (`mouse-tracker.js:27, 619-620`). Hay un dedupe de 5 ms **global entre teclas distintas** (`background.js:222, 513`); [I] dos teclas en menos de 5 ms pierden la segunda. Al soltar se calcula `dwell = t_up − t_down` (`mouse-tracker.js:630-646`) y se rellena en la última pulsación de esa tecla que aún no tenga dwell (`background.js:502-511`).
- Se graban **todas** las teclas, incluido el chat [O]. Solo al subir a la nube se reducen a clases (§1.9).

### 1.4 Frecuencia de muestreo

- **Modo uiohook**: va por eventos, una muestra por mensaje de movimiento del hook [O], menos el dedupe de 8 ms y 1 px. [I] La frecuencia real es la del ratón y el ritmo de mensajes (125–1000+ Hz). El comentario «~125Hz max» (`mouse-tracker.js:40`) engaña: solo se descarta lo que además se mueve ≤1 px.
- **Con el cursor quieto no hay muestras** en modo uiohook [I, por diseño]. Quedan huecos, y de eso dependen `idle` y la detección de paneos.
- **Modo polling**: cada 16 ms, unos 60 Hz (`:16, 724-754`).
- Hay una muestra al arrancar (`:714-721`) y otra al recuperar el foco.
- Los lotes se mandan por IPC cada 100 ms (`:15, 757`). Los clics van al momento.
- El replay reduce a 16 ms, pero conserva cualquier muestra con un giro de más de 60° (`cos < 0,5`, ambos vectores >2 px; `js/replay/lifecycle.js:13-45`).
- `SAMPLE_INTERVAL_MS = 33` (`background.js:3`) [I] solo sirve en la ruta Overwolf.

### 1.5 Marcas de tiempo [O]

- `hookTimestamp(e)` (`mouse-tracker.js:48-62`) toma `e.time` de uiohook (GetMessageTime, ms desde el arranque) más un offset calibrado **una vez por sesión** con `Date.now() − e.time` en el primer evento. El resultado es la hora epoch del evento del SO, no la del callback de Node. El polling usa `Date.now()`.
- `gameTime = (time − matchStartTime) + gameTimeOffset` (`background.js:2031-2038`). `matchStartTime = Date.now()` al empezar el tracking (`:2119`).
- `gameTimeOffset` viene de la Live Client API (`allgamedata.gameData.gameTime` cada 2 s; `background.js:563-604`):
  - la 1.ª muestra fija `offset = apiTime − (Date.now() − matchStartTime)` y corrige hacia atrás todo lo ya capturado;
  - las 4 siguientes promedian: `offset = round((offset + nuevo)/2)`;
  - después solo corrige si `|nuevo − offset| > 100 ms`, también promediando.
- **Al guardar** (`:2755-2799`) se recalcula todo `gameTime` con el offset final, se descartan `gameTime < 0` (pantalla de carga) en positions, clicks, keypresses y abilitySnapshots, y se ordenan `positions` y `clicks` por `gameTime`. `keypresses` no se ordena; quedan en orden de llegada.

### 1.6 Coordenadas [O]

- **Espacio**: píxeles **lógicos (DIP de Electron)** relativos a la esquina superior izquierda del **área cliente** del juego: `x − gameBounds.left`, `y − gameBounds.top` (`mouse-tracker.js:156-162`).
- uiohook da píxeles físicos. Si `scaleFactor > 1` se dividen y se redondean (`:164-175`). `screen.getCursorScreenPoint()` ya está en DIP.
- `gameBounds` se calcula en `game-detector.js:92-171`:
  - `getGameWindowRect('RiotWindowClass')` (nativo) devuelve `{left, top, width, height, clientWidth, clientHeight, dpi}` en físicos. Los nombres de campo aparecen como cadenas en el `.node`: «top clientWidth clientHeight dpi».
  - `scaleFactor` = `display.scaleFactor` de Electron en la pantalla más cercana.
  - Es pantalla completa si (ventana en DIP ≥ 95 % del display en ambos ejes) o (`scale > 1` y área cliente física ≈ display lógico ±50 px). Entonces los límites son `display.bounds`.
  - En ventana: `border = (w − clientW)/2`, `titleBar = h − clientH − border`, `left = round((rect.left + border)/scale)`, `top = round((rect.top + titleBar)/scale)`, `logicalWidth = round(clientWidth/scale)`.
  - El área cliente debe medir ≥100 px; si no, la ventana aún no está lista.
- Los límites se recalculan al recuperar el foco, en `display-metrics-changed` y a los 3, 6, 10, 15, 20 y 30 s de empezar (`game-detector.js:310`), y se aplican con `MouseTracker.setGameBounds` (`ipc-handlers.js:31-48`).
- Cada 5 s se compara uiohook con Electron y se escribe en el log (`COORD_DIAG`, `mouse-tracker.js:597-611`).
- No hay calibración pantalla→mapa para el ratón. El ratón vive siempre en espacio de pantalla del juego.

### 1.7 Sincronía con el vídeo [O]

- **Al parar** (`background.js:2557-2597`):
  - Si hubo varios segmentos de vídeo, se elige el que tenga más kills y deaths; si empatan, el más largo.
  - `syncOffset = (matchStartTime − videoFileStart) − gameTimeOffset`, de modo que `videoTime = gameTime + syncOffset`.
  - `videoFileStart` = `startTime` del segmento, que viene del grabador nativo.
- **En el replay de Electron** (`js/replay/player.js:535-600`):
  - Todo se pasa al reloj del vídeo: `gameTime := time − videoStartTime` (posiciones, clics, teclas; los eventos con `timestamp − videoStartTime`). En memoria `syncOffset := 0`.
  - Reloj de dibujo: `gameTime = video.currentTime·1000 − syncOffset + syncAdjust` (`render-loop.js:29, 298`).
  - `syncAdjust` es el ajuste manual del usuario, por partida o global. Se cambia con «Cursor earlier/later» (`[` `]`) y con «Calibrate» (`Shift S`, acercar el cursor del juego al punto rojo) (`js/core/player-keys.js:41-43`; `locales/en.json:229, 233`).
- `recordingSyncOffset` (`player.js:604-622`): si el offset guardado es 0, lo recupera como mediana de `time − gameTime − videoStartTime` en tres muestras (primera, central, última), siempre que coincidan en ±1000 ms.
- `contentStartOffsetMs` (`main/services/ffmpeg-service.js:33-65`):
  - Se calcula con `blackdetect=d=0.05:pic_th=0.98:pix_th=0.10` sobre los primeros 12 s.
  - Solo cuenta si el negro empieza en ≤0,05 s; se recorta a [0, 5000] ms.
  - [O] Se guarda. [D] En el remapeo directo de `player.js:560-575` no se resta. No sé si se usa en otra parte.
- **Espacial** (`js/replay/overlay.js:157-163`, `js/replay/video.js:298-330`):
  - `canvasX = ((x / dpiScale) + manualOffsetX) · scaleX`.
  - En Electron, `dpiScale = logicalWidth / videoWidth` y `scaleX = anchoContenido / videoWidth`.
  - `manualOffset` se ajusta con Shift+flechas.
- El cursor se interpola linealmente entre muestras si el hueco es ≤500 ms (`overlay.js:65-97`). El trazo se corta en huecos de más de 500 ms (`overlay.js:185`; `js/expanded/canvas.js:377`).
- El grabador nativo dibuja el cursor DXGI dentro del vídeo: el `.node` contiene las cadenas «DXGI cursor: …» y `windows_record::capture::cursor` [O, cadenas del binario].

### 1.8 Sincronía con el mapa

- [O] No se proyecta el ratón al mapa durante la partida.
- Lo único de mapa es la reconstrucción de la posición del campeón (§3.13). Usa:
  - un minimapa fijo a 1080p, `{x0: 1654, y0: 792, size: 253}`, escalado por `k = h/1080` y anclado abajo a la derecha: `x0 = w − (1920−1654)·k`, `y0 = h − (1080−792)·k` (`position-track.js:86, 108-119`);
  - una cámara en perspectiva fija, `{Hc: 1750, pitchDeg: 56, vfovDeg: 40}` (`:85, 90-106`).
- [I] No lee `MinimapScale` ni el lado del minimapa. Con el minimapa a otra escala o a la izquierda se equivoca.
- [I] `payloadFromGame` usa `resolution.width/height`, que son píxeles **físicos** (`:545-546`), mientras los clics están en DIP. Con escalado distinto del 100 % la geometría queda mal.

### 1.9 Formato y ubicación en disco [O]

- **IndexedDB** `lol_mouse_tracker`, versión 5 (`js/core/db.js:1-7`), del origen `file://`.
  - En esta máquina existe `%APPDATA%\microlab\IndexedDB\file__0.indexeddb.leveldb` [O, 15 KB, sin partidas].
  - `game_history` guarda el registro ligero (keyPath `id`).
  - `game_data` guarda lo pesado: `{gameId, positions, clicks, keypresses, liveStats}` (keyPath `gameId`; `db.js:114-125, 138-166`).
  - `game_metadata` es un espejo ligero para la barra lateral.
  - `video_metadata` (keyPath `gameId`) guarda `{path, url, duration, resolution, gameResolution, syncOffset, videoStartTime, contentStartTime, contentStartOffsetMs, contentStartMeasured, segments, fps, bitrate, positionTrack?}` (`background.js:2600-2616`).
  - `game_metrics` (keyPath `gameId`).
- **Serialización**: objetos JS normales por structured clone, sin compresión ni codificación propias. [I] LevelDB de Chromium comprime los bloques con Snappy.
- [I] La propia app estima unos 96 B por muestra (`js/core/desktop-input-cache.js:9-10`).
- **Nube** (`js/utils/cloud-sync.js:24-28, 44-48, 79-…`; `js/utils/data-serializer.js:137-192, 235-310`):
  - Es **opt-out**: activado por defecto si no hay clave en localStorage. Exige sesión de MicroLab.
  - El payload es JSON comprimido con `CompressionStream('gzip')`. Contiene:
    - `positions: [{x, y, t}]`, con `t` en ms relativos a la 1.ª muestra y coordenadas redondeadas;
    - `clicks: [{x, y, t, b: 'l'|'r'}]`;
    - `keypresses: [{k, t, d?}]`, con `k` ∈ {Q, W, E, R, D, F, B, item (1–7), enter, esc, other}; el resto de teclas se reducen a `other` para que no se pueda reconstruir el chat;
    - las estadísticas de §2.
  - Destino: `game-upload.js:3`, un API Gateway de AWS.
- **Log de diagnóstico**: `%TEMP%\microlab_mouse_debug.log` (`mouse-tracker.js:94-99`).

### 1.10 Salud de captura [O]

- `main/services/input-health.js` evalúa una muestra como mucho cada 500 ms, por ventanas de 20 s y con 30 s de gracia inicial.
  - Una ventana es sospechosa si el cursor recorrió ≥400 px (pasos ≥3 px, cada paso limitado a 200 px) en ≥10 movimientos y no se guardó ningún clic.
  - El motivo es `delivery`, `filtered` o `capture`. `capture` exige además menos de 5 clics del hook y 6 ventanas silenciosas seguidas (2 min).
- Si una sesión de ≥120 s acaba con 0 clics y el cursor se movió ≥20 px, se envía un aviso a Sentry (`mouse-tracker.js:767-828`).
- Si el juego corre como administrador y la app no, el hook no oye nada (UIPI). La app ofrece «Restart as administrator» (`locales/en.json:109-110`).

---

## 2. Métricas de la pestaña Inputs

Cálculo: `js/desktop/game-details.js:289-341`, que llama a `DataSerializer` en `js/utils/data-serializer.js`. Todo es local y determinista. Los clics incluyen izquierdo y derecho salvo que se indique otra cosa.

| Métrica (UI) | Fórmula exacta | Archivo:línea |
|---|---|---|
| **APM** | `(nClicks + nKeypresses) / ((positions[last].time − positions[0].time)/60000)`, con 1 decimal. Las teclas son **todas** las pulsaciones (sin repetición automática, con chat). El tiempo es reloj de pared e incluye muertes y alt-tab. Si hay menos de 2 posiciones, todo vale 0. | `data-serializer.js:26-40` |
| **Traveled** | `Σ ‖p_i − p_{i−1}‖` sobre todas las posiciones (con los puntos de clic insertados), redondeado. Se muestra en metros: `m = px · (1080 / window.screen.height) · 0.000264583`. Se usa ≥1000 m → «km», ≥1 m → «m» y si no «cm». [I] `screen.height` es el del monitor **del visor**, no el de la partida. | `data-serializer.js:42-55`; `js/utils/format.js:64-80` |
| avgVelocity / maxVelocity | `totalDistance / (totalTime/1000)` px/s y `max(dist/dt)` por par con `dt > 0`. No salen en la UI; solo van al log, a la nube y al asistente. | `data-serializer.js:57-60` |
| **Efficiency** | `Σ_pares straight / Σ_pares path`: un **cociente de sumas**, no una media de cocientes, sobre cada par de clics consecutivos. `straight = ‖b − a‖`. `path` es la longitud de la polilínea de las posiciones con `gameTime ∈ [t_a, t_b]` (búsqueda binaria) si hay ≥2; si no, `path = straight`. Si `path = 0` → 1,0 (o 0 si `straight > 0`). `null` con menos de 2 clics. Se muestra como `(eff·100).toFixed(0)%`. | `data-serializer.js:316-356`; UI `game-details.js:327` |
| **Spread** (subtítulo de Efficiency) | Media de `‖c_i − c_{i−1}‖` entre clics consecutivos, «Spread: N px». Exige ≥3 clics. La función también devuelve stdDev (poblacional), 30 cubos temporales y los cubos más apretado y más ancho, pero la UI no los usa. | `data-serializer.js:374-446`; `game-details.js:314-317` |
| **Clicks** | total, izquierdo y derecho | `data-serializer.js:62-68` |
| **Tempo** | `(N − 1) / ((t_N − t_1)/1000)` en Hz, con `gameTime` de todos los clics. El botón ▶ lo hace sonar: WebAudio, seno de 660 Hz, envolvente 0→0,3 en 5 ms y exponencial →0,001 a los 80 ms, con `setInterval(1000/Hz)`. | `data-serializer.js:361-368`; `game-details.js:478-507` |
| **Idle** | Algoritmo de ventanas, abajo. Se muestra como duración. | `data-serializer.js:70-127` |
| Camera pans | `nPans / (totalTime/60000)` → «X/m» y «N total» (§3.10) | `game-details.js:303-308` |

**Idle**, pseudocódigo exacto (`IDLE_THRESHOLD_PX = 5`, `IDLE_WINDOW_MS = 1000`):
```
dead = intervalos [death.gameTime, respawn.gameTime]; un death sin respawn se cierra con la última posición
ws = 0; idle = 0
for i in 1..n-1:
    dt = pos[i].time - pos[ws].time
    if dt >= 1000:
        mid = (pos[ws].gameTime + pos[i].gameTime) / 2
        if mid ∈ dead: ws = i; continue
        if dist(pos[i], pos[ws]) < 5: idle += dt      # desplazamiento entre los extremos, no el recorrido
        ws = i
idlePercent = idle / totalTime · 100
```
- [I] Las ventanas miden **≥1 s** y pueden ser mucho más largas. Un hueco sin muestras por cursor quieto entra entero como una sola ventana. Un movimiento que vuelve al mismo sitio también cuenta como inactivo.
- [I, **posible fallo**] La versión Electron **nunca emite eventos `respawn`**: `game-events.js` solo envía kill, death, assist, multikill, objetivos (ace, turret_kill, …), game_end y match_start (`game-events.js:181-235, 294-308`); `respawn` solo existe en la lista de Overwolf, `background.js:1701`. Por tanto el intervalo de muerte va **desde la 1.ª muerte hasta el final** y el Idle solo mide hasta la primera muerte. Lo mismo afecta a «Alive only» (§3.4).

**Deltas** (`game-details.js:228-255, 357-389`):
- La referencia es **la partida anterior en la lista visible**, ordenada de más nueva a más vieja: `games[idx+1]`.
- `pct = (actual − anterior)/|anterior|·100`. Para Efficiency, `pct = (actual − anterior)·100`, en puntos porcentuales.
- Se oculta si `|pct| < 0,5` o si `anterior = 0`.
- Flecha ▲/▼. En Idle está invertido: subir es malo.
- Hay delta en APM, Traveled, Efficiency, Clicks, Tempo, Idle y Pans/min.

---

## 3. «Patrones»

### 3.1 Vista Expanded: datos y filtro de tiempo [O]

- Carga la partida entera de IndexedDB (`pages/expanded.js:41-125`). `maxMs` = máximo `gameTime` de las posiciones.
- Filtro: el deslizador de inicio y el de duración van en % de `maxMs`. La duración mínima es 1 s (`js/expanded/filters.js:84-117, 440-450`). El recorte usa búsqueda binaria `[lower(start), upper(end))` (`filters.js:5-45`).
- Navegación por eventos: kill y death muestran `[t − 10 s, t]`; assist muestra `[t − 10 s, t + 3 s]` (`js/expanded/state.js:25-41`; `filters.js:138-155, 340-358`). Teclas `[ ]`, `{ }`, `( )` (`pages/expanded.js:826-837`).
- Dibujo: encaje con ×0,9, zoom de 1 a 20, trazo cortado en huecos >500 ms (`canvas.js:248-377`).

### 3.2 Secuencia con clic derecho [O]

- Clic derecho en un punto: el clic más cercano dentro de `20·zoom` px de canvas (`canvas.js:116-135`).
- Selección: `[i, min(i + range − 1, N − 1)]` con `range` = 15 por defecto (`state.js:56-63`; `canvas.js:190-245`). Botones ±10 (mínimo 2 clics; `sequence.js:150-194`). «Select all» con `A`. «Isolate» con `I` oculta lo demás.
- «Attacks only» se queda solo con los clics **izquierdos**. Entonces la eficiencia se oculta y el timing sigue.
- **Eficiencia de la secuencia** (`sequence.js:219-303`): misma fórmula que la global (§2), aplicada a los clics de la secuencia. Colores: ≥0,9 verde, ≥0,7 amarillo, ≥0,5 naranja, por debajo rojo. El detalle es «recta / real px».

### 3.3 Timing de la secuencia [O] (`sequence.js:352-436`)

Se calcula por botón: `left` es «ATK» y `right` es «MOV».
```
c = clics de la secuencia con ese botón
Δ_k = t_k − t_{k−1}, solo los Δ > 0 (t = gameTime, o time si falta)
avg = media(Δ); std = sqrt(media((Δ−avg)²))                  # poblacional
CV = std/avg·100;  consistency = 100·exp(−CV/50)
freq(Hz) = (#Δ / (t_last − t_first))·1000
min/max de Δ
```
La UI **solo enseña `freq`** de ATK y MOV (`:439-505`). `consistency`, `std` y `CV` se calculan pero no se muestran [O].

### 3.4 Ranking de eficiencia [O] (`sequence.js:596-733`)

```
L = longitud (10 por defecto, entre 2 y N)
para cada i en 0..N−L:                                   # ventana deslizante de paso 1
    si aliveOnly y [t_i, t_{i+L−1}] solapa un intervalo de muerte: saltar
    eff_i = cociente de sumas de §2 sobre clics[i..i+L−1]
ordenar: de mayor a menor (por defecto) o al revés (tecla S)
voraz: quedarse con cada ventana que no solape en índices con ninguna ya elegida
```
- Teclas: `R` activa el ranking y `<` `>` navegan.
- Los intervalos de muerte son death→respawn, o hasta `maxMs` si falta el respawn (`sequence.js:511-554`). Ver el posible fallo de §2.

### 3.5 Metrónomo [O] (`js/expanded/metronome.js`)

- ATK suena a 880 Hz y MOV a 440 Hz. Seno con envolvente de 5 ms y 80 ms. Intervalo `1000/freq` ms.
- Si la secuencia cambia mientras suena, se reinicia con la nueva frecuencia (`sequence.js:482-504`).

### 3.6 Lanzamientos de habilidad [O] (`js/utils/ability-detection.js`)

- **En la vista Expanded no funciona**: `expanded.html:375-397` no carga `abilities.js`, `ability-detection.js` ni `keycodes.js`, y `abilityCastNav` no está declarado en ninguna parte. Las llamadas están protegidas con `typeof initAbilityCasts === 'function'` (`pages/expanded.js:601, 960`).
- **Sí se usa en el Replay** (`js/replay/video.js:151-159`; pausar en lanzamientos con `B`, `render-loop.js:77-100`) y en `vod-metadata.js`.

Pipeline por pulsación:
```
1. tecla ∈ {16:Q, 17:W, 18:E, 19:R, 32:D, 33:F}                       (scancodes: posición física QWERTY)
2. no hay chat abierto: Enter abre; Enter o Esc cierran; se cierra solo a los 8000 ms; dentro = (open, close]
3. no está muerto: [death, death + 15000 ms] (respawn fijo de 15 s aquí)
4. nivel > 0 en el snapshot ≤ t, o en el siguiente; D y F siempre pasan
5. confianza = 'high'; si hay ≥3 teclas alfabéticas que no son de habilidad en ±200 ms → 'low'
6. si sigue 'high' y la velocidad media del cursor en ±150 ms es < 50 px/s → 'low'
7. cursor = posición más cercana en tiempo
→ {ability, gameTime, cursorX, cursorY, confidence}
```
[I] El replay pasa `gameTime` al reloj del vídeo (§1.7) pero no `abilitySnapshots`, que sigue en tiempo de partida. [D] No sé si la detección corre antes o después del remapeo; si corre después, la puerta de nivel compara relojes distintos.

### 3.7 Vista previa de la pestaña Inputs: Path / Heatmap [O] (`js/desktop/preview.js`)

- **Path**: polilínea de todas las posiciones con la opacidad elegida ×0,45 y puntos izquierdo/derecho. El encaje usa el min/max de las muestras con 20 px de margen (`:109-159, 463-511`).
- **Hover**: clic más cercano a ≤18 px. La búsqueda va por una rejilla de cubos de 28 px y mira la vecindad 3×3 (`:34-36, 92-107, 584-609`). Muestra una secuencia de **10 clics** centrada: `start = i − 5`, `end = start + 9`, ajustada a los bordes (`:611-619`). Al hacer clic abre un mini reproductor de `[t_start, t_end]` (`:746-760`).
- **Heatmap**, en §3.8. **Caja arrastrable**: un arrastre de ≥4 px de canvas y ≥6 px de pantalla por lado (`:47, 264-271, 729`) consulta `CursorVisits.visits(positions, box)` (§3.9) y muestra «tiempo dentro · N momentos». «Watch N moments» abre el Replay y reproduce cada momento con 1500 ms de antes y 1000 ms de después (`js/replay/box-moments.js:14-26`).

### 3.8 Heatmap: rejilla, núcleo y normalización [O] (`js/core/heatmap-core.js`)

```
kernel(σ): radio r = ceil(2,5σ); tamaño 2r+1; w = exp(−(dx²+dy²)/(2σ²)); normalizado a suma 1
densityGrid(points, cols, rows, project, kernel):
    counts[celda(floor(project(p)))] += 1          # fuera de la rejilla se descarta
    blur separable con la fila central normalizada del kernel (horizontal y luego vertical)
percentile(grid, p): valor en floor(n_nozero·p) de las celdas >0 ordenadas
logCurve(k): t ↦ ln(1 + k·t)/ln(1 + k)
paint: t = curve(v/norm) → índice LUT = min(255, t·255) → RGBA; las celdas vacías quedan transparentes
```
- **Escritorio** (`preview.js:176-218`): la celda mide 2 px de canvas. `σ = 1,2` celdas (r = 3). La proyección es `p·fit/2`, donde `fit` encaja la **resolución lógica de la partida** en el canvas. Normaliza al **percentil 99,9** de las celdas no nulas. Curva `log` con `k = 20`. Paleta `SCREEN_HEAT_STOPS` sobre fondo azul marino (`heatmap-core.js:142-150`).
- **Replay** (`js/replay/heatmap.js`): celda de 6 px de coordenadas. Dos capas acumulativas hasta el instante actual:
  - movimiento: σ = 3, normalizado fijo `v·255/30`, tonos azules;
  - clics: σ = 5, normalizado fijo `v·255/3`, tonos rojos.
  - Se mezclan por alfa. Se dibuja con `globalAlpha = 0.55`. Guarda un checkpoint cada 60 s para retroceder (`:9-61, 78-130, 173-241`).
  - [I] La rejilla usa `mouseCoordWidth = videoWidth`, aunque los puntos están en DIP.

### 3.9 Cursor visits («momentos» dentro de una región) [O] (`js/core/cursor-visits.js`)

```
SAMPLE_MS = 16; MAX_HOLD_MS = 250; región = caja {x,y,width,height} o círculo {x,y,radius}; bordes incluidos
para cada muestra p (t = gameTime ?? time):
    si p está dentro:
        held = (no hay siguiente) ? 16 : (en orden y t_sig > t) ? min(t_sig − t, 250) : 0
        si hay momento actual y t − actual.end ≤ gapMs(4000): ampliarlo; insideMs += held
        si no: cerrar el actual y abrir uno nuevo
durationMs = end − start + 16
devolver los momentos con insideMs ≥ minMs(1000)
summary: count, totalMs = Σ insideMs, longestMs, spanMs = Σ durationMs
```

### 3.10 Paneos de cámara por borde [O] (`data-serializer.js:545-650`)

```
dim = min(W, H) lógicos; EDGE = max(25, round(0,04·dim)); GAP = 30 ms; MAX_GAP = 3000 ms
edgeDir(p) = combinación de top/bottom/left/right si p está a ≤EDGE del borde
trajectoryEdgeDir(i): Δ>2 px hacia un borde y estar en el 20 % exterior de ese eje
recorrer las posiciones:
  si 30 < hueco < 3000 ms:                         # el cursor salió de los límites (sin bordes en borderless)
      con paneo activo: alargarlo hasta p; si p no está en el borde, cerrarlo
      sin paneo: si la muestra previa está en el borde o iba hacia él, abrir un paneo [t_prev, t_p]
  si hueco ≥ 3000: cerrar                           # alt-tab
  p en el borde → abrir o alargar; p fuera del borde → cerrar
duración mínima = 0 (un solo fotograma en el borde ya cuenta)
```
[I] En modo uiohook el cursor parado en el borde no genera muestras. El paneo dura hasta la muestra siguiente si llega antes de 3 s.

### 3.11 Superposiciones del Replay [O] (`js/replay/overlay.js`)

- **Distancia del último par de clics** en px, que se mantiene hasta el siguiente clic (`:246-291`).
- **Eficiencia del último par**: se omite si la recta mide <5 px. Usa las posiciones reducidas y la limita con `min(…, 1)`. Mismos colores que en §3.2 (`:293-363`). También dibuja la línea recta ideal (`:365-395`).
- **Flechas de paneo** de `cameraPans` (`:432-…`).
- Atajos: `G` heatmap, `N` distancias, `E` eficiencia (`js/core/player-keys.js:26-28`). `player-keys.js` y `hotkey-keys.js` solo son atajos de UI y del clip/marcador dentro de la partida (`game-hotkeys.js`); no son captura.

### 3.12 Lo que no es un patrón de análisis

- **`cursor-art.js`** [O] es solo estética del cursor en el Replay y la exportación de clips. Cambia el grosor según la velocidad: `w = 2 + 12·(1 − min(1, v/3600))^1,3` px@1080p. Corta tramos en huecos >500 ms. Las «permanencias» son puntos a ≤6 px durante ≥90 ms. Las marcas de clic derecho se fusionan si caen en el mismo sitio en <180 ms; como mucho hay 6 vivas. Todo es aleatorio con semilla para ser determinista (`cursor-art.js:24-28, 76-80, 91-166, 597-605`).
- **`detectClickClusters`** (`data-serializer.js:453-534`): rachas de ≥4 distancias entre clics por debajo de la media. Es **código muerto**: no lo llama nadie.
- **`phase.js`**: contexto por minuto sacado de la **timeline de Riot** (forwardness respecto a la diagonal de nexos, zonas aproximadas, deltas de daño y oro). No usa los inputs del ratón.

### 3.13 Reconstrucción de posición en el mapa (HMM) [O] (`js/core/position-track.js`, en un Web Worker)

- La rejilla es el navgrid de la Grieta: celdas de 200 u, máscara de bits caminables, tick de 500 ms (`:70-87, 122-140`).
- **Observaciones** (gaussianas sobre celdas caminables):
  - frames por minuto de Riot, σ = 70;
  - muertes, σ = 70;
  - kills especiales σ = 60, kills σ = 650, estructuras σ = 500;
  - reaparición en la fuente σ = 150 con reinicio uniforme;
  - mientras está muerto, cada 1 s, σ = 120;
  - compras fuera de la muerte, en la fuente, σ = 500;
  - `B` sin muerte ni movimiento en 8000 ms, en la fuente a los 8600 ms.
- La reaparición sale de `dead/rt` de liveStats. Si no hay, de la vida pasando de <60 % a ≥90 %. Si tampoco, de una tabla BRW por nivel más el factor por minuto (`:300-325`).
- **Órdenes de movimiento** (`:262-287`):
  - todo clic derecho;
  - un clic izquierdo si hubo `A` en el segundo anterior (attack-move);
  - se quitan los que caen a ±400 ms de una compra;
  - se quitan los repetidos (≥3 en ±1200 ms a ≤2 px), salvo en la zona del minimapa (`x > 0,83w`, `y > 0,72h`);
  - se quitan los que caen <1500 ms después de `P` (tienda) dentro de la zona central.
- **Cámara**:
  - un clic izquierdo en el minimapa fija el centro de cámara;
  - un tramo ≥100 ms en el borde (≤2 px) suelta la cámara;
  - un clic en pantalla con la cámara conocida (≤10 s) da un **destino**: suelo proyectado con la cámara en perspectiva;
  - sin cámara da un **rumbo**, con offset por lado `{100: [137, 78], 200: [−168, −365]}` y memoria `d/velocidad + 500 ms`;
  - `S` o `Espacio` recentran: σ del ángulo de 18° durante 3 s; si no, 30°.
- **Transición** (`:156-233`): núcleo de radio 3 celdas, `σ_paso = 60`, 10 % isotrópico de atípicos, `pStay = 0,5` sin orden, teletransporte `1e−5`, velocidad = `moveSpd` de liveStats o 350.
- **Suavizado**: forward-backward. Resultado: media posterior (x, y) y `spread = √Var`.
- **Autocalibración**: 2 iteraciones EM. Triangulación por mínimos cuadrados de 5 órdenes en ≤2,5 s, residuo ≤200. Mediana en ventanas de 45 s sobre una rejilla de 5 s, limitada a ±1200 (`:483-589`).
- Confianza en la UI: `spread < 200` «±50», `< 400` «±250», `< 800` «±800», si no «Low» (`js/replay/position-map.js:372`).

---

## 4. ¿IA, ML o servidor?

- **Todo lo de §2 y §3 es local y determinista** [O]: estadística descriptiva, geometría, búsquedas binarias, gaussianas y un HMM con parámetros fijos. **No hay ningún modelo entrenado.** El HMM es probabilístico pero no aprende; el «EM» solo ajusta un offset de cámara por partida.
- **Partes con servidor** [O]:
  1. Las **anclas de posición** de §3.13 vienen del worker en la nube de MicroLab (`CloudAuth.WORKER_BASE` + `/api/riot/resolve-match|match|timeline`), que hace de proxy de match-v5 y timeline de Riot. Requiere login (`main/services/riot-match.js:35-90`; `position-anchors.js`). El modo «Exact» usa además un oráculo de la Replay API (`exact-positions.js`).
  2. **Subida de partidas** a la nube: opt-out, activada por defecto si hay sesión (§1.9).
  3. El **coach IA** recibe un resumen de texto con APM, Click efficiency, Clicks, Tempo, Idle y distancia (`js/ui/assistant-tools.js:40-75`) vía su Worker `/api/assistant`, que según el comentario de `assistant-client.js:1-7` usa Anthropic.
  4. Sentry para diagnóstico de captura.
- La Live Client API (`127.0.0.1:2999`) es local, del propio juego.

---

## 5. Qué depende del módulo nativo `microlab-recorder.win32-x64-msvc.node`

Visto desde `native/index.js` (`:62-76, 314-331`) y sus llamadas en JS. Es Rust con napi-rs.

| Exportación | Uso en captura de inputs | Dónde |
|---|---|---|
| `getMouseButtonState()` → `{left, right}` | Sonda de salud y clics de respaldo por flanco cada 16 ms. [I] Usa `GetAsyncKeyState`: la importa y aparecen las cadenas `get_mouse_button_state`, «left»/«right». | `mouse-tracker.js:270-273, 385-442` |
| `checkGameFocused('RiotWindowClass')` → bool | Foco cada 250 ms y recuperación síncrona en el clic. [I] `GetForegroundWindow` + `FindWindowW`. | `game-detector.js:82`; `mouse-tracker.js:275-292` |
| `getGameWindowRect('RiotWindowClass')` → `{left, top, width, height, clientWidth, clientHeight, dpi}` | Límites y resolución (§1.6). [I] `GetWindowRect`, `GetClientRect`, `GetDpiForWindow`. | `game-detector.js:96` |
| `findWindowExists`, `findWindowByTitleExists` | Detección de juego y lanzador | `game-detector.js:64` |
| `configureRecorder`, `startRecording`, `stopRecording`, `getFirstFrameTime`, `getProcessedFrameCount`, … | Grabación de vídeo. Su `startTime` es el `videoStartTime` de la sincronía (§1.7). | — |

- **Del módulo nativo NO depende** [O, por imports]: la captura de movimiento, clics y teclas en modo normal. Eso es **uiohook-napi**, otro binario. Tampoco la posición del cursor, que sale de `screen.getCursorScreenPoint()` de Electron.
- El `.node` no importa `SetWindowsHookEx`, `GetCursorPos` ni Raw Input (`ev_18476c3b…`).

---

## 6. Notas para reimplementarlo en Tauri + Rust

- **Captura**: un hilo con `SetWindowsHookExW(WH_MOUSE_LL / WH_KEYBOARD_LL)` y bucle de mensajes, o la crate `rdev`, que hace lo mismo. Para replicar MicroLab:
  - hora del evento = `MSLLHOOKSTRUCT.time` / `KBDLLHOOKSTRUCT.time` más un offset epoch calibrado una vez;
  - guardar `mousedown` izquierdo y derecho (no mouseup) y el botón central como arrastre;
  - para teclas: `scanCode`, sin repetición automática (conjunto de teclas pulsadas) y `dwell` al soltar.
- **Coordenadas**: el hook da píxeles físicos si el proceso es per-monitor DPI-aware, como Tauri por defecto. Lo más sencillo es guardar en **físicos relativos al área cliente** (`GetClientRect` + `ClientToScreen` de la ventana `RiotWindowClass`) y guardar también la resolución. Así se evitan los descuadres de DIP que MicroLab corrige a mano (§1.6) y el que aún tiene en `payloadFromGame` (§1.8).
- **Insertar cada clic también como posición** (MicroLab lo hace). La eficiencia y la distancia dependen de ello.
- **Foco**: descartar posiciones sin foco y comprobar el foco de forma síncrona en el clic.
- **Dedupe**: el de 8 ms y 1 px es razonable. No copiar el dedupe global de 5 ms entre teclas distintas.
- **Reloj**: `gameTime` desde la Live Client API, con offset promediado como en §1.5, recalculado al final, descartando lo negativo y ordenando.
- **Métricas**: las fórmulas de §2 y §3 se pueden copiar tal cual. Cuidado con lo que MicroLab hace raro:
  - el APM cuenta las teclas del chat;
  - el Idle usa el desplazamiento entre extremos y se rompe tras la 1.ª muerte (§2);
  - Traveled en metros depende del monitor del visor;
  - el `consistency` de timing está calculado y nunca se enseña.

---

## 7. Resumen de lo inferido y lo desconocido

**Inferido [I]**
- uiohook usa hooks LL de Windows. La tasa real de muestras va con la frecuencia del ratón.
- Sin movimiento no hay muestras en modo uiohook, y eso condiciona Idle y los paneos.
- El dedupe global de 5 ms entre teclas puede perder pulsaciones simultáneas.
- Posible fallo: sin `respawn` en Electron, Idle y «Alive only» excluyen todo desde la 1.ª muerte.
- `payloadFromGame` mezcla `width/height` físicos con clics en DIP.
- La rejilla del heatmap del Replay usa el ancho del vídeo para coordenadas DIP.
- El minimapa está fijo (escala por defecto, abajo a la derecha).
- `getMouseButtonState`, `checkGameFocused` y `getGameWindowRect` usan las APIs user32 deducidas de imports y cadenas.
- LevelDB comprime con Snappy.

**Desconocido [D]**
- Si `contentStartOffsetMs` se resta en alguna ruta de reproducción además de la observada.
- Si la detección de habilidades del Replay corre antes o después del remapeo a reloj de vídeo.
- La implementación interna exacta de las funciones nativas: no se descompiló.
- Qué hace el servidor con los inputs subidos.
