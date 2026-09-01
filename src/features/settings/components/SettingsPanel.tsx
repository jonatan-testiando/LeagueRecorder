import React, { useState, useEffect } from "react";
import { getRecorderStatus, startManualRecording, stopManualRecording, getAudioStatus, getVideoSettings, setVideoSettings, getAppConfig, setAppConfig, checkRiotKey, AppConfig } from "../../../core/tauri-ipc";
import { AudioStatus, VideoSettings } from "../../../types";
import { RefreshCw } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useDialog } from "../../../components/ui/DialogProvider";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdateNow, getPendingUpdate, installPendingUpdate, onUpdateProgress, onUpdateReady, type PendingUpdate } from "../../../core/updates";
import { useLang } from "../../../core/LanguageProvider";
import { LANGUAGES, type Language } from "../../../core/i18n";

// Mismos límites que aplica el backend (`storage::MIN_STORAGE_GB` y el clamp de
// `set_app_config`). Los dos campos gobiernan borrados de ficheros, así que un 0
// colado por un campo vacío significaría "vacía la biblioteca".
const MIN_STORAGE_GB = 10;
const MAX_STORAGE_GB = 100_000;
const MAX_PRUNE_DAYS = 3650;

const clampStorageGb = (raw: string): number => {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return MIN_STORAGE_GB;
  return Math.min(Math.max(n, MIN_STORAGE_GB), MAX_STORAGE_GB);
};

const clampPruneDays = (raw: string): number => {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), MAX_PRUNE_DAYS);
};

/** Escala del minimapa en % (100 = estándar). Misma cota que el backend. */
const clampMinimapPct = (raw: string): number => {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 100;
  return Math.min(Math.max(n, 50), 200);
};

