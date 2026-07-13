import React, { useRef, useState, useEffect, useCallback } from "react";
import { MatchMetadata, MatchEvent, MouseEventData, Comment as MatchComment, Participant, TeamObjectives, ItemPurchase } from "../../../types";
import { invoke } from "@tauri-apps/api/core";
import { outcome } from "../../../core/matchStats";
import {
  Swords, Skull, Handshake, Flame, Droplet,
  Orbit, Crown, Eye, TowerControl, BrickWall,
  Sparkles, Flag, Trophy, FlagOff, Maximize, Play, Pause,
  VolumeX, Volume1, Volume2, Scissors, AlertTriangle,
  ThumbsUp, XCircle, ChevronLeft, ChevronRight, Share2, MousePointer2, EyeOff,
  Trash2, Send, RefreshCw, Check, MinusCircle
} from "lucide-react";
import { exportErrorClip, getMatchDetails, saveMatchComments, syncMatchNow } from "../../../core/tauri-ipc";

// Retratos de campeón: bundleados localmente en public/champions (script scripts/download-champions.ps1).
const champIcon = (champion: string) => `/champions/${champion}.png`;
// Los iconos de items sí se piden a Data Dragon (conjunto grande y volátil). Versión de fallback.
const DDRAGON_VER = "16.13.1";
const itemIcon = (ver: string, id: number) =>
  `https://ddragon.leagueoflegends.com/cdn/${ver}/img/item/${id}.png`;
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
const BARON_COLOR = "var(--color-objective)";

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
  const [tab, setTab] = useState<"stats" | "events" | "comments">("events");
  const [comments, setComments] = useState<MatchComment[]>(match.comments ?? []);
  const [newComment, setNewComment] = useState<string>("");
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const v = parseInt(localStorage.getItem("reviewSidebarWidth") || "380", 10);
    return isNaN(v) ? 380 : Math.min(700, Math.max(300, v));
  });
  const [ddragonVer, setDdragonVer] = useState<string>(DDRAGON_VER);
  const [participants, setParticipants] = useState<Participant[]>(match.participants ?? []);
  const [objectives, setObjectives] = useState<TeamObjectives[]>(match.objectives ?? []);
  const [itemPurchases, setItemPurchases] = useState<ItemPurchase[]>(match.item_purchases ?? []);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [eventFilter, setEventFilter] = useState<"all" | "good" | "neutral" | "bad">("all");

  const { showSuccess, showError } = useDialog();

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const videoSrc = streamUrl(match.video_path);

  // La estela del ratón (mouse_events) NO viene en el listado por rendimiento.
  // La cargamos bajo demanda al abrir la partida en el reproductor.
  const [mouseEvents, setMouseEvents] = useState<MouseEventData[]>(match.mouse_events ?? []);

  useEffect(() => {
    let cancelled = false;
    if (match.mouse_events && match.mouse_events.length > 0) {
      setMouseEvents(match.mouse_events);
      return;
    }
    setMouseEvents([]);
    getMatchDetails(match.id)
      .then((full) => {
        if (!cancelled && full?.mouse_events) setMouseEvents(full.mouse_events);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [match.id]);

  // Comentarios (con marca de tiempo) de la partida.
  useEffect(() => {
    setComments(match.comments ?? []);
  }, [match.id, match.comments]);

  // Última versión de Data Dragon (para los iconos de items).
  useEffect(() => {
    fetch("https://ddragon.leagueoflegends.com/api/versions.json")
      .then((r) => r.json())
      .then((v: string[]) => { if (Array.isArray(v) && v[0]) setDdragonVer(v[0]); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setParticipants(match.participants ?? []);
    setObjectives(match.objectives ?? []);
    setItemPurchases(match.item_purchases ?? []);
  }, [match.id, match.participants, match.objectives, match.item_purchases]);

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

  // --- Comentarios (persistidos en el JSON de la partida vía backend) ---
  const persistComments = useCallback(
    (next: MatchComment[]) => {
      setComments(next);
      saveMatchComments(match.id, next).catch((e) =>
        showError("No se pudieron guardar los comentarios: " + e)
      );
    },
    [match.id, showError]
  );

  const addComment = () => {
    const text = newComment.trim();
    if (!text) return;
    const next = [...comments, { time: currentTime, text }].sort((a, b) => a.time - b.time);
    persistComments(next);
    setNewComment("");
  };

  const deleteComment = (idx: number) => {
    persistComments(comments.filter((_, i) => i !== idx));
  };

  // Sincroniza (backfill) el scoreboard de los 10 jugadores con Riot.
  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const updated = await syncMatchNow(match.id);
      setParticipants(updated.participants ?? []);
      setObjectives(updated.objectives ?? []);
      setItemPurchases(updated.item_purchases ?? []);
    } catch (e) {
      showError("No se pudo sincronizar con Riot: " + e);
    } finally {
      setSyncing(false);
    }
  };

  // --- Redimensionar el panel lateral arrastrando su borde izquierdo ---
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const onMove = (ev: PointerEvent) => {
      const w = Math.min(700, Math.max(300, window.innerWidth - ev.clientX));
      setSidebarWidth(w);
      localStorage.setItem("reviewSidebarWidth", String(Math.round(w)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
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
  // Cerramos la línea hasta el borde inferior para rellenar el área bajo la curva de APM.
  const apmAreaPath = apmLinePath ? `${apmLinePath} L 100 100 L 0 100 Z` : "";

  // Agrupamos eventos cercanos en el tiempo en un único marcador con badge de cantidad,
  // para que no se solapen en la línea de tiempo (estilo Ascent).
  const eventClusters = React.useMemo(() => {
    if (!isFinite(duration) || duration <= 0) return [] as { events: MatchEvent[] }[];
    const evs = match.events
      .filter((e) => e.type !== "GameStart" && e.type !== "GameEnd")
      .sort((a, b) => a.time - b.time);
    const gap = Math.max(8, duration * 0.018); // separación mínima entre marcadores (s)
    const clusters: { events: MatchEvent[] }[] = [];
    for (const ev of evs) {
      const last = clusters[clusters.length - 1];
      if (last && ev.time - last.events[last.events.length - 1].time <= gap) last.events.push(ev);
      else clusters.push({ events: [ev] });
    }
    return clusters;
  }, [match.events, duration]);

  // Evento "principal" de un grupo: el de mayor relevancia (muerte/kill sobre objetivo, etc.).
  const clusterPrimary = (evs: MatchEvent[]): MatchEvent => {
    const pri: Record<string, number> = { deaths: 5, kills: 4, objectives: 3, structures: 2, assists: 1, abilities: 0, other: 0 };
    return [...evs].sort((a, b) => (pri[eventMeta(b).category] ?? 0) - (pri[eventMeta(a).category] ?? 0))[0];
  };

  const result = outcome(match.result);
  const isWin = result === "victory";
  const activeIndex = timedEvents.findIndex(e => e.time === activeEventTime) + 1;

  // Rendimiento del jugador y agregados de su equipo (para el panel "Your Performance").
  const selfP = participants.find((p) => p.is_self);
  const myTeam = selfP ? participants.filter((p) => p.team_id === selfP.team_id) : [];
  const teamKills = myTeam.reduce((s, p) => s + p.kills, 0);
  const teamDamage = myTeam.reduce((s, p) => s + (p.damage ?? 0), 0);
  const durMin = duration > 0 ? duration / 60 : 0;

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
      if (mouseEvents.length === 0) return;
      
      const videoW = v.videoWidth || 1920;
      const videoH = v.videoHeight || 1080;
      const scaleX = canvas.width / videoW;
      const scaleY = canvas.height / videoH;
      
      const TRAIL_DURATION = 1.0;
      const adjustedCt = ct - mouseSync;
      const recentEvents = mouseEvents.filter(e => e.t <= adjustedCt && e.t >= adjustedCt - TRAIL_DURATION);
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
  }, [mouseEvents, mouseSync]);

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
          {loadState === "error" && <div style={styles.centerOverlay}><AlertTriangle size={48} color="var(--color-defeat)" /><span style={{ color: "#fff", marginTop: 8 }}>Couldn't load the video</span></div>}
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
              <button onClick={() => setShowTracker(s => !s)} style={styles.videoPlayBtn} title="Show/Hide Cursor">
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
            {/* APM Graph (línea + área rellena) */}
            {apmSeries.length >= 2 && (
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={styles.graphSvg}>
                <defs>
                  <linearGradient id="apmFill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent-violet)" stopOpacity="0.42" />
                    <stop offset="100%" stopColor="var(--accent-violet)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d={apmAreaPath} fill="url(#apmFill)" stroke="none" />
                <path d={apmLinePath} fill="none" stroke="var(--accent-violet)" strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
              </svg>
            )}

            {/* Marcadores de eventos (agrupados) */}
            {duration > 0 && eventClusters.map((cl, i) => {
              const primary = clusterPrimary(cl.events);
              const meta = eventMeta(primary);
              const pos = (primary.time / duration) * 100;
              const isActive = cl.events.some((e) => e.time === activeEventTime);
              const count = cl.events.length;
              return (
                <div
                  key={i}
                  onClick={(e) => { e.stopPropagation(); jumpToClip(primary.time); }}
                  style={{
                    ...styles.eventNode,
                    left: `${pos}%`,
                    borderColor: meta.color,
                    background: isActive ? meta.color : "var(--bg-app)",
                    transform: `translateX(-50%) scale(${isActive ? 1.25 : 1})`,
                    boxShadow: isActive ? `0 0 10px ${meta.color}` : "none",
                    zIndex: isActive ? 10 : 5,
                  }}
                  title={cl.events.map((e) => `${formatTime(e.time)} · ${eventMeta(e).label}${e.description ? " – " + e.description : ""}`).join("\n")}
                >
                  <span style={{ color: isActive ? "#fff" : meta.color, display: "flex", transform: "scale(0.68)" }}>
                    {meta.icon}
                  </span>
                  {count > 1 && <span style={styles.nodeBadge}>{count}</span>}
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
                backgroundColor: "rgba(61, 139, 253, 0.35)",
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
      <div style={{ ...styles.rightColumn, width: sidebarWidth }}>
        <div style={styles.resizeHandle} onPointerDown={startResize} title="Arrastra para redimensionar" />
        <div style={styles.tabBar}>
          <button onClick={() => setTab("stats")} style={{ ...styles.tab, ...(tab === "stats" ? styles.tabActive : {}) }}>Stats</button>
          <button onClick={() => setTab("events")} style={{ ...styles.tab, ...(tab === "events" ? styles.tabActive : {}) }}>{match.is_vod ? "Análisis" : "Eventos"}</button>
          <button onClick={() => setTab("comments")} style={{ ...styles.tab, ...(tab === "comments" ? styles.tabActive : {}) }}>Comentarios</button>
        </div>

        {tab === "stats" && (
          <div style={styles.tabScroll}>
            {match.is_vod ? (
              <div style={{ ...styles.reviewScoreCard, background: "linear-gradient(180deg, rgba(61, 139, 253, 0.1) 0%, transparent 100%)" }}>
                <div style={{ ...styles.scoreIcon, background: "linear-gradient(135deg, var(--accent-violet), #1e5fd0)", boxShadow: "0 0 20px rgba(61,139,253,0.4)" }}>
                  <MousePointer2 size={28} color="#fff" />
                </div>
                <h2 style={{ ...styles.scoreText, color: "var(--accent-violet)" }}>VOD</h2>
                <p style={styles.scoreSub}>Análisis de cursor y APM de la partida importada.</p>
              </div>
            ) : (
              <div style={{ ...styles.reviewScoreCard, background: isWin ? "linear-gradient(180deg, rgba(77, 166, 255, 0.1) 0%, transparent 100%)" : "linear-gradient(180deg, rgba(255, 77, 77, 0.1) 0%, transparent 100%)" }}>
                <div style={{ ...styles.scoreIcon, background: isWin ? "linear-gradient(135deg, var(--accent-blue), var(--accent-teal))" : "linear-gradient(135deg, #ff4d4d, #cc0000)", boxShadow: isWin ? "0 0 20px rgba(77,166,255,0.4)" : "0 0 20px rgba(255,77,77,0.4)" }}>
                  {isWin ? <Trophy size={28} color="#fff" /> : <XCircle size={28} color="#fff" />}
                </div>
                <h2 style={{ ...styles.scoreText, color: isWin ? "var(--color-victory)" : "var(--color-defeat)" }}>{isWin ? "Victory" : "Defeat"}</h2>
                <p style={styles.scoreSub}>Tú y tu equipo {isWin ? "ganasteis" : "perdisteis"} la partida.</p>
              </div>
            )}

            <div style={styles.statGrid}>
              {match.kda && <div style={styles.statTile}><span style={styles.statLabel}>KDA</span><span style={styles.statValue}>{match.kda}</span></div>}
              {!!match.apm && <div style={styles.statTile}><span style={styles.statLabel}>APM</span><span style={styles.statValue}>{Math.round(match.apm)}</span></div>}
              {!!match.gold_earned && <div style={styles.statTile}><span style={styles.statLabel}>Oro</span><span style={{ ...styles.statValue, color: "var(--accent-gold)" }}>{(match.gold_earned / 1000).toFixed(1)}k</span></div>}
              {!!match.damage_dealt && <div style={styles.statTile}><span style={styles.statLabel}>Daño</span><span style={styles.statValue}>{(match.damage_dealt / 1000).toFixed(1)}k</span></div>}
              <div style={styles.statTile}><span style={styles.statLabel}>Duración</span><span style={styles.statValue}>{formatTime(duration)}</span></div>
              <div style={styles.statTile}><span style={styles.statLabel}>Eventos</span><span style={styles.statValue}>{timedEvents.length}</span></div>
            </div>

            {/* Scoreboard de los 10 jugadores (API Match-V5 de Riot), estilo Ascent */}
            {participants.length > 0 ? (
              [100, 200].map((teamId) => {
                const team = participants.filter((p) => p.team_id === teamId);
                if (team.length === 0) return null;
                const won = team[0].win;
                return (
                  <div key={teamId} style={styles.team}>
                    <div style={styles.teamHeader}>
                      <span style={{ color: won ? "var(--color-victory)" : "var(--color-defeat)" }}>
                        {teamId === 100 ? "Equipo Azul" : "Equipo Rojo"}
                      </span>
                      <span style={{ color: won ? "var(--color-victory)" : "var(--color-defeat)", fontSize: "11px", fontWeight: 700 }}>
                        {won ? "Victoria" : "Derrota"}
                      </span>
                    </div>
                    {team.map((p, i) => {
                      const ratio = p.deaths === 0 ? p.kills + p.assists : (p.kills + p.assists) / p.deaths;
                      return (
                        <div key={i} style={{ ...styles.playerRow, ...(p.is_self ? styles.playerRowSelf : {}) }}>
                          <div style={styles.champWrap}>
                            <img src={champIcon(p.champion)} alt={p.champion} style={styles.champIcon} onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
                            <span style={styles.champLevel}>{p.level}</span>
                          </div>
                          <div style={styles.playerMid}>
                            <span style={styles.playerName}>{p.is_self ? "Tú" : (p.name || p.champion)}</span>
                            <div style={styles.itemRow}>
                              {Array.from({ length: 6 }).map((_, k) => {
                                const it = (p.items ?? [])[k] ?? 0;
                                return it > 0 ? (
                                  <img key={k} src={itemIcon(ddragonVer, it)} style={styles.itemIcon} onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
                                ) : (
                                  <span key={k} style={styles.itemEmpty} />
                                );
                              })}
                            </div>
                          </div>
                          <div style={styles.playerKdaCol}>
                            <span style={styles.playerKda}>{p.kills}/{p.deaths}/{p.assists}</span>
                            <span style={styles.playerRatio}>{ratio.toFixed(2)} KDA</span>
                          </div>
                          <div style={styles.playerNums}>
                            <span style={styles.playerCs}>{p.cs} CS</span>
                            <span style={styles.playerGold}>{(p.gold / 1000).toFixed(1)}k</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })
            ) : (
              !match.is_vod && (
                <div style={styles.syncBox}>
                  <p style={styles.syncText}>Marcador de los 10 jugadores aún no cargado.</p>
                  <button style={styles.syncBtn} onClick={handleSync} disabled={syncing}>
                    <RefreshCw size={14} style={syncing ? { animation: "spin 1s linear infinite" } : undefined} />
                    {syncing ? "Sincronizando…" : "Sincronizar con Riot"}
                  </button>
                  <p style={styles.syncHint}>Requiere tu Riot API key configurada en Ajustes.</p>
                </div>
              )
            )}

            {/* Your Performance (estilo Ascent) */}
            {selfP && (
              <div style={styles.perfBox}>
                <div style={styles.perfHeader}>
                  <img src={champIcon(selfP.champion)} alt={selfP.champion} style={styles.perfChamp} onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
                  <div>
                    <div style={styles.perfTitle}>Tu rendimiento</div>
                    <div style={styles.perfSub}>{selfP.champion} · Nivel {selfP.level}</div>
                  </div>
                </div>
                <div style={styles.perfList}>
                  <div style={styles.perfRow}><span>Kill Participation</span><b>{teamKills > 0 ? Math.round(((selfP.kills + selfP.assists) / teamKills) * 100) + "%" : "—"}</b></div>
                  <div style={styles.perfRow}><span>CS / min</span><b>{durMin > 0 ? (selfP.cs / durMin).toFixed(1) : "—"}</b></div>
                  <div style={styles.perfRow}><span>Daño a campeones</span><b>{(selfP.damage ?? 0).toLocaleString("es")}</b></div>
                  <div style={styles.perfRow}><span>Damage Share</span><b>{teamDamage > 0 ? (100 * (selfP.damage ?? 0) / teamDamage).toFixed(1) + "%" : "—"}</b></div>
                  <div style={styles.perfRow}><span>Daño / min</span><b>{durMin > 0 ? Math.round((selfP.damage ?? 0) / durMin) : "—"}</b></div>
                  <div style={styles.perfRow}><span>Vision Score</span><b>{selfP.vision_score ?? 0}</b></div>
                  <div style={styles.perfRow}><span>Wards colocados</span><b>{selfP.wards_placed ?? 0}</b></div>
                </div>
                <div style={styles.perfItems}>
                  {Array.from({ length: 7 }).map((_, k) => {
                    const it = (selfP.items ?? [])[k] ?? 0;
                    return it > 0 ? (
                      <img key={k} src={itemIcon(ddragonVer, it)} style={styles.perfItem} onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
                    ) : (
                      <span key={k} style={styles.perfItemEmpty} />
                    );
                  })}
                </div>
              </div>
            )}

            {/* Objectives (estilo Ascent) */}
            {objectives.length > 0 && (
              <div style={{ flexShrink: 0 }}>
                <div style={styles.sectionTitle}>Objectives</div>
                <div style={styles.objGrid}>
                  {[100, 200].map((tid) => {
                    const o = objectives.find((x) => x.team_id === tid);
                    if (!o) return null;
                    return (
                      <div key={tid} style={styles.objCol}>
                        <div style={{ ...styles.objTeam, color: o.win ? "var(--color-victory)" : "var(--color-defeat)" }}>
                          {tid === 100 ? "Equipo Azul" : "Equipo Rojo"}
                        </div>
                        <div style={styles.objRow}><span>Dragones</span><b>{o.dragons}</b></div>
                        <div style={styles.objRow}><span>Barones</span><b>{o.barons}</b></div>
                        <div style={styles.objRow}><span>Heraldos</span><b>{o.heralds}</b></div>
                        <div style={styles.objRow}><span>Torres</span><b>{o.towers}</b></div>
                        <div style={styles.objRow}><span>Inhibidores</span><b>{o.inhibitors}</b></div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Compras de items con su minuto (timeline de Riot) */}
            {itemPurchases.length > 0 && (
              <div style={{ flexShrink: 0 }}>
                <div style={styles.sectionTitle}>Compras de items</div>
                <div style={styles.buyGrid}>
                  {itemPurchases.map((ip, i) => (
                    <button key={i} style={styles.buyItem} onClick={() => seekTo(ip.time, false)} title={`Comprado en ${formatTime(ip.time)} · ir a ese momento`}>
                      <img src={itemIcon(ddragonVer, ip.item_id)} alt="" style={styles.buyIcon} onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
                      <span style={styles.buyTime}>{formatTime(ip.time)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Re-sincronizar: partidas sincronizadas con versiones antiguas pueden no
                tener daño/visión/objetivos/cola; esto refresca todo desde Riot. */}
            {!match.is_vod && participants.length > 0 && (
              <button style={styles.resyncBtn} onClick={handleSync} disabled={syncing}>
                <RefreshCw size={13} style={syncing ? { animation: "spin 1s linear infinite" } : undefined} />
                {syncing ? "Actualizando…" : "Actualizar datos de Riot"}
              </button>
            )}
          </div>
        )}

        {tab === "events" && (() => {
          const bucket = (tone: Tone): "good" | "neutral" | "bad" =>
            tone === "excellent" || tone === "good" ? "good"
              : tone === "mistake" || tone === "throw" ? "bad"
              : "neutral";
          const counts = { good: 0, neutral: 0, bad: 0 };
          timedEvents.forEach((e) => { counts[bucket(eventMeta(e).tone)]++; });
          const shown = timedEvents.filter((e) => eventFilter === "all" || bucket(eventMeta(e).tone) === eventFilter);
          const featured = timedEvents.find((e) => e.time === activeEventTime) ?? timedEvents[0];
          const chips: [("good" | "neutral" | "bad"), number, string, React.ReactNode][] = [
            ["good", counts.good, "var(--color-victory)", <Check size={13} />],
            ["neutral", counts.neutral, "var(--text-muted)", <MinusCircle size={13} />],
            ["bad", counts.bad, "var(--color-death)", <XCircle size={13} />],
          ];
          return (
            <>
              {featured && (() => {
                const meta = eventMeta(featured);
                const t = toneLabelAndIcon(meta.tone);
                return (
                  <div style={{ ...styles.featuredCard, borderColor: meta.color }}>
                    <div style={styles.featuredTop}>
                      <span style={{ color: t.color, display: "flex", alignItems: "center", gap: 6, fontWeight: 800, fontSize: 14 }}>
                        {t.icon} {t.text}
                      </span>
                      <button style={styles.featuredTime} onClick={() => jumpToClip(featured.time)}>{formatTime(featured.time)}</button>
                    </div>
                    <div style={styles.featuredName}>
                      <span style={{ color: meta.color, display: "flex" }}>{meta.icon}</span> {meta.label}
                    </div>
                    {featured.description && <p style={styles.featuredDesc}>{featured.description}</p>}
                  </div>
                );
              })()}

              <div style={styles.filterChips}>
                {chips.map(([id, count, color, icon]) => (
                  <button
                    key={id}
                    onClick={() => setEventFilter(eventFilter === id ? "all" : id)}
                    style={{ ...styles.chip, ...(eventFilter === id ? { borderColor: color, color } : {}) }}
                  >
                    <span style={{ color, display: "flex" }}>{icon}</span> {count}
                  </button>
                ))}
              </div>

              <div style={styles.reviewList}>
                <div style={styles.eventListV2}>
                  {shown.map((ev, i) => {
                    const meta = eventMeta(ev);
                    const t = toneLabelAndIcon(meta.tone);
                    const isActive = activeEventTime === ev.time;
                    return (
                      <div
                        key={i}
                        onClick={() => jumpToClip(ev.time)}
                        style={{ ...styles.eventRowV2, ...(isActive ? styles.eventRowV2Active : {}) }}
                      >
                        <span style={styles.eventRowTime}>{formatTime(ev.time)}</span>
                        <span style={{ color: meta.color, display: "flex" }}>{meta.icon}</span>
                        <span style={styles.eventRowLabel}>{meta.label}</span>
                        <span style={{ color: t.color, display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 700, marginLeft: "auto" }}>
                          {t.icon} {t.text}
                        </span>
                      </div>
                    );
                  })}
                  {shown.length === 0 && (
                    <div style={styles.emptyEvents}>
                      {timedEvents.length === 0 ? "No hay eventos registrados en esta partida." : "Sin eventos en este filtro."}
                    </div>
                  )}
                </div>
              </div>

              <div style={styles.reviewFooter}>
                <button onClick={() => goToAdjacentEvent(-1)} style={styles.ghostBtn} title="Evento anterior (P)"><ChevronLeft size={16} /> Previous</button>
                <span style={styles.pageInfo}>{activeIndex || "-"} of {timedEvents.length}</span>
                <button onClick={() => goToAdjacentEvent(1)} style={styles.ghostBtn} title="Evento siguiente (N)">Next <ChevronRight size={16} /></button>
              </div>
            </>
          );
        })()}

        {tab === "comments" && (
          <div style={styles.commentsWrap}>
            <div style={styles.commentsList}>
              {comments.length === 0 && (
                <div style={styles.emptyEvents}>Aún no hay comentarios. Escribe uno abajo y se anclará al minuto actual del vídeo.</div>
              )}
              {comments.map((c, i) => (
                <div key={i} style={styles.commentCard}>
                  <button style={styles.commentTime} onClick={() => seekTo(c.time, false)} title="Ir a este momento">
                    {formatTime(c.time)}
                  </button>
                  <span style={styles.commentText}>{c.text}</span>
                  <button style={styles.commentDelete} onClick={() => deleteComment(i)} title="Eliminar comentario"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
            <div style={styles.commentInputRow}>
              <span style={styles.commentAtTime} title="Se anclará a este momento">{formatTime(currentTime)}</span>
              <input
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addComment(); }}
                placeholder="Comenta este momento…"
                style={styles.commentInput}
              />
              <button style={styles.commentSend} onClick={addComment} title="Añadir en el minuto actual"><Send size={16} /></button>
            </div>
          </div>
        )}
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
                  showSuccess("Exported successfully!");
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
              {isExporting ? "Exporting…" : "Export " + (exportType === "clip" ? "Clip" : "Error")}
            </button>
            <button
              onClick={() => setIsClippingMode(false)}
              style={{ padding: "6px 12px", background: "transparent", border: "1px solid var(--text-muted)", color: "white", borderRadius: "5px", cursor: "pointer" }}
            >
              Cancel
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
    flex: 1,
    minHeight: 0,
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
    fontFamily: "var(--font-mono)",
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
    width: "380px",
    flexShrink: 0,
    position: "relative",
    backgroundColor: "var(--bg-sidebar)",
    borderLeft: "1px solid var(--border-subtle)",
    display: "flex",
    flexDirection: "column",
  },
  resizeHandle: {
    position: "absolute",
    left: "-3px",
    top: 0,
    bottom: 0,
    width: "7px",
    cursor: "ew-resize",
    zIndex: 30,
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
    flexShrink: 0,
    padding: "var(--space-6) var(--space-4)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-lg)",
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
    minHeight: 0,
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
    flexShrink: 0,
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
  },
  tabBar: {
    display: "flex",
    borderBottom: "1px solid var(--border-subtle)",
    padding: "0 var(--space-2)",
    flexShrink: 0,
  },
  tab: {
    flex: 1,
    background: "transparent",
    border: "none",
    borderBottom: "2px solid transparent",
    color: "var(--text-muted)",
    fontSize: "var(--font-sm)",
    fontWeight: 700,
    padding: "var(--space-3) var(--space-2)",
    cursor: "pointer",
    transition: "color 0.15s, border-color 0.15s",
  },
  tabActive: {
    color: "var(--accent-violet)",
    borderBottomColor: "var(--accent-violet)",
  },
  tabScroll: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: "var(--space-4)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-4)",
  },
  statGrid: {
    flexShrink: 0,
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "var(--space-3)",
  },
  statTile: {
    background: "var(--bg-card)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-3)",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  statLabel: {
    color: "var(--text-muted)",
    fontSize: "10px",
    textTransform: "uppercase",
    letterSpacing: "0.4px",
    fontWeight: 700,
  },
  statValue: {
    color: "#fff",
    fontSize: "18px",
    fontWeight: 800,
    fontVariantNumeric: "tabular-nums",
  },
  notesArea: {
    width: "100%",
    minHeight: "220px",
    resize: "vertical",
    background: "var(--bg-card)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    color: "var(--text-primary)",
    fontSize: "var(--font-sm)",
    lineHeight: 1.6,
    padding: "var(--space-3)",
    outline: "none",
    fontFamily: "inherit",
    boxSizing: "border-box",
  },
  notesHint: {
    color: "var(--text-muted)",
    fontSize: "11px",
    margin: 0,
  },
  nodeBadge: {
    position: "absolute",
    top: "-6px",
    right: "-6px",
    minWidth: "15px",
    height: "15px",
    padding: "0 3px",
    borderRadius: "8px",
    background: "var(--accent-violet)",
    color: "#fff",
    fontSize: "9px",
    fontWeight: 800,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 0 0 1.5px var(--bg-card)",
  },
  emptyEvents: {
    color: "var(--text-muted)",
    fontSize: "var(--font-sm)",
    textAlign: "center",
    padding: "var(--space-6) var(--space-4)",
  },
  // --- Scoreboard ---
  team: {
    flexShrink: 0,
    background: "var(--bg-card)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    overflow: "hidden",
  },
  teamHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "var(--space-2) var(--space-3)",
    fontWeight: 700,
    fontSize: "12px",
    borderBottom: "1px solid var(--border-subtle)",
  },
  playerRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "6px var(--space-3)",
    fontSize: "12px",
    borderBottom: "1px solid rgba(255,255,255,0.03)",
  },
  playerRowSelf: {
    background: "var(--accent-violet-soft)",
    boxShadow: "inset 3px 0 0 var(--accent-violet)",
  },
  champIcon: {
    width: "26px",
    height: "26px",
    borderRadius: "6px",
    background: "var(--bg-app)",
    flexShrink: 0,
    objectFit: "cover",
  },
  playerLevel: {
    color: "var(--text-muted)",
    width: "18px",
    textAlign: "center",
    fontVariantNumeric: "tabular-nums",
  },
  playerName: {
    flex: 1,
    fontWeight: 600,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  playerKda: {
    width: "64px",
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
  },
  playerCs: {
    width: "58px",
    textAlign: "right",
    color: "var(--text-muted)",
  },
  playerGold: {
    width: "46px",
    textAlign: "right",
    color: "var(--accent-gold)",
  },
  // --- Comentarios ---
  commentsWrap: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
  commentsList: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: "var(--space-4)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  },
  commentCard: {
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--space-2)",
    background: "var(--bg-card)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-2) var(--space-3)",
  },
  commentTime: {
    background: "var(--accent-violet-soft)",
    color: "var(--accent-violet)",
    border: "none",
    borderRadius: "4px",
    padding: "2px 6px",
    fontSize: "11px",
    fontWeight: 700,
    fontFamily: "var(--font-mono)",
    cursor: "pointer",
    flexShrink: 0,
  },
  commentText: {
    flex: 1,
    fontSize: "13px",
    color: "var(--text-primary)",
    lineHeight: 1.5,
    wordBreak: "break-word",
  },
  commentDelete: {
    background: "transparent",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    padding: "2px",
    display: "flex",
    flexShrink: 0,
  },
  commentInputRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "var(--space-3)",
    borderTop: "1px solid var(--border-subtle)",
  },
  commentAtTime: {
    color: "var(--accent-violet)",
    fontSize: "11px",
    fontWeight: 700,
    fontFamily: "var(--font-mono)",
    flexShrink: 0,
  },
  commentInput: {
    flex: 1,
    background: "var(--bg-card)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    color: "var(--text-primary)",
    fontSize: "13px",
    padding: "var(--space-2) var(--space-3)",
    outline: "none",
  },
  commentSend: {
    background: "var(--accent-violet)",
    border: "none",
    color: "#fff",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-2)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  // --- Scoreboard v2 (estilo Ascent) ---
  champWrap: { position: "relative", flexShrink: 0 },
  champLevel: {
    position: "absolute",
    bottom: "-3px",
    right: "-3px",
    background: "var(--bg-app)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "6px",
    fontSize: "9px",
    fontWeight: 800,
    padding: "0 3px",
    color: "var(--text-secondary)",
    lineHeight: "13px",
  },
  playerMid: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "3px" },
  itemRow: { display: "flex", gap: "2px" },
  itemIcon: { width: "15px", height: "15px", borderRadius: "3px", background: "var(--bg-app)" },
  itemEmpty: { width: "15px", height: "15px", borderRadius: "3px", background: "rgba(255,255,255,0.04)" },
  playerKdaCol: { display: "flex", flexDirection: "column", alignItems: "flex-end", width: "62px", flexShrink: 0 },
  playerRatio: { color: "var(--text-muted)", fontSize: "10px" },
  playerNums: { display: "flex", flexDirection: "column", alignItems: "flex-end", width: "48px", flexShrink: 0 },
  syncBox: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "var(--space-5) var(--space-4)",
    background: "var(--bg-card)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    textAlign: "center",
  },
  syncText: { margin: 0, color: "var(--text-secondary)", fontSize: "13px" },
  syncBtn: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    background: "var(--accent-violet)",
    color: "#fff",
    border: "none",
    borderRadius: "var(--radius-md)",
    padding: "8px 14px",
    fontWeight: 700,
    fontSize: "13px",
    cursor: "pointer",
  },
  syncHint: { margin: 0, color: "var(--text-muted)", fontSize: "11px" },
  resyncBtn: {
    flexShrink: 0,
    alignSelf: "center",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    background: "transparent",
    color: "var(--text-muted)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    padding: "6px 12px",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
  },
  // --- Eventos v2 (estilo Ascent) ---
  featuredCard: {
    flexShrink: 0,
    margin: "var(--space-4) var(--space-4) 0",
    background: "var(--bg-card)",
    border: "1px solid var(--border-subtle)",
    borderLeftWidth: "3px",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-3)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  },
  featuredTop: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  featuredTime: {
    background: "var(--accent-violet-soft)",
    color: "var(--accent-violet)",
    border: "none",
    borderRadius: "4px",
    padding: "2px 8px",
    fontSize: "11px",
    fontWeight: 700,
    fontFamily: "var(--font-mono)",
    cursor: "pointer",
  },
  featuredName: { display: "flex", alignItems: "center", gap: "6px", color: "#fff", fontWeight: 700, fontSize: "14px" },
  featuredDesc: { margin: 0, color: "var(--text-secondary)", fontSize: "12px", lineHeight: 1.5 },
  filterChips: { flexShrink: 0, display: "flex", gap: "var(--space-2)", padding: "var(--space-3) var(--space-4) 0" },
  chip: {
    display: "flex",
    alignItems: "center",
    gap: "5px",
    background: "var(--bg-card)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "16px",
    padding: "4px 12px",
    color: "var(--text-secondary)",
    fontSize: "12px",
    fontWeight: 700,
    cursor: "pointer",
  },
  eventListV2: { display: "flex", flexDirection: "column" },
  eventRowV2: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "8px var(--space-4)",
    cursor: "pointer",
    borderBottom: "1px solid rgba(255,255,255,0.03)",
    fontSize: "12px",
  },
  eventRowV2Active: { background: "hsla(0,0%,100%,0.06)", boxShadow: "inset 3px 0 0 var(--accent-violet)" },
  eventRowTime: { color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "11px", width: "40px", flexShrink: 0 },
  eventRowLabel: { color: "#fff", fontWeight: 600 },
  // --- Your Performance ---
  perfBox: {
    flexShrink: 0,
    background: "var(--bg-card)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-3)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-3)",
  },
  perfHeader: { display: "flex", alignItems: "center", gap: "var(--space-3)" },
  perfChamp: { width: "40px", height: "40px", borderRadius: "8px", background: "var(--bg-app)" },
  perfTitle: { color: "#fff", fontWeight: 700, fontSize: "14px" },
  perfSub: { color: "var(--text-muted)", fontSize: "12px" },
  perfList: { display: "flex", flexDirection: "column" },
  perfRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "6px 0",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
    fontSize: "13px",
    color: "var(--text-muted)",
  },
  perfItems: { display: "flex", gap: "3px" },
  perfItem: { width: "26px", height: "26px", borderRadius: "5px", background: "var(--bg-app)" },
  perfItemEmpty: { width: "26px", height: "26px", borderRadius: "5px", background: "rgba(255,255,255,0.04)" },
  sectionTitle: {
    color: "var(--text-secondary)",
    fontSize: "12px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.4px",
    marginBottom: "var(--space-2)",
  },
  objGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)" },
  objCol: {
    background: "var(--bg-card)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-3)",
  },
  objTeam: { fontWeight: 700, fontSize: "12px", marginBottom: "var(--space-2)" },
  objRow: { display: "flex", justifyContent: "space-between", fontSize: "12px", color: "var(--text-muted)", padding: "3px 0" },
  buyGrid: { display: "flex", flexWrap: "wrap", gap: "var(--space-2)" },
  buyItem: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "2px",
    background: "var(--bg-card)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    padding: "4px",
    cursor: "pointer",
  },
  buyIcon: { width: "30px", height: "30px", borderRadius: "5px", background: "var(--bg-app)" },
  buyTime: { color: "var(--text-muted)", fontSize: "10px", fontFamily: "var(--font-mono)" },
};
