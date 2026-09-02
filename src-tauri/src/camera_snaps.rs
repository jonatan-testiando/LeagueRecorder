//! Detección de saltos de cámara sobre el vídeo de una partida.
//!
//! Lanza `python_scripts/camera_snaps.py`, que identifica los instantes en que la
//! cámara teletransportó (una tecla de cámara aliada) y extrae un fotograma de cada
//! uno. Con eso salen dos cosas:
//!
//!   * Métricas objetivas de cumplimiento (checks/min, hueco ciego más largo) que
//!     se pintan en el timeline junto al APM.
//!   * La biblioteca de imágenes que alimenta el drill de lectura rápida.
//!
//! A diferencia del muestreo en vivo, esto funciona sobre partidas ya grabadas,
//! incluidas las de antes de instalar el entrenamiento.

use crate::cv_analyzer::{python_command, resolve_resource, AnalyzerState};
use crate::storage::{get_match_dir, load_match_by_id, save_match_metadata};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use tauri::Emitter;

/// Margen alrededor de una muerte propia en el que los saltos de cámara se
/// descartan: al morir la cámara se mueve sola.
const DEATH_WINDOW_SECS: f64 = 6.0;

/// Un salto detectado, tal y como lo devuelve el script.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snap {
    pub t: f64,
    #[serde(default)]
    pub mad: f64,
    #[serde(default)]
    pub response: f64,
    /// Nombre del JPEG extraído dentro de `<carpeta_partida>/snaps/`, si se guardó.
    #[serde(default)]
    pub still: Option<String>,
    /// Dónde miraste, en coordenadas de mapa. Sólo lo saben las miradas que
    /// vienen de un clic de minimapa (`camera_input`): el detector por vídeo ve
    /// que la cámara saltó, no adónde.
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct ScriptOutput {
    #[serde(default)]
    duration: f64,
    #[serde(default)]
    snaps: Vec<Snap>,
    #[serde(default)]
    stills_written: u32,
    #[serde(default)]
    stills_skipped: u32,
    #[serde(default)]
    error: Option<String>,
}

/// Fichero que persiste el detalle por partida (el timeline solo necesita los
/// tiempos, pero el drill de lectura necesita saber qué imagen va con cada salto).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SnapReport {
    pub match_id: String,
    pub duration: f64,
    pub snaps: Vec<Snap>,
    pub stills_skipped: u32,
    /// Quién lo calculó: "input" (clics de minimapa) o el detector por vídeo.
    #[serde(default)]
    pub source: String,
    /// Versión del backfill por entrada que ya pasó por esta partida.
    ///
    /// 0 = ninguna (informe del detector por vídeo, o de la primera hornada).
    /// Es el marcador que hace que el barrido del arranque sea un no-op en el
    /// segundo lanzamiento: sin él había que abrir el metadata COMPLETO de cada
    /// partida —estela del ratón incluida, que es el campo grande— sólo para
    /// descubrir que no había nada que hacer.
    #[serde(default)]
    pub from_input_v: u32,
}

pub fn report_path(match_id: &str) -> PathBuf {
    get_match_dir(match_id).join("camera_snaps.json")
}

pub fn stills_dir(match_id: &str) -> PathBuf {
    get_match_dir(match_id).join("snaps")
}

pub fn load_report(match_id: &str) -> Option<SnapReport> {
    let content = std::fs::read_to_string(report_path(match_id)).ok()?;
    serde_json::from_str(&content).ok()
}

#[derive(Serialize)]
pub struct SnapAnalysisResult {
    pub success: bool,
    pub message: String,
    pub snaps: usize,
    pub stills: u32,
    /// Métricas derivadas, listas para pintar.
    pub per_minute: f64,
    pub longest_gap_secs: f64,
}

