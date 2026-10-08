//! Los golpes que te comes: cada pelea que te empieza un rival, qué hacías
//! cuando te llegó el primer golpe y qué pasó después.
//!
//! La pregunta del usuario era "¿qué tan bien esquivo?". Un "% de esquiva" no
//! se puede medir: hace falta saber qué habilidades te FALLARON, y eso no lo
//! registra nada (la API no guarda lanzamientos, y ver proyectiles en el vídeo
//! exigiría un detector por campeón y por aspecto). Lo que sí se puede medir,
//! golpe a golpe y con su instante, es lo que te comes:
//!
//! - **El golpe**: de la barra de vida del HUD, ocho veces por segundo
//!   ([`crate::hud`]). Una bajada de al menos el [`GOLPE_MIN`] de tu vida máxima
//!   en menos de medio segundo.
//! - **La apertura**: el primer golpe tras [`CALMA`] segundos sin recibir nada.
//!   Es el que decide si hay pelea: el enganche, la raíz, el *poke* que te deja
//!   a medias. Es el que se puede esquivar; los de después ya van encadenados.
//! - **Si era de un campeón**: había un rival a menos de [`CERCA`] en el
//!   minimapa, o el efecto que te puso es de un campeón rival. Sin eso es un
//!   campamento, un súbdito o una torre, y no cuenta.
//! - **Qué hacía tu mano**: en línea recta o girando ([`crate::spells`]), la
//!   misma medida que separó 35 de tus 93 muertes.
//! - **De dónde vino**: si no se veía a ningún rival cerca en los segundos
//!   anteriores, vino de la niebla — y eso ya no es reflejo, es posición.
//! - **Tu reacción**: la primera tecla de habilidad o invocador tras el golpe.
//!   Sólo en partidas grabadas desde que se guardan las teclas (2026-10-07).
//! - **Qué te lo puso**, cuando el icono del efecto se reconoce.

use serde::{Deserialize, Serialize};

use crate::minimap::{Fix, Positions};
use crate::riot_api::{MatchDto, TimelineDto};

/// Fracción de la vida máxima (en milésimas) que tiene que bajar para ser un
/// golpe. Un 5 %: un autoataque de esbirro a nivel 6 no llega; una Q sí.
pub const GOLPE_MIN: i32 = 50;
/// Bajada mínima entre dos lecturas para empezar un golpe (2,5 %). Por debajo,
/// el ruido de la lectura (±15 de vida medido) y la regeneración.
const CAIDA_MIN: i32 = 25;
/// Un golpe que sigue bajando se alarga como mucho esto (el combo de una
/// habilidad que pega varias veces seguidas es un golpe, no tres).
const GOLPE_DURA: f64 = 0.5;
/// Segundos sin golpes para que el siguiente abra una pelea nueva.
pub const CALMA: f64 = 5.0;
/// A esta distancia (unidades de mapa) un rival te puede estar pegando:
/// el alcance de las habilidades largas de uso común ronda 1.100-1.300.
pub const CERCA: f64 = 1500.0;
/// Si ningún rival estaba a esta distancia en los segundos previos, el golpe
/// vino de la niebla: no lo tenías a la vista para esquivarlo.
const VISTO: f64 = 2500.0;
/// Ventana para buscar tu reacción tras el golpe.
const REACCION_MAX: f64 = 2.0;
/// Una muerte en estos segundos tras la apertura (o antes del último golpe de
/// esa pelea) cuenta como que la pelea acabó contigo.
const MUERTE_TRAS: f64 = 10.0;

#[derive(Deserialize)]
struct Hud {
    fps: f64,
    hud_ok: f64,
    hp: Vec<i32>,
    #[serde(default)]
    debuffs: Vec<Debuff>,
}

#[derive(Deserialize, Clone)]
struct Debuff {
    t: f64,
    icon: String,
}

/// Un golpe leído de la barra, en segundos de vídeo y milésimas de vida.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Golpe {
    pub t: f64,
    pub antes: i32,
    pub despues: i32,
}

