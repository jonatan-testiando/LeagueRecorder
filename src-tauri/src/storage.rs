use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Un suceso de la partida.
///
/// `description` es texto ya montado y en español: es lo que se guardaba antes y
/// lo que llevan todas las partidas grabadas hasta ahora, así que se conserva
/// para no romperlas. Los campos estructurados de abajo son los que se rellenan
/// a partir de ahora, y permiten que sea el frontend quien componga la frase —
/// en el idioma que sea— en vez de recibirla ya escrita desde aquí.
///
/// Todos son `Option` y se omiten al serializar si están vacíos: un JSON viejo
/// deserializa sin tocar nada y uno nuevo no engorda con nulls.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchEvent {
    pub r#type: String,
    pub subtype: Option<String>,
    pub time: f64,
    /// Frase ya montada. Legado: solo se usa si no hay campos estructurados.
    pub description: String,

    /// Quién lo hizo (nombre de invocador, sin tag).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    /// Sobre quién o qué.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// Matiz: tipo de dragón, tamaño de la racha, "stolen"…
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl MatchEvent {
    /// Constructor para los sucesos que no llevan datos estructurados
    /// (arranque de partida, ultimates, marcas del analizador…).
    pub fn plain(ty: &str, subtype: Option<&str>, time: f64, description: String) -> Self {
        MatchEvent {
            r#type: ty.to_string(),
            subtype: subtype.map(|s| s.to_string()),
            time,
            description,
            actor: None,
            target: None,
            detail: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MouseEventData {
    pub t: f64,
    pub x: f64,
    pub y: f64,
    pub evt: String,
}

/// Comentario del usuario anclado a una marca de tiempo del vídeo.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comment {
    pub time: f64,
    pub text: String,
}

/// Un jugador de la partida (scoreboard, de la API Match-V5 de Riot).
// `Default`, como `MatchMetadata`, para los jugadores de mentira de los tests.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Participant {
    pub champion: String,
    pub name: String,
    pub team_id: i32, // 100 = azul, 200 = rojo
    pub win: bool,
    pub level: i32,
    pub kills: i32,
    pub deaths: i32,
    pub assists: i32,
    pub cs: i32,
    pub gold: i32,
    pub is_self: bool,
    #[serde(default)]
    pub items: Vec<i32>, // item0..item6 (0 = casilla vacía)
    /// Hechizos de invocador [summoner1Id, summoner2Id]. Vacío en partidas
    /// guardadas antes de existir el campo; el backfill de arranque lo rellena.
    #[serde(default)]
    pub spells: Vec<i32>,
    /// El "#KR2" del riot id. Vacío en partidas viejas hasta que el backfill
    /// lo repone del DTO cacheado.
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub damage: i32, // daño a campeones
    #[serde(default)]
    pub vision_score: i32,
    #[serde(default)]
    pub wards_placed: i32,
    /// Puesto: "TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY". Vacío en partidas
    /// guardadas antes de existir el campo; el backfill de arranque lo repone del
    /// DTO cacheado, igual que los hechizos.
    #[serde(default)]
    pub role: String,
}

/// Objetivos conseguidos por un equipo (panel Objectives estilo Ascent).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamObjectives {
    pub team_id: i32, // 100 = azul, 200 = rojo
    pub win: bool,
    pub dragons: i32,
    pub barons: i32,
    pub towers: i32,
    pub heralds: i32,
    pub inhibitors: i32,
}

/// Compra de un item por el jugador, con el segundo de partida en que ocurrió.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemPurchase {
    pub time: f64, // segundos de partida
    pub item_id: i32,
}

/// Marcador de evento en la línea de tiempo del vídeo (de la Timeline v5 de Riot).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TimelineMarker {
    pub time: f64, // segundos en el vídeo
    pub event_type: String, // "kill", "assist", "death", "dragon", "herald", "baron", "grubs", "atakhan", "tower", "plate", "gank_attempt"
    pub description: String,
    #[serde(default)]
    pub position_x: Option<i32>,
    #[serde(default)]
    pub position_y: Option<i32>,
    // Sólo para "gank_attempt": el backend ya resuelve carril, resultado y
    // ángulo de entrada (ver `crate::gank`) para que la UI no vuelva a
    // deducirlos de las coordenadas —que es donde estaba el error—.
    /// "top" | "mid" | "bot"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane: Option<String>,
    /// "success" | "neutral" | "failed"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    /// 0..1. Cuánto se fía el detector de este gank.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    /// Incertidumbre del instante, en segundos. 0 = anclado a un evento exacto.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_precision: Option<f64>,
    /// "flank" (le cortas la retirada) | "front" (entrada directa)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approach: Option<String>,
}

/// Fotograma minuto a minuto de la partida (Timeline v5) para la gráfica de oro/XP
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MinuteFrameDto {
    pub minute: i32,
    pub team_gold_diff: i32,
    pub self_gold_diff: i32,
    pub self_xp_diff: i32,
    pub self_jungle_cs_diff: i32,
}

// `Default` para poder construir una partida de mentira en un test citando sólo
// los campos que importan, en vez de rellenar los treinta a mano.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MatchMetadata {
    pub id: String,
    pub game_duration: f64,
    pub video_path: String,
    pub result: String,
    pub champion: String,
    pub date: String,
    pub events: Vec<MatchEvent>,
    /// Acciones por minuto promedio (teclas + clics) durante la partida.
    #[serde(default)]
    pub apm: f64,
    /// APM por minuto de juego (para el gráfico tipo Outplayed).
    #[serde(default)]
    pub apm_series: Vec<f64>,
    /// Movimientos, clics y teclas del ratón: la estela.
    ///
    /// Vive en `estela.bin` (ver `crate::estela`), NO en el JSON: nunca se
    /// serializa, ni al disco ni al frontend (que la pide en binario con
    /// `get_match_trail`). Solo se lee aquí para las partidas guardadas antes
    /// de la separación, que la llevan dentro; la migración del arranque las
    /// pasa a su fichero. Ver [`sin_estela`] para el porqué del
    /// `deserialize_with`. La rellenan `load_match_by_id` y
    /// `get_match_metadata_con_estela`.
    #[serde(default, deserialize_with = "estela", skip_serializing)]
    pub mouse_events: Vec<MouseEventData>,
    /// Resolución del escritorio en la que se capturaron `mouse_events`.
    ///
    /// Imprescindible para dibujar la estela: `rdev` da coordenadas de PANTALLA, no
    /// del vídeo, y grabar 1080p en un monitor 1440p desplazaba el trazo un 33%.
    /// 0 = partida antigua sin este dato (el reproductor tira de heurística).
    #[serde(default)]
    pub mouse_space_w: u32,
    #[serde(default)]
    pub mouse_space_h: u32,
    /// Los ajustes del HUD de League al empezar la partida (tamaño y lado del
    /// minimapa, sobre todo). De aquí sale el rectángulo del minimapa con el
    /// que se analizan los clics: ver `camera_input::Calibracion`. `None` en
    /// las partidas grabadas antes de leerlos y en los VODs importados.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hud_settings: Option<crate::ajustes_juego::HudSettings>,
    /// API de Riot: ID real de la partida en el servidor
    #[serde(default)]
    pub riot_match_id: Option<String>,
    /// API de Riot: KDA (Kills/Deaths/Assists) en formato "K/D/A"
    #[serde(default)]
    pub kda: Option<String>,
    /// API de Riot: Oro total ganado
    #[serde(default)]
    pub gold_earned: Option<i32>,
    /// API de Riot: Daño total infligido a campeones
    #[serde(default)]
    pub damage_dealt: Option<i32>,
    /// API de Riot: los 10 jugadores (scoreboard). Vacío hasta sincronizar con Riot.
    #[serde(default)]
    pub participants: Vec<Participant>,
    /// API de Riot: queueId (420=clasif solo, 440=flex, 400/430=normal, 450=ARAM, 0=personalizada…).
    #[serde(default)]
    pub queue: Option<i32>,
    /// API de Riot: objetivos por equipo (dragones, barones, torres…).
    #[serde(default)]
    pub objectives: Vec<TeamObjectives>,
    /// API de Riot (timeline): compras de items del jugador con su minuto.
    #[serde(default)]
    pub item_purchases: Vec<ItemPurchase>,
    /// API de Riot (timeline): métricas avanzadas a min 15
    #[serde(default)]
    pub gold_diff_15: Option<i32>,
    #[serde(default)]
    pub xp_diff_15: Option<i32>,
    #[serde(default)]
    pub jungle_cs_diff_15: Option<i32>,
    /// CS TOTAL (súbditos + jungla) de ventaja sobre el rival de línea a min 15.
    ///
    /// Distinto de `jungle_cs_diff_15`, que sólo cuenta campamentos. Es el que
    /// pide el baremo de población (`crate::benchmarks`). Las partidas
    /// sincronizadas antes de que existiera el campo lo traen a `None`: se
    /// rellena a posteriori desde la timeline cacheada la primera vez que se
    /// piden sus baremos.
    #[serde(default)]
    pub cs_diff_15: Option<i32>,
    #[serde(default)]
    pub gank_impact_15: Option<f64>,
    #[serde(default)]
    pub lane_result: Option<String>,
    /// En qué puesto quedaste de los 10 por impacto (1 = el mejor de la partida).
    ///
    /// Se guarda porque la lista de partidas no puede recalcularlo al vuelo:
    /// necesita la timeline completa. Lo rellenan la sincronización, la pestaña
    /// de Impacto y `riot_api::impact_backfill` al arrancar (esta última
    /// sólo con los `riot_*.json` ya cacheados, sin gastar cuota de la API).
    /// Antes lo escribía únicamente la pestaña, así que la columna de la
    /// biblioteca eran rayas hasta que entrabas partida por partida.
    #[serde(default)]
    pub impact_rank: Option<i32>,
    /// Percentil de tu WPA dentro de tu rol, de 0 a 100. Ver `crate::baselines`.
    #[serde(default)]
    pub impact_percentile: Option<f64>,
    /// Versión del barrido de impacto que ya repasó esta partida.
    ///
    /// El sello es lo que hace que el barrido del arranque no vuelva a abrir
    /// dos JSON de varios megas por partida en cada lanzamiento. Antes el
    /// criterio era "¿le falta algún campo?", que para una partida a la que el
    /// DTO cacheado tampoco puede completar es cierto para siempre.
    #[serde(default)]
    pub impact_backfill_v: u32,
    /// Parche en que se jugó ("16.13"). De `info.gameVersion` de Riot.
    #[serde(default)]
    pub patch: Option<String>,
    /// Tramo de rango en que se jugó: "bajo", "medio" o "alto".
    ///
    /// Hace falta para comparar contra el baremo correcto — el percentil de un
    /// support cambia según el nivel de la partida. Se pide una vez al
    /// sincronizar y se guarda, porque el rango del jugador puede cambiar
    /// después y lo que importa es el que tenía al jugarla.
    #[serde(default)]
    pub tier_bucket: Option<String>,
    /// Rango exacto al jugarla: "MASTER", "EMERALD"... (league-v4, solo/dúo).
    #[serde(default)]
    pub rank_tier: Option<String>,
    /// División dentro del rango ("I".."IV"; en Master+ Riot devuelve "I").
    #[serde(default)]
    pub rank_division: Option<String>,
    /// LP al sincronizar (justo tras la partida): la resta entre partidas
    /// consecutivas es lo que ganaste o perdiste en cada una.
    #[serde(default)]
    pub rank_lp: Option<i32>,
    /// Marcadores de eventos para la barra del reproductor de vídeo
    #[serde(default)]
    pub timeline_markers: Vec<TimelineMarker>,
    /// Fotogramas minuto a minuto para la gráfica de oro/XP
    #[serde(default)]
    pub minute_frames: Vec<MinuteFrameDto>,
    /// Comentarios del usuario anclados a marcas de tiempo del vídeo.
    #[serde(default)]
    pub comments: Vec<Comment>,
    /// Segundos de los momentos ya revisados, para la cola de revisión.
    ///
    /// Vive aquí y NO dentro de `events[]` a propósito: la lista de sucesos la
    /// reescriben varias rutas (sincronización con Riot, realineado, análisis),
    /// así que cualquier estado del usuario metido ahí dentro es carne de
    /// cañón — se pierde en silencio la próxima vez que algo regenere eventos.
    /// Una lista propia no la toca nadie más.
    #[serde(default)]
    pub reviewed_moments: Vec<f64>,
    /// True si es un VOD importado/analizado (no una partida propia grabada).
    /// Permite a la UI ocultar el panel de Victoria/Derrota, que no aplica.
    #[serde(default)]
    pub is_vod: bool,
    /// Segundos de vídeo en que la cámara dio un salto (tecla de cámara aliada),
    /// detectados por `camera_snaps.py`. Vacío hasta que se analiza la partida.
    #[serde(default)]
    pub camera_snaps: Vec<f64>,
    /// Segundos de vídeo que hay ANTES del 0:00 del reloj de la partida (la pantalla
    /// de carga, que sí se graba). Es lo que convierte tiempo de partida en tiempo de
    /// vídeo: `t_vídeo = t_partida + video_offset`. Negativo si la grabación arrancó
    /// con la partida ya empezada. `None` = grabación antigua, sin medir: al abrirla,
    /// `realign_to_video_time` lo estima y reescribe el fichero.
    #[serde(default)]
    pub video_offset: Option<f64>,
    /// `gameId` de la partida según el cliente de League (LCU), sin plataforma.
    /// Con `platform_id` forma el id de Match-V5 (`LA1_1746460303`), que es lo
    /// que usa la sincronización con Riot en vez de emparejar por duración.
    /// `None` en partidas viejas, VODs, grabaciones manuales o si el cliente no
    /// contestó.
    #[serde(default)]
    pub game_id: Option<i64>,
    /// Plataforma del cliente al jugarla ("LA1", "EUW1"). Ver `game_id`.
    #[serde(default)]
    pub platform_id: Option<String>,
}

