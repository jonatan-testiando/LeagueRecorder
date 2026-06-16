import React, { useRef, useState, useEffect, useCallback } from "react";
import { MatchMetadata, MatchEvent } from "../../../types";
import { computeKDA, kdaRatio, outcome, formatDuration } from "../../../core/matchStats";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { 
  Swords, Skull, Handshake, Flame, Droplet, 
  Orbit, Crown, Eye, TowerControl, BrickWall, 
  Sparkles, Flag, Trophy, FlagOff, Maximize, Play, Pause,
  SkipBack, SkipForward, VolumeX, Volume1, Volume2, Scissors, AlertTriangle, PlayCircle
} from "lucide-react";

/**
 * Construye la URL de nuestro protocolo de streaming propio (con soporte de Range).
 */
const streamUrl = (path: string): string =>
  `http://stream.localhost/${encodeURIComponent(path)}`;

const CLIP_BEFORE = 10;
const CLIP_AFTER = 10;

type Tone = "good" | "bad" | "neutral";
interface EvMeta {
  icon: React.ReactNode;
  color: string;
  label: string;
  tone: Tone;
  category: "kills" | "deaths" | "assists" | "objectives" | "structures" | "abilities" | "other";
}

const ULT_COLOR = "var(--accent-violet)";
const MULTIKILL_COLOR = "var(--accent-gold)";
const BARON_COLOR = "hsl(280, 80%, 70%)";

const objTone = (s?: string): Tone => (s === "ally" ? "good" : s === "enemy" ? "bad" : "neutral");
const structTone = (s?: string): Tone => (s === "ally" ? "bad" : s === "enemy" ? "good" : "neutral");
const objColor = (s: string | undefined, base: string) => (s === "enemy" ? "var(--color-death)" : base);
const structColor = (s?: string) => (s === "ally" ? "var(--color-death)" : "var(--accent-teal)");

function eventMeta(ev: MatchEvent): EvMeta {
  const size = 16;
  switch (ev.type) {
    case "ChampionKill":
      if (ev.subtype === "kill")
        return { icon: <Swords size={size} />, color: "var(--color-kill)", label: "Asesinato", tone: "good", category: "kills" };
      if (ev.subtype === "death")
        return { icon: <Skull size={size} />, color: "var(--color-death)", label: "Muerte", tone: "bad", category: "deaths" };
      return { icon: <Handshake size={size} />, color: "var(--color-assist)", label: "Asistencia", tone: "good", category: "assists" };
    case "Multikill":
      return { icon: <Flame size={size} />, color: MULTIKILL_COLOR, label: "Multi-asesinato", tone: "good", category: "kills" };
    case "FirstBlood":
      return { icon: <Droplet size={size} />, color: "var(--color-kill)", label: "Primera sangre", tone: "good", category: "kills" };
    case "DragonKill":
      return { icon: <Orbit size={size} />, color: objColor(ev.subtype, "var(--color-objective)"), label: "Dragón", tone: objTone(ev.subtype), category: "objectives" };
    case "BaronKill":
      return { icon: <Crown size={size} />, color: objColor(ev.subtype, BARON_COLOR), label: "Barón Nashor", tone: objTone(ev.subtype), category: "objectives" };
    case "HeraldKill":
      return { icon: <Eye size={size} />, color: objColor(ev.subtype, "var(--accent-blue)"), label: "Heraldo", tone: objTone(ev.subtype), category: "objectives" };
    case "TowerKill":
      return { icon: <TowerControl size={size} />, color: structColor(ev.subtype), label: "Torre", tone: structTone(ev.subtype), category: "structures" };
    case "InhibKill":
      return { icon: <BrickWall size={size} />, color: structColor(ev.subtype), label: "Inhibidor", tone: structTone(ev.subtype), category: "structures" };
    case "Ultimate":
      return { icon: <Sparkles size={size} />, color: ULT_COLOR, label: "Ultimate (R)", tone: "good", category: "abilities" };
    case "GameStart":
      return { icon: <Flag size={size} />, color: "var(--text-muted)", label: "Inicio", tone: "neutral", category: "other" };
    case "GameEnd":
      return ev.subtype === "win"
        ? { icon: <Trophy size={size} />, color: "var(--color-victory)", label: "Victoria", tone: "good", category: "other" }
        : ev.subtype === "lose"
        ? { icon: <FlagOff size={size} />, color: "var(--color-defeat)", label: "Derrota", tone: "bad", category: "other" }
        : { icon: <Flag size={size} />, color: "var(--text-muted)", label: "Fin", tone: "neutral", category: "other" };
    default:
      return { icon: <Sparkles size={size} />, color: "var(--accent-blue)", label: ev.type, tone: "neutral", category: "other" };
  }
}

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

