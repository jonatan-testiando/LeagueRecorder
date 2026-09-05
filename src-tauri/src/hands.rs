//! La mano: geometría de tus clics de movimiento.
//!
//! Esquivar en LoL no es puntería, es **vector**. Un clic derecho manda a tu
//! campeón en la dirección que va del campeón al punto clicado, y el ángulo de
//! esa dirección es lo único que decide si sales de la línea del proyectil o te
//! la comes. La longitud del vector no cambia a dónde vas, pero sí **cuánto
//! cuesta apuntarlo**: con un temblor de mano de `e` píxeles, un clic a
//! distancia `r` del campeón se desvía `atan(e/r)`. A 400 px de radio un temblor
//! de 20 px son 3°; a 100 px son 11°. Clicar corto convierte cada esquiva en una
//! lotería de ángulo.
//!
//! Nada de esto hay que grabarlo: `mouse_events` lleva desde siempre cada clic
//! con su instante y su posición de ESCRITORIO, igual que las miradas de
//! [`crate::camera_input`]. Este módulo es retroactivo sobre todo el historial.
//!
//! **La suposición que hay que decir en voz alta**: el ancla es el centro de la
//! pantalla, que es donde está tu campeón con la cámara bloqueada. Con la cámara
//! suelta el ancla se va donde la hayas dejado y las distancias salen infladas.
//! Por eso el informe trae `anchor_conf`: si juegas desbloqueado, la nube de
//! clics deja de estar centrada y se nota.

use serde::Serialize;

use crate::camera_input::minimapa_rect;
use crate::storage::{MatchMetadata, MouseEventData};

/// Bajo este radio (en fracción de la ALTURA de pantalla) el clic es "corto".
///
/// Sale de la cuenta del encabezado: para que un temblor de 20 px cueste menos
/// de 5° de desvío hacen falta ~230 px, que a 1080p es 0,21 de la altura. Se
/// mide contra la altura y no contra el ancho para que el umbral signifique lo
/// mismo en 16:9 y en 21:9.
const RADIO_CORTO: f64 = 0.20;

/// El HUD ocupa la franja de abajo. Un clic ahí es tienda, objetos o
/// habilidades, nunca una orden de movimiento.
const HUD_TOP: f64 = 0.80;

/// Dos clics separados por menos de esto son el mismo gesto: el segundo corrige
/// al primero. La distancia entre ambos es la medida directa de tu temblor, y es
/// preferible a inventarse una constante de 20 px.
const CORRECCION_SECS: f64 = 0.15;

/// ...pero sólo si el segundo va en la MISMA dirección que el primero.
///
/// Medido sobre 23 partidas reales: sin este filtro salían "temblores" de 94 y
/// 167 px en las partidas de más giro, y con ellos costes angulares de 15° y
/// 24° que no eran temblor de mano sino kiting — dos órdenes distintas y
/// seguidas en direcciones opuestas. Refinar la misma orden y cambiar de idea
/// se parecen en el reloj y no se parecen en nada más.
const CORRECCION_GIRO: f64 = 20.0;

/// Más allá de este hueco, dos clics consecutivos no son un giro sino dos
/// decisiones distintas; medir el ángulo entre ellos no diría nada.
const GIRO_VENTANA_SECS: f64 = 2.0;

/// A partir de este giro el clic es reactivo: cambiaste de idea, no seguiste
/// andando. Es el subconjunto que de verdad contiene tus esquivas.
const GIRO_REACTIVO: f64 = 60.0;

/// Cuántos sectores angulares tiene la rosa. 16 = 22,5° cada uno, que es la
/// resolución a la que se distingue "diagonal" de "recto" sin que el histograma
/// se quede sin muestras por sector.
const SECTORES: usize = 16;

/// Un sector de la rosa de clics.
#[derive(Debug, Clone, Serialize)]
pub struct Sector {
    /// Ángulo central en grados, 0 = derecha, 90 = arriba.
    pub deg: f64,
    pub clicks: usize,
    /// Fracción del total, 0..1.
    pub share: f64,
    /// Distancia mediana al ancla de los clics de este sector, en píxeles.
    pub ring_px: f64,
}

