use crate::storage::{MatchEvent, MatchMetadata, MouseEventData};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
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
    /// PID del proceso de Python en curso (0 = ninguno), para poder cancelarlo.
    pub child_pid: AtomicU32,
    /// Marca que el usuario pidió cancelar (para distinguir fallo real de cancelación).
    pub cancel_requested: AtomicBool,
}

impl Default for AnalyzerState {
    fn default() -> Self {
        Self {
            is_running: AtomicBool::new(false),
            child_pid: AtomicU32::new(0),
            cancel_requested: AtomicBool::new(false),
        }
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

    // --- Selección de backend ---
    // Si están el venv de entreno (con onnxruntime-gpu) + el script YOLO + el modelo,
    // usamos el DETECTOR YOLO en GPU (mucho más rápido y más robusto). Si no, caemos
    // al analizador clásico (template matching CPU). Ruta configurable por env.
    let yolo_root = std::env::var("LEAGUEREC_YOLO_ROOT")
        .unwrap_or_else(|_| r"C:\Users\Alejandro\Documents\LeagueRecorder".to_string());
    let yolo_py = Path::new(&yolo_root).join(".venv-train").join("Scripts").join("python.exe");
    let yolo_script = Path::new(&yolo_root).join("python_scripts").join("yolo_backend.py");
    let yolo_model = Path::new(&yolo_root).join("models").join("cursor_multi_fp32.onnx");
    let torch_lib = Path::new(&yolo_root)
        .join(".venv-train").join("Lib").join("site-packages").join("torch").join("lib");
    let use_yolo = yolo_py.exists() && yolo_script.exists() && yolo_model.exists();

    // Lanzamos el proceso de Python AQUÍ (cuerpo async) en vez de dentro del hilo
    // bloqueante, para poder guardar su PID y permitir la cancelación.
    let mut cmd = if use_yolo {
        let _ = app.emit("vod_progress", "Iniciando análisis por GPU (YOLO)...");
        let mut c = Command::new(&yolo_py);
        c.env("PYTHONUNBUFFERED", "1")
            // Evita importar torch solo para localizar las DLLs de CUDA/cuDNN.
            .env("VOD_CUDA_DLL_DIR", torch_lib.to_string_lossy().to_string())
            .arg(&yolo_script)
            .arg(&video_path)
            .arg(yolo_model.to_string_lossy().to_string())
            .arg("960")   // imgsz
            .arg("0.30")  // conf
            .arg("48")    // batch
            .arg("8");    // workers de preproceso
        c
    } else {
        let mut c = Command::new(&python_exe);
        c.env("PYTHONUNBUFFERED", "1")
            // Aceleradores medidos en HW real para el path clásico: OpenCL penaliza
            // y el ROI adaptativo casi duplica la velocidad (~1.85x).
            .env("VOD_USE_OPENCL", "0")
            .env("VOD_ADAPTIVE_ROI", "1")
            .arg(&script_to_run)
            .arg(&video_path)
            .arg(&cursors_dir); // argv[2]: carpeta de cursores (robusta al empaquetado)
        c
    };

    let mut child = match cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) => {
            state.is_running.store(false, Ordering::SeqCst);
            let prog = if use_yolo { yolo_py.to_string_lossy().to_string() } else { python_exe.clone() };
            return Ok(ProcessVodResponse {
                success: false,
                message: format!("Fallo al ejecutar Python ({}): {}", prog, e),
                metadata: None,
            });
        }
    };

    // Registrar el PID para que `cancel_vod` pueda matarlo.
    state.child_pid.store(child.id(), Ordering::SeqCst);
    state.cancel_requested.store(false, Ordering::SeqCst);

    // Hilo lector de stderr → eventos de progreso para el frontend.
    let stderr = child.stderr.take().unwrap();
    let app_clone = app.clone();
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

    // La espera (bloqueante) y el parseo van en spawn_blocking.
    let result = tokio::task::spawn_blocking(move || {
        let output = child
            .wait_with_output()
            .map_err(|e| format!("Error esperando a python: {}", e))?;

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
    })
    .await
    .unwrap();

    // El proceso terminó: ya no hay PID que cancelar.
    state.child_pid.store(0, Ordering::SeqCst);

    let (detected_clicks, video_duration, v_path) = match result {
        Ok(res) => res,
        Err(e) => {
            state.is_running.store(false, Ordering::SeqCst);
            // Si el usuario pidió cancelar, el "fallo" es esperado: mensaje claro.
            let cancelled = state.cancel_requested.swap(false, Ordering::SeqCst);
            let message = if cancelled {
                "Análisis cancelado.".to_string()
            } else {
                e
            };
            return Ok(ProcessVodResponse { success: false, message, metadata: None });
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
        participants: Vec::new(),
        comments: Vec::new(),
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

/// Cancela el análisis de VOD en curso matando el proceso de Python (y su árbol).
/// No-op si no hay ninguno corriendo.
#[tauri::command]
pub fn cancel_vod(state: tauri::State<'_, AnalyzerState>) -> Result<(), String> {
    if !state.is_running.load(Ordering::SeqCst) {
        return Ok(());
    }
    let pid = state.child_pid.load(Ordering::SeqCst);
    if pid == 0 {
        return Ok(());
    }
    // Marcamos la cancelación para que process_vod no la reporte como error real.
    state.cancel_requested.store(true, Ordering::SeqCst);

    // En Windows matamos el árbol completo (taskkill /T) para que no quede Python huérfano.
    let _ = Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .output();

    Ok(())
}
