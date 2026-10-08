//! Ruta de jungla: qué campamento hiciste, cuándo, y en qué se te fue el tiempo.
//!
//! Idea tomada de un prototipo ajeno («Minimap Recorder», compartido por Discord
//! el 2026-10-07): seguir al jugador en el minimapa y deducir los campamentos.
//! Allí trabajan en vivo y sin la API, así que infieren el campamento por la
//! firma de oro (ambigua: 15 de oro es krug grande o lobo pequeño). Aquí no
//! hace falta: la POSICIÓN dice qué campamento era, y los súbditos de jungla de
//! la API, minuto a minuto, dicen si de verdad lo mataste.
//!
//! Medido sobre 21 partidas de jungla del usuario (2026-10-07), con las
//! coordenadas de abajo y sin más ajuste: los minutos en que el rastro está en
//! un campamento casan con los minutos en que sube `jungleMinionsKilled` con
//! precisión 90 % y cobertura 76 %, y el primer clear sale al segundo
//! (rapaces 0:51 → red 1:10 → krugs 1:30 → lobos 2:10 → gromp 2:25 → blue 2:40).
//! Los tiempos de reaparición también salen de esos datos: entre dos visitas al
//! mismo campamento pequeño pasan como poco ~2:15 (p10 126-142 s) y en los
//! buffs ~5:00 (p25 304 s).
//!
//! Todo en segundos de PARTIDA. Quien quiera saltar al vídeo suma
//! `video_offset`.

use crate::minimap::{Fix, Positions};
use crate::riot_api::{ParticipantDto, TimelineDto};
use serde::{Deserialize, Serialize};

/// Un campamento: dónde está, de quién es y cuánto tarda en volver.
struct Camp {
    key: &'static str,
    x: f64,
    y: f64,
    /// 100 / 200 = jungla de ese equipo. 0 = río (cangrejos).
    side: i32,
    respawn: f64,
}

const PEQUENO: f64 = 135.0;
const BUFF: f64 = 300.0;
const CANGREJO: f64 = 150.0;

/// Coordenadas aproximadas (centro del campamento), validadas contra el rastro
/// real: con radio 700 el primer clear de cada partida cae en el campamento
/// que toca, en el orden que toca.
const CAMPS: [Camp; 14] = [
    Camp { key: "blue", x: 3800.0, y: 7900.0, side: 100, respawn: BUFF },
    Camp { key: "gromp", x: 2100.0, y: 8450.0, side: 100, respawn: PEQUENO },
    Camp { key: "wolves", x: 3800.0, y: 6500.0, side: 100, respawn: PEQUENO },
    Camp { key: "raptors", x: 6950.0, y: 5450.0, side: 100, respawn: PEQUENO },
    Camp { key: "red", x: 7750.0, y: 4050.0, side: 100, respawn: BUFF },
    Camp { key: "krugs", x: 8400.0, y: 2700.0, side: 100, respawn: PEQUENO },
    Camp { key: "blue", x: 11000.0, y: 6950.0, side: 200, respawn: BUFF },
    Camp { key: "gromp", x: 12700.0, y: 6400.0, side: 200, respawn: PEQUENO },
    Camp { key: "wolves", x: 11000.0, y: 8400.0, side: 200, respawn: PEQUENO },
    Camp { key: "raptors", x: 7850.0, y: 9500.0, side: 200, respawn: PEQUENO },
    Camp { key: "red", x: 7100.0, y: 10850.0, side: 200, respawn: BUFF },
    Camp { key: "krugs", x: 6400.0, y: 12250.0, side: 200, respawn: PEQUENO },
    Camp { key: "scuttle_top", x: 4400.0, y: 9650.0, side: 0, respawn: CANGREJO },
    Camp { key: "scuttle_bot", x: 10450.0, y: 5150.0, side: 0, respawn: CANGREJO },
];

