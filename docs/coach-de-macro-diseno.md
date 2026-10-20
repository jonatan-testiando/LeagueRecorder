# Coach de macro y post-partida: diseño (2026-10-19)

Parte de la ingeniería inversa de iTero Coach (`docs/analisis-itero-coach-2026-10.md`). Lo que dice aquí sobre iTero está comprobado contra su código. Lo de LeagueRecorder sale del inventario de señales del mismo día. **Fuera de alcance por decisión del usuario:** overlays en partida.

## 1. Qué hace exactamente el coach de iTero (verificado con REA y código)

- **Disparo:** la transición de fase `InGame*` → `None|Lobby` (`YG`), y solo en la Grieta (`e === "InGame"`, `main.js` reducido :6393). Corre `WG()`:
  1. `POST lake-match-analysis` con **solo identificadores**: `{puuid, region, major_region, mastery, rank_data, itero_plus}`, con 3 intentos. El servidor se descarga la partida él mismo.
  2. Espera 4 s y sondea el historial 2 veces, separadas 2 s. Si hay partida nueva, parpadea la ventana y la abre; si no, cancela.
- **Qué analiza:** 122 estadísticas base: 10 overall, 17 de recursos, 60 de combate, 23 de objetivos y 12 de visión. Catálogo extraído de `BMkP8Yye.js`.
  - Todas salen de Match-V5 + timeline (incluidos los campos `challenges`). No usa nada que nosotros no tengamos.
  - Cada una existe en 5 tramos (`7_`, `14_`, `21_`, `28_`, `99_`), de ahí las «casi 500 métricas».
- **Qué devuelve:** por tramo, una nota de 0 a 5 (`performance`) y listas de claves de fortalezas y debilidades. No hay texto ni momentos concretos.
  - Las debilidades son «las estadísticas que más bajan tu probabilidad de victoria prevista» respecto a tu elo, ajustadas por campeón.
- **Foco y sesiones** (`h1_fjSTU.js`):
  - El tramo de foco es el de menor `performance` entre los que tienen ≥10 partidas.
  - Con menos de 10 partidas el tramo se deshabilita; entre 10 y 19 sale un aviso.
  - La revisión se renueva cada 10 partidas (`10 - games_remaining`).
- **Por estadística:** media móvil de 50 partidas con marca «Coaching Started», lista de partidas recientes y comparación con la media de tu elo.

**Sus límites, que son nuestra ventaja:**
1. Es correlacional y agregado: no te dice **qué momento** te costó la partida.
2. No tiene vídeo ni comportamiento (dónde mirabas, qué pulsabas, por dónde ibas).
3. La sesión no mide si mejoraste; solo vuelve a dar nota.
4. Depende de su servidor y de una cuenta.

## 2. Nuestro coach: mejor en cuatro cosas

| | iTero | LeagueRecorder |
|---|---|---|
| Unidad de análisis | estadística agregada | **jugada concreta con su ΔWP** (`winprob.rs::plays`, una por evento) |
| Por qué | «tu daño recibido está en el 9.º decil» | etiquetas de **comportamiento**: no miraste el mapa en 10 s, ibas en línea recta, te abrieron desde la niebla, oro sin gastar |
| Evidencia | ninguna | **el clip** de cada jugada, con lista de reproducción por categoría |
| Bucle | renota cada 10 partidas | **plan de 10 partidas** con antes y después medido, ejercicio en Training y recordatorio en champ select |

### 2.1 Base de datos del coach (prerrequisito)

- **Jugadas con ΔWP:** exponer la lista de jugadas de `winprob.rs::plays()` (261-384), que hoy se calcula y se tira.
  - Comando nuevo `get_match_plays(match_id)`.
  - Por jugada: `time`, `kind`, `team_id`, WP antes y después, `wpa`, `shares` y `victim`.
  - Cacheado en `<id>/plays_v1.json`.
- **Curva de probabilidad de victoria por minuto:** sale gratis de `State` en cada frame.
- **Huecos del modelo** que hay que tapar antes de usarlo para coaching:
  - Las muertes ejecutadas (killerId 0) hoy cuestan 0 (`winprob.rs:284`). Hay que valorarlas como kill enemiga sin bounty, porque el tiempo muerto sí cuenta.
  - Atakhan se ignora (`:347`).
  - Visión: queda fuera del modelo. Se dice tal cual en la UI y no se inventa.

