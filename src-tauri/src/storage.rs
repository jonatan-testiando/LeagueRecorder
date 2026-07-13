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

/// Comentario del usuario anclado a una marca de tiempo del vídeo.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comment {
    pub time: f64,
    pub text: String,
}

/// Un jugador de la partida (scoreboard, de la API Match-V5 de Riot).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Participant {
    pub champion: String,
    pub name: String,
    pub team_id: i32, // 100 = azul, 200 = rojo
    pub win: bool,
    pub level: i32,
    pub kills: i32,
    pub deaths: i32,
    pub assists: i32,
    pub cs: i32,
    pub gold: i32,
    pub is_self: bool,
    #[serde(default)]
    pub items: Vec<i32>, // item0..item6 (0 = casilla vacía)
    #[serde(default)]
    pub damage: i32, // daño a campeones
    #[serde(default)]
    pub vision_score: i32,
    #[serde(default)]
    pub wards_placed: i32,
}

/// Objetivos conseguidos por un equipo (panel Objectives estilo Ascent).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamObjectives {
    pub team_id: i32, // 100 = azul, 200 = rojo
    pub win: bool,
    pub dragons: i32,
    pub barons: i32,
    pub towers: i32,
    pub heralds: i32,
    pub inhibitors: i32,
}

/// Compra de un item por el jugador, con el segundo de partida en que ocurrió.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemPurchase {
    pub time: f64, // segundos de partida
    pub item_id: i32,
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
    /// API de Riot: los 10 jugadores (scoreboard). Vacío hasta sincronizar con Riot.
    #[serde(default)]
    pub participants: Vec<Participant>,
    /// API de Riot: queueId (420=clasif solo, 440=flex, 400/430=normal, 450=ARAM, 0=personalizada…).
    #[serde(default)]
    pub queue: Option<i32>,
    /// API de Riot: objetivos por equipo (dragones, barones, torres…).
    #[serde(default)]
    pub objectives: Vec<TeamObjectives>,
    /// API de Riot (timeline): compras de items del jugador con su minuto.
    #[serde(default)]
    pub item_purchases: Vec<ItemPurchase>,
    /// Comentarios del usuario anclados a marcas de tiempo del vídeo.
    #[serde(default)]
    pub comments: Vec<Comment>,
    /// True si es un VOD importado/analizado (no una partida propia grabada).
    /// Permite a la UI ocultar el panel de Victoria/Derrota, que no aplica.
    #[serde(default)]
    pub is_vod: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub save_directory: String,
    #[serde(default)]
    pub riot_api_key: String,
    #[serde(default)]
    pub auto_dataset_generator: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        let user_profile = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:".to_string());
        let default_dir = Path::new(&user_profile)
            .join("Videos")
            .join("LeagueRecorder")
            .to_string_lossy()
            .to_string();
        Self {
            save_directory: default_dir,
            riot_api_key: String::new(),
            auto_dataset_generator: false,
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

pub fn get_reviews_dir() -> PathBuf {
    let dir = get_videos_dir().join("VODsReviews");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

pub fn get_match_dir(id: &str) -> PathBuf {
    let dir = if id.starts_with("vod_") {
        get_reviews_dir().join(id)
    } else {
        get_videos_dir().join(id)
    };
    
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

/// Actualiza SOLO los comentarios de una partida (lee su JSON, reemplaza comments, reescribe).
pub fn save_comments(id: &str, comments: Vec<Comment>) -> Result<(), String> {
    let mut m = load_match_by_id(id).ok_or_else(|| "Partida no encontrada".to_string())?;
    m.comments = comments;
    save_match_metadata(&m)
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

#[tauri::command]
pub async fn get_vod_reviews() -> Vec<MatchMetadata> {
    let dir = get_reviews_dir();
    let mut matches = Vec::new();

    let mut process_file = |path: &Path| {
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(mut metadata) = serde_json::from_str::<MatchMetadata>(&content) {
                    if metadata.id.starts_with("vod_") {
                        // El listado no necesita la estela; el reproductor la carga aparte.
                        metadata.mouse_events = Vec::new();
                        matches.push(metadata);
                    }
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

/// Carga el metadata COMPLETO de una sola partida (incluye `mouse_events`) leyendo
/// directamente su JSON, sin escanear toda la biblioteca.
pub fn load_match_by_id(id: &str) -> Option<MatchMetadata> {
    let base = if id.starts_with("vod_") {
        get_reviews_dir()
    } else {
        get_videos_dir()
    };
    let file = base.join(id).join(format!("{}.json", id));
    let content = fs::read_to_string(file).ok()?;
    serde_json::from_str::<MatchMetadata>(&content).ok()
}

/// Comando: detalle completo de UNA partida (para el reproductor: estela del ratón).
#[tauri::command]
pub async fn get_match_details(id: String) -> Option<MatchMetadata> {
    load_match_by_id(&id)
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

pub fn get_dir_size(path: &Path) -> u64 {
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
