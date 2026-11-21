# MicroLab 1.5.17: clears de jungla de punta a punta

Análisis estático del `app.asar` extraído (no se ejecutó nada de la app). Rutas relativas a
`…\scratchpad\ml\app`. Etiquetas: **[O]** observado en el código, **[I]** inferido, **[?]** desconocido.

## 0. Veredicto corto

- La función es **un catálogo de vídeos de YouTube**: «el clear completo más rápido conocido para tu campeón». La app lo enseña en tres sitios (champ select, cabecera de una partida de jungla y la pestaña «Jungle clears»). **[O]**
- **MicroLab NO mide tu propio clear.** No hay código que calcule el tiempo, el orden de campamentos ni los smites de la partida del usuario, y por tanto **no hay comparación usuario contra catálogo** (ni métricas ni diferencias por campamento ni ruta en un mapa). **[O]** (búsqueda acotada, apartado 2.4)
- El catálogo viene **empaquetado** y además se **descarga de `https://cdn.microlab.gg/catalog/jungle-clears.v2.json`** como mucho una vez al día. Lo único que sale a la red es esa descarga y el reproductor de YouTube. **[O]**
- Cero IA y cero módulo nativo en la función de clears. Lo «de jungla» que sí toca IA es otra cosa: la herramienta `track_jungler` del coach (LLM servido por el Worker de MicroLab), que describe minuto a minuto la posición de un jungla con el timeline de Riot. **[O]**

Evidencia REA (CLI 6.10.1, `analyze-javascript-application --detail summary`, fuentes seleccionadas):

| Evidence ID | Qué es |
|---|---|
| `ev_a3dd730601a8f95e4abe408a43a2ae44f050505c02abb377f7607bb540514e4f` | Análisis completo (padre), 18 fuentes: catálogo, core, UI, youtube-pane, jungle-track, sr-map, navgrid, anchors, exact-positions, position-lookup, game-events, live-stats, ipc-handlers, preload, riot-coach, study-core, game-details, local-data-reset. Bundle: `…\ml\evidence\jungle-rea.json` |
| `ev_0eaf68f287bd3123004c1acf1c2de8b4255ba8a0459aa4135ad74c2cc2ac7eaf` | Resumen del anterior (18/18 parseados, 0 fallos; cobertura semántica parcial) |
| `ev_465b02d380c4eeaa74c2e9cb7d9dac7a5d23372c578460b2cbfee5f43ca52809` | Hechos de `main/services/jungle-clear-catalog.js`: `require('../../assets/data/jungle-clears.json')`, `require('electron-store')`, `require('../../js/core/jungle-clear-core')`, candidato de endpoint/almacén `catalog` en la línea 12 |
| `ev_59f1c2e02817fef220ba41e365b56babea90aada7d37c2358aa5b42434bd0ffb` | Hechos de la UI: `localStorage.getItem('lol_ddragon_version')` en `js/desktop/jungle-clears.js:148`; `fetch('../assets/data/jungle-clears.json')` en `:154` |
| `ev_577eb12b6351df72b2d3c6dded337b467a33dbc9f026109256f7d5c3c8df7e04` | Segundo análisis (padre): twitch-embed-server, compare-webview-preload, study.js, desktop-champselect, replay-oracle, riot-match. Bundle: `…\ml\evidence\jungle-rea-2.json` |
| `ev_3edd584ade9d60b538e44188019b0c193ff32e9729f9b0279da6e0b4b7514167` | Hechos IPC: canal `twitch-bridge` con `sendToHost` (`main/compare-webview-preload.js:14`) y `ipcRenderer.on` (`:19`) |
| `ev_7ac546f9…5f58a`, `ev_40778303…5c82e` | Trazas con semilla de cadena `cdn.microlab.gg…`: **0 coincidencias**. REA no indexa la URL como nodo porque está en una constante (`URL`) y se usa a través de `fetcher`. La URL está confirmada por lectura directa (`jungle-clear-catalog.js:4`) |

Límites de REA que conviene tener en cuenta: el resumen da 0 operaciones IPC para la primera selección (el
emparejamiento IPC de Electron no se aplicó a fuentes sueltas), así que los pares de IPC
(`jungle-clears:catalog`, `compare:embedPort`) se citan por archivo:línea leídos a mano. REA solo hizo
análisis estático: nada de lo que sigue se observó en ejecución.

