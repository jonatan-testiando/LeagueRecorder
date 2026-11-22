//! Patrones de clics: cómo mueve el ratón tu mano en una partida.
//!
//! Es lo que MicroLab llama «Inputs» (docs/analisis-microlab-2026-11), sacado
//! de la estela que Wardline ya graba en todas las partidas: movimiento a unos
//! 30 Hz, clics y teclas Q-F, cada uno con la posición del cursor. No hay que
//! grabar nada nuevo y vale para todo el historial.
//!
//! Tres cosas en las que se aparta de MicroLab a propósito:
//!
//! - **Solo cuenta el tiempo vivo de la partida.** Ni la pantalla de carga, ni
//!   lo de después del nexo, ni tus muertes. A MicroLab nunca le llega la
//!   reaparición y su «ratón quieto» deja de contar en tu primera muerte; aquí
//!   las muertes salen de la timeline de Riot con su temporizador.
//! - **Las cifras van por minuto vivo.** Un recorrido total depende de lo que
//!   duró la partida, y comparar 400 m de una de 20 minutos con 600 m de una de
//!   35 no dice nada de tu mano.
//! - **Se compara con tu mediana de las 10 partidas anteriores**, no con la
//!   partida anterior, que es casi ruido.
//!
//! Lo que hay que tener presente al leerlo: el movimiento se graba como mucho
//! una vez cada 33 ms. En un trazo curvo eso recorta un poco el recorrido, así
//! que la eficiencia sale algo más alta de lo que mediría un registro por
//! evento. Entre partidas propias da igual: todas se graban igual.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

use crate::camera_input::{Calibracion, Rect};
use crate::riot_api::{MatchDto, TimelineDto};
use crate::storage::{MatchMetadata, MouseEventData};

/// Las distancias se pasan a una pantalla de 1080 px de alto antes de
/// compararlas: así una partida a 1440p y otra a 1080p hablan en la misma
/// unidad.
const ALTO_REF: f64 = 1080.0;

/// Metros por píxel de esa pantalla de referencia a 96 ppp (25,4 mm / 96). Es
/// la convención de MicroLab: no son los metros de tu monitor (no sabemos lo
/// que mide), pero sí una unidad que se entiende y que no cambia entre
/// partidas.
const M_POR_PX_REF: f64 = 0.0254 / 96.0;

/// Dos clics más separados que esto son dos decisiones con una pausa en medio
/// (la tienda, el chat, mirar el marcador). El camino entre ellos no dice nada
/// de la mano y hundiría la eficiencia.
const PAUSA_ENTRE_CLICS: f64 = 5.0;

/// Una ventana de al menos este tiempo sin que el cursor se aparte más de
/// [`QUIETO_PX_REF`] del punto de partida cuenta como ratón quieto.
const QUIETO_VENTANA: f64 = 1.0;
/// En píxeles de la pantalla de referencia: el temblor de la mano en reposo.
const QUIETO_PX_REF: f64 = 5.0;

/// Clics por tramo en el ranking de eficiencia, y cuántos tramos se devuelven
/// por cada lado (los mejores y los peores).
const TRAMO_CLICS: usize = 10;
const TRAMOS_TOP: usize = 5;
/// Un tramo en el que la mano apenas se movió (diez clics al mismo objetivo)
/// sale «perfecto» sin haber hecho nada. Para entrar en el ranking, la suma de
/// las rectas entre sus clics tiene que pasar de media pantalla de alto.
const TRAMO_RECTA_MIN: f64 = 0.5;

/// Para el ritmo de un botón solo cuentan los clics seguidos: dos clics
/// separados por más de esto son dos ráfagas, y el hueco entre ellas no es
/// ritmo sino una pausa.
const RAFAGA_MAX: f64 = 1.5;
/// Por debajo de esto son el mismo clic visto dos veces.
const RAFAGA_MIN: f64 = 0.02;
/// Con menos intervalos el ritmo es una anécdota.
const RITMO_MIN: usize = 10;

/// Partidas anteriores con las que se compara.
const BAREMO_PARTIDAS: usize = 10;

/// A menos de esto del borde, el cursor está EN el borde: con la cámara suelta,
/// ahí League la desplaza. Medido en tus partidas: los paneos dejan muestras
/// pegadas al borde (x = 0, y = alto − 1) durante varios fotogramas.
const BORDE_PX: f64 = 3.0;
/// `rdev` da a veces unos píxeles de más al apretar contra el borde (x = −7,
/// y = 1.445 en un monitor de 1.440). Hasta aquí es el borde; más allá, otro
/// monitor, y no cuenta.
const FUERA_TOLERANCIA: f64 = 12.0;

