//! Lo que te comes: qué hechizos te matan y qué hacía tu mano al comértelos.
//!
//! La Timeline v5 de Riot trae, dentro de cada `CHAMPION_KILL`, el desglose del
//! daño que recibió la víctima **instancia a instancia y con el nombre del
//! hechizo** (`victimDamageReceived[].spellName`). Es la única fuente del juego
//! que dice "te mató la Q de Ahri" en vez de "te mató Ahri", y estaba en el
//! disco sin usarse para nada más que el reparto de crédito de
//! [`crate::attribution`].
//!
//! Encima de eso se cruza la estela: cada muerte tiene su instante exacto en
//! milisegundos, así que se puede mirar qué órdenes de movimiento diste en los
//! segundos anteriores. De ahí sale la pregunta que de verdad importa —**¿te
//! mató el hechizo o te mató estar quieto?**— y sale por hechizo, que es como se
//! entrena.
//!
//! # Los tres límites, dichos antes de que engañen
//!
//! 1. **`victimDamageReceived` sólo existe en los eventos de muerte.** Esto mide
//!    los hechizos que te comes *en las peleas que acaban contigo en el suelo*,
//!    no todos los que te tocan. Es muestra, no censo — el mismo aviso que lleva
//!    [`crate::gank`] con los ganks sin resultado.
//! 2. **Las instancias no traen instante propio.** Todas cuelgan del timestamp
//!    del kill, así que la ventana de mano se ancla a la muerte y no al impacto.
//!    Con 3 s de ventana eso basta para distinguir "venías moviéndote" de
//!    "llevabas dos segundos parado", que es la distinción útil.
//! 3. **`name` es la unidad que pegó, no siempre su dueño** (la Pix de Lulu sale
//!    con el nombre del aliado). El campeón se saca de `participantId`, como
//!    manda la nota de [`crate::riot_api::VictimDamageDto`]; `unit` conserva el
//!    nombre crudo por si el desglose sorprende.

use std::collections::HashMap;

use serde::Serialize;

use crate::riot_api::{ParticipantDto, TimelineDto};

/// Ventana de estela que se mira antes de cada muerte.
///
/// Tres segundos es lo que dura una entrada: da tiempo a ver si venías andando,
/// si giraste, o si llevabas la mano quieta desde antes de que empezara.
const VENTANA_SECS: f64 = 3.0;

/// Sin una orden de movimiento en este último tramo, estabas parado.
///
/// Un campeón sigue andando después del clic, así que "parado" no es "sin clic
/// justo al morir": es no haber dado ninguna orden en el último segundo y medio,
/// que a velocidad de movimiento normal son más de 500 unidades de mapa sin
/// cambiar de idea.
const QUIETO_SECS: f64 = 1.5;

/// Bajo este giro no hubo esquiva: seguiste el mismo rumbo.
///
/// Un cuarto de vuelta es el mínimo para cruzar la línea de un proyectil en vez
/// de correr por delante de ella, que es la regla en la que coinciden todas las
/// guías de esquiva. Medido sobre 93 muertes reales del usuario, el giro máximo
/// en los 3 s previos reparte p10 13°, p50 68° y p90 166°: el corte en 45° deja
/// 35 muertes de 93 a un lado, así que separa de verdad en vez de marcarlo todo.
const GIRO_ESQUIVA: f64 = 45.0;

/// Un hechizo que te comes, agregado.
#[derive(Debug, Clone, Serialize)]
pub struct SpellHit {
    /// Nombre interno del hechizo tal cual lo da Riot (`AhriOrbofDeception`).
    pub spell: String,
    /// 1=Q, 2=W, 3=E, 4=R. 0 en pasivas, objetos e invocador.
    pub slot: i32,
    /// Autoataque. Riot marca así el daño básico, que no es esquivable igual.
    pub basic: bool,
    /// Campeón dueño, sacado de `participantId`.
    pub champion: String,
    /// Unidad que pegó. Distinta del campeón en mascotas e invocaciones.
    pub unit: String,
    /// Instancias de daño.
    pub times: i32,
    /// En cuántas muertes tuyas aparece.
    pub deaths: i32,
    pub damage: i32,
    pub damage_avg: f64,
    /// Fracción del daño de campeón que has recibido en tus muertes, 0..1.
    pub share: f64,
    /// De las muertes en que aparece, en cuántas estabas parado.
    pub still_deaths: i32,
    /// De las muertes en que aparece, en cuántas ibas en línea recta.
    pub straight_deaths: i32,
    /// Mediana de segundos desde tu última orden de movimiento hasta la muerte,
    /// en las muertes donde aparece. `None` sin estela.
    pub last_order_secs_p50: Option<f64>,
}