/// Un escalón del histograma de distancia.
#[derive(Debug, Clone, Serialize)]
pub struct RingBin {
    /// Borde inferior en fracción de la altura de pantalla.
    pub from: f64,
    pub to: f64,
    pub clicks: usize,
    pub share: f64,
}

/// Los números de un grupo de clics (reactivos o de crucero).
#[derive(Debug, Clone, Serialize, Default)]
pub struct TurnGroup {
    pub clicks: usize,
    pub ring_px_p50: f64,
    /// El mismo radio en fracción de la altura, para comparar entre monitores.
    pub ring_pct_p50: f64,
}

/// Cómo es tu mano en esta partida.
#[derive(Debug, Clone, Serialize, Default)]
pub struct HandReport {
    /// Clics derechos válidos: los que son una orden en el mundo del juego.
    pub clicks: usize,
    /// Descartados por caer en el minimapa o en el HUD.
    pub discarded_ui: usize,
    /// Clics IZQUIERDOS en la zona de juego. No entran en el análisis (son
    /// habilidades y objetos), pero si eres de attack-move-click aquí se ve.
    pub left_in_play: usize,
    pub ring_px_p50: f64,
    pub ring_px_p90: f64,
    pub ring_pct_p50: f64,
    /// Fracción de clics por debajo de [`RADIO_CORTO`].
    pub short_ratio: f64,
    pub sectors: Vec<Sector>,
    pub rings: Vec<RingBin>,
    /// Mediana del giro entre clics consecutivos, en grados.
    pub turn_deg_p50: f64,
    /// Los clics que cambian de dirección: donde viven las esquivas.
    pub reactive: TurnGroup,
    /// Los que siguen la marcha.
    pub cruise: TurnGroup,
    /// Temblor medido: mediana de la separación entre los dos clics de un par de
    /// corrección. `None` si no hubo pares suficientes.
    pub correction_px_p50: Option<f64>,
    /// Fracción de clics que son la corrección de otro.
    pub correction_ratio: f64,
    /// Lo que ese temblor te cuesta en ángulo a tu radio mediano, en grados.
    pub angular_cost_deg: Option<f64>,
    /// Lo mismo pero en los clics reactivos, que es donde duele.
    pub angular_cost_reactive_deg: Option<f64>,
    /// Confianza en el ancla: 1 = la nube de clics está donde se espera con la
    /// cámara bloqueada; baja con la deriva HORIZONTAL. Ver [`analyze`].
    pub anchor_conf: f64,
    /// Deriva del centroide de clics respecto al centro, en píxeles. La
    /// vertical es esperable (el HUD tapa la franja de abajo); la horizontal no.
    pub anchor_dx_px: f64,
    pub anchor_dy_px: f64,
    pub screen_w: u32,
    pub screen_h: u32,
}

/// Percentil sobre una lista YA ordenada. Interpola entre vecinos.
fn pct(v: &[f64], p: f64) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    let idx = p * (v.len() - 1) as f64;
    let lo = idx.floor() as usize;
    let hi = idx.ceil() as usize;
    if lo == hi {
        return v[lo];
    }
    v[lo] + (v[hi] - v[lo]) * (idx - lo as f64)
}

/// Ángulo del vector campeón→clic en grados, 0 = derecha, 90 = arriba.
///
/// El eje Y de pantalla crece hacia abajo y el de la intuición hacia arriba, de
/// ahí el signo: sin él la rosa sale reflejada y "arriba a la derecha" se pinta
/// abajo.
fn angulo(dx: f64, dy: f64) -> f64 {
    let a = (-dy).atan2(dx).to_degrees();
    if a < 0.0 {
        a + 360.0
    } else {
        a
    }
}

/// Diferencia angular mínima entre dos rumbos, en [0, 180].
fn giro(a: f64, b: f64) -> f64 {
    let d = (a - b).abs() % 360.0;
    if d > 180.0 {
        360.0 - d
    } else {
        d
    }
}