/// A cuánto del centro del campamento cuenta como "estar en él".
const RADIO_CAMP: f64 = 700.0;
/// Lo mínimo que hay que quedarse para que sea un campamento y no un paso:
/// un campamento dura 6-10 s de mediana; cruzarlo andando, 1-2.
const PERMANENCIA_MIN: f64 = 4.0;
/// Dos tramos en el mismo campamento separados por menos que esto son la misma
/// visita (el detector pierde el icono a ratos). Las visitas de verdad están a
/// más de 2 minutos: es lo que tarda en reaparecer.
const FUSION: f64 = 30.0;
/// Distancia al eje de un carril a la que se está "en línea".
const RADIO_LINEA: f64 = 900.0;
/// Más que esto sin farmear entre dos campamentos y la primera vuelta acabó.
const HUECO_VUELTA: f64 = 60.0;
/// Un campamento que reapareció y al que no volviste se deja de contar como
/// "esperándote" pasado esto: a partir de ahí lo más probable es que se lo
/// llevara otro (un compañero, el jungla rival) y el vídeo no lo puede saber.
const ESPERA_MAX_ABIERTA: f64 = 120.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CampClear {
    /// "blue", "gromp", "wolves", "raptors", "red", "krugs", "scuttle_top", "scuttle_bot".
    pub camp: String,
    /// "own", "enemy" o "river".
    pub side: String,
    pub start: f64,
    pub end: f64,
    #[serde(skip)]
    respawn: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TimeBudget {
    pub farming: f64,
    pub moving: f64,
    pub lane: f64,
    pub base: f64,
    pub dead: f64,
    /// Sin rastro en el vídeo (icono tapado o perdido).
    pub unknown: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeathContext {
    pub time: f64,
    /// "farming" (tu jungla), "invading" (jungla rival), "scuttle", "lane",
    /// "river", "own_jungle", "enemy_jungle", "base".
    pub activity: String,
    pub camp: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Route {
    pub video_offset: f64,
    pub game_duration: f64,
    pub clears: Vec<CampClear>,
    /// Campamentos de la primera vuelta (hasta la primera vuelta a base).
    pub first_clear_camps: usize,
    /// Cuándo acabó el último campamento de esa vuelta.
    pub first_clear_end: Option<f64>,
    /// Si en esa vuelta cayeron los seis campamentos propios.
    pub full_clear: bool,
    pub recalls: Vec<f64>,
    pub budget: TimeBudget,
    pub invades: usize,
    pub scuttles: usize,
    /// Retraso medio, en segundos, entre que un campamento tuyo reaparece y
    /// vuelves a hacerlo. Sólo con las vueltas que sí hiciste.
    pub mean_delay: Option<f64>,
    pub delays: usize,
    pub deaths: Vec<DeathContext>,
    /// Fracción de la partida con tu icono localizado en el vídeo.
    pub coverage: f64,
    /// De los minutos en que la API dice que mataste monstruos de jungla, en
    /// cuántos vio el rastro un campamento. Por debajo de `ACUERDO_MIN` la ruta
    /// no es de fiar (el rastro siguió a otro icono).
    pub agreement: f64,
}

/// Por debajo de esto la interfaz avisa de que la ruta es dudosa. Medido: 21
/// de 22 partidas quedan entre 0,6 y 1; la que sigue a otro icono, en 0,4.
pub const ACUERDO_MIN: f64 = 0.6;

/// ¿Jugó de jungla el jugador grabado?
/// Dónde está un campamento, por su nombre y el equipo dueño de esa jungla
/// (100/200; los cangrejos valen con cualquiera).
pub fn posicion_campamento(key: &str, equipo: i32) -> Option<(f64, f64)> {
    CAMPS
        .iter()
        .find(|c| c.key == key && (c.side == equipo || c.side == 0))
        .map(|c| (c.x, c.y))
}

pub fn es_jungla(participants: &[ParticipantDto], pid: i32) -> bool {
    participants
        .get((pid - 1) as usize)
        .map(|p| p.teamPosition == "JUNGLE" || (p.teamPosition.is_empty() && p.individualPosition == "JUNGLE"))
        .unwrap_or(false)
}

/// Zona de un punto, con los mismos cortes que `riftZones.ts` (Patrones), pero
/// dicha desde el lado del jugador.
fn zona(x: f64, y: f64, equipo: i32) -> &'static str {
    let (u, v) = (x / 14820.0, y / 14881.0);
    let base_azul = u.hypot(v) < 0.29;
    let base_roja = (1.0 - u).hypot(1.0 - v) < 0.29;
    if base_azul || base_roja {
        return if base_azul == (equipo == 100) { "base" } else { "enemy_base" };
    }
    let top = (u < 0.14 && v > 0.2) || (v > 0.86 && u < 0.8);
    let bot = (v < 0.14 && u > 0.2) || (u > 0.86 && v < 0.8);
    if top || bot || (u - v).abs() < 0.075 {
        return "lane";
    }
    if (u + v - 1.0).abs() < 0.1 {
        return "river";
    }
    let lado_azul = u + v < 1.0;
    if lado_azul == (equipo == 100) { "own_jungle" } else { "enemy_jungle" }
}

/// La posición más cercana del rastro a `t`, si hay una a menos de 1,5 s.
fn fix_en(pista: &[Fix], t: f64) -> Option<&Fix> {
    let i = pista.partition_point(|f| f.sec < t);
    [i.checked_sub(1), Some(i)]
        .into_iter()
        .flatten()
        .filter_map(|j| pista.get(j))
        .filter(|f| (f.sec - t).abs() <= 1.5)
        .min_by(|a, b| (a.sec - t).abs().total_cmp(&(b.sec - t).abs()))
}

/// Súbditos de jungla acumulados por minuto, como (instante, total).
fn jungla_por_minuto(tl: &TimelineDto, pid: i32) -> Vec<(f64, i32)> {
    let k = pid.to_string();
    tl.info
        .frames
        .iter()
        .filter_map(|f| Some((f.timestamp as f64 / 1000.0, f.participantFrames.get(&k)?.jungleMinionsKilled)))
        .collect()
}

/// ¿Subieron los súbditos de jungla entre el minuto anterior a `a` y el
/// siguiente a `b`? Si no, estuviste en el campamento pero no lo mataste
/// (pasabas, esperabas a que apareciera, te fuiste a mitad).
fn confirmada(jcs: &[(f64, i32)], a: f64, b: f64) -> bool {
    let antes = jcs.iter().rev().find(|(t, _)| *t <= a).map(|x| x.1);
    let despues = jcs.iter().find(|(t, _)| *t >= b).map(|x| x.1);
    match (antes, despues) {
        (Some(x), Some(y)) => y > x,
        // Pasada la última foto de la API no hay con qué cerrar: se da por buena.
        (Some(_), None) => true,
        _ => false,
    }
}

/// Intervalos en que el jugador estuvo muerto, con el temporizador de Riot.
pub(crate) fn muertes(tl: &TimelineDto, pid: i32) -> Vec<(f64, f64, Option<(f64, f64)>)> {
    let frames = &tl.info.frames;
    frames
        .iter()
        .flat_map(|f| f.events.iter())
        .filter(|e| e.event_type == "CHAMPION_KILL" && e.victimId == pid)
        .map(|e| {
            let t = e.timestamp as f64 / 1000.0;
            let m = ((t / 60.0).floor() as usize).min(frames.len().saturating_sub(1));
            let nivel = frames
                .get(m)
                .and_then(|f| f.participantFrames.get(&pid.to_string()))
                .map(|p| p.level)
                .filter(|l| *l > 0)
                .unwrap_or(1);
            let pos = e.position.as_ref().map(|p| (p.x as f64, p.y as f64));
            (t, t + crate::attribution::death_timer(nivel, t / 60.0), pos)
        })
        .collect()
}

/// Visitas a la tienda: tandas de compras (y ventas) a menos de 45 s entre sí.
/// Devuelve `(inicio, fin, tras_morir)`; `tras_morir` = compraste al reaparecer,
/// no volviste a base. Las compras del arranque (<1 min) no cuentan.
pub(crate) fn visitas_a_base(tl: &TimelineDto, pid: i32, muertos: &[(f64, f64, Option<(f64, f64)>)]) -> Vec<(f64, f64, bool)> {
    let mut compras: Vec<f64> = tl
        .info
        .frames
        .iter()
        .flat_map(|f| f.events.iter())
        .filter(|e| (e.event_type == "ITEM_PURCHASED" || e.event_type == "ITEM_SOLD") && e.participantId == pid)
        .map(|e| e.timestamp as f64 / 1000.0)
        .filter(|t| *t >= 60.0)
        .collect();
    compras.sort_by(|a, b| a.total_cmp(b));
    let mut tandas: Vec<(f64, f64)> = Vec::new();
    for t in compras {
        match tandas.last_mut() {
            Some(v) if t - v.1 <= 45.0 => v.1 = t,
            _ => tandas.push((t, t)),
        }
    }
    tandas
        .into_iter()
        .map(|(a, b)| (a, b, muertos.iter().any(|(m, fin, _)| a >= *m && a <= fin + 60.0)))
        .collect()
}

/// Construye la ruta de la partida. `None` si el rastro no da para nada.
pub fn build(tl: &TimelineDto, participants: &[ParticipantDto], pos: &Positions) -> Option<Route> {
    let pid = pos.self_participant_id;
    let equipo = participants.get((pid - 1) as usize)?.teamId;
    let anclas = crate::minimap::anclas_de(tl, pid);
    let pista = pos.follow(&anclas);
    if pista.is_empty() {
        return None;
    }
    let duracion = tl.info.frames.last()?.timestamp as f64 / 1000.0;
    let jcs = jungla_por_minuto(tl, pid);
    let muertos = muertes(tl, pid);

    // --- Visitas: tramos seguidos junto a un mismo campamento.
    let mut tramos: Vec<(usize, f64, f64)> = Vec::new();
    for f in &pista {
        let cerca = CAMPS
            .iter()
            .enumerate()
            .map(|(i, c)| (i, (c.x - f.x).hypot(c.y - f.y)))
            .filter(|(_, d)| *d <= RADIO_CAMP)
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(i, _)| i);
        let Some(i) = cerca else { continue };
        match tramos.last_mut() {
            Some(t) if t.0 == i && f.sec - t.2 <= FUSION => t.2 = f.sec,
            _ => tramos.push((i, f.sec, f.sec)),
        }
    }
    let lado = |c: &Camp| match c.side {
        0 => "river",
        s if s == equipo => "own",
        _ => "enemy",
    };
    let clears: Vec<CampClear> = tramos
        .into_iter()
        .filter(|(_, a, b)| b - a >= PERMANENCIA_MIN)
        .filter(|(_, a, b)| confirmada(&jcs, *a, *b))
        .map(|(i, a, b)| CampClear {
            camp: CAMPS[i].key.to_string(),
            side: lado(&CAMPS[i]).to_string(),
            start: a,
            end: b,
            respawn: CAMPS[i].respawn,
        })
        .collect();

    // --- Vueltas a base, de las COMPRAS: sólo se compra en la tienda de la
    // base, y la API da cada compra al milisegundo. El icono en la fuente no
    // sirve: al volver a base el rastro "salta" más de lo que permite la
    // velocidad y lo pierde (salían 0 vueltas en partidas de 30 minutos).
    let visitas = visitas_a_base(tl, pid, &muertos);
    let recalls: Vec<f64> = visitas.iter().filter(|v| !v.2).map(|v| v.0).collect();

    // --- Primera vuelta: campamentos distintos seguidos desde el principio.
    // Se corta al repetir uno (ya es la segunda vuelta) o al pasar más de
    // `HUECO_VUELTA` sin farmear (fuiste a ganquear o a invadir). Una vuelta a
    // base NO la corta: en 8 de 22 partidas el usuario vuelve a base tras tres
    // campamentos (~1:58) y sigue con los otros tres.
    let mut primera: Vec<&CampClear> = Vec::new();
    for c in &clears {
        let antes = primera.iter().rev().find(|p| p.camp == c.camp && p.side == c.side);
        // Ningún campamento vuelve antes de 2:15: "repetir" uno al minuto es
        // la misma limpieza tras una pasada por delante (red antes de krugs).
        if let Some(p) = antes {
            if c.start - p.end < 100.0 {
                continue;
            }
        }
        let hueco = primera.last().is_some_and(|p| c.start - p.end > HUECO_VUELTA);
        if antes.is_some() || hueco || c.start > 360.0 {
            break;
        }
        primera.push(c);
        if primera.iter().filter(|p| p.side == "own").count() == 6 {
            break;
        }
    }
    let propias: std::collections::HashSet<&str> =
        primera.iter().filter(|c| c.side == "own").map(|c| c.camp.as_str()).collect();

    // --- Acuerdo con la API: de los minutos en que subieron tus súbditos de
    // jungla, en cuántos vio el rastro un campamento. Bajo, el rastro sigue a
    // otro icono buena parte de la partida (pasa: medido 0,4 en una de 22).
    let mut con_cs = 0usize;
    let mut con_visita = 0usize;
    for par in jcs.windows(2) {
        if par[1].1 > par[0].1 {
            con_cs += 1;
            if clears.iter().any(|c| c.end >= par[0].0 && c.start <= par[1].0) {
                con_visita += 1;
            }
        }
    }

    // --- Retraso al recoger: reaparece → vuelves.
    let mut retrasos = Vec::new();
    for camp in CAMPS.iter().filter(|c| c.side == equipo) {
        let suyas: Vec<&CampClear> = clears.iter().filter(|c| c.side == "own" && c.camp == camp.key).collect();
        for par in suyas.windows(2) {
            let vuelve = par[0].end + camp.respawn;
            // Volver "antes" de que reaparezca es una visita mal leída (o una
            // pasada que la API confirmó por otro campamento): no es un dato.
            if par[1].start >= vuelve - 20.0 {
                retrasos.push((par[1].start - vuelve).max(0.0));
            }
        }
    }

    // --- En qué se fue cada segundo.
    let mut budget = TimeBudget::default();
    let mut vistos = 0usize;
    let mut t = 0.0;
    while t < duracion {
        if muertos.iter().any(|(a, b, _)| t >= *a && t < *b) {
            budget.dead += 1.0;
        } else if visitas.iter().any(|(a, b, _)| t >= a - 2.0 && t <= b + 15.0) {
            // Llegar, comprar y salir de la fuente.
            budget.base += 1.0;
            if fix_en(&pista, t).is_some() {
                vistos += 1;
            }
        } else if let Some(f) = fix_en(&pista, t) {
            vistos += 1;
            if clears.iter().any(|c| t >= c.start && t <= c.end) {
                budget.farming += 1.0;
            } else if zona(f.x, f.y, equipo) == "base" {
                budget.base += 1.0;
            } else if crate::gank::lane_at(f.x, f.y, RADIO_LINEA).is_some() || zona(f.x, f.y, equipo) == "lane" {
                budget.lane += 1.0;
            } else {
                budget.moving += 1.0;
            }
        } else {
            budget.unknown += 1.0;
        }
        t += 1.0;
    }

    // --- Qué hacías al morir.
    let deaths = muertos
        .iter()
        .map(|(t, _, p)| {
            let haciendo = clears.iter().find(|c| *t >= c.start - 5.0 && *t <= c.end + 8.0);
            let (activity, camp) = match haciendo {
                Some(c) if c.side == "own" => ("farming", Some(c.camp.clone())),
                Some(c) if c.side == "enemy" => ("invading", Some(c.camp.clone())),
                Some(c) => ("scuttle", Some(c.camp.clone())),
                None => {
                    let donde = p.or_else(|| fix_en(&pista, *t).map(|f| (f.x, f.y)));
                    let z = donde.map(|(x, y)| zona(x, y, equipo)).unwrap_or("lane");
                    (if z == "enemy_base" { "lane" } else { z }, None)
                }
            };
            DeathContext { time: *t, activity: activity.to_string(), camp }
        })
        .collect();

    Some(Route {
        video_offset: pos.video_offset,
        game_duration: duracion,
        first_clear_camps: primera.len(),
        first_clear_end: primera.iter().rev().find(|c| c.side == "own").map(|c| c.end),
        full_clear: propias.len() == 6,
        invades: clears.iter().filter(|c| c.side == "enemy").count(),
        scuttles: clears.iter().filter(|c| c.side == "river").count(),
        mean_delay: (!retrasos.is_empty()).then(|| retrasos.iter().sum::<f64>() / retrasos.len() as f64),
        delays: retrasos.len(),
        coverage: vistos as f64 / duracion.max(1.0),
        agreement: if con_cs > 0 { con_visita as f64 / con_cs as f64 } else { 0.0 },
        recalls,
        budget,
        deaths,
        clears,
    })
}

impl Route {
    /// Fracción de `[a, b]` en que tenías al menos un campamento propio vivo
    /// esperándote: reapareció tras tu última limpieza y aún no volviste.
    ///
    /// Antes de tu primera limpieza de un campamento no se sabe cuándo apareció
    /// ni si alguien lo tocó, así que no cuenta. Y uno al que nunca volviste
    /// deja de contar `ESPERA_MAX_ABIERTA` después de reaparecer.
    pub fn camp_waiting_fraction(&self, a: f64, b: f64) -> f64 {
        if b <= a {
            return 0.0;
        }
        let propias: Vec<&CampClear> = self.clears.iter().filter(|c| c.side == "own").collect();
        let mut esperas: Vec<(f64, f64)> = Vec::new();
        for (i, c) in propias.iter().enumerate() {
            let vuelve = c.end + c.respawn;
            let siguiente = propias[i + 1..].iter().find(|d| d.camp == c.camp).map(|d| d.start);
            let hasta = siguiente.unwrap_or(vuelve + ESPERA_MAX_ABIERTA);
            if hasta > vuelve {
                esperas.push((vuelve, hasta));
            }
        }
        let mut dentro = 0.0;
        let mut t = a;
        while t < b {
            if esperas.iter().any(|(x, y)| t >= *x && t < *y) {
                dentro += 1.0;
            }
            t += 1.0;
        }
        (dentro / (b - a).ceil()).min(1.0)
    }
}

// ---------------------------------------------------------------- caché y comandos

/// Subir el número rehace todas las rutas guardadas.
// v2: vueltas a base por compras, no por el icono en la fuente.
const ROUTE_CACHE_V: u32 = 4; // v4: rastro con el recuadro de la cámara

#[derive(Serialize, Deserialize)]
struct RouteCache {
    v: u32,
    stamp: u64,
    route: Option<Route>,
    /// "ok", "not_jungle" o "no_track".
    status: String,
}

#[derive(Serialize)]
pub struct RouteResponse {
    /// "ok", "not_jungle", "no_minimap", "no_riot" o "no_track".
    pub status: String,
    pub route: Option<Route>,
}

fn calcular(id: &str) -> RouteResponse {
    let resp = |status: &str, route: Option<Route>| RouteResponse { status: status.to_string(), route };
    let (Some(raw), Some(raw_tl)) = (crate::storage::load_raw_match(id), crate::storage::load_raw_timeline(id)) else {
        return resp("no_riot", None);
    };
    let Some(pos) = Positions::load(id) else {
        return resp("no_minimap", None);
    };
    let stamp = crate::riot_api::huella_de_fuentes(id);
    let ruta_cache = crate::storage::get_match_dir(id).join("jungle_route_v1.json");
    if let Some(c) = std::fs::read_to_string(&ruta_cache)
        .ok()
        .and_then(|s| serde_json::from_str::<RouteCache>(&s).ok())
        .filter(|c| c.v == ROUTE_CACHE_V && c.stamp == stamp)
    {
        return resp(&c.status, c.route);
    }
    let (Ok(m), Ok(tl)) = (
        serde_json::from_str::<crate::riot_api::MatchDto>(&raw),
        serde_json::from_str::<TimelineDto>(&raw_tl),
    ) else {
        return resp("no_riot", None);
    };
    let (status, route) = if !es_jungla(&m.info.participants, pos.self_participant_id) {
        ("not_jungle", None)
    } else {
        match build(&tl, &m.info.participants, &pos) {
            Some(r) => ("ok", Some(r)),
            None => ("no_track", None),
        }
    };
    let c = RouteCache { v: ROUTE_CACHE_V, stamp, route, status: status.to_string() };
    if let Ok(s) = serde_json::to_string(&c) {
        let _ = std::fs::write(&ruta_cache, s);
    }
    resp(status, c.route)
}

/// La ruta de jungla de una partida.
#[tauri::command]
pub async fn get_jungle_route(match_id: String) -> RouteResponse {
    tokio::task::spawn_blocking(move || calcular(&match_id))
        .await
        .unwrap_or(RouteResponse { status: "no_riot".into(), route: None })
}

/// Lo que aporta una partida al resumen de Patrones.
#[derive(Serialize)]
pub struct RouteGame {
    pub match_id: String,
    pub date: String,
    pub champion: String,
    pub result: String,
    pub route: Route,
}

/// Todas las partidas de jungla con ruta, de la más reciente a la más vieja.
/// Los filtros (periodo, puesto) los aplica Patrones, como con el resto.
#[tauri::command]
pub async fn get_jungle_routes() -> Vec<RouteGame> {
    tokio::task::spawn_blocking(|| {
        let mut out: Vec<RouteGame> = crate::storage::load_all_matches()
            .into_iter()
            .filter(|m| !m.is_vod && m.riot_match_id.is_some())
            .filter_map(|m| {
                let route = calcular(&m.id).route?;
                Some(RouteGame { match_id: m.id, date: m.date, champion: m.champion, result: m.result, route })
            })
            .collect();
        out.sort_by(|a, b| b.date.cmp(&a.date));
        out
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zonas_desde_cada_lado() {
        // Jungla de abajo a la izquierda: tuya si eres azul, rival si rojo.
        assert_eq!(zona(3800.0, 6500.0, 100), "own_jungle");
        assert_eq!(zona(3800.0, 6500.0, 200), "enemy_jungle");
        assert_eq!(zona(400.0, 400.0, 100), "base");
        assert_eq!(zona(400.0, 400.0, 200), "enemy_base");
        assert_eq!(zona(7400.0, 7450.0, 100), "lane");
    }

    #[test]
    fn confirmar_con_la_api() {
        let jcs = vec![(0.0, 0), (60.0, 0), (120.0, 4), (180.0, 4)];
        assert!(confirmada(&jcs, 70.0, 80.0));
        assert!(!confirmada(&jcs, 130.0, 140.0));
    }

    fn clear(camp: &str, start: f64, end: f64, respawn: f64) -> CampClear {
        CampClear { camp: camp.into(), side: "own".into(), start, end, respawn }
    }

    fn ruta(clears: Vec<CampClear>) -> Route {
        Route {
            video_offset: 0.0, game_duration: 1800.0, clears, first_clear_camps: 0, first_clear_end: None,
            full_clear: false, recalls: vec![], budget: TimeBudget::default(), invades: 0, scuttles: 0,
            mean_delay: None, delays: 0, deaths: vec![], coverage: 1.0, agreement: 1.0,
        }
    }

    #[test]
    fn campamento_esperando() {
        // Gromp hecho a los 100-110: reaparece a los 245. Vuelves a los 300.
        let r = ruta(vec![clear("gromp", 100.0, 110.0, 135.0), clear("gromp", 300.0, 308.0, 135.0)]);
        assert_eq!(r.camp_waiting_fraction(200.0, 240.0), 0.0);
        assert!((r.camp_waiting_fraction(250.0, 290.0) - 1.0).abs() < 1e-9);
        // Tras la segunda limpieza nunca vuelves: cuenta 120 s y se cierra.
        assert!(r.camp_waiting_fraction(443.0, 453.0) > 0.99);
        assert_eq!(r.camp_waiting_fraction(600.0, 620.0), 0.0);
    }

    /// Con datos reales: `MIS_PARTIDAS_DIR=C:/Users/Alejandro/Videos/LeagueRecorder
    /// cargo test --lib ruta_en_mis_partidas -- --nocapture`. Sin la variable no hace nada.
    #[test]
    fn ruta_en_mis_partidas() {
        let Ok(dir) = std::env::var("MIS_PARTIDAS_DIR") else { return };
        let mut dirs: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).collect();
        dirs.sort();
        let mmss = |s: f64| format!("{}:{:02}", (s / 60.0) as i64, (s % 60.0) as i64);
        let (mut n, mut fc, mut full) = (0, Vec::new(), 0);
        for d in dirs {
            let (Ok(raw), Ok(rtl), Ok(rp)) = (
                std::fs::read_to_string(d.join("riot_match.json")),
                std::fs::read_to_string(d.join("riot_timeline.json")),
                std::fs::read_to_string(d.join("minimap_positions.json")),
            ) else { continue };
            let m: crate::riot_api::MatchDto = serde_json::from_str(&raw).unwrap();
            let tl: TimelineDto = serde_json::from_str(&rtl).unwrap();
            let pos = Positions::from_json(&rp).unwrap();
            if !es_jungla(&m.info.participants, pos.self_participant_id) { continue }
            let Some(r) = build(&tl, &m.info.participants, &pos) else { continue };
            n += 1;
            if let Some(e) = r.first_clear_end { fc.push(e); }
            full += usize::from(r.full_clear);
            let b = &r.budget;
            println!(
                "{} cob {:.0}% acuerdo {:.0}% · {} campamentos · 1er clear {} ({} camps{}) · invasiones {} · cangrejos {} · bases {} · retraso medio {} ({})",
                d.file_name().unwrap().to_string_lossy(), r.coverage * 100.0, r.agreement * 100.0, r.clears.len(),
                r.first_clear_end.map(mmss).unwrap_or("-".into()), r.first_clear_camps,
                if r.full_clear { ", completo" } else { "" }, r.invades, r.scuttles, r.recalls.len(),
                r.mean_delay.map(|x| format!("{x:.0}s")).unwrap_or("-".into()), r.delays,
            );
            println!(
                "   tiempo: farmeo {:.0} · moviéndote {:.0} · línea {:.0} · base {:.0} · muerto {:.0} · sin rastro {:.0} (min)",
                b.farming / 60.0, b.moving / 60.0, b.lane / 60.0, b.base / 60.0, b.dead / 60.0, b.unknown / 60.0
            );
            let ruta: Vec<String> = r.clears.iter().take(8).map(|c| format!("{}{} {}", if c.side == "enemy" { "*" } else { "" }, c.camp, mmss(c.start))).collect();
            println!("   {}", ruta.join(" → "));
            let muertes: Vec<String> = r.deaths.iter().map(|x| format!("{} {}{}", mmss(x.time), x.activity, x.camp.as_ref().map(|c| format!("({c})")).unwrap_or_default())).collect();
            println!("   muertes: {}", muertes.join(", "));
        }
        fc.sort_by(|a, b| a.total_cmp(b));
        println!("
{n} partidas · primer clear mediana {} · completos {full}", fc.get(fc.len() / 2).map(|x| mmss(*x)).unwrap_or_default());
    }
}
