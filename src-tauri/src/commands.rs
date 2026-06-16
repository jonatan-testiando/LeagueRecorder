use tauri::State;
use crate::recorder::{RecorderState, start_recording, stop_recording, is_recording, list_audio_devices, detect_system_audio_device};
use crate::storage::{MatchMetadata, MatchEvent, MouseEventData, load_all_matches, delete_match_files, save_match_metadata};
use crate::api_listener::{LolApiClient, LolEvent, strip_tag};
use crate::ultimate::UltState;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::collections::HashMap;
use tokio::sync::Mutex;
use chrono::Local;
use reqwest::multipart;

// Estructura para almacenar el estado de la partida actual en el worker de background
pub struct ActiveMatchState {
    pub id: Mutex<String>,
    pub champion: Mutex<String>,
    pub active_player: Mutex<String>,
    pub player_team: Mutex<String>,                       // "ORDER"/"CHAOS"
    pub team_map: Mutex<HashMap<String, String>>,         // summonerName(lower) -> team
    pub events: Mutex<Vec<MatchEvent>>,
    pub is_auto_recording: Mutex<bool>,
    pub apm_samples: Mutex<Vec<(f64, u64)>>,              // (tiempo de juego, acciones acumuladas)
    pub mouse_events: Mutex<Vec<MouseEventData>>,
    pub recording_start: Mutex<Option<std::time::Instant>>,
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
        }
    }
}

#[tauri::command]
pub fn get_recorded_matches() -> Vec<MatchMetadata> {
    load_all_matches()
}

#[tauri::command]
pub fn delete_match(id: String) -> Result<(), String> {
    delete_match_files(&id)
}