const FILTERS: { id: string; label: string; icon: React.ReactNode }[] = [
  { id: "all", label: "Todos", icon: null },
  { id: "kills", label: "Kills", icon: <Swords size={14} /> },
  { id: "deaths", label: "Muertes", icon: <Skull size={14} /> },
  { id: "assists", label: "Asist.", icon: <Handshake size={14} /> },
  { id: "objectives", label: "Objetivos", icon: <Orbit size={14} /> },
  { id: "structures", label: "Estructuras", icon: <TowerControl size={14} /> },
  { id: "abilities", label: "Ultis", icon: <Sparkles size={14} /> },
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
    clipEndRef.current = null;
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

  const jumpToClip = useCallback((eventTime: number) => {
    clipEndRef.current = clipMode ? eventTime + CLIP_AFTER : null;
    setActiveEventTime(eventTime);
    seekTo(Math.max(0, eventTime - CLIP_BEFORE), true);
  }, [clipMode, seekTo]);

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

  const timedEvents = match.events.filter((ev) => ev.type !== "GameStart" && ev.type !== "GameEnd");
  const barEvents = timedEvents.filter(passesFilter);
  const listEvents = match.events.filter(passesFilter);

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  const kda = computeKDA(match.events);
  const result = outcome(match.result);
  const resultAccent = result === "victory" ? "var(--color-victory)" : result === "defeat" ? "var(--color-defeat)" : "var(--text-muted)";
  const resultLabel = result === "victory" ? "VICTORIA" : result === "defeat" ? "DERROTA" : "PARTIDA";
  const apm = Math.round(match.apm ?? 0);

  const apmSeries = match.apm_series ?? [];
  const apmPeak = apmSeries.length ? Math.round(Math.max(...apmSeries)) : 0;
  let apmLinePath = "";
  let apmAreaPath = "";
  if (apmSeries.length >= 2) {
    const maxApm = Math.max(1, ...apmSeries);
    const n = apmSeries.length;
    const pts: [number, number][] = apmSeries.map((v, i) => {
      const x = (i / (n - 1)) * 100;
      const y = 38 - (v / maxApm) * 34;
      return [x, y];
    });
    apmLinePath = smoothLinePath(pts);
    apmAreaPath = `${apmLinePath} L100 40 L0 40 Z`;
  }

  const videoStyle = isFullscreen ? { ...styles.video, maxHeight: "100%" } : styles.video;

  return (
    <div ref={containerRef} style={styles.container}>
      {!isFullscreen && (
        <div style={styles.playerHeader}>
          <ChampionAvatar champion={match.champion} size={48} ring={resultAccent} />
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
          <span style={{ ...styles.headerResult, color: resultAccent, borderColor: resultAccent, background: `color-mix(in srgb, ${resultAccent} 10%, transparent)` }}>
            {resultLabel}
          </span>
        </div>
      )}

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
            <AlertTriangle size={48} color="var(--color-defeat)" style={{ marginBottom: "var(--space-3)" }} />
            <span style={styles.overlayText}>No se pudo cargar el video</span>
            <span style={styles.overlaySub}>El archivo podría estar dañado o vacío.</span>
            <code style={styles.pathCode}>{match.video_path}</code>
          </div>
        )}
        {buffering && loadState === "ready" && (
          <div style={styles.bufferOverlay}><div className="spinner" /></div>
        )}
        {!isPlaying && loadState === "ready" && !buffering && (
          <div style={styles.playOverlay} onClick={handlePlayPause}>
            <div style={styles.bigPlayButton}>
              <Play fill="currentColor" size={32} />
            </div>
          </div>
        )}
      </div>

      <div style={styles.controlsWrapper}>
        <div style={{ ...styles.progressBarWrapper, paddingTop: "66px" }}>
          <button onClick={() => goToAdjacentEvent(-1)} style={styles.navBtn} title="Evento anterior (P)">
            <SkipBack size={16} />
          </button>
          <button onClick={handlePlayPause} style={styles.playToggle} title="Reproducir/Pausar (Espacio)">
            {isPlaying ? <Pause fill="currentColor" size={16} /> : <Play fill="currentColor" size={16} />}
          </button>
          <button onClick={() => goToAdjacentEvent(1)} style={styles.navBtn} title="Evento siguiente (N)">
            <SkipForward size={16} />
          </button>
          <span style={styles.timeLabel}>{formatTime(currentTime)}</span>

          <div ref={progressBarRef} onClick={handleProgressBarClick} style={styles.progressBar}>
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

            {duration > 0 && barEvents.map((ev, i) => {
              const meta = eventMeta(ev);
              const pos = (ev.time / duration) * 100;
              const isActive = activeEventTime === ev.time;
              return (
                <div
                  key={`ic-${i}`}
                  onClick={(e) => { e.stopPropagation(); jumpToClip(ev.time); }}
                  title={`${meta.label}: ${ev.description} · ${formatTime(ev.time)}`}
                  style={{
                    ...styles.iconMarker,
                    left: `${pos}%`,
                    borderColor: meta.color,
                    color: meta.color,
                    transform: `translateX(-50%) scale(${isActive ? 1.2 : 1})`,
                    boxShadow: isActive ? `0 0 12px ${meta.color}` : "var(--shadow-sm)",
                    zIndex: isActive ? 9 : 6,
                  }}
                >
                  {meta.icon}
                </div>
              );
            })}

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
                    opacity: isActive ? 0.6 : 0.25,
                  }}
                />
              );
            })}

            <div style={{ ...styles.progressFill, width: `${progressPct}%` }} />
            <div style={{ ...styles.progressThumb, left: `${progressPct}%` }} />

            {duration > 0 && barEvents.map((ev, i) => {
              const meta = eventMeta(ev);
              const pos = (ev.time / duration) * 100;
              return <div key={`tk-${i}`} style={{ ...styles.tick, left: `${pos}%`, background: meta.color }} />;
            })}
          </div>

          <span style={styles.timeLabel}>{formatTime(duration)}</span>

          <div style={styles.volumeGroup}>
            <button onClick={() => setMuted((m) => !m)} style={styles.iconBtn} title={muted ? "Activar sonido (M)" : "Silenciar (M)"}>
              {muted || volume === 0 ? <VolumeX size={16} /> : volume < 0.5 ? <Volume1 size={16} /> : <Volume2 size={16} />}
            </button>
            <input
              type="range" min={0} max={1} step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => { setVolume(parseFloat(e.target.value)); setMuted(false); }}
              style={styles.volumeSlider} title="Volumen"
            />
          </div>
          <button onClick={toggleFullscreen} style={styles.iconBtn} title="Pantalla completa (F)">
            <Maximize size={16} />
          </button>
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
                  borderColor: activeFilter === f.id ? "var(--border-focus)" : "var(--border-subtle)",
                }}
              >
                {f.icon && <span style={{ marginRight: "6px", display: "inline-flex", alignItems: "center" }}>{f.icon}</span>}
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
              <Scissors size={14} style={{ marginRight: "6px" }} />
              Modo clip {clipMode ? "ON" : "OFF"}
            </button>
            {!hasAudio && (
              <span style={styles.noAudioBadge} title="Esta grabación no contiene pista de audio">
                <VolumeX size={12} style={{ marginRight: "4px" }} />
                Sin audio
              </span>
            )}
            <span style={styles.metaValue}>{match.champion}</span>
          </div>
        </div>
      </div>

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
                <span style={{ ...styles.eventIcon, color: meta.color }}>{meta.icon}</span>
                <div style={styles.eventBody}>
                  <span style={styles.eventDesc}>{ev.description}</span>
                  <span style={{ ...styles.eventLabel, color: meta.color }}>{meta.label}</span>
                </div>
                <span style={styles.eventTime}>{formatTime(ev.time)}</span>
                {isSelectable && <PlayCircle size={14} color="var(--accent-teal)" style={{ flexShrink: 0 }} />}
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
    gap: "var(--space-4)",
    padding: "var(--space-4) var(--space-5)",
    background: "var(--bg-panel)",
    borderBottom: "1px solid var(--border-subtle)",
    flexShrink: 0,
  },
  headerInfo: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
  headerChamp: { fontSize: "var(--font-lg)", fontWeight: 800, color: "var(--text-primary)", letterSpacing: "-0.02em" },
  headerSub: { fontSize: "var(--font-sm)", color: "var(--text-muted)", fontWeight: 500 },
  headerStats: { display: "flex", alignItems: "center", gap: "var(--space-5)", marginLeft: "auto" },
  statItem: { display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" },
  statValue: { fontSize: "var(--font-lg)", fontWeight: 800, fontFamily: "monospace", display: "flex", gap: "4px" },
  statSep: { color: "var(--text-muted)", fontWeight: 400 },
  statLabel: { fontSize: "10px", fontWeight: 800, color: "var(--text-muted)", letterSpacing: "0.1em", textTransform: "uppercase" },
  statDivider: { width: "1px", height: "32px", background: "var(--border-strong)" },
  headerResult: {
    fontSize: "11px",
    fontWeight: 800,
    letterSpacing: "0.1em",
    padding: "6px var(--space-4)",
    borderRadius: "var(--radius-full)",
    border: "1px solid currentColor",
    marginLeft: "var(--space-4)",
    flexShrink: 0,
  },
  videoWrapper: { position: "relative", flex: 1.8, backgroundColor: "#000", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", minHeight: 0 },
  video: { width: "100%", height: "100%", maxHeight: "calc(100vh - 450px)", objectFit: "contain", cursor: "pointer" },
  centerOverlay: { position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "var(--space-3)", backgroundColor: "rgba(0,0,0,0.7)", padding: "var(--space-6)", textAlign: "center", backdropFilter: "blur(8px)" },
  overlayText: { fontSize: "var(--font-lg)", fontWeight: 800, color: "var(--text-primary)" },
  overlaySub: { fontSize: "var(--font-sm)", color: "var(--text-secondary)", maxWidth: "480px" },
  pathCode: { fontSize: "12px", fontFamily: "monospace", color: "var(--text-secondary)", backgroundColor: "var(--bg-elevated)", padding: "var(--space-2) var(--space-3)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-strong)", maxWidth: "90%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  bufferOverlay: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.3)" },
  playOverlay: { position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "background 0.3s ease" },
  bigPlayButton: { width: "80px", height: "80px", borderRadius: "var(--radius-full)", background: "var(--bg-elevated)", border: "2px solid var(--accent-teal)", color: "var(--accent-teal)", display: "flex", alignItems: "center", justifyContent: "center", paddingLeft: "4px", boxShadow: "var(--glow-teal)" },
  controlsWrapper: { backgroundColor: "var(--bg-panel)", borderTop: "1px solid var(--border-subtle)", borderBottom: "1px solid var(--border-subtle)", padding: "var(--space-4) var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-4)" },
  progressBarWrapper: { display: "flex", alignItems: "center", gap: "var(--space-3)" },
  navBtn: { width: "36px", height: "36px", flexShrink: 0, borderRadius: "var(--radius-full)", border: "1px solid var(--border-strong)", background: "var(--bg-card)", color: "var(--text-secondary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.2s" },
  playToggle: { width: "42px", height: "42px", flexShrink: 0, borderRadius: "var(--radius-full)", border: "none", background: "var(--text-primary)", color: "var(--bg-app)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", marginRight: "var(--space-2)", boxShadow: "var(--shadow-sm)" },
  sparkline: { position: "absolute", left: 0, top: "-62px", width: "100%", height: "56px", overflow: "visible", pointerEvents: "none", zIndex: 1 },
  apmBadge: { position: "absolute", top: "-62px", right: 0, fontSize: "10px", fontWeight: 800, letterSpacing: "0.04em", color: "var(--text-primary)", background: "var(--accent-violet)", borderRadius: "var(--radius-sm)", padding: "2px 8px", pointerEvents: "none", zIndex: 7, boxShadow: "var(--shadow-sm)" },
  iconMarker: { position: "absolute", top: "-42px", width: "26px", height: "26px", borderRadius: "var(--radius-full)", background: "var(--bg-elevated)", border: "2px solid", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", zIndex: 6, transition: "transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)" },
  tick: { position: "absolute", top: 0, width: "2px", height: "100%", transform: "translateX(-50%)", borderRadius: "1px", opacity: 0.9, zIndex: 3, pointerEvents: "none" },
  timeLabel: { fontSize: "var(--font-sm)", fontWeight: 700, fontFamily: "monospace", color: "var(--text-secondary)", width: "50px", textAlign: "center", flexShrink: 0 },
  progressBar: { flex: 1, height: "12px", backgroundColor: "var(--bg-elevated)", borderRadius: "var(--radius-full)", position: "relative", cursor: "pointer", border: "1px solid var(--border-strong)", boxShadow: "inset 0 1px 3px rgba(0,0,0,0.5)" },
  clipBand: { position: "absolute", top: 0, bottom: 0, borderRadius: "var(--radius-sm)", border: "1px solid transparent", cursor: "pointer", zIndex: 1 },
  progressFill: { height: "100%", background: "var(--gradient-teal)", borderRadius: "var(--radius-full)", position: "absolute", top: 0, left: 0, zIndex: 2, pointerEvents: "none" },
  progressThumb: { position: "absolute", top: "50%", width: "18px", height: "18px", borderRadius: "var(--radius-full)", background: "var(--text-primary)", border: "3px solid var(--accent-teal)", transform: "translate(-50%, -50%)", boxShadow: "var(--shadow-sm)", zIndex: 4, pointerEvents: "none" },
  volumeGroup: { display: "flex", alignItems: "center", gap: "var(--space-2)", flexShrink: 0, marginLeft: "var(--space-2)" },
  volumeSlider: { width: "80px", accentColor: "var(--accent-teal)", cursor: "pointer" },
  iconBtn: { width: "36px", height: "36px", flexShrink: 0, borderRadius: "var(--radius-md)", border: "1px solid var(--border-strong)", background: "transparent", color: "var(--text-secondary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.2s" },
  bottomControls: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" },
  filters: { display: "flex", gap: "var(--space-2)", flexWrap: "wrap" },
  filterBtn: { display: "flex", alignItems: "center", background: "transparent", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", padding: "var(--space-2) var(--space-3)", fontSize: "var(--font-sm)", fontWeight: 700, cursor: "pointer", transition: "all 0.2s" },
  rightControls: { display: "flex", alignItems: "center", gap: "var(--space-4)" },
  clipToggle: { display: "flex", alignItems: "center", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-md)", padding: "var(--space-2) var(--space-4)", fontSize: "var(--font-sm)", fontWeight: 800, cursor: "pointer", transition: "all 0.2s" },
  noAudioBadge: { display: "flex", alignItems: "center", fontSize: "var(--font-xs)", fontWeight: 800, color: "var(--color-defeat)", border: "1px solid currentColor", borderRadius: "var(--radius-full)", padding: "2px var(--space-3)" },
  metaValue: { fontWeight: 800, color: "var(--accent-gold)", fontSize: "var(--font-sm)", letterSpacing: "0.05em" },
  timelineList: { flex: 1, padding: "var(--space-5) var(--space-6)", display: "flex", flexDirection: "column", gap: "var(--space-4)", overflowY: "auto", minHeight: 0 },
  timelineHeader: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  timelineTitle: { margin: 0, fontSize: "var(--font-sm)", fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)" },
  eventCount: { fontSize: "var(--font-sm)", fontWeight: 700, color: "var(--text-muted)" },
  eventsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "var(--space-3)" },
  eventItem: { display: "flex", alignItems: "center", gap: "var(--space-3)", padding: "var(--space-3) var(--space-4)", border: "1px solid var(--border-subtle)", borderLeft: "4px solid var(--border-subtle)", borderRadius: "var(--radius-md)", transition: "all 0.2s ease" },
  eventIcon: { display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, width: "32px", height: "32px", borderRadius: "var(--radius-full)", background: "var(--bg-app)" },
  eventBody: { display: "flex", flexDirection: "column", gap: "2px", flex: 1, minWidth: 0 },
  eventDesc: { fontSize: "var(--font-sm)", fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  eventLabel: { fontSize: "11px", fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase" },
  eventTime: { fontSize: "var(--font-sm)", fontWeight: 600, color: "var(--text-muted)", fontFamily: "monospace", flexShrink: 0, marginRight: "var(--space-2)" },
};
