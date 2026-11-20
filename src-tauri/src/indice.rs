//! El índice: resúmenes de la biblioteca ya calculados, guardados en SQLite.
//!
//! Medido con 1.000 partidas (docs/medidas-linea-base-2026-11.md): tras las
//! fases 1 y 2, lo que quedaba en Home y Patrones no era leer la biblioteca
//! sino recalcular cada resumen desde las cachés de cada partida: miles de
//! llamadas al sistema de ficheros para comprobar fechas, más leer y parsear
//! decenas de megas de cachés, en CADA petición y en cada arranque, aunque no
//! hubiera cambiado nada. Aquí cada resumen se guarda ya calculado, junto con
//! la firma de la biblioteca con la que se calculó; si la firma coincide, se
//! devuelve tal cual, sin recalcular y sin volver a serializar.
//!
//! La firma es barata a propósito (un listado de las carpetas de la
//! biblioteca, sin abrir ninguna): versión de la app, configuración, y nombre y
//! fecha de modificación de cada carpeta de partida. La fecha de una carpeta
//! cambia cuando se crea, borra o renombra algo dentro, y todo lo que la app
//! escribe en ellas se escribe a un temporal y se renombra (o se crea nuevo):
//! cualquier cambio de los datos de una partida cambia la firma.
//!
//! El fichero (`indice.db`, junto a la config) es desechable: si falta, está
//! dañado o es de otra versión del esquema, se borra y se rehace solo.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::value::RawValue;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Súbelo cuando cambie el cálculo de algún resumen sin cambiar la versión de
/// la app (en desarrollo, sobre todo): invalida todo lo guardado.
const RESUMENES_V: u32 = 1;
/// Versión del esquema de la base (`PRAGMA user_version`).
const ESQUEMA_V: i32 = 1;

static CONEXION: Mutex<Option<(PathBuf, Connection)>> = Mutex::new(None);

fn ruta() -> PathBuf {
    crate::storage::get_config_path().with_file_name("indice.db")
}

fn abrir(ruta: &Path) -> rusqlite::Result<Connection> {
    let c = Connection::open(ruta)?;
    c.busy_timeout(std::time::Duration::from_secs(2))?;
    c.pragma_update(None, "journal_mode", "WAL")?;
    c.pragma_update(None, "synchronous", "NORMAL")?;
    let version: i32 = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version != ESQUEMA_V {
        // Es una caché: si el esquema no es el nuestro se tira y se rehace.
        c.execute_batch(
            "DROP TABLE IF EXISTS resumenes;
             CREATE TABLE resumenes (
                 nombre    TEXT PRIMARY KEY,
                 firma     TEXT NOT NULL,
                 datos     TEXT NOT NULL,
                 calculado INTEGER NOT NULL
             ) STRICT;",
        )?;
        c.pragma_update(None, "user_version", ESQUEMA_V)?;
    }
    Ok(c)
}

fn borrar_ficheros(ruta: &Path) {
    for sufijo in ["", "-wal", "-shm"] {
        let mut p = ruta.as_os_str().to_owned();
        p.push(sufijo);
        let _ = std::fs::remove_file(PathBuf::from(p));
    }
}

/// Ejecuta `f` con la conexión, abriéndola (o rehaciéndola) si hace falta.
/// Cualquier error de la base se queda aquí: el índice solo acelera, y sin él
/// todo funciona igual que antes.
fn con<R>(f: impl FnOnce(&Connection) -> rusqlite::Result<R>) -> Option<R> {
    let destino = ruta();
    let mut g = CONEXION.lock().unwrap_or_else(|e| e.into_inner());
    if g.as_ref().map(|(r, _)| *r != destino).unwrap_or(true) {
        let c = abrir(&destino).or_else(|e| {
            eprintln!("índice: {} no se puede abrir ({e}); se rehace", destino.display());
            borrar_ficheros(&destino);
            abrir(&destino)
        });
        match c {
            Ok(c) => *g = Some((destino, c)),
            Err(e) => {
                eprintln!("índice: sin índice ({e})");
                *g = None;
                return None;
            }
        }
    }
    let (_, c) = g.as_ref()?;
    match f(c) {
        Ok(r) => Some(r),
        Err(e) => {
            eprintln!("índice: {e}");
            None
        }
    }
}

/// Firma de todo lo que puede cambiar un resumen de la biblioteca.
pub fn firma_biblioteca() -> String {
    let mut h: u64 = 1469598103934665603; // FNV-1a de 64 bits
    let mut mezclar = |b: &[u8]| {
        for x in b {
            h ^= *x as u64;
            h = h.wrapping_mul(1099511628211);
        }
    };
    mezclar(env!("CARGO_PKG_VERSION").as_bytes());
    mezclar(&RESUMENES_V.to_le_bytes());
    // La configuración entera: la calibración del minimapa, la escala, el
    // idioma… Cambia poco y, si cambia, recalcular es lo seguro.
    mezclar(serde_json::to_string(&crate::storage::load_config()).unwrap_or_default().as_bytes());

    let mut carpetas = 0usize;
    for base in [crate::storage::get_videos_dir(), crate::storage::get_reviews_dir()] {
        mezclar(base.to_string_lossy().as_bytes());
        let Ok(entradas) = std::fs::read_dir(&base) else { continue };
        let mut filas: Vec<(String, u128)> = entradas
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|e| {
                let nombre = e.file_name().to_str()?.to_string();
                let fecha = e
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                Some((nombre, fecha))
            })
            .collect();
        filas.sort();
        carpetas += filas.len();
        for (nombre, fecha) in filas {
            mezclar(nombre.as_bytes());
            mezclar(&fecha.to_le_bytes());
        }
    }
    format!("{h:016x}-{carpetas}")
}