/// Las cifras de una partida.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ClickStats {
    /// Acciones por minuto que guardó la grabación (teclas y clics, como en el
    /// resto de la app). `None` si la partida no lo trae.
    pub apm: Option<f64>,
    /// Clics izquierdos y derechos en tiempo vivo.
    pub clicks: usize,
    pub left: usize,
    pub right: usize,
    /// Recorrido del cursor en metros de la pantalla de referencia.
    pub traveled_m: f64,
    pub traveled_m_min: f64,
    /// Recta entre clics seguidos / camino que hizo el cursor entre ellos,
    /// como cociente de sumas. 1 = siempre en línea recta.
    pub efficiency: Option<f64>,
    /// Distancia media entre clics seguidos, en tus píxeles y en los de la
    /// pantalla de referencia (para comparar).
    pub spread_px: Option<f64>,
    pub spread_ref: Option<f64>,
    /// Viajes del cursor al borde de la pantalla (paneos de cámara si juegas
    /// con ella suelta) y por minuto vivo.
    pub edge_pans: usize,
    pub edge_pans_min: f64,
    /// Clics por segundo vivo.
    pub tempo_hz: Option<f64>,
    /// Segundos con el ratón quieto y su parte del tiempo vivo.
    pub idle_s: f64,
    pub idle_ratio: Option<f64>,
    /// El tiempo vivo que se contó.
    pub alive_s: f64,
}

/// Tu mediana de las partidas anteriores, campo a campo.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ClickBaseline {
    pub matches: usize,
    pub apm: Option<f64>,
    pub traveled_m_min: Option<f64>,
    pub efficiency: Option<f64>,
    pub spread_ref: Option<f64>,
    pub tempo_hz: Option<f64>,
    pub idle_ratio: Option<f64>,
    pub edge_pans_min: Option<f64>,
}

/// Un tramo de [`TRAMO_CLICS`] clics seguidos.
#[derive(Debug, Clone, Serialize)]
pub struct ClickWindow {
    /// Segundos de vídeo del primer y del último clic.
    pub start: f64,
    pub end: f64,
    pub clicks: usize,
    pub efficiency: f64,
    /// Suma de las rectas y del camino real, en tus píxeles.
    pub straight_px: f64,
    pub path_px: f64,
}

/// El ritmo de un botón: cada cuánto clicas cuando clicas seguido.
#[derive(Debug, Clone, Serialize)]
pub struct ClickRhythm {
    /// "left" (ataque) o "right" (movimiento).
    pub button: String,
    /// Intervalos que se midieron.
    pub intervals: usize,
    pub hz: f64,
    pub interval_ms: f64,
    /// Coeficiente de variación en %.
    pub cv: f64,
    /// 100·e^(−CV/50): 100 = metrónomo, baja cuanto más irregular.
    pub consistency: f64,
}

/// Todo lo del bloque «Tus clics» de una partida.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ClickPatterns {
    pub stats: ClickStats,
    pub baseline: Option<ClickBaseline>,
    pub best: Vec<ClickWindow>,
    pub worst: Vec<ClickWindow>,
    pub rhythm: Vec<ClickRhythm>,
    /// Tramos vivos en segundos de vídeo: lo que se contó. El mapa de calor del
    /// frontend filtra con ellos.
    pub alive: Vec<(f64, f64)>,
    /// `false` sin la timeline de Riot: entonces las muertes cuentan como vivo.
    pub deaths_known: bool,
    pub screen_w: u32,
    pub screen_h: u32,
    /// El minimapa de la partida en fracciones de pantalla (x0, x1, y0, y1),
    /// para dibujarlo de referencia.
    pub minimap: Rect,
}

/// Un punto del cursor.
#[derive(Debug, Clone, Copy)]
struct Punto {
    t: f64,
    x: f64,
    y: f64,
}

fn dist(a: Punto, b: Punto) -> f64 {
    ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt()
}

fn mediana(mut v: Vec<f64>) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(f64::total_cmp);
    let n = v.len();
    Some(if n % 2 == 1 { v[n / 2] } else { (v[n / 2 - 1] + v[n / 2]) / 2.0 })
}

/// Tus muertes en segundos de VÍDEO, de la caída a la reaparición. `None` sin
/// la timeline de Riot o sin desfase de vídeo.
fn muertes_en_video(m: &MatchMetadata) -> Option<Vec<(f64, f64)>> {
    let off = m.video_offset?;
    let tl: TimelineDto = serde_json::from_str(&crate::storage::load_raw_timeline(&m.id)?).ok()?;
    let det: MatchDto = serde_json::from_str(&crate::storage::load_raw_match(&m.id)?).ok()?;
    let idx = det.info.participants.iter().position(|p| p.championName == m.champion)?;
    Some(
        crate::jungle_route::muertes(&tl, idx as i32 + 1)
            .into_iter()
            .map(|(a, b, _)| (a + off, b + off))
            .collect(),
    )
}

