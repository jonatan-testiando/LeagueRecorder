//! Medidas de tiempo para la fase 0 del plan de almacenamiento.
//!
//! Apagadas por defecto: solo escriben si existe la variable de entorno
//! `WARDLINE_MEDIR`. Si vale una ruta, las líneas se añaden a ese fichero; si
//! vale cualquier otra cosa («1»), van a `%TEMP%\wardline-medidas.log`. No se usa
//! el crate `log` porque la app nunca inicializa un logger: lo que se mande por
//! ahí se pierde.
//!
//! Formato de cada línea, pensado para leerlo con una hoja de cálculo o `awk`:
//!
//!     <ms desde el arranque>\t<qué>\t<ms que tardó>\t<detalle>
//!
//! Además lleva la cuenta de los recorridos completos de la biblioteca y de las
//! partidas que se abren con la estela entera, que es lo que el plan quiere
//! poder comparar antes y después.

use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

static INICIO: OnceLock<Instant> = OnceLock::new();
static DESTINO: OnceLock<Option<Mutex<std::fs::File>>> = OnceLock::new();

/// Recorridos completos de la biblioteca (`load_all_matches`).
pub static RECORRIDOS: AtomicU64 = AtomicU64::new(0);
/// Bytes de metadata leídos: recorridos, `metadata_ligera` y aperturas con estela.
pub static BYTES_RECORRIDOS: AtomicU64 = AtomicU64::new(0);
/// Partidas abiertas con la estela del ratón (`load_match_by_id`).
pub static APERTURAS_CON_ESTELA: AtomicU64 = AtomicU64::new(0);
/// Bytes de los crudos de Riot leídos (`riot_timeline.json`, `riot_match.json`).
pub static BYTES_CRUDOS: AtomicU64 = AtomicU64::new(0);
/// Escrituras del metadata de una partida (`save_match_metadata`).
pub static ESCRITURAS_METADATA: AtomicU64 = AtomicU64::new(0);
/// Bytes escritos en esas escrituras.
pub static BYTES_ESCRITOS: AtomicU64 = AtomicU64::new(0);

fn destino() -> Option<&'static Mutex<std::fs::File>> {
    DESTINO
        .get_or_init(|| {
            let valor = std::env::var("WARDLINE_MEDIR").ok()?;
            let ruta = if valor.contains('\\') || valor.contains('/') {
                std::path::PathBuf::from(valor)
            } else {
                std::env::temp_dir().join("wardline-medidas.log")
            };
            let f = std::fs::OpenOptions::new().create(true).append(true).open(ruta).ok()?;
            INICIO.get_or_init(Instant::now);
            Some(Mutex::new(f))
        })
        .as_ref()
}

/// ¿Está midiendo? Barato: después de la primera llamada es leer un `OnceLock`.
pub fn activa() -> bool {
    destino().is_some()
}

/// Escribe una línea. `ms` es lo que tardó la operación.
pub fn anotar(que: &str, ms: f64, detalle: &str) {
    let Some(f) = destino() else { return };
    let desde = INICIO.get().map(|i| i.elapsed().as_secs_f64() * 1000.0).unwrap_or(0.0);
    if let Ok(mut f) = f.lock() {
        let _ = writeln!(f, "{desde:.0}\t{que}\t{ms:.2}\t{detalle}");
    }
}

/// Marca el arranque de la app (la cuenta de «ms desde el arranque»).
pub fn arranque() {
    if activa() {
        anotar("arranque", 0.0, "");
    }
}

/// Cronómetro que anota al soltarse. `Tramo::nuevo("x")` al principio de la
/// función y listo; `con` añade un detalle que se conoce al final.
pub struct Tramo {
    que: &'static str,
    t: Option<Instant>,
    detalle: String,
}

impl Tramo {
    pub fn nuevo(que: &'static str) -> Self {
        Tramo { que, t: activa().then(Instant::now), detalle: String::new() }
    }

    pub fn con(&mut self, detalle: impl Into<String>) {
        if self.t.is_some() {
            self.detalle = detalle.into();
        }
    }
}

impl Drop for Tramo {
    fn drop(&mut self) {
        if let Some(t) = self.t {
            anotar(self.que, t.elapsed().as_secs_f64() * 1000.0, &self.detalle);
        }
    }
}

/// Suma a un contador y devuelve el valor nuevo.
pub fn contar(c: &AtomicU64, n: u64) -> u64 {
    c.fetch_add(n, Ordering::Relaxed) + n
}
