# Historial del cliente (LCU) frente a Match-V5

Investigación, sin construir nada, de si el historial que sirve el cliente de
League alcanza para que la app funcione **sin clave de Riot**. Medido el
2026-10-19 con el cliente abierto (cuenta de LA1, fase `None`, sin partida en
curso), comparando campo a campo contra el `riot_match.json` y el
`riot_timeline.json` que la biblioteca ya tenía cacheados de Match-V5.

Partidas comparadas (las tres clasificatorias solo/dúo, de la biblioteca):

| Match-V5          | Fecha      | Duración | En la lista del LCU |
|-------------------|------------|----------|---------------------|
| `LA1_1746460303`  | 2026-09-05 | 1633 s   | sí (primera página) |
| `LA1_1745993601`  | 2026-09-03 | 914 s    | sí (primera página) |
| `LA1_1744746449`  | 2026-08-29 | 2020 s   | no; se pide por id y lo sirve |

## Veredicto

**No alcanza para funcionar entero sin clave.** El LCU devuelve la *misma*
partida (mismos números donde coinciden los campos) y la *misma* rejilla de
fotogramas por minuto, pero en el formato antiguo (v4) y con una timeline
recortada a tres tipos de suceso. Con eso:

- **Sí sale sin clave:** scoreboard de los diez (KDA, oro, daño, objetos
  finales, CS, visión, hechizos), resultado, duración, cola, parche,
  objetivos por equipo, y la gráfica de oro/XP/CS por minuto con posiciones.
  Las muertes (quién, a quién, asistencias, segundo y sitio), torres,
  inhibidores, dragones, heraldo, larvas y barón también.
- **No sale:** compras de objetos con su minuto, guardianes, placas, el
  desglose de daño de cada muerte, recompensas, roles fiables, `challenges` y
  pings. De eso viven la ruta de jungla, el oro, la detección de ganks, el
  reparto de crédito / WPA, «Lo que te comes», la presión y la probabilidad de
  victoria (ver la tabla de módulos abajo).

Un «modo sin clave» degradado es posible (scoreboard + gráfica + marcadores de
muertes y objetivos); el análisis que distingue a la app, no.

Dos cosas que el LCU da y Match-V5 no:

- **Partidas personalizadas y de práctica** (`queueId` 3100 y 3140 en esta
  cuenta) aparecen en su historial con detalle y timeline completos. Que
  Match-V5 no las devuelva por puuid no se ha comprobado aquí.
- **El puuid real**, no el cifrado por clave de API. Ver «Identidad».

## Conexión (lo que se midió)

- Lockfile en `C:\Riot Games\League of Legends\lockfile`:
  `LeagueClient:<pid de LeagueClient.exe>:<puerto>:<contraseña de 22>:https`.
  El de Riot Client (`%LOCALAPPDATA%\Riot Games\Riot Client\Config\lockfile`)
  tiene el mismo formato con nombre `Riot Client`: es otro servidor.
- `C:\ProgramData\Riot Games\RiotClientInstalls.json` lista la instalación en
  `associated_client` (claves = carpetas).
- Línea de comandos de `LeagueClientUx.exe`: `--app-port` coincide con el del
  lockfile, pero `--remoting-auth-token` **no** es la contraseña del lockfile;
  el servidor acepta las dos. Cuidado con `--riotclient-app-port` y
  `--riotclient-auth-token`, que son del Riot Client. El argumento
  `--riotgamesapi-settings` es un base64 que también lleva tokens: no se
  registra nunca.
- TLS: el certificado del LCU es `CN=rclient`, firmado por «LoL Game
  Engineering Certificate Authority», con SAN `DNS:localhost, IP:127.0.0.1`.
  Esa CA es exactamente la `riotgames.pem` que publica Riot (SHA-256
  `CA:8C:9D:32:5B:4C:DC:46:4C:6C:94:A5:85:C8:5E:91:EC:23:D4:0B:A5:BF:3A:E2:82:2B:95:1A:4A:50:4E:A3`,
  X.509 v1, caduca en 2043). Por eso `lcu.rs` verifica el TLS de verdad contra
  esa única raíz en vez de aceptar certificados inválidos.
- Plataforma: `/lol-chat/v1/me` → `platformId: "LA1"`.
  `/riotclient/region-locale` → `region: "LA1"`, `webRegion: "lan"`.
  `/lol-platform-config/v1/namespaces/LoginDataPacket/platformId` → **404**
  (la ruta que citan muchas librerías ya no existe).
- Gameflow: `/lol-gameflow/v1/gameflow-phase` → `"None"` fuera de partida;
  `/lol-gameflow/v1/session` → **404** sin partida. Los campos de la sesión en
  partida (`gameData.gameId`, `gameData.queue.id`) no se han podido ver con
  una partida real; `lcu.rs` los lee según su forma documentada.

## Endpoints del historial

