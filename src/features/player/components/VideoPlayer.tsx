import React, { useRef, useState, useEffect, useCallback } from "react";
import { MatchMetadata, MatchEvent, MouseEventData, Comment as MatchComment, Participant, TeamObjectives, ItemPurchase, TimelineMarker } from "../../../types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { outcome } from "../../../core/matchStats";
import {
  Eye, Maximize, Play, Pause,
  VolumeX, Volume1, Volume2, Scissors, AlertTriangle,
  XCircle, ChevronLeft, ChevronRight,
  Trash2, Send, RefreshCw, Check, MinusCircle,
  SkipBack, SkipForward, MoreHorizontal
} from "lucide-react";
import { exportErrorClip, getAllErrorClips, getMatchDetails, saveMatchComments, syncMatchNow } from "../../../core/tauri-ipc";
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
import { useT } from "../../../core/LanguageProvider";
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

/**
 * Fila del inspector: etiqueta a la izquierda, cifra a la derecha, en mono
 * tabular. Todas las cifras de la columna caen en la misma vertical, que es lo
 * que permite recorrerlas de un vistazo en vez de buscarlas dentro de azulejos.
 */
const InspRow: React.FC<{
  label: string;
  value: React.ReactNode;
  /** Color solo cuando el signo significa algo (una diferencia). */
  tone?: string;
  /** Matiz corto a la derecha del valor. */
  note?: string;
}> = ({ label, value, tone, note }) => (
  <div className="drow">
    <span>{label}</span>
    <b className="u-metric" style={tone ? { color: tone } : undefined}>
      {value}
      {note && <em className="drow__note">{note}</em>}
    </b>
  </div>
);

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
const diffTone = (n: number): string => (n >= 0 ? "var(--win)" : "var(--loss)");

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
  const t = useT();
  // Cuatro pestanas, no cinco. "Estadisticas" y "Analitica" eran dos nombres
  // para lo mismo (cifras de esta partida) y entre las dos no cabian en la
  // columna: la quinta salia cortada.
  const [tab, setTab] = useState<"review" | "match" | "events" | "comments">("review");

  // Los momentos que merecen una mirada. Los errores que marcaste tu viven en
  // clips aparte, asi que hay que traerlos y fusionarlos: eran la mitad de la
  // cola que faltaba.
  const [moments, setMoments] = useState<Moment[]>(() => buildQueue(match));
  useEffect(() => {
    let alive = true;
    setMoments(buildQueue(match));
    getAllErrorClips()
      .then((clips) => {
        if (!alive) return;
        setMoments(buildQueue(match, clips.filter((c) => c.match_id === match.id)));
      })
      .catch(console.error);
    return () => { alive = false; };
  }, [match.id]);
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
            title={t("Previous moment")}
            aria-label={t("Previous moment")}
          >
            <SkipBack size={14} fill="currentColor" />
          </button>
          <button
            className="tp-b tp-b--primary"
            onClick={handlePlayPause}
            title={t(isPlaying ? "Pause" : "Play")}
            aria-label={t(isPlaying ? "Pause" : "Play")}
          >
            {isPlaying ? <Pause fill="currentColor" size={15} /> : <Play fill="currentColor" size={15} />}
          </button>
          <button
            className="tp-b"
            onClick={() => goToAdjacentEvent(1)}
            title={t("Next moment")}
            aria-label={t("Next moment")}
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
          <span className="tp-seg" role="group" aria-label={t("Playback speed")}>
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
            <button className="tp-b" onClick={toggleMute} title={t(muted ? "Unmute" : "Mute")} aria-label={t(muted ? "Unmute" : "Mute")}>
              {muted || volume === 0 ? <VolumeX size={15} /> : volume < 0.5 ? <Volume1 size={15} /> : <Volume2 size={15} />}
            </button>
            <input
              type="range" min="0" max="1" step="0.05"
              value={muted ? 0 : volume}
              onChange={handleVolumeChange}
              aria-label={t("Volume")}
              style={styles.volumeSlider}
            />
          </div>

          <details className="tp-more">
            <summary title={t("Playback settings")} aria-label={t("Playback settings")}>
              <MoreHorizontal size={15} />
            </summary>
            <div className="tp-pop">
              <label className="tp-pop__row">
                <span>{t("Broadcast overlay")}</span>
                <input type="checkbox" checked={showEsportsHud} onChange={() => setShowEsportsHud((h) => !h)} />
              </label>
              <label className="tp-pop__row">
                <span>{t("Mouse trail")}</span>
                <input type="checkbox" checked={showTracker} onChange={() => setShowTracker((v) => !v)} />
              </label>
              <div className="tp-pop__row tp-pop__row--stack">
                <span>
                  Mouse trail sync
                  <em>{t("Shifts the trail against the video, in seconds.")}</em>
                </span>
                <div className="tp-pop__sync">
                  <input
                    type="range" min="-3" max="3" step="0.1" value={mouseSync}
                    aria-label={t("Mouse trail sync")}
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

          <button className="tp-b" onClick={toggleFullscreen} title={t("Fullscreen")} aria-label={t("Fullscreen")}>
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
                {snapBusy ? `Scanning ${snapPct.toFixed(0)}%` : t("Camera moves")}
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
                <Scissors size={14} /> {t("Clip")}
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
                <AlertTriangle size={14} /> {t("Error")}
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
                background: "var(--surface-1)",
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
        <div style={styles.resizeHandle} onPointerDown={startResize} title={t("Drag to resize")} />
        <div style={styles.tabBar}>
          <button onClick={() => setTab("review")} style={{ ...styles.tab, ...(tab === "review" ? styles.tabActive : {}) }}>{t("Review")}</button>
          <button onClick={() => setTab("match")} style={{ ...styles.tab, ...(tab === "match" ? styles.tabActive : {}) }}>{t("Match")}</button>
          <button onClick={() => setTab("events")} style={{ ...styles.tab, ...(tab === "events" ? styles.tabActive : {}) }}>{t(match.is_vod ? "Analysis" : "Events")}</button>
          <button onClick={() => setTab("comments")} style={{ ...styles.tab, ...(tab === "comments" ? styles.tabActive : {}) }}>{t("Notes")}</button>
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

        {tab === "match" && (
          <div className="insp">
            {/* El resultado es una linea, no una tarjeta: ya lo sabes al entrar,
                solo hace falta que te lo confirme. */}
            <div className="insp__lead">
              <span
                className="insp__verdict"
                style={{ color: match.is_vod ? "var(--cool)" : isWin ? "var(--win)" : "var(--loss)" }}
              >
                {match.is_vod ? t("Imported VOD") : t(isWin ? "Victory" : "Defeat")}
              </span>
              <span className="u-meta">{match.champion} · {formatTime(duration)}</span>
            </div>

            {/* ------------------------------------------------ tu partida */}
            <section>
              <div className="sect__head">
                <span className="u-label">{t("Your game")}</span>
                <i className="sect__rule" />
              </div>
              {match.kda && <InspRow label="KDA" value={match.kda} />}
              {!!match.apm && <InspRow label="APM" value={Math.round(match.apm)} />}
              {!!match.gold_earned && (
                <InspRow label={t("Gold")} value={`${(match.gold_earned / 1000).toFixed(1)}k`} />
              )}
              {selfP && (
                <>
                  <InspRow
                    label={t("Kill participation")}
                    value={teamKills > 0 ? `${Math.round(((selfP.kills + selfP.assists) / teamKills) * 100)}%` : "—"}
                  />
                  <InspRow label="CS / min" value={durMin > 0 ? (selfP.cs / durMin).toFixed(1) : "—"} />
                  <InspRow
                    label={t("Damage to champions")}
                    value={`${((selfP.damage ?? 0) / 1000).toFixed(1)}k`}
                    note={teamDamage > 0 ? `${Math.round((100 * (selfP.damage ?? 0)) / teamDamage)}% ${t("of team")}` : undefined}
                  />
                  <InspRow label={t("Vision score")} value={selfP.vision_score ?? 0} />
                </>
              )}
              {selfP && (selfP.items ?? []).some((it) => it > 0) && (
                <div className="insp__items">
                  {Array.from({ length: 7 }).map((_, k) => {
                    const it = (selfP.items ?? [])[k] ?? 0;
                    return it > 0 ? (
                      <img
                        key={k}
                        src={itemIcon(ddragonVer, it)}
                        alt=""
                        style={styles.perfItem}
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
                      />
                    ) : (
                      <span key={k} style={styles.perfItemEmpty} />
                    );
                  })}
                </div>
              )}
            </section>

            {/* -------------------------------------------- fase temprana */}
            {(match.gold_diff_15 != null || match.xp_diff_15 != null ||
              match.jungle_cs_diff_15 != null || match.gank_impact_15 != null) && (
              <section>
                <div className="sect__head">
                  <span className="u-label">{t("Early game")} · {t("minute 15")}</span>
                  <i className="sect__rule" />
                </div>
                {match.gold_diff_15 != null && (
                  <InspRow
                    label={t("Gold difference")}
                    value={signed(match.gold_diff_15)}
                    tone={diffTone(match.gold_diff_15)}
                  />
                )}
                {match.xp_diff_15 != null && (
                  <InspRow label={t("XP difference")} value={signed(match.xp_diff_15)} tone={diffTone(match.xp_diff_15)} />
                )}
                {match.jungle_cs_diff_15 != null && (
                  <InspRow
                    label={t("Jungle CS difference")}
                    value={signed(match.jungle_cs_diff_15)}
                    tone={diffTone(match.jungle_cs_diff_15)}
                  />
                )}
                {match.gank_impact_15 != null && (
                  <InspRow label={t("Gank pressure")} value={`${match.gank_impact_15}%`} />
                )}
                {/* El resultado de linea era una pildora de color; es una frase. */}
                {match.lane_result && (
                  <p className="note">
                    {t(
                      match.lane_result === "Win" ? "You came out of lane ahead."
                        : match.lane_result === "Loss" ? "You came out of lane behind."
                        : "You came out of lane even."
                    )}
                  </p>
                )}
              </section>
            )}

            {/* ------------------------------------------------- la curva */}
            {match.minute_frames && match.minute_frames.length > 1 && (
              <section>
                <div className="sect__head">
                  <span className="u-label">{t("Lead over time")}</span>
                  <i className="sect__rule" />
                </div>
                <GoldXpChart
                  frames={match.minute_frames}
                  videoOffset={match.video_offset ?? 0}
                  onSeek={(secs) => seekTo(secs, false)}
                />
              </section>
            )}

            {/* --------------------------------------------- el marcador */}
            {participants.length > 0 ? (
              <section>
                <div className="sect__head">
                  <span className="u-label">{t("Scoreboard")}</span>
                  <i className="sect__rule" />
                </div>
                {/* La leyenda va arriba: es la cabecera de las columnas, no un
                    pie de tabla. */}
                <div className="insp__legend u-label">
                  <span>{t("player")}</span><span>K/D/A</span><span>CS</span><span>{t("gold")}</span>
                </div>
                {[100, 200].map((teamId) => {
                  const team = participants.filter((p) => p.team_id === teamId);
                  if (team.length === 0) return null;
                  const won = team[0].win;
                  const tone = won ? "var(--win)" : "var(--loss)";
                  return (
                    <div key={teamId} className="insp__team">
                      <div className="insp__teamHead">
                        <span style={{ color: tone }}>{t(teamId === 100 ? "Blue Team" : "Red Team")}</span>
                        <span className="u-meta" style={{ color: tone }}>{t(won ? "Victory" : "Defeat")}</span>
                      </div>
                      {team.map((p, i) => (
                        <div key={i} className={`insp__player${p.is_self ? " insp__player--self" : ""}`}>
                          <img
                            src={champIcon(p.champion)}
                            alt={p.champion}
                            style={styles.champIcon}
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
                          />
                          <span className="insp__playerName">{p.is_self ? t("You") : (p.name || p.champion)}</span>
                          <span className="u-metric insp__playerKda">{p.kills}/{p.deaths}/{p.assists}</span>
                          <span className="u-metric insp__playerNum">{p.cs}</span>
                          <span className="u-metric insp__playerNum">{(p.gold / 1000).toFixed(1)}k</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </section>
            ) : (
              !match.is_vod && (
                <section>
                  <p className="note">{t("The 10-player scoreboard is not loaded yet.")}</p>
                  <button className="btn btn--primary btn--sm" onClick={handleSync} disabled={syncing}>
                    <RefreshCw size={13} style={syncing ? { animation: "spin 1s linear infinite" } : undefined} />
                    {syncing ? t("Syncing…") : t("Sync with Riot")}
                  </button>
                  <p className="note">{t("Needs your Riot API key set in Settings.")}</p>
                </section>
              )
            )}

            {/* ------------------------------------------------ objetivos */}
            {objectives.length > 0 && (
              <section>
                <div className="sect__head">
                  <span className="u-label">{t("Objectives")}</span>
                  <i className="sect__rule" />
                </div>
                {/* "Equipo Azul" no cabe en una columna de 40px: se parte en
                    dos lineas encima de las cifras. Aqui basta el color. */}
                <div className="drow drow--3 insp__objLegend u-label">
                  <span />
                  <span>{t("Blue")}</span>
                  <span>{t("Red")}</span>
                </div>
                {([
                  ["Dragons", "dragons"],
                  ["Barons", "barons"],
                  ["Heralds", "heralds"],
                  ["Towers", "towers"],
                  ["Inhibitors", "inhibitors"],
                ] as const).map(([label, key]) => {
                  const blue = objectives.find((o) => o.team_id === 100);
                  const red = objectives.find((o) => o.team_id === 200);
                  return (
                    <div key={key} className="drow drow--3">
                      <span>{t(label)}</span>
                      <b style={{ color: (blue?.[key] ?? 0) >= (red?.[key] ?? 0) ? "var(--text)" : "var(--faint)" }}>
                        {blue?.[key] ?? 0}
                      </b>
                      <b style={{ color: (red?.[key] ?? 0) > (blue?.[key] ?? 0) ? "var(--text)" : "var(--faint)" }}>
                        {red?.[key] ?? 0}
                      </b>
                    </div>
                  );
                })}
              </section>
            )}

            {/* -------------------------------------------------- compras */}
            {itemPurchases.length > 0 && (
              <section>
                <div className="sect__head">
                  <span className="u-label">{t("Item purchases")}</span>
                  <i className="sect__rule" />
                </div>
                <div className="insp__buys">
                  {itemPurchases.map((ip, i) => (
                    <button
                      key={i}
                      className="insp__buy"
                      onClick={() => seekTo(ip.time, false)}
                      title={`${formatTime(ip.time)} · ${t("Jump to this moment")}`}
                    >
                      <img
                        src={itemIcon(ddragonVer, ip.item_id)}
                        alt=""
                        style={styles.buyIcon}
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
                      />
                      <span className="u-meta">{formatTime(ip.time)}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* Los siete widgets de analitica vivian aqui abiertos, uno debajo
                de otro, cada uno con su tarjeta, su borde de color y su
                insignia. Siguen estando, pero cerrados: son una segunda
                lectura, no lo primero que tienes que ver al abrir un video. */}
            <details className="insp__more">
              <summary>{t("More analysis")}</summary>
              <div className="insp__moreBody">
                <PerformanceTrendsWidget currentMatch={match} />
                {match.timeline_markers && match.timeline_markers.length > 0 && (
                  <TacticalMap markers={match.timeline_markers} onSeek={(secs) => seekTo(secs, false)} />
                )}
                <MapAwarenessWidget
                  cameraSnaps={cameraSnaps}
                  markers={match.timeline_markers}
                  onSeek={(secs) => seekTo(secs, false)}
                />
                <PowerSpikeWidget
                  itemPurchases={match.item_purchases}
                  markers={match.timeline_markers}
                  onSeek={(secs) => seekTo(secs, false)}
                />
                <GankEfficiencyWidget
                  markers={match.timeline_markers}
                  gankImpact15={match.gank_impact_15}
                  onSeek={(secs) => seekTo(secs, false)}
                />
              </div>
            </details>

            {!match.is_vod && participants.length > 0 && (
              <button className="btn btn--ghost btn--sm insp__resync" onClick={handleSync} disabled={syncing}>
                <RefreshCw size={13} style={syncing ? { animation: "spin 1s linear infinite" } : undefined} />
                {syncing ? t("Updating…") : t("Refresh Riot data")}
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
                const tl = toneLabelAndIcon(meta.tone);
                return (
                  <div className="evfeat">
                    <div className="evfeat__top">
                      <span className="u-label" style={{ color: tl.color }}>{t(tl.text)}</span>
                      <button className="u-metric evfeat__time" onClick={() => jumpToClip(featured.time)}>
                        {formatTime(featured.time)}
                      </button>
                    </div>
                    <div className="evfeat__name">
                      <span style={{ color: meta.color, display: "flex" }}>{meta.icon}</span> {meta.label}
                    </div>
                    <p className="evfeat__desc">{describeEvent(featured)}</p>
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
                    const tl = toneLabelAndIcon(meta.tone);
                    const isActive = activeEventTime === ev.time;
                    return (
                      <div
                        key={i}
                        className="evrow"
                        data-on={isActive || undefined}
                        onClick={() => jumpToClip(ev.time)}
                      >
                        <span className="evrow__sev" style={{ background: meta.color }} />
                        <span className="u-metric evrow__time">{formatTime(ev.time)}</span>
                        <span className="evrow__icon" style={{ color: meta.color }}>{meta.icon}</span>
                        <span className="evrow__label">{meta.label}</span>
                        {describeEvent(ev) && (
                          <span className="evrow__desc">{describeEvent(ev)}</span>
                        )}
                        <span className="evrow__tone" style={{ color: tl.color }}>{t(tl.text)}</span>
                      </div>
                    );
                  })}
                  {shown.length === 0 && (
                    <div style={styles.emptyEvents}>
                      {timedEvents.length === 0 ? "No hay eventos registrados en esta partida." : t("No events match this filter.")}
                    </div>
                  )}
                </div>
              </div>

              <div style={styles.reviewFooter}>
                <button onClick={() => goToAdjacentEvent(-1)} style={styles.ghostBtn} title={`${t("Previous moment")} (P)`}><ChevronLeft size={16} /> {t("Previous")}</button>
                <span style={styles.pageInfo}>{activeIndex || "-"} {t("of")} {timedEvents.length}</span>
                <button onClick={() => goToAdjacentEvent(1)} style={styles.ghostBtn} title={`${t("Next moment")} (N)`}>{t("Next")} <ChevronRight size={16} /></button>
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
                  <button style={styles.commentTime} onClick={() => seekTo(c.time, false)} title={t("Jump to this moment")}>
                    {formatTime(c.time)}
                  </button>
                  <span style={styles.commentText}>{c.text}</span>
                  <button style={styles.commentDelete} onClick={() => deleteComment(i)} title="Eliminar comentario"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
            <div style={styles.commentInputRow}>
              <span style={styles.commentAtTime} title={t("Will be anchored to this moment")}>{formatTime(currentTime)}</span>
              <input
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addComment(); }}
                placeholder="Comenta este momento…"
                style={styles.commentInput}
              />
              <button style={styles.commentSend} onClick={addComment} title={t("Add at current time")}><Send size={16} /></button>
            </div>
          </div>
        )}
      </div>
      )}

      {/* Clipping Actions Bar */}
      {isClippingMode && (
        <div style={{
          position: "absolute", bottom: "80px", left: "50%", transform: "translateX(-50%)",
          background: "var(--surface-1)", padding: "12px 24px", borderRadius: "8px", border: "1px solid var(--border-subtle)",
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
                  background: "var(--surface-1)",
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
                backgroundColor: exportType === "clip" ? "var(--action)" : "var(--color-defeat)", 
                color: exportType === "clip" ? "var(--on-action)" : "var(--text)", 
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
