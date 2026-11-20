# Línea base de rendimiento (fase 0 del plan de almacenamiento)

Medido el 2026-11-19 en la máquina de desarrollo (release, caché del sistema caliente), antes de cambiar ningún formato. Sirve para comparar cada fase del plan.

## Cómo repetirlo

1. Bibliotecas sintéticas, sin vídeos: `python tools/medir/biblioteca_sintetica.py --origen <biblioteca> --destino <dir> --n 300` (añade `--sin-caches` para forzar el recálculo de coach, jugadas, presión y ruta).
2. Banco con los comandos reales: `set MEDIR_BIBLIOTECA=<dir>` y luego `cargo test --release --lib medida_banco -- --ignored --nocapture` (en `src-tauri`). Usa un `APPDATA` propio y no toca la configuración del usuario.
3. Arranque real: lanza la app con `WARDLINE_MEDIR=<fichero.log>`. Cada comando, cada `load_all_matches`, `load_match_by_id` y `save_match_metadata` y cada etapa del arranque deja una línea `ms_desde_arranque  qué  ms  detalle` (ver `src-tauri/src/medida.rs`). Sin la variable no escribe nada.

## 1. Arranque real (app de release, Home)

| | 29 partidas | 300 partidas |
|---|---|---|
| Recorridos completos de la biblioteca | 13 | 13 |
| Lista visible (`get_recorded_matches` termina) | 0,9 s | 2,8 s |
| Paneles de Home completos (segunda tanda) | 1,2 s | 6,0 s |
| Mantenimiento del arranque terminado (`impact_backfill`) | 1,1 s | 7,1 s |
| Cada `load_all_matches` | 170-255 ms | 2,2-2,5 s |

Los paneles de Home se piden **dos veces** cada uno (`get_coach_plan`, `get_blind_spot`, `get_pressure_summary`, `get_coach_summary`). `check_riot_key` va 3 veces y `get_all_error_clips` también 3 (210 ms cada una con 300 partidas).

## 2. Banco de comandos (2ª ejecución = estado estable con cachés)

| Comando | 29 | 300 | 1.000 | Recorridos | Aperturas con estela (300) |
|---|---|---|---|---|---|
| `load_all_matches` | 125 ms | 1,35 s | 4,6 s | 1 | 0 |
| Home: `get_recorded_matches` | 133 ms | 1,34 s | 4,7 s | 1 | 0 |
| Home: `get_pressure_summary` | 162 ms | 1,75 s | 5,8 s | 1 | 0 |
| Home: `get_coach_summary` | 170 ms | 1,83 s | 6,4 s | 1 | 0 |
| Home: `get_coach_plan` | 125 ms | 1,38 s | 4,6 s | 1 | 0 |
| Home: `get_blind_spot` | 141 ms | 1,49 s | 5,0 s | 1 | 0 |
| Patrones: `get_spell_diet` | 586 ms | 5,05 s | 17,9 s | 1 | **280** |
| Patrones: `get_jungle_routes` | 320 ms | 3,11 s | 10,3 s | 1 | 0 |
| Patrones: `get_waves_career` | 821 ms | 1,98 s | 6,4 s | 1 | 15 |
| Patrones: `get_game_states` | 178 ms | 1,77 s | 6,3 s | 1 | 0 |
| Patrones: `get_hits_taken_career` | 334 ms | 1,74 s | 5,4 s | 1 | 10 |
| Patrones: `get_camera_zone_history` | 146 ms | 1,64 s | 5,6 s | 1 | 0 |
| Patrones: `get_hand_career` | 211 ms | 1,35 s | 4,6 s | 1 | 10 |
| **Suma de todo** | 3,7 s | 26,0 s | 87,9 s | | |

Lo que se lee: cada recorrido son 96 MB de metadata con 29 partidas, 1,0 GB con 300 y 3,3 GB con 1.000. `get_spell_diet` lee además 2,0 GB de metadata y 216 MB de crudos de Riot con 300.

**Sin cachés** (300, 1ª ejecución, lo que pasa tras invalidarlas o en una biblioteca recién migrada): `get_pressure_summary` 16,2 s, `get_coach_summary` 9,8 s, `get_jungle_routes` 6,7 s, `get_game_states` 2,7 s.

