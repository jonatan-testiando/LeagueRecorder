#include "recorder.h"

#include <windows.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <thread>
#include <vector>

namespace {
// Calcula el recorte (en píxeles del monitor) para dejar solo el área cliente de la ventana `title`.
// Devuelve false si no encuentra la ventana. La captura debe ser del monitor que contiene la ventana.
bool compute_window_crop(const std::string &title, obs_sceneitem_crop *crop) {
    HWND hwnd = FindWindowA(nullptr, title.c_str());
    if (!hwnd) return false;
    RECT rc;
    if (!GetClientRect(hwnd, &rc)) return false;
    POINT tl = {rc.left, rc.top};
    POINT br = {rc.right, rc.bottom};
    ClientToScreen(hwnd, &tl);
    ClientToScreen(hwnd, &br);

    HMONITOR hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    MONITORINFO mi = {};
    mi.cbSize = sizeof(mi);
    if (!GetMonitorInfo(hmon, &mi)) return false;
    const int mon_w = mi.rcMonitor.right - mi.rcMonitor.left;
    const int mon_h = mi.rcMonitor.bottom - mi.rcMonitor.top;

    auto clamp0 = [](int v) { return v < 0 ? 0 : v; };
    crop->left = clamp0(tl.x - mi.rcMonitor.left);
    crop->top = clamp0(tl.y - mi.rcMonitor.top);
    crop->right = clamp0(mon_w - (br.x - mi.rcMonitor.left));
    crop->bottom = clamp0(mon_h - (br.y - mi.rcMonitor.top));
    return true;
}
} // namespace

