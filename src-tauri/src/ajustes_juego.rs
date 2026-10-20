//! Los ajustes de League que deciden dónde está el minimapa en pantalla.
//!
//! El análisis de minimapa (clics, miradas, manos, golpes, hechizos) necesita
//! saber qué rectángulo de la pantalla ocupa el minimapa. Durante meses fue un
//! rectángulo fijo, medido en la máquina de desarrollo, que resultó ser el de
//! `MinimapScale = 3` (el máximo). Un cliente con el valor por defecto (1) tiene
//! un minimapa un tercio más pequeño, y uno con `FlipMiniMap` lo tiene en la
//! otra esquina: a los dos se les analizaba un trozo de pantalla equivocado.
//!
//! Aquí se leen esos ajustes de los ficheros del juego al empezar cada partida
//! y se guardan en su metadata (`MatchMetadata::hud_settings`). La geometría
//! que se saca de ellos vive en `camera_input::minimapa_rect`.
//!
//! **Dónde está cada dato** (comprobado en esta máquina, parche 16.20):
//! - `Config/PersistedSettings.json` (la copia que el cliente sincroniza con el
//!   servidor): `HUD.MinimapScale`, `HUD.FlipMiniMap`, `HUD.GlobalScale`. NO
//!   trae `Width`, `Height` ni `WindowMode`: son de la máquina, no se suben.
//! - `Config/game.cfg` (INI, el que lee el juego): todo lo anterior y además
//!   `[General] Width/Height/WindowMode`.
//!
//! Se lee primero el JSON y lo que falte se completa con `game.cfg`.
//!
//! **Qué mueve el minimapa y qué no** (leído del código de iTero Coach, ver
//! `docs/analisis-itero-coach-2026-10.md` §4): sólo `MinimapScale`,
//! `FlipMiniMap` y la ALTURA de la pantalla del juego. `GlobalScale` escala la
//! barra de habilidades, no el minimapa. `Width`/`Height`/`WindowMode` se
//! guardan para diagnosticar, pero la geometría usa la resolución del monitor
//! donde se capturó el ratón: en pantalla completa y sin bordes coincide con la
//! del juego; en ventana (WindowMode=1) el minimapa está en la esquina de la
//! VENTANA, y eso hoy no se soporta (tampoco antes).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Lo que se leyó de los ajustes del juego.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HudSettings {
    /// `HUD.MinimapScale`. Rango del deslizador del juego: 0 a 3, con 1 por
    /// defecto (ver `camera_input::ESCALA_MAX`).
    pub minimap_scale: f64,
    /// `HUD.FlipMiniMap`: el minimapa anclado a la esquina izquierda.
    #[serde(default)]
    pub flip_minimap: bool,
    /// `HUD.GlobalScale`. No mueve el minimapa; se guarda porque sí mueve la
    /// barra de habilidades que leen `hud.rs` y `barras.rs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub global_scale: Option<f64>,
    /// `General.Width`/`Height`: resolución configurada en el juego.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// `General.WindowMode`: 0 pantalla completa, 1 ventana, 2 sin bordes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_mode: Option<u32>,
    /// Carpeta de League de la que salió todo esto, para poder diagnosticar.
    #[serde(default)]
    pub install_dir: String,
}

/// Valor de `MinimapScale` cuando los ficheros no lo traen: el que da por
/// defecto el propio cliente (`/lol-game-settings/v1/game-settings-schema`).
const ESCALA_POR_DEFECTO: f64 = 1.0;

/// Los ajustes de la instalación de League de esta máquina, o `None` si no se
/// encuentra ninguna o no se puede leer.
pub fn detectar() -> Option<HudSettings> {
    leer(&carpeta_de_league()?)
}

/// La carpeta de League (la que contiene `Config/`).
///
/// En orden: la del proceso del juego (si está abierto, es la que de verdad se
/// está usando), la que Riot apunta en sus metadatos de instalación (cubre a
/// quien instaló en otro disco sin la partida abierta, que es el caso de
/// Ajustes) y la ruta por defecto.
pub fn carpeta_de_league() -> Option<PathBuf> {
    let candidatas = [
        // ...\League of Legends\Game\League of Legends.exe → ...\League of Legends
        crate::winsys::window_process_path(crate::recorder::GAME_WINDOW)
            .and_then(|exe| Some(exe.parent()?.parent()?.to_path_buf())),
        carpeta_segun_riot(),
        Some(PathBuf::from(r"C:\Riot Games\League of Legends")),
    ];
    candidatas.into_iter().flatten().find(|d| d.join("Config").is_dir())
}

/// `product_install_full_path` del YAML que deja el cliente de Riot.
fn carpeta_segun_riot() -> Option<PathBuf> {
    let datos = std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".into());
    let yaml = Path::new(&datos)
        .join("Riot Games")
        .join("Metadata")
        .join("league_of_legends.live")
        .join("league_of_legends.live.product_settings.yaml");
    ruta_de_yaml(&std::fs::read_to_string(yaml).ok()?)
}

