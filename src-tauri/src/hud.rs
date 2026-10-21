//! Lectura del HUD de una partida grabada: tu vida y los efectos que te ponen.
//!
//! La hace `python_scripts/hud_vida.py` sobre el vídeo (ver su docstring para
//! qué mide y con qué error) y deja `hud_vida.json` en la carpeta de la
//! partida. Lo usa [`crate::golpes`] para sacar cada golpe que te comes.
//!
//! Va en el mismo lote que el minimapa ([`crate::minimap::lanzar_lote`]): son
//! dos pasadas sobre el mismo vídeo y las dos esperan a lo mismo (vídeo y datos
//! de Riot). Una partida de 27 min en AV1 1440p tarda ~4 min; en H.264 1080p,
//! ~1-2 min.
//!
//! Los iconos de los rivales salen de CommunityDragon (`hud/icons2d`, los que
//! usa el propio juego para la fila de efectos) y se guardan junto a la caché
//! de Data Dragon. Sin red se lee igual la vida; sólo se pierde el "quién".

use std::path::{Path, PathBuf};

pub const FICHERO: &str = "hud_vida.json";

const CDRAGON: &str = "https://raw.communitydragon.org/latest/game/assets/characters";

pub fn ruta(match_id: &str) -> PathBuf {
    crate::storage::get_match_dir(match_id).join(FICHERO)
}

/// Por debajo de esta fracción de fotogramas con barra verde, el HUD no estaba
/// donde se le buscó (otra escala de HUD en el juego): la vida no se puede
/// leer y un 0 no quiere decir nada. Muerto también da 0, pero nadie pasa más
/// de media partida muerto. Ver la cabecera de `hud_vida.py`.
pub const LEGIBLE: f64 = 0.5;

/// Cuánto más grande que en la máquina de desarrollo es el HUD de abajo (la
/// barra de vida y la fila de efectos) con `HUD.GlobalScale` = `global_scale`.
///
/// `hud_vida.py` se midió con GlobalScale = 0, el mínimo del deslizador, que
/// es el de esta máquina: con cualquier otro la barra no está donde se la
/// busca y el HUD sale ilegible. El modelo es el de iTero Coach para su
/// overlay de la barra de habilidades (`docs/analisis-itero-coach-2026-10.md`
/// §4): cada medida es `base + pendiente·GlobalScale`, con la pendiente la
/// mitad de la base, anclado abajo en el centro. GlobalScale va de 0 a 1;
/// fuera de ahí sólo sale de editar el fichero a mano y se acota.
///
/// Medido agrandando ×1,5 el HUD de dos clips reales (1080p y 1440p) desde
/// ese ancla: leído a escala 1, la barra sale en el 0-1 % de las lecturas;
/// con 1,5, en el 100 % y con la misma vida que el clip original (±20
/// milésimas en el 99 %). Que el juego lo agrande así NO está comprobado con
/// una grabación: no hay ninguna con otro GlobalScale.
pub fn escala_hud(global_scale: f64) -> f64 {
    let g = if global_scale.is_finite() { global_scale.clamp(0.0, 1.0) } else { 0.0 };
    1.0 + g / 2.0
}

/// La escala del HUD de una partida. Sin ajustes guardados (partidas de antes
/// de leerlos), la de siempre.
pub fn escala_de(meta: &crate::storage::MatchMetadata) -> f64 {
    meta.hud_settings.as_ref().and_then(|h| h.global_scale).map(escala_hud).unwrap_or(1.0)
}

/// La escala con la que se leyó un `hud_vida.json`, de su cabecera. Sin
/// `hud_scale` es de antes de esto, leído a escala 1.
fn escala_leida(cabecera: &str) -> Option<f64> {
    let Some(i) = cabecera.find("\"hud_scale\":") else { return Some(1.0) };
    let resto = &cabecera[i + "\"hud_scale\":".len()..];
    let fin = resto.find([',', '}']).unwrap_or(resto.len());
    resto[..fin].trim().parse().ok()
}

/// ¿Está leído, y con la escala de HUD de la partida? Uno leído con otra miró
/// la barra en otro sitio: lo normal es que saliera ilegible.
pub fn al_dia(match_id: &str) -> bool {
    let Some(cab) = crate::minimap::cabecera(&ruta(match_id)) else { return false };
    let Some(meta) = crate::storage::metadata_ligera(match_id) else { return true };
    escala_leida(&cab).is_some_and(|e| (e - escala_de(&meta)).abs() < 1e-9)
}

