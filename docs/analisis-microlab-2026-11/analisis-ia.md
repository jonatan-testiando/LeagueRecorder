# MicroLab 1.5.17: qué «análisis de IA» hace de verdad

Ingeniería inversa estática del `app.asar` extraído (`scratchpad/ml/app`). Nada se ejecutó ni se contactó con servidores de MicroLab. Las rutas `archivo:línea` son relativas a `app/`.

Leyenda: **[O]** observado en el código · **[I]** inferido · **[?]** desconocido (vive en el servidor o no está en el bundle).

---

## 0. Veredicto en una página

1. **[O] En 1.5.17 el asistente con LLM está apagado y medio desmontado.** `js/core/app-features.js:4` fija `aiCoach: false` («The AI coach is held back for 1.5.3»). Con eso:
   - `assistant-client.js:160-164` rechaza toda petición (`FEATURE_DISABLED`).
   - La ventana del asistente apunta a `pages/assistant-overlay.html` (`window-manager.js:82`), **que no está en el bundle**.
   - Ninguna página HTML carga `js/ui/assistant*.js` ni `js/core/coach-review.js` (no aparecen en los `<script>` de `desktop.html` ni de `replay.html`).
   - `css/app-features.css` oculta todo `[data-ai-coach-only]`.
   - `vod-search` (interpret/results/guideStats) ni siquiera se envía (`ipc-handlers.js:1211-1216`; `main/services/vod-search.js` no existe).
   - El atajo Ctrl+Espacio solo se registra si `aiCoach` (`main.js:286`).

   El código cliente del agente sigue ahí completo, así que se puede reconstruir cómo funcionaría.
2. **[O] Proveedor: Anthropic (Claude), detrás de un Worker propio.** El cliente envía `messages` a `https://clips.microlab.gg/api/assistant` y decodifica el SSE nativo de Anthropic. El Worker guarda el modelo, el system prompt, los esquemas de herramientas y la clave (`assistant-client.js:1-7`). **[?] El nombre del modelo no aparece en ningún sitio del cliente.**
3. **[O] Quién paga:** MicroLab paga a Anthropic con su clave; el usuario paga a MicroLab con Pro/Stripe (`subscription.js:1`). Sin Pro o «dev», el Worker devuelve HTTP 402 → `TIER_REQUIRED` (`assistant-client.js:155-157, 207`; texto de la UI en `assistant.js:271`: «The coaching assistant is a Pro feature.»).
4. **[O] El LLM solo redacta y razona.** Todo el análisis numérico (muertes, coste en oro, ganks, emboscadas de jungla, sequías de oro, actividad por cada 10 s, impacto 0-100, clips destacados, posiciones) es **heurística determinista** en JS, sin modelos entrenados. Varios módulos lo dicen en su cabecera: «No network, replay launch, video inspection or LLM» (`moment-context.js:2`); «Local, deterministic teaching retrieval. No model calls» (`expert-advice.js:1`).
5. **[O] No hay inferencia de ML local.** No hay ONNX, TF.js, WASM, YOLO ni archivos de modelo en el código propio. El módulo nativo (862 KB) solo graba con WGC/encoders. La única «IA» del cliente es la llamada al LLM remoto.
6. **[O] El «entrenar modelos de IA» del consentimiento corresponde a Cloud Sync.** Al terminar cada partida (si hay sesión iniciada) se sube un JSON gzip a un API Gateway de AWS. Lleva trayectoria del ratón, clics, teclas, estadísticas, Riot ID, región y rango. Está **activado por defecto (opt-out)**, y el modal de «consentimiento» es solo un aviso con un botón «Got it». **[?] Qué entrenan con eso.**
7. **Para el dueño:**
   - El 90 % del valor (las «lentes») se puede replicar gratis en local, y Wardline ya tiene equivalentes de varias.
   - Lo único que cuesta dinero es el LLM. En estimación, son céntimos por pregunta con un modelo medio y décimas de céntimo con Haiku.
   - Entrenar un modelo propio no hace falta para lo que hace MicroLab.

---

## 1. Método y evidencias REA

- REA 6.10.1, `analyze-javascript-application` con 27 `--source-path` (los archivos del encargo), `--detail summary`, Evidence completa en `scratchpad/ml/rea-ia/ia-evidence.json` (137 MB).
  - Evidence padre (análisis completo): **`ev_3c5149076e0dd97ca7a9bfc16290183254cbcd1c931622b78bd97d6c38235985`**
  - Resumen: `ev_a7bdf4c9cebe6afb27d3fd6db418f40031395fd67e74d37109c0a9ccffd0347c` (27 JS parseados, 0 fallos, 247 hallazgos; cobertura parcial, con 3.010 archivos fuera de la selección).
  - Vista de endpoints de `assistant-client.js` y `account-session.js`: `ev_63937f557e658dc5e501fb2739ba0925ef161ffe8b086453dd890b65f9db8358`
  - Vista de endpoints de los servicios de red: `ev_2f027ef60b9516b59517b8c94715707c4c99482064789afe98696751f89f0d81`
  - Vista de referencias de módulo de `account-session.js`: `ev_d64e02424442178041c740becaf151a24b5e3f7f302f5bf7aa2c1ac56985504e`
