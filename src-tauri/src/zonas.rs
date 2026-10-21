//! La teoría del gank del usuario, en coordenadas de juego.
//!
//! # Zonas de línea
//!
//! Cada línea se parte según dónde está la oleada, de la torre exterior de un
//! equipo a la del otro (imágenes del usuario, 2026-10-20):
//!
//! ```text
//! tu torre exterior                                    su torre exterior
//!   |   3   |  2  |            1            |  2  |   3   |
//! ```
//!
//! - **1** (el centro; en top y bot, la esquina): gankeable.
//! - **2** (a cada lado del 1): última oportunidad de gankear.
//! - **3** (pegada a cada torre exterior): ingankeable.
//!
//! Los cortes se midieron en la imagen de mid, que es una vista cenital: las
//! dos torres exteriores salen a la misma escala en x y en y (0,337 px por
//! unidad), así que no hay perspectiva que corregir. Proyectando cada píxel
//! pintado sobre el eje de torre a torre, el color dominante cambia en
//! 0,22 · 0,32 · 0,66 · 0,76. La imagen de bot está en perspectiva y sólo se
//! pudo estimar a ojo (0,18 · 0,33 · 0,62 · 0,80), que cae a menos de 0,04.
//! Se usan los de mid hechos simétricos, porque la teoría es la misma vista
//! desde los dos lados. Fuera del tramo (detrás de una torre exterior) es 3.
//!
//! **El mejor lado** (top y bot): el usuario rodeó el borde entre el 2 y el 1
//! del lado de TU torre: abajo-izquierda en bot si juegas en azul y
//! arriba-derecha si juegas en rojo. Top sale por simetría. En mid no rodeó
//! ninguno.
//!
//! # Regiones del mapa
//!
//! Como el grabador de minimapa de referencia («showcase 1 Minimap recorder»,
//! en Descargas): las dos diagonales parten el mapa en cuatro cuadrantes,
//! **Q1 oeste, Q2 sur, Q3 este y Q4 norte**, cada uno media jungla, con la
//! banda de mid y el río (superior e inferior) aparte. Las bases no salen en
//! los 15 s del vídeo y aquí van aparte: «venías de base» es otra entrada.
//! Sirven para el lado de entrada de un gank: de qué región venías al pisar
//! la línea.

use crate::gank::{Lane, LANE_HALF_WIDTH};
use crate::minimap::Fix;
use crate::riot_api::{ParticipantDto, TimelineDto};

/// Lado del mapa en unidades de juego.
const MAPA: f64 = 14870.0;

/// Corte entre el 3 y el 2, en fracción del tramo entre torres exteriores
/// contada desde tu torre. Ver la cabecera del módulo.
pub const CORTE_3_2: f64 = 0.23;
/// Corte entre el 2 y el 1.
pub const CORTE_2_1: f64 = 0.33;

/// Media anchura de la banda de mid. Medido en el minimapa del vídeo de
/// referencia: la tierra clara de mid cae a la mitad pasadas ~600 u del eje
/// (586 → 431 → 258 píxeles por franja de 100 u entre 400 y 700). Encaja con
/// sus etiquetas: «Mid» a 358 u y «Q1 - Oeste» a 1.872.
const MID_MEDIO_ANCHO: f64 = 650.0;
/// Media anchura del río. Medido en el mismo minimapa: los píxeles de agua
/// lejos del centro se acaban entre 1.000 y 1.100 u del eje (305 → 11 → 0).
/// Encaja con sus etiquetas: «Río superior» a 852 u y «Q2 - Sur» a 1.945.
const RIO_MEDIO_ANCHO: f64 = 1100.0;
/// Lado del cuadrado de cada base, desde su esquina: deja dentro las tres
/// torres de inhibidor (la más lejana, la de bot azul, a 4.281).
const BASE: f64 = 4500.0;

// ------------------------------------------------------------------ zonas

/// Zona de la teoría del gank, vista desde tu equipo.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Zona {
    /// 3 pegado a tu torre exterior.
    TorrePropia,
    /// 2 de tu lado.
    PreviaPropia,
    /// 1, el centro.
    Centro,
    /// 2 de su lado: la última oportunidad antes de su torre.
    PreviaRival,
    /// 3 pegado a su torre exterior.
    TorreRival,
}

impl Zona {
    pub fn key(self) -> &'static str {
        match self {
            Zona::TorrePropia => "own_3",
            Zona::PreviaPropia => "own_2",
            Zona::Centro => "center_1",
            Zona::PreviaRival => "enemy_2",
            Zona::TorreRival => "enemy_3",
        }
    }
}

/// Lo que sólo usan las tablas de medida.
#[cfg(test)]
impl Zona {
    pub const TODAS: [Zona; 5] =
        [Zona::TorrePropia, Zona::PreviaPropia, Zona::Centro, Zona::PreviaRival, Zona::TorreRival];

    /// El número de la teoría: 3, 2, 1, 2, 3.
    pub fn numero(self) -> u8 {
        match self {
            Zona::TorrePropia | Zona::TorreRival => 3,
            Zona::PreviaPropia | Zona::PreviaRival => 2,
            Zona::Centro => 1,
        }
    }

    pub fn etiqueta(self) -> &'static str {
        match self {
            Zona::TorrePropia => "3 tuya",
            Zona::PreviaPropia => "2 tuya",
            Zona::Centro => "1",
            Zona::PreviaRival => "2 suya",
            Zona::TorreRival => "3 suya",
        }
    }
}

/// Fracción del tramo entre torres exteriores en la que cae cada una, sobre
/// el progreso del eje de [`crate::gank`] (0 = base azul, 1 = base roja). Las
/// torres exteriores son los vértices 2 y 4 del eje.
fn tramo(lane: Lane) -> (f64, f64) {
    let p = lane.path();
    let t = |i: usize| crate::gank::project(lane, p[i].0, p[i].1).1;
    (t(2), t(4))
}

/// Tu torre exterior sobre el eje, contado desde tu base (0..1): el sentido
/// del choque de [`crate::oleadas`].
pub fn torre_exterior_propia(lane: Lane, equipo: i32) -> f64 {
    let (a, b) = tramo(lane);
    if equipo == 200 {
        1.0 - b
    } else {
        a
    }
}

