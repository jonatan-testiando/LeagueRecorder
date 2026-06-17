mod detector;
mod recorder;
mod api_listener;
mod storage;
mod commands;
mod streamer;
mod ultimate;

use std::sync::Arc;
use recorder::RecorderState;
use ultimate::{UltState, spawn_keyboard_listener};
use commands::{
    ActiveMatchState, spawn_background_monitor,
    get_recorded_matches, delete_match, get_recorder_status, get_audio_status,
    get_ultimate_settings, set_ultimate_settings,
    start_manual_recording, stop_manual_recording, export_clip,
    get_all_clips, upload_clip
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Inicializar estados compartidos
    let recorder_state = Arc::new(RecorderState::default());
    let active_match_state = Arc::new(ActiveMatchState::default());
    let ult_state = Arc::new(UltState::default());

    // Listener global de teclado para detectar la ultimate (best-effort)
    spawn_keyboard_listener(Arc::clone(&ult_state));

    // Iniciar monitor de fondo para detección automática de partidas
    spawn_background_monitor(
        Arc::clone(&recorder_state),
        Arc::clone(&active_match_state),
        Arc::clone(&ult_state),
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Protocolo de streaming propio para reproducir vídeos locales con soporte de
        // HTTP Range (seek instantáneo y archivos grandes). En Windows se sirve en
        // http://stream.localhost/<ruta>
        .register_uri_scheme_protocol("stream", |_ctx, request| {
            streamer::handle(request)
        })
        // Registrar estados compartidos para inyección de dependencias en comandos
        .manage(recorder_state)
        .manage(active_match_state)
        .manage(ult_state)
        .invoke_handler(tauri::generate_handler![
            get_recorded_matches,
            delete_match,
            get_recorder_status,
            get_audio_status,
            get_ultimate_settings,
            set_ultimate_settings,
            start_manual_recording,
            stop_manual_recording,
            export_clip,
            get_all_clips,
            upload_clip
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
