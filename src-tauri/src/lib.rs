mod api_listener;
mod commands;
mod cv_analyzer;
mod dataset_generator;
mod detector;
mod obs_client;
mod recorder;
pub mod riot_api;
mod storage;
mod streamer;
mod ultimate;

use commands::{
    add_error_event, delete_error_event, delete_match, edit_error_event, export_clip,
    export_error_clip, get_all_clips, get_all_error_clips, get_app_config, get_audio_status,
    get_recorded_matches, get_recorder_status, get_ultimate_settings, get_video_settings,
    save_match_comments, save_replay_clip, set_app_config, set_ultimate_settings, set_video_settings,
    sync_match_now,
    spawn_background_monitor, start_manual_recording, stop_manual_recording, toggle_clip_favorite,
    update_error_note,
    upload_clip, get_disk_usage, ActiveMatchState,
};
use recorder::RecorderState;
use std::sync::Arc;
use ultimate::{spawn_keyboard_listener, UltState};

use tauri::{tray::TrayIconBuilder, menu::{Menu, MenuItem}, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Inicializar estados compartidos
    let recorder_state = Arc::new(RecorderState::default());
    let active_match_state = Arc::new(ActiveMatchState::default());
    let ult_state = Arc::new(UltState::default());

    // Listener global de teclado para detectar la ultimate (best-effort)
    spawn_keyboard_listener(Arc::clone(&ult_state));

    let video_settings = Arc::new(std::sync::Mutex::new(
        crate::commands::VideoSettings::default(),
    ));

    // Iniciar monitor de fondo para detección automática de partidas
    spawn_background_monitor(
        Arc::clone(&recorder_state),
        Arc::clone(&active_match_state),
        Arc::clone(&ult_state),
        Arc::clone(&video_settings),
    );

    tauri::Builder::default()
        .manage(cv_analyzer::AnalyzerState::default())
        .setup(|app| {
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Open Recorder", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        // Cerrar el servidor de grabación (proceso hijo libobs) antes de salir.
                        if let Some(state) = app.try_state::<Arc<RecorderState>>() {
                            recorder::shutdown_recorder(&state);
                        }
                        std::process::exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            window.show().unwrap();
                            window.set_focus().unwrap();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            window.show().unwrap();
                            window.set_focus().unwrap();
                        }
                    }
                })
                .build(app)?;

            // En producción, el runtime de OBS va empaquetado bajo el resource dir; exponemos su
            // ruta a recorder.rs para que lance el server desde ahí (en dev usa third_party).
            if let Ok(res) = app.path().resource_dir() {
                std::env::set_var("LEAGUEREC_OBS_RUNTIME", res.join("obs-runtime"));
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                window.hide().unwrap();
                api.prevent_close();
            }
            _ => {}
        })
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Protocolo de streaming propio para reproducir vídeos locales con soporte de
        // HTTP Range (seek instantáneo y archivos grandes). En Windows se sirve en
        // http://stream.localhost/<ruta>
        .register_uri_scheme_protocol("stream", |_ctx, request| streamer::handle(request))
        .manage(recorder_state)
        .manage(active_match_state)
        .manage(ult_state)
        .manage(video_settings)
        .invoke_handler(tauri::generate_handler![
            get_recorded_matches,
            delete_match,
            get_recorder_status,
            save_replay_clip,
            save_match_comments,
            sync_match_now,
            get_audio_status,
            get_ultimate_settings,
            set_ultimate_settings,
            start_manual_recording,
            stop_manual_recording,
            export_clip,
            export_error_clip,
            get_all_error_clips,
            update_error_note,
            add_error_event,
            delete_error_event,
            edit_error_event,
            get_all_clips,
            upload_clip,
            toggle_clip_favorite,
            get_video_settings,
            set_video_settings,
            get_app_config,
            set_app_config,
            get_disk_usage,
            storage::get_vod_reviews,
            storage::get_match_details,
            cv_analyzer::process_vod,
            cv_analyzer::cancel_vod
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Al cerrar la app, apagamos el servidor de grabación (cierra el proceso hijo libobs).
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<Arc<RecorderState>>() {
                    recorder::shutdown_recorder(&state);
                }
            }
        });
}