- **Límites:**
  - IPC, preload, `riot-match.js`, `game-upload.js`, `data-serializer.js`, `background.js` y `window-manager.js` quedaron fuera de la selección de REA. Los leí directamente; la tabla IPC de REA marca 0 operaciones por eso, no porque no existan.
  - Todo es estático: nada prueba ejecución.
  - Lo del Worker (`server/worker/...`, citado en comentarios) no está en el bundle.

Observaciones REA de endpoints (todas en estado `observed`, AST):

| Archivo:línea | Endpoint | observation_id |
|---|---|---|
| main/services/assistant-client.js:181 | `${WORKER_BASE}/api/assistant` | `jag_observation_9006f64c8bea3dd1ea84576c25505f4a7bdb296ed3436649f25d3e05d27c1b70` |
| main/services/account-session.js:96 | `${WORKER_BASE}${path}` (login, account, sign-out) | `jag_observation_a3be855b9eb6e508e75f7914e6080d04a8d54164c3600d77225ae5a0aded7237` |
| main/services/matchup-intel.js:25 / :93 / :132 | `${WORKER_BASE}${path}`, `/api/matchups/builds`, `/api/matchups/phase` | `jag_observation_3c316247…`, `…044c7f68…`, `…69abd844…` |
| main/services/counters-intel.js:42 / :79 / :104 | `/api/tierlist`, `/api/build`, `/api/counters` | `…aac8ed19…`, `…3533d46c…`, `…0dded357…` |
| main/services/vod-uploader.js:323 / :773 / :787 | `${WORKER_BASE}${path}`, `/api/vods/list`, `/api/vods/${id}` | `…1db88487…`, `…e61b1730…`, `…880375a9…` |
| main/services/subscription.js:158 | `${WORKER_BASE}${path}` (billing) | `…d585295d…` |

`WORKER_BASE = process.env.CLIP_API_URL || 'https://clips.microlab.gg'` (`account-session.js:6`).

---

## 2. Asistente («MicroLab Assistant» / «MicroLab Coach»)

### 2.1 Flujo

```
Renderer (assistant.js, bucle de agente)          Main (Electron)                 Worker clips.microlab.gg        Anthropic
 ─ arma messages[] ─► IPC 'assistant:ask' ─► assistant-client.ask() ─► POST /api/assistant ─► (añade system+tools+modelo) ─► Messages API (stream)
 ◄─ 'assistant:delta|toolCall|thinking|done|error' ◄─ decodifica SSE Anthropic ◄──────── reenvía SSE tal cual ◄──────────────┘
 ─ si stop_reason=tool_use: ejecuta la herramienta EN LOCAL (assistant-tools.js) → añade tool_result → nueva ronda (máx. 6)
```

- **[O] El bucle de agente vive en el cliente.** El modelo pide `tool_use`; el renderer ejecuta la herramienta localmente (lee IndexedDB y llama al main por IPC); reenvía `tool_result`; repite (`assistant.js:736-855`).
- **[O]** El Worker es un proxy con estado mínimo: no ejecuta las herramientas de las partidas propias. Sí sirve datos de partidas pro (`/api/matchups/*`), que nunca llegan a la máquina.

### 2.2 Protocolo

- **Petición [O]** `POST ${WORKER_BASE}/api/assistant`, `Authorization: Bearer <token de sesión>`, JSON (`assistant-client.js:181-191`):

  ```json
  { "messages": [ ...formato Messages API de Anthropic... ],
    "coachingMemory": true,   // solo si existe AssistantMemory
    "momentContext": true,    // solo si existe la herramienta get_moment_context
    "reviewSession": true }   // solo en modo revisión de momento
  ```

  **[I]** Los tres flags le dicen al Worker qué esquemas de herramientas o qué contrato añadir; el cliente nunca manda `system`, `tools` ni `model`.
- **Respuesta [O]**: SSE nativo de Anthropic reenviado. Se decodifican `message_start` (telemetría de caché), `content_block_start/delta/stop` (`text_delta`, `input_json_delta`, `thinking_delta`, `signature_delta`, `redacted_thinking`), `message_delta` (stop_reason), `message_stop` y `error` (`assistant-client.js:48-145`).
- **Pensamiento extendido [O]**: los bloques `thinking` firmados y `redacted_thinking` se guardan y se reenvían tal cual en la siguiente ronda (`assistant.js:745-767, 810-812`). El comentario de `assistant-client.js:116` menciona `display:"omitted"`.
- **Caché de prompts [O]**: el Worker pone un breakpoint en el bloque system, lo que cachea también los esquemas de herramientas (~3,5k tokens). El cliente registra `cacheRead` y `cacheWrite` (`assistant-client.js:67-79`).
- **Autenticación [O]**: login con Google o Discord vía PKCE contra el Worker; el token se guarda con `safeStorage` (`account-session.js:133-193`). Cada trozo del stream revalida que la cuenta no cambió (`assistant-client.js:245`).

### 2.3 Límites y tiempos [O]

| Límite | Valor | Dónde |
|---|---|---|
| Inactividad del stream (también antes de cabeceras) | 45 s → `ASSISTANT_TIMEOUT` | assistant-client.js:19, 171-178 |
| Stream cortado sin `message_stop` | `ASSISTANT_TRUNCATED` | assistant-client.js:257-263 |
| Rondas de herramientas por pregunta | 6 (luego «Reached the lookup limit») | assistant.js:55-56, 820-827 |
| Pregunta | 2.000 caracteres (igual que el Worker) | assistant.js:54, 107 |
| Historial reenviado | 20 preguntas / 50.000 caracteres / 40 mensajes (el Worker topa en 60 msg / 120k / 16k por bloque) | assistant.js:46-52, 481-498 |
| tool_result guardado en historial | 8.000 caracteres (moment-evidence completo ≤14.500) | assistant.js:53, 502-526 |
| Lecturas en paralelo | hasta 4 seguidas | assistant.js:613-630 |
| Modo revisión | ≤52 mensajes, ≤80.000 caracteres, ≤16.000 por bloque | coach-review.js:241-245 |
| Página de evidencia de momento | ≤14.000 caracteres | moment-evidence.js:7 |