thread_local! {
    /// Si la deserialización en curso debe saltarse la estela del ratón.
    static SALTAR_ESTELA: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Deserializa `MatchMetadata` sin materializar `mouse_events`.
///
/// La biblioteca se relista en cada refresco (y el refresco es periódico), y
/// listar diecinueve partidas obligaba a construir cientos de miles de
/// `MouseEventData` que acto seguido se tiraban: `get_recorded_matches` los
/// vaciaba **después** de haberlos parseado. Lo mismo hacían los tres barridos
/// del arranque, `get_pressure_summary` y los agregados de Patrones.
///
/// Con esto el parser los recorre como `IgnoredAny` —sigue leyendo los tokens,
/// pero no reserva ni construye nada— y el campo queda vacío, que es
/// exactamente lo que esos caminos querían. Quien SÍ necesita la estela
/// (`load_match_by_id`, y con él el reproductor) llama fuera de este ámbito y
/// la recibe entera.
///
/// El interruptor es un `thread_local` y no un parámetro porque serde no deja
/// pasar contexto a un `Deserialize` derivado; el ámbito se abre y se cierra en
/// esta misma función, así que no puede quedarse encendido.
fn sin_estela<T>(f: impl FnOnce() -> T) -> T {
    SALTAR_ESTELA.with(|s| s.set(true));
    let r = f();
    SALTAR_ESTELA.with(|s| s.set(false));
    r
}

fn estela<'de, D>(d: D) -> Result<Vec<MouseEventData>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    if SALTAR_ESTELA.with(|s| s.get()) {
        serde::de::IgnoredAny::deserialize(d)?;
        return Ok(Vec::new());
    }
    Vec::<MouseEventData>::deserialize(d)
}

/// Tope de cordura para el desfase vídeo↔partida. Cualquier estimación fuera de este
/// margen es basura (metadatos corruptos, vídeo recortado a mano…) y se descarta.
const MAX_VIDEO_OFFSET_SECS: f64 = 600.0;

/// Pasa a tiempo de vídeo lo que una grabación antigua guardó en tiempo de partida.
///
/// Hasta ahora los marcadores de la Timeline de Riot se guardaban tal cual (tiempo de
/// partida) y el desfase de los eventos en directo se fijaba durante la pantalla de
/// carga, cuando el reloj de la API todavía está clavado en 0. Resultado: las marcas
/// salían adelantadas en la línea de tiempo hasta ~2 minutos respecto al vídeo.
///
/// Como el vídeo termina justo con la partida, el desfase se puede reconstruir a
/// posteriori: `video_offset ≈ duración_del_vídeo − instante_del_GameEnd_en_la_partida`.
/// Para saber en qué tiempo estaban ya los eventos en directo se compara cada kill/muerte
/// suya con su marcador de Riot equivalente (la mediana de esa diferencia es el desfase
/// que se les aplicó al grabar).
///
/// Devuelve `true` si ha tocado algo (entonces conviene reescribir el JSON).
pub fn realign_to_video_time(m: &mut MatchMetadata) -> bool {
    if m.video_offset.is_some() || m.is_vod {
        return false;
    }

    // Sin marcadores de Riot no hay nada desalineado que arreglar ni con qué estimar.
    let marker_times: Vec<f64> = m
        .timeline_markers
        .iter()
        .filter(|t| t.event_type == "kill" || t.event_type == "assist" || t.event_type == "death")
        .map(|t| t.time)
        .collect();
    if marker_times.is_empty() {
        return false;
    }

    // El GameEnd de la API viene en tiempo de partida; el de respaldo ("Grabación
    // finalizada", que se inventa cuando el juego se cierra a lo bruto) ya es de vídeo.
    // Se distingue por `subtype`, no por el texto. Esto comparaba la descripción
    // contra la cadena "Grabación finalizada", asi que en cuanto esa frase cambió
    // de idioma la condición dejó de cumplirse en silencio: un acoplamiento a
    // texto legible dentro de la lógica de alineación.
    //
    // Las partidas viejas no llevan el subtype, de ahi que se siga aceptando la
    // frase antigua como respaldo.
    let is_fallback_end = |e: &MatchEvent| {
        e.subtype.as_deref() == Some("recording") || e.description == "Grabación finalizada"
    };
    let game_end = m
        .events
        .iter()
        .find(|e| e.r#type == "GameEnd" && !is_fallback_end(e))
        .map(|e| e.time);
    let game_end = match game_end {
        Some(t) => t,
        None => return false,
    };

    // Desfase que ya llevan los eventos en directo, por emparejamiento con Riot.
    let mut diffs: Vec<f64> = Vec::new();
    for ev in m.events.iter().filter(|e| e.r#type == "ChampionKill") {
        let nearest = marker_times
            .iter()
            .map(|t| ev.time - t)
            .min_by(|a, b| a.abs().total_cmp(&b.abs()));
        if let Some(d) = nearest {
            if d.abs() <= 60.0 {
                diffs.push(d);
            }
        }
    }
    if diffs.is_empty() {
        return false;
    }
    diffs.sort_by(|a, b| a.total_cmp(b));
    let live_offset = diffs[diffs.len() / 2];

    let offset = m.game_duration - (game_end - live_offset);
    if !offset.is_finite() || offset.abs() > MAX_VIDEO_OFFSET_SECS {
        return false;
    }

    for ev in m.events.iter_mut() {
        // El GameStart inicial se apuntó al empezar a grabar: ya está en tiempo de vídeo.
        if ev.r#type == "GameStart" {
            continue;
        }
        ev.time = (ev.time - live_offset + offset).max(0.0);
    }
    for mk in m.timeline_markers.iter_mut() {
        mk.time = (mk.time + offset).max(0.0);
    }
    for ip in m.item_purchases.iter_mut() {
        ip.time = (ip.time + offset).max(0.0);
    }
    m.apm_series = shift_apm_series(&m.apm_series, m.game_duration, offset);
    m.video_offset = Some(offset);
    true
}

/// Reinterpreta la curva de APM —muestreada en tiempo de partida sobre `duration`—
/// como curva sobre la línea del vídeo. El tramo de carga queda a 0, que es lo que
/// había: la cuenta de acciones no empieza hasta que arranca la partida.
fn shift_apm_series(series: &[f64], duration: f64, offset: f64) -> Vec<f64> {
    if series.len() < 2 || duration <= 0.0 {
        return series.to_vec();
    }
    let n = series.len();
    let at_game_time = |t: f64| -> f64 {
        if t <= 0.0 {
            return 0.0;
        }
        let pos = t / duration * (n - 1) as f64;
        if pos >= (n - 1) as f64 {
            return series[n - 1];
        }
        let i = pos.floor() as usize;
        let frac = pos - i as f64;
        series[i] + (series[i + 1] - series[i]) * frac
    };
    (0..n)
        .map(|i| {
            let video_t = duration * i as f64 / (n - 1) as f64;
            at_game_time(video_t - offset)
        })
        .collect()
}

/// Suelo de la cuota de disco. Cualquier valor por debajo se ignora: un 0 aquí
/// significaría "borra todas las grabaciones".
pub const MIN_STORAGE_GB: u64 = 10;