**Lo que cruza el IPC en JSON:** `get_recorded_matches` 0,59 MB (29) → 6,1 MB (300) → 20,4 MB (1.000); `get_pressure_summary` 3,4 MB y `get_jungle_routes` 3,4 MB con 1.000.

## 3. Abrir una partida (no depende del tamaño de la biblioteca)

| Comando | ms | Aperturas con estela | Nota |
|---|---|---|---|
| `get_match_details` | 15 | 1 | 2,0 MB de JSON al WebView |
| `get_match_titles` | 27-35 | 1 | |
| `get_match_track` | 33 | 0 | 0,2 MB |
| `get_gold_report` | 30 | 1 | |
| `get_episode_strip` (×1 episodio) | 28-34 | 1 | una llamada por episodio, sin caché |
| `get_spell_autopsy` | 22-28 | **2** | |
| `get_match_plays`, `get_match_coach`, `get_minute_series`, `get_hand_report`, `get_aim`, `get_match_benchmarks` | 10-16 cada uno | 1 cada uno | |
| `save_match_comments` | 18-27 | 1 | reescribe 3,6 MB |

Al abrir una partida la estela (3,6 MB) se parsea unas 12 veces, una por comando, aunque solo el reproductor la usa.

## Lectura

- Todo lo que mira la biblioteca entera escala en línea recta: ~4,6 ms por partida y recorrido. El arranque hace 13 recorridos, así que cada partida nueva añade unos 60 ms de trabajo al abrir la app.
- El 99 % de lo leído es la estela del ratón, que ninguno de esos comandos usa.
- Abrir una partida es rápido en absoluto (~250 ms sumando todo), pero más de la mitad es reparsear la estela (13 aperturas de ~15 ms).

## Tras la fase 1 (2026-11-19, sin cambiar formatos)

Qué cambió: caché en memoria del listado (por fecha y tamaño de cada `{id}.json`, con un candado para que los listados simultáneos esperen al primero), config en memoria, `get_match_metadata` sin estela (solo manos, golpes, barras y miradas la piden con `get_match_metadata_con_estela`), metadata en JSON compacto y escrito de forma atómica, `storage::modificar` con candado por partida para los barridos y los guardados largos, comandos síncronos de disco pasados a async, caché por partida de `get_spell_diet` (`spells_v1.json`), la ruta de jungla mira su caché antes de parsear, y en el frontend: los resúmenes de Home dependen de una firma de la biblioteca (no se piden con la lista vacía ni en cada refresco), el rastro del ratón busca por bisección y `check_riot_key` / `get_all_error_clips` comparten la llamada en vuelo.

Banco, estado estable (2ª ejecución):

| Comando | 300 antes | 300 después | 1.000 antes | 1.000 después |
|---|---|---|---|---|
| `load_all_matches` | 1,35 s | 73 ms | 4,6 s | 144 ms |
| `get_recorded_matches` | 1,34 s | 84 ms | 4,7 s | 185 ms |
| `get_pressure_summary` | 1,75 s | 392 ms | 5,8 s | 1,20 s |
| `get_coach_summary` | 1,83 s | 471 ms | 6,4 s | 1,53 s |
| `get_coach_plan` | 1,38 s | 72 ms | 4,6 s | 145 ms |
| `get_blind_spot` | 1,49 s | 217 ms | 5,0 s | 635 ms |
| `get_spell_diet` | 5,05 s | 399 ms | 17,9 s | 1,25 s |
| `get_jungle_routes` | 3,11 s | — | 10,3 s | 1,10 s |
| `get_game_states` | 1,77 s | 339 ms | 6,3 s | 1,07 s |
| **Suma de todo el banco** | 26,0 s | 5,3 s | 87,9 s | 9,5 s |

`get_spell_diet` la primera vez calcula y guarda la caché de cada partida (7,9 s con 300, 16 s con 1.000); después ya no. El primer listado tras arrancar sigue parseando la biblioteca entera (1,4 s con 300, 4,7 s con 1.000): eso es la fase 2.

Abrir una partida: la estela se parsea 4 veces en vez de 13 (detalle, manos, autopsia de hechizos y puntería), y guardar un comentario escribe 2,0 MB en vez de 3,6.