/// Los tramos vivos: la partida (de su arranque a su final, en el eje del
/// vídeo) menos las muertes. Sin desfase no se sabe dónde empieza la partida y
/// se toma lo grabado entero.
fn tramos_vivos(m: &MatchMetadata, muertes: &[(f64, f64)], t_min: f64, t_max: f64) -> Vec<(f64, f64)> {
    let (desde, hasta) = match m.video_offset {
        Some(off) if m.game_duration > 0.0 => (off.max(t_min), (off + m.game_duration).min(t_max)),
        _ => (t_min, t_max),
    };
    if hasta <= desde {
        return Vec::new();
    }
    let mut muertes: Vec<(f64, f64)> = muertes.to_vec();
    muertes.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut tramos = Vec::new();
    let mut ini = desde;
    for (a, b) in muertes {
        if b <= ini {
            continue;
        }
        if a >= hasta {
            break;
        }
        if a > ini {
            tramos.push((ini, a));
        }
        ini = ini.max(b);
    }
    if hasta > ini {
        tramos.push((ini, hasta));
    }
    tramos
}

/// El tramo vivo que contiene `t`, si hay.
fn tramo_de(tramos: &[(f64, f64)], t: f64) -> Option<usize> {
    let i = tramos.partition_point(|(a, _)| *a <= t);
    if i == 0 {
        return None;
    }
    let (a, b) = tramos[i - 1];
    (t >= a && t <= b).then_some(i - 1)
}

/// Lo que se cuenta de la estela, ya separado.
struct Estela {
    /// Todas las posiciones del cursor (movimientos, clics y teclas) dentro de
    /// la pantalla, en orden, con su tramo vivo.
    puntos: Vec<(Punto, usize)>,
    /// Los clics, en orden, con su botón (true = izquierdo) y su tramo.
    clics: Vec<(Punto, bool, usize)>,
}

fn separar(eventos: &[MouseEventData], w: f64, h: f64, tramos: &[(f64, f64)]) -> Estela {
    let mut puntos = Vec::new();
    let mut clics = Vec::new();
    for e in eventos {
        // Lejos de la pantalla del juego (otro monitor) no es la mano jugando;
        // a unos píxeles es el borde, apretado.
        let f = FUERA_TOLERANCIA;
        if e.x < -f || e.y < -f || e.x > w + f || e.y > h + f {
            continue;
        }
        let Some(tr) = tramo_de(tramos, e.t) else { continue };
        let p = Punto { t: e.t, x: e.x.clamp(0.0, w), y: e.y.clamp(0.0, h) };
        puntos.push((p, tr));
        match e.evt.as_str() {
            "left_click" => clics.push((p, true, tr)),
            "right_click" => clics.push((p, false, tr)),
            _ => {}
        }
    }
    puntos.sort_by(|a, b| a.0.t.total_cmp(&b.0.t));
    clics.sort_by(|a, b| a.0.t.total_cmp(&b.0.t));
    Estela { puntos, clics }
}

/// ¿Está el punto en el borde de la pantalla?
fn en_borde(p: Punto, w: f64, h: f64) -> bool {
    p.x <= BORDE_PX || p.y <= BORDE_PX || p.x >= w - BORDE_PX || p.y >= h - BORDE_PX
}

/// Un par de clics seguidos.
#[derive(Debug, Clone, Copy)]
struct Par {
    recta: f64,
    camino: f64,
    /// El cursor fue al borde entre los dos clics: un paneo de cámara, no un
    /// rodeo de la mano. No cuenta para la eficiencia.
    borde: bool,
}

/// Un par de clics seguidos: la recta y el camino real del cursor entre ellos.
/// `None` si no cuentan (otro tramo vivo, o una pausa en medio).
fn par(est: &Estela, k: usize, w: f64, h: f64) -> Option<Par> {
    let (a, _, ta) = est.clics[k];
    let (b, _, tb) = est.clics[k + 1];
    if ta != tb || b.t - a.t > PAUSA_ENTRE_CLICS {
        return None;
    }
    let recta = dist(a, b);
    // El camino: del primer clic, por cada posición estrictamente entre los
    // dos, al segundo.
    let desde = est.puntos.partition_point(|(p, _)| p.t <= a.t);
    let hasta = est.puntos.partition_point(|(p, _)| p.t < b.t);
    let mut camino = 0.0;
    let mut borde = false;
    let mut prev = a;
    for (p, _) in &est.puntos[desde..hasta.max(desde)] {
        camino += dist(prev, *p);
        borde |= en_borde(*p, w, h);
        prev = *p;
    }
    camino += dist(prev, b);
    Some(Par { recta, camino: camino.max(recta), borde })
}

/// Viajes al borde: cada vez que el cursor llega a él desde dentro.
fn paneos(est: &Estela, w: f64, h: f64) -> usize {
    let mut n = 0;
    let mut antes: Option<(bool, usize)> = None;
    for (p, tr) in &est.puntos {
        let ahora = en_borde(*p, w, h);
        let seguia = matches!(antes, Some((true, t)) if t == *tr);
        if ahora && !seguia {
            n += 1;
        }
        antes = Some((ahora, *tr));
    }
    n
}

