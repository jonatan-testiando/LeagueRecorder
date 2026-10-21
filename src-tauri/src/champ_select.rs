//! La selección de campeón (§4 de `docs/coach-de-macro-diseno.md`): lo que la
//! app enseña en su ventana mientras eliges. Nunca en el juego.
//!
//! El valor de iTero en champ select es su modelo de draft, que no se puede
//! copiar. Lo nuestro es otra cosa, y todo sale de tus partidas grabadas:
//!  - **Tu historial contra tu rival** (5.1): victorias y derrotas, WPA medio,
//!    muertes por partida y las tres jugadas que más te costaron en esas
//!    partidas, con su clip.
//!  - **El recordatorio del plan** (5.2): lo pinta la interfaz con lo que ya da
//!    `coach_plan`; aquí no hay nada que calcular.
//!  - **Tu pool para el rol** (5.3), en tiers con los cortes de iTero, y la
//!    sugerencia de baneo: los rivales contra los que más pierdes.
//!
//! Las runas ganadoras (5.4) escriben en el cliente y no entran.
//!
//! # El carril de los rivales
//!
//! En clasificatoria el cliente no dice el puesto de los rivales
//! (`assignedPosition` viene vacío). Se infiere de los campeones que han fijado
//! con la tabla del corpus (`carriles_campeon.rs`), como hace iTero con su
//! `default_lane.json`. Pero no campeón a campeón: cada puesto lo juega uno, y
//! un Graves con un Lee Sin al lado no es el jungla aunque lo sea el 60 % de
//! las veces. Se reparten los cinco puestos entre las cinco plazas
//! ([`carriles`]), y las que aún no han fijado cuentan como un campeón
//! cualquiera, así que un único rival a la vista no se queda con un puesto que
//! puede ser de otro.
//!
//! # Lo que se lee del cliente
//!
//! Solo campeones y puestos (`lcu::parse_seleccion`): Riot prohíbe
//! des-anonimizar en champ select. Ni nombres ni cuentas, ni de los rivales ni
//! de los aliados.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::coach::JugadaRef;
use crate::lcu::SeleccionLcu;
use crate::storage::MatchMetadata;

/// Los cinco puestos, en el orden de la tabla.
pub const PUESTOS: [&str; 5] = crate::baselines::ROLES;

pub fn puesto_idx(p: &str) -> Option<usize> {
    PUESTOS.iter().position(|x| *x == p)
}

// ------------------------------------------------------------ campeones

/// Partidas de más que se le suman a cada puesto de un campeón antes de
/// repartir. Sin esto, un campeón visto 3 veces en medio tendría probabilidad
/// 0 de ir arriba y bloquearía cualquier reparto que lo pusiera ahí.
const SUAVIZADO: f64 = 1.0;

/// Nombres que dio el cliente para los campeones que no están en la tabla.
static NOMBRES_LCU: Mutex<Option<HashMap<i64, String>>> = Mutex::new(None);

fn en_tabla(id: i64) -> Option<&'static (i64, &'static str, [u32; 5])> {
    let t = crate::carriles_campeon::CARRILES;
    t.binary_search_by_key(&id, |f| f.0).ok().map(|i| &t[i])
}

/// El `championName` de Match-V5 de un `championId` del cliente.
pub fn nombre(id: i64) -> Option<String> {
    if id <= 0 {
        return None;
    }
    en_tabla(id).map(|f| f.1.to_string()).or_else(|| NOMBRES_LCU.lock().ok()?.as_ref()?.get(&id).cloned())
}

/// ¿Hay en la selección algún campeón sin nombre? Entonces hay que pedírselos
/// al cliente (`lcu::leer_nombres`).
pub fn faltan_nombres(s: &SeleccionLcu) -> bool {
    s.my_team.iter().chain(&s.their_team).map(|p| p.champion_id).chain(s.bans.iter().copied()).any(|c| c > 0 && nombre(c).is_none())
}

pub fn anadir_nombres(v: Vec<(i64, String)>) {
    if v.is_empty() {
        return;
    }
    if let Ok(mut m) = NOMBRES_LCU.lock() {
        m.get_or_insert_with(HashMap::new).extend(v);
    }
}

/// P(puesto | campeón) en el corpus, suavizada. `None` si el campeón no está.
pub fn reparto(id: i64) -> Option<[f64; 5]> {
    let n = en_tabla(id)?.2;
    let total: f64 = n.iter().map(|x| *x as f64).sum::<f64>() + 5.0 * SUAVIZADO;
    Some(std::array::from_fn(|l| (n[l] as f64 + SUAVIZADO) / total))
}

// ------------------------------------------------------------ carriles

/// Un rival en la selección: su campeón, si lo ha fijado (0 si no), y su
/// puesto, si el cliente lo da (personalizadas de torneo).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rival {
    pub champion_id: i64,
    pub position: Option<usize>,
}

/// Probabilidad de que cada rival juegue cada puesto, con los cinco juntos.
///
/// Se pesan todos los repartos de puestos distintos entre las plazas (5! = 120
/// con el equipo entero) por el producto de las probabilidades de cada una, y
/// se suma, para cada plaza y puesto, el peso de los repartos que la ponen
/// ahí. Una plaza sin campeón vale lo mismo en todos los puestos; una con
/// puesto dado por el cliente, solo en el suyo. `reparto` es la tabla del
/// corpus (en los tests, una de mentira).
///
/// Si ningún reparto es posible (dos rivales con el mismo puesto dado), cada
/// plaza se queda con lo suyo por separado.
pub fn carriles(rivales: &[Rival], reparto: impl Fn(i64) -> Option<[f64; 5]>) -> Vec<[f64; 5]> {
    let dist: Vec<[f64; 5]> = rivales
        .iter()
        .map(|r| match r.position {
            Some(l) if l < 5 => std::array::from_fn(|k| if k == l { 1.0 } else { 0.0 }),
            _ => (r.champion_id > 0).then(|| reparto(r.champion_id)).flatten().unwrap_or([0.2; 5]),
        })
        .collect();
    // Más de cinco no cabe en la Grieta: las que sobran se quedan con lo suyo.
    let n = dist.len().min(5);
    let mut post = vec![[0.0; 5]; n];
    let mut total = 0.0;
    let mut asignado = [0usize; 5];

    fn repartir(
        i: usize,
        usados: u8,
        peso: f64,
        dist: &[[f64; 5]],
        asignado: &mut [usize; 5],
        post: &mut [[f64; 5]],
        total: &mut f64,
    ) {
        if i == post.len() {
            *total += peso;
            for (k, l) in asignado.iter().take(post.len()).enumerate() {
                post[k][*l] += peso;
            }
            return;
        }
        for l in 0..5 {
            let p = dist[i][l];
            if usados & (1 << l) != 0 || p <= 0.0 {
                continue;
            }
            asignado[i] = l;
            repartir(i + 1, usados | (1 << l), peso * p, dist, asignado, post, total);
        }
    }
    repartir(0, 0, 1.0, &dist, &mut asignado, &mut post, &mut total);

    let mut out: Vec<[f64; 5]> = if total > 0.0 {
        post.iter().map(|p| std::array::from_fn(|l| p[l] / total)).collect()
    } else {
        dist[..n].to_vec()
    };
    out.extend_from_slice(&dist[n..]);
    out
}

/// A partir de esto, un rival «va» a un puesto: la vista lo dice y lo toma
/// como tu rival de carril. Por debajo, la vista dice que aún no se sabe.
pub const PROBABLE: f64 = 0.5;

