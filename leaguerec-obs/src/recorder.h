// Recorder — encapsula el ciclo de vida de libobs y una grabación.
// Reutilizable tanto por el modo one-shot (smoke test) como por el servidor IPC.
#pragma once

#include <obs.h>
#include <string>

struct RecordConfig {
    std::string source = "game";   // "monitor" | "window" | "game"
    std::string window;            // título de ventana
    std::string cls;               // clase de ventana (DEBE ser no-vacía para WGC window capture)
    std::string exe;               // ejecutable
    std::string out;               // ruta del .mp4
    int fps = 60;
    int width = 1920;
    int height = 1080;
    int bitrate = 12000;           // kbps CBR
};

class Recorder {
public:
    // obs_startup + audio + carga de plugins desde el rundir. Una sola vez.
    bool init(const std::string &rundir, std::string &err);

    // Crea fuentes/encoders/output y arranca la grabación. No debe haber otra activa.
    bool start(const RecordConfig &cfg, std::string &err);

    // Arranca un replay buffer que mantiene los últimos `buffer_seconds` en memoria. Los clips se
    // guardan con save_replay(). El nombre de archivo se deriva de cfg.out (se usa su directorio).
    bool start_replay(const RecordConfig &cfg, int buffer_seconds, std::string &err);

    // Guarda los últimos N segundos del replay buffer a un archivo. Devuelve la ruta ("" si falla).
    std::string save_replay(std::string &err);

    // Detiene, espera el cierre del contenedor y libera. Devuelve la ruta grabada ("" si nada).
    std::string stop();

    bool active() const;

    // obs_shutdown (una vez, al cerrar el proceso).
    void shutdown();

private:
    bool reset_video(const RecordConfig &cfg, std::string &err);
    // Monta vídeo (escena+fuente escalada), audio y encoders si aún no existen. Idempotente:
    // grabación y replay buffer comparten la misma tubería y encoders.
    bool ensure_pipeline(const RecordConfig &cfg, std::string &err);

    std::string rundir_;
    bool started_ = false;         // obs_startup hecho
    bool modules_loaded_ = false;
    int cur_fps_ = 0, cur_w_ = 0, cur_h_ = 0;

    obs_scene_t *scene_ = nullptr;   // escala la fuente al lienzo (evita recorte)
    obs_source_t *video_src_ = nullptr;
    obs_source_t *audio_src_ = nullptr;
    obs_encoder_t *venc_ = nullptr;
    obs_encoder_t *aenc_ = nullptr;
    obs_output_t *output_ = nullptr;         // grabación continua (ffmpeg_muxer)
    obs_output_t *replay_output_ = nullptr;  // replay buffer (concurrente, encoders compartidos)
    std::string out_path_;
};