/// Qué hizo la mano en los segundos previos a una muerte.
#[derive(Debug, Clone, Serialize)]
pub struct HandWindow {
    /// Órdenes de movimiento en los [`VENTANA_SECS`] previos.
    pub orders: usize,
    /// Segundos desde la última orden hasta la muerte.
    pub last_order_secs: f64,
    /// Radio mediano de esas órdenes, en píxeles.
    pub ring_px_p50: f64,
    /// El mayor cambio de rumbo dentro de la ventana, en grados.
    pub max_turn_deg: f64,
    /// Ninguna orden en el último [`QUIETO_SECS`].
    ///
    /// En un jugador que clica sin parar esto es siempre falso y no dice nada;
    /// sale a cero en las 93 muertes medidas. Se conserva porque un jugador de
    /// mano lenta sí lo activará, pero el número que discrimina es `straight`.
    pub still: bool,
    /// El rumbo no llegó a cambiar [`GIRO_ESQUIVA`]: moriste en línea recta.
    pub straight: bool,
}

/// Una muerte, abierta en canal.
#[derive(Debug, Clone, Serialize)]
pub struct DeathAutopsy {
    /// Segundos de partida.
    pub t_game: f64,
    /// Segundos de vídeo, para saltar el reproductor ahí.
    pub t_video: f64,
    /// Quién se llevó el kill.
    pub killer: String,
    /// Daño de campeones en la secuencia que te mató.
    pub damage_champions: i32,
    /// Daño de esbirros, torres y jungla en esa misma secuencia.
    pub damage_other: i32,
    /// Los hechizos que más pusieron, de mayor a menor (máximo tres).
    pub top: Vec<TopSpell>,
    /// `None` en VODs importados y en partidas sin estela.
    pub hand: Option<HandWindow>,
}

/// Una línea del desglose de una muerte.
#[derive(Debug, Clone, Serialize)]
pub struct TopSpell {
    pub spell: String,
    pub slot: i32,
    pub basic: bool,
    pub champion: String,
    pub damage: i32,
}

/// La dieta de hechizos de una partida (o de todo el historial).
#[derive(Debug, Clone, Serialize, Default)]
pub struct SpellReport {
    /// Partidas que han entrado en el agregado. 1 en el informe de una partida.
    pub matches: usize,
    pub deaths: usize,
    /// Muertes en las que llevabas [`QUIETO_SECS`] sin dar una orden.
    pub still_deaths: usize,
    /// Muertes en las que no cambiaste de rumbo. La cifra que de verdad separa.
    pub straight_deaths: usize,
    /// Muertes con estela utilizable. El denominador honesto de `still_deaths`.
    pub deaths_with_hand: usize,
    pub damage_champions: i32,
    pub damage_other: i32,
    /// Daño recibido en la ventana ANCHA de la pelea, no sólo en la secuencia
    /// que remató. Riot la manda aparte y en peleas largas recoge bastante más.
    pub damage_teamfight: i32,
    /// Ordenados por daño, de más a menos.
    pub spells: Vec<SpellHit>,
    pub autopsies: Vec<DeathAutopsy>,
}

/// Acumulador interno de un hechizo mientras se recorren las muertes.
#[derive(Default)]
struct Acc {
    slot: i32,
    basic: bool,
    champion: String,
    unit: String,
    times: i32,
    damage: i32,
    deaths: i32,
    still: i32,
    recto: i32,
    ultimos: Vec<f64>,
}

fn mediana(v: &mut Vec<f64>) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(f64::total_cmp);
    Some(v[v.len() / 2])
}

