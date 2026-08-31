mod riot_live_api;
mod attribution;
mod awareness;
mod baselines;
mod camera_input;
mod camera_snaps;
mod commands;
mod cv_analyzer;
mod app_update;
mod dataset_generator;
mod gank;
mod minimap;
mod obs_client;
mod occupancy;
mod overlay;
mod pressure;
mod proc;
mod recorder;
pub mod riot_api;
mod storage;
mod streamer;
mod training;
mod ultimate;
mod winprob;

use commands::{
    add_error_event, delete_error_event, delete_match, edit_error_event, export_clip,
    export_error_clip, get_all_clips, get_all_error_clips, get_app_config, get_audio_status,
    get_recorded_matches, get_recorder_status, get_video_settings,
    save_match_comments, save_replay_clip, set_app_config, set_error_clip_reviewed, set_event_reviewed, set_video_settings,
    sync_match_now,
    get_match_attribution,
    check_riot_key,
    get_match_pressure,
    process_match_minimap,
    get_minimap_status,
    cancel_match_minimap,
    spawn_background_monitor, start_manual_recording, stop_manual_recording, toggle_clip_favorite,
    update_error_note,
    upload_clip, get_disk_usage, ActiveMatchState,
};
use recorder::RecorderState;
use std::sync::Arc;
use training::TrainingState;
use ultimate::{spawn_keyboard_listener, UltState};

use tauri::{tray::TrayIconBuilder, menu::{Menu, MenuItem}, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Inicializar estados compartidos
    let recorder_state = Arc::new(RecorderState::default());
    let active_match_state = Arc::new(ActiveMatchState::default());
    let ult_state = Arc::new(UltState::default());
    let training_state = Arc::new(TrainingState::default());

    // Listener global de teclado y ratón: APM, estela del ratón y teclas de cámara
    // aliada. Solo lee eventos; nunca inyecta input en el juego.
    spawn_keyboard_listener(Arc::clone(&ult_state), Arc::clone(&training_state));

    let video_settings = Arc::new(std::sync::Mutex::new(
        crate::commands::VideoSettings::default(),
    ));

    // El monitor de fondo se lanza dentro de `setup` porque necesita un AppHandle
    // para emitir eventos al overlay del metrónomo.
    let monitor_deps = (
        Arc::clone(&recorder_state),
        Arc::clone(&active_match_state),
        Arc::clone(&ult_state),
        Arc::clone(&video_settings),
        Arc::clone(&training_state),
    );

    tauri::Builder::default()
        // El primero de todos, a propósito: si ya hay una instancia viva, esta se
        // muere aquí mismo y no llega a montar nada.
        //
        // Al cerrar la ventana la app no sale, se esconde en la bandeja (ver
        // `CloseRequested` más abajo). Sin esto, pulsar el acceso directo levantaba
        // un segundo proceso: dos ventanas, y —lo grave— dos monitores automáticos
        // peleándose por la misma partida y dos servidores de grabación.
        //
        // OJO en desarrollo: el candado es por identificador de la app, y la
        // compilación de dev usa el mismo que la instalada. Si tienes la app
        // empaquetada viva en la bandeja, `npm run tauri dev` se cerrará solo y te
        // pondrá al frente la ventana de la instalada. Sal de ella desde la bandeja
        // antes de arrancar dev.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(cv_analyzer::AnalyzerState::default())
        .manage(app_update::UpdateState::default())
        .setup(move |app| {
            // Antes de que nada lea la biblioteca: recoloca las partidas de versiones antiguas
            // que guardaban los ficheros sueltos en la raíz. Corre una sola vez por directorio.
            crate::storage::migrate_storage_layout();

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
                        // Y el análisis de minimapa, que ahora va sin consola: si no,
                        // se queda un Python invisible leyendo el vídeo.
                        minimap::cancelar_todo();
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

            // Detección automática de partidas (y, con ella, el entrenamiento en vivo).
            let (rec, active, ult, video, training) = monitor_deps;
            spawn_background_monitor(rec, active, ult, video, training, app.handle().clone());

            // Puesto de impacto de las partidas que se analizaron antes de que se
            // guardara: se calcula de lo que ya hay en disco, sin pedir nada.
            riot_api::spawn_impact_backfill();

            // Y las miradas al mapa, que salen de los clics ya grabados: las
            // partidas de antes también las tienen, sólo que nadie las había
            // leído. Ver `camera_input`.
            camera_input::spawn_backfill();

            // La actualización se descarga sola por detrás mientras usas la app, para
            // que pulsar "instalar" no sea esperar a que bajen 100 MB.
            app_update::spawn_background_check(app.handle().clone());
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
        // La actualización va en `installMode: "quiet"` (tauri.conf.json), que en
        // NSIS son los argumentos `/S /R`: instala sin abrir ninguna ventana y
        // relanza la app al acabar. El valor por defecto del plugin es `passive`
        // (`/P /R`), que sí enseña la ventana de progreso del instalador — eso era
        // "el instalador feo". No hace falta UAC porque instalamos por usuario, en
        // %LOCALAPPDATA%.
        //
        // Y el bundle sale solo como `nsis`: con `targets: "all"` se publicaba
        // además un MSI de 148 MB que caía en la clave genérica `windows-x86_64`
        // del latest.json. Hoy no se usa porque el plugin busca antes
        // `windows-x86_64-nsis` (el binario lleva grabado con qué se instaló), pero
        // si esa detección fallara el usuario se comería msiexec con UAC.
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
        .manage(training_state)
        .invoke_handler(tauri::generate_handler![
            get_recorded_matches,
            delete_match,
            get_recorder_status,
            save_replay_clip,
            save_match_comments,
            set_event_reviewed,
            set_error_clip_reviewed,
            sync_match_now,
            get_match_attribution,
            check_riot_key,
            get_match_pressure,
            process_match_minimap,
            get_minimap_status,
            cancel_match_minimap,
            get_audio_status,
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
            cv_analyzer::cancel_vod,
            training::get_training_config,
            training::set_training_config,
            training::get_drill_sessions,
            training::save_drill_session,
            awareness::generate_awareness_quiz,
            awareness::submit_awareness_quiz,
            awareness::list_awareness_records,
            awareness::get_champion_pool,
            camera_snaps::analyze_camera_snaps,
            camera_snaps::list_recall_frames,
            camera_snaps::get_camera_snap_summary,
            camera_snaps::get_camera_zones,
            camera_snaps::get_camera_looks,
            camera_snaps::get_blind_spot,
            overlay::preview_metronome_overlay,
            app_update::get_pending_update,
            app_update::install_pending_update,
            app_update::check_for_update_now
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Al cerrar la app, apagamos el servidor de grabación (cierra el proceso hijo libobs).
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<Arc<RecorderState>>() {
                    recorder::shutdown_recorder(&state);
                }
                minimap::cancelar_todo();
            }
        });
}
