mod riot_live_api;
mod spells;
mod ajustes_juego;
mod medida;
mod estela;
mod indice;
#[cfg(test)]
mod medida_banco;
mod attribution;
mod awareness;
mod escala;
mod backup;
mod baselines;
pub mod benchmarks;
mod camera_input;
mod camera_snaps;
mod carriles_campeon;
mod champ_select;
mod coach;
mod coach_baremos;
mod coach_plan;
mod commands;
mod curvas;
mod cv_analyzer;
mod estado_baremos;
mod estado_partida;
mod app_update;
mod dataset_generator;
mod gank;
mod gold;
mod track;
mod hud;
mod golpes;
mod franja;
mod oleadas;
mod barras;
mod hands;
mod jugadas;
mod jungle_records;
mod jungle_route;
mod lcu;
mod minimap;
mod muertes;
mod obs_client;
mod occupancy;
mod overlay;
mod pressure;
mod pressure_value;
mod proc;
mod recorder;
pub mod riot_api;
mod storage;
mod ddragon_cache;
mod streamer;
mod titulos;
mod titulos_baremos;
mod training;
mod ultimate;
mod winprob;
mod winsys;
mod visibilidad;
mod zonas;

use commands::{
    add_error_event, delete_error_event, delete_match, delete_matches, edit_error_event, export_clip,
    export_error_clip, get_all_clips, get_all_error_clips, get_app_config, get_audio_status,
    get_hotkeys, set_hotkeys,
    get_recorded_matches, get_recorded_matches_delta, get_recorder_status, get_video_settings,
    save_match_comments, save_replay_clip, set_app_config, set_error_clip_reviewed, set_event_reviewed, set_video_settings,
    sync_match_now,
    get_match_attribution,
    check_riot_key,
    get_match_pressure,
    get_match_benchmarks,
    process_match_minimap,
    get_minimap_status,
    cancel_match_minimap,
    get_minimap_batch,
    process_missing_minimaps,
    cancel_missing_minimaps,
    spawn_background_monitor, start_manual_recording, stop_manual_recording, toggle_clip_favorite,
    update_error_note,
    upload_clip, get_disk_usage, delete_clip, delete_error_clip, ActiveMatchState,
};
use recorder::RecorderState;
use std::sync::Arc;
use training::TrainingState;
use ultimate::{spawn_keyboard_listener, UltState};

use tauri::{tray::TrayIconBuilder, menu::{Menu, MenuItem}, Manager};

/// Saca la ventana principal al frente desde la bandeja.
///
/// Los `unwrap()` que había aquí tumbaban la app entera si la ventana ya no
/// estaba (cerrada por el SO, o durante el apagado): pulsar el icono de la
/// bandeja no puede ser una operación que mate el proceso.
fn mostrar_ventana(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("Bandeja: no hay ventana 'main' que mostrar.");
        return;
    };
    if let Err(e) = window.show() {
        eprintln!("Bandeja: no se pudo mostrar la ventana: {e}");
        return;
    }
    if let Err(e) = window.set_focus() {
        eprintln!("Bandeja: no se pudo enfocar la ventana: {e}");
    }
}

/// ¿Tema claro? El de la configuración o, con «sistema», el de Windows (del
/// registro: al principio de `run` aún no hay ventana a la que preguntar).
fn tema_claro() -> bool {
    match crate::storage::load_config().theme.as_str() {
        "light" => true,
        "dark" => false,
        _ => windows_en_claro(),
    }
}

#[cfg(windows)]
fn windows_en_claro() -> bool {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let w = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let clave = w("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
    let valor = w("AppsUseLightTheme");
    let mut dato: u32 = 0;
    let mut tam: u32 = std::mem::size_of::<u32>() as u32;
    let r = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            clave.as_ptr(),
            valor.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut dato as *mut u32 as *mut _,
            &mut tam,
        )
    };
    r == 0 && dato == 1
}

#[cfg(not(windows))]
fn windows_en_claro() -> bool {
    false
}

/// El color de fondo del tema (`--ground` en index.css).
fn fondo_del_tema(claro: bool) -> (u8, u8, u8) {
    if claro { (0xe4, 0xe4, 0xe7) } else { (0x11, 0x11, 0x14) }
}