---

## 1. Catálogo

### 1.1 Esquema (`assets/data/jungle-clears.json`) [O]

```jsonc
{
  "schemaVersion": 2,
  "updatedAt": "2026-11-08",          // ISO; decide qué copia gana
  "sourceUrl": "https://docs.google.com/spreadsheets/d/1jE8bnlnIJnmWv9pnVW9veMKRXJNaaJf5tneQB3xUkbI/edit?gid=1938238048",
  "entries": [{
    "champion": "Aatrox",              // nombre visible (con espacios/apóstrofos)
    "patch": "26.02",                  // texto; admite sufijos "26.01PBE", "26.06b"
    "clearSeconds": 159,               // > 0
    "camps": 6,                        // obligatorio exactamente 6
    "smites": 1,                       // 1 o 2
    "route": ["Raptors","Krugs","Red","Wolves","Gromp","Blue"],  // 6 campamentos + ≤1 "Recall" intermedio
    "videoId": "Iyno0bhlYzo",          // 11 caracteres [A-Za-z0-9_-]
    "startSeconds": 0,                 // 0..86400
    "creator": "MikeBEASTon",
    "notes": "QEQ, AD/AD/HPS",
    "evidence": "creator-reported"     // o "record-verified"
  }]
}
```

`sourceUrl` **no lo lee ningún código** (grep sin resultados fuera del JSON). Es procedencia
editorial: el catálogo se cura a mano desde una hoja de Google comunitaria y no se descarga de ella. **[O/I]**

### 1.2 Validación (`js/core/jungle-clear-core.js`) [O]

- `CAMPS = ['Blue','Gromp','Wolves','Raptors','Red','Krugs']` (`:4`). Scuttle, Herald y Grubs **no** cuentan.
- `valid(entry)` (`:19-33`): campeón no vacío; `patchKey` no nulo; `videoId` `^[A-Za-z0-9_-]{11}$`; `camps === 6`; `smites ∈ {1,2}`; `clearSeconds` finito > 0; `startSeconds` en [0, 86400]; la ruta tiene exactamente 6 campamentos distintos de `CAMPS` más como mucho un `Recall` que no puede ir ni el primero ni el último; `creator` es texto; `evidence ∈ {creator-reported, record-verified}`.
- `validCatalog(data)` (`:38-44`): `schemaVersion === 2`, `updatedAt` parseable, 1 ≤ entradas ≤ 1000, **todas** válidas y `entryKey = videoId@startSeconds` único (`:35-37`). Es todo o nada: basta una entrada mala para rechazar el catálogo entero.

Normalización:

```js
championKey(n) = n.toLowerCase().replace(/[^a-z]/g,'')  →  alias {monkeyking:'wukong', nunu:'nunuwillump'}   // :3, :5-8
patchKey(p): /^(\d+)\.(\d+)/ ; major∈[15,25) ? major+10 : major ; → major*100 + minor               // :10-15
// "Riot reports 16.17.x; the public season uses 26.17."  → "16.17.1" y "26.17" dan 2617
```

### 1.3 Carga y actualización: proceso main (`main/services/jungle-clear-catalog.js`) [O]

| Constante | Valor | Línea |
|---|---|---|
| `URL` | `https://cdn.microlab.gg/catalog/jungle-clears.v2.json` | `:4` |
| `REFRESH_MS` | 24 h (tras un éxito) | `:5` |
| `RETRY_MS` | 5 min (tras un fallo) | `:6` |
| `MAX_BYTES` | 512 KiB (cabecera `content-length` y conteo en streaming) | `:7`, `:20`, `:29` |
| timeout | `AbortSignal.timeout(5000)`, `credentials:'omit'` | `:18` |
| caché en disco | `electron-store` con `name: 'jungle-clear-catalog'` y clave `'catalog'` → `jungle-clear-catalog.json` en userData | `:61-62`, `:12`, `:38` |

Flujo:

1. Arranque (`:10-14`): `current = bundled`; si la caché de disco es `validCatalog` **y** su `updatedAt >= bundled.updatedAt`, se usa la caché.
2. `get()` (`:47-52`): deduplica la petición en curso (`pending`); si `now < nextCheck`, devuelve `current` sin red.
3. `refresh()` (`:16-45`): GET → `!ok` lanza error → límite de tamaño → `JSON.parse` → `validCatalog` → **solo sustituye si `updatedAt` es mayor o igual que el actual** («Prevent an old CDN response replacing a newer release/cache», `:35-36`) → guarda en disco. Un éxito programa la siguiente comprobación a +24 h y un fallo a +5 min. **Siempre devuelve un catálogo** (el empaquetado como mínimo).
4. IPC: `ipcMain.handle('jungle-clears:catalog', …get())` (`main/ipc-handlers.js:1283`) ↔ `getJungleClearCatalog: () => ipcRenderer.invoke('jungle-clears:catalog')` (`main/preload.js:457`).
5. «Borrar datos locales» incluye `jungle-clear-catalog.json` (`main/services/local-data-reset.js:8`).

En el renderer (`js/desktop/jungle-clears.js:152-168`) [O]:
- `loadCatalog()` pide por IPC y, si falla, recurre a `fetch('../assets/data/jungle-clears.json')` (`:154`, `:158-159`; REA `ev_59f1c2e0…`). Vuelve a pasar `validCatalog`.
- Si llega un catálogo nuevo **durante un draft**, se guarda en `deferredCatalog` y se aplica en `reset()` (`:163`, `:171`) para que el vídeo abierto no cambie.
- Sondeo: `setInterval(() => { if (!context) loadCatalog(); }, 5*60*1000)` (`:198`). El main limita las descargas reales a una por día o a un reintento cada 5 min.
- `getCatalog()` (`:205-209`) comparte la misma copia con la pestaña Study.

### 1.4 Filtrado y elección del «mejor» [O]

No hay filtros por campamentos ni por smites: `camps` siempre vale 6 y `smites` solo se muestra
como texto. Los únicos criterios son **campeón** y **parche ≤ parche actual**:

```js
// jungle-clear-core.js:56-64
variants(catalog, champion, patch) =
  entries.filter(e => valid(e) && championKey(e.champion) === championKey(champion)
                      && (patchKey(patch) === null || patchKey(e.patch) <= patchKey(patch)))
         .sort((a,b) => a.clearSeconds - b.clearSeconds || patchKey(b.patch) - patchKey(a.patch));
select(...) = variants(...)[0] || null     // el más rápido; si empatan, el de parche más nuevo
```

- Se excluyen las grabaciones **posteriores** al parche actual (`study.js:60`: «Paths recorded after the live patch stay out»).
- Las entradas antiguas no pierden prioridad: un clear del 26.02 gana a uno del 26.16 si es más rápido. La UI solo añade «(older patch)» (`jungle-clears.js:58-61`).
- Si no se conoce el parche (`''`), `patchKey` devuelve `null` y no se filtra.

De dónde sale el «parche actual» en cada sitio:
- Champ select: `tier?.patch` (respuesta de la tier list estilo OP.GG) o `localStorage.lol_ddragon_version` (`js/desktop/desktop-champselect.js:1181`).
- Cabecera de partida y Study: `localStorage.lol_ddragon_version`, la última versión de Data Dragon, que escribe `pages/background.js:1555` (`jungle-clears.js:148`, `study.js:60`). Ojo: en la cabecera se usa el parche **en vivo**, no el `gameVersion` de la partida, aunque el tooltip diga «for its patch» (`:133`). **[O]**

Pestaña Study (`js/core/study-core.js:24-54`) [O]: agrupa por `championKey`, una fila por campeón con
`{best = paths[0], paths, newest}`; búsqueda por subcadena de la clave; orden `fastest`
(`best.clearSeconds`, desempate A-Z), `az` o `newest` (patchKey máximo y luego tiempo); filtro
«Played» = campeones presentes en el historial local. Al abrirse, `defaultEntry` elige el clear más
rápido entre los campeones que has jugado y, si no hay ninguno, el más rápido del catálogo.

### 1.5 Dónde se muestra [O]

