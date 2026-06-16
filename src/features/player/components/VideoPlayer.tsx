import React, { useRef, useState, useEffect, useCallback } from "react";
import { MatchMetadata, MatchEvent } from "../../../types";
import { computeKDA, kdaRatio, outcome, formatDuration } from "../../../core/matchStats";
import { ChampionAvatar } from "../../../components/ChampionAvatar";

/**
 * Construye la URL de nuestro protocolo de streaming propio (con soporte de Range).
 * En Windows, los protocolos personalizados de Tauri se sirven en http://<scheme>.localhost/
 */
const streamUrl = (path: string): string =>
  `http://stream.localhost/${encodeURIComponent(path)}`;

// Ventana de clip por evento (estilo Outplayed/Valorant): 10s antes y 10s después.
const CLIP_BEFORE = 10;
const CLIP_AFTER = 10;

type Tone = "good" | "bad" | "neutral";
interface EvMeta {
  icon: string;
  color: string;
  label: string;
  tone: Tone;
  category: "kills" | "deaths" | "assists" | "objectives" | "structures" | "abilities" | "other";
}

const ULT_COLOR = "hsl(280, 80%, 66%)";

const MULTIKILL_COLOR = "hsl(25, 92%, 56%)";
const BARON_COLOR = "hsl(265, 70%, 62%)";

// Para objetivos (dragón/barón/heraldo): "ally" = lo tomó tu equipo (bueno).
const objTone = (s?: string): Tone => (s === "ally" ? "good" : s === "enemy" ? "bad" : "neutral");
// Para estructuras (torre/inhib): "ally" = estructura aliada caída (malo).
const structTone = (s?: string): Tone => (s === "ally" ? "bad" : s === "enemy" ? "good" : "neutral");
const objColor = (s: string | undefined, base: string) => (s === "enemy" ? "var(--color-death)" : base);
const structColor = (s?: string) => (s === "ally" ? "var(--color-death)" : "var(--accent-teal)");

function eventMeta(ev: MatchEvent): EvMeta {
  switch (ev.type) {
    case "ChampionKill":
      if (ev.subtype === "kill")
        return { icon: "⚔️", color: "var(--color-kill)", label: "Asesinato", tone: "good", category: "kills" };
      if (ev.subtype === "death")
        return { icon: "💀", color: "var(--color-death)", label: "Muerte", tone: "bad", category: "deaths" };
      return { icon: "🤝", color: "var(--color-assist)", label: "Asistencia", tone: "good", category: "assists" };
    case "Multikill":
      return { icon: "🔥", color: MULTIKILL_COLOR, label: "Multi-asesinato", tone: "good", category: "kills" };
    case "FirstBlood":
      return { icon: "🩸", color: "var(--color-kill)", label: "Primera sangre", tone: "good", category: "kills" };
    case "DragonKill":
      return { icon: "🐉", color: objColor(ev.subtype, "var(--color-objective)"), label: "Dragón", tone: objTone(ev.subtype), category: "objectives" };
    case "BaronKill":
      return { icon: "👑", color: objColor(ev.subtype, BARON_COLOR), label: "Barón Nashor", tone: objTone(ev.subtype), category: "objectives" };
    case "HeraldKill":
      return { icon: "👁️", color: objColor(ev.subtype, "var(--accent-blue)"), label: "Heraldo", tone: objTone(ev.subtype), category: "objectives" };
    case "TowerKill":
      return { icon: "🏰", color: structColor(ev.subtype), label: "Torre", tone: structTone(ev.subtype), category: "structures" };
    case "InhibKill":
      return { icon: "🧱", color: structColor(ev.subtype), label: "Inhibidor", tone: structTone(ev.subtype), category: "structures" };
    case "Ultimate":
      return { icon: "✨", color: ULT_COLOR, label: "Ultimate (R)", tone: "good", category: "abilities" };
    case "GameStart":
      return { icon: "🏁", color: "var(--text-muted)", label: "Inicio", tone: "neutral", category: "other" };
    case "GameEnd":
      return ev.subtype === "win"
        ? { icon: "🏆", color: "var(--color-victory)", label: "Victoria", tone: "good", category: "other" }
        : ev.subtype === "lose"
        ? { icon: "🏳️", color: "var(--color-defeat)", label: "Derrota", tone: "bad", category: "other" }
        : { icon: "🏁", color: "var(--text-muted)", label: "Fin", tone: "neutral", category: "other" };
    default:
      return { icon: "•", color: "var(--accent-blue)", label: ev.type, tone: "neutral", category: "other" };
  }
}