/// ¿Está el clic en una parte de la pantalla donde una orden de movimiento tiene
/// sentido? Fuera quedan el minimapa y el HUD.
fn en_juego(e: &MouseEventData, w: f64, h: f64, minimapa: (f64, f64, f64, f64)) -> bool {
    if e.x < 0.0 || e.y < 0.0 || e.x > w || e.y > h {
        return false;
    }
    if e.y > HUD_TOP * h {
        return false;
    }
    let (fx0, fx1, fy0, fy1) = minimapa;
    let en_minimapa = e.x >= fx0 * w && e.x <= fx1 * w && e.y >= fy0 * h && e.y <= fy1 * h;
    !en_minimapa
}

/// Un clic ya reducido a lo que importa: cuándo, dónde, a qué distancia y en qué
/// rumbo.
struct Vec2 {
    t: f64,
    x: f64,
    y: f64,
    r: f64,
    deg: f64,
}

/// Los clics de orden de una partida, ya filtrados y en orden.
///
/// Lo usa también [`crate::spells`] para mirar qué hizo la mano en los segundos
/// previos a cada muerte, así que el filtrado vive aquí y no duplicado allí.
pub(crate) fn ordenes(m: &MatchMetadata, escala: f64) -> Vec<(f64, f64, f64, f64, f64)> {
    let (w, h) = (m.mouse_space_w as f64, m.mouse_space_h as f64);
    if w <= 0.0 || h <= 0.0 {
        return Vec::new();
    }
    let minimapa = minimapa_rect(escala);
    let (cx, cy) = (w / 2.0, h / 2.0);
    let mut v: Vec<(f64, f64, f64, f64, f64)> = m
        .mouse_events
        .iter()
        .filter(|e| e.evt == "right_click" && en_juego(e, w, h, minimapa))
        .map(|e| {
            let (dx, dy) = (e.x - cx, e.y - cy);
            (e.t, e.x, e.y, (dx * dx + dy * dy).sqrt(), angulo(dx, dy))
        })
        .collect();
    v.sort_by(|a, b| a.0.total_cmp(&b.0));
    v
}