/// Analiza el vídeo de una partida y guarda tanto el informe detallado como los
/// tiempos en la metadata (para el timeline del reproductor).
#[tauri::command]
pub async fn analyze_camera_snaps(
    app: tauri::AppHandle,
    state: tauri::State<'_, AnalyzerState>,
    match_id: String,
) -> Result<SnapAnalysisResult, String> {
    // Compartimos el cerrojo con el analizador de VOD: los dos saturan la CPU y
    // lanzarlos a la vez solo consigue que ambos vayan lentos.
    if state.is_running.swap(true, Ordering::SeqCst) {
        return Ok(SnapAnalysisResult {
            success: false,
            message: "Another analysis is already running.".into(),
            snaps: 0,
            stills: 0,
            per_minute: 0.0,
            longest_gap_secs: 0.0,
        });
    }

    let finish = |state: &tauri::State<'_, AnalyzerState>| {
        state.is_running.store(false, Ordering::SeqCst);
        state.child_pid.store(0, Ordering::SeqCst);
    };

    let mut meta = match load_match_by_id(&match_id) {
        Some(m) => m,
        None => {
            finish(&state);
            return Err("Match not found.".into());
        }
    };
    if !std::path::Path::new(&meta.video_path).exists() {
        finish(&state);
        return Err(format!("Video file not found: {}", meta.video_path));
    }

    let script = match resolve_resource(&app, "python_scripts/camera_snaps.py") {
        Some(p) => p,
        None => {
            finish(&state);
            return Err("camera_snaps.py not found. Is python_scripts/ bundled?".into());
        }
    };
    let python_exe = python_command(&app);
    let out_dir = stills_dir(&match_id);

    let _ = app.emit("snaps_progress", "Scanning for camera cuts…");

    let mut child = match crate::proc::hide_console(
        Command::new(&python_exe)
            .env("PYTHONUNBUFFERED", "1")
            .arg(&script)
            .arg(&meta.video_path)
            .arg(out_dir.to_string_lossy().to_string()),
    )
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            finish(&state);
            return Err(format!("Failed to run Python ({}): {}", python_exe, e));
        }
    };

    state.child_pid.store(child.id(), Ordering::SeqCst);
    state.cancel_requested.store(false, Ordering::SeqCst);

    // Progreso por stderr, igual que el analizador de VOD.
    let stderr = child.stderr.take().unwrap();
    let app_clone = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(pct) = line.strip_prefix("PROGRESS:") {
                if let Ok(v) = pct.trim().parse::<f64>() {
                    let _ = app_clone.emit("snaps_progress_pct", v);
                }
            } else if !line.trim().is_empty() {
                let _ = app_clone.emit("snaps_progress", line);
            }
        }
    });

    let parsed = tokio::task::spawn_blocking(move || {
        let output = child
            .wait_with_output()
            .map_err(|e| format!("Error waiting for python: {}", e))?;
        if !output.status.success() {
            return Err("Camera-cut detection failed. Check the console for details.".to_string());
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        serde_json::from_str::<ScriptOutput>(&stdout).map_err(|e| {
            let preview: String = stdout.chars().take(200).collect();
            format!("Could not parse detector output: {}. Output: {}", e, preview)
        })
    })
    .await
    .unwrap();

    let parsed = match parsed {
        Ok(p) => p,
        Err(e) => {
            finish(&state);
            let cancelled = state.cancel_requested.swap(false, Ordering::SeqCst);
            return Err(if cancelled { "Analysis cancelled.".into() } else { e });
        }
    };
    if let Some(err) = parsed.error {
        finish(&state);
        return Err(err);
    }

    let duration = if parsed.duration > 0.0 {
        parsed.duration
    } else {
        meta.game_duration
    };

    // Al morir la cámara se va sola al cadáver y luego a la base: son saltos reales
    // pero no los has provocado tú, así que contarlos inflaría la métrica.
    let deaths: Vec<f64> = meta
        .events
        .iter()
        .filter(|e| e.r#type == "ChampionKill" && e.subtype.as_deref() == Some("death"))
        .map(|e| e.time)
        .collect();
    let snaps: Vec<Snap> = parsed
        .snaps
        .into_iter()
        .filter(|s| !deaths.iter().any(|d| (s.t - d).abs() <= DEATH_WINDOW_SECS))
        .collect();

    let times: Vec<f64> = snaps.iter().map(|s| s.t).collect();
    let per_minute = if duration > 0.0 {
        times.len() as f64 / (duration / 60.0)
    } else {
        0.0
    };
    let longest_gap = longest_gap(&times, duration);

    let report = SnapReport {
        match_id: match_id.clone(),
        duration,
        snaps,
        stills_skipped: parsed.stills_skipped,
        source: "video".to_string(),
        // Este informe lo escribe el detector por VÍDEO: el barrido por entrada
        // (`camera_input`) no ha pasado por aquí y tiene que poder mejorarlo.
        from_input_v: 0,
    };
    if let Ok(json) = serde_json::to_string(&report) {
        let _ = std::fs::write(report_path(&match_id), json);
    }

    // El timeline solo necesita los tiempos: van en la metadata de la partida.
    meta.camera_snaps = times.clone();
    let _ = save_match_metadata(&meta);

    finish(&state);
    let _ = app.emit("snaps_progress", "Done.");

    Ok(SnapAnalysisResult {
        success: true,
        message: format!("{} camera repositions detected.", times.len()),
        snaps: times.len(),
        stills: parsed.stills_written,
        per_minute,
        longest_gap_secs: longest_gap,
    })
}

/// Mayor intervalo sin ningún salto, contando el tramo inicial y el final.
fn longest_gap(times: &[f64], duration: f64) -> f64 {
    let mut sorted = times.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut longest = 0.0_f64;
    let mut prev = 0.0_f64;
    for t in &sorted {
        longest = longest.max(t - prev);
        prev = *t;
    }
    if duration > prev {
        longest = longest.max(duration - prev);
    }
    longest
}

/// Un fotograma disponible para el drill de lectura rápida.
#[derive(Serialize, Clone)]
pub struct RecallFrame {
    pub match_id: String,
    pub t: f64,
    /// Ruta absoluta del JPEG (el frontend la sirve por el protocolo `stream`).
    pub path: String,
}

/// Reúne todos los fotogramas extraídos de todas las partidas ya analizadas.
#[tauri::command]
pub async fn list_recall_frames() -> Vec<RecallFrame> {
    let mut out = Vec::new();
    for m in crate::storage::load_all_matches() {
        let Some(report) = load_report(&m.id) else {
            continue;
        };
        let dir = stills_dir(&m.id);
        for snap in &report.snaps {
            let Some(name) = &snap.still else { continue };
            let p = dir.join(name);
            if p.exists() {
                out.push(RecallFrame {
                    match_id: m.id.clone(),
                    t: snap.t,
                    path: p.to_string_lossy().to_string(),
                });
            }
        }
    }
    out
}

/// Métricas de cámara ya calculadas de una partida, si se analizó.
#[derive(Serialize)]
pub struct SnapSummary {
    pub match_id: String,
    pub analyzed: bool,
    pub snaps: usize,
    pub per_minute: f64,
    pub longest_gap_secs: f64,
    pub stills: usize,
}

/// Cuánto miraste cada carril y cuánto tiempo lo tuviste desatendido.
#[derive(Serialize)]
pub struct ZoneStat {
    /// "top", "mid" o "bot".
    pub key: String,
    pub looks: usize,
    pub per_minute: f64,
    /// El rato más largo sin mirar ESE carril, en segundos.
    pub longest_gap_secs: f64,
}

/// Una mirada con su carril, para pintarlas en la línea de tiempo.
#[derive(Serialize)]
pub struct CameraLook {
    /// Segundos de vídeo.
    pub t: f64,
    /// "top", "mid", "bot" — o `None` si miraste lejos de los tres (jungla
    /// profunda, base) o si la mirada no sabe adónde (tecla de cámara, VOD).
    pub lane: Option<String>,
}

/// Tus miradas en orden, cada una con el carril al que fue.
#[tauri::command]
pub async fn get_camera_looks(match_id: String) -> Vec<CameraLook> {
    let Some(r) = load_report(&match_id) else {
        return Vec::new();
    };
    r.snaps
        .iter()
        .map(|s| CameraLook {
            t: s.t,
            lane: match (s.x, s.y) {
                (Some(x), Some(y)) => {
                    crate::gank::Lane::nearest_within(x, y, crate::camera_input::RADIO_CARRIL)
                        .map(|l| l.key().to_string())
                }
                _ => None,
            },
        })
        .collect()
}

/// Reparto de tus miradas por carril.
///
/// Sale de la posición del clic, así que sólo hay datos en las partidas grabadas
/// aquí; un VOD importado tiene saltos de cámara pero no sabe adónde miraste.
/// Devuelve vacío en ese caso, en vez de inventarse un reparto.
#[tauri::command]
pub async fn get_camera_zones(match_id: String) -> Vec<ZoneStat> {
    match load_report(&match_id) {
        Some(r) => zonas_de(&r),
        None => Vec::new(),
    }
}

fn zonas_de(r: &SnapReport) -> Vec<ZoneStat> {
    let con_sitio: Vec<&Snap> = r.snaps.iter().filter(|s| s.x.is_some()).collect();
    if con_sitio.is_empty() {
        return Vec::new();
    }
    crate::gank::Lane::ALL
        .into_iter()
        .map(|lane| {
            let times: Vec<f64> = con_sitio
                .iter()
                .filter(|s| {
                    crate::gank::Lane::nearest_within(
                        s.x.unwrap_or(f64::NAN),
                        s.y.unwrap_or(f64::NAN),
                        crate::camera_input::RADIO_CARRIL,
                    ) == Some(lane)
                })
                .map(|s| s.t)
                .collect();
            ZoneStat {
                key: lane.key().to_string(),
                looks: times.len(),
                per_minute: if r.duration > 0.0 {
                    times.len() as f64 / (r.duration / 60.0)
                } else {
                    0.0
                },
                longest_gap_secs: longest_gap(&times, r.duration),
            }
        })
        .collect()
}

/// El carril que peor miras, mirando TODA la biblioteca.
///
/// Una partida suelta no dice nada: cualquiera puede desatender un carril media
/// partida y que sea la excepción. Lo que se puede llevar a la siguiente partida
/// es "esto te pasa siempre", y para eso hace falta contar en cuántas partidas
/// ese carril fue el peor.
#[derive(Serialize)]
pub struct BlindSpot {
    pub lane: String,
    /// Partidas con datos de miradas.
    pub games: usize,
    /// En cuántas de ellas ESE carril fue el más desatendido.
    pub games_worst: usize,
    /// Media de su hueco más largo, en segundos.
    pub avg_gap_secs: f64,
    /// El peor hueco que ha tenido, y en qué partida.
    pub worst_gap_secs: f64,
    pub worst_match_id: String,
}

/// El hueco ciego por carril de UNA partida, para pintar la tendencia.
#[derive(Serialize)]
pub struct ZoneHistoryRow {
    pub match_id: String,
    pub date: String,
    /// Hueco más largo sin mirar cada carril, en segundos: [top, mid, bot].
    pub gaps: [f64; 3],
    pub looks: [usize; 3],
}

/// Una fila por partida con miradas, de la más antigua a la más nueva.
///
/// `get_blind_spot` responde "¿cuál es mi punto ciego?"; esto responde la
/// pregunta que le sigue: "¿está mejorando?". La foto agregada no distingue
/// mejorar de empeorar.
#[tauri::command]
pub async fn get_camera_zone_history() -> Vec<ZoneHistoryRow> {
    let mut out: Vec<ZoneHistoryRow> = Vec::new();
    for m in crate::storage::load_all_matches() {
        if m.is_vod {
            continue;
        }
        let Some(r) = load_report(&m.id) else { continue };
        let zonas = zonas_de(&r);
        if zonas.is_empty() {
            continue;
        }
        let mut gaps = [0.0; 3];
        let mut looks = [0; 3];
        for z in &zonas {
            let i = match z.key.as_str() {
                "top" => 0,
                "mid" => 1,
                _ => 2,
            };
            gaps[i] = z.longest_gap_secs;
            looks[i] = z.looks;
        }
        out.push(ZoneHistoryRow { match_id: m.id, date: m.date, gaps, looks });
    }
    out.sort_by(|a, b| a.date.cmp(&b.date));
    out
}

#[tauri::command]
pub async fn get_blind_spot() -> Option<BlindSpot> {
    let mut peor_por_partida: Vec<(String, String, f64)> = Vec::new(); // (partida, carril, hueco)
    let mut huecos: std::collections::HashMap<String, Vec<f64>> = Default::default();
    let mut partidas = 0usize;

    for m in crate::storage::load_all_matches() {
        if m.is_vod {
            continue;
        }
        let Some(r) = load_report(&m.id) else { continue };
        let zonas = zonas_de(&r);
        if zonas.is_empty() {
            continue;
        }
        partidas += 1;
        for z in &zonas {
            huecos.entry(z.key.clone()).or_default().push(z.longest_gap_secs);
        }
        if let Some(peor) = zonas
            .iter()
            .max_by(|a, b| a.longest_gap_secs.total_cmp(&b.longest_gap_secs))
        {
            peor_por_partida.push((m.id.clone(), peor.key.clone(), peor.longest_gap_secs));
        }
    }
    if partidas == 0 {
        return None;
    }

    // El carril que más veces fue el peor. En empate, el de más hueco medio.
    let medio = |k: &str| {
        let v = huecos.get(k).cloned().unwrap_or_default();
        if v.is_empty() { 0.0 } else { v.iter().sum::<f64>() / v.len() as f64 }
    };
    let carril = crate::gank::Lane::ALL
        .into_iter()
        .map(|l| l.key().to_string())
        .max_by(|a, b| {
            let veces = |k: &String| peor_por_partida.iter().filter(|(_, c, _)| c == k).count();
            veces(a)
                .cmp(&veces(b))
                .then_with(|| medio(a).total_cmp(&medio(b)))
        })?;

    let (peor_id, peor_hueco) = peor_por_partida
        .iter()
        .filter(|(_, c, _)| *c == carril)
        .max_by(|a, b| a.2.total_cmp(&b.2))
        .map(|(id, _, g)| (id.clone(), *g))
        .unwrap_or_default();

    Some(BlindSpot {
        games_worst: peor_por_partida.iter().filter(|(_, c, _)| *c == carril).count(),
        avg_gap_secs: medio(&carril),
        worst_gap_secs: peor_hueco,
        worst_match_id: peor_id,
        lane: carril,
        games: partidas,
    })
}

#[tauri::command]
pub async fn get_camera_snap_summary(match_id: String) -> SnapSummary {
    match load_report(&match_id) {
        Some(r) => {
            let times: Vec<f64> = r.snaps.iter().map(|s| s.t).collect();
            SnapSummary {
                per_minute: if r.duration > 0.0 {
                    times.len() as f64 / (r.duration / 60.0)
                } else {
                    0.0
                },
                longest_gap_secs: longest_gap(&times, r.duration),
                snaps: times.len(),
                stills: r.snaps.iter().filter(|s| s.still.is_some()).count(),
                analyzed: true,
                match_id,
            }
        }
        None => SnapSummary {
            match_id,
            analyzed: false,
            snaps: 0,
            per_minute: 0.0,
            longest_gap_secs: 0.0,
            stills: 0,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hueco_incluye_el_tramo_final() {
        assert_eq!(longest_gap(&[60.0, 90.0], 300.0), 210.0);
        assert_eq!(longest_gap(&[], 300.0), 300.0);
        // El tramo inicial también cuenta.
        assert_eq!(longest_gap(&[200.0, 210.0], 220.0), 200.0);
    }

    #[test]
    fn hueco_ordena_los_tiempos() {
        // Aunque lleguen desordenados, el resultado es el mismo.
        assert_eq!(longest_gap(&[90.0, 60.0], 300.0), 210.0);
    }
}