// Genera un path SVG suave (interpolación Catmull-Rom → curvas de Bézier).
function smoothLinePath(pts: [number, number][]): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${cp1x.toFixed(2)} ${cp1y.toFixed(2)} ${cp2x.toFixed(2)} ${cp2y.toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d;
}

const FILTERS = [
  { id: "all", label: "Todos" },
  { id: "kills", label: "⚔️ Kills" },
  { id: "deaths", label: "💀 Muertes" },
  { id: "assists", label: "🤝 Asist." },
  { id: "objectives", label: "🐉 Objetivos" },
  { id: "structures", label: "🏰 Estructuras" },
  { id: "abilities", label: "✨ Ultis" },
];

type LoadState = "loading" | "ready" | "error";

interface VideoPlayerProps {
  match: MatchMetadata;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({ match }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const clipEndRef = useRef<number | null>(null);

  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(match.game_duration || 0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [activeFilter, setActiveFilter] = useState<string>("all");
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [buffering, setBuffering] = useState<boolean>(false);
  const [volume, setVolume] = useState<number>(1);
  const [muted, setMuted] = useState<boolean>(false);
  const [hasAudio, setHasAudio] = useState<boolean>(true);
  const [clipMode, setClipMode] = useState<boolean>(true);
  const [activeEventTime, setActiveEventTime] = useState<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const videoSrc = streamUrl(match.video_path);

  useEffect(() => {
    setCurrentTime(0);
    setIsPlaying(false);
    setLoadState("loading");
    setBuffering(false);
    setHasAudio(true);
    setActiveEventTime(null);
    clipEndRef.current = null;
    if (videoRef.current) videoRef.current.load();
  }, [match]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = muted;
    }
  }, [volume, muted]);

  const handlePlayPause = useCallback(() => {
    const v = videoRef.current;
    if (!v || loadState === "error") return;
    clipEndRef.current = null; // reproducción libre cancela el límite de clip
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, [loadState]);

  const seekTo = useCallback((seconds: number, play: boolean) => {
    const v = videoRef.current;
    if (!v) return;
    const target = Math.max(0, Math.min(seconds, duration || seconds));
    v.currentTime = target;
    setCurrentTime(target);
    if (play && v.paused) v.play().catch(() => {});
  }, [duration]);

  // Salta al INICIO del clip (10s antes del evento) y, en modo clip, se detiene 10s después.
  const jumpToClip = useCallback((eventTime: number) => {
    clipEndRef.current = clipMode ? eventTime + CLIP_AFTER : null;
    setActiveEventTime(eventTime);
    seekTo(Math.max(0, eventTime - CLIP_BEFORE), true);
  }, [clipMode, seekTo]);

  // Navega al evento anterior/siguiente (jugada por jugada).
  const goToAdjacentEvent = useCallback((dir: 1 | -1) => {
    const times = match.events
      .filter((e) => e.type !== "GameStart" && e.type !== "GameEnd")
      .map((e) => e.time)
      .sort((a, b) => a - b);
    if (!times.length) return;
    const cur = activeEventTime ?? currentTime;
    let target: number | undefined;
    if (dir === 1) target = times.find((t) => t > cur + 0.5);
    else target = [...times].reverse().find((t) => t < cur - 0.5);
    if (target === undefined) target = dir === 1 ? times[0] : times[times.length - 1];
    jumpToClip(target);
  }, [match.events, activeEventTime, currentTime, jumpToClip]);

  const handleTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    setCurrentTime(v.currentTime);
    // En modo clip, pausar al final de la ventana del evento.
    if (clipEndRef.current !== null && v.currentTime >= clipEndRef.current) {
      v.pause();
      clipEndRef.current = null;
    }
  };