/// Dónde cae `t_azul` (progreso del eje, 0 = base azul) entre las dos torres
/// exteriores: 0 = la azul, 1 = la roja. Fuera de [0, 1] está detrás de una.
pub fn entre_torres(lane: Lane, t_azul: f64) -> f64 {
    let (a, b) = tramo(lane);
    (t_azul - a) / (b - a)
}

/// Zona de una fracción del tramo (0 = torre azul), vista desde `equipo`.
pub fn zona_de_fraccion(f_azul: f64, equipo: i32) -> Zona {
    let f = if equipo == 200 { 1.0 - f_azul } else { f_azul };
    if f < CORTE_3_2 {
        Zona::TorrePropia
    } else if f < CORTE_2_1 {
        Zona::PreviaPropia
    } else if f <= 1.0 - CORTE_2_1 {
        Zona::Centro
    } else if f <= 1.0 - CORTE_3_2 {
        Zona::PreviaRival
    } else {
        Zona::TorreRival
    }
}

/// Zona de un punto del mapa en una línea, si está a menos de `radio` de su eje.
pub fn zona_en(lane: Lane, x: f64, y: f64, equipo: i32, radio: f64) -> Option<Zona> {
    let (d, t) = crate::gank::project(lane, x, y);
    (d <= radio).then(|| zona_de_fraccion(entre_torres(lane, t), equipo))
}

/// Zona del choque de oleadas que lee [`crate::oleadas`]: 0 = tu base, 1 = la
/// suya, sobre el eje entero de base a base.
pub fn zona_del_choque(lane: Lane, choque: f64, equipo: i32) -> Zona {
    let t_azul = if equipo == 200 { 1.0 - choque } else { choque };
    zona_de_fraccion(entre_torres(lane, t_azul), equipo)
}

/// La zona que la teoría marca como el mejor lado para ganquear: tu 2, en su
/// borde con el 1. En mid el usuario no marcó ninguno.
pub fn mejor_lado(lane: Lane) -> Option<Zona> {
    (lane != Lane::Mid).then_some(Zona::PreviaPropia)
}

// --------------------------------------------------------------- regiones

/// Región del mapa, como las nombra el grabador de minimapa de referencia.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Region {
    BaseAzul,
    BaseRoja,
    Mid,
    RioSuperior,
    RioInferior,
    /// Media jungla azul de arriba.
    Q1Oeste,
    /// Media jungla azul de abajo.
    Q2Sur,
    /// Media jungla roja de abajo.
    Q3Este,
    /// Media jungla roja de arriba.
    Q4Norte,
}

impl Region {
    pub fn key(self) -> &'static str {
        match self {
            Region::BaseAzul => "base_blue",
            Region::BaseRoja => "base_red",
            Region::Mid => "mid",
            Region::RioSuperior => "river_top",
            Region::RioInferior => "river_bot",
            Region::Q1Oeste => "q1_west",
            Region::Q2Sur => "q2_south",
            Region::Q3Este => "q3_east",
            Region::Q4Norte => "q4_north",
        }
    }
}

/// Región de un punto del mapa (x hacia la derecha, y hacia arriba).
pub fn region(x: f64, y: f64) -> Region {
    if x <= BASE && y <= BASE {
        return Region::BaseAzul;
    }
    if x >= MAPA - BASE && y >= MAPA - BASE {
        return Region::BaseRoja;
    }
    if Lane::Mid.distance(x, y) <= MID_MEDIO_ANCHO {
        return Region::Mid;
    }
    let arriba = y > x;
    if ((x + y - MAPA) / std::f64::consts::SQRT_2).abs() <= RIO_MEDIO_ANCHO {
        return if arriba { Region::RioSuperior } else { Region::RioInferior };
    }
    match (arriba, x + y < MAPA) {
        (true, true) => Region::Q1Oeste,
        (false, true) => Region::Q2Sur,
        (false, false) => Region::Q3Este,
        (true, false) => Region::Q4Norte,
    }
}

/// Por dónde entraste a la línea, visto desde tu equipo.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Entrada {
    /// Desde tu media jungla: el lado de tu torre.
    TuJungla,
    Rio,
    /// Desde su media jungla: por detrás del rival.
    SuJungla,
    Mid,
    Base,
}

impl Entrada {
    pub fn key(self) -> &'static str {
        match self {
            Entrada::TuJungla => "own_jungle",
            Entrada::Rio => "river",
            Entrada::SuJungla => "enemy_jungle",
            Entrada::Mid => "mid",
            Entrada::Base => "base",
        }
    }
}

#[cfg(test)]
impl Entrada {
    pub fn etiqueta(self) -> &'static str {
        match self {
            Entrada::TuJungla => "tu jungla",
            Entrada::Rio => "río",
            Entrada::SuJungla => "su jungla",
            Entrada::Mid => "mid",
            Entrada::Base => "base",
        }
    }
}

pub fn entrada(r: Region, equipo: i32) -> Entrada {
    let azul = equipo != 200;
    match r {
        Region::BaseAzul | Region::BaseRoja => Entrada::Base,
        Region::Mid => Entrada::Mid,
        Region::RioSuperior | Region::RioInferior => Entrada::Rio,
        Region::Q1Oeste | Region::Q2Sur if azul => Entrada::TuJungla,
        Region::Q3Este | Region::Q4Norte if !azul => Entrada::TuJungla,
        _ => Entrada::SuJungla,
    }
}

// --------------------------------------------------------- contexto del gank

