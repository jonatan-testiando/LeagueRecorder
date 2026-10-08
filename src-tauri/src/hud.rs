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
    if ruta(match_id).exists() || script(app).is_none() {
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

    if ruta(match_id).exists() {
        return Ok(());
    }
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
        if let Err(e) = procesar(&app, &match_id) {
            log::warn!("hud: {match_id}: {e}");
        }
    });
    Ok(())
}