#[derive(serde::Deserialize)]
struct Vida {
    fps: f64,
    hud_ok: f64,
    hp: Vec<i32>,
}

/// La serie de vida de un `hud_vida.json`: `(fps, hp)`, con `hp[i]` en
/// milésimas de la barra en el segundo de VÍDEO `i / fps`. `None` si el
/// fichero no se entiende o el HUD no es legible (`LEGIBLE`).
pub fn vida(raw: &str) -> Option<(f64, Vec<i32>)> {
    let v: Vida = serde_json::from_str(raw).ok()?;
    (v.hud_ok >= LEGIBLE && v.fps > 0.0).then_some((v.fps, v.hp))
}

/// Procesos de lectura en marcha, por partida, con su PID para poder pararlos.
fn en_curso() -> &'static std::sync::Mutex<std::collections::HashMap<String, (u32, bool)>> {
    static M: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, (u32, bool)>>> =
        std::sync::OnceLock::new();
    M.get_or_init(Default::default)
}

pub fn leyendo(match_id: &str) -> bool {
    en_curso().lock().map(|m| m.contains_key(match_id)).unwrap_or(false)
}

fn script(app: &tauri::AppHandle) -> Option<PathBuf> {
    let s = crate::cv_analyzer::resolve_resource(app, "python_scripts/hud_vida.py")
        .unwrap_or_else(|| Path::new("python_scripts/hud_vida.py").to_path_buf());
    s.exists().then_some(s)
}

/// ¿Se puede leer el HUD de esta partida y aún no se ha hecho?
pub fn falta(app: &tauri::AppHandle, match_id: &str) -> bool {
    if al_dia(match_id) || script(app).is_none() {
        return false;
    }
    let Ok(meta) = crate::storage::get_match_metadata(match_id) else { return false };
    !meta.is_vod
        && meta.video_offset.is_some()
        && Path::new(&meta.video_path).exists()
        && crate::storage::get_raw_match_path(match_id).exists()
        && crate::storage::get_timeline_path(match_id).exists()
}

/// Partidas propias y sincronizadas sin el HUD leído, de la más nueva a la más vieja.
pub fn pendientes(app: &tauri::AppHandle) -> Vec<String> {
    if script(app).is_none() {
        return Vec::new();
    }
    let mut ms: Vec<crate::storage::MatchMetadata> = crate::storage::load_all_matches()
        .into_iter()
        .filter(|m| !m.is_vod && m.riot_match_id.is_some())
        .collect();
    ms.sort_by(|a, b| b.date.cmp(&a.date));
    ms.into_iter().filter(|m| falta(app, &m.id)).map(|m| m.id).collect()
}

/// Los rivales de la partida, en minúsculas (el nombre de carpeta de CommunityDragon).
fn rivales(match_id: &str) -> Vec<String> {
    let Ok(meta) = crate::storage::get_match_metadata(match_id) else { return Vec::new() };
    let Some(raw) = crate::storage::load_raw_match(match_id) else { return Vec::new() };
    let Ok(m) = serde_json::from_str::<crate::riot_api::MatchDto>(&raw) else { return Vec::new() };
    let Some(yo) = m.info.participants.iter().find(|p| p.championName == meta.champion) else {
        return Vec::new();
    };
    m.info
        .participants
        .iter()
        .filter(|p| p.teamId != yo.teamId)
        .map(|p| p.championName.to_lowercase())
        .collect()
}

pub fn dir_iconos() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| "C:".to_string());
    Path::new(&appdata).join("LeagueRecorder").join("cdragon_icons2d")
}

