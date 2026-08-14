import React, { useState, useEffect } from "react";
import { getRecorderStatus, startManualRecording, stopManualRecording, getAudioStatus, getVideoSettings, setVideoSettings, getAppConfig, setAppConfig, AppConfig } from "../../../core/tauri-ipc";
import { AudioStatus, VideoSettings } from "../../../types";
import { RefreshCw } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useDialog } from "../../../components/ui/DialogProvider";
import { check } from "@tauri-apps/plugin-updater";
import { exit } from "@tauri-apps/plugin-process";
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

export const SettingsPanel: React.FC = () => {
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [manualId, setManualId] = useState<string>("");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [audio, setAudio] = useState<AudioStatus | null>(null);
  const [audioLoading, setAudioLoading] = useState<boolean>(false);
  const [video, setVideo] = useState<VideoSettings>({ fps: 60, quality: "High" });
  const [config, setConfig] = useState<AppConfig>({ save_directory: "", riot_api_key: "", auto_dataset_generator: false, max_storage_gb: 100, auto_prune_days: 0, language: "en" });
  // Los dos campos numéricos se editan como texto: si se guardara el `Number()` de
  // cada pulsación, vaciar el campo enviaría un 0 al backend. Se acotan al salir.
  const [storageDraft, setStorageDraft] = useState<string>("100");
  const [pruneDraft, setPruneDraft] = useState<string>("0");
  // El disco es lo primero que se mira al entrar aqui y no se estaba pidiendo:
  // la cuota se ajustaba a ciegas, sin saber cuanto se lleva usado.
  const [disk, setDisk] = useState<{ used_bytes: number; total_bytes: number } | null>(null);
  const [updateMsg, setUpdateMsg] = useState<string>("");
  const [isUpdating, setIsUpdating] = useState<boolean>(false);
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
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
    getAppConfig()
      .then(c => {
        setConfig(c);
        setStorageDraft(String(c.max_storage_gb));
        setPruneDraft(String(c.auto_prune_days));
      })
      .catch(console.error);
    const interval = setInterval(checkStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleSaveConfig = async (c: AppConfig) => {
    setConfig(c);
    await setAppConfig(c.save_directory, c.riot_api_key, c.auto_dataset_generator, c.max_storage_gb, c.auto_prune_days).catch(console.error);
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

  const handleApiKeyBlur = () => {
    handleSaveConfig(config);
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

  const checkForUpdates = async () => {
    setIsUpdating(true);
    setUpdateMsg("Checking for updates…");
    try {
      const update = await check();
      if (update) {
        setUpdateMsg(`New version ${update.version} available`);
        setIsDownloading(true);
        setDownloadProgress(0);
        
        let downloaded = 0;
        let contentLength = 0;
        
        await update.downloadAndInstall((event) => {
          switch (event.event) {
            case 'Started':
              contentLength = event.data.contentLength || 0;
              setUpdateMsg("Starting download…");
              break;
            case 'Progress':
              downloaded += event.data.chunkLength;
              if (contentLength > 0) {
                const percent = Math.round((downloaded / contentLength) * 100);
                setDownloadProgress(percent);
                setUpdateMsg(`Downloading… ${percent}%`);
              }
              break;
            case 'Finished':
              setUpdateMsg("Installing update…");
              setDownloadProgress(100);
              break;
          }
        });

        setUpdateMsg("Launching installer…");
        await exit(0);
      } else {
        setUpdateMsg("Your app is already on the latest version.");
        showSuccess("Your app is already up to date.");
      }
    } catch (err) {
      console.error(err);
      setUpdateMsg("Failed to check for updates.");
      showError("Update error: " + err);
    } finally {
      setIsUpdating(false);
      setIsDownloading(false);
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

        <Row label={t("Riot API key")} desc={t("Needed for the scoreboard and your stats. A development key expires every 24 hours.")}>
          <input
            type="password"
            className="field"
            placeholder="RGAPI-…"
            value={config.riot_api_key}
            onChange={handleApiKeyChange}
            onBlur={handleApiKeyBlur}
          />
        </Row>
      </section>

      {/* -------------------------------------------------------- avanzado */}
      <section>
        <div className="sect__head"><span className="u-label">{t("Advanced")}</span><i className="sect__rule" /></div>

        <Row label={t("AI dataset generator")} desc={t("Extracts frames at the moment of each click to train the detector. Off unless you are working on the model.")}>
          <input
            type="checkbox"
            className="check"
            checked={config.auto_dataset_generator}
            onChange={(e) => handleSaveConfig({ ...config, auto_dataset_generator: e.target.checked })}
          />
        </Row>

        <Row label={t("Updates")} desc={isDownloading ? updateMsg : (updateMsg || t("Version {v} installed.").replace("{v}", "1.2.8"))}>
          {isDownloading ? (
            <div className="upd">
              <span className="upd__track"><span className="upd__fill" style={{ width: `${downloadProgress}%` }} /></span>
              <span className="u-metric" style={{ fontSize: 11 }}>{downloadProgress}%</span>
            </div>
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