/// Saca la ruta de la línea `product_install_full_path: "C:/..."`. Basta con
/// leer esa línea: meter un parser de YAML por un campo sería desproporcionado.
fn ruta_de_yaml(txt: &str) -> Option<PathBuf> {
    txt.lines()
        .find_map(|l| l.trim().strip_prefix("product_install_full_path:"))
        .map(|v| v.trim().trim_matches('"').trim_matches('\''))
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Lee los ajustes de una carpeta de League concreta.
pub fn leer(dir: &Path) -> Option<HudSettings> {
    let config = dir.join("Config");
    let json = std::fs::read_to_string(config.join("PersistedSettings.json"))
        .ok()
        .map(|t| valores_de_persisted(&t));
    let cfg = std::fs::read_to_string(config.join("game.cfg"))
        .ok()
        .map(|t| valores_de_cfg(&t));
    if json.is_none() && cfg.is_none() {
        return None;
    }
    let mut v = json.unwrap_or_default();
    v.completar_con(cfg.unwrap_or_default());
    Some(v.en_ajustes(dir))
}

/// Los valores sueltos, tal cual vienen (texto), antes de interpretarlos.
#[derive(Debug, Default, PartialEq)]
struct Valores {
    minimap_scale: Option<f64>,
    flip_minimap: Option<bool>,
    global_scale: Option<f64>,
    width: Option<u32>,
    height: Option<u32>,
    window_mode: Option<u32>,
}

impl Valores {
    /// Apunta un ajuste de la sección `seccion`. Lo que no interesa se ignora.
    fn poner(&mut self, seccion: &str, nombre: &str, valor: &str) {
        let valor = valor.trim();
        let f = || valor.parse::<f64>().ok().filter(|v| v.is_finite());
        let u = || f().filter(|v| *v >= 0.0).map(|v| v.round() as u32);
        match (seccion.to_ascii_lowercase().as_str(), nombre) {
            ("hud", "MinimapScale") => self.minimap_scale = f(),
            // "0"/"1" en game.cfg, "0"/"1" en el JSON; "true"/"false" por si acaso.
            ("hud", "FlipMiniMap") => {
                self.flip_minimap = match valor.to_ascii_lowercase().as_str() {
                    "1" | "true" => Some(true),
                    "0" | "false" => Some(false),
                    _ => None,
                }
            }
            ("hud", "GlobalScale") => self.global_scale = f(),
            ("general", "Width") => self.width = u(),
            ("general", "Height") => self.height = u(),
            ("general", "WindowMode") => self.window_mode = u(),
            _ => {}
        }
    }

    /// Rellena lo que falta con lo de `otro`, sin pisar lo que ya hay.
    fn completar_con(&mut self, otro: Valores) {
        self.minimap_scale = self.minimap_scale.or(otro.minimap_scale);
        self.flip_minimap = self.flip_minimap.or(otro.flip_minimap);
        self.global_scale = self.global_scale.or(otro.global_scale);
        self.width = self.width.or(otro.width);
        self.height = self.height.or(otro.height);
        self.window_mode = self.window_mode.or(otro.window_mode);
    }

    fn en_ajustes(self, dir: &Path) -> HudSettings {
        HudSettings {
            minimap_scale: self.minimap_scale.unwrap_or(ESCALA_POR_DEFECTO),
            flip_minimap: self.flip_minimap.unwrap_or(false),
            global_scale: self.global_scale,
            width: self.width.filter(|w| *w > 0),
            height: self.height.filter(|h| *h > 0),
            window_mode: self.window_mode,
            install_dir: dir.to_string_lossy().into_owned(),
        }
    }
}

/// `PersistedSettings.json`:
/// `{"files":[{"name":"Game.cfg","sections":[{"name":"HUD","settings":[{"name":"MinimapScale","value":"3.0000"}]}]}]}`.
/// Sólo cuenta el fichero `Game.cfg`: `Input.ini` también tiene secciones y no
/// pinta nada aquí.
fn valores_de_persisted(txt: &str) -> Valores {
    let mut v = Valores::default();
    // El fichero lo escribe el cliente con BOM en algunas versiones.
    let Ok(raiz) = serde_json::from_str::<serde_json::Value>(txt.trim_start_matches('\u{feff}')) else {
        return v;
    };
    let ficheros = raiz.get("files").and_then(|f| f.as_array()).into_iter().flatten();
    for fichero in ficheros {
        let nombre = fichero.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if !nombre.eq_ignore_ascii_case("game.cfg") {
            continue;
        }
        let secciones = fichero.get("sections").and_then(|s| s.as_array()).into_iter().flatten();
        for seccion in secciones {
            let sn = seccion.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let ajustes = seccion.get("settings").and_then(|s| s.as_array()).into_iter().flatten();
            for a in ajustes {
                let (Some(n), Some(val)) = (a.get("name").and_then(|n| n.as_str()), a.get("value")) else {
                    continue;
                };
                // El valor viene como texto ("3.0000"), pero no cuesta aceptar
                // también un número o un booleano.
                let texto = match val {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Bool(b) => (if *b { "1" } else { "0" }).to_string(),
                    otro => otro.to_string(),
                };
                v.poner(sn, n, &texto);
            }
        }
    }
    v
}

/// `game.cfg`: INI de toda la vida, `[Seccion]` y `Clave=Valor`.
fn valores_de_cfg(txt: &str) -> Valores {
    let mut v = Valores::default();
    let mut seccion = String::new();
    for linea in txt.lines() {
        let l = linea.trim().trim_start_matches('\u{feff}');
        if let Some(s) = l.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            seccion = s.trim().to_string();
        } else if let Some((k, val)) = l.split_once('=') {
            v.poner(&seccion, k.trim(), val);
        }
    }
    v
}

