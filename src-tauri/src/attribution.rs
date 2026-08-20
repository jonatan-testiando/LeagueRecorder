//! Reparto de crédito por evento, sólo con datos de la API de Riot.
//!
//! El KDA y los scores que se construyen encima (OP Score y compañía) cuentan
//! kills y asistencias como si todos valieran lo mismo y como si el que remata
//! fuera el que hizo el trabajo. Este módulo corrige las tres cosas:
//!
//! 1. **Quién hizo el trabajo**: cada muerte se reparte por el daño real que
//!    puso cada jugador (`victimDamageReceived`), no por quién dio el último golpe.
//! 2. **Cuánto valió**: los kills se pesan por su oro (`bounty` + `shutdownBounty`),
//!    no se cuentan a pelo. Matar al alimentado en el minuto 30 no es matar al
//!    support en el 4.
//! 3. **Cuánto costó morir**: una muerte cuesta el oro que regalaste más el
//!    tiempo que estuviste fuera de la partida, que crece con el nivel y el reloj.
//!
//! Todo es solo-API: funciona para los 10 jugadores de cualquier partida, sin
//! depender del vídeo.

use crate::riot_api::{damage_shares, ParticipantDto, TimelineDto};
use std::collections::HashMap;

/// Oro que entrega cada objetivo al equipo que lo toma.
///
/// **Medidos, no tabulados.** Salen de una regresión sobre ~590.000
/// observaciones equipo-minuto del corpus (9.075 partidas) (`tools/corpus`, script
/// `fit_objective_gold.py`): se explica el incremento de oro del equipo en cada
/// minuto por su CS, su jungla, el oro de sus asesinatos —que se conoce exacto—
/// y los objetivos que tomó. Se hace así y no con una tabla porque Riot cambió
/// estos valores en la temporada 2026 y volverá a cambiarlos; el ajuste se
/// rehace con un comando.
///
/// Tres validaciones del método: el coeficiente de las placas sale **116** y la
/// documentación dice **120**, sin habérselo dicho al modelo; controlar por el
/// minuto de partida —la renta pasiva crece— convirtió el coeficiente de los
/// grubs de −11,8 (imposible) a positivo; y los valores **convergen**: entre
/// 1.250 y 9.075 partidas las placas pasan de 116,9 a 116,4 y el barón de 821,7
/// a 813,9. Ya no merece la pena más muestra para esto.
///
/// Ojo con lo que significan: es **oro entregado en ese minuto**, así que para
/// barón y dragón mezclan la recompensa directa con lo que sus mejoras generan
/// justo después. Para valorar una jugada eso es defendible —el valor de un
/// barón es lo que convierte— pero no son el precio de catálogo del objetivo.
/// Cuando exista el modelo de probabilidad de victoria, esto se sustituye.
pub const PESO_PLACA: f64 = 116.0;
pub const PESO_DRAGON: f64 = 85.0;
pub const PESO_BARON: f64 = 814.0;
pub const PESO_HERALDO: f64 = 30.0;
pub const PESO_GRUBS: f64 = 9.0;

/// Oro de una estructura según su tipo. Comparte tabla con `peso` para que el
/// modelo de probabilidad de victoria y el reparto de crédito no se separen.
pub fn peso_estructura(building: Option<&str>, tower: Option<&str>) -> f64 {
    match (building, tower) {
        (Some("INHIBITOR_BUILDING"), _) => peso::INHIBIDOR,
        (_, Some("OUTER_TURRET")) => peso::TORRE_EXTERIOR,
        (_, Some("INNER_TURRET")) => peso::TORRE_INTERIOR,
        (_, Some("BASE_TURRET")) => peso::TORRE_BASE,
        (_, Some("NEXUS_TURRET")) => peso::TORRE_NEXO,
        _ => 0.0,
    }
}

mod peso {
    pub const PLACA: f64 = 116.0;
    pub const TORRE_EXTERIOR: f64 = 315.0;
    pub const TORRE_INTERIOR: f64 = 215.0;
    pub const TORRE_BASE: f64 = 238.0;
    pub const TORRE_NEXO: f64 = 243.0;
    pub const INHIBIDOR: f64 = 83.0;
    pub const DRAGON: f64 = 85.0;
    pub const BARON: f64 = 814.0;
    pub const HERALDO: f64 = 30.0;
    pub const GRUBS: f64 = 9.0;
}