Arranque real, 300 partidas: lista visible 2,8 → 2,3 s, Home completa 6,0 → 3,3 s, mantenimiento terminado 7,1 → 3,0 s. Con 29 apenas cambia (~1,2 s), porque ahí pesa el resto del arranque.

## Tras la fase 2 (2026-11-19): la estela en `estela.bin`

Qué cambió: la estela del ratón sale del metadata a `estela.bin` (formato en `src-tauri/src/estela.rs`: tabla de tipos de evento y columnas `f64` alineadas a 8, sin perder un bit respecto al JSON). El metadata queda en ~20-30 KB. El reproductor recibe la estela en binario con `get_match_trail` (`ArrayBuffer`, ~1 MB) en vez de 2 MB de JSON dentro del detalle. La migración corre en el mantenimiento del arranque, una vez por partida: escribe, relee y compara punto a punto antes de reescribir el JSON, y devuelve a los ficheros su fecha original para no invalidar las cachés (coach, hechizos, presión). La copia de seguridad y el espejo llevan `estela.bin`; los scripts de Python que leían la estela usan `python_scripts/estela.py`.

Verificado con una copia de la biblioteca real (29 partidas, 1.051.379 puntos): todas las estelas coinciden bit a bit con lo que la app leía antes. Frente al JSON original hay 19 números en 2 partidas que difieren en 1 ULP: no es la migración, es que `serde_json` (sin `float_roundtrip`) ya los leía así.

| | antes (fase 0) | fase 1 | fase 2 |
|---|---|---|---|
| Primer listado tras arrancar, 300 | 1,39 s | 1,39 s | 113 ms |
| Primer listado tras arrancar, 1.000 | 4,9 s | 4,7 s | 383 ms |
| Abrir partida: detalle por IPC | 2,0 MB | 2,0 MB | 0,03 MB + 1 MB binario |
| Guardar un comentario | 3,6 MB | 2,0 MB | ~25 KB |
| Migración (una vez) | — | — | 0,9 s con 29 · 9,5 s con 300 · 24 s con 1.000 |

Arranque real ya migrado:

| | 29 | 300 |
|---|---|---|
| Lista visible | 0,9 s → 0,59 s | 2,8 s → 0,63 s |
| Home completa | 1,2 s → 0,70 s | 6,0 s → 1,5 s |
| Mantenimiento terminado | 1,1 s → 0,41 s | 7,1 s → 1,1 s |

## Tras la fase 3 (2026-11-19): resúmenes guardados en SQLite

Lo que quedaba (perfil con 1.000 partidas, resumen de presión): ~0,8 s de llamadas al sistema de ficheros para comprobar fechas de las cachés de cada partida y ~0,6 s de leer y parsear 28 MB de esas cachés, en cada petición. Pasar la lógica a SQL no lo arreglaba: el coste no era agregar, era recalcular desde cero cada vez.

Qué cambió: `indice.db` (rusqlite con SQLite incluido, WAL, junto a la config) guarda cada resumen ya calculado (presión, coach, punto ciego, estados de partida, rutas de jungla, dieta de hechizos, historial de cámara, golpes, oleadas, manos) con la firma de la biblioteca con la que se calculó. La firma es un solo listado de carpetas: versión de la app, configuración, y nombre y fecha de cada carpeta de partida; todo lo que la app escribe en ellas ya es atómico (temporal + renombrado), así que cualquier cambio cambia la fecha de su carpeta. Si la firma coincide, el comando devuelve el JSON guardado tal cual (`RawValue`), sin recalcular ni re-serializar. Solo se guarda si la firma es la misma antes y después de calcular. El índice es desechable (se rehace solo si falta o está dañado) y Ajustes → Almacenamiento → «Resúmenes guardados» lo vacía a mano.

| Resumen (estado estable) | 300 fase 2 | 300 fase 3 | 1.000 fase 2 | 1.000 fase 3 |
|---|---|---|---|---|
| `get_pressure_summary` | 359 ms | 4 ms | 1,23 s | 9 ms |
| `get_coach_summary` | 490 ms | 2 ms | 1,66 s | 2 ms* |
| `get_blind_spot` | 190 ms | 1 ms | 620 ms | 2 ms |
| `get_game_states` | 420 ms | 1 ms | 1,04 s | 2 ms |
| `get_jungle_routes` | 328 ms | 3 ms | 1,10 s | 10 ms |
| `get_spell_diet` | 410 ms | 1 ms* | 1,34 s | 1 ms* |

