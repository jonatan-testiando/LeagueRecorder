use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::http::{header, Request, Response, StatusCode};

/// Tamaño máximo de cada respuesta parcial (2 MiB). El navegador pedirá más rangos
/// según lo necesite, lo que permite streaming fluido y búsqueda (seek) instantánea
/// sin cargar el archivo entero en memoria.
const CHUNK: u64 = 2 * 1024 * 1024;

/// Maneja una petición del protocolo `stream://` (en Windows: http://stream.localhost/...).
/// Sirve un archivo de vídeo local con soporte de HTTP Range (206 Partial Content).
pub fn handle(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    // La URL es http://stream.localhost/<ruta-absoluta-url-encoded>
    let raw_path = request.uri().path().trim_start_matches('/').to_string();
    let decoded = urlencoding::decode(&raw_path)
        .map(|c| c.into_owned())
        .unwrap_or(raw_path);

    let fail = |code: StatusCode| -> Response<Vec<u8>> {
        Response::builder().status(code).body(Vec::new()).unwrap()
    };

    // Este servidor responde con `Access-Control-Allow-Origin: *`, así que
    // cualquier página abierta en el WebView podía leer CUALQUIER archivo del
    // disco pidiéndolo por su ruta absoluta. Solo se sirve lo que es nuestro:
    // la carpeta de grabaciones (con sus VODsReviews/ y recortes/) y los datos
    // de la app. Todo lo demás, 403.
    if !ruta_permitida(&decoded) && !vod_importado(&decoded) {
        eprintln!("stream: ruta fuera de las carpetas de la app, rechazada: {decoded}");
        return fail(StatusCode::FORBIDDEN);
    }

    let mut file = match File::open(&decoded) {
        Ok(f) => f,
        Err(_) => return fail(StatusCode::NOT_FOUND),
    };
    let total = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return fail(StatusCode::NOT_FOUND),
    };
    if total == 0 {
        return fail(StatusCode::NO_CONTENT);
    }

    // Parsear la cabecera Range (p.ej. "bytes=0-" o "bytes=1000-2000")
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_range);

    // Petición sin Range de un archivo que cabe entero (los stills del entrenamiento
    // son JPEG de ~150 KB): responder 200 con todo el cuerpo. Un `<img>` no envía
    // Range y no tiene por qué lidiar con un 206. Los vídeos siempre superan CHUNK,
    // así que su ruta de streaming no cambia.
    if range.is_none() && total <= CHUNK {
        let mut buf = Vec::with_capacity(total as usize);
        if file.read_to_end(&mut buf).is_err() {
            return fail(StatusCode::INTERNAL_SERVER_ERROR);
        }
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type(&decoded))
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_LENGTH, total.to_string())
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(buf)
            .unwrap();
    }

    let (start, end) = match range {
        Some((s, Some(e))) => (s, e.min(total - 1)),
        Some((s, None)) => (s, (s + CHUNK - 1).min(total - 1)),
        None => (0, (CHUNK - 1).min(total - 1)),
    };

    if start >= total || start > end {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{}", total))
            .body(Vec::new())
            .unwrap();
    }

    let len = end - start + 1;
    let mut buf = vec![0u8; len as usize];
    if file.seek(SeekFrom::Start(start)).is_err() {
        return fail(StatusCode::INTERNAL_SERVER_ERROR);
    }
    if let Err(_) = file.read_exact(&mut buf) {
        return fail(StatusCode::INTERNAL_SERVER_ERROR);
    }

    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, content_type(&decoded))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", start, end, total),
        )
        .header(header::CONTENT_LENGTH, len.to_string())
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(buf)
        .unwrap()
}

/// Carpetas cuyo contenido este servidor puede servir.
///
/// La de grabaciones incluye por debajo `VODsReviews/`, `recortes/` y los stills
/// del entrenamiento, así que basta con la raíz. La de datos de la app
/// (`%APPDATA%/LeagueRecorder`) es donde viven los registros de awareness y
/// demás material generado.
fn raices_permitidas() -> Vec<PathBuf> {
    let mut raices = vec![crate::storage::get_videos_dir()];
    if let Ok(appdata) = std::env::var("APPDATA") {
        raices.push(Path::new(&appdata).join("LeagueRecorder"));
    }
    raices
}