namespace {

// Elige el mejor encoder de vídeo H.264 disponible.
//
// Se piden ids CONCRETOS y en orden de preferencia, no "el primero que contenga nvenc": el orden
// en que se registran los plugins no está garantizado (y en el runtime ensamblado obs-nvenc.dll
// llega a cargarse dos veces, ver los avisos "Encoder id already exists"), así que buscar por
// subcadena podía devolver el encoder por software o el shim antiguo en vez del bueno. Eso importa
// porque cada uno lee las opciones con nombres distintos: obs_nvenc_h264_tex usa "preset" y
// jim_nvenc usa "preset2".
std::string pick_h264_encoder() {
    std::vector<std::string> ids;
    const char *id = nullptr;
    for (size_t i = 0; obs_enum_encoder_types(i, &id); ++i) {
        if (!id) continue;
        const char *codec = obs_get_encoder_codec(id);
        if (codec && std::strcmp(codec, "h264") == 0)
            ids.emplace_back(id);
    }

    auto have = [&](const char *want) {
        return std::find(ids.begin(), ids.end(), want) != ids.end();
    };

    // De mejor a peor: NVENC por textura (zero-copy desde la GPU) > NVENC por CUDA > shim de
    // compatibilidad > AMD > Intel QSV > x264 (CPU, último recurso).
    static const char *const kPreferred[] = {
        "obs_nvenc_h264_tex", "obs_nvenc_h264_cuda", "obs_nvenc_h264_soft", "jim_nvenc",
        "h264_texture_amf",   "h264_fallback_amf",   "obs_qsv11_v2",        "obs_qsv11",
        "obs_x264",
    };
    for (const char *want : kPreferred)
        if (have(want)) return want;

    // GPU o versión de OBS que no contemplamos: cualquier cosa antes que fallar, pero avisando,
    // porque las opciones de calidad que mandamos abajo pueden no aplicarse.
    if (!ids.empty()) {
        fprintf(stderr, "[leaguerec] aviso: encoder H.264 desconocido '%s'; la calidad puede no aplicarse\n",
                ids.front().c_str());
        return ids.front();
    }
    return "obs_x264";
}

// Elige el encoder AV1 de NVIDIA si este runtime y esta GPU lo traen.
//
// AV1 a igual calidad visual pesa ~40-50% menos que h264, y el reproductor de
// la app es Chromium (WebView2), que lo decodifica nativo. Devuelve "" cuando
// no hay: entonces se sigue con h264 exactamente como siempre — AV1 es una
// mejora, nunca un requisito. Solo NVENC a propósito: es el único que hemos
// medido; un AV1 por CPU (svt/aom) arruinaría la partida en vivo.
std::string pick_av1_encoder() {
    const char *id = nullptr;
    std::vector<std::string> ids;
    for (size_t i = 0; obs_enum_encoder_types(i, &id); ++i) {
        if (!id) continue;
        const char *codec = obs_get_encoder_codec(id);
        if (codec && std::strcmp(codec, "av1") == 0)
            ids.emplace_back(id);
    }
    // NVIDIA > AMD > Intel. Los de AMD/Intel hoy no viajan en el runtime
    // empaquetado (solo se ensamblan obs-nvenc y obs-x264), pero se piden por
    // si algún día se añaden: enumerar un id que no existe no cuesta nada, y
    // así esas GPU entrarían a AV1 sin tocar este fichero.
    static const char *const kPreferred[] = {
        "obs_nvenc_av1_tex", "obs_nvenc_av1_cuda", "jim_av1_nvenc",
        "av1_texture_amf",   "av1_fallback_amf",   "obs_qsv11_av1",
    };
    for (const char *want : kPreferred)
        if (std::find(ids.begin(), ids.end(), want) != ids.end())
            return want;
    return "";
}

obs_source_t *make_video_source(const RecordConfig &cfg) {
    // "titulo:clase:exe". OJO: para window_capture WGC la clase NO puede ir vacía
    // (ms_find_window_top_level hace `if(!class) return NULL`). Con priority=título su valor
    // no necesita matchear, pero debe existir. Si no llega clase, ponemos un placeholder.
    std::string cls = cfg.cls.empty() ? std::string("Window") : cfg.cls;
    std::string win = cfg.window + ":" + cls + ":" + cfg.exe;

    if (cfg.source == "window") {
        // Captura de ventana vía Windows Graphics Capture (WGC). NO inyecta hook: inmune a
        // elevación/anti-cheat, y capta contenido D3D (BitBlt saldría negro). Es el mismo
        // mecanismo que usaba el motor WGC anterior, que funcionaba con esta ventana.
        obs_data_t *s = obs_data_create();
        obs_data_set_string(s, "window", win.c_str());
        obs_data_set_int(s, "method", 2);          // METHOD_WGC (0=auto, 1=BitBlt, 2=WGC)
        obs_data_set_int(s, "priority", 1);        // 1 = emparejar por título
        obs_data_set_bool(s, "cursor", true);
        obs_data_set_bool(s, "client_area", true); // solo área cliente (sin barra de título)
        obs_source_t *src = obs_source_create("window_capture", "gameplay", s, nullptr);
        obs_data_release(s);
        return src;
    }
    if (cfg.source == "game") {
        // game_capture engancha el swapchain vía graphics hook (menor overhead) pero requiere
        // inyección: puede fallar (negro) por elevación/anti-cheat. Se conserva como opción.
        obs_data_t *s = obs_data_create();
        obs_data_set_string(s, "capture_mode", "window");
        obs_data_set_string(s, "window", win.c_str());
        obs_data_set_int(s, "priority", 1);
        obs_data_set_bool(s, "capture_cursor", true);
        obs_data_set_bool(s, "anti_cheat_hook", true);
        obs_source_t *src = obs_source_create("game_capture", "gameplay", s, nullptr);
        obs_data_release(s);
        return src;
    }
    // monitor: captura de pantalla completa vía WGC. Funciona de forma fiable en headless
    // (window_capture WGC no captura sin un preview activo). Para League en fullscreen/borderless
    // esto graba el juego. Auto-seleccionamos el monitor: el pasado en --window (monitor_id), o
    // el primero de la lista de propiedades del source.
    obs_source_t *src = obs_source_create("monitor_capture", "display", nullptr, nullptr);
    // Para "window_crop" auto-seleccionamos el monitor (cfg.window es el título, no un monitor_id).
    std::string monitor_id = (cfg.source == "monitor") ? cfg.window : std::string();
    if (monitor_id.empty()) {
        obs_properties_t *props = obs_source_properties(src);
        obs_property_t *p = obs_properties_get(props, "monitor_id");
        if (p) {
            size_t n = obs_property_list_item_count(p);
            std::string first_real;
            for (size_t i = 0; i < n; ++i) {
                const char *nm = obs_property_list_item_name(p, i);
                const char *id = obs_property_list_item_string(p, i);
                if (!id || !*id || std::strcmp(id, "DUMMY") == 0) continue; // saltar placeholder
                if (first_real.empty()) first_real = id;
                // Preferimos el monitor primario (donde corren los juegos en fullscreen).
                if (nm && std::strstr(nm, "Primary")) { monitor_id = id; break; }
            }
            if (monitor_id.empty()) monitor_id = first_real;
        }
        obs_properties_destroy(props);
    }
    obs_data_t *s = obs_data_create();
    if (!monitor_id.empty()) obs_data_set_string(s, "monitor_id", monitor_id.c_str());
    obs_data_set_int(s, "method", 2); // WGC
    obs_data_set_bool(s, "capture_cursor", true);
    obs_source_update(src, s);
    obs_data_release(s);
    return src;
}

// ¿Apuntan las dos rutas al mismo directorio? Las resuelve a absolutas (las relativas, contra el
// directorio de trabajo actual, igual que hace libobs) y compara sin distinguir mayúsculas.
bool same_dir(const std::string &a, const std::string &b) {
    char fa[MAX_PATH], fb[MAX_PATH];
    if (!GetFullPathNameA(a.c_str(), MAX_PATH, fa, nullptr)) return false;
    if (!GetFullPathNameA(b.c_str(), MAX_PATH, fb, nullptr)) return false;
    return _stricmp(fa, fb) == 0;
}

} // namespace

