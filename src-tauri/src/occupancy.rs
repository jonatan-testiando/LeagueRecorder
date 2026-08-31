//! Dónde estaba cada uno de los 10 jugadores en cada instante, y con qué certeza.
//!
//! La API da la posición de los 10 una vez por minuto. Eso basta para saber en
//! qué carril vive alguien, pero no para responder la pregunta que importa:
//! *"¿cuántos rivales estaban encima de mí cuando mi equipo tiró esa torre?"*.
//!
//! La resolución se gana por dos vías:
//!
//! 1. **Anclas duras.** Muchos eventos traen posición exacta con su instante
//!    exacto: asesinatos, monstruos épicos, edificios, placas. Y `ITEM_PURCHASED`
//!    implica estar en la fuente, que es un ancla gratis y frecuentísima. Entre
//!    fotograma y fotograma suele haber varias.
//! 2. **Cono de alcanzabilidad.** Entre dos anclas un jugador no pudo estar en
//!    cualquier sitio: sólo donde llegaba a la velocidad que tenía. La posición
//!    deja de ser un punto y pasa a ser un conjunto que se estrecha cerca de las
//!    anclas y se ensancha en medio.
//!
//! Esto generaliza lo que `gank::detect` hace para un caso concreto (¿hubo un
//! gank en mi carril?) a una consulta general sobre cualquier punto y momento.

use crate::riot_api::{ParticipantDto, TimelineDto};
use std::collections::HashMap;

/// Velocidad de movimiento por defecto si el fotograma no la trae.
const SPEED_FALLBACK: f64 = 335.0;

/// Holgura sobre la velocidad base. Un jugador puede recorrer más de lo que dice
/// su `movementSpeed`: destello, potenciadores, corredores, hechizos de
/// desplazamiento. Sin este margen, la alcanzabilidad se violaría constantemente.
const SPEED_SLACK: f64 = 1.35;

/// De dónde sale un ancla. Sirve para diagnóstico y para la validación:
/// las de evento son las que se pueden ocultar y volver a predecir.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorKind {
    /// Posición del fotograma de minuto. Exacta, pero sólo cada 60 s.
    Frame,
    /// Mató, murió o asistió en ese punto.
    Combat,
    /// Tiró un edificio, una placa o un monstruo épico.
    Objective,
    /// Compró un objeto, así que estaba en la fuente.
    Fountain,
}

#[derive(Debug, Clone, Copy)]
pub struct Anchor {
    pub sec: f64,
    pub x: f64,
    pub y: f64,
    /// Se escribe siempre, pero sólo lo leen las mediciones (que son tests).
    #[cfg_attr(not(test), allow(dead_code))]
    pub kind: AnchorKind,
}

/// Estimación de la posición de un jugador en un instante.
#[derive(Debug, Clone, Copy)]
pub struct Estimate {
    /// Mejor conjetura: interpolación entre las dos anclas que lo rodean.
    pub x: f64,
    pub y: f64,
    /// Cota dura: más lejos de aquí no pudo estar sin romper la física del
    /// juego. Es el semieje menor de la elipse de alcanzabilidad (ver
    /// `elipse`). 0 justo sobre un ancla.
    pub radius: f64,
    /// Error típico esperado, calibrado contra datos reales. Mucho más pequeño
    /// que `radius`: la cota dura es lo que *pudo* pasar, esto es lo que
    /// *suele* pasar. Es el número que hay que usar para ponderar confianza.
    pub sigma: f64,
}

/// Semieje menor de la elipse de alcanzabilidad, evaluado en la fracción `f`
/// del trayecto.
///
/// Entre dos anclas separadas `dt` segundos y `d` unidades, alguien que se mueve
/// a `v` puede desviarse de la recta hasta donde la suma de distancias a las dos
/// anclas siga siendo `≤ v·dt`. Eso es exactamente una elipse con focos en las
/// anclas, y su anchura máxima es `√((v·dt)² − d²)/2`.
///
/// Esto sustituye a una fórmula anterior —`(v·dt − d)/2`— que era mucho más
/// estrecha cuando `v·dt` apenas superaba `d`, y por eso el 34% de las
/// posiciones reales caían fuera de la cota que se suponía infranqueable.
fn elipse(v: f64, dt: f64, d: f64, f: f64) -> f64 {
    let mayor = v * dt;
    if mayor <= d {
        return 0.0; // Ni yendo recto llegaba: no hay margen de desvío.
    }
    let semi_menor = (mayor * mayor - d * d).sqrt() / 2.0;
    // Anchura de la elipse en el punto `f` del eje mayor.
    semi_menor * (1.0 - (2.0 * f - 1.0).powi(2)).max(0.0).sqrt()
}