\* En el banco la 2.ª ejecución aún recalcula estos porque el propio banco comenta una partida en la pasada anterior: la primera petición tras un cambio reescribe la caché de esa partida, la firma cambia por el camino y no se guarda; la siguiente sí. Comprobado con el test `que_cambia_al_calcular`.

Arranque real, 300 partidas, biblioteca sin cambios: los tres resúmenes de Home salen del índice en 5-9 ms a los 0,74 s del arranque; Home completa en ~0,85 s (fase 2: 1,5 s; fase 0: 6,0 s).

Lo siguiente que pesa: `get_recorded_matches` manda la biblioteca entera al WebView en JSON (6 MB con 300, 20 MB con 1.000) y el plan de 10 partidas (`get_coach_plan`, 100-150 ms) no está en el índice porque depende de las sesiones guardadas en `%APPDATA%`.

## La lista de partidas al WebView (2026-11-19)

Medido dentro del WebView (ida y vuelta de `invoke`): la lista completa tardaba ~120 ms con 300 partidas y ~380 ms con 1.000 (6,1 y 20,3 MB de JSON), y se pedía entera al arrancar, cada 5 minutos, cada 15 s durante el post-partida y tras cada sincronización, aunque casi nunca trajera nada nuevo.

Qué cambió:
- La lista ya no lleva `apm_series` (ninguna pantalla la lee) ni `item_purchases` (solo el reproductor, que la saca del detalle): un 19 % menos.
- `get_recorded_matches_delta`: el frontend manda la versión de cada partida que ya tiene (fecha y tamaño de su JSON) y recibe el orden completo (solo ids) más las partidas nuevas o cambiadas. El store conserva el objeto de las que no cambian y, si no cambió nada, no toca la lista.
- El listado en Rust solo clona las partidas que hay que enviar, y no hace un `stat` por partida si la fecha de su carpeta no ha cambiado (lo permite que toda escritura en las carpetas sea atómica; si el renombrado falla, `escribir_atomico` toca la carpeta para que su fecha cambie igual).

| 1.000 partidas, en el WebView | antes | ahora |
|---|---|---|
| Lista completa (arranque) | 380 ms · 20,3 MB | 256 ms · 16,6 MB |
| Refresco sin cambios | 380 ms | 13-15 ms |
| Refresco con un comentario nuevo | 380 ms | ~15 ms, 1 partida |
| `load_all_matches` en caliente (banco) | 144 ms | 34 ms |

Con 300: lista completa 97 ms y refresco sin cambios ~35 ms antes de quitar el `stat` (no repetido después).

## Arranque visual y frontend (2026-11-19)

Medido en la app de release con CDP: marcas `performance.mark("wl:*")` (main.tsx, useAppStore, HomePanel, App) alineadas con el registro de Rust por la hora de reloj (`epoch_ms` en la línea «arranque»). Perfiles de CPU de una recarga traducidos con el sourcemap de `vite build --sourcemap`.

Antes, con 29 partidas: el WebView empieza a cargar a ~0,4-0,5 s del arranque del proceso (Windows, Tauri y WebView2; nuestro `setup` son 25 ms); JS de 1,16 MB en un solo fichero; ~130 ms de primer render antes de la primera llamada al backend; `get_audio_status` síncrono (50-80 ms en el hilo principal) retrasaba la lista; datos de Hoy pintados a ~0,81 s; la bienvenida, con un mínimo de 2 s desde que se monta, dejaba ver Hoy a ~2,6-2,9 s. En el perfil, ~78 ms de ~200 ms de JS se iban en crear formateadores `Intl` (uno nuevo por cifra o fecha), Hoy montaba escondida la sección plegada (4.357 nodos, la mitad del DOM) y framer-motion medía el layout para la píldora del raíl (~31 ms en `scrollLeft`).

