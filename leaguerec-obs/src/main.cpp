// leaguerec-obs — servidor de grabación headless sobre libobs.
//
// Dos modos:
//   1) One-shot (smoke test):   leaguerec-obs.exe --source monitor --out clip.mp4 --seconds 10
//   2) Servidor IPC (named pipe): leaguerec-obs.exe --pipe leaguerec-obs
//
// Protocolo IPC: mensajes JSON delimitados por '\n' sobre \\.\pipe\<nombre>.
//   -> {"cmd":"start","source":"game","window":"...","out":"C:\\...\\clip.mp4","fps":60,"bitrate":12000}
//   -> {"cmd":"stop"}      <- {"ok":true,"file":"C:\\...\\clip.mp4"}
//   -> {"cmd":"status"}    <- {"ok":true,"active":true}
//   -> {"cmd":"shutdown"}  <- {"ok":true}
// El JSON se parsea/serializa con obs_data (ya incluido en libobs).

#include <windows.h>

#include <obs.h>

#include <atomic>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>

#include "recorder.h"

namespace {

// ---- Logging de libobs a stderr ---------------------------------------------
void log_handler(int level, const char *format, va_list args, void *) {
    char buf[4096];
    vsnprintf(buf, sizeof(buf), format, args);
    const char *tag = "INFO";
    if (level <= LOG_ERROR) tag = "ERROR";
    else if (level <= LOG_WARNING) tag = "WARN";
    else if (level >= LOG_DEBUG) tag = "DEBUG";
    fprintf(stderr, "[obs %-5s] %s\n", tag, buf);
}

std::string obs_rundir() {
    const char *p = std::getenv("OBS_RUNDIR");
    return p ? std::string(p) : std::string();
}

std::string json_of(obs_data_t *d) {
    const char *j = obs_data_get_json(d);
    return j ? std::string(j) : std::string("{}");
}

// ---- Modo servidor IPC ------------------------------------------------------

// Procesa una línea de comando JSON y devuelve la respuesta JSON.
// Pone running=false si el comando es "shutdown".
std::string handle_command(Recorder &rec, const std::string &line, bool &running) {
    obs_data_t *in = obs_data_create_from_json(line.c_str());
    obs_data_t *out = obs_data_create();

    if (!in) {
        obs_data_set_bool(out, "ok", false);
        obs_data_set_string(out, "error", "json invalido");
        std::string s = json_of(out);
        obs_data_release(out);
        return s;
    }

    std::string cmd = obs_data_get_string(in, "cmd");

    if (cmd == "start") {
        RecordConfig cfg;
        const char *src = obs_data_get_string(in, "source");
        if (src && *src) cfg.source = src;
        cfg.window = obs_data_get_string(in, "window");
        cfg.exe = obs_data_get_string(in, "exe");
        cfg.out = obs_data_get_string(in, "out");
        obs_data_set_default_int(in, "fps", 60);
        obs_data_set_default_int(in, "width", 1920);
        obs_data_set_default_int(in, "height", 1080);
        obs_data_set_default_int(in, "bitrate", 12000);
        cfg.fps = static_cast<int>(obs_data_get_int(in, "fps"));
        cfg.width = static_cast<int>(obs_data_get_int(in, "width"));
        cfg.height = static_cast<int>(obs_data_get_int(in, "height"));
        cfg.bitrate = static_cast<int>(obs_data_get_int(in, "bitrate"));

        std::string err;
        if (cfg.out.empty()) {
            obs_data_set_bool(out, "ok", false);
            obs_data_set_string(out, "error", "falta 'out'");
        } else if (rec.start(cfg, err)) {
            obs_data_set_bool(out, "ok", true);
            obs_data_set_string(out, "file", cfg.out.c_str());
        } else {
            obs_data_set_bool(out, "ok", false);
            obs_data_set_string(out, "error", err.c_str());
        }
    } else if (cmd == "start_replay") {
        RecordConfig cfg;
        const char *src = obs_data_get_string(in, "source");
        if (src && *src) cfg.source = src;
        cfg.window = obs_data_get_string(in, "window");
        cfg.exe = obs_data_get_string(in, "exe");
        cfg.out = obs_data_get_string(in, "out");
        obs_data_set_default_int(in, "fps", 60);
        obs_data_set_default_int(in, "bitrate", 12000);
        obs_data_set_default_int(in, "buffer_seconds", 30);
        cfg.fps = static_cast<int>(obs_data_get_int(in, "fps"));
        cfg.bitrate = static_cast<int>(obs_data_get_int(in, "bitrate"));
        int buffer = static_cast<int>(obs_data_get_int(in, "buffer_seconds"));

        std::string err;
        if (cfg.out.empty()) {
            obs_data_set_bool(out, "ok", false);
            obs_data_set_string(out, "error", "falta 'out' (se usa su directorio)");
        } else if (rec.start_replay(cfg, buffer, err)) {
            obs_data_set_bool(out, "ok", true);
        } else {
            obs_data_set_bool(out, "ok", false);
            obs_data_set_string(out, "error", err.c_str());
        }
    } else if (cmd == "save_replay") {
        std::string err;
        std::string file = rec.save_replay(err);
        if (!file.empty()) {
            obs_data_set_bool(out, "ok", true);
            obs_data_set_string(out, "file", file.c_str());
        } else {
            obs_data_set_bool(out, "ok", false);
            obs_data_set_string(out, "error", err.c_str());
        }
    } else if (cmd == "stop" || cmd == "stop_replay") {
        std::string file = rec.stop();
        obs_data_set_bool(out, "ok", true);
        obs_data_set_string(out, "file", file.c_str());
    } else if (cmd == "status") {
        obs_data_set_bool(out, "ok", true);
        obs_data_set_bool(out, "active", rec.active());
    } else if (cmd == "shutdown") {
        obs_data_set_bool(out, "ok", true);
        running = false;
    } else {
        obs_data_set_bool(out, "ok", false);
        obs_data_set_string(out, "error", ("comando desconocido: " + cmd).c_str());
    }

    std::string s = json_of(out);
    obs_data_release(out);
    obs_data_release(in);
    return s;
}

int run_pipe_server(Recorder &rec, const std::string &pipeName) {
    std::string full = "\\\\.\\pipe\\" + pipeName;
    fprintf(stderr, "[leaguerec] servidor IPC en %s\n", full.c_str());

    bool running = true;
    while (running) {
        HANDLE pipe = CreateNamedPipeA(
            full.c_str(), PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            1, 64 * 1024, 64 * 1024, 0, nullptr);
        if (pipe == INVALID_HANDLE_VALUE) {
            fprintf(stderr, "FATAL: CreateNamedPipe falló (%lu)\n", GetLastError());
            return 1;
        }

        BOOL connected = ConnectNamedPipe(pipe, nullptr)
                             ? TRUE
                             : (GetLastError() == ERROR_PIPE_CONNECTED);
        if (!connected) {
            CloseHandle(pipe);
            continue;
        }
        fprintf(stderr, "[leaguerec] cliente conectado\n");

        std::string buf;
        char chunk[4096];
        DWORD n = 0;
        while (running && ReadFile(pipe, chunk, sizeof(chunk), &n, nullptr) && n > 0) {
            buf.append(chunk, n);
            size_t pos;
            while ((pos = buf.find('\n')) != std::string::npos) {
                std::string line = buf.substr(0, pos);
                buf.erase(0, pos + 1);
                if (!line.empty() && line.back() == '\r') line.pop_back();
                if (line.empty()) continue;
                std::string resp = handle_command(rec, line, running);
                resp.push_back('\n');
                DWORD w = 0;
                WriteFile(pipe, resp.data(), static_cast<DWORD>(resp.size()), &w, nullptr);
                if (!running) break;
            }
        }

        FlushFileBuffers(pipe);
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
        fprintf(stderr, "[leaguerec] cliente desconectado\n");
    }
    return 0;
}

// ---- Modo one-shot (smoke test) ---------------------------------------------
struct OneShot {
    RecordConfig cfg;
    int seconds = 10;
    bool replay = false;   // probar el replay buffer en vez de grabación continua
    int buffer = 30;       // segundos de buffer
};

int run_one_shot(Recorder &rec, const OneShot &o) {
    std::string err;
    if (o.replay) {
        if (!rec.start_replay(o.cfg, o.buffer, err)) {
            fprintf(stderr, "FATAL: %s\n", err.c_str());
            return 1;
        }
        fprintf(stderr, "[leaguerec] replay buffer activo (%ds), llenando %ds...\n", o.buffer,
                o.seconds);
        for (int i = 0; i < o.seconds; ++i)
            std::this_thread::sleep_for(std::chrono::seconds(1));
        std::string clip = rec.save_replay(err);
        fprintf(stderr, "[leaguerec] clip guardado -> %s (%s)\n", clip.c_str(),
                clip.empty() ? err.c_str() : "ok");
        rec.stop();
        return clip.empty() ? 1 : 0;
    }
    if (!rec.start(o.cfg, err)) {
        fprintf(stderr, "FATAL: %s\n", err.c_str());
        return 1;
    }
    fprintf(stderr, "[leaguerec] grabando -> %s\n", o.cfg.out.c_str());
    for (int i = 0; i < o.seconds && rec.active(); ++i)
        std::this_thread::sleep_for(std::chrono::seconds(1));
    std::string file = rec.stop();
    fprintf(stderr, "[leaguerec] detenido -> %s\n", file.c_str());
    return 0;
}

} // namespace

