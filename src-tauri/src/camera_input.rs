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
/// Ojo: asume el minimapa en su sitio y la partida a pantalla completa (las
/// coordenadas del ratón son de ESCRITORIO). Esta es la geometría a escala
/// ESTÁNDAR (factor 1.0); con la interfaz de League reescalada, el rectángulo
/// real se obtiene con `minimapa_rect`, que lo escala desde su ancla.
const MINIMAPA: (f64, f64, f64, f64) = (0.787, 0.995, 0.622, 0.972);

/// El rectángulo del minimapa para una escala dada (config `minimap_scale`).
///
/// El minimapa se ancla a la esquina inferior derecha y crece HACIA DENTRO, así
/// que la esquina (x1, y1) es fija y son x0/y0 los que se mueven con la escala.
/// Se acota a [0.5, 2.0]: fuera de ahí no hay ajuste de League que lo produzca
/// y un valor corrupto en la config inventaría un rectángulo absurdo.
pub fn minimapa_rect(escala: f64) -> (f64, f64, f64, f64) {
    let s = if escala.is_finite() { escala.clamp(0.5, 2.0) } else { 1.0 };
    let (bx0, bx1, by0, by1) = MINIMAPA;
    (bx1 - (bx1 - bx0) * s, bx1, by1 - (by1 - by0) * s, by1)
}

/// Lado del mapa, en unidades de juego. La misma escala que usa el detector de
/// minimapa.
const MAPA: f64 = 14870.0;

/// Hasta dónde llega "mirar un carril".
///
/// Medido sobre 4.715 clics reales: la mediana cae a 715 unidades del eje del
/// carril más cercano y el percentil 90 a 2.401. Con 2.500 entra el 91% — el
/// carril y la jungla pegada a él. Lo que queda fuera es jungla profunda y base,
/// que no habla de ningún carril y no debe contar como si lo hiciera.
pub const RADIO_CARRIL: f64 = 2500.0;

/// Dos gestos más juntos que esto son la misma mirada.
///
/// Un clic de minimapa suele venir acompañado de un segundo clic de ajuste, y
/// contarlos por separado inflaría la cifra de "cuánto miras" justo en quien más
/// mira.
const MISMA_MIRADA: f64 = 0.35;

/// ¿Cae el clic dentro del minimapa?
fn en_minimapa(e: &MouseEventData, w: f64, h: f64, rect: (f64, f64, f64, f64)) -> bool {
    let (fx0, fx1, fy0, fy1) = rect;
    e.x >= fx0 * w && e.x <= fx1 * w && e.y >= fy0 * h && e.y <= fy1 * h
}

/// Una mirada: cuándo, y adónde si se sabe.
#[derive(Debug, Clone, Copy)]
pub struct Look {
    /// Segundos de VÍDEO.
    pub t: f64,
    /// Punto del mapa (0..14870). `None` en las teclas de cámara aliada: mueven
    /// la cámara a un compañero, y dónde estaba ese compañero no lo sabe el
    /// teclado.
    pub pos: Option<(f64, f64)>,
}

/// Dónde cae un clic de minimapa, en coordenadas de mapa.
///
/// El eje Y del juego crece hacia arriba y el de la pantalla hacia abajo, de ahí
/// el `1 -`. Es la misma conversión que hace `minimap_positions.py` con los
/// iconos que detecta en el vídeo.
fn punto_del_mapa(e: &MouseEventData, w: f64, h: f64, rect: (f64, f64, f64, f64)) -> (f64, f64) {
    let (fx0, fx1, fy0, fy1) = rect;
    let fx = (e.x - fx0 * w) / ((fx1 - fx0) * w);
    let fy = (e.y - fy0 * h) / ((fy1 - fy0) * h);
    (fx * MAPA, (1.0 - fy) * MAPA)
}

