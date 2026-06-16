use serde::{Serialize, Deserialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchEvent {
    pub r#type: String,
    pub subtype: Option<String>,
    pub time: f64,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

pub fn get_videos_dir() -> PathBuf {
    let user_profile = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:".to_string());
    let path = Path::new(&user_profile).join("Videos").join("LeagueRecorder");
    if !path.exists() {
        let _ = fs::create_dir_all(&path);
    }
    path
}

pub fn save_match_metadata(metadata: &MatchMetadata) -> Result<(), String> {
    let dir = get_videos_dir();
    let file_path = dir.join(format!("{}.json", metadata.id));
    let json_content = serde_json::to_string_pretty(metadata)
        .map_err(|e| format!("Error serializando JSON: {}", e))?;
    
    fs::write(file_path, json_content)
        .map_err(|e| format!("Error guardando archivo JSON: {}", e))?;
    Ok(())
}

pub fn load_all_matches() -> Vec<MatchMetadata> {
    let dir = get_videos_dir();
    let mut matches = Vec::new();
    
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Ok(content) = fs::read_to_string(&path) {
                    if let Ok(metadata) = serde_json::from_str::<MatchMetadata>(&content) {
                        matches.push(metadata);
                    }
                }
            }
        }
    }
    
    // Ordenar de más reciente a más antiguo
    matches.sort_by(|a, b| b.date.cmp(&a.date));
    matches
}

pub fn delete_match_files(id: &str) -> Result<(), String> {
    let dir = get_videos_dir();
    let json_path = dir.join(format!("{}.json", id));
    let mp4_path = dir.join(format!("{}.mp4", id));
    
    if json_path.exists() {
        fs::remove_file(json_path).map_err(|e| format!("No se pudo borrar el JSON: {}", e))?;
    }
    if mp4_path.exists() {
        fs::remove_file(mp4_path).map_err(|e| format!("No se pudo borrar el video MP4: {}", e))?;
    }
    Ok(())
}
