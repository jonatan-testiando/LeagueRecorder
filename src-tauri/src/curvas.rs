//! Las curvas por minuto de los diez y la franja de objetivos, para el bloque
//! «Ventaja» de la pestaña Partida.
//!
//! Hasta aquí la ficha sólo enseñaba el oro del equipo (`minute_frames`, que
//! se calcula al sincronizar y se guarda en el metadata). La timeline cruda que
//! se guarda en `riot_timeline.json` trae mucho más: oro, XP y daño, hecho y
//! recibido, de cada uno de los diez en cada fotograma de minuto. Con eso el
//! frontend puede comparar como quiera (contra tu rival, contra la media rival,
//! equipo contra equipo o los diez a la vez) sin pedir nada más.
//!
//! Aquí no se resta nada: se entregan las series en bruto y el frontend hace
//! las cuentas del modo elegido. Así cambiar de modo no cuesta una llamada, y
//! la resta vive en un solo sitio.

use serde::Serialize;

use crate::riot_api::{MatchDto, ParticipantDto, TimelineDto, TimelineEvent};

/// Lo que devuelve `get_minute_series`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Curvas {
    /// "ok", o "no_riot" si falta la timeline o el detalle de la partida.
    pub status: String,
    /// Minuto de PARTIDA de cada fotograma. Van de uno en uno salvo el último,
    /// que es el final de la partida y no cae en minuto entero.
    pub minutes: Vec<f64>,
    /// Los diez, en orden de `participantId` (1..=10).
    pub players: Vec<CurvaJugador>,
    /// Dragones, barones, heraldos, larvas, Atakhan, torres e inhibidores, por
    /// orden de tiempo.
    pub objectives: Vec<Objetivo>,
    /// El jugador grabado. 0 si no se sabe quién era.
    pub self_id: i32,
    /// Su rival de línea, con el mismo criterio que la curva del duelo
    /// (`rival_de_linea`). 0 si no hay jugador grabado.
    pub rival_id: i32,
}

/// Las cuatro series de un jugador, una cifra por fotograma. Todas son
/// acumuladas, como las da Riot: el oro total ganado, no el que lleva encima.
#[derive(Debug, Clone, Default, Serialize)]
pub struct CurvaJugador {
    pub participant_id: i32,
    pub team_id: i32,
    pub champion: String,
    /// "TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY", o vacío.
    pub role: String,
    pub gold: Vec<i64>,
    pub xp: Vec<i64>,
    /// `damageStats.totalDamageDoneToChampions`.
    pub damage_dealt: Vec<i64>,
    /// `damageStats.totalDamageTaken`.
    pub damage_taken: Vec<i64>,
}

/// Un objetivo caído, con quién se lo llevó.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Objetivo {
    /// Segundos de PARTIDA.
    pub time: f64,
    /// "dragon", "elder", "baron", "herald", "grubs", "atakhan", "tower" o
    /// "inhibitor".
    pub kind: String,
    /// El tipo de dragón ("FIRE_DRAGON"…) o de torre ("OUTER_TURRET"…).
    pub detail: Option<String>,
    /// Carril de la torre o el inhibidor ("TOP_LANE"…).
    pub lane: Option<String>,
    /// El equipo que se lo llevó (100 o 200).
    pub team_id: i32,
}