/// Lo que detecta la app ahora mismo, para enseñarlo en Ajustes.
#[derive(Debug, Serialize)]
pub struct MinimapDetection {
    /// `None` si no se encontró League o sus ajustes no se pudieron leer.
    pub hud: Option<HudSettings>,
}

/// Los ajustes del minimapa que se usarían si empezara una partida ahora.
#[tauri::command]
pub fn get_minimap_detection() -> MinimapDetection {
    MinimapDetection { hud: detectar() }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Recorte real del fichero de esta máquina (parche 16.20).
    const PERSISTED: &str = r#"{
        "description": "The settings in this file are persisted server-side.",
        "files": [
            {"name": "Game.cfg", "sections": [
                {"name": "General", "settings": [
                    {"name": "CfgVersion", "value": "16.20.824.8524"},
                    {"name": "RelativeTeamColors", "value": "1"}
                ]},
                {"name": "HUD", "settings": [
                    {"name": "FlipMiniMap", "value": "0"},
                    {"name": "GlobalScale", "value": "0.0000"},
                    {"name": "MinimapScale", "value": "3.0000"},
                    {"name": "MinimapScaleSpectator", "value": "1.0000"}
                ]}
            ]},
            {"name": "Input.ini", "sections": [
                {"name": "HUD", "settings": [{"name": "MinimapScale", "value": "9"}]}
            ]}
        ]
    }"#;

    const CFG: &str = "\u{feff}\r\n[General]\r\nHeight=1440\r\nWidth=2560\r\nWindowMode=2\r\n\r\n[HUD]\r\nMinimapScale=1.5000\r\nGlobalScale=0.0000\r\nFlipMiniMap=1\r\n\r\n[Replay]\r\nMinimapScale=7\r\n";

    #[test]
    fn el_json_trae_el_hud_y_no_la_resolucion() {
        let v = valores_de_persisted(PERSISTED);
        assert_eq!(v.minimap_scale, Some(3.0));
        assert_eq!(v.flip_minimap, Some(false));
        assert_eq!(v.global_scale, Some(0.0));
        // Ni Input.ini ni MinimapScaleSpectator se confunden con el bueno.
        assert_eq!((v.width, v.height, v.window_mode), (None, None, None));
    }

    #[test]
    fn el_cfg_se_lee_por_secciones() {
        let v = valores_de_cfg(CFG);
        // La de [Replay] no pisa la de [HUD].
        assert_eq!(v.minimap_scale, Some(1.5));
        assert_eq!(v.flip_minimap, Some(true));
        assert_eq!((v.width, v.height, v.window_mode), (Some(2560), Some(1440), Some(2)));
    }

    /// El JSON manda; game.cfg sólo rellena lo que el JSON no trae.
    #[test]
    fn el_json_manda_y_el_cfg_completa() {
        let mut v = valores_de_persisted(PERSISTED);
        v.completar_con(valores_de_cfg(CFG));
        let a = v.en_ajustes(Path::new(r"D:\Juegos\League of Legends"));
        assert_eq!(a.minimap_scale, 3.0);
        assert!(!a.flip_minimap);
        assert_eq!((a.width, a.height, a.window_mode), (Some(2560), Some(1440), Some(2)));
        assert_eq!(a.install_dir, r"D:\Juegos\League of Legends");
    }

    /// Ficheros sin la clave o con basura: el valor por defecto del juego, no
    /// un rectángulo inventado.
    #[test]
    fn sin_escala_se_usa_la_del_juego_por_defecto() {
        let a = valores_de_cfg("[HUD]\nMinimapScale=abc\nFlipMiniMap=x\n").en_ajustes(Path::new("x"));
        assert_eq!(a.minimap_scale, ESCALA_POR_DEFECTO);
        assert!(!a.flip_minimap);
        assert_eq!(valores_de_persisted("no es json"), Valores::default());
    }

    #[test]
    fn la_ruta_sale_del_yaml_de_riot() {
        let y = "auto_patching_enabled_by_player: false\nproduct_install_full_path: \"D:/Riot Games/League of Legends\"\nproduct_install_root: \"D:/Riot Games/\"\n";
        assert_eq!(ruta_de_yaml(y), Some(PathBuf::from("D:/Riot Games/League of Legends")));
        assert_eq!(ruta_de_yaml("nada: 1\n"), None);
    }

    /// Sobre la instalación real de esta máquina. Se activa con `LR_REAL=1`.
    #[test]
    fn sobre_la_instalacion_real() {
        if std::env::var("LR_REAL").is_err() {
            return;
        }
        println!("carpeta: {:?}", carpeta_de_league());
        println!("ajustes: {:?}", detectar());
    }
}