/// El informe de la mano para una partida.
///
/// `escala` es `minimap_scale` de la config: el rectángulo del minimapa cambia
/// con ella y hay que descontarlo bien o los clics de mirada se cuelan como
/// órdenes de movimiento.
pub fn analyze(m: &MatchMetadata, escala: f64) -> HandReport {
    let (w, h) = (m.mouse_space_w as f64, m.mouse_space_h as f64);
    let mut r = HandReport {
        screen_w: m.mouse_space_w,
        screen_h: m.mouse_space_h,
        ..Default::default()
    };
    if w <= 0.0 || h <= 0.0 {
        return r;
    }
    let minimapa = minimapa_rect(escala);
    let (cx, cy) = (w / 2.0, h / 2.0);

    let mut v: Vec<Vec2> = Vec::new();
    for e in &m.mouse_events {
        match e.evt.as_str() {
            "right_click" => {
                if !en_juego(e, w, h, minimapa) {
                    r.discarded_ui += 1;
                    continue;
                }
                let (dx, dy) = (e.x - cx, e.y - cy);
                v.push(Vec2 {
                    t: e.t,
                    x: e.x,
                    y: e.y,
                    r: (dx * dx + dy * dy).sqrt(),
                    deg: angulo(dx, dy),
                });
            }
            "left_click" => {
                if en_juego(e, w, h, minimapa) {
                    r.left_in_play += 1;
                }
            }
            _ => {}
        }
    }
    v.sort_by(|a, b| a.t.total_cmp(&b.t));
    r.clicks = v.len();
    if v.is_empty() {
        return r;
    }

    // Confianza del ancla.
    //
    // La primera versión medía la deriva del centroide en los dos ejes y daba
    // 0,45 en partidas jugadas con la cámara bloqueada. El motivo salió al
    // separarlos: la deriva es VERTICAL y hacia arriba, porque el HUD tapa la
    // franja de abajo y ahí no se clica. Eso no es la cámara suelta, es la forma
    // de la pantalla, y castigarlo era avisar de un problema que no existía.
    // Sólo cuenta la horizontal, que es la que no tiene explicación inocente.
    let (sx, sy) = v.iter().fold((0.0, 0.0), |(ax, ay), c| (ax + c.x, ay + c.y));
    let (mx, my) = (sx / v.len() as f64, sy / v.len() as f64);
    r.anchor_dx_px = mx - cx;
    r.anchor_dy_px = my - cy;
    r.anchor_conf = (1.0 - (r.anchor_dx_px.abs() / h) * 4.0).clamp(0.0, 1.0);

    let mut radios: Vec<f64> = v.iter().map(|c| c.r).collect();
    radios.sort_by(f64::total_cmp);
    r.ring_px_p50 = pct(&radios, 0.5);
    r.ring_px_p90 = pct(&radios, 0.9);
    r.ring_pct_p50 = r.ring_px_p50 / h;
    r.short_ratio =
        radios.iter().filter(|d| **d < RADIO_CORTO * h).count() as f64 / radios.len() as f64;

    // Rosa de sectores. El desplazamiento de medio paso centra cada sector en su
    // ángulo nominal en vez de dejarlo empezando en él.
    let paso = 360.0 / SECTORES as f64;
    let mut por_sector: Vec<Vec<f64>> = vec![Vec::new(); SECTORES];
    for c in &v {
        let i = (((c.deg + paso / 2.0) % 360.0) / paso).floor() as usize % SECTORES;
        por_sector[i].push(c.r);
    }
    r.sectors = por_sector
        .into_iter()
        .enumerate()
        .map(|(i, mut rs)| {
            rs.sort_by(f64::total_cmp);
            Sector {
                deg: i as f64 * paso,
                clicks: rs.len(),
                share: rs.len() as f64 / v.len() as f64,
                ring_px: pct(&rs, 0.5),
            }
        })
        .collect();

    // Histograma de distancia, en escalones de 0,05 de la altura hasta 0,5.
    let mut bins = vec![0usize; 11];
    for c in &v {
        let i = ((c.r / h) / 0.05).floor() as usize;
        bins[i.min(10)] += 1;
    }
    r.rings = bins
        .into_iter()
        .enumerate()
        .map(|(i, n)| RingBin {
            from: i as f64 * 0.05,
            to: if i == 10 { f64::INFINITY } else { (i + 1) as f64 * 0.05 },
            clicks: n,
            share: n as f64 / v.len() as f64,
        })
        .collect();

    // Giros y correcciones, ambos sobre pares consecutivos.
    let mut giros: Vec<f64> = Vec::new();
    let mut react: Vec<f64> = Vec::new();
    let mut cruise: Vec<f64> = Vec::new();
    let mut correcciones: Vec<f64> = Vec::new();
    for par in v.windows(2) {
        let (a, b) = (&par[0], &par[1]);
        let dt = b.t - a.t;
        let g = giro(a.deg, b.deg);
        if dt <= CORRECCION_SECS && g <= CORRECCION_GIRO {
            correcciones.push(((b.x - a.x).powi(2) + (b.y - a.y).powi(2)).sqrt());
        }
        if dt > GIRO_VENTANA_SECS {
            continue;
        }
        giros.push(g);
        if g >= GIRO_REACTIVO {
            react.push(b.r);
        } else {
            cruise.push(b.r);
        }
    }
    giros.sort_by(f64::total_cmp);
    react.sort_by(f64::total_cmp);
    cruise.sort_by(f64::total_cmp);
    correcciones.sort_by(f64::total_cmp);

    r.turn_deg_p50 = pct(&giros, 0.5);
    r.reactive = TurnGroup {
        clicks: react.len(),
        ring_px_p50: pct(&react, 0.5),
        ring_pct_p50: pct(&react, 0.5) / h,
    };
    r.cruise = TurnGroup {
        clicks: cruise.len(),
        ring_px_p50: pct(&cruise, 0.5),
        ring_pct_p50: pct(&cruise, 0.5) / h,
    };
    r.correction_ratio = correcciones.len() as f64 / v.len() as f64;
    // Con menos de cinco pares la mediana del temblor es una anécdota, y de ella
    // cuelga el coste angular: mejor no dar número que dar uno inventado.
    if correcciones.len() >= 5 {
        let e = pct(&correcciones, 0.5);
        r.correction_px_p50 = Some(e);
        if r.ring_px_p50 > 1.0 {
            r.angular_cost_deg = Some((e / r.ring_px_p50).atan().to_degrees());
        }
        if r.reactive.ring_px_p50 > 1.0 {
            r.angular_cost_reactive_deg = Some((e / r.reactive.ring_px_p50).atan().to_degrees());
        }
    }
    r
}