/// El campeón de un `participantId`. Cadena vacía si el id no es de un jugador.
fn champ(participants: &[ParticipantDto], pid: i32) -> String {
    if pid <= 0 {
        return String::new();
    }
    participants
        .get((pid - 1) as usize)
        .map(|p| p.championName.clone())
        .unwrap_or_default()
}

/// Diferencia angular mínima entre dos rumbos, en [0, 180].
fn giro(a: f64, b: f64) -> f64 {
    let d = (a - b).abs() % 360.0;
    if d > 180.0 {
        360.0 - d
    } else {
        d
    }
}

/// Qué hacía la mano en los segundos previos a `t_video`.
///
/// `ordenes` son los clics derechos ya filtrados por [`crate::hands::ordenes`]:
/// `(t, x, y, radio, rumbo)`, ordenados por tiempo.
fn ventana_de_mano(ordenes: &[(f64, f64, f64, f64, f64)], t_video: f64) -> Option<HandWindow> {
    if ordenes.is_empty() {
        return None;
    }
    // Una muerte fuera del tramo grabado (vídeo cortado, desfase mal estimado)
    // no tiene ventana: devolver una vacía diría "estabas parado" que es peor
    // que no decir nada.
    let (primera, ultima) = (ordenes[0].0, ordenes[ordenes.len() - 1].0);
    if t_video < primera || t_video > ultima + VENTANA_SECS {
        return None;
    }
    let dentro: Vec<&(f64, f64, f64, f64, f64)> = ordenes
        .iter()
        .filter(|o| o.0 <= t_video && o.0 >= t_video - VENTANA_SECS)
        .collect();
    let last = ordenes
        .iter()
        .rev()
        .find(|o| o.0 <= t_video)
        .map(|o| t_video - o.0)
        .unwrap_or(f64::INFINITY);
    let mut radios: Vec<f64> = dentro.iter().map(|o| o.3).collect();
    let mut max_turn = 0.0f64;
    for par in dentro.windows(2) {
        max_turn = max_turn.max(giro(par[0].4, par[1].4));
    }
    Some(HandWindow {
        orders: dentro.len(),
        last_order_secs: last,
        ring_px_p50: mediana(&mut radios).unwrap_or(0.0),
        max_turn_deg: max_turn,
        still: last > QUIETO_SECS,
        straight: max_turn < GIRO_ESQUIVA,
    })
}

