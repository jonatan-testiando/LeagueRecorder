//! El plan de 10 partidas del coach: §2.4 de `docs/coach-de-macro-diseno.md`.
//!
//! Fijas un foco (una categoría × tramo de `coach`), juegas diez partidas y el
//! plan se cierra con un antes y un después medidos: lo que te costó el foco
//! por partida en las de antes frente a las diez del plan, con un intervalo de
//! confianza y un veredicto que no dice más de lo que diez partidas permiten.
//!
//! # Qué cuenta
//!
//! - **Antes:** las últimas [`ANTES_MAX`] partidas en que el foco se puede
//!   medir, de las jugadas antes de empezar. Con menos de [`ANTES_MIN`] no se
//!   empieza: es el estado «pocas partidas».
//! - **Después:** cada partida que se sincroniza con un plan en curso y se jugó
//!   después de empezarlo. Las que no miden el foco (acabó antes del tramo, o
//!   es una categoría de vídeo sin las miradas grabadas) se guardan, pero no
//!   cuentan para las diez: no dicen nada del foco.
//! - El coste de cada partida **se congela al entrar en el plan**. Si después
//!   se procesa su minimapa y el coach la recalcula, el plan no cambia: si no,
//!   el antes y el después se medirían con reglas distintas a mitad de plan.
//!
//! # El veredicto
//!
//! Intervalo de la t de Student **con varianza conjunta** al [`NIVEL`] sobre la
//! diferencia entre el coste medio por partida del plan y lo esperado sin
//! cambiar nada (el antes menos la regresión a la media, abajo). Ni Welch ni
//! bootstrap, medido (`tests::sin_cambio_se_equivoca_lo_que_dice_el_nivel`):
//! el coste por partida es casi siempre cero y a veces una muerte cara, y en
//! diez partidas una media baja viene con una varianza baja. Welch, que estima
//! la varianza de cada lado por separado, se cree esa varianza y dice «mejoró»
//! sin cambio real un 8-10 % de las veces (nominal: 5 %); el bootstrap, un
//! 9-16 %. Con la varianza conjunta (que es lo que dice «no cambió nada»: las
//! dos muestras salen de la misma distribución) sale un 1-4 %, y «empeoró» un
//! 6 %. Errar hacia «no se sabe» cuando se trata de decirte que mejoraste es
//! lo que se quiere.
//!
//! - **Mejoró / empeoró:** el intervalo entero queda por debajo / por encima
//!   de cero.
//! - **Igual:** el intervalo cruza el cero y además cabe en ±[`CAMBIO_RELEVANTE`]
//!   de lo esperado: si hubo cambio, fue pequeño.
//! - **Muestra corta:** cruza el cero pero es más ancho que eso. No se sabe, y
//!   se dice así en vez de llamarlo «igual».
//!
//! Con el coste por partida que tiene el coach (muchas partidas a cero y
//! alguna muerte cara) lo normal tras diez partidas es «muestra corta» salvo
//! que el hábito desaparezca. Es lo honesto: iTero vuelve a dar nota cada diez
//! partidas sin medir si la diferencia es ruido.
//!
//! # Regresión a la media
//!
//! El foco se elige por ser lo que más pierdes, así que su antes viene
//! inflado por la suerte y el después baja solo. Medido con jugadores del
//! corpus que no hicieron ningún plan (`tests::placebo_en_el_corpus`, 290
//! planes simulados): con el foco del coach el coste bajó solo un 41 %, y el
//! veredicto decía «mejoró» al 10,7 % de ellos; con un foco al azar no baja
//! (después/antes 1,04). La caída crece cuando el antes es más ruidoso (0,44
//! con 10-14 partidas de antes, 0,61 con 20), así que se modela en errores
//! típicos: sin cambiar nada se espera el antes menos [`REGRESION`] errores
//! típicos de su media. El veredicto compara tus diez partidas con eso, no con
//! el antes. Con esto, a quien no hizo nada el coach le dice «mejoró» un 1,7 %
//! de las veces y «empeoró» otro 1,7 %, y lo esperado acierta en cada
//! categoría (después/esperado de 0,96 a 1,12) y con cualquier número de
//! partidas de antes (de 0,89 a 1,07).
//!
//! Sólo se descuenta si el foco se eligió por ser malo: si al empezar estaba
//! entre los candidatos del coach (`coach::candidatos`). Con un foco que no lo
//! estaba no hay nada que regrese: descontarlo a todos los focos al azar decía
//! «empeoró» a un 10,6 % de quienes no cambiaron; con esta regla, un 6,3 %
//! («mejoró», un 0,7 %). Cada plan guarda el descuento con el que empezó.
//!
//! # Guardado
//!
//! `%APPDATA%\LeagueRecorder\coach\sessions.json`, con versión de esquema
//! ([`ESQUEMA`]). Un fichero de una versión más nueva no se toca; uno ilegible
//! se aparta con otro nombre en vez de pisarlo.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::coach::{self, PartidaCoach};
use crate::storage::MatchMetadata;

/// Partidas que dura un plan.
pub const PARTIDAS_PLAN: usize = 10;

/// Partidas medidas que hacen falta para tener un antes. Las mismas que pide
/// el coach para elegir foco.
pub const ANTES_MIN: usize = coach::FOCO_MIN_PARTIDAS;

/// Partidas que se toman como antes, como mucho. Con más, el intervalo se
/// estrecha poco (con 10 después, de 10 a 20 antes lo estrecha un 13 %; de 20 a
/// infinitas, un 18 % más) y el antes deja de ser tu forma reciente.
pub const ANTES_MAX: usize = 20;

/// Confianza del intervalo: con el 90 %, cada veredicto en un sentido debería
/// equivocarse un 5 % de las veces cuando no cambió nada. Medido con costes
/// como los de verdad: «mejoró» un 1-4 % y «empeoró» un 6 %.
pub const NIVEL: f64 = 0.90;

/// El cambio más pequeño que importa, como fracción de lo esperado sin
/// cambiar nada. Menos de la mitad no se nota en tus partidas.
pub const CAMBIO_RELEVANTE: f64 = 0.5;

/// Errores típicos del antes que el coste del foco baja solo, por haberlo
/// elegido por ser lo peor (ver «Regresión a la media» arriba). Ajustado en
/// el corpus: 1,20 con todos los planes, 1,17 y 1,22 en dos mitades de los
/// jugadores.
pub const REGRESION: f64 = 1.2;

/// Versión del esquema de `sessions.json`.
pub const ESQUEMA: u32 = 1;

// Errores con clave estable: los traduce el frontend.
pub const ERR_ACTIVO: &str = "active_plan";
pub const ERR_SIN_PLAN: &str = "no_active_plan";
pub const ERR_POCAS: &str = "few_games";
pub const ERR_SIN_FOCO: &str = "no_focus";
pub const ERR_FOCO: &str = "bad_focus";
pub const ERR_ESQUEMA: &str = "newer_schema";

// ------------------------------------------------------------ datos

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EstadoPlan {
    Active,
    Closed,
    Abandoned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Veredicto {
    Improved,
    Same,
    Worse,
    ShortSample,
}

/// Una partida del plan, o del antes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PartidaPlan {
    pub match_id: String,
    /// Cuándo se jugó (`MatchMetadata::date`).
    pub date: String,
    #[serde(default)]
    pub champion: String,
    /// Lo que te costó el foco (0-1). `None` si en esta partida no se puede
    /// medir; esas no cuentan.
    pub cost: Option<f64>,
    /// Jugadas que cargaron en el foco.
    #[serde(default)]
    pub plays: usize,
    /// Su baremo en esta partida (el del corpus o tu media).
    #[serde(default)]
    pub base: Option<f64>,
}

/// Antes frente a después, al cerrar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cierre {
    /// Coste medio por partida (0-1).
    pub before: f64,
    pub after: f64,
    pub n_before: usize,
    pub n_after: usize,
    /// Después − antes, tal cual: negativo es que ahora te cuesta menos.
    pub diff: f64,
    /// Lo que se esperaba después sin cambiar nada: el antes menos lo que
    /// baja solo por la regresión a la media.
    pub expected: f64,
    /// Después − esperado: lo que se atribuye al plan.
    pub effect: f64,
    /// Intervalo de `effect`. `None` con menos de dos partidas en algún lado:
    /// no hay varianza que medir.
    pub low: Option<f64>,
    pub high: Option<f64>,
    pub level: f64,
    /// El cambio más pequeño que importa: «igual» exige que el intervalo quepa
    /// en ± esto.
    pub relevant: f64,
    pub verdict: Veredicto,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Plan {
    pub id: String,
    pub category: String,
    pub tramo: usize,
    pub status: EstadoPlan,
    /// Mismo formato que `MatchMetadata::date`, para compararlas como texto.
    pub started_at: String,
    /// La última partida antes de empezar: la marca «empezaste aquí».
    pub start_match: Option<String>,
    pub target: usize,
    /// Las de antes, de la más antigua a la más reciente.
    pub before: Vec<PartidaPlan>,
    pub before_cost: f64,
    /// Baremo medio de las de antes; `None` si alguna no lo tenía.
    pub before_base: Option<f64>,
    /// Errores típicos que se espera que baje solo: [`REGRESION`] si el foco
    /// era un candidato del coach al empezar, 0 si no.
    pub regression: f64,
    /// Lo que se espera que cueste por partida sin cambiar nada.
    pub expected_cost: f64,
    /// Las del plan, en el orden en que llegaron.
    pub games: Vec<PartidaPlan>,
    /// Coste medio de las que cuentan, mientras dura.
    pub after_cost: Option<f64>,
    pub ended_at: Option<String>,
    pub result: Option<Cierre>,
}

