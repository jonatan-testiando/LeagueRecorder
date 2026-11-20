//! Banco de medidas de la fase 0: llama a los comandos REALES contra una
//! biblioteca (normalmente una sintética de `tools/medir/biblioteca_sintetica.py`)
//! y saca una tabla de tiempos, recorridos de biblioteca, aperturas con estela y
//! megas leídos y escritos.
//!
//! No toca la configuración del usuario: apunta `APPDATA` a una carpeta propia
//! con una copia de `config.json` cuyo `save_directory` es la biblioteca a medir
//! y sin clave de Riot (nada sale a la red).
//!
//!     set MEDIR_BIBLIOTECA=D:\medir\bib300
//!     cargo test --release --lib medida_banco -- --ignored --nocapture
//!
//! Cada paso se ejecuta dos veces: la primera puede calcular y escribir cachés
//! (lo que pasa tras sincronizar una partida o invalidar la caché); la segunda
//! es el estado estable. Los contadores son los de la primera.
//!
//! Lo que NO cubre: los dos barridos del arranque (`camera_input::backfill` e
//! `impact_backfill`) piden un `AppHandle` real; con la biblioteca ya sellada se
//! reducen a un `load_all_matches` cada uno, que sí está medido. Tampoco el
//! frontend ni el IPC (salvo el tamaño del JSON que cruzaría).

use crate::medida::{self, APERTURAS_CON_ESTELA, BYTES_CRUDOS, BYTES_ESCRITOS, BYTES_RECORRIDOS, ESCRITURAS_METADATA, RECORRIDOS};
use std::sync::atomic::Ordering::Relaxed;
use std::time::Instant;

struct Fila {
    paso: String,
    ms1: f64,
    ms2: f64,
    recorridos: u64,
    aperturas: u64,
    mb_leidos: f64,
    mb_crudos: f64,
    escrituras: u64,
    mb_escritos: f64,
    nota: String,
}

fn contadores() -> [u64; 6] {
    [
        RECORRIDOS.load(Relaxed),
        APERTURAS_CON_ESTELA.load(Relaxed),
        BYTES_RECORRIDOS.load(Relaxed),
        ESCRITURAS_METADATA.load(Relaxed),
        BYTES_ESCRITOS.load(Relaxed),
        BYTES_CRUDOS.load(Relaxed),
    ]
}

/// Ejecuta `f` dos veces y devuelve la fila. `f` devuelve una nota (tamaño de
/// la respuesta, número de elementos…).
fn paso<F, Fut>(rt: &tokio::runtime::Runtime, nombre: &str, f: F) -> Fila
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = String>,
{
    let a = contadores();
    let t = Instant::now();
    let nota = rt.block_on(f());
    let ms1 = t.elapsed().as_secs_f64() * 1000.0;
    let b = contadores();
    let t = Instant::now();
    let _ = rt.block_on(f());
    let ms2 = t.elapsed().as_secs_f64() * 1000.0;
    let mb = |x: u64| x as f64 / 1048576.0;
    Fila {
        paso: nombre.to_string(),
        ms1,
        ms2,
        recorridos: b[0] - a[0],
        aperturas: b[1] - a[1],
        mb_leidos: mb(b[2] - a[2]),
        mb_crudos: mb(b[5] - a[5]),
        escrituras: b[3] - a[3],
        mb_escritos: mb(b[4] - a[4]),
        nota,
    }
}

/// Tamaño del JSON que cruzaría el IPC hacia el WebView.
fn ipc<T: serde::Serialize>(v: &T) -> String {
    let n = serde_json::to_vec(v).map(|v| v.len()).unwrap_or(0);
    format!("ipc={:.2} MB", n as f64 / 1048576.0)
}