/// Tu rival de carril: de los rivales con campeón, el que más probablemente
/// juega tu puesto, con su probabilidad, si llega a [`PROBABLE`].
pub fn rival_de_carril(rivales: &[Rival], post: &[[f64; 5]], puesto: usize) -> Option<(usize, f64)> {
    rivales
        .iter()
        .zip(post)
        .enumerate()
        .filter(|(_, (r, _))| r.champion_id > 0)
        .map(|(i, (_, p))| (i, p[puesto]))
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .filter(|(_, p)| *p >= PROBABLE)
}

// ------------------------------------------------------------ tus partidas

/// Una partida tuya, con lo que hace falta en la selección.
#[derive(Debug, Clone, Default)]
pub struct Partida {
    pub champion: String,
    /// Tu puesto ("JUNGLE"…); vacío si no se sabe.
    pub role: String,
    /// El campeón de tu rival de carril.
    pub rival: Option<String>,
    /// Los cinco del otro equipo.
    pub enemies: Vec<String>,
    pub win: bool,
    pub deaths: i32,
    /// Tu WPA en la partida (0-1). `None` sin los datos de Riot en disco.
    pub wpa: Option<f64>,
    /// Lo que te costó cada jugada (las del coach), con su vídeo si lo hay.
    pub plays: Vec<JugadaRef>,
}

/// Por debajo de esto la partida es un remake: no dice nada de nadie.
const DURACION_MIN: f64 = 300.0;