| Ruta | Qué devuelve |
|------|--------------|
| `/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=20` | `{accountId, platformId, games: {gameCount, games[…]}}`. Cada partida con UN solo participante (el tuyo). `endIndex` es inclusivo: 0..20 dio 21. Pagina: 20..40 devolvió las siguientes. |
| `/lol-match-history/v1/games/{gameId}` | La partida completa, formato v4 (abajo). ~31 KB frente a ~78 KB de Match-V5. Sirve partidas fuera de la primera página (la del 29-08 incluida). |
| `/lol-match-history/v1/game-timelines/{gameId}` | `{frames: […]}` sin `frameInterval` ni metadatos. ~45-90 KB frente a ~600 KB. |

El `gameId` es el número del id de Match-V5 sin prefijo: `LA1_1746460303` ↔
`1746460303`, y `platformId` (en la partida y en cada `participantIdentities[].player`)
es el prefijo.

## Partida: `/lol-match-history/v1/games/{gameId}` ↔ `match-v5/matches/{id}`

### Cabecera (`info`)

| Match-V5 `info.*` | LCU | Igual en las 3 |
|---|---|---|
| `gameId`, `gameDuration` (s), `gameCreation` (ms), `queueId`, `platformId`, `gameVersion`, `mapId`, `gameMode`, `gameType` | mismo nombre en la raíz | sí |
| `gameStartTimestamp`, `gameEndTimestamp` | — (aproximable con `gameCreation` + `gameDuration`) | — |
| `gameName`, `tournamentCode` | — | — |
| — | `endOfGameResult` (`"GameComplete"`), `seasonId`, `gameModeMutators` | — |

`gameEndTimestamp` lo usa la forma de temporada (`SeasonGame.game_end_ms`).

### Equipos

| Match-V5 `teams[].*` | LCU `teams[].*` |
|---|---|
| `teamId` | `teamId` |
| `win` (bool) | `win` (`"Win"` / `"Fail"`, cadena) |
| `objectives.baron.kills` | `baronKills` |
| `objectives.dragon.kills` | `dragonKills` |
| `objectives.tower.kills` | `towerKills` |
| `objectives.riftHerald.kills` | `riftHeraldKills` |
| `objectives.inhibitor.kills` | `inhibitorKills` |
| `objectives.horde.kills` | `hordeKills` |
| `objectives.*.first` | `firstBaron`, `firstDargon` (sic, con la errata), `firstTower`, `firstInhibitor`, `firstBlood` |
| `objectives.atakhan`, `objectives.champion` | — |
| `bans[]` | `bans[]` (`championId`, `pickTurn`) |

### Participantes

En el LCU cada jugador está partido en dos listas que se cruzan por
`participantId`: `participants[]` (campeón, equipo, hechizos y `stats{…}` con
118 claves) y `participantIdentities[].player` (nombre, puuid). Match-V5 tiene
156 claves planas por jugador. 76 coinciden en nombre; en las tres partidas
**todas dan el mismo valor salvo `puuid` y `summonerId`**.

Campos que usa `ParticipantDto` (riot_api.rs):

| `ParticipantDto` | LCU | Notas |
|---|---|---|
| `kills`, `deaths`, `assists`, `goldEarned`, `totalDamageDealtToChampions`, `win`, `champLevel`, `totalMinionsKilled`, `neutralMinionsKilled`, `item0`‥`item6`, `visionScore`, `wardsPlaced`, `totalDamageTaken`, `damageSelfMitigated`, `totalHeal`, `timeCCingOthers`, `longestTimeSpentLiving`, `damageDealtToObjectives`, `damageDealtToTurrets`, `firstBloodKill`, `firstTowerKill`, `gameEndedInSurrender`, `teamEarlySurrendered` | `stats.<mismo nombre>` | iguales 10/10 en las tres |
| `teamId` | `participants[].teamId` | igual |
| `summoner1Id`, `summoner2Id` | `participants[].spell1Id`, `spell2Id` | iguales |
| `riotIdGameName`, `riotIdTagline` | `participantIdentities[].player.gameName`, `tagLine` | iguales |
| `summonerName` | `player.summonerName` | — |
| `puuid` | `player.puuid` | **distinto**: ver «Identidad» |
| `championName` | — | solo `championId`; hay que traducirlo con Data Dragon (la app ya lo cachea) |
| `teamPosition`, `individualPosition` | — | solo `timeline.lane` / `timeline.role` del formato viejo, y **mal**: en `LA1_1746460303` el top (Tryndamere) sale como `JUNGLE/NONE` |
| `totalAllyJungleMinionsKilled`, `totalEnemyJungleMinionsKilled` | `stats.neutralMinionsKilledTeamJungle`, `…EnemyJungle` | existen pero valen **0 siempre** (el jungla con 145 propios da 0) |
| `totalHealsOnTeammates`, `totalDamageShieldedOnTeammates`, `totalTimeSpentDead`, `turretTakedowns`, `objectivesStolen` | — | |
| los `*Pings` | — | |
| `challenges` | — | |
| — | `stats.perk0`‥`perk5` (+ `Var1-3`), `perkPrimaryStyle`, `perkSubStyle` | runas en el formato viejo; V5 las trae en `perks` |