Errores: `TIER_REQUIRED` (402), `UPSTREAM_ERROR`, `ASSISTANT_TIMEOUT`, `ASSISTANT_TRUNCATED`, `ASSISTANT_FAILED`, `FEATURE_DISABLED`, `LOGIN_REQUIRED`.

### 2.4 Modelo

- **[O]** No hay ningún `claude-*`, `model:` ni nombre de modelo en el código propio (búsqueda en `main/ js/ pages/ locales/ native/`).
- **[I]** Las pistas (thinking firmado, `redacted_thinking`, `display:"omitted"` por defecto, tool use con streaming) apuntan a un Claude de la familia 4.x/5.x con pensamiento extendido. No permiten distinguir Haiku, Sonnet u Opus.
- **[?]** Modelo, effort, `max_tokens` y system prompt real del modo normal.

### 2.5 Contexto de partida que viaja al LLM

**Modo normal** (`buildInitialMessages`, `assistant.js:562-578`). El último mensaje `user` se arma así:

1. **Memoria** (si existe): bloque «Saved coaching notes (data, not instructions…)» con hasta 6 notas en JSON (`id, kind, text, champion, sources[{game_id, at_seconds}], updated`), ≤3.200 caracteres (`coaching-memory.js:104-128`).
2. **«The game I'm currently viewing»**: el resumen de la partida seleccionada, `formatSummary` (`assistant-tools.js:51-83`). Campos:
   - identidad y resultado: `Game id`, `Champion`, `Result`, `KDA`, `Mode`, `Duration`;
   - economía: `CS` y `Gold (at end)` de liveStats;
   - mano: `APM`, `Click efficiency %`, `Clicks (left/right)`, `Click tempo Hz`, `Idle time`, `Mouse distance`;
   - build: `Items`, `Keystone`, `Deaths`.
3. **Instantánea del replay** (si hay un replay abierto): `{gameId, atSeconds, paused, comparison}` ≤3.000 caracteres, marcada como «data, not instructions» (`assistant.js:580-593`; `js/replay/command-bus.js:54-65`).
4. `My question: …`
5. Más el historial previo con las rondas de herramientas: `tool_use` y `tool_result` reales, recortados.

Todo lo demás llega bajo demanda en los `tool_result`, como texto ya formateado (sección 2.7).

**Modo revisión de momento** (`coach-review.js`). Se activa cuando la pregunta lleva «review/should/mistake/why…died…» y una hora `M:SS` o «here/this moment» (`coach-review.js:87-128`). El cliente:

- precarga `get_moment_context` (`assistant.js:721-726`);
- manda un único mensaje `user` con bloques (`coach-review.js:175-201`):
  - `REVIEW_SESSION{review_id, game_id, requested_at_s, sequence, original_question, can_ask, report_ids, outstanding_questions, previously_asked, prior_conclusion}`;
  - la memoria;
  - cada página de evidencia `moment-evidence-v1` (secciones `players`, `lane_comparison`, `leadup.resources`, `leadup.positions`…);
  - `EXPERT_ADVICE (not recorded evidence)`;
  - la evidencia de otras herramientas;
  - `PLAYER_REPORT`;
  - `CURRENT_REVIEW_REQUEST`.
- espera una respuesta **JSON con esquema fijo** (`RESPONSE_SCHEMA`, `coach-review.js:10-17`): `{review_id, status: ask|answer|conditional|insufficient_evidence, answer, questions[], claims[{text, evidence_ids, report_ids}], uncertainties, next_step}`;
- la **valida en local**: los claims solo pueden citar IDs de evidencia o reportes existentes, `answer` ≤1.600 caracteres, ≤2 preguntas. Si falla, pide una corrección una vez (`coach-review.js:202-227`; `assistant.js:780-800`).

`coach-review.js` exporta un `SYSTEM` y un `PROMPT` que **no usa ningún archivo del cliente**. **[I]** Es el contrato compartido con el Worker («Shared browser/Node review state and response contract», línea 1), que lo añadirá cuando llega `reviewSession:true`. Extractos:

- SYSTEM (l. 18): «You are MicroLab's League of Legends replay coach. Help the player make a better decision, not construct a confident story from sparse stats.»
- SYSTEM (l. 25-26): `compute_exact_positions` exige que el jugador acepte antes, porque lanza el cliente del juego; y no se guarda memoria salvo que el jugador lo pida.
- PROMPT (l. 29): «Review the choice, not just the situation.» Respuesta visible de 40-90 palabras, ≤3 claims, ~120 palabras en total (l. 58-64). Incluye ejemplos de calibración inventados (l. 46-51).

`coaching-guides.js:13-19` añade a cada evidencia de momento instrucciones de método para el modelo (`provenance`, `branches`, `next`, `verdict`, `answer`). Ejemplo: «Unknown is not no.»

### 2.6 Memoria persistente [O]

