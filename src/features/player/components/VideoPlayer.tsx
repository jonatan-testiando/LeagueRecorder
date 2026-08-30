import React, { useRef, useState, useEffect, useCallback } from "react";
import { MatchMetadata, MatchEvent, MouseEventData, Comment as MatchComment, Participant, TeamObjectives, ItemPurchase } from "../../../types";
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
import { cancelMatchMinimap, exportErrorClip, getAllErrorClips, getMatchAttribution, getMatchDetails, getMatchPressure, getMinimapStatus, processMatchMinimap, saveMatchComments, syncMatchNow, type MinimapStatus, type PlayerCredit, type PressureWindow } from "../../../core/tauri-ipc";
import { analyzeCameraSnaps, getCameraSnapSummary, SnapSummary } from "../../training/api";
import { clock } from "../../../core/time";
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
import { individualEvents } from "../../../core/matchEvents";
import { champIcon } from "../../../core/ddragon";
import { useT } from "../../../core/LanguageProvider";
import { styles } from "./videoPlayerStyles";
import { mix } from "../../../core/color";
import {
  itemIcon,
  DDRAGON_VER,
  streamUrl,
  mouseSpace,
  smoothLinePath,
  CLIP_BEFORE,
  CLIP_AFTER,
} from "./videoPlayerUtils";

type LoadState = "loading" | "ready" | "error";

