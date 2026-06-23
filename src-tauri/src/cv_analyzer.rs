use crate::storage::{MatchEvent, MatchMetadata, MouseEventData};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use uuid::Uuid;
use chrono::Local;
use tauri::{Emitter, Manager};

/// Localiza un recurso empaquetado (`rel`, p.ej. "python_scripts/analyzer.py")
/// probando, en orden: el directorio de recursos de Tauri (instalación real),
/// el directorio del ejecutable, y varias rutas de desarrollo. Devuelve la
/// primera que exista. Misma filosofía que `recorder::ffmpeg_path`.
fn resolve_resource(app: &tauri::AppHandle, rel: &str) -> Option<PathBuf> {
    // 1) Directorio oficial de recursos de Tauri (junto al .exe en producción)
    if let Ok(res_dir) = app.path().resource_dir() {
        let p = res_dir.join(rel);
        if p.exists() {
            return Some(p);
        }
    }
    // 2) Junto al ejecutable, con saltos hacia arriba para `tauri dev`
    //    (el exe vive en src-tauri/target/debug/ → la raíz del repo está a ../../../)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for up in ["", "../../..", "../.."] {
                let p = if up.is_empty() {
                    parent.join(rel)
                } else {
                    parent.join(up).join(rel)
                };
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }
    // 3) Directorio de trabajo (en `tauri dev` suele ser src-tauri/)
    if let Ok(cwd) = std::env::current_dir() {
        let p = cwd.join(rel);
        if p.exists() {
            return Some(p);
        }
        if let Some(parent) = cwd.parent() {
            let p2 = parent.join(rel);
            if p2.exists() {
                return Some(p2);
            }
        }
    }
    None
}

/// Devuelve la ruta al intérprete de Python embebido si está empaquetado,
/// o cae al `python` del PATH del sistema (modo desarrollo).
fn python_command(app: &tauri::AppHandle) -> String {
    if let Some(p) = resolve_resource(app, "python-runtime/python.exe") {
        return p.to_string_lossy().to_string();
    }
    "python".to_string()
}

pub struct AnalyzerState {
    pub is_running: AtomicBool,
}

impl Default for AnalyzerState {
    fn default() -> Self {
        Self { is_running: AtomicBool::new(false) }
    }
}

#[derive(Serialize, Deserialize)]
pub struct ProcessVodResponse {
    pub success: bool,
    pub message: String,
    pub metadata: Option<MatchMetadata>,
}

/// Salida estructurada del analizador de Python: eventos de ratón + metadatos
/// reales del vídeo (duración/dimensiones), para no hardcodear la duración.
#[derive(Deserialize)]
struct AnalyzerOutput {
    #[serde(default)]
    events: Vec<MouseEventData>,
    #[serde(default)]
    duration: f64,
}

