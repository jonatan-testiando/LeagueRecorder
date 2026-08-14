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

#[derive(serde::Serialize)]
pub struct DiskSpaceInfo {
    pub used_bytes: u64,
    pub total_bytes: u64,
}

#[tauri::command]
pub async fn get_disk_usage() -> DiskSpaceInfo {
    let root_dir = crate::storage::get_videos_dir();
    let used_bytes = crate::storage::get_dir_size(&root_dir);
    let limit: u64 = 100 * 1024 * 1024 * 1024; // 100 GB
    DiskSpaceInfo {
        used_bytes,
        total_bytes: limit,
    }
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
        }
    }
}

#[tauri::command]
pub async fn get_recorded_matches() -> Vec<MatchMetadata> {
    let mut matches = load_all_matches();
    // El listado NO necesita la estela del ratón (arrays enormes). El reproductor
    // la carga aparte vía `get_match_details`. Esto aligera muchísimo el payload
    // de IPC y el parseo del polling periódico.
    for m in &mut matches {
        m.mouse_events = Vec::new();
    }
    matches
}

#[tauri::command]
pub fn delete_match(id: String) -> Result<(), String> {
    // El registro de entrenamiento vive fuera de la carpeta de la partida: hay que
    // borrarlo aparte para no dejar huérfanos en %APPDATA%.
    awareness::delete_record(&id);
    delete_match_files(&id)
}

#[tauri::command]
pub fn get_recorder_status(state: State<'_, Arc<RecorderState>>) -> bool {
    is_recording(&state)
}

/// Guarda un clip con los últimos segundos de juego (replay buffer). Devuelve la ruta del clip.
/// Pensado para atar a un atajo o botón durante la partida.
#[tauri::command]
pub fn save_replay_clip(state: State<'_, Arc<RecorderState>>) -> Result<String, String> {
    crate::recorder::save_replay(&state)
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
}

