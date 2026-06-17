use serde::{Deserialize, Serialize};
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
pub struct MouseEventData {
    pub t: f64,
    pub x: f64,
    pub y: f64,
    pub evt: String,
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
    /// Movimientos y clics del ratón.
    #[serde(default)]
    pub mouse_events: Vec<MouseEventData>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub save_directory: String,
    #[serde(default)]
    pub riot_api_key: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        let user_profile = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:".to_string());
        Self {
            save_directory: Path::new(&user_profile)
                .join("Videos")
                .join("LeagueRecorder")
                .to_string_lossy()
                .to_string(),
            riot_api_key: "".to_string(),
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

pub fn load_config() -> AppConfig {
    if let Ok(content) = fs::read_to_string(get_config_path()) {
        if let Ok(cfg) = serde_json::from_str(&content) {
            return cfg;
        }
    }
    AppConfig::default()
}

pub fn save_config(cfg: &AppConfig) {
    if let Ok(content) = serde_json::to_string_pretty(cfg) {
        let _ = fs::write(get_config_path(), content);
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

pub fn get_match_dir(id: &str) -> PathBuf {
    let dir = get_videos_dir().join(id);
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

pub fn save_match_metadata(metadata: &MatchMetadata) -> Result<(), String> {
    let dir = get_match_dir(&metadata.id);
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

    let mut process_file = |path: &Path| {
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(metadata) = serde_json::from_str::<MatchMetadata>(&content) {
                    matches.push(metadata);
                }
            }
        }
    };

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Ok(sub_entries) = fs::read_dir(&path) {
                    for sub_entry in sub_entries.flatten() {
                        process_file(&sub_entry.path());
                    }
                }
            } else if path.is_file() {
                process_file(&path);
            }
        }
    }

    // Ordenar de más reciente a más antiguo
    matches.sort_by(|a, b| b.date.cmp(&a.date));
    matches
}

pub fn get_match_metadata(match_id: &str) -> Result<MatchMetadata, String> {
    let matches = load_all_matches();
    for m in matches {
        if m.id == match_id {
            return Ok(m);
        }
    }
    Err("Match not found".to_string())
}

pub fn delete_match_files(id: &str) -> Result<(), String> {
    let match_dir = get_match_dir(id);
    if match_dir.exists() {
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

fn get_dir_size(path: &Path) -> u64 {
    let mut size = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let meta = entry.metadata().unwrap();
            if meta.is_dir() {
                size += get_dir_size(&entry.path());
            } else {
                size += meta.len();
            }
        }
    }
    size
}

pub fn check_storage_quota() {
    let limit: u64 = 100 * 1024 * 1024 * 1024; // 100 GB
    let root_dir = get_videos_dir();
    let current_size = get_dir_size(&root_dir);

    if current_size > limit {
        let mut matches = load_all_matches();
        // Sort from oldest to newest (ascending)
        matches.sort_by(|a, b| a.date.cmp(&b.date));

        let mut freed = 0;
        let excess = current_size - limit;

        for m in matches {
            if freed >= excess {
                break;
            }
            let m_dir = get_match_dir(&m.id);
            let size = get_dir_size(&m_dir);
            if delete_match_files(&m.id).is_ok() {
                freed += size;
            }
        }
    }
}