1. **Champ select** (`pages/desktop.html:457-467`, tarjeta `#jcCard`). `renderJungleClear()` (`desktop-champselect.js:1176-1183`) llama a `JungleClears.update({champion: nameOf(locked||hover), role, locked, patch})`. La tarjeta solo aparece con `role === 'JUNGLE'` (`jungle-clears.js:91`). Muestra título `"<Champ> · m:ss first clear"`, chips de rutas (`pathChip`: «`<primer campamento> start[ · recall]` · tiempo · parche», `:64-82`), meta «creador · Patch · N Smite(s)», ruta `A → B → …`, notas y la línea de evidencia. **Al bloquear campeón se abre el vídeo automáticamente, una vez por campeón y draft** (`:118`, conjunto `offered`).
2. **Cabecera de una partida del historial** (`desktop.html:526-531`, botón `#jcMatchWatch` «Fastest full clear m:ss»). `setMatch(game)` (`:135-151`) descarga el participante de match-v5 (`MatchReview.getPlayer`, a través del Worker `/api/riot/match`, `main/services/riot-match.js:85`) y comprueba `playedJungle(player, mapId)` (`jungle-clear-core.js:45-53`): `mapId === 11`; luego `teamPosition`/`individualPosition === 'JUNGLE'`; si no hay posición, que lleve Smite (`summoner1Id/2Id === 11`). Usa `select()` (solo el más rápido, sin chips).
3. **Pestaña «Jungle clears»** del título (`desktop.html:118`, vista `#studyView` `:698-747`, `js/desktop/study.js`). Lista de campeones con el tiempo del mejor clear, cabecera con splash, reproductor incrustado, chips de rutas, ruta como chips `.study-camp` (`study.js:282-289`) y notas. A la derecha, «You on X»: partidas/V-D/KDA locales de ese campeón y hasta 4 partidas como enlaces a la biblioteca (`study-core.js:58-69`, `study.js:313+`). Pie: «N champions · M clears · catalog <updatedAt>» (`study.js:237`). No vi ninguna puerta Pro en el módulo `clears`; la puerta `proAccess` solo se aplica al módulo `pros` (`study.js:62-71`). **[O]**

Los textos de esta función están **escritos a mano en inglés** dentro del JS y el HTML. En `locales/en.json` no hay cadenas de jungla ni de clears (grep sin resultados). **[O]**

### 1.6 Cómo se reproduce el vídeo de YouTube [O]

Cadena: `YouTubePane.create(host,{port})` → `<webview partition="youtube-embed" src="http://127.0.0.1:<port>/youtube?video=<id>&t=<startSeconds>&nonce=<hex32>">` (`js/desktop/youtube-pane.js:19-22`).

- El puerto lo da `getTwitchEmbedPort` → `ipcMain.handle('compare:embedPort', () => TwitchEmbedServer.ensureStarted())` (`preload.js:456`, `ipc-handlers.js:1282`): un servidor `http` de Node en `127.0.0.1:0`, es decir, en un puerto aleatorio (`main/services/twitch-embed-server.js:84-104`).
- La ruta `/youtube` valida los parámetros con regex (`YOUTUBE_RE` de 11 caracteres, `t` finito entre 0 y 86400, `NONCE_RE` `^[A-Za-z0-9_-]{8,64}$`; `:20-22`, `:94`) y sirve una página mínima con la **IFrame API oficial** (`https://www.youtube.com/iframe_api`) (`:24-42`):
  ```js
  playerVars:{origin:location.origin,start:Math.floor(startSeconds),autoplay:1,playsinline:1,controls:1,rel:0}
  onReady: mute(); playVideo(); post({event:'ready'})   onError: post({event:'error',code})
  ```
  No pasa `end`: el vídeo sigue reproduciéndose después del clear. No hay control de reproducción desde la app, solo eventos `ready` y `error`.
