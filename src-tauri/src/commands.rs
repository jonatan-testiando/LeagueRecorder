use crate::riot_live_api::{strip_tag, LolApiClient, LolEvent};
use crate::awareness::{self, AwarenessRecord, CameraPress, GameSnapshot};
use crate::recorder::{
    detect_system_audio_device, is_recording, start_recording, stop_recording,
    RecorderState,
};
use crate::storage::{
    delete_match_files, load_all_matches, save_match_metadata, MatchEvent, MatchMetadata,
    MouseEventData,
};
use crate::training::{MetronomeEvent, MetronomeRunner, TrainingState};
use crate::ultimate::UltState;
use chrono::Local;
use reqwest::multipart;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{Emitter, State};
use tokio::sync::Mutex;

/// A partir de cuántos segundos de reloj damos la partida por empezada de verdad.
/// Sirve para no fijar el desfase vídeo↔partida durante la pantalla de carga.
const GAME_CLOCK_RUNNING_SECS: f64 = 3.0;

/// Aviso de la grabadora hacia la interfaz. Se emite como evento `recorder_alert`.
///
/// Existe porque hasta ahora TODOS los fallos de grabación morían en un
/// `eprintln!`: la partida se quedaba sin vídeo y la app no lo decía en ningún
/// sitio. `kind` es la clave estable (el texto lo traduce el frontend);
/// `message` es un respaldo legible y `detail` el motivo técnico o la ruta.
#[derive(serde::Serialize, Clone)]
pub struct RecorderAlert {
    /// "start_failed" | "stopped_unexpectedly" | "disk_low" | "disk_full"
    /// | "replay_saved" | "replay_failed"
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Emite un `recorder_alert`. Best-effort: si la ventana no está, no pasa nada.
pub fn emit_recorder_alert(
    app: &tauri::AppHandle,
    kind: &str,
    message: &str,
    detail: Option<String>,
) {
    let _ = app.emit(
        "recorder_alert",
        RecorderAlert {
            kind: kind.to_string(),
            message: message.to_string(),
            detail,
        },
    );
}

/// Progreso del mantenimiento de la biblioteca al arrancar. Se emite como
/// evento `library_maintenance`.
///
/// `phase` es la clave estable de la etapa: `"migration"`, `"camera"`,
/// `"impact"` o `"done"`. `done`/`total` son partidas (0/0 en las etapas que no
/// cuentan partidas). La UI puede ignorarlo por completo: el mantenimiento
/// corre igual y en segundo plano.
#[derive(serde::Serialize, Clone)]
pub struct MaintenanceProgress {
    pub phase: String,
    pub done: usize,
    pub total: usize,
}

/// Emite un `library_maintenance`. Best-effort, como el resto de eventos: si la
/// ventana aún no está montada no pasa nada.
pub fn emit_maintenance(app: &tauri::AppHandle, phase: &str, done: usize, total: usize) {
    let _ = app.emit(
        "library_maintenance",
        MaintenanceProgress { phase: phase.to_string(), done, total },
    );
}

#[derive(serde::Serialize)]
pub struct DiskSpaceInfo {
    pub used_bytes: u64,
    pub total_bytes: u64,
    /// Bytes libres REALES del volumen donde se graba. 0 si no se pudo consultar.
    /// La cuota de la app no dice nada de esto: se puede estar al 20% de la cuota
    /// y no caber una partida más porque el disco está lleno por otras cosas.
    pub free_bytes: u64,
    /// Capacidad total de ese volumen. 0 si no se pudo consultar.
    pub drive_total_bytes: u64,
}

#[tauri::command]
pub async fn get_disk_usage() -> DiskSpaceInfo {
    // El total es la CUOTA CONFIGURADA, no un 100 fijo: la barra, el aviso de
    // "disco ajustado" (>=85%) y la limpieza rápida de la biblioteca calculan
    // el porcentaje contra este número, y con el límite inventado mentían.
    let quota_gb = crate::storage::load_config()
        .max_storage_gb
        .max(crate::storage::MIN_STORAGE_GB);
    let (free_bytes, drive_total_bytes) =
        crate::storage::disk_space_bytes(&crate::storage::get_videos_dir()).unwrap_or((0, 0));
    DiskSpaceInfo {
        // Cacheado (60 s): recorrer el árbol entero en cada refresco de la
        // biblioteca era una lectura de disco periódica para pintar una barra.
        used_bytes: crate::storage::videos_dir_size_cached(),
        total_bytes: quota_gb * 1024 * 1024 * 1024,
        free_bytes,
        drive_total_bytes,
    }
}

/// Atajos globales configurables. Fichero propio, ver `storage::HotkeyConfig`.
#[tauri::command]
pub fn get_hotkeys() -> crate::storage::HotkeyConfig {
    crate::storage::load_hotkeys()
}

#[tauri::command]
pub fn set_hotkeys(
    replay: String,
    ult_state: State<'_, Arc<UltState>>,
) -> Result<crate::storage::HotkeyConfig, String> {
    let escrito = replay.trim().to_uppercase();
    // Una tecla que el listener no sabe parsear dejaría el atajo muerto sin decir
    // nada: se rechaza aquí, que es donde el usuario puede corregirlo.
    let Some(tecla) = crate::training::parse_key(&escrito) else {
        return Err(format!("Unrecognized key: \"{escrito}\""));
    };
    // Se guarda el nombre CANÓNICO, no el que se escribió: "kp3", "numpad3" y
    // "NUM3" son la misma tecla, y dejar en el fichero la forma que tecleó cada
    // uno obliga a que todo lo que lo lea vuelva a normalizar.
    let replay = crate::training::key_name(tecla).unwrap_or(escrito);
    let cfg = crate::storage::HotkeyConfig { replay };
    crate::storage::save_hotkeys(&cfg)?;
    // El listener global lee de aquí en cada pulsación: sin esto el cambio no
    // valdría hasta reiniciar la app.
    *ult_state.replay_key.lock().unwrap() = cfg.replay.clone();
    Ok(cfg)
}
// Estructura para almacenar el estado de la partida actual en el worker de background
pub struct ActiveMatchState {
    pub id: Mutex<String>,
    pub champion: Mutex<String>,
    pub active_player: Mutex<String>,
    pub player_team: Mutex<String>,               // "ORDER"/"CHAOS"
    pub team_map: Mutex<HashMap<String, String>>, // summonerName(lower) -> team
    pub events: Mutex<Vec<MatchEvent>>,
    pub is_auto_recording: Mutex<bool>,
    pub apm_samples: Mutex<Vec<(f64, u64)>>, // (tiempo de juego, acciones acumuladas)
    pub mouse_events: Mutex<Vec<MouseEventData>>,
    pub recording_start: Mutex<Option<std::time::Instant>>,
    pub game_time_offset: Mutex<Option<f64>>,
    /// ¿Esta sesión tiene vídeo? Se pone a false si la grabación no arrancó, si
    /// el disco no daba para empezarla o si el output se murió a media partida.
    /// La partida se sigue registrando entera (eventos, APM, entrenamiento): lo
    /// único que cambia es que su `video_path` acabará vacío.
    pub has_video: Mutex<bool>,
}

impl Default for ActiveMatchState {
    fn default() -> Self {
        Self {
            id: Mutex::new(String::new()),
            champion: Mutex::new("Unknown".to_string()),
            active_player: Mutex::new(String::new()),
            player_team: Mutex::new("ORDER".to_string()),
            team_map: Mutex::new(HashMap::new()),
            events: Mutex::new(Vec::new()),
            is_auto_recording: Mutex::new(false),
            apm_samples: Mutex::new(Vec::new()),
            mouse_events: Mutex::new(Vec::new()),
            recording_start: Mutex::new(None),
            game_time_offset: Mutex::new(None),
            has_video: Mutex::new(false),
        }
    }
}

#[tauri::command]
pub async fn get_recorded_matches() -> Vec<MatchMetadata> {
    // El listado NO necesita la estela del ratón (arrays enormes). El reproductor
    // la carga aparte vía `get_match_details`. `load_all_matches` ya ni siquiera
    // la parsea (ver `storage::sin_estela`): antes se construían cientos de
    // miles de puntos para vaciarlos acto seguido, en cada refresco periódico.
    load_all_matches()
}

#[tauri::command]
pub fn delete_match(id: String) -> Result<(), String> {
    // El registro de entrenamiento vive fuera de la carpeta de la partida: hay que
    // borrarlo aparte para no dejar huérfanos en %APPDATA%.
    awareness::delete_record(&id);
    let r = delete_match_files(&id);
    crate::storage::invalidate_disk_cache();
    r
}

/// Borrado por lotes en UNA llamada: en serie (dos borrados en paralelo pueden
/// pisarse al mudar clips a `recortes/`) y con un solo refresco de la caché de
/// disco al final. Devuelve los ids que no se pudieron borrar.
#[tauri::command]
pub fn delete_matches(ids: Vec<String>) -> Vec<String> {
    let mut fallidos = Vec::new();
    for id in &ids {
        awareness::delete_record(id);
        if delete_match_files(id).is_err() {
            fallidos.push(id.clone());
        }
    }
    crate::storage::invalidate_disk_cache();
    fallidos
}

#[tauri::command]
pub fn get_recorder_status(state: State<'_, Arc<RecorderState>>) -> bool {
    is_recording(&state)
}

/// Guarda un clip con los últimos segundos de juego (replay buffer). Devuelve la ruta del clip.
///
/// Misma ruta que el atajo global de `ultimate.rs`: el clip acaba en la carpeta
/// de la partida con el nombre `<match_id>_clip_<mmss>.mp4`, que es el único que
/// `get_all_clips` sabe listar.
#[tauri::command]
pub fn save_replay_clip(
    app: tauri::AppHandle,
    state: State<'_, Arc<RecorderState>>,
) -> Result<String, String> {
    match crate::recorder::save_replay(&state) {
        Ok(path) => {
            emit_recorder_alert(&app, "replay_saved", "Replay clip saved", Some(path.clone()));
            Ok(path)
        }
        Err(e) => {
            emit_recorder_alert(
                &app,
                "replay_failed",
                "Could not save the replay clip",
                Some(e.clone()),
            );
            Err(e)
        }
    }
}

/// Persiste los comentarios (con marca de tiempo) de una partida en su JSON.
#[tauri::command]
pub fn save_match_comments(
    match_id: String,
    comments: Vec<crate::storage::Comment>,
) -> Result<(), String> {
    crate::storage::save_comments(&match_id, comments)
}

/// Marca o desmarca un suceso como revisado, para la cola de revisión.
///
/// Se guarda en el propio JSON de la partida, junto a los comentarios: revisar
/// una partida es una tarea con estado, y ese estado tiene que sobrevivir a
/// cerrar la app.
#[tauri::command]
pub fn set_event_reviewed(match_id: String, time: f64, reviewed: bool) -> Result<(), String> {
    crate::storage::set_event_reviewed(&match_id, time, reviewed)
}

/// Rellena el scoreboard (10 jugadores) de una partida ya sincronizada con Riot. Devuelve la
/// metadata actualizada. Para partidas antiguas sin `participants`.
#[tauri::command]
pub async fn sync_match_now(match_id: String) -> Result<crate::storage::MatchMetadata, String> {
    crate::riot_api::backfill_participants(&match_id).await
}

/// Comprueba la clave de Riot que está guardada ahora mismo. La UI lo llama al
/// guardarla: sin esto, una clave mala no se nota hasta que algo falla mucho
/// después y con un error que no la señala.
///
/// Recibe el `AppHandle` para dejarlo registrado: es la vía por la que el resto
/// del módulo de Riot puede emitir `riot_key_status` desde funciones que no lo
/// reciben. La UI llama a esto al arrancar, así que el banner de la clave está
/// bien desde el primer segundo.
#[tauri::command]
pub async fn check_riot_key(app: tauri::AppHandle) -> Result<(), String> {
    crate::riot_api::set_app_handle(app);
    let config = crate::storage::load_config();
    // Con proxy la clave la pone el servidor: no hay nada que comprobar aquí.
    let hay_proxy = !config.riot_proxy_url.trim().is_empty();
    if config.riot_api_key.trim().is_empty() && !hay_proxy {
        crate::riot_api::emit_key_status("missing", "No hay clave de Riot configurada");
        return Err("No hay clave configurada".to_string());
    }
    let r = crate::riot_api::RiotApiClient::with_config(config.riot_api_key.clone(), &config)
        .check_key()
        .await;
    if r.is_ok() {
        crate::riot_api::emit_key_status("ok", "");
    }
    r
}

/// Reparto de crédito de los 10 jugadores: cuánto oro de asesinatos les adjudica
/// el marcador por rematar, cuánto les corresponde por el daño que pusieron de
/// verdad, y lo que costó cada muerte. Ver `crate::attribution`.
#[tauri::command]
pub async fn get_match_attribution(
    match_id: String,
) -> Result<Vec<crate::attribution::PlayerCredit>, String> {
    crate::riot_api::attribution_for(&match_id).await
}

/// Procesa el vídeo de una partida para sacar posiciones densas del minimapa.
///
/// Devuelve enseguida: el trabajo (unos 2 min) va en un hilo aparte y avisa por
/// el evento `minimap_progress` con `(match_id, porcentaje)`. El −1 significa
/// que terminó mal.
///
/// **Lo pide el usuario, no la navegación.** Esto se llamaba solo al abrir la
/// pestaña de Impacto y, como el hijo salía con consola propia, cerrar esa
/// ventana negra mataba el trabajo antes de que escribiera nada.
#[tauri::command]
pub async fn process_match_minimap(app: tauri::AppHandle, match_id: String) -> Result<(), String> {
    crate::minimap::spawn_processing(&app, &match_id)
}

/// En qué punto está ese procesado, y cuánto hay hecho de una pasada anterior.
#[derive(serde::Serialize)]
pub struct MinimapStatus {
    pub state: crate::minimap::Estado,
    /// 0-100 de lo ya guardado, si quedó trabajo a medias.
    pub saved_progress: Option<f64>,
}

#[tauri::command]
pub async fn get_minimap_status(
    app: tauri::AppHandle,
    match_id: String,
) -> Result<MinimapStatus, String> {
    Ok(MinimapStatus {
        state: crate::minimap::estado(&app, &match_id),
        saved_progress: crate::minimap::avance_guardado(&match_id),
    })
}

/// Para el procesado a medias. Lo calculado hasta ahora se conserva y la
/// siguiente pasada lo retoma donde lo dejó.
#[tauri::command]
pub async fn cancel_match_minimap(match_id: String) -> Result<(), String> {
    crate::minimap::cancelar(&match_id);
    Ok(())
}

/// Tramos en los que un jugador tuvo más rivales encima que aliados, con lo que
/// su equipo consiguió lejos de allí mientras tanto. Ver `crate::pressure`.
/// Tiempos en el eje del vídeo.
#[tauri::command]
pub async fn get_match_pressure(
    match_id: String,
) -> Result<Vec<crate::pressure::PressureWindow>, String> {
    crate::riot_api::pressure_for(&match_id).await
}

#[derive(serde::Serialize)]
pub struct AudioStatus {
    /// Dispositivo de captura de audio del sistema detectado (sonido del juego), si existe.
    pub system_audio_device: Option<String>,
    /// Todos los dispositivos de audio DirectShow disponibles.
    pub all_devices: Vec<String>,
    /// true si hay una fuente válida para capturar el sonido del juego.
    pub ready_for_game_audio: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct VideoSettings {
    pub fps: i32,
    pub quality: String, // "High", "Medium", "Low"
    /// Lienzo de grabación: "native" (lo que mida el cliente de League, acotado
    /// a 1440p), "1080p" o "1440p". Ver `recorder::canvas_size`.
    #[serde(default = "default_resolution")]
    pub resolution: String,
}

fn default_resolution() -> String {
    "native".to_string()
}

impl Default for VideoSettings {
    fn default() -> Self {
        Self {
            fps: 60,
            quality: "High".to_string(),
            resolution: default_resolution(),
        }
    }
}

#[tauri::command]
pub fn get_video_settings(state: State<'_, Arc<std::sync::Mutex<VideoSettings>>>) -> VideoSettings {
    state.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_video_settings(
    fps: i32,
    quality: String,
    // Opcional a propósito: la pantalla de ajustes todavía no lo manda y no debe
    // resetear la resolución a "native" cada vez que se toca la calidad.
    resolution: Option<String>,
    state: State<'_, Arc<std::sync::Mutex<VideoSettings>>>,
) -> VideoSettings {
    let mut s = state.lock().unwrap();
    s.fps = fps;
    s.quality = quality;
    if let Some(r) = resolution {
        // Un valor desconocido se trata como "native" en vez de guardarse tal
        // cual: así nunca queda una config que la grabadora no sepa interpretar.
        s.resolution = match r.as_str() {
            "1080p" => "1080p".to_string(),
            "1440p" => "1440p".to_string(),
            _ => default_resolution(),
        };
    }
    s.clone()
}

/// Estado real de la captura de sonido del juego.
///
/// Era un stub que devolvía `ready_for_game_audio: true` pasara lo que pasase.
/// Ahora hay dos fuentes de verdad, de la más fuerte a la más débil:
///   1. si hay (o hubo) un servidor de grabación, lo que él contestó sobre si la
///      fuente `wasapi_output_capture` llegó a crearse;
///   2. si aún no se ha grabado nada, si el sistema tiene siquiera un dispositivo
///      de reproducción — sin salida de audio no hay loopback posible.
#[tauri::command]
pub fn get_audio_status(state: State<'_, Arc<RecorderState>>) -> AudioStatus {
    // Mientras hay algo grabando se le pregunta al servidor; si no, vale la
    // última respuesta que dio (con la tubería parada la fuente de audio no
    // existe, así que preguntar entonces siempre diría "no" y sería mentira).
    let del_servidor = crate::recorder::probe_status(&state)
        .filter(|s| s.active)
        .map(|s| s.audio)
        .or_else(|| crate::recorder::last_audio_ok(&state));
    let system_audio_device = detect_system_audio_device();
    let ready_for_game_audio = del_servidor.unwrap_or_else(|| system_audio_device.is_some());
    AudioStatus {
        ready_for_game_audio,
        system_audio_device: if ready_for_game_audio {
            system_audio_device
        } else {
            None
        },
        // La lista de dispositivos DirectShow murió con el motor de ffmpeg: OBS
        // captura el loopback del dispositivo por defecto y no hay nada que
        // elegir. Se deja vacía en vez de inventar entradas.
        all_devices: vec![],
    }
}

#[tauri::command]
pub async fn start_manual_recording(
    id: String,
    state: State<'_, Arc<RecorderState>>,
    active_match: State<'_, Arc<ActiveMatchState>>,
    video_settings: State<'_, Arc<std::sync::Mutex<VideoSettings>>>,
) -> Result<String, String> {
    let settings = video_settings.lock().unwrap().clone();
    let path = start_recording(&id, &state, &settings)?;

    // Configurar estado manual
    *active_match.id.lock().await = id;
    *active_match.champion.lock().await = "Manual Test".to_string();
    *active_match.active_player.lock().await = "Player".to_string();
    active_match.events.lock().await.clear();
    active_match.mouse_events.lock().await.clear();
    *active_match.is_auto_recording.lock().await = false;
    *active_match.recording_start.lock().await = Some(std::time::Instant::now());
    *active_match.has_video.lock().await = true;

    Ok(path)
}

#[tauri::command]
pub async fn stop_manual_recording(
    state: State<'_, Arc<RecorderState>>,
    active_match: State<'_, Arc<ActiveMatchState>>,
) -> Result<(), String> {
    // El error de `stop` no aborta el guardado: la grabación de prueba puede
    // haber quedado en disco igualmente y, si no, el metadata con `video_path`
    // vacío es justo lo que explica por qué no hay vídeo.
    let fallo_al_parar = stop_recording(&state).err();
    crate::storage::check_storage_quota();

    // Guardar metadata de la prueba manual
    let id = active_match.id.lock().await.clone();
    if !id.is_empty() {
        // Duración REAL, no los 30 s inventados de antes: se medía desde que
        // empezó la grabación y nadie la miraba.
        let duracion = active_match
            .recording_start
            .lock()
            .await
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        let mp4 = crate::storage::get_match_dir(&id).join(format!("{}.mp4", id));
        let video_path = video_path_si_sirve(&mp4);
        let mouse_space = crate::ultimate::mouse_coordinate_space();
        let metadata = MatchMetadata {
            id: id.clone(),
            game_duration: duracion,
            video_path,
            // No hay partida que ganar ni perder en una grabación manual: decir
            // "Victory" era una etiqueta falsa que la biblioteca contaba como tal.
            result: "Unknown".to_string(),
            champion: active_match.champion.lock().await.clone(),
            date: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            // Solo el principio y el final REALES. El "Test kill" del segundo
            // 12,5 que había aquí era un suceso inventado que la línea de tiempo
            // pintaba como si hubiera pasado.
            events: vec![
                MatchEvent::plain("GameStart", None, 0.0, "Manual recording started".to_string()),
                MatchEvent::plain(
                    "GameEnd",
                    Some("recording"),
                    duracion,
                    "Manual recording finished".to_string(),
                ),
            ],
            apm: 0.0,
            apm_series: Vec::new(),
            mouse_events: active_match.mouse_events.lock().await.clone(),
            mouse_space_w: mouse_space.0,
            mouse_space_h: mouse_space.1,
            riot_match_id: None,
            kda: None,
            gold_earned: None,
            damage_dealt: None,
            participants: Vec::new(),
            queue: None,
            objectives: Vec::new(),
            item_purchases: Vec::new(),
            gold_diff_15: None,
            xp_diff_15: None,
            jungle_cs_diff_15: None,
        cs_diff_15: None,
            gank_impact_15: None,
            lane_result: None,
            impact_rank: None,
            impact_percentile: None,
        impact_backfill_v: 0,
            patch: None,
            tier_bucket: None,
            rank_tier: None,
            rank_division: None,
            rank_lp: None,
            timeline_markers: Vec::new(),
            minute_frames: Vec::new(),
            comments: Vec::new(),
            reviewed_moments: Vec::new(),
            is_vod: false,
            camera_snaps: Vec::new(),
            // La grabación manual empieza y acaba con el vídeo: no hay carga que descontar.
            video_offset: Some(0.0),
        };
        // Ya no se traga el error: si el metadata no se escribe, la grabación
        // existe en disco pero la biblioteca no la ve nunca. Eso hay que decirlo.
        save_match_metadata(&metadata)
            .map_err(|e| format!("No se pudieron guardar los metadatos: {e}"))?;
    }

    match fallo_al_parar {
        Some(e) => Err(format!("The recording did not close cleanly: {e}")),
        None => Ok(()),
    }
}

/// Ruta del mp4 si de verdad hay un vídeo utilizable ahí, y cadena vacía si no.
///
/// Un fichero que no existe o que pesa 0 bytes es lo que deja una grabación que
/// nunca arrancó o que murió antes de escribir nada. Guardar su ruta hacía que
/// el reproductor intentara abrirlo y fallara sin explicar por qué; con la ruta
/// vacía el frontend puede decir "esta partida no tiene vídeo".
fn video_path_si_sirve(mp4: &std::path::Path) -> String {
    match std::fs::metadata(mp4) {
        Ok(m) if m.len() > 0 => mp4.to_string_lossy().to_string(),
        _ => String::new(),
    }
}

/// Bucle de segundo plano que corre indefinidamente detectando el juego y grabando de forma automatizada
pub fn spawn_background_monitor(
    recorder_state: Arc<RecorderState>,
    active_match: Arc<ActiveMatchState>,
    ult_state: Arc<UltState>,
    video_settings_state: Arc<std::sync::Mutex<VideoSettings>>,
    training_state: Arc<TrainingState>,
    app: tauri::AppHandle,
) {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            // La retención se pasaba SOLO al parar una grabación: quien deja la
            // app abierta sin jugar nunca la ejecutaba, y quien tiene el borrado
            // por edad activado no veía desaparecer nada hasta la siguiente
            // partida. Ahora al arrancar y cada hora.
            crate::storage::check_storage_quota();
            let mut last_quota_pass = std::time::Instant::now();

            let api_client = LolApiClient::new();
            let mut last_event_id = -1;
            let mut game_start_time = Local::now();
            let mut close_grace_ticks = 0;
            // Evita reiniciar la grabación durante la pantalla post-partida (la API sigue viva).
            let mut awaiting_new_game = false;
            // Seguimiento del tiempo de juego para alinear en el vídeo los eventos
            // que llegan por teclado/ratón (teclas de cámara, estela, muestras de APM).
            let mut last_game_time: f64 = 0.0;
            let mut last_game_time_at = std::time::Instant::now();
            let mut last_ult_time: f64 = -100.0;
            // Entrenamiento de cámara: fotos del estado de la partida (para el quiz) y
            // pulsaciones de las teclas de cámara aliada (para las métricas).
            let mut snapshots: Vec<GameSnapshot> = Vec::new();
            let mut cam_presses: Vec<CameraPress> = Vec::new();
            // Clics de minimapa con su carril, en tiempo de juego. El metrónomo
            // los acepta como respuesta igual que una tecla de cámara: es el
            // gesto con el que la mayoría mira el mapa.
            let mut cam_looks: Vec<(f64, &'static str)> = Vec::new();
            let espacio_raton = crate::ultimate::mouse_coordinate_space();
            let mut last_snapshot_time: f64 = -1e9;
            // Metrónomo: rotación de roles, aviso pendiente y resultados.
            let mut metro: MetronomeRunner = MetronomeRunner::default();
            // Config de entrenamiento: se relee al empezar cada partida, no en cada
            // tick (sería un acceso a disco por segundo durante toda la partida).
            let mut tcfg = crate::training::load_config();
            // Hay partida en curso. Se sigue APARTE de si la grabación arrancó: el
            // entrenamiento (eventos, teclas de cámara, quiz) solo necesita la API del
            // juego y el teclado, así que un fallo de la grabadora no debe cegarlo.
            let mut session_active = false;
            // Sondeo de vida del output de OBS: `is_recording` solo dice si
            // QUEREMOS grabar. Cada 5 ticks se le pregunta al servidor si sigue
            // emitiendo de verdad, y el aviso de muerte se da UNA vez por sesión.
            let mut liveness_ticks: u32 = 0;
            let mut death_reported = false;

            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;

                // Pasada de retención cada hora, juegue o no.
                if last_quota_pass.elapsed() >= Duration::from_secs(3600) {
                    crate::storage::check_storage_quota();
                    last_quota_pass = std::time::Instant::now();
                }

                // Comprobar si el servidor local está vivo llamando a get_events().
                // Si responde Ok, significa que el juego está activo (independiente de si algún endpoint da 404 momentáneo).
                let events_result = api_client.get_events().await;
                let lol_running = events_result.is_ok();

                if lol_running && !session_active && !awaiting_new_game {
                    session_active = true;
                    let match_id = format!("match_{}", Local::now().format("%Y%m%d_%H%M%S"));
                    println!("Detección automática: Servidor del juego detectado en el puerto 2999. Grabadora activa.");

                    // Inicializar metadatos de partida activa con valores por defecto
                    // y los iremos actualizando en diferido
                    *active_match.id.lock().await = match_id.clone();
                    *active_match.champion.lock().await = "Unknown".to_string();
                    *active_match.active_player.lock().await = "Player".to_string();
                    active_match.events.lock().await.clear();
                    *active_match.is_auto_recording.lock().await = true;
                    last_event_id = -1;
                    game_start_time = Local::now();
                    close_grace_ticks = 0;
                    // Reiniciar el seguimiento de tiempo de juego para la nueva partida.
                    last_game_time = 0.0;
                    last_game_time_at = std::time::Instant::now();
                    *active_match.game_time_offset.lock().await = None;
                    // Reiniciar el conteo de acciones (APM) y empezar a contar.
                    ult_state.actions.store(0, Ordering::Relaxed);
                    ult_state.counting.store(true, Ordering::Relaxed);
                    ult_state.presses.lock().unwrap().clear();
                    last_ult_time = -100.0;
                    // Empezar a registrar las teclas de cámara aliada de esta partida.
                    training_state.reset();
                    training_state.active.store(true, Ordering::Relaxed);
                    // Recargamos la config por si cambió entre partidas.
                    tcfg = crate::training::load_config();
                    training_state.set_bindings(tcfg.bindings.clone());
                    snapshots.clear();
                    cam_presses.clear();
                    last_snapshot_time = -1e9;
                    // El primer aviso espera a que empiece la fase de líneas: pedir
                    // que mires al top mientras compras en la base no entrena nada.
                    metro.start(&tcfg, 90.0);
                    if metro.is_enabled() {
                        crate::overlay::show(&app);
                    }
                    active_match.apm_samples.lock().await.clear();
                    active_match.mouse_events.lock().await.clear();
                    ult_state.mouse_events.lock().unwrap().clear();

                    // Registrar evento inicial
                    active_match.events.lock().await.push(MatchEvent::plain(
                        "GameStart",
                        None,
                        0.0,
                        "Game start".to_string(),
                    ));

                    // Iniciar grabación. La partida sigue "activa" aunque no haya vídeo: el
                    // entrenamiento y los eventos se recogen igual (antes esto reintentaba en
                    // bucle cada segundo y dejaba todo lo demás sin ejecutarse nunca). Lo que
                    // cambia es que ahora se DICE, en vez de morir en un eprintln.
                    *active_match.has_video.lock().await = false;
                    liveness_ticks = 0;
                    death_reported = false;

                    // Espacio físico ANTES de empezar: una grabación que arranca en un
                    // disco a cero se corta a los pocos minutos y encima se lleva por
                    // delante el resto de la sesión.
                    let libres = crate::storage::free_disk_bytes(&crate::storage::get_videos_dir());
                    let sin_sitio = libres.map_or(false, |b| b < crate::storage::DISK_FULL_BYTES);
                    if sin_sitio {
                        let gb = libres.unwrap_or(0) as f64 / 1024f64.powi(3);
                        eprintln!("Disco lleno ({gb:.1} GB libres): no se graba esta partida.");
                        emit_recorder_alert(
                            &app,
                            "disk_full",
                            "Not enough free disk space to record this game",
                            Some(format!("{gb:.1} GB free")),
                        );
                        // Un intento de liberar sitio para la SIGUIENTE partida.
                        crate::storage::check_storage_quota();
                        last_quota_pass = std::time::Instant::now();
                    } else {
                        if let Some(b) = libres {
                            if b < crate::storage::DISK_LOW_BYTES {
                                let gb = b as f64 / 1024f64.powi(3);
                                emit_recorder_alert(
                                    &app,
                                    "disk_low",
                                    "Running low on disk space",
                                    Some(format!("{gb:.1} GB free")),
                                );
                            }
                        }
                        let settings = video_settings_state.lock().unwrap().clone();
                        if let Err(e) = start_recording(&match_id, &recorder_state, &settings) {
                            eprintln!("Fallo al iniciar grabación (se sigue registrando la partida sin vídeo): {}", e);
                            emit_recorder_alert(
                                &app,
                                "start_failed",
                                "Recording could not be started; the game is still being tracked",
                                Some(e),
                            );
                        } else {
                            *active_match.recording_start.lock().await =
                                Some(std::time::Instant::now());
                            *active_match.has_video.lock().await = true;
                        }
                    }
                } else if !lol_running && session_active {
                    // Salida brusca SIN evento GameEnd (cierre/crash). Usamos ticks de gracia
                    // por si es un fallo momentáneo de la API.
                    close_grace_ticks += 1;
                    if close_grace_ticks >= 3 {
                        println!("Detección automática: La API no responde. Finalizando grabación...");
                        let snaps = cam_presses.iter().map(|c| c.t).collect::<Vec<_>>();
                        persist_awareness(&app, &active_match, &training_state, &mut snapshots, &mut cam_presses, &mut metro, last_game_time).await;
                        finalize_match(&app, &recorder_state, &active_match, &ult_state, game_start_time, snaps).await;
                        session_active = false;
                        awaiting_new_game = false;
                        close_grace_ticks = 0;
                    } else {
                        println!("Detección automática: La API del juego no responde (Ticks de gracia: {}/3)", close_grace_ticks);
                    }
                } else if !lol_running && !session_active {
                    // El juego/cliente se cerró del todo: listos para una nueva partida.
                    awaiting_new_game = false;
                    close_grace_ticks = 0;
                } else if session_active {
                    close_grace_ticks = 0;

                    // ¿Sigue grabando de verdad? `is_recording` refleja la intención;
                    // el servidor sabe si el output se cayó (encoder que revienta,
                    // disco lleno a media partida, el propio libobs muriéndose).
                    liveness_ticks += 1;
                    if liveness_ticks >= 5 {
                        liveness_ticks = 0;
                        let esperabamos_video = *active_match.has_video.lock().await;
                        if esperabamos_video && !death_reported {
                            // `None` = no se pudo preguntar; eso NO es prueba de
                            // muerte y no marca la sesión sin vídeo.
                            if let Some(st) = crate::recorder::probe_status(&recorder_state) {
                                if !st.recording {
                                    death_reported = true;
                                    *active_match.has_video.lock().await = false;
                                    eprintln!("La grabación se detuvo sola a media partida.");
                                    emit_recorder_alert(
                                        &app,
                                        "stopped_unexpectedly",
                                        "Recording stopped on its own; the rest of the game has no video",
                                        None,
                                    );
                                }
                            }
                        }
                    }

                    // Cargar (en diferido) el contexto de la partida si aún no lo tenemos:
                    // campeón, nombre de invocador, equipo y el mapa de equipos de todos los jugadores.
                    let current_champ = active_match.champion.lock().await.clone();
                    if current_champ == "Unknown" {
                        if let Ok(ctx) = api_client.get_game_context().await {
                            println!("Detección diferida: {} ({}), equipo {}", ctx.active_player, ctx.champion, ctx.team);
                            *active_match.champion.lock().await = ctx.champion;
                            *active_match.active_player.lock().await = ctx.active_player;
                            *active_match.player_team.lock().await = ctx.team;
                            let mut map = active_match.team_map.lock().await;
                            map.clear();
                            for (name, team) in ctx.players {
                                map.insert(strip_tag(&name), team);
                            }
                        }
                    }

                    // Actualizar el tiempo de juego (el nivel de la R ya no se usa:
                    // la detección de ultimate se retiró, ver `ultimate.rs`).
                    if let Ok((gt, _r_level)) = api_client.get_live_state().await {
                        let mut offset_guard = active_match.game_time_offset.lock().await;
                        // El reloj de /allgamedata se queda clavado en ~0 (pero no en 0 exacto)
                        // mientras dura la pantalla de carga. Con `gt > 0.0` el offset se fijaba
                        // ahí, ANTES de que la partida empezara, y todos los eventos quedaban
                        // adelantados lo que hubiese durado la carga (medido: hasta ~1:45).
                        // Esperamos a que el reloj corra de verdad: mientras corre,
                        // `gt - tiempo_de_vídeo` es constante, así que fijarlo unos segundos
                        // más tarde no resta ni un ápice de precisión.
                        if offset_guard.is_none() && gt >= GAME_CLOCK_RUNNING_SECS {
                            let rec_start = active_match.recording_start.lock().await;
                            if let Some(start) = *rec_start {
                                let video_time = std::time::Instant::now().saturating_duration_since(start).as_secs_f64();
                                *offset_guard = Some(gt - video_time);
                                println!("Calculado game_time_offset: {}", gt - video_time);
                            }
                        }

                        last_game_time = gt;
                        last_game_time_at = std::time::Instant::now();
                        // Muestrear el contador de acciones para el APM.
                        let actions = ult_state.actions.load(Ordering::Relaxed);
                        active_match.apm_samples.lock().await.push((gt, actions));
                    }

                    // --- Entrenamiento de cámara ---
                    // Pulsaciones de las teclas de cámara aliada, pasadas a tiempo de juego.
                    for (inst, role) in training_state.drain_presses() {
                        let ago = last_game_time_at.saturating_duration_since(inst).as_secs_f64();
                        cam_presses.push(CameraPress {
                            t: (last_game_time - ago).max(0.0),
                            role,
                        });
                    }
                    
                    // --- Uso de Ultimate ---
                    let presses: Vec<std::time::Instant> = {
                        let mut guard = ult_state.presses.lock().unwrap();
                        guard.drain(..).collect()
                    };
                    if !presses.is_empty() {
                        let mut ult_events = Vec::new();
                        for p in presses {
                            let ago = last_game_time_at.saturating_duration_since(p).as_secs_f64();
                            let gt = (last_game_time - ago).max(0.0);
                            // Debouncing de 8s para evitar flood
                            if gt - last_ult_time < 8.0 { continue; } 
                            last_ult_time = gt;
                            ult_events.push(MatchEvent::plain(
                                "Ultimate",
                                Some("R"),
                                gt,
                                "Ultimate (R)".to_string(),
                            ));
                        }
                        if !ult_events.is_empty() {
                            active_match.events.lock().await.extend(ult_events);
                        }
                    }

                    // Metrónomo: pedir el siguiente aliado o resolver el aviso anterior.
                    match metro.tick(last_game_time, &cam_presses, &cam_looks) {
                        Some(MetronomeEvent::Prompt { role, key, window_secs }) => {
                            let _ = app.emit(
                                "metronome_prompt",
                                serde_json::json!({ "role": role, "key": key, "window_secs": window_secs }),
                            );
                        }
                        Some(MetronomeEvent::Ack { ok, role, latency_ms }) => {
                            let _ = app.emit(
                                "metronome_ack",
                                serde_json::json!({ "ok": ok, "role": role, "latency_ms": latency_ms }),
                            );
                        }
                        None => {}
                    }

                    // Foto del estado de los 10 jugadores cada N segundos: es la fuente de
                    // verdad con la que luego se corrige el quiz de awareness.
                    if tcfg.awareness_quiz_enabled
                        && last_game_time - last_snapshot_time
                            >= tcfg.snapshot_interval_secs.max(1) as f64
                    {
                        if let Ok(raw) = api_client.get_allgamedata().await {
                            let active_name = active_match.active_player.lock().await.clone();
                            let active_norm = strip_tag(&active_name);
                            if let Some(snap) =
                                awareness::snapshot_from_allgamedata(&raw, &active_norm)
                            {
                                // Sin saber quiénes somos no podemos distinguir aliados de
                                // enemigos: mejor descartar la foto que guardar una inútil.
                                if snap.players.iter().any(|p| p.is_self) {
                                    last_snapshot_time = snap.t;
                                    snapshots.push(snap);
                                }
                            }
                        }
                    }

                    // Nuevo: Procesar eventos del ratón
                    let raw_mouse_events = {
                        let mut guard = ult_state.mouse_events.lock().unwrap();
                        guard.drain(..).collect::<Vec<_>>()
                    };
                    if !raw_mouse_events.is_empty() {
                        let mut me_guard = active_match.mouse_events.lock().await;
                        let rec_start_guard = active_match.recording_start.lock().await;
                        if let Some(rec_start) = *rec_start_guard {
                            // `game_time_offset` guarda `t_partida - t_vídeo`, así que
                            // sumarlo lleva un instante del vídeo al reloj de la partida,
                            // que es en el que trabaja el metrónomo.
                            let desfase = active_match.game_time_offset.lock().await.unwrap_or(0.0);
                            // La escala del minimapa se lee UNA vez por tanda,
                            // no por clic: es un fichero de config en disco.
                            let escala_minimapa = crate::storage::load_config().minimap_scale;
                            for (inst, x, y, evt_str) in raw_mouse_events {
                                // Usamos el instante relativo al momento en que empezó el video
                                let gt = inst.saturating_duration_since(rec_start).as_secs_f64();
                                if evt_str == "left_click" {
                                    if let Some(carril) = crate::camera_input::lane_of_click(
                                        x,
                                        y,
                                        espacio_raton.0 as f64,
                                        espacio_raton.1 as f64,
                                        escala_minimapa,
                                    ) {
                                        cam_looks.push((gt + desfase, carril));
                                    }
                                }
                                me_guard.push(MouseEventData {
                                    t: gt,
                                    x,
                                    y,
                                    evt: evt_str,
                                });
                            }
                        }
                    }

                    // Polling de eventos de la partida.
                    let active_name = active_match.active_player.lock().await.clone();
                    let player_team = active_match.player_team.lock().await.clone();
                    let team_map = active_match.team_map.lock().await.clone();
                    let game_time_offset = active_match.game_time_offset.lock().await.unwrap_or(0.0);
                    let mut game_ended = false;
                    if let Ok(lol_events) = api_client.get_events().await {
                        let mut new_events = Vec::new();
                        for ev in lol_events {
                            if ev.event_id > last_event_id {
                                last_event_id = ev.event_id;
                                if let Some(mapped) = map_lol_event(&ev, &active_name, &player_team, &team_map, game_time_offset) {
                                    if mapped.r#type == "GameEnd" {
                                        game_ended = true;
                                    }
                                    new_events.push(mapped);
                                }
                            }
                        }
                        if !new_events.is_empty() {
                            active_match.events.lock().await.extend(new_events);
                        }
                    }

                    // La partida terminó (cayó el Nexo): detener YA en vez de esperar a que
                    // muera la API durante la pantalla de victoria/derrota (~15s de más).
                    if game_ended {
                        println!("Detección automática: evento GameEnd recibido. Finalizando grabación de inmediato.");
                        let snaps = cam_presses.iter().map(|c| c.t).collect::<Vec<_>>();
                        persist_awareness(&app, &active_match, &training_state, &mut snapshots, &mut cam_presses, &mut metro, last_game_time).await;
                        finalize_match(&app, &recorder_state, &active_match, &ult_state, game_start_time, snaps).await;
                        session_active = false;
                        awaiting_new_game = true;
                    }
                }
            }
        });
    });
}

