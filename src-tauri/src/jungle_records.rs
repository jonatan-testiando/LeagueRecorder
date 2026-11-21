//! Récords de primer clear de jungla, de la hoja comunitaria.
//!
//! La hoja (Google Sheets, pública, la mantiene la comunidad de su Discord)
//! lista por campeón el primer clear más rápido conocido: parche, campamentos,
//! smites, tiempo, orden de campamentos, vídeo, jugador y notas (runas, build).
//! Es la misma fuente de la que MicroLab copia a mano su catálogo; aquí se lee
//! directamente:
//!
//! - **Pestaña**: la de la temporada más alta («Jungle clear S16/2026»). Se
//!   saca del índice de pestañas (`htmlview`), así que cuando salga la S17 se
//!   coge sola.
//! - **Descarga**: la exportación a CSV de esa pestaña, sin sesión (~55 KB).
//! - **Copia local**: `jungle_records.json` junto a la config, escrita a un
//!   temporal y renombrada. Se refresca cada 24 h; si falla, se reintenta en
//!   30 min y mientras tanto vale la copia anterior.
//! - **Filas**: las mal escritas se descartan una a una (MicroLab rechaza el
//!   catálogo entero por una sola fila mala). Una descarga con menos de
//!   `MIN_FILAS` buenas no sustituye a la copia que hay.
//!
//! Medido el 2026-11-21: 382 clears de 134 campeones en la pestaña S16
//! (Meta 270, Off-Meta 78, Non-Meta 34), parches 25.14 a 26.23; 378 de 6
//! campamentos; enlaces de YouTube salvo 7 de Bilibili y 1 de X; 11 con el
//! segundo de inicio en la URL.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

const HOJA: &str = "1jE8bnlnIJnmWv9pnVW9veMKRXJNaaJf5tneQB3xUkbI";
/// La pestaña S16/2026, por si el índice de pestañas no se puede leer.
const PESTANA_RESPALDO: (&str, &str) = ("S16/2026", "1938238048");
const REFRESCO_S: i64 = 24 * 3_600;
const REINTENTO_S: i64 = 30 * 60;
/// Menos filas buenas que esto es que la hoja cambió de forma o la descarga
/// salió mal: no se pisa la copia que hay.
const MIN_FILAS: usize = 50;
const UA: &str = "Wardline/1 (jungle clear records)";

pub fn url_hoja() -> String {
    format!("https://docs.google.com/spreadsheets/d/{HOJA}/edit")
}

/// Un clear de la hoja.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordClear {
    /// Como lo escribe la hoja: "Kha'Zix", "Nunu & Willump".
    pub champion: String,
    /// "26.02", "26.01PBE", "26.06b".
    pub patch: String,
    /// Tiempo del juego al acabar el último campamento.
    pub clear_s: u32,
    pub camps: u8,
    pub smites: u8,
    /// En orden, con las claves de `jungle_route.rs` ("raptors", "red"…) más
    /// "recall" y "scuttle".
    pub route: Vec<String>,
    /// El enlace tal cual (YouTube, Bilibili, X…).
    pub video_url: String,
    /// Solo si es de YouTube: para reproducirlo dentro de la app.
    pub youtube_id: Option<String>,
    /// Segundo del vídeo en que empieza (0 si la URL no lo dice).
    pub start_s: u32,
    pub player: String,
    pub notes: String,
    /// "meta", "off_meta", "non_meta" u "outdated".
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Catalogo {
    /// Epoch ms de la descarga.
    descargado: i64,
    /// "S16/2026".
    temporada: String,
    gid: String,
    filas: Vec<RecordClear>,
}

static CATALOGO: Mutex<Option<Catalogo>> = Mutex::new(None);

fn ruta_copia() -> PathBuf {
    crate::storage::get_config_path().with_file_name("jungle_records.json")
}

fn ahora_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ---------------------------------------------------------------------------
// Lectura de la hoja
// ---------------------------------------------------------------------------