/// Baja (una vez) los iconos de efecto de un campeón. Devuelve si hay alguno.
///
/// El listado de la carpeta es el HTML que sirve CommunityDragon: se sacan los
/// `href="*.png"`. Un campeón sin iconos o sin red no es un error: la lectura
/// de la vida sigue y ese campeón no se podrá nombrar.
async fn bajar_iconos(champ: &str) -> bool {
    // Sólo letras: es una ruta en disco y un trozo de URL.
    if champ.is_empty() || !champ.chars().all(|c| c.is_ascii_alphanumeric()) {
        return false;
    }
    let dir = dir_iconos().join(champ);
    if std::fs::read_dir(&dir).map(|mut d| d.next().is_some()).unwrap_or(false) {
        return true;
    }
    let Ok(cliente) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
    else {
        return false;
    };
    let base = format!("{CDRAGON}/{champ}/hud/icons2d/");
    let Ok(listado) = async { cliente.get(&base).send().await?.text().await }.await else {
        return false;
    };
    let nombres: Vec<String> = listado
        .split("href=\"")
        .skip(1)
        .filter_map(|s| s.split('"').next())
        .filter(|n| {
            n.ends_with(".png")
                && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
        })
        .map(str::to_string)
        .take(60)
        .collect();
    if nombres.is_empty() {
        return false;
    }
    // A una carpeta aparte y luego se renombra: una descarga cortada no deja
    // media carpeta que la próxima vez parezca completa.
    let tmp = dir_iconos().join(format!("{champ}.tmp"));
    let _ = std::fs::remove_dir_all(&tmp);
    if std::fs::create_dir_all(&tmp).is_err() {
        return false;
    }
    let mut alguno = false;
    for n in &nombres {
        let Ok(resp) = cliente.get(format!("{base}{n}")).send().await else { continue };
        if !resp.status().is_success() {
            continue;
        }
        if let Ok(b) = resp.bytes().await {
            alguno |= std::fs::write(tmp.join(n), &b).is_ok();
        }
    }
    if !alguno {
        let _ = std::fs::remove_dir_all(&tmp);
        return false;
    }
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::rename(&tmp, &dir).is_ok()
}

/// Lee el HUD de una partida. Bloquea hasta que termina: el lote la llama
/// desde su hilo, y `procesar_en_hilo` desde uno propio.
pub fn procesar(app: &tauri::AppHandle, match_id: &str) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use tauri::Emitter;

    if al_dia(match_id) {
        return Ok(());
    }
    // Uno leído con otra escala se sustituye; las barras salieron de sus
    // peleas (ver `crate::barras::falta`) y se vuelven a leer detrás.
    let rehacer = ruta(match_id).exists();
    let script = script(app).ok_or("Esta instalación no trae el lector del HUD.")?;
    let meta = crate::storage::get_match_metadata(match_id).map_err(|_| "No se encuentra la partida.")?;
    if !Path::new(&meta.video_path).exists() {
        return Err("El vídeo de esta partida ya no está.".into());
    }
    {
        let mut c = en_curso().lock().map_err(|_| "estado interno corrupto")?;
        if c.contains_key(match_id) {
            return Ok(());
        }
        c.insert(match_id.to_string(), (0, false));
    }
    let soltar = || en_curso().lock().ok().and_then(|mut c| c.remove(match_id));

    let rivales = rivales(match_id);
    let con_iconos: Vec<String> = tauri::async_runtime::block_on(async {
        let mut v = Vec::new();
        for r in &rivales {
            if bajar_iconos(r).await {
                v.push(r.clone());
            }
        }
        v
    });

    let ffmpeg = crate::proc::ffmpeg(app);
    let (w, h, dur) =
        crate::proc::video_info(&ffmpeg, &meta.video_path).unwrap_or((1920.0, 1080.0, None));
    let duracion = dur.unwrap_or(meta.game_duration as f64 + meta.video_offset.unwrap_or(0.0));
    let py = crate::cv_analyzer::python_command(app);

    let mut cmd = std::process::Command::new(&py);
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
        .arg(format!("{duracion:.2}"))
        .arg("--escala-hud")
        .arg(escala_de(&meta).to_string())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if !con_iconos.is_empty() {
        cmd.arg("--iconos").arg(dir_iconos()).arg("--rivales").arg(con_iconos.join(","));
    }
    crate::proc::hide_console(&mut cmd);

    log::info!("hud: leyendo el vídeo de {match_id}");
    let mut hijo = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            soltar();
            return Err(format!("No se pudo lanzar el lector del HUD: {e}"));
        }
    };
    if let Ok(mut c) = en_curso().lock() {
        if let Some(t) = c.get_mut(match_id) {
            t.0 = hijo.id();
        }
    }
    if let Some(err) = hijo.stderr.take() {
        let app = app.clone();
        let id = match_id.to_string();
        std::thread::spawn(move || {
            for linea in BufReader::new(err).lines().map_while(Result::ok) {
                match linea.strip_prefix("PROGRESS:").and_then(|v| v.trim().parse::<f64>().ok()) {
                    Some(pct) => {
                        let _ = app.emit("hud_progress", (id.clone(), pct));
                    }
                    None if !linea.trim().is_empty() => log::info!("hud[{id}]: {linea}"),
                    None => {}
                }
            }
        });
    }
    let salida = hijo.wait_with_output();
    let cancelado = soltar().map(|t| t.1).unwrap_or(false);
    let ok = matches!(&salida, Ok(o) if o.status.success()) && ruta(match_id).exists();
    let _ = app.emit("hud_progress", (match_id.to_string(), if ok { 100.0 } else { -1.0 }));
    if cancelado {
        return Err("Parada.".into());
    }
    if ok {
        log::info!("hud: {match_id} leída");
        if rehacer {
            let _ = std::fs::remove_file(crate::barras::ruta(match_id));
        }
        Ok(())
    } else {
        let detalle = salida
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).lines().last().unwrap_or("").to_string())
            .unwrap_or_default();
        log::warn!("hud: falló {match_id}: {detalle}");
        Err("No se pudo leer el HUD del vídeo.".into())
    }
}