/// Vuelca a disco lo recogido para el entrenamiento de cámara y deja de escuchar.
/// Se llama justo antes de finalizar la grabación, cuando `active_match` aún tiene
/// el id y el campeón de la partida que acaba de terminar.
async fn persist_awareness(
    app: &tauri::AppHandle,
    active_match: &Arc<ActiveMatchState>,
    training_state: &Arc<TrainingState>,
    snapshots: &mut Vec<GameSnapshot>,
    cam_presses: &mut Vec<CameraPress>,
    metro: &mut MetronomeRunner,
    duration_secs: f64,
) {
    training_state.active.store(false, Ordering::Relaxed);
    metro.stop();
    crate::overlay::hide(app);
    // Últimas pulsaciones que quedaran sin drenar en el buffer del listener.
    for (_, role) in training_state.drain_presses() {
        cam_presses.push(CameraPress { t: duration_secs, role });
    }

    if snapshots.is_empty() && cam_presses.is_empty() && metro.results.is_empty() {
        return;
    }
    let match_id = active_match.id.lock().await.clone();
    if match_id.is_empty() {
        snapshots.clear();
        cam_presses.clear();
        metro.results.clear();
        return;
    }

    let record = AwarenessRecord {
        match_id,
        date: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        champion: active_match.champion.lock().await.clone(),
        duration_secs,
        snapshots: std::mem::take(snapshots),
        camera_presses: std::mem::take(cam_presses),
        metronome: std::mem::take(&mut metro.results),
        pending_quiz: None,
        results: Vec::new(),
    };
    if let Err(e) = awareness::save_record(&record) {
        eprintln!("Entrenamiento: no se pudo guardar el registro de awareness: {}", e);
    }
}