/// Las miradas de una partida, en orden y sin repetir.
///
/// `teclas` son las pulsaciones de cámara aliada, ya en tiempo de vídeo. El
/// botón derecho NO cuenta: sobre el minimapa es una orden de movimiento, no una
/// mirada — en la partida medida eran 380 clics derechos dentro del rectángulo
/// que no había que contar.
pub fn looks_from_input(m: &MatchMetadata, teclas: &[f64], escala: f64) -> Vec<Look> {
    let (w, h) = (m.mouse_space_w as f64, m.mouse_space_h as f64);
    let rect = minimapa_rect(escala);
    let mut v: Vec<Look> = teclas.iter().map(|t| Look { t: *t, pos: None }).collect();
    if w > 0.0 && h > 0.0 {
        v.extend(
            m.mouse_events
                .iter()
                .filter(|e| e.evt == "left_click" && en_minimapa(e, w, h, rect))
                .map(|e| Look { t: e.t, pos: Some(punto_del_mapa(e, w, h, rect)) }),
        );
    }
    v.retain(|l| l.t.is_finite() && l.t >= 0.0);
    v.sort_by(|a, b| a.t.total_cmp(&b.t));
    // Al fusionar dos gestos pegados se conserva el primero, que es la mirada; el
    // segundo suele ser el ajuste.
    v.dedup_by(|a, b| a.t - b.t < MISMA_MIRADA);
    v
}

/// Sólo los instantes, para quien no necesita saber adónde. Hoy la usan los
/// tests, que es donde se comprueba el filtrado sin ruido de coordenadas.
#[cfg(test)]
pub fn snaps_from_input(m: &MatchMetadata, teclas: &[f64]) -> Vec<f64> {
    looks_from_input(m, teclas, 1.0).into_iter().map(|l| l.t).collect()
}

/// Carril al que va un clic de minimapa, o `None` si el clic no está en el
/// minimapa o cae lejos de los tres carriles.
///
/// Lo usa el metrónomo en vivo, que trabaja con clics sueltos según llegan y no
/// tiene todavía metadata de la partida donde mirar la resolución.
pub fn lane_of_click(x: f64, y: f64, w: f64, h: f64, escala: f64) -> Option<&'static str> {
    let e = MouseEventData { t: 0.0, x, y, evt: String::new() };
    let rect = minimapa_rect(escala);
    if w <= 0.0 || h <= 0.0 || !en_minimapa(&e, w, h, rect) {
        return None;
    }
    let (mx, my) = punto_del_mapa(&e, w, h, rect);
    crate::gank::Lane::nearest_within(mx, my, RADIO_CARRIL).map(|l| l.key())
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
pub fn write_report(m: &MatchMetadata, looks: &[Look]) {
    let informe = serde_json::json!({
        "match_id": m.id,
        "duration": duracion(m),
        "source": "input",
        "from_input_v": BACKFILL_V,
        "snaps": looks
            .iter()
            .map(|l| match l.pos {
                Some((x, y)) => serde_json::json!({ "t": l.t, "x": x, "y": y }),
                None => serde_json::json!({ "t": l.t }),
            })
            .collect::<Vec<_>>(),
        "stills_skipped": 0,
    });
    if let Ok(txt) = serde_json::to_string(&informe) {
        let _ = std::fs::write(crate::camera_snaps::report_path(&m.id), txt);
    }
}

/// Regenera las miradas de TODA la biblioteca con una escala nueva.
///
/// Se lanza al cambiar `minimap_scale` en Ajustes: los informes ya escritos se
/// calcularon con el rectángulo viejo, y sin esto la calibración solo aplicaba
/// a partidas nuevas. Solo partidas propias con estela (los VODs van por el
/// detector de vídeo, que no depende de esta geometría de escritorio).
///
/// Las teclas de cámara van vacías a propósito: `camera_snaps` ya es la lista
/// fusionada de pasadas anteriores, y reinyectarla fundiría cada clic con su
/// propio duplicado sin posición (el mismo gotcha del backfill). Las teclas
/// reales eran 0-1 por partida: pérdida asumida y documentada.
pub fn spawn_regenerate_all(escala: f64) {
    std::thread::spawn(move || {
        let mut hechas = 0;
        for m in crate::storage::load_all_matches() {
            if m.is_vod {
                continue;
            }
            let Ok(full) = crate::storage::get_match_metadata(&m.id) else {
                continue;
            };
            if full.mouse_events.is_empty() {
                continue;
            }
            let looks = looks_from_input(&full, &[], escala);
            write_report(&full, &looks);
            let nuevos: Vec<f64> = looks.iter().map(|l| l.t).collect();
            // El informe sí cambia (las posiciones son otras), pero los tiempos
            // suelen ser los mismos: no hay por qué reescribir megas de
            // metadata para dejarlos igual.
            if full.camera_snaps != nuevos {
                let mut meta = full;
                meta.camera_snaps = nuevos;
                let _ = crate::storage::save_match_metadata(&meta);
            }
            hechas += 1;
        }
        log::info!("cámara: miradas regeneradas con escala {escala:.2} en {hechas} partidas");
    });
}