/// CSV (RFC 4180): comillas, comillas dobladas y saltos de línea dentro.
fn leer_csv(texto: &str) -> Vec<Vec<String>> {
    let mut filas = Vec::new();
    let mut fila = Vec::new();
    let mut campo = String::new();
    let mut entre_comillas = false;
    let mut it = texto.chars().peekable();
    while let Some(c) = it.next() {
        if entre_comillas {
            if c == '"' {
                if it.peek() == Some(&'"') {
                    campo.push('"');
                    it.next();
                } else {
                    entre_comillas = false;
                }
            } else {
                campo.push(c);
            }
            continue;
        }
        match c {
            '"' => entre_comillas = true,
            ',' => fila.push(std::mem::take(&mut campo)),
            '\r' => {}
            '\n' => {
                fila.push(std::mem::take(&mut campo));
                filas.push(std::mem::take(&mut fila));
            }
            _ => campo.push(c),
        }
    }
    if !campo.is_empty() || !fila.is_empty() {
        fila.push(campo);
        filas.push(fila);
    }
    filas
}

/// "02:54" → 174. Admite "2:54" y décimas ("2:54.5" → 175).
fn segundos_de(t: &str) -> Option<u32> {
    let (m, s) = t.trim().split_once(':')?;
    let m: u32 = m.trim().parse().ok()?;
    let s: f64 = s.trim().parse().ok()?;
    if !(0.0..60.0).contains(&s) || m > 15 {
        return None;
    }
    let total = m as f64 * 60.0 + s;
    (total > 0.0).then(|| total.round() as u32)
}

/// Clave de parche comparable: "26.02" → 2602. Riot cuenta 16.x donde la
/// temporada dice 26.x (el `gameVersion` de la partida es "16.21.x"): de 15 a
/// 24 se suma 10, como hace MicroLab.
pub fn clave_parche(p: &str) -> Option<u32> {
    let p = p.trim();
    let fin = p.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(p.len());
    let mut it = p[..fin].split('.');
    let mayor: u32 = it.next()?.parse().ok()?;
    let menor: u32 = it.next()?.parse().ok()?;
    let mayor = if (15..25).contains(&mayor) { mayor + 10 } else { mayor };
    Some(mayor * 100 + menor)
}

/// Clave de campeón: solo letras, en minúscula, con los dos nombres internos
/// que no se parecen al visible.
pub fn clave_campeon(n: &str) -> String {
    let k: String = n.chars().filter(|c| c.is_ascii_alphabetic()).map(|c| c.to_ascii_lowercase()).collect();
    match k.as_str() {
        "monkeyking" => "wukong".into(),
        "nunu" => "nunuwillump".into(),
        _ => k,
    }
}

/// "Raptors->Red->Krugs->Recall->…" → claves de campamento.
fn ruta_de(txt: &str) -> Vec<String> {
    txt.split("->")
        .flat_map(|s| s.split('→'))
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .map(|s| match s.as_str() {
            "wolf" => "wolves".into(),
            "raptor" => "raptors".into(),
            "krug" => "krugs".into(),
            "scuttler" | "crab" => "scuttle".into(),
            "base" | "back" => "recall".into(),
            _ => s,
        })
        .collect()
}

/// "1m30s", "90s", "90" → segundos.
fn segundos_url(t: &str) -> Option<u32> {
    if let Ok(n) = t.parse::<u32>() {
        return Some(n);
    }
    let mut total = 0u32;
    let mut num = String::new();
    for c in t.chars() {
        if c.is_ascii_digit() {
            num.push(c);
        } else {
            let n: u32 = num.parse().ok()?;
            num.clear();
            total += n * match c {
                'h' => 3600,
                'm' => 60,
                's' => 1,
                _ => return None,
            };
        }
    }
    if !num.is_empty() {
        total += num.parse::<u32>().ok()?;
    }
    Some(total)
}

/// Id de YouTube y segundo de inicio de un enlace; `None` si no es de YouTube.
fn youtube_de(url: &str) -> Option<(String, u32)> {
    let u = url.trim();
    let sin_esquema = u.trim_start_matches("https://").trim_start_matches("http://");
    let (ruta, consulta) = sin_esquema.split_once('?').unwrap_or((sin_esquema, ""));
    let host = ruta.split('/').next()?.trim_start_matches("www.").trim_start_matches("m.").to_ascii_lowercase();
    let param = |k: &str| {
        consulta
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .find(|(a, _)| *a == k)
            .map(|(_, v)| v.split('#').next().unwrap_or(v).to_string())
    };
    let id = match host.as_str() {
        "youtu.be" => ruta.split('/').nth(1).map(str::to_string),
        "youtube.com" | "youtube-nocookie.com" => {
            let partes: Vec<&str> = ruta.split('/').collect();
            match partes.get(1).copied() {
                Some("watch") => param("v"),
                Some("shorts") | Some("live") | Some("embed") => partes.get(2).map(|s| s.to_string()),
                _ => None,
            }
        }
        _ => None,
    }?;
    let valido = id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valido {
        return None;
    }
    let inicio = param("t").or_else(|| param("start")).and_then(|t| segundos_url(&t)).unwrap_or(0);
    Some((id, inicio.min(86_400)))
}

