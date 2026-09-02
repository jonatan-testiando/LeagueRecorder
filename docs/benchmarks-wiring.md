# Cómo enchufar `benchmarks.rs`

Nota para quien integre el módulo. El módulo ya está medido, probado y no
depende de nada del crate salvo `serde` (y `serde_json` + `flate2` en las
pruebas, que ya son dependencias). Falta declararlo y escribir el comando.

## 1. Declararlo en `lib.rs`

Una línea, justo detrás de `mod baselines;` (la lista está en orden alfabético
en ese tramo):

```rust
mod benchmarks;
```

Nada más. El módulo no toca estado global ni el `AppHandle`.

## 2. El comando

```rust
/// Compara las métricas de una partida contra la población de su rango y
/// puesto: "un jungla de tu rango hace 6,2 de CS por minuto; tú hiciste 4,8".
#[tauri::command]
pub fn get_match_benchmarks(
    match_id: String,
) -> Result<Vec<crate::benchmarks::MetricComparison>, String> {
    // ...
}
```

`MetricComparison` ya deriva `Serialize`, así que llega al front como
`{ metric, value, percentile, median, lower_is_better }`. `percentile` es
`Option<u8>` (0..100) y `median` es `Option<f64>`; los dos vienen a `null`
cuando la métrica no está en el baremo, para que la UI pueda enseñar el valor
crudo igualmente.

**`lower_is_better` no está aplicado.** El percentil es siempre crudo: en
`deaths_per_game` un 90 significa "mueres más que el 90%", que es malo. La
inversión la hace la UI (`100 - percentile`, o pintar el arco al revés). Se dejó
así a propósito para que el signo se vea en el sitio donde se pinta y no quede
escondido dentro de una tabla.

## 3. El tramo: usar `tier_bucket`, no `rank_tier`

`MatchMetadata` **ya trae el tramo calculado** en `tier_bucket:
Option<String>` (`"bajo"` / `"medio"` / `"alto"`), que es exactamente lo que
espera el parámetro `band`. Lo rellenan `riot_api::sync` y
`spawn_impact_backfill` con `RiotApiClient::tramo_de`, y es el mismo campo que
usa `baselines::percentil_en_tramo`.

```rust
let band = metadata.tier_bucket.as_deref();          // None = partida sin rango
crate::benchmarks::compare_all(band, &yo.role, &valores)
```

`benchmarks::band_for_tier("EMERALD")` sólo hace falta si en algún sitio se
tiene el rango crudo (`rank_tier`) y no el bucket. Dos avisos:

- Devuelve `""` para un rango desconocido, y `percentile` trata `Some("")`
  igual que `None` (cae al baremo del puesto). `RiotApiClient::tramo_de`, en
  cambio, mete cualquier rango desconocido en `"alto"` por su `_ =>`; si alguna
  vez se le pasa un tier vacío, `tier_bucket` mentirá. No lo he tocado.
- **El Oro va en `medio`**, no en `bajo`. Es la definición de
  `tools/corpus/fetch_tiers.py`, que es la que etiquetó el corpus con el que se
  midieron las constantes. Si se cambia, hay que cambiarla en los tres sitios
  (`fetch_tiers.py`, `benchmarks::band_for_tier`, `RiotApiClient::tramo_de`) y
  volver a medir.

Perder el tramo degrada pero no invalida: el efecto del puesto sobre estas
métricas es mucho mayor que el del rango.

## 4. De dónde sale cada métrica

El puesto es `Participant.role` del jugador con `is_self` (`riot_api.rs` lo
llena con `rol_de(p)`). Ojo: `rol_de` cae a `individualPosition` cuando
`teamPosition` viene vacío, mientras que el corpus sólo contó `teamPosition`;
son cuatro partidas raras de cada mil, pero el dato no es idéntico.

`dur = metadata.game_duration / 60.0` es el denominador de todas las tasas —el
mismo que usa Riot en sus `challenges`, comprobado.

### Lo que ya está en `MatchMetadata` (sin abrir ficheros)

