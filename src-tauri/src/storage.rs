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

/// Marcador de evento en la línea de tiempo del vídeo (de la Timeline v5 de Riot).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineMarker {
    pub time: f64, // segundos en el vídeo
    pub event_type: String, // "kill", "death", "dragon", "herald", "tower", "plate"
    pub description: String,
    #[serde(default)]
    pub position_x: Option<i32>,
    #[serde(default)]
    pub position_y: Option<i32>,
}

/// Fotograma minuto a minuto de la partida (Timeline v5) para la gráfica de oro/XP
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MinuteFrameDto {
    pub minute: i32,
    pub team_gold_diff: i32,
    pub self_gold_diff: i32,
    pub self_xp_diff: i32,
    pub self_jungle_cs_diff: i32,
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
    /// Resolución del escritorio en la que se capturaron `mouse_events`.
    ///
    /// Imprescindible para dibujar la estela: `rdev` da coordenadas de PANTALLA, no
    /// del vídeo, y grabar 1080p en un monitor 1440p desplazaba el trazo un 33%.
    /// 0 = partida antigua sin este dato (el reproductor tira de heurística).
    #[serde(default)]
    pub mouse_space_w: u32,
    #[serde(default)]
    pub mouse_space_h: u32,
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
    /// API de Riot (timeline): métricas avanzadas a min 15
    #[serde(default)]
    pub gold_diff_15: Option<i32>,
    #[serde(default)]
    pub xp_diff_15: Option<i32>,
    #[serde(default)]
    pub jungle_cs_diff_15: Option<i32>,
    #[serde(default)]
    pub gank_impact_15: Option<f64>,
    #[serde(default)]
    pub lane_result: Option<String>,
    /// Marcadores de eventos para la barra del reproductor de vídeo
    #[serde(default)]
    pub timeline_markers: Vec<TimelineMarker>,
    /// Fotogramas minuto a minuto para la gráfica de oro/XP
    #[serde(default)]
    pub minute_frames: Vec<MinuteFrameDto>,
    /// Comentarios del usuario anclados a marcas de tiempo del vídeo.
    #[serde(default)]
    pub comments: Vec<Comment>,
    /// True si es un VOD importado/analizado (no una partida propia grabada).
    /// Permite a la UI ocultar el panel de Victoria/Derrota, que no aplica.
    #[serde(default)]
    pub is_vod: bool,
    /// Segundos de vídeo en que la cámara dio un salto (tecla de cámara aliada),
    /// detectados por `camera_snaps.py`. Vacío hasta que se analiza la partida.
    #[serde(default)]
    pub camera_snaps: Vec<f64>,
}

/// Suelo de la cuota de disco. Cualquier valor por debajo se ignora: un 0 aquí
/// significaría "borra todas las grabaciones".
pub const MIN_STORAGE_GB: u64 = 10;

