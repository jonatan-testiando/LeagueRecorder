import React, { useRef, useState, useEffect, useCallback } from "react";
import { MatchMetadata, MatchEvent } from "../../../types";
import { invoke } from "@tauri-apps/api/core";
import { outcome } from "../../../core/matchStats";
import { 
  Swords, Skull, Handshake, Flame, Droplet, 
  Orbit, Crown, Eye, TowerControl, BrickWall, 
  Sparkles, Flag, Trophy, FlagOff, Maximize, Play, Pause,
  VolumeX, Volume1, Volume2, Scissors, AlertTriangle, 
  ThumbsUp, XCircle, ChevronLeft, ChevronRight, Share2, MousePointer2, EyeOff
} from "lucide-react";
import { exportErrorClip } from "../../../core/tauri-ipc";
import { useDialog } from "../../../components/ui/DialogProvider";

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

  const [mouseSync, setMouseSync] = useState<number>(() => {
    return parseFloat(localStorage.getItem("mouseSyncOffset") || "1.0");
  });
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(match.game_duration || 0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [volume, setVolume] = useState<number>(0.5);
  const [muted, setMuted] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [activeEventTime, setActiveEventTime] = useState<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  const [showTracker, setShowTracker] = useState<boolean>(true);
  const [isClippingMode, setIsClippingMode] = useState<boolean>(false);
  const [clipDragThumb, setClipDragThumb] = useState<"start" | "end" | null>(null);
  const [clipStart, setClipStart] = useState<number>(0);
  const [clipEnd, setClipEnd] = useState<number>(0);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportType, setExportType] = useState<"clip" | "error">("clip");
  const [errorNote, setErrorNote] = useState<string>("");
  const [hoverClientX, setHoverClientX] = useState<number | null>(null);

  const { showSuccess, showError } = useDialog();

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

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  const handlePlayPause = useCallback(() => {
    const v = videoRef.current;
    if (!v || loadState === "error") return;
    clipEndRef.current = null;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, [loadState]);

  const toggleMute = () => setMuted(m => !m);
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setVolume(parseFloat(e.target.value));
    setMuted(false);
  };

  const seekTo = useCallback((seconds: number, play: boolean) => {
    const v = videoRef.current;
    if (!v) return;
    const target = Math.max(0, Math.min(seconds, duration || seconds));
    v.currentTime = target;
    setCurrentTime(target);
    if (play && v.paused) v.play().catch(() => {});
  }, [duration]);

  const jumpToClip = useCallback((eventTime: number) => {
    clipEndRef.current = eventTime + CLIP_AFTER;
    setActiveEventTime(eventTime);
    seekTo(Math.max(0, eventTime - CLIP_BEFORE), true);
  }, [seekTo]);

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

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!isClippingMode) {
      setIsDragging(true);
      updateScrub(e.clientX, true);
    } else {
      setIsDragging(true);
      updateScrub(e.clientX, true);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (progressBarRef.current) {
      const rect = progressBarRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const pct = x / rect.width;
      setHoverPct(pct);
      setHoverClientX(e.clientX);
      
      if (clipDragThumb) {
        const newTime = pct * duration;
        if (clipDragThumb === "start") setClipStart(Math.min(newTime, clipEnd - 1));
        else setClipEnd(Math.max(newTime, clipStart + 1));
      } else if (isDragging) {
        updateScrub(e.clientX, false);
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (clipDragThumb) {
      setClipDragThumb(null);
    } else if (isDragging) {
      setIsDragging(false);
    }
    setHoverPct(null);
  };

  const handlePointerLeave = () => {
    if (!isDragging) setHoverPct(null);
  };

  const handleThumbPointerDown = (e: React.PointerEvent<HTMLDivElement>, type: "start" | "end") => {
    e.stopPropagation();
    if (progressBarRef.current) {
      progressBarRef.current.setPointerCapture(e.pointerId);
    }
    setClipDragThumb(type);
  };

  const updateScrub = (clientX: number, playAfter: boolean) => {
    if (progressBarRef.current && duration > 0) {
      const rect = progressBarRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      clipEndRef.current = null;
      setActiveEventTime(null);
      seekTo(pct * duration, playAfter);
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

  // Marcas del eje temporal adaptadas a la duración real del vídeo (antes fijas a 30 min).
  // Elegimos un paso "redondo" para tener ~4-6 marcas legibles.
  const axisMarks = React.useMemo(() => {
    if (!isFinite(duration) || duration <= 0) return [];
    const steps = [15, 30, 60, 120, 300, 600, 900]; // 15s..15min
    let step = steps.find(s => duration / s <= 6) ?? Math.ceil(duration / 6);
    if (step <= 0) step = 15; // prevent infinite loop
    const marks: number[] = [];
    for (let t = 0; t < duration; t += step) marks.push(t);
    return marks;
  }, [duration]);
  
  const apmSeries = match.apm_series ?? [];
  let apmLinePath = "";
  if (apmSeries.length >= 2) {
    const maxApm = Math.max(1, ...apmSeries);
    const n = apmSeries.length;
    const pts: [number, number][] = apmSeries.map((v, i) => {
      const x = (i / (n - 1)) * 100;
      const y = 80 - (v / maxApm) * 70;
      return [x, y];
    });
    apmLinePath = smoothLinePath(pts);
  }

  const result = outcome(match.result);
  const isWin = result === "victory";
  const activeIndex = timedEvents.findIndex(e => e.time === activeEventTime) + 1;

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
    const render = () => {
      rafRef.current = requestAnimationFrame(render);
      const v = videoRef.current;
      if (!v) return;
      
      const ct = v.currentTime;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!match.mouse_events || match.mouse_events.length === 0) return;
      
      const videoW = v.videoWidth || 1920;
      const videoH = v.videoHeight || 1080;
      const scaleX = canvas.width / videoW;
      const scaleY = canvas.height / videoH;
      
      const TRAIL_DURATION = 1.0;
      const adjustedCt = ct - mouseSync;
      const recentEvents = match.mouse_events.filter(e => e.t <= adjustedCt && e.t >= adjustedCt - TRAIL_DURATION);
      if (recentEvents.length === 0) return;
      const moves = recentEvents.filter(e => e.evt === "move");
      if (moves.length > 1) {
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (let i = 0; i < moves.length - 1; i++) {
          const p1 = moves[i];
          const p2 = moves[i+1];
          const ageRatio = Math.max(0, 1 - (adjustedCt - p2.t) / TRAIL_DURATION);
          ctx.beginPath();
          ctx.moveTo(p1.x * scaleX, p1.y * scaleY);
          ctx.lineTo(p2.x * scaleX, p2.y * scaleY);
          ctx.lineWidth = 2.5 + ageRatio * 4;
          const r = Math.floor(255 + ageRatio * (0 - 255));
          const g = Math.floor(200 + ageRatio * (150 - 200));
          const b = Math.floor(50 + ageRatio * (255 - 50));
          ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${ageRatio})`;
          ctx.stroke();
        }
      }
      const clicks = recentEvents.filter(e => e.evt === "left_click" || e.evt === "right_click");
      for (const click of clicks) {
        const age = adjustedCt - click.t;
        if (age > 0.6) continue;
        const ageRatio = Math.max(0, 1 - (age / 0.6));
        const radius = 8 + (1 - ageRatio) * 15;
        const opacity = ageRatio;

        const r = Math.floor(255 + ageRatio * (0 - 255));
        const g = Math.floor(200 + ageRatio * (150 - 200));
        const b = Math.floor(50 + ageRatio * (255 - 50));
        
        ctx.save();
        ctx.shadowBlur = 10;
        ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${opacity})`;
        
        // Anillo exterior
        ctx.beginPath();
        ctx.arc(click.x * scaleX, click.y * scaleY, radius, 0, Math.PI * 2);
        ctx.lineWidth = 4;
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${opacity * 0.8})`;
        ctx.stroke();

        // Núcleo interior brillante
        ctx.beginPath();
        ctx.arc(click.x * scaleX, click.y * scaleY, radius * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
        ctx.fill();
        ctx.restore();
      }
    };
    rafRef.current = requestAnimationFrame(render);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      resizeObserver.disconnect();
    };
  }, [match.mouse_events, mouseSync]);

  return (
    <div ref={containerRef} style={styles.container}>
      <div style={styles.leftColumn}>
        <div style={styles.videoWrapper}>
          <div style={styles.topBar}>
            <div style={styles.topBarLeft}></div>
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
            preload="auto"
          />
          {loadState === "loading" && <div style={styles.centerOverlay}><div className="spinner" /></div>}
          {loadState === "error" && <div style={styles.centerOverlay}><AlertTriangle size={48} color="var(--color-defeat)" /><span style={{ color: "#fff", marginTop: 8 }}>No se pudo cargar el video</span></div>}
          <canvas ref={canvasRef} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 5, opacity: showTracker ? 1 : 0, transition: "opacity 0.2s" }} />
          <div style={styles.videoProgressWrapper}>
            <button onClick={handlePlayPause} style={styles.videoPlayBtn}>
              {isPlaying ? <Pause fill="currentColor" size={16} /> : <Play fill="currentColor" size={16} />}
            </button>
            <div style={styles.volumeContainer}>
              <button onClick={toggleMute} style={styles.videoPlayBtn}>
                {muted || volume === 0 ? <VolumeX size={20} /> : volume < 0.5 ? <Volume1 size={20} /> : <Volume2 size={20} />}
              </button>
              <input type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} onChange={handleVolumeChange} style={styles.volumeSlider} />
            </div>
            <span style={styles.videoTime}>{formatTime(currentTime)} / {formatTime(duration)}</span>
            <select 
              value={playbackRate} 
              onChange={(e) => setPlaybackRate(parseFloat(e.target.value))}
              style={styles.playbackSelect}
            >
              <option value={0.25}>0.25x</option>
              <option value={0.5}>0.50x</option>
              <option value={0.75}>0.75x</option>
              <option value={1}>1.00x</option>
              <option value={1.5}>1.50x</option>
              <option value={2}>2.00x</option>
              <option value={4}>4.00x</option>
            </select>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginLeft: "auto", marginRight: "16px" }}>
              <button onClick={() => setShowTracker(s => !s)} style={styles.videoPlayBtn} title="Mostrar/Ocultar Ratón">
                {showTracker ? <Eye size={16} /> : <EyeOff size={16} />}
              </button>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ color: "#8b949e", fontSize: "12px", display: "flex", alignItems: "center", gap: "4px" }}>
                  <MousePointer2 size={12} /> Sync
                </span>
                <input type="range" min="-3" max="3" step="0.1" value={mouseSync} onChange={(e) => { const val = parseFloat(e.target.value); setMouseSync(val); localStorage.setItem("mouseSyncOffset", val.toString()); }} style={{...styles.volumeSlider, width: "60px"}} />
                <span style={{ color: "#8b949e", fontSize: "12px", width: "35px", textAlign: "right" }}>{mouseSync > 0 ? `+${mouseSync.toFixed(1)}s` : `${mouseSync.toFixed(1)}s`}</span>
              </div>
            </div>
            <button onClick={toggleFullscreen} style={styles.videoPlayBtn}><Maximize size={16} /></button>
          </div>
        </div>
        {!isFullscreen && (
        <div style={styles.timelineArea}>
          <div style={styles.timelineHeaderRow}>
            <span style={styles.apmLabel}>Average APM: {Math.round(match.apm || 0)}</span>
            <div style={styles.timelineHeaderRight}>
              <button 
                onClick={() => {
                  setExportType("clip");
                  if (!isClippingMode) {
                    setClipStart(Math.max(0, currentTime - 10));
                    setClipEnd(Math.min(duration, currentTime + 10));
                  }
                  setIsClippingMode(!isClippingMode);
                }} 
                style={{...styles.ghostBtn, color: isClippingMode && exportType === "clip" ? "var(--accent-violet)" : "var(--text-primary)"}}
              >
                <Scissors size={14} /> Clip
              </button>
              <button 
                onClick={() => {
                  setExportType("error");
                  if (!isClippingMode) {
                    setClipStart(Math.max(0, currentTime - 10));
                    setClipEnd(Math.min(duration, currentTime + 10));
                  }
                  setIsClippingMode(!isClippingMode);
                }} 
                style={{...styles.ghostBtn, color: isClippingMode && exportType === "error" ? "var(--color-defeat)" : "var(--text-primary)"}}
              >
                <AlertTriangle size={14} /> Error
              </button>
            </div>
          </div>

          <div 
            style={styles.timelineGraph} 
            ref={progressBarRef} 
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerLeave}
          >
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
            
            {/* Hover Scrubber Line */}
            {hoverPct !== null && (
              <div style={{ ...styles.playheadHover, left: `${hoverPct * 100}%` }} />
            )}
            
            {/* Axis marks — generados dinámicamente según la duración real */}
            <div style={styles.axisMarks}>
              {axisMarks.map(m => (
                <span key={m} style={{position: "absolute", left: `${(m/duration)*100}%`, fontSize: "10px", color: "var(--text-muted)"}}>
                  {formatTime(m)}
                </span>
              ))}
            </div>

            {/* Hover Tooltip */}
            {hoverPct !== null && hoverClientX !== null && (
              <div style={{
                position: "fixed",
                left: hoverClientX,
                bottom: "160px",
                transform: "translateX(-50%)",
                backgroundColor: "var(--bg-card)",
                padding: "8px 12px",
                borderRadius: "8px",
                border: "1px solid var(--border-subtle)",
                boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
                pointerEvents: "none",
                zIndex: 100,
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                minWidth: "120px"
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", fontWeight: "bold", color: "#fff" }}>
                  <span>{formatTime(hoverPct * duration)}</span>
                  <span style={{ color: "var(--accent-violet)" }}>
                    {apmSeries.length > 0 ? Math.round(apmSeries[Math.min(apmSeries.length - 1, Math.floor(hoverPct * apmSeries.length))]) : 0} APM
                  </span>
                </div>
                {timedEvents.filter(ev => Math.abs(ev.time - hoverPct * duration) < (duration * 0.01)).slice(0, 1).map(ev => {
                  const meta = eventMeta(ev);
                  return (
                    <div key={ev.time} style={{ fontSize: "11px", color: meta.color, display: "flex", alignItems: "center", gap: "4px", marginTop: "4px" }}>
                      <span style={{ transform: "scale(0.8)" }}>{meta.icon}</span>
                      {meta.label} {ev.description ? `- ${ev.description}` : ""}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Clipping Overlay */}
            {isClippingMode && duration > 0 && (
              <div style={{
                position: "absolute",
                top: 0, bottom: 0,
                left: `${(clipStart / duration) * 100}%`,
                width: `${((clipEnd - clipStart) / duration) * 100}%`,
                backgroundColor: "rgba(178, 92, 255, 0.4)",
                borderLeft: "2px solid var(--accent-violet)",
                borderRight: "2px solid var(--accent-violet)",
                zIndex: 10,
              }}>
                <div 
                  onPointerDown={(e) => handleThumbPointerDown(e, "start")}
                  style={{ position: "absolute", left: -6, top: 0, bottom: 0, width: 12, cursor: "ew-resize", zIndex: 11 }} 
                />
                <div 
                  onPointerDown={(e) => handleThumbPointerDown(e, "end")}
                  style={{ position: "absolute", right: -6, top: 0, bottom: 0, width: 12, cursor: "ew-resize", zIndex: 11 }} 
                />
              </div>
            )}
          </div>
        </div>
        )}
      </div>

      {/* Right Column: Game Review */}
      {!isFullscreen && (
      <div style={styles.rightColumn}>
        <div style={styles.reviewHeader}>
          <span style={styles.reviewTitle}>{match.is_vod ? "VOD Analysis" : "Game Review"}</span>
        </div>

        {match.is_vod ? (
          // En un VOD importado no hay resultado propio: mostramos una cabecera neutra
          // en lugar del engañoso "Defeat" que salía siempre.
          <div style={{...styles.reviewScoreCard, background: "linear-gradient(180deg, rgba(178, 92, 255, 0.1) 0%, transparent 100%)"}}>
            <div style={{...styles.scoreIcon, background: "linear-gradient(135deg, var(--accent-violet), #7a3cff)", boxShadow: "0 0 20px rgba(178,92,255,0.4)"}}>
              <MousePointer2 size={28} color="#fff" />
            </div>
            <h2 style={{ ...styles.scoreText, color: "var(--accent-violet)" }}>VOD</h2>
            <p style={styles.scoreSub}>
              Análisis de cursor y APM sobre la partida importada.
            </p>
          </div>
        ) : (
          <div style={{...styles.reviewScoreCard, background: isWin ? "linear-gradient(180deg, rgba(77, 166, 255, 0.1) 0%, transparent 100%)" : "linear-gradient(180deg, rgba(255, 77, 77, 0.1) 0%, transparent 100%)"}}>
            <div style={{...styles.scoreIcon, background: isWin ? "linear-gradient(135deg, var(--accent-blue), var(--accent-teal))" : "linear-gradient(135deg, #ff4d4d, #cc0000)", boxShadow: isWin ? "0 0 20px rgba(77,166,255,0.4)" : "0 0 20px rgba(255,77,77,0.4)"}}>
              {isWin ? <Trophy size={28} color="#fff" /> : <XCircle size={28} color="#fff" />}
            </div>
            <h2 style={{ ...styles.scoreText, color: isWin ? "var(--color-victory)" : "var(--color-defeat)" }}>
              {isWin ? "Victory" : "Defeat"}
            </h2>
            <p style={styles.scoreSub}>
              You and your team {isWin ? "secured" : "lost"} the match.
            </p>
          </div>
        )}

        <div style={styles.reviewList}>
          <div style={styles.timelineContainer}>
            {/* The vertical line */}
            <div style={styles.timelineLine} />
            
            {timedEvents.map((ev, i) => {
              const meta = eventMeta(ev);
              const { text: toneText, color: toneColor, icon: toneIcon } = toneLabelAndIcon(meta.tone);
              const isActive = activeEventTime === ev.time;

              return (
                <div 
                  key={i} 
                  onClick={() => jumpToClip(ev.time)}
                  style={{
                    ...styles.reviewCardWrapper,
                    opacity: isActive ? 1 : 0.6,
                    transform: isActive ? "scale(1.02)" : "scale(1)",
                  }}
                >
                  <div style={{
                    ...styles.timelineDot, 
                    borderColor: meta.color, 
                    backgroundColor: isActive ? meta.color : "var(--bg-app)", 
                    boxShadow: isActive ? `0 0 10px ${meta.color}` : "none"
                  }} />
                  <div style={{
                    ...styles.reviewCard,
                    borderColor: isActive ? meta.color : "var(--border-subtle)",
                    backgroundColor: isActive ? "hsla(0,0%,100%,0.08)" : "hsla(0,0%,100%,0.03)",
                  }}>
                    <div style={styles.reviewCardHeader}>
                      <span style={{ color: "var(--text-muted)", fontSize: "10px", fontWeight: "bold" }}>
                        {formatTime(ev.time)}
                      </span>
                      <div style={{...styles.toneBadge, color: toneColor, backgroundColor: `${toneColor}22`}}>
                        {toneIcon} <span style={{fontSize: "10px", fontWeight: "bold"}}>{toneText}</span>
                      </div>
                    </div>
                    <div style={styles.reviewCardBody}>
                      <span style={{color: meta.color, display: "flex"}}>{meta.icon}</span>
                      <span style={styles.reviewCardTitle}>{meta.label}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={styles.reviewFooter}>
          <button onClick={() => goToAdjacentEvent(-1)} style={styles.ghostBtn} title="Evento anterior (P)"><ChevronLeft size={16} /> Previous</button>
          <span style={styles.pageInfo}>{activeIndex || "-"} of {timedEvents.length}</span>
          <button onClick={() => goToAdjacentEvent(1)} style={styles.ghostBtn} title="Evento siguiente (N)">Next <ChevronRight size={16} /></button>
        </div>
      </div>
      )}

      {/* Clipping Actions Bar */}
      {isClippingMode && (
        <div style={{
          position: "absolute", bottom: "80px", left: "50%", transform: "translateX(-50%)",
          background: "var(--bg-card)", padding: "12px 24px", borderRadius: "8px", border: "1px solid var(--border-subtle)",
          display: "flex", alignItems: "center", gap: "20px", zIndex: 50, boxShadow: "0 4px 12px rgba(0,0,0,0.5)"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }}>
            {exportType === "clip" ? (
              <Scissors size={20} color="var(--accent-violet)" />
            ) : (
              <AlertTriangle size={20} color="var(--color-defeat)" />
            )}
            <div>
              <div style={{ fontSize: "var(--font-sm)", fontWeight: 700 }}>
                {exportType === "clip" ? "Exportar Clip de Video" : "Marcar Error"}
              </div>
              <div style={{ fontSize: "var(--font-xs)", color: "var(--text-muted)" }}>
                {formatTime(clipStart)} - {formatTime(clipEnd)} ({Math.round(Math.max(0.1, clipEnd - clipStart))}s)
              </div>
            </div>
          </div>
          
          <div style={{ display: "flex", gap: "var(--space-3)", flex: 1, alignItems: "center" }}>
            {exportType === "error" && (
              <input
                type="text"
                placeholder="Escribe una nota sobre este error..."
                value={errorNote}
                onChange={(e) => setErrorNote(e.target.value)}
                style={{
                  flex: 1,
                  padding: "var(--space-2) var(--space-3)",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border-strong)",
                  backgroundColor: "var(--bg-panel)",
                  color: "var(--text-primary)",
                  fontSize: "var(--font-sm)",
                  outline: "none"
                }}
              />
            )}
            <button 
              onClick={async () => {
                if (isExporting) return;
                setIsExporting(true);
                try {
                  const dur = Math.max(0.1, clipEnd - clipStart);
                  if (exportType === "clip") {
                    await invoke("export_clip", { matchId: match.id, videoPath: match.video_path, startTime: clipStart, duration: dur });
                  } else {
                    await exportErrorClip(match.id, match.video_path, clipStart, dur, errorNote);
                    setErrorNote("");
                  }
                  setIsClippingMode(false);
                  showSuccess("¡Exportado con éxito!");
                } catch (err) {
                  showError("Error: " + err);
                } finally {
                  setIsExporting(false);
                }
              }}
              disabled={isExporting}
              style={{
                ...styles.ghostBtn, 
                backgroundColor: exportType === "clip" ? "var(--accent-violet)" : "var(--color-defeat)", 
                color: "#fff", 
                border: "none",
                marginLeft: exportType === "clip" ? "auto" : 0,
                padding: "6px 16px",
                borderRadius: "5px"
              }}
            >
              {isExporting ? "Exportando..." : "Exportar " + (exportType === "clip" ? "Clip" : "Error")}
            </button>
            <button 
              onClick={() => setIsClippingMode(false)} 
              style={{ padding: "6px 12px", background: "transparent", border: "1px solid var(--text-muted)", color: "white", borderRadius: "5px", cursor: "pointer" }}
            >
              Cancelar
            </button>
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
    padding: "0 var(--space-2)",
  },
  playbackSelect: {
    background: "transparent",
    color: "var(--text-secondary)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "4px",
    padding: "2px 4px",
    fontSize: "12px",
    outline: "none",
    cursor: "pointer",
    marginLeft: "8px",
  },
  videoTime: {
    color: "#fff",
    fontSize: "var(--font-xs)",
    fontWeight: 600,
    fontFamily: "monospace",
  },
  volumeContainer: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
  },
  volumeSlider: {
    width: "80px",
    accentColor: "var(--accent-violet)",
    cursor: "pointer",
    height: "4px",
    borderRadius: "2px",
    appearance: "none",
    background: "var(--bg-card)",
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
    opacity: 0.9,
    boxShadow: "0 0 8px rgba(255,255,255,0.8)",
  },
  playheadHover: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: "1px",
    backgroundColor: "var(--accent-violet)",
    pointerEvents: "none",
    zIndex: 15,
    opacity: 0.5,
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
  timelineContainer: {
    position: "relative",
    padding: "0 var(--space-4)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-4)",
  },
  timelineLine: {
    position: "absolute",
    left: "21px", // 16px padding + 5px center of 10px dot
    top: "16px",
    bottom: "0",
    width: "2px",
    backgroundColor: "var(--border-subtle)",
    zIndex: 1,
  },
  reviewCardWrapper: {
    display: "flex",
    gap: "var(--space-3)",
    position: "relative",
    zIndex: 2,
    cursor: "pointer",
    transition: "opacity 0.2s, transform 0.2s",
  },
  timelineDot: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    border: "2px solid",
    marginTop: "14px",
    flexShrink: 0,
    zIndex: 3,
  },
  reviewCard: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
    padding: "var(--space-3)",
    borderRadius: "var(--radius-md)",
    border: "1px solid",
    backdropFilter: "blur(8px)", // Glassmorphism
    WebkitBackdropFilter: "blur(8px)",
    transition: "background 0.2s, border-color 0.2s",
  },
  reviewCardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  toneBadge: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "2px 6px",
    borderRadius: "4px",
  },
  reviewCardBody: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
  },
  reviewCardTitle: {
    color: "#fff",
    fontSize: "var(--font-sm)",
    fontWeight: 600,
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
