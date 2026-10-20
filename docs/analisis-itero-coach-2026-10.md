# iTero Coach por dentro, y qué nos llevamos (2026-10-19)

Ingeniería inversa **estática** de *The iTero Coach* 3.11.7 (`%LOCALAPPDATA%\Programs\iTero Drafting Coach Electron`), hecha con REA 6.5.0 (`analyze-javascript-application`, `inspect-electron-fuses`) más lectura del `app.asar` extraído. No se ejecutó nada del programa ni se llamó a sus APIs. Lo que va marcado como **comprobado** está verificado contra el código. Lo marcado como **por verificar** es conocimiento nuestro que no sale de iTero.

## 1. Qué es iTero

- **Plataforma:** Overwolf Electron 42.7.1 con los paquetes `gep` (eventos de juego) y `overlay`. React 19, TanStack Router y Query, zustand y electron-store.
- **Ventanas:** 16. Están desktop, background (Firebase), drafting y drafting-aram, ingame e ingame-second (la versión para segunda pantalla), sus equivalentes de ARAM, y 8 overlays: map-timers, monster-buff-timers, ult-cooldown-timers, skill-level-up-tracker, stat-tracker, team-gold-tracker, damage-tracker y aram-mayhem-augments.
- **Fuente de los datos de juego:** todo llega por **Overwolf GEP**, nunca por la API local de la partida (0 referencias a `liveclientdata` o `:2999`, **comprobado**). El puerto y el token del LCU también los da GEP (`lcu_info.port`/`.token`), así que no lee el lockfile.
  - Funciones GEP del launcher: `summoner_info, lcu_info, game_flow, lobby_info, champ_select, game_info`.
  - Funciones GEP de la partida: `live_client_data, match_info, death, kill, assist, gold, minions, summoner_info, teams, level, announcer, damage, counters, jungle_camps, team_frames, augments`.
- **El "cerebro" está en su servidor:** AWS API Gateway por región. euw1, eun1, me1, ru y tr1 van a eu-central-1; na1 a us-east-2; br1, la1 y la2 a sa-east-1; kr y jp1 a ap-northeast-2; oc1 y SEA a ap-southeast-1. Endpoints `lake-*`: `draft-v2-{lane}`, `coach-{lane}`, `match-analysis`, `request-data`, `basic-info`, `team-scouting`, `leaderboard`, `flame-me` y `regional-pricing`. Los datos estáticos salen de CloudFront.
- **REA (puente preload):** 8 APIs (`electronAPI, network, errorReporter, overwolfPackages, ipcRenderer, windows, api, logger`), 50 miembros y 102 operaciones IPC.
  - Expone `ipcRenderer.invoke/send/on` **en crudo**, para cualquier canal.
  - Fusibles de Electron: RunAsNode, NODE_OPTIONS e `--inspect` desactivados; integridad del asar activada.
- **Lo que no hay que copiar:**
  - El token del LCU se escribe en claro en el log.
  - Las APIs `lake-*` no llevan autenticación: identifican al usuario solo por puuid.
  - El servidor se fía de un `itero_plus: true` que manda el cliente.
  - El IPC está abierto a cualquier canal.

## 2. Selección de campeón (draft)

- **Estado:** llega por GEP `champ_select.raw`, que es el JSON de `/lol-champ-select/v1/session`. Una máquina de fases (`zG`/`XG`) combina gameflow, queueId y subestado de la selección, y de ahí salen las fases `Picking`, `ChampLocked`, `EveryoneLocked` e `InGame`. También detecta un *dodge* (de champ select a Lobby) y el fin de partida (de InGame a Lobby).
- **Escrituras al cliente (LCU):**