fn leer(nombre: &str, firma: &str) -> Option<String> {
    con(|c| {
        c.query_row(
            "SELECT datos FROM resumenes WHERE nombre = ?1 AND firma = ?2",
            params![nombre, firma],
            |r| r.get::<_, String>(0),
        )
        .optional()
    })
    .flatten()
}

fn guardar(nombre: &str, firma: &str, datos: &str) {
    let ahora = chrono::Utc::now().timestamp();
    con(|c| {
        c.execute(
            "INSERT INTO resumenes (nombre, firma, datos, calculado) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(nombre) DO UPDATE SET firma = excluded.firma, datos = excluded.datos,
                                               calculado = excluded.calculado",
            params![nombre, firma, datos, ahora],
        )
    });
}

/// Borra todo lo guardado: el siguiente resumen se recalcula. Para el botón de
/// Ajustes y para cuando algo se vea raro.
pub fn vaciar() {
    con(|c| c.execute("DELETE FROM resumenes", []));
}

/// El resumen `nombre` de la biblioteca: el guardado si la biblioteca no ha
/// cambiado desde que se calculó, o recién calculado con `calcular`.
///
/// Solo se guarda si la firma es la misma antes y después de calcular: el
/// cálculo puede escribir cachés por partida (eso cambia la firma, y la
/// siguiente petición ya lo guardará), y si mientras tanto terminó un análisis
/// de vídeo, lo calculado podría no incluirlo.
///
/// Devuelve el JSON ya hecho: el comando lo manda tal cual al frontend, sin
/// volver a deserializarlo ni serializarlo.
///
/// La firma y la base van en un hilo de bloqueo; el cálculo se espera tal cual.
pub async fn memo_async<T: Serialize, Fut: std::future::Future<Output = T>>(
    nombre: &'static str,
    calcular: impl FnOnce() -> Fut,
) -> Box<RawValue> {
    let (antes, guardado) = tauri::async_runtime::spawn_blocking(move || {
        let f = firma_biblioteca();
        let g = leer(nombre, &f);
        (f, g)
    })
    .await
    .unwrap_or_default();
    if let Some(raw) = guardado.and_then(|d| RawValue::from_string(d).ok()) {
        crate::medida::anotar("indice/acierto", 0.0, nombre);
        return raw;
    }
    let datos = serde_json::to_string(&calcular().await).unwrap_or_else(|_| "null".to_string());
    let copia = datos.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if !antes.is_empty() && firma_biblioteca() == antes {
            guardar(nombre, &antes, &copia);
        }
    })
    .await;
    RawValue::from_string(datos).unwrap_or_else(|_| RawValue::from_string("null".into()).expect("null"))
}

/// Como [`memo_async`] para los cálculos que pueden fallar: los errores no se guardan.
pub async fn memo_result_async<T: Serialize, Fut: std::future::Future<Output = Result<T, String>>>(
    nombre: &'static str,
    calcular: impl FnOnce() -> Fut,
) -> Result<Box<RawValue>, String> {
    let (antes, guardado) = tauri::async_runtime::spawn_blocking(move || {
        let f = firma_biblioteca();
        let g = leer(nombre, &f);
        (f, g)
    })
    .await
    .unwrap_or_default();
    if let Some(raw) = guardado.and_then(|d| RawValue::from_string(d).ok()) {
        crate::medida::anotar("indice/acierto", 0.0, nombre);
        return Ok(raw);
    }
    let datos = serde_json::to_string(&calcular().await?).map_err(|e| e.to_string())?;
    let copia = datos.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if !antes.is_empty() && firma_biblioteca() == antes {
            guardar(nombre, &antes, &copia);
        }
    })
    .await;
    RawValue::from_string(datos).map_err(|e| e.to_string())
}

/// Vacía el índice. El siguiente Home lo recalcula todo.
#[tauri::command]
pub async fn rebuild_index() -> Result<(), String> {
    let _medida = crate::medida::Tramo::nuevo("cmd/rebuild_index");
    tauri::async_runtime::spawn_blocking(vaciar).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_esquema_se_crea_y_se_rehace() {
        let dir = std::env::temp_dir().join(format!("indice-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let r = dir.join("indice.db");
        {
            let c = abrir(&r).unwrap();
            c.execute(
                "INSERT INTO resumenes (nombre, firma, datos, calculado) VALUES ('a', 'f', '1', 0)",
                [],
            )
            .unwrap();
            // Otra versión del esquema: al reabrir se tira la tabla.
            c.pragma_update(None, "user_version", 99).unwrap();
        }
        let c = abrir(&r).unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM resumenes", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        drop(c);
        borrar_ficheros(&r);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