fn default_max_storage() -> u64 { 100 }
/// Factor heredado del minimapa: 1.0 = el rectángulo validado tal cual. Ver
/// `AppConfig::minimap_scale`.
fn default_minimap_scale() -> f64 { 1.0 }
/// 0 = borrado por edad DESACTIVADO. Es el valor que heredan las configuraciones
/// ya guardadas, que no traen el campo: actualizar la app nunca debe empezar a
/// borrar grabaciones que el usuario no ha pedido borrar.
fn default_auto_prune() -> u32 { 0 }
/// "auto" = la plataforma se sondea la primera vez y se recuerda en
/// `riot_platform_detected`. Cualquier otro valor es una plataforma fijada a
/// mano en Ajustes y manda sobre lo detectado.
fn default_riot_platform() -> String { "auto".to_string() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub save_directory: String,
    #[serde(default)]
    pub riot_api_key: String,
    #[serde(default)]
    pub auto_dataset_generator: bool,
    #[serde(default = "default_max_storage")]
    pub max_storage_gb: u64,
    #[serde(default = "default_auto_prune")]
    pub auto_prune_days: u32,
    /// Idioma de la interfaz: "en" o "es".
    ///
    /// Vive en la config de disco y no en localStorage porque tiene que
    /// sobrevivir a cerrar la app del todo, no solo a recargar la ventana.
    #[serde(default = "default_language")]
    pub language: String,
    /// Tema de la interfaz: "dark", "light" o "system". Vive en disco por la
    /// misma razón que el idioma: tiene que sobrevivir a cerrar la app.
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Tamaño de la interfaz (el zoom del WebView): 0 = automático según la
    /// pantalla, o el factor elegido en Ajustes. Ver `escala.rs`.
    #[serde(default)]
    pub ui_scale: f64,
    /// HEREDADO. Tamaño del minimapa respecto al rectángulo validado (1.0),
    /// de cuando era la única calibración. Ya no sale en Ajustes; sólo lo usan
    /// las partidas grabadas antes de leer los ajustes del juego, que así se
    /// quedan como estaban. Ver `camera_input::rect_heredado`.
    #[serde(default = "default_minimap_scale")]
    pub minimap_scale: f64,
    /// `MinimapScale` de League puesto a mano (0 a 3), o `None` para usar el
    /// que se lee del juego en cada partida. Es la salida de emergencia por si
    /// la detección falla: manda sobre lo detectado en TODAS las partidas,
    /// también en las antiguas.
    #[serde(default)]
    pub minimap_scale_override: Option<f64>,
    /// Plataforma de Riot del jugador ("la1", "euw1", "kr"…) o "auto".
    ///
    /// La app nació clavada en LAN: quien juega fuera de América no recibía
    /// NADA de Riot y sin un mensaje que lo explicara. Ver
    /// `riot_api::regional_route` para el mapa plataforma → ruta regional.
    #[serde(default = "default_riot_platform")]
    pub riot_platform: String,
    /// Plataforma averiguada sondeando match-v5 con "auto". Se guarda para que
    /// el sondeo (cuatro peticiones) ocurra una sola vez.
    #[serde(default)]
    pub riot_platform_detected: String,
    /// Proxy propio que pone la clave de Riot por el usuario. Vacío = cada uno
    /// usa la suya. Ver `server/riot-proxy`.
    #[serde(default)]
    pub riot_proxy_url: String,
    /// Si el asistente de primer arranque ya se completó.
    #[serde(default)]
    pub onboarding_done: bool,
    /// Carpeta espejo donde se copia el metadata de cada partida al guardarlo.
    ///
    /// Vacío = desactivado. Apuntándolo a una carpeta de OneDrive, Google Drive
    /// o Dropbox se obtiene sincronización en la nube gratis: lo que pesa son
    /// los vídeos, y esos NO se copian — el espejo lleva sólo los JSON (notas,
    /// comentarios, momentos revisados, marcas de error), que son lo
    /// irreemplazable y ocupan kilobytes.
    ///
    /// La copia es síncrona y best-effort: si falla se anota en el log y el
    /// guardado local sigue siendo un éxito. Un disco de red caído no puede
    /// convertir "guardar un comentario" en un error.
    #[serde(default)]
    pub backup_mirror_dir: String,
}

fn default_language() -> String {
    "en".to_string()
}

fn default_theme() -> String {
    "dark".to_string()
}

impl Default for AppConfig {
    fn default() -> Self {
        let user_profile = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:".to_string());
        let default_dir = Path::new(&user_profile)
            .join("Videos")
            .join("LeagueRecorder")
            .to_string_lossy()
            .to_string();
        Self {
            save_directory: default_dir,
            riot_api_key: String::new(),
            auto_dataset_generator: false,
            max_storage_gb: 100,
            // Opt-in, también en instalaciones nuevas: ver `default_auto_prune`.
            auto_prune_days: 0,
            language: "en".to_string(),
            theme: "dark".to_string(),
            ui_scale: 0.0,
            minimap_scale: 1.0,
            minimap_scale_override: None,
            riot_platform: "auto".to_string(),
            riot_platform_detected: String::new(),
            riot_proxy_url: String::new(),
            onboarding_done: false,
            backup_mirror_dir: String::new(),
        }
    }
}

pub fn get_config_path() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| "C:".to_string());
    let dir = Path::new(&appdata).join("LeagueRecorder");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir.join("config.json")
}

/// La config ya leída, con la ruta de la que salió.
///
/// `load_config` se llama en cada `get_videos_dir()`, es decir, en cada
/// `get_match_dir`, en cada petición de rango del vídeo y en cada guardado:
/// releer y parsear el fichero cada vez era trabajo tirado. Solo `save_config`
/// escribe el fichero, así que basta con refrescar la copia ahí. La ruta va en
/// la clave porque `APPDATA` puede cambiar en los tests y en el banco de medidas.
static CONFIG: std::sync::RwLock<Option<(PathBuf, AppConfig)>> = std::sync::RwLock::new(None);

pub fn load_config() -> AppConfig {
    let ruta = get_config_path();
    if let Ok(g) = CONFIG.read() {
        if let Some((r, cfg)) = g.as_ref() {
            if *r == ruta {
                return cfg.clone();
            }
        }
    }
    let cfg: AppConfig = fs::read_to_string(&ruta)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();
    if let Ok(mut g) = CONFIG.write() {
        *g = Some((ruta, cfg.clone()));
    }
    cfg
}

/// Guarda la config. Devuelve el error en vez de tragárselo: antes un disco
/// lleno o un fichero en solo lectura dejaba a la UI diciendo "guardado" y al
/// reabrir la app los ajustes eran los viejos, sin ninguna pista de por qué.
pub fn save_config(cfg: &AppConfig) -> Result<(), String> {
    let content = serde_json::to_string_pretty(cfg)
        .map_err(|e| format!("Could not serialize the settings: {e}"))?;
    let ruta = get_config_path();
    escribir_atomico(&ruta, content.as_bytes())
        .map_err(|e| format!("Could not write the settings file: {e}"))?;
    if let Ok(mut g) = CONFIG.write() {
        *g = Some((ruta, cfg.clone()));
    }
    Ok(())
}

/// Escribe un fichero sin dejarlo nunca a medias.
///
/// `fs::write` trunca y luego escribe: si la app se cierra en medio (o se va la
/// luz), queda un JSON cortado y con él las notas del usuario. Aquí se escribe
/// a un temporal al lado y se renombra encima, que en NTFS es atómico.
///
/// Si el renombrado falla (otro proceso tiene el destino abierto sin permitir
/// borrarlo: un antivirus, el sidecar de Python leyéndolo) se cae a la
/// escritura directa de antes: peor garantía, pero el dato se guarda.
pub fn escribir_atomico(ruta: &Path, datos: &[u8]) -> std::io::Result<()> {
    let nombre = ruta.file_name().and_then(|s| s.to_str()).unwrap_or("fichero");
    let tmp = ruta.with_file_name(format!(".{nombre}.{}.tmp", std::process::id()));
    fs::write(&tmp, datos)?;
    match fs::rename(&tmp, ruta) {
        Ok(()) => Ok(()),
        Err(_) => {
            let r = fs::write(ruta, datos);
            let _ = fs::remove_file(&tmp);
            // Escribir encima no cambia la fecha de la carpeta, y el listado y
            // el índice (`crate::indice`) se fían de ella para saber si algo
            // cambió dentro. Crear y borrar un fichero vacío sí la cambia.
            if let Some(dir) = ruta.parent() {
                let marca = dir.join(format!(".toque.{}", std::process::id()));
                if fs::write(&marca, b"").is_ok() {
                    let _ = fs::remove_file(&marca);
                }
            }
            r
        }
    }
}

pub fn get_videos_dir() -> PathBuf {
    let cfg = load_config();
    let path = Path::new(&cfg.save_directory);
    if !path.exists() {
        let _ = fs::create_dir_all(&path);
    }
    path.to_path_buf()
}