impl Plan {
    pub fn tiene(&self, match_id: &str) -> bool {
        self.games.iter().chain(self.before.iter()).any(|g| g.match_id == match_id)
    }

    /// Las que miden el foco: las que cuentan para las diez.
    pub fn contadas(&self) -> usize {
        self.games.iter().filter(|g| g.cost.is_some()).count()
    }

    fn costes(v: &[PartidaPlan]) -> Vec<f64> {
        v.iter().filter_map(|g| g.cost).collect()
    }

    fn cerrar(&mut self, ahora: &str) {
        self.status = EstadoPlan::Closed;
        self.ended_at = Some(ahora.to_string());
        self.result = Some(comparar_con(&Self::costes(&self.before), &Self::costes(&self.games), self.regression));
    }
}

/// Lo que hay en `sessions.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sesiones {
    pub version: u32,
    /// Todos los planes, del primero al último. Como mucho uno en curso.
    #[serde(default)]
    pub plans: Vec<Plan>,
}

impl Default for Sesiones {
    fn default() -> Self {
        Self { version: ESQUEMA, plans: Vec::new() }
    }
}

fn media(v: &[f64]) -> f64 {
    if v.is_empty() {
        0.0
    } else {
        v.iter().sum::<f64>() / v.len() as f64
    }
}

/// Lo que te costó el foco en una partida.
fn medir(p: &PartidaCoach, cat: &str, tramo: usize) -> PartidaPlan {
    let c = coach::coste(p, cat, tramo);
    PartidaPlan {
        match_id: p.match_id.clone(),
        date: p.date.clone(),
        champion: p.champion.clone(),
        cost: c.map(|c| c.0),
        plays: c.map_or(0, |c| c.2),
        base: c.and_then(|c| c.1),
    }
}

/// Las últimas [`ANTES_MAX`] partidas jugadas antes de `hasta` que miden el
/// foco, de la más antigua a la más reciente.
fn antes(partidas: &[PartidaCoach], cat: &str, tramo: usize, hasta: &str) -> Vec<PartidaPlan> {
    let mut previas: Vec<&PartidaCoach> = partidas.iter().filter(|p| p.date.as_str() < hasta).collect();
    previas.sort_by(|a, b| b.date.cmp(&a.date));
    let mut v: Vec<PartidaPlan> =
        previas.iter().map(|p| medir(p, cat, tramo)).filter(|g| g.cost.is_some()).take(ANTES_MAX).collect();
    v.reverse();
    v
}

impl Sesiones {
    pub fn activo(&self) -> Option<&Plan> {
        self.plans.iter().find(|p| p.status == EstadoPlan::Active)
    }

    fn activo_mut(&mut self) -> Option<&mut Plan> {
        self.plans.iter_mut().find(|p| p.status == EstadoPlan::Active)
    }

    /// El último plan acabado, cerrado o abandonado.
    pub fn ultimo_acabado(&self) -> Option<&Plan> {
        self.plans.iter().rev().find(|p| p.status != EstadoPlan::Active)
    }

    /// Empieza un plan con el foco `cat` × `tramo`. `partidas` son las tuyas
    /// ya sincronizadas; el antes sale de las jugadas antes de `ahora`.
    pub fn empezar(&mut self, cat: &str, tramo: usize, partidas: &[PartidaCoach], ahora: &str) -> Result<(), String> {
        if self.activo().is_some() {
            return Err(ERR_ACTIVO.into());
        }
        if !coach::CATEGORIAS.contains(&cat) || tramo >= coach::TRAMOS || !coach::existe(cat, tramo) {
            return Err(ERR_FOCO.into());
        }
        let before = antes(partidas, cat, tramo, ahora);
        if before.len() < ANTES_MIN {
            return Err(ERR_POCAS.into());
        }
        let previas: Vec<PartidaCoach> = partidas.iter().filter(|p| p.date.as_str() < ahora).cloned().collect();
        let start_match = previas.iter().max_by(|a, b| a.date.cmp(&b.date)).map(|p| p.match_id.clone());
        // ¿Se eligió por ser malo? Con lo que el coach sabía al empezar.
        let resumen = coach::resumen(&previas);
        let candidato = coach::candidatos(&resumen.rows).iter().any(|f| f.category == cat && f.tramo == Some(tramo));
        let regression = if candidato { REGRESION } else { 0.0 };
        let bases: Option<Vec<f64>> = before.iter().map(|g| g.base).collect();
        let costes = Plan::costes(&before);
        self.plans.push(Plan {
            id: format!("plan-{}", self.plans.len() + 1),
            category: cat.to_string(),
            tramo,
            status: EstadoPlan::Active,
            started_at: ahora.to_string(),
            start_match,
            target: PARTIDAS_PLAN,
            before_cost: media(&costes),
            before_base: bases.map(|b| media(&b)),
            regression,
            expected_cost: esperado(&costes, regression),
            before,
            games: Vec::new(),
            after_cost: None,
            ended_at: None,
            result: None,
        });
        Ok(())
    }

    pub fn abandonar(&mut self, ahora: &str) -> Result<(), String> {
        let plan = self.activo_mut().ok_or(ERR_SIN_PLAN)?;
        plan.status = EstadoPlan::Abandoned;
        plan.ended_at = Some(ahora.to_string());
        Ok(())
    }

    /// Añade una partida al plan en curso, si se jugó después de empezarlo y
    /// no estaba ya. Al llegar a las diez que cuentan, lo cierra. Devuelve si
    /// cambió algo.
    pub fn anadir(&mut self, p: &PartidaCoach, ahora: &str) -> bool {
        let Some(plan) = self.activo_mut() else { return false };
        if p.date.as_str() < plan.started_at.as_str() || plan.tiene(&p.match_id) {
            return false;
        }
        plan.games.push(medir(p, &plan.category, plan.tramo));
        let costes = Plan::costes(&plan.games);
        plan.after_cost = (!costes.is_empty()).then(|| media(&costes));
        if plan.contadas() >= plan.target {
            plan.cerrar(ahora);
        }
        true
    }
}

// ------------------------------------------------------------ estadística

/// Media y varianza muestral (n − 1).
fn media_var(v: &[f64]) -> (f64, f64) {
    let m = media(v);
    let var = if v.len() < 2 { 0.0 } else { v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / (v.len() - 1) as f64 };
    (m, var)
}

/// Lanczos (g = 7, n = 9).
fn ln_gamma(x: f64) -> f64 {
    const G: [f64; 9] = [
        0.999_999_999_999_809_9,
        676.520_368_121_885_1,
        -1_259.139_216_722_402_8,
        771.323_428_777_653_1,
        -176.615_029_162_140_6,
        12.507_343_278_686_905,
        -0.138_571_095_265_720_12,
        9.984_369_578_019_572e-6,
        1.505_632_735_149_311_6e-7,
    ];
    use std::f64::consts::PI;
    if x < 0.5 {
        return PI.ln() - (PI * x).sin().ln() - ln_gamma(1.0 - x);
    }
    let x = x - 1.0;
    let t = x + 7.5;
    let a = G[0] + (1..9).map(|i| G[i] / (x + i as f64)).sum::<f64>();
    0.5 * (2.0 * PI).ln() + (x + 0.5) * t.ln() - t + a.ln()
}

/// Fracción continua de la beta incompleta (Lentz).
fn beta_cf(a: f64, b: f64, x: f64) -> f64 {
    const TINY: f64 = 1e-300;
    let fix = |v: f64| if v.abs() < TINY { TINY } else { v };
    let (qab, qap, qam) = (a + b, a + 1.0, a - 1.0);
    let mut c = 1.0;
    let mut d = 1.0 / fix(1.0 - qab * x / qap);
    let mut h = d;
    for m in 1..300 {
        let m = m as f64;
        let m2 = 2.0 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1.0 / fix(1.0 + aa * d);
        c = fix(1.0 + aa / c);
        h *= d * c;
        let aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1.0 / fix(1.0 + aa * d);
        c = fix(1.0 + aa / c);
        let del = d * c;
        h *= del;
        if (del - 1.0).abs() < 1e-14 {
            break;
        }
    }
    h
}