export const SettingsPanel: React.FC = () => {
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [manualId, setManualId] = useState<string>("");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [audio, setAudio] = useState<AudioStatus | null>(null);
  const [audioLoading, setAudioLoading] = useState<boolean>(false);
  const [video, setVideo] = useState<VideoSettings>({ fps: 60, quality: "High" });
  const [config, setConfig] = useState<AppConfig>({ save_directory: "", riot_api_key: "", auto_dataset_generator: false, max_storage_gb: 100, auto_prune_days: 0, language: "en", minimap_scale: 1 });
  // Los dos campos numéricos se editan como texto: si se guardara el `Number()` de
  // cada pulsación, vaciar el campo enviaría un 0 al backend. Se acotan al salir.
  const [storageDraft, setStorageDraft] = useState<string>("100");
  const [pruneDraft, setPruneDraft] = useState<string>("0");
  const [minimapDraft, setMinimapDraft] = useState<string>("100");
  // El disco es lo primero que se mira al entrar aqui y no se estaba pidiendo:
  // la cuota se ajustaba a ciegas, sin saber cuanto se lleva usado.
  const [disk, setDisk] = useState<{ used_bytes: number; total_bytes: number } | null>(null);
  const [updateMsg, setUpdateMsg] = useState<string>("");
  const [isUpdating, setIsUpdating] = useState<boolean>(false);
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  // El instalador corre en silencio y la app se cierra sola para poder
  // reemplazar su .exe: sin este velo son unos segundos en negro que parecen
  // un cuelgue.
  const [isInstalling, setIsInstalling] = useState<boolean>(false);
  const [appVersion, setAppVersion] = useState<string>("");
  // Lo que el backend ya ha bajado por su cuenta y espera a que digas cuándo.
  const [pending, setPending] = useState<PendingUpdate | null>(null);
  const { showError, showSuccess } = useDialog();
  const { lang, setLang, t } = useLang();

  const checkStatus = async () => {
    try {
      const status = await getRecorderStatus();
      setIsRecording(status);
    } catch (err) {
      console.error(err);
    }
  };

  const refreshAudio = async () => {
    setAudioLoading(true);
    try {
      setAudio(await getAudioStatus());
    } catch (err) {
      console.error(err);
    } finally {
      setAudioLoading(false);
    }
  };

  const saveVideo = async (fps: number, quality: string) => {
    try {
      setVideo(await setVideoSettings(fps, quality));
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    checkStatus();
    refreshAudio();
    getVideoSettings().then(setVideo).catch(console.error);
    invoke<{ used_bytes: number; total_bytes: number }>("get_disk_usage").then(setDisk).catch(() => {});
    getVersion().then(setAppVersion).catch(console.error);
    getPendingUpdate().then(setPending).catch(() => {});
    getAppConfig()
      .then(c => {
        setConfig(c);
        setStorageDraft(String(c.max_storage_gb));
        setPruneDraft(String(c.auto_prune_days));
        setMinimapDraft(String(Math.round((c.minimap_scale ?? 1) * 100)));
      })
      .catch(console.error);
    // La descarga la arranca el backend por su cuenta: si ocurre mientras estás
    // mirando esta pantalla, la barra se mueve sin que hayas pulsado nada.
    const stopProgress = onUpdateProgress(({ percent }) => {
      setIsDownloading(percent < 100);
      setDownloadProgress(percent);
      setUpdateMsg(`${t("Downloading…")} ${percent}%`);
    });
    const stopReady = onUpdateReady((u) => {
      setIsDownloading(false);
      setUpdateMsg("");
      setPending(u);
    });
    const interval = setInterval(checkStatus, 2000);
    return () => {
      clearInterval(interval);
      stopProgress.then((f) => f()).catch(() => {});
      stopReady.then((f) => f()).catch(() => {});
    };
  }, []);

  // Estado de la clave de Riot: null = sin comprobar. Existe porque una clave
  // que no se guarda o que no sirve era invisible hasta que fallaba algo mucho
  // despues, con un error que no la señalaba.
  const [keyState, setKeyState] = useState<"saving" | "ok" | "bad" | null>(null);
  const [keyMsg, setKeyMsg] = useState<string>("");

  const handleSaveConfig = async (c: AppConfig) => {
    setConfig(c);
    // `c.language` iba sin pasar y caia al valor por defecto "en": guardar la
    // clave te reseteaba el idioma a ingles sin decir nada.
    try {
      await setAppConfig(
        c.save_directory,
        c.riot_api_key,
        c.auto_dataset_generator,
        c.max_storage_gb,
        c.auto_prune_days,
        c.language,
        c.minimap_scale ?? 1,
      );
    } catch (e) {
      // Antes esto era un console.error: el fallo no salia de la consola.
      setKeyState("bad");
      setKeyMsg(String(e));
      throw e;
    }
  };

  const handlePickDirectory = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: config.save_directory || undefined,
    });
    if (selected === null) {
      return;
    } else {
      handleSaveConfig({ ...config, save_directory: selected as string });
    }
  };

  const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setConfig({ ...config, riot_api_key: e.target.value });
  };

  // Guarda y, acto seguido, le pregunta a Riot si la clave sirve. Guardar sin
  // comprobar es lo que dejaba al usuario creyendo que estaba lista.
  const handleApiKeyBlur = async () => {
    if (!config.riot_api_key.trim()) {
      setKeyState(null);
      return;
    }
    setKeyState("saving");
    setKeyMsg("");
    try {
      await handleSaveConfig(config);
      await checkRiotKey();
      setKeyState("ok");
    } catch (e) {
      setKeyState("bad");
      setKeyMsg(String(e).replace(/^Error:\s*/, ""));
    }
  };

  // Sin esto la clave sólo se guardaba al perder el foco: quien la pegaba y salía
  // del panel directo se quedaba sin guardarla, y sin ningún aviso.
  const handleApiKeyKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    }
  };

  const handleStartManual = async () => {
    if (!manualId.trim()) {
      showError("Por favor introduce un ID o nombre para la prueba manual");
      return;
    }
    
    setIsProcessing(true);
    setStatusMsg("Starting test recording…");
    try {
      await startManualRecording(manualId.trim());
      setIsRecording(true);
      setStatusMsg("Recording in progress. You can use your PC.");
    } catch (err) {
      setStatusMsg("Error: " + err);
      showError("Failed to start: " + err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleStopManual = async () => {
    setIsProcessing(true);
    setStatusMsg("Stopping and saving clip…");
    try {
      await stopManualRecording();
      setIsRecording(false);
      setStatusMsg("Clip saved successfully. Check the 'Games' section.");
      setManualId("");
      showSuccess("Clip saved successfully.");
    } catch (err) {
      setStatusMsg("Failed to stop: " + err);
      showError("Failed to stop: " + err);
    } finally {
      setIsProcessing(false);
    }
  };

  /** Comprobar a mano. El backend deja el paquete descargado, no lo instala. */
  const checkForUpdates = async () => {
    setIsUpdating(true);
    setUpdateMsg(t("Checking for updates…"));
    try {
      const found = await checkForUpdateNow();
      if (found) {
        setPending(found);
        setUpdateMsg("");
      } else {
        setUpdateMsg(t("Your app is already on the latest version."));
        showSuccess(t("Your app is already up to date."));
      }
    } catch (err) {
      console.error(err);
      setUpdateMsg(t("Failed to check for updates."));
      showError("Update error: " + err);
    } finally {
      setIsUpdating(false);
      setIsDownloading(false);
    }
  };

  /** Instalar lo ya descargado: son segundos, y la app vuelve sola. */
  const installUpdate = async () => {
    setIsInstalling(true);
    setUpdateMsg(t("Installing update…"));
    try {
      // En Windows esto no vuelve: el instalador toma el relevo y mata el proceso.
      await installPendingUpdate();
    } catch (err) {
      console.error(err);
      // Si falla, el proceso sigue vivo: hay que quitar el velo o la ventana se
      // queda tapada para siempre.
      setIsInstalling(false);
      setPending(null);
      setUpdateMsg(t("Failed to check for updates."));
      showError("Update error: " + err);
    }
  };

  const audioReady = audio?.ready_for_game_audio ?? false;
  const usedGb = disk ? (disk.used_bytes / 1024 ** 3).toFixed(1) : null;
  const diskPct = disk && disk.total_bytes > 0 ? Math.round((disk.used_bytes / disk.total_bytes) * 100) : null;

  /** Fila de ajuste: etiqueta y descripcion a la izquierda, control a la derecha. */
  const Row: React.FC<{ label: string; desc?: string; children: React.ReactNode }> = ({ label, desc, children }) => (
    <div className="drow drow--set">
      <div>
        <span className="drow__label">{label}</span>
        {desc && <span className="drow__desc">{desc}</span>}
      </div>
      <div className="drow__control">{children}</div>
    </div>
  );

  return (
    <div className="setpage panel-enter">
      {isInstalling && (
        <div className="updv" role="status" aria-live="polite">
          <div className="updv__card">
            <RefreshCw size={22} color="var(--cool)" style={{ margin: "0 auto", animation: "spin 1s linear infinite" }} />
            <span className="updv__title">{t("Installing update…")}</span>
            <span className="updv__note">
              {t("The app will close and reopen by itself when it finishes. Do not close it.")}
            </span>
          </div>
        </div>
      )}

      <header>
        <h1 style={{ margin: 0, fontSize: "var(--font-xl)" }}>{t("Settings")}</h1>
        <p className="note">{t("What the recorder does, where it saves, and how it talks to Riot.")}</p>
      </header>

      {/* ------------------------------------------------------------ estado
          Antes esto estaba repartido en tres tarjetas ("Listo para grabar
          sonido", "Requisitos del sistema", "Deteccion de partidas") mezcladas
          con los ajustes de verdad. Pero el estado no se ajusta: se comprueba.
          Va arriba, en una tira, y contesta "esta todo listo" de un vistazo. */}
      <section className="status">
        <div className="status__item">
          <span className={isRecording ? "rec-dot" : "status__dot"} data-tone="idle" />
          <span className="status__label">{t("Recorder")}</span>
          <span className="status__value">{isRecording ? t("Recording") : t("Idle")}</span>
        </div>

        <div className="status__item">
          <span className="status__dot" data-tone={audioReady ? "ok" : "warn"} />
          <span className="status__label">{t("Game sound")}</span>
          <span className="status__value" title={audio?.system_audio_device ?? undefined}>
            {audioReady ? audio?.system_audio_device : t("No capture device")}
          </span>
          <button className="btn btn--ghost btn--sm" onClick={refreshAudio} disabled={audioLoading}>
            <RefreshCw size={12} style={audioLoading ? { animation: "spin 1s linear infinite" } : undefined} />
            {audioLoading ? t("Checking…") : t("Re-detect")}
          </button>
        </div>

        <div className="status__item">
          <span className="status__dot" data-tone={diskPct !== null && diskPct > 90 ? "warn" : "ok"} />
          <span className="status__label">{t("Disk")}</span>
          <span className="status__value">
            {usedGb ? `${usedGb} GB · ${diskPct}%` : "—"}
          </span>
        </div>
      </section>

      {/* La receta para arreglar el audio solo aparece cuando hace falta. */}
      {!audioReady && (
        <details className="fold fold--warn">
          <summary>{t("How to enable game sound capture")}</summary>
          <p className="note">
            {t("Install Screen Capturer Recorder (already in your Downloads folder): run the setup as administrator. It adds the virtual-audio-capturer device, which captures exactly what you hear. Then hit Re-detect. Meanwhile it records with the microphone if there is one.")}
          </p>
        </details>
      )}

      {/* -------------------------------------------------------- grabacion */}
      <section>
        {/* No puede llamarse "Grabacion": la tira de estado de arriba ya usa
            "Grabando" para el estado del grabador y se leian como lo mismo. */}
        <div className="sect__head"><span className="u-label">{t("Video")}</span><i className="sect__rule" /></div>

        <Row label={t("Quality")} desc={t("Constant quality: a lower CQ is sharper and heavier.")}>
          <div className="tp-seg">
            {([
              { key: "High", label: t("High"), hint: "CQ 20" },
              { key: "Medium", label: t("Medium"), hint: "CQ 23" },
              { key: "Low", label: t("Low"), hint: "CQ 26" },
            ] as const).map((q) => (
              <button
                key={q.key}
                onClick={() => video && saveVideo(video.fps, q.key)}
                {...(video?.quality === q.key ? { "data-on": true } : {})}
                title={q.hint}
              >
                {q.label}
              </button>
            ))}
          </div>
        </Row>

        <Row label={t("Frame rate")} desc={t("Captured at 1080p on the GPU (NVENC); higher resolutions are scaled down.")}>
          <div className="tp-seg">
            {[60, 30].map((f) => (
              <button
                key={f}
                onClick={() => video && saveVideo(f, video.quality)}
                {...(video?.fps === f ? { "data-on": true } : {})}
              >
                {f} FPS
              </button>
            ))}
          </div>
        </Row>
      </section>

      {/* --------------------------------------------------- almacenamiento */}
      <section>
        <div className="sect__head"><span className="u-label">{t("Storage")}</span><i className="sect__rule" /></div>

        <Row label={t("Save location")} desc={t("Directory where videos and clips are saved")}>
          <input type="text" className="field field--path" value={config.save_directory} readOnly title={config.save_directory} />
          <button onClick={handlePickDirectory} className="btn btn--ghost btn--sm">{t("Change")}</button>
        </Row>

        <Row
          label={t("Max Storage Quota (GB)")}
          desc={t("Oldest matches are deleted first when the folder goes over this. Minimum {n} GB.").replace("{n}", String(MIN_STORAGE_GB))}
        >
          <input
            type="number"
            min={MIN_STORAGE_GB}
            className="field field--num"
            value={storageDraft}
            onChange={(e) => setStorageDraft(e.target.value)}
            onBlur={() => {
              const gb = clampStorageGb(storageDraft);
              setStorageDraft(String(gb));
              handleSaveConfig({ ...config, max_storage_gb: gb });
            }}
          />
        </Row>

        <Row
          label={t("Auto-prune Age (Days)")}
          desc={t("Deletes matches older than this, with their clips. 0 disables it. Imported VODs and matches with favourited clips are never touched.")}
        >
          <input
            type="number"
            min="0"
            className="field field--num"
            value={pruneDraft}
            onChange={(e) => setPruneDraft(e.target.value)}
            onBlur={() => {
              const days = clampPruneDays(pruneDraft);
              setPruneDraft(String(days));
              handleSaveConfig({ ...config, auto_prune_days: days });
            }}
          />
        </Row>
      </section>

      {/* ---------------------------------------------------------- cuenta */}
      <section>
        <div className="sect__head"><span className="u-label">{t("Interface and account")}</span><i className="sect__rule" /></div>

        <Row label={t("Language")} desc={t("Interface language. Saved with your settings.")}>
          <div className="tp-seg">
            {LANGUAGES.map((l) => (
              <button
                key={l.code}
                onClick={() => setLang(l.code as Language)}
                {...(lang === l.code ? { "data-on": true } : {})}
              >
                {l.label}
              </button>
            ))}
          </div>
        </Row>

        <Row label={t("Riot API key")} desc={t("Needed for the scoreboard and your stats. Saved when you leave the field. A development key expires every 24 hours; a personal one does not.")}>
          <input
            type="password"
            className="field"
            placeholder="RGAPI-…"
            value={config.riot_api_key}
            onChange={handleApiKeyChange}
            onBlur={handleApiKeyBlur}
            onKeyDown={handleApiKeyKeyDown}
          />
          {keyState !== null && (
            <span
              className="u-meta"
              style={{
                color:
                  keyState === "ok" ? "var(--win)" : keyState === "bad" ? "var(--loss)" : undefined,
              }}
            >
              {keyState === "saving" && t("Checking…")}
              {keyState === "ok" && t("Key saved and working")}
              {keyState === "bad" && (keyMsg || t("The key is not valid"))}
            </span>
          )}
        </Row>
      </section>

      {/* -------------------------------------------------------- avanzado */}
      <section>
        <div className="sect__head"><span className="u-label">{t("Advanced")}</span><i className="sect__rule" /></div>

        <Row
          label={t("Minimap scale")}
          desc={t("Size of your in-game minimap versus the standard one, in percent. Calibrates minimap-click detection (map looks, blind spots) if you play with the HUD rescaled. Applies to new games.")}
        >
          <input
            type="number"
            min={50}
            max={200}
            step={5}
            className="field field--num"
            value={minimapDraft}
            onChange={(e) => setMinimapDraft(e.target.value)}
            onBlur={() => {
              const pct = clampMinimapPct(minimapDraft);
              setMinimapDraft(String(pct));
              handleSaveConfig({ ...config, minimap_scale: pct / 100 });
            }}
          />
          <span className="u-meta">%</span>
        </Row>

        <Row label={t("AI dataset generator")} desc={t("Extracts frames at the moment of each click to train the detector. Off unless you are working on the model.")}>
          <input
            type="checkbox"
            className="check"
            checked={config.auto_dataset_generator}
            onChange={(e) => handleSaveConfig({ ...config, auto_dataset_generator: e.target.checked })}
          />
        </Row>

        {/* La versión se pedía al backend, no se escribía a mano: estaba clavada
            en "1.2.8" mientras la app iba por la 1.2.11. */}
        {/* Tres estados: bajando (barra), lista (botón de instalar) y al día
            (botón de comprobar). La descarga ya no la dispara este botón: viene
            hecha de fondo, así que instalar son segundos. */}
        <Row
          label={t("Updates")}
          desc={
            isDownloading
              ? updateMsg
              : pending
                ? t("Version {v} downloaded and ready. Installing takes a few seconds and the app reopens by itself.").replace("{v}", pending.version)
                : (updateMsg || (appVersion ? t("Version {v} installed.").replace("{v}", appVersion) : ""))
          }
        >
          {isDownloading ? (
            <div className="upd">
              <span className="upd__track"><span className="upd__fill" style={{ width: `${downloadProgress}%` }} /></span>
              <span className="u-metric" style={{ fontSize: 11 }}>{downloadProgress}%</span>
            </div>
          ) : pending ? (
            <button onClick={installUpdate} className="btn btn--sm">
              {t("Restart and install")}
            </button>
          ) : (
            <button onClick={checkForUpdates} disabled={isUpdating} className="btn btn--ghost btn--sm">
              {isUpdating ? t("Checking…") : t("Check for Updates")}
            </button>
          )}
        </Row>
      </section>

      {/* ----------------------------------------------------- herramientas
          Grabar a mano no es un ajuste: es algo que se ejecuta. Por eso baja
          al final y se presenta como herramienta, no como preferencia. */}
      <section>
        <div className="sect__head"><span className="u-label">{t("Tools")}</span><i className="sect__rule" /></div>

        <Row label={t("Manual test recording")} desc={t("Checks that FFmpeg and GPU encoding work before trusting a real match.")}>
          {isRecording ? (
            <button onClick={handleStopManual} disabled={isProcessing} className="btn btn--primary btn--sm">
              {t("Stop and save")}
            </button>
          ) : (
            <>
              <input
                type="text"
                className="field field--num"
                style={{ width: 120 }}
                placeholder={t("name")}
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
                disabled={isProcessing}
              />
              <button onClick={handleStartManual} disabled={isProcessing} className="btn btn--primary btn--sm">
                {t("Record screen")}
              </button>
            </>
          )}
        </Row>
        {statusMsg && <p className="note">{statusMsg}</p>}
      </section>

      {/* La documentacion que estaba suelta en dos tarjetas: sigue disponible,
          pero plegada. No es algo que se ajuste. */}
      <details className="fold">
        <summary>{t("How automatic recording works")}</summary>
        <ul className="fold__list">
          <li>{t("The background service connects to the in-game API on port 2999 when a match starts.")}</li>
          <li>{t("It records locally at 1080p with hardware encoding, so your FPS is untouched.")}</li>
          <li>{t("It logs kills, deaths, assists and objectives with their timestamps.")}</li>
          <li>{t("It saves everything when the match ends, with no action from you.")}</li>
          <li>{t("It needs ffmpeg on your Windows PATH; without it the recorder cannot start.")}</li>
        </ul>
      </details>

      {audio && audio.all_devices.length > 0 && (
        <details className="fold">
          <summary>{t("Detected audio devices")} ({audio.all_devices.length})</summary>
          <ul className="fold__list">
            {audio.all_devices.map((d) => (
              <li key={d} style={{ color: d === audio.system_audio_device ? "var(--cool)" : undefined }}>
                {d}{d === audio.system_audio_device ? ` ← ${t("used for the game")}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
};
