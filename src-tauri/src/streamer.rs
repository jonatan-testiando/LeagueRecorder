use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
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
    } else {
        "application/octet-stream"
    }
}