bool Recorder::init(const std::string &rundir, std::string &err) {
    if (started_) return true;
    rundir_ = rundir;

    if (!obs_startup("en-US", nullptr, nullptr)) {
        err = "obs_startup falló";
        return false;
    }
    started_ = true;

    // CRÍTICO: inicializar el vídeo (D3D11) ANTES de cargar los módulos. El plugin win-capture
    // decide `wgc_supported` en su module_load consultando gs_get_device_type(); si el device D3D11
    // aún no existe, WGC queda deshabilitado para siempre y window/monitor capture caen a BitBlt,
    // que NO capta contenido D3D → pantalla negra. Con el vídeo listo antes, WGC se habilita.
    RecordConfig defaults;
    if (!reset_video(defaults, err)) {
        return false;
    }

    obs_audio_info oai = {};
    oai.samples_per_sec = 48000;
    oai.speakers = SPEAKERS_STEREO;
    if (!obs_reset_audio(&oai)) {
        err = "obs_reset_audio falló";
        return false;
    }

    if (rundir_.empty()) {
        err = "rundir vacío";
        return false;
    }
    // obs_startup ya registró la ruta relativa "../../obs-plugins/64bit" (add_default_module_paths
    // en obs-windows.c) y el servidor se ejecuta obligatoriamente desde bin/64bit, así que esa
    // relativa apunta al MISMO directorio que la nuestra. obs_add_module_path no deduplica, de modo
    // que cada plugin se cargaba dos veces: de ahí los avisos "Encoder id '...' already exists!
    // Duplicate library?" y que qué encoder ganaba dependiera del orden de registro.
    std::string plugin_bin = rundir_ + "/obs-plugins/64bit";
    std::string plugin_data = rundir_ + "/data/obs-plugins/%module%";
    if (!same_dir(plugin_bin, "../../obs-plugins/64bit"))
        obs_add_module_path(plugin_bin.c_str(), plugin_data.c_str());
    obs_load_all_modules();
    obs_post_load_modules();
    modules_loaded_ = true;
    return true;
}

bool Recorder::reset_video(const RecordConfig &cfg, std::string &err) {
    if (cur_fps_ == cfg.fps && cur_w_ == cfg.width && cur_h_ == cfg.height)
        return true;  // ya configurado igual

    obs_video_info ovi = {};
    ovi.graphics_module = "libobs-d3d11";
    ovi.fps_num = static_cast<uint32_t>(cfg.fps);
    ovi.fps_den = 1;
    ovi.base_width = static_cast<uint32_t>(cfg.width);
    ovi.base_height = static_cast<uint32_t>(cfg.height);
    ovi.output_width = static_cast<uint32_t>(cfg.width);
    ovi.output_height = static_cast<uint32_t>(cfg.height);
    ovi.output_format = VIDEO_FORMAT_NV12;
    ovi.colorspace = VIDEO_CS_709;
    ovi.range = VIDEO_RANGE_PARTIAL;
    ovi.adapter = 0;
    ovi.gpu_conversion = true;
    ovi.scale_type = OBS_SCALE_BICUBIC;

    int rc = obs_reset_video(&ovi);
    if (rc != OBS_VIDEO_SUCCESS) {
        err = "obs_reset_video falló (código " + std::to_string(rc) + ")";
        return false;
    }
    cur_fps_ = cfg.fps;
    cur_w_ = cfg.width;
    cur_h_ = cfg.height;
    return true;
}