- **Local**, en electron-store `coaching-memory.json`; nada se guarda en la nube (`coaching-memory.js:10-16`).
- 40 notas como máximo, de ≤400 caracteres cada una. Tipos: `preference`, `goal`, `review`, `pattern`. `review` necesita una partida de referencia; `pattern`, al menos 2 partidas distintas. Las de tipo review/pattern caducan del contexto a los 90 días (`:4-8, 52-53, 110`).
- **Selección por puntuación** (`:115`): `solapamiento_de_términos×3 + misma_partida×12 + (goal 6 | preference 4)`, con hasta 6 notas.
- El modelo solo puede hacer 1 escritura por pregunta (`assistant-memory.js:32-34`), con control de generación contra ediciones simultáneas.
- La UI deja editar, archivar y borrar (`assistant-memory.js:51-152`).

### 2.7 Herramientas del agente (todas en el cliente)

Notas generales:

- **[O]** Los esquemas los define el Worker; aquí están las implementaciones. Los parámetros son los que lee cada implementación. **[?]** Qué subconjunto expone de verdad el Worker.
- Registro: `assistant-tools.js:900` (22 herramientas) más `coaching_memory` (`assistant-memory.js:153`).
- «Riot» = match-v5 + timeline **a través del Worker** (`/api/riot/resolve-match`, `/api/riot/match`, `/api/riot/timeline`, `riot-match.js:63-87`), con la clave de Riot de MicroLab y caché en R2 (`riot-match.js:1-3`).

| # | Herramienta | Parámetros | Devuelve | Origen de datos | Tipo | Archivo:línea |
|---|---|---|---|---|---|---|
| 1 | `list_recent_games` | `offset`≥0, `limit` 1-30, `champion`? | Líneas «campeón · resultado · KDA · modo · duración · fecha (id)» más el total y la paginación | IndexedDB local (`GameDB.getAllGamesMetadata`) | lectura | assistant-tools.js:174-219 |
| 2 | `get_game_summary` | `game_id` | El resumen de la §2.5 (KDA, CS, oro, APM, eficiencia, tempo, inactividad, ítems, keystone) | GameDB + `DataSerializer` local | lectura | :221-227, :51-83 |
| 3 | `get_deaths` | `game_id` | Por muerte: tipo (lane/gank/collapse/teamfight/skirmish/nonchampion), atacantes con % de daño, jungla cerca, HP, wards, objetivo cercano, oro sin gastar, gap de oro, nivel/ulti y **coste en oro** | Riot + liveStats locales (HP exacto) + pista exacta si existe; sin Riot: muertes por HP=0 en liveStats | lectura | :229-259; riot-coach.js:111-128 |
| 4 | `get_timeline` | `game_id` | CS / oro / nivel por minuto, más ventaja de oro sobre el rival de línea | Riot; sin Riot: liveStats | lectura | :261-287; riot-coach.js:33-59 |
| 5 | `get_death_leadup` | `game_id`, `at_seconds` | Cronología de hasta 3 min antes de la muerte (compras, kills cerca, acercamiento del jungla, HP%) | Riot + liveStats + pista exacta | lectura | :289-302; death-leadup.js |
| 6 | `get_moment_context` | `game_id`, `at_seconds` 0-21600, `lookback_seconds` 30-600 (120), `after_seconds` 0-60 (30), `focus` general/gank/trade/recall/objective, `section`, `offset`, `revision` | JSON `moment-evidence-v1` paginado (≤14k caracteres): recursos en tramos de 10 s con «lente de actividad», posiciones, comparación de línea, jugadores, consecuencias, cobertura y omisiones, más la guía de investigación (tarjetas de la base de conocimiento) y, aparte, el consejo experto | liveStats, playerSnapshots y teclas (solo código + reloj) **locales** + Riot + nombres de ítems + pista exacta | lectura | :304-334; riot-coach.js:146-176; moment-context.js; moment-evidence.js |
| 7 | `get_droughts` | `game_id` | ≤4 periodos de «sequía» de ingresos estando vivo | liveStats locales (sin Riot) | lectura | :337-348; js/utils/droughts.js |
| 8 | `get_stats` | `game_id` | Agregados de `challenges` (visión, wards, benchmarks de línea, combate) | Riot (sin timeline) | lectura | :486-497; match-stats.js |
| 9 | `get_backs` | `game_id` | Número y horas de vueltas a base (derivadas de compras; «es un mínimo») | Riot timeline | lectura | :735-757; js/utils/backs.js |
| 10 | `find_moments` | `game_id`, `kind` kills/wards/objectives/plates/levels, `who` | Lista y recuento (≤15 líneas) | Riot timeline | lectura | :540-554; moments.js |
| 11 | `play_moment` | `game_id`, `kind`, `who`, `which` | Localiza un evento y **abre el replay** en él | Riot + bus de comandos `replay.open` | acción | :561-603 |
| 12 | `open_expanded` | `game_id`, `from_seconds`?, `to_seconds`? | Abre la vista ampliada (clics y cursor) | localStorage + ventana | acción | :510-535 |
| 13 | `open_replay` | `game_id`, `at_seconds`? | Abre el replay | bus `replay.open` | acción | :835-846 |
| 14 | `jump_to` | `at_seconds` | Salta en el replay abierto | bus `replay.jumpTo` | acción | :848-853 |
| 15 | `set_replay_view` | `show[]`, `hide[]` (capas clicks/path/cursor/heatmap/positions/pans/distances/efficiency/ideal_line/abilities), `trail` 100-3000, `opacity`, `volume`, `mute`, `pause_on_ability` | Cambia capas y ajustes | bus `replay.setView` | acción | :855-868; command-bus.js:15-16 |
| 16 | `select_game` | `game_id` | Selecciona la partida en la biblioteca y reubica el foco | bus `desktop.selectGame` | acción | :870-896 |
| 17 | `open_compare` | `game_id_a`, `game_id_b`, `at_seconds`? (rechaza `pro_game_id`) | Compara dos grabaciones propias | bus `compare.open` | acción | :624-644 |
| 18 | `find_pro_moments` | `game_id` (solo la partida pro elegida en el comparador), `kind` kills/deaths/objectives/plates/levels/backs/all | ≤15 momentos de la partida pro | **Worker** `/api/matchups/moments` | lectura | :652-679 |
| 19 | `describe_phase` | `game_id`, `who` (preset lane/botlane/lane+jungle/team/all o tokens `me, duo, lane_opponent…`), `from_seconds`, `to_seconds` | Contexto por minuto (posición, avance, trades, muertes) | Propia: Riot + `phase.js` en local. Pro: **Worker** `/api/matchups/phase` | lectura | :776-815; js/utils/phase.js |
| 20 | `track_jungler` | `game_id`, `who` ally/enemy, `to_seconds` (900 por defecto) | Ruta del jungla por minuto, etiquetada por campamento, más sus kills | Riot timeline | lectura | :761-774; jungle-track.js |
| 21 | `get_position` | `game_id`, `at_seconds` | Tu región y la de los otros 9 («posiciones reales, no lo que veías en pantalla»): exacta o estimada con su confianza | Pista guardada en videoMeta; si no hay, estimación HMM en un Web Worker; si existe, la exacta del Replay API | lectura | :424-451 |
| 22 | `compute_exact_positions` | `game_id` | Lanza el replay de LoL minimizado unos 2-4 min y guarda las posiciones exactas de los 10 campeones | Replay API local `https://127.0.0.1:2999` + LCU | **acción pesada (requiere consentimiento en el chat)** | :455-482; replay-oracle.js:1-16 |
| 23 | `coaching_memory` | `action` list/save/delete, `offset`, `kind`, `text`, `champion`, `status`, `sources[≤3]`, `id` | JSON de notas o confirmación | electron-store local | lectura/escritura | assistant-memory.js:25-44; coaching-memory.js |
| — | `find_pro_games` (retirada) | — | Texto fijo; nunca ejecuta | — | — | assistant.js:600 |

