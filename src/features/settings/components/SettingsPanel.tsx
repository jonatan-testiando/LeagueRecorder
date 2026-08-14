import React, { useState, useEffect } from "react";
import { getRecorderStatus, startManualRecording, stopManualRecording, getAudioStatus, getVideoSettings, setVideoSettings, getAppConfig, setAppConfig, AppConfig } from "../../../core/tauri-ipc";
import { AudioStatus, VideoSettings } from "../../../types";
import { Volume2, CheckCircle2, AlertTriangle, RefreshCw, Monitor, FolderOpen, KeyRound, ArrowUpCircle, Languages } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useDialog } from "../../../components/ui/DialogProvider";
import { check } from "@tauri-apps/plugin-updater";
import { exit } from "@tauri-apps/plugin-process";
import { motion, Variants } from "framer-motion";
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

  const containerVariants: Variants = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: { staggerChildren: 0.1 }
    }
  };

  const itemVariants: Variants = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 300, damping: 24 } }
  };

  return (
    <div style={styles.container}>
      <div>
        <h2 style={styles.title}>{t("Control Panel")}</h2>
        <p style={styles.subtitle}>{t("Recorder status, audio capture and automatic match detection.")}</p>
      </div>

      <motion.div 
        style={styles.settingsGrid}
        variants={containerVariants}
        initial="hidden"
        animate="show"
      >
      {/* Almacenamiento */}
      <motion.div variants={itemVariants} style={styles.card}>
        <div style={styles.cardHeader}>
          <FolderOpen size={20} color="var(--accent-violet)" style={{ marginRight: "8px" }} />
          <h3 style={styles.cardTitle}>{t("Storage")}</h3>
        </div>
        <div style={styles.cardBody}>
          <div style={styles.settingRow}>
            <div style={styles.settingInfo}>
              <span style={styles.settingLabel}>{t("Save location")}</span>
              <span style={styles.settingDesc}>{t("Directory where videos and clips are saved")}</span>
            </div>
            <div style={{ display: "flex", gap: "8px", flex: 1, marginLeft: "16px" }}>
              <input 
                type="text" 
                value={config.save_directory} 
                readOnly
                style={{
                  flex: 1, padding: "8px", borderRadius: "6px", border: "1px solid var(--border-subtle)",
                  backgroundColor: "var(--bg-app)", color: "var(--text-primary)", fontSize: "12px", outline: "none"
                }} 
              />
              <button onClick={handlePickDirectory} className="btn btn--ghost btn--sm" style={{ padding: "8px 12px" }}>
                Change
              </button>
            </div>
          </div>

          <div style={{...styles.settingRow, marginTop: "16px"}}>
            <div style={styles.settingInfo}>
              <span style={styles.settingLabel}>{t("Max Storage Quota (GB)")}</span>
              <span style={styles.settingDesc}>Oldest matches are deleted first if size exceeds this limit (minimum {MIN_STORAGE_GB} GB)</span>
            </div>
            <div style={{ flex: 1, marginLeft: "16px", maxWidth: "80px" }}>
              <input
                type="number"
                min={MIN_STORAGE_GB}
                value={storageDraft}
                onChange={(e) => setStorageDraft(e.target.value)}
                onBlur={() => {
                  const gb = clampStorageGb(storageDraft);
                  setStorageDraft(String(gb));
                  handleSaveConfig({ ...config, max_storage_gb: gb });
                }}
                style={{
                  width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid var(--border-subtle)",
                  backgroundColor: "var(--bg-app)", color: "var(--text-primary)", fontSize: "12px", outline: "none", textAlign: "center"
                }}
              />
            </div>
          </div>

          <div style={{...styles.settingRow, marginTop: "16px"}}>
            <div style={styles.settingInfo}>
              <span style={styles.settingLabel}>{t("Auto-prune Age (Days)")}</span>
              <span style={styles.settingDesc}>
                Permanently deletes local matches older than X days, together with their clips.
                0 disables it (default). Imported VODs and matches with favorited clips are never touched.
              </span>
            </div>
            <div style={{ flex: 1, marginLeft: "16px", maxWidth: "80px" }}>
              <input
                type="number"
                min="0"
                value={pruneDraft}
                onChange={(e) => setPruneDraft(e.target.value)}
                onBlur={() => {
                  const days = clampPruneDays(pruneDraft);
                  setPruneDraft(String(days));
                  handleSaveConfig({ ...config, auto_prune_days: days });
                }}
                style={{
                  width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid var(--border-subtle)",
                  backgroundColor: "var(--bg-app)", color: "var(--text-primary)", fontSize: "12px", outline: "none", textAlign: "center"
                }}
              />
            </div>
          </div>
        </div>
      </motion.div>

      {/* Idioma */}
      <motion.div variants={itemVariants} style={styles.card}>
        <div style={styles.cardHeader}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <Languages size={17} strokeWidth={1.6} color="var(--brand)" style={{ marginRight: 8 }} />
            <h3 style={styles.cardTitle}>{t("Language")}</h3>
          </div>
        </div>
        <div style={styles.cardBody}>
          <div style={styles.settingRow}>
            <div style={styles.settingInfo}>
              <span style={styles.settingLabel}>{t("Language")}</span>
              <span style={styles.settingDesc}>
                {t("Interface language. Saved with your settings.")}
              </span>
            </div>
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              {LANGUAGES.map((l) => (
                <button
                  key={l.code}
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-pressed={lang === l.code}
                  onClick={() => setLang(l.code as Language)}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </motion.div>

      {/* Riot API */}
      <motion.div variants={itemVariants} style={styles.card}>
        <div style={styles.cardHeader}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <KeyRound size={17} strokeWidth={1.6} color="var(--brand)" style={{ marginRight: 8 }} />
            <h3 style={styles.cardTitle}>{t("Riot Developer API")}</h3>
          </div>
        </div>
        <div style={styles.cardBody}>
          <div style={styles.settingRow}>
            <div style={styles.settingInfo}>
              <span style={styles.settingLabel}>{t("API Key (Development)")}</span>
              <span style={styles.settingDesc}>Required to fetch your stats (KDA, gold, damage). Expires every 24 hours!</span>
            </div>
            <div style={{ flex: 1, marginLeft: "16px" }}>
              <input 
                type="password" 
                placeholder="RGAPI-..."
                value={config.riot_api_key} 
                onChange={handleApiKeyChange}
                onBlur={handleApiKeyBlur}
                style={{
                  width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid var(--border-subtle)",
                  backgroundColor: "var(--bg-app)", color: "var(--text-primary)", fontSize: "12px", outline: "none"
                }} 
              />
            </div>
          </div>
        </div>
      </motion.div>

      {/* Sistema de Actualizaciones */}
      <motion.div variants={itemVariants} style={styles.card}>
        <div style={styles.cardHeader}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <ArrowUpCircle size={17} strokeWidth={1.6} color="var(--brand)" style={{ marginRight: 8 }} />
            <h3 style={styles.cardTitle}>{t("Updates")}</h3>
          </div>
        </div>
        <div style={styles.cardBody}>
          <p style={styles.cardText}>
            Automatically check for and install the latest LeagueRecorder improvements.
          </p>
          
          {isDownloading ? (
            <div style={{ marginTop: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--accent-violet)" }}>
                  {updateMsg}
                </span>
                <span style={{ fontSize: "14px", fontWeight: 800, color: "var(--text-primary)" }}>
                  {downloadProgress}%
                </span>
              </div>
              <div style={{ width: "100%", height: "10px", backgroundColor: "var(--bg-app)", borderRadius: "5px", overflow: "hidden", border: "1px solid var(--border-subtle)" }}>
                <div style={{ 
                  width: `${downloadProgress}%`, 
                  height: "100%", 
                  background: "var(--gradient-violet)",
                  boxShadow: "0 0 10px color-mix(in srgb, var(--flag) 50%, transparent)",
                  transition: "width 0.2s ease-out",
                  borderRadius: "5px"
                }} />
              </div>
            </div>
          ) : (
            <>
              <div style={{ ...styles.form, marginTop: "16px" }}>
                <button 
                  onClick={checkForUpdates} 
                  disabled={isUpdating}
                  // Buscar actualizaciones no es la acción principal de esta
                  // pantalla: un relleno turquesa a ancho completo la convertía
                  // en lo más brillante de la vista.
                  style={{
                    ...styles.btn,
                    background: "transparent",
                    border: "1px solid var(--line)",
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "12px",
                    fontWeight: 500,
                    flex: 1,
                    opacity: isUpdating ? 0.7 : 1,
                    transition: "opacity var(--t-quick) var(--e-out)",
                  }}
                >
                  {isUpdating ? updateMsg || t("Checking…") : t("Check for Updates")}
                </button>
              </div>
              {updateMsg && !isUpdating && <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "8px" }}>{updateMsg}</p>}
            </>
          )}
        </div>
      </motion.div>

      {/* Estado del audio del juego */}
      <motion.div variants={itemVariants} style={styles.card}>
        <div style={styles.cardTitleRow}>
          <h3 style={styles.cardTitle}>
            <Volume2 size={20} color="var(--accent-gold)" style={{ marginRight: "8px" }} />
            {t("Game Sound Capture")}
          </h3>
          <button onClick={refreshAudio} disabled={audioLoading} style={styles.ghostBtn}>
            <RefreshCw size={14} style={{ marginRight: "6px" }} />
            {audioLoading ? t("Checking…") : t("Re-detect")}
          </button>
        </div>

        <div style={{ ...styles.audioBanner, borderLeftColor: audioReady ? "var(--color-victory)" : "var(--accent-gold)" }}>
          <div style={{ flexShrink: 0, marginTop: "2px" }}>
            {audioReady ? <CheckCircle2 size={24} color="var(--color-victory)" /> : <AlertTriangle size={24} color="var(--accent-gold)" />}
          </div>
          <div>
            {audioReady ? (
              <>
                <span style={styles.statusTitle}>{t("Ready to record game sound")}</span>
                <p style={styles.statusText}>
                  System device detected: <strong style={{ color: "var(--accent-teal)" }}>{audio?.system_audio_device}</strong>
                </p>
              </>
            ) : (
              <>
                <span style={styles.statusTitle}>Missing a system capture device</span>
                <p style={styles.statusText}>
                  To record game sound with no latency, install <strong>Screen Capturer Recorder</strong> (already downloaded in
                  <code style={styles.inlineCode}> Downloads\ScreenCaptureRecorder</code>): run
                  <code style={styles.inlineCode}>Setup.Screen.Capturer.Recorder…exe</code> as administrator (Next → Next). It adds the
                  <strong> virtual-audio-capturer</strong> device, which captures exactly what you hear through your headphones. Then click “Re-detect”.
                  Meanwhile it will record with the microphone if available.
                </p>
              </>
            )}
          </div>
        </div>

        {audio && audio.all_devices.length > 0 && (
          <details style={styles.details}>
            <summary style={styles.summary}>Detected audio devices ({audio.all_devices.length})</summary>
            <ul style={styles.deviceList}>
              {audio.all_devices.map((d) => (
                <li key={d} style={{ color: d === audio.system_audio_device ? "var(--accent-teal)" : "var(--text-secondary)" }}>
                  {d}{d === audio.system_audio_device ? "  ← used for the game" : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
      </motion.div>

      {/* Configuración de Video */}
      <motion.div variants={itemVariants} style={styles.card}>
        <div style={styles.cardTitleRow}>
          <h3 style={styles.cardTitle}>
            <Monitor size={20} color="var(--accent-blue)" style={{ marginRight: "8px" }} />
            Video Recording Quality
          </h3>
        </div>
        <p style={styles.cardText}>
          Video is recorded at 1080p via NVENC (GPU), with no FPS loss. If you play at a higher
          resolution the image is scaled down to 1080p, keeping the full frame. Choose the FPS and
          quality: quality trades sharpness against file size.
        </p>
        
        <div style={styles.videoSettingsGrid}>
          <div style={styles.videoSetCol}>
            <span style={styles.videoSetLabel}>Frame Rate (FPS)</span>
            <div style={styles.buttonGroup}>
              <button 
                onClick={() => video && saveVideo(60, video.quality)}
                style={{
                  ...styles.selectBtn,
                  backgroundColor: video?.fps === 60 ? "var(--surface-2)" : "var(--bg-app)",
                  borderColor: video?.fps === 60 ? "var(--cool)" : "var(--border-strong)",
                  color: video?.fps === 60 ? "var(--text)" : "var(--text-secondary)"
                }}
              >
                60 FPS
              </button>
              <button 
                onClick={() => video && saveVideo(30, video.quality)}
                style={{
                  ...styles.selectBtn,
                  backgroundColor: video?.fps === 30 ? "var(--surface-2)" : "var(--bg-app)",
                  borderColor: video?.fps === 30 ? "var(--cool)" : "var(--border-strong)",
                  color: video?.fps === 30 ? "var(--text)" : "var(--text-secondary)"
                }}
              >
                30 FPS
              </button>
            </div>
          </div>

          <div style={styles.videoSetCol}>
            <span style={styles.videoSetLabel}>Quality</span>
            <div style={styles.buttonGroup}>
              {([
                { key: "High", label: "High", hint: "CQ 20 · sharpest" },
                { key: "Medium", label: "Medium", hint: "CQ 23 · balanced" },
                { key: "Low", label: "Low", hint: "CQ 26 · smallest" },
              ] as const).map((q) => {
                const sel = video?.quality === q.key;
                return (
                  <button
                    key={q.key}
                    onClick={() => video && saveVideo(video.fps, q.key)}
                    style={{
                      ...styles.qualityBtn,
                      backgroundColor: sel ? "var(--surface-2)" : "var(--bg-app)",
                      borderColor: sel ? "var(--cool)" : "var(--border-strong)",
                      color: sel ? "var(--text)" : "var(--text-secondary)",
                    }}
                  >
                    <span>{q.label}</span>
                    <span style={styles.btnHint}>{q.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div style={styles.infoNote}>
          <Monitor size={14} color="var(--accent-blue)" style={{ flexShrink: 0, marginTop: "2px" }} />
          <span>
            Recording uses constant quality, so the encoder only spends bits where there is motion
            and quiet stretches take up almost nothing. File size therefore varies with the match:
            a lower CQ number means a sharper, heavier video.
          </span>
        </div>
      </motion.div>

      <motion.div variants={itemVariants} style={styles.card}>
        <h3 style={styles.cardTitle}>{t("Manual Test Recording")}</h3>
        <p style={styles.cardText}>
          Use this tool to verify that FFmpeg and hardware (GPU) video acceleration work correctly before jumping into a real match.
        </p>

        {isRecording ? (
          <div style={styles.statusBoxActive}>
            <div style={styles.indicatorActive} />
            <div>
              <span style={styles.statusTitle}>Recording Screen</span>
              <p style={styles.statusText}>{statusMsg || "Capturing video and audio…"}</p>
            </div>
          </div>
        ) : (
          <div style={styles.statusBoxInactive}>
            <div style={styles.indicatorInactive} />
            <div>
              <span style={styles.statusTitle}>Recorder Idle</span>
              <p style={styles.statusText}>{statusMsg || "Waiting for automatic or manual start."}</p>
            </div>
          </div>
        )}

        <div style={styles.form}>
          {!isRecording ? (
            <>
              <input
                type="text"
                placeholder="Test name (e.g. screen_test)"
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
                style={styles.input}
                disabled={isProcessing}
              />
              <button
                onClick={handleStartManual}
                disabled={isProcessing}
                style={{ ...styles.btn, backgroundColor: "var(--action)", color: "var(--on-action)" }}
              >
                Record Full Screen
              </button>
            </>
          ) : (
            <button
              onClick={handleStopManual}
              disabled={isProcessing}
              style={{ ...styles.btn, backgroundColor: "var(--color-defeat)" }}
            >
              Stop and Save Clip
            </button>
          )}
        </div>
      </motion.div>

      <motion.div variants={itemVariants} style={styles.card}>
        <h3 style={styles.cardTitle}>Match Detection</h3>
        <p style={styles.cardText}>
          The background service runs constantly. When you open League of Legends and enter a match:
        </p>
        <ul style={styles.list}>
          <li>It connects automatically to the in-game API on port 2999.</li>
          <li>It starts local recording at 1080p with zero performance impact.</li>
          <li>It logs timestamps for kills, deaths, assists and objectives.</li>
          <li>It saves everything when the match ends, 100% automatically.</li>
        </ul>
      </motion.div>

      <motion.div variants={itemVariants} style={styles.card}>
        <h3 style={styles.cardTitle}>Automatic AI Dataset Generator</h3>
        <p style={styles.cardText}>
          Extracts frames at the exact moments of your physical clicks to automatically train a YOLOv8 model.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: "var(--space-4)" }}>
          <label style={{ display: "flex", alignItems: "center", cursor: "pointer", gap: "var(--space-3)" }}>
            <input 
              type="checkbox"
              checked={config.auto_dataset_generator}
              onChange={(e) => handleSaveConfig({ ...config, auto_dataset_generator: e.target.checked })}
              style={{ width: "18px", height: "18px", accentColor: "var(--accent-violet)" }}
            />
            <span style={{ fontSize: "var(--font-sm)", fontWeight: 600, color: "var(--text-primary)" }}>
              Enable auto-generation when a match ends
            </span>
          </label>
        </div>
      </motion.div>

      <motion.div variants={itemVariants} style={styles.card}>
        <h3 style={styles.cardTitle}>System Requirements</h3>
        <ul style={styles.list}>
          <li>
            <strong>FFmpeg on PATH:</strong> Make sure `ffmpeg` is on your Windows PATH. Otherwise the recorder won't be able to start.
          </li>
          <li>
            <strong>Game Resolution:</strong> Capture is automatically scaled to 1080p 60fps using hardware encoding on the GPU so your FPS isn't affected.
          </li>
        </ul>
      </motion.div>
      </motion.div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    padding: "var(--space-6)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-6)",
    overflowY: "auto",
    background: "transparent",
    boxSizing: "border-box",
  },
  settingsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))",
    gap: "var(--space-6)",
  },
  title: {
    margin: 0,
    fontSize: "var(--font-2xl)",
    fontWeight: 800,
    letterSpacing: "-0.03em",
  },
  subtitle: {
    margin: "var(--space-2) 0 0 0",
    fontSize: "var(--font-sm)",
    color: "var(--text-muted)",
  },
  cardTitleRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "var(--space-3)",
  },
  // Estas siete faltaban: el código las usaba (`styles.settingInfo`, etc.) pero
  // nunca se definieron, así que llegaban a React como `undefined` y esos
  // elementos se pintaban sin estilo. De ahí que la etiqueta y su descripción
  // salieran pegadas ("Save locationDirectory where videos…").
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    marginBottom: "var(--space-4)",
  },
  cardBody: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-4)",
  },
  settingRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "var(--space-4)",
  },
  settingInfo: {
    display: "flex",
    flexDirection: "column",
    gap: "3px",
    minWidth: 0,
    flex: 1,
  },
  settingLabel: {
    fontSize: "var(--font-sm)",
    fontWeight: 600,
    color: "var(--text)",
  },
  settingDesc: {
    fontSize: "var(--font-xs)",
    lineHeight: 1.5,
    color: "var(--muted)",
    maxWidth: "48ch",
  },
  button: {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    padding: "var(--space-2) var(--space-4)",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--line)",
    background: "var(--raised)",
    color: "var(--text)",
    cursor: "pointer",
  },
  ghostBtn: {
    background: "transparent",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-md)",
    color: "var(--text-secondary)",
    fontSize: "var(--font-xs)",
    fontWeight: 600,
    padding: "var(--space-2) var(--space-3)",
    cursor: "pointer",
  },
  toggle: {
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-full)",
    fontSize: "var(--font-xs)",
    fontWeight: 800,
    padding: "var(--space-2) var(--space-4)",
    cursor: "pointer",
  },
  ultRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    flexWrap: "wrap",
  },
  ultLabel: { fontSize: "var(--font-sm)", color: "var(--text-secondary)", fontWeight: 600 },
  keyInput: {
    width: "44px",
    height: "44px",
    textAlign: "center",
    fontSize: "var(--font-lg)",
    fontWeight: 800,
    backgroundColor: "var(--bg-app)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-md)",
    color: "var(--accent-teal)",
    outline: "none",
    textTransform: "uppercase",
  },
  ultHint: { fontSize: "var(--font-xs)", color: "var(--text-muted)", flex: 1, minWidth: "180px" },
  audioBanner: {
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--space-3)",
    background: "var(--surface-1)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-4)",
    borderLeft: "4px solid var(--accent-gold)",
  },
  inlineCode: {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    backgroundColor: "var(--bg-app)",
    padding: "1px 6px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border-subtle)",
    color: "var(--text-secondary)",
  },
  details: {
    background: "var(--surface-1)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-3) var(--space-4)",
    border: "1px solid var(--border-subtle)",
  },
  summary: {
    cursor: "pointer",
    fontSize: "var(--font-sm)",
    fontWeight: 600,
    color: "var(--text-secondary)",
  },
  deviceList: {
    margin: "var(--space-3) 0 0 0",
    paddingLeft: "var(--space-6)",
    fontSize: "var(--font-sm)",
    lineHeight: "1.7",
  },
  card: {
    background: "var(--surface-1)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-lg)",
    padding: "var(--space-6)",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-3)",
  },
  cardTitle: {
    margin: 0,
    fontSize: "var(--font-lg)",
    fontWeight: 700,
    color: "var(--text-primary)",
  },
  cardText: {
    margin: 0,
    fontSize: "var(--font-sm)",
    color: "var(--text-secondary)",
    lineHeight: "1.5",
  },
  statusBoxInactive: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-4)",
    background: "var(--surface-1)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-4)",
    borderLeft: "4px solid var(--text-muted)",
  },
  statusBoxActive: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-4)",
    background: "var(--surface-1)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-4)",
    borderLeft: "4px solid var(--color-defeat)",
  },
  indicatorInactive: {
    width: "12px",
    height: "12px",
    borderRadius: "var(--radius-full)",
    backgroundColor: "var(--text-muted)",
  },
  indicatorActive: {
    width: "12px",
    height: "12px",
    borderRadius: "var(--radius-full)",
    backgroundColor: "var(--color-defeat)",
    boxShadow: "0 0 8px var(--color-defeat)",
    animation: "pulse 1.5s infinite",
  },
  statusTitle: {
    fontWeight: 700,
    fontSize: "var(--font-sm)",
  },
  statusText: {
    margin: "2px 0 0 0",
    fontSize: "var(--font-xs)",
    color: "var(--text-muted)",
  },
  form: {
    display: "flex",
    gap: "var(--space-3)",
    marginTop: "var(--space-2)",
  },
  input: {
    flex: 1,
    backgroundColor: "var(--bg-app)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-2) var(--space-4)",
    color: "var(--text-primary)",
    fontSize: "var(--font-sm)",
    outline: "none",
  },
  btn: {
    border: "none",
    borderRadius: "var(--radius-md)",
    color: "var(--text)",
    fontSize: "var(--font-sm)",
    fontWeight: 700,
    padding: "var(--space-3) var(--space-6)",
    cursor: "pointer",
  },
  list: {
    margin: 0,
    paddingLeft: "var(--space-6)",
    fontSize: "var(--font-sm)",
    color: "var(--text-secondary)",
    lineHeight: "1.6",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-1)",
  },
  videoSettingsGrid: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--space-6)",
    marginTop: "var(--space-2)",
  },
  videoSetCol: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
    flex: 1,
    minWidth: "200px",
  },
  videoSetLabel: {
    fontSize: "var(--font-sm)",
    fontWeight: 600,
    color: "var(--text-primary)",
  },
  buttonGroup: {
    display: "flex",
    gap: "var(--space-2)",
    backgroundColor: "var(--bg-app)",
    padding: "var(--space-1)",
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--border-subtle)",
  },
  selectBtn: {
    flex: 1,
    padding: "var(--space-2) var(--space-4)",
    borderRadius: "var(--radius-md)",
    border: "1px solid transparent",
    fontSize: "var(--font-sm)",
    fontWeight: 700,
    cursor: "pointer",
    transition: "all 0.2s ease",
  },
  qualityBtn: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "2px",
    padding: "var(--space-2) var(--space-3)",
    borderRadius: "var(--radius-md)",
    border: "1px solid transparent",
    fontSize: "var(--font-sm)",
    fontWeight: 700,
    cursor: "pointer",
    transition: "all 0.2s ease",
  },
  btnHint: {
    fontSize: "11px",
    fontWeight: 500,
    opacity: 0.75,
  },
  infoNote: {
    display: "flex",
    gap: "var(--space-2)",
    marginTop: "var(--space-4)",
    padding: "var(--space-3)",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--bg-app)",
    border: "1px solid var(--border-subtle)",
    fontSize: "var(--font-sm)",
    color: "var(--text-secondary)",
    lineHeight: 1.4,
  },
};