/// Qué fracción del radio duro es el error típico. Se calibra midiendo
/// `error_real / radio` sobre el corpus (ver `calibracion_del_radio`), porque la
/// posición real casi nunca está en el borde de lo alcanzable: la gente va
/// razonablemente directa a donde va. El valor se fija con datos, no a ojo.
/// Medido: p68 de `error/radio` = 0,20, estable entre el subconjunto de
/// calibración y el de validación (0,13 vs 0,14 de mediana). O sea que el error
/// típico es la quinta parte de lo que la física permitía.
const FACTOR_SIGMA: f64 = 0.20;

pub struct Occupancy {
    /// Anclas por jugador, ordenadas por instante.
    anchors: HashMap<i32, Vec<Anchor>>,
    /// Velocidad por jugador y minuto.
    speed: HashMap<(i32, usize), f64>,
    /// Ver `FACTOR_SIGMA`. Es campo y no constante para que la prueba de
    /// calibración pueda barrer valores.
    factor_sigma: f64,
}

/// Qué se admite como ancla. Existe porque no todas valen lo mismo: la víctima
/// de un asesinato estuvo ahí seguro, pero un asistente pudo estar en la otra
/// punta del mapa con un ulti global.
#[derive(Debug, Clone, Copy)]
pub struct Config {
    pub victima: bool,
    pub asesino: bool,
    pub asistentes: bool,
    pub objetivos: bool,
    pub fuente: bool,
}

impl Default for Config {
    /// La fuente va apagada **por medición**, no por criterio: en la prueba de
    /// ablación (`que_anclas_ayudan`) encenderla empeora la mediana de 2065 a
    /// 2244 y el p75 de 4767 a 5296. Parecía el ancla gratis más obvia y
    /// resultó ser la única que estorba: interpolar en línea recta desde la
    /// base modela fatal a alguien que sale por un carril.
    fn default() -> Self {
        Self { victima: true, asesino: true, asistentes: true, objetivos: true, fuente: false }
    }
}

/// Posición de la fuente de cada equipo.
fn fountain(team_id: i32) -> (f64, f64) {
    if team_id == 100 {
        (400.0, 400.0)
    } else {
        (14400.0, 14400.0)
    }
}

impl Occupancy {
    pub fn build(tl: &TimelineDto, participants: &[ParticipantDto]) -> Self {
        Self::build_with(tl, participants, Config::default())
    }