Detalles relevantes:

- Las herramientas devuelven **texto en prosa preparado para el LLM**, con advertencias incrustadas. Ejemplos: «do NOT claim there is no data»; «Proximity does NOT establish visibility…» (`death-context.js:337-340`).
- Las teclas que se envían son solo `{key, gameTime}` (`assistant-tools.js:323`).
- **[O] Lo que sale del PC hacia Anthropic:** solo el texto de prompts y herramientas, a través del Worker. Nunca vídeo ni imágenes; no hay bloques `image` en ningún sitio.

---

## 3. Coaching «experto»: reglas a mano, sin modelo

### 3.1 `coaching-knowledge.json`: base de tarjetas de decisión (escrita a mano)

- `version 2026-09-07.1`, `origin "research/coach-decision-kb"`.
- **6 tarjetas:** G1 «Gank exposure and available information», G2 «Dive vulnerability…», T1 «Trade purpose…», W1 «Wave commitment…», R1 «Recall as a complete sequence», O1 «Objective preparation…».
- **11 fuentes:** posts de X de coaches (Kirei, LS/Wickd, Eagz, Peter Dun, Veigar v2…), una guía de Mobafire y una de Reddit.
- Cada tarjeta tiene `source_principle`, 3 `questions` del tipo [pregunta, qué evidencia hace falta], `synthesis`, `alternatives` y `disconfirm`.
- **Selección fija por `focus`** (`coaching-guides.js:4`): `gank→[G1,G2]`, `trade→[T1]`, `recall→[R1,W1]`, `objective→[O1]`, `general→[]`. Se adjunta a cada `get_moment_context` (`moment-context.js:384`).
- El `focus` lo elige el modelo o, en modo revisión, una regex sobre la pregunta (`coach-review.js:246-252`: recall/reset/wave → recall; trade → trade; objective/rotat/dragon/baron → objective; gank/died/death → gank).

### 3.2 `expert-knowledge.json`: consejos de campeón (piloto pequeño, escrito a mano)

- `version 2026-09-08.expert-pilot-1`, `mechanics_checked_patch 16.17`.
- **21 tarjetas para 7 campeones** (Lucian 5, LeBlanc 4, Jhin 3, Caitlyn 3, Draven 2, Varus 2, Orianna 2), casi todas de BOTTOM o MIDDLE.
- 8 fuentes de Mobafire u OneTricks con autor, sección, «expertise» y advertencia.
- Cada tarjeta: `tip`, `when`, `exceptions`, `review_check` (≤400 caracteres), roles, temas, fase, rival opcional y requisitos booleanos.
- **Recuperación determinista** (`expert-advice.js:41-98`), una tarjeta pasa si:
  - el campeón y el rol coinciden;
  - el rival es uno de los de su línea (bot incluye al support);
  - el tema encaja;
  - si su fase es «lane», ocurre ≤15 min (`at≤900`);
  - el parche está en `{16.12, 16.16, 16.17}` (`:55`).