/// Versión del barrido de miradas por entrada.
///
/// Se estampa en el informe (`SnapReport::from_input_v`) para saber que esa
/// partida ya pasó por aquí. Subirlo obliga a rehacer toda la biblioteca, que
/// es lo que hay que hacer si cambia el criterio de qué es una mirada.
pub const BACKFILL_V: u32 = 1;

/// Rellena los saltos de cámara de las partidas grabadas antes de que esto
/// existiera. Sólo lee lo que ya hay en disco.
///
/// No toca los VODs importados (no tienen estela: ahí manda el detector por
/// vídeo) ni las partidas que ya pasaron por este barrido.
///
/// **Va dentro de la tarea única de mantenimiento** (`lib.rs`), en serie con la
/// migración y el backfill de impacto: los tres recorrían la biblioteca entera
/// a la vez nada más arrancar, y éste además reescribía el metadata de cada
/// partida —con la estela dentro— hubiera cambiado algo o no.
pub async fn backfill(app: &tauri::AppHandle) {
    let escala = crate::storage::load_config().minimap_scale;

    // Primera pasada, sólo con metadata ligera (sin estela) y el informe: deja
    // la lista de las que de verdad hay que abrir enteras.
    let pendientes: Vec<crate::storage::MatchMetadata> = crate::storage::load_all_matches()
        .into_iter()
        .filter(|m| !m.is_vod)
        .filter(|m| {
            crate::camera_snaps::load_report(&m.id)
                .map(|r| r.from_input_v < BACKFILL_V)
                .unwrap_or(true)
        })
        .collect();

    let total = pendientes.len();
    crate::commands::emit_maintenance(app, "camera", 0, total);
    let mut hechas = 0;
    for (i, m) in pendientes.into_iter().enumerate() {
        procesar_una(&m.id, escala);
        hechas += 1;
        crate::commands::emit_maintenance(app, "camera", i + 1, total);
        // Prioridad baja a propósito: esto corre mientras el usuario abre la
        // app, y la app tiene que responder. Ceder entre partidas cuesta
        // milisegundos y evita comerse un núcleo durante el arranque.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    if hechas > 0 {
        log::info!("cámara: miradas calculadas de la entrada en {hechas} partidas");
    }
}

/// Una partida: calcula sus miradas y deja el informe marcado, haya salido algo
/// o no. Marcar siempre es lo que hace que el segundo arranque no lea nada.
fn procesar_una(id: &str, escala: f64) {
    let previo = crate::camera_snaps::load_report(id);
    // Un informe SIN posiciones es de la primera hornada (cuando las miradas
    // aún no llevaban x/y) o del detector por vídeo, y se regenera: saltarlo
    // dejaba "Dónde miraste" y la tendencia de Patrones vacíos para siempre.
    let sin_posiciones = previo
        .as_ref()
        .map(|r| !r.snaps.iter().any(|s| s.x.is_some()))
        .unwrap_or(false);

    // `load_all_matches` no trae la estela: hay que leer la partida entera.
    let Ok(full) = crate::storage::get_match_metadata(id) else {
        return;
    };

    // OJO al regenerar: `camera_snaps` ya es la lista FUSIONADA de la hornada
    // anterior. Pasarla como "teclas" haría que cada clic se fundiera con su
    // propio duplicado sin posición y las perdiera todas otra vez. Las teclas
    // reales eran 0-1 por partida.
    let teclas: &[f64] = if sin_posiciones { &[] } else { &full.camera_snaps };
    let looks = looks_from_input(&full, teclas, escala);

    if looks.is_empty() {
        marcar_visto(id, previo);
        return;
    }

    write_report(&full, &looks);
    let nuevos: Vec<f64> = looks.iter().map(|l| l.t).collect();
    // Nunca reescribir un fichero cuyo contenido no ha cambiado: el metadata de
    // una partida son megas (la estela), y esto corría en cada arranque.
    if full.camera_snaps != nuevos {
        let mut meta = full;
        meta.camera_snaps = nuevos;
        let _ = crate::storage::save_match_metadata(&meta);
    }
}