// Utilidades para Duration y compatibilidad
use std::time::Duration;

/// Detiene la grabación, calcula los metadatos finales (duración, resultado, APM) y los guarda.
/// Si no hubo evento GameEnd de Riot (p.ej. salida brusca), añade un marcador de fin.
async fn finalize_match(
    app: &tauri::AppHandle,
    recorder_state: &Arc<RecorderState>,
    active_match: &Arc<ActiveMatchState>,
    ult_state: &Arc<UltState>,
    game_start_time: chrono::DateTime<Local>,
    camera_snaps: Vec<f64>,
) {
    let is_auto = *active_match.is_auto_recording.lock().await;
    // El error de `stop` ya no se tira: si el servidor no cerró la grabación, el
    // mp4 puede estar a medias o no existir, y eso lo tiene que saber el usuario.
    let fallo_al_parar = stop_recording(recorder_state).err();
    if let Some(e) = &fallo_al_parar {
        eprintln!("La grabación no cerró limpiamente: {e}");
    }
    crate::storage::check_storage_quota();
    ult_state.counting.store(false, Ordering::Relaxed);
    if !is_auto {
        return;
    }

    let match_id = active_match.id.lock().await.clone();
    if match_id.is_empty() {
        return;
    }
    let champion = active_match.champion.lock().await.clone();
    let duration = (Local::now() - game_start_time).num_seconds() as f64;

    // Segundos de vídeo que preceden al 0:00 del reloj de la partida (la carga).
    // `game_time_offset` guarda `t_partida - t_vídeo`, así que el desfase inverso
    // —el que convierte tiempo de partida en tiempo de vídeo— es su negativo.
    let video_offset = active_match.game_time_offset.lock().await.map(|o| -o);
    let to_video = |t_game: f64| (t_game + video_offset.unwrap_or(0.0)).max(0.0);

    // Las muestras de APM y los saltos de cámara se recogen en tiempo de partida, pero
    // la gráfica y las marcas se pintan sobre la línea del vídeo.
    let samples: Vec<(f64, u64)> = active_match
        .apm_samples
        .lock()
        .await
        .iter()
        .map(|(t, a)| (to_video(*t), *a))
        .collect();
    let (apm, apm_series) = compute_apm(&samples, duration);
    let camera_snaps: Vec<f64> = camera_snaps.iter().map(|t| to_video(*t)).collect();

    // Resultado a partir del GameEnd de Riot (subtype win/lose) y si ya existe ese evento.
    let mut result = "Unknown".to_string();
    let mut has_game_end = false;
    {
        let events_guard = active_match.events.lock().await;
        for ev in events_guard.iter() {
            if ev.r#type == "GameEnd" {
                has_game_end = true;
                match ev.subtype.as_deref() {
                    Some("win") => result = "Victory".to_string(),
                    Some("lose") => result = "Defeat".to_string(),
                    _ => {}
                }
            }
        }
    }
    if !has_game_end {
        // subtype "recording": marca que este GameEnd es el de respaldo, el que se
        // inventa cuando el juego se cierra a lo bruto y no llega el de la API.
        // La alineación necesita distinguirlo, y antes lo hacía comparando la
        // frase, que es fragil.
        active_match.events.lock().await.push(MatchEvent::plain(
            "GameEnd",
            Some("recording"),
            duration,
            "Recording finished".to_string(),
        ));
    }

    let mut final_duration = duration;
    let match_id_str = match_id.clone();
    let dir = crate::storage::get_match_dir(&match_id_str);

    let final_path = dir.join(format!("{}.mp4", match_id_str));

    // Si la partida se cerró abruptamente (sin GameEnd de la API), descontamos 10 segundos
    // y recortamos físicamente el video para que no se vea el escritorio.
    if !has_game_end && is_auto {
        final_duration = (duration - 10.0).max(1.0);

        // Esperamos un momento a que ffmpeg libere el archivo tras el kill()
        std::thread::sleep(std::time::Duration::from_millis(1500));

        if final_path.exists() {
            trim_en_sitio(&app, &final_path, final_duration);
        }
    }

    // La grabación puede no existir: nunca arrancó, murió a media partida, o el
    // recorte se quedó sin fichero. En ese caso el metadata se guarda IGUAL —los
    // eventos, el APM y el entrenamiento valen por sí solos— pero con la ruta de
    // vídeo vacía, para que el frontend pueda explicar por qué no hay reproductor.
    let habia_video = *active_match.has_video.lock().await;
    let video_path = video_path_si_sirve(&final_path);
    if video_path.is_empty() {
        let detalle = fallo_al_parar.clone().or_else(|| {
            Some(if habia_video {
                "the recording file is missing or empty".to_string()
            } else {
                "the recording never started".to_string()
            })
        });
        eprintln!(
            "Partida {} sin vídeo utilizable ({}).",
            match_id,
            detalle.clone().unwrap_or_default()
        );
        emit_recorder_alert(
            &app,
            if habia_video {
                "stopped_unexpectedly"
            } else {
                "start_failed"
            },
            "This game was saved without video",
            detalle,
        );
    }

    // Resolución del escritorio: es el espacio en el que `rdev` da las coordenadas
    // del ratón, y el reproductor lo necesita para escalar bien la estela.
    let mouse_space = crate::ultimate::mouse_coordinate_space();
    let metadata = MatchMetadata {
        id: match_id.clone(),
        game_duration: final_duration,
        video_path,
        result,
        champion,
        date: game_start_time.format("%Y-%m-%d %H:%M:%S").to_string(),
        events: active_match.events.lock().await.clone(),
        apm,
        apm_series,
        mouse_events: active_match.mouse_events.lock().await.clone(),
        mouse_space_w: mouse_space.0,
        mouse_space_h: mouse_space.1,
        riot_match_id: None,
        kda: None,
        gold_earned: None,
        damage_dealt: None,
        participants: Vec::new(),
        queue: None,
        objectives: Vec::new(),
        item_purchases: Vec::new(),
        gold_diff_15: None,
        xp_diff_15: None,
        jungle_cs_diff_15: None,
        cs_diff_15: None,
        gank_impact_15: None,
        lane_result: None,
        impact_rank: None,
        impact_percentile: None,
        impact_backfill_v: 0,
        patch: None,
        tier_bucket: None,
        rank_tier: None,
        rank_division: None,
        rank_lp: None,
        timeline_markers: Vec::new(),
        minute_frames: Vec::new(),
        comments: Vec::new(),
        reviewed_moments: Vec::new(),
        is_vod: false,
        camera_snaps,
        video_offset,
    };

    // Las miradas al mapa: las teclas de cámara que se acaban de recoger MÁS los
    // clics de minimapa de la estela, que hasta ahora nadie leía. Con esto una
    // grabación local no necesita el detector por vídeo. Ver `camera_input`.
    let mut metadata = metadata;
    let miradas = crate::camera_input::looks_from_input(
        &metadata,
        &metadata.camera_snaps,
        crate::storage::load_config().minimap_scale,
    );
    crate::camera_input::write_report(&metadata, &miradas);
    metadata.camera_snaps = miradas.iter().map(|l| l.t).collect();

    match save_match_metadata(&metadata) {
        Ok(_) => {
            println!("Metadatos guardados con éxito para la partida {}", match_id);
            // Iniciar sincronización con Riot API en segundo plano tras 60 segundos
            let match_id_for_riot = match_id.clone();
            let active_player_for_riot = active_match.active_player.lock().await.clone();
            tokio::spawn(async move {
                println!(
                    "Esperando 60 segundos antes de sincronizar con Riot API para la partida {}...",
                    match_id_for_riot
                );
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                match crate::riot_api::sync_riot_data(&match_id_for_riot, &active_player_for_riot)
                    .await
                {
                    Ok(_) => println!(
                        "Sincronización con Riot API completada para {}",
                        match_id_for_riot
                    ),
                    Err(e) => eprintln!("Error al sincronizar con Riot API: {}", e),
                }
            });

            // Trigger Dataset Generation si está activo
            let app_config = crate::storage::load_config();
            if app_config.auto_dataset_generator {
                let video_path = metadata.video_path.clone();
                let meta_clone = metadata.clone();
                let dataset_dir = std::path::Path::new(&app_config.save_directory).join("dataset");
                let app_for_dataset = app.clone();
                tokio::spawn(async move {
                    println!("Generando auto-dataset para partida {}...", meta_clone.id);
                    // Extract ~100 clicks
                    if let Err(e) = crate::dataset_generator::generate_dataset(&app_for_dataset, &video_path, &meta_clone, &dataset_dir, 100).await {
                        eprintln!("Error generando dataset: {}", e);
                    } else {
                        println!("Auto-dataset generado para {}", meta_clone.id);
                    }
                });
            }
        }
        Err(e) => eprintln!("Error al guardar los metadatos de la partida: {}", e),
    }
}

