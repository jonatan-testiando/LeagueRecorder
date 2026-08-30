//! Miradas fuera de tu campeón, leídas de lo que hiciste con las manos.
//!
//! Mirar el mapa no hay que deducirlo del vídeo: **el gesto ya está grabado**.
//! Se hace de dos maneras y la app registra las dos desde hace tiempo sin
//! usarlas para esto:
//!
//! - **Clic izquierdo en el minimapa**: mueve la cámara allí. Está en
//!   `mouse_events`, con su instante y su posición.
//! - **Teclas de cámara aliada** (F1-F5 por defecto): las recoge el monitor en
//!   `CameraPress`.
//!
//! Frente al detector por vídeo (`camera_snaps.rs`, correlación de fase) esto es
//! instantáneo, exacto y **retroactivo**: la estela del ratón lleva guardándose
//! desde siempre, así que las partidas viejas también se pueden rellenar. El
//! detector por vídeo se queda para los VODs importados, que es donde no hay
//! registro de entrada y sí hay que estimar.
//!
//! Medido sobre partidas reales del usuario: entre 266 y 473 clics de minimapa
//! por partida (unos 15 por minuto) frente a 0 ó 1 saltos que había encontrado
//! el detector por vídeo.

use crate::storage::{MatchMetadata, MouseEventData};

/// El minimapa, en fracciones de la pantalla: (x0, x1, y0, y1).
///
/// Son las mismas que usa `python_scripts/minimap_positions.py` para recortar el
/// minimapa del vídeo, y valen igual aquí porque la interfaz de League se ancla
/// a la esquina y escala con la resolución.
///
/// Comprobado contra los clics de una partida real: **365 clics dentro y 0 en la
/// franja de 120 px pegada al borde izquierdo del rectángulo**. Un borde así de
/// limpio dice que la geometría es la buena.
///
/// Ojo: asume el minimapa en su sitio y a escala normal, y la partida a pantalla
/// completa (las coordenadas del ratón son de ESCRITORIO). Con la interfaz
/// reescalada el rectángulo se queda corto; se notaría como clics de menos, no
/// como clics inventados, porque el minimapa sólo puede crecer hacia dentro.
const MINIMAPA: (f64, f64, f64, f64) = (0.787, 0.995, 0.622, 0.972);

/// Dos gestos más juntos que esto son la misma mirada.
///
/// Un clic de minimapa suele venir acompañado de un segundo clic de ajuste, y
/// contarlos por separado inflaría la cifra de "cuánto miras" justo en quien más
/// mira.
const MISMA_MIRADA: f64 = 0.35;

/// ¿Cae el clic dentro del minimapa?
fn en_minimapa(e: &MouseEventData, w: f64, h: f64) -> bool {
    let (fx0, fx1, fy0, fy1) = MINIMAPA;
    e.x >= fx0 * w && e.x <= fx1 * w && e.y >= fy0 * h && e.y <= fy1 * h
}

/// Instantes (en tiempo de VÍDEO) en que miraste a otra parte del mapa.
///
/// `teclas` son las pulsaciones de cámara aliada, ya en tiempo de vídeo. El
/// botón derecho NO cuenta: sobre el minimapa es una orden de movimiento, no una
/// mirada — en la partida medida eran 380 clics derechos dentro del rectángulo
/// que no había que contar.
pub fn snaps_from_input(m: &MatchMetadata, teclas: &[f64]) -> Vec<f64> {
    let (w, h) = (m.mouse_space_w as f64, m.mouse_space_h as f64);
    let mut t: Vec<f64> = teclas.to_vec();
    if w > 0.0 && h > 0.0 {
        t.extend(
            m.mouse_events
                .iter()
                .filter(|e| e.evt == "left_click" && en_minimapa(e, w, h))
                .map(|e| e.t),
        );
    }
    t.retain(|x| x.is_finite() && *x >= 0.0);
    t.sort_by(f64::total_cmp);
    t.dedup_by(|a, b| *a - *b < MISMA_MIRADA);
    t
}

/// Cuánto dura la partida a efectos de este informe: lo que diga el reloj de
/// juego más la pantalla de carga, o lo que se llegó a grabar si fue más.
fn duracion(m: &MatchMetadata) -> f64 {
    let por_reloj = m.game_duration + m.video_offset.unwrap_or(0.0);
    let por_estela = m.mouse_events.last().map(|e| e.t).unwrap_or(0.0);
    por_reloj.max(por_estela).max(1.0)
}

