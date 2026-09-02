// Recorder — encapsula el ciclo de vida de libobs y una grabación.
// Reutilizable tanto por el modo one-shot (smoke test) como por el servidor IPC.
#pragma once

#include <obs.h>

#include <atomic>
#include <climits>
#include <string>
#include <thread>

struct RecordConfig {
    std::string source = "game";   // "monitor" | "window" | "game"
    std::string window;            // título de ventana
    std::string cls;               // clase de ventana (DEBE ser no-vacía para WGC window capture)
    std::string exe;               // ejecutable
    std::string out;               // ruta del .mp4
    int fps = 60;
    int width = 1920;
    int height = 1080;
    int cqp = 23;                  // calidad constante (menor = mejor y más pesado). 20 ≈ visualmente
                                   // intacto, 26 ya se nota. Ver la nota de CQP en recorder.cpp.
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

    // ¿Hay ALGO emitiendo? (grabación continua o replay buffer).
    bool active() const;

    // Solo la grabación continua. Es la que hay que vigilar para saber si la
    // partida se está quedando sin vídeo: `active()` seguiría diciendo que sí
    // mientras el replay buffer aguantara, aunque el .mp4 hubiera muerto.
    bool recording() const;

    // ¿Se creó la fuente de audio de escritorio (loopback)? Lo pregunta el cliente
    // para no mentir en el estado de audio de la interfaz.
    bool has_audio() const { return audio_src_ != nullptr; }

    // obs_shutdown (una vez, al cerrar el proceso).
    void shutdown();

private:
    bool reset_video(const RecordConfig &cfg, std::string &err);
    // Monta vídeo (escena+fuente escalada), audio y encoders si aún no existen. Idempotente:
    // grabación y replay buffer comparten la misma tubería y encoders.
    bool ensure_pipeline(const RecordConfig &cfg, std::string &err);

    // Seguimiento del recorte de ventana (modo "window_crop"): un hilo repasa la
    // posición real de la ventana cada pocos segundos y actualiza el crop del
    // scene item. Sin esto, mover o redimensionar la ventana a media partida
    // dejaba la grabación desalineada para siempre (el crop se calculaba UNA
    // vez al arrancar).
    void start_crop_tracking();
    void stop_crop_tracking();

    // Repunta la captura al monitor cuyo origen es (x, y). Se llama cuando la
    // ventana del juego se ha movido a OTRA pantalla: sin esto seguíamos
    // capturando el monitor de siempre y recortando con coordenadas del nuevo,
    // así que la grabación quedaba en negro o cortada.
    void switch_capture_monitor(int origin_x, int origin_y);

    std::string rundir_;
    bool started_ = false;         // obs_startup hecho
    bool modules_loaded_ = false;
    int cur_fps_ = 0, cur_w_ = 0, cur_h_ = 0;

    obs_sceneitem_t *item_ = nullptr;      // el item de la fuente (dueña: la escena)
    std::string crop_window_;              // título que sigue el hilo de crop
    std::thread crop_thread_;
    std::atomic<bool> crop_run_{false};
    // Origen (esquina superior izquierda) del monitor que estamos capturando.
    // Es lo que identifica de forma estable a un monitor entre la lista de
    // propiedades de OBS y `MonitorFromWindow`. INT_MIN = aún sin fijar.
    std::atomic<int> cap_mon_x_{INT_MIN};
    std::atomic<int> cap_mon_y_{INT_MIN};

    obs_scene_t *scene_ = nullptr;   // escala la fuente al lienzo (evita recorte)
    obs_source_t *video_src_ = nullptr;
    obs_source_t *audio_src_ = nullptr;
    obs_encoder_t *venc_ = nullptr;
    obs_encoder_t *aenc_ = nullptr;
    obs_output_t *output_ = nullptr;         // grabación continua (ffmpeg_muxer)
    obs_output_t *replay_output_ = nullptr;  // replay buffer (concurrente, encoders compartidos)
    std::string out_path_;
};