// Geometría de los marcadores de la línea de tiempo. Dos filas: con una sola,
// cualquier pelea de equipo obligaba a desplazar media docena de marcas.
//
// Las medidas están atadas al alto real del carril (56 px): las dos filas
// apiladas lo llenan justo, sin invadir la cabecera ni la tira de saltos de
// cámara del pie. Si el carril crece, esto se puede ensanchar.
const MARK_SIZE = 21;        // diámetro del marcador, en px
const MARK_PITCH = 23;       // separación mínima entre centros de una misma fila
// Con dos marcas en la misma vertical (lo normal en una pelea), las filas
// pegadas se leían como una sola mancha. 2 px de aire las separan sin salirse
// del carril: 12+21 = 33, y la de arriba ocupa de 35 a 56.
const MARK_ROWS = [12, 35];

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
  // La duración de la partida, hasta que el vídeo diga la suya (que es la buena).
  //
  // El valor inicial de `useState` solo se usa al montar, así que al pasar de una
  // partida a otra SIN desmontar el reproductor se quedaba la duración de la
  // anterior: los marcadores, las marcas del eje y el reloj se calculaban contra
  // una longitud que no era la de ese vídeo. Se ve enseguida cuando las dos
  // partidas duran distinto.
  const [duration, setDuration] = useState<number>(match.game_duration || 0);
  useEffect(() => {
    setDuration(match.game_duration || 0);
  }, [match.id, match.game_duration]);
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
  const [tab, setTab] = useState<"review" | "match" | "impact" | "events">("review");

  // Reparto de credito por dano real. Se pide al abrir la pestana de la partida
  // y no antes: la primera vez puede costar dos llamadas a la API, luego sale de
  // cache en disco.
  const [credits, setCredits] = useState<PlayerCredit[] | null>(null);
  const [creditsErr, setCreditsErr] = useState<string | null>(null);
  // Tramos de presion absorbida. Se piden junto al credito, en la misma pestana.
  const [pressure, setPressure] = useState<PressureWindow[] | null>(null);
  const [pressureErr, setPressureErr] = useState<string | null>(null);
  // Procesado del minimapa: en que punto esta y como va la pasada actual.
  const [mmStatus, setMmStatus] = useState<MinimapStatus | null>(null);
  const [mmPct, setMmPct] = useState<number | null>(null);
  const [mmErr, setMmErr] = useState<string | null>(null);

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

  // El reparto de credito se pide al abrir la pestana de la partida, una sola
  // vez por partida. Si falla no se reintenta en bucle: se guarda el motivo y se
  // enseña, que es mas util que un panel vacio.
  // OJO con las dependencias: `credits` NO puede estar aqui. Al estarlo, en
  // cuanto la atribucion respondia y hacia setCredits, el efecto se re-ejecutaba
  // y su limpieza ponia vivo=false, descartando la respuesta de presion que
  // seguia en vuelo. Funcionaba mientras las dos iban a la API (la presion
  // ganaba la carrera) y se rompio al cachear, cuando la atribucion paso a
  // responder primero. El "ya pedido" se lleva en un ref, que no dispara
  // re-ejecuciones.
  const pedidoRef = useRef<string | null>(null);
  useEffect(() => {
    if (tab !== "impact" || match.is_vod) return;
    if (pedidoRef.current === match.id) return;
    pedidoRef.current = match.id;
    let vivo = true;
    getMatchAttribution(match.id)
      .then((rows) => { if (vivo) setCredits(rows); })
      .catch((e) => { if (vivo) setCreditsErr(String(e)); });
    // El error se ENSENA, no se traga: tragarselo hacia que un fallo del comando
    // y "esta partida no tuvo tramos" fueran indistinguibles.
    //
    // Aqui se lanzaba ADEMAS el procesado del video (dos minutos de Python) solo
    // por entrar en la pestana. Salia con consola propia -la ventana negra- y
    // cerrarla mataba el trabajo antes de que escribiera nada, asi que a la
    // siguiente visita vuelta a empezar. Ahora se pide desde el panel.
    getMatchPressure(match.id)
      .then((ws) => { if (vivo) setPressure(ws); })
      .catch((e) => { if (vivo) { setPressure([]); setPressureErr(String(e)); } });
    return () => { vivo = false; };
  }, [tab, match.id, match.is_vod]);

  // Estado del procesado del video. Se consulta al abrir Impacto (y al cambiar
  // de partida) y se mantiene al dia con el evento de progreso del backend.
  useEffect(() => {
    if (tab !== "impact" || match.is_vod) return;
    let vivo = true;
    setMmErr(null);
    getMinimapStatus(match.id)
      .then((st) => {
        if (!vivo) return;
        setMmStatus(st);
        // Si quedo trabajo a medias, la barra arranca donde se quedo: lo hecho
        // no se repite, y empezar de cero haria pensar que si.
        setMmPct(st.state === "en_curso" ? st.saved_progress ?? 0 : null);
      })
      .catch(() => { if (vivo) setMmStatus(null); });
    return () => { vivo = false; };
  }, [tab, match.id, match.is_vod]);

  useEffect(() => {
    const un = listen<[string, number]>("minimap_progress", (e) => {
      const [id, pct] = e.payload;
      if (id !== match.id) return;
      if (pct < 0) {
        // -1 es "termino mal". Sin distinguirlo, el unico aviso de un fallo era
        // una barra congelada a la mitad.
        setMmPct(null);
        setMmErr(t("The video analysis failed. Check the log for details."));
        getMinimapStatus(match.id).then(setMmStatus).catch(() => {});
        return;
      }
      setMmPct(pct);
      if (pct >= 100) {
        setMmPct(null);
        getMinimapStatus(match.id).then(setMmStatus).catch(() => {});
        // Los tramos se recalculan: ahora tienen el video detras y sus bordes
        // dejan de ser una cota inferior.
        getMatchPressure(match.id).then(setPressure).catch(() => {});
      }
    });
    return () => { un.then((f) => f()).catch(() => {}); };
  }, [match.id, t]);

  const empezarMinimapa = async () => {
    setMmErr(null);
    setMmPct(mmStatus?.saved_progress ?? 0);
    try {
      await processMatchMinimap(match.id);
      setMmStatus(await getMinimapStatus(match.id));
    } catch (e) {
      setMmPct(null);
      setMmErr(String(e));
    }
  };

  const pararMinimapa = async () => {
    try {
      await cancelMatchMinimap(match.id);
    } finally {
      setMmPct(null);
      setMmStatus(await getMinimapStatus(match.id).catch(() => null));
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

  // La MISMA lista que pinta la línea de tiempo, marcadores de Riot incluidos.
  //
  // Iban por separado, y eso hacía que al pulsar una marca que sólo existía en la
  // timeline de Riot no se seleccionara nada en la pestaña de Eventos: se podía
  // hacer clic en algo que la lista no tenía.
  const timedEvents = React.useMemo(
    () => individualEvents(match.events, match.timeline_markers ?? []),
    [match.events, match.timeline_markers]
  );
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

  // Una marca por suceso: se acabaron los grupos con contador. Un doble asesinato
  // son dos kills, no una marca con un "2" encima, y lo mismo cada asistencia.
  //
  // Para que no se pisen: la segunda de dos marcas juntas sube a la fila de
  // arriba, y solo cuando ni así caben se desplaza lo justo — con una guía que la
  // ata a su instante real, porque el marcador puede mentir de sitio pero no de
  // cuándo.
  // La colocación de marcadores se hace en píxeles: el solapamiento es un hecho
  // de pantalla, no de porcentaje, y depende de lo ancha que esté la ventana.
  const [trackSize, setTrackSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = progressBarRef.current;
    if (!el) return;
    const measure = () => setTrackSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const eventMarks = React.useMemo(() => {
    if (!isFinite(duration) || duration <= 0) return [];
    const evs = timedEvents;
    const w = trackSize.w || 1000;
    const half = MARK_SIZE / 2;
    const sitio = (t: number) => Math.min(w - half, Math.max(half, (t / duration) * w));
    const marcas = evs.map((ev) => ({ ev, exactX: sitio(ev.time) }));

    // Racimos: sucesos cuyos INSTANTES REALES caen tan juntos que sus marcas se
    // pisarían. Se encadena por vecindad de tiempo, nunca por dónde acabó la
    // marca anterior — que era el fallo de la versión anterior: al empujar cada
    // marca a la derecha, la siguiente medía contra la posición ya empujada y
    // heredaba el desplazamiento. En una partida de 57 sucesos eso arrastraba
    // TODAS las marcas (hasta 128 px, casi tres minutos de partida) y subía a la
    // fila de arriba marcas que no tenían a nadie al lado.
    const racimos: { ev: MatchEvent; exactX: number }[][] = [];
    for (const m of marcas) {
      const ult = racimos[racimos.length - 1];
      if (ult && m.exactX - ult[ult.length - 1].exactX < MARK_PITCH) ult.push(m);
      else racimos.push([m]);
    }

    // Cada racimo se dibuja en columnas de dos —las dos filas se tocan sin
    // solaparse, así que caben dos marcas en la misma vertical— y se centra en
    // su propio instante. Centrar en vez de empujar reparte el error a los dos
    // lados y deja el racimo encima del momento en que pasó.
    const ancho = (n: number) => (Math.ceil(n / 2) - 1) * MARK_PITCH;
    const centro = (g: typeof marcas) => (g[0].exactX + g[g.length - 1].exactX) / 2;

    // Dos racimos ya centrados pueden pisarse entre ellos. En vez de fundirlos
    // —que engorda el bloque, y el bloque gordo se come al siguiente hasta
    // formar un bloque de media partida— se separan repartiendo el solape a
    // partes iguales entre los dos. Así el ajuste se queda entre vecinos y cada
    // racimo sigue encima de su momento.
    const anchos = racimos.map((g) => ancho(g.length));
    const inicios = racimos.map((g, i) => centro(g) - anchos[i] / 2);
    const limitar = (x: number, i: number) =>
      Math.max(half, Math.min(w - half - anchos[i], x));
    for (let vuelta = 0; vuelta < 12; vuelta++) {
      let movido = false;
      for (let i = 0; i < racimos.length - 1; i++) {
        const solape = inicios[i] + anchos[i] + MARK_PITCH - inicios[i + 1];
        if (solape > 0.5) {
          inicios[i] = limitar(inicios[i] - solape / 2, i);
          inicios[i + 1] = limitar(inicios[i + 1] + solape / 2, i + 1);
          movido = true;
        }
      }
      if (!movido) break;
    }

    return racimos.flatMap((g, gi) =>
      g.map((m, i) => ({
        ev: m.ev,
        exactX: m.exactX,
        x: limitar(inicios[gi], gi) + (i >> 1) * MARK_PITCH,
        bottom: MARK_ROWS[i & 1],
      }))
    );
  }, [timedEvents, duration, trackSize.w]);

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
            <b>{clock(currentTime)}.{String(Math.floor((currentTime % 1) * 100)).padStart(2, "0")}</b>
            <span className="tp-tc__total"> / {clock(duration)}</span>
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
                title={t("How often you moved the camera off yourself: minimap clicks and ally camera keys, counted from what you actually pressed. 'Blind' is the longest stretch without a single look.")}
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
                  {clock(snapSummary.longest_gap_secs)} blind
                </span>
              </span>
            ) : (
              <button
                onClick={runSnapAnalysis}
                disabled={snapBusy}
                style={{ ...styles.ghostBtn, opacity: snapBusy ? 0.6 : 1 }}
                title={t("Scan the video for camera moves. Only needed for imported VODs: a game recorded here already knows this from your clicks and keys.")}
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

            {/* Guías: solo las dibuja el marcador que ha tenido que apartarse,
                y van de su instante real al pie del propio marcador. */}
            {duration > 0 && trackSize.w > 0 && (
              <svg
                viewBox={`0 0 ${trackSize.w} ${trackSize.h}`}
                style={{ ...styles.graphSvg, pointerEvents: "none", zIndex: 4 }}
              >
                {eventMarks
                  .filter((m) => Math.abs(m.x - m.exactX) > 1.5)
                  .map((m, i) => (
                    <line
                      key={i}
                      x1={m.exactX}
                      y1={trackSize.h - 1}
                      x2={m.x}
                      y2={trackSize.h - m.bottom}
                      stroke={mix(eventMeta(m.ev).color, 40)}
                      strokeWidth={1}
                    />
                  ))}
              </svg>
            )}

            {/* Marcadores de eventos: uno por suceso */}
            {duration > 0 && eventMarks.map((m, i) => {
              const meta = eventMeta(m.ev, 14);
              const isActive = m.ev.time === activeEventTime;
              return (
                <div
                  key={i}
                  onClick={(e) => { e.stopPropagation(); jumpToClip(m.ev.time); }}
                  style={{
                    ...styles.eventNode,
                    left: `${m.x}px`,
                    bottom: `${m.bottom}px`,
                    width: `${MARK_SIZE}px`,
                    height: `${MARK_SIZE}px`,
                    borderColor: isActive ? meta.color : mix(meta.color, 55),
                    background: isActive ? meta.color : "var(--panel)",
                    transform: "translateX(-50%)",
                    boxShadow: "none",
                    zIndex: isActive ? 10 : 5,
                  }}
                  title={[`${clock(m.ev.time)} · ${t(meta.label)}`, describeEvent(m.ev)]
                    .filter(Boolean)
                    .join(" – ")}
                >
                  <span style={{ color: isActive ? "var(--text)" : meta.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {meta.icon}
                  </span>
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
                  {clock(m)}
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
                  <span>{clock(hoverPct * duration)}</span>
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
          <button onClick={() => setTab("impact")} style={{ ...styles.tab, ...(tab === "impact" ? styles.tabActive : {}) }}>{t("Impact")}</button>
          <button onClick={() => setTab("events")} style={{ ...styles.tab, ...(tab === "events" ? styles.tabActive : {}) }}>{t(match.is_vod ? "Analysis" : "Events")}</button>
        </div>

        {/* Revision reune la cola de momentos y tus notas: las dos son cosas
            tuyas ancladas a un minuto del video, y sirven para lo mismo —
            errores puntuales y cosas que mejorar—. Separarlas obligaba a saltar
            de pestana para anotar lo que acababas de ver. */}
        {tab === "review" && (
          <>
            <ReviewQueue
              matchId={match.id}
              moments={moments}
              currentTime={currentTime}
              onSeek={(secs) => jumpToClip(secs)}
              onChange={setMoments}
            />
            <div className="sect__head" style={{ marginTop: "var(--space-4)" }}>
              <span className="u-label">{t("Notes")}</span>
              <i className="sect__rule" />
            </div>
            <div style={styles.commentsWrap}>
              <div style={styles.commentsList}>
                {comments.length === 0 && (
                  <div style={styles.emptyEvents}>Aún no hay comentarios. Escribe uno abajo y se anclará al minuto actual del vídeo.</div>
                )}
                {comments.map((c, i) => (
                  <div key={i} style={styles.commentCard}>
                    <button style={styles.commentTime} onClick={() => seekTo(c.time, false)} title={t("Jump to this moment")}>
                      {clock(c.time)}
                    </button>
                    <span style={styles.commentText}>{c.text}</span>
                    <button style={styles.commentDelete} onClick={() => deleteComment(i)} title="Eliminar comentario"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
              <div style={styles.commentInputRow}>
                <span style={styles.commentAtTime} title={t("Will be anchored to this moment")}>{clock(currentTime)}</span>
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
          </>
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
              <span className="u-meta">{match.champion} · {clock(duration)}</span>
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
                      title={`${clock(ip.time)} · ${t("Jump to this moment")}`}
                    >
                      <img
                        src={itemIcon(ddragonVer, ip.item_id)}
                        alt=""
                        style={styles.buyIcon}
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
                      />
                      <span className="u-meta">{clock(ip.time)}</span>
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

        {/* Impacto responde "que significo", frente a Partida que responde
            "que paso". Estaban mezcladas en la misma columna y lo mas
            diferencial quedaba al final de un scroll largo. */}
        {tab === "impact" && (
          <div className="insp">
            {/* --------------------------------------- tu impacto
                El puesto y el percentil ya existian, pero solo en la columna de
                la biblioteca: quien abria esta pestana veia la tabla de los diez
                y tenia que buscarse. Y un puesto suelto no se puede revisar, asi
                que va con el desglose de DONDE salio. */}
            {!match.is_vod && credits !== null && (() => {
              const yo = participants.findIndex((p) => p.is_self) + 1;
              const mio = credits.find((c) => c.participant_id === yo);
              if (!mio) return null;
              const puesto =
                [...credits]
                  .sort((a, b) => b.role_percentile - a.role_percentile)
                  .findIndex((c) => c.participant_id === yo) + 1;
              const partes: [string, number][] = [
                [t("kills"), mio.wpa_kills],
                [t("objectives"), mio.wpa_objectives],
                [t("structures"), mio.wpa_structures],
                [t("deaths"), mio.wpa_deaths],
              ];
              // Todas las barras contra la misma escala: la parte mas grande de
              // esta partida llena medio carril. Escalar cada una por su cuenta
              // haria que una aportacion minuscula pareciera enorme.
              const escala = Math.max(...partes.map(([, v]) => Math.abs(v)), 0.01);
              return (
                <section>
                  <div className="sect__head">
                    <span className="u-label">{t("Your impact")}</span>
                    <i className="sect__rule" />
                  </div>
                  <div className="imp__head">
                    <span
                      className="imp__rank"
                      style={{ color: puesto === 1 ? "var(--win)" : puesto >= 8 ? "var(--loss)" : undefined }}
                    >
                      {puesto === 1 ? t("MVP") : `${puesto}º`}
                    </span>
                    <span className="u-meta">{t("of")} {credits.length}</span>
                    <span
                      className="u-metric imp__pct"
                      style={{ color: mio.role_percentile >= 50 ? "var(--win)" : "var(--loss)" }}
                      title={`${t("win %")}: ${mio.wpa >= 0 ? "+" : ""}${(mio.wpa * 100).toFixed(1)} · ${mio.role}`}
                    >
                      {Math.round(mio.role_percentile)}
                    </span>
                    <span className="u-meta">{t("vs role")}</span>
                  </div>
                  <p className="note">
                    {t("Win probability you added, and where it came from. The four parts add up to your total.")}
                  </p>
                  {partes.map(([nombre, v]) => {
                    const ancho = (Math.abs(v) / escala) * 50;
                    const color = v >= 0 ? "var(--win)" : "var(--loss)";
                    return (
                      <div key={nombre} className="imp__row">
                        <span className="imp__rowName">{nombre}</span>
                        <span className="imp__track">
                          <span
                            className="imp__bar"
                            style={{
                              background: color,
                              width: `${ancho}%`,
                              left: v >= 0 ? "50%" : `${50 - ancho}%`,
                            }}
                          />
                        </span>
                        <span className="u-metric imp__rowNum" style={{ color }}>
                          {v >= 0 ? "+" : ""}{(v * 100).toFixed(1)}
                        </span>
                      </div>
                    );
                  })}
                  <div className="imp__total">
                    <span className="u-label">{t("total")}</span>
                    <span
                      className="u-metric"
                      style={{ color: mio.wpa >= 0 ? "var(--win)" : "var(--loss)" }}
                    >
                      {mio.wpa >= 0 ? "+" : ""}{(mio.wpa * 100).toFixed(1)}
                    </span>
                  </div>
                </section>
              );
            })()}

            {/* --------------------------------------- credito real
                El marcador reparte el oro de un asesinato entero al que remata.
                Aqui se reparte por el dano que puso cada uno, que es quien hizo
                el trabajo. El desfase entre ambos es la columna que importa. */}
            {!match.is_vod && (credits !== null || creditsErr !== null) && (
              <section>
                <div className="sect__head">
                  <span className="u-label">{t("Real credit")}</span>
                  <i className="sect__rule" />
                </div>
                {creditsErr !== null ? (
                  <p className="note">{creditsErr}</p>
                ) : (
                  <>
                    <p className="note">
                      {t("Kill gold as the scoreboard hands it out (last hit) versus how it splits by damage actually dealt.")}
                    </p>
                    <div className="insp__legend u-label">
                      <span>{t("player")}</span><span>{t("gap")}</span><span>{t("win %")}</span><span>{t("vs role")}</span>
                    </div>
                    {/* Separado por bandos: la lista de los 10 mezclados ordena
                        bien pero no se puede leer como rendimiento si no sabes
                        quien jugaba contigo. Dentro de cada bando, por desfase. */}
                    {(() => {
                      const selfTeam = participants.find((p) => p.is_self)?.team_id;
                      const grupos: Array<[string, PlayerCredit[]]> =
                        selfTeam === undefined
                          ? [["", [...credits!]]]
                          : [
                              [t("Your team"), credits!.filter((c) => c.team_id === selfTeam)],
                              [t("Enemy team"), credits!.filter((c) => c.team_id !== selfTeam)],
                            ];
                      return grupos.map(([titulo, filas]) =>
                        filas.length === 0 ? null : (
                          <div key={titulo} className="insp__team">
                            {titulo !== "" && (
                              <div className="insp__teamHead"><span>{titulo}</span></div>
                            )}
                            {[...filas]
                              .sort((a, b) => b.role_percentile - a.role_percentile)
                              .map((c) => {
                                // Por indice, no por nombre de campeon: en Blind
                                // Pick los dos equipos pueden llevar el mismo y
                                // saldrian dos "Tu". `participant_id` es 1..10 en
                                // el mismo orden que Riot.
                                const self = participants[c.participant_id - 1]?.is_self ?? false;
                                const tone = c.credit_gap >= 0 ? "var(--win)" : "var(--loss)";
                                return (
                                  <div key={c.participant_id} className={`insp__player${self ? " insp__player--self" : ""}`}>
                                    <img
                                      src={champIcon(c.champion)}
                                      alt={c.champion}
                                      style={styles.champIcon}
                                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
                                    />
                                    <span className="insp__playerName">
                                      {self ? `${t("You")} · ${c.champion}` : c.champion}
                                    </span>
                                    <span className="u-metric insp__playerNum" style={{ color: tone }}
                                      title={`${t("scoreboard")}: ${Math.round(c.killing_blow_gold)} · ${t("real")}: ${Math.round(c.damage_credit_gold)}`}>
                                      {c.credit_gap >= 0 ? "+" : ""}{Math.round(c.credit_gap)}
                                    </span>
                                    <span className="u-metric insp__playerNum"
                                      style={{ color: c.wpa >= 0 ? "var(--win)" : "var(--loss)" }}
                                      title={`${t("gold")}: ${Math.round(c.total_value)} (${t("objectives")}: ${Math.round(c.objective_gold)})`}>
                                      {c.wpa >= 0 ? "+" : ""}{(c.wpa * 100).toFixed(1)}
                                    </span>
                                    <span className="u-metric insp__playerNum"
                                      style={{ color: c.role_percentile >= 50 ? "var(--win)" : "var(--loss)" }}
                                      title={`${t("win %")}: ${c.wpa >= 0 ? "+" : ""}${(c.wpa * 100).toFixed(1)} · ${c.role}`}>
                                      {Math.round(c.role_percentile)}
                                    </span>
                                  </div>
                                );
                              })}
                          </div>
                        ),
                      );
                    })()}
                    {/* El coste real de morir: no es "-1 muerte", es el rato que
                        estuviste fuera de la partida, que crece con el reloj. */}
                    {(() => {
                      const peor = credits!
                        .flatMap((c) => c.deaths_detail.map((d) => ({ c, d })))
                        .sort((a, b) => b.d.seconds_dead - a.d.seconds_dead)[0];
                      if (!peor) return null;
                      return (
                        <p className="note">
                          {t("Most expensive death")}: {peor.c.champion} · {t("minute")} {Math.round(peor.d.minute)} · {Math.round(peor.d.seconds_dead)}s
                        </p>
                      );
                    })()}
                  </>
                )}
              </section>
            )}

            {/* --------------------------------------- procesado del vídeo
                Lo que convierte los tramos de abajo de "al menos tanto" en una
                duración medida. Antes se lanzaba solo al entrar aquí, sin
                decirlo y sin poder pararlo; ahora se pide, se ve y se corta. */}
            {!match.is_vod && mmStatus !== null && (
              <section>
                <div className="sect__head">
                  <span className="u-label">{t("Video analysis")}</span>
                  <i className="sect__rule" />
                </div>
                {mmStatus.state === "hecha" ? (
                  <p className="note">
                    {t("Positions read from the video: the stretches below are measured, not estimated.")}
                  </p>
                ) : mmStatus.state === "no_disponible" ? (
                  <p className="note">
                    {t("Not available for this game: it needs the video, the detector and the Riot data.")}
                  </p>
                ) : mmPct !== null ? (
                  <>
                    <div className="mm__bar">
                      <div className="mm__fill" style={{ width: `${Math.max(2, mmPct)}%` }} />
                    </div>
                    <div className="mm__row">
                      <span className="u-metric">{Math.round(mmPct)}%</span>
                      <span className="u-meta">{t("reading the minimap, about two minutes")}</span>
                      <button className="btn btn--ghost btn--sm" style={{ marginLeft: "auto" }} onClick={pararMinimapa}>
                        {t("Stop")}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="note">
                      {t("Without it each stretch is a lower bound: the API only gives one position per minute. Takes about two minutes and can be stopped; what it has done is kept.")}
                    </p>
                    <button className="btn btn--primary btn--sm" onClick={empezarMinimapa}>
                      {mmStatus.saved_progress
                        ? `${t("Resume analysis")} (${Math.round(mmStatus.saved_progress)}%)`
                        : t("Analyze the video")}
                    </button>
                  </>
                )}
                {mmErr !== null && <p className="note">{mmErr}</p>}
              </section>
            )}

            {/* --------------------------------------- presión absorbida
                Los tramos en los que tuviste más rivales encima que aliados, y
                lo que tu equipo sacó al otro lado del mapa mientras tanto. En un
                marcador esto no existe: si acabas muerto, es "+1 muerte".

                Sólo se muestran los tuyos. Se detectan para los 10, pero los de
                los demás no ayudan a revisar tu partida. */}
            {!match.is_vod && (pressure !== null || pressureErr !== null) && (() => {
              const yo = participants.findIndex((p) => p.is_self) + 1;
              // Se ordena por lo que tu equipo sacó mientras te sujetaban, que
              // está en probabilidad de victoria. Antes era `rivales × rato`,
              // una aproximación que ponía arriba el tramo más aparatoso en vez
              // del que decidió algo. El modelo de probabilidad ya existe: esto
              // era justo el hueco que quedaba por cerrar.
              //
              // El desempate sigue siendo el tamaño del tramo, para los que no
              // dieron ningún fruto medible (que también son información).
              const mios = (pressure ?? [])
                .filter((w) => w.participant_id === yo)
                .sort(
                  (a, b) =>
                    b.wpa_elsewhere - a.wpa_elsewhere ||
                    b.max_enemies * (b.end - b.start) - a.max_enemies * (a.end - a.start),
                )
                .slice(0, 6);
              return (
                <section>
                  <div className="sect__head">
                    <span className="u-label">{t("Pressure you absorbed")}</span>
                    <i className="sect__rule" />
                  </div>
                  <p className="note">
                    {t("Stretches where more enemies were on you than allies. What your team took elsewhere is what your presence bought.")}
                  </p>
                  {/* Tres estados distinguibles: fallo, vacio de verdad, y datos. */}
                  {pressureErr !== null && <p className="note">{pressureErr}</p>}
                  {pressureErr === null && mios.length === 0 && (
                    <p className="note">{t("No stretches detected in this game.")}</p>
                  )}
                  {mios.map((w, i) => {
                    const botin = [
                      w.towers_elsewhere && `${w.towers_elsewhere} ${t(w.towers_elsewhere === 1 ? "tower" : "towers")}`,
                      w.inhibs_elsewhere && `${w.inhibs_elsewhere} ${t(w.inhibs_elsewhere === 1 ? "inhibitor" : "inhibitors")}`,
                      w.plates_elsewhere && `${w.plates_elsewhere} ${t(w.plates_elsewhere === 1 ? "plate" : "plates")}`,
                      w.epics_elsewhere && `${w.epics_elsewhere} ${t(w.epics_elsewhere === 1 ? "epic" : "epics")}`,
                      w.gold_elsewhere > 0 && `${Math.round(w.gold_elsewhere)} ${t("gold")}`,
                    ].filter(Boolean).join(" · ");
                    return (
                      <button
                        key={i}
                        className="insp__press"
                        onClick={() => seekTo(Math.max(0, w.start - 5), true)}
                        title={t("Jump to this moment")}
                      >
                        <span className="u-metric">{clock(w.start)}</span>
                        <span className="insp__pressWhat">
                          {w.max_enemies.toFixed(1)} {t("enemies on you")} ·{" "}
                          {/* El "~" marca que la duracion es una cota inferior:
                              sin video, entre minutos la API no dice nada. */}
                          <span title={w.from_video ? t("Confirmed frame by frame in the video") : t("Lower bound: the API only gives one position per minute")}>
                            {w.from_video ? "" : "~"}{Math.round(w.end - w.start)}s
                          </span>
                          {w.died && ` · ${t("you die")}`}
                        </span>
                        <span className="insp__pressGain">
                          {w.wpa_elsewhere > 0 && (
                            <b style={{ color: "var(--win)" }}>+{(w.wpa_elsewhere * 100).toFixed(1)}% </b>
                          )}
                          {botin}
                        </span>
                      </button>
                    );
                  })}
                </section>
              );
            })()}
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
                        {clock(featured.time)}
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
                        // Traerla a la vista si la selección vino de fuera (una
                        // marca de la línea de tiempo, o las flechas): marcar una
                        // fila que se ha quedado fuera de la lista es no marcar
                        // nada. `nearest` no mueve la lista si ya se está viendo.
                        ref={(el) => {
                          if (isActive && el) el.scrollIntoView({ block: "nearest" });
                        }}
                        onClick={() => jumpToClip(ev.time)}
                      >
                        <span className="evrow__sev" style={{ background: meta.color }} />
                        <span className="u-metric evrow__time">{clock(ev.time)}</span>
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
                {clock(clipStart)} - {clock(clipEnd)} ({Math.round(Math.max(0.1, clipEnd - clipStart))}s)
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