/// El informe de una partida.
///
/// `video_offset` lleva del reloj de la partida al del vídeo
/// (`t_vídeo = t_partida + video_offset`), que es el eje de la estela y el del
/// reproductor. `ordenes` puede venir vacío: entonces no hay ventana de mano y
/// el informe se queda en el desglose de hechizos, que ya vale por sí solo.
pub fn analyze(
    tl: &TimelineDto,
    participants: &[ParticipantDto],
    self_pid: i32,
    ordenes: &[(f64, f64, f64, f64, f64)],
    video_offset: f64,
) -> SpellReport {
    let mut r = SpellReport { matches: 1, ..Default::default() };
    let mut acc: HashMap<(i32, String, i32, bool), Acc> = HashMap::new();

    for frame in &tl.info.frames {
        for ev in &frame.events {
            if ev.event_type != "CHAMPION_KILL" || ev.victimId != self_pid {
                continue;
            }
            r.deaths += 1;
            let t_game = ev.timestamp as f64 / 1000.0;
            let t_video = t_game + video_offset;
            let hand = ventana_de_mano(ordenes, t_video);
            if let Some(h) = &hand {
                r.deaths_with_hand += 1;
                if h.still {
                    r.still_deaths += 1;
                }
                if h.straight {
                    r.straight_deaths += 1;
                }
            }

            r.damage_teamfight += ev
                .victimTeamfightDamageReceived
                .iter()
                .filter(|d| d.from_player())
                .map(|d| d.total())
                .sum::<i32>();

            // Desglose de la secuencia que remató.
            let mut de_esta_muerte: HashMap<(i32, String, i32, bool), i32> = HashMap::new();
            for d in &ev.victimDamageReceived {
                let dmg = d.total();
                if dmg <= 0 {
                    continue;
                }
                if !d.from_player() {
                    r.damage_other += dmg;
                    continue;
                }
                r.damage_champions += dmg;
                let clave = (d.participantId, d.spellName.clone(), d.spellSlot, d.basic);
                *de_esta_muerte.entry(clave.clone()).or_insert(0) += dmg;
                let e = acc.entry(clave).or_default();
                if e.champion.is_empty() {
                    e.champion = champ(participants, d.participantId);
                    e.unit = d.name.clone();
                    e.slot = d.spellSlot;
                    e.basic = d.basic;
                }
                e.times += 1;
                e.damage += dmg;
            }
            // `deaths` se cuenta una vez por muerte, no una por instancia: una Q
            // que pega tres veces en el mismo kill sigue siendo una muerte.
            for clave in de_esta_muerte.keys() {
                if let Some(e) = acc.get_mut(clave) {
                    e.deaths += 1;
                    if let Some(h) = &hand {
                        if h.still {
                            e.still += 1;
                        }
                        if h.straight {
                            e.recto += 1;
                        }
                        if h.last_order_secs.is_finite() {
                            e.ultimos.push(h.last_order_secs);
                        }
                    }
                }
            }

            let mut top: Vec<TopSpell> = de_esta_muerte
                .into_iter()
                .map(|((pid, spell, slot, basic), damage)| TopSpell {
                    spell,
                    slot,
                    basic,
                    champion: champ(participants, pid),
                    damage,
                })
                .collect();
            top.sort_by(|a, b| b.damage.cmp(&a.damage));
            let damage_champions = top.iter().map(|t| t.damage).sum();
            top.truncate(3);

            r.autopsies.push(DeathAutopsy {
                t_game,
                t_video,
                killer: champ(participants, ev.killerId),
                damage_champions,
                damage_other: ev
                    .victimDamageReceived
                    .iter()
                    .filter(|d| !d.from_player())
                    .map(|d| d.total())
                    .sum(),
                top,
                hand,
            });
        }
    }

    r.spells = ordenar(acc, r.damage_champions);
    r.autopsies.sort_by(|a, b| a.t_game.total_cmp(&b.t_game));
    r
}

/// Vuelca el acumulador a la lista pública, ordenada por daño.
fn ordenar(acc: HashMap<(i32, String, i32, bool), Acc>, total: i32) -> Vec<SpellHit> {
    let mut v: Vec<SpellHit> = acc
        .into_iter()
        .map(|((_, spell, _, _), mut e)| SpellHit {
            spell,
            slot: e.slot,
            basic: e.basic,
            champion: e.champion,
            unit: e.unit,
            times: e.times,
            deaths: e.deaths,
            damage: e.damage,
            damage_avg: if e.times > 0 { e.damage as f64 / e.times as f64 } else { 0.0 },
            share: if total > 0 { e.damage as f64 / total as f64 } else { 0.0 },
            still_deaths: e.still,
            straight_deaths: e.recto,
            last_order_secs_p50: mediana(&mut e.ultimos),
        })
        .collect();
    v.sort_by(|a, b| b.damage.cmp(&a.damage));
    v
}

/// Funde el informe `otro` dentro de `base`. Para el agregado de varias partidas.
///
/// Las autopsias NO se acumulan: en el agregado no sirven (apuntan al vídeo de
/// su partida) y multiplicarían el tamaño de la respuesta por el historial
/// entero.
fn fundir(base: &mut SpellReport, otro: SpellReport) {
    base.matches += otro.matches;
    base.deaths += otro.deaths;
    base.still_deaths += otro.still_deaths;
    base.straight_deaths += otro.straight_deaths;
    base.deaths_with_hand += otro.deaths_with_hand;
    base.damage_champions += otro.damage_champions;
    base.damage_other += otro.damage_other;
    base.damage_teamfight += otro.damage_teamfight;
    for s in otro.spells {
        match base
            .spells
            .iter_mut()
            .find(|x| x.spell == s.spell && x.champion == s.champion && x.basic == s.basic)
        {
            Some(x) => {
                x.times += s.times;
                x.deaths += s.deaths;
                x.damage += s.damage;
                x.still_deaths += s.still_deaths;
                x.straight_deaths += s.straight_deaths;
                x.damage_avg = if x.times > 0 { x.damage as f64 / x.times as f64 } else { 0.0 };
                // La mediana de medianas no es la mediana, pero aquí se compara
                // "cuánto llevabas parado" entre hechizos, no se publica un
                // estadístico exacto; promediarlas mantiene el orden.
                x.last_order_secs_p50 = match (x.last_order_secs_p50, s.last_order_secs_p50) {
                    (Some(a), Some(b)) => Some((a + b) / 2.0),
                    (a, b) => a.or(b),
                };
            }
            None => base.spells.push(s),
        }
    }
}

