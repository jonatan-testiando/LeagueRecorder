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

/// Un rectángulo en fracciones de la pantalla: (x0, x1, y0, y1).
pub type Rect = (f64, f64, f64, f64);

/// El minimapa de la máquina de desarrollo, en fracciones de la pantalla.
///
/// Son las mismas que usa `python_scripts/minimap_positions.py` para recortar el
/// minimapa del vídeo, y valen igual aquí porque la interfaz de League se ancla
/// a la esquina y escala con la resolución.
///
/// Comprobado contra los clics de una partida real: **365 clics dentro y 0 en la
/// franja de 120 px pegada al borde izquierdo del rectángulo**. Un borde así de
/// limpio dice que la geometría es la buena.
///
/// Ojo: es la geometría de UN ajuste concreto, `MinimapScale = 3` (el máximo
/// del juego) a 2560×1440, que es el que tiene el desarrollador. Durante meses
/// fue la de todo el mundo. Hoy sólo la usan tal cual las partidas grabadas
/// antes de leer los ajustes del juego (`rect_heredado`); para el resto es la
/// referencia de la que sale el margen del marco (`margenes`).
const MINIMAPA: Rect = (0.787, 0.995, 0.622, 0.972);

/// La pantalla y la escala en las que se midió `MINIMAPA`.
const REF_W: f64 = 2560.0;
const REF_H: f64 = 1440.0;
const REF_ESCALA: f64 = 3.0;

/// Rango de `HUD.MinimapScale`.
///
/// No hay documentación de Riot. Lo que se sabe: el esquema del cliente
/// (`/lol-game-settings/v1/game-settings-schema`) da 1.0 por defecto sin
/// mínimo ni máximo; en la fórmula de iTero el paso es un tercio del lado
/// mínimo, así que a 3 el minimapa mide el doble que a 0; y las guías
/// recomiendan "33 en el deslizador" para el tamaño por defecto, lo que cuadra
/// con un deslizador de 0 a 100 que guarda de 0 a 3. El 3 de la máquina de
/// desarrollo es el deslizador al máximo. Un valor fuera de rango sólo sale de
/// editar el fichero a mano y se acota.
pub const ESCALA_MAX: f64 = 3.0;

/// El cuadrado que ocupa el minimapa en pantalla, en píxeles: (x0, y0, lado).
///
/// Es la fórmula de iTero Coach (`docs/analisis-itero-coach-2026-10.md` §4),
/// con su mismo redondeo: el lado mínimo es la altura entre 5,12 y cada punto
/// de escala suma un tercio de ese mínimo. Sólo depende de la ALTURA de la
/// pantalla: en un ultrapanorámico el minimapa mide lo mismo que en 16:9 con
/// la misma altura, y sigue pegado a la esquina.
fn cuadrado(w: f64, h: f64, escala: f64, flip: bool) -> (f64, f64, f64) {
    let base = (h / 5.12).round();
    let paso = (base / 3.0).round();
    let lado = (base + paso * escala).round();
    (if flip { 0.0 } else { w - lado }, h - lado, lado)
}

/// El margen entre el cuadrado de `cuadrado` y la zona que de verdad cuenta
/// como minimapa, en fracciones del lado: (izquierda, derecha, arriba, abajo).
///
/// Sale de comparar las dos geometrías en la pantalla de referencia: allí el
/// cuadrado va de x 1997 a 2560 y de y 877 a 1440 (lado 563), y `MINIMAPA` de
/// 2014,7 a 2547,2 y de 895,7 a 1399,7. A la izquierda, arriba y a la derecha
/// el margen es el marco dorado del minimapa (17,7, 18,7 y 12,8 px; en un
/// fotograma grabado el mapa empieza justo ahí). Abajo son 40 px que el
/// rectángulo validado deja fuera aunque el marco acabe unos 25 px más abajo.
///
/// Se guardan como fracción del lado y no de la pantalla porque el marco es
/// parte del minimapa y crece con él. Eso NO está comprobado a otras escalas
/// (no hay ninguna partida grabada que no sea a escala 3); si algún día se
/// graba una, es lo primero que hay que medir.
fn margenes() -> (f64, f64, f64, f64) {
    let (x0, y0, lado) = cuadrado(REF_W, REF_H, REF_ESCALA, false);
    let (fx0, fx1, fy0, fy1) = MINIMAPA;
    (
        (fx0 * REF_W - x0) / lado,
        (REF_W - fx1 * REF_W) / lado,
        (fy0 * REF_H - y0) / lado,
        (REF_H - fy1 * REF_H) / lado,
    )
}

