use crate::storage::{MatchEvent, MatchMetadata, MouseEventData};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader};
use uuid::Uuid;
use chrono::Local;
use tauri::Emitter;

#[derive(Serialize, Deserialize)]
pub struct ProcessVodResponse {
    pub success: bool,
    pub message: String,
    pub metadata: Option<MatchMetadata>,
}

#[tauri::command]
pub async fn process_vod(
    app: tauri::AppHandle,
    video_path: String,
    model_path: String, // Mantenemos la firma para que el Frontend no rompa
) -> ProcessVodResponse {
    let video_p = Path::new(&video_path);
    if !video_p.exists() {
        return ProcessVodResponse {
            success: false,
            message: "Video file not found".to_string(),
            metadata: None,
        };
    }

    println!("Iniciando procesamiento del VOD con Python: {}", video_path);
    
    let _ = app.emit("vod_progress", "Iniciando análisis del cursor con IA Clásica (OpenCV)...");

    let app_for_closure = app.clone();

    let result = tokio::task::spawn_blocking(move || {
        // Encontrar la ruta al script de python (subimos de src-tauri al root)
        let root_dir = std::env::current_dir().unwrap_or_default().parent().unwrap().to_path_buf();
        // Fallback por si lo ejecutan en dev vs production
        let python_script = root_dir.join("python_scripts").join("analyzer.py");
        let fallback_script = std::env::current_dir().unwrap_or_default().join("python_scripts").join("analyzer.py");
        
        let script_to_run = if python_script.exists() { python_script } else { fallback_script };

        let mut child = Command::new("python")
            .env("PYTHONUNBUFFERED", "1")
            .arg(&script_to_run)
            .arg(&video_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Fallo al ejecutar python: {}", e))?;

        let stderr = child.stderr.take().unwrap();
        let app_clone = app_for_closure;
        
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(l) = line {
                    // Enviar CUALQUIER output de stderr al frontend (errores, tracebacks o progreso)
                    let _ = app_clone.emit("vod_progress", format!("AI Log: {}", l));
                }
            }
        });

        let output = child.wait_with_output().map_err(|e| format!("Error esperando a python: {}", e))?;

        if !output.status.success() {
            return Err("El análisis falló. Revisa la consola para más detalles.".to_string());
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        
        let detected_clicks: Vec<MouseEventData> = serde_json::from_str(&stdout)
            .unwrap_or_else(|e| {
                println!("Error parseando JSON de Python: {}. Stdout: {}", e, stdout);
                Vec::new()
            });

        Ok((detected_clicks, video_path))
    }).await.unwrap();

    let (detected_clicks, v_path) = match result {
        Ok(res) => res,
        Err(e) => return ProcessVodResponse { success: false, message: e, metadata: None },
    };

    let match_id = format!("vod_{}", Uuid::new_v4().to_string());
    
    let new_metadata = MatchMetadata {
        id: match_id.clone(),
        game_duration: 1800.0,
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
    };

    let _ = app.emit("vod_progress", "Análisis finalizado.");

    ProcessVodResponse {
        success: true,
        message: format!("VOD analizado. Clics y tracking detectados: {}", new_metadata.mouse_events.len()),
        metadata: Some(new_metadata),
    }
}