/// La geometría de tus clics en una partida grabada.
///
/// Sale a cero en los VODs importados: ahí no hubo teclado ni ratón que
/// registrar, y el detector de clics por vídeo no distingue botón.
#[tauri::command]
pub async fn get_hand_report(match_id: String) -> Result<HandReport, String> {
    let m = crate::storage::get_match_metadata(&match_id)?;
    let escala = crate::storage::load_config().minimap_scale;
    Ok(analyze(&m, escala))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn partida(evs: Vec<(f64, f64, f64, &str)>) -> MatchMetadata {
        MatchMetadata {
            mouse_space_w: 1920,
            mouse_space_h: 1080,
            mouse_events: evs
                .into_iter()
                .map(|(t, x, y, evt)| MouseEventData { t, x, y, evt: evt.to_string() })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn el_angulo_pone_arriba_arriba() {
        // Y de pantalla crece hacia abajo: restar en Y es subir.
        assert!((angulo(0.0, -10.0) - 90.0).abs() < 1e-6);
        assert!((angulo(10.0, 0.0) - 0.0).abs() < 1e-6);
        assert!((angulo(0.0, 10.0) - 270.0).abs() < 1e-6);
    }

    #[test]
    fn el_giro_es_el_camino_corto() {
        assert!((giro(350.0, 10.0) - 20.0).abs() < 1e-6);
        assert!((giro(10.0, 350.0) - 20.0).abs() < 1e-6);
        assert!((giro(0.0, 180.0) - 180.0).abs() < 1e-6);
    }

    #[test]
    fn el_hud_y_el_minimapa_no_son_ordenes() {
        let m = partida(vec![
            (1.0, 960.0, 1050.0, "right_click"),  // HUD de abajo
            (2.0, 1800.0, 900.0, "right_click"),  // minimapa
            (3.0, 1200.0, 400.0, "right_click"),  // esta sí
        ]);
        let r = analyze(&m, 1.0);
        assert_eq!(r.clicks, 1);
        assert_eq!(r.discarded_ui, 2);
    }

    #[test]
    fn el_radio_se_mide_desde_el_centro() {
        // Cuatro clics a 300 px del centro (960, 540), uno por cuadrante.
        let m = partida(vec![
            (1.0, 1260.0, 540.0, "right_click"),
            (5.0, 660.0, 540.0, "right_click"),
            (9.0, 960.0, 240.0, "right_click"),
            (13.0, 960.0, 840.0, "right_click"),
        ]);
        let r = analyze(&m, 1.0);
        assert_eq!(r.clicks, 4);
        assert!((r.ring_px_p50 - 300.0).abs() < 1e-6);
        // 300 px pasa de 0,20 × 1080 = 216, así que ninguno es corto.
        assert!((r.short_ratio - 0.0).abs() < 1e-6);
    }

    #[test]
    fn los_clics_cortos_se_cuentan() {
        let m = partida(vec![
            (1.0, 1010.0, 540.0, "right_click"),  // 50 px: corto
            (5.0, 1360.0, 540.0, "right_click"),  // 400 px: largo
        ]);
        let r = analyze(&m, 1.0);
        assert!((r.short_ratio - 0.5).abs() < 1e-6);
    }

    #[test]
    fn un_giro_de_ciento_ochenta_es_reactivo() {
        // Dos clics seguidos en direcciones opuestas, dentro de la ventana.
        let m = partida(vec![
            (1.0, 1360.0, 540.0, "right_click"),
            (1.5, 560.0, 540.0, "right_click"),
        ]);
        let r = analyze(&m, 1.0);
        assert_eq!(r.reactive.clicks, 1);
        assert_eq!(r.cruise.clicks, 0);
        assert!((r.turn_deg_p50 - 180.0).abs() < 1e-6);
    }

    #[test]
    fn dos_clics_lejanos_en_el_tiempo_no_son_un_giro() {
        let m = partida(vec![
            (1.0, 1360.0, 540.0, "right_click"),
            (30.0, 560.0, 540.0, "right_click"),
        ]);
        let r = analyze(&m, 1.0);
        assert_eq!(r.reactive.clicks, 0);
        assert_eq!(r.cruise.clicks, 0);
    }

    #[test]
    fn el_temblor_sale_de_los_pares_pegados() {
        // Cinco pares: clic y corrección 20 px a la derecha, 40 ms después.
        let mut evs = Vec::new();
        for i in 0..5 {
            let t = i as f64 * 3.0;
            evs.push((t, 1360.0, 540.0, "right_click"));
            evs.push((t + 0.04, 1380.0, 540.0, "right_click"));
        }
        let m = partida(evs);
        let r = analyze(&m, 1.0);
        assert_eq!(r.correction_px_p50, Some(20.0));
        // atan(20/~400) ≈ 2,9°
        let coste = r.angular_cost_deg.unwrap();
        assert!(coste > 2.0 && coste < 4.0, "coste angular raro: {}", coste);
    }

    #[test]
    fn sin_estela_no_se_inventa_nada() {
        let r = analyze(&MatchMetadata::default(), 1.0);
        assert_eq!(r.clicks, 0);
        assert!(r.sectors.is_empty());
    }

    /// Sobre la biblioteca de verdad de esta máquina.
    ///
    /// Se activa con `LR_REAL=1`. No afirma nada —los números son los que
    /// sean— pero es la única forma de ver si el filtrado deja clics vivos y si
    /// las cifras caen en un rango que signifique algo.
    #[test]
    fn sobre_partidas_reales() {
        if std::env::var("LR_REAL").is_err() {
            return;
        }
        let escala = crate::storage::load_config().minimap_scale;
        for m in crate::storage::load_all_matches() {
            let Some(full) = crate::storage::load_match_by_id(&m.id) else { continue };
            let r = analyze(&full, escala);
            if r.clicks == 0 {
                println!("{:<28} sin clics", m.id);
                continue;
            }
            println!(
                "{:<28} {:>5} ordenes | radio p50 {:>4.0}px ({:>2.0}%) p90 {:>4.0}px | cortos {:>2.0}% | temblor {:>5} | coste {:>5} | giro p50 {:>3.0} | react {:>4.0}px vs crucero {:>4.0}px | ancla {:.2} (dx {:+.0} dy {:+.0}) | izq {}",
                m.id,
                r.clicks,
                r.ring_px_p50,
                r.ring_pct_p50 * 100.0,
                r.ring_px_p90,
                r.short_ratio * 100.0,
                r.correction_px_p50.map(|v| format!("{v:.0}px")).unwrap_or_else(|| "-".into()),
                r.angular_cost_deg.map(|v| format!("{v:.1}deg")).unwrap_or_else(|| "-".into()),
                r.turn_deg_p50,
                r.reactive.ring_px_p50,
                r.cruise.ring_px_p50,
                r.anchor_conf,
                r.anchor_dx_px,
                r.anchor_dy_px,
                r.left_in_play,
            );
        }
    }

}