| clave del baremo | de dónde |
|---|---|
| `cs_per_min` | `yo.cs / dur` (`Participant.cs` ya es `totalMinionsKilled + neutralMinionsKilled`) |
| `deaths_per_game` | `yo.deaths` |
| `kda` | `(yo.kills + yo.assists) / max(1, yo.deaths)` — **no** el campo `MatchMetadata.kda`, que es la cadena `"K/D/A"` |
| `gold_per_min` | `yo.gold / dur` |
| `damage_per_min` | `yo.damage / dur` |
| `damage_share` | `yo.damage` partido por la suma de `damage` de los 5 con mi mismo `team_id` |
| `vision_score_per_min` | `yo.vision_score / dur` |
| `wards_per_min` | `yo.wards_placed / dur` |
| `kills_per_game` | `yo.kills` |
| `assists_per_game` | `yo.assists` |
| `kill_participation` | `(yo.kills + yo.assists) / kills del equipo`, sumando `participants` del mismo `team_id`. Es una reconstrucción: el corpus usó `challenges.killParticipation` de Riot, que cuenta igual pero redondea distinto |
| `gold_diff_15` | `metadata.gold_diff_15` (`Option<i32>`) — ya se calcula contra el rival de línea y con la misma ventana de frame (870-930 s) que el corpus |
| `xp_diff_15` | `metadata.xp_diff_15` |

### Lo que exige el DTO crudo

`crate::storage::load_raw_match(&match_id)` devuelve el `riot_match.json`
cacheado, que es el **DTO de match tal cual** (`mt["info"]["participants"]`, sin
el envoltorio `{"match":…, "timeline":…}` que llevan los `.json.gz` del corpus).
Se parsea a `Vec<ParticipantDto>`, que ya trae `damageDealtToTurrets` y el bloque
`challenges` entero como `serde_json::Value`.

| clave del baremo | de dónde |
|---|---|
| `turret_damage_per_min` | `ParticipantDto.damageDealtToTurrets / dur` |
| `control_wards` | `challenges["controlWardsPlaced"]` |
| `solo_kills` | `challenges["soloKills"]` |
| `kill_participation` | `challenges["killParticipation"]` — preferir ésta a la reconstrucción de arriba, es la que se midió |
| `cs_diff_15` | **no está cacheado**. Ver abajo |

### `cs_diff_15` es el único que hay que calcular

`MatchMetadata` guarda `jungle_cs_diff_15`, que es sólo la parte de jungla;
`MinuteFrameDto` tampoco lleva CS (sólo oro, XP y jungla). El baremo mide
`(minionsKilled + jungleMinionsKilled)` propio menos el del rival de línea en el
frame de minuto 15.

Dos salidas, por orden de pereza:

1. Abrir `crate::storage::load_raw_timeline(&match_id)`, coger el frame con
   `timestamp` entre 870.000 y 930.000 (`riot_api.rs` ya lo hace así) y restar
   `minionsKilled + jungleMinionsKilled` entre el jugador y el rival — el rival
   de línea es el del mismo `teamPosition` en el otro equipo, y sólo vale si es
   uno solo.
2. Omitir la métrica: `compare_all` acepta una lista más corta sin quejarse.

Si acaba haciéndose la opción 1, lo suyo sería que `analizar_timeline` guardara
`cs_diff_15` en el metadata como hace con los otros dos, y así el comando no
tendría que abrir la timeline. Eso toca `riot_api.rs` y `storage.rs`, que no
eran míos.

## 5. Ejemplo de armado

```rust
let mut valores: Vec<(&str, f64)> = vec![
    ("cs_per_min", yo.cs as f64 / dur),
    ("deaths_per_game", yo.deaths as f64),
    // …
];
if let Some(g) = metadata.gold_diff_15 {
    valores.push(("gold_diff_15", g as f64));
}
Ok(crate::benchmarks::compare_all(band, &yo.role, &valores))
```

Las claves válidas están en `benchmarks::METRICAS` (17). Una clave que no exista
no revienta: sale en la lista con `percentile` y `median` a `null`.

## 6. Volver a medir

```
python tools/corpus/fit_benchmarks.py --corpus D:/lol-corpus     # ~40 s
CORPUS_DIR=D:/lol-corpus cargo test --release --lib benchmarks::tests
```

La prueba `recalcular_desde_corpus` rehace los deciles desde el corpus y falla
si algún corte se ha movido más de 1e-3, imprimiendo la tabla nueva lista para
pegar. Es la misma disciplina que `baselines.rs`. Las otras diez pruebas del
módulo corren sin corpus y son instantáneas.

Aviso para el que las toque: el script de Python y la prueba de Rust calculan lo
mismo dos veces (mismo filtro de 900 s, mismo frame de minuto 15, mismo índice
de decil sin interpolar). Es a propósito —que cuadren es la comprobación— pero
significa que si se cambia una métrica hay que cambiarla en los dos sitios.