/// Las cifras de una partida ya separada.
fn cifras(m: &MatchMetadata, est: &Estela, tramos: &[(f64, f64)], pares: &[Option<Par>]) -> ClickStats {
    let (w, h) = (m.mouse_space_w as f64, m.mouse_space_h as f64);
    let escala = ALTO_REF / h;
    let vivo: f64 = tramos.iter().map(|(a, b)| b - a).sum();
    let mut s = ClickStats {
        apm: (m.apm > 0.0).then_some(m.apm),
        alive_s: vivo,
        ..Default::default()
    };
    if vivo <= 0.0 {
        return s;
    }

    s.clicks = est.clics.len();
    s.left = est.clics.iter().filter(|c| c.1).count();
    s.right = s.clicks - s.left;
    s.tempo_hz = (s.clicks > 0).then(|| s.clicks as f64 / vivo);

    // Recorrido: posiciones seguidas del mismo tramo vivo.
    let recorrido: f64 = est
        .puntos
        .windows(2)
        .filter(|w| w[0].1 == w[1].1)
        .map(|w| dist(w[0].0, w[1].0))
        .sum();
    s.traveled_m = recorrido * escala * M_POR_PX_REF;
    s.traveled_m_min = s.traveled_m / (vivo / 60.0);

    // Eficiencia sobre los pares sin paneo en medio; dispersión sobre todos.
    let (rectas, caminos) = pares
        .iter()
        .flatten()
        .filter(|p| !p.borde)
        .fold((0.0, 0.0), |(r, c), p| (r + p.recta, c + p.camino));
    if caminos > 0.0 {
        s.efficiency = Some(rectas / caminos);
    }
    let validos: Vec<f64> = pares.iter().flatten().map(|p| p.recta).collect();
    if validos.len() >= 2 {
        let media = validos.iter().sum::<f64>() / validos.len() as f64;
        s.spread_px = Some(media);
        s.spread_ref = Some(media * escala);
    }
    s.edge_pans = paneos(est, w, h);
    s.edge_pans_min = s.edge_pans as f64 / (vivo / 60.0);

    s.idle_s = quieto(est, tramos, QUIETO_PX_REF / escala);
    s.idle_ratio = Some(s.idle_s / vivo);
    s
}

/// Segundos con el ratón quieto: rachas de al menos [`QUIETO_VENTANA`] en las
/// que el cursor no se aparta más de `umbral` píxeles del punto donde se paró.
///
/// La racha empieza en una muestra (el ancla) y acaba en la primera que se
/// sale del radio. La estela no tiene muestras mientras el cursor no se mueve
/// (solo se graba el movimiento), así que un hueco largo entre dos muestras ES
/// el ratón quieto; y como el primer movimiento tras la pausa se graba al
/// momento, la muestra que se sale marca bien cuándo volvió a moverse.
///
/// No es la ventana de MicroLab: allí una ventana que empieza moviéndose y
/// sigue quieta (lo normal al pararse) se descarta entera.
///
/// Para que cuente lo quieto al principio y al final de cada tramo vivo (la
/// reaparición, por ejemplo), cada tramo arranca y acaba con la última
/// posición conocida.
fn quieto(est: &Estela, tramos: &[(f64, f64)], umbral: f64) -> f64 {
    let mut total = 0.0;
    let mut ultimo: Option<Punto> = None;
    let mut i = 0;
    for (k, (a, b)) in tramos.iter().enumerate() {
        // La posición de antes del tramo (la de la muerte, por ejemplo).
        let mut pts: Vec<Punto> = Vec::new();
        while i < est.puntos.len() && est.puntos[i].1 < k {
            ultimo = Some(est.puntos[i].0);
            i += 1;
        }
        if let Some(u) = ultimo {
            pts.push(Punto { t: *a, ..u });
        }
        while i < est.puntos.len() && est.puntos[i].1 == k {
            pts.push(est.puntos[i].0);
            ultimo = Some(est.puntos[i].0);
            i += 1;
        }
        if let Some(u) = ultimo {
            if pts.last().map_or(true, |p| p.t < *b) {
                pts.push(Punto { t: *b, ..u });
            }
        }
        let Some(&primero) = pts.first() else { continue };
        let mut ancla = primero;
        let mut ultima = primero;
        for &p in &pts[1..] {
            if dist(ancla, p) > umbral {
                let racha = p.t - ancla.t;
                if racha >= QUIETO_VENTANA {
                    total += racha;
                }
                ancla = p;
            }
            ultima = p;
        }
        let racha = ultima.t - ancla.t;
        if racha >= QUIETO_VENTANA {
            total += racha;
        }
    }
    total
}