- Por qué existe la página en localhost: los embeds exigen que todos los marcos antecesores estén en un origen `http(s)` declarado, y la ventana es `file://` (comentario en `:3-7`). El `webview` se fuerza a `sandbox`, `contextIsolation`, sin Node, con partición `youtube-embed` y precarga `compare-webview-preload.js` (`main/services/window-manager.js:207-223`). La precarga reenvía los mensajes `{mlc:'twitch-bridge', nonce, event}` al embebedor con `sendToHost` (`main/compare-webview-preload.js:12-15`; REA `ev_3edd584a…`).
- En el renderer: resuelve con `ready`, falla con `error`, `did-fail-load` (salvo `-3`) o **timeout de 30 s** (`youtube-pane.js:23-32`). Hay un botón «Try again» y un enlace externo `https://www.youtube.com/watch?v=<id>&t=<s>s` (`jungle-clears.js:35`, `study.js:281`).
- El reproductor flotante `#jcPlayer` (480 px, esquina inferior derecha, `css/jungle-clears.css`) se mueve a `document.body` y se cierra con Esc (`jungle-clears.js:185-192`).

---

## 2. El clear del propio usuario

### 2.1 Respuesta: **no se detecta** [O]

No existe código que produzca el tiempo de clear, el orden de campamentos, los smites ni el inicio y
el fin del clear del usuario. Lo único que se mira de la partida del usuario es si jugó de jungla
(`playedJungle`) para enseñar el botón del catálogo. No hay umbrales ni constantes de detección de
clears porque no hay detección.

### 2.2 Qué fuentes de datos tiene la app y por qué no sirven para el clear [O]

| Fuente | Dónde | Qué da | ¿Se usa para clears? |
|---|---|---|---|
| Live Client Data API `https://127.0.0.1:2999/liveclientdata/{allgamedata,eventdata,gamestats}` | `main/services/game-events.js:55`, `:163`, `:366`; snapshot `live-stats.js` | Eventos `DragonKill/HeraldKill/HordeKill/BaronKill/…` (`game-events.js:294-308`) y CS total | No. La API **no emite eventos de campamentos normales** y el código no los intenta inferir |
| match-v5 + timeline (a través del Worker de MicroLab, `/api/riot/match`, `/api/riot/timeline`) | `main/services/riot-match.js:1-3`, `:85-86` | Posición y `jungleMinionsKilled` **una vez por minuto**, `ELITE_MONSTER_KILL`, kills | Solo para el coach (`track_jungler`, 2.3) y para `playedJungle` |
| Replay API (`POST /replay/render` con `cameraPosition`) | `main/services/replay-oracle.js:1-8`, `:16` | Posiciones exactas de los 10 campeones (el propio cada ~0,4 s, el resto cada 3-4 s) | No. La usan `exact-positions.js`, `death-context.js` y la proximidad del jungla enemigo en `jungle-track.js` |
| Entradas grabadas (clics/teclas) + HMM sobre navgrid | `js/core/position-track.js` (worker), `js/replay/position-map.js` | Estimación de tu posición en el reproductor | No. Grep de `jungle\|camp\|smite` en position-track y position-map: 0 resultados |
| Visión por ordenador del minimapa | — | — | No existe en esta función |

### 2.3 Lo más parecido: `track_jungler` (herramienta del coach LLM) [O]

`main/services/jungle-track.js` → `riot-coach.getJungleTrack` (`riot-coach.js:201-209`) → IPC
`riot:trackJungler` (`ipc-handlers.js:1185`) → herramienta `track_jungler` del asistente
(`js/ui/assistant-tools.js:761-774`). Devuelve **texto** para el modelo y no muestra ninguna UI de clears.

- Elige el jungla (`:25-27`): `who:'ally'` da el jungla de tu equipo (**que eres tú si juegas jungla** [I]) y por defecto el enemigo: `parts.find(p => p.teamId === team && p.teamPosition === 'JUNGLE')`.
- Ventana: `DEFAULT_TO_S = 900` (primeros 15 min, `:15`). `NEAR_YOU = 3000` (`:16`).
- Para cada frame de minuto (`:39-64`): `SR.whereIs(position, team)` da etiqueta, zona, lado y campamento; `monsters = jungleMinionsKilled` y su `delta` con el minuto anterior; nivel; distancia a ti; campeones a ≤ 1500 u.
- **Lado de inicio** (`:88-96`): el primer snapshot entre 1:00 y 2:00 (±1 s) que cae en un campamento; si no hay ninguno, el de las 2:00. Devuelve el lado del campamento (top-side/bot-side).
- `sightEntries` (`:99-113`, solo para el enemigo): con posiciones exactas, instantes en los que estuvo a ≤ `VISION_RANGE = 1200` u (`exact-positions.js:11`), muestreando cada 1 s y separados al menos 30 s.
- El propio formateador admite el límite (`:159`): posiciones una vez por minuto, «camp order between marks is not known», sin datos de smite.