### 2.2 Categorías de pérdida (dónde se te va la partida)

Cada jugada en la que tu equipo pierde WP y tú estás implicado entra en una categoría. Las etiquetas se calculan con datos que ya existen.

| Categoría | Regla | Datos |
|---|---|---|
| Muerte al jungla | el jungla enemigo es el killer o asistente | kill event + `participants` |
| Muerte fuera de tu zona | posición de la kill lejos de tu carril (`RADIO_CARRIL` 2500, `camera_input.rs:62`) | kill x,y |
| Dive / bajo torre antes del 14 | muerte cerca de una torre (propia o enemiga), minuto < 14 | kill x,y + posiciones de torres |
| Muerte con poco daño devuelto | `victimDamageDealt` bajo frente al decil de tu rol | timeline (cuidado con `participantId != 0`) |
| Muerte sin mirar el mapa | ninguna mirada en los 10 s previos | `camera_snaps` (ya en `DeathsSection`) |
| Te abrieron desde la niebla | apertura `from_fog` | `golpes.rs` `Apertura` |
| Muerte antes de objetivo | objetivo enemigo ≤60 s después: el coste del objetivo se suma a la muerte | plays (sustituye los pesos a mano de `moments.ts:81-89`) |
| Ausente del objetivo | objetivo enemigo con tu icono lejos, o muerto, o en base | track propio 2 Hz (`track.rs`) + `ELITE_MONSTER_KILL` |
| Tirada | caída de WP con tu equipo ≥65 % | curva WP |

- **Coste de la categoría** = Σ ΔWP perdido en la partida.
- **Baremo:** el mismo cálculo sobre el corpus de 9.258 partidas (`D:/lol-corpus`), por rol × franja, con el patrón de `baselines.rs`.
  - Las categorías de vídeo (mirar el mapa, niebla, línea recta) no existen en el corpus. Su baremo es **tu propia media**, y la UI lo dice.

### 2.3 Tramos y foco

- **Nota por tramo:** tu WPA en cada tramo (0-7 / 7-14 / 14-21 / 21-28 / 28+), con los mismos cortes que iTero, comparado con los deciles del corpus. Se muestra como percentil, con la convención de color de `RankBenchmarkCard`.
- **Foco** = la combinación categoría × tramo con más WP perdido **por encima de tu baremo**, que tenga muestra suficiente:
  - Mínimo 10 partidas; menos de 15 es «indicio» (`confidenceOf`, `patterns.ts:179`).
  - Sustituye a `currentFocus` (`patterns.ts:223`). Hoy ese foco es «el bloque de 5 min en que más mueres», sin ventana de tiempo, aunque Home diga «esta semana».

### 2.4 Plan de 10 partidas (el bucle)

1. **Arranque:** «Tu foco: muertes al jungla entre 7 y 14. Te cuestan 9 % de victoria por partida; en tu rango, 4 %».
   - Se acompaña de una lista de reproducción con tus 5 peores jugadas de esa categoría.
2. **Durante:**
   - Tras cada partida, una línea en Home: «esta partida: 1 (−3 %) · media del plan: 1,4».
   - Con el LCU, un recordatorio en champ select, en la ventana de la app y no en el juego: «hoy: ojo al jungla entre 7 y 14».
3. **Ejercicio:** si la categoría es de mapa (sin mirar, niebla), se enlaza el drill de Training correspondiente (`ReflexDrill`, `AwarenessQuiz`).
4. **Cierre a las 10 partidas:** antes y después con intervalo de confianza, y veredicto honesto («mejoró», «igual», «muestra corta»). Luego se propone el siguiente foco.
   - Las sesiones se guardan en `%APPDATA%\LeagueRecorder\coach\sessions.json`.
5. **Por categoría:** media móvil con la marca «empezaste aquí» y la lista de partidas, cada una enlazada a su clip. Es lo de iTero, pero con vídeo.

### 2.5 Dónde vive en la UI

Una pantalla **Coach** en el grupo «Mejorar» del rail, junto a Patrones y Training. Lleva:
- el plan en curso;
- las categorías ordenadas por coste;
- los tramos;
- el historial de planes.

En la ficha de partida, la pestaña Impacto gana el bloque «Lo que te costó esta partida», que muestra las 3 jugadas con más ΔWP en contra.