/// Hasta cuánto antes del gank se busca tu entrada en la línea. Un gank con
/// resultado tarda segundos desde que pisas la línea hasta el kill; esperar
/// más que esto en la banda ya no es «entrar», es estar.
const ENTRADA_ANTES_MAX: f64 = 45.0;
/// Un gank sin resultado se fecha interpolando entre fotogramas de minuto:
/// tu entrada real puede caer hasta un minuto después.
const ENTRADA_DESPUES_SIN_RESULTADO: f64 = 60.0;
/// Hueco máximo entre dos puntos del rastro para dar el tramo por continuo.
const HUECO_RASTRO: f64 = 3.0;
/// Sin rastro, un gank con resultado empieza esto antes del kill: la mediana
/// medida en tus partidas desde que pisas la línea (p10 1 s, p90 22 s).
/// Fecharlo en el kill mismo hacía trampa: la muerte del rival invalidaba su
/// fotograma, y los niveles y la R del propio kill entraban como «antes».
const RETRASO_KILL: f64 = 10.0;
/// Un fotograma de la API más lejos que esto del inicio no dice dónde estaba
/// el rival: en 20 s anda ~7.000 u.
const FOTOGRAMA_MAX: f64 = 20.0;
/// La vida cambia en un intercambio: sólo vale el fotograma muy pegado.
const VIDA_MAX: f64 = 15.0;
/// Ventana hacia atrás en la que se busca la R del rival en el desglose de
/// daño de una muerte.
const R_VISTA_ANTES: f64 = 150.0;

/// Lo que se sabe de un gank al empezar. Lo que sale de la API vale para
/// cualquier partida; lo del vídeo (inicio, oleada, entrada) sólo con él.
#[derive(Debug, Clone, Default)]
pub struct Contexto {
    /// Segundos de partida: tu entrada en la línea según el rastro del vídeo,
    /// o el instante del gank si no hay rastro.
    pub inicio: f64,
    pub inicio_con_video: bool,
    /// Dónde estaba el choque de oleadas al empezar (minimapa del vídeo).
    pub zona_oleada: Option<Zona>,
    /// Dónde estaba el rival en el fotograma de la API más cercano al inicio.
    pub zona_rival: Option<Zona>,
    /// De qué región venías al pisar la línea (rastro del vídeo).
    pub region_entrada: Option<Region>,
    pub nivel_tuyo: i32,
    pub nivel_rival: Option<i32>,
    /// Tu compañero del mismo puesto que el rival (en bot, tirador contra
    /// tirador y apoyo contra apoyo).
    pub nivel_aliado: Option<i32>,
    pub r_tuya: bool,
    pub r_rival: Option<bool>,
    /// Vida del rival (0..1) en el fotograma de la API, si está pegado al inicio.
    pub vida_rival: Option<f64>,
    /// Segundos desde la última vez que la R del rival aparece en el desglose
    /// de daño de una muerte. Es lo único de sus enfriamientos que deja rastro.
    pub r_rival_vista: Option<f64>,
}

/// Cuándo pisaste la línea camino de este gank, según tu rastro del vídeo, y
/// dónde estabas justo antes. Se toma el punto del rastro dentro de la banda
/// del carril más cercano al gank y se retrocede por ese tramo hasta su
/// primer punto. `None` si el rastro no cubre el gank, si no se te ve entrar
/// (hueco en el rastro) o si llevabas en la línea más de
/// [`ENTRADA_ANTES_MAX`]: entonces no entraste, estabas.
pub fn entrada_en_rastro(g: &crate::gank::Gank, pista: &[Fix]) -> Option<(f64, (f64, f64))> {
    let lane = g.lane;
    let dentro = |f: &Fix| lane.distance(f.x, f.y) <= LANE_HALF_WIDTH;
    let despues = if g.outcome == crate::gank::Outcome::Neutral { ENTRADA_DESPUES_SIN_RESULTADO } else { 3.0 };
    let desde = pista.partition_point(|f| f.sec < g.time - ENTRADA_ANTES_MAX);
    let hasta = pista.partition_point(|f| f.sec <= g.time + despues);
    let j = (desde..hasta)
        .filter(|&k| dentro(&pista[k]))
        .min_by(|&a, &b| (pista[a].sec - g.time).abs().total_cmp(&(pista[b].sec - g.time).abs()))?;
    let mut i = j;
    while i > 0 && dentro(&pista[i - 1]) && pista[i].sec - pista[i - 1].sec <= HUECO_RASTRO {
        i -= 1;
    }
    let antes = pista.get(i.checked_sub(1)?)?;
    if pista[i].sec - antes.sec > HUECO_RASTRO || pista[j].sec - pista[i].sec > ENTRADA_ANTES_MAX + despues {
        return None;
    }
    Some((pista[i].sec, (antes.x, antes.y)))
}

/// Nivel de un participante en un instante: los `LEVEL_UP` traen milisegundos.
fn nivel_en(tl: &TimelineDto, pid: i32, t: f64) -> i32 {
    tl.info
        .frames
        .iter()
        .flat_map(|f| f.events.iter())
        .filter(|e| e.event_type == "LEVEL_UP" && e.participantId == pid && e.timestamp as f64 / 1000.0 <= t)
        .map(|e| e.level)
        .max()
        .unwrap_or(1)
        .max(1)
}

/// ¿Había aprendido la R? `SKILL_LEVEL_UP` cuenta las habilidades de 1 a 4
/// (la R es el 4, a nivel 6, 11 y 16), al contrario que el desglose de daño.
fn tiene_r(tl: &TimelineDto, pid: i32, t: f64) -> bool {
    tl.info.frames.iter().flat_map(|f| f.events.iter()).any(|e| {
        e.event_type == "SKILL_LEVEL_UP" && e.participantId == pid && e.skillSlot == 4 && e.timestamp as f64 / 1000.0 <= t
    })
}

/// La última R del rival en el desglose de daño de una muerte (ranura 3,
/// contada desde 0) en la ventana previa al gank.
fn r_vista(tl: &TimelineDto, pid: i32, t: f64) -> Option<f64> {
    tl.info
        .frames
        .iter()
        .flat_map(|f| f.events.iter())
        .filter(|e| e.event_type == "CHAMPION_KILL")
        .filter(|e| {
            let s = e.timestamp as f64 / 1000.0;
            s < t && s >= t - R_VISTA_ANTES
        })
        .filter(|e| {
            e.victimDamageReceived.iter().chain(e.victimDamageDealt.iter()).any(|d| d.participantId == pid && d.spellSlot == 3)
        })
        .map(|e| t - e.timestamp as f64 / 1000.0)
        .min_by(f64::total_cmp)
}

