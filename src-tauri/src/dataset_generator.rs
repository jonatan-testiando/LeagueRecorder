use crate::storage::{MatchMetadata, MouseEventData};
use rand::seq::SliceRandom;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub async fn generate_dataset(
    app: &tauri::AppHandle,
    video_path: &str,
    metadata: &MatchMetadata,
    dataset_dir: &Path,
    max_samples: usize,
) -> Result<(), String> {
    let ffmpeg_exe = crate::proc::ffmpeg(app);
    let images_dir = dataset_dir.join("images");
    let labels_dir = dataset_dir.join("labels");

    fs::create_dir_all(&images_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&labels_dir).map_err(|e| e.to_string())?;

    // Crear classes.txt para que Roboflow reconozca el formato YOLO
    let classes_path = dataset_dir.join("classes.txt");
    if !classes_path.exists() {
        let _ = fs::write(classes_path, "click\n");
    }

    // Filtrar solo clics derechos (movimiento / ataque)
    let mut right_clicks: Vec<&MouseEventData> = metadata
        .mouse_events
        .iter()
        .filter(|e| e.evt == "right_click")
        .collect();

    if right_clicks.is_empty() {
        return Ok(());
    }

    // Tomar una muestra aleatoria para no saturar el disco ni tardar mucho
    let mut rng = rand::thread_rng();
    right_clicks.shuffle(&mut rng);
    let sample = right_clicks.into_iter().take(max_samples).collect::<Vec<_>>();

    let match_id = &metadata.id;

    // Resolución real del vídeo. Se lee de la cabecera de `ffmpeg -i` en vez de
    // llamar a ffprobe: ese binario no se empaqueta, así que dependía de que el
    // usuario lo tuviera instalado.
    let (screen_w, screen_h) = crate::proc::video_dimensions(&ffmpeg_exe, video_path)
        .unwrap_or((1920.0, 1080.0));

    let box_size = 60.0; // 60x60 pixels bounding box
    
    let norm_w = box_size / screen_w;
    let norm_h = box_size / screen_h;

    for (i, click) in sample.iter().enumerate() {
        // Reducimos el delay a 0.05s para que la cámara no se haya movido casi nada
        let extract_time = click.t + 0.05;
        if extract_time < 0.0 || extract_time > metadata.game_duration {
            continue;
        }

        let base_name = format!("{}_click_{:04}", match_id, i);
        let img_path = images_dir.join(format!("{}.jpg", base_name));
        let lbl_path = labels_dir.join(format!("{}.txt", base_name));

        // Calcular coordenadas YOLO (Normalizadas 0 a 1)
        let norm_x = click.x / screen_w;
        let norm_y = click.y / screen_h;
        
        let label_content = format!("0 {:.6} {:.6} {:.6} {:.6}\n", norm_x, norm_y, norm_w, norm_h);

        // Extraer frame con FFmpeg (Fast Seek)
        // -ss antes de -i es MUY rápido
        let output = crate::proc::hide_console(Command::new(&ffmpeg_exe).args(&[
            "-y", // Sobrescribir
            "-ss", &format!("{:.3}", extract_time),
            "-i", video_path,
            "-frames:v", "1",
            "-q:v", "2", // Alta calidad JPEG
            img_path.to_str().unwrap(),
        ]))
        .output();

        match output {
            Ok(res) if res.status.success() => {
                // Solo escribimos el label si la imagen se extrajo correctamente
                let _ = fs::write(&lbl_path, label_content);
            }
            _ => {
                println!("Error extrayendo frame en {}", extract_time);
            }
        }
    }

    Ok(())
}