/// Monta las curvas de una partida. `self_id` es el `participantId` del jugador
/// grabado, si se sabe.
pub fn curvas(m: &MatchDto, tl: &TimelineDto, self_id: Option<i32>) -> Curvas {
    let ps = &m.info.participants;
    let frames = &tl.info.frames;

    let minutes: Vec<f64> = frames.iter().map(|f| f.timestamp as f64 / 60_000.0).collect();

    let mut players: Vec<CurvaJugador> = ps
        .iter()
        .enumerate()
        .map(|(i, p)| CurvaJugador {
            participant_id: i as i32 + 1,
            team_id: p.teamId,
            champion: p.championName.clone(),
            role: crate::riot_api::rol_de(p),
            gold: Vec::with_capacity(frames.len()),
            xp: Vec::with_capacity(frames.len()),
            damage_dealt: Vec::with_capacity(frames.len()),
            damage_taken: Vec::with_capacity(frames.len()),
        })
        .collect();

    for frame in frames {
        for pl in players.iter_mut() {
            match frame.participantFrames.get(&pl.participant_id.to_string()) {
                Some(pf) => {
                    pl.gold.push(pf.totalGold as i64);
                    pl.xp.push(pf.xp as i64);
                    pl.damage_dealt.push(pf.damageStats.totalDamageDoneToChampions as i64);
                    pl.damage_taken.push(pf.damageStats.totalDamageTaken as i64);
                }
                // Un fotograma sin ese jugador (no debería pasar, pero la API
                // no lo garantiza): se repite lo último que se sabe. Son series
                // acumuladas, así que un cero sería un desplome que no ocurrió.
                None => {
                    let last = |v: &Vec<i64>| v.last().copied().unwrap_or(0);
                    let (g, x, d, t) = (last(&pl.gold), last(&pl.xp), last(&pl.damage_dealt), last(&pl.damage_taken));
                    pl.gold.push(g);
                    pl.xp.push(x);
                    pl.damage_dealt.push(d);
                    pl.damage_taken.push(t);
                }
            }
        }
    }

    let objectives = frames
        .iter()
        .flat_map(|f| f.events.iter())
        .filter_map(|ev| objetivo(ev, ps))
        .collect();

    let self_id = self_id.filter(|id| (1..=ps.len() as i32).contains(id)).unwrap_or(0);
    let rival_id = if self_id > 0 { crate::riot_api::rival_de_linea(ps, self_id) } else { 0 };

    Curvas { status: "ok".into(), minutes, players, objectives, self_id, rival_id }
}

/// El objetivo de un evento, o nada si el evento no lo es.
fn objetivo(ev: &TimelineEvent, ps: &[ParticipantDto]) -> Option<Objetivo> {
    let team_of = |pid: i32| -> Option<i32> {
        if pid < 1 {
            return None;
        }
        ps.get((pid - 1) as usize).map(|p| p.teamId)
    };
    let valido = |t: i32| t == 100 || t == 200;
    let time = ev.timestamp as f64 / 1000.0;

    match ev.event_type.as_str() {
        "ELITE_MONSTER_KILL" => {
            // `killerTeamId` viene siempre en las timelines actuales; el
            // equipo de quien remató es el respaldo para las viejas.
            let team = Some(ev.killerTeamId).filter(|t| valido(*t)).or_else(|| team_of(ev.killerId))?;
            let (kind, detail) = match ev.monsterType.as_deref()? {
                "DRAGON" if ev.monsterSubType.as_deref() == Some("ELDER_DRAGON") => ("elder", None),
                "DRAGON" => ("dragon", ev.monsterSubType.clone()),
                "BARON_NASHOR" => ("baron", None),
                "RIFTHERALD" => ("herald", None),
                "HORDE" => ("grubs", None),
                "ATAKHAN" => ("atakhan", None),
                _ => return None,
            };
            Some(Objetivo { time, kind: kind.into(), detail, lane: None, team_id: team })
        }
        "BUILDING_KILL" => {
            // En un edificio, `teamId` es el DUEÑO (el que lo pierde), no quien
            // lo tira. Se lo lleva el otro. Si no viene, el equipo de quien
            // remató; si lo remató un súbdito (killerId 0) y tampoco hay dueño,
            // no se puede decir de quién es y se descarta.
            let team = if valido(ev.teamId) { Some(300 - ev.teamId) } else { team_of(ev.killerId) }?;
            let inhib = ev.buildingType.as_deref() == Some("INHIBITOR_BUILDING");
            Some(Objetivo {
                time,
                kind: if inhib { "inhibitor" } else { "tower" }.into(),
                detail: if inhib { None } else { ev.towerType.clone() },
                lane: ev.laneType.clone(),
                team_id: team,
            })
        }
        _ => None,
    }
}

/// El jugador grabado: el `is_self` del marcador guardado, que va en el mismo
/// orden que los participantes del DTO. Sin marcador, por el campeón.
fn jugador_grabado(meta: &crate::storage::MatchMetadata, m: &MatchDto) -> Option<i32> {
    meta.participants
        .iter()
        .position(|p| p.is_self)
        .or_else(|| m.info.participants.iter().position(|p| p.championName == meta.champion))
        .map(|i| i as i32 + 1)
}