/// La categoría que abre una fila de sección ("Meta Junglers:"…). `Some(None)`
/// para las secciones que no son de clears ("Helpful resources:", "Appendix:").
fn seccion_de(celda: &str) -> Option<Option<&'static str>> {
    let c = celda.trim().to_ascii_lowercase();
    if !c.ends_with(':') {
        return None;
    }
    Some(if c.contains("off-meta") || c.contains("off meta") {
        Some("off_meta")
    } else if c.contains("non-meta") || c.contains("non meta") {
        Some("non_meta")
    } else if c.contains("outdated") {
        Some("outdated")
    } else if c.contains("meta") {
        Some("meta")
    } else {
        None
    })
}

/// Las filas de clears de una pestaña exportada a CSV.
fn leer_hoja(csv: &str) -> Vec<RecordClear> {
    let mut categoria: Option<&'static str> = None;
    let mut out = Vec::new();
    for fila in leer_csv(csv) {
        let celda = |i: usize| fila.get(i).map(|s| s.trim()).unwrap_or("");
        // Fila de sección: el nombre y nada en las columnas de datos.
        if (1..=4).all(|i| celda(i).is_empty()) {
            if let Some(c) = seccion_de(celda(0)) {
                categoria = c;
            }
            continue;
        }
        let Some(cat) = categoria else { continue };
        let (campeon, parche) = (celda(0), celda(1));
        if campeon.is_empty() || clave_parche(parche).is_none() {
            continue;
        }
        let (Some(clear_s), Ok(camps), Some(smites)) = (
            segundos_de(celda(4)),
            celda(2).parse::<u8>(),
            celda(3).chars().find(|c| c.is_ascii_digit()).and_then(|c| c.to_digit(10)),
        ) else {
            continue;
        };
        let route = ruta_de(celda(5));
        if route.is_empty() {
            continue;
        }
        let url = celda(6).to_string();
        let yt = youtube_de(&url);
        out.push(RecordClear {
            champion: campeon.to_string(),
            patch: parche.to_string(),
            clear_s,
            camps,
            smites: smites as u8,
            route,
            youtube_id: yt.as_ref().map(|(id, _)| id.clone()),
            start_s: yt.map(|(_, s)| s).unwrap_or(0),
            video_url: url,
            player: celda(7).to_string(),
            notes: celda(8).to_string(),
            category: cat.to_string(),
        });
    }
    out
}

/// Pestañas de clears del índice de la hoja: `("S16/2026", gid)`, la de la
/// temporada más alta primero.
fn pestanas(html: &str) -> Vec<(u32, String, String)> {
    let mut out = Vec::new();
    let marca = "Jungle clear S";
    let mut resto = html;
    while let Some(i) = resto.find(marca) {
        resto = &resto[i + marca.len()..];
        let num: String = resto.chars().take_while(|c| c.is_ascii_digit()).collect();
        let Ok(temporada) = num.parse::<u32>() else { continue };
        // El nombre sigue hasta la comilla: "S16\/2026" → "S16/2026".
        let nombre: String = resto.chars().take_while(|c| *c != '"' && *c != '<').collect();
        let nombre = format!("S{}", nombre.replace("\\/", "/").trim());
        let ventana: String = resto.chars().take(400).collect();
        if let Some(j) = ventana.find("gid=") {
            let gid: String = ventana[j + 4..].chars().take_while(|c| c.is_ascii_digit()).collect();
            if !gid.is_empty() && !out.iter().any(|(_, _, g): &(u32, String, String)| *g == gid) {
                out.push((temporada, nombre, gid));
            }
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out
}

// ---------------------------------------------------------------------------
// Descarga y copia local
// ---------------------------------------------------------------------------

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

async fn texto(url: &str) -> Result<String, String> {
    let r = http().get(url).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("{}", r.status()));
    }
    r.text().await.map_err(|e| e.to_string())
}