Qué cambió:
- `core/intl.ts`: formateadores `Intl` creados una vez por idioma y opciones.
- Hoy: «Más sobre esta partida» no se monta hasta abrirla; los episodios buscan su partida en un `Map`.
- La píldora del raíl es un solo elemento movido con `transform` y una curva de muelle sin rebote en CSS (`linear()`); el fundido del título de pantalla también es CSS. framer-motion solo queda en el reproductor de errores.
- `get_audio_status` fuera del hilo principal.
- Las pantallas que no se ven al arrancar van en su propio trozo (`core/perezoso.tsx`, sin `React.lazy` para que no haya un fotograma vacío que se coma la entrada) y se precargan en reposo al irse la bienvenida y al pasar el ratón por el raíl. JS principal 1,19 MB → 599 KB; CSS principal 224 → 95 KB.
- Bienvenida: mínimo de 1 s contado desde que se ve (su coreografía acaba a los ~960 ms), en vez de 2 s desde que se monta.

| 29 partidas | antes | ahora |
|---|---|---|
| Hoy visible (sale la bienvenida) | 2,6-2,9 s | ~1,95 s |
| JS de la app en el perfil de una recarga | ~200 ms | ~35 ms |
| Recarga en caliente: Hoy pintada | 217 ms | 137 ms |
| Nodos del DOM en Hoy | 8.938 | ~4.600 |

Lo que queda por debajo de eso es de WebView2: ~0,45 s hasta empezar a cargar la página y ~250 ms entre que el JS empieza y el primer fotograma en un arranque en frío (en una recarga en caliente son ~5 ms), que es la puesta en marcha del compositor, no nuestro código.

## Movimiento (2026-11-19/20)

El usuario: las animaciones «van a tirones». Medido con clics de ratón reales por CDP en la app de release, pantalla de 240 Hz (4,2 ms por fotograma). Dos medidas: fotogramas del hilo principal (`requestAnimationFrame`) y fotogramas que presenta o pierde el compositor (`PipelineReporter` en una traza del navegador; solo esta dice lo que ve el ojo en las animaciones que corren en el compositor).

Causa de los tirones: `core/enterMotion.ts` recorría el árbol con `getComputedStyle`/`getBoundingClientRect` en el mismo fotograma en que React montaba la pantalla y animaba hasta 23 piezas, cada una en su capa; la animación arrancaba con el hilo principal ocupado.

Qué cambió (`core/movimiento.ts`, `core/navegar.ts`):
- Cambiar de pantalla con View Transitions (90 ms la que se va, 220 ms la que llega, 10 px según la dirección del raíl; el título de la barra cruza con desenfoque). Todas las navegaciones pasan por `useNavigate` de `core/navegar.ts`, que va directo al navegador del router: el de react-router se suscribe a la ruta y repintaba en cada cambio todas las pantallas que lo usan. `HashRouter useTransitions={false}`: si no, el cambio de ruta va en `startTransition` y `flushSync` no lo aplica dentro de la transición.
- El contenido de cada pantalla, memorizado en App: antes se repintaban todas las pantallas montadas en cada navegación (23 ms).
- Entrada escalonada solo en la primera visita, ≤5 bloques (`data-e` o los hijos del primer contenedor con varios), sin medir nada.
- Abrir/cerrar partida: vuela el retrato (fila o Hoy → miga del reproductor); el reproductor se funde y el panel entra 18 px con la curva de los cajones; la Biblioteca se funde al volver.
- Segmentados con `clip-path` sobre una copia activa (el texto cambia de color a la vez que el fondo); indicadores con muelle `linear()`.
- Hoja de estadísticas: sube como un cajón (320 ms) y baja en 200 ms; pestañas y bloques cambian con un fundido de 160 ms con desenfoque.
- Con el teclado no se anima nada; movimiento reducido = solo fundidos.

| Interacción (hilo principal, `requestAnimationFrame`) | antes | ahora |
|---|---|---|
| Abrir la hoja de estadísticas | tirón de 46 ms | máx. 8 ms |
| Pestaña Resumen del reproductor | tirón de 25 ms | máx. 8 ms |
| Pestaña de la hoja | 12,5 ms | máx. 8 ms |
| Abrir partida | hasta 50 ms | hasta 54 ms |

Cambio de pantalla, compositor: tras el clic hay ~20 ms con la pantalla quieta (5 fotogramas a 240 Hz: la captura de la transición y el render) y después la animación de 220 ms no pierde ningún fotograma. El render dentro de la transición bajó de 23 ms a ~13 ms con las pantallas memorizadas y el `useNavigate` propio.