pub fn get_reviews_dir() -> PathBuf {
    let dir = get_videos_dir().join("VODsReviews");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

pub fn get_match_dir(id: &str) -> PathBuf {
    let dir = if id.starts_with("vod_") {
        get_reviews_dir().join(id)
    } else {
        get_videos_dir().join(id)
    };
    
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

/// Timeline crudo de Riot, tal cual llegó. Se guarda aparte del metadata porque
/// es grande (1-3 MB) y porque el análisis va a cambiar muchas veces: sin esto,
/// cada iteración cuesta una llamada a la API y queda atada al límite de cuota.
/// Es la fuente para re-analizar partidas viejas con métricas nuevas.
pub fn get_timeline_path(id: &str) -> PathBuf {
    get_match_dir(id).join("riot_timeline.json")
}

pub fn save_raw_timeline(id: &str, raw: &str) -> Result<(), String> {
    escribir_atomico(&get_timeline_path(id), raw.as_bytes())
        .map_err(|e| format!("Error guardando timeline: {}", e))
}

pub fn load_raw_timeline(id: &str) -> Option<String> {
    let raw = fs::read_to_string(get_timeline_path(id)).ok()?;
    crate::medida::contar(&crate::medida::BYTES_CRUDOS, raw.len() as u64);
    Some(raw)
}

/// Detalle crudo de la partida. Se cachea por lo mismo que el timeline: el
/// análisis de atribución necesita el `ParticipantDto` completo (155 campos,
/// incluido `challenges`), no la versión recortada que va en el metadata.
pub fn get_raw_match_path(id: &str) -> PathBuf {
    get_match_dir(id).join("riot_match.json")
}

pub fn save_raw_match(id: &str, raw: &str) -> Result<(), String> {
    escribir_atomico(&get_raw_match_path(id), raw.as_bytes()).map_err(|e| format!("Error guardando partida: {}", e))
}

pub fn load_raw_match(id: &str) -> Option<String> {
    let raw = fs::read_to_string(get_raw_match_path(id)).ok()?;
    crate::medida::contar(&crate::medida::BYTES_CRUDOS, raw.len() as u64);
    Some(raw)
}

/// Resumen mínimo de una ranked de la TEMPORADA (grabada o no) para la forma
/// reciente y la predicción de rango. Viene de match-v5 por puuid y se cachea
/// aquí para no repedir detalles ya vistos.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeasonGame {
    pub riot_match_id: String,
    pub win: bool,
    pub champion: String,
    pub kills: i32,
    pub deaths: i32,
    pub assists: i32,
    /// Fin de partida en ms epoch, para ordenar sin re-pedir nada.
    pub game_end_ms: i64,
    /// Nota de rendimiento 0–100: percentil de tu juego DENTRO del lobby de
    /// esa partida (estilo AI-Score de deeplol). 50 = el quinto de diez.
    #[serde(default)]
    pub score: f64,
}

pub fn season_form_cache_path() -> PathBuf {
    // v2: las entradas viejas no traían la nota de rendimiento; con el nombre
    // nuevo la caché se rehace sola en la primera apertura.
    get_config_path().with_file_name("season_form_v2.json")
}

pub fn load_season_form_cache() -> Vec<SeasonGame> {
    fs::read_to_string(season_form_cache_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_season_form_cache(games: &[SeasonGame]) {
    if let Ok(s) = serde_json::to_string(games) {
        let _ = escribir_atomico(&season_form_cache_path(), s.as_bytes());
    }
}

/// Sólo la estela de un fichero de partida ya escrito.
///
/// Los demás campos se tokenizan y se tiran; no hay que construirlos.
fn estela_en_disco(file_path: &Path) -> Vec<MouseEventData> {
    #[derive(Deserialize)]
    struct Solo {
        #[serde(default)]
        mouse_events: Vec<MouseEventData>,
    }
    fs::read_to_string(file_path)
        .ok()
        .and_then(|c| serde_json::from_str::<Solo>(&c).ok())
        .map(|s| s.mouse_events)
        .unwrap_or_default()
}

/// **El único sitio por el que se escribe el metadata de una partida.**
///
/// Aquí cuelgan dos cosas que tienen que pasar SIEMPRE, y por eso están aquí y
/// no en cada llamante: la salvaguarda de la estela y la copia al espejo.
pub fn save_match_metadata(metadata: &MatchMetadata) -> Result<(), String> {
    let mut tramo = crate::medida::Tramo::nuevo("save_match_metadata");
    let dir = get_match_dir(&metadata.id);
    let file_path = dir.join(format!("{}.json", metadata.id));

    // La estela va a su fichero, ANTES que el JSON: si algo se corta entre los
    // dos, queda la estela nueva con el JSON viejo, y al leer manda el fichero.
    //
    // Salvaguarda: un metadata leído sin estela (el listado, `modificar`,
    // casi todos los comandos) la trae vacía, y eso no significa «bórrala».
    // Con la estela ya en su fichero basta con no tocarlo. En una partida aún
    // sin migrar la estela sigue DENTRO del JSON viejo, y escribir el nuevo
    // (que ya no la lleva) la perdería: se rescata de ahí primero.
    let ruta_estela = crate::estela::ruta(&dir);
    if !metadata.mouse_events.is_empty() {
        crate::estela::guardar(&dir, &metadata.mouse_events)
            .map_err(|e| format!("Could not write the mouse trail: {e}"))?;
    } else if !ruta_estela.exists() {
        let previa = estela_en_disco(&file_path);
        if !previa.is_empty() {
            crate::estela::guardar(&dir, &previa)
                .map_err(|e| format!("Could not write the mouse trail: {e}"))?;
        }
    }

    // Compacto, y ya sin la estela (`skip_serializing`): unos 20-30 KB.
    let json_content = serde_json::to_string(metadata)
        .map_err(|e| format!("Could not serialize the match data: {e}"))?;

    escribir_atomico(&file_path, json_content.as_bytes())
        .map_err(|e| format!("Could not write the match file: {e}"))?;
    if crate::medida::activa() {
        let n = crate::medida::contar(&crate::medida::ESCRITURAS_METADATA, 1);
        crate::medida::contar(&crate::medida::BYTES_ESCRITOS, json_content.len() as u64);
        tramo.con(format!("escritura={n} id={} mb={:.2}", metadata.id, json_content.len() as f64 / 1048576.0));
    }

    mirror_match(&metadata.id, &json_content);
    Ok(())
}

/// Copia el metadata (y los sidecars ligeros) a `backup_mirror_dir`.
///
/// Best-effort y síncrono: son kilobytes, y quien apunte el espejo a una
/// carpeta de OneDrive/Drive quiere que el fichero esté ahí *ya*. Los fallos se
/// registran y no se propagan — un disco de red caído no puede convertir
/// "guardar un comentario" en un error para el usuario.
fn mirror_match(id: &str, json_content: &str) {
    let destino = load_config().backup_mirror_dir;
    if destino.trim().is_empty() {
        return;
    }
    let dir = Path::new(destino.trim()).join(id);
    if let Err(e) = fs::create_dir_all(&dir) {
        log::warn!("espejo de copia: no se pudo crear {}: {e}", dir.display());
        return;
    }
    if let Err(e) = escribir_atomico(&dir.join(format!("{id}.json")), json_content.as_bytes()) {
        log::warn!("espejo de copia: no se pudo escribir el metadata de {id}: {e}");
        return;
    }
    // Los sidecars que también son trabajo del usuario o análisis caro de
    // rehacer, y que igualmente pesan poco. Los vídeos NO se copian nunca.
    let origen = get_match_dir(id);
    for nombre in sidecars_de(&origen) {
        let _ = fs::copy(origen.join(&nombre), dir.join(&nombre));
    }
}

/// Los ficheros de una carpeta de partida que SÍ entran en una copia de
/// seguridad: el informe de miradas y los JSON de los clips de error (la nota
/// escrita a mano, los sucesos marcados). Ni vídeos ni DTOs crudos de Riot —
/// los primeros pesan gigas y los segundos se vuelven a pedir.
///
/// La comparte `crate::backup`: el espejo y el ZIP tienen que llevar lo mismo,
/// o restaurar desde uno daría un resultado distinto que desde el otro.
pub fn sidecars_de(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
        .filter(|n| {
            n == "camera_snaps.json"
                || n == crate::estela::FICHERO
                || (n.contains("_error_") && n.ends_with(".json"))
        })
        .collect()
}

/// Pasa la estela de las partidas viejas (dentro del JSON) a `estela.bin`.
///
/// Una vez por partida: las ya pasadas tienen su fichero y se saltan sin leer
/// nada. Para cada una se escribe la estela, se relee y se compara punto a
/// punto con la original, y SOLO entonces se reescribe el JSON sin ella; si la
/// comparación falla, el fichero nuevo se borra y el JSON se queda como estaba.
///
/// `progreso(hecho, total)` para la línea de mantenimiento de la Home.
/// Devuelve cuántas partidas se pasaron.
pub fn migrar_estelas(mut progreso: impl FnMut(usize, usize)) -> usize {
    let _tramo = crate::medida::Tramo::nuevo("migrar_estelas");
    let mut pendientes: Vec<String> = Vec::new();
    for base in [get_videos_dir(), get_reviews_dir()] {
        let Ok(entradas) = fs::read_dir(&base) else { continue };
        for e in entradas.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(id) = e.file_name().to_str().map(|s| s.to_string()) else { continue };
            let dir = e.path();
            if crate::estela::ruta(&dir).exists() {
                continue;
            }
            let json = dir.join(format!("{id}.json"));
            // Sin parsear: basta con saber si la clave sigue ahí.
            if fs::read_to_string(&json).map(|t| t.contains("\"mouse_events\"")).unwrap_or(false) {
                pendientes.push(id);
            }
        }
    }

    let total = pendientes.len();
    let mut hechas = 0;
    for (i, id) in pendientes.iter().enumerate() {
        progreso(i + 1, total);
        let c = candado(id);
        let _g = c.lock().unwrap_or_else(|e| e.into_inner());
        let dir = get_match_dir(id);
        let json = dir.join(format!("{id}.json"));
        let fecha = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).ok();
        let fecha_original = fecha(&json);
        let Some(full) = load_match_by_id(id) else { continue };
        // Si al leerla se realineó, ya se guardó con datos nuevos: esa fecha
        // nueva es la buena y no hay que devolverle la vieja.
        let realineada = fecha(&json) != fecha_original;
        if !full.mouse_events.is_empty() {
            if crate::estela::guardar(&dir, &full.mouse_events).is_err() {
                continue;
            }
            let releida = crate::estela::cargar(&dir).unwrap_or_default();
            let igual = releida.len() == full.mouse_events.len()
                && releida.iter().zip(&full.mouse_events).all(|(a, b)| {
                    a.t.to_bits() == b.t.to_bits()
                        && a.x.to_bits() == b.x.to_bits()
                        && a.y.to_bits() == b.y.to_bits()
                        && a.evt == b.evt
                });
            if !igual {
                eprintln!("estela: la copia de {id} no coincide; se deja el JSON como estaba");
                let _ = fs::remove_file(crate::estela::ruta(&dir));
                continue;
            }
        }
        // Reescribe el JSON ya sin la estela (y sin la clave, si estaba vacía).
        if save_match_metadata(&full).is_err() {
            continue;
        }
        // Mismos datos en otro formato: se les devuelve la fecha de antes. Las
        // cachés por partida (coach, hechizos, presión) se dan por frescas
        // comparando fechas, y sin esto la migración las invalidaba todas a la
        // vez: el primer Coach tras actualizar tardaba 9 s con 300 partidas y
        // 29 s con 1.000 en recalcular lo mismo que ya tenía.
        if let (Some(f), false) = (fecha_original, realineada) {
            for p in [json.clone(), crate::estela::ruta(&dir)] {
                if let Ok(fichero) = fs::OpenOptions::new().write(true).open(&p) {
                    let _ = fichero.set_modified(f);
                }
            }
        }
        hechas += 1;
    }
    hechas
}

/// Un candado por partida para las modificaciones de [`modificar`].
fn candado(id: &str) -> std::sync::Arc<std::sync::Mutex<()>> {
    #[allow(clippy::type_complexity)]
    static CANDADOS: std::sync::Mutex<Option<std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<()>>>>> =
        std::sync::Mutex::new(None);
    let mut g = CANDADOS.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(Default::default)
        .entry(id.to_string())
        .or_default()
        .clone()
}

/// Lee, cambia y guarda una partida sin pisar a nadie.
///
/// Los barridos del arranque guardaban copias tomadas al empezar el bucle:
/// si mientras tanto el usuario escribía un comentario o marcaba un suceso,
/// el guardado del barrido lo borraba con la copia vieja. Aquí la lectura es
/// la de ese mismo momento y, con el candado, nadie más que pase por aquí
/// escribe esa partida entre la lectura y el guardado.
///
/// Lee SIN la estela (la conserva la salvaguarda de [`save_match_metadata`]):
/// `f` no debe tocar `mouse_events`.
pub fn modificar(id: &str, f: impl FnOnce(&mut MatchMetadata)) -> Result<MatchMetadata, String> {
    let c = candado(id);
    let _g = c.lock().unwrap_or_else(|e| e.into_inner());
    let mut m = leer_ligera(id).ok_or_else(|| "Match not found".to_string())?;
    realign_to_video_time(&mut m);
    f(&mut m);
    save_match_metadata(&m)?;
    Ok(m)
}

/// Actualiza SOLO los comentarios de una partida.
pub fn save_comments(id: &str, comments: Vec<Comment>) -> Result<(), String> {
    modificar(id, |m| m.comments = comments).map(|_| ())
}

/// Marca (o desmarca) un suceso como revisado.
///
/// El suceso se identifica por su marca de tiempo, que es lo único estable que
/// tiene: no hay ids de evento. Se compara con tolerancia porque los tiempos son
/// `f64` y vienen de restas en coma flotante.
pub fn set_event_reviewed(id: &str, time: f64, reviewed: bool) -> Result<(), String> {
    let same = |a: f64, b: f64| (a - b).abs() < 0.05;
    modificar(id, |m| {
        if reviewed {
            if !m.reviewed_moments.iter().any(|t| same(*t, time)) {
                m.reviewed_moments.push(time);
            }
        } else {
            m.reviewed_moments.retain(|t| !same(*t, time));
        }
    })
    .map(|_| ())
}

/// La metadata que hay dentro de una carpeta de partida.
///
/// El fichero se llama como su carpeta (`save_match_metadata`), y aprovecharlo
/// importa: al lado viven `riot_match.json`, `riot_timeline.json` y ahora
/// `minimap_positions.json`, y esto los leía y los pasaba por serde **todos**
/// para descartarlos por no encajar en `MatchMetadata`. Medido sobre 19
/// partidas: 11 MB de lectura y parseo tirados en cada refresco de la
/// biblioteca, que además es periódico. Con el minimapa procesado serían 26.
///
/// El barrido se conserva como respaldo por si alguna carpeta no sigue la
/// convención (renombrada a mano, restaurada de una copia): perder una partida
/// del listado sería mucho peor que leer de más.
fn metadata_en_carpeta(dir: &Path) -> Option<MatchMetadata> {
    let leer = |ruta: &Path| -> Option<MatchMetadata> {
        let texto = fs::read_to_string(ruta).ok()?;
        crate::medida::contar(&crate::medida::BYTES_RECORRIDOS, texto.len() as u64);
        serde_json::from_str(&texto).ok()
    };

    if let Some(nombre) = dir.file_name().and_then(|s| s.to_str()) {
        if let Some(m) = leer(&dir.join(format!("{}.json", nombre))) {
            return Some(m);
        }
    }

    fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
        .find_map(|p| leer(&p))
}

/// Una partida **sin la estela del ratón** (ver [`sin_estela`]) ni la
/// realineación de [`load_match_by_id`]: para quien mira campos sueltos (la
/// resolución, los ajustes del juego) de muchas partidas seguidas, como las
/// comprobaciones de si un análisis está al día. NUNCA para guardarla: le falta
/// la estela.
pub fn metadata_ligera(id: &str) -> Option<MatchMetadata> {
    sin_estela(|| metadata_en_carpeta(&get_match_dir(id)))
}

/// Todas las partidas de la biblioteca, **sin la estela del ratón** (ver
/// [`sin_estela`]). Ningún camino que liste la biblioteca la necesita; el que
/// la quiere pide una partida concreta con [`load_match_by_id`].
fn version_de((fecha, tam): (std::time::SystemTime, u64)) -> String {
    let ns = fecha.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{ns:x}-{tam:x}")
}

/// Caché del listado: por cada `{id}.json`, su (fecha de modificación, tamaño)
/// y el metadata ya parseado sin estela. Si el fichero no ha cambiado no se
/// vuelve a leer: el listado pasa de parsear toda la biblioteca a hacer un
/// `stat` por carpeta. Cualquier guardado cambia la fecha y la invalida sola.
#[allow(clippy::type_complexity)]
static LISTADO: std::sync::Mutex<
    Option<(
        PathBuf,
        std::collections::HashMap<PathBuf, ((std::time::SystemTime, u64), MatchMetadata)>,
        // Carpetas sin metadata de partida, con su fecha de modificación.
        std::collections::HashMap<PathBuf, std::time::SystemTime>,
        // Fecha de cada carpeta de partida en el último listado.
        std::collections::HashMap<PathBuf, std::time::SystemTime>,
    )>,
> = std::sync::Mutex::new(None);

pub fn load_all_matches() -> Vec<MatchMetadata> {
    listado_con_versiones().into_iter().map(|(_, m)| m).collect()
}

/// El listado con la versión de cada partida: fecha de modificación y tamaño
/// de su `{id}.json`, la misma firma que usa la caché. Cambia con cualquier
/// guardado. Vacía si la carpeta no sigue la convención de nombre (entonces no
/// hay firma estable y quien compare versiones la tratará siempre como nueva).
pub fn listado_con_versiones() -> Vec<(String, MatchMetadata)> {
    recorrer(|_, _| true)
        .into_iter()
        .filter_map(|(_, v, m)| Some((v, m?)))
        .collect()
}

/// El recorrido de la biblioteca con su caché. Devuelve, en orden (más
/// reciente primero), `(id, versión, metadata)` de cada partida; el metadata
/// solo se clona si `quiero(id, versión)` lo pide. Para saber qué cambió
/// basta con las versiones, y clonar mil metadatas para tirarlos costaba más
/// que todo lo demás.
pub fn recorrer(mut quiero: impl FnMut(&str, &str) -> bool) -> Vec<(String, String, Option<MatchMetadata>)> {
    let mut tramo = crate::medida::Tramo::nuevo("load_all_matches");
    let bytes_antes = crate::medida::BYTES_RECORRIDOS.load(std::sync::atomic::Ordering::Relaxed);
    let dir = get_videos_dir();
    let mut matches = Vec::new();

    // Un solo listado a la vez: si llegan varios juntos (el arranque pide unos
    // trece en el primer segundo), los demás esperan y se llevan la caché ya
    // llena en vez de parsear todos la biblioteca a la vez.
    let mut guard = LISTADO.lock().unwrap_or_else(|e| e.into_inner());
    if guard.as_ref().map(|(d, _, _, _)| *d != dir).unwrap_or(true) {
        *guard = Some((dir.clone(), Default::default(), Default::default(), Default::default()));
    }
    let (_, cache, no_partidas, fechas_carpeta) = guard.as_mut().expect("recién puesto");
    let mut vistos = std::collections::HashSet::new();
    let mut no_vistas = std::collections::HashSet::new();
    let mut parseadas = 0usize;

    // Una carpeta por partida. Los sueltos en la raíz ya no se contemplan: `migrate_flat_layout`
    // los recoloca al arrancar.
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            // `file_type` y `metadata` de una entrada de `read_dir` salen gratis
            // en Windows (vienen en la misma enumeración); `path.is_dir()`
            // costaba una llamada al sistema por carpeta.
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let path = entry.path();
            // Carpetas que no son partidas (`recortes`, `dataset`, `VODsReviews`):
            // se recuerdan con la fecha de la carpeta para no volver a abrirlas y
            // recorrer sus ficheros en cada listado.
            let fecha_carpeta = entry.metadata().and_then(|m| m.modified()).ok();
            if let (Some(f), Some(prev)) = (fecha_carpeta, no_partidas.get(&path)) {
                if *prev == f {
                    no_vistas.insert(path);
                    continue;
                }
            }
            let canonico = path
                .file_name()
                .and_then(|s| s.to_str())
                .map(|n| path.join(format!("{n}.json")));
            // Si la carpeta tiene la misma fecha que la última vez, su JSON no
            // ha cambiado: todo lo que la app escribe ahí se escribe a un
            // temporal y se renombra (o toca la carpeta, ver `escribir_atomico`),
            // y eso cambia la fecha de la carpeta. Así no hace falta un `stat`
            // por partida en cada listado: 1.000 partidas costaban ~100 ms solo
            // en eso.
            let firma = match (&canonico, fecha_carpeta) {
                (Some(f), Some(fc)) if fechas_carpeta.get(&path) == Some(&fc) && cache.contains_key(f) => {
                    cache.get(f).map(|(firma, _)| *firma)
                }
                _ => canonico
                    .as_ref()
                    .and_then(|f| fs::metadata(f).ok())
                    .and_then(|md| Some((md.modified().ok()?, md.len()))),
            };
            if let Some(fc) = fecha_carpeta {
                fechas_carpeta.insert(path.clone(), fc);
            }
            if let (Some(f), Some(firma)) = (&canonico, firma) {
                if let Some((guardada, m)) = cache.get(f) {
                    if *guardada == firma {
                        let v = version_de(firma);
                        let copia = quiero(&m.id, &v).then(|| m.clone());
                        matches.push((m.date.clone(), m.id.clone(), v, copia));
                        vistos.insert(f.clone());
                        continue;
                    }
                }
            }
            parseadas += 1;
            if let Some(m) = sin_estela(|| metadata_en_carpeta(&path)) {
                let version = firma.map(version_de).unwrap_or_default();
                if let (Some(f), Some(firma)) = (canonico, firma) {
                    cache.insert(f.clone(), (firma, m.clone()));
                    vistos.insert(f);
                }
                let copia = quiero(&m.id, &version).then(|| m.clone());
                matches.push((m.date.clone(), m.id.clone(), version, copia));
            } else if let Some(f) = fecha_carpeta {
                no_partidas.insert(path.clone(), f);
                no_vistas.insert(path);
            }
        }
    }
    cache.retain(|f, _| vistos.contains(f));
    no_partidas.retain(|p, _| no_vistas.contains(p));
    let carpetas_vistas: std::collections::HashSet<&Path> = vistos.iter().filter_map(|f| f.parent()).collect();
    fechas_carpeta.retain(|p, _| carpetas_vistas.contains(p.as_path()));
    drop(guard);

    // Ordenar de más reciente a más antiguo
    matches.sort_by(|a, b| b.0.cmp(&a.0));
    if crate::medida::activa() {
        let n = crate::medida::contar(&crate::medida::RECORRIDOS, 1);
        let bytes = crate::medida::BYTES_RECORRIDOS.load(std::sync::atomic::Ordering::Relaxed) - bytes_antes;
        tramo.con(format!("recorrido={n} partidas={} parseadas={parseadas} mb={:.1}", matches.len(), bytes as f64 / 1048576.0));
    }
    matches.into_iter().map(|(_, id, v, m)| (id, v, m)).collect()
}