### 2.4 Alcance de la búsqueda negativa [O]

Grep en todo el árbol fuera de `node_modules` de: `first clear|full clear|clearSeconds|clear time|firstClear`
(solo aparecen el catálogo, la UI del catálogo y Study); `Raptors|Krugs|Gromp` con mayúscula (solo
`jungle-clear-core.js`); `\.route` (solo validación y presentación); `jungle|camp|smite` en el
binario nativo (`native/microlab-recorder.win32-x64-msvc.node`, 0), en `native/index.js` (0) y en
los inventarios `native-rust.json` y `native-imports.json` (0). [?] Queda fuera el código del Worker
en la nube (no viene en el asar).

---

## 3. Comparación usuario contra catálogo

**No existe** [O]. Lo que hay:

- Métricas: ninguna. El único número es el `clearSeconds` declarado por el creador.
- Diferencias por campamento: ninguna.
- Visualización: la ruta solo se muestra **como texto** (`route.join(' → ')`, `jungle-clears.js:114`) o como chips (`study.js:282-289`). **No se dibuja en ningún mapa.**
- «You on X» de Study son estadísticas genéricas del campeón (partidas, V-D, KDA) y no tienen nada que ver con el clear.

### 3.1 Geometría reutilizable (sí está en el código) [O]

Coordenadas de mundo de Summoner's Rift (0-~14800). Lado rojo = reflejo puntual `(14820 − x, 14820 − y)`.
Fuente: `main/services/sr-map.js:58-71` (idéntica en `js/core/position-lookup.js:11-21`). Las coordenadas rojas las he calculado yo con esa fórmula.

| Campamento | Azul (100) | Rojo (200) |
|---|---|---|
| blue buff | (3871, 7901) | (10949, 6919) |
| gromp | (2164, 8434) | (12656, 6386) |
| wolves | (3780, 6443) | (11040, 8377) |
| raptors | (6943, 5459) | (7877, 9361) |
| red buff | (7815, 4051) | (7005, 10769) |
| krugs | (8370, 2716) | (6450, 12104) |
| dragon pit | (9866, 4414) | — |
| baron pit | (5007, 10471) | — |
| bot scuttle | (10400, 5100) | — |
| top scuttle | (4400, 9700) | — |

- `CAMP_RADIUS = 1400` u: «estar en el campamento» con snapshots de minuto (`sr-map.js:71`); `campNear` devuelve el más cercano dentro del radio (`:91-98`).
- Zonas (`sr-map.js:10-20`, iguales en `js/utils/phase.js` y `position-lookup.js:23-31`): base azul `x<3300 && y<3300`; base roja `x>11500 && y>11500`; mid `|x−y| ≤ 1800`; top `x ≤ 2300 || y ≥ 12500`; bot `y ≤ 2300 || x ≥ 12500`; río `|x+y−14820| ≤ 1200`; si no, jungla azul o roja según `x+y < 14820`.
- `laneSideOf`: `y−x > 2500` top-side, `< −2500` bot-side (`:50-54`). En un campamento manda el lado del centro canónico del campamento (`:116`).
- **Navgrid** (`js/core/navgrid-data.js:1-2`): «Map11 aipath.aimesh_ngrid, patch 16.17», bit-packed por filas, 1 = caminable, bit MSB primero (`position-track.js:122-140`). Dos resoluciones: `200` (74×73 celdas, cell 200) y `100` (148×147, cell 100), con `minx=-1.1049`, `miny=32.7558`. Celda: `col=floor((x−minx)/cell)`, `row=floor((y−miny)/cell)`. Decodificado con mi script: 4087/5402 celdas caminables (75,7 %) en la de 200, y **todos los centros de campamento caen en celda caminable** (salida en `scripts\navgrid_stats.out.txt`). La navgrid **solo la usan** el HMM de posición y el minimapa del reproductor, no los clears.

---

## 4. IA, ML o servidor