    pub fn build_with(tl: &TimelineDto, participants: &[ParticipantDto], cfg: Config) -> Self {
        let mut anchors: HashMap<i32, Vec<Anchor>> = HashMap::new();
        let mut speed: HashMap<(i32, usize), f64> = HashMap::new();
        let team_of = |pid: i32| {
            participants
                .get((pid - 1) as usize)
                .map(|p| p.teamId)
                .unwrap_or(100)
        };

        let mut push = |pid: i32, sec: f64, x: f64, y: f64, kind: AnchorKind| {
            if pid >= 1 && pid <= 10 {
                anchors.entry(pid).or_default().push(Anchor { sec, x, y, kind });
            }
        };

        for (minute, frame) in tl.info.frames.iter().enumerate() {
            let sec = frame.timestamp as f64 / 1000.0;
            for (key, pf) in &frame.participantFrames {
                let Ok(pid) = key.parse::<i32>() else { continue };
                if pf.championStats.movementSpeed > 0 {
                    speed.insert((pid, minute), pf.championStats.movementSpeed as f64);
                }
                if let Some(p) = &pf.position {
                    push(pid, sec, p.x as f64, p.y as f64, AnchorKind::Frame);
                }
            }

            for ev in &frame.events {
                let sec = ev.timestamp as f64 / 1000.0;
                match ev.event_type.as_str() {
                    "CHAMPION_KILL" => {
                        let Some(p) = &ev.position else { continue };
                        let (x, y) = (p.x as f64, p.y as f64);
                        // La víctima estuvo ahí con total seguridad. El asesino y
                        // los asistentes, a distancia de pegar: se toman como
                        // ancla igualmente porque el error que introduce (unos
                        // cientos de unidades) es mucho menor que el que se evita.
                        if cfg.victima {
                            push(ev.victimId, sec, x, y, AnchorKind::Combat);
                        }
                        if cfg.asesino {
                            push(ev.killerId, sec, x, y, AnchorKind::Combat);
                        }
                        if cfg.asistentes {
                            for pid in &ev.assistingParticipantIds {
                                push(*pid, sec, x, y, AnchorKind::Combat);
                            }
                        }
                    }
                    "ELITE_MONSTER_KILL" | "BUILDING_KILL" | "TURRET_PLATE_DESTROYED"
                        if cfg.objetivos =>
                    {
                        let Some(p) = &ev.position else { continue };
                        let (x, y) = (p.x as f64, p.y as f64);
                        push(ev.killerId, sec, x, y, AnchorKind::Objective);
                        for pid in &ev.assistingParticipantIds {
                            push(*pid, sec, x, y, AnchorKind::Objective);
                        }
                    }
                    "ITEM_PURCHASED" if cfg.fuente => {
                        // Comprar exige estar en la tienda. Es el ancla más
                        // abundante de todas y nadie la usa.
                        let (x, y) = fountain(team_of(ev.participantId));
                        push(ev.participantId, sec, x, y, AnchorKind::Fountain);
                    }
                    _ => {}
                }
            }
        }

        for v in anchors.values_mut() {
            v.sort_by(|a, b| a.sec.total_cmp(&b.sec));
        }
        Self { anchors, speed, factor_sigma: FACTOR_SIGMA }
    }

/// Sólo lo usan las mediciones sobre el corpus, que son tests. Se marca en vez
/// de borrarse: es el instrumento con el que se fijaron las constantes de este
/// módulo, y hará falta la próxima vez que haya que revisarlas.
    #[cfg(test)]
    pub fn anchors_of(&self, pid: i32) -> &[Anchor] {
        self.anchors.get(&pid).map(Vec::as_slice).unwrap_or(&[])
    }

    fn speed_at(&self, pid: i32, sec: f64) -> f64 {
        let minute = (sec / 60.0) as usize;
        (0..=minute)
            .rev()
            .find_map(|m| self.speed.get(&(pid, m)).copied())
            .unwrap_or(SPEED_FALLBACK)
            * SPEED_SLACK
    }

    /// Dónde estaba `pid` en el segundo `sec`, y con cuánta incertidumbre.
    ///
    /// `skip` permite ignorar un ancla concreta por su índice: es lo que usa la
    /// validación para esconder un ancla y comprobar si se predice sola.
    pub fn estimate_skipping(&self, pid: i32, sec: f64, skip: Option<usize>) -> Option<Estimate> {
        let all = self.anchors.get(&pid)?;
        let usable = |i: usize| skip != Some(i);

        let before = (0..all.len())
            .filter(|&i| usable(i) && all[i].sec <= sec)
            .next_back();
        let after = (0..all.len()).find(|&i| usable(i) && all[i].sec >= sec);

        match (before, after) {
            (Some(i), Some(j)) => {
                let (a, b) = (all[i], all[j]);
                let dt = b.sec - a.sec;
                if dt <= 0.001 {
                    return Some(Estimate { x: a.x, y: a.y, radius: 0.0, sigma: 0.0 });
                }
                let f = ((sec - a.sec) / dt).clamp(0.0, 1.0);
                let v = self.speed_at(pid, sec);
                let recta = ((b.x - a.x).powi(2) + (b.y - a.y).powi(2)).sqrt();
                let radius = elipse(v, dt, recta, f);
                Some(Estimate {
                    x: a.x + (b.x - a.x) * f,
                    y: a.y + (b.y - a.y) * f,
                    radius,
                    sigma: radius * self.factor_sigma,
                })
            }
            // Fuera del rango de anclas: sólo se puede acotar por velocidad.
            (Some(i), None) => {
                let a = all[i];
                let r = self.speed_at(pid, sec) * (sec - a.sec).max(0.0);
                Some(Estimate { x: a.x, y: a.y, radius: r, sigma: r * self.factor_sigma })
            }
            (None, Some(j)) => {
                let b = all[j];
                let r = self.speed_at(pid, sec) * (b.sec - sec).max(0.0);
                Some(Estimate { x: b.x, y: b.y, radius: r, sigma: r * self.factor_sigma })
            }
            (None, None) => None,
        }
    }