/// Beta incompleta regularizada I_x(a, b).
fn beta_inc(a: f64, b: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    let ln_bt = ln_gamma(a + b) - ln_gamma(a) - ln_gamma(b) + a * x.ln() + b * (1.0 - x).ln();
    if x < (a + 1.0) / (a + b + 2.0) {
        ln_bt.exp() * beta_cf(a, b, x) / a
    } else {
        1.0 - ln_bt.exp() * beta_cf(b, a, 1.0 - x) / b
    }
}

/// P(T ≤ t) con T una t de Student de `df` grados.
fn t_cdf(t: f64, df: f64) -> f64 {
    let cola = 0.5 * beta_inc(df / 2.0, 0.5, df / (df + t * t));
    if t >= 0.0 {
        1.0 - cola
    } else {
        cola
    }
}

/// El t tal que P(T ≤ t) = p, para p ≥ 0,5.
fn t_cuantil(p: f64, df: f64) -> f64 {
    let (mut lo, mut hi) = (0.0, 1e4);
    for _ in 0..200 {
        let mid = 0.5 * (lo + hi);
        if t_cdf(mid, df) < p {
            lo = mid
        } else {
            hi = mid
        }
    }
    0.5 * (lo + hi)
}

/// Antes frente a después con un foco elegido por el coach: con el descuento
/// de la regresión a la media.
#[cfg(test)]
fn comparar(antes: &[f64], despues: &[f64]) -> Cierre {
    comparar_con(antes, despues, REGRESION)
}

/// Lo que se espera que cueste por partida sin cambiar nada: el antes menos
/// `regresion` errores típicos de su media. Nunca menos de cero.
fn esperado(antes: &[f64], regresion: f64) -> f64 {
    let (m, v) = media_var(antes);
    if antes.len() < 2 {
        return m;
    }
    (m - regresion * (v / antes.len() as f64).sqrt()).max(0.0)
}

/// [`comparar`] con `regresion` errores típicos de caída esperada.
fn comparar_con(antes: &[f64], despues: &[f64], regresion: f64) -> Cierre {
    let (ma, va) = media_var(antes);
    let (md, vd) = media_var(despues);
    let (na, nd) = (antes.len(), despues.len());
    let expected = esperado(antes, regresion);
    let effect = md - expected;
    let relevant = CAMBIO_RELEVANTE * expected;
    let intervalo = (na >= 2 && nd >= 2).then(|| {
        let df = (na + nd - 2) as f64;
        let conjunta = ((na - 1) as f64 * va + (nd - 1) as f64 * vd) / df;
        let se = (conjunta * (1.0 / na as f64 + 1.0 / nd as f64)).sqrt();
        let half = t_cuantil(1.0 - (1.0 - NIVEL) / 2.0, df) * se;
        (effect - half, effect + half)
    });
    let verdict = match intervalo {
        None => Veredicto::ShortSample,
        Some((_, hi)) if hi < 0.0 => Veredicto::Improved,
        Some((lo, _)) if lo > 0.0 => Veredicto::Worse,
        Some((lo, hi)) if lo >= -relevant && hi <= relevant => Veredicto::Same,
        Some(_) => Veredicto::ShortSample,
    };
    Cierre {
        before: ma,
        after: md,
        n_before: na,
        n_after: nd,
        diff: md - ma,
        expected,
        effect,
        low: intervalo.map(|i| i.0),
        high: intervalo.map(|i| i.1),
        level: NIVEL,
        relevant,
        verdict,
    }
}

// ------------------------------------------------------------ lo que ve la UI

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Situacion {
    /// Hay un plan en curso.
    Active,
    /// El último plan se cerró: toca enseñar el cierre y proponer el siguiente.
    Closed,
    Abandoned,
    /// Nunca hubo plan y no hay [`ANTES_MIN`] partidas para empezar uno.
    FewGames,
    /// Nunca hubo plan.
    NoPlan,
}

/// El foco que se propone empezar ahora.
#[derive(Debug, Clone, Serialize)]
pub struct Propuesta {
    /// La fila del coach, con sus peores jugadas para la lista de reproducción.
    pub row: coach::Fila,
    /// Partidas que serían el antes, y su coste medio.
    pub before_games: usize,
    pub before_cost: f64,
    /// Es el foco del último plan.
    pub repeat: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Panorama {
    pub state: Situacion,
    pub active: Option<Plan>,
    /// Los acabados (cerrados o abandonados), el último primero.
    pub history: Vec<Plan>,
    pub target: usize,
    pub min_before: usize,
    /// Tus partidas que cuentan para el coach.
    pub games: usize,
    /// Sólo sin plan en curso.
    pub proposal: Option<Propuesta>,
}

/// El siguiente foco. El de ahora, salvo que el último plan ya lo mejorara:
/// entonces el siguiente que más te cuesta, si lo hay.
pub fn propuesta(partidas: &[PartidaCoach], ultimo: Option<&Plan>, ahora: &str) -> Option<Propuesta> {
    let r = coach::resumen(partidas);
    let cands = coach::candidatos(&r.rows);
    let mismo = |f: &coach::Fila| ultimo.is_some_and(|p| p.category == f.category && Some(p.tramo) == f.tramo);
    let mejoro = ultimo.and_then(|p| p.result.as_ref()).is_some_and(|c| c.verdict == Veredicto::Improved);
    let f = if mejoro { cands.iter().find(|f| !mismo(f)).or(cands.first()) } else { cands.first() }?;
    let before = antes(partidas, &f.category, f.tramo?, ahora);
    Some(Propuesta {
        before_games: before.len(),
        before_cost: media(&Plan::costes(&before)),
        repeat: mismo(f),
        row: (**f).clone(),
    })
}

pub fn panorama(s: &Sesiones, games: usize, proposal: Option<Propuesta>) -> Panorama {
    let active = s.activo().cloned();
    let history: Vec<Plan> = s.plans.iter().rev().filter(|p| p.status != EstadoPlan::Active).cloned().collect();
    let state = match (&active, history.first().map(|p| p.status)) {
        (Some(_), _) => Situacion::Active,
        (None, Some(EstadoPlan::Closed)) => Situacion::Closed,
        (None, Some(_)) => Situacion::Abandoned,
        (None, None) if games < ANTES_MIN => Situacion::FewGames,
        (None, None) => Situacion::NoPlan,
    };
    Panorama {
        state,
        proposal: if active.is_none() { proposal } else { None },
        active,
        history,
        target: PARTIDAS_PLAN,
        min_before: ANTES_MIN,
        games,
    }
}

// ------------------------------------------------------------ fichero

pub fn ruta() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| "C:".to_string());
    Path::new(&appdata).join("LeagueRecorder").join("coach").join("sessions.json")
}

pub fn cargar(ruta: &Path) -> Result<Sesiones, String> {
    let texto = match std::fs::read_to_string(ruta) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Sesiones::default()),
        Err(e) => return Err(e.to_string()),
    };
    #[derive(Deserialize)]
    struct Cabecera {
        version: u32,
    }
    // Uno de una versión más nueva de la app no se entiende ni se pisa.
    if serde_json::from_str::<Cabecera>(&texto).is_ok_and(|c| c.version > ESQUEMA) {
        return Err(ERR_ESQUEMA.into());
    }
    match serde_json::from_str::<Sesiones>(&texto) {
        Ok(s) => Ok(s),
        Err(e) => {
            // Ilegible: se aparta con otro nombre, para no perder el historial
            // por pisarlo con uno vacío.
            let aparte = ruta.with_extension(format!("{}.bad.json", chrono::Local::now().format("%Y%m%d-%H%M%S")));
            eprintln!("coach: {} no se puede leer ({e}); se aparta como {}", ruta.display(), aparte.display());
            std::fs::rename(ruta, &aparte).map_err(|e| e.to_string())?;
            Ok(Sesiones::default())
        }
    }
}

/// Escribe en un temporal y lo pone en su sitio: un corte a mitad no deja el
/// fichero a medias.
pub fn guardar(ruta: &Path, s: &Sesiones) -> Result<(), String> {
    if let Some(dir) = ruta.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = ruta.with_extension("json.tmp");
    let texto = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, texto).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, ruta).map_err(|e| e.to_string())
}

/// El fichero se lee y se escribe desde la sincronización (en segundo plano) y
/// desde los comandos: sin candado, uno pisaría lo del otro.
static CANDADO: Mutex<()> = Mutex::new(());

/// Carga, aplica `f` y guarda si dijo que cambió.
fn con_sesiones<T>(f: impl FnOnce(&mut Sesiones) -> Result<(T, bool), String>) -> Result<T, String> {
    let _g = CANDADO.lock().unwrap_or_else(|e| e.into_inner());
    let ruta = ruta();
    let mut s = cargar(&ruta)?;
    let (v, cambio) = f(&mut s)?;
    if cambio {
        guardar(&ruta, &s)?;
    }
    Ok(v)
}