/// Los tramos de [`TRAMO_CLICS`] clics: los más rectos y los más torcidos, sin
/// solaparse.
fn tramos_de_clics(est: &Estela, pares: &[Option<Par>], h: f64) -> (Vec<ClickWindow>, Vec<ClickWindow>) {
    let n = est.clics.len();
    if n < TRAMO_CLICS {
        return (Vec::new(), Vec::new());
    }
    let mut ventanas: Vec<(usize, ClickWindow)> = Vec::new();
    'fuera: for i in 0..=(n - TRAMO_CLICS) {
        let (mut recta, mut camino) = (0.0, 0.0);
        for par in &pares[i..i + TRAMO_CLICS - 1] {
            // Un paneo en medio no es la mano: el tramo no entra.
            let Some(p) = par.filter(|p| !p.borde) else { continue 'fuera };
            recta += p.recta;
            camino += p.camino;
        }
        if recta < TRAMO_RECTA_MIN * h || camino <= 0.0 {
            continue;
        }
        ventanas.push((
            i,
            ClickWindow {
                start: est.clics[i].0.t,
                end: est.clics[i + TRAMO_CLICS - 1].0.t,
                clicks: TRAMO_CLICS,
                efficiency: recta / camino,
                straight_px: recta,
                path_px: camino,
            },
        ));
    }
    let elegir = |mut v: Vec<(usize, ClickWindow)>, mejores: bool| {
        v.sort_by(|a, b| {
            let o = a.1.efficiency.total_cmp(&b.1.efficiency);
            if mejores { o.reverse() } else { o }
        });
        let mut usados: Vec<usize> = Vec::new();
        let mut out = Vec::new();
        for (i, w) in v {
            if usados.iter().any(|u| i.abs_diff(*u) < TRAMO_CLICS) {
                continue;
            }
            usados.push(i);
            out.push(w);
            if out.len() == TRAMOS_TOP {
                break;
            }
        }
        out
    };
    (elegir(ventanas.clone(), true), elegir(ventanas, false))
}

/// El ritmo de cada botón.
fn ritmos(est: &Estela) -> Vec<ClickRhythm> {
    [(true, "left"), (false, "right")]
        .into_iter()
        .filter_map(|(izq, nombre)| {
            let mut previo: Option<(f64, usize)> = None;
            let mut dts: Vec<f64> = Vec::new();
            for (p, b, tr) in &est.clics {
                if *b != izq {
                    continue;
                }
                if let Some((t0, tr0)) = previo {
                    let dt = p.t - t0;
                    if tr0 == *tr && (RAFAGA_MIN..=RAFAGA_MAX).contains(&dt) {
                        dts.push(dt);
                    }
                }
                previo = Some((p.t, *tr));
            }
            if dts.len() < RITMO_MIN {
                return None;
            }
            let media = dts.iter().sum::<f64>() / dts.len() as f64;
            let var = dts.iter().map(|d| (d - media).powi(2)).sum::<f64>() / dts.len() as f64;
            let cv = var.sqrt() / media * 100.0;
            Some(ClickRhythm {
                button: nombre.to_string(),
                intervals: dts.len(),
                hz: 1.0 / media,
                interval_ms: media * 1000.0,
                cv,
                consistency: 100.0 * (-cv / 50.0).exp(),
            })
        })
        .collect()
}

/// El análisis de una partida ya cargada, con sus muertes en el eje del vídeo
/// (`None` si no se saben).
fn analizar(m: &MatchMetadata, muertes: Option<&[(f64, f64)]>) -> ClickPatterns {
    let (w, h) = (m.mouse_space_w as f64, m.mouse_space_h as f64);
    let mut r = ClickPatterns {
        deaths_known: muertes.is_some(),
        screen_w: m.mouse_space_w,
        screen_h: m.mouse_space_h,
        ..Default::default()
    };
    if w <= 0.0 || h <= 0.0 || m.mouse_events.is_empty() {
        return r;
    }
    let (t_min, t_max) = m
        .mouse_events
        .iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), e| (a.min(e.t), b.max(e.t)));
    let tramos = tramos_vivos(m, muertes.unwrap_or(&[]), t_min, t_max);
    let est = separar(&m.mouse_events, w, h, &tramos);
    let pares: Vec<Option<Par>> = (0..est.clics.len().saturating_sub(1)).map(|k| par(&est, k, w, h)).collect();
    r.stats = cifras(m, &est, &tramos, &pares);
    let (mejores, peores) = tramos_de_clics(&est, &pares, h);
    r.best = mejores;
    r.worst = peores;
    r.rhythm = ritmos(&est);
    r.alive = tramos;
    r
}

/// Las cifras de cada partida ya calculadas en esta sesión: las de una partida
/// pasada no cambian, y el baremo pide las de diez cada vez que se abre una.
/// La clave lleva lo que sí puede cambiar: que se sincronice con Riot (llegan
/// las muertes) o que se realinee el vídeo.
static CIFRAS: Mutex<Option<HashMap<String, ClickStats>>> = Mutex::new(None);

