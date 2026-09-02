//! Copia de seguridad y restauración: "tus datos sobreviven a una reinstalación".
//!
//! Lo que pesa en esta app son los vídeos, y los vídeos son reemplazables: se
//! vuelven a grabar. Lo que **no** se puede volver a tener es lo que escribió
//! el usuario —las notas de los clips de error, los comentarios anclados a un
//! segundo, los momentos ya revisados— y el análisis caro que ya se hizo. Todo
//! eso son kilobytes de JSON repartidos por la biblioteca, así que la copia es
//! diminuta y cabe en cualquier sitio.
//!
//! Por eso aquí NO entra ni un `.mp4`. Tampoco los DTO crudos de Riot
//! (`riot_match.json`, `riot_timeline.json`): pesan megas cada uno y se vuelven
//! a pedir a la API. Lo que entra es:
//!
//! ```text
//!   manifest.json                      versión, fecha, nº de partidas
//!   config.json                        ajustes SIN la clave de la API
//!   training/**                        configuración, sesiones y quizzes
//!   matches/<id>/<id>.json             metadata de cada partida
//!   matches/<id>/camera_snaps.json     informe de miradas
//!   matches/<id>/<id>_error_*.json     notas y sucesos de cada clip de error
//! ```
//!
//! La restauración es **aditiva y no destructiva**: nunca pisa un dato local
//! que ya tenga contenido. Una partida cuyo vídeo ya no está se restaura igual,
//! sin `video_path`; el frontend ya sabe enseñar una partida sin vídeo, y las
//! notas y las estadísticas valen por sí solas.

use crate::storage::{self, MatchMetadata};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Formato del ZIP. Sube si cambia la disposición de carpetas de dentro.
const BACKUP_V: u32 = 1;

/// La tarjeta de identidad de la copia, para poder mirar qué es sin abrirla del
/// todo y para que una versión futura sepa qué se está comiendo.
#[derive(Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    /// Fecha local de creación, "YYYY-MM-DD HH:MM:SS".
    pub created: String,
    /// Cuántas partidas lleva dentro.
    pub matches: usize,
    /// Versión de LeagueRecorder que la hizo.
    pub app_version: String,
}

/// Lo que hizo una restauración. Son tres números porque son las tres cosas
/// distintas que pueden pasarle a una partida de la copia, y mezclarlas
/// escondería justo lo que el usuario quiere saber ("¿cuántas he recuperado
/// sin vídeo?").
#[derive(Serialize, Default)]
pub struct ImportReport {
    /// Partidas que existían aquí y se les completó algo.
    pub restored: usize,
    /// Partidas que no existían y se han creado sin vídeo.
    pub created_without_video: usize,
    /// Entradas que no aportaban nada (o no se pudieron leer).
    pub skipped: usize,
}

// ---------------------------------------------------------------------------
// Exportar
// ---------------------------------------------------------------------------

