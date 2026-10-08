//! Las oleadas y las decisiones de macro que dependen de ellas.
//!
//! El consejo que llegó por Discord (2026-10-07) era no buscar patrones
//! mágicos sino cosas concretas: "para invadir, las dos líneas de al lado
//! tienen que estar empujadas a tu favor, para que sus laners no puedan rotar
//! a salvar a su jungla". Para eso hace falta saber dónde está cada oleada, y
//! eso lo dice el minimapa: los súbditos son puntitos azules (los tuyos,
//! siempre visibles) y rojos (los rivales, con visión). Los lee
//! `python_scripts/oleadas.py` en los fotogramas clave del vídeo, uno cada
//! ~4 s, y deja `oleadas.json` en la carpeta de la partida.
//!
//! # El macro correcto, escrito
//!
//! Antes de juzgar hay que decir qué es lo correcto. Tres reglas, de las que
//! coinciden todas las guías y que el minimapa puede comprobar:
//!
//! 1. **Invadir** la jungla rival: con los dos carriles cercanos (el del lado
//!    del campamento y mid) empujados a tu favor. Si no, sus laners llegan
//!    antes que los tuyos.
//! 2. **Ganquear**: con la oleada de ese carril de TU lado (el rival
//!    sobreextendido, lejos de su torre). Con la oleada bajo su torre es un
//!    *dive*, mucho más caro.
//! 3. **Objetivos** (dragón, Barón, Heraldo, larvas, Atakhan): con prioridad
//!    en los carriles cercanos (bot y mid para el dragón; top y mid para el
//!    resto) en el minuto previo.
//!
//! "Empujado a tu favor" = el choque de oleadas está pasada la mitad del
//! carril, hacia la base rival. La posición se mide sobre el eje del carril
//! de [`crate::gank`], de 0 (tu base) a 1 (la suya).

use serde::{Deserialize, Serialize};

use crate::gank::Lane;
use crate::riot_api::{MatchDto, TimelineDto};

pub const FICHERO: &str = "oleadas.json";

/// Un súbdito a más de esto del eje no es de ese carril (jungla, río, base).
const RADIO_CARRIL: f64 = 900.0;
/// Alrededor de una torre o inhibidor, lo que se lee es su icono, no súbditos:
/// los rivales tienen el mismo rojo que sus súbditos.
const RADIO_ESTRUCTURA: f64 = 420.0;
/// Por encima, el choque está en su mitad: carril empujado a tu favor.
pub const EMPUJADO: f64 = 0.5;
/// Gank con la oleada en tu lado: el rival está lejos de su torre.
const LADO_PROPIO: f64 = 0.45;
/// Gank con la oleada más allá de esto: bajo su torre exterior, un diveo.
const BAJO_SU_TORRE: f64 = 0.62;
/// Antes de esto no han chocado aún las primeras oleadas.
const PRIMERAS_OLEADAS: f64 = 95.0;

/// Torres, inhibidores y nexos de la Grieta, en coordenadas de juego.
const ESTRUCTURAS: [(f64, f64); 30] = [
    (981.0, 10441.0), (1512.0, 6699.0), (1169.0, 4287.0),
    (5846.0, 6396.0), (5048.0, 4812.0), (3651.0, 3696.0),
    (10504.0, 1029.0), (6919.0, 1483.0), (4281.0, 1253.0),
    (1748.0, 2270.0), (2177.0, 1807.0),
    (1171.0, 3571.0), (3203.0, 3208.0), (3452.0, 1236.0), (1551.0, 1659.0),
    (4318.0, 13875.0), (7943.0, 13411.0), (10481.0, 13650.0),
    (8955.0, 8510.0), (9767.0, 10113.0), (11134.0, 11207.0),
    (13866.0, 4505.0), (13327.0, 8226.0), (13624.0, 10572.0),
    (12611.0, 13084.0), (13052.0, 12612.0),
    (11261.0, 13676.0), (11598.0, 11667.0), (13604.0, 11316.0), (13144.0, 13174.0),
];

#[derive(Deserialize)]
struct Fichero {
    frames: Vec<FrameRaw>,
}

#[derive(Deserialize)]
struct FrameRaw {
    #[serde(default)]
    t: f64,
    a: Vec<[f64; 2]>,
    e: Vec<[f64; 2]>,
}