int main(int argc, char **argv) {
    base_set_log_handler(log_handler, nullptr);

    std::string pipeName;
    OneShot one;
    auto next = [&](int &i) -> std::string {
        return (i + 1 < argc) ? std::string(argv[++i]) : std::string();
    };
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--pipe")          pipeName = next(i);
        else if (a == "--source")   one.cfg.source = next(i);
        else if (a == "--window")   one.cfg.window = next(i);
        else if (a == "--class")    one.cfg.cls = next(i);
        else if (a == "--exe")      one.cfg.exe = next(i);
        else if (a == "--out")      one.cfg.out = next(i);
        else if (a == "--seconds")  one.seconds = std::atoi(next(i).c_str());
        else if (a == "--fps")      one.cfg.fps = std::atoi(next(i).c_str());
        else if (a == "--bitrate")  one.cfg.bitrate = std::atoi(next(i).c_str());
        else if (a == "--replay")   one.replay = true;
        else if (a == "--buffer")   one.buffer = std::atoi(next(i).c_str());
    }
    if (one.cfg.out.empty() && pipeName.empty())
        one.cfg.out = "leaguerec-smoke.mp4";
    if (one.cfg.source.empty())
        one.cfg.source = "monitor";

    Recorder rec;
    std::string err;
    if (!rec.init(obs_rundir(), err)) {
        fprintf(stderr, "FATAL: init: %s\n", err.c_str());
        return 1;
    }

    int rc;
    if (!pipeName.empty())
        rc = run_pipe_server(rec, pipeName);
    else
        rc = run_one_shot(rec, one);

    rec.stop(); // asegura el flush de cualquier salida activa (grabación/clip ya en disco)
    fprintf(stderr, "[leaguerec] fin\n");
    fflush(stderr);
    fflush(stdout);
    // Evitamos obs_shutdown(): en este proceso headless crashea en el teardown (0xC0000374) DESPUÉS
    // de que los archivos ya están escritos. Salimos en duro con código 0; el SO recupera el resto.
    ExitProcess(static_cast<UINT>(rc < 0 ? 1 : rc));
    return rc; // inalcanzable
}