/// La partida en la forma de la selección. El rival de carril es el del otro
/// equipo con tu mismo puesto o, en las partidas viejas sin puestos, el del
/// mismo hueco (lo que hace «Tus rivales» en Patrones).
pub fn partida_de(meta: &MatchMetadata, coach: Option<&crate::coach::PartidaCoach>) -> Option<Partida> {
    let ps = &meta.participants;
    let i = ps.iter().position(|p| p.is_self)?;
    let yo = &ps[i];
    if meta.game_duration > 0.0 && meta.game_duration < DURACION_MIN {
        return None;
    }
    let role = if yo.role.is_empty() { coach.map(|c| c.role.clone()).unwrap_or_default() } else { yo.role.clone() };
    let enemigos: Vec<&crate::storage::Participant> = ps.iter().filter(|p| p.team_id != yo.team_id).collect();
    let rival = enemigos
        .iter()
        .find(|p| !role.is_empty() && p.role == role)
        .map(|p| p.champion.clone())
        .or_else(|| (ps.len() == 10 && enemigos.iter().all(|p| p.role.is_empty())).then(|| ps[(i + 5) % 10].champion.clone()));
    let plays = coach
        .map(|c| {
            c.plays
                .iter()
                .map(|j| JugadaRef {
                    match_id: meta.id.clone(),
                    champion: yo.champion.clone(),
                    date: meta.date.clone(),
                    time: j.time,
                    video_time: c.video_offset.map(|o| j.time + o),
                    lost: j.lost,
                    kind: j.kind.clone(),
                    killer: j.killer.clone(),
                    objective: j.objective.clone(),
                    state: j.state.clone(),
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Partida {
        champion: yo.champion.clone(),
        role,
        rival,
        enemies: enemigos.iter().map(|p| p.champion.clone()).collect(),
        win: yo.win,
        deaths: yo.deaths,
        wpa: coach.map(|c| c.wpa_tramo.iter().sum()),
        plays,
    })
}

/// Las del coach (sincronizadas, grabadas y de la Grieta), de la más
/// reciente a la más antigua.
fn leer_partidas() -> Vec<Partida> {
    crate::storage::load_all_matches()
        .iter()
        .filter(|m| crate::coach::cuenta(m))
        .filter_map(|m| partida_de(m, crate::coach::cacheada(m).as_ref()))
        .collect()
}

/// Una selección dura cinco minutos y la vista se pide en cada elección: tus
/// partidas se leen una vez y valen este rato. No cambian mientras eliges.
const VIGENCIA: Duration = Duration::from_secs(120);

static PARTIDAS: Mutex<Option<(Instant, Arc<Vec<Partida>>)>> = Mutex::new(None);

fn partidas() -> Arc<Vec<Partida>> {
    if let Ok(g) = PARTIDAS.lock() {
        if let Some((t, v)) = g.as_ref() {
            if t.elapsed() < VIGENCIA {
                return v.clone();
            }
        }
    }
    let v = Arc::new(leer_partidas());
    if let Ok(mut g) = PARTIDAS.lock() {
        *g = Some((Instant::now(), v.clone()));
    }
    v
}

/// El puesto que más juegas, para cuando el cliente no dice el tuyo (normal
/// a ciegas, personalizada). Empate: el de la partida más reciente.
pub fn rol_habitual(partidas: &[Partida]) -> Option<String> {
    let mut n: HashMap<&str, (usize, usize)> = HashMap::new();
    for (orden, p) in partidas.iter().enumerate().filter(|(_, p)| puesto_idx(&p.role).is_some()) {
        let e = n.entry(p.role.as_str()).or_insert((0, usize::MAX));
        e.0 += 1;
        e.1 = e.1.min(orden);
    }
    n.into_iter().max_by(|a, b| a.1 .0.cmp(&b.1 .0).then(b.1 .1.cmp(&a.1 .1))).map(|(r, _)| r.to_string())
}

fn en_rol<'a>(partidas: &'a [Partida], rol: Option<&'a str>) -> impl Iterator<Item = &'a Partida> {
    partidas.iter().filter(move |p| rol.is_none_or(|r| p.role == r))
}

// ------------------------------------------------------------ contra un campeón

/// Jugadas que se enseñan contra un campeón.
const JUGADAS_CONTRA: usize = 3;

/// Tu historial contra un campeón.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Contra {
    pub games: usize,
    pub wins: usize,
    /// WPA medio por partida (0-1), sobre las que lo tienen.
    pub wpa: Option<f64>,
    pub wpa_games: usize,
    pub deaths: f64,
    /// Las que más te costaron en esas partidas, de mayor a menor.
    pub plays: Vec<JugadaRef>,
}

/// Tu historial contra `campeon` en `rol`: con él de rival de carril
/// (`de_carril`), o en cualquier puesto del otro equipo.
pub fn contra(partidas: &[Partida], rol: Option<&str>, campeon: &str, de_carril: bool) -> Contra {
    let es = |p: &&Partida| {
        if de_carril {
            p.rival.as_deref() == Some(campeon)
        } else {
            p.enemies.iter().any(|e| e == campeon)
        }
    };
    let ps: Vec<&Partida> = en_rol(partidas, rol).filter(es).collect();
    let wpas: Vec<f64> = ps.iter().filter_map(|p| p.wpa).collect();
    let mut plays: Vec<JugadaRef> = ps.iter().flat_map(|p| p.plays.iter().cloned()).collect();
    plays.sort_by(|a, b| b.lost.total_cmp(&a.lost));
    plays.truncate(JUGADAS_CONTRA);
    Contra {
        games: ps.len(),
        wins: ps.iter().filter(|p| p.win).count(),
        wpa: (!wpas.is_empty()).then(|| wpas.iter().sum::<f64>() / wpas.len() as f64),
        wpa_games: wpas.len(),
        deaths: if ps.is_empty() { 0.0 } else { ps.iter().map(|p| p.deaths as f64).sum::<f64>() / ps.len() as f64 },
        plays,
    }
}

// ------------------------------------------------------------ tu pool

/// Partidas con un campeón para entrar en el pool con tier.
pub const POOL_MIN: usize = 3;

/// Por debajo de esto la vista avisa de que la muestra es corta. El mismo
/// corte que «indicio» en `confidenceOf` (`patterns.ts`).
pub const POOL_CORTA: usize = 15;

/// Partidas que vale tu media en el tier de un campeón: el WR con el que se
/// pone el tier es `(victorias + K·media) / (partidas + K)`.
///
/// Medido en el corpus (12.974 clasificatorias; `tests::tabla_de_carriles`
/// lo vuelve a sacar): el WR de un jugador con un campeón se aparta del suyo
/// con los demás poco más de lo que da el azar. Quitado el azar, la
/// dispersión real es de 5 puntos con los campeones de 5 partidas o más (456
/// parejas, K ≈ 96) y de 7 con los de 10 o más (114, K ≈ 48); con este
/// tamaño de muestra, las dos caben en un error de ±3 puntos. Se toma el
/// extremo que menos encoge. Con los cortes de iTero a un punto de distancia,
/// el WR crudo de 10 partidas pondría tiers al azar: 7-3 es S+ y 3-7 es INT,
/// y las dos cosas caben en la misma habilidad.
pub const POOL_K: f64 = 50.0;

/// Los cortes de iTero sobre el winrate en el carril.
pub const TIERS: [(f64, &str); 7] =
    [(0.54, "S+"), (0.52, "S"), (0.51, "A+"), (0.50, "A"), (0.49, "B"), (0.48, "C"), (0.47, "D")];

pub fn tier(wr: f64) -> &'static str {
    TIERS.iter().find(|(c, _)| wr >= *c - 1e-9).map(|(_, t)| *t).unwrap_or("INT")
}

/// WR encogido hacia `media` con el peso de [`POOL_K`] partidas.
pub fn wr_ajustado(wins: usize, games: usize, media: f64) -> f64 {
    (wins as f64 + POOL_K * media) / (games as f64 + POOL_K)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FilaPool {
    pub champion: String,
    pub games: usize,
    pub wins: usize,
    /// Tal cual: victorias / partidas.
    pub wr: f64,
    /// El de la tier ([`wr_ajustado`]).
    pub adjusted: f64,
    pub tier: String,
    pub wpa: Option<f64>,
    /// Menos de [`POOL_CORTA`] partidas.
    pub short: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Pool {
    /// Tus partidas en el rol.
    pub games: usize,
    /// Tu WR en el rol, ya encogido hacia el 50 %: la media hacia la que va
    /// cada campeón.
    pub mean: f64,
    pub rows: Vec<FilaPool>,
    /// Campeones con menos de [`POOL_MIN`] partidas, que no se listan.
    pub hidden: usize,
}

/// Tu pool en un rol, del mejor tier al peor.
pub fn pool(partidas: &[Partida], rol: Option<&str>) -> Pool {
    let mut por: HashMap<&str, (usize, usize, Vec<f64>)> = HashMap::new();
    let (mut games, mut wins) = (0, 0);
    for p in en_rol(partidas, rol) {
        let e = por.entry(p.champion.as_str()).or_default();
        e.0 += 1;
        e.1 += p.win as usize;
        e.2.extend(p.wpa);
        games += 1;
        wins += p.win as usize;
    }
    // Tu media en el rol también es una muestra: va hacia el 50 % igual.
    let mean = wr_ajustado(wins, games, 0.5);
    let mut rows: Vec<FilaPool> = por
        .iter()
        .filter(|(_, e)| e.0 >= POOL_MIN)
        .map(|(c, (g, w, wpa))| {
            let adjusted = wr_ajustado(*w, *g, mean);
            FilaPool {
                champion: c.to_string(),
                games: *g,
                wins: *w,
                wr: *w as f64 / *g as f64,
                adjusted,
                tier: tier(adjusted).to_string(),
                wpa: (!wpa.is_empty()).then(|| wpa.iter().sum::<f64>() / wpa.len() as f64),
                short: *g < POOL_CORTA,
            }
        })
        .collect();
    rows.sort_by(|a, b| b.adjusted.total_cmp(&a.adjusted).then(b.games.cmp(&a.games)).then(a.champion.cmp(&b.champion)));
    Pool { games, mean, hidden: por.len() - rows.len(), rows }
}

// ------------------------------------------------------------ baneos

/// Partidas contra un rival para sugerir banearlo.
pub const BAN_MIN: usize = 2;
const BANEOS: usize = 3;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IdeaBan {
    pub champion: String,
    pub games: usize,
    pub losses: usize,
}

/// Los rivales de carril contra los que más pierdes en el rol, con más
/// derrotas que victorias y al menos [`BAN_MIN`] partidas. `fuera` son los
/// que no tiene sentido banear: ya baneados, ya elegidos o en la mano de un
/// aliado.
pub fn baneos(partidas: &[Partida], rol: Option<&str>, fuera: &[String]) -> Vec<IdeaBan> {
    let mut por: HashMap<&str, (usize, usize)> = HashMap::new();
    for p in en_rol(partidas, rol) {
        let Some(r) = p.rival.as_deref() else { continue };
        let e = por.entry(r).or_default();
        e.0 += 1;
        e.1 += (!p.win) as usize;
    }
    let mut v: Vec<IdeaBan> = por
        .into_iter()
        .filter(|(c, (g, l))| *g >= BAN_MIN && 2 * l > *g && !fuera.iter().any(|f| f == c))
        .map(|(c, (g, l))| IdeaBan { champion: c.to_string(), games: g, losses: l })
        .collect();
    v.sort_by(|a, b| {
        b.losses
            .cmp(&a.losses)
            .then((b.losses * a.games).cmp(&(a.losses * b.games)))
            .then(a.champion.cmp(&b.champion))
    });
    v.truncate(BANEOS);
    v
}

// ------------------------------------------------------------ la vista

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RivalVista {
    /// `None` si aún no ha fijado.
    pub champion: Option<String>,
    /// Probabilidad de cada puesto, en el orden de [`PUESTOS`].
    pub lanes: [f64; 5],
    /// El puesto que juega, si llega a [`PROBABLE`].
    pub likely: Option<String>,
    /// Tu historial contra él de rival de carril, en tu rol.
    pub as_rival: Option<Contra>,
    /// Contra él en cualquier puesto del otro equipo, en tu rol.
    pub as_enemy: Option<Contra>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Vista {
    /// `timer.phase` del cliente.
    pub phase: Option<String>,
    pub queue_id: Option<i32>,
    /// `false` en ARAM, Arena y demás: sin carriles de los que hablar.
    pub rift: bool,
    /// El rol con que se arma la vista.
    pub role: Option<String>,
    /// De dónde sale: "assigned" (el cliente), "chosen" (lo elegiste aquí) o
    /// "usual" (el que más juegas).
    pub role_source: Option<String>,
    /// Tu campeón: fijado o en la mano.
    pub my_champion: Option<String>,
    pub my_locked: bool,
    pub enemies: Vec<RivalVista>,
    /// Índice en `enemies` de tu rival de carril, con su probabilidad.
    pub rival: Option<usize>,
    pub rival_probability: Option<f64>,
    pub bans: Vec<String>,
    pub pool: Pool,
    pub ban_ideas: Vec<IdeaBan>,
    /// Tus partidas que cuentan, en todos los roles.
    pub games: usize,
}

/// ¿Hay carriles? Lo dice el mapa de la cola (11 es la Grieta). Sin mapa, la
/// cola: las de la Grieta del coach y las personalizadas de la Grieta, que
/// desde 2026 tienen cola propia (3100 a ciegas, 3110 reclutamiento, 3120
/// todo aleatorio, 3130 torneo, 3140 herramienta de práctica; medido en el
/// cliente LA1). Sin nada, se supone que sí.
fn es_grieta(cola: Option<i32>, mapa: Option<i32>) -> bool {
    match mapa {
        Some(m) => m == 11,
        None => cola.is_none_or(|q| {
            matches!(q, 0 | 400 | 420 | 430 | 440 | 480 | 490 | 700 | 3100 | 3110 | 3120 | 3130 | 3140) || q < 0
        }),
    }
}

/// La vista de la selección: pura, para poder probarla. `elegido` es el rol
/// que el usuario ha puesto a mano en la pantalla.
pub fn armar(
    sel: &SeleccionLcu,
    cola: Option<i32>,
    mapa: Option<i32>,
    partidas: &[Partida],
    elegido: Option<&str>,
    nombre: impl Fn(i64) -> Option<String>,
    reparto: impl Fn(i64) -> Option<[f64; 5]>,
) -> Vista {
    let yo = sel.yo();
    let asignado = yo.and_then(|p| p.position.clone());
    let elegido = elegido.filter(|r| puesto_idx(r).is_some()).map(str::to_string);
    let (role, role_source) = match (elegido, asignado) {
        (Some(r), _) => (Some(r), Some("chosen")),
        (None, Some(r)) => (Some(r), Some("assigned")),
        (None, None) => match rol_habitual(partidas) {
            Some(r) => (Some(r), Some("usual")),
            None => (None, None),
        },
    };
    let rol = role.as_deref();

    let rivales: Vec<Rival> = sel
        .their_team
        .iter()
        .map(|p| Rival { champion_id: p.champion_id, position: p.position.as_deref().and_then(puesto_idx) })
        .collect();
    let post = carriles(&rivales, &reparto);
    let enemies: Vec<RivalVista> = rivales
        .iter()
        .zip(&post)
        .map(|(r, lanes)| {
            let champion = nombre(r.champion_id);
            let (l, p) = lanes.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map(|(l, p)| (l, *p)).unwrap_or((0, 0.0));
            RivalVista {
                as_rival: champion.as_deref().map(|c| contra(partidas, rol, c, true)),
                as_enemy: champion.as_deref().map(|c| contra(partidas, rol, c, false)),
                likely: (p >= PROBABLE).then(|| PUESTOS[l].to_string()),
                champion,
                lanes: *lanes,
            }
        })
        .collect();
    let rival = rol.and_then(puesto_idx).and_then(|l| rival_de_carril(&rivales, &post, l));

    let bans: Vec<String> = sel.bans.iter().filter_map(|c| nombre(*c)).collect();
    // No se sugiere banear lo que ya no se puede elegir ni lo que tiene en la
    // mano un aliado.
    let fuera: Vec<String> = sel
        .my_team
        .iter()
        .chain(&sel.their_team)
        .filter_map(|p| nombre(p.champion_id))
        .chain(bans.iter().cloned())
        .collect();

    Vista {
        phase: sel.phase.clone(),
        queue_id: cola,
        rift: es_grieta(cola, mapa),
        role_source: role_source.map(str::to_string),
        my_champion: yo.and_then(|p| nombre(p.champion_id)),
        my_locked: yo.is_some_and(|p| p.locked),
        rival: rival.map(|r| r.0),
        rival_probability: rival.map(|r| r.1),
        enemies,
        bans,
        pool: pool(partidas, rol),
        ban_ideas: baneos(partidas, rol, &fuera),
        games: partidas.len(),
        role,
    }
}

/// La vista de la selección en curso, o `None` fuera de ella. `role` es el
/// rol que el usuario haya puesto a mano en la pantalla.
#[tauri::command]
pub async fn get_champ_select(role: Option<String>) -> Option<Vista> {
    let sel = crate::lcu::seleccion()?;
    let st = crate::lcu::status();
    tokio::task::spawn_blocking(move || {
        let ps = partidas();
        armar(&sel, st.queue_id, st.map_id, &ps, role.as_deref(), nombre, reparto)
    })
    .await
    .ok()
}

/// Lo que cubre `a` del área de `b`, de 0 a 1. Rectángulos como
/// (izquierda, arriba, derecha, abajo).
pub fn solape(a: (i32, i32, i32, i32), b: (i32, i32, i32, i32)) -> f64 {
    let w = (a.2.min(b.2) - a.0.max(b.0)).max(0) as f64;
    let h = (a.3.min(b.3) - a.1.max(b.1)).max(0) as f64;
    let area = ((b.2 - b.0).max(0) as f64) * ((b.3 - b.1).max(0) as f64);
    if area <= 0.0 { 0.0 } else { w * h / area }
}

/// La app se pone delante al entrar en la selección, sin quitarle el teclado
/// a nadie. Devuelve qué hizo: "front" (ya lo estaba), "raised", "covers"
/// (no se sube porque taparía la ventana que estás usando, que en una
/// selección es el cliente: con un solo monitor no se le tapa el reloj de la
/// elección a nadie) o "failed".
#[tauri::command]
pub fn champ_select_bring_forward(window: tauri::WebviewWindow) -> String {
    #[cfg(target_os = "windows")]
    {
        match window.hwnd() {
            Ok(h) => crate::winsys::subir_sin_foco(h.0 as _).to_string(),
            Err(_) => "failed".into(),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        "failed".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lcu::Plaza;

    /// Una tabla de mentira: el reparto de cada campeón sale de aquí.
    fn tabla(id: i64) -> Option<[f64; 5]> {
        match id {
            // Lee Sin: jungla casi siempre.
            1 => Some([0.01, 0.96, 0.01, 0.01, 0.01]),
            // Un Graves de mentira: jungla o arriba, sin ser jungla puro.
            2 => Some([0.30, 0.60, 0.05, 0.04, 0.01]),
            // Ahri: medio.
            3 => Some([0.02, 0.01, 0.95, 0.01, 0.01]),
            // Jinx y Thresh.
            4 => Some([0.01, 0.01, 0.02, 0.95, 0.01]),
            5 => Some([0.01, 0.01, 0.01, 0.02, 0.95]),
            // Garen: arriba.
            6 => Some([0.90, 0.02, 0.05, 0.02, 0.01]),
            // Syndra y Orianna: las dos de medio.
            7 => Some([0.02, 0.01, 0.90, 0.05, 0.02]),
            8 => Some([0.01, 0.01, 0.85, 0.03, 0.10]),
            _ => None,
        }
    }

    fn r(champion_id: i64) -> Rival {
        Rival { champion_id, position: None }
    }

    fn id_de(nombre: &str) -> Option<i64> {
        crate::carriles_campeon::CARRILES.iter().find(|f| f.1 == nombre).map(|f| f.0)
    }

    fn mas_probable(p: &[f64; 5]) -> usize {
        p.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0
    }

    const TOP: usize = 0;
    const JUNGLA: usize = 1;
    const MEDIO: usize = 2;

    #[test]
    fn un_equipo_entero_se_reparte_un_puesto_por_cabeza() {
        let rivales = [r(6), r(1), r(3), r(4), r(5)];
        let post = carriles(&rivales, tabla);
        let puestos: Vec<usize> = post.iter().map(mas_probable).collect();
        assert_eq!(puestos, vec![0, 1, 2, 3, 4]);
        for p in &post {
            assert!((p.iter().sum::<f64>() - 1.0).abs() < 1e-9);
        }
        // Cada puesto también suma 1 entre las cinco plazas.
        for l in 0..5 {
            assert!((post.iter().map(|p| p[l]).sum::<f64>() - 1.0).abs() < 1e-9);
        }
    }

    #[test]
    fn un_jungla_claro_manda_al_otro_a_su_segundo_puesto() {
        // Solo, Graves es jungla el 60 %…
        let solo = carriles(&[r(2), r(0), r(0), r(0), r(0)], tabla);
        assert_eq!(mas_probable(&solo[0]), JUNGLA);
        assert!((solo[0][JUNGLA] - 0.60).abs() < 1e-9, "las plazas vacías no cambian nada: {:?}", solo[0]);
        // …pero con Lee Sin en el equipo, Graves va arriba.
        let con = carriles(&[r(2), r(1), r(0), r(0), r(0)], tabla);
        assert_eq!(mas_probable(&con[0]), TOP);
        assert_eq!(mas_probable(&con[1]), JUNGLA);
        // Lo que no es jungla de Graves, repartido: 0,30 de 0,40 va arriba.
        assert!(con[0][TOP] > 0.65, "{:?}", con[0]);
        assert!(con[0][JUNGLA] < 0.1, "{:?}", con[0]);
    }

    #[test]
    fn dos_magos_de_medio_se_reparten_medio_y_otro_puesto() {
        // Syndra y Orianna: una va a medio y la otra a lo que mejor le encaje
        // de lo que quede (Orianna de support antes que Syndra).
        let post = carriles(&[r(7), r(8), r(0), r(0), r(0)], tabla);
        assert!((post[0][MEDIO] + post[1][MEDIO] - 1.0).abs() < 0.2, "{post:?}");
        assert!(post[0][MEDIO] > post[1][MEDIO]);
        assert!(post[1][4] > post[0][4]);
    }

    #[test]
    fn el_puesto_que_da_el_cliente_manda() {
        let rivales = [Rival { champion_id: 3, position: Some(TOP) }, r(0), r(0), r(0), r(0)];
        let post = carriles(&rivales, tabla);
        assert_eq!(post[0], [1.0, 0.0, 0.0, 0.0, 0.0]);
        // Dos con el mismo puesto no tienen reparto posible: cada uno lo suyo.
        let raros = [Rival { champion_id: 3, position: Some(TOP) }, Rival { champion_id: 6, position: Some(TOP) }];
        let post = carriles(&raros, tabla);
        assert_eq!(post[0][TOP], 1.0);
        assert_eq!(post[1][TOP], 1.0);
    }

    #[test]
    fn un_campeon_que_no_esta_en_la_tabla_cuenta_como_cualquiera() {
        let post = carriles(&[r(999), r(1)], tabla);
        assert!(post[0][JUNGLA] < 0.05, "Lee Sin se queda la jungla: {:?}", post[0]);
        assert!((post[0][TOP] - 0.25).abs() < 0.01);
    }

    #[test]
    fn el_rival_de_carril_solo_si_es_probable() {
        let rivales = [r(2), r(0), r(0), r(0), r(0)];
        let post = carriles(&rivales, tabla);
        // Jungla: Graves, con su 60 %.
        assert_eq!(rival_de_carril(&rivales, &post, JUNGLA).map(|x| x.0), Some(0));
        // Arriba: un 30 % no basta para decir que es tu rival.
        assert_eq!(rival_de_carril(&rivales, &post, TOP), None);
        // Medio: nadie a la vista.
        assert_eq!(rival_de_carril(&rivales, &post, MEDIO), None);
        // Las plazas sin campeón no son rivales aunque tengan probabilidad.
        let nadie = [r(0); 5];
        let post = carriles(&nadie, tabla);
        assert_eq!(rival_de_carril(&nadie, &post, MEDIO), None);
    }

    /// Con la tabla de verdad, los de siempre van a su sitio.
    #[test]
    fn la_tabla_del_corpus_pone_a_cada_uno_en_su_sitio() {
        if crate::carriles_campeon::CARRILES.is_empty() {
            return;
        }
        let id = |n: &str| id_de(n).unwrap_or_else(|| panic!("{n} no está en la tabla"));
        for (campeon, puesto) in
            [("Garen", "TOP"), ("LeeSin", "JUNGLE"), ("Ahri", "MIDDLE"), ("Jinx", "BOTTOM"), ("Thresh", "UTILITY")]
        {
            let p = reparto(id(campeon)).unwrap();
            assert_eq!(PUESTOS[mas_probable(&p)], puesto, "{campeon}: {p:?}");
        }
        // Sola, Gwen va arriba (40 %) o por medio (34 %); con Lee Sin y Ahri
        // a la vista, arriba (83 %).
        let gwen = id("Gwen");
        assert!(reparto(gwen).unwrap()[TOP] < 0.5);
        let post = carriles(&[r(gwen), r(id("LeeSin")), r(id("Ahri")), r(0), r(0)], reparto);
        assert!(post[0][TOP] > 0.8, "{:?}", post[0]);
        // Dos junglas a la vez: uno de los dos es el jungla, sin saber cuál.
        let post = carriles(&[r(id("Graves")), r(id("LeeSin")), r(0), r(0), r(0)], reparto);
        assert!((post[0][JUNGLA] + post[1][JUNGLA] - 1.0).abs() < 0.05, "{post:?}");
        assert!(post[0][JUNGLA] > 0.4 && post[1][JUNGLA] > 0.4);
        // Ordenada por id: `en_tabla` busca por bisección.
        assert!(crate::carriles_campeon::CARRILES.windows(2).all(|w| w[0].0 < w[1].0));
        assert_eq!(nombre(id("Gwen")).as_deref(), Some("Gwen"));
        assert_eq!(nombre(0), None);
    }

    // -------------------------------------------------------- tus partidas

    fn partida(champion: &str, role: &str, rival: &str, win: bool) -> Partida {
        Partida {
            champion: champion.into(),
            role: role.into(),
            rival: Some(rival.into()),
            enemies: vec![rival.into(), "Ahri".into()],
            win,
            deaths: if win { 2 } else { 6 },
            wpa: Some(if win { 0.10 } else { -0.05 }),
            plays: Vec::new(),
        }
    }

    fn muchas(n: usize, champion: &str, role: &str, rival: &str, wins: usize) -> Vec<Partida> {
        (0..n).map(|i| partida(champion, role, rival, i < wins)).collect()
    }

    #[test]
    fn los_cortes_de_itero() {
        let casos = [
            (0.60, "S+"),
            (0.54, "S+"),
            (0.539, "S"),
            (0.52, "S"),
            (0.515, "A+"),
            (0.51, "A+"),
            (0.50, "A"),
            (0.495, "B"),
            (0.48, "C"),
            (0.47, "D"),
            (0.469, "INT"),
            (0.30, "INT"),
        ];
        for (wr, t) in casos {
            assert_eq!(tier(wr), t, "{wr}");
        }
    }

    #[test]
    fn el_pool_encoge_las_muestras_cortas_hacia_tu_media() {
        let mut ps = muchas(30, "Gwen", "JUNGLE", "LeeSin", 18); // 60 %
        ps.extend(muchas(3, "Viego", "JUNGLE", "LeeSin", 3)); // 3-0
        ps.extend(muchas(3, "Shaco", "JUNGLE", "LeeSin", 0)); // 0-3
        ps.extend(muchas(2, "Kayn", "JUNGLE", "LeeSin", 2)); // no llega al mínimo
        ps.extend(muchas(9, "Ahri", "MIDDLE", "Zed", 9)); // otro rol
        let p = pool(&ps, Some("JUNGLE"));
        assert_eq!(p.games, 38);
        assert_eq!(p.hidden, 1, "Kayn con 2 partidas no se lista");
        let fila = |c: &str| p.rows.iter().find(|f| f.champion == c).unwrap();
        // Un 3-0 no es un 100 %: se queda a menos de 3 puntos de tu media, a
        // la par de Gwen, que tiene 30 partidas al 60 % (las dos le sacan a
        // tu media unas victorias y media; a Gwen se le reparten en más).
        assert_eq!(fila("Viego").wr, 1.0);
        assert!(fila("Viego").adjusted > p.mean && fila("Viego").adjusted - p.mean < 0.03, "{:?}", fila("Viego"));
        assert!((fila("Gwen").adjusted - fila("Viego").adjusted).abs() < 0.01);
        assert_eq!(fila("Gwen").tier, "S+");
        // Un 0-3 tampoco es INT de entrada.
        assert_eq!(fila("Shaco").wr, 0.0);
        assert_ne!(fila("Shaco").tier, "INT");
        assert!(fila("Shaco").adjusted < p.mean);
        // La muestra corta se avisa.
        assert!(fila("Viego").short && !fila("Gwen").short);
        // Las de otro rol no entran.
        assert!(p.rows.iter().all(|f| f.champion != "Ahri"));
        // WPA medio.
        assert!((fila("Viego").wpa.unwrap() - 0.10).abs() < 1e-9);
    }

    #[test]
    fn el_pool_vacio_y_sin_rol() {
        let p = pool(&[], Some("JUNGLE"));
        assert_eq!(p.games, 0);
        assert!(p.rows.is_empty());
        assert_eq!(p.mean, 0.5);
        // Sin rol entran todas.
        let ps = muchas(4, "Ahri", "MIDDLE", "Zed", 2);
        assert_eq!(pool(&ps, None).rows.len(), 1);
    }

    #[test]
    fn mucho_ganar_acaba_en_s_mas() {
        // 40-20 con un WR en el rol del 60 %: ya es una muestra que dice algo.
        let ps = muchas(60, "Gwen", "JUNGLE", "LeeSin", 40);
        let p = pool(&ps, Some("JUNGLE"));
        assert_eq!(p.rows[0].tier, "S+");
        // Y mucho perder, en INT.
        let ps = muchas(60, "Gwen", "JUNGLE", "LeeSin", 15);
        assert_eq!(pool(&ps, Some("JUNGLE")).rows[0].tier, "INT");
    }

    #[test]
    fn contra_tu_rival() {
        let mut ps = muchas(4, "Gwen", "JUNGLE", "LeeSin", 1);
        ps.extend(muchas(3, "Gwen", "JUNGLE", "Viego", 3));
        ps.extend(muchas(2, "Ahri", "MIDDLE", "LeeSin", 0)); // otro rol
        ps[0].plays = vec![jugada("a", 100.0, 0.02), jugada("a", 200.0, 0.09)];
        ps[1].plays = vec![jugada("b", 50.0, 0.05), jugada("b", 70.0, 0.01)];
        let c = contra(&ps, Some("JUNGLE"), "LeeSin", true);
        assert_eq!((c.games, c.wins), (4, 1));
        assert!((c.deaths - (2.0 + 6.0 * 3.0) / 4.0).abs() < 1e-9);
        assert!((c.wpa.unwrap() - (0.10 - 0.05 * 3.0) / 4.0).abs() < 1e-9);
        // Las tres que más costaron, de mayor a menor.
        let lost: Vec<f64> = c.plays.iter().map(|j| j.lost).collect();
        assert_eq!(lost, vec![0.09, 0.05, 0.02]);
        // Sin rol, también las de medio.
        assert_eq!(contra(&ps, None, "LeeSin", true).games, 6);
        // En cualquier puesto del otro equipo: Ahri va en todas.
        assert_eq!(contra(&ps, Some("JUNGLE"), "Ahri", false).games, 7);
        assert_eq!(contra(&ps, Some("JUNGLE"), "Ahri", true).games, 0);
        let nadie = contra(&ps, Some("JUNGLE"), "Teemo", true);
        assert_eq!((nadie.games, nadie.wpa, nadie.deaths), (0, None, 0.0));
    }

    fn jugada(m: &str, time: f64, lost: f64) -> JugadaRef {
        JugadaRef {
            match_id: m.into(),
            champion: "Gwen".into(),
            date: String::new(),
            time,
            video_time: Some(time + 20.0),
            lost,
            kind: "death".into(),
            killer: Some("LeeSin".into()),
            objective: None,
            state: None,
        }
    }

    #[test]
    fn la_sugerencia_de_baneo() {
        let mut ps = muchas(5, "Gwen", "JUNGLE", "LeeSin", 1); // 4 derrotas
        ps.extend(muchas(3, "Gwen", "JUNGLE", "Viego", 0)); // 3 derrotas, 0 %
        ps.extend(muchas(4, "Gwen", "JUNGLE", "Graves", 2)); // empate: fuera
        ps.extend(muchas(1, "Gwen", "JUNGLE", "Shaco", 0)); // una sola: fuera
        ps.extend(muchas(6, "Gwen", "JUNGLE", "Kayn", 2)); // 4 derrotas, 67 %
        ps.extend(muchas(5, "Ahri", "MIDDLE", "Zed", 0)); // otro rol
        let b: Vec<String> = baneos(&ps, Some("JUNGLE"), &[]).into_iter().map(|b| b.champion).collect();
        // Más derrotas primero; a igualdad, la peor proporción.
        assert_eq!(b, vec!["LeeSin", "Kayn", "Viego"]);
        // Lo que ya está baneado o elegido no se sugiere.
        let b: Vec<String> = baneos(&ps, Some("JUNGLE"), &["LeeSin".into()]).into_iter().map(|b| b.champion).collect();
        assert_eq!(b, vec!["Kayn", "Viego"]);
    }

    #[test]
    fn el_rol_habitual() {
        let mut ps = muchas(3, "Gwen", "JUNGLE", "LeeSin", 1);
        ps.extend(muchas(2, "Ahri", "MIDDLE", "Zed", 1));
        assert_eq!(rol_habitual(&ps).as_deref(), Some("JUNGLE"));
        // Empate: el de la más reciente (las partidas van de nueva a vieja).
        let mut ps = muchas(2, "Ahri", "MIDDLE", "Zed", 1);
        ps.extend(muchas(2, "Gwen", "JUNGLE", "LeeSin", 1));
        assert_eq!(rol_habitual(&ps).as_deref(), Some("MIDDLE"));
        assert_eq!(rol_habitual(&[]), None);
    }

    // -------------------------------------------------------- la vista

    fn nombre_de(id: i64) -> Option<String> {
        match id {
            1 => Some("LeeSin".into()),
            2 => Some("Graves".into()),
            3 => Some("Ahri".into()),
            6 => Some("Garen".into()),
            10 => Some("Gwen".into()),
            11 => Some("Viego".into()),
            _ => None,
        }
    }

    fn plaza(cell: i64, champion_id: i64, position: Option<&str>) -> Plaza {
        Plaza { cell, champion_id, locked: champion_id > 0, position: position.map(str::to_string) }
    }

    fn seleccion(mi_puesto: Option<&str>, rivales: &[i64]) -> SeleccionLcu {
        SeleccionLcu {
            local_cell: 1,
            my_team: vec![plaza(0, 0, Some("TOP")), plaza(1, 10, mi_puesto), plaza(2, 11, None)],
            their_team: rivales.iter().enumerate().map(|(i, c)| plaza(5 + i as i64, *c, None)).collect(),
            bans: vec![6],
            phase: Some("BAN_PICK".into()),
        }
    }

    #[test]
    fn la_vista_con_el_rol_del_cliente() {
        let mut ps = muchas(4, "Gwen", "JUNGLE", "LeeSin", 1);
        ps.extend(muchas(3, "Gwen", "JUNGLE", "Graves", 0));
        ps.extend(muchas(6, "Ahri", "MIDDLE", "Zed", 6));
        let v = armar(&seleccion(Some("JUNGLE"), &[1, 0, 3, 0, 0]), Some(420), None, &ps, None, nombre_de, tabla);
        assert_eq!(v.role.as_deref(), Some("JUNGLE"));
        assert_eq!(v.role_source.as_deref(), Some("assigned"));
        assert!(v.rift);
        assert_eq!(v.my_champion.as_deref(), Some("Gwen"));
        assert_eq!(v.enemies.len(), 5);
        assert_eq!(v.rival, Some(0), "Lee Sin es tu rival en la jungla");
        assert!(v.rival_probability.unwrap() > 0.9);
        let lee = &v.enemies[0];
        assert_eq!(lee.likely.as_deref(), Some("JUNGLE"));
        assert_eq!(lee.as_rival.as_ref().map(|c| (c.games, c.wins)), Some((4, 1)));
        // La plaza sin campeón no tiene historial.
        assert!(v.enemies[1].champion.is_none() && v.enemies[1].as_rival.is_none());
        assert_eq!(v.bans, vec!["Garen"]);
        // Pool y baneos del rol: ni Ahri en el pool ni Zed en los baneos.
        assert_eq!(v.pool.games, 7);
        assert_eq!(v.pool.rows.iter().map(|f| f.champion.as_str()).collect::<Vec<_>>(), vec!["Gwen"]);
        // Lee Sin ya está elegido: no se sugiere banearlo.
        assert_eq!(v.ban_ideas.iter().map(|b| b.champion.as_str()).collect::<Vec<_>>(), vec!["Graves"]);
    }

    #[test]
    fn la_vista_sin_rol_del_cliente_usa_el_habitual_o_el_elegido() {
        let mut ps = muchas(4, "Gwen", "JUNGLE", "LeeSin", 1);
        ps.extend(muchas(2, "Ahri", "MIDDLE", "Zed", 1));
        let sel = seleccion(None, &[3, 0, 0, 0, 0]);
        let v = armar(&sel, None, None, &ps, None, nombre_de, tabla);
        assert_eq!((v.role.as_deref(), v.role_source.as_deref()), (Some("JUNGLE"), Some("usual")));
        assert_eq!(v.rival, None, "Ahri no va a la jungla");
        let v = armar(&sel, None, None, &ps, Some("MIDDLE"), nombre_de, tabla);
        assert_eq!((v.role.as_deref(), v.role_source.as_deref()), (Some("MIDDLE"), Some("chosen")));
        assert_eq!(v.rival, Some(0));
        // Un rol que no existe se ignora.
        let v = armar(&sel, None, None, &ps, Some("SUPPORT"), nombre_de, tabla);
        assert_eq!(v.role_source.as_deref(), Some("usual"));
        // Sin partidas no hay rol que suponer.
        let v = armar(&sel, None, None, &[], None, nombre_de, tabla);
        assert_eq!(v.role, None);
        assert!(v.pool.rows.is_empty());
    }

    #[test]
    fn en_aram_no_hay_grieta() {
        let rift = |cola, mapa| armar(&seleccion(None, &[]), cola, mapa, &[], None, nombre_de, tabla).rift;
        assert!(!rift(Some(450), None));
        assert!(!rift(Some(450), Some(12)));
        assert!(rift(Some(420), Some(11)));
        // Personalizada de la Grieta a ciegas: cola 3100 (medido en el cliente).
        assert!(rift(Some(3100), Some(11)));
        assert!(rift(Some(3100), None));
        // Personalizada del Abismo: cola propia y mapa 12.
        assert!(!rift(Some(3200), Some(12)));
        assert!(rift(Some(-1), None));
        assert!(rift(None, None));
    }

    #[test]
    fn solape_de_ventanas() {
        let cliente = (0, 0, 1280, 720);
        assert_eq!(solape((0, 0, 1920, 1080), cliente), 1.0);
        assert_eq!(solape((1920, 0, 3840, 1080), cliente), 0.0, "otro monitor");
        assert!((solape((640, 0, 1920, 1080), cliente) - 0.5).abs() < 1e-9);
        assert_eq!(solape((0, 0, 10, 10), (0, 0, 0, 0)), 0.0);
    }

    // -------------------------------------------------------- partida_de

    fn participante(champion: &str, team_id: i32, role: &str, is_self: bool) -> crate::storage::Participant {
        crate::storage::Participant {
            champion: champion.into(),
            name: String::new(),
            team_id,
            win: team_id == 100,
            level: 18,
            kills: 1,
            deaths: 3,
            assists: 2,
            cs: 100,
            gold: 10_000,
            is_self,
            items: Vec::new(),
            spells: Vec::new(),
            tag: String::new(),
            damage: 0,
            vision_score: 0,
            wards_placed: 0,
            role: role.into(),
        }
    }

    #[test]
    fn el_rival_de_carril_de_una_partida() {
        let roles = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
        let azules = ["Garen", "Gwen", "Ahri", "Jinx", "Thresh"];
        let rojos = ["Darius", "LeeSin", "Zed", "Kaisa", "Nautilus"];
        let mut ps: Vec<_> = azules.iter().zip(roles).map(|(c, r)| participante(c, 100, r, *c == "Gwen")).collect();
        // El rojo en otro orden: el rival es el del mismo puesto, no el del hueco.
        let mut rojo: Vec<_> = rojos.iter().zip(roles).map(|(c, r)| participante(c, 200, r, false)).collect();
        rojo.swap(1, 2);
        ps.extend(rojo);
        let meta = MatchMetadata { id: "m".into(), game_duration: 1800.0, participants: ps.clone(), ..Default::default() };
        let p = partida_de(&meta, None).unwrap();
        assert_eq!(p.rival.as_deref(), Some("LeeSin"));
        assert_eq!((p.champion.as_str(), p.role.as_str(), p.win, p.deaths), ("Gwen", "JUNGLE", true, 3));
        assert_eq!(p.enemies.len(), 5);
        assert_eq!(p.wpa, None);
        // Sin puestos (partidas viejas): el del mismo hueco.
        let sin: Vec<_> = ps.iter().cloned().map(|mut x| { x.role.clear(); x }).collect();
        let meta2 = MatchMetadata { participants: sin, ..meta.clone() };
        assert_eq!(partida_de(&meta2, None).unwrap().rival.as_deref(), Some("Zed"));
        // Un remake no cuenta.
        let remake = MatchMetadata { game_duration: 200.0, ..meta };
        assert!(partida_de(&remake, None).is_none());
    }

    // -------------------------------------------------------- la tabla

    /// Genera `carriles_campeon.rs` desde el corpus, o comprueba que el
    /// compilado siga cuadrando. De paso vuelve a medir [`POOL_K`].
    ///
    /// `CORPUS_DIR=D:/lol-corpus [CARRILES_ESCRIBIR=1] cargo test --release --lib champ_select::tests::tabla_de_carriles -- --nocapture`
    #[test]
    fn tabla_de_carriles() {
        let Ok(corpus) = std::env::var("CORPUS_DIR") else { return };
        let ficheros = ficheros_del_corpus(&corpus);
        let hilos = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let t0 = Instant::now();
        let trozos: Vec<Vec<Fila>> = std::thread::scope(|s| {
            let hs: Vec<_> = ficheros
                .chunks(ficheros.len().div_ceil(hilos).max(1))
                .map(|t| s.spawn(move || t.iter().filter_map(|f| leer(f)).collect::<Vec<Fila>>()))
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let partidas: Vec<Fila> = trozos.into_iter().flatten().collect();
        if partidas.len() < 50 {
            println!("corpus demasiado pequeño ({} partidas), no se comprueba", partidas.len());
            return;
        }
        println!("\n{} partidas en {:?}", partidas.len(), t0.elapsed());

        let mut tabla: std::collections::BTreeMap<i64, (String, [u32; 5])> = Default::default();
        for p in &partidas {
            for (_, id, nombre, puesto, _) in p {
                let Some(l) = puesto_idx(puesto) else { continue };
                tabla.entry(*id).or_insert_with(|| (nombre.clone(), [0; 5])).1[l] += 1;
            }
        }
        medir_pool_k(&partidas);

        let mut s = format!(
            "//! El puesto de cada campeón en el corpus: la tabla con la que la selección\n\
             //! de campeón (`crate::champ_select`) infiere el carril de los rivales, que\n\
             //! el cliente no da en clasificatoria.\n\
             //!\n\
             //! GENERADO por `champ_select::tests::tabla_de_carriles` sobre `{corpus}`\n\
             //! ({} partidas). No editar a mano: con `CARRILES_ESCRIBIR=1` el test lo\n\
             //! reescribe, y sin él comprueba que sigue cuadrando con el corpus.\n\
             //!\n\
             //!     CORPUS_DIR=D:/lol-corpus CARRILES_ESCRIBIR=1 cargo test --release --lib champ_select::tests::tabla_de_carriles -- --nocapture\n\n\
             /// (championId, championName, partidas en TOP, JUNGLE, MIDDLE, BOTTOM, UTILITY),\n\
             /// por id: se busca por bisección.\n\
             pub(crate) const CARRILES: &[(i64, &str, [u32; 5])] = &[\n",
            partidas.len()
        );
        for (id, (nombre, n)) in &tabla {
            s.push_str(&format!(
                "    ({id}, \"{nombre}\", [{}]),\n",
                n.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", ")
            ));
        }
        s.push_str("];\n");
        println!("{} campeones", tabla.len());

        if std::env::var("CARRILES_ESCRIBIR").is_ok() {
            let ruta = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/carriles_campeon.rs");
            std::fs::write(&ruta, &s).unwrap();
            println!("escrito {}", ruta.display());
            return;
        }
        assert!(!crate::carriles_campeon::CARRILES.is_empty(), "carriles_campeon.rs está sin generar: CARRILES_ESCRIBIR=1");
        let compilada: HashMap<i64, [u32; 5]> = crate::carriles_campeon::CARRILES.iter().map(|f| (f.0, f.2)).collect();
        let desviados: Vec<String> = tabla
            .iter()
            .filter(|(id, (_, n))| compilada.get(id) != Some(n))
            .map(|(id, (nombre, n))| format!("{nombre} ({id}): {:?} → {n:?}", compilada.get(id)))
            .collect();
        assert!(desviados.is_empty(), "la tabla de carriles se ha quedado desfasada:\n{}", desviados.join("\n"));
    }

    /// (puuid, championId, championName, teamPosition, win) de cada jugador.
    type Fila = Vec<(String, i64, String, String, bool)>;

    fn ficheros_del_corpus(corpus: &str) -> Vec<std::path::PathBuf> {
        let mut v: Vec<std::path::PathBuf> = std::fs::read_dir(format!("{corpus}/partidas"))
            .into_iter()
            .flatten()
            .flatten()
            .flat_map(|d| std::fs::read_dir(d.path()).into_iter().flatten().flatten().map(|f| f.path()))
            .collect();
        v.sort();
        v
    }

    /// Solo los participantes: la línea de tiempo se salta sin construirla.
    fn leer(f: &std::path::Path) -> Option<Fila> {
        use serde::Deserialize;
        use std::io::Read;
        #[derive(Deserialize)]
        struct Fichero {
            #[serde(rename = "match")]
            partida: Match,
        }
        #[derive(Deserialize)]
        struct Match {
            info: Info,
        }
        #[derive(Deserialize)]
        struct Info {
            participants: Vec<P>,
        }
        #[derive(Deserialize)]
        #[allow(non_snake_case)]
        struct P {
            #[serde(default)]
            puuid: String,
            championId: i64,
            championName: String,
            #[serde(default)]
            teamPosition: String,
            #[serde(default)]
            win: bool,
        }
        let mut texto = String::new();
        flate2::read::GzDecoder::new(&std::fs::read(f).ok()?[..]).read_to_string(&mut texto).ok()?;
        let d: Fichero = serde_json::from_str(&texto).ok()?;
        Some(d.partida.info.participants.into_iter().map(|p| (p.puuid, p.championId, p.championName, p.teamPosition, p.win)).collect())
    }

    /// Cuánto se aparta de verdad el WR de un jugador con un campeón del suyo
    /// con los demás: la varianza observada menos la del azar. De ahí sale
    /// [`POOL_K`] = p(1-p)/τ² - 1.
    fn medir_pool_k(partidas: &[Fila]) {
        let mut por: HashMap<(&str, i64), (u32, u32)> = HashMap::new();
        let mut tot: HashMap<&str, (u32, u32)> = HashMap::new();
        for p in partidas {
            for (puuid, id, _, _, win) in p {
                let e = por.entry((puuid.as_str(), *id)).or_default();
                e.0 += 1;
                e.1 += *win as u32;
                let t = tot.entry(puuid.as_str()).or_default();
                t.0 += 1;
                t.1 += *win as u32;
            }
        }
        for m in [5, 10] {
            let (mut obs, mut azar, mut n) = (0.0, 0.0, 0);
            for ((puuid, _), (g, w)) in &por {
                let (gt, wt) = tot[puuid];
                if *g < m || gt - g < 20 {
                    continue;
                }
                let resto = (wt - w) as f64 / (gt - g) as f64;
                obs += (*w as f64 / *g as f64 - resto).powi(2);
                azar += resto * (1.0 - resto) * (1.0 / *g as f64 + 1.0 / (gt - g) as f64);
                n += 1;
            }
            if n > 0 {
                let tau2 = (obs - azar) / n as f64;
                println!(
                    "WR por campeón con ≥{m} partidas: {n} parejas, varianza {:.4}, azar {:.4}, real {tau2:.5} (K ≈ {})",
                    obs / n as f64,
                    azar / n as f64,
                    if tau2 > 0.0 { format!("{:.0}", 0.25 / tau2 - 1.0) } else { "∞".into() }
                );
            }
        }
    }
}