- Se ordenan primero las que tienen rival y luego por id. Las contradictorias viajan juntas, con un máximo de 3 tarjetas y ≤3.400 caracteres (`:4, 78-93`).
- Se entrega como bloque `EXPERT_ADVICE (not recorded evidence)` (`coach-review.js:189-192`) y aparece en la UI con enlaces solo a mobafire/onetricks (`assistant.js:304`).

---

## 4. Lo que se vende como análisis y es determinista

Todo esto es JS puro. Ningún módulo carga un modelo ni llama a un LLM:

| Módulo | Qué calcula | Reglas y constantes clave |
|---|---|---|
| `riot-coach.js` | Orquesta las «lentes» sobre match-v5 y formatea texto | SR = mapId 11 (`:22`); rival de línea = mismo `teamPosition` del otro equipo (`:37-39`) |
| `death-context.js` | Clasifica cada muerte | `SHARE_MIN 0.10`, `LANING_END 840000` (14:00), `NEARBY 2500` u, `OBJECTIVE_WINDOW_MS 150000`, `DRAGON_RESPAWN_MS 300000` (`:16-20`). Atacantes = daño de campeón ≥10 % o el asesino. Tipo (`:121-128`): sin atacantes → `nonchampion`; ≥3 → `teamfight` (≥14:00) o `collapse`; si es tarde → `skirmish`; si todos son rivales de línea → `lane`; si no → `gank`. Ventaja de ulti si el atacante cruza 6/11/16 antes que tú (`:190`). Aviso de oro sin gastar ≥500 (`:287`) |
| `death-leadup.js` | Cronología previa a la muerte | Ventana 120 s (máx. 180 s, `:11, 76`); compras agrupadas a ≤8 s (`:81`); kills a >7.000 u se ignoran (`:107`); jungla «a la vista» ≤1.200 u (`:138-139`); distancias <4.000 «cerca», <9.000 «media» (`:27`); HP% en los 6 s previos (`:150`) |
| `js/utils/death-cost.js` + `death-cost-tables.js` | «Recibo» de coste en oro por muerte | Tiempo de respawn = BRW[nivel]·(1+TIF) (`tables:6, 16-28`). TIF: +0,425 % por medio minuto desde 15:00, +0,3 % desde 30:00, +1,45 % desde 45:00, tope 50 %. Vuelta a línea = primer frame a >4.000 u de la fuente, entre 10-60 s (`death-cost.js:9-12, 230-241`). CS perdido = ritmo de los 3 min previos × minutos fuera − CS real (`:289-296, 363-371`). `AVG_MINION_GOLD 21`, `PLATE_GOLD 125`, placas hasta 14:00. Oscilación total = Δ(oro_rival − oro_tuyo) entre muerte y vuelta. Libro mayor (`:395-406`): kill + farm (ΔCS×21) + kills del rival − tus kills + «otros» |
| `moment-context.js` | Reconstrucción de cualquier momento | Ventana por defecto −120/+30 s (`:11-21`). «Lente de actividad» cada 10 s (`:59-83`) con teclas Q W E R=16-19, D F=32-33, B=48. Reglas: (habilidad o summoner) y pérdida de HP ≥10 % → «possible fighting or trading»; ≥3 habilidades → «repeated ability inputs»; sin teclas y HP ≥15 % → «taking damage»; CS≥2 → «farming»; oro ≤−150 → «spending gold»; B pulsada → «recall key pressed» |
| `moment-evidence.js` | Paginación de evidencia | Secciones fijas, `LIMIT 14000` caracteres, IDs `rev:sección:índice` (`:4-7, 44-75`) |
| `moments.js` | find/play moment | ≤15 líneas, `SR_DIAGONAL 14820`; los wards no tienen posición en match-v5 (`:11-27`) |
| `highlights.js` | Clips automáticos en directo | Eventos del Live Client (`ChampionKill`, `Multikill`, `FirstBlood`) (`:44-60`); −5 s/+5 s; multikill a 10 s (30 s tras una quadra); búfer de 60 s; ≤40 por partida (`:22-30`) |
| `js/utils/droughts.js` | Sequías de oro | Tramos de 30 s; base local ±3 min; <50 % del ritmo y base ≥4 oro/s; ignora los primeros 90 s; ≤4 periodos (`:13-18`) |
| `js/core/review-queue.js` | Cola de «momentos a revisar» | «Priority is a heuristic, never a mistake probability» (`:1`); umbrales de oscilación `max(800, min·55)` (`:112`), caída de farm <50 % (`:143`), etc. |
| `js/core/match-review-core.js` | «Impact» 0-100 | 9 ejes con pesos por rol (`:49-56`, p. ej. JUNGLE obj 0,20; UTILITY util 0,15); mezcla de percentil en la partida y «espejo» contra el rival de posición (`MIRROR_BLEND 0.6`, potencia 2, `:57-58`); «idea PandaSkill / Victory-Contribution» (`:41`) |
| `js/core/position-track.js` (+ worker) | Posición estimada de tu campeón | **HMM en rejilla con forward-backward sobre el navgrid de SR**, guiado por clics de movimiento y anclas de la timeline de Riot (`:1-4`). Probabilístico clásico, sin entrenamiento |
| `replay-oracle.js` | Posiciones exactas | Pone `EnableReplayApi=1` en `game.cfg`, lanza el replay y sondea `POST /replay/render` en `127.0.0.1:2999` (`:1-16`) |
| `phase.js`, `jungle-track.js`, `match-stats.js`, `backs.js`, `sr-map.js` | Fases, ruta del jungla, agregados, vueltas a base, geometría | `DEFAULT_WINDOW 0-840 s`; `NEAR_YOU 3000`; `CAMP_RADIUS 1400`; compras agrupadas a 10 s, etc. |
| `js/utils/ability-detection.js`, `heatmap-core.js`, `data-serializer.js` | Lanzamientos inferidos de teclas, mapas de calor, APM, eficiencia y tempo | Filtros por reglas y kernels gaussianos |