/// Dónde está el choque de cada carril en un instante: 0 = tu base, 1 = la
/// suya. `None` si no se ve ninguna oleada en ese carril.
#[derive(Debug, Clone, Copy)]
pub struct Instante {
    pub t_game: f64,
    pub carril: [Option<f64>; 3],
}

fn idx(l: Lane) -> usize {
    match l {
        Lane::Top => 0,
        Lane::Mid => 1,
        Lane::Bot => 2,
    }
}

fn percentil(v: &mut [f64], p: f64) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(f64::total_cmp);
    Some(v[((v.len() - 1) as f64 * p).round() as usize])
}

/// Posición de cada punto en su carril, ya "hacia la base rival" (0..1).
fn por_carril(puntos: &[[f64; 2]], equipo: i32) -> [Vec<f64>; 3] {
    let mut out: [Vec<f64>; 3] = Default::default();
    for &[x, y] in puntos {
        if ESTRUCTURAS.iter().any(|(sx, sy)| (sx - x).hypot(sy - y) < RADIO_ESTRUCTURA) {
            continue;
        }
        if let Some((lane, _, t)) = crate::gank::lane_at(x, y, RADIO_CARRIL) {
            out[idx(lane)].push(if equipo == 100 { t } else { 1.0 - t });
        }
    }
    out
}

/// El choque de un carril con lo que se ve: la punta de tu oleada (la más
/// adelantada, sin el súbdito suelto) y, si se ve, la de la suya.
pub fn choque(aliados: &mut [f64], rivales: &mut [f64]) -> Option<f64> {
    let tuya = percentil(aliados, 0.9)?;
    match percentil(rivales, 0.1) {
        // Las dos a la vista y cerca: el choque está entre ellas. Lejos, lo
        // de los suyos que se ve es otra oleada (la que acaba de salir de su
        // base, vista por un centinela) y no dice dónde está el choque.
        Some(suya) if (suya - tuya).abs() < 0.25 => Some((tuya + suya) / 2.0),
        Some(_) => Some(tuya),
        // Sólo la tuya, y pegada a tu base: es la que acaba de salir, no
        // donde está el carril. Si la suya estuviera empujando hasta ahí se
        // vería (bajo tus torres tienes visión). Medido en una partida: a los
        // 6 min los tres carriles daban 0,05-0,10 por esto.
        None if tuya < SALIDA => None,
        None => Some(tuya),
    }
}

/// Hasta aquí llega una oleada recién salida antes de cruzarse con nada.
const SALIDA: f64 = 0.3;

pub fn instantes(raw: &str, equipo: i32, desfase: f64) -> Option<Vec<Instante>> {
    let f: Fichero = serde_json::from_str(raw).ok()?;
    Some(
        f.frames
            .into_iter()
            .map(|fr| {
                let mut a = por_carril(&fr.a, equipo);
                let mut e = por_carril(&fr.e, equipo);
                let mut carril = [None; 3];
                for i in 0..3 {
                    carril[i] = choque(&mut a[i], &mut e[i]);
                }
                Instante { t_game: fr.t - desfase, carril }
            })
            .collect(),
    )
}

/// El choque de un carril en torno a `t` (segundos de partida): la mediana de
/// lo leído entre `t - antes` y `t + 2`. Con un fotograma clave cada ~4 s
/// suelen entrar 2-3 lecturas.
pub fn en(serie: &[Instante], lane: Lane, t: f64, antes: f64) -> Option<f64> {
    let mut v: Vec<f64> = serie
        .iter()
        .filter(|i| i.t_game >= t - antes && i.t_game <= t + 2.0)
        .filter_map(|i| i.carril[idx(lane)])
        .collect();
    if v.is_empty() {
        return None;
    }
    v.sort_by(f64::total_cmp);
    Some(v[v.len() / 2])
}