fn de_partida(match_id: &str) -> Curvas {
    let no_riot = || Curvas { status: "no_riot".into(), ..Default::default() };
    let (Some(raw), Some(raw_tl)) = (
        crate::storage::load_raw_match(match_id),
        crate::storage::load_raw_timeline(match_id),
    ) else {
        return no_riot();
    };
    let (Ok(m), Ok(tl)) = (serde_json::from_str::<MatchDto>(&raw), serde_json::from_str::<TimelineDto>(&raw_tl)) else {
        return no_riot();
    };
    if tl.info.frames.len() < 2 || m.info.participants.is_empty() {
        return no_riot();
    }
    let self_id = crate::storage::get_match_metadata(match_id)
        .ok()
        .and_then(|meta| jugador_grabado(&meta, &m));
    curvas(&m, &tl, self_id)
}

/// Las curvas por minuto de los diez y los objetivos de una partida.
#[tauri::command]
pub async fn get_minute_series(match_id: String) -> Curvas {
    tokio::task::spawn_blocking(move || de_partida(&match_id))
        .await
        .unwrap_or_else(|_| Curvas { status: "no_riot".into(), ..Default::default() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn partida() -> MatchDto {
        const PUESTOS: [&str; 5] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
        let ps: Vec<_> = (1..=10)
            .map(|i| {
                let puesto = PUESTOS[((i - 1) % 5) as usize];
                json!({
                    "puuid": format!("p{i}"),
                    "kills": 0, "deaths": 0, "assists": 0,
                    "goldEarned": 0, "totalDamageDealtToChampions": 0, "win": i <= 5,
                    "championName": format!("Champ{i}"),
                    "teamId": if i <= 5 { 100 } else { 200 },
                    "teamPosition": puesto,
                })
            })
            .collect();
        serde_json::from_value(json!({ "info": { "gameDuration": 1500, "participants": ps } })).unwrap()
    }

    fn fotograma(ms: i64, base: i32, events: serde_json::Value) -> serde_json::Value {
        let pf: serde_json::Map<String, serde_json::Value> = (1..=10)
            .map(|i| {
                (
                    i.to_string(),
                    json!({
                        "participantId": i,
                        "totalGold": base + i * 10,
                        "xp": base + i,
                        "damageStats": { "totalDamageDoneToChampions": base * 2 + i, "totalDamageTaken": base * 3 + i },
                    }),
                )
            })
            .collect();
        json!({ "timestamp": ms, "events": events, "participantFrames": pf })
    }

    fn timeline() -> TimelineDto {
        serde_json::from_value(json!({ "info": { "frames": [
            fotograma(0, 500, json!([])),
            fotograma(60_000, 800, json!([
                { "type": "ELITE_MONSTER_KILL", "timestamp": 50_000, "killerId": 7, "killerTeamId": 200,
                  "monsterType": "DRAGON", "monsterSubType": "FIRE_DRAGON" },
                { "type": "CHAMPION_KILL", "timestamp": 55_000, "killerId": 1, "victimId": 6 },
            ])),
            fotograma(90_500, 1200, json!([
                // Torre del rojo (dueño 200) tirada por un súbdito: es del azul.
                { "type": "BUILDING_KILL", "timestamp": 70_000, "killerId": 0, "teamId": 200,
                  "buildingType": "TOWER_BUILDING", "towerType": "OUTER_TURRET", "laneType": "MID_LANE" },
                { "type": "BUILDING_KILL", "timestamp": 80_000, "killerId": 3, "teamId": 200,
                  "buildingType": "INHIBITOR_BUILDING", "laneType": "MID_LANE" },
                // Sin killerTeamId (timeline vieja): el equipo de quien remató.
                { "type": "ELITE_MONSTER_KILL", "timestamp": 85_000, "killerId": 2,
                  "monsterType": "DRAGON", "monsterSubType": "ELDER_DRAGON" },
                { "type": "ELITE_MONSTER_KILL", "timestamp": 88_000, "killerId": 2, "killerTeamId": 100,
                  "monsterType": "HORDE" },
                { "type": "TURRET_PLATE_DESTROYED", "timestamp": 89_000, "killerId": 1, "teamId": 200 },
            ])),
        ] } }))
        .unwrap()
    }

    #[test]
    fn las_series_salen_en_bruto_y_en_orden_de_participante() {
        let c = curvas(&partida(), &timeline(), Some(3));
        assert_eq!(c.status, "ok");
        assert_eq!(c.minutes.len(), 3);
        assert!((c.minutes[2] - 90.5 / 60.0).abs() < 1e-9, "el último es el final, no un minuto entero");
        assert_eq!(c.players.len(), 10);
        let p3 = &c.players[2];
        assert_eq!((p3.participant_id, p3.team_id, p3.champion.as_str(), p3.role.as_str()), (3, 100, "Champ3", "MIDDLE"));
        assert_eq!(p3.gold, vec![530, 830, 1230]);
        assert_eq!(p3.xp, vec![503, 803, 1203]);
        assert_eq!(p3.damage_dealt, vec![1003, 1603, 2403]);
        assert_eq!(p3.damage_taken, vec![1503, 2403, 3603]);
        // El rival de línea del mid azul es el mid rojo.
        assert_eq!((c.self_id, c.rival_id), (3, 8));
    }

    #[test]
    fn los_objetivos_van_al_equipo_que_se_los_lleva() {
        let c = curvas(&partida(), &timeline(), None);
        let resumen: Vec<(&str, i32)> = c.objectives.iter().map(|o| (o.kind.as_str(), o.team_id)).collect();
        assert_eq!(
            resumen,
            vec![("dragon", 200), ("tower", 100), ("inhibitor", 100), ("elder", 100), ("grubs", 100)],
            "ni los asesinatos ni las placas son objetivos"
        );
        assert_eq!(c.objectives[0].detail.as_deref(), Some("FIRE_DRAGON"));
        assert_eq!(c.objectives[1].detail.as_deref(), Some("OUTER_TURRET"));
        assert_eq!(c.objectives[1].lane.as_deref(), Some("MID_LANE"));
        assert_eq!(c.objectives[0].time, 50.0);
        // Sin jugador grabado no hay rival que señalar.
        assert_eq!((c.self_id, c.rival_id), (0, 0));
    }

    #[test]
    fn un_fotograma_sin_un_jugador_repite_su_ultimo_valor() {
        let mut tl = timeline();
        tl.info.frames[1].participantFrames.remove("4");
        let c = curvas(&partida(), &tl, Some(4));
        assert_eq!(c.players[3].gold, vec![540, 540, 1240]);
    }

    #[test]
    fn el_rival_de_un_jungla_es_el_jungla_aunque_un_top_haga_campamentos() {
        // Lo de match_20260829_235459: el top rival con 28 campamentos va antes
        // en la lista que el jungla rival.
        let mut m = partida();
        m.info.participants[1].neutralMinionsKilled = 238;
        m.info.participants[5].neutralMinionsKilled = 28;
        m.info.participants[6].neutralMinionsKilled = 256;
        assert_eq!(curvas(&m, &timeline(), Some(2)).rival_id, 7);
        // Sin puestos, el que más campamentos hizo, no el primero que pase de 20.
        for p in m.info.participants.iter_mut() {
            p.teamPosition.clear();
        }
        assert_eq!(curvas(&m, &timeline(), Some(2)).rival_id, 7);
    }

    #[test]
    fn un_jugador_grabado_fuera_de_rango_no_cuenta() {
        let c = curvas(&partida(), &timeline(), Some(11));
        assert_eq!((c.self_id, c.rival_id), (0, 0));
    }

    /// Sobre la biblioteca de verdad de esta máquina. Se activa con `LR_REAL=1`.
    /// Comprueba lo que la gráfica da por hecho: diez jugadores con una cifra
    /// por fotograma, series que no bajan y objetivos de un equipo válido.
    #[test]
    fn sobre_partidas_reales() {
        if std::env::var("LR_REAL").is_err() {
            return;
        }
        let mut vistas = 0;
        for meta in crate::storage::load_all_matches() {
            let c = de_partida(&meta.id);
            if c.status != "ok" {
                continue;
            }
            vistas += 1;
            assert_eq!(c.players.len(), 10, "{}", meta.id);
            for p in &c.players {
                for s in [&p.gold, &p.xp, &p.damage_dealt, &p.damage_taken] {
                    assert_eq!(s.len(), c.minutes.len(), "{}", meta.id);
                    assert!(s.windows(2).all(|w| w[1] >= w[0]), "{}: una serie acumulada baja", meta.id);
                }
            }
            assert!(c.objectives.iter().all(|o| o.team_id == 100 || o.team_id == 200));
            let dragones = c.objectives.iter().filter(|o| o.kind == "dragon").count();
            let torres = c.objectives.iter().filter(|o| o.kind == "tower").count();
            println!(
                "{:<28} {:>3} fotogramas · yo {:>2} rival {:>2} · {:>2} objetivos ({} dragones, {} torres)",
                meta.id,
                c.minutes.len(),
                c.self_id,
                c.rival_id,
                c.objectives.len(),
                dragones,
                torres
            );
        }
        println!("{vistas} partidas con timeline");
    }
}