/// Los golpes de una serie de vida. `vivo(t)` dice si en ese segundo de vídeo
/// estabas vivo y en partida: fuera de eso la barra no dice nada.
pub fn golpes_de(hp: &[i32], fps: f64, vivo: impl Fn(f64) -> bool, muerte_cerca: impl Fn(f64) -> bool) -> Vec<Golpe> {
    let mut v = Vec::new();
    let largo = (GOLPE_DURA * fps).round().max(1.0) as usize;
    let mut i = 1;
    while i < hp.len() {
        let caida = hp[i - 1] - hp[i];
        if caida < CAIDA_MIN || hp[i - 1] <= 0 {
            i += 1;
            continue;
        }
        let ini = i - 1;
        let mut fin = i;
        while fin + 1 < hp.len() && fin + 1 - ini <= largo && hp[fin] - hp[fin + 1] >= 10 {
            fin += 1;
        }
        let t = ini as f64 / fps;
        let (antes, despues) = (hp[ini], hp[fin]);
        // Lectura falsa: la barra vuelve enseguida a donde estaba (algo pasó
        // por delante del HUD), o se va a cero sin que murieras.
        let vuelve = hp[fin + 1..(fin + 3).min(hp.len())].iter().any(|&h| h >= antes - 15);
        let cero_falso = despues <= 0 && !muerte_cerca(t);
        if antes - despues >= GOLPE_MIN && vivo(t) && !vuelve && !cero_falso {
            v.push(Golpe { t, antes, despues });
        }
        i = fin + 1;
    }
    v
}