bool Recorder::ensure_pipeline(const RecordConfig &cfg, std::string &err) {
    if (venc_) return true; // ya montado (grabación y replay comparten tubería)
    if (!reset_video(cfg, err)) return false;

    video_src_ = make_video_source(cfg);
    if (!video_src_) {
        err = "no se pudo crear la fuente de vídeo '" + cfg.source + "'";
        return false;
    }
    // Metemos la fuente en una escena con bounding box que la escala al lienzo (SCALE_INNER,
    // centrada). Así un monitor de mayor resolución (p.ej. 1440p) se escala completo al lienzo
    // 1080p en vez de recortarse. La escena, además, propaga "showing" a la fuente (crítico: las
    // fuentes de captura solo capturan si están "showing", no solo "active").
    scene_ = obs_scene_create("scene");
    obs_sceneitem_t *item = obs_scene_add(scene_, video_src_);
    struct vec2 bounds;
    vec2_set(&bounds, static_cast<float>(cur_w_), static_cast<float>(cur_h_));
    obs_sceneitem_set_bounds_type(item, OBS_BOUNDS_SCALE_INNER);
    obs_sceneitem_set_bounds_alignment(item, OBS_ALIGN_CENTER);
    obs_sceneitem_set_bounds(item, &bounds);

    // Modo "window_crop": capturamos el monitor pero recortamos a la región de la ventana de League,
    // así grabamos solo el juego aunque esté en modo ventana. El recorte se aplica sobre la fuente
    // (monitor) y luego el bounding box escala el resultado al lienzo. (window_capture WGC no funciona
    // en este proceso headless, de ahí este enfoque monitor+crop.)
    item_ = item;
    if (cfg.source == "window_crop") {
        obs_sceneitem_crop crop = {};
        if (compute_window_crop(cfg.window, &crop)) {
            obs_sceneitem_set_crop(item, &crop);
            fprintf(stderr, "[leaguerec] recorte ventana: L%d T%d R%d B%d\n", crop.left, crop.top,
                    crop.right, crop.bottom);
        } else {
            fprintf(stderr, "[leaguerec] ventana '%s' no encontrada; capturo el monitor completo\n",
                    cfg.window.c_str());
        }
        // El crop de arriba es la foto del ARRANQUE; el hilo lo mantiene al día
        // si la ventana se mueve o redimensiona a media partida (fase 5e).
        crop_window_ = cfg.window;
        start_crop_tracking();
    }

    obs_source_t *scene_src = obs_scene_get_source(scene_);
    obs_set_output_source(0, scene_src);
    obs_source_inc_showing(scene_src);

    audio_src_ = obs_source_create("wasapi_output_capture", "desktop-audio", nullptr, nullptr);
    if (audio_src_)
        obs_set_output_source(1, audio_src_);

    // AV1 primero si la GPU lo trae; h264 como siempre si no.
    std::string venc_id = pick_av1_encoder();
    const bool es_av1 = !venc_id.empty();
    if (!es_av1)
        venc_id = pick_h264_encoder();
    fprintf(stderr, "[leaguerec] encoder de video: %s\n", venc_id.c_str());

    obs_data_t *venc_settings = obs_data_create();
    // CQP y no CBR: el CBR gastaba el bitrate entero también en la tienda, la pantalla de muerte
    // y el mapa quieto, que es la mayor parte de una partida de LoL. Con calidad constante el
    // encoder solo gasta bits donde hay movimiento; a igual nitidez el archivo baja ~50-60%.
    obs_data_set_string(venc_settings, "rate_control", "CQP");
    // OJO con la escala: obs-nvenc multiplica este valor POR 4 para AV1
    // (nvenc.c: `cqp * 4`, hacia el qindex 0-255). El +4 está MEDIDO sobre una
    // pelea real de 15 s a 1080p60, con VMAF contra la fuente:
    //   h264 qp23:        15,9 MB  VMAF 95,5   (lo que grababa hasta ahora)
    //   AV1 +0 (q 92):    10,0 MB  VMAF 94,9   (-37%, calidad idéntica)
    //   AV1 +4 (q 108):    7,5 MB  VMAF 93,0   (-53%, imperceptible al revisar)
    //   AV1 +7 (q 120):    6,1 MB  VMAF 91,4   (el primer intento: se pasaba)
    obs_data_set_int(venc_settings, "cqp", es_av1 ? cfg.cqp + 4 : cfg.cqp);
    // El preset va por partida doble a propósito: el NVENC moderno (obs_nvenc_h264_tex) lee
    // "preset", pero el shim de compatibilidad (jim_nvenc) lee "preset2", y pick_h264_encoder()
    // puede devolver cualquiera de los dos. Además el valor DEBE ser p1..p7: get_nv_preset() no
    // reconoce nombres como "quality" y cae silenciosamente a P5 (era el caso hasta ahora).
    obs_data_set_string(venc_settings, "preset", "p6");
    obs_data_set_string(venc_settings, "preset2", "p6");
    obs_data_set_bool(venc_settings, "psycho_aq", true);
    venc_ = obs_video_encoder_create(venc_id.c_str(), "venc", venc_settings, nullptr);
    obs_data_release(venc_settings);
    obs_encoder_set_video(venc_, obs_get_video());

    obs_data_t *aenc_settings = obs_data_create();
    obs_data_set_int(aenc_settings, "bitrate", 160);
    aenc_ = obs_audio_encoder_create("ffmpeg_aac", "aenc", aenc_settings, 0, nullptr);
    obs_data_release(aenc_settings);
    obs_encoder_set_audio(aenc_, obs_get_audio());
    return true;
}