## 3. Resto del post-partida (punto 3)

| # | Qué | Cómo | Esfuerzo |
|---|---|---|---|
| 3.1 | **Muertes con precio** | Cada fila de `DeathsSection` gana un chip de ΔWP («−6 % de victoria») y las etiquetas de §2.2. `DeathCost` (`attribution.rs:105`) pasa a tener `wpa` y `tags` | S (con §2.1) |
| 3.2 | **Curva por minuto con modos** | De `riot_timeline.json`, que ya guarda crudo los `participantFrames` de los 10: oro, XP, `damageStats.totalDamageDoneToChampions` y `totalDamageTaken`. Modos: vs rival / vs media rival / equipo vs equipo / los 10. Debajo, la franja de objetivos (`ELITE_MONSTER_KILL`) y **la curva de WP con las jugadas como puntos**: clic → vídeo. Va en el bloque «Ventaja» de `MatchTab` | M |
| 3.3 | **Por delante, igualada o por detrás** | Estado de cada partida por la diferencia de oro con tu rival al 14 (`minute_frames`), con cortes por terciles del corpus por rol. Patrones se parte en tres. Además: **tasa de tiradas** (pierdes con WP ≥ 65 %) y **tasa de remontadas** (ganas desde ≤ 35 %) | S-M |
| 3.4 | **Calibración del score** | Winrate por tramo de `impact_percentile` en tus partidas, frente a la línea del corpus (que tiene resultado). Una tarjeta pequeña en Impacto o Patrones: «cuando sales MVP ganas el X %» | S |
| 3.5 | **Flujo automático al terminar** | Al acabar la sincronización (`commands.rs:1314`, 60 s después del fin): toast de progreso, `requestUserAttention` de Tauri hasta que la ventana tenga foco, y abrir la partida en `/review`. No navega si el usuario está viendo un vídeo o tiene el reproductor abierto (el `blockNavigation` de iTero). Con el LCU el disparo será exacto | S |
| 3.6 | **Títulos para los 10** | Un título por jugador según su métrica más extrema frente a los deciles de `benchmarks.rs` («El fantasma», «Cazado por el jungla»). Va en el marcador | S |

## 4. Selección de campeón (punto 5, depende del LCU)

Todo se muestra en la ventana de la app durante champ select (fase `ChampSelect` del LCU), nunca en el juego. Solo se usan **campeones**, no nombres: Riot prohíbe des-anonimizar en champ select.

| # | Qué | Cómo |
|---|---|---|
| 5.1 | **Tu historial contra tu rival** | Al aparecer el campeón enemigo de tu rol: tu W/L, tu WPA medio y tus muertes por partida contra él (de «Tus rivales»), más las 3 jugadas que más te costaron contra ese campeón, con clip. **Ojo:** en ranked el `assignedPosition` de los enemigos viene vacío, así que el carril se infiere con la tabla campeón → carril más común sacada del corpus (iTero hace lo mismo con `default_lane.json`) |
| 5.2 | **Recordatorio del plan** | El foco de la sesión (§2.4) y cómo vas: «3 de 10 · media 1,4» |
| 5.3 | **Tu pool personal** | Tus mejores picks para el rol: WR y WPA por campeón con muestra mínima, en tiers con los cortes de iTero (≥54 S+, ≥52 S, ≥51 A+…), avisando cuando la muestra es corta. Sugerencia de baneo: los campeones contra los que más pierdes |
| 5.4 | **Tus runas ganadoras** (opcional) | La página de runas más frecuente en tus victorias con ese campeón (de `riot_match.json`), escrita con `PUT /lol-perks/v1/pages/{id}` como hace iTero. Es una escritura en el cliente: va detrás de un botón, nunca es automática |

**Descartado:** auto-hover y auto-lock (poco valor y riesgo), y modelo de draft (necesita millones de partidas).

## 5. Orden propuesto

1. **§2.1 + 3.1** (jugadas con ΔWP + muertes con precio): es la base de todo lo demás.
2. **3.2** (curva con WP) y **3.5** (flujo automático): independientes y visibles.
3. **§2.2-2.3** (categorías + baremos del corpus) y después **§2.4-2.5** (plan y pantalla Coach).
4. **3.3, 3.4 y 3.6**.
5. **§4**, cuando el LCU esté integrado.