#[derive(Debug, Clone, Serialize)]
pub struct Efecto {
    /// Nombre del campeón tal cual lo da Riot ("Leblanc").
    pub champion: String,
    /// "Q", "W", "E", "R", "P" (pasiva) o el hechizo de invocador ("Ignite").
    pub ability: Option<String>,
    /// `campeón/fichero` del icono reconocido.
    pub icon: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Reaccion {
    /// "Q", "W", "E", "R" o el invocador de esa tecla ("Flash", "Smite"…).
    pub key: String,
    pub secs: f64,
}

/// Una pelea que te empezaron, abierta en canal.
#[derive(Debug, Clone, Serialize)]
pub struct Apertura {
    pub t_game: f64,
    pub t_video: f64,
    /// Lo que te quitó el primer golpe, en % de tu vida máxima.
    pub hit_pct: f64,
    /// Lo mismo en vida, con la vida máxima de ese minuto. `None` sin el dato.
    pub hit_hp: Option<i32>,
    /// Tu vida justo antes, en %.
    pub hp_before_pct: f64,
    /// Lo que perdiste en toda la pelea, en %.
    pub fight_pct: f64,
    /// Golpes de toda la pelea.
    pub fight_hits: usize,
    /// Rivales a menos de [`CERCA`] al recibirlo.
    pub enemies_near: usize,
    /// Ningún rival a la vista cerca en los segundos previos.
    pub from_fog: bool,
    /// `None` sin estela del ratón.
    pub straight: Option<bool>,
    pub reaction: Option<Reaccion>,
    pub effect: Option<Efecto>,
    pub died: bool,
    /// Hacia dónde te movías respecto al rival más cercano en pantalla:
    /// "lateral", "away", "toward" u "offscreen" ([`crate::barras`]).
    pub line: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EfectoCuenta {
    pub effect: Efecto,
    pub times: usize,
    /// El icono como `data:` URL, para pintarlo sin servir la caché.
    pub icon_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct GolpesReport {
    /// "ok", "no_hud" (sin leer), "reading", "hud_unreadable", "no_minimap", "no_riot".
    pub status: String,
    pub matches: usize,
    /// Golpes de campeón contados (todos, no sólo aperturas).
    pub hits: usize,
    pub openers: usize,
    pub straight: usize,
    /// Aperturas con estela del ratón: el denominador de `straight`.
    pub straight_known: usize,
    pub from_fog: usize,
    pub died: usize,
    /// Partidas con las teclas grabadas.
    pub matches_with_keys: usize,
    /// Aperturas en partidas con teclas: el denominador de la reacción.
    pub reaction_known: usize,
    pub reaction_n: usize,
    pub reaction_p50: Option<f64>,
    /// Aperturas con la línea de fuego medida (rival en pantalla y orden de
    /// movimiento): el denominador de las tres siguientes.
    pub line_known: usize,
    pub line_lateral: usize,
    pub line_away: usize,
    pub line_toward: usize,
    /// Te llegó sin ningún rival en tu pantalla.
    pub line_offscreen: usize,
    pub effects: Vec<EfectoCuenta>,
    pub list: Vec<Apertura>,
    #[serde(skip)]
    reacciones: Vec<f64>,
}

/// `leblanc/leblance` → (campeón, Some("E")). Los nombres de CommunityDragon
/// son el del campeón pegado a la letra, con o sin guion bajo (`zedq`,
/// `akali_e2`, `galio_w_passive_cd`); los invocadores van como `summonerX`.
pub fn habilidad(icono: &str) -> (String, Option<String>) {
    let (champ, fichero) = icono.split_once('/').unwrap_or(("", icono));
    if let Some(s) = fichero.strip_prefix("summoner") {
        let nombre = match s {
            "dot" | "ignite" => "Ignite",
            "exhaust" => "Exhaust",
            "flash" => "Flash",
            "smite" => "Smite",
            _ => "",
        };
        return (champ.to_string(), (!nombre.is_empty()).then(|| nombre.to_string()));
    }
    let resto = fichero.strip_prefix(champ).unwrap_or(fichero).trim_start_matches('_');
    let letra = if resto.starts_with("passive") || resto == "p" || resto.starts_with("p_") {
        Some("P")
    } else {
        match resto.chars().next() {
            Some('q') => Some("Q"),
            Some('w') => Some("W"),
            Some('e') => Some("E"),
            Some('r') => Some("R"),
            _ => None,
        }
    };
    (champ.to_string(), letra.map(str::to_string))
}

fn invocador(id: i32) -> &'static str {
    match id {
        4 => "Flash",
        11 => "Smite",
        14 => "Ignite",
        12 => "Teleport",
        6 => "Ghost",
        3 => "Exhaust",
        7 => "Heal",
        21 => "Barrier",
        1 => "Cleanse",
        _ => "",
    }
}

fn mediana(v: &mut [f64]) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(f64::total_cmp);
    Some(v[v.len() / 2])
}

fn en(pista: &[Fix], sec: f64) -> Option<(f64, f64)> {
    let i = pista.partition_point(|f| f.sec < sec);
    [i.checked_sub(1), Some(i)]
        .into_iter()
        .flatten()
        .filter_map(|j| pista.get(j))
        .filter(|f| (f.sec - sec).abs() <= 1.0)
        .min_by(|a, b| (a.sec - sec).abs().total_cmp(&(b.sec - sec).abs()))
        .map(|f| (f.x, f.y))
}

/// Rivales a menos de `radio` de tu posición en las muestras de `[t0, t1]`
/// (segundos de vídeo): el máximo por muestra.
fn rivales_cerca(pos: &Positions, pista: &[Fix], t0: f64, t1: f64, radio: f64) -> usize {
    let i = pos.samples.partition_point(|s| s.t < t0);
    pos.samples[i..]
        .iter()
        .take_while(|s| s.t <= t1)
        .filter_map(|s| {
            let (x, y) = en(pista, s.t - pos.video_offset)?;
            Some(
                s.icons
                    .iter()
                    .filter(|ic| ic.team.is_some_and(|t| t != pos.self_team_id))
                    .filter(|ic| (ic.x - x).hypot(ic.y - y) < radio)
                    .count(),
            )
        })
        .max()
        .unwrap_or(0)
}

/// Todo lo de una partida.
pub struct Entrada<'a> {
    pub hud_raw: &'a str,
    pub tl: &'a TimelineDto,
    pub m: &'a MatchDto,
    pub pos: &'a Positions,
    pub meta: &'a crate::storage::MatchMetadata,
    pub escala_minimapa: f64,
    pub barras: Option<&'a crate::barras::Barras>,
}