/// ¿Murió `pid` entre dos instantes? En ese hueco su posición de la API es la
/// de un muerto y no dice dónde estaba.
fn murio_entre(tl: &TimelineDto, pid: i32, a: f64, b: f64) -> bool {
    let (a, b) = (a.min(b), a.max(b));
    tl.info.frames.iter().flat_map(|f| f.events.iter()).any(|e| {
        e.event_type == "CHAMPION_KILL" && e.victimId == pid && {
            let s = e.timestamp as f64 / 1000.0;
            s >= a && s <= b
        }
    })
}

/// El fotograma de minuto más cercano a `t`, a menos de `max` segundos, antes
/// de `fin` y sin una muerte de `pid` por medio: `(segundos, x, y, vida 0..1)`.
///
/// `fin` es el desenlace del gank. Sin él, un gank que acaba en kill sólo
/// podía usar los fotogramas previos y uno que acaba en tu muerte también los
/// de después: la zona se conocía más en los fallidos y la tabla salía torcida.
fn fotograma(tl: &TimelineDto, pid: i32, t: f64, max: f64, fin: f64) -> Option<(f64, f64, f64, Option<f64>)> {
    let k = pid.to_string();
    tl.info
        .frames
        .iter()
        .filter_map(|f| {
            let s = f.timestamp as f64 / 1000.0;
            let pf = f.participantFrames.get(&k)?;
            let p = pf.position.as_ref()?;
            let cs = &pf.championStats;
            let vida = (cs.healthMax > 0).then(|| cs.health as f64 / cs.healthMax as f64);
            Some((s, p.x as f64, p.y as f64, vida))
        })
        .filter(|(s, ..)| (s - t).abs() <= max && *s < fin && !murio_entre(tl, pid, *s, t))
        .min_by(|a, b| (a.0 - t).abs().total_cmp(&(b.0 - t).abs()))
}

