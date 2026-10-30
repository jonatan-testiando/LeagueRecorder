//! Tamaño de la interfaz: el zoom del WebView de la ventana principal.
//!
//! Todo el CSS va en px fijos y se diseñó para verse entre 1280 y 1920 px de
//! ancho. En un monitor de 2560 al 100 % de escala de Windows eso dejaba la
//! letra del cuerpo a 14 px físicos y el contenido como una isla en medio de la
//! pantalla. El zoom del WebView lo escala TODO a la vez (letra, huecos,
//! iconos, el lienzo del mapa), y a diferencia del `zoom` de CSS mantiene
//! coherentes las coordenadas del ratón y `devicePixelRatio`, que el mapa y la
//! estela del ratón ya saben manejar porque Windows al 125 % hace lo mismo.
//!
//! Se aplica en `setup`, antes de que pinte la página: sin parpadeo de un
//! tamaño a otro al arrancar.

use tauri::{AppHandle, LogicalSize, Manager, WebviewWindow};

/// El ancho de diseño: a partir de aquí la interfaz crece con la pantalla.
const ANCHO_DISEÑO: f64 = 1920.0;
/// Tope del automático: más allá, mejor que lo pida el usuario.
const AUTO_MAX: f64 = 1.5;
/// Lo que acepta el selector de Ajustes.
const ESCALA_MIN: f64 = 0.8;
const ESCALA_MAX: f64 = 2.0;
/// El tamaño mínimo y el inicial de la ventana en px de CSS (los de
/// `tauri.conf.json`): con zoom, la ventana tiene que crecer en proporción o
/// las pantallas recibirían menos sitio del que dan por hecho.
const MIN_CSS: (f64, f64) = (1024.0, 680.0);
const INICIAL_CSS: (f64, f64) = (1280.0, 800.0);

/// Redondeo a 5 %: que el selector diga «135 %» y no «133,33 %».
fn redondear(z: f64) -> f64 {
    (z * 20.0).round() / 20.0
}

/// El ancho lógico (en px de Windows, ya con su escala) del monitor donde está
/// la ventana.
fn monitor_logico(w: &WebviewWindow) -> Option<(f64, f64)> {
    let m = w.current_monitor().ok().flatten().or_else(|| w.primary_monitor().ok().flatten())?;
    let sf = m.scale_factor();
    Some((m.size().width as f64 / sf, m.size().height as f64 / sf))
}

/// La escala que toca a esta pantalla: 1 hasta 1920 de ancho lógico y, por
/// encima, la que devuelve el contenido a esos 1920 de CSS. Un 2560 al 100 %
/// sale a 135 %; un 2560 al 125 % de Windows (2048 lógicos), a 105 %.
pub fn automatica(w: &WebviewWindow) -> f64 {
    match monitor_logico(w) {
        Some((ancho, _)) => redondear((ancho / ANCHO_DISEÑO).clamp(1.0, AUTO_MAX)),
        None => 1.0,
    }
}

/// Acota lo que llega de la config: 0 (o cualquier cosa rota) es automático.
pub fn sanear(v: f64) -> f64 {
    if v.is_finite() && v > 0.0 {
        redondear(v.clamp(ESCALA_MIN, ESCALA_MAX))
    } else {
        0.0
    }
}

fn efectiva(w: &WebviewWindow) -> f64 {
    let elegida = sanear(crate::storage::load_config().ui_scale);
    if elegida > 0.0 { elegida } else { automatica(w) }
}

/// Aplica la escala a la ventana principal. `arranque`: además deja la ventana
/// al tamaño inicial escalado y centrada, como la habría abierto sin zoom.
pub fn aplicar(app: &AppHandle, arranque: bool) {
    let Some(w) = app.get_webview_window("main") else { return };
    let z = efectiva(&w);
    if let Err(e) = w.set_zoom(z) {
        eprintln!("Escala: no se pudo aplicar el zoom {z}: {e}");
        return;
    }

    // Nunca más que la pantalla: con 150 % en un portátil, el mínimo escalado
    // no cabría y la ventana se saldría por abajo.
    let (tope_w, tope_h) = monitor_logico(&w).map(|(a, b)| (a * 0.95, b * 0.9)).unwrap_or((f64::MAX, f64::MAX));
    let min = LogicalSize::new((MIN_CSS.0 * z).min(tope_w), (MIN_CSS.1 * z).min(tope_h));
    let _ = w.set_min_size(Some(min));

    if w.is_maximized().unwrap_or(false) {
        return;
    }
    let (Ok(size), Ok(sf)) = (w.inner_size(), w.scale_factor()) else { return };
    let actual = size.to_logical::<f64>(sf);
    if arranque {
        let ini = LogicalSize::new((INICIAL_CSS.0 * z).min(tope_w), (INICIAL_CSS.1 * z).min(tope_h));
        let _ = w.set_size(ini);
        let _ = w.center();
    } else if actual.width < min.width || actual.height < min.height {
        let _ = w.set_size(LogicalSize::new(actual.width.max(min.width), actual.height.max(min.height)));
    }
}

#[derive(serde::Serialize)]
pub struct Escala {
    /// La que daría «Automático» en esta pantalla.
    pub auto: f64,
    /// La que hay puesta ahora.
    pub efectiva: f64,
}

/// Para el selector de Ajustes: «Automático (135 %)» necesita saber el número.
#[tauri::command]
pub fn get_ui_scale(app: AppHandle) -> Escala {
    match app.get_webview_window("main") {
        Some(w) => Escala { auto: automatica(&w), efectiva: efectiva(&w) },
        None => Escala { auto: 1.0, efectiva: 1.0 },
    }
}