async fn descargar() -> Result<Catalogo, String> {
    let (temporada, gid) = match texto(&format!("https://docs.google.com/spreadsheets/d/{HOJA}/htmlview")).await {
        Ok(html) => pestanas(&html)
            .into_iter()
            .next()
            .map(|(_, n, g)| (n, g))
            .unwrap_or_else(|| (PESTANA_RESPALDO.0.into(), PESTANA_RESPALDO.1.into())),
        Err(_) => (PESTANA_RESPALDO.0.into(), PESTANA_RESPALDO.1.into()),
    };
    let csv = texto(&format!("https://docs.google.com/spreadsheets/d/{HOJA}/export?format=csv&gid={gid}")).await?;
    let filas = leer_hoja(&csv);
    if filas.len() < MIN_FILAS {
        return Err(format!("la hoja trae solo {} clears legibles", filas.len()));
    }
    Ok(Catalogo { descargado: ahora_ms(), temporada, gid, filas })
}

fn guardar(c: &Catalogo) -> Result<(), String> {
    let ruta = ruta_copia();
    let tmp = ruta.with_extension("json.tmp");
    let json = serde_json::to_vec(c).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &ruta).map_err(|e| e.to_string())
}

fn cargar_copia() -> Option<Catalogo> {
    let bytes = std::fs::read(ruta_copia()).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// El catálogo en memoria; si no lo hay, el de disco.
fn actual() -> Option<Catalogo> {
    let mut g = CATALOGO.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_none() {
        *g = cargar_copia();
    }
    g.clone()
}

async fn refrescar() -> Result<usize, String> {
    let c = descargar().await?;
    let n = c.filas.len();
    let c2 = c.clone();
    tauri::async_runtime::spawn_blocking(move || guardar(&c2)).await.map_err(|e| e.to_string())??;
    *CATALOGO.lock().unwrap_or_else(|e| e.into_inner()) = Some(c);
    Ok(n)
}

/// Mantiene la copia al día mientras la app está abierta: al arrancar (con un
/// rato de margen) si tiene más de un día, y luego cada día.
pub fn spawn_refresco() {
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(Duration::from_secs(45)).await;
        loop {
            let edad = actual().map(|c| (ahora_ms() - c.descargado) / 1000);
            let espera = if edad.map_or(true, |e| e >= REFRESCO_S) {
                match refrescar().await {
                    Ok(n) => {
                        log::info!("récords de jungla: {n} clears");
                        REFRESCO_S
                    }
                    Err(e) => {
                        log::warn!("récords de jungla: {e}");
                        REINTENTO_S
                    }
                }
            } else {
                REFRESCO_S - edad.unwrap_or(0)
            };
            // Se duerme a trozos de una hora: tras una suspensión del equipo
            // el reloj de pared manda.
            tokio::time::sleep(Duration::from_secs(espera.clamp(60, 3_600) as u64)).await;
        }
    });
}

// ---------------------------------------------------------------------------
// Comando
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JungleRecords {
    /// Clears completos (6 campamentos) del campeón, del parche de la partida
    /// o anteriores: el más rápido primero.
    records: Vec<RecordClear>,
    /// La hoja tiene clears de ese campeón, aunque ninguno sirva (parches
    /// posteriores o incompletos).
    any_for_champion: bool,
    season: Option<String>,
    /// Epoch ms de la copia.
    updated_ms: Option<i64>,
    sheet_url: String,
    /// No hay copia y la descarga falló.
    unavailable: bool,
}

/// Los clears que valen de referencia para un campeón y parche.
fn elegir(filas: &[RecordClear], campeon: &str, parche: Option<&str>) -> (Vec<RecordClear>, bool) {
    let clave = clave_campeon(campeon);
    let tope = parche.and_then(clave_parche);
    let del_campeon: Vec<&RecordClear> = filas.iter().filter(|r| clave_campeon(&r.champion) == clave).collect();
    let mut validos: Vec<RecordClear> = del_campeon
        .iter()
        .filter(|r| r.camps == 6 && r.category != "outdated")
        .filter(|r| match (tope, clave_parche(&r.patch)) {
            (Some(t), Some(p)) => p <= t,
            _ => true,
        })
        .map(|r| (*r).clone())
        .collect();
    validos.sort_by(|a, b| {
        a.clear_s
            .cmp(&b.clear_s)
            .then_with(|| clave_parche(&b.patch).cmp(&clave_parche(&a.patch)))
    });
    // Varios: la vista busca entre ellos el de tu misma ruta.
    validos.truncate(30);
    (validos, !del_campeon.is_empty())
}