/// Tiempo base de reaparición por nivel de campeón (1..18), en segundos.
const BASE_RESPAWN: [f64; 18] = [
    10.0, 10.0, 12.0, 12.0, 14.0, 16.0, 20.0, 25.0, 28.0, 32.5, 35.0, 37.5, 40.0, 42.5, 45.0,
    47.5, 50.0, 52.5,
];

/// Factor de aumento del temporizador de muerte según el reloj de partida.
/// Antes del minuto 15 no hay recargo; a partir de ahí sube por tramos, con
/// tope del 50%.
fn time_increase_factor(minute: f64) -> f64 {
    let tif = if minute < 15.0 {
        0.0
    } else if minute < 30.0 {
        (2.0 * (minute - 15.0)).ceil() * 0.00425
    } else if minute < 45.0 {
        0.1275 + (2.0 * (minute - 30.0)).ceil() * 0.0030
    } else {
        0.2175 + (2.0 * (minute - 45.0)).ceil() * 0.0145
    };
    tif.min(0.50)
}

/// Cuánto dura una muerte concreta, en segundos.
fn death_timer(level: i32, minute: f64) -> f64 {
    let idx = (level.clamp(1, 18) - 1) as usize;
    BASE_RESPAWN[idx] * (1.0 + time_increase_factor(minute))
}

/// Una muerte concreta y lo que costó en tiempo fuera de la partida.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct DeathCost {
    pub minute: f64,
    pub seconds_dead: f64,
}

/// Lo que aportó y lo que costó un jugador, en oro.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct PlayerCredit {
    pub participant_id: i32,
    pub champion: String,
    pub team_id: i32,
    pub kills: i32,
    pub deaths: i32,
    pub assists: i32,
    /// Oro de asesinatos que Riot le adjudicó por dar el último golpe.
    /// Es lo que ve un KDA.
    pub killing_blow_gold: f64,
    /// El mismo oro, pero repartido por el daño que puso cada uno.
    pub damage_credit_gold: f64,
    /// `damage_credit_gold - killing_blow_gold`. Positivo = hizo más trabajo del
    /// que le reconoce el marcador; negativo = se llevó kills que trabajaron otros.
    pub credit_gap: f64,
    /// Oro que regaló al morir (su propia recompensa más el shutdown).
    pub death_gold_given: f64,
    /// Segundos que pasó muerto en total, según Riot.
    pub time_dead: f64,
    /// Cada muerte con lo que costó. Es lo que permite distinguir morir baiteando
    /// en el minuto 8 de morir en el 35 y perder el barón por ello.
    pub deaths_detail: Vec<DeathCost>,
    /// Oro de objetivos y estructuras que le corresponde. Ver `peso`.
    pub objective_gold: f64,
    /// Lo que aportó en total: daño en asesinatos más objetivos. Es el primer
    /// número único por jugador que produce este módulo — incompleto (no valora
    /// visión, aguante ni presión) pero honesto en lo que sí cubre.
    pub total_value: f64,
    /// Probabilidad de victoria que aportó, sumando su parte de cada jugada.
    /// Es la moneda común: a diferencia del oro, sabe que una torre en el
    /// minuto 30 vale más que la misma torre en el 10. Ver `crate::winprob`.
    pub wpa: f64,
    /// Puesto que jugó (`TOP`, `JUNGLE`, `MIDDLE`, `BOTTOM`, `UTILITY`).
    pub role: String,
    /// Percentil de su WPA **dentro de su rol**, de 0 a 100. Es el único número
    /// comparable entre puestos: el techo de un support es más bajo, así que
    /// +0,05 de probabilidad no significa lo mismo para él que para un tirador.
    /// Ver `crate::baselines`.
    pub role_percentile: f64,
    /// Fracción de los asesinatos de su equipo en los que puso daño.
    /// La participación de verdad, no la de las etiquetas de asistencia.
    pub damage_participation: f64,
    /// Cuando participó, qué parte del daño puso de media.
    pub mean_damage_share: f64,
}