pub fn analizar(e: &Entrada) -> GolpesReport {
    let mut r = GolpesReport { status: "ok".into(), matches: 1, ..Default::default() };
    let Ok(hud) = serde_json::from_str::<Hud>(e.hud_raw) else {
        r.status = "hud_unreadable".into();
        return r;
    };
    if hud.hud_ok < 0.5 || hud.fps <= 0.0 {
        r.status = "hud_unreadable".into();
        return r;
    }
    let pid = e.pos.self_participant_id;
    let off = e.meta.video_offset.unwrap_or(e.pos.video_offset);
    let fin_partida = e.tl.info.frames.last().map(|f| f.timestamp as f64 / 1000.0).unwrap_or(f64::MAX);
    let muertes = crate::jungle_route::muertes(e.tl, pid);
    let vivo = |tv: f64| {
        let tg = tv - off;
        tg > 1.0 && tg < fin_partida && !muertes.iter().any(|(d, resp, _)| tg > *d - 0.2 && tg < *resp + 1.0)
    };
    let muerte_cerca = |tv: f64| muertes.iter().any(|(d, _, _)| (tv - off - d).abs() < 1.5);
    let golpes = golpes_de(&hud.hp, hud.fps, vivo, muerte_cerca);

    let anclas = crate::minimap::anclas_de(e.tl, pid);
    let pista = e.pos.follow(&anclas);
    let ordenes = crate::hands::ordenes(e.meta, e.escala_minimapa);
    let teclas: Vec<(f64, &str)> = e
        .meta
        .mouse_events
        .iter()
        .filter_map(|ev| ev.evt.strip_prefix("key_").map(|k| (ev.t, k)))
        .collect();
    if !teclas.is_empty() {
        r.matches_with_keys = 1;
    }
    let yo = e.m.info.participants.get((pid - 1) as usize);
    let nombre_tecla = |k: &str| -> String {
        match (k, yo) {
            ("d", Some(p)) => Some(invocador(p.summoner1Id)).filter(|s| !s.is_empty()).unwrap_or("D").to_string(),
            ("f", Some(p)) => Some(invocador(p.summoner2Id)).filter(|s| !s.is_empty()).unwrap_or("F").to_string(),
            _ => k.to_uppercase(),
        }
    };
    let rival_de = |champ: &str| -> Option<String> {
        let mio = yo?.teamId;
        e.m.info
            .participants
            .iter()
            .find(|p| p.teamId != mio && p.championName.to_lowercase() == champ)
            .map(|p| p.championName.clone())
    };
    let vida_max = |tg: f64| -> Option<i32> {
        let f = e.tl.info.frames.get((tg / 60.0).floor().max(0.0) as usize)?;
        let v = f.participantFrames.get(&pid.to_string())?.championStats.healthMax;
        (v > 0).then_some(v)
    };
    let efecto_en = |tv: f64| -> Option<Efecto> {
        hud.debuffs
            .iter()
            .filter(|d| d.t >= tv - 0.5 && d.t <= tv + 1.5)
            .min_by(|a, b| (a.t - tv).abs().total_cmp(&(b.t - tv).abs()))
            .and_then(|d| {
                let (champ, ability) = habilidad(&d.icon);
                Some(Efecto { champion: rival_de(&champ)?, ability, icon: d.icon.clone() })
            })
    };

    // Golpes de campeón y peleas. Los de justo antes de morir cuentan siempre:
    // en el último segundo el rastro del minimapa suele perderte (el icono se
    // apaga al morir) y sin esto la pelea que te mató se partía en dos.
    let de_campeon: Vec<(Golpe, usize)> = golpes
        .into_iter()
        .filter_map(|g| {
            // Más de cinco es un icono leído dos veces o un aliado con el aro mal leído.
            let cerca = rivales_cerca(e.pos, &pista, g.t - 1.0, g.t + 1.5, CERCA).min(5);
            let antes_de_morir = muertes.iter().any(|(d, _, _)| {
                let tg = g.t - off;
                *d >= tg && *d <= tg + 4.0
            });
            (cerca > 0 || antes_de_morir || efecto_en(g.t).is_some()).then_some((g, cerca))
        })
        .collect();
    r.hits = de_campeon.len();

    let mut previo = f64::NEG_INFINITY;
    let mut peleas: Vec<Vec<(Golpe, usize)>> = Vec::new();
    for (g, c) in de_campeon {
        if g.t - previo >= CALMA || peleas.is_empty() {
            peleas.push(Vec::new());
        }
        previo = g.t;
        peleas.last_mut().unwrap().push((g, c));
    }

    for pelea in peleas {
        let (g, cerca) = pelea[0];
        let tv = g.t;
        let tg = tv - off;
        let visto = rivales_cerca(e.pos, &pista, tv - 4.0, tv - 0.75, VISTO) > 0;
        let straight = crate::spells::ventana_de_mano(&ordenes, tv).map(|h| h.straight);
        let reaction = teclas
            .iter()
            .find(|(t, _)| *t > tv && *t <= tv + REACCION_MAX)
            .map(|(t, k)| Reaccion { key: nombre_tecla(k), secs: ((t - tv) * 100.0).round() / 100.0 });
        let minimo = pelea.iter().map(|(g, _)| g.despues).min().unwrap_or(g.despues);
        // La pelea acabó contigo: moriste antes de que se cortara (una pelea
        // larga sigue siendo la misma mientras los golpes no paren), o poco
        // después del primero.
        let ultimo = pelea.last().map(|(g, _)| g.t - off).unwrap_or(tg);
        let died = muertes
            .iter()
            .any(|(d, _, _)| *d >= tg - 0.5 && *d <= (tg + MUERTE_TRAS).max(ultimo + 2.0));
        let ap = Apertura {
            t_game: tg,
            t_video: tv,
            hit_pct: (g.antes - g.despues) as f64 / 10.0,
            hit_hp: vida_max(tg).map(|m| (m as f64 * (g.antes - g.despues) as f64 / 1000.0).round() as i32),
            hp_before_pct: g.antes as f64 / 10.0,
            fight_pct: (g.antes - minimo).max(0) as f64 / 10.0,
            fight_hits: pelea.len(),
            enemies_near: cerca,
            from_fog: !visto,
            straight,
            reaction,
            effect: efecto_en(tv),
            died,
            line: e.barras.and_then(|b| crate::barras::linea_de_fuego(b, e.meta, tv)),
        };
        match ap.line {
            Some("offscreen") => r.line_offscreen += 1,
            Some(l) => {
                r.line_known += 1;
                match l {
                    "lateral" => r.line_lateral += 1,
                    "away" => r.line_away += 1,
                    _ => r.line_toward += 1,
                }
            }
            None => {}
        }
        r.openers += 1;
        if let Some(s) = ap.straight {
            r.straight_known += 1;
            r.straight += s as usize;
        }
        r.from_fog += ap.from_fog as usize;
        r.died += ap.died as usize;
        if !teclas.is_empty() {
            r.reaction_known += 1;
            if let Some(re) = &ap.reaction {
                r.reaction_n += 1;
                r.reacciones.push(re.secs);
            }
        }
        r.list.push(ap);
    }
    r.reaction_p50 = mediana(&mut r.reacciones.clone());
    r.effects = contar_efectos(&r.list);
    r
}