/// Recorta la grabación a `segundos` sustituyendo el fichero original.
///
/// La regla es una: **nunca perder la grabación**. La versión anterior borraba el
/// original y luego renombraba el recorte encima; si ese renombrado fallaba (el
/// antivirus con el fichero abierto, el disco lleno justo ahí), la partida entera
/// desaparecía. Y las tres ramas de fallo iban con `let _ =`, así que no quedaba
/// ni rastro de por qué.
///
/// Ahora el original se aparta a un `.orig` y solo se borra cuando el recorte ya
/// ocupa su sitio; si algo se tuerce, vuelve.
fn trim_en_sitio(app: &tauri::AppHandle, final_path: &std::path::Path, segundos: f64) {
    let tmp_path = final_path.with_extension("trim.mp4");
    let backup_path = final_path.with_extension("orig.mp4");
    let _ = std::fs::remove_file(&tmp_path);

    let salida = crate::proc::hide_console(
        std::process::Command::new(crate::proc::ffmpeg(app)).args(&[
            "-i",
            &final_path.to_string_lossy(),
            "-t",
            &segundos.to_string(),
            "-c",
            "copy",
            &tmp_path.to_string_lossy(),
        ]),
    )
    .output();

    match salida {
        Err(e) => {
            eprintln!("Recorte final: no se pudo ejecutar ffmpeg ({e}); se deja la grabación entera.");
            return;
        }
        Ok(out) if !out.status.success() => {
            eprintln!(
                "Recorte final: ffmpeg salió con {} ; se deja la grabación entera.\n{}",
                out.status,
                String::from_utf8_lossy(&out.stderr)
                    .lines()
                    .rev()
                    .take(5)
                    .collect::<Vec<_>>()
                    .join("\n")
            );
            let _ = std::fs::remove_file(&tmp_path);
            return;
        }
        Ok(_) => {}
    }

    // ffmpeg puede salir con 0 y dejar un fichero vacío (entrada corrupta).
    match std::fs::metadata(&tmp_path) {
        Ok(m) if m.len() > 0 => {}
        _ => {
            eprintln!("Recorte final: el recorte salió vacío; se deja la grabación entera.");
            let _ = std::fs::remove_file(&tmp_path);
            return;
        }
    }

    let _ = std::fs::remove_file(&backup_path);
    if let Err(e) = std::fs::rename(final_path, &backup_path) {
        eprintln!("Recorte final: no se pudo apartar el original ({e}); se deja como está.");
        let _ = std::fs::remove_file(&tmp_path);
        return;
    }
    if let Err(e) = std::fs::rename(&tmp_path, final_path) {
        eprintln!("Recorte final: no se pudo poner el recorte en su sitio ({e}); se restaura el original.");
        if let Err(e2) = std::fs::rename(&backup_path, final_path) {
            // Lo peor que puede pasar: el original está en `.orig.mp4` y hay que
            // decirlo bien alto, porque el vídeo SIGUE AHÍ.
            eprintln!(
                "Recorte final: tampoco se pudo restaurar ({e2}). La grabación intacta está en {}",
                backup_path.display()
            );
        }
        let _ = std::fs::remove_file(&tmp_path);
        return;
    }
    let _ = std::fs::remove_file(&backup_path);
}