#[tauri::command]
pub async fn get_vod_reviews() -> Vec<MatchMetadata> {
    let _medida = crate::medida::Tramo::nuevo("cmd/get_vod_reviews");
    let dir = get_reviews_dir();
    let mut matches = Vec::new();

    let mut añadir = |metadata: Option<MatchMetadata>| {
        let Some(metadata) = metadata else { return };
        if metadata.id.starts_with("vod_") {
            // El listado no necesita la estela; el reproductor la carga aparte
            // (aquí ni siquiera se parsea: ver `sin_estela`).
            matches.push(metadata);
        }
    };

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                añadir(sin_estela(|| metadata_en_carpeta(&path)));
            } else if path.extension().and_then(|s| s.to_str()) == Some("json") {
                // Análisis sueltos en la raíz, de antes de que cada uno tuviera
                // su carpeta.
                añadir(sin_estela(|| {
                    fs::read_to_string(&path)
                        .ok()
                        .and_then(|c| serde_json::from_str(&c).ok())
                }));
            }
        }
    }

    matches.sort_by(|a, b| b.date.cmp(&a.date));
    matches
}

/// Una partida **sin la estela del ratón**, realineada como al abrirla.
///
/// Es lo que quieren casi todos los comandos de una partida (coach, jugadas,
/// títulos, curvas, oro, HUD, oleadas, minimapa…): antes abrían la partida
/// entera, y al abrir una en el reproductor la estela (3-5 MB de JSON) se
/// parseaba una vez por comando. Quien la necesita (manos, golpes, barras,
/// miradas) llama a [`get_match_metadata_con_estela`].
pub fn get_match_metadata(match_id: &str) -> Result<MatchMetadata, String> {
    if let Some(m) = load_match_ligera(match_id) {
        return Ok(m);
    }
    buscar_en_listado(match_id)
}