/// ¿Cae `ruta` dentro de alguna carpeta permitida?
///
/// Se comparan rutas CANÓNICAS: sin eso, un `..\..\Windows\System32\...` colado
/// en medio pasaría el prefijo y saldría del corral. Canonicalizar exige que el
/// archivo exista, que es justo lo que queremos (si no existe, no hay nada que
/// servir y el 403 es tan buena respuesta como el 404).
///
/// La comparten los comandos de borrado (`commands::delete_clip`,
/// `delete_error_clip`): un `path` que llega del frontend es una cadena que el
/// backend no eligió, y borrar merece al menos el mismo corral que servir.
pub fn ruta_permitida(ruta: &str) -> bool {
    let Ok(objetivo) = std::fs::canonicalize(ruta) else {
        return false;
    };
    raices_permitidas().iter().any(|raiz| {
        std::fs::canonicalize(raiz)
            .map(|r| objetivo.starts_with(&r))
            .unwrap_or(false)
    })
}

/// ¿Es `ruta` el vídeo de un VOD importado?
///
/// Un VOD se analiza donde el usuario lo tenga (Descargas, otro disco...) y no se
/// copia a la carpeta de grabaciones, así que el corral de [`ruta_permitida`] lo
/// rechazaba con 403 y el reproductor decía "falta el fichero o está dañado" con
/// el análisis recién terminado. Se abre la puerta a esos ficheros concretos —
/// los que figuran como `video_path` en `VODsReviews/` — y a nada más.
///
/// Va aparte de `ruta_permitida` a propósito: esa también decide qué se puede
/// BORRAR, y el original de un VOD es del usuario.
///
/// Cada vídeo llega en cientos de peticiones de rango, así que la lista se
/// guarda en memoria y solo se relee de disco cuando una ruta no está en ella
/// (un VOD recién importado).
fn vod_importado(ruta: &str) -> bool {
    use std::collections::HashSet;
    use std::sync::Mutex;

    static VODS: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

    let Ok(objetivo) = std::fs::canonicalize(ruta) else {
        return false;
    };
    let mut cache = VODS.lock().unwrap_or_else(|e| e.into_inner());
    if cache.as_ref().is_some_and(|s| s.contains(&objetivo)) {
        return true;
    }
    let vods = videos_de_vods();
    let encontrado = vods.contains(&objetivo);
    *cache = Some(vods);
    encontrado
}

/// Rutas canónicas de los vídeos de todos los VOD importados.
fn videos_de_vods() -> std::collections::HashSet<PathBuf> {
    // Solo el campo que importa: el resto (la estela entera) se salta sin
    // construirlo.
    #[derive(serde::Deserialize)]
    struct SoloVideo {
        video_path: String,
    }
    let leer = |json: &Path| -> Option<PathBuf> {
        let m: SoloVideo = serde_json::from_str(&std::fs::read_to_string(json).ok()?).ok()?;
        std::fs::canonicalize(m.video_path).ok()
    };

    let mut jsons = Vec::new();
    if let Ok(entradas) = std::fs::read_dir(crate::storage::get_reviews_dir()) {
        for e in entradas.flatten() {
            let p = e.path();
            if p.is_dir() {
                // Una carpeta por análisis; los .json de dentro son el suyo
                // (y, si los hubiera, los de sus clips, que no tienen
                // `video_path` de VOD y no casan con nada fuera del corral).
                if let Ok(dentro) = std::fs::read_dir(&p) {
                    jsons.extend(dentro.flatten().map(|d| d.path()));
                }
            } else {
                // Análisis sueltos en la raíz, de antes de las carpetas.
                jsons.push(p);
            }
        }
    }
    jsons
        .iter()
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
        .filter_map(|p| leer(p))
        .collect()
}

/// Parsea "bytes=START-END" devolviendo (start, Option<end>).
fn parse_range(value: &str) -> Option<(u64, Option<u64>)> {
    let spec = value.trim().strip_prefix("bytes=")?;
    // Sólo soportamos un único rango (suficiente para reproducción de vídeo).
    let spec = spec.split(',').next()?;
    let mut parts = spec.split('-');
    let start = parts.next()?.trim().parse::<u64>().ok()?;
    let end = parts.next().and_then(|e| {
        let e = e.trim();
        if e.is_empty() {
            None
        } else {
            e.parse::<u64>().ok()
        }
    });
    Some((start, end))
}

fn content_type(path: &str) -> &'static str {
    let p = path.to_lowercase();
    if p.ends_with(".mp4") {
        "video/mp4"
    } else if p.ends_with(".webm") {
        "video/webm"
    } else if p.ends_with(".mkv") {
        "video/x-matroska"
    } else if p.ends_with(".jpg") || p.ends_with(".jpeg") {
        "image/jpeg"
    } else if p.ends_with(".png") {
        "image/png"
    } else {
        "application/octet-stream"
    }
}