void Recorder::start_crop_tracking() {
    if (crop_run_) return;
    crop_run_ = true;
    crop_thread_ = std::thread([this] {
        obs_sceneitem_crop prev = {};
        bool have_prev = false;
        while (crop_run_) {
            // Cadencia de ~2 s, pero atentos al flag cada 100 ms para que stop()
            // no espere dos segundos a que el hilo se entere.
            for (int i = 0; i < 20 && crop_run_; ++i)
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            if (!crop_run_) break;

            HWND hwnd = FindWindowA(nullptr, crop_window_.c_str());
            // Minimizada: GetClientRect da un rectángulo sin sentido; se deja el
            // último crop bueno hasta que la ventana vuelva.
            if (!hwnd || IsIconic(hwnd)) continue;

            obs_sceneitem_crop c = {};
            if (!compute_window_crop(crop_window_, &c)) continue;
            if (have_prev && std::memcmp(&prev, &c, sizeof(c)) == 0) continue;
            obs_sceneitem_set_crop(item_, &c);
            if (have_prev)
                fprintf(stderr, "[leaguerec] recorte ventana actualizado: L%d T%d R%d B%d\n",
                        c.left, c.top, c.right, c.bottom);
            prev = c;
            have_prev = true;
        }
    });
}

void Recorder::stop_crop_tracking() {
    crop_run_ = false;
    if (crop_thread_.joinable()) crop_thread_.join();
}

bool Recorder::start(const RecordConfig &cfg, std::string &err) {
    if (output_) {
        err = "ya hay una grabación activa";
        return false;
    }
    if (!ensure_pipeline(cfg, err)) {
        stop();
        return false;
    }

    obs_data_t *out_settings = obs_data_create();
    obs_data_set_string(out_settings, "path", cfg.out.c_str());
    output_ = obs_output_create("ffmpeg_muxer", "recording", out_settings, nullptr);
    obs_data_release(out_settings);
    obs_output_set_video_encoder(output_, venc_);
    obs_output_set_audio_encoder(output_, aenc_, 0);

    if (!obs_output_start(output_)) {
        err = std::string("obs_output_start falló: ") +
              (obs_output_get_last_error(output_) ? obs_output_get_last_error(output_) : "?");
        obs_output_release(output_);
        output_ = nullptr;
        if (!replay_output_) stop(); // si no hay replay corriendo, limpiamos toda la tubería
        return false;
    }
    out_path_ = cfg.out;
    return true;
}

// Devuelve el directorio de una ruta de archivo (todo hasta la última '/' o '\\').
static std::string dir_of(const std::string &path) {
    size_t pos = path.find_last_of("/\\");
    return pos == std::string::npos ? std::string(".") : path.substr(0, pos);
}