| Método | Endpoint | Para qué |
|---|---|---|
| PATCH | `/lol-champ-select/v1/session/actions/{id}` | hover; con `completed:true` bloquea el pick o el ban (auto-hover, auto-ban, auto-lock) |
| PATCH | `/lol-champ-select/v1/session/my-selection` | hechizos `{spell1Id, spell2Id}`, respetando si el usuario tiene Flash en D o en F |
| POST | `/lol-champ-select/v1/session/bench/swap/{id}` | cambio con el banquillo en ARAM |
| GET | `/lol-champ-select/v1/all-grid-champions` | campeones propios, gratuitos y de Game Pass |
| GET/POST/PUT | `/lol-perks/v1/pages`, `/pages/{id}`, `/currentpage` | página de runas "iTero Recommended Runes" |
| GET/POST/PUT | `/lol-item-sets/v1/item-sets/{summonerId}/sets` | set de objetos "iTero: Champion Set" |
| GET | `/lol-game-settings/v1/game-settings` | geometría del HUD, para colocar los overlays (§4) |

- **Recomendación:** `POST lake-draft-v2-{lane}` con `{action:"recommend", mastery_data, t1_side, bans, rank_class, t1_TOP_champion…, user_model_weightings}`. Cada candidato vuelve con `result_pred_rating` (nota global), `laning_pred_rating`, sinergias y counters por carril, escalado early/mid/late, AD ratio, builds y `matchup_analysis` por nivel.
  - Es su modelo propietario. Reproducirlo exige millones de partidas, así que **no es copiable**.
- **Reglas que corren en el cliente (comprobado):**
  - Nota de 0 a 5: rojo por debajo de 1,7, amarillo desde 1,7, verde desde 3,3.
  - Estilo del matchup por nivel. `d` es `damage_diff_rating` y `k` es `kill_diff_rating`, ambos en escala de 0 a 5:
    - Jungla: k < 1,667 → «farmear y crossmap»; k ≤ 3,33 → «neutral»; si no, «gankear e invadir».
    - Carriles: d y k entre 1,667 y 3,333 → «Neutral». Si no:

      | | k < 2,5 | k > 2,5 |
      |---|---|---|
      | **d < 2,5** | Safe | Sustain |
      | **d > 2,5** | Poke | Bully |
  - Tier list personal según el winrate en el carril: ≥54 S+, ≥52 S, ≥51 A+, ≥50 A, ≥49 B, ≥48 C, ≥47 D; por debajo, «INT».
- **Pool y ban pool:** son solo del cliente: ordenan y filtran el auto-hover. No se mandan al servidor.

## 3. En partida (overlays)

Todo llega por GEP, con un *debounce* de 500 ms y difusión entre ventanas por suscripción a claves (`store:<nombre>:update`).

| Overlay | Lógica (comprobada) | ¿Se puede hacer sin GEP, solo con la API :2999? |
|---|---|---|
| Timers de mapa | `InhibKilled` → reloj + 300 s; `TurretKilled` de torre de nexo (`L1_P4/P5`) → + 180 s; reliquias de ARAM + 90 s. **No tiene timers de dragón, barón, heraldo, larvas ni Atakhan.** Solo procesa el último evento de cada lote | Sí, con `/eventdata` (procesando cada `EventID`) |
| Buffs de barón y ancestral | `BaronKill` + 180 s, `DragonKill` Elder + 150 s; los portadores son los vivos del equipo que mata, y se van quitando con `isDead` | Sí (`/eventdata` + `/playerlist`) |
| Oro del equipo | Σ `priceTotal` de los objetos de cada jugador (CDragon `items.json`); empareja las filas por índice, **no por rol** (bug) | Sí, emparejando por `position` |
| CS/min | (minions + neutrales) / minuto frente a una curva por elo `cs_tracker` del servidor | Sí, con `scores.creepScore` y nuestros baremos |
| Estado de línea | Tu `total_gold` frente a una tabla por carril y minuto; p. ej. MID min 14: por detrás ≤ 1.793, por delante ≥ 2.024 | A medias: la API no da el oro total (hay que estimarlo como objetos + oro actual) |
| Subida de habilidad | Flecha sobre `order[nivelesGastados]` cuando te queda un punto; la runa 8313 permite un punto de más desde nivel 9 | Sí; falta una fuente para el orden de habilidades |
| Ultis aliadas | `team_frames.ult_cd`, que Overwolf lee del HUD; no lo calcula | No (habría que leerlo del vídeo) |
| Daño hecho y recibido | Deltas de GEP `damage` | No; la API en vivo no da daño |
| Aumentos de ARAM Mayhem | Nota S–D por aumento, de un JSON por campeón | No (GEP `augments`) |