/// El rectángulo del minimapa en una pantalla de `w`×`h` píxeles con los
/// ajustes de League `escala` (`HUD.MinimapScale`) y `flip`
/// (`HUD.FlipMiniMap`), en fracciones de la pantalla.
///
/// A escala 3 en 2560×1440 devuelve `MINIMAPA` (salvo redondeo de coma
/// flotante, muy por debajo del píxel): con los ajustes del desarrollador, el
/// análisis de sus partidas no cambia.
///
/// Con `flip` el minimapa se ancla a la esquina inferior IZQUIERDA y el marco
/// se refleja (el lado grueso sigue mirando al centro de la pantalla). El
/// reflejo es una suposición razonable, no una medida: nadie ha grabado una
/// partida con el minimapa volteado.
pub fn minimapa_rect(w: f64, h: f64, escala: f64, flip: bool) -> Rect {
    if !(w > 0.0 && h > 0.0) {
        return MINIMAPA;
    }
    let s = if escala.is_finite() { escala.clamp(0.0, ESCALA_MAX) } else { 1.0 };
    let (x0, y0, lado) = cuadrado(w, h, s, flip);
    let (izq, der, arr, aba) = margenes();
    let (mi, md) = if flip { (der, izq) } else { (izq, der) };
    (
        (x0 + mi * lado) / w,
        (x0 + lado - md * lado) / w,
        (y0 + arr * lado) / h,
        (y0 + lado - aba * lado) / h,
    )
}

/// El rectángulo de antes de leer los ajustes del juego: `MINIMAPA` escalado
/// desde su esquina inferior derecha por el factor `minimap_scale` de la config
/// (1.0 = tal cual). Sólo para partidas sin `hud_settings`, que así se quedan
/// exactamente como estaban.
///
/// Se acota a [0.5, 2.0]: fuera de ahí no hay ajuste de League que lo produzca
/// y un valor corrupto en la config inventaría un rectángulo absurdo.
pub fn rect_heredado(factor: f64) -> Rect {
    let s = if factor.is_finite() { factor.clamp(0.5, 2.0) } else { 1.0 };
    let (bx0, bx1, by0, by1) = MINIMAPA;
    (bx1 - (bx1 - bx0) * s, bx1, by1 - (by1 - by0) * s, by1)
}

/// ¿Son el mismo rectángulo? Con margen para la coma flotante: el de una
/// partida nueva a escala 3 sale de una cuenta y difiere de `MINIMAPA` en el
/// último bit, y eso no puede separar dos partidas con el minimapa en el mismo
/// sitio.
pub fn mismo_rect(a: Rect, b: Rect) -> bool {
    let cerca = |x: f64, y: f64| (x - y).abs() < 1e-9;
    cerca(a.0, b.0) && cerca(a.1, b.1) && cerca(a.2, b.2) && cerca(a.3, b.3)
}

/// Lo que dice la config sobre el minimapa. Se lee UNA vez por tanda (es un
/// fichero en disco) y se le pide el rectángulo de cada partida.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Calibracion {
    /// `minimap_scale_override`: un `MinimapScale` puesto a mano en Ajustes.
    /// Manda sobre lo detectado, en todas las partidas.
    pub forzada: Option<f64>,
    /// `minimap_scale`: el factor heredado de `rect_heredado`.
    pub heredada: f64,
}

impl Default for Calibracion {
    fn default() -> Self {
        Self { forzada: None, heredada: 1.0 }
    }
}

impl Calibracion {
    pub fn de_config(c: &crate::storage::AppConfig) -> Self {
        Self { forzada: c.minimap_scale_override, heredada: c.minimap_scale }
    }

    pub fn actual() -> Self {
        Self::de_config(&crate::storage::load_config())
    }