  const handleLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    if (isFinite(v.duration) && v.duration > 0) setDuration(v.duration);
    setLoadState("ready");
    const anyV = v as any;
    if (anyV.audioTracks?.length !== undefined) setHasAudio(anyV.audioTracks.length > 0);
    else if (anyV.mozHasAudio !== undefined) setHasAudio(!!anyV.mozHasAudio);
  };

  const handleProgressBarClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (progressBarRef.current && duration > 0) {
      const rect = progressBarRef.current.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      clipEndRef.current = null;
      setActiveEventTime(null);
      seekTo(pct * duration, true);
    }
  };

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const v = videoRef.current;
      if (!v) return;
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          handlePlayPause();
          break;
        case "ArrowRight": clipEndRef.current = null; seekTo(v.currentTime + 5, false); break;
        case "ArrowLeft": clipEndRef.current = null; seekTo(v.currentTime - 5, false); break;
        case "m": setMuted((m) => !m); break;
        case "f": toggleFullscreen(); break;
        case "n": e.preventDefault(); goToAdjacentEvent(1); break;
        case "p": e.preventDefault(); goToAdjacentEvent(-1); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlePlayPause, seekTo, goToAdjacentEvent]);

  const formatTime = (seconds: number): string => {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const passesFilter = (ev: MatchEvent): boolean => {
    if (activeFilter === "all") return true;
    return eventMeta(ev).category === activeFilter;
  };

  // Eventos con marca de tiempo (excluye inicio/fin para la barra y segmentos).
  const timedEvents = match.events.filter((ev) => ev.type !== "GameStart" && ev.type !== "GameEnd");
  const barEvents = timedEvents.filter(passesFilter);
  const listEvents = match.events.filter(passesFilter);

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  const kda = computeKDA(match.events);
  const result = outcome(match.result);
  const resultAccent = result === "victory" ? "var(--color-victory)" : result === "defeat" ? "var(--color-defeat)" : "var(--text-muted)";
  const resultLabel = result === "victory" ? "VICTORIA" : result === "defeat" ? "DERROTA" : "PARTIDA";
  const apm = Math.round(match.apm ?? 0);

  // Construir el gráfico de APM (curva suave con relleno) alineado con la barra de tiempo.
  const apmSeries = match.apm_series ?? [];
  const apmPeak = apmSeries.length ? Math.round(Math.max(...apmSeries)) : 0;
  let apmLinePath = "";
  let apmAreaPath = "";
  if (apmSeries.length >= 2) {
    const maxApm = Math.max(1, ...apmSeries);
    const n = apmSeries.length;
    const pts: [number, number][] = apmSeries.map((v, i) => {
      const x = (i / (n - 1)) * 100;
      const y = 38 - (v / maxApm) * 34; // 38 (suelo) .. 4 (techo)
      return [x, y];
    });
    apmLinePath = smoothLinePath(pts);
    apmAreaPath = `${apmLinePath} L100 40 L0 40 Z`;
  }

  const videoStyle = isFullscreen ? { ...styles.video, maxHeight: "100%" } : styles.video;

  return (
    <div ref={containerRef} style={styles.container}>
      {/* Cabecera analítica de la partida (oculta en pantalla completa) */}
      {!isFullscreen && (
        <div style={styles.playerHeader}>
          <ChampionAvatar champion={match.champion} size={42} ring={resultAccent} />
          <div style={styles.headerInfo}>
            <span style={styles.headerChamp}>{match.champion}</span>
            <span style={styles.headerSub}>{match.date}</span>
          </div>
          <div style={styles.headerStats}>
            <div style={styles.statItem}>
              <span style={styles.statValue}>
                <span style={{ color: "var(--text-primary)" }}>{kda.kills}</span>
                <span style={styles.statSep}>/</span>
                <span style={{ color: "var(--color-death)" }}>{kda.deaths}</span>
                <span style={styles.statSep}>/</span>
                <span style={{ color: "var(--accent-teal)" }}>{kda.assists}</span>
              </span>
              <span style={styles.statLabel}>KDA</span>
            </div>
            <div style={styles.statDivider} />
            <div style={styles.statItem}>
              <span style={{ ...styles.statValue, color: "var(--accent-gold)" }}>{kdaRatio(kda)}</span>
              <span style={styles.statLabel}>RATIO</span>
            </div>
            {apm > 0 && (
              <>
                <div style={styles.statDivider} />
                <div style={styles.statItem}>
                  <span style={{ ...styles.statValue, color: "var(--accent-violet)" }}>{apm}</span>
                  <span style={styles.statLabel}>APM</span>
                </div>
              </>
            )}
            <div style={styles.statDivider} />
            <div style={styles.statItem}>
              <span style={styles.statValue}>{formatDuration(duration || match.game_duration)}</span>
              <span style={styles.statLabel}>DURACIÓN</span>
            </div>
          </div>
          <span style={{ ...styles.headerResult, color: resultAccent, borderColor: resultAccent }}>{resultLabel}</span>
        </div>
      )}

      {/* Video */}
      <div style={styles.videoWrapper}>
        <video
          ref={videoRef}
          src={videoSrc}
          style={videoStyle}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onClick={handlePlayPause}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onWaiting={() => setBuffering(true)}
          onPlaying={() => setBuffering(false)}
          onCanPlay={() => { setBuffering(false); if (loadState !== "error") setLoadState("ready"); }}
          onError={() => setLoadState("error")}
          preload="auto"
        />

        {loadState === "loading" && (
          <div style={styles.centerOverlay}>
            <div className="spinner" />
            <span style={styles.overlayText}>Cargando video…</span>
          </div>
        )}
        {loadState === "error" && (
          <div style={styles.centerOverlay}>
            <span style={{ fontSize: "44px" }}>⚠️</span>
            <span style={styles.overlayText}>No se pudo cargar el video</span>
            <span style={styles.overlaySub}>El archivo podría estar dañado o vacío (una grabación fallida). Ruta:</span>
            <code style={styles.pathCode}>{match.video_path}</code>
          </div>
        )}
        {buffering && loadState === "ready" && (
          <div style={styles.bufferOverlay}><div className="spinner" /></div>
        )}
        {!isPlaying && loadState === "ready" && !buffering && (
          <div style={styles.playOverlay} onClick={handlePlayPause}>
            <div style={styles.bigPlayButton}>▶</div>
          </div>
        )}
      </div>

      {/* Controles */}
      <div style={styles.controlsWrapper}>
        <div style={{ ...styles.progressBarWrapper, paddingTop: "66px" }}>
          <button onClick={() => goToAdjacentEvent(-1)} style={styles.navBtn} title="Evento anterior (P)">⏮</button>
          <button onClick={handlePlayPause} style={styles.playToggle} title="Reproducir/Pausar (Espacio)">
            {isPlaying ? "❚❚" : "▶"}
          </button>
          <button onClick={() => goToAdjacentEvent(1)} style={styles.navBtn} title="Evento siguiente (N)">⏭</button>
          <span style={styles.timeLabel}>{formatTime(currentTime)}</span>

          <div ref={progressBarRef} onClick={handleProgressBarClick} style={styles.progressBar}>
            {/* Gráfico de APM (curva suave con relleno, estilo Outplayed) */}
            {apmSeries.length >= 2 && (
              <>
                <svg viewBox="0 0 100 40" preserveAspectRatio="none" style={styles.sparkline}>
                  <defs>
                    <linearGradient id="apmGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--accent-violet)" stopOpacity="0.55" />
                      <stop offset="100%" stopColor="var(--accent-violet)" stopOpacity="0.02" />
                    </linearGradient>
                  </defs>
                  <path d={apmAreaPath} fill="url(#apmGrad)" />
                  <path d={apmLinePath} fill="none" stroke="var(--accent-violet)" strokeWidth={1.8} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
                </svg>
                <span style={styles.apmBadge}>APM máx {apmPeak}</span>
              </>
            )}

            {/* Iconos de cada evento por encima de la barra */}
            {duration > 0 && barEvents.map((ev, i) => {
              const meta = eventMeta(ev);
              const pos = (ev.time / duration) * 100;
              const isActive = activeEventTime === ev.time;
              return (
                <div
                  key={`ic-${i}`}
                  onClick={(e) => { e.stopPropagation(); jumpToClip(ev.time); }}
                  title={`${meta.label}: ${ev.description} · ${formatTime(ev.time)}  (clip ${CLIP_BEFORE}s/${CLIP_AFTER}s)`}
                  style={{
                    ...styles.iconMarker,
                    left: `${pos}%`,
                    borderColor: meta.color,
                    transform: `translateX(-50%) scale(${isActive ? 1.18 : 1})`,
                    boxShadow: isActive ? `0 0 10px ${meta.color}` : "var(--shadow-sm)",
                    zIndex: isActive ? 9 : 6,
                  }}
                >
                  {meta.icon}
                </div>
              );
            })}

            {/* Segmentos de clip (10s antes/después) */}
            {duration > 0 && barEvents.map((ev, i) => {
              const meta = eventMeta(ev);
              const segStart = Math.max(0, ev.time - CLIP_BEFORE);
              const segEnd = Math.min(duration, ev.time + CLIP_AFTER);
              const left = (segStart / duration) * 100;
              const width = ((segEnd - segStart) / duration) * 100;
              const isActive = activeEventTime === ev.time;
              return (
                <div
                  key={`seg-${i}`}
                  onClick={(e) => { e.stopPropagation(); jumpToClip(ev.time); }}
                  style={{
                    ...styles.clipBand,
                    left: `${left}%`,
                    width: `${width}%`,
                    backgroundColor: meta.color,
                    opacity: isActive ? 0.5 : 0.2,
                    borderColor: isActive ? meta.color : "transparent",
                  }}
                />
              );
            })}

            {/* Relleno de progreso */}
            <div style={{ ...styles.progressFill, width: `${progressPct}%` }} />
            <div style={{ ...styles.progressThumb, left: `${progressPct}%` }} />

            {/* Marca fina en el instante exacto del evento */}
            {duration > 0 && barEvents.map((ev, i) => {
              const meta = eventMeta(ev);
              const pos = (ev.time / duration) * 100;
              return <div key={`tk-${i}`} style={{ ...styles.tick, left: `${pos}%`, background: meta.color }} />;
            })}
          </div>

          <span style={styles.timeLabel}>{formatTime(duration)}</span>

          <div style={styles.volumeGroup}>
            <button onClick={() => setMuted((m) => !m)} style={styles.iconBtn} title={muted ? "Activar sonido (M)" : "Silenciar (M)"}>
              {muted || volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}
            </button>
            <input
              type="range" min={0} max={1} step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => { setVolume(parseFloat(e.target.value)); setMuted(false); }}
              style={styles.volumeSlider} title="Volumen"
            />
          </div>
          <button onClick={toggleFullscreen} style={styles.iconBtn} title="Pantalla completa (F)">⛶</button>
        </div>

        <div style={styles.bottomControls}>
          <div style={styles.filters}>
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setActiveFilter(f.id)}
                style={{
                  ...styles.filterBtn,
                  color: activeFilter === f.id ? "var(--text-primary)" : "var(--text-secondary)",
                  backgroundColor: activeFilter === f.id ? "var(--bg-elevated)" : "transparent",
                  borderColor: activeFilter === f.id ? "var(--border-strong)" : "var(--border-subtle)",
                }}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div style={styles.rightControls}>
            <button
              onClick={() => setClipMode((c) => !c)}
              style={{
                ...styles.clipToggle,
                color: clipMode ? "var(--bg-app)" : "var(--text-secondary)",
                background: clipMode ? "var(--gradient-teal)" : "transparent",
                borderColor: clipMode ? "transparent" : "var(--border-strong)",
              }}
              title={`En modo clip, al pulsar un evento se reproduce desde ${CLIP_BEFORE}s antes y se pausa ${CLIP_AFTER}s después`}
            >
              ✂️ Modo clip {clipMode ? "ON" : "OFF"}
            </button>
            {!hasAudio && <span style={styles.noAudioBadge} title="Esta grabación no contiene pista de audio">🔇 Sin audio</span>}
            <span style={styles.metaValue}>{match.champion}</span>
          </div>
        </div>
      </div>

      {/* Lista de eventos (oculta en pantalla completa para dar más espacio al video) */}
      {!isFullscreen && (
      <div style={styles.timelineList}>
        <div style={styles.timelineHeader}>
          <h4 style={styles.timelineTitle}>Eventos de la Partida</h4>
          <span style={styles.eventCount}>{listEvents.length} eventos</span>
        </div>
        <div style={styles.eventsGrid}>
          {listEvents.map((ev, i) => {
            const meta = eventMeta(ev);
            const isSelectable = ev.type !== "GameStart" && ev.type !== "GameEnd";
            const isActive = activeEventTime === ev.time && isSelectable;
            return (
              <div
                key={i}
                onClick={() => isSelectable && jumpToClip(ev.time)}
                style={{
                  ...styles.eventItem,
                  cursor: isSelectable ? "pointer" : "default",
                  borderColor: isActive ? meta.color : "var(--border-subtle)",
                  borderLeftColor: meta.color,
                  background: isActive ? "var(--bg-elevated)" : "var(--bg-card)",
                }}
              >
                <span style={styles.eventIcon}>{meta.icon}</span>
                <div style={styles.eventBody}>
                  <span style={styles.eventDesc}>{ev.description}</span>
                  <span style={{ ...styles.eventLabel, color: meta.color }}>{meta.label}</span>
                </div>
                <span style={styles.eventTime}>{formatTime(ev.time)}</span>
                {isSelectable && <span style={styles.eventJump}>▶</span>}
              </div>
            );
          })}
        </div>
      </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: { flex: 1, display: "flex", flexDirection: "column", height: "100%", boxSizing: "border-box", overflow: "hidden" },
  playerHeader: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    padding: "var(--space-3) var(--space-5)",
    background: "linear-gradient(180deg, var(--bg-panel), var(--bg-app))",
    borderBottom: "1px solid var(--border-subtle)",
    flexShrink: 0,
  },
  headerAvatar: {
    width: "42px",
    height: "42px",
    flexShrink: 0,
    borderRadius: "var(--radius-full)",
    background: "linear-gradient(160deg, var(--bg-elevated), var(--bg-app))",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "var(--font-sm)",
    fontWeight: 800,
    color: "var(--text-primary)",
  },
  headerInfo: { display: "flex", flexDirection: "column", gap: "1px", minWidth: 0 },
  headerChamp: { fontSize: "var(--font-md)", fontWeight: 800, color: "var(--text-primary)", letterSpacing: "-0.02em" },
  headerSub: { fontSize: "var(--font-xs)", color: "var(--text-muted)" },
  headerStats: { display: "flex", alignItems: "center", gap: "var(--space-4)", marginLeft: "auto" },
  statItem: { display: "flex", flexDirection: "column", alignItems: "center", gap: "2px" },
  statValue: { fontSize: "var(--font-md)", fontWeight: 800, fontFamily: "monospace", display: "flex", gap: "3px" },
  statSep: { color: "var(--text-muted)", fontWeight: 400 },
  statLabel: { fontSize: "9px", fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.1em" },
  statDivider: { width: "1px", height: "28px", background: "var(--border-subtle)" },
  headerResult: {
    fontSize: "var(--font-xs)",
    fontWeight: 800,
    letterSpacing: "0.08em",
    padding: "4px var(--space-3)",
    borderRadius: "var(--radius-full)",
    border: "1px solid currentColor",
    marginLeft: "var(--space-4)",
    flexShrink: 0,
  },
  videoWrapper: { position: "relative", flex: 1.8, backgroundColor: "#000", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", minHeight: 0 },
  video: { width: "100%", height: "100%", maxHeight: "calc(100vh - 450px)", objectFit: "contain", cursor: "pointer" },
  centerOverlay: { position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "var(--space-3)", backgroundColor: "rgba(0,0,0,0.55)", padding: "var(--space-6)", textAlign: "center" },
  overlayText: { fontSize: "var(--font-md)", fontWeight: 700, color: "var(--text-primary)" },
  overlaySub: { fontSize: "var(--font-xs)", color: "var(--text-muted)", maxWidth: "480px" },
  pathCode: { fontSize: "11px", fontFamily: "monospace", color: "var(--text-secondary)", backgroundColor: "var(--bg-card)", padding: "var(--space-2) var(--space-3)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-subtle)", maxWidth: "90%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  bufferOverlay: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.25)" },
  playOverlay: { position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" },
  bigPlayButton: { width: "76px", height: "76px", borderRadius: "var(--radius-full)", background: "linear-gradient(160deg, rgba(20,30,45,0.92), rgba(10,16,26,0.92))", border: "2px solid var(--accent-gold)", color: "var(--text-primary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "30px", paddingLeft: "6px", boxShadow: "var(--shadow-lg), 0 0 24px hsla(41,60%,55%,0.25)" },
  controlsWrapper: { backgroundColor: "var(--bg-panel)", borderTop: "1px solid var(--border-subtle)", borderBottom: "1px solid var(--border-subtle)", padding: "var(--space-4) var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-3)" },
  progressBarWrapper: { display: "flex", alignItems: "center", gap: "var(--space-2)" },
  navBtn: { width: "32px", height: "32px", flexShrink: 0, borderRadius: "var(--radius-full)", border: "1px solid var(--border-subtle)", background: "transparent", color: "var(--text-secondary)", fontSize: "12px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
  playToggle: { width: "38px", height: "38px", flexShrink: 0, borderRadius: "var(--radius-full)", border: "1px solid var(--border-strong)", background: "var(--bg-elevated)", color: "var(--text-primary)", fontSize: "13px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", marginRight: "var(--space-2)" },
  sparkline: { position: "absolute", left: 0, top: "-62px", width: "100%", height: "56px", overflow: "visible", pointerEvents: "none", zIndex: 1 },
  apmBadge: { position: "absolute", top: "-62px", right: 0, fontSize: "9px", fontWeight: 700, letterSpacing: "0.04em", color: "var(--accent-violet)", background: "var(--bg-app)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)", padding: "1px 6px", pointerEvents: "none", zIndex: 7 },
  iconMarker: { position: "absolute", top: "-40px", width: "24px", height: "24px", borderRadius: "var(--radius-full)", background: "var(--bg-elevated)", border: "2px solid var(--accent-blue)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", cursor: "pointer", zIndex: 6 },
  tick: { position: "absolute", top: 0, width: "2px", height: "100%", transform: "translateX(-50%)", borderRadius: "1px", opacity: 0.85, zIndex: 3, pointerEvents: "none" },
  timeLabel: { fontSize: "var(--font-xs)", fontWeight: 600, fontFamily: "monospace", color: "var(--text-secondary)", width: "46px", textAlign: "center", flexShrink: 0 },
  progressBar: { flex: 1, height: "14px", backgroundColor: "var(--bg-app)", borderRadius: "var(--radius-full)", position: "relative", cursor: "pointer", border: "1px solid var(--border-subtle)" },
  clipBand: { position: "absolute", top: 0, bottom: 0, borderRadius: "var(--radius-sm)", border: "1px solid transparent", cursor: "pointer", zIndex: 1 },
  progressFill: { height: "100%", background: "var(--gradient-teal)", borderRadius: "var(--radius-full)", position: "absolute", top: 0, left: 0, opacity: 0.9, zIndex: 2, pointerEvents: "none" },
  progressThumb: { position: "absolute", top: "50%", width: "16px", height: "16px", borderRadius: "var(--radius-full)", background: "var(--text-primary)", border: "2px solid var(--accent-teal)", transform: "translate(-50%, -50%)", boxShadow: "var(--shadow-sm)", zIndex: 4, pointerEvents: "none" },
  marker: { width: "12px", height: "12px", borderRadius: "var(--radius-full)", position: "absolute", top: "50%", transform: "translate(-50%, -50%)", cursor: "pointer", zIndex: 3, border: "2px solid var(--bg-panel)" },
  volumeGroup: { display: "flex", alignItems: "center", gap: "var(--space-1)", flexShrink: 0 },
  volumeSlider: { width: "80px", accentColor: "var(--accent-teal)", cursor: "pointer" },
  iconBtn: { width: "34px", height: "34px", flexShrink: 0, borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle)", background: "transparent", color: "var(--text-secondary)", fontSize: "15px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
  bottomControls: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" },
  filters: { display: "flex", gap: "var(--space-2)", flexWrap: "wrap" },
  filterBtn: { background: "transparent", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", padding: "var(--space-2) var(--space-3)", fontSize: "var(--font-xs)", fontWeight: 700, cursor: "pointer" },
  rightControls: { display: "flex", alignItems: "center", gap: "var(--space-3)" },
  clipToggle: { border: "1px solid var(--border-strong)", borderRadius: "var(--radius-md)", padding: "var(--space-2) var(--space-3)", fontSize: "var(--font-xs)", fontWeight: 800, cursor: "pointer" },
  noAudioBadge: { fontSize: "var(--font-xs)", fontWeight: 700, color: "var(--color-defeat)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-full)", padding: "2px var(--space-2)" },
  metaValue: { fontWeight: 700, color: "var(--accent-gold)", fontSize: "var(--font-sm)" },
  timelineList: { flex: 1, padding: "var(--space-4) var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-3)", overflowY: "auto", minHeight: 0 },
  timelineHeader: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  timelineTitle: { margin: 0, fontSize: "var(--font-xs)", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-muted)" },
  eventCount: { fontSize: "var(--font-xs)", color: "var(--text-muted)" },
  eventsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "var(--space-2)" },
  eventItem: { display: "flex", alignItems: "center", gap: "var(--space-3)", padding: "var(--space-2) var(--space-3)", border: "1px solid var(--border-subtle)", borderLeft: "3px solid var(--border-subtle)", borderRadius: "var(--radius-md)" },
  eventIcon: { fontSize: "18px", flexShrink: 0, width: "24px", textAlign: "center" },
  eventBody: { display: "flex", flexDirection: "column", gap: "1px", flex: 1, minWidth: 0 },
  eventDesc: { fontSize: "var(--font-sm)", fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  eventLabel: { fontSize: "10px", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" },
  eventTime: { fontSize: "var(--font-xs)", color: "var(--text-muted)", fontFamily: "monospace", flexShrink: 0 },
  eventJump: { fontSize: "10px", color: "var(--accent-teal)", flexShrink: 0 },
};