fn ahora() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Mete en el plan en curso las partidas jugadas desde que empezó que aún no
/// estén. Sólo analiza esas: las viejas ni se miran.
fn ponerse_al_dia(s: &mut Sesiones, metas: &[MatchMetadata], ahora: &str) -> bool {
    let Some(plan) = s.activo() else { return false };
    let mut nuevas: Vec<&MatchMetadata> =
        metas.iter().filter(|m| m.date.as_str() >= plan.started_at.as_str() && !plan.tiene(&m.id)).collect();
    nuevas.sort_by(|a, b| a.date.cmp(&b.date));
    let mut cambio = false;
    for m in nuevas {
        if let Some(p) = coach::cacheada(m) {
            cambio |= s.anadir(&p, ahora);
        }
    }
    cambio
}

/// Una partida recién sincronizada: si hay un plan en curso, entra en él. Lo
/// llama la sincronización de después de la partida, antes de avisar de que
/// está lista, para que quien la abra vea el plan al día.
pub fn al_sincronizar(meta: &MatchMetadata) {
    if !coach::cuenta(meta) {
        return;
    }
    let ahora = ahora();
    let r = con_sesiones(|s| {
        let fuera = s.activo().is_none_or(|p| meta.date.as_str() < p.started_at.as_str() || p.tiene(&meta.id));
        if fuera {
            return Ok(((), false));
        }
        let Some(p) = coach::cacheada(meta) else { return Ok(((), false)) };
        Ok(((), s.anadir(&p, &ahora)))
    });
    if let Err(e) = r {
        eprintln!("coach: no se pudo añadir {} al plan: {e}", meta.id);
    }
}

fn tus_metas() -> Vec<MatchMetadata> {
    crate::storage::load_all_matches().into_iter().filter(coach::cuenta).collect()
}

/// El panorama, con la propuesta sólo si no hay plan en curso (es lo único que
/// necesita analizar todas las partidas).
fn armar(s: &Sesiones, metas: &[MatchMetadata], ahora: &str) -> Panorama {
    let proposal = if s.activo().is_none() {
        let partidas: Vec<PartidaCoach> = metas.iter().filter_map(coach::cacheada).collect();
        propuesta(&partidas, s.ultimo_acabado(), ahora)
    } else {
        None
    };
    panorama(s, metas.len(), proposal)
}

fn ver() -> Result<Panorama, String> {
    let metas = tus_metas();
    let ahora = ahora();
    let s = con_sesiones(|s| {
        let cambio = ponerse_al_dia(s, &metas, &ahora);
        Ok((s.clone(), cambio))
    })?;
    Ok(armar(&s, &metas, &ahora))
}

fn empezar_ahora(category: Option<String>, tramo: Option<usize>) -> Result<Panorama, String> {
    let metas = tus_metas();
    let partidas: Vec<PartidaCoach> = metas.iter().filter_map(coach::cacheada).collect();
    let ahora = ahora();
    let (cat, tramo) = match (category, tramo) {
        (Some(c), Some(t)) => (c, t),
        (None, None) => {
            let f = coach::resumen(&partidas).focus.ok_or(ERR_SIN_FOCO)?;
            let t = f.tramo.ok_or(ERR_SIN_FOCO)?;
            (f.category, t)
        }
        _ => return Err(ERR_FOCO.into()),
    };
    let s = con_sesiones(|s| {
        s.empezar(&cat, tramo, &partidas, &ahora)?;
        Ok((s.clone(), true))
    })?;
    Ok(armar(&s, &metas, &ahora))
}

fn abandonar_ahora() -> Result<Panorama, String> {
    let metas = tus_metas();
    let ahora = ahora();
    let s = con_sesiones(|s| {
        s.abandonar(&ahora)?;
        Ok((s.clone(), true))
    })?;
    Ok(armar(&s, &metas, &ahora))
}

/// El plan en curso, los acabados y, sin plan, el foco que se propone.
#[tauri::command]
pub async fn get_coach_plan() -> Result<Panorama, String> {
    tokio::task::spawn_blocking(ver).await.map_err(|e| e.to_string())?
}