#[tauri::command]
pub async fn get_jungle_records(champion: String, patch: Option<String>) -> JungleRecords {
    let mut cat = tauri::async_runtime::spawn_blocking(actual).await.ok().flatten();
    // Sin copia todavía (primer arranque): se baja ahora, no a los 45 s.
    if cat.is_none() {
        if refrescar().await.is_ok() {
            cat = actual();
        }
    }
    let Some(c) = cat else {
        return JungleRecords {
            records: vec![],
            any_for_champion: false,
            season: None,
            updated_ms: None,
            sheet_url: url_hoja(),
            unavailable: true,
        };
    };
    let (records, any) = elegir(&c.filas, &champion, patch.as_deref());
    JungleRecords {
        records,
        any_for_champion: any,
        season: Some(c.temporada),
        updated_ms: Some(c.descargado),
        sheet_url: url_hoja(),
        unavailable: false,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JungleClearCatalog {
    /// Todos los clears de la hoja (también los de 3 campamentos y los viejos):
    /// la pantalla Clears filtra.
    records: Vec<RecordClear>,
    season: Option<String>,
    updated_ms: Option<i64>,
    sheet_url: String,
    unavailable: bool,
}

/// El catálogo entero, para la pantalla Clears.
#[tauri::command]
pub async fn get_jungle_clear_catalog() -> JungleClearCatalog {
    let mut cat = tauri::async_runtime::spawn_blocking(actual).await.ok().flatten();
    if cat.is_none() && refrescar().await.is_ok() {
        cat = actual();
    }
    match cat {
        Some(c) => JungleClearCatalog {
            records: c.filas,
            season: Some(c.temporada),
            updated_ms: Some(c.descargado),
            sheet_url: url_hoja(),
            unavailable: false,
        },
        None => JungleClearCatalog {
            records: vec![],
            season: None,
            updated_ms: None,
            sheet_url: url_hoja(),
            unavailable: true,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MUESTRA: &str = "Season 16/2026,,,Got any questions,,,,https://discord.com/invite/x,\n\
,,,\"How to use: 'Ctrl F'\",,,,,\n\
\"*Recall clear note*: All S16 Clears\nNote: more lines\",,,,,,,,\n\
Champion,Patch,Camps,Smite(s),Time,Path,Link,Player,Notes/Details: (more may be found)\n\
Meta Junglers:,,,,,,,,\n\
Aatrox,26.02,6,1,02:54,Raptors->Red->Krugs->Recall->Wolves->Gromp->Blue,https://www.youtube.com/watch?v=DaIlrj-Jcx0,Zen'Kih,\"QEQ, AD/AD/HPS\"\n\
Aatrox,26.02,6,1,02:39,Raptors->Krugs->Red->Wolves->Gromp->Blue,https://www.youtube.com/watch?v=Iyno0bhlYzo&t=120s,MikeBEASTon,\"QEQ, AD/AD/HPS\"\n\
Aatrox,26.23,6,1,02:30,Raptors->Krugs->Red->Wolves->Gromp->Blue,https://youtu.be/B-9JJ9eUY7g?t=114,Nuevo,\n\
Wukong,26.10,3,1,01:40,Red->Krugs->Raptors,https://www.youtube.com/watch?v=4mMdfMRE6cY,X,\n\
Off-Meta Junglers:,,,,,Situationally viable picks,,,\n\
Zoe,26.06,6,2,02:57,Raptors->Krugs->Red->Wolves->Gromp->Blue,https://www.bilibili.com/video/BV1xdQfB6EJu,0o一米阳光o0,\"QEQ, AP/AP\"\n\
Roto,26.06,6,x,dos minutos,Red,,,\n\
Helpful resources: ,,,,,,,,\n\
Basic Kiting Guide,,,,https://www.youtube.com/watch?v=QgVA3RXSaaa,,,,\n\
Appendix:,,,,,,,,\n\
AD,Attack Damage ,,,Rune shard Row 1/2 Option 1. ,,,,\n";

    #[test]
    fn lee_la_hoja() {
        let f = leer_hoja(MUESTRA);
        assert_eq!(f.len(), 5, "{f:#?}");
        assert_eq!(f[0].champion, "Aatrox");
        assert_eq!(f[0].clear_s, 174);
        assert_eq!(f[0].route, vec!["raptors", "red", "krugs", "recall", "wolves", "gromp", "blue"]);
        assert_eq!(f[0].notes, "QEQ, AD/AD/HPS");
        assert_eq!(f[0].category, "meta");
        assert_eq!(f[1].youtube_id.as_deref(), Some("Iyno0bhlYzo"));
        assert_eq!(f[1].start_s, 120);
        assert_eq!((f[2].youtube_id.as_deref(), f[2].start_s), (Some("B-9JJ9eUY7g"), 114));
        // Bilibili: sin id de YouTube, pero con su enlace.
        let zoe = f.iter().find(|r| r.champion == "Zoe").unwrap();
        assert_eq!((zoe.youtube_id.as_ref(), zoe.category.as_str(), zoe.smites), (None, "off_meta", 2));
        // Ni la fila rota ni los recursos ni el apéndice.
        assert!(f.iter().all(|r| r.champion != "Roto" && r.champion != "AD" && !r.champion.contains("Guide")));
    }

    #[test]
    fn elige_el_record() {
        let f = leer_hoja(MUESTRA);
        // Partida del parche 16.22 (= 26.22): el 2:30 del 26.23 es posterior y no vale.
        let (r, hay) = elegir(&f, "Aatrox", Some("16.22"));
        assert!(hay);
        assert_eq!(r.iter().map(|x| x.clear_s).collect::<Vec<_>>(), vec![159, 174]);
        // En el 26.23 sí.
        assert_eq!(elegir(&f, "Aatrox", Some("16.23")).0[0].clear_s, 150);
        // Wukong por su nombre interno; su único clear es de 3 campamentos.
        let (r, hay) = elegir(&f, "MonkeyKing", Some("16.22"));
        assert!(hay && r.is_empty());
        assert!(!elegir(&f, "Shyvana", None).1);
    }

    #[test]
    fn claves_y_formatos() {
        assert_eq!(clave_parche("26.02"), Some(2602));
        assert_eq!(clave_parche("16.21.734.1234"), Some(2621));
        assert_eq!(clave_parche("26.01PBE"), Some(2601));
        assert_eq!(clave_parche("25.14"), Some(2514));
        assert_eq!(clave_parche("x"), None);
        assert_eq!(clave_campeon("Kha'Zix"), clave_campeon("KhaZix"));
        assert_eq!(clave_campeon("Nunu & Willump"), clave_campeon("Nunu"));
        assert_eq!(segundos_de("2:54.5"), Some(175));
        assert_eq!(segundos_de("02:60"), None);
        assert_eq!(segundos_url("1m30s"), Some(90));
        assert_eq!(youtube_de("https://www.youtube.com/watch?v=6kxNHNdxgGs&t=225"), Some(("6kxNHNdxgGs".into(), 225)));
        assert_eq!(youtube_de("https://x.com/lolshapeshift/status/1"), None);
        let html = r#"{name: "Jungle clear S15\/2025", pageUrl: "https:\/\/x\/htmlview?gid=0"},{name: "Jungle clear S16\/2026", pageUrl: "https:\/\/x\/htmlview?gid=1938238048"}"#;
        assert_eq!(pestanas(html)[0], (16, "S16/2026".to_string(), "1938238048".to_string()));
    }

    /// Contra la hoja de verdad (red). `cargo test --lib jungle_records::tests::hoja_real -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn hoja_real() {
        let c = descargar().await.unwrap();
        eprintln!("{} · gid {} · {} clears", c.temporada, c.gid, c.filas.len());
        let (r, _) = elegir(&c.filas, "Gwen", Some("16.23"));
        for x in r.iter().take(3) {
            eprintln!("{} {} {}s {:?} {:?}+{} {}", x.champion, x.patch, x.clear_s, x.route, x.youtube_id, x.start_s, x.player);
        }
        assert!(c.filas.len() >= MIN_FILAS);
    }
}
