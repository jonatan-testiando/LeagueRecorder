import React, { useRef, useState, useEffect, useCallback } from "react";
import { MatchMetadata, MatchEvent } from "../../../types";
import { outcome } from "../../../core/matchStats";
import { 
  Swords, Skull, Handshake, Flame, Droplet, 
  Orbit, Crown, Eye, TowerControl, BrickWall, 
  Sparkles, Flag, Trophy, FlagOff, Maximize, Play, Pause,
  VolumeX, Volume1, Volume2, Scissors, AlertTriangle, 
  ThumbsUp, XCircle, ChevronLeft, ChevronRight, Share2
} from "lucide-react";

const streamUrl = (path: string): string =>
  `http://stream.localhost/${encodeURIComponent(path)}`;

const CLIP_BEFORE = 10;
const CLIP_AFTER = 10;

type Tone = "excellent" | "good" | "inaccuracy" | "mistake" | "throw" | "neutral";
interface EvMeta {
  icon: React.ReactNode;
  color: string;
  label: string;
  tone: Tone;
  category: "kills" | "deaths" | "assists" | "objectives" | "structures" | "abilities" | "other";
}

const ULT_COLOR = "var(--accent-violet)";
const MULTIKILL_COLOR = "var(--accent-gold)";
const BARON_COLOR = "#b25cff";

const objTone = (s?: string): Tone => (s === "ally" ? "excellent" : s === "enemy" ? "mistake" : "neutral");
const structTone = (s?: string): Tone => (s === "ally" ? "mistake" : s === "enemy" ? "good" : "neutral");
const objColor = (s: string | undefined, base: string) => (s === "enemy" ? "var(--color-death)" : base);
const structColor = (s?: string) => (s === "ally" ? "var(--color-death)" : "var(--accent-teal)");

function eventMeta(ev: MatchEvent): EvMeta {
  const size = 16;
  switch (ev.type) {
    case "ChampionKill":
      if (ev.subtype === "kill")
        return { icon: <Swords size={size} />, color: "var(--color-victory)", label: "Kill", tone: "good", category: "kills" };
      if (ev.subtype === "death")
        return { icon: <Skull size={size} />, color: "var(--color-death)", label: "Death", tone: "mistake", category: "deaths" };
      return { icon: <Handshake size={size} />, color: "var(--color-assist)", label: "Assist", tone: "good", category: "assists" };
    case "Multikill":
      return { icon: <Flame size={size} />, color: MULTIKILL_COLOR, label: "Multi Kill", tone: "excellent", category: "kills" };
    case "FirstBlood":
      return { icon: <Droplet size={size} />, color: "var(--color-victory)", label: "First Blood", tone: "excellent", category: "kills" };
    case "DragonKill":
      return { icon: <Orbit size={size} />, color: objColor(ev.subtype, "var(--color-objective)"), label: "Dragon", tone: objTone(ev.subtype), category: "objectives" };
    case "BaronKill":
      return { icon: <Crown size={size} />, color: objColor(ev.subtype, BARON_COLOR), label: "Baron", tone: objTone(ev.subtype), category: "objectives" };
    case "HeraldKill":
      return { icon: <Eye size={size} />, color: objColor(ev.subtype, "var(--accent-blue)"), label: "Herald", tone: objTone(ev.subtype), category: "objectives" };
    case "TowerKill":
      return { icon: <TowerControl size={size} />, color: structColor(ev.subtype), label: "Tower", tone: structTone(ev.subtype), category: "structures" };
    case "InhibKill":
      return { icon: <BrickWall size={size} />, color: structColor(ev.subtype), label: "Inhibitor", tone: structTone(ev.subtype), category: "structures" };
    case "Ultimate":
      return { icon: <Sparkles size={size} />, color: ULT_COLOR, label: "Ultimate (R)", tone: "neutral", category: "abilities" };
    case "GameStart":
      return { icon: <Flag size={size} />, color: "var(--text-muted)", label: "Game Start", tone: "neutral", category: "other" };
    case "GameEnd":
      return ev.subtype === "win"
        ? { icon: <Trophy size={size} />, color: "var(--color-victory)", label: "Victory", tone: "excellent", category: "other" }
        : ev.subtype === "lose"
        ? { icon: <FlagOff size={size} />, color: "var(--color-defeat)", label: "Defeat", tone: "throw", category: "other" }
        : { icon: <Flag size={size} />, color: "var(--text-muted)", label: "Game End", tone: "neutral", category: "other" };
    default:
      return { icon: <Sparkles size={size} />, color: "var(--accent-blue)", label: ev.type, tone: "neutral", category: "other" };
  }
}