/// El contexto de un gank. `serie` son las oleadas del vídeo y `pista` tu
/// rastro; sin ellos queda lo que da la API.
pub fn contexto(
    tl: &TimelineDto,
    participants: &[ParticipantDto],
    self_pid: i32,
    g: &crate::gank::Gank,
    serie: Option<&[crate::oleadas::Instante]>,
    pista: Option<&[Fix]>,
) -> Contexto {
    let equipo = participants.get((self_pid - 1) as usize).map(|p| p.teamId).unwrap_or(100);
    let por_rastro = pista.and_then(|p| entrada_en_rastro(g, p));
    let con_resultado = g.outcome != crate::gank::Outcome::Neutral;
    // Los sin resultado ya vienen fechados en su entrada (interpolada).
    let inicio = por_rastro
        .map(|(t, _)| t)
        .unwrap_or(if con_resultado { g.time - RETRASO_KILL } else { g.time });
    let fin = if con_resultado { g.time } else { f64::INFINITY };
    let mut c = Contexto {
        inicio,
        inicio_con_video: por_rastro.is_some(),
        region_entrada: por_rastro.map(|(_, (x, y))| region(x, y)),
        nivel_tuyo: nivel_en(tl, self_pid, inicio),
        r_tuya: tiene_r(tl, self_pid, inicio),
        ..Default::default()
    };
    if let Some(serie) = serie {
        c.zona_oleada = crate::oleadas::en(serie, g.lane, inicio, 8.0).map(|p| zona_del_choque(g.lane, p, equipo));
    }
    let Some(rival) = g.rival else { return c };
    c.nivel_rival = Some(nivel_en(tl, rival, inicio));
    c.r_rival = Some(tiene_r(tl, rival, inicio));
    c.r_rival_vista = r_vista(tl, rival, inicio);
    if let Some((s, x, y, vida)) = fotograma(tl, rival, inicio, FOTOGRAMA_MAX, fin) {
        c.zona_rival = zona_en(g.lane, x, y, equipo, crate::gank::KILL_LANE_WIDTH);
        c.vida_rival = vida.filter(|_| (s - inicio).abs() <= VIDA_MAX);
    }
    // El compañero del mismo puesto que el rival.
    let puesto = |p: &ParticipantDto| if p.teamPosition.is_empty() { p.individualPosition.clone() } else { p.teamPosition.clone() };
    if let Some(r) = participants.get((rival - 1) as usize) {
        let suyo = puesto(r);
        c.nivel_aliado = participants
            .iter()
            .position(|p| p.teamId == equipo && !suyo.is_empty() && puesto(p) == suyo)
            .map(|i| nivel_en(tl, i as i32 + 1, inicio));
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn las_torres_exteriores_son_los_bordes_del_tramo() {
        for lane in Lane::ALL {
            let p = lane.path();
            let (_, ta) = crate::gank::project(lane, p[2].0, p[2].1);
            let (_, tr) = crate::gank::project(lane, p[4].0, p[4].1);
            assert!(entre_torres(lane, ta).abs() < 1e-9, "{lane:?}");
            assert!((entre_torres(lane, tr) - 1.0).abs() < 1e-9, "{lane:?}");
        }
    }

    #[test]
    fn las_zonas_se_ven_al_reves_desde_el_otro_lado() {
        let casos = [
            (0.10, Zona::TorrePropia, Zona::TorreRival),
            (0.28, Zona::PreviaPropia, Zona::PreviaRival),
            (0.50, Zona::Centro, Zona::Centro),
            (0.72, Zona::PreviaRival, Zona::PreviaPropia),
            (0.90, Zona::TorreRival, Zona::TorrePropia),
            // Detrás de una torre exterior sigue siendo su 3.
            (-0.20, Zona::TorrePropia, Zona::TorreRival),
            (1.30, Zona::TorreRival, Zona::TorrePropia),
        ];
        for (f, azul, rojo) in casos {
            assert_eq!(zona_de_fraccion(f, 100), azul, "{f} en azul");
            assert_eq!(zona_de_fraccion(f, 200), rojo, "{f} en rojo");
        }
        for z in Zona::TODAS {
            assert_eq!(z.numero(), match z { Zona::Centro => 1, Zona::PreviaPropia | Zona::PreviaRival => 2, _ => 3 });
        }
    }

    #[test]
    fn el_1_de_las_lineas_laterales_es_la_esquina() {
        // Los codos de bot y top y el centro de mid.
        assert_eq!(zona_en(Lane::Bot, 13400.0, 1500.0, 100, 1300.0), Some(Zona::Centro));
        assert_eq!(zona_en(Lane::Top, 1500.0, 13400.0, 200, 1300.0), Some(Zona::Centro));
        assert_eq!(zona_en(Lane::Mid, 7450.0, 7450.0, 100, 1300.0), Some(Zona::Centro));
        // Al pie de cada torre exterior, el 3 de su dueño.
        assert_eq!(zona_en(Lane::Bot, 10504.0, 1029.0, 100, 1300.0), Some(Zona::TorrePropia));
        assert_eq!(zona_en(Lane::Bot, 13866.0, 4505.0, 100, 1300.0), Some(Zona::TorreRival));
        assert_eq!(zona_en(Lane::Top, 4318.0, 13875.0, 200, 1300.0), Some(Zona::TorrePropia));
        // Lejos del eje no hay zona.
        assert_eq!(zona_en(Lane::Bot, 7000.0, 4500.0, 100, 1300.0), None);
    }

    #[test]
    fn el_mejor_lado_es_el_2_de_tu_torre() {
        // Bot en azul: el 2 de abajo-izquierda, entre tu torre y la esquina.
        let (_, t) = crate::gank::project(Lane::Bot, 11800.0, 1400.0);
        assert_eq!(zona_de_fraccion(entre_torres(Lane::Bot, t), 100), Zona::PreviaPropia);
        // Bot en rojo: el 2 de arriba-derecha.
        let (_, t) = crate::gank::project(Lane::Bot, 13650.0, 3200.0);
        assert_eq!(zona_de_fraccion(entre_torres(Lane::Bot, t), 200), Zona::PreviaPropia);
        assert_eq!(mejor_lado(Lane::Bot), Some(Zona::PreviaPropia));
        assert_eq!(mejor_lado(Lane::Top), Some(Zona::PreviaPropia));
        assert_eq!(mejor_lado(Lane::Mid), None);
    }

    #[test]
    fn el_choque_de_oleadas_se_lee_desde_tu_base() {
        // El choque de oleadas.rs es 0 en tu base: en rojo, 0,2 es su lado azul.
        let (_, t_torre_azul) = crate::gank::project(Lane::Mid, 5846.0, 6396.0);
        assert_eq!(zona_del_choque(Lane::Mid, t_torre_azul, 100), Zona::TorrePropia);
        assert_eq!(zona_del_choque(Lane::Mid, 1.0 - t_torre_azul, 200), Zona::TorreRival);
        assert_eq!(zona_del_choque(Lane::Mid, 0.5, 200), Zona::Centro);
    }

    #[test]
    fn regiones_como_el_video_de_referencia() {
        // Las etiquetas del vídeo, pasadas de la fracción del minimapa (y
        // hacia abajo) a coordenadas de juego.
        let de = |fx: f64, fy: f64| region(fx * MAPA, (1.0 - fy) * MAPA);
        assert_eq!(de(0.505, 0.743), Region::Q2Sur);
        assert_eq!(de(0.469, 0.714), Region::Q2Sur);
        assert_eq!(de(0.466, 0.651), Region::Q2Sur);
        assert_eq!(de(0.258, 0.564), Region::Q1Oeste);
        assert_eq!(de(0.196, 0.479), Region::Q1Oeste);
        assert_eq!(de(0.352, 0.614), Region::Mid);
        assert_eq!(de(0.303, 0.384), Region::RioSuperior);
        assert_eq!(de(0.590, 0.572), Region::RioInferior);
        assert_eq!(de(0.719, 0.643), Region::RioInferior);
        // Los otros dos cuadrantes y las bases.
        assert_eq!(region(11000.0, 6900.0), Region::Q3Este); // azul rojo
        assert_eq!(region(7100.0, 10900.0), Region::Q4Norte);
        assert_eq!(region(500.0, 500.0), Region::BaseAzul);
        assert_eq!(region(14300.0, 14300.0), Region::BaseRoja);
        // Los fosos de Barón y dragón son río.
        assert_eq!(region(5007.0, 10471.0), Region::RioSuperior);
        assert_eq!(region(9866.0, 4414.0), Region::RioInferior);
    }

    #[test]
    fn la_entrada_depende_del_lado() {
        assert_eq!(entrada(Region::Q2Sur, 100), Entrada::TuJungla);
        assert_eq!(entrada(Region::Q2Sur, 200), Entrada::SuJungla);
        assert_eq!(entrada(Region::Q3Este, 200), Entrada::TuJungla);
        assert_eq!(entrada(Region::Q4Norte, 100), Entrada::SuJungla);
        assert_eq!(entrada(Region::RioInferior, 200), Entrada::Rio);
    }

    fn fix(sec: f64, x: f64, y: f64) -> Fix {
        Fix { sec, x, y, anchored: false }
    }

    fn gank(time: f64, outcome: crate::gank::Outcome) -> crate::gank::Gank {
        crate::gank::Gank {
            time,
            precision: 0.0,
            lane: Lane::Bot,
            outcome,
            confidence: 0.9,
            x: 12000,
            y: 1500,
            approach: None,
            rival: None,
        }
    }

    #[test]
    fn la_entrada_es_el_primer_punto_del_tramo_en_la_linea() {
        // Del río inferior a la esquina de bot, y el kill 10 s después.
        let mut pista = vec![fix(300.0, 10500.0, 4200.0), fix(302.0, 11200.0, 3600.0)];
        for k in 0..12 {
            pista.push(fix(304.0 + k as f64, 12200.0 + 50.0 * k as f64, 2300.0 - 50.0 * k as f64));
        }
        let (t, (x, y)) = entrada_en_rastro(&gank(314.0, crate::gank::Outcome::Success), &pista).expect("entrada");
        assert_eq!(t, 304.0);
        assert_eq!(region(x, y), Region::RioInferior);
        // Con un hueco grande justo antes no se te ve entrar.
        let sin_entrada: Vec<Fix> = pista.iter().copied().filter(|f| f.sec >= 304.0 || f.sec < 298.0).collect();
        assert!(entrada_en_rastro(&gank(314.0, crate::gank::Outcome::Success), &sin_entrada).is_none());
        // Llevar un minuto entero en la línea no es entrar.
        let quieto: Vec<Fix> = (0..104)
            .map(|k| fix(200.0 + k as f64, 12500.0, 2000.0))
            .chain(pista.iter().copied().filter(|f| f.sec >= 304.0))
            .collect();
        assert!(entrada_en_rastro(&gank(310.0, crate::gank::Outcome::Success), &quieto).is_none());
    }

    // ------------------------------------------------------------ medición

    use crate::gank::Outcome;
    use std::collections::BTreeMap;

    /// Cuántos ganks de cada fila acabaron en kill, en tu muerte o sin nada.
    #[derive(Default)]
    struct Tabla(BTreeMap<String, [u32; 3]>);

    impl Tabla {
        fn sumar(&mut self, fila: impl Into<String>, o: Outcome) {
            let e = self.0.entry(fila.into()).or_default();
            e[match o {
                Outcome::Success => 0,
                Outcome::Failed => 1,
                Outcome::Neutral => 2,
            }] += 1;
        }

        fn juntar(&mut self, otra: Tabla) {
            for (k, v) in otra.0 {
                let e = self.0.entry(k).or_default();
                (0..3).for_each(|i| e[i] += v[i]);
            }
        }

        /// Kill frente a muerte entre los que tuvieron desenlace, con su
        /// intervalo de Wilson al 95 %. Los «sin resultado» del minuto son
        /// muestra y no censo (ver `crate::gank`), así que no entran en el %.
        fn imprimir(&self, titulo: &str) {
            println!("\n{titulo}");
            println!("  {:24} {:>5} {:>5} {:>5} {:>5}   kill/(kill+muerte)", "", "n", "kill", "muere", "nada");
            for (k, [s, f, n]) in &self.0 {
                let con = s + f;
                let pct = if con > 0 {
                    let (lo, hi) = wilson(*s, con);
                    format!("{:>3.0}%  [{:>3.0}-{:>3.0}]", 100.0 * *s as f64 / con as f64, 100.0 * lo, 100.0 * hi)
                } else {
                    "-".into()
                };
                println!("  {:24} {:>5} {:>5} {:>5} {:>5}   {pct}", k, s + f + n, s, f, n);
            }
        }
    }

    fn wilson(k: u32, n: u32) -> (f64, f64) {
        let (k, n, z) = (k as f64, n as f64, 1.96_f64);
        let p = k / n;
        let d = 1.0 + z * z / n;
        let c = p + z * z / (2.0 * n);
        let a = z * (p * (1.0 - p) / n + z * z / (4.0 * n * n)).sqrt();
        ((c - a) / d, (c + a) / d)
    }

    fn tramo_nivel(d: i32) -> &'static str {
        match d {
            i32::MIN..=-2 => "a: -2 o menos",
            -1 => "b: -1",
            0 => "c: igual",
            1 => "d: +1",
            _ => "e: +2 o más",
        }
    }

    fn tramo_vida(v: f64) -> &'static str {
        if v < 0.5 {
            "a: < 50 %"
        } else if v < 0.8 {
            "b: 50-80 %"
        } else {
            "c: >= 80 %"
        }
    }

    fn zona_o(z: Option<Zona>) -> String {
        z.map(|z| format!("{} {}", z as u8, z.etiqueta())).unwrap_or_else(|| "9 sin dato".into())
    }

    /// Las tablas que salen sólo de la API: valen igual en el corpus.
    #[derive(Default)]
    struct Tablas {
        ganks: u32,
        zona_rival: Tabla,
        zona_rival_lateral: Tabla,
        zona_rival_lado: Tabla,
        nivel_rival: Tabla,
        nivel_linea: Tabla,
        r: Tabla,
        vida: Tabla,
        r_vista_t: Tabla,
        r_vista: u32,
        con_rival: u32,
    }

    impl Tablas {
        fn sumar(&mut self, g: &crate::gank::Gank, c: &Contexto, equipo: i32) {
            let o = g.outcome;
            self.ganks += 1;
            let lateral = if g.lane == Lane::Mid { "mid" } else { "top/bot" };
            let lado = if equipo == 100 { "azul" } else { "rojo" };
            self.zona_rival.sumar(zona_o(c.zona_rival), o);
            self.zona_rival_lateral.sumar(format!("{lateral:7} {}", zona_o(c.zona_rival)), o);
            self.zona_rival_lado.sumar(format!("{lado} {}", zona_o(c.zona_rival)), o);
            if let Some(nr) = c.nivel_rival {
                self.con_rival += 1;
                self.nivel_rival.sumar(tramo_nivel(c.nivel_tuyo - nr), o);
                if let Some(na) = c.nivel_aliado {
                    self.nivel_linea.sumar(tramo_nivel(na - nr), o);
                }
            }
            if let Some(rr) = c.r_rival {
                let fila = match (c.r_tuya, rr) {
                    (true, true) => "las dos",
                    (true, false) => "sólo la tuya",
                    (false, true) => "sólo la suya",
                    (false, false) => "ninguna",
                };
                self.r.sumar(fila, o);
            }
            if let Some(v) = c.vida_rival {
                self.vida.sumar(tramo_vida(v), o);
            }
            self.r_vista += u32::from(c.r_rival_vista.is_some());
            if c.r_rival == Some(true) {
                let fila = match c.r_rival_vista {
                    Some(s) if s < 60.0 => "a: hace < 60 s",
                    Some(_) => "b: hace 60-150 s",
                    None => "c: no vista",
                };
                self.r_vista_t.sumar(fila, o);
            }
        }

        fn juntar(&mut self, o: Tablas) {
            self.ganks += o.ganks;
            self.con_rival += o.con_rival;
            self.r_vista += o.r_vista;
            self.zona_rival.juntar(o.zona_rival);
            self.zona_rival_lateral.juntar(o.zona_rival_lateral);
            self.zona_rival_lado.juntar(o.zona_rival_lado);
            self.nivel_rival.juntar(o.nivel_rival);
            self.nivel_linea.juntar(o.nivel_linea);
            self.r.juntar(o.r);
            self.vida.juntar(o.vida);
            self.r_vista_t.juntar(o.r_vista_t);
        }

        fn imprimir(&self) {
            self.zona_rival.imprimir("Zona del RIVAL (fotograma de la API a <= 20 s del inicio)");
            self.zona_rival_lateral.imprimir("Zona del rival, por tipo de línea");
            self.zona_rival_lado.imprimir("Zona del rival, por tu lado");
            self.nivel_rival.imprimir("Tu nivel - el del rival");
            self.nivel_linea.imprimir("Nivel de tu compañero de línea - el del rival");
            self.r.imprimir("R aprendida (SKILL_LEVEL_UP)");
            self.vida.imprimir("Vida del rival (fotograma a <= 15 s del inicio)");
            self.r_vista_t.imprimir("Rival con R: ¿la usó en una muerte registrada justo antes?");
            println!(
                "\nR del rival vista en el desglose de una muerte en los {R_VISTA_ANTES} s previos: {} de {} ganks con rival",
                self.r_vista, self.con_rival
            );
        }
    }

    /// La teoría del gank sobre tus partidas grabadas: zona de la oleada al
    /// empezar (vídeo), lado de entrada (rastro), y lo que da la API. Sólo lee.
    ///
    /// `LR_REAL=1 cargo test --lib zonas::tests::teoria_del_gank_en_mis_partidas -- --nocapture`
    #[test]
    fn teoria_del_gank_en_mis_partidas() {
        if std::env::var("LR_REAL").is_err() {
            return;
        }
        let mut api = Tablas::default();
        let (mut oleada, mut oleada_lateral, mut mejor, mut entrada_t, mut region_t) =
            (Tabla::default(), Tabla::default(), Tabla::default(), Tabla::default(), Tabla::default());
        let mut zona_entrada = Tabla::default();
        // Oleada del vídeo frente al rival de la API, para saber si el corpus
        // (que no tiene vídeo) mide lo mismo.
        let mut acuerdo: BTreeMap<(String, String), u32> = BTreeMap::new();
        // Dónde está la oleada en cualquier fotograma clave de los primeros 15
        // min: la base con la que comparar dónde ganqueas. Fracción del tramo
        // entre torres vista desde ti, en franjas de 0,05.
        let mut base_zona: BTreeMap<(&'static str, String), u32> = BTreeMap::new();
        let mut base_fino: BTreeMap<(&'static str, i32), u32> = BTreeMap::new();
        let (mut partidas, mut con_inicio) = (0, 0);
        let mut retraso: Vec<f64> = Vec::new();
        for meta in crate::storage::load_all_matches() {
            if meta.is_vod || meta.riot_match_id.is_none() {
                continue;
            }
            let (Some(rm), Some(rtl)) = (crate::storage::load_raw_match(&meta.id), crate::storage::load_raw_timeline(&meta.id)) else {
                continue;
            };
            let (Ok(m), Ok(tl)) = (
                serde_json::from_str::<crate::riot_api::MatchDto>(&rm),
                serde_json::from_str::<TimelineDto>(&rtl),
            ) else {
                continue;
            };
            let ps = &m.info.participants;
            let Some(pid) = meta.participants.iter().position(|q| q.is_self).map(|i| i as i32 + 1) else { continue };
            let equipo = ps[(pid - 1) as usize].teamId;
            let desfase = meta.video_offset.unwrap_or(0.0);
            let serie = std::fs::read_to_string(crate::oleadas::ruta(&meta.id))
                .ok()
                .and_then(|raw| crate::oleadas::instantes(&raw, equipo, desfase));
            let pista = crate::minimap::Positions::load(&meta.id)
                .filter(|p| p.self_participant_id == pid)
                .map(|p| p.follow(&crate::minimap::anclas_de(&tl, pid)))
                .filter(|p| !p.is_empty());
            partidas += 1;
            for i in serie.iter().flatten().filter(|i| i.t_game >= 95.0 && i.t_game <= crate::gank::EARLY_GAME_END) {
                for lane in Lane::ALL {
                    let Some(p) = i.carril[lane as usize] else { continue };
                    let tipo = if lane == Lane::Mid { "mid" } else { "top/bot" };
                    let t_azul = if equipo == 200 { 1.0 - p } else { p };
                    let f = entre_torres(lane, t_azul);
                    let f_tuyo = if equipo == 200 { 1.0 - f } else { f };
                    *base_zona.entry((tipo, zona_o(Some(zona_de_fraccion(f, equipo))))).or_default() += 1;
                    *base_fino.entry((tipo, (f_tuyo / 0.05).floor() as i32)).or_default() += 1;
                }
            }
            let ganks = crate::gank::detect(&tl, pid, ps);
            println!(
                "\n{} {} {} · {} ganks · oleadas {} · rastro {}",
                meta.id,
                meta.champion,
                if equipo == 100 { "azul" } else { "rojo" },
                ganks.len(),
                serie.is_some(),
                pista.is_some()
            );
            for g in &ganks {
                let c = contexto(&tl, ps, pid, g, serie.as_deref(), pista.as_deref());
                api.sumar(g, &c, equipo);
                let o = g.outcome;
                oleada.sumar(zona_o(c.zona_oleada), o);
                let lateral = if g.lane == Lane::Mid { "mid" } else { "top/bot" };
                oleada_lateral.sumar(format!("{lateral:7} {}", zona_o(c.zona_oleada)), o);
                if let (Some(z), Some(m)) = (c.zona_oleada, mejor_lado(g.lane)) {
                    mejor.sumar(if z == m { "en el mejor lado" } else { "en otra zona" }, o);
                }
                let ent = c.region_entrada.map(|r| entrada(r, equipo));
                entrada_t.sumar(ent.map(|e| e.etiqueta()).unwrap_or("sin dato"), o);
                region_t.sumar(c.region_entrada.map(|r| format!("{} {:?}", g.lane.key(), r)).unwrap_or("sin dato".into()), o);
                if let (Some(z), Some(e)) = (c.zona_oleada, ent) {
                    zona_entrada.sumar(format!("{} · {}", z.etiqueta(), e.etiqueta()), o);
                }
                if c.inicio_con_video {
                    con_inicio += 1;
                    retraso.push(g.time - c.inicio);
                }
                if c.zona_oleada.is_some() || c.zona_rival.is_some() {
                    *acuerdo.entry((zona_o(c.zona_oleada), zona_o(c.zona_rival))).or_default() += 1;
                }
                println!(
                    "  {:>5.0}s {:3} {:8} inicio {:>5.0}s{} · oleada {:10} · rival {:10} · entra {:10} · nv {} vs {:?} (línea {:?}) · R {} vs {:?} · vida {:?}",
                    g.time,
                    g.lane.key(),
                    o.key(),
                    c.inicio,
                    if c.inicio_con_video { "v" } else { " " },
                    c.zona_oleada.map(|z| z.etiqueta()).unwrap_or("-"),
                    c.zona_rival.map(|z| z.etiqueta()).unwrap_or("-"),
                    ent.map(|e| e.etiqueta()).unwrap_or("-"),
                    c.nivel_tuyo,
                    c.nivel_rival,
                    c.nivel_aliado,
                    c.r_tuya,
                    c.r_rival,
                    c.vida_rival.map(|v| (v * 100.0).round())
                );
            }
        }
        println!("\n=== {partidas} partidas, {} ganks en los primeros 15 min ===", api.ganks);
        retraso.sort_by(f64::total_cmp);
        let q = |p: f64| retraso.get(((retraso.len().max(1) - 1) as f64 * p) as usize).copied().unwrap_or(f64::NAN);
        println!(
            "inicio por el rastro en {con_inicio} de {}: el gank llega {:.0} / {:.0} / {:.0} s después de pisar la línea (p10/p50/p90)",
            api.ganks,
            q(0.1),
            q(0.5),
            q(0.9)
        );
        println!("\nDónde está la oleada en cualquier fotograma clave (1:35-15:00), base de comparación:");
        for tipo in ["top/bot", "mid"] {
            let total: u32 = base_zona.iter().filter(|((t, _), _)| *t == tipo).map(|(_, n)| n).sum();
            let partes: Vec<String> = base_zona
                .iter()
                .filter(|((t, _), _)| *t == tipo)
                .map(|((_, z), n)| format!("{z} {:.0}%", 100.0 * *n as f64 / total.max(1) as f64))
                .collect();
            println!("  {tipo:7} ({total}): {}", partes.join(" · "));
            let fino: Vec<String> = base_fino
                .iter()
                .filter(|((t, _), _)| *t == tipo)
                .map(|((_, b), n)| format!("{:.2}:{n}", *b as f64 * 0.05))
                .collect();
            println!("          desde tu torre: {}", fino.join(" "));
        }
        oleada.imprimir("Zona de la OLEADA al empezar (minimapa del vídeo)");
        oleada_lateral.imprimir("Zona de la oleada, por tipo de línea");
        mejor.imprimir("Top y bot: oleada en el mejor lado (tu 2) o no");
        entrada_t.imprimir("Por dónde entraste (región justo antes de pisar la línea)");
        region_t.imprimir("Región de entrada por línea");
        zona_entrada.imprimir("Zona de la oleada × entrada");
        api.imprimir();
        println!("\nOleada (vídeo) frente a rival (API), mismos ganks:");
        for ((a, b), n) in &acuerdo {
            println!("  oleada {a:14} rival {b:14} {n}");
        }
    }

    // -------------------------------------------------------------- corpus

    fn ficheros_del_corpus(corpus: &str, paso: usize) -> Vec<std::path::PathBuf> {
        let mut v: Vec<std::path::PathBuf> = std::fs::read_dir(format!("{corpus}/partidas"))
            .into_iter()
            .flatten()
            .flatten()
            .flat_map(|d| std::fs::read_dir(d.path()).into_iter().flatten().flatten().map(|f| f.path()))
            .collect();
        v.sort();
        v.into_iter().step_by(paso.max(1)).collect()
    }

    fn leer_del_corpus(f: &std::path::Path) -> Option<(Vec<ParticipantDto>, TimelineDto)> {
        use std::io::Read;
        let bytes = std::fs::read(f).ok()?;
        let mut texto = String::new();
        flate2::read::GzDecoder::new(&bytes[..]).read_to_string(&mut texto).ok()?;
        let mut d: serde_json::Value = serde_json::from_str(&texto).ok()?;
        let ps = serde_json::from_value(d["match"]["info"]["participants"].take()).ok()?;
        let tl = serde_json::from_value(d["timeline"].take()).ok()?;
        Some((ps, tl))
    }

    /// Lo mismo con la API sola, sobre los junglas del corpus: sin vídeo no hay
    /// oleada ni entrada, pero sí la zona del rival, niveles, R y vida.
    ///
    /// `CORPUS_DIR=D:/lol-corpus [GANK_PASO=1] cargo test --release --lib zonas::tests::teoria_del_gank_en_el_corpus -- --nocapture`
    #[test]
    fn teoria_del_gank_en_el_corpus() {
        let Ok(corpus) = std::env::var("CORPUS_DIR") else { return };
        let paso = std::env::var("GANK_PASO").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
        let ficheros = ficheros_del_corpus(&corpus, paso);
        let hilos = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let t0 = std::time::Instant::now();
        let mut total = Tablas::default();
        let mut partidas = 0usize;
        std::thread::scope(|s| {
            let trozos: Vec<_> = ficheros
                .chunks(ficheros.len().div_ceil(hilos).max(1))
                .map(|trozo| {
                    s.spawn(move || {
                        let (mut t, mut n) = (Tablas::default(), 0usize);
                        for f in trozo {
                            let Some((ps, tl)) = leer_del_corpus(f) else { continue };
                            n += 1;
                            for (i, p) in ps.iter().enumerate() {
                                if p.teamPosition != "JUNGLE" {
                                    continue;
                                }
                                let pid = i as i32 + 1;
                                for g in crate::gank::detect(&tl, pid, &ps) {
                                    let c = contexto(&tl, &ps, pid, &g, None, None);
                                    t.sumar(&g, &c, p.teamId);
                                }
                            }
                        }
                        (t, n)
                    })
                })
                .collect();
            for h in trozos {
                let (t, n) = h.join().unwrap();
                total.juntar(t);
                partidas += n;
            }
        });
        println!("\n{partidas} partidas del corpus, {} ganks de jungla en {:?}", total.ganks, t0.elapsed());
        total.imprimir();
    }
}
