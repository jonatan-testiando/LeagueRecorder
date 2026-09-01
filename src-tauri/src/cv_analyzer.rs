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
pub(crate) fn resolve_resource(app: &tauri::AppHandle, rel: &str) -> Option<PathBuf> {
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
pub(crate) fn python_command(app: &tauri::AppHandle) -> String {
    if let Some(p) = resolve_resource(app, "python-runtime/python.exe") {
        return p.to_string_lossy().to_string();
    }
    "python".to_string()
}

/// Raíz donde vive el entorno de entreno (`.venv-train`), configurable por env.
///
/// Es una ruta de la máquina de desarrollo: en cualquier instalación normal no
/// existe, y quien la use tiene que degradar solo. Ver `gpu_python`.
pub(crate) fn gpu_root() -> String {
    std::env::var("LEAGUEREC_YOLO_ROOT")
        .unwrap_or_else(|_| r"C:\Users\Alejandro\Documents\LeagueRecorder".to_string())
}

/// El Python del entorno de entreno, que trae `onnxruntime-gpu`, si existe.
///
/// Lo comparten el analizador de VOD y el detector de minimapa: los dos mueven
/// modelos ONNX y los dos van varias veces más rápido por GPU, pero **ninguno
/// puede exigirlo**. `None` significa "usa el runtime empaquetado", que es lo
/// normal fuera de esta máquina.
pub(crate) fn gpu_python() -> Option<std::path::PathBuf> {
    let p = Path::new(&gpu_root())
        .join(".venv-train")
        .join("Scripts")
        .join("python.exe");
    p.exists().then_some(p)
}

/// Dónde están las DLL de CUDA (las trae torch dentro del venv de entreno).
///
/// Hay que pasárselo a Python en `VOD_CUDA_DLL_DIR` o **el proveedor CUDA no
/// carga y `onnxruntime` sigue por CPU sin decir nada**: la sesión se crea
/// igual. Es un fallo caro de ver, porque sólo se nota en el reloj.
pub(crate) fn torch_lib_dir() -> std::path::PathBuf {
    Path::new(&gpu_root())
        .join(".venv-train")
        .join("Lib")
        .join("site-packages")
        .join("torch")
        .join("lib")
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
    // Tres escalones, del mejor al peor:
    //  1) YOLO en GPU: exige el venv de entreno (onnxruntime-gpu + torch), que
    //     solo existe en la máquina de desarrollo. Ruta configurable por env.
    //  2) YOLO en CPU: script + modelo van EMPAQUETADOS como recursos y corren
    //     con el runtime embebido (que trae onnxruntime CPU). Medido en esta
    //     máquina: 1,5x tiempo real con VOD_RECT=1 — más rápido que el clásico
    //     (2,7x) y con mucha mejor detección. Es lo que reciben los usuarios;
    //     antes caían al template matching porque el modelo nunca viajaba.
    //  3) Clásico (template matching): último recurso si faltan los recursos.
    let yolo_root = gpu_root();
    let dev_py = gpu_python();
    let dev_script = Path::new(&yolo_root).join("python_scripts").join("yolo_backend.py");
    let dev_model = Path::new(&yolo_root).join("models").join("cursor_multi_fp32.onnx");
    let torch_lib = torch_lib_dir();

    enum YoloMode {
        Gpu,
        Cpu,
    }
    let yolo: Option<(PathBuf, PathBuf, PathBuf, YoloMode)> = match dev_py {
        Some(py) if dev_script.exists() && dev_model.exists() => {
            Some((py, dev_script, dev_model, YoloMode::Gpu))
        }
        _ => {
            // El runtime embebido es obligatorio para el escalón CPU: un
            // `python` cualquiera del PATH no garantiza onnxruntime.
            let runtime = resolve_resource(&app, "python-runtime/python.exe");
            let script = resolve_resource(&app, "python_scripts/yolo_backend.py");
            let model = resolve_resource(&app, "models/cursor_multi_fp32.onnx");
            match (runtime, script, model) {
                (Some(r), Some(s), Some(m)) => Some((r, s, m, YoloMode::Cpu)),
                _ => None,
            }
        }
    };
    let use_yolo = yolo.is_some();
    let yolo_py = yolo
        .as_ref()
        .map(|(py, ..)| py.clone())
        .unwrap_or_default();

    // Lanzamos el proceso de Python AQUÍ (cuerpo async) en vez de dentro del hilo
    // bloqueante, para poder guardar su PID y permitir la cancelación.
    let mut cmd = if let Some((py, script, model, mode)) = yolo {
        let (msg, batch, workers) = match mode {
            YoloMode::Gpu => ("Iniciando análisis por GPU (YOLO)...", "48", "8"),
            YoloMode::Cpu => ("Iniciando análisis YOLO (CPU)...", "8", "4"),
        };
        let _ = app.emit("vod_progress", msg);
        let mut c = Command::new(&py);
        c.env("PYTHONUNBUFFERED", "1");
        match mode {
            YoloMode::Gpu => {
                // Evita importar torch solo para localizar las DLLs de CUDA/cuDNN.
                c.env("VOD_CUDA_DLL_DIR", torch_lib.to_string_lossy().to_string());
            }
            YoloMode::Cpu => {
                // Sin CUDA: pedirlo haría fallar la sesión con el paquete CPU.
                c.env("VOD_EP", "cpu");
                // Entrada rectangular: 43% del tensor cuadrado era relleno gris;
                // medido 1,66x en CPU con paridad 99,5% de eventos.
                c.env("VOD_RECT", "1");
            }
        }
        c.arg(&script)
            .arg(&video_path)
            .arg(model.to_string_lossy().to_string())
            .arg("960") // imgsz
            .arg("0.30") // conf
            .arg(batch)
            .arg(workers);
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

    crate::proc::hide_console(&mut cmd);

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
        events: vec![MatchEvent::plain(
            "GameStart",
            None,
            0.0,
            "VOD processed with OpenCV".to_string(),
        )],
        apm: 0.0,
        apm_series: vec![],
        mouse_events: detected_clicks,
        // El analizador de VOD detecta el cursor SOBRE el vídeo: sus coordenadas ya
        // están en el espacio del vídeo, así que no hay reescalado que aplicar.
        mouse_space_w: 0,
        mouse_space_h: 0,
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
        impact_rank: None,
        impact_percentile: None,
        patch: None,
        tier_bucket: None,
        rank_tier: None,
        rank_division: None,
        rank_lp: None,
        timeline_markers: Vec::new(),
        minute_frames: Vec::new(),
        comments: Vec::new(),
        reviewed_moments: Vec::new(),
        is_vod: true,
        camera_snaps: Vec::new(),
        // Todo lo que detecta el analizador ya está en tiempo de vídeo.
        video_offset: Some(0.0),
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
    let _ = crate::proc::hide_console(
        Command::new("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]),
    )
    .output();

    Ok(())
}