fn clave(m: &MatchMetadata) -> String {
    format!("{}|{:?}|{:?}", m.id, m.riot_match_id, m.video_offset.map(f64::to_bits))
}

fn cifras_en_cache(m: &MatchMetadata) -> Option<ClickStats> {
    CIFRAS.lock().ok()?.as_ref()?.get(&clave(m)).cloned()
}

fn guardar_cifras(m: &MatchMetadata, s: &ClickStats) {
    if let Ok(mut g) = CIFRAS.lock() {
        g.get_or_insert_with(HashMap::new).insert(clave(m), s.clone());
    }
}

/// Tu mediana de las [`BAREMO_PARTIDAS`] partidas grabadas antes que esta.
fn baremo(actual: &MatchMetadata) -> Option<ClickBaseline> {
    let mut anteriores: Vec<MatchMetadata> = crate::storage::load_all_matches()
        .into_iter()
        .filter(|m| !m.is_vod && m.id != actual.id && m.date < actual.date && m.mouse_space_w > 0)
        .collect();
    anteriores.sort_by(|a, b| b.date.cmp(&a.date));
    let mut todas: Vec<ClickStats> = Vec::new();
    for ligera in anteriores {
        if todas.len() >= BAREMO_PARTIDAS {
            break;
        }
        let s = match cifras_en_cache(&ligera) {
            Some(s) => s,
            None => {
                let Ok(m) = crate::storage::get_match_metadata_con_estela(&ligera.id) else { continue };
                let muertes = muertes_en_video(&m);
                let s = analizar(&m, muertes.as_deref()).stats;
                guardar_cifras(&m, &s);
                s
            }
        };
        // Una partida sin clics (grabada sin estela, o un abandono a los
        // pocos segundos) no es tu mano: no entra en la mediana.
        if s.clicks < 50 {
            continue;
        }
        todas.push(s);
    }
    if todas.is_empty() {
        return None;
    }
    let campo = |f: fn(&ClickStats) -> Option<f64>| mediana(todas.iter().filter_map(f).collect());
    Some(ClickBaseline {
        matches: todas.len(),
        apm: campo(|s| s.apm),
        traveled_m_min: campo(|s| Some(s.traveled_m_min)),
        efficiency: campo(|s| s.efficiency),
        spread_ref: campo(|s| s.spread_ref),
        tempo_hz: campo(|s| s.tempo_hz),
        idle_ratio: campo(|s| s.idle_ratio),
        edge_pans_min: campo(|s| Some(s.edge_pans_min)),
    })
}

/// El cálculo de [`get_click_patterns`], fuera del comando para las pruebas.
pub fn calcular(match_id: &str) -> Result<ClickPatterns, String> {
    let m = crate::storage::get_match_metadata_con_estela(match_id)?;
    let muertes = muertes_en_video(&m);
    let mut r = analizar(&m, muertes.as_deref());
    guardar_cifras(&m, &r.stats);
    r.minimap = Calibracion::actual().rect(&m);
    if r.stats.clicks > 0 {
        r.baseline = baremo(&m);
    }
    Ok(r)
}