/// Escribe el informe de saltos de cámara a partir de la entrada, en el mismo
/// formato que deja el detector por vídeo.
///
/// Compartir formato no es pereza: así el resumen (`get_camera_snap_summary`),
/// la tira de la línea de tiempo y el entrenamiento siguen leyendo de un único
/// sitio, sin enterarse de quién lo calculó.
pub fn write_report(m: &MatchMetadata, snaps: &[f64]) {
    let informe = serde_json::json!({
        "match_id": m.id,
        "duration": duracion(m),
        "source": "input",
        "snaps": snaps.iter().map(|t| serde_json::json!({ "t": t })).collect::<Vec<_>>(),
        "stills_skipped": 0,
    });
    if let Ok(txt) = serde_json::to_string(&informe) {
        let _ = std::fs::write(crate::camera_snaps::report_path(&m.id), txt);
    }
}

/// Rellena los saltos de cámara de las partidas grabadas antes de que esto
/// existiera. Sólo lee lo que ya hay en disco.
///
/// No toca los VODs importados (no tienen estela: ahí manda el detector por
/// vídeo) ni las partidas cuyo informe ya existe.
pub fn spawn_backfill() {
    std::thread::spawn(|| {
        let mut hechas = 0;
        for m in crate::storage::load_all_matches() {
            if m.is_vod || crate::camera_snaps::report_path(&m.id).exists() {
                continue;
            }
            // `load_all_matches` no trae la estela: hay que leer la partida entera.
            let Ok(full) = crate::storage::get_match_metadata(&m.id) else {
                continue;
            };
            if full.mouse_events.is_empty() {
                continue;
            }
            let snaps = snaps_from_input(&full, &full.camera_snaps);
            if snaps.is_empty() {
                continue;
            }
            write_report(&full, &snaps);
            let mut meta = full;
            meta.camera_snaps = snaps;
            let _ = crate::storage::save_match_metadata(&meta);
            hechas += 1;
        }
        if hechas > 0 {
            log::info!("cámara: miradas calculadas de la entrada en {hechas} partidas");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(eventos: Vec<MouseEventData>) -> MatchMetadata {
        MatchMetadata {
            id: "m".into(),
            game_duration: 1800.0,
            mouse_space_w: 2560,
            mouse_space_h: 1440,
            mouse_events: eventos,
            ..Default::default()
        }
    }

    fn clic(t: f64, x: f64, y: f64, evt: &str) -> MouseEventData {
        MouseEventData { t, x, y, evt: evt.to_string() }
    }

    /// El rectángulo real en 2560x1440 es x 2014..2547, y 895..1399.
    #[test]
    fn solo_cuenta_el_clic_izquierdo_dentro_del_minimapa() {
        let m = meta(vec![
            clic(10.0, 2200.0, 1100.0, "left_click"),  // dentro
            clic(20.0, 1200.0, 700.0, "left_click"),   // en medio de la pantalla
            clic(30.0, 2200.0, 1100.0, "right_click"), // orden de movimiento, no mirada
            clic(40.0, 2200.0, 1100.0, "move"),        // sólo pasar por encima
            clic(50.0, 2000.0, 1100.0, "left_click"),  // 14 px a la izquierda del borde
        ]);
        assert_eq!(snaps_from_input(&m, &[]), vec![10.0]);
    }

    /// Dos clics seguidos son un vistazo con corrección, no dos miradas.
    #[test]
    fn los_clics_pegados_cuentan_una_vez() {
        let m = meta(vec![
            clic(10.0, 2200.0, 1100.0, "left_click"),
            clic(10.2, 2300.0, 1200.0, "left_click"),
            clic(10.9, 2300.0, 1200.0, "left_click"),
        ]);
        assert_eq!(snaps_from_input(&m, &[]), vec![10.0, 10.9]);
    }

    /// Las teclas de cámara aliada cuentan igual, y se mezclan en orden.
    #[test]
    fn las_teclas_se_mezclan_con_los_clics() {
        let m = meta(vec![
            clic(30.0, 2200.0, 1100.0, "left_click"),
            clic(10.0, 2200.0, 1100.0, "left_click"),
        ]);
        assert_eq!(snaps_from_input(&m, &[20.0, 5.0]), vec![5.0, 10.0, 20.0, 30.0]);
    }

    /// Sin resolución de escritorio no se puede situar el minimapa; entonces se
    /// devuelven sólo las teclas en vez de inventarse un rectángulo.
    #[test]
    fn sin_resolucion_no_se_adivina() {
        let mut m = meta(vec![clic(10.0, 2200.0, 1100.0, "left_click")]);
        m.mouse_space_w = 0;
        m.mouse_space_h = 0;
        assert_eq!(snaps_from_input(&m, &[7.0]), vec![7.0]);
    }
}
