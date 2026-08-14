import React, { useRef, useState, useEffect, useCallback } from "react";
import { MatchMetadata, MatchEvent, MouseEventData, Comment as MatchComment, Participant, TeamObjectives, ItemPurchase, TimelineMarker } from "../../../types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { outcome } from "../../../core/matchStats";
import {
  Eye, Sparkles, Trophy, Maximize, Play, Pause,
  VolumeX, Volume1, Volume2, Scissors, AlertTriangle,
  XCircle, ChevronLeft, ChevronRight, MousePointer2,
  Trash2, Send, RefreshCw, Check, MinusCircle,
  SkipBack, SkipForward, MoreHorizontal
} from "lucide-react";
import { exportErrorClip, getMatchDetails, saveMatchComments, syncMatchNow } from "../../../core/tauri-ipc";
import { analyzeCameraSnaps, getCameraSnapSummary, SnapSummary, fmtClock } from "../../training/api";
import { GoldXpChart } from "./GoldXpChart";
import { TacticalMap } from "./TacticalMap";
import { MapAwarenessWidget } from "./MapAwarenessWidget";
import { PowerSpikeWidget } from "./PowerSpikeWidget";
import { GankEfficiencyWidget } from "./GankEfficiencyWidget";
import { PerformanceTrendsWidget } from "./PerformanceTrendsWidget";
import { EsportsPlayerOverlay } from "./EsportsPlayerOverlay";
import { useDialog } from "../../../components/ui/DialogProvider";
import { eventMeta, toneLabelAndIcon, type Tone } from "./eventMeta";
import { ReviewQueue, buildQueue, type Moment } from "./ReviewQueue";
import { describeEvent } from "../../../core/eventText";
import { styles } from "./videoPlayerStyles";
import { mix } from "../../../core/color";
import {
  champIcon,
  itemIcon,
  DDRAGON_VER,
  streamUrl,
  mouseSpace,
  smoothLinePath,
  CLIP_BEFORE,
  CLIP_AFTER,
} from "./videoPlayerUtils";

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
  // La pestana por defecto es la cola de revision, no las estadisticas: al abrir
  // una partida lo que quieres saber es que mirar, no como te fue.
  const [tab, setTab] = useState<"review" | "stats" | "analytics" | "events" | "comments">("review");

  // Los momentos que merecen una mirada. Se recalculan solo si cambia la partida.
  const [moments, setMoments] = useState<Moment[]>(() => buildQueue(match));
  useEffect(() => { setMoments(buildQueue(match)); }, [match.id]);
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
  const [showEsportsHud, setShowEsportsHud] = useState<boolean>(true);

  const { showSuccess, showError } = useDialog();

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const videoSrc = streamUrl(match.video_path);

  // La estela del ratón (mouse_events) NO viene en el listado por rendimiento.
  const [currentMatch, setCurrentMatch] = useState<MatchMetadata>(match);
  const [mouseEvents, setMouseEvents] = useState<MouseEventData[]>(match.mouse_events ?? []);

  // Los comentarios NO tienen estado propio: se derivan de `currentMatch`, que es lo que se
  // persiste. Antes vivían a la vez en un useState, en currentMatch.comments y en el backend,
  // sincronizados a mano por dos efectos, y bastaba con que uno se quedara atrás para que la
  // lista mostrara algo distinto de lo guardado.
  const comments: MatchComment[] = currentMatch.comments ?? [];

  useEffect(() => {
    setCurrentMatch(match);
  }, [match]);

  useEffect(() => {
    let cancelled = false;
    getMatchDetails(match.id)
      .then((full) => {
        if (!cancelled && full) {
          // El detalle manda en todo menos en los comentarios: si viene sin ellos conservamos los
          // del listado en vez de vaciar la pestaña.
          setCurrentMatch({ ...full, comments: full.comments ?? match.comments });
          if (full.mouse_events) setMouseEvents(full.mouse_events);
          if (full.participants) setParticipants(full.participants);
          if (full.objectives) setObjectives(full.objectives);
          if (full.item_purchases) setItemPurchases(full.item_purchases);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [match.id]);

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

  // Un salto grande anima el cursor; avanzar reproduciendo, no. La regla del
  // sistema: si el movimiento lo causa el sistema, curva; si lo causa la mano
  // del usuario o el propio vídeo, latencia cero.
  const [isSeeking, setIsSeeking] = useState(false);
  const seekAnimRef = useRef<number | null>(null);

  const seekTo = useCallback((seconds: number, play: boolean) => {
    const v = videoRef.current;
    if (!v) return;
    const target = Math.max(0, Math.min(seconds, duration || seconds));
    const jumped = Math.abs(target - v.currentTime) > 1.5;
    v.currentTime = target;
    setCurrentTime(target);
    if (jumped) {
      setIsSeeking(true);
      if (seekAnimRef.current) window.clearTimeout(seekAnimRef.current);
      // 240ms = --t-base con un margen, para no cortar la transición a medias.
      seekAnimRef.current = window.setTimeout(() => setIsSeeking(false), 240);
    }
    if (play && v.paused) v.play().catch(() => {});
  }, [duration]);

  useEffect(() => () => {
    if (seekAnimRef.current) window.clearTimeout(seekAnimRef.current);
  }, []);

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
      setCurrentMatch((prev) => ({ ...prev, comments: next }));
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
      setCurrentMatch(updated);
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
  
  // --- Saltos de cámara (entrenamiento de teclas de aliado) ---
  // Los tiempos viven en la metadata; el resumen (checks/min, hueco ciego) se pide
  // aparte porque se calcula del informe detallado del analizador.
  const [snapSummary, setSnapSummary] = useState<SnapSummary | null>(null);
  const [snapBusy, setSnapBusy] = useState(false);
  const [snapPct, setSnapPct] = useState(0);
  const [cameraSnaps, setCameraSnaps] = useState<number[]>(match.camera_snaps ?? []);

  useEffect(() => {
    setCameraSnaps(match.camera_snaps ?? []);
    getCameraSnapSummary(match.id).then(setSnapSummary).catch(() => setSnapSummary(null));
  }, [match.id, match.camera_snaps]);

  useEffect(() => {
    if (!snapBusy) return;
    const un = listen<number>("snaps_progress_pct", (e) => setSnapPct(e.payload));
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, [snapBusy]);

  const runSnapAnalysis = async () => {
    setSnapBusy(true);
    setSnapPct(0);
    try {
      const res = await analyzeCameraSnaps(match.id);
      if (res.success) {
        setSnapSummary(await getCameraSnapSummary(match.id));
        // La metadata que nos pasaron ya está vieja: releemos para pintar las marcas.
        const fresh = await getMatchDetails(match.id);
        setCameraSnaps(fresh?.camera_snaps ?? []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSnapBusy(false);
    }
  };

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

    // Los marcadores de la Timeline de Riot repiten kills, muertes y objetivos que ya
    // llegan por la API en directo (con mejor descripción): ahora que ambos van en el
    // mismo eje de tiempo, se solaparían en la misma marca y contarían doble.
    const alreadyLive = (tm: TimelineMarker) =>
      match.events.some((ev) => {
        if (Math.abs(ev.time - tm.time) > 6) return false;
        switch (tm.event_type) {
          case "kill": return ev.type === "ChampionKill" && ev.subtype !== "death";
          case "death": return ev.type === "ChampionKill" && ev.subtype === "death";
          case "dragon": return ev.type === "DragonKill";
          case "herald": return ev.type === "HeraldKill" || ev.type === "BaronKill";
          case "tower": return ev.type === "TowerKill";
          default: return false;
        }
      });

    const timelineEvents: MatchEvent[] = (match.timeline_markers ?? [])
      // `gank_attempt` es materia prima del widget de ganks (una marca por minuto de
      // presencia en línea), no un evento que pintar en la línea de tiempo.
      .filter((tm) => tm.event_type !== "gank_attempt" && !alreadyLive(tm))
      .map((tm) => {
        let type = "ChampionKill";
        let subtype: string | undefined = "kill";
        if (tm.event_type === "kill") { type = "ChampionKill"; subtype = "kill"; }
        else if (tm.event_type === "death") { type = "ChampionKill"; subtype = "death"; }
        else if (tm.event_type === "dragon") { type = "DragonKill"; subtype = "ally"; }
        else if (tm.event_type === "herald") { type = "HeraldKill"; subtype = "ally"; }
        else if (tm.event_type === "tower") { type = "TowerKill"; subtype = "ally"; }
        else if (tm.event_type === "plate") { type = "TowerKill"; subtype = "plate"; }

        return {
          type,
          subtype,
          time: tm.time,
          description: tm.description,
        };
      });

    const allEvs = [...match.events, ...timelineEvents]
      .filter((e) => e.type !== "GameStart" && e.type !== "GameEnd")
      .sort((a, b) => a.time - b.time);

    const gap = Math.max(8, duration * 0.018); // separación mínima entre marcadores (s)
    const clusters: { events: MatchEvent[] }[] = [];
    for (const ev of allEvs) {
      const last = clusters[clusters.length - 1];
      if (last && ev.time - last.events[last.events.length - 1].time <= gap) last.events.push(ev);
      else clusters.push({ events: [ev] });
    }
    return clusters;
  }, [match.events, match.timeline_markers, duration]);

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
      // En pixeles de dispositivo, no CSS: en una pantalla HiDPI el trazo salia
      // borroso porque el buffer tenia menos resolucion que la pantalla.
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
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
      
      // Las coordenadas del ratón vienen de rdev y están en el espacio del
      // ESCRITORIO, no del vídeo. Escalar por las dimensiones del vídeo desplazaba
      // toda la estela cuando se grababa a una resolución distinta a la del monitor
      // (1080p en un monitor 1440p = todo dibujado un 33% más lejos del origen).
      const videoW = v.videoWidth || 1920;
      const videoH = v.videoHeight || 1080;
      const [spaceW, spaceH] = mouseSpace(match, videoW, videoH);

      // El <video> se pinta con `object-fit: contain`, asi que cuando la
      // proporcion del contenedor no coincide con la del video quedan barras y
      // la imagen ocupa solo una parte. El canvas, en cambio, cubre el
      // contenedor entero. Mapear sobre `canvas.width/height` estiraba la estela
      // sobre las barras y la dejaba desplazada; solo cuadraba en pantalla
      // completa, que es justo cuando las proporciones coinciden y no hay barras.
      //
      // Hay que mapear sobre el rectangulo donde el video se pinta de verdad.
      const fit = Math.min(canvas.width / videoW, canvas.height / videoH);
      const paintedW = videoW * fit;
      const paintedH = videoH * fit;
      const offX = (canvas.width - paintedW) / 2;
      const offY = (canvas.height - paintedH) / 2;
      const scaleX = paintedW / spaceW;
      const scaleY = paintedH / spaceH;
      const px = (x: number) => offX + x * scaleX;
      const py = (y: number) => offY + y * scaleY;
      
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
          ctx.moveTo(px(p1.x), py(p1.y));
          ctx.lineTo(px(p2.x), py(p2.y));
          ctx.lineWidth = 2.5 + ageRatio * 4;
          // Rampa oro -> turquesa: lo viejo se apaga hacia el oro, lo reciente
          // llega en turquesa. Va en números porque es canvas y `fillStyle` no
          // entiende var(); son los mismos dos tintes del sistema.
          const r = Math.floor(200 + ageRatio * (10 - 200));
          const g = Math.floor(170 + ageRatio * (200 - 170));
          const b = Math.floor(110 + ageRatio * (185 - 110));
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
        ctx.arc(px(click.x), py(click.y), radius, 0, Math.PI * 2);
        ctx.lineWidth = 4;
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${opacity * 0.8})`;
        ctx.stroke();

        // Núcleo interior brillante
        ctx.beginPath();
        ctx.arc(px(click.x), py(click.y), radius * 0.4, 0, Math.PI * 2);
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

  // Transporte. Lo que se hace en esta pantalla es saltar entre momentos, así que
  // eso manda en el centro; los ajustes crípticos (sincronía del rastro del ratón,
  // capas del overlay) se van a un menú con nombres de verdad en vez de vivir
  // sueltos y sin etiqueta en la barra principal.
  //
  // Va acoplado a la baraja, y solo flota sobre el vídeo en pantalla completa,
  // que es cuando la baraja no existe.
  const transportBar = (
        <div className="tp" style={isFullscreen ? styles.transportOverlay : styles.transportDocked}>
          <button
            className="tp-b"
            onClick={() => goToAdjacentEvent(-1)}
            title="Previous moment"
            aria-label="Previous moment"
          >
            <SkipBack size={14} fill="currentColor" />
          </button>
          <button
            className="tp-b tp-b--primary"
            onClick={handlePlayPause}
            title={isPlaying ? "Pause" : "Play"}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? <Pause fill="currentColor" size={15} /> : <Play fill="currentColor" size={15} />}
          </button>
          <button
            className="tp-b"
            onClick={() => goToAdjacentEvent(1)}
            title="Next moment"
            aria-label="Next moment"
          >
            <SkipForward size={14} fill="currentColor" />
          </button>

          {/* Centesimas: en una herramienta de revision hace falta senalar un
              instante, no un minuto. */}
          <span className="tp-tc">
            <b>{formatTime(currentTime)}.{String(Math.floor((currentTime % 1) * 100)).padStart(2, "0")}</b>
            <span className="tp-tc__total"> / {formatTime(duration)}</span>
          </span>

          <span className="tp-sep" />

          {/* Segmentado y no desplegable: durante una revision la velocidad se
              cambia constantemente y un desplegable son dos clics cada vez. */}
          <span className="tp-seg" role="group" aria-label="Playback speed">
            {[0.25, 0.5, 1, 2].map((r) => (
              <button
                key={r}
                onClick={() => setPlaybackRate(r)}
                aria-pressed={playbackRate === r}
                data-on={playbackRate === r ? "" : undefined}
              >
                {r}&times;
              </button>
            ))}
          </span>

          <span style={{ flex: 1, minWidth: 12 }} />

          <div className="tp-vol">
            <button className="tp-b" onClick={toggleMute} title={muted ? "Unmute" : "Mute"} aria-label={muted ? "Unmute" : "Mute"}>
              {muted || volume === 0 ? <VolumeX size={15} /> : volume < 0.5 ? <Volume1 size={15} /> : <Volume2 size={15} />}
            </button>
            <input
              type="range" min="0" max="1" step="0.05"
              value={muted ? 0 : volume}
              onChange={handleVolumeChange}
              aria-label="Volume"
              style={styles.volumeSlider}
            />
          </div>

          <details className="tp-more">
            <summary title="Playback settings" aria-label="Playback settings">
              <MoreHorizontal size={15} />
            </summary>
            <div className="tp-pop">
              <label className="tp-pop__row">
                <span>Broadcast overlay</span>
                <input type="checkbox" checked={showEsportsHud} onChange={() => setShowEsportsHud((h) => !h)} />
              </label>
              <label className="tp-pop__row">
                <span>Mouse trail</span>
                <input type="checkbox" checked={showTracker} onChange={() => setShowTracker((v) => !v)} />
              </label>
              <div className="tp-pop__row tp-pop__row--stack">
                <span>
                  Mouse trail sync
                  <em>Shifts the trail against the video, in seconds.</em>
                </span>
                <div className="tp-pop__sync">
                  <input
                    type="range" min="-3" max="3" step="0.1" value={mouseSync}
                    aria-label="Mouse trail sync"
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      setMouseSync(val);
                      localStorage.setItem("mouseSyncOffset", val.toString());
                    }}
                  />
                  <span className="tp-pop__val">{mouseSync > 0 ? `+${mouseSync.toFixed(1)}` : mouseSync.toFixed(1)}s</span>
                </div>
              </div>
            </div>
          </details>

          <button className="tp-b" onClick={toggleFullscreen} title="Fullscreen" aria-label="Fullscreen">
            <Maximize size={15} />
          </button>
        </div>
  );

  return (
    <div ref={containerRef} style={styles.container}>
      <div style={styles.leftColumn}>
        <div style={styles.videoWrapper}>
          <div style={styles.topBar}>
            <div style={styles.topBarLeft}></div>
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
          {loadState === "error" && <div style={styles.centerOverlay}><AlertTriangle size={48} color="var(--color-defeat)" /><span style={{ color: "var(--text)", marginTop: 8 }}>Couldn't load the video</span></div>}
          <canvas ref={canvasRef} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 5, opacity: showTracker ? 1 : 0, transition: "opacity 0.2s" }} />
          
          {/* Overlay eSports Broadcast (HUD flotante sobre el vídeo) */}
          <EsportsPlayerOverlay
            currentTime={currentTime}
            match={currentMatch}
            visible={showEsportsHud}
          />

          {isFullscreen && transportBar}
        </div>
        {/* Transporte y linea de tiempo son la misma herramienta: antes eran una
            barra flotando sobre el video y, separada y mas abajo, una tira con el
            APM y los eventos que ademas hacia de barra de busqueda. Por eso el
            centro del transporte estaba vacio: le faltaba su mitad. */}
        {!isFullscreen && (
        <div style={styles.deck}>
          {transportBar}
          <div style={styles.timelineHeaderRow}>
            <span style={styles.apmLabel}>Average APM: {Math.round(match.apm || 0)}</span>
            {/* Métricas de uso de las teclas de cámara aliada. */}
            {snapSummary?.analyzed ? (
              <span
                style={styles.snapLabel}
                title="Camera repositions found in the video (deaths excluded). This counts ally camera keys AND minimap clicks — it is a proxy for how often you took the camera off yourself, not an exact F-key count. Games recorded from now on measure the keys exactly."
              >
                <Eye size={13} /> {snapSummary.per_minute.toFixed(1)}/min
                <span style={{ color: "var(--text-muted)" }}>·</span>
                <span
                  style={{
                    color:
                      snapSummary.longest_gap_secs > 120
                        ? "var(--color-defeat)"
                        : "var(--color-victory)",
                  }}
                >
                  {fmtClock(snapSummary.longest_gap_secs)} blind
                </span>
              </span>
            ) : (
              <button
                onClick={runSnapAnalysis}
                disabled={snapBusy}
                style={{ ...styles.ghostBtn, opacity: snapBusy ? 0.6 : 1 }}
                title="Scan the video for camera repositions (ally camera keys and minimap clicks)"
              >
                <Eye size={14} />
                {snapBusy ? `Scanning ${snapPct.toFixed(0)}%` : "Camera moves"}
              </button>
            )}
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
                <path d={apmAreaPath} fill="var(--apm-fill)" stroke="none" />
                <path d={apmLinePath} fill="none" stroke="var(--apm-line)" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
              </svg>
            )}

            {/* Saltos de cámara: tira de marcas finas al pie de la curva de APM.
                Los huecos anchos son exactamente los minutos en que no miraste a nadie. */}
            {duration > 0 && cameraSnaps.length > 0 && (
              <div style={styles.snapStrip}>
                {cameraSnaps.map((t, i) => (
                  <div
                    key={i}
                    style={{ ...styles.snapTick, left: `${(t / duration) * 100}%` }}
                  />
                ))}
              </div>
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
                    width: "28px",
                    height: "28px",
                    borderColor: isActive ? meta.color : mix(meta.color, 55),
                    background: isActive ? meta.color : "var(--panel)",
                    transform: "translateX(-50%)",
                    boxShadow: "none",
                    zIndex: isActive ? 10 : 5,
                  }}
                  title={cl.events.map((e) => `${formatTime(e.time)} · ${eventMeta(e).label} – ${describeEvent(e)}`).join("\n")}
                >
                  <span style={{ color: isActive ? "var(--text)" : meta.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {meta.icon}
                  </span>
                  {count > 1 && (
                    <span style={{
                      position: "absolute",
                      top: "-7px",
                      right: "-7px",
                      minWidth: "16px",
                      height: "16px",
                      padding: "0 4px",
                      borderRadius: "10px",
                      background: "color-mix(in srgb, var(--ground) 95%, transparent)",
                      border: `1.5px solid ${meta.color}`,
                      color: "var(--text)",
                      fontSize: "10px",
                      fontWeight: 800,
                      fontFamily: "var(--font-mono)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxShadow: "0 2px 6px rgba(0,0,0,0.8)",
                    }}>
                      {count}
                    </span>
                  )}
                </div>
              );
            })}

            {/* Cursor de reproducción. Durante la reproducción va pegado al vídeo
                (sin transición); cuando el salto lo provoca un evento o un
                comentario, recorre la distancia en --t-base para que se vea
                hacia qué lado y cuánto te has movido dentro de la partida. */}
            <div
              style={{
                ...styles.playhead,
                left: `${progressPct}%`,
                transition: isSeeking ? "left var(--t-base) var(--e-move)" : "none",
              }}
            />
            
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
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", fontWeight: "bold", color: "var(--text)" }}>
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
                      {meta.label} {`- ${describeEvent(ev)}`}
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
                backgroundColor: "color-mix(in srgb, var(--accent-blue) 35%, transparent)",
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
        <div style={styles.resizeHandle} onPointerDown={startResize} title="Drag to resize" />
        <div style={styles.tabBar}>
          <button onClick={() => setTab("review")} style={{ ...styles.tab, ...(tab === "review" ? styles.tabActive : {}) }}>Review</button>
          <button onClick={() => setTab("stats")} style={{ ...styles.tab, ...(tab === "stats" ? styles.tabActive : {}) }}>Stats</button>
          <button onClick={() => setTab("analytics")} style={{ ...styles.tab, ...(tab === "analytics" ? styles.tabActive : {}) }}>Analytics</button>
          <button onClick={() => setTab("events")} style={{ ...styles.tab, ...(tab === "events" ? styles.tabActive : {}) }}>{match.is_vod ? "Analysis" : "Events"}</button>
          <button onClick={() => setTab("comments")} style={{ ...styles.tab, ...(tab === "comments" ? styles.tabActive : {}) }}>Comments</button>
        </div>

        {tab === "review" && (
          <ReviewQueue
            matchId={match.id}
            moments={moments}
            currentTime={currentTime}
            onSeek={(secs) => jumpToClip(secs)}
            onChange={setMoments}
          />
        )}

        {tab === "stats" && (
          <div style={styles.tabScroll}>
            {match.is_vod ? (
              <div style={{ ...styles.reviewScoreCard, borderLeft: "2px solid var(--cool)" }}>
                <MousePointer2 size={18} color="var(--cool)" />
                <div style={{ minWidth: 0 }}>
                  <div style={{ ...styles.scoreText, color: "var(--cool)" }}>Imported VOD</div>
                  <p style={styles.scoreSub}>Cursor and APM analysis.</p>
                </div>
              </div>
            ) : (
              <div style={{ ...styles.reviewScoreCard, borderLeft: `2px solid ${isWin ? "var(--win)" : "var(--loss)"}` }}>
                {isWin ? <Trophy size={18} color="var(--win)" /> : <XCircle size={18} color="var(--loss)" />}
                <div style={{ minWidth: 0 }}>
                  <div style={{ ...styles.scoreText, color: isWin ? "var(--win)" : "var(--loss)" }}>
                    {isWin ? "Victory" : "Defeat"}
                  </div>
                  <p style={styles.scoreSub}>{match.champion} · {formatTime(duration)}</p>
                </div>
              </div>
            )}

            <div style={styles.statGrid}>
              {match.kda && <div style={styles.statTile}><span style={styles.statLabel}>KDA</span><span style={styles.statValue}>{match.kda}</span></div>}
              {!!match.apm && <div style={styles.statTile}><span style={styles.statLabel}>APM</span><span style={styles.statValue}>{Math.round(match.apm)}</span></div>}
              {!!match.gold_earned && <div style={styles.statTile}><span style={styles.statLabel}>Gold</span><span style={{ ...styles.statValue, color: "var(--accent-gold)" }}>{(match.gold_earned / 1000).toFixed(1)}k</span></div>}
              {!!match.damage_dealt && <div style={styles.statTile}><span style={styles.statLabel}>Damage</span><span style={styles.statValue}>{(match.damage_dealt / 1000).toFixed(1)}k</span></div>}
              <div style={styles.statTile}><span style={styles.statLabel}>Duration</span><span style={styles.statValue}>{formatTime(duration)}</span></div>
              <div style={styles.statTile}><span style={styles.statLabel}>Events</span><span style={styles.statValue}>{timedEvents.length}</span></div>
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
                        {teamId === 100 ? "Blue Team" : "Red Team"}
                      </span>
                      <span style={{ color: won ? "var(--color-victory)" : "var(--color-defeat)", fontSize: "11px", fontWeight: 700 }}>
                        {won ? "Victory" : "Defeat"}
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
                    <div style={styles.perfTitle}>Your performance</div>
                    <div style={styles.perfSub}>{selfP.champion} · Level {selfP.level}</div>
                  </div>
                </div>
                <div style={styles.perfList}>
                  <div style={styles.perfRow}><span>Kill Participation</span><b>{teamKills > 0 ? Math.round(((selfP.kills + selfP.assists) / teamKills) * 100) + "%" : "—"}</b></div>
                  <div style={styles.perfRow}><span>CS / min</span><b>{durMin > 0 ? (selfP.cs / durMin).toFixed(1) : "—"}</b></div>
                  <div style={styles.perfRow}><span>Damage to champions</span><b>{(selfP.damage ?? 0).toLocaleString("es")}</b></div>
                  <div style={styles.perfRow}><span>Damage Share</span><b>{teamDamage > 0 ? (100 * (selfP.damage ?? 0) / teamDamage).toFixed(1) + "%" : "—"}</b></div>
                  <div style={styles.perfRow}><span>Damage / min</span><b>{durMin > 0 ? Math.round((selfP.damage ?? 0) / durMin) : "—"}</b></div>
                  <div style={styles.perfRow}><span>Vision Score</span><b>{selfP.vision_score ?? 0}</b></div>
                  <div style={styles.perfRow}><span>Wards placed</span><b>{selfP.wards_placed ?? 0}</b></div>
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
                          {tid === 100 ? "Blue Team" : "Red Team"}
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

            {/* Re-sincronizar con Riot */}
            {!match.is_vod && participants.length > 0 && (
              <button style={styles.resyncBtn} onClick={handleSync} disabled={syncing}>
                <RefreshCw size={13} style={syncing ? { animation: "spin 1s linear infinite" } : undefined} />
                {syncing ? "Actualizando…" : "Actualizar datos de Riot"}
              </button>
            )}
          </div>
        )}

        {tab === "analytics" && (
          <div style={styles.tabScroll}>
            {/* Comparativa de Rendimiento y Tendencias con el Campeón */}
            <PerformanceTrendsWidget currentMatch={match} />

            {/* Early Game @ 15m (Riot Timeline v5) Card */}
            {(match.gold_diff_15 !== undefined || match.jungle_cs_diff_15 !== undefined || match.gank_impact_15 !== undefined) && (
              <div style={{
                backgroundColor: "var(--bg-card)",
                border: "1px solid var(--border-subtle)",
                borderTop: "3px solid var(--accent-violet)",
                borderRadius: "var(--radius-lg)",
                padding: "16px",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                boxShadow: "0 4px 16px rgba(0, 0, 0, 0.25)",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--text)", fontWeight: 700, fontSize: "13px" }}>
                    <Sparkles size={16} color="var(--accent-violet)" />
                    <span>Fase Temprana (@15 min)</span>
                  </div>
                  {match.lane_result && (
                    <span style={{
                      fontSize: "11px",
                      fontWeight: 800,
                      padding: "2px 8px",
                      borderRadius: "12px",
                      textTransform: "uppercase",
                      letterSpacing: "0.5px",
                      background: match.lane_result === "Win" ? "color-mix(in srgb, var(--color-victory) 15%, transparent)" : match.lane_result === "Loss" ? "color-mix(in srgb, var(--color-defeat) 15%, transparent)" : "rgba(255, 255, 255, 0.1)",
                      color: match.lane_result === "Win" ? "var(--color-victory)" : match.lane_result === "Loss" ? "var(--color-defeat)" : "var(--text-secondary)",
                      border: `1px solid ${match.lane_result === "Win" ? "color-mix(in srgb, var(--color-victory) 30%, transparent)" : match.lane_result === "Loss" ? "color-mix(in srgb, var(--color-defeat) 30%, transparent)" : "rgba(255, 255, 255, 0.15)"}`,
                    }}>
                      {match.lane_result === "Win" ? "Victoria de Línea" : match.lane_result === "Loss" ? "Derrota de Línea" : "Línea Igualada"}
                    </span>
                  )}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                  {match.gold_diff_15 !== undefined && match.gold_diff_15 !== null && (
                    <div style={{ background: "var(--bg-app)", borderRadius: "var(--radius-md)", padding: "10px", border: "1px solid var(--border-subtle)" }}>
                      <span style={{ fontSize: "10px", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>Gold difference</span>
                      <div style={{ fontSize: "16px", fontWeight: 800, marginTop: "2px", color: match.gold_diff_15 >= 0 ? "var(--color-victory)" : "var(--color-defeat)" }}>
                        {match.gold_diff_15 >= 0 ? `+${match.gold_diff_15}g` : `${match.gold_diff_15}g`}
                      </div>
                    </div>
                  )}

                  {match.xp_diff_15 !== undefined && match.xp_diff_15 !== null && (
                    <div style={{ background: "var(--bg-app)", borderRadius: "var(--radius-md)", padding: "10px", border: "1px solid var(--border-subtle)" }}>
                      <span style={{ fontSize: "10px", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>Diferencia de XP</span>
                      <div style={{ fontSize: "16px", fontWeight: 800, marginTop: "2px", color: match.xp_diff_15 >= 0 ? "var(--color-victory)" : "var(--color-defeat)" }}>
                        {match.xp_diff_15 >= 0 ? `+${match.xp_diff_15} XP` : `${match.xp_diff_15} XP`}
                      </div>
                    </div>
                  )}

                  {match.jungle_cs_diff_15 !== undefined && match.jungle_cs_diff_15 !== null && (
                    <div style={{ background: "var(--bg-app)", borderRadius: "var(--radius-md)", padding: "10px", border: "1px solid var(--border-subtle)" }}>
                      <span style={{ fontSize: "10px", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>Diferencia de Jungla</span>
                      <div style={{ fontSize: "16px", fontWeight: 800, marginTop: "2px", color: "var(--flag)" }}>
                        {match.jungle_cs_diff_15 >= 0 ? `+${match.jungle_cs_diff_15} CS` : `${match.jungle_cs_diff_15} CS`}
                      </div>
                    </div>
                  )}

                  {match.gank_impact_15 !== undefined && match.gank_impact_15 !== null && (
                    <div style={{ background: "var(--bg-app)", borderRadius: "var(--radius-md)", padding: "10px", border: "1px solid var(--border-subtle)" }}>
                      <span style={{ fontSize: "10px", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>Presión de Ganks</span>
                      <div style={{ fontSize: "16px", fontWeight: 800, marginTop: "2px", color: "var(--color-objective)" }}>
                        {match.gank_impact_15}%
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Gráfica de Ventaja de Oro y XP minuto a minuto */}
            {match.minute_frames && match.minute_frames.length > 1 && (
              <GoldXpChart
                frames={match.minute_frames}
                videoOffset={match.video_offset ?? 0}
                onSeek={(secs) => seekTo(secs, false)}
              />
            )}

            {/* Minimapa Táctico 2D con Mapa de Calor */}
            {match.timeline_markers && match.timeline_markers.length > 0 && (
              <TacticalMap
                markers={match.timeline_markers}
                onSeek={(secs) => seekTo(secs, false)}
              />
            )}

            {/* Diagnóstico de Conciencia de Mapa y Muertes a Ciegas */}
            <MapAwarenessWidget
              cameraSnaps={cameraSnaps}
              markers={match.timeline_markers}
              onSeek={(secs) => seekTo(secs, false)}
            />

            {/* Asistente de Power Spikes y Compras */}
            <PowerSpikeWidget
              itemPurchases={match.item_purchases}
              markers={match.timeline_markers}
              onSeek={(secs) => seekTo(secs, false)}
            />

            {/* Análisis de Ganks e Impacto en Líneas */}
            <GankEfficiencyWidget
              markers={match.timeline_markers}
              gankImpact15={match.gank_impact_15}
              onSeek={(secs) => seekTo(secs, false)}
            />
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
                  <div style={{ ...styles.featuredCard, borderLeft: `4px solid ${meta.color}` }}>
                    <div style={styles.featuredTop}>
                      <span style={{ color: t.color, display: "flex", alignItems: "center", gap: 6, fontWeight: 800, fontSize: 14 }}>
                        {t.icon} {t.text}
                      </span>
                      <button style={styles.featuredTime} onClick={() => jumpToClip(featured.time)}>{formatTime(featured.time)}</button>
                    </div>
                    <div style={styles.featuredName}>
                      <span style={{ color: meta.color, display: "flex" }}>{meta.icon}</span> {meta.label}
                    </div>
                    <p style={styles.featuredDesc}>{describeEvent(featured)}</p>
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
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "10px",
                          padding: "10px 14px",
                          marginBottom: "6px",
                          borderRadius: "8px",
                          cursor: "pointer",
                          background: isActive
                            ? "color-mix(in srgb, var(--accent-blue) 15%, transparent)"
                            : "color-mix(in srgb, var(--panel) 60%, transparent)",
                          border: isActive
                            ? "1px solid color-mix(in srgb, var(--accent-blue) 40%, transparent)"
                            : "1px solid rgba(255, 255, 255, 0.08)",
                          borderLeft: `4px solid ${meta.color}`,
                          boxShadow: isActive
                            ? `0 0 16px ${mix(meta.color, 19)}`
                            : "0 2px 8px rgba(0, 0, 0, 0.25)",
                          transition: "all 0.15s ease",
                        }}
                      >
                        <span style={{
                          color: "var(--text-secondary)",
                          fontFamily: "var(--font-mono)",
                          fontSize: "11px",
                          fontWeight: 700,
                          background: "rgba(255, 255, 255, 0.06)",
                          padding: "2px 6px",
                          borderRadius: "4px",
                        }}>
                          {formatTime(ev.time)}
                        </span>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                          {meta.icon}
                        </div>
                        <span style={{ color: "var(--text)", fontWeight: 700, fontSize: "13px" }}>
                          {meta.label}
                        </span>
                        {describeEvent(ev) && (
                          <span style={{ color: "var(--text-muted)", fontSize: "11px", marginLeft: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "90px" }}>
                            {describeEvent(ev)}
                          </span>
                        )}
                        <span style={{
                          color: t.color,
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: 11,
                          fontWeight: 800,
                          marginLeft: "auto",
                          padding: "2px 8px",
                          borderRadius: "12px",
                          background: mix(t.color, 8),
                          border: `1px solid ${mix(t.color, 19)}`,
                        }}>
                          {t.icon} {t.text}
                        </span>
                      </div>
                    );
                  })}
                  {shown.length === 0 && (
                    <div style={styles.emptyEvents}>
                      {timedEvents.length === 0 ? "No hay eventos registrados en esta partida." : "No events match this filter."}
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
                  <button style={styles.commentTime} onClick={() => seekTo(c.time, false)} title="Jump to this moment">
                    {formatTime(c.time)}
                  </button>
                  <span style={styles.commentText}>{c.text}</span>
                  <button style={styles.commentDelete} onClick={() => deleteComment(i)} title="Eliminar comentario"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
            <div style={styles.commentInputRow}>
              <span style={styles.commentAtTime} title="Will be anchored to this moment">{formatTime(currentTime)}</span>
              <input
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addComment(); }}
                placeholder="Comenta este momento…"
                style={styles.commentInput}
              />
              <button style={styles.commentSend} onClick={addComment} title="Add at current time"><Send size={16} /></button>
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
                {exportType === "clip" ? "Exportar Clip de Video" : "Mark error"}
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
                onKeyDown={(e) => e.stopPropagation()}
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
                color: "var(--text)", 
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