- Clears (catálogo, filtrado, elección, vídeo): **todo local**, salvo la descarga del JSON desde `cdn.microlab.gg`, la IFrame API y los vídeos de YouTube. Sin ML ni heurísticas aprendidas: un `filter` y un `sort`. **[O]**
- Servidor de MicroLab: el CDN del catálogo (público, sin credenciales, `:1` «Public metadata only»). El Worker solo interviene en `playedJungle` (match-v5) y en el coach. **[O]**
- IA: solo `track_jungler` como herramienta del asistente. El modelo, el prompt y la clave de Anthropic viven en el Worker (`main/services/assistant-client.js:1-7`). El texto de la herramienta se calcula en local con timeline + `sr-map`. **[O]**
- Curación: los datos vienen de una hoja comunitaria (`sourceUrl`) y los 360 son `creator-reported`. **[O]** Cómo se pasan de la hoja al JSON del CDN es desconocido (proceso editorial o script fuera del asar). **[?]**

## 5. Dependencias con el módulo nativo y el grabador

- **Ninguna** [O]. La función no usa el addon `microlab-recorder` (0 referencias), ni el grabador, ni los vídeos grabados. La reproducción va por un `<webview>` aparte de YouTube.
- Lo que sí comparte con otras partes: el servidor `twitch-embed-server` (también sirve los VOD de Twitch y chzzk para comparar) y el `webview` endurecido de `window-manager`. **[O]**

---

## 6. Estadísticas del catálogo empaquetado

Calculadas con `…\ml\scripts\catalog_stats.py` (ejecutado con `python -I`, reimplementa
`valid`/`variants` en Python; salida completa en `…\ml\scripts\catalog_stats.out.txt`).

| Métrica | Valor |
|---|---|
| Tamaño en disco | 156.652 bytes (CRLF), lejos de `MAX_BYTES` 524.288 |
| `updatedAt` | 2026-11-08 |
| Entradas | **360** (todas válidas, 0 `entryKey` duplicados; `validCatalog` pasaría) |
| Campeones distintos | **132** (35 con 1 entrada, 37 con 2…; máximo Dr. Mundo con 7) |
| Cadenas de parche distintas | **26**: de 25.14 (1 entrada) a 26.22 (3); incluye `26.01PBE` (2), `26.13PBE` (1) y `26.06b` (1), que `patchKey` trata como 26.01/26.13/26.06 |
| Creadores distintos | **36**. Zen'Kih 135, MikeBEASTon 76, arol 32, Veno 28, Fell 25, Pando 7, Appetite 6, 個人的JGフルクリア 6… |
| `evidence` | 360 `creator-reported`, **0 `record-verified`** |
| Smites | 1: 294 · 2: 66 |
| `clearSeconds` | mín. 128 s (2:08, Ivern) · mediana 164 · media 163,7 · máx. 198 s (3:18, Alistar); todos enteros |
| Con `Recall` en la ruta | 51 |
| Campamento inicial | Blue 139 · Red 115 · Raptors 96 · Wolves 9 · Gromp 1 |
| Rutas distintas | 16. La más común es `Blue>Gromp>Wolves>Raptors>Red>Krugs` (110), luego `Red>Krugs>Raptors>Wolves>Gromp>Blue` (85) y `Raptors>Red>Krugs>Recall>Wolves>Gromp>Blue` (41) |
| `videoId` distintos | 352 (3 vídeos con varias entradas; 11 entradas con `startSeconds ≠ 0`) |
| Mejor clear = el del parche más nuevo de ese campeón | 79/132 campeones (en 53 gana un parche anterior) |

---

## 7. Pseudocódigo para reimplementarlo (Tauri + Rust + React)

Lo observado se traduce casi uno a uno:

```rust
// Rust (comando Tauri) — equivalente a main/services/jungle-clear-catalog.js
const URL: &str = "<tu CDN>/jungle-clears.v2.json";
const REFRESH: Duration = 24h; const RETRY: Duration = 5min; const MAX: usize = 512 * 1024;
state { current: Catalog = include_str!("jungle-clears.json"), next_check: Instant, pending: Option<Shared<Fut>> }
init: if let Some(c) = disk_cache() { if valid_catalog(&c) && c.updated_at >= bundled.updated_at { current = c } }
#[tauri::command] get_catalog():
  if pending → await it; if now < next_check → return current
  match http_get(URL, timeout 5s, sin cookies, corta al pasar MAX bytes) {
    Ok(d) if valid_catalog(&d) => { if d.updated_at >= current.updated_at { current = d; write_atomic(cache) }
                                    next_check = now + REFRESH }
    _ => next_check = now + RETRY }
  return current
```

