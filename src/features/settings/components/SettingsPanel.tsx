import React, { useState, useEffect } from "react";
import { getRecorderStatus, startManualRecording, stopManualRecording, getAudioStatus, getUltimateSettings, setUltimateSettings, getVideoSettings, setVideoSettings, getAppConfig, setAppConfig, AppConfig } from "../../../core/tauri-ipc";
import { AudioStatus, UltimateSettings, VideoSettings } from "../../../types";
import { Sparkles, Volume2, CheckCircle2, AlertTriangle, RefreshCw, Monitor, FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useDialog } from "../../../components/ui/DialogProvider";
import { check } from "@tauri-apps/plugin-updater";
import { exit } from "@tauri-apps/plugin-process";
import { motion, Variants } from "framer-motion";

export const SettingsPanel: React.FC = () => {
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [manualId, setManualId] = useState<string>("");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [audio, setAudio] = useState<AudioStatus | null>(null);
  const [audioLoading, setAudioLoading] = useState<boolean>(false);
  const [ult, setUlt] = useState<UltimateSettings>({ enabled: true, key: "R" });
  const [video, setVideo] = useState<VideoSettings>({ fps: 60, quality: "High" });
  const [config, setConfig] = useState<AppConfig>({ save_directory: "", riot_api_key: "", auto_dataset_generator: false });
  const [updateMsg, setUpdateMsg] = useState<string>("");
  const [isUpdating, setIsUpdating] = useState<boolean>(false);
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const { showError, showSuccess } = useDialog();

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

  const saveUlt = async (enabled: boolean, key: string) => {
    try {
      setUlt(await setUltimateSettings(enabled, key));
    } catch (err) {
      console.error(err);
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
    getUltimateSettings().then(setUlt).catch(console.error);
    getVideoSettings().then(setVideo).catch(console.error);
    getAppConfig().then(setConfig).catch(console.error);
    const interval = setInterval(checkStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleSaveConfig = async (c: AppConfig) => {
    setConfig(c);
    await setAppConfig(c.save_directory, c.riot_api_key, c.auto_dataset_generator).catch(console.error);
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
        <h2 style={styles.title}>Control Panel</h2>
        <p style={styles.subtitle}>Recorder status, audio capture and automatic match detection.</p>
      </div>

      <motion.div 
        style={styles.settingsGrid}
        variants={containerVariants}
        initial="hidden"
        animate="show"
      >
      {/* Detección de ultimate (R) */}
      <motion.div variants={itemVariants} style={styles.card}>
        <div style={styles.cardTitleRow}>
          <h3 style={styles.cardTitle}>
            <Sparkles size={20} color="var(--accent-violet)" style={{ marginRight: "8px" }} />
            Ultimate Detection (R)
          </h3>
          <button
            onClick={() => ult && saveUlt(!ult.enabled, ult.key)}
            style={{
              ...styles.toggle,
              background: ult?.enabled ? "var(--gradient-teal)" : "transparent",
              color: ult?.enabled ? "var(--bg-app)" : "var(--text-secondary)",
              borderColor: ult?.enabled ? "transparent" : "var(--border-strong)",
            }}
          >
            {ult?.enabled ? "On" : "Off"}
          </button>
        </div>
        <p style={styles.cardText}>
          Riot's API <strong>does not report</strong> ability usage, so this is detected from the
          keypress while you record (best-effort). It's only flagged once your ultimate is available (level ≥ 6).
          There may be a false positive if you press it while on cooldown.
        </p>
        <div style={styles.ultRow}>
          <span style={styles.ultLabel}>Ultimate key:</span>
          <input
            type="text"
            maxLength={1}
            value={ult?.key ?? "R"}
            onChange={(e) => ult && setUlt({ ...ult, key: e.target.value.toUpperCase() })}
            onBlur={() => ult && saveUlt(ult.enabled, ult.key)}
            style={{ width: "30px", textAlign: "center", textTransform: "uppercase", fontWeight: "bold" }}
          />
        </div>
      </motion.div>

      {/* Almacenamiento */}
      <motion.div variants={itemVariants} style={styles.card}>
        <div style={styles.cardHeader}>
          <FolderOpen size={20} color="var(--accent-violet)" style={{ marginRight: "8px" }} />
          <h3 style={styles.cardTitle}>Storage</h3>
        </div>
        <div style={styles.cardBody}>
          <div style={styles.settingRow}>
            <div style={styles.settingInfo}>
              <span style={styles.settingLabel}>Save location</span>
              <span style={styles.settingDesc}>Directory where videos and clips are saved</span>
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
              <button onClick={handlePickDirectory} style={{...styles.button, backgroundColor: "var(--accent-violet)", padding: "8px 12px"}}>
                Change
              </button>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Riot API */}
      <motion.div variants={itemVariants} style={styles.card}>
        <div style={styles.cardHeader}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <span style={{ fontSize: "20px", marginRight: "8px" }}>🔑</span>
            <h3 style={styles.cardTitle}>Riot Developer API</h3>
          </div>
        </div>
        <div style={styles.cardBody}>
          <div style={styles.settingRow}>
            <div style={styles.settingInfo}>
              <span style={styles.settingLabel}>API Key (Development)</span>
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
            <span style={{ fontSize: "20px", marginRight: "8px" }}>🚀</span>
            <h3 style={styles.cardTitle}>Updates</h3>
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
                  boxShadow: "0 0 10px rgba(168, 85, 247, 0.5)",
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
                  style={{ ...styles.btn, backgroundColor: "var(--accent-violet)", flex: 1, opacity: isUpdating ? 0.7 : 1, transition: "opacity 0.2s" }}
                >
                  {isUpdating ? updateMsg || "Checking…" : "Check for Updates"}
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
            Game Sound Capture
          </h3>
          <button onClick={refreshAudio} disabled={audioLoading} style={styles.ghostBtn}>
            <RefreshCw size={14} style={{ marginRight: "6px" }} />
            {audioLoading ? "Checking…" : "Re-detect"}
          </button>
        </div>

        <div style={{ ...styles.audioBanner, borderLeftColor: audioReady ? "var(--color-victory)" : "var(--accent-gold)" }}>
          <div style={{ flexShrink: 0, marginTop: "2px" }}>
            {audioReady ? <CheckCircle2 size={24} color="var(--color-victory)" /> : <AlertTriangle size={24} color="var(--accent-gold)" />}
          </div>
          <div>
            {audioReady ? (
              <>
                <span style={styles.statusTitle}>Ready to record game sound</span>
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
          Video is recorded at your monitor's native resolution via NVENC (GPU), with no FPS loss.
          Choose the FPS and quality: quality sets the bitrate — i.e. how sharp the video is
          versus the file size.
        </p>
        
        <div style={styles.videoSettingsGrid}>
          <div style={styles.videoSetCol}>
            <span style={styles.videoSetLabel}>Frame Rate (FPS)</span>
            <div style={styles.buttonGroup}>
              <button 
                onClick={() => video && saveVideo(60, video.quality)}
                style={{
                  ...styles.selectBtn,
                  backgroundColor: video?.fps === 60 ? "var(--accent-blue)" : "var(--bg-app)",
                  borderColor: video?.fps === 60 ? "var(--accent-blue)" : "var(--border-strong)",
                  color: video?.fps === 60 ? "#fff" : "var(--text-secondary)"
                }}
              >
                60 FPS
              </button>
              <button 
                onClick={() => video && saveVideo(30, video.quality)}
                style={{
                  ...styles.selectBtn,
                  backgroundColor: video?.fps === 30 ? "var(--accent-blue)" : "var(--bg-app)",
                  borderColor: video?.fps === 30 ? "var(--accent-blue)" : "var(--border-strong)",
                  color: video?.fps === 30 ? "#fff" : "var(--text-secondary)"
                }}
              >
                30 FPS
              </button>
            </div>
          </div>

          <div style={styles.videoSetCol}>
            <span style={styles.videoSetLabel}>Quality (bitrate)</span>
            <div style={styles.buttonGroup}>
              {([
                { key: "High", label: "High", hint: "22 Mbps" },
                { key: "Medium", label: "Medium", hint: "14 Mbps" },
                { key: "Low", label: "Low", hint: "8 Mbps" },
              ] as const).map((q) => {
                const sel = video?.quality === q.key;
                return (
                  <button
                    key={q.key}
                    onClick={() => video && saveVideo(video.fps, q.key)}
                    style={{
                      ...styles.qualityBtn,
                      backgroundColor: sel ? "var(--accent-blue)" : "var(--bg-app)",
                      borderColor: sel ? "var(--accent-blue)" : "var(--border-strong)",
                      color: sel ? "#fff" : "var(--text-secondary)",
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
            Captured at your game's native resolution (no rescaling, so no FPS drop). The higher the
            bitrate, the sharper the motion but the larger the file.
          </span>
        </div>
      </motion.div>

      <motion.div variants={itemVariants} style={styles.card}>
        <h3 style={styles.cardTitle}>Manual Test Recording</h3>
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
                style={{ ...styles.btn, backgroundColor: "var(--accent-blue)" }}
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
    backgroundColor: "var(--bg-app)",
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
    backgroundColor: "var(--bg-card)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-4)",
    borderLeft: "4px solid var(--accent-gold)",
  },
  inlineCode: {
    fontFamily: "monospace",
    fontSize: "12px",
    backgroundColor: "var(--bg-app)",
    padding: "1px 6px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border-subtle)",
    color: "var(--text-secondary)",
  },
  details: {
    backgroundColor: "var(--bg-card)",
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
    backgroundColor: "var(--bg-panel)",
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
    backgroundColor: "var(--bg-card)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-4)",
    borderLeft: "4px solid var(--text-muted)",
  },
  statusBoxActive: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-4)",
    backgroundColor: "var(--bg-card)",
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
    color: "#fff",
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
