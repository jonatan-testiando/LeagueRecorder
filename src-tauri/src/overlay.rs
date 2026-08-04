//! Ventana transparente del metrónomo in-game.
//!
//! Se crea al empezar la partida (si el metrónomo está activo) y se destruye al
//! terminarla. Es transparente, sin bordes, siempre encima, fuera de la barra de
//! tareas y **click-through**: no roba el foco ni intercepta el ratón, así que el
//! juego se comporta exactamente igual con ella que sin ella.
//!
//! Nota: sobre un juego en pantalla completa *exclusiva* ninguna ventana se pinta
//! encima. Hay que jugar en "sin bordes"/ventana, que además es lo que necesita la
//! grabadora para capturar.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub const OVERLAY_LABEL: &str = "overlay";

/// Alto de la píldora más margen. El ancho se deja generoso porque el contenido
/// va centrado y la ventana es click-through: sobrar no molesta.
const OVERLAY_W: f64 = 420.0;
const OVERLAY_H: f64 = 60.0;

/// Crea la ventana del overlay si no existe. No falla la partida si algo sale mal:
/// el metrónomo es un extra, no puede tumbar la grabación.
///
/// Se llama desde el hilo del monitor, así que la construcción se despacha al hilo
/// principal: crear ventanas desde otro hilo es territorio resbaladizo.
pub fn show(app: &tauri::AppHandle) {
    let handle = app.clone();
    if let Err(e) = app.run_on_main_thread(move || build(&handle)) {
        eprintln!("Overlay: no se pudo despachar la creación de la ventana: {}", e);
    }
}

/// Cierra el overlay si está abierto.
pub fn hide(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window(OVERLAY_LABEL) {
            let _ = w.close();
        }
    });
}

/// Muestra el overlay con un aviso de ejemplo y lo cierra solo. Sirve para
/// comprobar que se ve por encima del juego y dónde queda, sin tener que esperar
/// a una partida real (que es justo lo que hace difícil probarlo).
#[tauri::command]
pub async fn preview_metronome_overlay(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;

    show(&app);
    // Pequeña espera: la webview necesita montar y suscribirse antes de recibir nada.
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    let _ = app.emit(
        "metronome_prompt",
        serde_json::json!({ "role": "MID", "key": "2", "window_secs": 5 }),
    );
    tokio::time::sleep(std::time::Duration::from_millis(2200)).await;
    let _ = app.emit(
        "metronome_ack",
        serde_json::json!({ "ok": true, "role": "MID", "latency_ms": 380.0 }),
    );
    tokio::time::sleep(std::time::Duration::from_millis(1600)).await;
    hide(&app);
    Ok(())
}

fn build(app: &tauri::AppHandle) {
    if app.get_webview_window(OVERLAY_LABEL).is_some() {
        return;
    }

    let builder = WebviewWindowBuilder::new(
        app,
        OVERLAY_LABEL,
        WebviewUrl::App("index.html?overlay=1".into()),
    )
    .title("LeagueRecorder Overlay")
    .inner_size(OVERLAY_W, OVERLAY_H)
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .focused(false)
    .visible(true);

    let window = match builder.build() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("Overlay: no se pudo crear la ventana: {}", e);
            return;
        }
    };

    // Click-through: los clics atraviesan la ventana y llegan al juego.
    if let Err(e) = window.set_ignore_cursor_events(true) {
        eprintln!("Overlay: no se pudo activar click-through: {}", e);
    }

    // Centrada arriba del monitor principal.
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let logical_w = size.width as f64 / scale;
        let x = (logical_w - OVERLAY_W) / 2.0;
        let _ = window.set_position(tauri::LogicalPosition::new(x.max(0.0), 8.0));
    }
}