    pub fn estimate(&self, pid: i32, sec: f64) -> Option<Estimate> {
        self.estimate_skipping(pid, sec, None)
    }

    /// Confianza [0,1] de que `pid` estuviera a menos de `radius` de (x, y) en
    /// el segundo `sec`.
    ///
    /// Tres tramos, y cada uno responde a algo distinto:
    ///
    /// - Si la mejor conjetura ya cae dentro del radio pedido: 1.
    /// - Si está más lejos de lo alcanzable (`e.radius`): 0. Cota dura, no
    ///   opinión — no pudo estar ahí.
    /// - En medio, decae como una gaussiana sobre `sigma`, que es el error
    ///   típico medido, no la cota. Antes era una rampa lineal sobre la cota, y
    ///   eso sobreestimaba muchísimo la presencia lejos del centro.
    pub fn presence(&self, pid: i32, sec: f64, x: f64, y: f64, radius: f64) -> f64 {
        let Some(e) = self.estimate(pid, sec) else { return 0.0 };
        let d = ((e.x - x).powi(2) + (e.y - y).powi(2)).sqrt();
        if d > radius + e.radius {
            return 0.0; // Cota dura: no pudo estar ahí.
        }

        // Cuánta de la incertidumbre cabe dentro del radio preguntado. A mitad
        // de un hueco entre anclas el error típico es de miles de unidades, así
        // que "la conjetura cae dentro" no significa gran cosa.
        //
        // Sin este factor, `presence` devolvía 1.0 en cuanto la interpolación
        // caía dentro del radio, sin importar lo incierta que fuera. Como todos
        // los jugadores se interpolan en línea recta entre fotogramas de minuto,
        // sus rastros se cruzaban por artefacto y salían "cinco rivales encima"
        // con certeza total a mitad de un hueco de 60 segundos.
        let fiabilidad = if e.sigma <= 1.0 {
            1.0
        } else {
            1.0 - (-(radius * radius) / (2.0 * e.sigma * e.sigma)).exp()
        };

        if d <= radius {
            return fiabilidad;
        }
        if e.sigma <= 0.0 {
            return 0.0;
        }
        let z = (d - radius) / e.sigma;
        fiabilidad * (-0.5 * z * z).exp()
    }

    /// Confianza de cada jugador del equipo `team_id` de estar cerca de (x, y).
    pub fn presences(
        &self,
        participants: &[ParticipantDto],
        team_id: i32,
        sec: f64,
        x: f64,
        y: f64,
        radius: f64,
    ) -> Vec<f64> {
        participants
            .iter()
            .enumerate()
            .filter(|(_, p)| p.teamId == team_id)
            .map(|(i, _)| self.presence((i + 1) as i32, sec, x, y, radius))
            .collect()
    }

    /// Cuántos jugadores del equipo estaban cerca **con certeza razonable**.
    ///
    /// Existe porque la suma de confianzas engaña: cinco rivales al 0,45 suman
    /// 2,25 y parecen una multitud, cuando en realidad no se sabe dónde estaba
    /// ninguno. Contando sólo los que superan el umbral, la incertidumbre deja
    /// de acumularse en presencia ficticia.
    pub fn committed_sure(
        &self,
        participants: &[ParticipantDto],
        team_id: i32,
        sec: f64,
        x: f64,
        y: f64,
        radius: f64,
        umbral: f64,
    ) -> usize {
        self.presences(participants, team_id, sec, x, y, radius)
            .into_iter()
            .filter(|c| *c >= umbral)
            .count()
    }