/// Calcula el APM promedio y la serie de APM por minuto a partir de muestras
/// (tiempo_de_vídeo, acciones_acumuladas).
fn compute_apm(samples: &[(f64, u64)], duration: f64) -> (f64, Vec<f64>) {
    if samples.len() < 2 || duration <= 0.0 {
        return (0.0, Vec::new());
    }
    // Cuenta acumulada de acciones en un tiempo de juego dado (interpolación lineal).
    let count_at = |t: f64| -> f64 {
        if t <= samples[0].0 {
            return samples[0].1 as f64;
        }
        if t >= samples[samples.len() - 1].0 {
            return samples[samples.len() - 1].1 as f64;
        }
        for w in samples.windows(2) {
            let (t0, c0) = w[0];
            let (t1, c1) = w[1];
            if t >= t0 && t <= t1 {
                if (t1 - t0).abs() < f64::EPSILON {
                    return c1 as f64;
                }
                let frac = (t - t0) / (t1 - t0);
                return c0 as f64 + frac * (c1 as f64 - c0 as f64);
            }
        }
        samples[samples.len() - 1].1 as f64
    };

    let total_actions = samples[samples.len() - 1].1 as f64;
    let minutes = (duration / 60.0).max(1.0 / 60.0);
    let avg = total_actions / minutes;

    // Serie fina y suave: N puntos equiespaciados, APM con ventana deslizante de 20s.
    // Esto produce una curva con subidas y bajadas claras (no una línea plana).
    let n: usize = ((duration / 8.0) as usize).clamp(10, 200);
    let window = 20.0_f64;
    let mut series = Vec::with_capacity(n);
    for i in 0..n {
        let t = duration * (i as f64) / ((n - 1) as f64);
        let a = (t - window / 2.0).max(0.0);
        let b = (t + window / 2.0).min(duration);
        let span_min = ((b - a) / 60.0).max(f64::EPSILON);
        let actions = count_at(b) - count_at(a);
        series.push((actions / span_min).max(0.0));
    }
    (avg, series)
}

/// Nombre canónico (en inglés, el de Riot) del tipo de dragón que da la API.
///
/// Devolvía los nombres en español y se incrustaban en frases inglesas: salía
/// "Your team took the de Montaña Dragon". La traducción es cosa del frontend
/// (`describeEvent` / i18n), que es quien sabe en qué idioma está la interfaz;
/// aquí solo se normaliza el código de la API a su nombre.
fn translate_dragon(dtype: &str) -> &'static str {
    match dtype.to_lowercase().as_str() {
        "fire" => "Infernal",
        "earth" | "mountain" => "Mountain",
        "water" | "ocean" => "Ocean",
        "air" | "cloud" => "Cloud",
        "hextech" => "Hextech",
        "chemtech" => "Chemtech",
        "elder" => "Elder",
        _ => "Elemental",
    }
}

/// Determina a qué equipo pertenece una estructura (torre/inhibidor) por su nombre.
/// "Turret_T1_..."/"Barracks_T1_..." = ORDER (azul); "..._T2_..." = CHAOS (rojo).
fn structure_owner_team(name: &str) -> Option<&'static str> {
    if name.contains("_T1_") {
        Some("ORDER")
    } else if name.contains("_T2_") {
        Some("CHAOS")
    } else {
        None
    }
}

/// Clasifica un nombre como aliado (Some(true)) o enemigo (Some(false)) respecto al
/// equipo del jugador; None si no se conoce el equipo de ese nombre.
fn classify_ally(
    name: &str,
    player_team: &str,
    team_map: &HashMap<String, String>,
) -> Option<bool> {
    team_map.get(&strip_tag(name)).map(|t| t == player_team)
}

/// Convierte un evento de la API de Riot en un MatchEvent enriquecido y centrado en el
/// jugador. Devuelve None para eventos que no nos interesan (kills ajenos, spawns, etc.).
fn map_lol_event(
    ev: &LolEvent,
    active_name: &str,
    player_team: &str,
    team_map: &HashMap<String, String>,
    game_time_offset: f64,
) -> Option<MatchEvent> {
    let an = strip_tag(active_name);
    let stolen = ev
        .stolen
        .as_deref()
        .map_or(false, |s| s.eq_ignore_ascii_case("true"));
    let stolen_txt = if stolen { " (stolen)" } else { "" };

    // Datos estructurados del suceso. Los rellena cada rama que tenga algo que
    // decir; el frontend compone la frase a partir de ellos y solo cae a
    // `description` cuando vienen vacíos (partidas grabadas antes de esto).
    let mut actor: Option<String> = None;
    let mut target: Option<String> = None;
    let mut detail: Option<String> = None;

    // (tipo, subtype, descripción)
    let (ty, subtype, description): (&str, Option<&str>, String) = match ev.event_name.as_str() {
        "GameStart" => ("GameStart", None, "Game start".to_string()),
        "GameEnd" => {
            let res = ev.result.as_deref().unwrap_or("");
            if res.eq_ignore_ascii_case("win") {
                ("GameEnd", Some("win"), "Victory".to_string())
            } else if res.eq_ignore_ascii_case("lose") {
                ("GameEnd", Some("lose"), "Defeat".to_string())
            } else {
                ("GameEnd", None, "Game over".to_string())
            }
        }
        "FirstBlood" => {
            let recip = ev.recipient.as_deref().unwrap_or("");
            if strip_tag(recip) == an {
                (
                    "FirstBlood",
                    Some("kill"),
                    "First blood".to_string(),
                )
            } else {
                return None; // primera sangre ajena: no nos interesa
            }
        }
        "ChampionKill" => {
            let killer = ev.killer_name.as_deref().unwrap_or("");
            let victim = ev.victim_name.as_deref().unwrap_or("Enemigo");
            if strip_tag(killer) == an {
                actor = Some(an.to_string());
                target = Some(strip_tag(victim).to_string());
                (
                    "ChampionKill",
                    Some("kill"),
                    format!("Killed {}", strip_tag(victim)),
                )
            } else if strip_tag(victim) == an {
                actor = Some(strip_tag(killer).to_string());
                target = Some(an.to_string());
                (
                    "ChampionKill",
                    Some("death"),
                    format!("Killed by {}", strip_tag(killer)),
                )
            } else if ev
                .assisters
                .as_ref()
                .map_or(false, |a| a.iter().any(|n| strip_tag(n) == an))
            {
                actor = Some(strip_tag(killer).to_string());
                target = Some(strip_tag(victim).to_string());
                (
                    "ChampionKill",
                    Some("assist"),
                    format!("Assisted killing {}", strip_tag(victim)),
                )
            } else {
                return None; // kill que no te involucra
            }
        }
        "Multikill" => {
            let killer = ev.killer_name.as_deref().unwrap_or("");
            if strip_tag(killer) != an {
                return None;
            }
            let streak = ev.kill_streak.unwrap_or(0);
            let desc = match streak {
                2 => "Double kill",
                3 => "Triple kill",
                4 => "Quadra kill",
                5 => "Pentakill",
                _ => "Multi kill",
            };
            actor = Some(an.to_string());
            detail = Some(streak.to_string());
            ("Multikill", Some("kill"), desc.to_string())
        }
        "TurretKilled" => {
            let killer = ev.killer_name.as_deref().unwrap_or("");
            let is_killer = strip_tag(killer) == an;
            let is_assister = ev.assisters.as_ref().map_or(false, |a| a.iter().any(|n| strip_tag(n) == an));
            
            if !is_killer && !is_assister {
                return None;
            }

            let turret = ev.turret_killed.as_deref().unwrap_or("");
            match structure_owner_team(turret) {
                Some(owner) if owner == player_team => (
                    "TowerKill",
                    Some("ally"),
                    "Lost an allied tower".to_string(),
                ),
                Some(_) => (
                    "TowerKill",
                    Some("enemy"),
                    "Destroyed an enemy tower".to_string(),
                ),
                None => ("TowerKill", None, "Tower destroyed".to_string()),
            }
        }
        "InhibKilled" => {
            let killer = ev.killer_name.as_deref().unwrap_or("");
            let is_killer = strip_tag(killer) == an;
            let is_assister = ev.assisters.as_ref().map_or(false, |a| a.iter().any(|n| strip_tag(n) == an));
            
            if !is_killer && !is_assister {
                return None;
            }

            let inhib = ev.inhib_killed.as_deref().unwrap_or("");
            match structure_owner_team(inhib) {
                Some(owner) if owner == player_team => (
                    "InhibKill",
                    Some("ally"),
                    "Lost an allied inhibitor".to_string(),
                ),
                Some(_) => (
                    "InhibKill",
                    Some("enemy"),
                    "Destroyed an enemy inhibitor".to_string(),
                ),
                None => ("InhibKill", None, "Inhibitor destroyed".to_string()),
            }
        }
        "DragonKill" => {
            let dtype = translate_dragon(ev.dragon_type.as_deref().unwrap_or(""));
            let ally = classify_ally(
                ev.killer_name.as_deref().unwrap_or(""),
                player_team,
                team_map,
            );
            let sub = ally.map(|a| if a { "ally" } else { "enemy" });
            detail = Some(dtype.to_string());
            let desc = match ally {
                Some(true) => format!("Your team took the {} Dragon{}", dtype, stolen_txt),
                Some(false) => format!("Enemy took the {} Dragon{}", dtype, stolen_txt),
                None => format!("{} Dragon{}", dtype, stolen_txt),
            };
            ("DragonKill", sub, desc)
        }
        "HeraldKill" => {
            let ally = classify_ally(
                ev.killer_name.as_deref().unwrap_or(""),
                player_team,
                team_map,
            );
            let sub = ally.map(|a| if a { "ally" } else { "enemy" });
            let desc = match ally {
                Some(true) => format!("Your team took Rift Herald{}", stolen_txt),
                Some(false) => format!("Enemy took Rift Herald{}", stolen_txt),
                None => format!("Rift Herald{}", stolen_txt),
            };
            ("HeraldKill", sub, desc)
        }
        "BaronKill" => {
            let ally = classify_ally(
                ev.killer_name.as_deref().unwrap_or(""),
                player_team,
                team_map,
            );
            let sub = ally.map(|a| if a { "ally" } else { "enemy" });
            let desc = match ally {
                Some(true) => format!("Your team killed Baron Nashor{}", stolen_txt),
                Some(false) => format!("Enemy killed Baron Nashor{}", stolen_txt),
                None => format!("Baron Nashor{}", stolen_txt),
            };
            ("BaronKill", sub, desc)
        }
        _ => return None, // MinionsSpawning, FirstBrick, Ace, Inhib respawn, etc.
    };

    Some(MatchEvent {
        r#type: ty.to_string(),
        subtype: subtype.map(|s| s.to_string()),
        time: (ev.event_time - game_time_offset).max(0.0),
        description,
        actor,
        target,
        // "stolen" es un matiz que ya venia en la frase; se saca aparte para que
        // el frontend pueda pintarlo como quiera.
        detail: if stolen_txt.is_empty() { detail } else { Some(match detail {
            Some(d) => format!("{},stolen", d),
            None => "stolen".to_string(),
        }) },
    })
}

#[tauri::command]
pub async fn export_clip(
    app: tauri::AppHandle,
    match_id: String,
    video_path: String,
    start_time: f64,
    duration: f64,
) -> Result<String, String> {
    let dir = crate::storage::get_match_dir(&match_id);
    let clip_id = format!(
        "{}_clip_{}",
        match_id,
        chrono::Local::now().format("%H%M%S")
    );
    let clip_path = dir.join(format!("{}.mp4", clip_id));

    cut_clip(&app, &video_path, start_time, duration, &clip_path)?;
    Ok(clip_path.to_string_lossy().to_string())
}