/// La partida entera, estela incluida.
pub fn get_match_metadata_con_estela(match_id: &str) -> Result<MatchMetadata, String> {
    // Por la ruta normal (una carpeta por partida) para que pase la realineación.
    if let Some(m) = load_match_by_id(match_id) {
        return Ok(m);
    }
    buscar_en_listado(match_id)
}

/// Respaldo para carpetas que no siguen la convención de nombre.
fn buscar_en_listado(match_id: &str) -> Result<MatchMetadata, String> {
    let matches = load_all_matches();
    for m in matches {
        if m.id == match_id {
            return Ok(m);
        }
    }
    Err("Match not found".to_string())
}

/// Marca de que la migración de disposición ya corrió en ese directorio.
const LAYOUT_MARKER: &str = ".layout-v2";

/// A qué partida pertenece un fichero suelto de la raíz, por su nombre:
///   `match_x.json` / `match_x.mp4`        -> "match_x"
///   `match_x_error_3.mp4` / `.json`       -> "match_x"
/// Devuelve None para cualquier cosa que no sea un `.json`/`.mp4` (el propio marcador incluido).
fn owner_id_of(file_name: &str) -> Option<String> {
    let path = Path::new(file_name);
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if ext != "json" && ext != "mp4" {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    let id = match stem.find("_error_") {
        Some(i) => &stem[..i],
        None => stem,
    };
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

/// Migra la disposición antigua (ficheros sueltos `<id>.json` / `<id>.mp4` / `<id>_error_*.mp4`
/// en la raíz) a la actual: una carpeta `<id>/` por partida.
///
/// Se ejecuta una sola vez por directorio, marcada con un fichero `.layout-v2`. NO borra nada:
/// solo mueve, y si el destino ya existe deja el original donde está y lo registra. Si algún
/// movimiento falla no escribe el marcador, así que el siguiente arranque lo reintenta.
///
/// Devuelve la lista de ficheros movidos (para el log).
pub fn migrate_flat_layout(root: &Path) -> Vec<String> {
    let marker = root.join(LAYOUT_MARKER);
    if marker.exists() {
        return Vec::new();
    }

    let mut moved = Vec::new();
    let mut failed = false;

    let Ok(entries) = fs::read_dir(root) else {
        return moved; // sin marcador: se reintenta en el próximo arranque
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(id) = owner_id_of(name) else {
            continue;
        };

        let dest_dir = root.join(&id);
        if let Err(e) = fs::create_dir_all(&dest_dir) {
            eprintln!("Migración: no se pudo crear {}: {e}", dest_dir.display());
            failed = true;
            continue;
        }
        let dest = dest_dir.join(name);
        if dest.exists() {
            eprintln!(
                "Migración: {} ya existe; dejo {} sin tocar",
                dest.display(),
                path.display()
            );
            failed = true;
            continue;
        }
        match fs::rename(&path, &dest) {
            Ok(()) => moved.push(name.to_string()),
            Err(e) => {
                eprintln!("Migración: no se pudo mover {}: {e}", path.display());
                failed = true;
            }
        }
    }

    if !failed {
        let _ = fs::write(&marker, "1");
    }
    moved
}

/// Lanza la migración sobre los dos directorios que pueden tener partidas sueltas.
pub fn migrate_storage_layout() {
    for root in [get_videos_dir(), get_reviews_dir()] {
        let moved = migrate_flat_layout(&root);
        if !moved.is_empty() {
            println!(
                "Migración de disposición en {}: {} fichero(s) movidos a su carpeta",
                root.display(),
                moved.len()
            );
        }
    }
}

/// Carga el metadata COMPLETO de una sola partida (incluye `mouse_events`) leyendo
/// directamente su JSON, sin escanear toda la biblioteca.
///
/// Solo mira la disposición actual (`<base>/<id>/<id>.json`): de los sueltos antiguos en la raíz
/// se encarga `migrate_flat_layout` al arrancar.
/// Ruta del metadata de una partida, sin crear carpetas (`get_match_dir` las crea).
fn ruta_metadata(id: &str) -> PathBuf {
    let base = if id.starts_with("vod_") { get_reviews_dir() } else { get_videos_dir() };
    base.join(id).join(format!("{id}.json"))
}

/// El metadata tal cual está en disco, sin estela ni realineación.
fn leer_ligera(id: &str) -> Option<MatchMetadata> {
    let content = fs::read_to_string(ruta_metadata(id)).ok()?;
    crate::medida::contar(&crate::medida::BYTES_RECORRIDOS, content.len() as u64);
    sin_estela(|| serde_json::from_str::<MatchMetadata>(&content).ok())
}

/// Como [`load_match_by_id`] pero sin la estela: lee y realinea igual.
pub fn load_match_ligera(id: &str) -> Option<MatchMetadata> {
    let _tramo = crate::medida::Tramo::nuevo("load_match_ligera");
    let mut metadata = leer_ligera(id)?;
    // Guardar sin estela es seguro: la salvaguarda de `save_match_metadata`
    // conserva la del disco.
    if realign_to_video_time(&mut metadata) {
        let _ = save_match_metadata(&metadata);
    }
    Some(metadata)
}

pub fn load_match_by_id(id: &str) -> Option<MatchMetadata> {
    let base = if id.starts_with("vod_") {
        get_reviews_dir()
    } else {
        get_videos_dir()
    };
    let mut tramo = crate::medida::Tramo::nuevo("load_match_by_id");
    let dir = base.join(id);
    let file = dir.join(format!("{}.json", id));
    let content = fs::read_to_string(file).ok()?;
    // Con la estela en su fichero no hace falta construir la que pudiera
    // quedar dentro de un JSON viejo: manda la del fichero.
    let tiene_fichero = crate::estela::ruta(&dir).exists();
    let parse = || serde_json::from_str::<MatchMetadata>(&content).ok();
    let mut metadata = if tiene_fichero { sin_estela(parse)? } else { parse()? };
    if tiene_fichero {
        metadata.mouse_events = crate::estela::cargar(&dir).unwrap_or_default();
    }
    crate::medida::contar(&crate::medida::BYTES_RECORRIDOS, content.len() as u64);
    if crate::medida::activa() {
        let n = crate::medida::contar(&crate::medida::APERTURAS_CON_ESTELA, 1);
        tramo.con(format!("apertura={n} id={id} mb={:.2}", content.len() as f64 / 1048576.0));
    }
    // Las grabaciones anteriores al arreglo del desfase se realinean al abrirlas.
    if realign_to_video_time(&mut metadata) {
        let _ = save_match_metadata(&metadata);
    }
    Some(metadata)
}

/// Comando: detalle completo de UNA partida (para el reproductor: estela del ratón).
#[tauri::command]
pub async fn get_match_details(id: String) -> Option<MatchMetadata> {
    // Sin la estela: ya no viaja en JSON (ver `get_match_trail`).
    let _medida = crate::medida::Tramo::nuevo("cmd/get_match_details");
    tauri::async_runtime::spawn_blocking(move || load_match_ligera(&id)).await.ok().flatten()
}

/// La estela del ratón de una partida, en binario (formato en `crate::estela`).
///
/// Llega al reproductor como `ArrayBuffer`: antes viajaba dentro del detalle
/// como 2 MB de JSON que el WebView tenía que parsear entero. Si la partida
/// aún no tiene `estela.bin` (sin migrar todavía, o un VOD viejo), se codifica
/// al vuelo desde el JSON.
#[tauri::command]
pub async fn get_match_trail(match_id: String) -> Result<tauri::ipc::Response, String> {
    let _medida = crate::medida::Tramo::nuevo("cmd/get_match_trail");
    tauri::async_runtime::spawn_blocking(move || {
        let dir = ruta_metadata(&match_id).parent().map(Path::to_path_buf).unwrap_or_default();
        if let Some(b) = crate::estela::bytes(&dir) {
            return Ok(b);
        }
        let m = load_match_by_id(&match_id).ok_or_else(|| "Match not found".to_string())?;
        Ok(crate::estela::codificar(&m.mouse_events))
    })
    .await
    .map_err(|e| e.to_string())?
    .map(tauri::ipc::Response::new)
}

/// Carpeta donde viven los recortes cuya partida ya no existe.
///
/// Los clips y errores nacen dentro de la carpeta de su partida, pero NO son
/// suyos: son la colección del usuario. Borrar la partida (que es lo que pesa:
/// 4 GB de vídeo) no debe llevarse un clip de 80 MB con la lección escrita.
pub fn rescue_dir() -> PathBuf {
    let dir = get_videos_dir().join("recortes");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

/// Muda los recortes (mp4 de clip/error y su JSON) fuera de una carpeta que va
/// a borrarse. Devuelve cuántos ficheros salvó.
fn rescue_clips(match_dir: &Path) -> usize {
    rescue_clips_into(match_dir, &rescue_dir())
}

fn rescue_clips_into(match_dir: &Path, destino: &Path) -> usize {
    let mut salvados = 0;
    let Ok(entries) = fs::read_dir(match_dir) else { return 0 };
    for e in entries.flatten() {
        let nombre = e.file_name().to_string_lossy().to_string();
        let es_recorte = (nombre.contains("_clip_") || nombre.contains("_error_"))
            && (nombre.ends_with(".mp4") || nombre.ends_with(".json"));
        if !es_recorte {
            continue;
        }
        // `rename` y no copia: mismo volumen, instantáneo. Si ya existiera uno
        // con ese nombre (no debería: el id de partida va en el nombre), no se
        // pisa — mejor un duplicado sin salvar que una lección sobrescrita.
        let a = destino.join(&nombre);
        let _ = fs::create_dir_all(destino);
        if !a.exists() && fs::rename(e.path(), &a).is_ok() {
            salvados += 1;
        }
    }
    salvados
}

pub fn delete_match_files(id: &str) -> Result<(), String> {
    let match_dir = get_match_dir(id);
    if match_dir.exists() {
        let n = rescue_clips(&match_dir);
        if n > 0 {
            log::info!("borrado de {id}: {n} recortes mudados a recortes/");
        }
        let _ = fs::remove_dir_all(&match_dir);
        return Ok(());
    }

    // Retrocompatibilidad
    let root_dir = get_videos_dir();
    let json_path = root_dir.join(format!("{}.json", id));
    let mp4_path = root_dir.join(format!("{}.mp4", id));

    if json_path.exists() {
        let _ = fs::remove_file(json_path);
    }
    if mp4_path.exists() {
        let _ = fs::remove_file(mp4_path);
    }
    Ok(())
}

/// Caché del tamaño de la carpeta de vídeos.
///
/// `get_dir_size` recorre el árbol entero (cientos de GB en ficheros grandes) y
/// la UI lo pedía en cada refresco de la biblioteca solo para pintar la barra
/// de disco. Con un minuto de vida sobra: el tamaño solo cambia al ritmo de una
/// grabación, y quien borra invalida a mano.
static DISK_CACHE: std::sync::Mutex<Option<(std::time::Instant, u64)>> =
    std::sync::Mutex::new(None);
const DISK_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(60);

pub fn videos_dir_size_cached() -> u64 {
    let mut guard = DISK_CACHE.lock().unwrap();
    if let Some((t, v)) = *guard {
        if t.elapsed() < DISK_CACHE_TTL {
            return v;
        }
    }
    let v = get_dir_size(&get_videos_dir());
    *guard = Some((std::time::Instant::now(), v));
    v
}

/// Tira la caché: se llama tras borrar partidas para que la barra baje al
/// momento en vez de al minuto.
pub fn invalidate_disk_cache() {
    *DISK_CACHE.lock().unwrap() = None;
}

pub fn get_dir_size(path: &Path) -> u64 {
    let mut size = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            // Un fichero que desaparece a media pasada (o al que no llegamos por
            // permisos) NO puede tumbar el cálculo: esto lo llama la barra de
            // disco y la cuota, y antes un `unwrap()` aquí mataba el hilo entero.
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                size += get_dir_size(&entry.path());
            } else {
                size += meta.len();
            }
        }
    }
    size
}