    /// Cuántos jugadores del equipo `team_id` estaban cerca de (x, y), sumando
    /// confianzas. Es la medida de "cuánta gente había comprometida aquí".
    pub fn committed(
        &self,
        participants: &[ParticipantDto],
        team_id: i32,
        sec: f64,
        x: f64,
        y: f64,
        radius: f64,
    ) -> f64 {
        participants
            .iter()
            .enumerate()
            .filter(|(_, p)| p.teamId == team_id)
            .map(|(i, _)| self.presence((i + 1) as i32, sec, x, y, radius))
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cargar(dir: &str, id: &str) -> (TimelineDto, Vec<ParticipantDto>) {
        let tl: TimelineDto =
            serde_json::from_str(&std::fs::read_to_string(format!("{dir}/{id}.timeline.json")).unwrap())
                .unwrap();
        let m: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(format!("{dir}/{id}.match.json")).unwrap())
                .unwrap();
        let ps: Vec<ParticipantDto> =
            serde_json::from_value(m["info"]["participants"].clone()).unwrap();
        (tl, ps)
    }

    /// Compara qué anclas ayudan y cuáles estorban.
    ///
    /// El objetivo son las **posiciones de fotograma**: exactas para los 10
    /// jugadores y, a diferencia de las muertes, no arrastran contaminación.
    /// Validar sobre muertes daba resultados absurdos porque tras morir siempre
    /// se reaparece y se compra, y esa compra —ancla correcta— tira de la
    /// estimación hacia la base justo en el instante evaluado.
    ///
    /// Se oculta un fotograma de cada dos y se predice desde el resto, así que
    /// el hueco a salvar es de 2 minutos: el caso difícil de verdad.
    #[test]
    fn que_anclas_ayudan() {
        let Ok(dir) = std::env::var("ATTR_CORPUS_DIR") else {
            return;
        };
        let mut ids: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.strip_suffix(".match.json").map(str::to_string))
            .collect();
        ids.sort();
        let partidas: Vec<_> = ids.iter().map(|id| cargar(&dir, id)).collect();

        let base = Config { victima: false, asesino: false, asistentes: false, objetivos: false, fuente: false };
        let variantes: Vec<(&str, Config)> = vec![
            ("sólo fotogramas", base),
            ("+ fuente", Config { fuente: true, ..base }),
            ("+ objetivos", Config { fuente: true, objetivos: true, ..base }),
            ("+ víctimas", Config { fuente: true, objetivos: true, victima: true, ..base }),
            ("+ asesino", Config { fuente: true, objetivos: true, victima: true, asesino: true, ..base }),
            ("+ asistentes (todo)", Config { victima: true, asesino: true, asistentes: true, objetivos: true, fuente: true }),
            ("TODO MENOS FUENTE", Config { victima: true, asesino: true, asistentes: true, objetivos: true, fuente: false }),
        ];