/// Reparte el crédito de todos los asesinatos de la partida entre los 10 jugadores.
pub fn analyze(tl: &TimelineDto, participants: &[ParticipantDto]) -> Vec<PlayerCredit> {
    let mut credit: HashMap<i32, PlayerCredit> = HashMap::new();
    for (i, p) in participants.iter().enumerate() {
        let pid = (i + 1) as i32;
        credit.insert(
            pid,
            PlayerCredit {
                participant_id: pid,
                champion: p.championName.clone(),
                team_id: p.teamId,
                kills: p.kills,
                deaths: p.deaths,
                assists: p.assists,
                role: if p.teamPosition.is_empty() {
                    p.individualPosition.clone()
                } else {
                    p.teamPosition.clone()
                },
                ..Default::default()
            },
        );
    }
    let team_of = |pid: i32| participants.get((pid - 1) as usize).map(|p| p.teamId);

    // Nivel de cada jugador minuto a minuto, para el temporizador de muerte.
    let mut level_at: HashMap<(i32, usize), i32> = HashMap::new();
    for (minute, frame) in tl.info.frames.iter().enumerate() {
        for (key, pf) in &frame.participantFrames {
            if let Ok(pid) = key.parse::<i32>() {
                level_at.insert((pid, minute), pf.level.max(1));
            }
        }
    }
    let level_of = |pid: i32, minute: usize| -> i32 {
        // El frame del minuto en curso, o el más cercano hacia atrás.
        (0..=minute)
            .rev()
            .find_map(|m| level_at.get(&(pid, m)).copied())
            .unwrap_or(1)
    };

    // Instante en que acabó la partida. Hace falta porque una muerte en los
    // últimos segundos no cuesta el temporizador entero: si el nexo cae antes,
    // el jugador no llegó a pasar todo ese rato fuera. Sin este recorte el
    // tiempo muerto del equipo que pierde se sobreestima.
    let game_end = tl
        .info
        .frames
        .iter()
        .flat_map(|f| f.events.iter())
        .find(|e| e.event_type == "GAME_END")
        .map(|e| e.timestamp)
        .or_else(|| tl.info.frames.last().map(|f| f.timestamp))
        .unwrap_or(i64::MAX) as f64
        / 1000.0;

    // Cada muerte con su minuto y su temporizador calculado. La fórmula acierta
    // dentro del 2% en la mayoría de casos, pero se desvía en las muertes tardías
    // del equipo que pierde (revives, el nexo cayendo a mitad del temporizador).
    // Por eso no se usa como valor absoluto: sirve para repartir *entre* muertes,
    // y el total lo fija `totalTimeSpentDead`, que Riot ya mide.
    let mut timers: HashMap<i32, Vec<(f64, f64)>> = HashMap::new();
    let mut team_kills: HashMap<i32, i32> = HashMap::new();
    let mut participated: HashMap<i32, i32> = HashMap::new();
    let mut share_sum: HashMap<i32, f64> = HashMap::new();

    for frame in &tl.info.frames {
        for ev in frame.events.iter().filter(|e| e.event_type == "CHAMPION_KILL") {
            let minute = ev.timestamp as f64 / 60_000.0;
            let gold = (ev.bounty + ev.shutdownBounty) as f64;

            // Coste para quien murió.
            if let Some(c) = credit.get_mut(&ev.victimId) {
                c.death_gold_given += gold;
                let timer = death_timer(level_of(ev.victimId, minute as usize), minute);
                let until_end = (game_end - ev.timestamp as f64 / 1000.0).max(0.0);
                timers
                    .entry(ev.victimId)
                    .or_default()
                    .push((minute, timer.min(until_end)));
            }

            // El último golpe: lo que el marcador le adjudica.
            if let Some(c) = credit.get_mut(&ev.killerId) {
                c.killing_blow_gold += gold;
            }

            let killer_team = match team_of(ev.killerId) {
                Some(t) => t,
                None => continue, // Ejecuciones por torre/esbirro: killerId = 0.
            };
            *team_kills.entry(killer_team).or_insert(0) += 1;

            // El reparto real. Se usa la ventana de la pelea entera cuando existe:
            // recoge a quien peleó de verdad aunque no tocara al que murió al final.
            let damage = if !ev.victimTeamfightDamageReceived.is_empty() {
                &ev.victimTeamfightDamageReceived
            } else {
                &ev.victimDamageReceived
            };
            let shares = damage_shares(damage);
            // Sólo cuenta el daño del bando que mató: al que muere le puede haber
            // pegado un aliado suyo de rebote y eso no es crédito.
            let by_killers: HashMap<i32, i32> = shares
                .into_iter()
                .filter(|(pid, _)| team_of(*pid) == Some(killer_team))
                .collect();
            let total: i32 = by_killers.values().sum();
            if total <= 0 {
                // Sin desglose utilizable, el oro se queda donde lo puso Riot.
                if let Some(c) = credit.get_mut(&ev.killerId) {
                    c.damage_credit_gold += gold;
                }
                continue;
            }
            for (pid, dmg) in by_killers {
                let share = dmg as f64 / total as f64;
                if let Some(c) = credit.get_mut(&pid) {
                    c.damage_credit_gold += gold * share;
                }
                *participated.entry(pid).or_insert(0) += 1;
                *share_sum.entry(pid).or_insert(0.0) += share;
            }
        }
    }

    // --- Objetivos y estructuras ---
    //
    // Se reparten a partes iguales entre quien lo remató y quienes asistieron.
    // Es una simplificación consciente: la timeline no dice quién puso el daño
    // a un edificio o a un monstruo (`victimDamageReceived` sólo existe para
    // campeones), así que un reparto por trabajo real no es posible aquí.
    for frame in &tl.info.frames {
        for ev in &frame.events {
            let valor = match ev.event_type.as_str() {
                "TURRET_PLATE_DESTROYED" => peso::PLACA,
                "BUILDING_KILL" => match (
                    ev.buildingType.as_deref(),
                    ev.towerType.as_deref(),
                ) {
                    (Some("INHIBITOR_BUILDING"), _) => peso::INHIBIDOR,
                    (_, Some("OUTER_TURRET")) => peso::TORRE_EXTERIOR,
                    (_, Some("INNER_TURRET")) => peso::TORRE_INTERIOR,
                    (_, Some("BASE_TURRET")) => peso::TORRE_BASE,
                    (_, Some("NEXUS_TURRET")) => peso::TORRE_NEXO,
                    _ => continue,
                },
                "ELITE_MONSTER_KILL" => match ev.monsterType.as_deref() {
                    Some("DRAGON") => peso::DRAGON,
                    Some("BARON_NASHOR") => peso::BARON,
                    Some("RIFTHERALD") => peso::HERALDO,
                    Some("HORDE") => peso::GRUBS,
                    _ => continue,
                },
                _ => continue,
            };

            let mut quienes: Vec<i32> = Vec::new();
            if ev.killerId >= 1 && ev.killerId <= 10 {
                quienes.push(ev.killerId);
            }
            quienes.extend(ev.assistingParticipantIds.iter().copied().filter(|p| (1..=10).contains(p)));
            quienes.sort_unstable();
            quienes.dedup();
            if quienes.is_empty() {
                continue; // Estructuras que caen solas, por esbirros.
            }

            // Reparto entre los presentes, pesado por el daño que cada uno hizo
            // a estructuras en toda la partida.
            //
            // No es tan bueno como el de los asesinatos —la timeline no dice
            // quién pegó a ESTA torre, sólo el total de la partida— pero corrige
            // el sesgo grande: a partes iguales, quien deja una torre al 10% y
            // se va no cobra nada, y quien pasa a rematarla cobra lo mismo que
            // quien la tiró. Es el mismo problema del último golpe.
            //
            // Para monstruos épicos se sigue repartiendo a partes iguales: ahí
            // `damageDealtToObjectives` mezcla jungla neutral con épicos y no
            // discrimina nada útil.
            let estructura = matches!(
                ev.event_type.as_str(),
                "BUILDING_KILL" | "TURRET_PLATE_DESTROYED"
            );
            let pesos: Vec<f64> = quienes
                .iter()
                .map(|pid| {
                    if !estructura {
                        return 1.0;
                    }
                    participants
                        .get((*pid - 1) as usize)
                        .map(|p| p.damageDealtToTurrets as f64)
                        .unwrap_or(0.0)
                })
                .collect();
            let total: f64 = pesos.iter().sum();
            for (pid, peso) in quienes.iter().zip(pesos.iter()) {
                // Si nadie registró daño a torres (o son épicos), a partes iguales.
                let frac = if total > 0.0 {
                    peso / total
                } else {
                    1.0 / quienes.len() as f64
                };
                if let Some(c) = credit.get_mut(pid) {
                    c.objective_gold += valor * frac;
                }
            }
        }
    }

    // Probabilidad de victoria aportada, con el mismo reparto por daño real.
    let wpa = crate::winprob::per_player(&crate::winprob::plays(tl, participants));
    for (pid, v) in wpa {
        if let Some(c) = credit.get_mut(&pid) {
            c.wpa = v;
        }
    }

    let mut out: Vec<PlayerCredit> = credit.into_values().collect();
    for c in out.iter_mut() {
        c.credit_gap = c.damage_credit_gold - c.killing_blow_gold;
        c.total_value = c.damage_credit_gold + c.objective_gold;
        c.role_percentile = crate::baselines::percentil(&c.role, c.wpa);

        // Tiempo muerto: el total real de Riot, repartido entre las muertes según
        // lo que pesaba el temporizador de cada una.
        let raw = timers.remove(&c.participant_id).unwrap_or_default();
        let raw_total: f64 = raw.iter().map(|(_, t)| t).sum();
        let real_total = participants
            .get((c.participant_id - 1) as usize)
            .map(|p| p.totalTimeSpentDead as f64)
            .unwrap_or(raw_total);
        let scale = if raw_total > 0.0 { real_total / raw_total } else { 0.0 };
        c.time_dead = real_total;
        c.deaths_detail = raw
            .into_iter()
            .map(|(minute, t)| DeathCost {
                minute,
                seconds_dead: t * scale,
            })
            .collect();
        let n = participated.get(&c.participant_id).copied().unwrap_or(0);
        let team_total = team_kills.get(&c.team_id).copied().unwrap_or(0);
        c.damage_participation = if team_total > 0 {
            n as f64 / team_total as f64
        } else {
            0.0
        };
        c.mean_damage_share = if n > 0 {
            share_sum.get(&c.participant_id).copied().unwrap_or(0.0) / n as f64
        } else {
            0.0
        };
    }
    out.sort_by_key(|c| c.participant_id);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_temporizador_de_muerte_crece_con_nivel_y_reloj() {
        // Nivel 1 al principio: el mínimo de la tabla, sin recargo.
        assert!((death_timer(1, 2.0) - 10.0).abs() < 0.01);
        // Mismo nivel más tarde: sube por el factor de tiempo.
        assert!(death_timer(1, 35.0) > 11.0);
        // A igual reloj, más nivel cuesta más.
        assert!(death_timer(18, 20.0) > death_timer(6, 20.0));
        // El recargo está topado al 50%.
        assert!(death_timer(18, 90.0) <= 52.5 * 1.5 + 0.01);
    }

    #[test]
    fn el_factor_de_tiempo_no_aplica_antes_del_minuto_15() {
        assert_eq!(time_increase_factor(0.0), 0.0);
        assert_eq!(time_increase_factor(14.9), 0.0);
        assert!(time_increase_factor(15.5) > 0.0);
    }

    /// Barre un corpus de partidas reales si se le pasa el directorio por
    /// `ATTR_CORPUS_DIR` (parejas `<id>.match.json` / `<id>.timeline.json`).
    /// Sin la variable no hace nada: el test no puede depender de la red ni de
    /// una key.
    #[test]
    fn invariantes_sobre_corpus_real() {
        let Ok(dir) = std::env::var("ATTR_CORPUS_DIR") else {
            return;
        };
        let mut ids: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|e| {
                e.file_name()
                    .to_str()?
                    .strip_suffix(".match.json")
                    .map(str::to_string)
            })
            .collect();
        ids.sort();
        assert!(!ids.is_empty(), "corpus vacío en {dir}");

        let (mut partidas, mut jugadores) = (0usize, 0usize);
        let mut discrepa_top = 0usize;
        let mut gaps: Vec<f64> = Vec::new();
        let mut sin_desglose = 0usize;
        let mut peor_muerte: Option<(String, String, f64, f64)> = None;

        for id in &ids {
            let tl: TimelineDto = serde_json::from_str(
                &std::fs::read_to_string(format!("{dir}/{id}.timeline.json")).unwrap(),
            )
            .unwrap();
            let m: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(format!("{dir}/{id}.match.json")).unwrap(),
            )
            .unwrap();
            let participants: Vec<ParticipantDto> =
                serde_json::from_value(m["info"]["participants"].clone()).unwrap();

            let rows = analyze(&tl, &participants);
            assert_eq!(rows.len(), 10, "{id}: no salieron 10 jugadores");
            partidas += 1;
            jugadores += rows.len();

            // 1. El reparto ni inventa ni pierde oro.
            let by_blow: f64 = rows.iter().map(|c| c.killing_blow_gold).sum();
            let by_damage: f64 = rows.iter().map(|c| c.damage_credit_gold).sum();
            assert!(
                (by_blow - by_damage).abs() < 1.0,
                "{id}: oro descuadrado {by_blow:.0} vs {by_damage:.0}"
            );

            for (c, p) in rows.iter().zip(participants.iter()) {
                // 2. El tiempo muerto total es el de Riot y el desglose lo suma.
                assert_eq!(c.time_dead, p.totalTimeSpentDead as f64, "{id}/{}", c.champion);
                let suma: f64 = c.deaths_detail.iter().map(|d| d.seconds_dead).sum();
                assert!(
                    (suma - c.time_dead).abs() < 0.5,
                    "{id}/{}: desglose {suma:.0}s vs total {:.0}s",
                    c.champion,
                    c.time_dead
                );
                // 3. Hay una entrada de desglose por cada muerte registrada.
                if c.deaths as usize != c.deaths_detail.len() {
                    sin_desglose += 1;
                }
                // 4. Nada de shares fuera de rango.
                assert!(
                    (0.0..=1.0).contains(&c.mean_damage_share),
                    "{id}/{}: share {}",
                    c.champion,
                    c.mean_damage_share
                );
                gaps.push(c.credit_gap);

                for d in &c.deaths_detail {
                    if peor_muerte.as_ref().map_or(true, |p| d.seconds_dead > p.3) {
                        peor_muerte =
                            Some((id.clone(), c.champion.clone(), d.minute, d.seconds_dead));
                    }
                }
            }

            // ¿Cuántas veces el marcador y el trabajo real señalan a otro?
            let top_blow = rows
                .iter()
                .max_by(|a, b| a.killing_blow_gold.total_cmp(&b.killing_blow_gold))
                .unwrap();
            let top_real = rows
                .iter()
                .max_by(|a, b| a.damage_credit_gold.total_cmp(&b.damage_credit_gold))
                .unwrap();
            if top_blow.participant_id != top_real.participant_id {
                discrepa_top += 1;
                println!(
                    "{id}: el marcador corona a {:<11} pero el trabajo lo hizo {:<11} ({:+.0} de oro)",
                    top_blow.champion, top_real.champion, top_real.credit_gap
                );
            }
        }

        // ¿Cuánto de la economía cubre ya el reparto? Antes de incluir objetivos
        // era el 16,7% (sólo asesinatos). El resto es renta pasiva y farmeo, que
        // no es crédito disputado: nadie te lo quita.
        {
            let (mut repartido, mut ganado) = (0.0f64, 0.0f64);
            for id in &ids {
                let tl: TimelineDto = serde_json::from_str(
                    &std::fs::read_to_string(format!("{dir}/{id}.timeline.json")).unwrap(),
                )
                .unwrap();
                let m: serde_json::Value = serde_json::from_str(
                    &std::fs::read_to_string(format!("{dir}/{id}.match.json")).unwrap(),
                )
                .unwrap();
                let ps: Vec<ParticipantDto> =
                    serde_json::from_value(m["info"]["participants"].clone()).unwrap();
                for c in analyze(&tl, &ps) {
                    repartido += c.total_value;
                }
                ganado += ps.iter().map(|p| p.goldEarned as f64).sum::<f64>();
            }
            println!(
                "\ncobertura del reparto: {:.0} de {:.0} de oro generado ({:.1}% de la economía)",
                repartido,
                ganado,
                100.0 * repartido / ganado
            );
        }

        gaps.sort_by(f64::total_cmp);
        let p = |q: f64| gaps[((gaps.len() - 1) as f64 * q) as usize];
        println!(
            "\n{partidas} partidas, {jugadores} jugadores. Invariantes de oro y tiempo muerto: OK."
        );
        println!(
            "gap de crédito (oro): min {:.0} | p25 {:.0} | mediana {:.0} | p75 {:+.0} | max {:+.0}",
            gaps[0],
            p(0.25),
            p(0.50),
            p(0.75),
            gaps[gaps.len() - 1]
        );
        let grandes = gaps.iter().filter(|g| g.abs() >= 1000.0).count();
        println!(
            "jugadores con gap >= 1000 de oro: {grandes} ({:.0}%)",
            100.0 * grandes as f64 / jugadores as f64
        );
        println!(
            "partidas donde el mejor por marcador NO es el mejor por trabajo: {discrepa_top}/{partidas}"
        );
        println!("jugadores cuyo nº de muertes no cuadra con el desglose: {sin_desglose}");
        if let Some((id, champ, min, secs)) = peor_muerte {
            println!("muerte más cara del corpus: {champ} en {id}, minuto {min:.0} -> {secs:.0}s");
        }
    }
}