/// «Tus clics» de una partida: las cifras, tu mediana, los tramos y el ritmo.
///
/// A cero en los VODs importados: no hubo ratón que grabar.
#[tauri::command]
pub async fn get_click_patterns(match_id: String) -> Result<ClickPatterns, String> {
    let _medida = crate::medida::Tramo::nuevo("cmd/get_click_patterns");
    tokio::task::spawn_blocking(move || calcular(&match_id))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(t: f64, x: f64, y: f64, evt: &str) -> MouseEventData {
        MouseEventData { t, x, y, evt: evt.to_string() }
    }

    fn partida(evs: Vec<MouseEventData>) -> MatchMetadata {
        MatchMetadata {
            id: "prueba".into(),
            mouse_space_w: 1920,
            mouse_space_h: 1080,
            mouse_events: evs,
            ..Default::default()
        }
    }

    #[test]
    fn los_tramos_vivos_quitan_muertes_y_lo_de_fuera_de_la_partida() {
        let m = MatchMetadata { video_offset: Some(10.0), game_duration: 100.0, ..Default::default() };
        // Grabado de 0 a 120; la partida va de 10 a 110 en el vídeo.
        let t = tramos_vivos(&m, &[(30.0, 40.0), (100.0, 130.0)], 0.0, 120.0);
        assert_eq!(t, vec![(10.0, 30.0), (40.0, 100.0)]);
        assert_eq!(tramo_de(&t, 35.0), None);
        assert_eq!(tramo_de(&t, 50.0), Some(1));
        assert_eq!(tramo_de(&t, 5.0), None);
    }

    #[test]
    fn la_recta_es_eficiencia_uno_y_el_rodeo_la_baja() {
        // Recto: clic, dos movimientos en la misma línea, clic.
        let recto = partida(vec![
            ev(0.0, 100.0, 100.0, "right_click"),
            ev(0.1, 200.0, 100.0, "move"),
            ev(0.2, 300.0, 100.0, "move"),
            ev(0.3, 400.0, 100.0, "right_click"),
        ]);
        let r = analizar(&recto, None);
        assert!((r.stats.efficiency.unwrap() - 1.0).abs() < 1e-9);
        // Rodeo: el cursor sube 150 px y baja. Camino 2·√(150²+150²) ≈ 424 por 300 de recta.
        let rodeo = partida(vec![
            ev(0.0, 100.0, 300.0, "right_click"),
            ev(0.2, 250.0, 150.0, "move"),
            ev(0.4, 400.0, 300.0, "right_click"),
        ]);
        let e = analizar(&rodeo, None).stats.efficiency.unwrap();
        assert!((e - 300.0 / (2.0 * (2.0f64 * 150.0 * 150.0).sqrt())).abs() < 1e-9, "{e}");
    }

    #[test]
    fn una_pausa_entre_clics_no_cuenta() {
        let m = partida(vec![
            ev(0.0, 100.0, 100.0, "right_click"),
            ev(3.0, 900.0, 900.0, "move"),
            ev(20.0, 400.0, 100.0, "right_click"),
        ]);
        let r = analizar(&m, None);
        assert_eq!(r.stats.clicks, 2);
        assert_eq!(r.stats.efficiency, None);
    }

    #[test]
    fn una_muerte_corta_el_par_y_no_cuenta_lo_de_dentro() {
        let m = MatchMetadata {
            video_offset: Some(0.0),
            game_duration: 100.0,
            ..partida(vec![
                ev(1.0, 100.0, 100.0, "right_click"),
                ev(2.0, 200.0, 100.0, "right_click"),
                ev(11.0, 900.0, 900.0, "right_click"), // muerto: no cuenta
                ev(21.0, 300.0, 100.0, "right_click"),
                ev(22.0, 400.0, 100.0, "right_click"),
            ])
        };
        let r = analizar(&m, Some(&[(10.0, 20.0)]));
        assert!(r.deaths_known);
        assert_eq!(r.stats.clicks, 4);
        // Dos pares válidos (1→2 y 21→22), el que cruza la muerte no.
        assert!((r.stats.spread_px.unwrap() - 100.0).abs() < 1e-9);
        // Lo vivo va de la primera a la última muestra (1 a 22 s) menos la
        // muerte: fuera de la estela no hay mano que medir.
        assert!((r.stats.alive_s - 11.0).abs() < 1e-9, "{}", r.stats.alive_s);
    }

    #[test]
    fn el_raton_quieto_cuenta_los_huecos_sin_movimiento() {
        // 10 s de partida: se mueve el primer segundo, quieto 8 s, se mueve al final.
        let mut evs = Vec::new();
        for i in 0..30 {
            evs.push(ev(i as f64 * 0.033, 100.0 + i as f64 * 10.0, 100.0, "move"));
        }
        evs.push(ev(9.0, 391.0, 100.0, "move")); // primer movimiento tras la pausa: 1 px
        for i in 1..30 {
            evs.push(ev(9.0 + i as f64 * 0.033, 391.0 + i as f64 * 10.0, 100.0, "move"));
        }
        let m = MatchMetadata { video_offset: Some(0.0), game_duration: 10.0, ..partida(evs) };
        let r = analizar(&m, Some(&[]));
        let quieto = r.stats.idle_s;
        assert!(quieto > 7.5 && quieto < 8.5, "quieto {quieto}");
    }

    #[test]
    fn el_ranking_elige_tramos_sin_solaparse() {
        // 40 clics en zigzag: los veinte primeros en línea recta, los veinte
        // últimos con un rodeo entre cada par.
        let mut evs = Vec::new();
        let mut t = 0.0;
        for i in 0..40 {
            let x = if i % 2 == 0 { 200.0 } else { 1200.0 };
            if i >= 20 && i > 0 {
                evs.push(ev(t - 0.1, 700.0, 900.0, "move"));
            }
            evs.push(ev(t, x, 300.0, "right_click"));
            t += 0.3;
        }
        let r = analizar(&partida(evs), None);
        assert!(!r.best.is_empty() && !r.worst.is_empty());
        assert!(r.best[0].efficiency > 0.99, "{}", r.best[0].efficiency);
        assert!(r.worst[0].efficiency < r.best[0].efficiency);
        for par in r.best.windows(2) {
            assert!(par[0].efficiency >= par[1].efficiency);
        }
        // Sin solaparse: los tramos elegidos no comparten clics.
        let mut todos: Vec<&ClickWindow> = r.best.iter().collect();
        todos.sort_by(|a, b| a.start.total_cmp(&b.start));
        for par in todos.windows(2) {
            assert!(par[1].start > par[0].end);
        }
    }

    #[test]
    fn el_ritmo_de_un_metronomo_es_regular() {
        let evs: Vec<MouseEventData> = (0..30).map(|i| ev(i as f64 * 0.25, 500.0, 500.0, "left_click")).collect();
        let r = analizar(&partida(evs), None);
        let izq = r.rhythm.iter().find(|x| x.button == "left").unwrap();
        assert!((izq.hz - 4.0).abs() < 1e-6);
        assert!(izq.consistency > 99.0);
        assert!(r.rhythm.iter().all(|x| x.button != "right"));
    }

    #[test]
    fn las_distancias_se_comparan_a_1080p() {
        // El mismo gesto a 1440p: 133 px de 1440 son 100 de 1080.
        let a = partida(vec![ev(0.0, 0.0, 0.0, "right_click"), ev(0.5, 100.0, 0.0, "right_click"), ev(1.0, 200.0, 0.0, "right_click")]);
        let b = MatchMetadata {
            mouse_space_w: 2560,
            mouse_space_h: 1440,
            ..partida(vec![ev(0.0, 0.0, 0.0, "right_click"), ev(0.5, 133.3333, 0.0, "right_click"), ev(1.0, 266.6667, 0.0, "right_click")])
        };
        let (sa, sb) = (analizar(&a, None).stats, analizar(&b, None).stats);
        assert!((sa.spread_ref.unwrap() - sb.spread_ref.unwrap()).abs() < 0.01);
        assert!((sa.traveled_m - sb.traveled_m).abs() < 1e-4);
    }

    #[test]
    fn un_paneo_por_el_borde_no_es_un_rodeo() {
        // Entre los dos primeros clics el cursor va a la esquina (apretando:
        // x = −6) y vuelve. Es un paneo: no baja la eficiencia, cuenta aparte.
        let m = partida(vec![
            ev(0.0, 500.0, 500.0, "right_click"),
            ev(0.1, 200.0, 800.0, "move"),
            ev(0.2, -6.0, 1084.0, "move"),
            ev(0.3, 300.0, 700.0, "move"),
            ev(0.4, 600.0, 500.0, "right_click"),
            ev(0.5, 650.0, 500.0, "move"),
            ev(0.6, 700.0, 500.0, "right_click"),
            ev(0.7, 3000.0, 500.0, "move"), // otro monitor: fuera
        ]);
        let r = analizar(&m, None);
        assert_eq!(r.stats.edge_pans, 1);
        // Solo cuenta el segundo par, que va recto.
        assert!((r.stats.efficiency.unwrap() - 1.0).abs() < 1e-9);
        // La dispersión sí cuenta los dos: (100 + 100) / 2.
        assert!((r.stats.spread_px.unwrap() - 100.0).abs() < 1e-9);
    }

    #[test]
    fn sin_estela_no_se_inventa_nada() {
        let r = analizar(&MatchMetadata::default(), None);
        assert_eq!(r.stats.clicks, 0);
        assert!(r.best.is_empty() && r.rhythm.is_empty());
    }

    /// Sobre la biblioteca de verdad. Se activa con `LR_REAL=1`.
    #[test]
    fn sobre_partidas_reales() {
        if std::env::var("LR_REAL").is_err() {
            return;
        }
        for ligera in crate::storage::load_all_matches().into_iter().filter(|m| !m.is_vod).take(30) {
            let ini = std::time::Instant::now();
            let Ok(r) = calcular(&ligera.id) else { continue };
            let s = &r.stats;
            println!(
                "{:<26} {:>4.0} ms | vivo {:>5.0} s muertes {:<5} | clics {:>5} ({} izq) | {:>5.1} m/min | efic {:>5} | disp {:>5} | {:>4.2} Hz | quieto {:>5} | tramos {}/{} ritmo {:?} | baremo {}",
                ligera.id,
                ini.elapsed().as_secs_f64() * 1000.0,
                s.alive_s,
                r.deaths_known,
                s.clicks,
                s.left,
                s.traveled_m_min,
                s.efficiency.map(|e| format!("{:.0}%", e * 100.0)).unwrap_or("-".into()),
                s.spread_ref.map(|e| format!("{e:.0}")).unwrap_or("-".into()),
                s.tempo_hz.unwrap_or(0.0),
                s.idle_ratio.map(|e| format!("{:.0}%", e * 100.0)).unwrap_or("-".into()),
                r.best.len(),
                r.worst.len(),
                r.rhythm.iter().map(|x| format!("{} {:.1}Hz c{:.0}", x.button, x.hz, x.consistency)).collect::<Vec<_>>(),
                r.baseline.as_ref().map_or(0, |b| b.matches),
            );
        }
    }
}