## Timeline: `/lol-match-history/v1/game-timelines/{gameId}` ↔ `match-v5/…/timeline`

**Fotogramas: idénticos.** Mismo número de fotogramas (29, 17 y 35), mismos
`timestamp` (0, 60022, 120036…), y para cada jugador los mismos
`currentGold`, `totalGold`, `xp`, `level`, `minionsKilled`,
`jungleMinionsKilled` y `position`: 0 diferencias en 2030 + 1190 + 2450 valores.

Lo que le falta a cada fotograma de jugador: `championStats`, `damageStats`,
`goldPerSecond`, `timeEnemySpentControlled`. (El LCU añade `dominionScore` y
`teamScore`, a 0.)

**Sucesos: solo tres tipos.**

| Tipo | Match-V5 (`LA1_1746460303`) | LCU |
|---|---|---|
| `CHAMPION_KILL` | 41 | 41 — mismos `timestamp`, `killerId`, `victimId`, `assistingParticipantIds` y `position` |
| `ELITE_MONSTER_KILL` | 7 | 7 — mismos tiempos, `monsterType`, `monsterSubType` y `killerId` |
| `BUILDING_KILL` | 12 | 12 |
| `ITEM_PURCHASED` / `ITEM_SOLD` / `ITEM_UNDO` / `ITEM_DESTROYED` | 224 / 8 / 9 / 207 | — |
| `WARD_PLACED` / `WARD_KILL` | 171 / 50 | — |
| `SKILL_LEVEL_UP` / `LEVEL_UP` | 150 / 140 | — |
| `TURRET_PLATE_DESTROYED` | 50 | — |
| `CHAMPION_SPECIAL_KILL` | 4 | — |
| `DRAGON_SOUL_GIVEN`, `OBJECTIVE_BOUNTY_PRESTART`, `PAUSE_END`, `GAME_END` | 1 c/u | — |

Y en las muertes que sí están faltan `bounty`, `shutdownBounty`,
`killStreakLength`, `victimDamageDealt`, `victimDamageReceived` y los dos
`victimTeamfight*`. Las otras dos partidas dan el mismo patrón.

En el formato del LCU todos los sucesos llevan todas las claves, vacías cuando
no aplican (`"monsterType": ""`, `"itemId": 0`…): al leerlo, la cadena vacía
hay que tratarla como ausente.

## Qué módulo se queda sin qué

| Módulo | Necesita de Match-V5 | Sin clave |
|---|---|---|
| Scoreboard, resultado, KDA, objetivos (`to_participant`, `objectives_from`) | campos de participante y equipo | **sí**, salvo rol y nombre de campeón (Data Dragon) |
| Gráfica oro/XP, `minute_frames`, diferencias a min 15 | fotogramas | **sí**; el rival de línea, sin `teamPosition`, cae a la heurística de `rival_de_linea` (el del mismo puesto en la lista del otro equipo) |
| Marcadores de muertes y objetivos (parte de `process_timeline_full`) | `CHAMPION_KILL`, `ELITE_MONSTER_KILL`, `BUILDING_KILL` | **sí** |
| Compras de objetos (`item_purchases`), `gold.rs`, `jungle_route.rs`, `occupancy.rs` | `ITEM_PURCHASED`/`ITEM_SOLD` | no |
| Ganks (`gank.rs`) | `WARD_PLACED`, `teamPosition` | no |
| Atribución / WPA / MVP (`attribution.rs`, `winprob.rs`) | `victimDamageReceived`, `bounty`, `shutdownBounty`, placas, `GAME_END` | no |
| «Lo que te comes» (`spells.rs`, `golpes.rs`) | `victimDamageReceived`, `championStats` | no |
| Presión (`pressure.rs`, `pressure_value.rs`) | `bounty`, `damageStats`, placas | no |
| Baremos por rol (`baselines.rs`, `benchmarks.rs`) | `teamPosition` / `individualPosition` | no |
| Rango al jugar (league-v4) | otra API | no medido en el LCU |

## Identidad

El `puuid` del LCU no es el de Match-V5: la API de Riot devuelve el puuid
cifrado por clave de aplicación, y el cliente da el real. Los dos no se pueden
comparar. Para cruzar una partida del LCU con una de Match-V5 vale el
`participantId` (mismo orden en las dos) o `gameName#tagLine`; el puuid, no.

## Cómo repetir la medición

Con el cliente abierto, lo que hace `lcu.rs` en dos tests de solo lectura:

```bash
LCU_EN_VIVO=1 cargo test --lib lcu::tests::en_vivo -- --nocapture
RIOT_EN_VIVO=LA1_1746460303 cargo test --lib tests_id_exacto::en_vivo -- --nocapture
```

La comparación campo a campo se hizo con un script aparte que pedía
`/lol-match-history/v1/games/{id}` y `/game-timelines/{id}` y las cruzaba con
los `riot_*.json` de la carpeta de cada partida; no está en el repositorio.