impl Default for VideoSettings {
    fn default() -> Self {
        Self {
            fps: 60,
            quality: "High".to_string(),
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
    state: State<'_, Arc<std::sync::Mutex<VideoSettings>>>,
) -> VideoSettings {
    let mut s = state.lock().unwrap();
    s.fps = fps;
    s.quality = quality;
    s.clone()
}

#[tauri::command]
pub fn get_audio_status() -> AudioStatus {
    let system_audio_device = detect_system_audio_device();
    AudioStatus {
        ready_for_game_audio: true, // WGC always captures system audio por defecto
        system_audio_device,
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

    Ok(path)
}

#[tauri::command]
pub async fn stop_manual_recording(
    state: State<'_, Arc<RecorderState>>,
    active_match: State<'_, Arc<ActiveMatchState>>,
) -> Result<(), String> {
    stop_recording(&state)?;
    crate::storage::check_storage_quota();

    // Guardar metadata simulada para la prueba manual
    let id = active_match.id.lock().await.clone();
    if !id.is_empty() {
        let mouse_space = crate::ultimate::mouse_coordinate_space();
        let metadata = MatchMetadata {
            id: id.clone(),
            game_duration: 30.0, // Simulado
            video_path: crate::storage::get_match_dir(&id)
                .join(format!("{}.mp4", id))
                .to_string_lossy()
                .to_string(),
            result: "Victory".to_string(),
            champion: active_match.champion.lock().await.clone(),
            date: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            events: vec![
                MatchEvent::plain("GameStart", None, 0.0, "Manual recording started".to_string()),
                MatchEvent::plain("ChampionKill", Some("kill"), 12.5, "Test kill".to_string()),
                MatchEvent::plain("GameEnd", None, 25.0, "Manual recording finished".to_string()),
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
            gank_impact_15: None,
            lane_result: None,
            timeline_markers: Vec::new(),
            minute_frames: Vec::new(),
            comments: Vec::new(),
            reviewed_moments: Vec::new(),
            is_vod: false,
            camera_snaps: Vec::new(),
            // La grabación manual empieza y acaba con el vídeo: no hay carga que descontar.
            video_offset: Some(0.0),
        };
        let _ = save_match_metadata(&metadata);
    }

    Ok(())
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

            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;

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

                    // Iniciar grabación
                    let settings = video_settings_state.lock().unwrap().clone();
                    if let Err(e) = start_recording(&match_id, &recorder_state, &settings) {
                        // La partida sigue "activa" aunque no haya vídeo: el entrenamiento
                        // y los eventos se recogen igual. Antes esto reintentaba en bucle
                        // cada segundo y dejaba todo lo demás sin ejecutarse nunca.
                        eprintln!("Fallo al iniciar grabación (se sigue registrando la partida sin vídeo): {}", e);
                    } else {
                        *active_match.recording_start.lock().await = Some(std::time::Instant::now());
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
                    match metro.tick(last_game_time, &cam_presses) {
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
                            for (inst, x, y, evt_str) in raw_mouse_events {
                                // Usamos el instante relativo al momento en que empezó el video
                                let gt = inst.saturating_duration_since(rec_start).as_secs_f64();
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
    let _ = stop_recording(recorder_state);
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

    // Si la partida se cerró abruptamente (sin GameEnd de la API), descontamos 10 segundos
    // y recortamos físicamente el video para que no se vea el escritorio.
    if !has_game_end && is_auto {
        final_duration = (duration - 10.0).max(1.0);
        let final_path = dir.join(format!("{}.mp4", match_id_str));
        let tmp_path = dir.join(format!("{}_trim.mp4", match_id_str));

        // Esperamos un momento a que ffmpeg libere el archivo tras el kill()
        std::thread::sleep(std::time::Duration::from_millis(1500));

        if final_path.exists() {
            let output = crate::proc::hide_console(
                std::process::Command::new(crate::proc::ffmpeg(&app)).args(&[
                    "-i",
                    &final_path.to_string_lossy(),
                    "-t",
                    &final_duration.to_string(),
                    "-c",
                    "copy",
                    &tmp_path.to_string_lossy(),
                ]),
            )
            .output();

            if let Ok(out) = output {
                if out.status.success() {
                    let _ = std::fs::remove_file(&final_path);
                    let _ = std::fs::rename(&tmp_path, &final_path);
                } else {
                    let _ = std::fs::remove_file(&tmp_path);
                }
            }
        }
    }

    // Resolución del escritorio: es el espacio en el que `rdev` da las coordenadas
    // del ratón, y el reproductor lo necesita para escalar bien la estela.
    let mouse_space = crate::ultimate::mouse_coordinate_space();
    let metadata = MatchMetadata {
        id: match_id.clone(),
        game_duration: final_duration,
        video_path: dir
            .join(format!("{}.mp4", match_id_str))
            .to_string_lossy()
            .to_string(),
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
        gank_impact_15: None,
        lane_result: None,
        timeline_markers: Vec::new(),
        minute_frames: Vec::new(),
        comments: Vec::new(),
        reviewed_moments: Vec::new(),
        is_vod: false,
        camera_snaps,
        video_offset,
    };
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

/// Traduce el tipo de dragón de la API al nombre en español.
fn translate_dragon(dtype: &str) -> &'static str {
    match dtype.to_lowercase().as_str() {
        "fire" => "Infernal",
        "earth" => "de Montaña",
        "water" | "ocean" => "del Océano",
        "air" | "cloud" => "de Nube",
        "hextech" => "Hextech",
        "chemtech" => "Quimtech",
        "elder" => "Ancestral",
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
        .map_err(|e| format!("No se encontró la metadata de {}: {e}", json_path.display()))?;
    serde_json::from_str::<ErrorClipMetadata>(&content)
        .map_err(|e| format!("Metadata ilegible en {}: {e}", json_path.display()))
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
        .map_err(|e| format!("No se pudo guardar {}: {e}", json_path.display()))
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
        return Err(format!("El evento {event_id} ya no existe en este clip"));
    }

    write_clip_meta(mp4_path, &meta).await
}

#[tauri::command]
pub async fn edit_error_event(
    path: String,
    event_id: String,
    text: String,
    category: String,
) -> Result<(), String> {
    let mp4_path = std::path::Path::new(&path);
    let mut meta = load_clip_meta(mp4_path).await?;

    // Antes se escribía el fichero aunque el evento no estuviera: la UI daba el cambio por
    // guardado y al recargar reaparecía el texto viejo.
    let Some(ev) = meta.events.iter_mut().find(|e| e.id == event_id) else {
        return Err(format!("El evento {event_id} ya no existe en este clip"));
    };
    ev.text = text;
    ev.category = category;

    write_clip_meta(mp4_path, &meta).await
}

#[tauri::command]
pub fn get_app_config() -> crate::storage::AppConfig {
    crate::storage::load_config()
}

#[tauri::command]
pub fn set_app_config(save_directory: String, riot_api_key: String, auto_dataset_generator: bool, max_storage_gb: u64, auto_prune_days: u32) -> Result<(), String> {
    let mut config = crate::storage::load_config();
    config.save_directory = save_directory;
    config.riot_api_key = riot_api_key;
    config.auto_dataset_generator = auto_dataset_generator;
    // Ambos valores mandan sobre un borrado automático de ficheros, así que se
    // acotan aquí y no solo en la UI: una cuota de 0 GB vaciaría la biblioteca.
    config.max_storage_gb = max_storage_gb.clamp(crate::storage::MIN_STORAGE_GB, 100_000);
    config.auto_prune_days = auto_prune_days.min(3650);
    crate::storage::save_config(&config);
    Ok(())
}

/// Sube un clip y devuelve un enlace directo reproducible.
///
/// `expiry`:
///   - "permanent" -> catbox.moe (permanente, hasta 200 MB, sirve desde files.catbox.moe)
///   - "1h" | "12h" | "24h" | "72h" -> litterbox (temporal, hasta 1 GB, sirve desde litter.catbox.moe)
///
/// Ambos servicios devuelven la URL del archivo como texto plano.
#[tauri::command]
pub async fn upload_clip(path: String, expiry: String) -> Result<String, String> {
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Error leyendo archivo: {}", e))?;
    let file_name = std::path::Path::new(&path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let part = multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str("video/mp4")
        .map_err(|_| "Error configurando el mime type".to_string())?;

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("Error construyendo cliente: {}", e))?;

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
        .map_err(|e| format!("No se pudo conectar al servidor de subida: {}", e))?;

    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    let body = body.trim().to_string();

    if status.is_success() && body.starts_with("https://") {
        Ok(body)
    } else if body.is_empty() {
        Err(format!("Error en el servidor de subida ({})", status))
    } else {
        Err(format!("Error al subir: {}", body))
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
        assert!(err.contains("No se encontró la metadata"), "mensaje inesperado: {err}");
    }

    #[tokio::test]
    async fn borrar_un_id_que_no_esta_es_error() {
        let mp4 = temp_clip("del-id-raro");
        add_one(&mp4).await;
        let err = delete_error_event(mp4.to_string_lossy().to_string(), "otro-id".to_string())
            .await
            .expect_err("un id inexistente no puede reportar éxito");
        assert!(err.contains("ya no existe"), "mensaje inesperado: {err}");
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
        )
        .await
        .expect_err("editar un id inexistente no puede reportar éxito");
        assert!(err.contains("ya no existe"), "mensaje inesperado: {err}");

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