#[test]
#[ignore]
fn medida_banco() {
    let Ok(biblioteca) = std::env::var("MEDIR_BIBLIOTECA") else {
        eprintln!("MEDIR_BIBLIOTECA no está definida: nada que medir");
        return;
    };

    // APPDATA propio con la config del usuario apuntando a la biblioteca a medir.
    let appdata = std::env::temp_dir().join(format!("wardline-medir-appdata-{}", std::process::id()));
    let dir_cfg = appdata.join("LeagueRecorder");
    std::fs::create_dir_all(&dir_cfg).unwrap();
    let real = std::env::var("APPDATA").map(std::path::PathBuf::from).unwrap_or_default();
    let mut cfg: serde_json::Value = std::fs::read_to_string(real.join("LeagueRecorder").join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    cfg["save_directory"] = serde_json::json!(biblioteca);
    cfg["riot_api_key"] = serde_json::json!("");
    cfg["backup_mirror_dir"] = serde_json::json!("");
    std::fs::write(dir_cfg.join("config.json"), serde_json::to_vec_pretty(&cfg).unwrap()).unwrap();
    // El plan de 10 partidas lee sus sesiones de APPDATA: copia de las del usuario.
    let sesiones = real.join("LeagueRecorder").join("coach").join("sessions.json");
    if sesiones.exists() {
        std::fs::create_dir_all(dir_cfg.join("coach")).unwrap();
        let _ = std::fs::copy(&sesiones, dir_cfg.join("coach").join("sessions.json"));
    }
    std::env::set_var("APPDATA", &appdata);
    std::env::set_var("WARDLINE_MEDIR", appdata.join("medidas.log"));
    assert!(medida::activa());

    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let mut filas = Vec::new();

    // ── Migración de la estela a estela.bin (solo trabaja la primera vez) ─────
    filas.push(paso(&rt, "migrar_estelas (arranque)", || async {
        format!("{} migradas", crate::storage::migrar_estelas(|_, _| {}))
    }));

    // ── Lo que hace el arranque y la Home ──────────────────────────────────────
    filas.push(paso(&rt, "load_all_matches (cada barrido del arranque)", || async {
        format!("{} partidas", crate::storage::load_all_matches().len())
    }));
    filas.push(paso(&rt, "Home: get_recorded_matches", || async {
        ipc(&crate::commands::get_recorded_matches().await)
    }));
    filas.push(paso(&rt, "Home: get_pressure_summary", || async {
        ipc(&crate::riot_api::get_pressure_summary().await)
    }));
    filas.push(paso(&rt, "Home: get_coach_summary", || async {
        ipc(&crate::coach::get_coach_summary().await)
    }));
    filas.push(paso(&rt, "Home: get_coach_plan", || async {
        ipc(&crate::coach_plan::get_coach_plan().await.ok())
    }));
    filas.push(paso(&rt, "Home: get_blind_spot", || async {
        ipc(&crate::camera_snaps::get_blind_spot().await)
    }));

    // ── Patrones ───────────────────────────────────────────────────────────────
    filas.push(paso(&rt, "Patrones: get_hand_career", || async {
        ipc(&crate::hands::get_hand_career().await.ok())
    }));
    filas.push(paso(&rt, "Patrones: get_spell_diet", || async {
        ipc(&crate::spells::get_spell_diet().await.ok())
    }));
    filas.push(paso(&rt, "Patrones: get_hits_taken_career", || async {
        ipc(&crate::golpes::get_hits_taken_career().await)
    }));
    filas.push(paso(&rt, "Patrones: get_waves_career", || async {
        ipc(&crate::oleadas::get_waves_career().await)
    }));
    filas.push(paso(&rt, "Patrones: get_camera_zone_history", || async {
        ipc(&crate::camera_snaps::get_camera_zone_history().await)
    }));
    filas.push(paso(&rt, "Patrones: get_game_states", || async {
        ipc(&crate::estado_partida::get_game_states().await)
    }));
    filas.push(paso(&rt, "Patrones: get_jungle_routes", || async {
        ipc(&crate::jungle_route::get_jungle_routes().await)
    }));

    // ── Abrir la partida más reciente con datos de Riot ───────────────────────
    let id = crate::storage::load_all_matches()
        .into_iter()
        .find(|m| m.riot_match_id.is_some() && !m.is_vod)
        .map(|m| m.id)
        .expect("ninguna partida sincronizada en la biblioteca");
    let i = id.clone();
    filas.push(paso(&rt, "Abrir: get_match_details (con estela)", || {
        let i = i.clone();
        async move { ipc(&crate::storage::get_match_details(i).await) }
    }));
    {
        let i = id.clone();
        filas.push(paso(&rt, "Abrir: get_match_trail (binario)", || {
            let i = i.clone();
            async move {
                let ok = crate::storage::get_match_trail(i.clone()).await.is_ok();
                let kb = crate::estela::bytes(&crate::storage::get_match_dir(&i)).map(|b| b.len() / 1024).unwrap_or(0);
                format!("ok={ok} ipc={kb} KB")
            }
        }));
    }
    macro_rules! abrir {
        ($nombre:literal, $llamada:expr) => {{
            let i = id.clone();
            filas.push(paso(&rt, concat!("Abrir: ", $nombre), || {
                let i = i.clone();
                #[allow(clippy::redundant_closure_call)]
                async move { ipc(&($llamada)(i).await) }
            }));
        }};
    }
    abrir!("get_match_plays", |i| crate::jugadas::get_match_plays(i));
    abrir!("get_match_coach", |i| crate::coach::get_match_coach(i));
    abrir!("get_match_titles", |i| crate::titulos::get_match_titles(i));
    abrir!("get_minute_series", |i| crate::curvas::get_minute_series(i));
    abrir!("get_match_track", |i| crate::track::get_match_track(i));
    abrir!("get_jungle_route", |i| crate::jungle_route::get_jungle_route(i));
    abrir!("get_hits_taken", |i| crate::golpes::get_hits_taken(i));
    abrir!("get_hand_report", |i| crate::hands::get_hand_report(i));
    abrir!("get_spell_autopsy", |i| crate::spells::get_spell_autopsy(i));
    abrir!("get_aim", |i| crate::barras::get_aim(i));
    abrir!("get_gold_report", |i| crate::gold::get_gold_report(i));
    {
        let i = id.clone();
        filas.push(paso(&rt, "Abrir: get_match_benchmarks", || {
            let i = i.clone();
            async move { ipc(&crate::commands::get_match_benchmarks(i).await) }
        }));
        let i = id.clone();
        filas.push(paso(&rt, "Abrir: get_episode_strip ×1 (0-120 s)", || {
            let i = i.clone();
            async move { ipc(&crate::franja::get_episode_strip(i, 0.0, 120.0).await) }
        }));
    }

    // ── Guardar un comentario ──────────────────────────────────────────────────
    {
        let i = id.clone();
        let previos = crate::storage::load_match_by_id(&id).map(|m| m.comments).unwrap_or_default();
        filas.push(paso(&rt, "Guardar: save_match_comments", || {
            let i = i.clone();
            let mut c = previos.clone();
            c.push(crate::storage::Comment { time: 1.0, text: "medida".into() });
            async move { format!("{:?}", crate::commands::save_match_comments(i, c).await.is_ok()) }
        }));
        let _ = rt.block_on(crate::commands::save_match_comments(id.clone(), previos));
    }

    // ── Tabla ─────────────────────────────────────────────────────────────────
    println!("\nBiblioteca: {biblioteca}");
    println!(
        "{:<48} {:>9} {:>9} {:>5} {:>5} {:>8} {:>8} {:>5} {:>8}  {}",
        "paso", "1ª ms", "2ª ms", "recor", "estel", "MB meta", "MB riot", "escr", "MB escr", "nota"
    );
    for f in &filas {
        println!(
            "{:<48} {:>9.1} {:>9.1} {:>5} {:>5} {:>8.1} {:>8.1} {:>5} {:>8.1}  {}",
            f.paso, f.ms1, f.ms2, f.recorridos, f.aperturas, f.mb_leidos, f.mb_crudos, f.escrituras, f.mb_escritos, f.nota
        );
    }
    let total1: f64 = filas.iter().map(|f| f.ms1).sum();
    let total2: f64 = filas.iter().map(|f| f.ms2).sum();
    println!("{:<48} {:>9.1} {:>9.1}", "TOTAL", total1, total2);
    let _ = std::fs::remove_dir_all(&appdata);
}
