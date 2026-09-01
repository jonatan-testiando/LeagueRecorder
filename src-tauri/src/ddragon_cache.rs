//! Caché local de Data Dragon.
//!
//! Los iconos de item, hechizo y mapa se cargaban directos del CDN público en
//! cada sesión: sin conexión la interfaz se quedaba sin iconos, y con ella cada
//! apertura repetía descargas de assets que son inmutables (la versión va en la
//! ruta). Este protocolo (`http://ddragon.localhost/...`) sirve desde disco y
//! solo sale a la red en el primer fallo de caché.
//!
//! Mismo patrón que `streamer.rs` (el protocolo `stream://`), pero asíncrono:
//! el primer acceso descarga, y eso no puede bloquear el hilo del webview.
//!
//! La única ruta MUTABLE es `/api/versions.json` (cambia con cada parche): se
//! revalida cada 24 h y, sin red, se sirve la copia vieja — una lista de
//! versiones caducada sigue siendo mejor que una interfaz sin iconos.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::http::{header, Request, Response, StatusCode};

const CDN: &str = "https://ddragon.leagueoflegends.com";
const VERSIONS_TTL_SECS: u64 = 24 * 3600;

fn cache_dir() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| "C:".to_string());
    std::path::Path::new(&appdata)
        .join("LeagueRecorder")
        .join("ddragon")
}

/// Ruta local del asset, o `None` si la ruta pedida no es un asset legal.
///
/// El saneado importa: la URL la compone el frontend pero viaja como una ruta
/// arbitraria, y un `..` colándose aquí leería fuera de la carpeta de caché.
fn cache_path_for(path: &str) -> Option<PathBuf> {
    let mut out = cache_dir();
    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    for seg in trimmed.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return None;
        }
        if !seg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            return None;
        }
        out.push(seg);
    }
    Some(out)
}

fn content_type(path: &str) -> &'static str {
    let p = path.to_lowercase();
    if p.ends_with(".png") {
        "image/png"
    } else if p.ends_with(".jpg") || p.ends_with(".jpeg") {
        "image/jpeg"
    } else if p.ends_with(".json") {
        "application/json"
    } else {
        "application/octet-stream"
    }
}

fn respond(bytes: Vec<u8>, path: &str, immutable: bool) -> Response<Vec<u8>> {
    let cache = if immutable {
        // La versión va en la ruta: el asset no cambia nunca.
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type(path))
        .header(header::CACHE_CONTROL, cache)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(bytes)
        .unwrap()
}

fn fail(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(code).body(Vec::new()).unwrap()
}

async fn download(path: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("{CDN}{path}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("CDN {}", resp.status()));
    }
    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

/// Atiende una petición `http://ddragon.localhost/<ruta-del-cdn>`.
pub async fn handle(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = request.uri().path().to_string();
    let Some(local) = cache_path_for(&path) else {
        return fail(StatusCode::BAD_REQUEST);
    };
    let mutable = path == "/api/versions.json";

    let cache_valida = if mutable {
        fs::metadata(&local)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|e| e.as_secs() < VERSIONS_TTL_SECS)
            .unwrap_or(false)
    } else {
        local.exists()
    };

    if cache_valida {
        if let Ok(bytes) = fs::read(&local) {
            return respond(bytes, &path, !mutable);
        }
    }

    match download(&path).await {
        Ok(bytes) => {
            if let Some(dir) = local.parent() {
                let _ = fs::create_dir_all(dir);
            }
            let _ = fs::write(&local, &bytes);
            respond(bytes, &path, !mutable)
        }
        Err(e) => {
            // Sin red: lo cacheado, aunque haya caducado, es mejor que nada.
            if let Ok(bytes) = fs::read(&local) {
                return respond(bytes, &path, !mutable);
            }
            log::debug!("ddragon: {path} no disponible ({e})");
            fail(StatusCode::NOT_FOUND)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn las_rutas_legales_caen_dentro_de_la_cache() {
        let p = cache_path_for("/cdn/15.11.1/img/item/3153.png").unwrap();
        assert!(p.starts_with(cache_dir()));
        assert!(p.ends_with("cdn/15.11.1/img/item/3153.png"));
        assert!(cache_path_for("/api/versions.json").is_some());
    }

    #[test]
    fn un_escape_de_ruta_se_rechaza() {
        assert!(cache_path_for("/../config.json").is_none());
        assert!(cache_path_for("/cdn/../../secreto").is_none());
        assert!(cache_path_for("/cdn//doble").is_none());
        assert!(cache_path_for("/").is_none());
        assert!(cache_path_for("/cdn/img/con espacio.png").is_none());
    }
}