- **No hay coaching en vivo.** No hay avisos, ni TTS, ni nada tipo "objetivo en 60 s". Todo es información pasiva.
- **Teclas:** `Tab` mantenido muestra los paneles de oro, daño y buffs y deja moverlos; Alt+I abre el panel de partida y Alt+O cambia de pestaña. Son hotkeys de Overwolf con *passthrough*.
- **Ventanas:** se acotan a los límites de la ventana del juego. Las posiciones se guardan con *debounce* y cualquier ventana que quede fuera de pantalla se recentra.

## 4. Geometría del HUD sin mirar el vídeo (lo más aprovechable)

iTero coloca los overlays leyendo `HUD.MinimapScale`, `FlipMiniMap`, `GlobalScale` y `ShowTeamFramesOnLeft` de `/lol-game-settings/v1/game-settings` (chunk `D7yQ8ZjR.js`, **comprobado**). El minimapa es un cuadrado anclado a la esquina:

```
base = round(H / 5.12);  paso = round(base / 3)
lado = round(base + paso * MinimapScale)
x0   = FlipMiniMap ? 0 : W - lado;   y0 = H - lado
```

- **Lo que pasa en esta máquina (comprobado):** `C:\Riot Games\League of Legends\Config\PersistedSettings.json` tiene `MinimapScale = 3.0000`, `FlipMiniMap = 0` y `GlobalScale = 0`.
  - A 1080p la fórmula da un lado de 421 px, con x0 = 0,781·W e y0 = 0,610·H.
  - Nuestro rectángulo fijo de `camera_input.rs:38` va de x 0,787 a 0,995 y de y 0,622 a 0,972. Es casi el mismo, con margen por el marco.
- **Consecuencia:** nuestro `minimap_scale = 1.0` equivale al `MinimapScale = 3` de este usuario.
  - Un cliente con el minimapa más pequeño o volteado a la izquierda obtiene análisis de minimapa erróneos: clics, miradas, recorrido, presión, golpes, manos y hechizos.
  - Ese cliente tampoco tiene forma de saber qué valor poner en Ajustes › Avanzado.
- **Corrección:** el modelo actual (`minimapa_rect`) escala de forma proporcional desde el ancla. El de iTero es afín: base + paso·escala. Es otro caso del patrón «funciona en la máquina de desarrollo y falla en una instalación limpia».

## 5. Post-partida y estadísticas

- **Coach de macro:** no hay LLM. Unas 121 estadísticas base por tramo (`7_`, `14_`, `21_`, `28_`, `99_`) llegan a «casi 500 métricas».
  - Cada tramo recibe una nota de 0 a 5, con sus fortalezas y debilidades, que son claves de estadística y no texto.
  - Las áreas de mejora son «las estadísticas que más bajan tu probabilidad de victoria prevista».
  - Hay **sesiones**: la revisión se bloquea durante 10 partidas. El tramo de foco es el peor que tenga al menos 10 partidas.
  - Cada estadística tiene su media móvil de 50 partidas, con una marca de «Coaching Started».
- **Muertes con precio:** `major_death` = «ganancia neta de más de 1000 de oro para el enemigo alrededor de la muerte, estimando objetivos no-oro (dragones, barón)» (**comprobado**, `BMkP8Yye.js`). Hay más categorías: `low_damage_death`, `death_to_jungler`, `turret_diving_death` antes del minuto 14 y `out_lane_death`.
- **Detalle de partida:**
  - Curva por minuto de oro, XP, daño hecho y daño recibido, con modos «vs rival de línea / vs media rival / equipo vs equipo / los 10» y una franja de objetivos bajo el eje.
  - Un título para cada uno de los 10 jugadores («The Ghost», «Bullied by Jungler»).
  - Percentiles ajustados por campeón.