#[derive(Debug, Clone, Serialize)]
pub struct LanePush {
    pub lane: &'static str,
    /// 0 = tu base, 1 = la suya. `None`: sin oleada a la vista.
    pub push: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InvadeCheck {
    pub t_game: f64,
    pub t_video: f64,
    pub camp: String,
    pub lanes: Vec<LanePush>,
    /// "prio" (los dos empujados), "half" (uno), "none", "early" (antes de
    /// que choquen las oleadas) o "unknown".
    pub verdict: &'static str,
    pub died: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct GankCheck {
    pub t_game: f64,
    pub t_video: f64,
    pub lane: &'static str,
    pub push: Option<f64>,
    /// "good" (oleada en tu lado), "even", "dive" (bajo su torre), "unknown".
    pub setup: &'static str,
    /// "success", "neutral", "failed".
    pub outcome: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct ObjectiveCheck {
    pub t_game: f64,
    pub t_video: f64,
    /// "DRAGON", "BARON_NASHOR", "RIFTHERALD", "HORDE", "ATAKHAN".
    pub kind: String,
    pub ours: bool,
    pub lanes: Vec<LanePush>,
    /// "prio", "half", "none" o "unknown", con las mismas reglas que la invasión.
    pub verdict: &'static str,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct WavesReport {
    /// "ok", "no_waves" (sin leer), "reading", "unreadable", "no_riot".
    pub status: String,
    pub matches: usize,
    /// `[t_partida, top, mid, bot]`, -1 donde no se vio oleada.
    pub series: Vec<[f32; 4]>,
    pub invades: Vec<InvadeCheck>,
    pub ganks: Vec<GankCheck>,
    pub objectives: Vec<ObjectiveCheck>,
}

fn veredicto(lanes: &[LanePush]) -> &'static str {
    let vistos: Vec<f64> = lanes.iter().filter_map(|l| l.push).collect();
    if vistos.len() < lanes.len() {
        // Con un carril sin leer, sólo se puede afirmar lo que ya es seguro.
        return match vistos.iter().filter(|p| **p >= EMPUJADO).count() {
            0 if !vistos.is_empty() => "none",
            _ => "unknown",
        };
    }
    match vistos.iter().filter(|p| **p >= EMPUJADO).count() {
        n if n == lanes.len() => "prio",
        0 => "none",
        _ => "half",
    }
}

/// Carriles de los que depende un punto de la jungla o del río: el de su lado
/// del mapa (por encima o por debajo de mid) y mid.
fn carriles_de(x: f64, y: f64) -> [Lane; 2] {
    [if y > x { Lane::Top } else { Lane::Bot }, Lane::Mid]
}

fn empujes(serie: &[Instante], lanes: &[Lane], t: f64, antes: f64) -> Vec<LanePush> {
    lanes.iter().map(|&l| LanePush { lane: l.key(), push: en(serie, l, t, antes) }).collect()
}

pub fn analizar(raw: &str, tl: &TimelineDto, m: &MatchDto, pid: i32, desfase: f64, pos: Option<&crate::minimap::Positions>) -> WavesReport {
    let Some(yo) = m.info.participants.get((pid - 1) as usize) else {
        return WavesReport { status: "no_riot".into(), ..Default::default() };
    };
    let equipo = yo.teamId;
    let Some(serie) = instantes(raw, equipo, desfase) else {
        return WavesReport { status: "unreadable".into(), ..Default::default() };
    };
    let mut r = WavesReport { status: "ok".into(), matches: 1, ..Default::default() };
    r.series = serie
        .iter()
        .filter(|i| i.t_game >= 0.0)
        .map(|i| {
            let f = |v: Option<f64>| v.map(|x| ((x * 1000.0).round() / 1000.0) as f32).unwrap_or(-1.0);
            [i.t_game as f32, f(i.carril[0]), f(i.carril[1]), f(i.carril[2])]
        })
        .collect();

    let muertes = crate::jungle_route::muertes(tl, pid);

    // 1. Invasiones: campamentos tuyos hechos en la jungla rival.
    if let Some(pos) = pos {
        if crate::jungle_route::es_jungla(&m.info.participants, pid) {
            let rival = if equipo == 100 { 200 } else { 100 };
            let clears = crate::jungle_route::build(tl, &m.info.participants, pos)
                .filter(|r| r.agreement >= crate::jungle_route::ACUERDO_MIN)
                .map(|r| r.clears)
                .unwrap_or_default();
            for c in clears.iter().filter(|c| c.side == "enemy") {
                let Some((x, y)) = crate::jungle_route::posicion_campamento(&c.camp, rival) else { continue };
                let lanes = empujes(&serie, &carriles_de(x, y), c.start, 8.0);
                let verdict = if c.start < PRIMERAS_OLEADAS { "early" } else { veredicto(&lanes) };
                let died = muertes.iter().any(|(d, _, _)| *d >= c.start - 2.0 && *d <= c.end + 15.0);
                r.invades.push(InvadeCheck {
                    t_game: c.start,
                    t_video: c.start + desfase,
                    camp: c.camp.clone(),
                    lanes,
                    verdict,
                    died,
                });
            }
        }
    }

    // 2. Ganks.
    for g in crate::gank::detect(tl, pid, &m.info.participants) {
        let push = en(&serie, g.lane, g.time, 8.0);
        let setup = match push {
            None => "unknown",
            Some(p) if p <= LADO_PROPIO => "good",
            Some(p) if p >= BAJO_SU_TORRE => "dive",
            Some(_) => "even",
        };
        r.ganks.push(GankCheck {
            t_game: g.time,
            t_video: g.time + desfase,
            lane: g.lane.key(),
            push,
            setup,
            outcome: g.outcome.key(),
        });
    }

    // 3. Objetivos: la prioridad se mira en el minuto previo, cuando se monta.
    for ev in tl.info.frames.iter().flat_map(|f| f.events.iter()) {
        if ev.event_type != "ELITE_MONSTER_KILL" {
            continue;
        }
        let Some(kind) = ev.monsterType.clone() else { continue };
        let t = ev.timestamp as f64 / 1000.0;
        // Cada larva del vacío es un evento: tres seguidos son un objetivo.
        if r.objectives.iter().any(|o| o.kind == kind && t - o.t_game < 90.0) {
            continue;
        }
        let lanes: &[Lane] = if kind == "DRAGON" { &[Lane::Bot, Lane::Mid] } else { &[Lane::Top, Lane::Mid] };
        let lanes = empujes(&serie, lanes, t - 15.0, 45.0);
        r.objectives.push(ObjectiveCheck {
            t_game: t,
            t_video: t + desfase,
            kind,
            ours: ev.killerTeamId == equipo,
            verdict: veredicto(&lanes),
            lanes,
        });
    }
    r
}

pub fn ruta(match_id: &str) -> std::path::PathBuf {
    crate::storage::get_match_dir(match_id).join(FICHERO)
}

fn script(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let s = crate::cv_analyzer::resolve_resource(app, "python_scripts/oleadas.py")
        .unwrap_or_else(|| std::path::Path::new("python_scripts/oleadas.py").to_path_buf());
    s.exists().then_some(s)
}

fn leyendo() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static M: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> = std::sync::OnceLock::new();
    M.get_or_init(Default::default)
}

/// ¿Se pueden leer las oleadas de esta partida y aún no se ha hecho?
pub fn falta(app: &tauri::AppHandle, match_id: &str) -> bool {
    if ruta(match_id).exists() || script(app).is_none() {
        return false;
    }
    let Ok(meta) = crate::storage::get_match_metadata(match_id) else { return false };
    !meta.is_vod
        && meta.video_offset.is_some()
        && std::path::Path::new(&meta.video_path).exists()
        && crate::storage::get_raw_match_path(match_id).exists()
}

/// Lee las oleadas de una partida. Bloquea, pero son segundos: sólo se
/// descodifican los fotogramas clave.
pub fn procesar(app: &tauri::AppHandle, match_id: &str) -> Result<(), String> {
    if ruta(match_id).exists() {
        return Ok(());
    }
    let script = script(app).ok_or("Esta instalación no trae el lector de oleadas.")?;
    let meta = crate::storage::get_match_metadata(match_id).map_err(|_| "No se encuentra la partida.")?;
    if !leyendo().lock().map_err(|_| "estado interno corrupto")?.insert(match_id.to_string()) {
        return Ok(());
    }
    let ffmpeg = crate::proc::ffmpeg(app);
    let (w, h, dur) = crate::proc::video_info(&ffmpeg, &meta.video_path).unwrap_or((1920.0, 1080.0, None));
    let duracion = dur.unwrap_or(meta.game_duration as f64 + meta.video_offset.unwrap_or(0.0));
    let mut cmd = std::process::Command::new(crate::cv_analyzer::python_command(app));
    cmd.arg(script)
        .arg("--video")
        .arg(&meta.video_path)
        .arg("--salida")
        .arg(ruta(match_id))
        .arg("--ffmpeg")
        .arg(&ffmpeg)
        .arg("--wh")
        .arg(format!("{}x{}", w as i64, h as i64))
        .arg("--duracion")
        .arg(format!("{duracion:.2}"));
    crate::proc::hide_console(&mut cmd);
    let salida = cmd.output();
    if let Ok(mut l) = leyendo().lock() {
        l.remove(match_id);
    }
    match salida {
        Ok(o) if o.status.success() && ruta(match_id).exists() => Ok(()),
        Ok(o) => {
            log::warn!("oleadas: falló {match_id}: {}", String::from_utf8_lossy(&o.stderr).lines().last().unwrap_or(""));
            Err("No se pudieron leer las oleadas del vídeo.".into())
        }
        Err(e) => Err(format!("No se pudo lanzar el lector de oleadas: {e}")),
    }
}

pub fn pendientes(app: &tauri::AppHandle) -> Vec<String> {
    if script(app).is_none() {
        return Vec::new();
    }
    crate::storage::load_all_matches()
        .into_iter()
        .filter(|m| !m.is_vod && m.riot_match_id.is_some())
        .filter(|m| falta(app, &m.id))
        .map(|m| m.id)
        .collect()
}

fn estado(s: &str) -> WavesReport {
    WavesReport { status: s.into(), ..Default::default() }
}

fn de_partida(match_id: &str) -> WavesReport {
    if leyendo().lock().map(|l| l.contains(match_id)).unwrap_or(false) {
        return estado("reading");
    }
    let Ok(raw) = std::fs::read_to_string(ruta(match_id)) else { return estado("no_waves") };
    let (Some(rm), Some(rtl), Ok(meta)) = (
        crate::storage::load_raw_match(match_id),
        crate::storage::load_raw_timeline(match_id),
        crate::storage::get_match_metadata(match_id),
    ) else {
        return estado("no_riot");
    };
    let (Ok(m), Ok(tl)) = (serde_json::from_str::<MatchDto>(&rm), serde_json::from_str::<TimelineDto>(&rtl)) else {
        return estado("no_riot");
    };
    let Some(pid) = m.info.participants.iter().position(|p| p.championName == meta.champion).map(|i| i as i32 + 1) else {
        return estado("no_riot");
    };
    let pos = crate::minimap::Positions::load(match_id);
    analizar(&raw, &tl, &m, pid, meta.video_offset.unwrap_or(0.0), pos.as_ref())
}

/// Oleadas y macro de una partida. Si faltan por leer y se puede, las lee
/// (son segundos) antes de contestar.
#[tauri::command]
pub async fn get_waves(app: tauri::AppHandle, match_id: String) -> WavesReport {
    tokio::task::spawn_blocking(move || {
        if falta(&app, &match_id) {
            if let Err(e) = procesar(&app, &match_id) {
                log::warn!("oleadas: {match_id}: {e}");
            }
        }
        de_partida(&match_id)
    })
    .await
    .unwrap_or_else(|_| estado("no_riot"))
}

const PARTIDAS_HISTORIAL: usize = 15;

/// Lo mismo sobre tus últimas partidas con las oleadas leídas, sin la serie.
#[tauri::command]
pub async fn get_waves_career() -> WavesReport {
    tokio::task::spawn_blocking(|| {
        let mut total = estado("no_waves");
        for m in crate::storage::load_all_matches().into_iter().filter(|m| !m.is_vod) {
            if total.matches >= PARTIDAS_HISTORIAL {
                break;
            }
            if !ruta(&m.id).exists() {
                continue;
            }
            let r = de_partida(&m.id);
            if r.status != "ok" {
                continue;
            }
            total.status = "ok".into();
            total.matches += 1;
            total.invades.extend(r.invades);
            total.ganks.extend(r.ganks);
            total.objectives.extend(r.objectives);
        }
        total
    })
    .await
    .unwrap_or_else(|_| estado("no_riot"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_choque_esta_entre_las_dos_puntas() {
        let mut a = vec![0.3, 0.42, 0.45, 0.46];
        let mut e = vec![0.5, 0.52, 0.7];
        let c = choque(&mut a, &mut e).unwrap();
        assert!((c - 0.48).abs() < 0.01, "{c}");
        // Sin los suyos a la vista, la punta de la tuya.
        assert_eq!(choque(&mut [0.6, 0.62], &mut []), Some(0.62));
        assert_eq!(choque(&mut [], &mut [0.4]), None);
    }

    #[test]
    fn veredictos() {
        let l = |p: Option<f64>| LanePush { lane: "top", push: p };
        assert_eq!(veredicto(&[l(Some(0.6)), l(Some(0.55))]), "prio");
        assert_eq!(veredicto(&[l(Some(0.6)), l(Some(0.3))]), "half");
        assert_eq!(veredicto(&[l(Some(0.2)), l(Some(0.3))]), "none");
        assert_eq!(veredicto(&[l(Some(0.2)), l(None)]), "none");
        assert_eq!(veredicto(&[l(Some(0.7)), l(None)]), "unknown");
    }

    #[test]
    fn el_icono_de_una_torre_no_es_un_subdito() {
        // Encima de la torre exterior de top azul y en mitad de top.
        let p = por_carril(&[[1000.0, 10400.0], [2300.0, 12700.0]], 100);
        assert_eq!(p[0].len(), 1);
    }

    /// `MIS_PARTIDAS_DIR=... cargo test --lib oleadas_en_mis_partidas -- --nocapture`
    #[test]
    fn oleadas_en_mis_partidas() {
        let Ok(dir) = std::env::var("MIS_PARTIDAS_DIR") else { return };
        for d in std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()) {
            let id = d.file_name().unwrap().to_string_lossy().to_string();
            let (Ok(raw), Ok(rm), Ok(rtl), Ok(rmeta)) = (
                std::fs::read_to_string(d.join(FICHERO)),
                std::fs::read_to_string(d.join("riot_match.json")),
                std::fs::read_to_string(d.join("riot_timeline.json")),
                std::fs::read_to_string(d.join(format!("{id}.json"))),
            ) else { continue };
            let m: MatchDto = serde_json::from_str(&rm).unwrap();
            let tl: TimelineDto = serde_json::from_str(&rtl).unwrap();
            let meta: crate::storage::MatchMetadata = serde_json::from_str(&rmeta).unwrap();
            let pid = m.info.participants.iter().position(|p| p.championName == meta.champion).unwrap() as i32 + 1;
            let pos = std::fs::read_to_string(d.join("minimap_positions.json")).ok().and_then(|r| crate::minimap::Positions::from_json(&r));
            let r = analizar(&raw, &tl, &m, pid, meta.video_offset.unwrap_or(0.0), pos.as_ref());
            let visto = |i: usize| r.series.iter().filter(|s| s[i] >= 0.0).count() as f64 / r.series.len().max(1) as f64;
            println!(
                "{id} equipo {} · carriles vistos top {:.0}% mid {:.0}% bot {:.0}%",
                m.info.participants[(pid - 1) as usize].teamId, 100.0 * visto(1), 100.0 * visto(2), 100.0 * visto(3)
            );
            for s in r.series.iter().step_by(15) {
                println!("   {:>5.0}s top {:>5.2} mid {:>5.2} bot {:>5.2}", s[0], s[1], s[2], s[3]);
            }
            for i in &r.invades {
                println!("   invasión {:>5.0}s {} {:?} {} muerte {}", i.t_game, i.camp, i.lanes.iter().map(|l| (l.lane, l.push)).collect::<Vec<_>>(), i.verdict, i.died);
            }
            for g in &r.ganks {
                println!("   gank {:>5.0}s {} {:?} {} {}", g.t_game, g.lane, g.push, g.setup, g.outcome);
            }
            for o in &r.objectives {
                println!("   objetivo {:>5.0}s {} nuestro {} {:?} {}", o.t_game, o.kind, o.ours, o.lanes.iter().map(|l| (l.lane, l.push)).collect::<Vec<_>>(), o.verdict);
            }
        }
    }
}