/// Escribe `LeagueRecorder-backup-YYYYMMDD-HHMM.zip` en `dest_dir` y devuelve
/// la ruta completa del fichero.
#[tauri::command]
pub fn export_backup(dest_dir: String) -> Result<String, String> {
    let dir = PathBuf::from(dest_dir.trim());
    if dir.as_os_str().is_empty() {
        return Err("No destination folder was given for the backup".to_string());
    }
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    let ahora = chrono::Local::now();
    let nombre = format!("LeagueRecorder-backup-{}.zip", ahora.format("%Y%m%d-%H%M"));
    let destino = dir.join(&nombre);

    let fichero = std::fs::File::create(&destino)
        .map_err(|e| format!("Could not create {}: {e}", destino.display()))?;
    let mut zip = zip::ZipWriter::new(fichero);
    let opciones: zip::write::SimpleFileOptions = Default::default();

    let escribir = |zip: &mut zip::ZipWriter<std::fs::File>, ruta: &str, datos: &[u8]| {
        zip.start_file(ruta, opciones)
            .and_then(|_| zip.write_all(datos).map_err(Into::into))
            .map_err(|e| format!("Could not write {ruta} into the backup: {e}"))
    };

    // Los ajustes, SIN la clave de la API: una copia de seguridad acaba en una
    // carpeta compartida, en un pendrive o en un correo, y una clave de Riot
    // que viaja es una clave regalada. Al restaurar se pide de nuevo.
    let mut cfg = serde_json::to_value(storage::load_config())
        .map_err(|e| format!("Could not serialize the settings: {e}"))?;
    if let Some(o) = cfg.as_object_mut() {
        o.remove("riot_api_key");
    }
    let cfg_txt = serde_json::to_string_pretty(&cfg).unwrap_or_default();
    escribir(&mut zip, "config.json", cfg_txt.as_bytes())?;

    // El entrenamiento vive fuera de la biblioteca (`%APPDATA%`), así que hay
    // que ir a por él aparte o se perdería entero.
    for (rel, abs) in ficheros_de(&crate::training::training_dir()) {
        if let Ok(datos) = std::fs::read(&abs) {
            escribir(&mut zip, &format!("training/{rel}"), &datos)?;
        }
    }

    let partidas = storage::load_all_matches();
    let mut n = 0usize;
    for m in &partidas {
        let origen = storage::get_match_dir(&m.id);
        let meta = origen.join(format!("{}.json", m.id));
        let Ok(datos) = std::fs::read(&meta) else { continue };
        escribir(&mut zip, &format!("matches/{}/{}.json", m.id, m.id), &datos)?;
        n += 1;
        for nombre in storage::sidecars_de(&origen) {
            if let Ok(datos) = std::fs::read(origen.join(&nombre)) {
                escribir(&mut zip, &format!("matches/{}/{nombre}", m.id), &datos)?;
            }
        }
    }

    let manifest = Manifest {
        version: BACKUP_V,
        created: ahora.format("%Y-%m-%d %H:%M:%S").to_string(),
        matches: n,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    let manifest_txt = serde_json::to_string_pretty(&manifest).unwrap_or_default();
    escribir(&mut zip, "manifest.json", manifest_txt.as_bytes())?;

    zip.finish()
        .map_err(|e| format!("Could not finish writing the backup: {e}"))?;
    log::info!("copia de seguridad: {n} partidas en {}", destino.display());
    Ok(destino.to_string_lossy().to_string())
}

/// Todos los ficheros bajo `raiz`, con su ruta relativa en formato ZIP.
fn ficheros_de(raiz: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let mut pila = vec![(String::new(), raiz.to_path_buf())];
    while let Some((prefijo, dir)) = pila.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let Some(nombre) = e.file_name().to_str().map(|s| s.to_string()) else {
                continue;
            };
            let rel = if prefijo.is_empty() {
                nombre.clone()
            } else {
                format!("{prefijo}/{nombre}")
            };
            if e.path().is_dir() {
                pila.push((rel, e.path()));
            } else {
                out.push((rel, e.path()));
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Importar
// ---------------------------------------------------------------------------

/// Restaura una copia. Aditiva: nunca pisa un dato local que ya tenga algo.
#[tauri::command]
pub fn import_backup(zip_path: String) -> Result<ImportReport, String> {
    let fichero = std::fs::File::open(zip_path.trim())
        .map_err(|e| format!("Could not open the backup file: {e}"))?;
    let mut zip = zip::ZipArchive::new(fichero)
        .map_err(|e| format!("That file is not a valid backup: {e}"))?;

    // Todo a memoria primero: son kilobytes, y así el bucle de restauración no
    // tiene que pelearse con el préstamo mutable del archivo por cada entrada.
    let mut entradas: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..zip.len() {
        let Ok(mut f) = zip.by_index(i) else { continue };
        if f.is_dir() {
            continue;
        }
        let nombre = f.name().replace('\\', "/");
        let mut datos = Vec::new();
        if f.read_to_end(&mut datos).is_ok() {
            entradas.push((nombre, datos));
        }
    }

    let manifest: Option<Manifest> = entradas
        .iter()
        .find(|(n, _)| n == "manifest.json")
        .and_then(|(_, d)| serde_json::from_slice(d).ok());
    if let Some(mf) = &manifest {
        if mf.version > BACKUP_V {
            return Err(format!(
                "This backup was made by a newer version of the app (format v{})",
                mf.version
            ));
        }
    }

    let mut informe = ImportReport::default();

    // 1. Las partidas. Primero los metadata, luego los sidecars: crear la
    //    carpeta al escribir el metadata deja el sitio hecho para el resto.
    for (nombre, datos) in &entradas {
        let Some(id) = id_de_metadata(nombre) else { continue };
        let Ok(copia) = serde_json::from_slice::<MatchMetadata>(datos) else {
            informe.skipped += 1;
            continue;
        };
        match storage::load_match_by_id(&id) {
            Some(mut local) => {
                if fusionar(&mut local, &copia) {
                    let _ = storage::save_match_metadata(&local);
                    informe.restored += 1;
                } else {
                    informe.skipped += 1;
                }
            }
            None => {
                let mut nueva = copia;
                // Sin vídeo: la ruta de la copia apunta a un disco que aquí no
                // existe, y una ruta rota es peor que ninguna.
                nueva.video_path = String::new();
                let _ = storage::save_match_metadata(&nueva);
                informe.created_without_video += 1;
            }
        }
    }

    // 2. Los sidecars, sólo si aquí no hay ya uno. Una nota local siempre gana:
    //    es lo último que escribió el usuario en ESTA máquina.
    for (nombre, datos) in &entradas {
        let Some((id, hoja)) = sidecar_de(nombre) else { continue };
        let destino = storage::get_match_dir(&id).join(&hoja);
        if destino.exists() {
            continue;
        }
        let _ = std::fs::write(&destino, datos);
    }

    // 3. El entrenamiento, con el mismo criterio: lo que aquí no existe.
    for (nombre, datos) in &entradas {
        let Some(rel) = nombre.strip_prefix("training/") else { continue };
        let destino = crate::training::training_dir().join(rel);
        if destino.exists() {
            continue;
        }
        if let Some(padre) = destino.parent() {
            let _ = std::fs::create_dir_all(padre);
        }
        let _ = std::fs::write(&destino, datos);
    }

    // 4. Los ajustes.
    if let Some((_, datos)) = entradas.iter().find(|(n, _)| n == "config.json") {
        if let Ok(copia) = serde_json::from_slice::<serde_json::Value>(datos) {
            restaurar_config(&copia);
        }
    }

    log::info!(
        "restauración: {} completadas, {} creadas sin vídeo, {} sin cambios",
        informe.restored,
        informe.created_without_video,
        informe.skipped
    );
    Ok(informe)
}

/// `matches/<id>/<id>.json` → `<id>`.
fn id_de_metadata(nombre: &str) -> Option<String> {
    let resto = nombre.strip_prefix("matches/")?;
    let (id, hoja) = resto.split_once('/')?;
    (hoja == format!("{id}.json")).then(|| id.to_string())
}

/// `matches/<id>/<hoja>` → `(<id>, <hoja>)`, saltándose el propio metadata.
fn sidecar_de(nombre: &str) -> Option<(String, String)> {
    let resto = nombre.strip_prefix("matches/")?;
    let (id, hoja) = resto.split_once('/')?;
    if hoja == format!("{id}.json") || hoja.contains('/') {
        return None;
    }
    Some((id.to_string(), hoja.to_string()))
}

/// Vuelca en la partida local lo que la copia tiene y ella no.
///
/// Nunca al revés y nunca encima: si aquí hay comentarios, mandan los de aquí.
/// `video_path` no se toca jamás — el vídeo es de esta máquina y la copia sabe
/// de rutas de otra.
///
/// Devuelve `true` si ha cambiado algo (y por tanto hay que guardar).
fn fusionar(local: &mut MatchMetadata, copia: &MatchMetadata) -> bool {
    let mut cambio = false;

    if local.comments.is_empty() && !copia.comments.is_empty() {
        local.comments = copia.comments.clone();
        cambio = true;
    }
    if local.reviewed_moments.is_empty() && !copia.reviewed_moments.is_empty() {
        local.reviewed_moments = copia.reviewed_moments.clone();
        cambio = true;
    }
    // El impacto cuesta parsear dos JSON de varios megas; si la copia lo trae
    // hecho, no hay motivo para rehacerlo.
    if local.impact_rank.is_none() && copia.impact_rank.is_some() {
        local.impact_rank = copia.impact_rank;
        local.impact_percentile = copia.impact_percentile;
        cambio = true;
    }
    // El rango de cuando se jugó la partida es IRRECUPERABLE: league-v4 sólo da
    // el de hoy. Si se pierde, ya no vuelve.
    if local.rank_tier.is_none() && copia.rank_tier.is_some() {
        local.rank_tier = copia.rank_tier.clone();
        local.rank_division = copia.rank_division.clone();
        local.rank_lp = copia.rank_lp;
        cambio = true;
    }
    if local.tier_bucket.is_none() && copia.tier_bucket.is_some() {
        local.tier_bucket = copia.tier_bucket.clone();
        cambio = true;
    }
    cambio
}

/// Aplica los ajustes de la copia sobre los de aquí, con dos excepciones.
fn restaurar_config(copia: &serde_json::Value) {
    let local = storage::load_config();
    let Ok(mut mezcla) = serde_json::to_value(&local) else { return };
    let (Some(dst), Some(src)) = (mezcla.as_object_mut(), copia.as_object()) else {
        return;
    };
    for (k, v) in src {
        // La clave de la API no viaja en la copia, pero si alguna copia antigua
        // la llevara: una clave local que ya funciona no se pisa nunca.
        if k == "riot_api_key" && !local.riot_api_key.is_empty() {
            continue;
        }
        // La carpeta de vídeos es de la máquina, no del usuario: restaurar la
        // ruta de otro ordenador dejaría la biblioteca apuntando a la nada.
        if k == "save_directory" && !Path::new(v.as_str().unwrap_or("")).is_dir() {
            continue;
        }
        dst.insert(k.clone(), v.clone());
    }
    if let Ok(cfg) = serde_json::from_value::<storage::AppConfig>(mezcla) {
        let _ = storage::save_config(&cfg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn con(comments: Vec<crate::storage::Comment>) -> MatchMetadata {
        MatchMetadata { id: "m".into(), comments, ..Default::default() }
    }

    fn comentario(t: f64) -> crate::storage::Comment {
        crate::storage::Comment { time: t, text: "nota".into() }
    }

    #[test]
    fn rutas_del_zip() {
        assert_eq!(id_de_metadata("matches/abc/abc.json").as_deref(), Some("abc"));
        assert_eq!(id_de_metadata("matches/abc/camera_snaps.json"), None);
        assert_eq!(id_de_metadata("training/config.json"), None);
        assert_eq!(
            sidecar_de("matches/abc/camera_snaps.json"),
            Some(("abc".into(), "camera_snaps.json".into()))
        );
        assert_eq!(sidecar_de("matches/abc/abc.json"), None);
    }

    /// Lo local manda siempre; la copia sólo rellena huecos.
    #[test]
    fn la_fusion_nunca_pisa_lo_que_ya_hay() {
        let mut local = con(vec![comentario(1.0)]);
        let copia = con(vec![comentario(9.0), comentario(10.0)]);
        assert!(!fusionar(&mut local, &copia));
        assert_eq!(local.comments.len(), 1);
        assert_eq!(local.comments[0].time, 1.0);
    }

    #[test]
    fn la_fusion_rellena_lo_que_falta() {
        let mut local = con(vec![]);
        let mut copia = con(vec![comentario(9.0)]);
        copia.reviewed_moments = vec![3.0];
        copia.impact_rank = Some(2);
        copia.rank_tier = Some("EMERALD".into());
        assert!(fusionar(&mut local, &copia));
        assert_eq!(local.comments.len(), 1);
        assert_eq!(local.reviewed_moments, vec![3.0]);
        assert_eq!(local.impact_rank, Some(2));
        assert_eq!(local.rank_tier.as_deref(), Some("EMERALD"));
    }

    /// La ruta del vídeo es de ESTA máquina y no se toca: es lo único que la
    /// copia no puede saber.
    #[test]
    fn la_fusion_no_toca_la_ruta_del_video() {
        let mut local = con(vec![]);
        local.video_path = "D:/aqui/video.mp4".into();
        let mut copia = con(vec![comentario(1.0)]);
        copia.video_path = "E:/otro-pc/video.mp4".into();
        fusionar(&mut local, &copia);
        assert_eq!(local.video_path, "D:/aqui/video.mp4");
    }

}