fn contar_efectos(list: &[Apertura]) -> Vec<EfectoCuenta> {
    let mut v: Vec<EfectoCuenta> = Vec::new();
    for ap in list {
        let Some(ef) = &ap.effect else { continue };
        match v.iter_mut().find(|c| c.effect.icon == ef.icon) {
            Some(c) => c.times += 1,
            None => v.push(EfectoCuenta { effect: ef.clone(), times: 1, icon_url: None }),
        }
    }
    v.sort_by(|a, b| b.times.cmp(&a.times));
    v.truncate(6);
    v
}

fn con_iconos(mut r: GolpesReport) -> GolpesReport {
    for c in &mut r.effects {
        let ruta = crate::hud::dir_iconos().join(format!("{}.png", c.effect.icon));
        c.icon_url = std::fs::read(ruta).ok().map(|b| format!("data:image/png;base64,{}", base64(&b)));
    }
    r
}

fn base64(datos: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(datos.len().div_ceil(3) * 4);
    for c in datos.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for k in 0..4 {
            if k <= c.len() {
                s.push(T[(n >> (18 - 6 * k) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

fn estado(status: &str) -> GolpesReport {
    GolpesReport { status: status.into(), ..Default::default() }
}

fn de_partida(match_id: &str, escala: f64) -> GolpesReport {
    if crate::hud::leyendo(match_id) {
        return estado("reading");
    }
    let Ok(hud_raw) = std::fs::read_to_string(crate::hud::ruta(match_id)) else {
        return estado("no_hud");
    };
    let (Some(raw), Some(raw_tl), Ok(meta)) = (
        crate::storage::load_raw_match(match_id),
        crate::storage::load_raw_timeline(match_id),
        crate::storage::get_match_metadata(match_id),
    ) else {
        return estado("no_riot");
    };
    let (Ok(m), Ok(tl)) = (serde_json::from_str::<MatchDto>(&raw), serde_json::from_str::<TimelineDto>(&raw_tl)) else {
        return estado("no_riot");
    };
    let Some(pos) = Positions::load(match_id) else { return estado("no_minimap") };
    let barras = crate::barras::Barras::load(match_id);
    analizar(&Entrada {
        hud_raw: &hud_raw,
        tl: &tl,
        m: &m,
        pos: &pos,
        meta: &meta,
        escala_minimapa: escala,
        barras: barras.as_ref(),
    })
}

/// Instantes de vídeo de las peleas que te empezaron: alrededor de ellos se
/// leen las barras de vida ([`crate::barras`]).
pub(crate) fn aperturas(match_id: &str) -> Vec<f64> {
    de_partida(match_id, crate::storage::load_config().minimap_scale)
        .list
        .iter()
        .map(|a| a.t_video)
        .collect()
}

/// Las peleas que te empezaron en una partida.
#[tauri::command]
pub async fn get_hits_taken(match_id: String) -> GolpesReport {
    tokio::task::spawn_blocking(move || {
        con_iconos(de_partida(&match_id, crate::storage::load_config().minimap_scale))
    })
    .await
    .unwrap_or_else(|_| estado("no_riot"))
}

const PARTIDAS_HISTORIAL: usize = 10;

/// Lo mismo sobre tus últimas partidas con el HUD leído.
#[tauri::command]
pub async fn get_hits_taken_career() -> GolpesReport {
    tokio::task::spawn_blocking(|| {
        let escala = crate::storage::load_config().minimap_scale;
        let mut total = GolpesReport { status: "no_hud".into(), ..Default::default() };
        let mut todas: Vec<Apertura> = Vec::new();
        for m in crate::storage::load_all_matches().into_iter().filter(|m| !m.is_vod) {
            if total.matches >= PARTIDAS_HISTORIAL {
                break;
            }
            if !crate::hud::ruta(&m.id).exists() {
                continue;
            }
            let r = de_partida(&m.id, escala);
            if r.status != "ok" {
                continue;
            }
            total.status = "ok".into();
            total.matches += 1;
            total.hits += r.hits;
            total.openers += r.openers;
            total.straight += r.straight;
            total.straight_known += r.straight_known;
            total.from_fog += r.from_fog;
            total.died += r.died;
            total.matches_with_keys += r.matches_with_keys;
            total.reaction_known += r.reaction_known;
            total.reaction_n += r.reaction_n;
            total.line_known += r.line_known;
            total.line_lateral += r.line_lateral;
            total.line_away += r.line_away;
            total.line_toward += r.line_toward;
            total.line_offscreen += r.line_offscreen;
            total.reacciones.extend(r.reacciones);
            todas.extend(r.list);
        }
        total.reaction_p50 = mediana(&mut total.reacciones.clone());
        total.effects = contar_efectos(&todas);
        con_iconos(total)
    })
    .await
    .unwrap_or_else(|_| estado("no_riot"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_golpe_y_su_combo_son_uno() {
        // 100 % → Q que pega en dos lecturas seguidas → regenera.
        let hp = [1000, 1000, 900, 850, 850, 860, 870, 870, 870];
        let g = golpes_de(&hp, 8.0, |_| true, |_| false);
        assert_eq!(g, vec![Golpe { t: 1.0 / 8.0, antes: 1000, despues: 850 }]);
    }

    #[test]
    fn el_ruido_y_lo_que_vuelve_no_son_golpes() {
        // -20 es ruido; la bajada a 700 que vuelve a 1000 es algo delante del HUD.
        let hp = [1000, 980, 1000, 700, 1000, 1000];
        assert!(golpes_de(&hp, 8.0, |_| true, |_| false).is_empty());
    }

    #[test]
    fn un_cero_sin_muerte_es_la_barra_que_no_esta() {
        let hp = [800, 0, 0, 0, 0];
        assert!(golpes_de(&hp, 8.0, |_| true, |_| false).is_empty());
        assert_eq!(golpes_de(&hp, 8.0, |_| true, |_| true).len(), 1);
    }

    #[test]
    fn muerto_no_se_cuenta() {
        let hp = [1000, 600, 600];
        assert!(golpes_de(&hp, 8.0, |_| false, |_| false).is_empty());
    }

    #[test]
    fn nombres_de_icono() {
        assert_eq!(habilidad("leblanc/leblance"), ("leblanc".into(), Some("E".into())));
        assert_eq!(habilidad("akali/akali_e2"), ("akali".into(), Some("E".into())));
        assert_eq!(habilidad("zed/zedq"), ("zed".into(), Some("Q".into())));
        assert_eq!(habilidad("garen/summonerignite"), ("garen".into(), Some("Ignite".into())));
        assert_eq!(habilidad("quinn/quinn_passive"), ("quinn".into(), Some("P".into())));
        assert_eq!(habilidad("lux/luxlightstrikekugel"), ("lux".into(), None));
    }

    #[test]
    fn base64_como_el_estandar() {
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
    }

    /// Medida sobre las partidas reales:
    /// `MIS_PARTIDAS_DIR=... cargo test --lib golpes_en_mis_partidas -- --nocapture`
    #[test]
    fn golpes_en_mis_partidas() {
        let Ok(dir) = std::env::var("MIS_PARTIDAS_DIR") else { return };
        for d in std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()) {
            let id = d.file_name().unwrap().to_string_lossy().to_string();
            let (Ok(hud), Ok(raw), Ok(rtl), Ok(rp), Ok(rm)) = (
                std::fs::read_to_string(d.join(crate::hud::FICHERO)),
                std::fs::read_to_string(d.join("riot_match.json")),
                std::fs::read_to_string(d.join("riot_timeline.json")),
                std::fs::read_to_string(d.join("minimap_positions.json")),
                std::fs::read_to_string(d.join(format!("{id}.json"))),
            ) else { continue };
            let m: MatchDto = serde_json::from_str(&raw).unwrap();
            let tl: TimelineDto = serde_json::from_str(&rtl).unwrap();
            let pos = Positions::from_json(&rp).unwrap();
            let meta: crate::storage::MatchMetadata = serde_json::from_str(&rm).unwrap();
            let t0 = std::time::Instant::now();
            let barras = std::fs::read_to_string(d.join(crate::barras::FICHERO)).ok().and_then(|r| crate::barras::Barras::from_json(&r));
            let r = analizar(&Entrada { hud_raw: &hud, tl: &tl, m: &m, pos: &pos, meta: &meta, escala_minimapa: 1.0, barras: barras.as_ref() });
            println!("   línea de fuego: lateral {} · huyendo {} · hacia él {} · fuera de pantalla {} (de {} medidas)", r.line_lateral, r.line_away, r.line_toward, r.line_offscreen, r.line_known);
            println!(
                "{id} {} · {} golpes de campeón · {} aperturas · recto {}/{} · niebla {} · muerte {} · efectos {:?} · {:?}",
                r.status, r.hits, r.openers, r.straight, r.straight_known, r.from_fog, r.died,
                r.effects.iter().map(|c| format!("{} {:?} ×{}", c.effect.champion, c.effect.ability, c.times)).collect::<Vec<_>>(),
                t0.elapsed()
            );
            if std::env::var("GOLPES_DETALLE").is_ok() {
                for a in &r.list {
                    println!(
                        "   {:>5.0}s v{:>6.1} -{:>4.1}% (pelea -{:.0}%, {} golpes) cerca {} niebla {} recto {:?} muerte {} efecto {:?}",
                        a.t_game, a.t_video, a.hit_pct, a.fight_pct, a.fight_hits, a.enemies_near, a.from_fog, a.straight, a.died,
                        a.effect.as_ref().map(|e| format!("{} {:?}", e.champion, e.ability))
                    );
                }
            }
        }
    }
}