/// Para la lectura de una partida, si la hay.
pub fn cancelar(match_id: &str) {
    let pid = en_curso().lock().ok().and_then(|mut m| {
        let t = m.get_mut(match_id)?;
        t.1 = true;
        Some(t.0)
    });
    if let Some(pid) = pid.filter(|p| *p != 0) {
        let _ = crate::proc::hide_console(std::process::Command::new("taskkill").args([
            "/F",
            "/T",
            "/PID",
            &pid.to_string(),
        ]))
        .output();
    }
}

pub fn cancelar_todo() {
    let ids: Vec<String> = en_curso().lock().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    for id in ids {
        cancelar(&id);
    }
}

/// Lee el HUD de una sola partida desde el reproductor, sin bloquear.
#[tauri::command]
pub async fn read_match_hud(app: tauri::AppHandle, match_id: String) -> Result<(), String> {
    if !falta(&app, &match_id) && !ruta(&match_id).exists() {
        return Err("Esta partida no tiene con qué: falta el vídeo o los datos de Riot.".into());
    }
    std::thread::spawn(move || {
        use tauri::Emitter;
        if let Err(e) = procesar(&app, &match_id) {
            log::warn!("hud: {match_id}: {e}");
            return;
        }
        // Con las peleas ya sabidas, las barras sobre los campeones en ellas
        // (la línea de fuego). Al acabar se avisa otra vez para que la
        // sección se refresque con ella.
        if crate::barras::falta(&app, &match_id) {
            match crate::barras::procesar(&app, &match_id) {
                Ok(()) => {
                    let _ = app.emit("hud_progress", (match_id.clone(), 100.0));
                }
                Err(e) => log::warn!("barras: {match_id}: {e}"),
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// GlobalScale 0 (el de esta máquina) deja la geometría tal cual; el
    /// máximo la hace un 50 % más grande, como en iTero.
    #[test]
    fn la_escala_del_hud_sale_de_global_scale() {
        assert_eq!(escala_hud(0.0), 1.0);
        assert_eq!(escala_hud(0.5), 1.25);
        assert_eq!(escala_hud(1.0), 1.5);
        assert_eq!(escala_hud(7.0), 1.5);
        assert_eq!(escala_hud(-1.0), 1.0);
        assert_eq!(escala_hud(f64::NAN), 1.0);
    }

    /// Los ficheros de antes no traen la escala: se leyeron a 1.
    #[test]
    fn la_escala_leida_sale_de_la_cabecera() {
        assert_eq!(escala_leida(r#"{"v":1,"fps":8.0,"width":2560,"height":1440,"hud_ok":0.93,"hp":[1"#), Some(1.0));
        assert_eq!(escala_leida(r#"{"v":1,"fps":8.0,"width":2560,"height":1440,"hud_scale":1.25,"hud_ok":0.9"#), Some(1.25));
        assert_eq!(escala_leida(r#"{"hud_scale":1.5}"#), Some(1.5));
        assert_eq!(escala_leida(r#"{"hud_scale":"x","hud_ok":0.9"#), None);
    }
}