/// Deja constancia de que el barrido ya miró esta partida y no había nada.
///
/// Sin esto, una partida sin estela (grabada antes de que se registrara, o con
/// la resolución del ratón sin medir) se volvía a abrir ENTERA en cada arranque
/// para descubrir otra vez que no había nada. Si ya había informe se conserva
/// tal cual y sólo se le pone el sello; si no, se escribe uno vacío.
fn marcar_visto(id: &str, previo: Option<crate::camera_snaps::SnapReport>) {
    let mut r = previo.unwrap_or_else(|| crate::camera_snaps::SnapReport {
        match_id: id.to_string(),
        ..Default::default()
    });
    r.from_input_v = BACKFILL_V;
    if let Ok(txt) = serde_json::to_string(&r) {
        let _ = std::fs::write(crate::camera_snaps::report_path(id), txt);
    }
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

    /// La esquina inferior izquierda del minimapa es la base azul (0,0) y la
    /// superior derecha la roja: si esto se invierte, "miraste a bot" señala a
    /// top y la métrica dice lo contrario de lo que pasó.
    #[test]
    fn el_clic_se_convierte_a_coordenadas_de_mapa() {
        let m = meta(vec![
            // Las esquinas justo por dentro: el borde real en 2560x1440 cae en
            // x 2014,7..2547,2 e y 895,7..1399,7.
            clic(1.0, 2015.0, 1399.0, "left_click"), // esquina inferior izquierda
            clic(9.0, 2547.0, 896.0, "left_click"),  // esquina superior derecha
        ]);
        let l = looks_from_input(&m, &[], 1.0);
        let (x0, y0) = l[0].pos.unwrap();
        let (x1, y1) = l[1].pos.unwrap();
        assert!(x0 < 60.0 && y0 < 60.0, "abajo-izquierda dio ({x0:.0}, {y0:.0})");
        assert!(x1 > 14800.0 && y1 > 14800.0, "arriba-derecha dio ({x1:.0}, {y1:.0})");
    }

    /// Un clic en el carril de abajo tiene que caer en `bot`, y uno en tu base
    /// en ningún carril.
    #[test]
    fn cada_clic_cae_en_su_carril() {
        use crate::gank::Lane;
        assert_eq!(Lane::nearest_within(6919.0, 1483.0, RADIO_CARRIL), Some(Lane::Bot));
        assert_eq!(Lane::nearest_within(7450.0, 7450.0, RADIO_CARRIL), Some(Lane::Mid));
        assert_eq!(Lane::nearest_within(1512.0, 6699.0, RADIO_CARRIL), Some(Lane::Top));
        // Base azul: lejos de los tres ejes.
        assert_eq!(Lane::nearest_within(700.0, 700.0, RADIO_CARRIL), None);
    }

    /// Con el minimapa agrandado en League, el rectángulo estándar pierde los
    /// clics del borde interior; calibrar la escala los recupera, y la esquina
    /// anclada (abajo-derecha) no se mueve.
    #[test]
    fn la_escala_agranda_el_rectangulo_hacia_dentro() {
        // 14 px a la izquierda del borde estándar en 2560×1440: fuera a 1.0.
        let m = meta(vec![clic(10.0, 2000.0, 1100.0, "left_click")]);
        assert!(looks_from_input(&m, &[], 1.0).is_empty());
        assert_eq!(looks_from_input(&m, &[], 1.1).len(), 1);

        // El ancla no se mueve: la esquina inferior derecha sigue dentro con
        // cualquier escala, y un valor corrupto cae al rectángulo estándar.
        let (_, x1, _, y1) = minimapa_rect(0.7);
        assert_eq!((x1, y1), (0.995, 0.972));
        assert_eq!(minimapa_rect(f64::NAN), minimapa_rect(1.0));
        assert_eq!(minimapa_rect(99.0), minimapa_rect(2.0));
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
