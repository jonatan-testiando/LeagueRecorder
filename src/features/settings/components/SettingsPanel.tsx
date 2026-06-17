import React, { useState, useEffect } from "react";
import { getRecorderStatus, startManualRecording, stopManualRecording, getAudioStatus, getUltimateSettings, setUltimateSettings, getVideoSettings, setVideoSettings } from "../../../core/tauri-ipc";
import { AudioStatus, UltimateSettings, VideoSettings } from "../../../types";
import { Sparkles, Volume2, CheckCircle2, AlertTriangle, RefreshCw, Monitor } from "lucide-react";

export const SettingsPanel: React.FC = () => {
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [manualId, setManualId] = useState<string>("");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [audio, setAudio] = useState<AudioStatus | null>(null);
  const [audioLoading, setAudioLoading] = useState<boolean>(false);
  const [ult, setUlt] = useState<UltimateSettings | null>(null);
  const [video, setVideo] = useState<VideoSettings | null>(null);

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
    const interval = setInterval(checkStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleStartManual = async () => {
    if (!manualId.trim()) {
      alert("Por favor introduce un ID o nombre para la prueba manual");
      return;
    }
    
    setIsProcessing(true);
    setStatusMsg("Iniciando grabación de prueba...");
    try {
      await startManualRecording(manualId.trim());
      setIsRecording(true);
      setStatusMsg("Grabación en curso. Puedes interactuar con tu PC.");
    } catch (err) {
      setStatusMsg("Error: " + err);
      alert("No se pudo iniciar: " + err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleStopManual = async () => {
    setIsProcessing(true);
    setStatusMsg("Deteniendo y guardando clip...");
    try {
      await stopManualRecording();
      setIsRecording(false);
      setStatusMsg("Clip guardado con éxito. Revisa la sección 'Tus Partidas'.");
      setManualId("");
    } catch (err) {
      setStatusMsg("Error al detener: " + err);
      alert("No se pudo detener: " + err);
    } finally {
      setIsProcessing(false);
    }
  };

  const audioReady = audio?.ready_for_game_audio ?? false;

  return (
    <div style={styles.container}>
      <div>
        <h2 style={styles.title}>Panel de Control</h2>
        <p style={styles.subtitle}>Estado de la grabadora, captura de audio y detección automática de partidas.</p>
      </div>

      {/* Detección de ultimate (R) */}
      <div style={styles.card}>
        <div style={styles.cardTitleRow}>
          <h3 style={styles.cardTitle}>
            <Sparkles size={20} color="var(--accent-violet)" style={{ marginRight: "8px" }} />
            Detección de Ultimate (R)
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
            {ult?.enabled ? "Activado" : "Desactivado"}
          </button>
        </div>
        <p style={styles.cardText}>
          La API de Riot <strong>no informa</strong> del uso de habilidades, así que esto se detecta por la
          tecla mientras grabas (best-effort). Solo se marca cuando tu ultimate ya está disponible (nivel ≥ 6).
          Puede haber algún falso positivo si la pulsas en enfriamiento.
        </p>
        <div style={styles.ultRow}>
          <span style={styles.ultLabel}>Tecla de la ultimate:</span>
          <input
            type="text"
            maxLength={1}
            value={ult?.key ?? "R"}
            onChange={(e) => ult && setUlt({ ...ult, key: e.target.value.toUpperCase() })}
            onBlur={() => ult && saveUlt(ult.enabled, ult.key)}
            style={styles.keyInput}
          />
          <span style={styles.ultHint}>Por defecto R. Cámbiala si reasignaste tu ultimate.</span>
        </div>
      </div>

      {/* Estado del audio del juego */}
      <div style={styles.card}>
        <div style={styles.cardTitleRow}>
          <h3 style={styles.cardTitle}>
            <Volume2 size={20} color="var(--accent-gold)" style={{ marginRight: "8px" }} />
            Captura de Sonido del Juego
          </h3>
          <button onClick={refreshAudio} disabled={audioLoading} style={styles.ghostBtn}>
            <RefreshCw size={14} style={{ marginRight: "6px" }} />
            {audioLoading ? "Comprobando…" : "Re-detectar"}
          </button>
        </div>

        <div style={{ ...styles.audioBanner, borderLeftColor: audioReady ? "var(--color-victory)" : "var(--accent-gold)" }}>
          <div style={{ flexShrink: 0, marginTop: "2px" }}>
            {audioReady ? <CheckCircle2 size={24} color="var(--color-victory)" /> : <AlertTriangle size={24} color="var(--accent-gold)" />}
          </div>
          <div>
            {audioReady ? (
              <>
                <span style={styles.statusTitle}>Listo para grabar el sonido del juego</span>
                <p style={styles.statusText}>
                  Dispositivo de sistema detectado: <strong style={{ color: "var(--accent-teal)" }}>{audio?.system_audio_device}</strong>
                </p>
              </>
            ) : (
              <>
                <span style={styles.statusTitle}>Falta un dispositivo de captura de sistema</span>
                <p style={styles.statusText}>
                  Para grabar el sonido del juego sin latencia, instala <strong>Screen Capturer Recorder</strong> (ya descargado en
                  <code style={styles.inlineCode}> Descargas\ScreenCaptureRecorder</code>): ejecuta
                  <code style={styles.inlineCode}>Setup.Screen.Capturer.Recorder…exe</code> como administrador (Siguiente → Siguiente). Añade el
                  dispositivo <strong>virtual-audio-capturer</strong>, que capta justo lo que oyes por tus auriculares. Luego pulsa “Re-detectar”.
                  Mientras tanto se grabará con el micrófono si está disponible.
                </p>
              </>
            )}
          </div>
        </div>

        {audio && audio.all_devices.length > 0 && (
          <details style={styles.details}>
            <summary style={styles.summary}>Dispositivos de audio detectados ({audio.all_devices.length})</summary>
            <ul style={styles.deviceList}>
              {audio.all_devices.map((d) => (
                <li key={d} style={{ color: d === audio.system_audio_device ? "var(--accent-teal)" : "var(--text-secondary)" }}>
                  {d}{d === audio.system_audio_device ? "  ← usado para el juego" : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {/* Configuración de Video */}
      <div style={styles.card}>
        <div style={styles.cardTitleRow}>
          <h3 style={styles.cardTitle}>
            <Monitor size={20} color="var(--accent-blue)" style={{ marginRight: "8px" }} />
            Calidad de Grabación de Video
          </h3>
        </div>
        <p style={styles.cardText}>
          Ajusta los FPS y la nitidez. Si notas que los videos pesan demasiado, baja la calidad a Media o Baja,
          o usa 30 FPS. Todas las resoluciones se escalan a 1080p.
        </p>
        
        <div style={styles.videoSettingsGrid}>
          <div style={styles.videoSetCol}>
            <span style={styles.videoSetLabel}>Tasa de Fotogramas (FPS)</span>
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
            <span style={styles.videoSetLabel}>Calidad de Imagen</span>
            <div style={styles.buttonGroup}>
              <button 
                onClick={() => video && saveVideo(video.fps, "High")}
                style={{
                  ...styles.selectBtn,
                  backgroundColor: video?.quality === "High" ? "var(--accent-blue)" : "var(--bg-app)",
                  borderColor: video?.quality === "High" ? "var(--accent-blue)" : "var(--border-strong)",
                  color: video?.quality === "High" ? "#fff" : "var(--text-secondary)"
                }}
              >
                Alta
              </button>
              <button 
                onClick={() => video && saveVideo(video.fps, "Medium")}
                style={{
                  ...styles.selectBtn,
                  backgroundColor: video?.quality === "Medium" ? "var(--accent-blue)" : "var(--bg-app)",
                  borderColor: video?.quality === "Medium" ? "var(--accent-blue)" : "var(--border-strong)",
                  color: video?.quality === "Medium" ? "#fff" : "var(--text-secondary)"
                }}
              >
                Media
              </button>
              <button 
                onClick={() => video && saveVideo(video.fps, "Low")}
                style={{
                  ...styles.selectBtn,
                  backgroundColor: video?.quality === "Low" ? "var(--accent-blue)" : "var(--bg-app)",
                  borderColor: video?.quality === "Low" ? "var(--accent-blue)" : "var(--border-strong)",
                  color: video?.quality === "Low" ? "#fff" : "var(--text-secondary)"
                }}
              >
                Baja
              </button>
            </div>
          </div>
        </div>
      </div>

      <div style={styles.card}>
        <h3 style={styles.cardTitle}>Grabación Manual de Prueba</h3>
        <p style={styles.cardText}>
          Utiliza esta herramienta para comprobar que FFmpeg y la aceleración de video por hardware (GPU) funcionan correctamente antes de entrar a una partida real.
        </p>

        {isRecording ? (
          <div style={styles.statusBoxActive}>
            <div style={styles.indicatorActive} />
            <div>
              <span style={styles.statusTitle}>Grabando Pantalla</span>
              <p style={styles.statusText}>{statusMsg || "Capturando video y audio..."}</p>
            </div>
          </div>
        ) : (
          <div style={styles.statusBoxInactive}>
            <div style={styles.indicatorInactive} />
            <div>
              <span style={styles.statusTitle}>Grabadora Inactiva</span>
              <p style={styles.statusText}>{statusMsg || "Esperando inicio automático o manual."}</p>
            </div>
          </div>
        )}

        <div style={styles.form}>
          {!isRecording ? (
            <>
              <input
                type="text"
                placeholder="Nombre de la prueba (ej. test_pantalla)"
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
                Grabar Pantalla Completa
              </button>
            </>
          ) : (
            <button
              onClick={handleStopManual}
              disabled={isProcessing}
              style={{ ...styles.btn, backgroundColor: "var(--color-defeat)" }}
            >
              Detener y Guardar Clip
            </button>
          )}
        </div>
      </div>

      <div style={styles.card}>
        <h3 style={styles.cardTitle}>Detección de Partidas</h3>
        <p style={styles.cardText}>
          El sistema en segundo plano está en ejecución constante. Cuando abres League of Legends y entras en partida:
        </p>
        <ul style={styles.list}>
          <li>Se conecta automáticamente a la API del juego en el puerto 2999.</li>
          <li>Inicia la grabación local a 1080p con cero impacto de rendimiento.</li>
          <li>Registra marcas de tiempo para kills, deaths, asistencias y objetivos.</li>
          <li>Guarda todo al finalizar el match de manera 100% automatizada.</li>
        </ul>
      </div>

      <div style={styles.card}>
        <h3 style={styles.cardTitle}>Requisitos de Sistema</h3>
        <ul style={styles.list}>
          <li>
            <strong>FFmpeg en el PATH:</strong> Asegúrate de que `ffmpeg` esté en el PATH de Windows. Si no, la grabadora no podrá arrancar.
          </li>
          <li>
            <strong>Resolución de Juego:</strong> La captura se escala automáticamente a 1080p 60fps usando codificación por hardware en la GPU para no afectar tus FPS.
          </li>
        </ul>
      </div>
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
};