Fuentes de los datos crudos [O]:

- **Live Client Data API local** (`https://127.0.0.1:2999/liveclientdata/*`) cada 2 s: oro, HP, maná, nivel, CS y stats (`live-stats.js:1-9`; `game-events.js:55, 163, 366`).
- Ratón y teclado vía `uiohook-napi`.
- **match-v5 a través del Worker** de MicroLab.

---

## 5. Entrenamiento y ML

### 5.1 Qué se sube «para entrenar modelos» [O]

- **Texto del aviso** (`desktop.html:1354`, `locales/en.json:101`): «MicroLab uploads gameplay data to identify patterns and train AI models that improve tracking accuracy.» y «You can disable this anytime in Settings.»
- **No hay consentimiento real:** el modal solo tiene «Got it» y se marca como visto (`js/desktop/first-run-modals.js:48-102`).
- **El ajuste:** «Cloud Sync — Help improve accuracy by sharing anonymous gameplay data», casilla marcada en el HTML (`desktop.html:1326-1330`) y **activado si no hay valor guardado** («Default to true (opt-out model)», `js/utils/cloud-sync.js:24-28`).
- **Cuándo:** al terminar cada partida «completa» (resultado, KDA, ítems, runas y perfil), con reintento a los 45 s (`pages/background.js:1119-1149`). Solo con sesión iniciada; se ata a `microlabUserId` (`cloud-sync.js:85-92`).
- **Destino:** `POST https://l97v5zm4wi.execute-api.us-east-1.amazonaws.com/dev/upload-game` (AWS API Gateway, stage `dev`, «to S3», `cloud-sync.js:3`), con Bearer de MicroLab, gzip, ≤5 MB (`main/services/game-upload.js:3-16`). Variable de entorno `GAME_UPLOAD_API_URL`.
- **Carga** (`js/utils/data-serializer.js:235-310`):
  - `player`: `ign` (Riot ID), `tagLine`, `region`, `tier`, `division`. Es decir, no es «anónimo» en sentido estricto.
  - `game`: id, campeón, modo, resultado, duración, timestamp.
  - `stats`: APM, distancia, clics L/R/total, teclas, tiempo y % inactivo, eficiencia, tempo, velocidad media y máxima del ratón.
  - `kda` y nivel.
  - `graph`: **trayectoria completa del cursor** `{x,y,t}`, **clics** y **teclas** con tiempos relativos, y resolución.
  - `abilitySnapshots` (`t, Q, W, E, R, h`).
  - Además, `microlabUserId`.
- **[?]** Qué modelos entrenan, si los entrenan, y qué significa «tracking accuracy». **[I]** Lo más probable es la reconstrucción de posición o la detección de lanzamientos a partir del ratón (encaja con `position-track` y `ability-detection`), pero en el cliente no hay ningún modelo entrenado que lo consuma.
- **No es para entrenamiento:** `vod-uploader.js` es la subida de VOD de Pro a R2 (multipart con URLs firmadas, `:1-13`), iniciada por el usuario para compartir o hacer copia; nada en él habla de entrenamiento.

### 5.2 Inferencia local [O, búsqueda acotada]

- **Búsqueda** sin distinguir mayúsculas en `main/ js/ pages/ locales/ native/` (sin node_modules) de: `onnx, tensorflow, tfjs, inference, yolo, .wasm, webassembly, opencv, anthropic, claude-*, openai, gpt-*, gemini, llm, neural, whisper, InferenceSession, torch`.
  - Solo aparecen «Anthropic» (asistente), «LLM» en comentarios (`command-bus.js:177, 270`; `moment-context.js:2`), «inference» con el sentido de «deducir el rol» (`counters-intel.js:16`, `phase.js:368`, `desktop-champselect.js:151`) y el aviso de consentimiento.
- **Archivos:** no hay `.onnx`, `.tflite`, `.pt`, `.wasm`, `.bin`, `.safetensors` ni `.gguf` fuera de node_modules.
- **Dependencias:** `node_modules` no trae runtimes de ML (las de `package.json`: Sentry, electron-store, electron-updater, extract-zip, ffmpeg-static, uiohook-napi).
- **Módulo nativo** `microlab-recorder.win32-x64-msvc.node` (862 KB): exporta solo grabación y ventanas (`configureRecorder, startRecording, stopRecording, enumerateEncoders, getGameWindowRect, getMouseButtonState…`, `native/index.js`). Sus cadenas son de WGC, captura de audio y encoders; nada de ONNX, DirectML ni CUDA.
- **Conclusión:** cero inferencia de modelos en local; lo que más se acerca es el HMM clásico de `position-track.js`.

---

## 6. Coste: qué necesita un servidor de pago y qué puede ser gratis