```ts
// React/TS — equivalente a jungle-clear-core.js
championKey = s => alias[s.toLowerCase().replace(/[^a-z]/g,'')] ?? that   // mejor: mapear por championId
patchKey    = p => { const [ , a, b] = /^(\d+)\.(\d+)/.exec(p)!; const M = +a; return ((M>=15&&M<25)?M+10:M)*100 + +b }
variants    = (cat, champ, patch) => cat.entries.filter(valid).filter(sameChamp && (patch==null || patchKey(e.patch) <= patchKey(patch)))
                                    .sort((a,b) => a.clearSeconds-b.clearSeconds || patchKey(b.patch)-patchKey(a.patch))
```

Vídeo: en Tauri la ventana ya tiene origen `http(s)://tauri.localhost`, así que un `<iframe src="https://www.youtube-nocookie.com/embed/<id>?start=<s>&autoplay=1&mute=1&playsinline=1&rel=0">` debería bastar sin servidor en localhost **[I]** (MicroLab necesitaba el servidor porque su ventana es `file://`). Si quieres parar al terminar el clear, añade `end=<startSeconds+clearSeconds+margen>`, cosa que MicroLab no hace.

### 7.1 Si quieres lo que MicroLab NO tiene: medir el clear del usuario [I, propuesta]

Esto es diseño propio, no algo observado. Con las fuentes que maneja MicroLab, el timeline de Riot
(minuto a minuto) **no basta** para dar el tiempo exacto de un clear de unos 2:45: solo dice dónde
estabas en los minutos 1, 2 y 3 y cuántos monstruos llevabas. Opciones, de más a menos precisa:
1. Posiciones densas propias (vídeo/minimapa o la Replay API como `replay-oracle.js`) más los centros de la tabla 3.1: entrada y salida de cada campamento dentro de un radio pequeño (no 1400, que es para snapshots de minuto). Orden = orden de entrada. Fin del clear = salida del sexto campamento, o primer `Recall`/llegada a línea.
2. Live Client Data `allgamedata` sondeado cada 1-2 s: `scores.creepScore` del jugador activo sube a saltos al matar monstruos [I]. Combinado con la posición da tiempos por campamento. La API no da la posición del jugador [?], así que necesita la fuente 1.
3. Smites: ni el timeline ni la Live Client API los dan directamente (el propio `jungle-track.js:159` lo admite). Habría que sacarlos de la pulsación de la tecla del hechizo (si grabas teclas) y validarlos con la caída de vida del monstruo, cosa que no he comprobado.

---

## 8. Observado, inferido y desconocido

**Observado**: todo lo marcado con [O], con su archivo y línea. Entre lo más importante: la URL del
CDN y sus constantes; la regla «el más rápido, parche ≤ actual, desempate por el más nuevo»; el
reproductor de YouTube a través de 127.0.0.1 con `start=floor(startSeconds)`, silenciado y en autoplay;
que no hay detección ni comparación del clear propio; que no hay ML ni módulo nativo.

**Inferido**: que `who:'ally'` en `track_jungler` te describe a ti cuando juegas jungla; que el JSON
del CDN se genera desde la hoja de Google; que en Tauri basta un iframe; el diseño del apartado 7.1;
que a un nombre como «Renata Glasc» (hoy no está en el catálogo) le fallaría el emparejamiento con
`championName` de Riot («Renata»), porque `championKey` compara nombres visibles.
`position-track.js:10-13` usa además el alias contrario (`wukong → monkeyking`), lo que confirma que
emparejar por nombre es frágil.

**Desconocido**: el contenido actual de `cdn.microlab.gg/catalog/jungle-clears.v2.json` (no lo he
descargado); el proceso de curación y la autoría de `record-verified`; el código del Worker; el
comportamiento en ejecución (análisis solo estático; REA no ejecutó nada y su cobertura semántica es
parcial para las fuentes no seleccionadas).