/// Recorta `[start_time, start_time + duration]` de `video_path` a `dest`.
///
/// Copia los streams tal cual (`-c copy`) en vez de recomprimir. Medido sobre una
/// grabación de 1440p60: 139 ms y 9,0 MB, frente a 1684 ms y 16,6 MB con
/// `libx264 -preset ultrafast` — 12x más rápido, 46% más pequeño y sin pérdida,
/// porque son los bits originales de NVENC. El reencode salía incluso MÁS grande
/// que el original: `ultrafast` comprime peor que el encoder de la grabación.
///
/// El corte es exacto en ambos extremos: ffmpeg busca el keyframe anterior pero
/// marca el inicio de presentación en el instante pedido (verificado comparando
/// hashes del primer y último fotograma contra el original). El contenedor arrastra
/// ese GOP de arranque oculto tras la edit list, que todos los reproductores basados
/// en Chromium respetan — incluidos el WebView de la app y los navegadores donde se
/// abren los clips subidos.
fn cut_clip(
    app: &tauri::AppHandle,
    video_path: &str,
    start_time: f64,
    duration: f64,
    dest: &std::path::Path,
) -> Result<(), String> {
    let output = crate::proc::hide_console(
        std::process::Command::new(crate::proc::ffmpeg(app)).args(&[
            "-ss",
            &start_time.to_string(),
            "-i",
            video_path,
            "-t",
            &duration.to_string(),
            "-c",
            "copy",
            "-movflags",
            "faststart",
            &dest.to_string_lossy(),
        ]),
    )
    .output()
    .map_err(|e| format!("Fallo al ejecutar ffmpeg: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        Err(format!("Error en ffmpeg: {}", err))
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ClipMetadata {
    pub path: String,
    pub name: String,
    pub match_id: String,
    pub size: u64,
    pub favorite: bool,
}

/// Borra un recorte y todo lo que colgaba de él.
///
/// El estado que la UI enseña de un recorte —si es favorito, la nota, los
/// sucesos marcados— no vive en ningún índice: vive en el `.json` de al lado
/// (ver `get_all_clips` y `get_all_error_clips`, que lo releen del disco en
/// cada llamada). Así que borrar los dos ficheros ES refrescar el índice: la
/// siguiente llamada ya no lo ve.
///
/// `marca` distingue los dos tipos de recorte por su nombre, que es como los
/// distingue el resto del módulo.
fn borrar_recorte(path: &str, marca: &str) -> Result<(), String> {
    let ruta = std::path::Path::new(path);

    // Un `path` que llega del frontend es una cadena arbitraria, y esto borra.
    // El mismo corral que usa el servidor de vídeo, más la exigencia de que
    // parezca un recorte: nunca se puede llegar desde aquí a un vídeo de
    // partida, a un metadata ni a la config.
    if !crate::streamer::ruta_permitida(path) {
        return Err("That file is outside the app folders".to_string());
    }
    let nombre = ruta
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    if !nombre.contains(marca) || !nombre.to_lowercase().ends_with(".mp4") {
        return Err("That file is not a clip".to_string());
    }

    std::fs::remove_file(ruta).map_err(|e| format!("Could not delete the clip: {e}"))?;
    // El sidecar es best-effort: si el vídeo ya no está, dejar el JSON huérfano
    // sería peor que no poder borrarlo, pero tampoco es motivo para fallar.
    let sidecar = ruta.with_extension("json");
    if sidecar.exists() {
        if let Err(e) = std::fs::remove_file(&sidecar) {
            log::warn!("no se pudo borrar el sidecar {}: {e}", sidecar.display());
        }
    }
    // La barra de disco lee de una caché de un minuto: sin esto el hueco
    // liberado no aparecía hasta el siguiente refresco.
    crate::storage::invalidate_disk_cache();
    Ok(())
}

/// Borra un recorte guardado (`<partida>_clip_N.mp4`) y su JSON.
#[tauri::command]
pub fn delete_clip(path: String) -> Result<(), String> {
    borrar_recorte(&path, "_clip_")
}

/// Borra un clip de error (`<partida>_error_N.mp4`) y su JSON, con la nota y
/// los sucesos que llevara dentro.
#[tauri::command]
pub fn delete_error_clip(path: String) -> Result<(), String> {
    borrar_recorte(&path, "_error_")
}

#[tauri::command]
pub async fn get_all_clips() -> Vec<ClipMetadata> {
    let mut clips = Vec::new();
    let root_dir = crate::storage::get_videos_dir();

    if let Ok(mut entries) = tokio::fs::read_dir(root_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if entry.path().is_dir() {
                let match_id = entry.file_name().to_string_lossy().to_string();
                if let Ok(mut sub_entries) = tokio::fs::read_dir(entry.path()).await {
                    while let Ok(Some(sub_entry)) = sub_entries.next_entry().await {
                        let name = sub_entry.file_name().to_string_lossy().to_string();
                        if name.starts_with(&match_id)
                            && name.contains("_clip_")
                            && name.ends_with(".mp4")
                        {
                            let size = sub_entry.metadata().await.map(|m| m.len()).unwrap_or(0);
                            let json_path = sub_entry.path().with_extension("json");
                            let mut favorite = false;
                            if let Ok(content) = tokio::fs::read_to_string(&json_path).await {
                                if let Ok(meta) = serde_json::from_str::<ClipMetadata>(&content) {
                                    favorite = meta.favorite;
                                }
                            }
                            clips.push(ClipMetadata {
                                path: sub_entry.path().to_string_lossy().to_string(),
                                name,
                                match_id: match_id.clone(),
                                size,
                                favorite,
                            });
                        }
                    }
                }
            }
        }
    }
    // Los rescatados: recortes cuya partida se borró. El id de partida se saca
    // del nombre, que siempre lo lleva delante ("match_X_clip_N.mp4").
    let rescate = crate::storage::rescue_dir();
    if let Ok(mut entries) = tokio::fs::read_dir(rescate).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".mp4") || !name.contains("_clip_") {
                continue;
            }
            let match_id = name.split("_clip_").next().unwrap_or("").to_string();
            let size = entry.metadata().await.map(|m| m.len()).unwrap_or(0);
            let json_path = entry.path().with_extension("json");
            let mut favorite = false;
            if let Ok(content) = tokio::fs::read_to_string(&json_path).await {
                if let Ok(meta) = serde_json::from_str::<ClipMetadata>(&content) {
                    favorite = meta.favorite;
                }
            }
            clips.push(ClipMetadata {
                path: entry.path().to_string_lossy().to_string(),
                name,
                match_id,
                size,
                favorite,
            });
        }
    }

    // Sort descending by name
    clips.sort_by(|a, b| b.name.cmp(&a.name));
    clips
}