/// Empieza un plan de diez partidas. Sin foco explícito, el foco actual del
/// coach (el de Hoy).
#[tauri::command]
pub async fn start_coach_plan(category: Option<String>, tramo: Option<usize>) -> Result<Panorama, String> {
    tokio::task::spawn_blocking(move || empezar_ahora(category, tramo)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn abandon_coach_plan() -> Result<Panorama, String> {
    tokio::task::spawn_blocking(abandonar_ahora).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coach::Jugada;
    use crate::muertes;
    use rand::rngs::StdRng;
    use rand::{Rng, SeedableRng};
    use serde_json::Value;
    use std::collections::HashMap;

    const CAT: &str = muertes::JUNGLA;
    /// 7-14.
    const TRAMO: usize = 1;

    fn fecha(i: usize) -> String {
        format!("2026-09-{:02} {:02}:00:00", 1 + i / 24, i % 24)
    }

    /// Una partida de jungla en la que el jungla rival te costó `coste` entre
    /// el 7 y el 14.
    fn partida(i: usize, coste: f64) -> PartidaCoach {
        con_cargo(i, CAT, 600.0, coste)
    }

    fn con_cargo(i: usize, cat: &str, sec: f64, coste: f64) -> PartidaCoach {
        let plays = if coste > 0.0 {
            vec![Jugada {
                time: sec,
                kind: "death".into(),
                lost: coste,
                charges: vec![(cat.into(), coste)],
                ..Default::default()
            }]
        } else {
            Vec::new()
        };
        PartidaCoach {
            match_id: format!("m{i}"),
            date: fecha(i),
            champion: "Gwen".into(),
            role: "JUNGLE".into(),
            band: Some("alto".into()),
            duration: 1800.0,
            plays,
            ..Default::default()
        }
    }

    /// Una que acaba en el minuto 6: no llega al 7-14.
    fn corta(i: usize) -> PartidaCoach {
        PartidaCoach { duration: 360.0, ..partida(i, 0.0) }
    }

    fn historial(n: usize) -> Vec<PartidaCoach> {
        (0..n).map(|i| partida(i, if i % 2 == 0 { 0.06 } else { 0.0 })).collect()
    }

    fn dir_de_prueba(nombre: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("leaguerec-coachplan-{}-{nombre}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    /// Igual salvo el último bit de los f64, que `serde_json` no garantiza
    /// releer.
    fn cerca(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => (x.as_f64().unwrap() - y.as_f64().unwrap()).abs() < 1e-12,
            (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| cerca(a, b)),
            (Value::Object(x), Value::Object(y)) => {
                x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| cerca(v, w)))
            }
            _ => a == b,
        }
    }

    // -------------------------------------------------------------- guardado

    #[test]
    fn el_guardado_vuelve_igual_y_con_su_version() {
        let dir = dir_de_prueba("guardado");
        let ruta = dir.join("coach").join("sessions.json");
        assert_eq!(cargar(&ruta).unwrap(), Sesiones::default(), "sin fichero, vacío");

        let mut s = Sesiones::default();
        s.empezar(CAT, TRAMO, &historial(12), &fecha(12)).unwrap();
        s.anadir(&partida(13, 0.01), &fecha(14));
        s.anadir(&corta(15), &fecha(16));
        guardar(&ruta, &s).unwrap();

        let texto = std::fs::read_to_string(&ruta).unwrap();
        assert!(texto.contains(&format!("\"version\": {ESQUEMA}")), "{texto}");
        assert!(!ruta.with_extension("json.tmp").exists(), "no queda el temporal");
        let leido = cargar(&ruta).unwrap();
        assert!(cerca(&serde_json::to_value(&s).unwrap(), &serde_json::to_value(&leido).unwrap()));
        let plan = leido.activo().unwrap();
        assert_eq!((plan.games.len(), plan.contadas(), plan.games[1].cost), (2, 1, None));

        // Guardar otra vez sobre el que ya existe.
        s.anadir(&partida(17, 0.02), &fecha(18));
        guardar(&ruta, &s).unwrap();
        assert_eq!(cargar(&ruta).unwrap().activo().unwrap().games.len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn un_fichero_de_una_version_nueva_no_se_toca() {
        let dir = dir_de_prueba("version");
        let ruta = dir.join("sessions.json");
        std::fs::create_dir_all(&dir).unwrap();
        let nuevo = format!("{{\"version\": {}, \"plans\": [], \"algo\": 1}}", ESQUEMA + 1);
        std::fs::write(&ruta, &nuevo).unwrap();
        assert_eq!(cargar(&ruta), Err(ERR_ESQUEMA.to_string()));
        assert_eq!(std::fs::read_to_string(&ruta).unwrap(), nuevo);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn un_fichero_ilegible_se_aparta_sin_perderlo() {
        let dir = dir_de_prueba("roto");
        let ruta = dir.join("sessions.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&ruta, "{ esto no es json").unwrap();
        assert_eq!(cargar(&ruta).unwrap(), Sesiones::default());
        assert!(!ruta.exists());
        let apartados: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".bad.json"))
            .collect();
        assert_eq!(apartados.len(), 1, "{apartados:?}");
        assert_eq!(std::fs::read_to_string(dir.join(&apartados[0])).unwrap(), "{ esto no es json");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // -------------------------------------------------------------- empezar

    #[test]
    fn el_antes_son_las_ultimas_que_miden_el_foco() {
        // 30 partidas; las múltiplos de 3 acaban en el minuto 6.
        let partidas: Vec<PartidaCoach> =
            (0..30).map(|i| if i % 3 == 0 { corta(i) } else { partida(i, 0.01 * (i % 5) as f64) }).collect();
        let mut s = Sesiones::default();
        s.empezar(CAT, TRAMO, &partidas, &fecha(30)).unwrap();
        let plan = s.activo().unwrap();
        assert_eq!(plan.before.len(), ANTES_MAX);
        assert!(plan.before.iter().all(|g| g.cost.is_some()));
        assert!(plan.before.windows(2).all(|w| w[0].date < w[1].date), "de la más antigua a la más reciente");
        // Las 20 medibles de las 30 son justo todas: de la m1 a la m29 sin las cortas.
        assert_eq!((plan.before[0].match_id.as_str(), plan.before[19].match_id.as_str()), ("m1", "m29"));
        assert_eq!(plan.start_match.as_deref(), Some("m29"));
        let esperado = plan.before.iter().map(|g| g.cost.unwrap()).sum::<f64>() / ANTES_MAX as f64;
        assert!((plan.before_cost - esperado).abs() < 1e-12);
        assert!(plan.before_base.is_some_and(|b| b > 0.0), "jungla × alto × 7-14 tiene baremo");
        assert_eq!((plan.status, plan.target, plan.games.len()), (EstadoPlan::Active, PARTIDAS_PLAN, 0));

        // Con más de 20 medibles, sólo las 20 últimas.
        let mut s = Sesiones::default();
        s.empezar(CAT, TRAMO, &historial(35), &fecha(35)).unwrap();
        let plan = s.activo().unwrap();
        assert_eq!((plan.before.len(), plan.before[0].match_id.as_str()), (ANTES_MAX, "m15"));
    }

    #[test]
    fn sin_diez_partidas_antes_no_se_empieza() {
        let mut s = Sesiones::default();
        // Diez partidas, pero una no llega al tramo: nueve que miden el foco.
        let mut partidas = historial(ANTES_MIN - 1);
        partidas.push(corta(50));
        assert_eq!(s.empezar(CAT, TRAMO, &partidas, &fecha(60)), Err(ERR_POCAS.to_string()));
        assert!(s.plans.is_empty());
        // Las de después de «ahora» no son antes.
        assert_eq!(s.empezar(CAT, TRAMO, &historial(30), &fecha(5)), Err(ERR_POCAS.to_string()));
        assert_eq!(panorama(&s, ANTES_MIN - 1, None).state, Situacion::FewGames);
        assert_eq!(panorama(&s, ANTES_MIN, None).state, Situacion::NoPlan);
    }

    #[test]
    fn un_plan_a_la_vez_y_un_foco_que_exista() {
        let mut s = Sesiones::default();
        let partidas = historial(12);
        assert_eq!(s.empezar("inventada", 1, &partidas, &fecha(12)), Err(ERR_FOCO.to_string()));
        assert_eq!(s.empezar(muertes::FUERA_DE_ZONA, 2, &partidas, &fecha(12)), Err(ERR_FOCO.to_string()), "acaba en el 14");
        assert_eq!(s.empezar(CAT, coach::TRAMOS, &partidas, &fecha(12)), Err(ERR_FOCO.to_string()));
        assert_eq!(s.abandonar(&fecha(12)), Err(ERR_SIN_PLAN.to_string()));
        s.empezar(CAT, TRAMO, &partidas, &fecha(12)).unwrap();
        assert_eq!(s.empezar(CAT, TRAMO, &partidas, &fecha(12)), Err(ERR_ACTIVO.to_string()));

        s.anadir(&partida(13, 0.0), &fecha(13));
        s.abandonar(&fecha(14)).unwrap();
        let p = &s.plans[0];
        assert_eq!((p.status, p.ended_at.as_deref(), p.games.len()), (EstadoPlan::Abandoned, Some(fecha(14).as_str()), 1));
        assert!(p.result.is_none(), "abandonado no tiene veredicto");
        assert!(!s.anadir(&partida(15, 0.0), &fecha(15)), "sin plan en curso no entra nada");
        assert_eq!(panorama(&s, 14, None).state, Situacion::Abandoned);

        s.empezar(CAT, TRAMO, &partidas, &fecha(16)).unwrap();
        assert_eq!(s.plans.len(), 2);
        assert_ne!(s.plans[0].id, s.plans[1].id);
        let v = panorama(&s, 16, None);
        assert_eq!((v.state, v.history.len()), (Situacion::Active, 1));
        assert_eq!(v.active.unwrap().id, s.plans[1].id);
    }

    // -------------------------------------------------------------- añadir

    #[test]
    fn la_misma_partida_dos_veces_cuenta_una() {
        let mut s = Sesiones::default();
        s.empezar(CAT, TRAMO, &historial(15), &fecha(15)).unwrap();
        let nueva = partida(16, 0.01);
        assert!(s.anadir(&nueva, &fecha(17)));
        assert!(!s.anadir(&nueva, &fecha(18)), "la segunda vez no cambia nada");
        // Con otro coste (la caché rehecha), tampoco: el coste se congela.
        assert!(!s.anadir(&partida(16, 0.5), &fecha(18)));
        let plan = s.activo().unwrap();
        assert_eq!((plan.games.len(), plan.contadas(), plan.games[0].cost), (1, 1, Some(0.01)));
        assert_eq!(plan.after_cost, Some(0.01));

        // Ni una jugada antes de empezar…
        assert!(!s.anadir(&partida(14, 0.5), &fecha(18)));
        // …ni una que ya es del antes, aunque la fecha diga otra cosa.
        let mut del_antes = partida(3, 0.5);
        del_antes.date = fecha(19);
        assert!(!s.anadir(&del_antes, &fecha(19)));
        assert_eq!(s.activo().unwrap().games.len(), 1);
    }

    #[test]
    fn a_las_diez_que_cuentan_se_cierra() {
        let mut s = Sesiones::default();
        s.empezar(CAT, TRAMO, &historial(20), &fecha(20)).unwrap();
        // No llega al tramo: se guarda y no cuenta.
        assert!(s.anadir(&corta(21), &fecha(21)));
        assert_eq!(s.activo().map(|p| (p.games.len(), p.contadas(), p.after_cost)), Some((1, 0, None)));
        for i in 22..31 {
            s.anadir(&partida(i, 0.0), &fecha(i));
        }
        let plan = s.activo().expect("con nueve sigue en curso");
        assert_eq!((plan.contadas(), plan.after_cost), (9, Some(0.0)));

        assert!(s.anadir(&partida(31, 0.0), "fin"));
        assert!(s.activo().is_none());
        let p = &s.plans[0];
        assert_eq!((p.status, p.ended_at.as_deref()), (EstadoPlan::Closed, Some("fin")));
        let r = p.result.as_ref().unwrap();
        assert_eq!((r.n_before, r.n_after), (20, 10));
        assert!((r.before - 0.03).abs() < 1e-12 && r.after == 0.0 && (r.diff + 0.03).abs() < 1e-12);
        assert_eq!(r.verdict, Veredicto::Improved, "{r:?}");
        assert!(!s.anadir(&partida(40, 0.1), &fecha(40)), "cerrado, ya no entra nada");
        assert_eq!(panorama(&s, 31, None).state, Situacion::Closed);
    }

    // -------------------------------------------------------------- propuesta

    /// El jungla te cuesta mucho en el 7-14 y las tiradas algo en el 14-21:
    /// dos candidatos, el jungla primero.
    fn dos_focos(n: usize) -> Vec<PartidaCoach> {
        (0..n)
            .map(|i| {
                let mut p = partida(i, 0.2);
                p.plays.push(con_cargo(i, coach::TIRADA, 1000.0, 0.1).plays.remove(0));
                p
            })
            .collect()
    }

    #[test]
    fn tras_mejorar_se_propone_el_siguiente_foco() {
        let partidas = dos_focos(12);
        let r = coach::resumen(&partidas);
        let c: Vec<(&str, Option<usize>)> = coach::candidatos(&r.rows).iter().map(|f| (f.category.as_str(), f.tramo)).collect();
        assert_eq!(c, vec![(CAT, Some(TRAMO)), (coach::TIRADA, Some(2))]);

        let sin_plan = propuesta(&partidas, None, &fecha(12)).unwrap();
        assert_eq!((sin_plan.row.category.as_str(), sin_plan.row.tramo, sin_plan.repeat), (CAT, Some(TRAMO), false));
        assert_eq!(sin_plan.before_games, 12);
        assert!((sin_plan.before_cost - 0.2).abs() < 1e-12);

        let mut s = Sesiones::default();
        s.empezar(CAT, TRAMO, &partidas, &fecha(12)).unwrap();
        for i in 12..22 {
            s.anadir(&partida(i, 0.0), &fecha(i));
        }
        assert_eq!(s.ultimo_acabado().unwrap().result.as_ref().unwrap().verdict, Veredicto::Improved);
        let siguiente = propuesta(&partidas, s.ultimo_acabado(), &fecha(22)).unwrap();
        assert_eq!((siguiente.row.category.as_str(), siguiente.row.tramo, siguiente.repeat), (coach::TIRADA, Some(2), false));

        // Abandonado, se vuelve a proponer el mismo.
        let mut s = Sesiones::default();
        s.empezar(CAT, TRAMO, &partidas, &fecha(12)).unwrap();
        s.abandonar(&fecha(13)).unwrap();
        let otra_vez = propuesta(&partidas, s.ultimo_acabado(), &fecha(13)).unwrap();
        assert_eq!((otra_vez.row.category.as_str(), otra_vez.repeat), (CAT, true));

        // Con plan en curso, el panorama no propone nada.
        s.empezar(CAT, TRAMO, &partidas, &fecha(14)).unwrap();
        assert!(panorama(&s, 12, Some(otra_vez)).proposal.is_none());
    }

    /// La regresión a la media sólo se descuenta si el foco se eligió por
    /// ser malo.
    #[test]
    fn el_descuento_solo_si_el_foco_se_eligio_por_malo() {
        let mut partidas = dos_focos(12);
        for (i, p) in partidas.iter_mut().enumerate() {
            p.plays[0].lost = if i % 2 == 0 { 0.3 } else { 0.1 };
            p.plays[0].charges[0].1 = p.plays[0].lost;
        }
        let mut s = Sesiones::default();
        s.empezar(CAT, TRAMO, &partidas, &fecha(12)).unwrap();
        let p = s.activo().unwrap();
        let costes = Plan::costes(&p.before);
        let (m, v) = media_var(&costes);
        assert_eq!(p.regression, REGRESION);
        assert!((p.expected_cost - (m - REGRESION * (v / 12.0).sqrt())).abs() < 1e-12 && p.expected_cost < p.before_cost);
        for i in 12..22 {
            s.anadir(&partida(i, 0.2), &fecha(i));
        }
        let r = s.plans[0].result.as_ref().unwrap();
        assert!((r.expected - s.plans[0].expected_cost).abs() < 1e-12, "el cierre usa el descuento con que empezó");

        // Las tiradas del 0-7 no existen en estas partidas: no es un foco
        // que el coach eligiera, y no hay nada que regrese.
        let mut s = Sesiones::default();
        s.empezar(coach::TIRADA, 0, &partidas, &fecha(12)).unwrap();
        let p = s.activo().unwrap();
        assert_eq!((p.regression, p.expected_cost, p.before_cost), (0.0, 0.0, 0.0));
    }

    // -------------------------------------------------------------- veredicto

    /// Tabla de la t de Student.
    #[test]
    fn los_cuantiles_de_la_t() {
        for (p, df, t) in [
            (0.95, 1.0, 6.313_752),
            (0.95, 9.0, 1.833_113),
            (0.95, 19.0, 1.729_133),
            (0.975, 10.0, 2.228_139),
            (0.95, 30.0, 1.697_261),
            (0.95, 1e7, 1.644_854),
        ] {
            let q = t_cuantil(p, df);
            assert!((q - t).abs() < 1e-5, "t({p}, {df}) = {q}, tabla {t}");
            assert!((t_cdf(q, df) - p).abs() < 1e-9);
        }
        // Con grados no enteros, entre sus vecinos.
        let q = t_cuantil(0.95, 9.5);
        assert!(q < t_cuantil(0.95, 9.0) && q > t_cuantil(0.95, 10.0));
    }

    /// Cerca de 0,03 por partida, con muchas a cero: como el coste de verdad.
    const ANTES: [f64; 20] = [
        0.05, 0.0, 0.08, 0.02, 0.0, 0.06, 0.03, 0.0, 0.07, 0.04, 0.05, 0.0, 0.03, 0.06, 0.02, 0.0, 0.04, 0.05, 0.01, 0.04,
    ];

    #[test]
    fn los_cuatro_veredictos() {
        let r = comparar(&ANTES, &[0.0; 10]);
        assert_eq!(r.verdict, Veredicto::Improved, "el hábito desaparece: {r:?}");
        assert!(r.high.unwrap() < 0.0 && r.diff < 0.0);

        let peor = [0.12, 0.1, 0.15, 0.09, 0.11, 0.13, 0.1, 0.14, 0.12, 0.1];
        let r = comparar(&ANTES, &peor);
        assert_eq!(r.verdict, Veredicto::Worse, "{r:?}");
        assert!(r.low.unwrap() > 0.0);

        // Lo mismo y con poco ruido: el intervalo cabe en ± la mitad del antes.
        let estable: Vec<f64> = (0..20).map(|i| 0.04 + 0.002 * (i % 5) as f64).collect();
        let r = comparar(&estable, &estable[..10]);
        assert_eq!(r.verdict, Veredicto::Same, "{r:?}");
        assert!(r.low.unwrap() >= -r.relevant && r.high.unwrap() <= r.relevant);

        // La misma media, pero diez partidas con dos muertes caras: no se sabe.
        let ruido = [0.0, 0.0, 0.15, 0.0, 0.0, 0.0, 0.18, 0.0, 0.0, 0.0];
        let r = comparar(&ANTES, &ruido);
        assert_eq!(r.verdict, Veredicto::ShortSample, "{r:?}");
        assert!(r.low.unwrap() < -r.relevant || r.high.unwrap() > r.relevant);

        // Con una sola partida no hay varianza: ni intervalo.
        let r = comparar(&ANTES, &[0.01]);
        assert_eq!((r.verdict, r.low, r.high), (Veredicto::ShortSample, None, None));
    }

    #[test]
    fn el_intervalo_a_mano() {
        // antes: media 2,5 y varianza 5/3; después: media 5 y varianza 20/3.
        // Conjunta: (3·5/3 + 3·20/3) / 6 = 25/6, con 6 grados.
        let r = comparar_con(&[1.0, 2.0, 3.0, 4.0], &[2.0, 4.0, 6.0, 8.0], 0.0);
        let half = 1.943_180 * (25.0_f64 / 6.0 * 0.5).sqrt();
        assert!((r.diff - 2.5).abs() < 1e-12 && r.effect == r.diff && r.expected == 2.5);
        assert!((r.low.unwrap() - (2.5 - half)).abs() < 1e-5 && (r.high.unwrap() - (2.5 + half)).abs() < 1e-5, "{r:?}");
        assert_eq!(r.verdict, Veredicto::ShortSample);

        // Con la regresión, lo esperado es el antes menos 1,2 errores típicos
        // (√(5/3)/2), y el intervalo se mueve con él.
        let r = comparar(&[1.0, 2.0, 3.0, 4.0], &[2.0, 4.0, 6.0, 8.0]);
        let esperado = 2.5 - REGRESION * (5.0_f64 / 3.0).sqrt() / 2.0;
        assert!((r.expected - esperado).abs() < 1e-12 && (r.effect - (5.0 - esperado)).abs() < 1e-12);
        assert!((r.diff - 2.5).abs() < 1e-12, "la diferencia cruda no cambia");
        assert!((r.high.unwrap() - r.low.unwrap() - 2.0 * half).abs() < 1e-5);
        // Nunca se espera menos de cero.
        assert_eq!(comparar(&[0.0, 0.0, 0.0, 0.3], &[0.0; 4]).expected, 0.0);
    }

    /// Sin cambio de verdad (y sin elegir el foco: sin regresión a la media),
    /// cada veredicto en un sentido debería salir más o menos un 5 % de las
    /// veces (`NIVEL`). Con diez partidas y un coste tan sesgado ninguna t es
    /// exacta: esto mide cuánto se aparta el intervalo por sí solo.
    ///
    /// Aquí, la varianza conjunta da «mejoró» un 2,8 % y «empeoró» un 6,1 %;
    /// Welch daba 9,2 % y 1,9 %. En una simulación aparte (de una a varias
    /// muertes por partida, del 40 al 80 % de partidas a cero) Welch da 8-10 %
    /// y 1-2 %, el bootstrap de percentiles 9-16 % y 4-6 %, una permutación
    /// 2-5 % y 4-5 %, y la conjunta 1-4 % y 6 %: cerca de la permutación sin
    /// sus remuestreos.
    #[test]
    fn sin_cambio_se_equivoca_lo_que_dice_el_nivel() {
        let mut rng = StdRng::seed_from_u64(7);
        let coste = |rng: &mut StdRng| if rng.gen::<f64>() < 0.6 { 0.0 } else { -0.04 * (1.0 - rng.gen::<f64>()).ln() };
        let n = 20_000;
        let mut cuenta: HashMap<Veredicto, usize> = HashMap::new();
        for _ in 0..n {
            let a: Vec<f64> = (0..ANTES_MAX).map(|_| coste(&mut rng)).collect();
            let d: Vec<f64> = (0..PARTIDAS_PLAN).map(|_| coste(&mut rng)).collect();
            *cuenta.entry(comparar_con(&a, &d, 0.0).verdict).or_default() += 1;
        }
        let tasa = |v| *cuenta.get(&v).unwrap_or(&0) as f64 / n as f64;
        println!(
            "mejoró {:.1}% · empeoró {:.1}% · igual {:.1}% · muestra corta {:.1}%",
            100.0 * tasa(Veredicto::Improved),
            100.0 * tasa(Veredicto::Worse),
            100.0 * tasa(Veredicto::Same),
            100.0 * tasa(Veredicto::ShortSample)
        );
        // «Mejoró» por debajo del nominal: es el que no se puede regalar.
        assert!(tasa(Veredicto::Improved) <= 0.05, "{}", tasa(Veredicto::Improved));
        assert!(tasa(Veredicto::Worse) <= 0.08, "{}", tasa(Veredicto::Worse));
    }

    // -------------------------------------------------------- datos reales

    fn pts(x: f64) -> String {
        format!("{:.1}", 100.0 * x)
    }

    fn linea_de_cierre(c: &Cierre) -> String {
        format!(
            "{:?}: antes {} ({} part.) → esperado {} → después {} ({}) · efecto {} pts, entre {} y {} · relevante ±{}",
            c.verdict,
            pts(c.before),
            c.n_before,
            pts(c.expected),
            pts(c.after),
            c.n_after,
            pts(c.effect),
            c.low.map(pts).unwrap_or("-".into()),
            c.high.map(pts).unwrap_or("-".into()),
            pts(c.relevant)
        )
    }

    /// Simula un plan que empieza tras las `k` primeras: el foco con lo que
    /// había entonces y las siguientes como plan. `None` si no hay foco o no
    /// hay antes; el plan, aunque no llegue a cerrarse.
    fn simular(partidas: &[PartidaCoach], k: usize, foco: impl FnOnce(&[PartidaCoach]) -> Option<(String, usize)>) -> Option<Plan> {
        let (previas, despues) = partidas.split_at(k);
        let (cat, tramo) = foco(previas)?;
        let mut s = Sesiones::default();
        s.empezar(&cat, tramo, previas, &despues.first()?.date).ok()?;
        for p in despues {
            s.anadir(p, &p.date);
        }
        s.plans.pop()
    }

    fn foco_del_coach(previas: &[PartidaCoach]) -> Option<(String, usize)> {
        coach::resumen(previas).focus.map(|f| (f.category, f.tramo.unwrap()))
    }

    /// Un plan sobre tus partidas de verdad. En cada punto posible se toma el
    /// foco que había con las partidas de hasta entonces y las siguientes
    /// hacen de plan. No hiciste ningún plan: lo esperable es «muestra corta»,
    /// y un «mejoró» sería regresión a la media o que de verdad cambiaste. El
    /// último que cierra es el plan de tus diez últimas. Sólo lee: no escribe
    /// ni la caché del coach ni `sessions.json`.
    ///
    /// `LR_REAL=1 cargo test --lib coach_plan::tests::plan_en_mis_partidas -- --nocapture`
    #[test]
    fn plan_en_mis_partidas() {
        if std::env::var("LR_REAL").is_err() {
            return;
        }
        let mut partidas: Vec<PartidaCoach> =
            crate::storage::load_all_matches().iter().filter(|m| coach::cuenta(m)).filter_map(coach::analizar).collect();
        partidas.sort_by(|a, b| a.date.cmp(&b.date));
        let fecha_de = |p: Option<&PartidaCoach>| p.map(|p| p.date.clone()).unwrap_or_default();
        println!("{} partidas, de {} a {}", partidas.len(), fecha_de(partidas.first()), fecha_de(partidas.last()));
        if let Some(f) = coach::resumen(&partidas).focus {
            println!("foco de hoy: {} en el tramo {} · {} partidas · {} pts por partida, baremo {}\n", f.category, f.tramo.unwrap(), f.games, pts(f.user), f.base.map(pts).unwrap_or_default());
        }
        let mut ultimo = None;
        for k in ANTES_MIN..partidas.len() {
            let Some(plan) = simular(&partidas, k, foco_del_coach) else {
                println!("tras {k:2}: sin foco o sin {ANTES_MIN} partidas que lo midan");
                continue;
            };
            let foco = format!("{} {}", plan.category, plan.tramo);
            match &plan.result {
                None => println!("tras {k:2}: {foco:22} {} de {} (no cierra)", plan.contadas(), plan.target),
                Some(c) => {
                    println!("tras {k:2}: {foco:22} {}", linea_de_cierre(c));
                    ultimo = Some(plan.clone());
                }
            }
        }
        let Some(p) = ultimo else {
            println!("\nningún plan llega a cerrarse");
            return;
        };
        let c = p.result.as_ref().unwrap();
        println!("\nEL PLAN DE TUS ÚLTIMAS PARTIDAS: {} en el tramo {}, empezado tras {}", p.category, p.tramo, p.start_match.as_deref().unwrap_or("?"));
        for g in &p.games {
            println!("  {} {:9} {}", g.date, g.champion, g.cost.map(|c| format!("{} pts · {} jugadas", pts(c), g.plays)).unwrap_or("no mide el foco".into()));
        }
        println!("  {}", linea_de_cierre(c));
        assert_eq!(c.n_after, PARTIDAS_PLAN);
        assert!((ANTES_MIN..=ANTES_MAX).contains(&c.n_before));
    }

    // -------------------------------------------------------------- corpus

    fn ficheros_del_corpus(corpus: &str) -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = std::fs::read_dir(format!("{corpus}/partidas"))
            .into_iter()
            .flatten()
            .flatten()
            .flat_map(|d| std::fs::read_dir(d.path()).into_iter().flatten().flatten().map(|f| f.path()))
            .collect();
        v.sort();
        v
    }

    fn descomprimir(f: &Path) -> Option<String> {
        use std::io::Read;
        let mut texto = String::new();
        flate2::read::GzDecoder::new(&std::fs::read(f).ok()?[..]).read_to_string(&mut texto).ok()?;
        Some(texto)
    }

    /// Reparte `v` entre hilos y junta lo que devuelve `f` de cada trozo.
    fn en_hilos<T: Sync, R: Send>(v: &[T], f: impl Fn(&[T]) -> Vec<R> + Sync) -> Vec<R> {
        let hilos = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        std::thread::scope(|s| {
            let f = &f;
            let trozos: Vec<_> = v.chunks(v.len().div_ceil(hilos).max(1)).map(|t| s.spawn(move || f(t))).collect();
            trozos.into_iter().flat_map(|h| h.join().unwrap()).collect()
        })
    }

    /// Jugadores del corpus con 30 partidas o más, que no hicieron ningún
    /// plan. A cada uno se le simulan planes con el foco que tenía antes de
    /// sus 10 últimas (y de las 10 anteriores, si le da). Cuenta cuántas veces
    /// el veredicto se inventa un cambio, con la regresión a la media de elegir
    /// el foco por ser lo peor incluida; y lo mismo con un foco al azar de los
    /// que tienen muestra, que no la tiene. Sólo categorías de la API: el
    /// corpus no tiene vídeo.
    ///
    /// `CORPUS_DIR=D:/lol-corpus cargo test --release --lib coach_plan::tests::placebo_en_el_corpus -- --nocapture`
    #[test]
    fn placebo_en_el_corpus() {
        let Ok(corpus) = std::env::var("CORPUS_DIR") else { return };
        let t0 = std::time::Instant::now();
        let franjas: HashMap<String, String> = std::fs::read_to_string(format!("{corpus}/tiers.json"))
            .ok()
            .and_then(|r| serde_json::from_str(&r).ok())
            .unwrap_or_default();

        #[derive(Deserialize)]
        struct Cab {
            #[serde(rename = "match")]
            m: CabM,
        }
        #[derive(Deserialize)]
        struct CabM {
            info: CabI,
        }
        #[derive(Deserialize)]
        #[allow(non_snake_case)]
        struct CabI {
            gameCreation: i64,
            participants: Vec<CabP>,
        }
        #[derive(Deserialize)]
        struct CabP {
            puuid: String,
        }

        // Quién jugó cada partida.
        let ficheros = ficheros_del_corpus(&corpus);
        let quien: Vec<(usize, i64, Vec<String>)> = en_hilos(&ficheros.iter().enumerate().collect::<Vec<_>>(), |t| {
            t.iter()
                .filter_map(|(i, f)| {
                    let c: Cab = serde_json::from_str(&descomprimir(f)?).ok()?;
                    Some((*i, c.m.info.gameCreation, c.m.info.participants.into_iter().map(|p| p.puuid).collect()))
                })
                .collect()
        });
        let mut por_jugador: HashMap<&str, Vec<(usize, i32)>> = HashMap::new();
        for (i, _, ps) in &quien {
            for (k, p) in ps.iter().enumerate() {
                por_jugador.entry(p.as_str()).or_default().push((*i, k as i32 + 1));
            }
        }
        por_jugador.retain(|_, v| v.len() >= ANTES_MAX + PARTIDAS_PLAN);
        let creacion: HashMap<usize, i64> = quien.iter().map(|(i, c, _)| (*i, *c)).collect();
        let mut hace_falta: HashMap<usize, Vec<i32>> = HashMap::new();
        for v in por_jugador.values() {
            for (i, pid) in v {
                hace_falta.entry(*i).or_default().push(*pid);
            }
        }
        println!("{} partidas; {} jugadores con {}+; {} partidas que analizar ({:?})", quien.len(), por_jugador.len(), ANTES_MAX + PARTIDAS_PLAN, hace_falta.len(), t0.elapsed());

        // Su análisis, como el de una partida tuya sin vídeo.
        let trabajo: Vec<(usize, Vec<i32>)> = hace_falta.into_iter().collect();
        let analizadas: Vec<((usize, i32), PartidaCoach)> = en_hilos(&trabajo, |t| {
            let mut out = Vec::new();
            for (i, pids) in t {
                let Some(texto) = descomprimir(&ficheros[*i]) else { continue };
                let Ok(mut d) = serde_json::from_str::<Value>(&texto) else { continue };
                let (Ok(ps), Ok(tl)) = (
                    serde_json::from_value::<Vec<crate::riot_api::ParticipantDto>>(d["match"]["info"]["participants"].take()),
                    serde_json::from_value::<crate::riot_api::TimelineDto>(d["timeline"].take()),
                ) else {
                    continue;
                };
                let id = ficheros[*i].file_name().unwrap().to_string_lossy().trim_end_matches(".json.gz").to_string();
                let plays = crate::winprob::plays(&tl, &ps);
                let an = coach::Analisis::new(&tl, &ps, &plays);
                for pid in pids {
                    let Some(rol) = an.rol(*pid).filter(|r| crate::baselines::ROLES.contains(r)) else { continue };
                    out.push((
                        (*i, *pid),
                        PartidaCoach {
                            match_id: id.clone(),
                            date: format!("{:016}", creacion[i]),
                            champion: ps[(*pid - 1) as usize].championName.clone(),
                            role: rol.to_string(),
                            band: franjas.get(&id).filter(|b| *b != "sin").cloned(),
                            duration: an.duracion,
                            positions: "minute".into(),
                            plays: an.jugadas(*pid, None),
                            wpa_tramo: an.wpa_por_tramo(*pid),
                            ..Default::default()
                        },
                    ));
                }
            }
            out
        });
        let analizadas: HashMap<(usize, i32), PartidaCoach> = analizadas.into_iter().collect();
        println!("analizadas en {:?}", t0.elapsed());

        // Los planes de mentira.
        let mut rng = StdRng::seed_from_u64(11);
        let mut cuenta: HashMap<(&str, Veredicto), usize> = HashMap::new();
        let mut cambio: HashMap<&str, Vec<f64>> = HashMap::new();
        let mut planes: Vec<(&str, Plan)> = Vec::new();
        let mut jugadores: Vec<&&str> = por_jugador.keys().collect();
        jugadores.sort();
        for j in jugadores {
            let mut partidas: Vec<PartidaCoach> = por_jugador[*j].iter().filter_map(|k| analizadas.get(k).cloned()).collect();
            partidas.sort_by(|a, b| a.date.cmp(&b.date));
            let mut k = partidas.len().saturating_sub(PARTIDAS_PLAN);
            while k >= ANTES_MAX {
                let elegido = simular(&partidas, k, foco_del_coach);
                let azar = simular(&partidas, k, |previas| {
                    let r = coach::resumen(previas);
                    let c: Vec<&coach::Fila> = r.rows.iter().filter(|f| f.tramo.is_some() && f.games >= ANTES_MIN && f.user > 0.0).collect();
                    let f = c.get(rng.gen_range(0..c.len().max(1)))?;
                    Some((f.category.clone(), f.tramo.unwrap()))
                });
                for (como, plan) in [("foco del coach", elegido), ("foco al azar", azar)] {
                    let Some(plan) = plan.filter(|p| p.result.is_some()) else { continue };
                    let c = plan.result.clone().unwrap();
                    *cuenta.entry((como, c.verdict)).or_default() += 1;
                    if c.before > 0.0 {
                        cambio.entry(como).or_default().push(c.diff / c.before);
                    }
                    planes.push((como, plan));
                }
                k -= PARTIDAS_PLAN;
            }
        }
        println!("\nplanes simulados sin que nadie hiciera nada ({:?}):", t0.elapsed());
        for como in ["foco del coach", "foco al azar"] {
            let n: usize = cuenta.iter().filter(|((c, _), _)| *c == como).map(|(_, n)| n).sum();
            if n == 0 {
                continue;
            }
            let tasa = |v| 100.0 * *cuenta.get(&(como, v)).unwrap_or(&0) as f64 / n as f64;
            let rel = cambio.get(como).map(|v| media(v)).unwrap_or(0.0);
            println!(
                "  {como:15} {n:4} planes · mejoró {:.1}% · empeoró {:.1}% · igual {:.1}% · muestra corta {:.1}% · cambio medio {:+.0}% del antes",
                tasa(Veredicto::Improved),
                tasa(Veredicto::Worse),
                tasa(Veredicto::Same),
                tasa(Veredicto::ShortSample),
                100.0 * rel
            );
        }

        // Cuántos errores típicos del antes baja solo, con el foco del coach:
        // κ = Σ(antes − después) / Σ error típico. Ajustado con una mitad de
        // los jugadores y comprobado con la otra.
        let se_antes = |p: &Plan| {
            let (_, v) = media_var(&Plan::costes(&p.before));
            (v / p.before.len() as f64).sqrt()
        };
        let del_coach: Vec<&Plan> = planes.iter().filter(|(c, _)| *c == "foco del coach").map(|(_, p)| p).collect();
        let kappa = |ps: &[&Plan]| {
            let caida: f64 = ps.iter().map(|p| p.result.as_ref().unwrap().before - p.result.as_ref().unwrap().after).sum();
            caida / ps.iter().map(|p| se_antes(p)).sum::<f64>()
        };
        let par: Vec<&Plan> = del_coach.iter().step_by(2).copied().collect();
        let impar: Vec<&Plan> = del_coach.iter().skip(1).step_by(2).copied().collect();
        println!("\nκ = {:.2} (todos) · {:.2} (mitad par) · {:.2} (mitad impar)", kappa(&del_coach), kappa(&par), kappa(&impar));

        // Cuánto baja solo: después / antes y después / esperado, sumando
        // todos los planes. Lo segundo debería quedar cerca de 1 en cualquier
        // trozo si el modelo de la regresión vale.
        let razon = |ps: &[&Plan]| {
            let suma = |f: fn(&Cierre) -> f64| ps.iter().map(|p| f(p.result.as_ref().unwrap())).sum::<f64>();
            let d = suma(|c| c.after);
            format!("{:.2} / {:.2} ({})", d / suma(|c| c.before), d / suma(|c| c.expected), ps.len())
        };
        println!("\ndespués / antes y después / esperado (sumas), por cómo se eligió y por categoría:");
        for como in ["foco del coach", "foco al azar"] {
            let mias: Vec<&Plan> = planes.iter().filter(|(c, _)| *c == como).map(|(_, p)| p).collect();
            println!("  {como}: {}", razon(&mias));
            let mut cats: Vec<&str> = mias.iter().map(|p| p.category.as_str()).collect();
            cats.sort();
            cats.dedup();
            for cat in cats {
                let de: Vec<&Plan> = mias.iter().filter(|p| p.category == cat).copied().collect();
                println!("    {cat:20} {}", razon(&de));
            }
            for (lo, hi) in [(10, 14), (15, 19), (20, 20)] {
                let de: Vec<&Plan> =
                    mias.iter().filter(|p| (lo..=hi).contains(&p.result.as_ref().unwrap().n_before)).copied().collect();
                if !de.is_empty() {
                    println!("    antes de {lo}-{hi} partidas: {}", razon(&de));
                }
            }
        }

        // Lo que importa: a quien no hizo nada, el coach no le dice que mejoró
        // más de lo que promete el nivel.
        let n = del_coach.len() as f64;
        let falsos = del_coach.iter().filter(|p| p.result.as_ref().unwrap().verdict == Veredicto::Improved).count() as f64;
        assert!(n >= 100.0, "pocos planes simulados: {n}");
        assert!(falsos / n <= 0.05, "«mejoró» sin hacer nada: {:.1}%", 100.0 * falsos / n);
    }
}