### 6.1 Qué depende de un servidor

| Pieza | En MicroLab | ¿Hace falta pagar? |
|---|---|---|
| LLM (Claude) del asistente | Worker + clave de Anthropic de MicroLab; el usuario lo paga con Pro | **Sí**, por tokens (o con un LLM local) |
| match-v5 + timeline | Proxy del Worker con su clave de Riot y caché R2 | **No, solo una clave de Riot**. [I] Riot da claves de desarrollo y personales gratis (conocimiento general, no verificado aquí); Wardline ya tiene región/clave/proxy |
| Índice de partidas pro y streamers, counters, tier list, builds | Cron y caché del Worker (`matchup-intel.js:1-3`, `counters-intel.js`) | Infraestructura propia o terceros; **no es IA** |
| Todas las lentes de la §4, la base de conocimiento, la memoria, la validación de respuestas | Cliente | **Gratis en local** |
| Cloud Sync | AWS de MicroLab | Irrelevante para uso personal |

### 6.2 Cuánto costaría el LLM: estimación [I]

**Supuestos:**

- Prefijo de tools + system de ~3,5k tokens, en caché (dato del propio código, `assistant-client.js:69-70`).
- Mensajes de ~2k tokens iniciales más ~1,5k por resultado de herramienta. El historial no queda en caché: solo hay breakpoint en el system, así que se reenvía entero en cada ronda.
- 4 rondas por pregunta, ~1,3k tokens de salida por ronda (texto + pensamiento).
- En total: ≈17k tokens de entrada sin caché, ≈14k de lectura de caché y ≈5k de salida por pregunta.

Precios de lista de Anthropic, tabla cacheada el 2026-11-03 en la skill `claude-api` (USD por millón de tokens):

| Modelo | Entrada / salida | Lectura de caché | ≈ coste por pregunta (normal) | ≈ coste por revisión (~60k entrada) |
|---|---|---|---|---|
| Claude Haiku 5.5 | 0,10 / 0,50 (≤100k) | — | **≈ 0,004 $** | ≈ 0,01 $ |
| Claude Sonnet 5.5 | 2 / 10 | 0,10 | **≈ 0,09 $** | ≈ 0,15-0,20 $ |
| Claude Opus 5.5 | 4 / 20 | 0,20 | **≈ 0,17 $** | ≈ 0,30-0,40 $ |

La escritura de caché cuesta ~1,25× la entrada, una vez cada 5 min: unos céntimos. Con unas 20 preguntas al mes, el gasto es de céntimos (Haiku) a unos 2-4 $ (Sonnet u Opus). Son órdenes de magnitud, no mediciones: **[?]** el modelo y el effort reales de MicroLab.

### 6.3 Opciones para el dueño (uso personal) [I]

1. **Gratis, sin LLM.** Portar o comparar las lentes deterministas: coste de muerte, clasificación gank/lane/collapse, leadup, sequías, actividad cada 10 s, Impact. Son reglas con constantes explícitas (§4). Wardline ya tiene análogos («Muertes con precio», `gank.rs`, `coach.rs`, panel de Impacto), así que lo valioso es comparar umbrales, no copiar.
2. **Gratis con tu suscripción a Claude.** Generar en Wardline el mismo texto de evidencia que producen las lentes (formato `moment-evidence-v1` y prosa con advertencias) y pegarlo en Claude o Claude Code. Se pierde el bucle automático de herramientas, pero no hay coste por token.
3. **Créditos de API (lo más fiel a MicroLab).**
   - Bucle de agente en Wardline con el SDK oficial de Anthropic, las herramientas definidas localmente y el system prompt en local; no hace falta Worker porque es un solo usuario y la clave queda en la máquina.
   - Coste de §6.2: Haiku 5.5 sobra para redactar a partir de texto ya digerido; Sonnet u Opus solo para revisiones finas.
   - Ideas que vale la pena copiar: respuesta JSON con claims que deben citar IDs de evidencia, validada en local y con un reintento (§2.5); memoria local con puntuación simple; tope de rondas y de caracteres.
4. **LLM local** (GPU propia; RTX 5070 Ti en esta máquina). Viable para resumir texto ya estructurado. La calidad del razonamiento y del uso de herramientas es menor; **[?]** no medido.
5. **Entrenar algo propio: no hace falta para replicar MicroLab.** Su «IA» no es un modelo entrenado: son reglas más un LLM generalista. El único «entrenamiento» que menciona es en su servidor, con la telemetría de ratón de todos los usuarios, para «tracking», y no existe ningún modelo en el cliente. Con datos de un solo jugador no hay volumen para entrenar algo mejor que las reglas.

---

## 7. Lista de comprobación del encargo

| Pregunta | Estado |
|---|---|
| URL, protocolo, campos enviados, memoria, límites, gating | Respondida [O] |
| Nombre del modelo | Sin resolver: oculto en el Worker [?] |
| Todas las herramientas | Respondida: 23 + 1 retirada [O]; qué esquemas publica el Worker [?] |
| ¿Reglas a mano?, estructura, selección | Respondida [O] |
| Lentes deterministas con fórmulas | Respondida [O] |
| Datos de «entrenamiento»: qué, dónde, consentimiento | Respondida [O]; uso real en el servidor [?] |
| Inferencia local | Respondida: no existe (búsqueda acotada al código propio y al .node) |
| Coste y alternativas | Estimada [I] |