function toneLabelAndIcon(tone: Tone) {
  switch (tone) {
    case "excellent": return { text: "Excellent", color: "var(--accent-gold)", icon: <Sparkles size={12} fill="currentColor" /> };
    case "good": return { text: "Good", color: "var(--color-victory)", icon: <ThumbsUp size={12} fill="currentColor" /> };
    case "inaccuracy": return { text: "Inaccuracy", color: "var(--accent-gold)", icon: <AlertTriangle size={12} fill="currentColor" /> };
    case "mistake": return { text: "Mistake", color: "var(--accent-gold)", icon: <AlertTriangle size={12} fill="currentColor" /> }; // Ascent uses orange (!)
    case "throw": return { text: "Throw", color: "var(--color-death)", icon: <XCircle size={12} fill="currentColor" /> };
    default: return { text: "Info", color: "var(--text-muted)", icon: <div style={{width:8,height:8,borderRadius:4,background:"currentColor"}}/> };
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

type LoadState = "loading" | "ready" | "error";

interface VideoPlayerProps {
  match: MatchMetadata;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({ match }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const clipEndRef = useRef<number | null>(null);

  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(match.game_duration || 0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [volume, setVolume] = useState<number>(1);
  const [muted, setMuted] = useState<boolean>(false);
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

  const timedEvents = match.events.filter((ev) => ev.type !== "GameStart" && ev.type !== "GameEnd");
  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  
  const apmSeries = match.apm_series ?? [];
  let apmLinePath = "";
  if (apmSeries.length >= 2) {
    const maxApm = Math.max(1, ...apmSeries);
    const n = apmSeries.length;
    const pts: [number, number][] = apmSeries.map((v, i) => {
      const x = (i / (n - 1)) * 100;
      const y = 80 - (v / maxApm) * 70; // Map APM to graph height
      return [x, y];
    });
    apmLinePath = smoothLinePath(pts);
  }

  const result = outcome(match.result);
  const isWin = result === "victory";
  const activeIndex = timedEvents.findIndex(e => e.time === activeEventTime) + 1;

  // Mouse Trail Rendering Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const resizeObserver = new ResizeObserver(() => {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
    });
    resizeObserver.observe(canvas);
    
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Asumimos monitor principal para la escala de captura rdev
    const screenW = window.screen.width;
    const screenH = window.screen.height;

    const render = () => {
      rafRef.current = requestAnimationFrame(render);
      const v = videoRef.current;
      if (!isPlaying || !v) return;
      
      const ct = v.currentTime;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      if (!match.mouse_events || match.mouse_events.length === 0) return;

      const TRAIL_DURATION = 1.0;
      const recentEvents = match.mouse_events.filter(e => e.t <= ct && e.t >= ct - TRAIL_DURATION);
      if (recentEvents.length === 0) return;

      const scaleX = canvas.width / screenW;
      const scaleY = canvas.height / screenH;

      const moves = recentEvents.filter(e => e.evt === "move");
      if (moves.length > 1) {
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (let i = 0; i < moves.length - 1; i++) {
          const p1 = moves[i];
          const p2 = moves[i+1];
          const ageRatio = Math.max(0, 1 - (ct - p2.t) / TRAIL_DURATION);
          
          ctx.beginPath();
          ctx.moveTo(p1.x * scaleX, p1.y * scaleY);
          ctx.lineTo(p2.x * scaleX, p2.y * scaleY);
          
          ctx.lineWidth = 2 + ageRatio * 3;
          
          // Interpolate color from yellow to bright blue
          const r = Math.floor(255 + ageRatio * (0 - 255));
          const g = Math.floor(200 + ageRatio * (150 - 200));
          const b = Math.floor(50 + ageRatio * (255 - 50));
          
          ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${ageRatio})`;
          ctx.stroke();
        }
      }

      const clicks = recentEvents.filter(e => e.evt === "left_click" || e.evt === "right_click");
      for (const click of clicks) {
        const age = ct - click.t;
        if (age > 0.5) continue;
        
        const ageRatio = age / 0.5;
        const radius = 5 + ageRatio * 25;
        const opacity = 1 - ageRatio;
        
        ctx.beginPath();
        ctx.arc(click.x * scaleX, click.y * scaleY, radius, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        if (click.evt === "left_click") {
          ctx.strokeStyle = `rgba(0, 255, 100, ${opacity})`;
        } else {
          ctx.strokeStyle = `rgba(255, 50, 50, ${opacity})`;
        }
        ctx.stroke();
      }
    };
    
    rafRef.current = requestAnimationFrame(render);
    
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      resizeObserver.disconnect();
    };
  }, [isPlaying, match.mouse_events]);

  return (
    <div ref={containerRef} style={styles.container}>
      {/* Left Column: Video & Timeline */}
      <div style={styles.leftColumn}>
        <div style={styles.videoWrapper}>
          <div style={styles.topBar}>
            <div style={styles.topBarLeft}>
              {/* Spacer for when back button is external */}
            </div>
            <button style={styles.shareBtn}>
              <Share2 size={14} /> Share Video
            </button>
          </div>
          
          <video
            ref={videoRef}
            src={videoSrc}
            style={styles.video}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onClick={handlePlayPause}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onWaiting={() => {}}
            onPlaying={() => {}}
            onCanPlay={() => { if (loadState !== "error") setLoadState("ready"); }}
            onError={() => setLoadState("error")}
            preload="auto"
          />

          {loadState === "loading" && (
            <div style={styles.centerOverlay}>
              <div className="spinner" />
            </div>
          )}
          {loadState === "error" && (
            <div style={styles.centerOverlay}>
              <AlertTriangle size={48} color="var(--color-defeat)" />
              <span style={{ color: "#fff", marginTop: 8 }}>No se pudo cargar el video</span>
            </div>
          )}

          {/* Canvas for Mouse Trail Overlay */}
          <canvas
            ref={canvasRef}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              pointerEvents: "none",
              zIndex: 5
            }}
          />

          {/* Overlay Progress Bar at the bottom of video */}
          <div style={styles.videoProgressWrapper}>
            <button onClick={handlePlayPause} style={styles.videoPlayBtn}>
              {isPlaying ? <Pause fill="currentColor" size={16} /> : <Play fill="currentColor" size={16} />}
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              <button onClick={() => setMuted(m => !m)} style={styles.videoPlayBtn} title="Silenciar (M)">
                {muted || volume === 0 ? <VolumeX size={16} /> : volume < 0.5 ? <Volume1 size={16} /> : <Volume2 size={16} />}
              </button>
              <input
                type="range" min={0} max={1} step={0.05}
                value={muted ? 0 : volume}
                onChange={(e) => { setVolume(parseFloat(e.target.value)); setMuted(false); }}
                style={{ width: "80px", accentColor: "var(--accent-violet)", cursor: "pointer" }}
                title="Volumen"
              />
            </div>
            <span style={styles.videoTime}>{formatTime(currentTime)} / {formatTime(duration)}</span>
            
            <div style={{ flex: 1 }} />
            
            <button onClick={toggleFullscreen} style={styles.videoPlayBtn}>
              <Maximize size={16} />
            </button>
          </div>
        </div>

        {/* Timeline Area (Ascent style, below video) */}
        {!isFullscreen && (
        <div style={styles.timelineArea}>
          <div style={styles.timelineHeaderRow}>
            <span style={styles.apmLabel}>Average APM: {Math.round(match.apm || 0)}</span>
            <div style={styles.timelineHeaderRight}>
              <button onClick={() => setClipMode(c => !c)} style={{...styles.ghostBtn, color: clipMode ? "var(--text-primary)" : "var(--text-muted)"}}>
                <Scissors size={14} /> Clip
              </button>
              <button style={styles.ghostBtn}>
                APM <ChevronRight size={14} style={{transform: "rotate(90deg)"}}/>
              </button>
            </div>
          </div>

          <div style={styles.timelineGraph} ref={progressBarRef} onClick={handleProgressBarClick}>
            {/* APM Graph */}
            {apmSeries.length >= 2 && (
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={styles.graphSvg}>
                <path d={apmLinePath} fill="none" stroke="var(--accent-violet)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              </svg>
            )}

            {/* Event Nodes */}
            {duration > 0 && timedEvents.map((ev, i) => {
              const meta = eventMeta(ev);
              const pos = (ev.time / duration) * 100;
              const isActive = activeEventTime === ev.time;
              return (
                <div
                  key={i}
                  onClick={(e) => { e.stopPropagation(); jumpToClip(ev.time); }}
                  style={{
                    ...styles.eventNode,
                    left: `${pos}%`,
                    borderColor: meta.color,
                    background: isActive ? meta.color : "var(--bg-app)",
                    transform: `translateX(-50%) scale(${isActive ? 1.2 : 1})`,
                    zIndex: isActive ? 10 : 5,
                  }}
                  title={ev.description}
                >
                  <span style={{ color: isActive ? "#fff" : meta.color, display: "flex", transform: "scale(0.625)" }}>
                    {meta.icon}
                  </span>
                </div>
              );
            })}

            {/* Current Time Line */}
            <div style={{ ...styles.playhead, left: `${progressPct}%` }} />
            
            {/* Axis marks */}
            <div style={styles.axisMarks}>
              {[0, 10, 20, 30].map(m => (
                <span key={m} style={{position: "absolute", left: `${(m*60/duration)*100}%`, fontSize: "10px", color: "var(--text-muted)"}}>
                  {m}:00
                </span>
              ))}
            </div>
          </div>
        </div>
        )}
      </div>

      {/* Right Column: Game Review */}
      {!isFullscreen && (
      <div style={styles.rightColumn}>
        <div style={styles.reviewHeader}>
          <span style={styles.reviewTitle}>Game Review</span>
        </div>

        <div style={styles.reviewScoreCard}>
          <div style={styles.scoreIcon}>
            {isWin ? <Trophy size={24} color="#fff" /> : <XCircle size={24} color="#fff" />}
          </div>
          <h2 style={{ ...styles.scoreText, color: isWin ? "var(--color-victory)" : "var(--color-defeat)" }}>
            {isWin ? "Victory" : "Defeat"}
          </h2>
          <p style={styles.scoreSub}>
            You and your team {isWin ? "secured" : "lost"} the match.
          </p>
        </div>

        <div style={styles.reviewList}>
          {timedEvents.map((ev, i) => {
            const meta = eventMeta(ev);
            const { text: toneText, color: toneColor, icon: toneIcon } = toneLabelAndIcon(meta.tone);
            const isActive = activeEventTime === ev.time;

            return (
              <div 
                key={i} 
                onClick={() => jumpToClip(ev.time)}
                style={{
                  ...styles.reviewItem,
                  background: isActive ? "hsla(0,0%,100%,0.05)" : "transparent",
                  borderLeft: isActive ? `3px solid ${meta.color}` : "3px solid transparent",
                }}
              >
                <div style={styles.reviewItemLeft}>
                  <span style={styles.reviewNumber}>{i + 1}.</span>
                  <span style={styles.reviewName}>{meta.label}</span>
                </div>
                <div style={styles.reviewItemRight}>
                  <div style={{...styles.toneIconWrap, color: toneColor}}>
                    {toneIcon}
                  </div>
                  <span style={{...styles.toneText, color: toneColor}}>{toneText}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div style={styles.reviewFooter}>
          <button onClick={() => goToAdjacentEvent(-1)} style={styles.ghostBtn} title="Evento anterior (P)"><ChevronLeft size={16} /> Previous</button>
          <span style={styles.pageInfo}>{activeIndex || "-"} of {timedEvents.length}</span>
          <button onClick={() => goToAdjacentEvent(1)} style={styles.ghostBtn} title="Evento siguiente (N)">Next <ChevronRight size={16} /></button>
        </div>
      </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "row",
    height: "100%",
    width: "100%",
    backgroundColor: "var(--bg-app)",
    overflow: "hidden",
  },
  leftColumn: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    padding: "var(--space-4)",
    gap: "var(--space-4)",
    minWidth: 0,
  },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    padding: "var(--space-4)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    zIndex: 10,
    background: "linear-gradient(to bottom, rgba(0,0,0,0.6), transparent)",
  },
  topBarLeft: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
  },
  shareBtn: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    background: "var(--accent-violet)",
    color: "#fff",
    border: "none",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-2) var(--space-4)",
    fontWeight: 700,
    fontSize: "var(--font-xs)",
    cursor: "pointer",
  },
  videoWrapper: {
    flex: 1,
    position: "relative",
    backgroundColor: "#000",
    borderRadius: "var(--radius-lg)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  video: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
  centerOverlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.7)",
  },
  videoProgressWrapper: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: "var(--space-3) var(--space-4)",
    background: "linear-gradient(to top, rgba(0,0,0,0.8), transparent)",
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
  },
  videoPlayBtn: {
    background: "transparent",
    border: "none",
    color: "#fff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "4px",
  },
  videoTime: {
    color: "#fff",
    fontSize: "var(--font-xs)",
    fontWeight: 600,
    fontFamily: "monospace",
  },
  timelineArea: {
    height: "140px",
    backgroundColor: "var(--bg-card)",
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--border-subtle)",
    padding: "var(--space-3) var(--space-4)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  },
  timelineHeaderRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  apmLabel: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-xs)",
    fontWeight: 600,
  },
  timelineHeaderRight: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
  },
  ghostBtn: {
    background: "transparent",
    border: "none",
    color: "var(--text-secondary)",
    display: "flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "var(--font-xs)",
    cursor: "pointer",
  },
  timelineGraph: {
    flex: 1,
    position: "relative",
    cursor: "pointer",
    marginTop: "var(--space-2)",
  },
  graphSvg: {
    width: "100%",
    height: "100%",
    position: "absolute",
    inset: 0,
  },
  eventNode: {
    position: "absolute",
    bottom: "20px",
    width: "20px",
    height: "20px",
    borderRadius: "50%",
    border: "1.5px solid",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "transform 0.1s",
    cursor: "pointer",
  },
  playhead: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: "2px",
    backgroundColor: "#fff",
    pointerEvents: "none",
    zIndex: 20,
    opacity: 0.7,
  },
  axisMarks: {
    position: "absolute",
    bottom: "-15px",
    left: 0,
    right: 0,
  },
  rightColumn: {
    width: "320px",
    backgroundColor: "var(--bg-sidebar)",
    borderLeft: "1px solid var(--border-subtle)",
    display: "flex",
    flexDirection: "column",
  },
  reviewHeader: {
    padding: "var(--space-4)",
    textAlign: "center",
  },
  reviewTitle: {
    color: "#fff",
    fontSize: "var(--font-sm)",
    fontWeight: 700,
  },
  reviewScoreCard: {
    padding: "var(--space-6) var(--space-4)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    borderBottom: "1px solid var(--border-subtle)",
  },
  scoreIcon: {
    width: "48px",
    height: "48px",
    borderRadius: "50%",
    background: "linear-gradient(135deg, var(--accent-blue), var(--accent-teal))",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: "var(--space-3)",
    boxShadow: "0 0 16px rgba(77, 166, 255, 0.3)",
  },
  scoreText: {
    margin: 0,
    fontSize: "var(--font-xl)",
    fontWeight: 800,
  },
  scoreSub: {
    margin: "var(--space-2) 0 0 0",
    color: "var(--text-secondary)",
    fontSize: "var(--font-xs)",
    lineHeight: 1.5,
  },
  reviewList: {
    flex: 1,
    overflowY: "auto",
    padding: "var(--space-4) 0",
  },
  reviewItem: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "var(--space-3) var(--space-4)",
    cursor: "pointer",
    transition: "background 0.15s",
  },
  reviewItemLeft: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
  },
  reviewNumber: {
    color: "var(--text-muted)",
    fontSize: "var(--font-xs)",
    width: "16px",
  },
  reviewName: {
    color: "#fff",
    fontSize: "var(--font-sm)",
    fontWeight: 600,
  },
  reviewItemRight: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
  },
  toneIconWrap: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  toneText: {
    fontSize: "11px",
    fontWeight: 700,
  },
  reviewFooter: {
    padding: "var(--space-4)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    borderTop: "1px solid var(--border-subtle)",
  },
  pageInfo: {
    color: "var(--text-muted)",
    fontSize: "11px",
    fontWeight: 600,
  }
};