fn default_max_storage() -> u64 { 100 }
/// 0 = borrado por edad DESACTIVADO. Es el valor que heredan las configuraciones
/// ya guardadas, que no traen el campo: actualizar la app nunca debe empezar a
/// borrar grabaciones que el usuario no ha pedido borrar.
fn default_auto_prune() -> u32 { 0 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub save_directory: String,
    #[serde(default)]
    pub riot_api_key: String,
    #[serde(default)]
    pub auto_dataset_generator: bool,
    #[serde(default = "default_max_storage")]
    pub max_storage_gb: u64,
    #[serde(default = "default_auto_prune")]
    pub auto_prune_days: u32,
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
            max_storage_gb: 100,
            // Opt-in, también en instalaciones nuevas: ver `default_auto_prune`.
            auto_prune_days: 0,
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

    // Una carpeta por partida. Los sueltos en la raíz ya no se contemplan: `migrate_flat_layout`
    // los recoloca al arrancar.
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Ok(sub_entries) = fs::read_dir(&path) {
                    for sub_entry in sub_entries.flatten() {
                        process_file(&sub_entry.path());
                    }
                }
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

/// Marca de que la migración de disposición ya corrió en ese directorio.
const LAYOUT_MARKER: &str = ".layout-v2";

/// A qué partida pertenece un fichero suelto de la raíz, por su nombre:
///   `match_x.json` / `match_x.mp4`        -> "match_x"
///   `match_x_error_3.mp4` / `.json`       -> "match_x"
/// Devuelve None para cualquier cosa que no sea un `.json`/`.mp4` (el propio marcador incluido).
fn owner_id_of(file_name: &str) -> Option<String> {
    let path = Path::new(file_name);
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if ext != "json" && ext != "mp4" {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    let id = match stem.find("_error_") {
        Some(i) => &stem[..i],
        None => stem,
    };
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

/// Migra la disposición antigua (ficheros sueltos `<id>.json` / `<id>.mp4` / `<id>_error_*.mp4`
/// en la raíz) a la actual: una carpeta `<id>/` por partida.
///
/// Se ejecuta una sola vez por directorio, marcada con un fichero `.layout-v2`. NO borra nada:
/// solo mueve, y si el destino ya existe deja el original donde está y lo registra. Si algún
/// movimiento falla no escribe el marcador, así que el siguiente arranque lo reintenta.
///
/// Devuelve la lista de ficheros movidos (para el log).
pub fn migrate_flat_layout(root: &Path) -> Vec<String> {
    let marker = root.join(LAYOUT_MARKER);
    if marker.exists() {
        return Vec::new();
    }

    let mut moved = Vec::new();
    let mut failed = false;

    let Ok(entries) = fs::read_dir(root) else {
        return moved; // sin marcador: se reintenta en el próximo arranque
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(id) = owner_id_of(name) else {
            continue;
        };

        let dest_dir = root.join(&id);
        if let Err(e) = fs::create_dir_all(&dest_dir) {
            eprintln!("Migración: no se pudo crear {}: {e}", dest_dir.display());
            failed = true;
            continue;
        }
        let dest = dest_dir.join(name);
        if dest.exists() {
            eprintln!(
                "Migración: {} ya existe; dejo {} sin tocar",
                dest.display(),
                path.display()
            );
            failed = true;
            continue;
        }
        match fs::rename(&path, &dest) {
            Ok(()) => moved.push(name.to_string()),
            Err(e) => {
                eprintln!("Migración: no se pudo mover {}: {e}", path.display());
                failed = true;
            }
        }
    }

    if !failed {
        let _ = fs::write(&marker, "1");
    }
    moved
}

/// Lanza la migración sobre los dos directorios que pueden tener partidas sueltas.
pub fn migrate_storage_layout() {
    for root in [get_videos_dir(), get_reviews_dir()] {
        let moved = migrate_flat_layout(&root);
        if !moved.is_empty() {
            println!(
                "Migración de disposición en {}: {} fichero(s) movidos a su carpeta",
                root.display(),
                moved.len()
            );
        }
    }
}

/// Carga el metadata COMPLETO de una sola partida (incluye `mouse_events`) leyendo
/// directamente su JSON, sin escanear toda la biblioteca.
///
/// Solo mira la disposición actual (`<base>/<id>/<id>.json`): de los sueltos antiguos en la raíz
/// se encarga `migrate_flat_layout` al arrancar.
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

/// Decide si una partida puede borrarse automáticamente. Borrar una partida se
/// lleva por delante su carpeta entera, y ahí dentro viven también sus clips, así
/// que hay dos cosas que el borrado automático nunca toca:
///   - VOD importados: material que el usuario trajo a mano, no lo generamos nosotros.
///   - Partidas con algún clip marcado como favorito.
fn is_auto_deletable(m: &MatchMetadata) -> bool {
    if m.is_vod {
        return false;
    }
    !has_favorite_clip(&m.id)
}

/// true si la carpeta de la partida contiene algún clip marcado como favorito.
/// Se lee el JSON en crudo a propósito: solo nos interesa ese campo y no queremos
/// que un cambio de forma en `ClipMetadata` haga fallar el parseo y, con él, la
/// protección.
fn has_favorite_clip(match_id: &str) -> bool {
    let dir = get_match_dir(match_id);
    let Ok(entries) = fs::read_dir(&dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.contains("_clip_") || !name.ends_with(".json") {
            continue;
        }
        if let Ok(content) = fs::read_to_string(entry.path()) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                if v.get("favorite").and_then(|f| f.as_bool()).unwrap_or(false) {
                    return true;
                }
            }
        }
    }
    false
}

pub fn check_storage_quota() {
    let cfg = load_config();
    // Un límite de 0 (campo vacío en ajustes, config corrupta) borraría absolutamente
    // todo: por debajo del mínimo lo tratamos como "sin configurar".
    let limit: u64 = cfg.max_storage_gb.max(MIN_STORAGE_GB) * 1024 * 1024 * 1024;
    let prune_days = cfg.auto_prune_days;
    let root_dir = get_videos_dir();

    // 1. Borrado por edad. Desactivado mientras `auto_prune_days` sea 0, que es
    //    el valor por defecto: es destructivo, así que se opta por él a mano.
    //    El formato de fecha es "YYYY-MM-DD HH:MM:SS".
    if prune_days > 0 {
        let now = chrono::Local::now().naive_local();
        for m in load_all_matches() {
            if !is_auto_deletable(&m) {
                continue;
            }
            let Ok(dt) = chrono::NaiveDateTime::parse_from_str(&m.date, "%Y-%m-%d %H:%M:%S") else {
                continue; // fecha ilegible: no la borramos a ciegas
            };
            if now.signed_duration_since(dt).num_days() > prune_days as i64 {
                if let Err(e) = delete_match_files(&m.id) {
                    eprintln!("Auto-prune: no se pudo borrar {}: {}", m.id, e);
                }
            }
        }
    }

    // 2. Borrado por cuota. El tamaño se mide una sola vez, ya con el paso anterior
    //    aplicado: recorrer el árbol entero es caro y antes se hacía dos veces.
    let current_size = get_dir_size(&root_dir);
    if current_size <= limit {
        return;
    }

    let mut matches = load_all_matches();
    matches.sort_by(|a, b| a.date.cmp(&b.date)); // de la más antigua a la más nueva

    let mut freed = 0;
    let excess = current_size - limit;
    for m in matches {
        if freed >= excess {
            break;
        }
        if !is_auto_deletable(&m) {
            continue;
        }
        let size = get_dir_size(&get_match_dir(&m.id));
        match delete_match_files(&m.id) {
            Ok(()) => freed += size,
            Err(e) => eprintln!("Cuota: no se pudo borrar {}: {}", m.id, e),
        }
    }
}

#[cfg(test)]
mod layout_migration_tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("leaguerec-layout-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path) {
        fs::write(path, b"x").unwrap();
    }

    #[test]
    fn deriva_el_id_del_nombre() {
        assert_eq!(owner_id_of("match_1.json").as_deref(), Some("match_1"));
        assert_eq!(owner_id_of("match_1.mp4").as_deref(), Some("match_1"));
        assert_eq!(owner_id_of("match_1_error_3.mp4").as_deref(), Some("match_1"));
        assert_eq!(owner_id_of("match_1_error_3.json").as_deref(), Some("match_1"));
        // Ni el marcador ni cualquier otra cosa se tocan.
        assert_eq!(owner_id_of(".layout-v2"), None);
        assert_eq!(owner_id_of("notas.txt"), None);
    }

    #[test]
    fn agrupa_los_sueltos_en_su_carpeta() {
        let root = temp_root("agrupa");
        touch(&root.join("match_1.json"));
        touch(&root.join("match_1.mp4"));
        touch(&root.join("match_1_error_0.mp4"));
        touch(&root.join("match_1_error_0.json"));
        touch(&root.join("match_2.json"));

        let moved = migrate_flat_layout(&root);
        assert_eq!(moved.len(), 5);

        for f in ["match_1.json", "match_1.mp4", "match_1_error_0.mp4", "match_1_error_0.json"] {
            assert!(root.join("match_1").join(f).exists(), "falta {f}");
            assert!(!root.join(f).exists(), "{f} sigue suelto en la raíz");
        }
        assert!(root.join("match_2").join("match_2.json").exists());
        assert!(root.join(LAYOUT_MARKER).exists());
    }

    #[test]
    fn no_toca_lo_que_ya_esta_migrado() {
        let root = temp_root("idempotente");
        touch(&root.join("match_1.json"));
        assert_eq!(migrate_flat_layout(&root).len(), 1);
        // Segunda pasada: el marcador la corta en seco.
        touch(&root.join("match_9.json"));
        assert!(migrate_flat_layout(&root).is_empty());
        assert!(root.join("match_9.json").exists(), "no debería haberse movido");
    }

    #[test]
    fn nunca_pisa_un_destino_existente() {
        let root = temp_root("colision");
        fs::create_dir_all(root.join("match_1")).unwrap();
        fs::write(root.join("match_1").join("match_1.json"), b"el bueno").unwrap();
        fs::write(root.join("match_1.json"), b"el suelto").unwrap();

        assert!(migrate_flat_layout(&root).is_empty());
        assert_eq!(fs::read(root.join("match_1").join("match_1.json")).unwrap(), b"el bueno");
        assert!(root.join("match_1.json").exists(), "el suelto no se debe perder");
        // Sin marcador: al haber quedado algo pendiente, el próximo arranque lo reintenta.
        assert!(!root.join(LAYOUT_MARKER).exists());
    }

    #[test]
    fn ignora_directorios_y_extensiones_ajenas() {
        let root = temp_root("ignora");
        fs::create_dir_all(root.join("VODsReviews")).unwrap();
        fs::create_dir_all(root.join("dataset")).unwrap();
        touch(&root.join("notas.txt"));

        assert!(migrate_flat_layout(&root).is_empty());
        assert!(root.join("VODsReviews").is_dir());
        assert!(root.join("dataset").is_dir());
        assert!(root.join("notas.txt").is_file());
    }
}