bool Recorder::start_replay(const RecordConfig &cfg, int buffer_seconds, std::string &err) {
    if (replay_output_) {
        err = "el replay buffer ya está activo";
        return false;
    }
    if (!ensure_pipeline(cfg, err)) {
        stop();
        return false;
    }

    obs_data_t *s = obs_data_create();
    obs_data_set_string(s, "directory", dir_of(cfg.out).c_str());
    obs_data_set_string(s, "format", "replay_%CCYY-%MM-%DD_%hh-%mm-%ss");
    obs_data_set_string(s, "extension", "mp4");
    obs_data_set_int(s, "max_time_sec", buffer_seconds > 0 ? buffer_seconds : 30);
    obs_data_set_int(s, "max_size_mb", 0); // sin límite por tamaño
    replay_output_ = obs_output_create("replay_buffer", "replay", s, nullptr);
    obs_data_release(s);
    obs_output_set_video_encoder(replay_output_, venc_);
    obs_output_set_audio_encoder(replay_output_, aenc_, 0);

    if (!obs_output_start(replay_output_)) {
        err = std::string("no se pudo iniciar el replay buffer: ") +
              (obs_output_get_last_error(replay_output_) ? obs_output_get_last_error(replay_output_)
                                                         : "?");
        obs_output_release(replay_output_);
        replay_output_ = nullptr;
        if (!output_) stop(); // si no hay grabación corriendo, limpiamos la tubería
        return false;
    }
    return true;
}

std::string Recorder::save_replay(std::string &err) {
    if (!replay_output_) {
        err = "no hay replay buffer activo";
        return "";
    }
    proc_handler_t *ph = obs_output_get_proc_handler(replay_output_);

    // Ruta previa (para detectar cuándo aparece el nuevo clip; get_last_replay conserva el anterior).
    auto last_path = [&]() -> std::string {
        calldata_t cd = {};
        proc_handler_call(ph, "get_last_replay", &cd);
        const char *p = calldata_string(&cd, "path");
        std::string r = p ? p : "";
        calldata_free(&cd);
        return r;
    };
    std::string prev = last_path();

    calldata_t cd = {};
    proc_handler_call(ph, "save", &cd);
    calldata_free(&cd);

    // El guardado es asíncrono; esperamos a que get_last_replay cambie (máx ~5s).
    for (int i = 0; i < 50; ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        std::string cur = last_path();
        if (!cur.empty() && cur != prev) return cur;
    }
    err = "timeout guardando el replay";
    return "";
}

std::string Recorder::stop() {
    std::string file;
    auto stop_and_wait = [](obs_output_t *o) {
        if (!o) return;
        obs_output_stop(o);
        for (int i = 0; i < 100 && obs_output_active(o); ++i)
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
    };
    if (output_) file = out_path_;
    // Antes de desmontar la escena: el hilo de crop toca item_, que muere con ella.
    stop_crop_tracking();
    item_ = nullptr;
    stop_and_wait(output_);
    stop_and_wait(replay_output_);

    // Orden correcto: desasignar canales antes de liberar las fuentes.
    obs_set_output_source(0, nullptr);
    obs_set_output_source(1, nullptr);
    if (output_) { obs_output_release(output_); output_ = nullptr; }
    if (replay_output_) { obs_output_release(replay_output_); replay_output_ = nullptr; }
    if (venc_) { obs_encoder_release(venc_); venc_ = nullptr; }
    if (aenc_) { obs_encoder_release(aenc_); aenc_ = nullptr; }
    if (scene_) {
        obs_source_dec_showing(obs_scene_get_source(scene_)); // balancea el inc_showing
        obs_scene_release(scene_);                            // libera la escena (y la ref al item)
        scene_ = nullptr;
    }
    if (video_src_) {
        obs_source_release(video_src_);
        video_src_ = nullptr;
    }
    if (audio_src_) { obs_source_release(audio_src_); audio_src_ = nullptr; }
    out_path_.clear();
    return file;
}

bool Recorder::active() const {
    return (output_ && obs_output_active(output_)) ||
           (replay_output_ && obs_output_active(replay_output_));
}

void Recorder::shutdown() {
    if (active()) stop();
    if (started_) {
        obs_shutdown();
        started_ = false;
    }
}