#[tauri::command]
pub async fn process_vod(
    app: tauri::AppHandle,
    state: tauri::State<'_, AnalyzerState>,
    video_path: String,
    model_path: String, // Mantenemos la firma para que el Frontend no rompa
) -> Result<ProcessVodResponse, String> {
    if state.is_running.swap(true, Ordering::SeqCst) {
        return Ok(ProcessVodResponse {
            success: false,
            message: "Ya hay un análisis de IA en curso. Por favor espera a que termine para evitar problemas de rendimiento.".to_string(),
            metadata: None,
        });
    }

    let video_p = Path::new(&video_path);
    if !video_p.exists() {
        state.is_running.store(false, Ordering::SeqCst);
        return Ok(ProcessVodResponse {
            success: false,
            message: "Video file not found".to_string(),
            metadata: None,
        });
    }

    println!("Iniciando procesamiento del VOD con Python: {}", video_path);
    
    let _ = app.emit("vod_progress", "Iniciando análisis del cursor con OpenCV...");

    // Resolver rutas de recursos ANTES de entrar al hilo bloqueante. Así funciona
    // tanto en `tauri dev` como en la instalación empaquetada.
    let script_to_run = match resolve_resource(&app, "python_scripts/analyzer.py") {
        Some(p) => p,
        None => {
            state.is_running.store(false, Ordering::SeqCst);
            return Ok(ProcessVodResponse {
                success: false,
                message: "No se encontró analyzer.py. ¿Falta empaquetar python_scripts/?".to_string(),
                metadata: None,
            });
        }
    };
    let cursors_dir = resolve_resource(&app, "assets/cursors")
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let python_exe = python_command(&app);

    let app_for_closure = app.clone();

    let result = tokio::task::spawn_blocking(move || {
        let mut child = Command::new(&python_exe)
            .env("PYTHONUNBUFFERED", "1")
            .arg(&script_to_run)
            .arg(&video_path)
            .arg(&cursors_dir) // argv[2]: carpeta de cursores (robusta al empaquetado)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Fallo al ejecutar Python ({}): {}", python_exe, e))?;

        let stderr = child.stderr.take().unwrap();
        let app_clone = app_for_closure;

        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(l) = line {
                    if l.starts_with("[HARDWARE]") {
                        let msg = l.replace("[HARDWARE]", "");
                        let _ = app_clone.emit("hardware_info", msg.trim().to_string());
                    } else if let Some(pct) = l.strip_prefix("PROGRESS:") {
                        // Línea estructurada de progreso → evento numérico para una barra real
                        if let Ok(v) = pct.trim().parse::<f64>() {
                            let _ = app_clone.emit("vod_progress_pct", v);
                        }
                    } else {
                        // Enviar output normal de stderr al frontend como progreso
                        let _ = app_clone.emit("vod_progress", format!("AI Log: {}", l));
                    }
                }
            }
        });

        let output = child.wait_with_output().map_err(|e| format!("Error esperando a python: {}", e))?;

        if !output.status.success() {
            return Err("El análisis falló. Revisa la consola para más detalles.".to_string());
        }

        let stdout = String::from_utf8_lossy(&output.stdout);

        // Parseo del formato estructurado. Si falla, lo reportamos como error real
        // en vez de fingir un análisis vacío exitoso.
        let parsed: AnalyzerOutput = serde_json::from_str(&stdout).map_err(|e| {
            let preview: String = stdout.chars().take(200).collect();
            format!("No se pudo interpretar la salida del analizador: {}. Salida: {}", e, preview)
        })?;

        Ok((parsed.events, parsed.duration, video_path))
    }).await.unwrap();

    let (detected_clicks, video_duration, v_path) = match result {
        Ok(res) => res,
        Err(e) => {
            state.is_running.store(false, Ordering::SeqCst);
            return Ok(ProcessVodResponse { success: false, message: e, metadata: None });
        }
    };

    let match_id = format!("vod_{}", Uuid::new_v4().to_string());
    
    let new_metadata = MatchMetadata {
        id: match_id.clone(),
        // Duración real reportada por el analizador (fallback defensivo si viene 0).
        game_duration: if video_duration > 0.0 { video_duration } else { 1800.0 },
        video_path: v_path,
        result: "Unknown".to_string(),
        champion: "VOD Analysis".to_string(),
        date: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        events: vec![MatchEvent {
            r#type: "GameStart".to_string(),
            subtype: None,
            time: 0.0,
            description: "VOD Procesado con OpenCV Python".to_string()
        }],
        apm: 0.0,
        apm_series: vec![],
        mouse_events: detected_clicks,
        riot_match_id: None,
        kda: None,
        gold_earned: None,
        damage_dealt: None,
        is_vod: true,
    };

    let _ = app.emit("vod_progress", "Análisis finalizado.");

    // Guardar en el disco (en la carpeta VODsReviews)
    let _ = crate::storage::save_match_metadata(&new_metadata);

    state.is_running.store(false, Ordering::SeqCst);

    Ok(ProcessVodResponse {
        success: true,
        message: format!("VOD analizado. Clics y tracking detectados: {}", new_metadata.mouse_events.len()),
        metadata: Some(new_metadata),
    })
}