#[tauri::command]
pub fn get_recorder_status(state: State<'_, Arc<RecorderState>>) -> bool {
    is_recording(&state)
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

#[derive(serde::Serialize)]
pub struct UltimateSettings {
    pub enabled: bool,
    pub key: String,
}

#[tauri::command]
pub fn get_ultimate_settings(state: State<'_, Arc<UltState>>) -> UltimateSettings {
    UltimateSettings {
        enabled: *state.enabled.lock().unwrap(),
        key: state.key.lock().unwrap().clone(),
    }
}

#[tauri::command]
pub fn set_ultimate_settings(enabled: bool, key: String, state: State<'_, Arc<UltState>>) -> UltimateSettings {
    *state.enabled.lock().unwrap() = enabled;
    let k = key.trim().to_uppercase();
    if !k.is_empty() {
        *state.key.lock().unwrap() = k;
    }
    UltimateSettings {
        enabled: *state.enabled.lock().unwrap(),
        key: state.key.lock().unwrap().clone(),
    }
}

#[tauri::command]
pub fn get_audio_status() -> AudioStatus {
    let all_devices = list_audio_devices();
    let system_audio_device = detect_system_audio_device();
    AudioStatus {
        ready_for_game_audio: system_audio_device.is_some(),
        system_audio_device,
        all_devices,
    }
}

#[tauri::command]
pub async fn start_manual_recording(
    id: String,
    state: State<'_, Arc<RecorderState>>,
    active_match: State<'_, Arc<ActiveMatchState>>
) -> Result<String, String> {
    let path = start_recording(&id, &state)?;
    
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
    active_match: State<'_, Arc<ActiveMatchState>>
) -> Result<(), String> {
    stop_recording(&state)?;
    
    // Guardar metadata simulada para la prueba manual
    let id = active_match.id.lock().await.clone();
    if !id.is_empty() {
        let metadata = MatchMetadata {
            id: id.clone(),
            game_duration: 30.0, // Simulado
            video_path: crate::storage::get_match_dir(&id).join(format!("{}.mp4", id)).to_string_lossy().to_string(),
            result: "Victory".to_string(),
            champion: active_match.champion.lock().await.clone(),
            date: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            events: vec![
                MatchEvent {
                    r#type: "GameStart".to_string(),
                    subtype: None,
                    time: 0.0,
                    description: "Inicio de grabación manual".to_string(),
                },
                MatchEvent {
                    r#type: "ChampionKill".to_string(),
                    subtype: Some("kill".to_string()),
                    time: 12.5,
                    description: "Asesinato de prueba".to_string(),
                },
                MatchEvent {
                    r#type: "GameEnd".to_string(),
                    subtype: None,
                    time: 25.0,
                    description: "Grabación manual finalizada".to_string(),
                }
            ],
            apm: 0.0,
            apm_series: Vec::new(),
            mouse_events: active_match.mouse_events.lock().await.clone(),
        };
        let _ = save_match_metadata(&metadata);
    }
    
    Ok(())
}

/// Bucle de segundo plano que corre indefinidamente detectando el juego y grabando de forma automatizada
pub fn spawn_background_monitor(
    recorder_state: Arc<RecorderState>,
    active_match: Arc<ActiveMatchState>,
    ult_state: Arc<UltState>
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
            // Seguimiento del tiempo de juego para alinear los eventos de ultimate.
            let mut last_game_time: f64 = 0.0;
            let mut last_game_time_at = std::time::Instant::now();
            let mut r_available = false;
            let mut last_ult_time: f64 = -100.0;

            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;

                // Comprobar si el servidor local está vivo llamando a get_events().
                // Si responde Ok, significa que el juego está activo (independiente de si algún endpoint da 404 momentáneo).
                let events_result = api_client.get_events().await;
                let lol_running = events_result.is_ok();
                let recording = is_recording(&recorder_state);

                if lol_running && !recording && !awaiting_new_game {
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
                    // Reiniciar el seguimiento de ultimates para la nueva partida.
                    last_game_time = 0.0;
                    last_game_time_at = std::time::Instant::now();
                    r_available = false;
                    last_ult_time = -100.0;
                    ult_state.presses.lock().unwrap().clear();
                    // Reiniciar el conteo de acciones (APM) y empezar a contar.
                    ult_state.actions.store(0, Ordering::Relaxed);
                    ult_state.counting.store(true, Ordering::Relaxed);
                    active_match.apm_samples.lock().await.clear();
                    active_match.mouse_events.lock().await.clear();
                    ult_state.mouse_events.lock().unwrap().clear();

                    // Registrar evento inicial
                    active_match.events.lock().await.push(MatchEvent {
                        r#type: "GameStart".to_string(),
                        subtype: None,
                        time: 0.0,
                        description: "Partida Iniciada".to_string(),
                    });

                    // Iniciar grabación
                    if let Err(e) = start_recording(&match_id, &recorder_state) {
                        eprintln!("Error al iniciar grabación automática: {}", e);
                    } else {
                        *active_match.recording_start.lock().await = Some(std::time::Instant::now());
                    }
                } else if !lol_running && recording {
                    // Salida brusca SIN evento GameEnd (cierre/crash). Usamos ticks de gracia
                    // por si es un fallo momentáneo de la API.
                    close_grace_ticks += 1;
                    if close_grace_ticks >= 3 {
                        println!("Detección automática: La API no responde. Finalizando grabación...");
                        finalize_match(&recorder_state, &active_match, &ult_state, game_start_time).await;
                        awaiting_new_game = false;
                        close_grace_ticks = 0;
                    } else {
                        println!("Detección automática: La API del juego no responde (Ticks de gracia: {}/3)", close_grace_ticks);
                    }
                } else if !lol_running && !recording {
                    // El juego/cliente se cerró del todo: listos para una nueva partida.
                    awaiting_new_game = false;
                    close_grace_ticks = 0;
                } else if recording {
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

                    // Actualizar tiempo de juego y disponibilidad de la R (una sola llamada).
                    if let Ok((gt, r_level)) = api_client.get_live_state().await {
                        last_game_time = gt;
                        last_game_time_at = std::time::Instant::now();
                        r_available = r_level >= 1;
                        // Muestrear el contador de acciones para el APM.
                        let actions = ult_state.actions.load(Ordering::Relaxed);
                        active_match.apm_samples.lock().await.push((gt, actions));
                    }

                    // Procesar pulsaciones de ultimate (best-effort): solo si la R está
                    // disponible, y evitando duplicados dentro de una ventana de enfriamiento.
                    let ult_enabled = *ult_state.enabled.lock().unwrap();
                    let presses: Vec<std::time::Instant> = {
                        let mut guard = ult_state.presses.lock().unwrap();
                        guard.drain(..).collect()
                    };
                    if ult_enabled && r_available {
                        let mut ult_events = Vec::new();
                        for p in presses {
                            // Tiempo de juego aproximado en el instante de la pulsación.
                            let ago = last_game_time_at.saturating_duration_since(p).as_secs_f64();
                            let gt = (last_game_time - ago).max(0.0);
                            // Evitar marcar varias veces el mismo lanzamiento (cooldowns largos).
                            if gt - last_ult_time < 8.0 {
                                continue;
                            }
                            last_ult_time = gt;
                            ult_events.push(MatchEvent {
                                r#type: "Ultimate".to_string(),
                                subtype: Some("R".to_string()),
                                time: gt,
                                description: "Usaste tu Ultimate (R)".to_string(),
                            });
                        }
                        if !ult_events.is_empty() {
                            active_match.events.lock().await.extend(ult_events);
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
                    let mut game_ended = false;
                    if let Ok(lol_events) = api_client.get_events().await {
                        let mut new_events = Vec::new();
                        for ev in lol_events {
                            if ev.event_id > last_event_id {
                                last_event_id = ev.event_id;
                                if let Some(mapped) = map_lol_event(&ev, &active_name, &player_team, &team_map) {
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
                        finalize_match(&recorder_state, &active_match, &ult_state, game_start_time).await;
                        awaiting_new_game = true;
                    }
                }
            }
        });
    });
}

// Utilidades para Duration y compatibilidad
use std::time::Duration;

/// Detiene la grabación, calcula los metadatos finales (duración, resultado, APM) y los guarda.
/// Si no hubo evento GameEnd de Riot (p.ej. salida brusca), añade un marcador de fin.
async fn finalize_match(
    recorder_state: &Arc<RecorderState>,
    active_match: &Arc<ActiveMatchState>,
    ult_state: &Arc<UltState>,
    game_start_time: chrono::DateTime<Local>,
) {
    let is_auto = *active_match.is_auto_recording.lock().await;
    let _ = stop_recording(recorder_state);
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

    let samples = active_match.apm_samples.lock().await.clone();
    let (apm, apm_series) = compute_apm(&samples, duration);

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
        active_match.events.lock().await.push(MatchEvent {
            r#type: "GameEnd".to_string(),
            subtype: None,
            time: duration,
            description: "Grabación finalizada".to_string(),
        });
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
            let output = std::process::Command::new("ffmpeg")
                .args(&[
                    "-i", &final_path.to_string_lossy(),
                    "-t", &final_duration.to_string(),
                    "-c", "copy",
                    &tmp_path.to_string_lossy()
                ])
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

    let metadata = MatchMetadata {
        id: match_id.clone(),
        game_duration: final_duration,
        video_path: dir.join(format!("{}.mp4", match_id_str)).to_string_lossy().to_string(),
        result,
        champion,
        date: game_start_time.format("%Y-%m-%d %H:%M:%S").to_string(),
        events: active_match.events.lock().await.clone(),
        apm,
        apm_series,
        mouse_events: active_match.mouse_events.lock().await.clone(),
    };
    match save_match_metadata(&metadata) {
        Ok(_) => println!("Metadatos guardados con éxito para la partida {}", match_id),
        Err(e) => eprintln!("Error al guardar los metadatos de la partida: {}", e),
    }
}

/// Calcula el APM promedio y la serie de APM por minuto a partir de muestras
/// (tiempo_de_juego, acciones_acumuladas).
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
fn classify_ally(name: &str, player_team: &str, team_map: &HashMap<String, String>) -> Option<bool> {
    team_map.get(&strip_tag(name)).map(|t| t == player_team)
}

/// Convierte un evento de la API de Riot en un MatchEvent enriquecido y centrado en el
/// jugador. Devuelve None para eventos que no nos interesan (kills ajenos, spawns, etc.).
fn map_lol_event(
    ev: &LolEvent,
    active_name: &str,
    player_team: &str,
    team_map: &HashMap<String, String>,
) -> Option<MatchEvent> {
    let an = strip_tag(active_name);
    let stolen = ev.stolen.as_deref().map_or(false, |s| s.eq_ignore_ascii_case("true"));
    let stolen_txt = if stolen { " (¡robado!)" } else { "" };

    // (tipo, subtype, descripción)
    let (ty, subtype, description): (&str, Option<&str>, String) = match ev.event_name.as_str() {
        "GameStart" => ("GameStart", None, "Inicio de la partida".to_string()),
        "GameEnd" => {
            let res = ev.result.as_deref().unwrap_or("");
            if res.eq_ignore_ascii_case("win") {
                ("GameEnd", Some("win"), "Victoria".to_string())
            } else if res.eq_ignore_ascii_case("lose") {
                ("GameEnd", Some("lose"), "Derrota".to_string())
            } else {
                ("GameEnd", None, "Fin de la partida".to_string())
            }
        }
        "FirstBlood" => {
            let recip = ev.recipient.as_deref().unwrap_or("");
            if strip_tag(recip) == an {
                ("FirstBlood", Some("kill"), "¡Primera sangre! La conseguiste tú".to_string())
            } else {
                return None; // primera sangre ajena: no nos interesa
            }
        }
        "ChampionKill" => {
            let killer = ev.killer_name.as_deref().unwrap_or("");
            let victim = ev.victim_name.as_deref().unwrap_or("Enemigo");
            if strip_tag(killer) == an {
                ("ChampionKill", Some("kill"), format!("Mataste a {}", victim))
            } else if strip_tag(victim) == an {
                ("ChampionKill", Some("death"), format!("Te mató {}", killer))
            } else if ev.assisters.as_ref().map_or(false, |a| a.iter().any(|n| strip_tag(n) == an)) {
                ("ChampionKill", Some("assist"), format!("Asististe en la muerte de {}", victim))
            } else {
                return None; // kill que no te involucra
            }
        }
        "Multikill" => {
            let killer = ev.killer_name.as_deref().unwrap_or("");
            if strip_tag(killer) != an {
                return None;
            }
            let desc = match ev.kill_streak.unwrap_or(0) {
                2 => "¡Doble asesinato!",
                3 => "¡Triple asesinato!",
                4 => "¡Cuádruple asesinato!",
                5 => "¡PENTAKILL!",
                _ => "¡Multi-asesinato!",
            };
            ("Multikill", Some("kill"), desc.to_string())
        }
        "TurretKilled" => {
            let turret = ev.turret_killed.as_deref().unwrap_or("");
            match structure_owner_team(turret) {
                Some(owner) if owner == player_team => ("TowerKill", Some("ally"), "Perdiste una torre aliada".to_string()),
                Some(_) => ("TowerKill", Some("enemy"), "Tu equipo destruyó una torre enemiga".to_string()),
                None => ("TowerKill", None, "Torre destruida".to_string()),
            }
        }
        "InhibKilled" => {
            let inhib = ev.inhib_killed.as_deref().unwrap_or("");
            match structure_owner_team(inhib) {
                Some(owner) if owner == player_team => ("InhibKill", Some("ally"), "Perdiste un inhibidor".to_string()),
                Some(_) => ("InhibKill", Some("enemy"), "Tu equipo destruyó un inhibidor".to_string()),
                None => ("InhibKill", None, "Inhibidor destruido".to_string()),
            }
        }
        "DragonKill" => {
            let dtype = translate_dragon(ev.dragon_type.as_deref().unwrap_or(""));
            let ally = classify_ally(ev.killer_name.as_deref().unwrap_or(""), player_team, team_map);
            let sub = ally.map(|a| if a { "ally" } else { "enemy" });
            let desc = match ally {
                Some(true) => format!("Tu equipo tomó el Dragón {}{}", dtype, stolen_txt),
                Some(false) => format!("El enemigo tomó el Dragón {}{}", dtype, stolen_txt),
                None => format!("Dragón {}{}", dtype, stolen_txt),
            };
            ("DragonKill", sub, desc)
        }
        "HeraldKill" => {
            let ally = classify_ally(ev.killer_name.as_deref().unwrap_or(""), player_team, team_map);
            let sub = ally.map(|a| if a { "ally" } else { "enemy" });
            let desc = match ally {
                Some(true) => format!("Tu equipo tomó el Heraldo de la Grieta{}", stolen_txt),
                Some(false) => format!("El enemigo tomó el Heraldo de la Grieta{}", stolen_txt),
                None => format!("Heraldo de la Grieta{}", stolen_txt),
            };
            ("HeraldKill", sub, desc)
        }
        "BaronKill" => {
            let ally = classify_ally(ev.killer_name.as_deref().unwrap_or(""), player_team, team_map);
            let sub = ally.map(|a| if a { "ally" } else { "enemy" });
            let desc = match ally {
                Some(true) => format!("Tu equipo mató al Barón Nashor{}", stolen_txt),
                Some(false) => format!("El enemigo mató al Barón Nashor{}", stolen_txt),
                None => format!("Barón Nashor{}", stolen_txt),
            };
            ("BaronKill", sub, desc)
        }
        _ => return None, // MinionsSpawning, FirstBrick, Ace, Inhib respawn, etc.
    };

    Some(MatchEvent {
        r#type: ty.to_string(),
        subtype: subtype.map(|s| s.to_string()),
        time: ev.event_time,
        description,
    })
}

#[tauri::command]
pub async fn export_clip(
    match_id: String,
    video_path: String,
    start_time: f64,
    duration: f64,
) -> Result<String, String> {
    let dir = crate::storage::get_match_dir(&match_id);
    let clip_id = format!("{}_clip_{}", match_id, chrono::Local::now().format("%H%M%S"));
    let clip_path = dir.join(format!("{}.mp4", clip_id));

    let output = std::process::Command::new("ffmpeg")
        .args(&[
            "-ss", &start_time.to_string(),
            "-i", &video_path,
            "-t", &duration.to_string(),
            "-c", "copy",
            "-movflags", "faststart",
            &clip_path.to_string_lossy(),
        ])
        .output()
        .map_err(|e| format!("Fallo al ejecutar ffmpeg: {}", e))?;

    if output.status.success() {
        Ok(clip_path.to_string_lossy().to_string())
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        Err(format!("Error en ffmpeg: {}", err))
    }
}

#[derive(serde::Serialize)]
pub struct ClipMetadata {
    pub path: String,
    pub name: String,
    pub match_id: String,
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
                        if name.starts_with(&match_id) && name.contains("_clip_") && name.ends_with(".mp4") {
                            clips.push(ClipMetadata {
                                path: sub_entry.path().to_string_lossy().to_string(),
                                name,
                                match_id: match_id.clone(),
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
pub async fn upload_to_catbox(path: String) -> Result<String, String> {
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("Error leyendo archivo: {}", e))?;
    let file_name = std::path::Path::new(&path).file_name().unwrap_or_default().to_string_lossy().to_string();
    
    let part = multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str("video/mp4")
        .map_err(|_| "Error configurando el mime type".to_string())?;

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .build()
        .map_err(|e| format!("Error construyendo cliente: {}", e))?;

    let servers_res = client.get("https://api.gofile.io/servers").send().await
        .map_err(|e| format!("Error obteniendo servidor GoFile: {}", e))?;
    let servers_json: serde_json::Value = servers_res.json().await.map_err(|e| e.to_string())?;
    
    let server_name = servers_json["data"]["servers"][0]["name"].as_str()
        .ok_or_else(|| "No se encontró servidor de GoFile".to_string())?;

    let upload_url = format!("https://{}.gofile.io/contents/upload", server_name);
    let form = multipart::Form::new().part("file", part);

    let res = client.post(&upload_url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Subida fallida a GoFile: {}", e))?;

    if res.status().is_success() {
        let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        if let Some(url) = json["data"]["downloadPage"].as_str() {
            Ok(url.to_string())
        } else {
            Err("Error parseando URL de GoFile".to_string())
        }
    } else {
        Err(format!("Error en el servidor GoFile: {}", res.status()))
    }
}