/// El fondo con el que NACE WebView2, antes de que la página pinte: lo lee de
/// esta variable al crear su control. wry solo le pasa uno si viene en
/// tauri.conf.json, y uno fijo ahí daba un fotograma oscuro en el tema claro
/// (o blanco en el oscuro, sin ninguno). Tiene que ir antes de que Tauri cree
/// la ventana.
fn preparar_fondo_de_webview2() {
    let (r, g, b) = fondo_del_tema(tema_claro());
    std::env::set_var("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", format!("FF{r:02X}{g:02X}{b:02X}"));
}

/// El fondo de la ventana del color del tema: lo que se ve antes de que pinte
/// WebView2 y al agrandar la ventana.
fn pintar_fondo_del_tema(app: &tauri::AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let (r, g, b) = fondo_del_tema(tema_claro());
    if let Err(e) = w.set_background_color(Some(tauri::window::Color(r, g, b, 0xff))) {
        eprintln!("No se pudo poner el fondo del tema a la ventana: {e}");
    }
}

/// Los tres barridos del arranque, en UNA tarea y en orden.
///
/// Eran tres hilos sueltos lanzados a la vez, y los tres empezaban por
/// `load_all_matches()`: al abrir la app se leía la biblioteca entera tres
/// veces en paralelo —el de cámara, además, abría el metadata COMPLETO de cada
/// partida (estela del ratón incluida) y lo reescribía hubiera cambiado algo o
/// no—. Con una biblioteca grande eso es el arranque entero peleándose consigo
/// mismo justo cuando el usuario quiere ver su lista.
///
/// El orden importa: la migración recoloca ficheros que los otros dos van a
/// leer, y el de impacto va el último por ser el más caro. Cada etapa cede el
/// hilo entre partidas y sella lo que repasa, así que el segundo lanzamiento no
/// hace nada. El progreso sale por el evento `library_maintenance`.
fn spawn_library_maintenance(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Antes de que nada lea la biblioteca: recoloca las partidas de versiones
        // antiguas que guardaban los ficheros sueltos en la raíz. Corre una sola
        // vez por directorio (deja su propia marca en disco).
        commands::emit_maintenance(&app, "migration", 0, 0);
        {
            let _t = crate::medida::Tramo::nuevo("arranque/migrate_storage_layout");
            crate::storage::migrate_storage_layout();
        }

        // La estela del ratón sale del JSON a su fichero (`estela.bin`). Va
        // antes que las miradas porque esas leen la estela entera. Una vez por
        // partida: las ya pasadas se saltan sin leer nada.
        {
            let _t = crate::medida::Tramo::nuevo("arranque/migrar_estelas");
            let app2 = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                crate::storage::migrar_estelas(|i, n| commands::emit_maintenance(&app2, "trail", i, n))
            })
            .await;
        }

        // Lo que sigue repasa la biblioteca ENTERA (cada partida y su informe de
        // miradas) solo para ver sus sellos: 0,4-0,7 s en cada arranque, y 5,5 s
        // con la caché de disco fría, a la vez que se leía la lista de Hoy (que
        // pasaba de 0,2 a 2,7 s; medido el 2026-11-21). Si la biblioteca está
        // igual que la última vez que se repasó entera, no hay nada que hacer.
        let firma = tauri::async_runtime::spawn_blocking(crate::indice::firma_biblioteca)
            .await
            .unwrap_or_default();
        if !firma.is_empty() && crate::indice::mantenimiento_hecho(&firma) {
            crate::medida::anotar("arranque/mantenimiento", 0.0, "biblioteca sin cambios");
            commands::emit_maintenance(&app, "done", 0, 0);
            return;
        }
        // Y si hay que hacerlo, después de la primera lista de Hoy.
        commands::esperar_primera_lista(std::time::Duration::from_secs(10)).await;

        // Las miradas al mapa salen de los clics ya grabados: las partidas de
        // antes también las tienen, sólo que nadie las había leído.
        {
            let _t = crate::medida::Tramo::nuevo("arranque/camera_input::backfill");
            camera_input::backfill(&app).await;
        }

        // Puesto de impacto de las partidas que se analizaron antes de que se
        // guardara: se calcula de lo que ya hay en disco, sin pedir nada.
        {
            let _t = crate::medida::Tramo::nuevo("arranque/impact_backfill");
            riot_api::impact_backfill(&app).await;
        }

        // La firma de después: lo que se acaba de escribir ya cuenta.
        if let Ok(despues) = tauri::async_runtime::spawn_blocking(crate::indice::firma_biblioteca).await {
            if !despues.is_empty() {
                crate::indice::marcar_mantenimiento(&despues);
            }
        }

        commands::emit_maintenance(&app, "done", 0, 0);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    crate::medida::arranque();
    preparar_fondo_de_webview2();
    // Inicializar estados compartidos
    let recorder_state = Arc::new(RecorderState::default());
    let active_match_state = Arc::new(ActiveMatchState::default());
    let ult_state = Arc::new(UltState::default());
    let training_state = Arc::new(TrainingState::default());

    let video_settings = Arc::new(std::sync::Mutex::new(
        crate::commands::VideoSettings::default(),
    ));

    // El monitor de fondo y el listener global se lanzan dentro de `setup` porque
    // necesitan un AppHandle: el monitor para el overlay del metrónomo, y el
    // listener para avisar de que un clip de replay se guardó (o falló).
    let monitor_deps = (
        Arc::clone(&recorder_state),
        Arc::clone(&active_match_state),
        Arc::clone(&ult_state),
        Arc::clone(&video_settings),
        Arc::clone(&training_state),
    );
    let listener_deps = (
        Arc::clone(&ult_state),
        Arc::clone(&training_state),
        Arc::clone(&recorder_state),
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
            let _t_setup = crate::medida::Tramo::nuevo("arranque/setup");
            // La ventana nace oculta ("visible": false en tauri.conf.json). Antes
            // se enseñaba nada más crearse, medio segundo antes de llegar aquí:
            // blanca (el fondo por defecto de Windows y de WebView2) y luego
            // con un rectángulo blanco al tamaño viejo cuando la escala la
            // agrandaba (medido capturando la pantalla: blanca de 70 a 450 ms y
            // la bienvenida a los 650). Ahora: el fondo del tema, el tamaño, y
            // entonces se enseña, ya del color de la bienvenida.
            pintar_fondo_del_tema(app.handle());
            // El tamaño de la interfaz, antes de que pinte la página.
            {
                let _t = crate::medida::Tramo::nuevo("arranque/escala");
                escala::aplicar(app.handle(), true);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }

            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Open Recorder", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            // Sin icono por defecto no hay bandeja, pero tampoco hay motivo para
            // tumbar la app entera: sin `unwrap` la ventana sigue funcionando.
            let icono = app
                .default_window_icon()
                .cloned()
                .ok_or("la app no trae icono por defecto para la bandeja")?;
            let _tray = TrayIconBuilder::new()
                .icon(icono)
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
                    "show" => mostrar_ventana(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        mostrar_ventana(tray.app_handle());
                    }
                })
                .build(app)?;

            // En producción, el runtime de OBS va empaquetado bajo el resource dir; exponemos su
            // ruta a recorder.rs para que lance el server desde ahí (en dev usa third_party).
            if let Ok(res) = app.path().resource_dir() {
                std::env::set_var("LEAGUEREC_OBS_RUNTIME", res.join("obs-runtime"));
            }

            // Listener global de teclado y ratón: APM, estela del ratón, teclas de
            // cámara aliada y el atajo del replay. Solo lee eventos; nunca inyecta
            // input en el juego.
            let (l_ult, l_training, l_rec) = listener_deps;
            spawn_keyboard_listener(l_ult, l_training, l_rec, app.handle().clone());

            // Detección automática de partidas (y, con ella, el entrenamiento en vivo).
            let (rec, active, ult, video, training) = monitor_deps;
            spawn_background_monitor(rec, active, ult, video, training, app.handle().clone());

            // El cliente de League (LCU): fase de gameflow, gameId y cola. Solo
            // lectura; el monitor de partida lo consulta al etiquetar la grabación.
            lcu::spawn_monitor(app.handle().clone());

            // Mantenimiento de la biblioteca: migración, miradas e impacto.
            spawn_library_maintenance(app.handle().clone());

            // La actualización se descarga sola por detrás mientras usas la app, para
            // que pulsar "instalar" no sea esperar a que bajen 100 MB.
            app_update::spawn_background_check(app.handle().clone());

            // Récords de primer clear de la hoja comunitaria: copia local, al día.
            jungle_records::spawn_refresco();

            // Que WebView2 sepa cuándo la ventana no se ve (minimizada, en la
            // bandeja o con el juego delante) y deje de pintar y animar.
            visibilidad::vigilar(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Con el foco, se ve; al perderlo, restaurarla o moverla se mira al
            // momento (visibilidad.rs además escucha a Windows directamente).
            tauri::WindowEvent::Focused(true) if window.label() == "main" => {
                visibilidad::al_enfocar(window.app_handle());
            }
            tauri::WindowEvent::Focused(false) | tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_)
                if window.label() == "main" =>
            {
                visibilidad::revisar(window.app_handle());
            }
            tauri::WindowEvent::CloseRequested { api, .. } => {
                // Si esconderla falla, se deja cerrar: mejor eso que un pánico en
                // el hilo de eventos con la ventana a medio camino.
                match window.hide() {
                    Ok(()) => {
                        api.prevent_close();
                        visibilidad::revisar(window.app_handle());
                    }
                    Err(e) => eprintln!("No se pudo esconder la ventana en la bandeja: {e}"),
                }
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
        // Caché local de Data Dragon: los iconos se sirven de disco y solo se
        // descargan la primera vez, así que la interfaz funciona sin conexión.
        // En Windows se sirve en http://ddragon.localhost/<ruta-del-cdn>.
        // Asíncrono porque el primer acceso descarga y no puede bloquear el
        // hilo del webview.
        .register_asynchronous_uri_scheme_protocol("ddragon", |_ctx, request, responder| {
            tauri::async_runtime::spawn(async move {
                responder.respond(ddragon_cache::handle(request).await);
            });
        })
        .manage(recorder_state)
        .manage(active_match_state)
        .manage(ult_state)
        .manage(video_settings)
        .manage(training_state)
        .invoke_handler(tauri::generate_handler![
            get_recorded_matches, get_recorded_matches_delta,
            delete_match,
            delete_matches,
            get_recorder_status,
            save_replay_clip,
            save_match_comments,
            set_event_reviewed,
            set_error_clip_reviewed,
            sync_match_now,
            get_match_attribution,
            check_riot_key,
            get_match_pressure,
            get_match_benchmarks,
            process_match_minimap,
            get_minimap_status,
            cancel_match_minimap,
            get_minimap_batch,
            process_missing_minimaps,
            cancel_missing_minimaps,
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
            delete_clip,
            delete_error_clip,
            toggle_clip_favorite,
            get_video_settings,
            set_video_settings,
            get_app_config,
            set_app_config,
            escala::get_ui_scale,
            ajustes_juego::get_minimap_detection,
            get_disk_usage,
            lcu::get_lcu_status,
            champ_select::get_champ_select,
            champ_select::champ_select_bring_forward,
            backup::export_backup,
            backup::import_backup,
            get_hotkeys,
            set_hotkeys,
            storage::get_vod_reviews,
            storage::get_match_details,
            storage::get_match_trail,
            indice::rebuild_index,
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
            jungle_route::get_jungle_route,
            jungle_route::get_jungle_routes,
            jungle_records::get_jungle_records,
            jungle_records::get_jungle_clear_catalog,
            gold::get_gold_report,
            track::get_match_track,
            track::export_route_video,
            hud::read_match_hud,
            golpes::get_hits_taken,
            jugadas::get_match_plays,
            coach::get_coach_summary,
            coach::get_match_coach,
            estado_partida::get_game_states,
            titulos::get_match_titles,
            coach_plan::get_coach_plan,
            coach_plan::start_coach_plan,
            coach_plan::abandon_coach_plan,
            golpes::get_hits_taken_career,
            franja::get_episode_strip,
            curvas::get_minute_series,
            oleadas::get_waves,
            oleadas::get_waves_career,
            barras::get_aim,
            hands::get_hand_career,
            camera_snaps::get_camera_zone_history,
            hands::get_hand_report,
            spells::get_spell_autopsy,
            spells::get_spell_diet,
            riot_api::get_pressure_summary,
            riot_api::get_season_form,
            riot_api::get_current_rank,
            overlay::preview_metronome_overlay,
            app_update::get_pending_update,
            app_update::install_pending_update,
            app_update::check_for_update_now
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Ready = event {
                crate::medida::anotar("arranque/bucle_listo", 0.0, "");
            }
            // Al cerrar la app, apagamos el servidor de grabación (cierra el proceso hijo libobs).
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<Arc<RecorderState>>() {
                    recorder::shutdown_recorder(&state);
                }
                minimap::cancelar_todo();
            }
        });
}