/// Recalcula los `share` después de fundir, que si no se quedan con el
/// denominador de su partida.
fn reparto(r: &mut SpellReport) {
    let total = r.damage_champions;
    for s in r.spells.iter_mut() {
        s.share = if total > 0 { s.damage as f64 / total as f64 } else { 0.0 };
    }
    r.spells.sort_by(|a, b| b.damage.cmp(&a.damage));
}

/// Carga lo que hace falta para analizar UNA partida, todo desde el disco.
///
/// Devuelve `None` sin timeline o sin detalle cacheados: este camino no pide
/// nada a la API de Riot a propósito, para que el agregado del historial no se
/// coma la cuota por abrir un panel.
fn desde_cache(m: &crate::storage::MatchMetadata, con_estela: bool) -> Option<SpellReport> {
    let raw_tl = crate::storage::load_raw_timeline(&m.id)?;
    let raw_match = crate::storage::load_raw_match(&m.id)?;
    let tl: TimelineDto = serde_json::from_str(&raw_tl).ok()?;
    let det: crate::riot_api::MatchDto = serde_json::from_str(&raw_match).ok()?;
    let idx = det
        .info
        .participants
        .iter()
        .position(|p| p.championName == m.champion)?;
    let ordenes = if con_estela {
        let escala = crate::storage::load_config().minimap_scale;
        crate::storage::load_match_by_id(&m.id)
            .map(|full| crate::hands::ordenes(&full, escala))
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    Some(analyze(
        &tl,
        &det.info.participants,
        (idx as i32) + 1,
        &ordenes,
        m.video_offset.unwrap_or(0.0),
    ))
}

/// Qué te comiste en esta partida, muerte a muerte.
#[tauri::command]
pub async fn get_spell_autopsy(match_id: String) -> Result<SpellReport, String> {
    let m = crate::storage::get_match_metadata(&match_id)?;
    desde_cache(&m, true).ok_or_else(|| {
        "Esta partida aún no tiene la timeline de Riot descargada. Sincronízala y vuelve."
            .to_string()
    })
}

/// Tu dieta de hechizos en todo el historial ya sincronizado.
///
/// Sólo mira lo que hay en disco, así que no gasta cuota de API y responde
/// aunque no haya clave configurada.
#[tauri::command]
pub async fn get_spell_diet() -> Result<SpellReport, String> {
    let mut total = SpellReport::default();
    for m in crate::storage::load_all_matches() {
        if m.riot_match_id.is_none() {
            continue;
        }
        if let Some(r) = desde_cache(&m, true) {
            fundir(&mut total, r);
        }
    }
    // `fundir` suma `matches` sobre un informe que nació vacío, así que la
    // cuenta ya es la de partidas fundidas y no hay que tocarla.
    reparto(&mut total);
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn timeline(json: serde_json::Value) -> TimelineDto {
        serde_json::from_value(serde_json::json!({
            "info": { "frames": [ { "timestamp": 0, "events": json, "participantFrames": {} } ] }
        }))
        .unwrap()
    }

    /// `ParticipantDto` exige siete campos sin `default` (puuid, KDA, oro, daño,
    /// win); el resto los rellena serde. Aquí sólo importa `championName`.
    fn quien(champ: &str) -> serde_json::Value {
        serde_json::json!({
            "puuid": "", "kills": 0, "deaths": 0, "assists": 0, "goldEarned": 0,
            "totalDamageDealtToChampions": 0, "win": false, "championName": champ
        })
    }

    fn participantes() -> Vec<ParticipantDto> {
        serde_json::from_value(serde_json::json!([quien("Jinx"), quien("Ahri")])).unwrap()
    }

    /// Una muerte del jugador 1 con Q de Ahri y un autoataque.
    fn muerte(ts: i64) -> serde_json::Value {
        serde_json::json!({
            "type": "CHAMPION_KILL",
            "timestamp": ts,
            "killerId": 2,
            "victimId": 1,
            "victimDamageReceived": [
                { "participantId": 2, "name": "Ahri", "type": "OTHER",
                  "spellName": "AhriOrbofDeception", "spellSlot": 1, "basic": false,
                  "magicDamage": 300 },
                { "participantId": 2, "name": "Ahri", "type": "OTHER",
                  "spellName": "AhriBasicAttack", "spellSlot": 0, "basic": true,
                  "physicalDamage": 80 },
                { "participantId": 0, "name": "Minion", "type": "MINION",
                  "spellName": "", "spellSlot": 0, "basic": true,
                  "physicalDamage": 40 }
            ],
            "victimTeamfightDamageReceived": [
                { "participantId": 2, "name": "Ahri", "type": "OTHER",
                  "spellName": "AhriOrbofDeception", "spellSlot": 1, "basic": false,
                  "magicDamage": 500 }
            ]
        })
    }

    #[test]
    fn separa_el_dano_de_campeon_del_de_esbirro() {
        let tl = timeline(serde_json::json!([muerte(60_000)]));
        let r = analyze(&tl, &participantes(), 1, &[], 0.0);
        assert_eq!(r.deaths, 1);
        assert_eq!(r.damage_champions, 380);
        assert_eq!(r.damage_other, 40);
        assert_eq!(r.damage_teamfight, 500);
    }

    #[test]
    fn el_autoataque_va_aparte_del_hechizo() {
        let tl = timeline(serde_json::json!([muerte(60_000)]));
        let r = analyze(&tl, &participantes(), 1, &[], 0.0);
        assert_eq!(r.spells.len(), 2);
        let q = &r.spells[0];
        assert_eq!(q.spell, "AhriOrbofDeception");
        assert_eq!(q.champion, "Ahri");
        assert_eq!(q.damage, 300);
        assert!(!q.basic);
        assert!(r.spells.iter().any(|s| s.basic && s.damage == 80));
    }

    #[test]
    fn las_muertes_ajenas_no_cuentan() {
        // Mismo evento pero la víctima es el 2: no es nuestra dieta.
        let mut ev = muerte(60_000);
        ev["victimId"] = serde_json::json!(2);
        let tl = timeline(serde_json::json!([ev]));
        let r = analyze(&tl, &participantes(), 1, &[], 0.0);
        assert_eq!(r.deaths, 0);
        assert!(r.spells.is_empty());
    }

    #[test]
    fn una_q_que_pega_dos_veces_es_una_sola_muerte() {
        let mut ev = muerte(60_000);
        ev["victimDamageReceived"] = serde_json::json!([
            { "participantId": 2, "name": "Ahri", "spellName": "AhriOrbofDeception",
              "spellSlot": 1, "basic": false, "magicDamage": 150 },
            { "participantId": 2, "name": "Ahri", "spellName": "AhriOrbofDeception",
              "spellSlot": 1, "basic": false, "magicDamage": 150 }
        ]);
        let tl = timeline(serde_json::json!([ev]));
        let r = analyze(&tl, &participantes(), 1, &[], 0.0);
        assert_eq!(r.spells[0].times, 2);
        assert_eq!(r.spells[0].deaths, 1);
        assert_eq!(r.spells[0].damage, 300);
    }

    #[test]
    fn la_mano_quieta_se_detecta() {
        // Muerte en el segundo 60 de partida; la última orden fue en el 57,0.
        let ordenes = vec![(50.0, 100.0, 100.0, 300.0, 0.0), (57.0, 100.0, 100.0, 300.0, 0.0)];
        let tl = timeline(serde_json::json!([muerte(60_000)]));
        let r = analyze(&tl, &participantes(), 1, &ordenes, 0.0);
        let h = r.autopsies[0].hand.as_ref().unwrap();
        assert!(h.still, "3 s sin orden tenía que contar como parado");
        assert_eq!(h.orders, 1);
        assert_eq!(r.still_deaths, 1);
        assert_eq!(r.spells[0].still_deaths, 1);
    }

    #[test]
    fn la_mano_en_movimiento_no_se_marca() {
        let ordenes = vec![
            (58.0, 100.0, 100.0, 300.0, 0.0),
            (59.0, 100.0, 100.0, 300.0, 90.0),
            (59.6, 100.0, 100.0, 300.0, 180.0),
        ];
        let tl = timeline(serde_json::json!([muerte(60_000)]));
        let r = analyze(&tl, &participantes(), 1, &ordenes, 0.0);
        let h = r.autopsies[0].hand.as_ref().unwrap();
        assert!(!h.still);
        assert_eq!(h.orders, 3);
        assert!((h.max_turn_deg - 90.0).abs() < 1e-6);
        assert_eq!(r.still_deaths, 0);
    }

    #[test]
    fn morir_sin_cambiar_de_rumbo_es_linea_recta() {
        // Tres ordenes seguidas casi en el mismo rumbo: nunca hubo esquiva.
        let ordenes = vec![
            (58.0, 100.0, 100.0, 300.0, 10.0),
            (59.0, 100.0, 100.0, 300.0, 20.0),
            (59.6, 100.0, 100.0, 300.0, 35.0),
        ];
        let tl = timeline(serde_json::json!([muerte(60_000)]));
        let r = analyze(&tl, &participantes(), 1, &ordenes, 0.0);
        let h = r.autopsies[0].hand.as_ref().unwrap();
        assert!(h.straight, "25 grados de giro maximo no es una esquiva");
        assert!(!h.still, "clicaba, solo que siempre hacia el mismo sitio");
        assert_eq!(r.straight_deaths, 1);
        assert_eq!(r.still_deaths, 0);
        assert_eq!(r.spells[0].straight_deaths, 1);
    }

    #[test]
    fn un_cuarto_de_vuelta_ya_no_es_linea_recta() {
        let ordenes = vec![
            (58.0, 100.0, 100.0, 300.0, 0.0),
            (59.5, 100.0, 100.0, 300.0, 50.0),
        ];
        let tl = timeline(serde_json::json!([muerte(60_000)]));
        let r = analyze(&tl, &participantes(), 1, &ordenes, 0.0);
        assert!(!r.autopsies[0].hand.as_ref().unwrap().straight);
        assert_eq!(r.straight_deaths, 0);
    }

    #[test]
    fn una_muerte_fuera_del_video_no_inventa_ventana() {
        // La estela acaba en el segundo 10 y la muerte es en el 60.
        let ordenes = vec![(5.0, 100.0, 100.0, 300.0, 0.0), (10.0, 100.0, 100.0, 300.0, 0.0)];
        let tl = timeline(serde_json::json!([muerte(60_000)]));
        let r = analyze(&tl, &participantes(), 1, &ordenes, 0.0);
        assert!(r.autopsies[0].hand.is_none());
        assert_eq!(r.deaths_with_hand, 0);
    }

    #[test]
    fn el_desfase_lleva_la_muerte_al_eje_del_video() {
        let tl = timeline(serde_json::json!([muerte(60_000)]));
        let r = analyze(&tl, &participantes(), 1, &[], -12.0);
        assert!((r.autopsies[0].t_game - 60.0).abs() < 1e-6);
        assert!((r.autopsies[0].t_video - 48.0).abs() < 1e-6);
    }

    #[test]
    fn fundir_suma_y_recalcula_el_reparto() {
        let tl = timeline(serde_json::json!([muerte(60_000)]));
        let a = analyze(&tl, &participantes(), 1, &[], 0.0);
        let b = analyze(&tl, &participantes(), 1, &[], 0.0);
        let mut total = SpellReport::default();
        fundir(&mut total, a);
        fundir(&mut total, b);
        reparto(&mut total);
        assert_eq!(total.matches, 2);
        assert_eq!(total.deaths, 2);
        assert_eq!(total.damage_champions, 760);
        assert_eq!(total.spells[0].damage, 600);
        assert!((total.spells[0].share - 600.0 / 760.0).abs() < 1e-9);
    }

    /// Sobre la biblioteca de verdad de esta máquina. Se activa con `LR_REAL=1`.
    #[test]
    fn sobre_partidas_reales() {
        if std::env::var("LR_REAL").is_err() {
            return;
        }
        let mut total = SpellReport::default();
        let mut manos: Vec<HandWindow> = Vec::new();
        for m in crate::storage::load_all_matches() {
            if m.riot_match_id.is_none() {
                continue;
            }
            let Some(r) = desde_cache(&m, true) else {
                println!("{:<28} sin timeline cacheada", m.id);
                continue;
            };
            println!(
                "{:<28} {:>2} muertes ({} con estela, {} en recta) | dano campeon {:>6} | top: {}",
                m.id,
                r.deaths,
                r.deaths_with_hand,
                r.straight_deaths,
                r.damage_champions,
                r.spells
                    .iter()
                    .take(3)
                    .map(|s| format!("{} {} {}", s.champion, etiqueta(s), s.damage))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            manos.extend(r.autopsies.iter().filter_map(|a| a.hand.clone()));
            fundir(&mut total, r);
        }
        reparto(&mut total);
        let mut giros: Vec<f64> = manos.iter().map(|h| h.max_turn_deg).collect();
        let mut ults: Vec<f64> = manos.iter().map(|h| h.last_order_secs).collect();
        let mut ords: Vec<f64> = manos.iter().map(|h| h.orders as f64).collect();
        giros.sort_by(f64::total_cmp);
        ults.sort_by(f64::total_cmp);
        ords.sort_by(f64::total_cmp);
        let q = |v: &Vec<f64>, p: f64| v[((v.len() - 1) as f64 * p) as usize];
        println!(
            "
ventana de mano en {} muertes: giro max p10 {:.0} p50 {:.0} p90 {:.0} | ultima orden p50 {:.2}s p90 {:.2}s | ordenes p10 {:.0} p50 {:.0} p90 {:.0}",
            manos.len(), q(&giros,0.1), q(&giros,0.5), q(&giros,0.9),
            q(&ults,0.5), q(&ults,0.9), q(&ords,0.1), q(&ords,0.5), q(&ords,0.9));
        println!("giro maximo < 45 grados en {} de {} muertes",
                 giros.iter().filter(|g| **g < 45.0).count(), giros.len());
        println!(
            "
=== AGREGADO: {} partidas, {} muertes | {} en linea recta, {} parado (de {} con estela) ===",
            total.matches, total.deaths, total.straight_deaths, total.still_deaths, total.deaths_with_hand);
        for s in total.spells.iter().take(30) {
            println!(
                "  {:<12} {:<3} {:<24} {:>6} dmg ({:>4.1}%) | {:>2} muertes, {:>2} en recta | ultima orden {}",
                s.champion,
                etiqueta(s),
                s.spell,
                s.damage,
                s.share * 100.0,
                s.deaths,
                s.straight_deaths,
                s.last_order_secs_p50.map(|v| format!("{v:.1}s")).unwrap_or_else(|| "-".into()),
            );
        }
    }

    /// Q/W/E/R o AA, para imprimir.
    ///
    /// `spellSlot` es 0-INDEXADO. Medido contra 23 partidas reales: `garenq`
    /// llega con slot 0, `vaynesilveredbolts` (W) con 1, `garene` con 2 y
    /// `garenr` y `feast` (la R de Cho'Gath) con 3. Las pasivas, objetos y runas
    /// usan 63, 64, 46 o -1, que caen fuera y salen como raya.
    pub(super) fn etiqueta(s: &SpellHit) -> &'static str {
        if s.basic {
            return "AA";
        }
        match s.slot {
            0..=3 => ["Q", "W", "E", "R"][s.slot as usize],
            _ => "-",
        }
    }

}