    /// El minimapa en una pantalla de `w`×`h` con estos ajustes del juego.
    ///
    /// - Con ajustes leídos: su lado, y su escala salvo que haya una forzada.
    /// - Sin ajustes (partida antigua) pero con escala forzada: esa escala, a
    ///   la derecha.
    /// - Sin nada: el rectángulo de siempre, como hasta ahora.
    pub fn rect_para(&self, w: f64, h: f64, hud: Option<&crate::ajustes_juego::HudSettings>) -> Rect {
        match (hud, self.forzada) {
            (Some(a), forzada) => minimapa_rect(w, h, forzada.unwrap_or(a.minimap_scale), a.flip_minimap),
            (None, Some(forzada)) => minimapa_rect(w, h, forzada, false),
            (None, None) => rect_heredado(self.heredada),
        }
    }

    /// El minimapa de una partida grabada.
    pub fn rect(&self, m: &MatchMetadata) -> Rect {
        self.rect_para(m.mouse_space_w as f64, m.mouse_space_h as f64, m.hud_settings.as_ref())
    }
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
fn en_minimapa(e: &MouseEventData, w: f64, h: f64, rect: Rect) -> bool {
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
fn punto_del_mapa(e: &MouseEventData, w: f64, h: f64, rect: Rect) -> (f64, f64) {
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
///
/// `rect` es el minimapa de ESTA partida (`Calibracion::rect`).
pub fn looks_from_input(m: &MatchMetadata, teclas: &[f64], rect: Rect) -> Vec<Look> {
    let (w, h) = (m.mouse_space_w as f64, m.mouse_space_h as f64);
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
    looks_from_input(m, teclas, Calibracion::default().rect(m)).into_iter().map(|l| l.t).collect()
}

/// Carril al que va un clic de minimapa, o `None` si el clic no está en el
/// minimapa o cae lejos de los tres carriles.
///
/// Lo usa el metrónomo en vivo, que trabaja con clics sueltos según llegan y no
/// tiene todavía metadata de la partida donde mirar la resolución: `rect` se
/// lo calcula el llamante con `Calibracion::rect_para`.
pub fn lane_of_click(x: f64, y: f64, w: f64, h: f64, rect: Rect) -> Option<&'static str> {
    let e = MouseEventData { t: 0.0, x, y, evt: String::new() };
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

/// Regenera las miradas de TODA la biblioteca con una calibración nueva.
///
/// Se lanza al cambiar `minimap_scale_override` en Ajustes: los informes ya
/// escritos se calcularon con el rectángulo viejo, y sin esto la calibración
/// solo aplicaba a partidas nuevas. Cada partida usa SU rectángulo
/// (`Calibracion::rect`): la escala forzada es común, pero el lado y el
/// volteo salen de los ajustes que se leyeron al grabarla. Solo partidas propias con estela (los VODs van por el
/// detector de vídeo, que no depende de esta geometría de escritorio).
///
/// Las teclas de cámara van vacías a propósito: `camera_snaps` ya es la lista
/// fusionada de pasadas anteriores, y reinyectarla fundiría cada clic con su
/// propio duplicado sin posición (el mismo gotcha del backfill). Las teclas
/// reales eran 0-1 por partida: pérdida asumida y documentada.
pub fn spawn_regenerate_all(cal: Calibracion) {
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
            let looks = looks_from_input(&full, &[], cal.rect(&full));
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
        log::info!("cámara: miradas regeneradas con {cal:?} en {hechas} partidas");
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
    let cal = Calibracion::actual();

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
        procesar_una(&m.id, cal);
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
fn procesar_una(id: &str, cal: Calibracion) {
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
    let looks = looks_from_input(&full, teclas, cal.rect(&full));

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
        let l = looks_from_input(&m, &[], rect_heredado(1.0));
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

    /// El factor heredado (partidas sin ajustes leídos) sigue haciendo lo de
    /// antes: agranda el rectángulo hacia dentro sin mover la esquina anclada.
    #[test]
    fn el_factor_heredado_agranda_el_rectangulo_hacia_dentro() {
        // 14 px a la izquierda del borde estándar en 2560×1440: fuera a 1.0.
        let m = meta(vec![clic(10.0, 2000.0, 1100.0, "left_click")]);
        assert!(looks_from_input(&m, &[], rect_heredado(1.0)).is_empty());
        assert_eq!(looks_from_input(&m, &[], rect_heredado(1.1)).len(), 1);

        // El ancla no se mueve: la esquina inferior derecha sigue dentro con
        // cualquier escala, y un valor corrupto cae al rectángulo estándar.
        let (_, x1, _, y1) = rect_heredado(0.7);
        assert_eq!((x1, y1), (0.995, 0.972));
        assert_eq!(rect_heredado(f64::NAN), rect_heredado(1.0));
        assert_eq!(rect_heredado(99.0), rect_heredado(2.0));
        assert_eq!(rect_heredado(1.0), MINIMAPA);
    }

    /// El rectángulo en píxeles: (x0, x1, y0, y1).
    fn px(r: Rect, w: f64, h: f64) -> (f64, f64, f64, f64) {
        (r.0 * w, r.1 * w, r.2 * h, r.3 * h)
    }

    fn casi(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64), tol: f64) -> bool {
        (a.0 - b.0).abs() < tol && (a.1 - b.1).abs() < tol && (a.2 - b.2).abs() < tol && (a.3 - b.3).abs() < tol
    }

    /// Con los ajustes del desarrollador (escala 3, sin voltear, 2560×1440) el
    /// modelo nuevo da el rectángulo validado: sus partidas no cambian.
    #[test]
    fn a_escala_3_es_el_rectangulo_validado() {
        let r = minimapa_rect(2560.0, 1440.0, 3.0, false);
        assert!(casi(r, MINIMAPA, 1e-12), "{r:?} != {MINIMAPA:?}");
        assert!(mismo_rect(r, rect_heredado(1.0)));
        assert!(!mismo_rect(r, minimapa_rect(2560.0, 1440.0, 2.9, false)));
    }

    /// El cuadrado es el de iTero: lado = round(H/5,12) + round(base/3)·escala,
    /// pegado abajo a la derecha (o a la izquierda volteado). A 1080p y escala 3
    /// son los 421 px del informe.
    #[test]
    fn el_cuadrado_es_el_de_itero() {
        for (h, lados) in [(1440.0, [281.0, 375.0, 469.0, 563.0]), (1080.0, [211.0, 281.0, 351.0, 421.0])] {
            let w = h * 16.0 / 9.0;
            for (escala, lado) in lados.into_iter().enumerate() {
                assert_eq!(cuadrado(w, h, escala as f64, false), (w - lado, h - lado, lado), "{h}p escala {escala}");
                assert_eq!(cuadrado(w, h, escala as f64, true), (0.0, h - lado, lado), "{h}p escala {escala} volteado");
            }
        }
        // Sólo cuenta la altura: un ultrapanorámico tiene el mismo lado.
        assert_eq!(cuadrado(3440.0, 1440.0, 3.0, false), (3440.0 - 563.0, 877.0, 563.0));
    }

    /// Escalas 0 a 3, con y sin volteo, en 2560×1440. Lo que se fija:
    /// - el rectángulo cae dentro de su cuadrado, con el marco proporcional;
    /// - volteado es el reflejo exacto respecto al centro de la pantalla;
    /// - a más escala, rectángulo más grande y que crece hacia el centro.
    #[test]
    fn el_rectangulo_a_cada_escala_con_y_sin_volteo() {
        let (w, h) = (2560.0, 1440.0);
        // Esperado a mano para la escala por defecto (1): cuadrado de 375 px
        // desde (2185, 1065); marco de 375·17,72/563 = 11,8 px a la izquierda,
        // 8,5 a la derecha, 12,4 arriba y 26,9 abajo.
        let uno = px(minimapa_rect(w, h, 1.0, false), w, h);
        assert!(casi(uno, (2196.80, 2551.47, 1077.44, 1413.14), 0.01), "escala 1: {uno:?}");

        let mut anterior: Option<(f64, f64, f64, f64)> = None;
        for escala in [0.0, 1.0, 2.0, 3.0] {
            let (sx0, sy0, lado) = cuadrado(w, h, escala, false);
            let r = px(minimapa_rect(w, h, escala, false), w, h);
            let (izq, der, arr, aba) = margenes();
            assert!(casi(r, (sx0 + izq * lado, sx0 + lado - der * lado, sy0 + arr * lado, sy0 + lado - aba * lado), 1e-9));
            assert!(r.0 > sx0 && r.1 < w && r.2 > sy0 && r.3 < h, "escala {escala}: {r:?} se sale del cuadrado");

            // Volteado: el reflejo, y el borde izquierdo de la pantalla queda
            // fuera del rectángulo (el marco está ahí).
            let f = px(minimapa_rect(w, h, escala, true), w, h);
            assert!(casi(f, (w - r.1, w - r.0, r.2, r.3), 1e-9), "escala {escala} volteada: {f:?}");
            assert!(f.0 > 0.0 && f.1 < lado);

            if let Some(a) = anterior {
                assert!(r.0 < a.0 && r.2 < a.2, "escala {escala} no crece hacia el centro");
                assert!(r.1 - r.0 > a.1 - a.0 && r.3 - r.2 > a.3 - a.2);
            }
            anterior = Some(r);
        }
    }

    /// Valores imposibles: se acota al deslizador del juego y una escala rota
    /// cae a la de por defecto. Sin resolución, el rectángulo de siempre.
    #[test]
    fn la_escala_se_acota_al_deslizador() {
        let (w, h) = (1920.0, 1080.0);
        assert_eq!(minimapa_rect(w, h, 9.0, false), minimapa_rect(w, h, ESCALA_MAX, false));
        assert_eq!(minimapa_rect(w, h, -2.0, false), minimapa_rect(w, h, 0.0, false));
        assert_eq!(minimapa_rect(w, h, f64::NAN, true), minimapa_rect(w, h, 1.0, true));
        assert_eq!(minimapa_rect(0.0, 0.0, 1.0, false), MINIMAPA);
    }

    fn hud(escala: f64, flip: bool) -> crate::ajustes_juego::HudSettings {
        crate::ajustes_juego::HudSettings {
            minimap_scale: escala,
            flip_minimap: flip,
            global_scale: None,
            width: None,
            height: None,
            window_mode: None,
            install_dir: String::new(),
        }
    }

    /// Qué rectángulo toca a cada partida: los ajustes leídos mandan; la escala
    /// forzada en Ajustes manda sobre su escala pero no sobre el volteo; sin
    /// nada, el de siempre con el factor heredado.
    #[test]
    fn cada_partida_usa_sus_ajustes() {
        let (w, h) = (2560.0, 1440.0);
        let auto = Calibracion { forzada: None, heredada: 1.2 };
        let forzada = Calibracion { forzada: Some(2.0), heredada: 1.2 };

        assert_eq!(auto.rect_para(w, h, None), rect_heredado(1.2));
        assert_eq!(auto.rect_para(w, h, Some(&hud(1.0, true))), minimapa_rect(w, h, 1.0, true));
        assert_eq!(forzada.rect_para(w, h, Some(&hud(1.0, true))), minimapa_rect(w, h, 2.0, true));
        assert_eq!(forzada.rect_para(w, h, None), minimapa_rect(w, h, 2.0, false));

        let mut m = meta(vec![]);
        m.hud_settings = Some(hud(0.0, false));
        assert_eq!(auto.rect(&m), minimapa_rect(w, h, 0.0, false));
    }

    /// Lo que arregla todo esto, con clics: un jugador con el minimapa por
    /// defecto (escala 1) que hace clic en el campo de batalla, justo a la
    /// izquierda de SU minimapa, ya no cuenta como mirada; y uno con el
    /// minimapa volteado a la izquierda por fin las cuenta.
    #[test]
    fn los_clics_caen_en_el_minimapa_de_cada_uno() {
        let cal = Calibracion::default();
        // Dentro del rectángulo de siempre, fuera del de escala 1 (x0 2196,8).
        let mut m = meta(vec![clic(10.0, 2100.0, 1200.0, "left_click")]);
        assert_eq!(looks_from_input(&m, &[], cal.rect(&m)).len(), 1);
        m.hud_settings = Some(hud(1.0, false));
        assert!(looks_from_input(&m, &[], cal.rect(&m)).is_empty());

        // Volteado: abajo a la izquierda, y la base azul sigue abajo a la izquierda.
        let mut v = meta(vec![clic(10.0, 30.0, 1390.0, "left_click")]);
        assert!(looks_from_input(&v, &[], cal.rect(&v)).is_empty());
        v.hud_settings = Some(hud(3.0, true));
        let l = looks_from_input(&v, &[], cal.rect(&v));
        let (x, y) = l[0].pos.unwrap();
        assert!(x < 500.0 && y < 500.0, "volteado dio ({x:.0}, {y:.0})");
    }

    /// La prueba de la franja sobre la biblioteca real de esta máquina, con el
    /// modelo nuevo a escala 3 frente al rectángulo de siempre. Se activa con
    /// `LR_REAL=1` y sólo lee.
    ///
    /// Afirma que las miradas (instante y punto) y las órdenes de movimiento de
    /// cada partida salen idénticas, y cuenta los clics izquierdos dentro del
    /// minimapa y en la franja de 120 px pegada a su borde izquierdo.
    #[test]
    fn franja_en_partidas_reales() {
        if std::env::var("LR_REAL").is_err() {
            return;
        }
        let (mut partidas, mut dentro_total, mut franja_total) = (0, 0, 0);
        for ligera in crate::storage::load_all_matches() {
            if ligera.is_vod {
                continue;
            }
            let Some(m) = crate::storage::load_match_by_id(&ligera.id) else { continue };
            let (w, h) = (m.mouse_space_w as f64, m.mouse_space_h as f64);
            if w <= 0.0 || h <= 0.0 || m.mouse_events.is_empty() {
                continue;
            }
            let viejo = rect_heredado(1.0);
            let nuevo = minimapa_rect(w, h, 3.0, false);
            // Los mismos clics en los mismos instantes; el punto del mapa, igual
            // salvo el último dígito de coma flotante (el rectángulo nuevo sale
            // de una cuenta, no de la constante escrita).
            let (a, b) = (looks_from_input(&m, &[], viejo), looks_from_input(&m, &[], nuevo));
            assert_eq!(a.iter().map(|l| l.t).collect::<Vec<_>>(), b.iter().map(|l| l.t).collect::<Vec<_>>(), "{}: miradas distintas", m.id);
            for (la, lb) in a.iter().zip(&b) {
                let ((xa, ya), (xb, yb)) = (la.pos.unwrap(), lb.pos.unwrap());
                assert!((xa - xb).abs() < 1e-6 && (ya - yb).abs() < 1e-6, "{}: punto distinto en {}", m.id, la.t);
            }
            assert_eq!(crate::hands::ordenes(&m, viejo), crate::hands::ordenes(&m, nuevo), "{}: órdenes distintas", m.id);

            let (x0, y0, y1) = (nuevo.0 * w, nuevo.2 * h, nuevo.3 * h);
            let izq: Vec<&MouseEventData> = m.mouse_events.iter().filter(|e| e.evt == "left_click").collect();
            let dentro = izq.iter().filter(|e| en_minimapa(e, w, h, nuevo)).count();
            let franja = izq
                .iter()
                .filter(|e| e.x >= x0 - 120.0 && e.x < x0 && e.y >= y0 && e.y <= y1)
                .count();
            println!("{:<24} {}x{} · {dentro:>4} dentro · {franja} en la franja", m.id, w, h);
            partidas += 1;
            dentro_total += dentro;
            franja_total += franja;
        }
        println!("{partidas} partidas · {dentro_total} clics dentro · {franja_total} en la franja");
    }

    /// Las partidas guardadas antes de esto no traen el campo y se leen igual.
    #[test]
    fn la_metadata_antigua_se_lee_sin_ajustes() {
        let txt = r#"{"id":"m","game_duration":1.0,"video_path":"","result":"","champion":"","date":"","events":[]}"#;
        let m: MatchMetadata = serde_json::from_str(txt).unwrap();
        assert!(m.hud_settings.is_none());
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