        println!("\nerror al predecir una posición de fotograma oculta (hueco de 2 min):");
        println!("{:<22} {:>9} {:>9} {:>9} {:>9}", "anclas usadas", "mediana", "p75", "p90", "media");
        let mut n_obj = 0usize;
        for (nombre, cfg) in &variantes {
            let mut errs: Vec<f64> = Vec::new();
            for (tl, ps) in &partidas {
                let occ = Occupancy::build_with(tl, ps, *cfg);
                for pid in 1..=10 {
                    let anclas = occ.anchors_of(pid);
                    for (i, a) in anclas.iter().enumerate() {
                        // Uno de cada dos fotogramas, por minuto par.
                        if a.kind != AnchorKind::Frame || (a.sec / 60.0).round() as i64 % 2 != 0 {
                            continue;
                        }
                        if let Some(e) = occ.estimate_skipping(pid, a.sec, Some(i)) {
                            errs.push(((e.x - a.x).powi(2) + (e.y - a.y).powi(2)).sqrt());
                        }
                    }
                }
            }
            errs.sort_by(f64::total_cmp);
            let p = |q: f64| errs[((errs.len() - 1) as f64 * q) as usize];
            let media = errs.iter().sum::<f64>() / errs.len() as f64;
            n_obj = errs.len();
            println!("{nombre:<22} {:>9.0} {:>9.0} {:>9.0} {:>9.0}", p(0.50), p(0.75), p(0.90), media);
        }
        println!("({n_obj} posiciones evaluadas en {} partidas)", partidas.len());
    }

    /// Calibra el radio: ¿cubre la cota dura lo que dice cubrir, y qué fracción
    /// de ella es el error típico?
    ///
    /// Método: ocultar posiciones de fotograma, predecirlas, y comparar el error
    /// real contra el radio que el estimador anunciaba. Dos cosas se miden:
    ///
    /// 1. **Cobertura**: qué porcentaje de posiciones reales cae dentro de la
    ///    cota. Debería ser casi 100%; lo que se escapa son destellos,
    ///    teleportes y potenciadores de velocidad.
    /// 2. **Forma**: la distribución de `error / radio`, que es lo que fija
    ///    `FACTOR_SIGMA`.
    #[test]
    fn calibracion_del_radio() {
        let Ok(dir) = std::env::var("ATTR_CORPUS_DIR") else {
            return;
        };
        let mut ids: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.strip_suffix(".match.json").map(str::to_string))
            .collect();
        ids.sort();
        // Mitad para calibrar, mitad para comprobar que la calibración aguanta
        // en partidas que no se usaron para fijarla.
        let corte = ids.len() / 2;

        let recoger = |subset: &[String]| -> (Vec<f64>, Vec<f64>) {
            let (mut errores, mut ratios) = (Vec::new(), Vec::new());
            for id in subset {
                let (tl, ps) = cargar(&dir, id);
                let occ = Occupancy::build(&tl, &ps);
                for pid in 1..=10 {
                    let anclas = occ.anchors_of(pid);
                    for (i, a) in anclas.iter().enumerate() {
                        if a.kind != AnchorKind::Frame || (a.sec / 60.0).round() as i64 % 2 != 0 {
                            continue;
                        }
                        if let Some(e) = occ.estimate_skipping(pid, a.sec, Some(i)) {
                            let d = ((e.x - a.x).powi(2) + (e.y - a.y).powi(2)).sqrt();
                            errores.push(d);
                            if e.radius > 1.0 {
                                ratios.push(d / e.radius);
                            }
                        }
                    }
                }
            }
            (errores, ratios)
        };

        let (err_cal, ratios_cal) = recoger(&ids[..corte]);
        let (err_val, ratios_val) = recoger(&ids[corte..]);
        assert!(!ratios_cal.is_empty());

        let pct = |v: &mut Vec<f64>, q: f64| {
            v.sort_by(f64::total_cmp);
            v[((v.len() - 1) as f64 * q) as usize]
        };
        let cobertura = |r: &[f64]| 100.0 * r.iter().filter(|x| **x <= 1.0).count() as f64 / r.len() as f64;

        println!("\n--- calibración ({} partidas, {} muestras) ---", corte, ratios_cal.len());
        println!("cobertura de la cota dura : {:.1}%", cobertura(&ratios_cal));
        println!(
            "error/radio: mediana {:.2} | p75 {:.2} | p90 {:.2} | p95 {:.2}",
            pct(&mut ratios_cal.clone(), 0.50),
            pct(&mut ratios_cal.clone(), 0.75),
            pct(&mut ratios_cal.clone(), 0.90),
            pct(&mut ratios_cal.clone(), 0.95)
        );
        println!("error absoluto: mediana {:.0}", pct(&mut err_cal.clone(), 0.50));

        println!("\n--- validación ({} partidas, {} muestras) ---", ids.len() - corte, ratios_val.len());
        println!("cobertura de la cota dura : {:.1}%", cobertura(&ratios_val));
        println!(
            "error/radio: mediana {:.2} | p75 {:.2} | p90 {:.2} | p95 {:.2}",
            pct(&mut ratios_val.clone(), 0.50),
            pct(&mut ratios_val.clone(), 0.75),
            pct(&mut ratios_val.clone(), 0.90),
            pct(&mut ratios_val.clone(), 0.95)
        );
        println!("error absoluto: mediana {:.0}", pct(&mut err_val.clone(), 0.50));

        let sugerido = pct(&mut ratios_cal.clone(), 0.68); // 1 sigma de una normal
        println!("\nFACTOR_SIGMA sugerido (p68 del ratio): {sugerido:.2} — actual: {FACTOR_SIGMA:.2}");

        // La cota dura tiene que serlo de verdad: si se escapa más de un 10%,
        // no es una cota, es una sugerencia.
        assert!(
            cobertura(&ratios_val) >= 90.0,
            "la cota dura sólo cubre el {:.1}%",
            cobertura(&ratios_val)
        );
        // Y la constante tiene que seguir pareciéndose a lo que dicen los datos.
        // Si alguien toca el estimador y esto se desvía, se entera aquí y no tres
        // fases más adelante con un score mal ponderado.
        assert!(
            (sugerido - FACTOR_SIGMA).abs() < 0.10,
            "FACTOR_SIGMA ({FACTOR_SIGMA:.2}) se ha desviado de los datos ({sugerido:.2})"
        );
    }

    /// Esconde cada ancla de evento y comprueba si el estimador la habría
    /// predicho a partir de las demás. Es la única validación posible sin el
    /// vídeo, y mide justo lo que importa: el error entre fotogramas.
    #[test]
    fn precision_dejando_fuera_cada_ancla() {
        let Ok(dir) = std::env::var("ATTR_CORPUS_DIR") else {
            return;
        };
        let mut ids: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.strip_suffix(".match.json").map(str::to_string))
            .collect();
        ids.sort();

        let mut errores: Vec<f64> = Vec::new();
        let mut errores_solo_frames: Vec<f64> = Vec::new();
        let mut fuera_de_cono = 0usize;
        let mut total_anclas = 0usize;

        for id in ids.iter().take(18) {
            let (tl, ps) = cargar(&dir, id);
            let occ = Occupancy::build(&tl, &ps);
            // Un estimador que sólo usa fotogramas de minuto, para comparar.
            let solo_frames = Occupancy {
                anchors: occ
                    .anchors
                    .iter()
                    .map(|(k, v)| {
                        (*k, v.iter().copied().filter(|a| a.kind == AnchorKind::Frame).collect())
                    })
                    .collect(),
                speed: occ.speed.clone(),
                factor_sigma: occ.factor_sigma,
            };

            for pid in 1..=10 {
                let anclas = occ.anchors_of(pid).to_vec();
                for (i, a) in anclas.iter().enumerate() {
                    // Sólo se validan las de combate y objetivo: son las que
                    // caen entre fotogramas y las que interesa acertar.
                    if a.kind != AnchorKind::Combat && a.kind != AnchorKind::Objective {
                        continue;
                    }
                    total_anclas += 1;
                    if let Some(e) = occ.estimate_skipping(pid, a.sec, Some(i)) {
                        let d = ((e.x - a.x).powi(2) + (e.y - a.y).powi(2)).sqrt();
                        errores.push(d);
                        if d > e.radius + 1.0 {
                            fuera_de_cono += 1;
                        }
                    }
                    if let Some(e) = solo_frames.estimate(pid, a.sec) {
                        errores_solo_frames
                            .push(((e.x - a.x).powi(2) + (e.y - a.y).powi(2)).sqrt());
                    }
                }
            }
        }

        assert!(!errores.is_empty(), "no se validó ninguna ancla");
        let pct = |v: &mut Vec<f64>, q: f64| {
            v.sort_by(f64::total_cmp);
            v[((v.len() - 1) as f64 * q) as usize]
        };
        let media = errores.iter().sum::<f64>() / errores.len() as f64;
        println!(
            "\n{total_anclas} anclas de evento validadas dejando cada una fuera\n\
             error del estimador completo : mediana {:.0} | p75 {:.0} | p90 {:.0} | media {:.0}",
            pct(&mut errores.clone(), 0.50),
            pct(&mut errores.clone(), 0.75),
            pct(&mut errores.clone(), 0.90),
            media
        );
        let media_f = errores_solo_frames.iter().sum::<f64>() / errores_solo_frames.len() as f64;
        println!(
            "error sólo con fotogramas    : mediana {:.0} | p75 {:.0} | p90 {:.0} | media {:.0}",
            pct(&mut errores_solo_frames.clone(), 0.50),
            pct(&mut errores_solo_frames.clone(), 0.75),
            pct(&mut errores_solo_frames.clone(), 0.90),
            media_f
        );
        println!(
            "mejora de usar las anclas de evento: {:.0}% menos error medio",
            100.0 * (1.0 - media / media_f)
        );
        println!(
            "anclas fuera del cono de incertidumbre: {fuera_de_cono} ({:.1}%) \
             — destellos, teleportes y reapariciones",
            100.0 * fuera_de_cono as f64 / errores.len() as f64
        );
        // El mapa mide ~14 800 de lado: un error medio por encima de un cuarto
        // del mapa significaría que el estimador no sirve para nada.
        assert!(media < 3700.0, "error medio absurdo: {media:.0}");
    }
}