/// Decide si una partida puede borrarse automáticamente. Borrar una partida se
/// lleva por delante su carpeta entera, y ahí dentro viven también sus clips, así
/// que hay dos cosas que el borrado automático nunca toca:
///   - VOD importados: material que el usuario trajo a mano, no lo generamos nosotros.
///   - Partidas con algún clip marcado como favorito.
fn is_auto_deletable(m: &MatchMetadata) -> bool {
    if m.is_vod {
        return false;
    }
    !has_favorite_clip(&m.id)
}

/// true si la carpeta de la partida contiene algún clip marcado como favorito.
/// Se lee el JSON en crudo a propósito: solo nos interesa ese campo y no queremos
/// que un cambio de forma en `ClipMetadata` haga fallar el parseo y, con él, la
/// protección.
fn has_favorite_clip(match_id: &str) -> bool {
    let dir = get_match_dir(match_id);
    let Ok(entries) = fs::read_dir(&dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.contains("_clip_") || !name.ends_with(".json") {
            continue;
        }
        if let Ok(content) = fs::read_to_string(entry.path()) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                if v.get("favorite").and_then(|f| f.as_bool()).unwrap_or(false) {
                    return true;
                }
            }
        }
    }
    false
}

pub fn check_storage_quota() {
    let cfg = load_config();
    // Un límite de 0 (campo vacío en ajustes, config corrupta) borraría absolutamente
    // todo: por debajo del mínimo lo tratamos como "sin configurar".
    let limit: u64 = cfg.max_storage_gb.max(MIN_STORAGE_GB) * 1024 * 1024 * 1024;
    let prune_days = cfg.auto_prune_days;
    let root_dir = get_videos_dir();

    // 1. Borrado por edad. Desactivado mientras `auto_prune_days` sea 0, que es
    //    el valor por defecto: es destructivo, así que se opta por él a mano.
    //    El formato de fecha es "YYYY-MM-DD HH:MM:SS".
    if prune_days > 0 {
        let now = chrono::Local::now().naive_local();
        for m in load_all_matches() {
            if !is_auto_deletable(&m) {
                continue;
            }
            let Ok(dt) = chrono::NaiveDateTime::parse_from_str(&m.date, "%Y-%m-%d %H:%M:%S") else {
                continue; // fecha ilegible: no la borramos a ciegas
            };
            if now.signed_duration_since(dt).num_days() > prune_days as i64 {
                if let Err(e) = delete_match_files(&m.id) {
                    eprintln!("Auto-prune: no se pudo borrar {}: {}", m.id, e);
                }
            }
        }
    }

    // 2. Borrado por cuota. El tamaño se mide una sola vez, ya con el paso anterior
    //    aplicado: recorrer el árbol entero es caro y antes se hacía dos veces.
    let current_size = get_dir_size(&root_dir);
    if current_size <= limit {
        return;
    }

    let mut matches = load_all_matches();
    matches.sort_by(|a, b| a.date.cmp(&b.date)); // de la más antigua a la más nueva

    let mut freed = 0;
    let excess = current_size - limit;
    for m in matches {
        if freed >= excess {
            break;
        }
        if !is_auto_deletable(&m) {
            continue;
        }
        let size = get_dir_size(&get_match_dir(&m.id));
        match delete_match_files(&m.id) {
            Ok(()) => freed += size,
            Err(e) => eprintln!("Cuota: no se pudo borrar {}: {}", m.id, e),
        }
    }
    if freed > 0 {
        invalidate_disk_cache();
    }
}

#[cfg(test)]
mod rescate_tests {
    use super::*;

    fn dir_tmp(nombre: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("leaguerec-rescate-{}-{}", std::process::id(), nombre));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// Lo que motivó esto: el usuario borró partidas para liberar espacio y se
    /// llevaron por delante su colección de clips y errores.
    #[test]
    fn los_recortes_se_salvan_y_el_video_gordo_no() {
        let partida = dir_tmp("partida");
        let destino = dir_tmp("destino");
        for f in [
            "match_1.mp4",              // el vídeo de 4 GB: ese SÍ debe morir
            "match_1.json",
            "riot_timeline.json",
            "match_1_clip_1.mp4",
            "match_1_clip_1.json",
            "match_1_error_2.mp4",
            "match_1_error_2.json",
        ] {
            fs::write(partida.join(f), b"x").unwrap();
        }
        let n = rescue_clips_into(&partida, &destino);
        assert_eq!(n, 4, "clip y error, con sus JSON");
        assert!(destino.join("match_1_clip_1.mp4").exists());
        assert!(destino.join("match_1_error_2.json").exists());
        // Lo pesado se queda para que el borrado lo elimine.
        assert!(partida.join("match_1.mp4").exists());
        assert!(!partida.join("match_1_clip_1.mp4").exists());
    }

    /// Un rescate no pisa a otro: mejor un duplicado sin salvar que una lección
    /// sobrescrita.
    #[test]
    fn no_se_pisa_un_rescatado_anterior() {
        let partida = dir_tmp("partida2");
        let destino = dir_tmp("destino2");
        fs::write(partida.join("match_2_clip_1.mp4"), b"nuevo").unwrap();
        fs::write(destino.join("match_2_clip_1.mp4"), b"viejo").unwrap();
        assert_eq!(rescue_clips_into(&partida, &destino), 0);
        assert_eq!(fs::read(destino.join("match_2_clip_1.mp4")).unwrap(), b"viejo");
    }
}

#[cfg(test)]
mod metadata_en_carpeta_tests {
    use super::*;

    fn carpeta(nombre: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "leaguerec-meta-{}-{}",
            std::process::id(),
            nombre
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn json_de(id: &str) -> String {
        format!(
            r#"{{"id":"{id}","game_duration":1700.0,"video_path":"v.mp4","result":"Victory","champion":"Gwen","date":"2026-08-30 05:00:00","events":[]}}"#
        )
    }

    #[test]
    fn lee_el_fichero_que_se_llama_como_la_carpeta() {
        let raiz = carpeta("match_x");
        let dir = raiz.join("match_1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("match_1.json"), json_de("match_1")).unwrap();
        assert_eq!(metadata_en_carpeta(&dir).unwrap().id, "match_1");
    }

    /// Lo que motivó todo esto: al lado de la metadata viven varios JSON grandes
    /// que NO son metadata, y leerlos para descartarlos costaba megas en cada
    /// refresco de la biblioteca. Con un `riot_timeline.json` de mentira que
    /// tampoco encaja, el resultado tiene que ser el mismo y sin tocarlo.
    #[test]
    fn no_le_hacen_falta_los_ficheros_vecinos() {
        let raiz = carpeta("match_vecinos");
        let dir = raiz.join("match_2");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("match_2.json"), json_de("match_2")).unwrap();
        fs::write(dir.join("riot_timeline.json"), "{\"info\":{}}").unwrap();
        fs::write(dir.join("minimap_positions.json"), "{\"samples\":[]}").unwrap();
        assert_eq!(metadata_en_carpeta(&dir).unwrap().id, "match_2");
    }

    /// Respaldo: una carpeta renombrada a mano seguiría apareciendo en la
    /// biblioteca. Perder una partida del listado es peor que leer de más.
    #[test]
    fn si_el_nombre_no_cuadra_lo_busca_igual() {
        let raiz = carpeta("match_renombrada");
        let dir = raiz.join("copia de match_3");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("match_3.json"), json_de("match_3")).unwrap();
        assert_eq!(metadata_en_carpeta(&dir).unwrap().id, "match_3");
    }

    #[test]
    fn una_carpeta_sin_metadata_no_devuelve_nada() {
        let raiz = carpeta("match_vacia");
        let dir = raiz.join("match_4");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("riot_match.json"), "{}").unwrap();
        assert!(metadata_en_carpeta(&dir).is_none());
    }
}

