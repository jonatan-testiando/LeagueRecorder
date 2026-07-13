# leaguerec-obs

Motor de grabación nativo basado en **libobs** (patrón tipo *ascent-obs*): un proceso
C++ headless que corre libobs y graba el juego con captura a nivel GPU + NVENC/AMF/QSV,
controlado desde la app Tauri por IPC (named pipe).

Este directorio cubre **Fase 0** (compilar OBS) y **Fase 1** (servidor headless mínimo).
La capa IPC y la integración con Rust llegan en fases posteriores.

## Layout

```
leaguerec-obs/
  CMakeLists.txt          # proyecto del servidor headless
  cmake/FindLibObs.cmake  # localiza headers + libobs.lib del build de OBS
  src/main.cpp            # servidor mínimo: captura + NVENC -> mp4
  scripts/
    build-obs.ps1         # Fase 0: clona y compila OBS (pinned)
    build-server.ps1      # Fase 1: compila este servidor contra libobs
    run-dev.ps1           # ejecuta el servidor con el entorno correcto
```

## Requisitos (ya verificados en esta máquina)

- Visual Studio **Build Tools 2022** con workload C++ (MSVC 14.44) y Windows SDK 10.
- CMake + Ninja incluidos en Build Tools (los scripts los localizan solos vía `vswhere`).
- ~10 GB libres para el árbol y build de OBS.

## Uso

```powershell
# Fase 0 — compila OBS (largo: ~30-60 min, descarga varios GB la primera vez)
./scripts/build-obs.ps1

# Fase 1 — compila el servidor headless contra el libobs recién construido
./scripts/build-server.ps1

# Prueba de humo — graba 10s del monitor primario a un mp4 con NVENC
./scripts/run-dev.ps1 -Source monitor -Seconds 10 -Out "$env:USERPROFILE\Desktop\smoke.mp4"
```

## Empaquetado para producción

Para distribuir la app con su propio runtime de OBS (sin depender de `third_party/`):

```powershell
# Ensambla un runtime OBS mínimo autocontenido en src-tauri/obs-runtime/ (~105 MB)
./scripts/assemble-runtime.ps1

# Luego, el build normal de Tauri lo incluye como recurso (ver tauri.conf.json -> bundle.resources)
npm run tauri build
```

En producción, `recorder.rs` localiza el runtime vía `resource_dir()` (env `LEAGUEREC_OBS_RUNTIME`,
lo fija lib.rs) o junto al exe; en desarrollo usa el árbol `third_party/obs-studio`.

**Modos de captura del server** (`--source`): `monitor` (pantalla completa), `window_crop` (monitor
recortado a una ventana; `--window "<título>"`), `game` (game_capture, no fiable headless), `window`
(window_capture WGC, no captura headless). La app usa `window_crop` con la ventana de League.

## Versión de OBS

Fijada en `scripts/build-obs.ps1` (`$ObsVersion`). Se compila desde fuente para obtener
`obs.lib` + headers y poder enlazar nuestro servidor; los plugins (`win-capture`,
`obs-ffmpeg`/nvenc, `win-wasapi`) se toman del mismo build en runtime.