- **Partida por delante, igualada o por detrás:** todas las estadísticas de cuenta se pueden partir según cómo iba la partida.
- **Calibración:** winrate propio por tramo de *draft score* frente a una línea base comunitaria `{40,6; 47,9; 51,1; 53,9; 58,8}`.
- **Flujo al terminar la partida:**
  1. Un toast «Analysing your previous match…» con estado de promesa.
  2. Un POST al servidor y luego sondeo hasta que aparece la partida.
  3. Parpadeo en la barra de tareas hasta que la ventana recibe el foco.
  4. Se abre sola la ficha de la partida.
- **Premium:** el coach partida a partida, el análisis prioritario, el draft continuo, quitar anuncios y personalizar el modelo. Las estadísticas de cuenta son gratis.

## 6. Qué nos llevamos, por orden

Puntos de partida en LeagueRecorder: no hay LCU ni selección de campeón; la API :2999 se consulta a 1 Hz; hay un overlay (el metrónomo) y un hook de teclado (`rdev`); y existen `winprob.rs`/WPA, `benchmarks.rs` (deciles por rol y franja de rango) y el foco de la semana (el tramo en que más mueres).

### A. Base y arreglos (mucho valor, poco esfuerzo)

1. **Geometría del minimapa leída de `PersistedSettings.json`** (MinimapScale, FlipMiniMap), con la fórmula afín de §4, en lugar del `minimap_scale` manual.
   - Hace falta guardarla por partida, porque el usuario puede cambiarla.
   - Se valida con la prueba que ya existe de la franja de clics (365 dentro, 0 en el borde), repetida a varias escalas.
   - No necesita LCU.
2. **Conexión al LCU** (lockfile del cliente). Da:
   - La fase de gameflow: champ select, partida, fin y *dodge*.
   - El `queueId`.
   - El `gameId` exacto al terminar, que sustituye al emparejado por duración ±180 s de `riot_api.rs`.
   - **Por verificar:** `/lol-match-history/v1/games/{gameId}` y `/game-timelines/{gameId}` podrían dar partida y timeline **sin clave de Riot**, lo que quitaría la barrera del onboarding.
   - Certificado: aceptar solo `127.0.0.1` y no loguear el token. Para :2999, sustituir `danger_accept_invalid_certs(true)` (`riot_live_api.rs:94`) por el certificado raíz que publica Riot (**por verificar**).

### B. Post-partida (el núcleo del producto)

3. **Muertes con precio.** Etiquetar cada muerte con su coste (oro neto en ±N s con objetivos valorados, o directamente ΔWP con `winprob.rs`) y con su tipo: al jungla, *dive* antes del 14, fuera de tu carril, poco daño devuelto. `DeathsSection` ya tiene una fila por muerte. Ojo con las trampas de `victimDamageReceived`.
4. **Sesión de coaching.** Áreas de mejora = las estadísticas con más pérdida de WP, por tramo (0-7 / 7-14 / 14-21 / 21-28 / 28+).
   - Se fija el foco durante 10 partidas.
   - Cada estadística lleva su media móvil con la marca «empezaste aquí» y la lista de partidas, cada una con enlace al momento del vídeo.
   - Generaliza el foco semanal actual.
5. **Curva por minuto con modos** (vs rival / vs media rival / equipo vs equipo / los 10), con series de oro, XP y daño hecho y recibido (`participantFrames.damageStats`), la franja de objetivos y el hover sincronizado con el vídeo.
6. **Por delante, igualada o por detrás:** clasificar cada partida por la diferencia de oro al minuto 14 y partir Patrones con eso («¿tiras ventajas o remontas?»).
7. **Calibrar nuestro propio score:** winrate por tramo de WPA/MVP. Valida el score que está en curso.
8. **Flujo automático al terminar:** toast de progreso, parpadeo de la barra de tareas (`request_user_attention` de Tauri) y abrir la partida, salvo si el usuario está en otra pantalla.
9. **Títulos para los 10 jugadores.** Es barato y da gracia al marcador.

### C. En partida: DESCARTADO