Queda: abrir una partida sigue costando ~47 ms de montaje del reproductor antes de la animación (el cuerpo de `VideoPlayer` ~11 ms, el layout de todo el reproductor que fuerzan las medidas de `useIndicator` ~17 ms, y sus efectos después) y la primera visita a la Biblioteca (lista virtualizada) pierde ~20 fotogramas. Eso es el coste del reproductor, no de la animación.

### Abrir una partida (2026-11-20)

Medido en la app de release con doble clic de ratón real por CDP en la Biblioteca (120 ms entre los dos clics, como una persona), pantalla de 240 Hz. Traza del navegador: fotogramas perdidos del compositor y tareas del hilo principal; perfil de CPU con los sourcemaps de la build.

Qué pasaba al abrir:
- Dentro de la transición (el callback de `startViewTransition`, con la pantalla congelada) se iban 43,6 ms: montar `VideoPlayer`, la maquetación entera que fuerza `useIndicator` al medir, los efectos que React ejecuta dentro de `flushSync` y la Biblioteca entera repintándose aunque se quedaba oculta.
- Después, cada dato llegaba por su lado (detalle, estela, serie por minuto, errores marcados, miradas, resumen de saltos, versión de Data Dragon) y repintaba el reproductor entero: unas diez tareas de 2-8 ms durante el vuelo.
- Dos animaciones no se componían y dependían del hilo principal en cada fotograma: el vuelo del retrato (el navegador anima `width`/`height` porque el retrato cambia de tamaño) y el título de la barra (el desenfoque). Cualquier tarea las hacía saltar.
- La estela del ratón tenía un bucle de `requestAnimationFrame` que no paraba nunca: 240 repintados por segundo con el vídeo en pausa y con el reproductor oculto en otra pantalla, y leía el estilo calculado al montarse (6 ms).

Qué cambió:
- `features/player/datosPartida.ts`: todo lo del reproductor en una sola espera, pedido al pulsar el ratón sobre una fila o un acceso de Hoy (`data-match-id`, `data-abre-partida`) y en `setSelectedMatch`. El reproductor se monta con los datos si ya llegaron (casi siempre con doble clic) o los aplica de una vez. Los errores marcados salen de la lista compartida del store (y se refresca al marcar uno desde el reproductor).
- Fuera los estados que se reiniciaban a sí mismos al montar (`useAlCambiar`: solo cuando cambia la partida) y la cola de momentos pasa a `useMemo`.
- `vueloEnCompositor` (core/movimiento.ts): el vuelo del retrato se rehace solo con `transform` (el grupo con su tamaño final, empezando escalado); al abrir o cerrar, el título cruza sin desenfoque.
- La Biblioteca, memorizada aparte en App: abrir o cerrar no la repinta.
- Al abrir con animación, las filas de la lista de sucesos llegan justo después del primer fotograma (`useDeferredValue`), con el panel aún casi transparente; con el teclado, a la vez.
- La estela pinta solo cuando el vídeo cambia de instante (reproduciendo, al buscar, al cargar, al cambiar de tamaño o de tema) y lee los colores la primera vez que dibuja.

| Abrir partida (en caliente, 3 de 4 aperturas) | antes | ahora |
|---|---|---|
| Fotogramas perdidos | 33 | 8-12 |
| Pausa hasta que empieza a moverse | ~100 ms | ~25 ms |
| Trabajo dentro de la transición | 43,6 ms | 12 ms |
| Repintados del reproductor durante el vuelo | ~10 | 3 pequeños |
| Animaciones sin componer | vuelo del retrato, título | ninguna propia |

La primera apertura de la sesión pierde 20 (JavaScript aún sin optimizar: 21 ms dentro de la transición). Cerrar pierde 2-4, todos en la pausa inicial. Con una partida abierta y el vídeo en pausa, `requestAnimationFrame` pasa de 240 llamadas por segundo a 0; reproduciendo, una por fotograma.

Lo que queda en la pausa inicial es inevitable con View Transitions: capturar la pantalla de antes (~10 ms) y montar y maquetar el reproductor (~12 ms).