#[tauri::command]
pub async fn toggle_clip_favorite(path: String) -> Result<bool, String> {
    let mp4_path = std::path::Path::new(&path);
    let json_path = mp4_path.with_extension("json");

    let mut meta = ClipMetadata {
        path: path.clone(),
        name: mp4_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        match_id: "".to_string(),
        size: 0,
        favorite: false,
    };

    if let Ok(content) = tokio::fs::read_to_string(&json_path).await {
        if let Ok(existing) = serde_json::from_str::<ClipMetadata>(&content) {
            meta = existing;
        }
    }

    meta.favorite = !meta.favorite;
    tokio::fs::write(
        &json_path,
        serde_json::to_string(&meta).map_err(|e| e.to_string())?,
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(meta.favorite)
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct ErrorEvent {
    pub id: String,
    pub time: f64,
    pub text: String,
    pub category: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ErrorClipMetadata {
    pub path: String,
    pub name: String,
    pub match_id: String,
    pub size: u64,
    pub note: String,
    #[serde(default)]
    pub events: Vec<ErrorEvent>,
    /// Segundo del video de origen en que empieza el recorte.
    ///
    /// Faltaba: `export_error_clip` lo recibia como parametro y lo usaba para
    /// cortar, pero no lo guardaba. El resultado es que un error marcado perdia
    /// su posicion en la partida en cuanto se exportaba, y no habia forma de
    /// devolverlo a la linea de tiempo ni a la cola de revision.
    ///
    /// Los clips exportados antes de esto no lo llevan; de ahi el Option.
    #[serde(default)]
    pub start_time: Option<f64>,
    /// Marcado como visto en la cola de revision.
    ///
    /// Vive aqui y no en MatchEvent porque un error marcado no es un suceso de
    /// la partida: es un clip aparte con su propio JSON.
    #[serde(default)]
    pub reviewed: Option<bool>,
}

#[tauri::command]
pub async fn export_error_clip(
    app: tauri::AppHandle,
    match_id: String,
    video_path: String,
    start_time: f64,
    duration: f64,
    note: String,
) -> Result<String, String> {
    let dir = crate::storage::get_match_dir(&match_id);
    let error_id = format!(
        "{}_error_{}",
        match_id,
        chrono::Local::now().format("%H%M%S")
    );
    let error_path = dir.join(format!("{}.mp4", error_id));
    let json_path = dir.join(format!("{}.json", error_id));

    cut_clip(&app, &video_path, start_time, duration, &error_path)?;

    let meta = ErrorClipMetadata {
        path: error_path.to_string_lossy().to_string(),
        name: error_id.clone() + ".mp4",
        match_id: match_id.clone(),
        size: std::fs::metadata(&error_path).map(|m| m.len()).unwrap_or(0),
        note: note.clone(),
        events: Vec::new(),
        start_time: Some(start_time),
        reviewed: None,
    };
    let _ = tokio::fs::write(&json_path, serde_json::to_string(&meta).unwrap_or_default()).await;
    Ok(error_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_all_error_clips() -> Vec<ErrorClipMetadata> {
    let mut errors = Vec::new();
    // Los dos directorios NO son un apaño heredado: los VOD analizados (`vod_*`) viven en
    // VODsReviews y las partidas grabadas en la raíz de vídeos (ver `get_match_dir`).
    let dirs = vec![crate::storage::get_videos_dir(), crate::storage::get_reviews_dir()];

    for root_dir in dirs {
        if let Ok(mut entries) = tokio::fs::read_dir(root_dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                if entry.path().is_dir() {
                    let match_id = entry.file_name().to_string_lossy().to_string();
                    if let Ok(mut sub_entries) = tokio::fs::read_dir(entry.path()).await {
                        while let Ok(Some(sub_entry)) = sub_entries.next_entry().await {
                            let name = sub_entry.file_name().to_string_lossy().to_string();
                            if name.contains("_error_") && name.ends_with(".mp4") {
                                // En la carpeta de rescatados el id de la partida
                                // ya no es el nombre del directorio: va delante
                                // en el propio fichero.
                                let match_id = if match_id == "recortes" {
                                    name.split("_error_").next().unwrap_or("").to_string()
                                } else {
                                    match_id.clone()
                                };
                                let size = sub_entry.metadata().await.map(|m| m.len()).unwrap_or(0);
                                let json_path = sub_entry.path().with_extension("json");
                                let mut note = String::new();
                                let mut events = Vec::new();
                                let mut start_time: Option<f64> = None;
                                let mut reviewed: Option<bool> = None;
                                if let Ok(content) = tokio::fs::read_to_string(&json_path).await {
                                    if let Ok(meta) = serde_json::from_str::<ErrorClipMetadata>(&content) {
                                        note = meta.note;
                                        events = meta.events;
                                        start_time = meta.start_time;
                                        reviewed = meta.reviewed;
                                    }
                                }
                                errors.push(ErrorClipMetadata {
                                    path: sub_entry.path().to_string_lossy().to_string(),
                                    name,
                                    match_id: match_id.clone(),
                                    size,
                                    note,
                                    start_time,
                                    reviewed,
                                    events,
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    errors.sort_by(|a, b| b.name.cmp(&a.name));
    errors
}

/// Lee la metadata de un clip de error, o devuelve una recién inventada si el `.json` no existe
/// o no se puede parsear. La ausencia es un caso NORMAL: los clips de versiones anteriores se
/// grabaron sin `.json`, y la primera nota o el primer evento son justamente lo que lo crea.
async fn load_or_init_clip_meta(mp4_path: &std::path::Path) -> ErrorClipMetadata {
    let json_path = mp4_path.with_extension("json");
    if let Ok(content) = tokio::fs::read_to_string(&json_path).await {
        if let Ok(meta) = serde_json::from_str::<ErrorClipMetadata>(&content) {
            return meta;
        }
    }
    ErrorClipMetadata {
        path: mp4_path.to_string_lossy().to_string(),
        name: mp4_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        match_id: String::new(),
        size: tokio::fs::metadata(mp4_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0),
        note: String::new(),
        events: Vec::new(),
            start_time: None,
        reviewed: None,
    }
}

/// Lee la metadata de un clip que DEBE existir ya. La usan editar y borrar eventos: si llegan
/// aquí es porque la UI acaba de listar ese evento, así que un `.json` ausente o corrupto es una
/// inconsistencia real y hay que decirlo, no fingir que se guardó.
async fn load_clip_meta(mp4_path: &std::path::Path) -> Result<ErrorClipMetadata, String> {
    let json_path = mp4_path.with_extension("json");
    let content = tokio::fs::read_to_string(&json_path)
        .await
        .map_err(|e| format!("No metadata found for {}: {e}", json_path.display()))?;
    serde_json::from_str::<ErrorClipMetadata>(&content)
        .map_err(|e| format!("Unreadable metadata in {}: {e}", json_path.display()))
}

/// Guarda la metadata junto al mp4 (mismo nombre, extensión `.json`).
async fn write_clip_meta(
    mp4_path: &std::path::Path,
    meta: &ErrorClipMetadata,
) -> Result<(), String> {
    let json_path = mp4_path.with_extension("json");
    let body = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    tokio::fs::write(&json_path, body)
        .await
        .map_err(|e| format!("Could not save {}: {e}", json_path.display()))
}

/// Marca o desmarca un clip de error como revisado, para la cola de revision.
#[tauri::command]
pub async fn set_error_clip_reviewed(path: String, reviewed: bool) -> Result<(), String> {
    let mp4_path = std::path::Path::new(&path);
    let mut meta = load_clip_meta(mp4_path).await?;
    meta.reviewed = if reviewed { Some(true) } else { None };
    write_clip_meta(mp4_path, &meta).await
}

#[tauri::command]
pub async fn update_error_note(path: String, note: String) -> Result<(), String> {
    let mp4_path = std::path::Path::new(&path);
    let mut meta = load_or_init_clip_meta(mp4_path).await;
    meta.note = note;
    write_clip_meta(mp4_path, &meta).await
}

#[tauri::command]
pub async fn add_error_event(
    path: String,
    time: f64,
    text: String,
    category: String,
) -> Result<String, String> {
    let mp4_path = std::path::Path::new(&path);
    let mut meta = load_or_init_clip_meta(mp4_path).await;

    let id = uuid::Uuid::new_v4().to_string();
    meta.events.push(ErrorEvent {
        id: id.clone(),
        time,
        text,
        category,
    });
    meta.events.sort_by(|a, b| {
        a.time
            .partial_cmp(&b.time)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    write_clip_meta(mp4_path, &meta).await?;
    Ok(id)
}

#[tauri::command]
pub async fn delete_error_event(path: String, event_id: String) -> Result<(), String> {
    let mp4_path = std::path::Path::new(&path);
    let mut meta = load_clip_meta(mp4_path).await?;

    let before = meta.events.len();
    meta.events.retain(|e| e.id != event_id);
    if meta.events.len() == before {
        return Err(format!("Event {event_id} no longer exists in this clip"));
    }

    write_clip_meta(mp4_path, &meta).await
}

/// Edita una nota de un clip de error.
///
/// `time` es opcional y omitirlo deja el instante como estaba: mover una nota
/// exigía borrarla y volver a crearla, lo que le cambiaba el id (y con él
/// cualquier referencia que la UI tuviera abierta) y la hacía desaparecer un
/// instante de la lista. Con esto es una edición como las otras.
#[tauri::command]
pub async fn edit_error_event(
    path: String,
    event_id: String,
    text: String,
    category: String,
    time: Option<f64>,
) -> Result<(), String> {
    let mp4_path = std::path::Path::new(&path);
    let mut meta = load_clip_meta(mp4_path).await?;

    // Antes se escribía el fichero aunque el evento no estuviera: la UI daba el cambio por
    // guardado y al recargar reaparecía el texto viejo.
    let Some(ev) = meta.events.iter_mut().find(|e| e.id == event_id) else {
        return Err(format!("Event {event_id} no longer exists in this clip"));
    };
    ev.text = text;
    ev.category = category;
    if let Some(t) = time {
        // Un tiempo absurdo (NaN, negativo) rompería el orden y la línea de
        // tiempo; se ignora en vez de guardarlo.
        if t.is_finite() && t >= 0.0 {
            ev.time = t;
        }
    }
    // El orden por tiempo lo mantiene `add_error_event` al insertar; moverlo
    // aquí lo rompería si no se reordenase también.
    meta.events.sort_by(|a, b| a.time.total_cmp(&b.time));

    write_clip_meta(mp4_path, &meta).await
}

#[tauri::command]
pub fn get_app_config() -> crate::storage::AppConfig {
    crate::storage::load_config()
}

/// Parche de configuración: solo lo que venga puesto se toca.
///
/// Antes esto eran siete argumentos posicionales, y quien llamaba tenía que
/// mandar la config ENTERA aunque solo quisiera cambiar el idioma. El selector
/// de idioma omitía `minimap_scale`, así que cambiar de idioma reseteaba la
/// calibración del minimapa a 1 y lanzaba un recálculo de todas las partidas en
/// segundo plano, sin decir nada.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct AppConfigPatch {
    pub save_directory: Option<String>,
    pub riot_api_key: Option<String>,
    pub auto_dataset_generator: Option<bool>,
    pub max_storage_gb: Option<u64>,
    pub auto_prune_days: Option<u32>,
    pub language: Option<String>,
    pub minimap_scale: Option<f64>,
    pub riot_platform: Option<String>,
    pub riot_proxy_url: Option<String>,
    pub onboarding_done: Option<bool>,
    pub backup_mirror_dir: Option<String>,
}

#[tauri::command]
pub fn set_app_config(patch: AppConfigPatch) -> Result<(), String> {
    let mut config = crate::storage::load_config();
    if let Some(d) = patch.save_directory {
        config.save_directory = d;
    }
    // Se recorta: pegar la clave desde una web o una captura arrastra espacios y
    // tabuladores invisibles. HTTP los tolera en la cabecera por accidente, así
    // que el fallo no sale por ningún lado hasta que algo se comporta raro.
    if let Some(k) = patch.riot_api_key {
        config.riot_api_key = k.trim().to_string();
    }
    if let Some(v) = patch.auto_dataset_generator {
        config.auto_dataset_generator = v;
    }
    // Ambos valores mandan sobre un borrado automático de ficheros, así que se
    // acotan aquí y no solo en la UI: una cuota de 0 GB vaciaría la biblioteca.
    if let Some(gb) = patch.max_storage_gb {
        config.max_storage_gb = gb.clamp(crate::storage::MIN_STORAGE_GB, 100_000);
    }
    if let Some(d) = patch.auto_prune_days {
        config.auto_prune_days = d.min(3650);
    }
    // Cualquier valor desconocido cae a ingles: mejor eso que una UI a medio
    // traducir si algun dia llega un idioma que no existe.
    if let Some(l) = patch.language {
        config.language = if l == "es" { "es".to_string() } else { "en".to_string() };
    }
    // Plataforma de Riot: "auto" o una de las conocidas. Al fijarla a mano se
    // olvida la sondeada, que puede ser de otra cuenta.
    if let Some(p) = patch.riot_platform {
        let nueva = crate::riot_api::platform_conocida(&p)
            .unwrap_or_else(|| "auto".to_string());
        if nueva != config.riot_platform {
            config.riot_platform = nueva;
            config.riot_platform_detected.clear();
        }
    }
    if let Some(u) = patch.riot_proxy_url {
        config.riot_proxy_url = u.trim().trim_end_matches('/').to_string();
    }
    if let Some(v) = patch.onboarding_done {
        config.onboarding_done = v;
    }
    // Espejo de copia. Se acepta cualquier ruta (aún puede no existir: OneDrive
    // crea la carpeta al iniciar sesión) y el error de escritura se registra al
    // guardar, no aquí — ver `storage::mirror_match`.
    if let Some(d) = patch.backup_mirror_dir {
        config.backup_mirror_dir = d.trim().to_string();
    }
    // La misma cota que aplica la geometría (`camera_input::minimapa_rect`):
    // fuera de [0.5, 2.0] no hay ajuste de League que lo produzca.
    if let Some(s) = patch.minimap_scale {
        if s.is_finite() {
            let nueva = s.clamp(0.5, 2.0);
            // Al cambiar de verdad, las miradas ya calculadas se recalculan en
            // segundo plano: sin esto la calibración solo valía hacia delante.
            if (nueva - config.minimap_scale).abs() > 1e-9 {
                config.minimap_scale = nueva;
                crate::camera_input::spawn_regenerate_all(nueva);
            }
        }
    }
    // El fallo al escribir sube hasta la UI: guardar en silencio y mentir era
    // peor que no guardar.
    crate::storage::save_config(&config)
}

/// Progreso de la subida de un clip. Se emite como evento `clip_upload_progress`.
///
/// `path` identifica de qué clip se habla (puede haber varias subidas en
/// marcha) y `total` viaja en cada aviso para que la UI no tenga que haber
/// visto el primero: entrar a la pestaña a mitad de subida sigue enseñando el
/// porcentaje bien.
#[derive(serde::Serialize, Clone)]
pub struct UploadProgress {
    pub path: String,
    pub sent: u64,
    pub total: u64,
}

fn emit_upload_progress(app: &tauri::AppHandle, path: &str, sent: u64, total: u64) {
    let _ = app.emit(
        "clip_upload_progress",
        UploadProgress { path: path.to_string(), sent, total },
    );
}

/// Sube un clip y devuelve un enlace directo reproducible.
///
/// `expiry`:
///   - "permanent" -> catbox.moe (permanente, hasta 200 MB, sirve desde files.catbox.moe)
///   - "1h" | "12h" | "24h" | "72h" -> litterbox (temporal, hasta 1 GB, sirve desde litter.catbox.moe)
///
/// Ambos servicios devuelven la URL del archivo como texto plano.
#[tauri::command]
pub async fn upload_clip(
    app: tauri::AppHandle,
    path: String,
    expiry: String,
) -> Result<String, String> {
    use futures_util::StreamExt;

    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("Could not read the clip: {e}"))?;
    let total = file
        .metadata()
        .await
        .map(|m| m.len())
        .map_err(|e| format!("Could not read the clip: {e}"))?;
    let file_name = std::path::Path::new(&path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // El fichero ya no se carga entero en memoria: un recorte de catbox puede
    // llegar a 200 MB y uno de litterbox a 1 GB, y eso era un `Vec<u8>` de 1 GB
    // mientras durase la subida. Ahora se trocea y se va enviando.
    //
    // El progreso cuenta lo que sale hacia el cuerpo, no lo que confirma el
    // servidor; con la contrapresión de la conexión van casi a la par, y es lo
    // más cerca que se puede estar sin instrumentar el socket. Se emite cada 1%
    // o cada 256 KB (lo que sea mayor) para no ahogar al webview con eventos.
    let paso = (total / 100).max(256 * 1024);
    let (mut enviados, mut ultimo) = (0u64, 0u64);
    let app_ev = app.clone();
    let ruta_ev = path.clone();
    emit_upload_progress(&app, &path, 0, total);
    let cuerpo = tokio_util::io::ReaderStream::with_capacity(file, 64 * 1024).map(move |trozo| {
        if let Ok(t) = &trozo {
            enviados += t.len() as u64;
            if enviados - ultimo >= paso || enviados >= total {
                ultimo = enviados;
                emit_upload_progress(&app_ev, &ruta_ev, enviados, total);
            }
        }
        trozo
    });

    // Con longitud: sin ella reqwest usa `Transfer-Encoding: chunked`, y la API
    // de catbox lo rechaza.
    let part = multipart::Part::stream_with_length(reqwest::Body::wrap_stream(cuerpo), total)
        .file_name(file_name)
        .mime_str("video/mp4")
        .map_err(|_| "Could not set the upload mime type".to_string())?;

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("Could not build the HTTP client: {e}"))?;

    let (url, form) = if expiry == "permanent" {
        (
            "https://catbox.moe/user/api.php",
            multipart::Form::new()
                .text("reqtype", "fileupload")
                .part("fileToUpload", part),
        )
    } else {
        (
            "https://litterbox.catbox.moe/resources/internals/api.php",
            multipart::Form::new()
                .text("reqtype", "fileupload")
                .text("time", expiry)
                .part("fileToUpload", part),
        )
    };

    let res = client
        .post(url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Could not reach the upload server: {e}"))?;

    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    let body = body.trim().to_string();

    if status.is_success() && body.starts_with("https://") {
        Ok(body)
    } else if body.is_empty() {
        Err(format!("The upload server returned an error ({status})"))
    } else {
        Err(format!("Error al subir: {}", body))
    }
}

// ---------------------------------------------------------------------------
// Baremos de población
// ---------------------------------------------------------------------------

/// Un número del DTO crudo de Riot, venga como entero o como decimal.
fn num(v: Option<&serde_json::Value>) -> Option<f64> {
    v?.as_f64()
}

/// Arma los pares (clave del baremo, valor) de una partida.
///
/// `info` es el bloque `info` del `riot_match.json` cacheado, o `None` si esa
/// partida no lo tiene: sin él se pierden `turret_damage_per_min`,
/// `control_wards` y `solo_kills` (viven sólo en el DTO crudo) y el resto se
/// sirve igual. `compare_all` acepta una lista más corta sin quejarse.
///
/// Devuelve también el puesto, que es la otra mitad de la coordenada del
/// baremo. Separado del comando para poder probarlo con un participante de
/// mentira, que es donde de verdad se equivoca uno: en el mapeo.
fn metricas_de_partida(
    m: &MatchMetadata,
    info: Option<&serde_json::Value>,
) -> Result<(String, Vec<(&'static str, f64)>), String> {
    let idx = m
        .participants
        .iter()
        .position(|p| p.is_self)
        .ok_or_else(|| "This match has not been synced with Riot yet".to_string())?;
    let yo = &m.participants[idx];

    // El denominador de todas las tasas: la duración de la partida SEGÚN RIOT,
    // que es la que usa Riot en sus `challenges` y con la que se midió el
    // baremo. `metadata.game_duration` es la del VÍDEO, que lleva la pantalla
    // de carga pegada delante y estiraría el denominador un minuto largo.
    // (Riot da segundos desde el parche 11.20 y milisegundos en las anteriores,
    // sin renombrar el campo.)
    let dur_s = num(info.and_then(|i| i.get("gameDuration")))
        .map(|d| if d > 20_000.0 { d / 1000.0 } else { d })
        .filter(|d| *d > 0.0)
        .unwrap_or(m.game_duration);
    if !(dur_s > 0.0) {
        return Err("This match has no duration, so per-minute rates cannot be computed".to_string());
    }
    let dur = dur_s / 60.0;

    let dto = info
        .and_then(|i| i.get("participants"))
        .and_then(|p| p.get(idx));
    // `to_participant` construye `metadata.participants` recorriendo el DTO en
    // orden, así que el índice de `is_self` vale para los dos.
    let challenges = dto.and_then(|d| d.get("challenges"));

    let dano_equipo: i64 = m
        .participants
        .iter()
        .filter(|p| p.team_id == yo.team_id)
        .map(|p| p.damage as i64)
        .sum();
    let kills_equipo: i64 = m
        .participants
        .iter()
        .filter(|p| p.team_id == yo.team_id)
        .map(|p| p.kills as i64)
        .sum();

    let mut v: Vec<(&'static str, f64)> = vec![
        ("cs_per_min", yo.cs as f64 / dur),
        ("deaths_per_game", yo.deaths as f64),
        // El KDA de verdad, no `MatchMetadata.kda`, que es la cadena "K/D/A".
        ("kda", (yo.kills + yo.assists) as f64 / (yo.deaths.max(1)) as f64),
        ("gold_per_min", yo.gold as f64 / dur),
        ("damage_per_min", yo.damage as f64 / dur),
        ("vision_score_per_min", yo.vision_score as f64 / dur),
        ("wards_per_min", yo.wards_placed as f64 / dur),
        ("kills_per_game", yo.kills as f64),
        ("assists_per_game", yo.assists as f64),
    ];
    if dano_equipo > 0 {
        v.push(("damage_share", yo.damage as f64 / dano_equipo as f64));
    }

    // Participación en kills: la de Riot manda. La reconstrucción cuenta lo
    // mismo pero redondea distinto, y el baremo se midió con la suya.
    let kp = num(challenges.and_then(|c| c.get("killParticipation"))).or_else(|| {
        (kills_equipo > 0).then(|| (yo.kills + yo.assists) as f64 / kills_equipo as f64)
    });
    if let Some(kp) = kp {
        v.push(("kill_participation", kp));
    }

    if let Some(g) = m.gold_diff_15 {
        v.push(("gold_diff_15", g as f64));
    }
    if let Some(x) = m.xp_diff_15 {
        v.push(("xp_diff_15", x as f64));
    }
    if let Some(c) = m.cs_diff_15 {
        v.push(("cs_diff_15", c as f64));
    }

    if let Some(d) = num(dto.and_then(|d| d.get("damageDealtToTurrets"))) {
        v.push(("turret_damage_per_min", d / dur));
    }
    if let Some(c) = num(challenges.and_then(|c| c.get("controlWardsPlaced"))) {
        v.push(("control_wards", c));
    }
    if let Some(s) = num(challenges.and_then(|c| c.get("soloKills"))) {
        v.push(("solo_kills", s));
    }

    Ok((yo.role.clone(), v))
}

/// Compara las métricas de una partida contra la población de su rango y
/// puesto: "un jungla de tu rango hace 6,2 de CS por minuto; tú hiciste 4,8".
///
/// `percentile` es SIEMPRE el percentil crudo, también donde lo bueno es tener
/// menos: en `deaths_per_game` un 90 significa "mueres más que el 90%". La
/// inversión la hace la UI mirando `lower_is_better`, para que el signo se vea
/// donde se pinta y no quede escondido dentro de una tabla.
#[tauri::command]
pub fn get_match_benchmarks(
    match_id: String,
) -> Result<Vec<crate::benchmarks::MetricComparison>, String> {
    let mut metadata = crate::storage::get_match_metadata(&match_id)?;

    // `cs_diff_15` no existía cuando se sincronizaron las partidas viejas. Se
    // repone de la timeline ya cacheada (no cuesta cuota de API) y se guarda,
    // así que sólo se paga una vez por partida.
    if metadata.cs_diff_15.is_none() {
        if let Some(nuevo) = cs_diff_15_cacheado(&metadata) {
            metadata.cs_diff_15 = Some(nuevo);
            let _ = crate::storage::save_match_metadata(&metadata);
        }
    }

    let info = crate::storage::load_raw_match(&match_id)
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
    let (rol, valores) = metricas_de_partida(&metadata, info.as_ref().and_then(|v| v.get("info")))?;

    // El tramo sale de `tier_bucket`, que ya viene calculado y guardado con el
    // rango que el jugador TENÍA al jugarla. `rank_tier` es el crudo y no vale:
    // habría que traducirlo, y sobre todo puede haber cambiado desde entonces.
    Ok(crate::benchmarks::compare_all(
        metadata.tier_bucket.as_deref(),
        &rol,
        &valores,
    ))
}

/// `cs_diff_15` de una partida vieja, de su timeline cacheada. `None` si no la
/// tiene guardada: pedirla gastaría cuota por una sola métrica.
fn cs_diff_15_cacheado(m: &MatchMetadata) -> Option<i32> {
    let raw_tl = crate::storage::load_raw_timeline(&m.id)?;
    let raw = crate::storage::load_raw_match(&m.id)?;
    let tl = serde_json::from_str::<crate::riot_api::TimelineDto>(&raw_tl).ok()?;
    let details = serde_json::from_str::<crate::riot_api::MatchDto>(&raw).ok()?;
    let idx = m.participants.iter().position(|p| p.is_self)?;
    crate::riot_api::cs_diff_15_de(&tl, (idx as i32) + 1, &details.info.participants)
}

#[cfg(test)]
mod benchmark_tests {
    use super::*;
    use crate::storage::Participant;

    fn jugador(is_self: bool, team_id: i32) -> Participant {
        Participant {
            champion: "Lux".into(),
            name: "yo".into(),
            team_id,
            win: true,
            level: 18,
            kills: 6,
            deaths: 4,
            assists: 10,
            cs: 180,
            gold: 12_000,
            is_self,
            items: vec![],
            spells: vec![],
            tag: String::new(),
            damage: 24_000,
            vision_score: 30,
            wards_placed: 12,
            role: "MIDDLE".into(),
        }
    }

    /// Un participante recortado del `riot_match.json`: sólo los campos que el
    /// mapeo lee del DTO crudo.
    fn info_recortada() -> serde_json::Value {
        serde_json::json!({
            "gameDuration": 1800,
            "participants": [
                {
                    "damageDealtToTurrets": 3600,
                    "challenges": {
                        "killParticipation": 0.64,
                        "controlWardsPlaced": 3,
                        "soloKills": 2
                    }
                },
                { "damageDealtToTurrets": 100, "challenges": {} }
            ]
        })
    }

    fn partida() -> MatchMetadata {
        let mut otro = jugador(false, 100);
        otro.damage = 16_000;
        otro.kills = 4;
        MatchMetadata {
            id: "m".into(),
            // Distinta de la de Riot a propósito: la del vídeo lleva la
            // pantalla de carga pegada y NO debe ser el denominador.
            game_duration: 1920.0,
            participants: vec![jugador(true, 100), otro],
            gold_diff_15: Some(450),
            xp_diff_15: Some(-120),
            cs_diff_15: Some(11),
            tier_bucket: Some("medio".into()),
            ..Default::default()
        }
    }

    fn valor(v: &[(&str, f64)], k: &str) -> f64 {
        v.iter().find(|(m, _)| *m == k).unwrap_or_else(|| panic!("falta {k}")).1
    }

    #[test]
    fn mapea_el_participante_a_las_claves_del_baremo() {
        let m = partida();
        let info = info_recortada();
        let (rol, v) = metricas_de_partida(&m, Some(&info)).unwrap();
        assert_eq!(rol, "MIDDLE");

        // 30 minutos según Riot, no los 32 del vídeo.
        assert!((valor(&v, "cs_per_min") - 6.0).abs() < 1e-9);
        assert!((valor(&v, "gold_per_min") - 400.0).abs() < 1e-9);
        assert!((valor(&v, "damage_per_min") - 800.0).abs() < 1e-9);
        assert!((valor(&v, "vision_score_per_min") - 1.0).abs() < 1e-9);
        assert!((valor(&v, "wards_per_min") - 0.4).abs() < 1e-9);
        assert!((valor(&v, "turret_damage_per_min") - 120.0).abs() < 1e-9);

        assert_eq!(valor(&v, "deaths_per_game"), 4.0);
        assert_eq!(valor(&v, "kills_per_game"), 6.0);
        assert_eq!(valor(&v, "assists_per_game"), 10.0);
        // (6+10)/4, no la cadena "6/4/10" del campo `kda`.
        assert_eq!(valor(&v, "kda"), 4.0);
        // 24.000 de 40.000 del equipo.
        assert!((valor(&v, "damage_share") - 0.6).abs() < 1e-9);
        // La de Riot manda sobre la reconstrucción (que daría 16/10).
        assert!((valor(&v, "kill_participation") - 0.64).abs() < 1e-9);
        assert_eq!(valor(&v, "control_wards"), 3.0);
        assert_eq!(valor(&v, "solo_kills"), 2.0);

        assert_eq!(valor(&v, "gold_diff_15"), 450.0);
        assert_eq!(valor(&v, "xp_diff_15"), -120.0);
        assert_eq!(valor(&v, "cs_diff_15"), 11.0);
    }

    /// Sin el DTO crudo se sirve lo que se pueda y no se inventa el resto.
    #[test]
    fn sin_dto_crudo_omite_las_metricas_que_solo_estan_ahi() {
        let m = partida();
        let (_, v) = metricas_de_partida(&m, None).unwrap();
        for k in ["turret_damage_per_min", "control_wards", "solo_kills"] {
            assert!(v.iter().all(|(n, _)| *n != k), "{k} no debería estar");
        }
        // Sin `gameDuration` de Riot cae a la del vídeo, que es lo único que hay.
        assert!((valor(&v, "cs_per_min") - 180.0 / 32.0).abs() < 1e-9);
        // Y la participación se reconstruye del scoreboard: (6+10)/10.
        assert!((valor(&v, "kill_participation") - 1.6).abs() < 1e-9);
    }

    /// Sin `is_self` no hay a quién comparar, y decirlo es mejor que devolver
    /// una lista vacía que la UI pintaría como "todo a cero".
    #[test]
    fn sin_jugador_propio_es_un_error() {
        let mut m = partida();
        for p in m.participants.iter_mut() {
            p.is_self = false;
        }
        assert!(metricas_de_partida(&m, None).is_err());
    }

    /// El tramo desconocido no puede colarse como "alto": el baremo cae
    /// entonces al del puesto sobre el corpus entero.
    #[test]
    fn un_tramo_que_no_existe_cae_al_baremo_del_puesto() {
        let con_tramo = crate::benchmarks::median("cs_per_min", Some("alto"), "MIDDLE").unwrap();
        let sin_tramo = crate::benchmarks::median("cs_per_min", Some("xxx"), "MIDDLE").unwrap();
        let general = crate::benchmarks::median("cs_per_min", None, "MIDDLE").unwrap();
        assert_eq!(sin_tramo, general);
        assert_ne!(sin_tramo, con_tramo);
    }
}

#[cfg(test)]
mod error_clip_tests {
    use super::*;

    /// Crea un mp4 de mentira en una carpeta temporal propia de cada test. No hace falta que sea
    /// un vídeo válido: estos comandos solo tocan el `.json` de al lado.
    fn temp_clip(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("leaguerec-test-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mp4 = dir.join("2026-01-01_error_0.mp4");
        std::fs::write(&mp4, b"no soy un video").unwrap();
        mp4
    }

    async fn add_one(mp4: &std::path::Path) -> String {
        add_error_event(
            mp4.to_string_lossy().to_string(),
            12.5,
            "ward mal puesto".to_string(),
            "vision".to_string(),
        )
        .await
        .expect("añadir un evento debería crear la metadata")
    }

    #[tokio::test]
    async fn anadir_crea_la_metadata_si_no_existe() {
        let mp4 = temp_clip("add");
        let id = add_one(&mp4).await;
        let meta = load_clip_meta(&mp4).await.expect("el .json debe existir ya");
        assert_eq!(meta.events.len(), 1);
        assert_eq!(meta.events[0].id, id);
    }

    #[tokio::test]
    async fn borrar_sin_metadata_es_error() {
        let mp4 = temp_clip("del-sin-meta");
        let err = delete_error_event(mp4.to_string_lossy().to_string(), "cualquiera".to_string())
            .await
            .expect_err("sin .json no se puede borrar nada");
        assert!(err.contains("No metadata found"), "mensaje inesperado: {err}");
    }

    #[tokio::test]
    async fn borrar_un_id_que_no_esta_es_error() {
        let mp4 = temp_clip("del-id-raro");
        add_one(&mp4).await;
        let err = delete_error_event(mp4.to_string_lossy().to_string(), "otro-id".to_string())
            .await
            .expect_err("un id inexistente no puede reportar éxito");
        assert!(err.contains("no longer exists"), "mensaje inesperado: {err}");
    }

    #[tokio::test]
    async fn borrar_de_verdad_quita_el_evento() {
        let mp4 = temp_clip("del-ok");
        let id = add_one(&mp4).await;
        delete_error_event(mp4.to_string_lossy().to_string(), id).await.unwrap();
        assert!(load_clip_meta(&mp4).await.unwrap().events.is_empty());
    }

    #[tokio::test]
    async fn editar_un_id_que_no_esta_no_toca_el_fichero() {
        let mp4 = temp_clip("edit-id-raro");
        add_one(&mp4).await;
        let err = edit_error_event(
            mp4.to_string_lossy().to_string(),
            "otro-id".to_string(),
            "texto nuevo".to_string(),
            "macro".to_string(),
            None,
        )
        .await
        .expect_err("editar un id inexistente no puede reportar éxito");
        assert!(err.contains("no longer exists"), "mensaje inesperado: {err}");

        // El evento original debe seguir intacto: antes se reescribía el fichero igualmente.
        let meta = load_clip_meta(&mp4).await.unwrap();
        assert_eq!(meta.events[0].text, "ward mal puesto");
    }

    #[tokio::test]
    async fn la_nota_se_guarda_aunque_no_hubiera_metadata() {
        let mp4 = temp_clip("nota");
        update_error_note(mp4.to_string_lossy().to_string(), "revisar esto".to_string())
            .await
            .unwrap();
        assert_eq!(load_clip_meta(&mp4).await.unwrap().note, "revisar esto");
    }
}