El usuario no quiere overlays en partida (2026-10-19). Lo que tenga valor de §3 se traduce a post-partida, por ejemplo «¿estabas en el objetivo?» en la revisión.

**Diseño detallado de B, del coach de macro y de D:** `docs/coach-de-macro-diseno.md`.

### D. Selección de campeón (después del LCU)

11. **«Tus rivales» en champ select:** cuando aparece tu rival de línea, mostrar tu historial contra él con los datos que ya tiene la tarjeta de Patrones. Las reglas Safe/Sustain/Poke/Bully de §2 se pueden alimentar con nuestras diferencias de daño y kills por nivel.
12. **Pool y ban pool con auto-hover y auto-ban, e importar runas, objetos y hechizos.** La fontanería es fácil, pero hoy no tenemos fuente de builds, salvo derivarlas de las partidas propias.
13. **No:** modelo de draft, quiz de personalidad, «flame me» con IA, depender de Overwolf o GEP, ni fiarse de flags de premium que manda el cliente.

## 7. Cómo repetir el análisis

- **Cómo lanzar REA:** con `--source-path` por cada fichero propio. Sin eso parsea los 17.506 ficheros de `node_modules`, tarda más de 30 min y la evidencia completa pesa 473 MB.

  ```
  rea analyze-javascript-application <app.asar> --source-path dist-electron/main.js --source-path dist-electron/preload.mjs --source-path dist/assets/<chunk>.js … --integrity-policy record-and-continue --max-heap-mb 4096 --format json --full-output
  ```
- **Contradicción de integridad:** el `esbuild.exe` desempaquetado no coincide con el hash declarado; por eso hace falta `record-and-continue`.
- **Grafo semántico y trazados** (`trace-javascript-semantics`), dos tandas:
  - **Primera tanda, 174 ficheros:** el grafo se truncó en 100.000 nodos.
  - **Segunda tanda, enfocada.** Límites usados: `--max-semantic-nodes 1000000`, que es el máximo que acepta REA, y `--max-semantic-nodes-per-file 400000`.
    - Los chunks del coach y del post-partida salieron bien: 118.000 nodos.
    - Los del draft (`1k3LloIa`, `a3MS-J-6`, `drafting-*`) superaron el presupuesto de resultado y solo conservan los datos estáticos.
    - `main.js` completo da un grafo vacío, por las librerías empaquetadas. Se recortó a las sentencias propias de iTero: líneas 1-160, 12907-15255, 24700-26417 y 35875 en adelante. Ese recorte, analizado como directorio, da 27.000 nodos sin truncar y conserva 100 de las 102 operaciones IPC.
  - **Cómo se lanza un trazado:** se construye `{"application": <evidencia>, "query": {…}}` volcando los bytes de la evidencia, sin re-serializarla. Cada trazado tarda unos 75 s con la evidencia de 480 MB y unos segundos con la de 47 MB.
- **Qué confirmó REA:**
  - `main.js` reducido :6393 llama a `YG(e,t)` (fin de partida) y a `WG()` (análisis).
  - `WG` → `HG` → `POST lake-match-analysis` solo con identificadores; los detalles en `docs/coach-de-macro-diseno.md` §1.
  - En el renderer, las semillas por propiedad o por literal de plantilla salen ambiguas o vacías. En ese caso, lo exacto se leyó del código en esos anclajes.
- **Lectura del código:** extraer con `npx @electron/asar extract` a una carpeta aislada. `main.js` es legible; los chunks del renderer están minificados.
- **Mapa de chunks:**

  | Qué | Chunk |
  |---|---|
  | Draft | `drafting-*.js`, `1k3LloIa.js` |
  | Overlays (lógica) | `main.js` ~36650–37450 |
  | Geometría del HUD | `D7yQ8ZjR.js` |
  | Coach | `h1_fjSTU.js`, `_89qKOxY.js` |
  | Detalle de partida | `BUEq32Eu.js` |
  | Diccionario de estadísticas | `BMkP8Yye.js` |
  | Textos en inglés | `D7PBoM77.js` |