#[cfg(test)]
mod layout_migration_tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("leaguerec-layout-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path) {
        fs::write(path, b"x").unwrap();
    }

    #[test]
    fn deriva_el_id_del_nombre() {
        assert_eq!(owner_id_of("match_1.json").as_deref(), Some("match_1"));
        assert_eq!(owner_id_of("match_1.mp4").as_deref(), Some("match_1"));
        assert_eq!(owner_id_of("match_1_error_3.mp4").as_deref(), Some("match_1"));
        assert_eq!(owner_id_of("match_1_error_3.json").as_deref(), Some("match_1"));
        // Ni el marcador ni cualquier otra cosa se tocan.
        assert_eq!(owner_id_of(".layout-v2"), None);
        assert_eq!(owner_id_of("notas.txt"), None);
    }

    #[test]
    fn agrupa_los_sueltos_en_su_carpeta() {
        let root = temp_root("agrupa");
        touch(&root.join("match_1.json"));
        touch(&root.join("match_1.mp4"));
        touch(&root.join("match_1_error_0.mp4"));
        touch(&root.join("match_1_error_0.json"));
        touch(&root.join("match_2.json"));

        let moved = migrate_flat_layout(&root);
        assert_eq!(moved.len(), 5);

        for f in ["match_1.json", "match_1.mp4", "match_1_error_0.mp4", "match_1_error_0.json"] {
            assert!(root.join("match_1").join(f).exists(), "falta {f}");
            assert!(!root.join(f).exists(), "{f} sigue suelto en la raíz");
        }
        assert!(root.join("match_2").join("match_2.json").exists());
        assert!(root.join(LAYOUT_MARKER).exists());
    }

    #[test]
    fn no_toca_lo_que_ya_esta_migrado() {
        let root = temp_root("idempotente");
        touch(&root.join("match_1.json"));
        assert_eq!(migrate_flat_layout(&root).len(), 1);
        // Segunda pasada: el marcador la corta en seco.
        touch(&root.join("match_9.json"));
        assert!(migrate_flat_layout(&root).is_empty());
        assert!(root.join("match_9.json").exists(), "no debería haberse movido");
    }

    #[test]
    fn nunca_pisa_un_destino_existente() {
        let root = temp_root("colision");
        fs::create_dir_all(root.join("match_1")).unwrap();
        fs::write(root.join("match_1").join("match_1.json"), b"el bueno").unwrap();
        fs::write(root.join("match_1.json"), b"el suelto").unwrap();

        assert!(migrate_flat_layout(&root).is_empty());
        assert_eq!(fs::read(root.join("match_1").join("match_1.json")).unwrap(), b"el bueno");
        assert!(root.join("match_1.json").exists(), "el suelto no se debe perder");
        // Sin marcador: al haber quedado algo pendiente, el próximo arranque lo reintenta.
        assert!(!root.join(LAYOUT_MARKER).exists());
    }

    #[test]
    fn ignora_directorios_y_extensiones_ajenas() {
        let root = temp_root("ignora");
        fs::create_dir_all(root.join("VODsReviews")).unwrap();
        fs::create_dir_all(root.join("dataset")).unwrap();
        touch(&root.join("notas.txt"));

        assert!(migrate_flat_layout(&root).is_empty());
        assert!(root.join("VODsReviews").is_dir());
        assert!(root.join("dataset").is_dir());
        assert!(root.join("notas.txt").is_file());
    }
}

#[cfg(test)]
mod realineado_tests {

    /// Un config guardado antes de que existiera `language` tiene que cargar sin
    /// romperse y quedarse en ingles. Es el caso real de cualquiera que ya tenga
    /// la app instalada: su config.json no lleva el campo.
    #[test]
    fn config_viejo_sin_idioma_carga_en_ingles() {
        let viejo = r#"{
            "save_directory": "/videos",
            "riot_api_key": "RGAPI-x",
            "auto_dataset_generator": false,
            "max_storage_gb": 100,
            "auto_prune_days": 0
        }"#;
        let cfg: AppConfig = serde_json::from_str(viejo).expect("deberia deserializar");
        assert_eq!(cfg.language, "en");
        assert_eq!(cfg.max_storage_gb, 100);
    }

    /// Y uno guardado con idioma lo conserva al ida y vuelta.
    #[test]
    fn el_idioma_sobrevive_al_guardado() {
        let mut cfg = AppConfig::default();
        cfg.language = "es".to_string();
        let json = serde_json::to_string(&cfg).unwrap();
        let leido: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(leido.language, "es");
    }

    use super::*;

    /// Partida real (match_20260811_225013): 2595 s de vídeo con 1:47 de pantalla de
    /// carga por delante. La muerte que el reloj de la partida sitúa en 5:34 ocurre en
    /// el 7:20 del vídeo.
    fn partida_con_carga_larga() -> MatchMetadata {
        serde_json::from_str(
            r#"{
                "id": "match_test",
                "game_duration": 2595.0,
                "video_path": "",
                "result": "Victory",
                "champion": "Gwen",
                "date": "2026-08-11 22:50:13",
                "events": [
                    {"type":"GameStart","subtype":null,"time":0.0,"description":"Partida Iniciada"},
                    {"type":"ChampionKill","subtype":"death","time":335.5,"description":"Te mató Lanaria"},
                    {"type":"ChampionKill","subtype":"kill","time":399.5,"description":"Mataste a Sunny"},
                    {"type":"GameEnd","subtype":"win","time":2488.6,"description":"Victoria"}
                ],
                "timeline_markers": [
                    {"time":334.4,"event_type":"death","description":"Muerte"},
                    {"time":398.4,"event_type":"kill","description":"Asesinato"}
                ],
                "item_purchases": [{"time":13.9,"item_id":1055}]
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn lleva_las_marcas_al_instante_real_del_video() {
        let mut m = partida_con_carga_larga();
        assert!(realign_to_video_time(&mut m));

        let offset = m.video_offset.unwrap();
        assert!((offset - 107.5).abs() < 1.0, "offset estimado: {offset}");
        // Muerte del minuto 5:34 de partida -> 7:22 de vídeo (±1,5 s de estimación).
        assert!((m.events[1].time - 441.9).abs() < 1.5, "evento: {}", m.events[1].time);
        assert!(
            (m.timeline_markers[0].time - 441.9).abs() < 1.5,
            "marcador: {}",
            m.timeline_markers[0].time
        );
        // El evento en directo y su marcador de Riot acaban en el mismo sitio.
        assert!((m.events[1].time - m.timeline_markers[0].time).abs() < 0.1);
        // La compra se mueve con todo lo demás.
        assert!((m.item_purchases[0].time - 121.4).abs() < 1.5);
        // El GameStart lo apunta la grabadora: ya estaba en tiempo de vídeo.
        assert_eq!(m.events[0].time, 0.0);
    }

    #[test]
    fn no_vuelve_a_desplazar_lo_ya_realineado() {
        let mut m = partida_con_carga_larga();
        assert!(realign_to_video_time(&mut m));
        let ya_alineado = m.clone();
        assert!(!realign_to_video_time(&mut m));
        assert_eq!(m.events[1].time, ya_alineado.events[1].time);
        assert_eq!(m.timeline_markers[0].time, ya_alineado.timeline_markers[0].time);
    }

    #[test]
    fn se_abstiene_sin_datos_con_los_que_estimar() {
        // Sin marcadores de Riot no hay nada desalineado ni referencia que usar.
        let mut sin_marcadores = partida_con_carga_larga();
        sin_marcadores.timeline_markers.clear();
        assert!(!realign_to_video_time(&mut sin_marcadores));
        assert!(sin_marcadores.video_offset.is_none());

        // El GameEnd de respaldo ya va en tiempo de vídeo: no sirve de referencia.
        let mut sin_game_end = partida_con_carga_larga();
        sin_game_end.events.retain(|e| e.r#type != "GameEnd");
        sin_game_end.events.push(MatchEvent::plain(
            "GameEnd",
            // El subtype es lo que lo marca como de respaldo; la descripción no,
            // que cambia de idioma. Es como lo crea `commands.rs`.
            Some("recording"),
            2595.0,
            "Recording finished".to_string(),
        ));
        assert!(!realign_to_video_time(&mut sin_game_end));
    }

    #[test]
    fn la_curva_de_apm_se_corre_con_el_video() {
        // Rampa 0..10 sobre 100 s de partida; con 20 s de carga por delante, lo que
        // estaba en el segundo 0 pasa al 20 y el arranque queda a 0.
        let serie: Vec<f64> = (0..11).map(|i| i as f64).collect();
        let movida = shift_apm_series(&serie, 100.0, 20.0);
        assert_eq!(movida.len(), serie.len());
        assert_eq!(movida[0], 0.0);
        assert_eq!(movida[1], 0.0); // t=10 s de vídeo: la partida aún no ha empezado
        assert!((movida[2] - 0.0).abs() < 1e-9); // t=20 s: justo el 0:00 de la partida
        assert!((movida[4] - 2.0).abs() < 1e-9); // t=40 s de vídeo = 20 s de partida
        assert!((movida[10] - 8.0).abs() < 1e-9);
    }
}

// ---------------------------------------------------------------------------
// Espacio físico del disco y atajos de teclado.
//
// Sección NUEVA al final del fichero a propósito: nada de aquí toca `AppConfig`
// ni su fichero. El atajo del replay vive en su propio `hotkeys.json` para que
// añadirlo no compita con quien esté reestructurando la configuración general.
// ---------------------------------------------------------------------------

/// Bytes libres en el volumen donde vive `path`. `None` si no se puede consultar.
pub fn free_disk_bytes(path: &Path) -> Option<u64> {
    crate::winsys::disk_space(path).map(|(free, _)| free)
}

/// (libres, capacidad total) del volumen donde vive `path`.
pub fn disk_space_bytes(path: &Path) -> Option<(u64, u64)> {
    crate::winsys::disk_space(path)
}

/// Umbral de aviso: por debajo de esto la grabación empieza, pero se avisa.
pub const DISK_LOW_BYTES: u64 = 3 * 1024 * 1024 * 1024;
/// Umbral duro: por debajo de esto NO se graba (un mp4 a medias no sirve de nada
/// y un disco a cero se lleva por delante también los metadatos de la partida).
pub const DISK_FULL_BYTES: u64 = 1024 * 1024 * 1024;

/// Atajos globales. Fichero propio (`hotkeys.json`) y struct propio: ver la nota
/// de la cabecera de la sección.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeyConfig {
    /// Tecla que guarda los últimos segundos del replay buffer. Formato el mismo
    /// que entiende `training::parse_key` (letras, dígitos, F1–F12).
    #[serde(default = "default_replay_hotkey")]
    pub replay: String,
}

fn default_replay_hotkey() -> String {
    "F8".to_string()
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            replay: default_replay_hotkey(),
        }
    }
}

pub fn get_hotkeys_path() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| "C:".to_string());
    let dir = Path::new(&appdata).join("LeagueRecorder");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir.join("hotkeys.json")
}

pub fn load_hotkeys() -> HotkeyConfig {
    if let Ok(content) = fs::read_to_string(get_hotkeys_path()) {
        if let Ok(cfg) = serde_json::from_str::<HotkeyConfig>(&content) {
            return cfg;
        }
    }
    HotkeyConfig::default()
}

pub fn save_hotkeys(cfg: &HotkeyConfig) -> Result<(), String> {
    let content = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(get_hotkeys_path(), content).map_err(|e| e.to_string())
}
