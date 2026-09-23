import React, { useRef, useState, useEffect, useCallback } from "react";
import { MatchMetadata, MatchEvent, MouseEventData, Comment as MatchComment, Participant, TeamObjectives, ItemPurchase } from "../../../types";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { outcome, queueKey, lpDeltas } from "../../../core/matchStats";
import {
  ArrowLeft, Eye, EyeOff, Maximize, Play, Pause,
  VolumeX, Volume1, Volume2, Scissors, AlertTriangle, Flag, Check, RotateCcw,
  Trash2, RefreshCw, FileText,
  SkipBack, SkipForward, MoreHorizontal, VideoOff, FolderOpen, Pencil, X,
  BarChart3
} from "lucide-react";
import { cancelMatchMinimap, getAllErrorClips, getCameraLooks, getCameraZones, getMatchAttribution, getMatchDetails, getMatchPressure, getMinimapStatus, processMatchMinimap, saveMatchComments, setErrorClipReviewed, setEventReviewed, syncMatchNow, type CameraLook, type ErrorClipMetadata, type MinimapStatus, type PlayerCredit, type PressureWindow, type ZoneStat } from "../../../core/tauri-ipc";
import { analyzeCameraSnaps, getCameraSnapSummary, SnapSummary } from "../../training/api";
import { clock, relativeDay } from "../../../core/time";
import { GoldXpChart } from "./GoldXpChart";
import { PressureEpisodeCard } from "./PressureEpisodeCard";
import { formatGold, formatSeconds } from "./pressureFormat";
import { TacticalMap } from "./TacticalMap";
import { MapAwarenessWidget } from "./MapAwarenessWidget";
import { PowerSpikeWidget } from "./PowerSpikeWidget";
import { GankEfficiencyWidget } from "./GankEfficiencyWidget";
import { HandWidget } from "./HandWidget";
import { SpellDietWidget } from "./SpellDietWidget";
import { PerformanceTrendsWidget } from "./PerformanceTrendsWidget";
import { EsportsPlayerOverlay } from "./EsportsPlayerOverlay";
import { InspSection } from "./InspSection";
import { BenchmarkWidget } from "./BenchmarkWidget";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { useDialog } from "../../../components/ui/DialogProvider";
import { useVideoPlayback } from "../hooks/useVideoPlayback";
import { useMouseTrailCanvas } from "../hooks/useMouseTrailCanvas";
import { useClipExporter } from "../hooks/useClipExporter";
import {
  eventMeta, toneLabelAndIcon, ChampFace, IconFinding,
  IconDragon, IconBaron, IconHerald, IconTower, type Tone,
} from "./eventMeta";
import { buildQueue, analyzerFindings, type Moment, type Finding } from "./ReviewQueue";
import { describeEvent } from "../../../core/eventText";
import { individualEvents, eventChampion, withChampionNames, champLabel } from "../../../core/matchEvents";
import { champIcon, ddragonUrl } from "../../../core/ddragon";
import { sameRole } from "../../../core/roles";
import { useLang } from "../../../core/LanguageProvider";
import { useMatches } from "../../../store/useAppStore";
import { PositionIcon, POSITION_LABEL, normalizePosition } from "../../../components/PositionIcon";
import { styles } from "./videoPlayerStyles";
import "./VideoPlayer.css";
import { mix } from "../../../core/color";
import {
  itemIcon,
  DDRAGON_VER,
  streamUrl,
  smoothLinePath,
  CLIP_BEFORE,
  CLIP_AFTER,
} from "./videoPlayerUtils";

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

// El resto de la línea de tiempo, de arriba abajo: la regla de minutos, la
// barra de progreso (lo reproducido, en oro), la curva de APM y el carril de
// los sucesos. El carril sigue midiendo 56 px —las dos filas de arriba lo
// llenan— y la curva de APM sale de detrás de las marcas a su propia fila: en
// la misma, las marcas tapaban justo los picos de una pelea.
const RULER_H = 16;
const BAR_TOP = RULER_H + 6;
const BAR_H = 4;
const APM_H = 32;
const LANE_H = 56;
const ROW_GAP = 8;

/** Un elemento de la línea de tiempo: un suceso de la partida o un hallazgo. */
interface TimelineItem {
  key: string;
  time: number;
  ev?: MatchEvent;
  finding?: Finding;
}

type Bucket = "good" | "neutral" | "bad";

/** Fila de la lista de revisión. */
interface ReviewRow {
  key: string;
  time: number;
  color: string;
  icon: React.ReactNode;
  /** La frase de la fila, ya traducida ("Te mata Kai'Sa"). */
  text: string;
  /** Qué clase de momento es ("Muerte"), ya traducido. */
  label: string;
  /** Explicación: la de un hallazgo, o la categoría de un error marcado. */
  detail: string;
  tone: Tone;
  bucket: Bucket;
  finding?: Finding;
  moment?: Moment;
}

const bucketOf = (tone: Tone): Bucket =>
  tone === "excellent" || tone === "good" ? "good" : tone === "mistake" || tone === "throw" ? "bad" : "neutral";

/**
 * Salto de un "fotograma" con `,` y `.`. No se puede saber el fps real del
 * fichero desde el elemento `<video>`, así que se usa 1/30 s: en una grabación a
 * 60 fps avanza dos fotogramas, que sigue siendo el gesto de afinar el instante
 * exacto de una muerte.
 */
const FRAME_STEP = 1 / 30;

/**
 * A qué distancia del cursor un suceso se considera "el que estás viendo", para
 * la tarjeta destacada de la pestaña de sucesos.
 */
const FEATURED_NEAR = 4;

/**
 * Atajos de teclado del reproductor, en el orden en que se enseñan.
 *
 * La maqueta ponía el momento anterior/siguiente en `[` y `]`, pero esas dos
 * ya marcan la entrada y la salida del recorte: se quedan P y N, que ya
 * existían, y son las que se enseñan en los botones.
 */
const SHORTCUTS: [string, string][] = [
  ["Space / K", "Play or pause"],
  ["← / →", "Back or forward 5 s"],
  [", / .", "Step one frame"],
  ["P / N", "Previous or next moment"],
  ["[ / ]", "Set clip in or out point"],
  ["C", "Create clip"],
  ["E", "Mark error"],
  ["M", "Mute"],
  ["F", "Fullscreen"],
  ["Esc", "Leave fullscreen"],
];

/** Velocidades del segmentado del transporte. */
const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

interface VideoPlayerProps {
  match: MatchMetadata;
  /**
   * Volver a la lista de la que se abrió. La cabecera de la pantalla (campeón,
   * resultado, acciones) vive aquí y no en App.tsx porque necesita lo que solo
   * el reproductor sabe: la duración real del vídeo y el recortador.
   */
  onBack?: () => void;
}

/**
 * Fila del inspector: etiqueta a la izquierda, cifra a la derecha, en sans con
 * cifras tabulares. Todas las cifras de la columna caen en la misma vertical,
 * que es lo que permite recorrerlas de un vistazo en vez de buscarlas dentro de
 * azulejos.
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

export const VideoPlayer: React.FC<VideoPlayerProps> = ({ match, onBack }) => {
  // El componente pasaba de 2100 líneas con todo dentro; ahora compone tres
  // responsabilidades extraídas a hooks: el transporte (useVideoPlayback), la
  // estela del ratón (useMouseTrailCanvas, más abajo, cuando ya existen los
  // mouse_events) y el recortador (useClipExporter).
  const {
    videoRef,
    containerRef,
    clipEndRef,
    currentTime,
    duration,
    isPlaying,
    setIsPlaying,
    loadState,
    setLoadState,
    volume,
    muted,
    setMuted,
    playbackRate,
    setPlaybackRate,
    activeEventTime,
    setActiveEventTime,
    isFullscreen,
    isSeeking,
    seekTo,
    jumpToClip: jumpToClipAt,
    handlePlayPause,
    toggleMute,
    handleVolumeChange,
    handleTimeUpdate,
    handleLoadedMetadata,
    toggleFullscreen,
  } = useVideoPlayback(match);
  const progressBarRef = useRef<HTMLDivElement>(null);

  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  const [showTracker, setShowTracker] = useState<boolean>(true);
  const {
    isClippingMode,
    setIsClippingMode,
    clipDragThumb,
    setClipDragThumb,
    clipStart,
    clipEnd,
    isExporting,
    exportType,
    errorNote,
    setErrorNote,
    toggleClipMode,
    dragThumbTo,
    doExport,
  } = useClipExporter(match);
  const [hoverClientX, setHoverClientX] = useState<number | null>(null);
  // La pestana por defecto es la cola de revision, no las estadisticas: al abrir
  // una partida lo que quieres saber es que mirar, no como te fue.
  const { t, lang } = useLang();
  // Tres pestañas: Revisión (los sucesos, la cola y las notas: todo lo que se
  // hace CON el vídeo), Partida (qué pasó) e Impacto (qué significó). "Eventos"
  // era una cuarta con la misma lista que la cola de revisión, en otro orden.
  // Sin vídeo, la revisión no lleva a ningún sitio: se abre por la ficha de la
  // partida, que es lo único que sí hay.
  const [tab, setTab] = useState<"review" | "match" | "impact">(
    match.video_path ? "review" : "match"
  );

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
  // Reparto de tus miradas por carril. Sale de la posición del clic de minimapa.
  const [zonas, setZonas] = useState<ZoneStat[]>([]);

  // Los momentos que merecen una mirada. Los errores que marcaste tu viven en
  // clips aparte, asi que hay que traerlos y fusionarlos: eran la mitad de la
  // cola que faltaba.
  const [errorClips, setErrorClips] = useState<ErrorClipMetadata[]>([]);
  useEffect(() => {
    let alive = true;
    setErrorClips([]);
    getAllErrorClips()
      .then((clips) => {
        if (alive) setErrorClips(clips.filter((c) => c.match_id === match.id));
      })
      .catch(console.error);
    return () => { alive = false; };
  }, [match.id]);

  // La cola se recompone también al cambiar de idioma: los títulos llevan
  // nombres dentro ("Te mata Ahri"), así que se escriben aquí y no se pueden
  // traducir después.
  const [moments, setMoments] = useState<Moment[]>(() => buildQueue(match, [], t));
  useEffect(() => {
    setMoments(buildQueue(match, errorClips, t));
    // `match` entero en las deps: la cola sale de sus eventos y sus saltos de
    // cámara, no sólo de su id.
  }, [match, errorClips, t]);
  // Marcar un momento como visto. Cada fuente guarda en su sitio: los sucesos
  // en el JSON de la partida y los errores marcados en el de su propio clip. Si
  // el guardado falla se revierte y se DICE: revertir en silencio parecía un
  // clic perdido.
  const [reviewErr, setReviewErr] = useState<string | null>(null);
  const toggleReviewed = useCallback(
    (m: Moment) => {
      setReviewErr(null);
      const before = moments;
      setMoments(before.map((x) => (x.id === m.id ? { ...x, reviewed: !x.reviewed } : x)));
      const save =
        m.source === "error" && m.clipPath
          ? setErrorClipReviewed(m.clipPath, !m.reviewed)
          : setEventReviewed(match.id, m.time, !m.reviewed);
      save.catch((err) => {
        setMoments(before);
        setReviewErr(t("Couldn't save the reviewed state: {msg}", { msg: String(err) }));
      });
    },
    [moments, match.id, t]
  );
  const [newComment, setNewComment] = useState<string>("");
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const v = parseInt(localStorage.getItem("reviewSidebarWidth") || "392", 10);
    return isNaN(v) ? 392 : Math.min(700, Math.max(300, v));
  });
  const [ddragonVer, setDdragonVer] = useState<string>(DDRAGON_VER);
  const [participants, setParticipants] = useState<Participant[]>(match.participants ?? []);
  const [objectives, setObjectives] = useState<TeamObjectives[]>(match.objectives ?? []);
  const [itemPurchases, setItemPurchases] = useState<ItemPurchase[]>(match.item_purchases ?? []);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [eventFilter, setEventFilter] = useState<"all" | "good" | "neutral" | "bad" | "pending">("all");
  const [showEsportsHud, setShowEsportsHud] = useState<boolean>(true);

  const { showError } = useDialog();

  const videoSrc = streamUrl(match.video_path);

  /**
   * Partidas seguidas pero no grabadas. El backend ya guarda la partida aunque
   * la grabación falle, así que `video_path` puede venir vacío: sin esto la
   * pantalla se quedaba en el spinner para siempre.
   *
   * El motivo, si lo hay, viaja en la metadata; se lee con cuidado porque es un
   * campo que no todas las partidas tienen.
   */
  const hasVideo = !!match.video_path;
  const noVideoReason = ((match as unknown as { recording_error?: string }).recording_error ?? "").trim();

  /** Abre el explorador con el fichero seleccionado. */
  const revealVideo = useCallback(() => {
    if (!match.video_path) return;
    revealItemInDir(match.video_path).catch((e) =>
      showError(t("Couldn't open the folder: {msg}", { msg: String(e) }))
    );
  }, [match.video_path, showError, t]);

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
    fetch(ddragonUrl("/api/versions.json"))
      .then((r) => r.json())
      .then((v: string[]) => { if (Array.isArray(v) && v[0]) setDdragonVer(v[0]); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setParticipants(match.participants ?? []);
    setObjectives(match.objectives ?? []);
    setItemPurchases(match.item_purchases ?? []);
  }, [match.id, match.participants, match.objectives, match.item_purchases]);

  const jumpToClip = useCallback((eventTime: number) => {
    jumpToClipAt(eventTime, CLIP_BEFORE, CLIP_AFTER);
  }, [jumpToClipAt]);

  // Las dos ramas del if hacían lo mismo, así que no había tal decisión: en modo
  // recorte o fuera de él, pinchar la tira busca ese punto.
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);
    updateScrub(e.clientX, true);
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
        dragThumbTo(pct * duration);
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

  /**
   * Poner la entrada o la salida del recorte en el instante actual.
   *
   * El recortador sólo expone "mueve el asidero COGIDO", así que se coge, se
   * mueve y se suelta: el valor viaja en un ref porque `dragThumbTo` lee el
   * asidero del render, no el que acabamos de pedir. Si el recortador no está
   * abierto, `[` y `]` lo abren — poner una entrada en un rango que no existe no
   * significa nada.
   */
  const pendingBound = useRef<number | null>(null);
  const setClipBound = useCallback(
    (kind: "start" | "end", time: number) => {
      if (!isClippingMode) {
        toggleClipMode("clip", time, duration);
        return;
      }
      pendingBound.current = time;
      setClipDragThumb(kind);
    },
    [isClippingMode, toggleClipMode, duration, setClipDragThumb]
  );
  useEffect(() => {
    if (clipDragThumb === null || pendingBound.current === null) return;
    dragThumbTo(pendingBound.current);
    pendingBound.current = null;
    setClipDragThumb(null);
  }, [clipDragThumb, dragThumbTo, setClipDragThumb]);

  // --- Comentarios (persistidos en el JSON de la partida vía backend) ---
  const persistComments = useCallback(
    (next: MatchComment[]) => {
      setCurrentMatch((prev) => ({ ...prev, comments: next }));
      saveMatchComments(match.id, next).catch((e) =>
        showError(t("Couldn't save the notes: {msg}", { msg: String(e) }))
      );
    },
    [match.id, showError, t]
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

  // Editar una nota. Sólo se podía borrar y volver a escribir, que en una nota
  // de tres líneas escritas mientras revisabas es perderlas para arreglar una
  // palabra. El índice del que se está editando, y su texto en curso.
  const [editingNote, setEditingNote] = useState<number | null>(null);
  const [editingText, setEditingText] = useState<string>("");

  const startEditNote = (idx: number) => {
    setEditingNote(idx);
    setEditingText(comments[idx]?.text ?? "");
  };

  const commitEditNote = () => {
    if (editingNote === null) return;
    const text = editingText.trim();
    // Vaciar una nota la borra: es lo que significa dejarla vacía, y evita
    // guardar filas sin contenido que luego no se pueden distinguir.
    persistComments(
      text
        ? comments.map((c, i) => (i === editingNote ? { ...c, text } : c))
        : comments.filter((_, i) => i !== editingNote)
    );
    setEditingNote(null);
    setEditingText("");
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
      showError(t("Couldn't sync with Riot: {msg}", { msg: String(e) }));
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
  //
  // `intento` sube al pulsar Reintentar: es lo que permite volver a pedirlo sin
  // reabrir la pestaña. Un fallo de la API dejaba el panel muerto hasta cambiar
  // de partida y volver.
  const pedidoRef = useRef<string | null>(null);
  const [intento, setIntento] = useState(0);
  const reintentar = useCallback(() => {
    pedidoRef.current = null;
    setCredits(null);
    setCreditsErr(null);
    setPressure(null);
    setPressureErr(null);
    setIntento((n) => n + 1);
  }, []);
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
    getCameraZones(match.id)
      .then((z) => { if (vivo) setZonas(z); })
      .catch(() => { if (vivo) setZonas([]); });
    getMatchPressure(match.id)
      .then((ws) => { if (vivo) setPressure(ws); })
      .catch((e) => { if (vivo) { setPressure([]); setPressureErr(String(e)); } });
    return () => { vivo = false; };
  }, [tab, match.id, match.is_vod, intento]);

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
      setMmErr(t("Couldn't start the video analysis: {msg}", { msg: String(e) }));
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
  // El ancho se mide contra el borde derecho del propio panel, no contra la
  // ventana: entre los dos hay el margen de la rejilla.
  const asideRef = useRef<HTMLElement>(null);
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const right = asideRef.current?.getBoundingClientRect().right ?? window.innerWidth;
    const onMove = (ev: PointerEvent) => {
      const w = Math.min(700, Math.max(300, right - ev.clientX));
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
    let step = steps.find((paso) => duration <= paso * 6) ?? Math.ceil(duration / 6);
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
  // Las mismas miradas, pero sabiendo a qué carril fue cada una.
  const [cameraLooks, setCameraLooks] = useState<CameraLook[]>([]);

  useEffect(() => {
    setCameraSnaps(match.camera_snaps ?? []);
    getCameraSnapSummary(match.id).then(setSnapSummary).catch(() => setSnapSummary(null));
    getCameraLooks(match.id).then(setCameraLooks).catch(() => setCameraLooks([]));
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

  // --- Hallazgos del analizador -------------------------------------------
  // Lecturas de lo que hiciste sacadas de datos ya grabados (miradas al mapa,
  // saltos de cámara), no sucesos de Riot. Van en violeta en la línea de tiempo,
  // en la lista y, si son de los que avisan, sobre el propio vídeo.
  const findings = React.useMemo<Finding[]>(() => {
    const deaths = timedEvents
      .filter((e) => e.type === "ChampionKill" && e.subtype === "death")
      .map((e) => e.time);
    const looks = [...cameraSnaps, ...cameraLooks.map((l) => l.t)];
    return analyzerFindings(deaths, looks, moments, t);
  }, [timedEvents, cameraSnaps, cameraLooks, moments, t]);

  // La lista única de la línea de tiempo: sucesos y hallazgos, por orden. Es lo
  // que colocan los racimos y lo que recorren «momento anterior/siguiente».
  const timelineItems = React.useMemo<TimelineItem[]>(
    () =>
      [
        ...timedEvents.map((ev) => ({ key: `event:${ev.time}:${ev.type}:${ev.subtype ?? ""}`, time: ev.time, ev })),
        ...findings.map((f) => ({ key: f.id, time: f.time, finding: f })),
      ].sort((a, b) => a.time - b.time),
    [timedEvents, findings]
  );

  // Una sola lista para la pestaña Revisión: los sucesos con hora (marcadores
  // de Riot incluidos, la MISMA que pinta la tira), los errores que marcaste y
  // los hallazgos. La cola de revisión no es otra lista: es esta, con su casilla
  // de "visto" en las filas que salen de buildQueue.
  const rows = React.useMemo<ReviewRow[]>(() => {
    const byId = new Map(moments.map((m) => [m.id, m] as const));
    const out: ReviewRow[] = timedEvents.map((ev) => {
      const meta = eventMeta(ev, 16);
      const key = `event:${ev.time}:${ev.type}:${ev.subtype ?? ""}`;
      const label = t(meta.label);
      // La frase con la cara que se reconoce: el campeón, no el nick.
      const desc = describeEvent(withChampionNames(ev, participants), t);
      return {
        key,
        time: ev.time,
        color: meta.color,
        icon: meta.icon,
        text: desc || label,
        label,
        detail: "",
        tone: meta.tone,
        bucket: bucketOf(meta.tone),
        moment: byId.get(key),
      };
    });
    for (const m of moments) {
      if (m.source !== "error") continue;
      out.push({
        key: m.id,
        time: m.time,
        color: "var(--loss)",
        icon: <Flag size={16} />,
        text: m.title,
        label: t("Flagged error"),
        detail: m.note ? t(m.note) : "",
        tone: "mistake",
        bucket: "bad",
        moment: m,
      });
    }
    for (const f of findings) {
      out.push({
        key: f.id,
        time: f.time,
        color: "var(--flag)",
        icon: <IconFinding size={16} />,
        text: f.title,
        label: t("Finding"),
        detail: f.detail,
        tone: "neutral",
        bucket: f.bad ? "bad" : "neutral",
        finding: f,
        moment: f.moment,
      });
    }
    return out.sort((a, b) => a.time - b.time);
  }, [timedEvents, moments, findings, participants, t]);

  // El aviso violeta sobre el vídeo: el hallazgo en cuyo tramo estás. Se puede
  // cerrar, y cerrado se queda para esta partida (volver a pasar por el mismo
  // tramo no lo resucita).
  const [dismissedNotices, setDismissedNotices] = useState<Set<string>>(() => new Set());
  useEffect(() => setDismissedNotices(new Set()), [match.id]);
  const activeNotice = findings.find(
    (f) => f.notice && !dismissedNotices.has(f.id) && currentTime >= f.time && currentTime <= f.end
  );

  // El momento actual de la tarjeta: el elegido (una marca, una fila, las
  // flechas), o el suceso más cercano al cursor, o el hallazgo en cuyo tramo
  // estás.
  const featured = React.useMemo<ReviewRow | undefined>(() => {
    const exact = rows.find((r) => r.time === activeEventTime);
    if (exact) return exact;
    let best: ReviewRow | undefined;
    let bestD = Infinity;
    for (const r of rows) {
      const d = Math.abs(r.time - currentTime);
      if (d <= FEATURED_NEAR && d < bestD) { best = r; bestD = d; }
    }
    return best ?? rows.find((r) => r.finding && currentTime >= r.time && currentTime <= r.finding.end);
  }, [rows, activeEventTime, currentTime]);

  // La fila del momento actual se trae a la vista cuando CAMBIA de momento, no
  // en cada render: con un `ref` en línea se recolocaba cuatro veces por
  // segundo durante la reproducción y no dejaba desplazar la lista a mano.
  const listRef = useRef<HTMLDivElement>(null);
  const featuredKey = featured?.key;
  useEffect(() => {
    if (!featuredKey || tab !== "review") return;
    const list = listRef.current;
    if (!list) return;
    const row = Array.from(list.querySelectorAll<HTMLElement>("[data-key]")).find(
      (el) => el.dataset.key === featuredKey
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [featuredKey, tab]);

  // Los LP que dio o quitó esta partida: la resta con la clasificatoria anterior
  // del mismo rango, la MISMA cuenta que enseñan la biblioteca y «Hoy».
  const { matches: library } = useMatches();
  const lpDelta = React.useMemo(() => lpDeltas(library).get(match.id), [library, match.id]);

  const goToAdjacentEvent = useCallback((dir: 1 | -1) => {
    const times = timelineItems.map((it) => it.time);
    if (!times.length) return;
    const cur = activeEventTime ?? currentTime;
    let target: number | undefined;
    if (dir === 1) target = times.find((x) => x > cur + 0.5);
    else target = [...times].reverse().find((x) => x < cur - 0.5);
    if (target === undefined) target = dir === 1 ? times[0] : times[times.length - 1];
    jumpToClip(target);
  }, [timelineItems, activeEventTime, currentTime, jumpToClip]);

  // Atajos. Dos guardas nuevas:
  // - con un modificador pulsado no son nuestros (Ctrl K es la búsqueda global,
  //   y la «k» sola pausaba el vídeo al abrirla);
  // - el reproductor sigue montado aunque se cambie de pantalla (App oculta las
  //   rutas con display:none), así que solo responde si se está viendo. Si no,
  //   la «c» pulsada en otra pantalla abría el recortador aquí, a escondidas.
  const vpRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!vpRef.current || vpRef.current.getClientRects().length === 0) return;
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
        // Los dos botones de la cabecera, sin soltar el teclado.
        case "c": if (hasVideo) { e.preventDefault(); toggleClipMode("clip", v.currentTime, duration); } break;
        case "e": if (hasVideo) { e.preventDefault(); toggleClipMode("error", v.currentTime, duration); } break;
        // Escape salía de pantalla completa por el navegador, pero no si se
        // había entrado desde el botón sin pasar por su gesto: se dice aquí.
        case "Escape":
          if (document.fullscreenElement) { e.preventDefault(); toggleFullscreen(); }
          break;
        // Fotograma a fotograma. A 60 fps son 16 ms; se usa 1/30 para que un
        // toque avance algo visible en cualquier grabación.
        case ",": e.preventDefault(); v.pause(); clipEndRef.current = null; seekTo(v.currentTime - FRAME_STEP, false); break;
        case ".": e.preventDefault(); v.pause(); clipEndRef.current = null; seekTo(v.currentTime + FRAME_STEP, false); break;
        // Entrada y salida del recorte, sin soltar el teclado.
        case "[": e.preventDefault(); setClipBound("start", v.currentTime); break;
        case "]": e.preventDefault(); setClipBound("end", v.currentTime); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlePlayPause, seekTo, goToAdjacentEvent, toggleFullscreen, setMuted, setClipBound, toggleClipMode, duration, hasVideo, videoRef, clipEndRef]);

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
    // isFullscreen en las deps A PROPÓSITO: la tira cambia de padre al entrar y
    // salir de pantalla completa (baraja ↔ overlay), o sea que el nodo se
    // remonta. Con deps [] el observador seguía vigilando el nodo muerto y los
    // racimos quedaban colocados con el ancho viejo hasta recargar — el
    // descuadre que veía el usuario al volver del fullscreen.
  }, [isFullscreen]);

  const eventMarks = React.useMemo(() => {
    if (!isFinite(duration) || duration <= 0) return [];
    const w = trackSize.w || 1000;
    const half = MARK_SIZE / 2;
    const sitio = (t: number) => Math.min(w - half, Math.max(half, (t / duration) * w));
    const marcas = timelineItems.map((it) => ({ it, exactX: sitio(it.time) }));

    // Racimos: sucesos cuyos INSTANTES REALES caen tan juntos que sus marcas se
    // pisarían. Se encadena por vecindad de tiempo, nunca por dónde acabó la
    // marca anterior — que era el fallo de la versión anterior: al empujar cada
    // marca a la derecha, la siguiente medía contra la posición ya empujada y
    // heredaba el desplazamiento. En una partida de 57 sucesos eso arrastraba
    // TODAS las marcas (hasta 128 px, casi tres minutos de partida) y subía a la
    // fila de arriba marcas que no tenían a nadie al lado.
    const racimos: { it: TimelineItem; exactX: number }[][] = [];
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
        it: m.it,
        exactX: m.exactX,
        x: limitar(inicios[gi], gi) + (i >> 1) * MARK_PITCH,
        bottom: MARK_ROWS[i & 1],
      }))
    );
  }, [timelineItems, duration, trackSize.w]);

  const result = outcome(match.result);
  const isWin = result === "victory";

  // Quién ve la sección de ganks: el jungla siempre (es su trabajo) y cualquiera
  // que tenga emboscadas detectadas.
  const isJungler = sameRole(participants.find((p) => p.is_self)?.role, "JUNGLE");
  const hasGankMarkers = (match.timeline_markers ?? []).some((m) => m.event_type === "gank_attempt");

  // Rendimiento del jugador y agregados de su equipo (para el panel "Your Performance").
  const selfP = participants.find((p) => p.is_self);
  const myTeam = selfP ? participants.filter((p) => p.team_id === selfP.team_id) : [];
  const teamKills = myTeam.reduce((s, p) => s + p.kills, 0);
  const teamDamage = myTeam.reduce((s, p) => s + (p.damage ?? 0), 0);
  const durMin = duration > 0 ? duration / 60 : 0;

  // La estela del ratón vive en su hook: canvas, rAF y sincronía.
  const { canvasRef, mouseSync, updateMouseSync } = useMouseTrailCanvas(videoRef, match, mouseEvents);

  // --- Línea de tiempo ------------------------------------------------------
  // La tira ES la barra de búsqueda de este reproductor: en pantalla completa
  // también tiene que existir (sin ella no había forma de saltar a un minuto,
  // que fue lo que señaló el usuario). Allí va compacta, sin la curva de APM,
  // que taparía media imagen.
  //
  // Regla, barra, curva y carril son UNA superficie de búsqueda con un solo
  // ancho —el que mide `progressBarRef` para colocar los racimos—, así que
  // pinchar en cualquiera de las cuatro busca ese instante.
  const laneTop = (compact: boolean) => BAR_TOP + BAR_H + ROW_GAP + (compact ? 0 : APM_H + ROW_GAP);
  /** Aro del retrato: a quién matas en jade, quién te mata en rojo, la asistencia en jade tenue. */
  const markRing = (ev: MatchEvent): string =>
    ev.subtype === "death"
      ? "var(--loss)"
      : ev.subtype === "assist"
        ? "color-mix(in srgb, var(--win) 45%, transparent)"
        : "var(--win)";
  const hasLookStrip = duration > 0 && (cameraLooks.some((l) => l.lane) || cameraSnaps.length > 0);

  const renderTrack = (compact: boolean) => {
    const top = laneTop(compact);
    const move = isSeeking ? "var(--t-base) var(--e-move)" : "0s";
    return (
      <div
        className="vp-track"
        ref={progressBarRef}
        style={{ height: top + LANE_H }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
      >
        {/* Regla de minutos, generada según la duración real. El último rótulo
            es la duración, pegado a la derecha; el que lo pisaría se calla. */}
        <div className="vp-track__ruler" style={{ height: RULER_H }}>
          {axisMarks
            .filter((m) => m === 0 || ((duration - m) / duration) * (trackSize.w || 1000) >= 68)
            .map((m) => (
              <span
                key={m}
                className="u-time"
                style={{ left: `${(m / duration) * 100}%`, transform: m === 0 ? "none" : "translateX(-50%)" }}
              >
                {clock(m)}
              </span>
            ))}
          {duration > 0 && (
            <span className="u-time" style={{ left: "100%", transform: "translateX(-100%)" }}>
              {clock(duration)}
            </span>
          )}
        </div>

        {/* Rejilla: una línea tenue por rótulo, de la barra al pie. */}
        {duration > 0 &&
          axisMarks.slice(1).map((m) => (
            <i key={m} className="vp-track__grid" style={{ left: `${(m / duration) * 100}%`, top: BAR_TOP }} />
          ))}

        {/* Progreso: lo reproducido, en oro. */}
        <div className="vp-track__bar" style={{ top: BAR_TOP, height: BAR_H }}>
          <div className="vp-track__played" style={{ width: `${progressPct}%`, transition: `width ${move}` }} />
        </div>

        {/* Curva de APM (línea + área). */}
        {!compact && apmSeries.length >= 2 && (
          <svg
            className="vp-track__apm"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            style={{ top: BAR_TOP + BAR_H + ROW_GAP, height: APM_H }}
            aria-hidden="true"
          >
            <path d={apmAreaPath} fill="var(--apm-fill)" stroke="none" />
            <path d={apmLinePath} fill="none" stroke="var(--apm-line)" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
          </svg>
        )}

        {/* El carril de los sucesos: dos filas de marcas y, al pie, las miradas
            al mapa. */}
        <div className="vp-track__lane" style={{ top, height: LANE_H }}>
          {/* Miradas al mapa. Los huecos anchos son exactamente los minutos en
              que no miraste.

              Tres carriles en vez de uno: con 250 miradas por partida una sola
              fila era un peine ilegible, y partirla por carril baja la densidad
              Y dice de qué lado tienes el punto ciego — el hueco se ve en su
              fila. De arriba abajo, top / mid / bot, como en el mapa. Las
              miradas que no caen en ningún carril (jungla profunda, base, o las
              teclas de cámara, que no saben adónde) no se pintan aquí. */}
          {duration > 0 && cameraLooks.some((l) => l.lane) ? (
            <div style={styles.snapStrip}>
              {(["top", "mid", "bot"] as const).map((carril, fila) => (
                <div key={carril} style={{ ...styles.snapLane, top: `${fila * 4}px` }}>
                  {cameraLooks
                    .filter((l) => l.lane === carril)
                    .map((l, i) => (
                      <div
                        key={i}
                        style={{ ...styles.snapTick, left: `${(l.t / duration) * 100}%` }}
                        title={`${carril} · ${clock(l.t)}`}
                      />
                    ))}
                </div>
              ))}
            </div>
          ) : duration > 0 && cameraSnaps.length > 0 ? (
            <div style={styles.snapStrip}>
              {cameraSnaps.map((s, i) => (
                <div key={i} style={{ ...styles.snapTick, left: `${(s / duration) * 100}%` }} />
              ))}
            </div>
          ) : null}

          {/* Guías: solo las dibuja el marcador que ha tenido que apartarse,
              y van de su instante real al pie del propio marcador. */}
          {duration > 0 && trackSize.w > 0 && (
            <svg className="vp-track__guides" viewBox={`0 0 ${trackSize.w} ${LANE_H}`} aria-hidden="true">
              {eventMarks
                .filter((m) => Math.abs(m.x - m.exactX) > 1.5)
                .map((m, i) => (
                  <line
                    key={i}
                    x1={m.exactX}
                    y1={LANE_H - 1}
                    x2={m.x}
                    y2={LANE_H - m.bottom}
                    stroke={mix(m.it.ev ? eventMeta(m.it.ev).color : "var(--flag)", 40)}
                    strokeWidth={1}
                  />
                ))}
            </svg>
          )}

          {/* Marcas: una por suceso. Kills, muertes y asistencias llevan la cara
              del campeón del otro lado cuando se sabe; objetivos en oro; los
              hallazgos del analizador, rombo violeta. */}
          {duration > 0 &&
            eventMarks.map((m, i) => {
              const { it } = m;
              const isActive = it.time === activeEventTime;
              const place: React.CSSProperties = {
                left: `${m.x}px`,
                bottom: `${m.bottom}px`,
                width: `${MARK_SIZE}px`,
                height: `${MARK_SIZE}px`,
                zIndex: isActive ? 10 : 5,
              };
              if (it.finding) {
                const f = it.finding;
                const label = `${clock(f.time)} · ${f.title}`;
                return (
                  <button
                    key={`${it.key}:${i}`}
                    type="button"
                    className="vp-mark vp-mark--finding"
                    data-on={isActive || undefined}
                    style={place}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); jumpToClip(f.time); }}
                    aria-label={label}
                    title={`${label} – ${f.detail}`}
                  >
                    <span className="vp-mark__diamond" />
                  </button>
                );
              }
              const ev = it.ev as MatchEvent;
              const meta = eventMeta(ev, 12);
              const champ = eventChampion(ev, participants);
              const desc = describeEvent(withChampionNames(ev, participants), t);
              const label = [`${clock(ev.time)} · ${t(meta.label)}`, desc].filter(Boolean).join(" – ");
              const glyph = <span className="vp-mark__glyph">{meta.icon}</span>;
              return (
                <button
                  key={`${it.key}:${i}`}
                  type="button"
                  className="vp-mark"
                  data-on={isActive || undefined}
                  style={{ ...place, "--mark": meta.color, "--ring": champ ? markRing(ev) : meta.color } as React.CSSProperties}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); jumpToClip(ev.time); }}
                  aria-label={label}
                  title={label}
                >
                  {champ ? (
                    <ChampFace champion={champ} size={MARK_SIZE} className="vp-mark__face" fallback={glyph} />
                  ) : (
                    glyph
                  )}
                </button>
              );
            })}
        </div>

        {/* Cabezal: línea y asa, en oro. Durante la reproducción va pegado al
            vídeo (sin transición); cuando el salto lo provoca un suceso o una
            nota, recorre la distancia en --t-base para que se vea hacia qué
            lado y cuánto te has movido dentro de la partida. */}
        <div className="vp-track__head" style={{ left: `${progressPct}%`, top: BAR_TOP - 3, transition: `left ${move}` }} />
        <div
          className="vp-track__knob"
          style={{ left: `${progressPct}%`, top: BAR_TOP + BAR_H / 2 - 6, transition: `left ${move}` }}
        />

        {hoverPct !== null && (
          <div className="vp-track__hover" style={{ left: `${hoverPct * 100}%`, top: BAR_TOP - 3 }} />
        )}

        {/* Etiqueta al pasar por encima. Cuelga de la propia tira, que es a lo
            que se refiere: en `position: fixed` con una altura a fuego flotaba
            en mitad del vídeo en pantalla completa. */}
        {hoverPct !== null && hoverClientX !== null && (
          <div className="vp-tip" style={{ left: `${hoverPct * 100}%` }}>
            <div className="vp-tip__head">
              <span className="u-time">{clock(hoverPct * duration)}</span>
              {apmSeries.length > 0 && (
                <span className="u-metric vp-tip__apm">
                  {t("{n} APM", {
                    n: Math.round(apmSeries[Math.min(apmSeries.length - 1, Math.floor(hoverPct * apmSeries.length))]),
                  })}
                </span>
              )}
            </div>
            {timelineItems
              .filter((it) => Math.abs(it.time - hoverPct * duration) < duration * 0.01)
              .slice(0, 1)
              .map((it) => {
                if (it.finding) {
                  return (
                    <div key={it.key} className="vp-tip__ev" style={{ color: "var(--flag)" }}>
                      <IconFinding size={12} />
                      <span>{it.finding.title}</span>
                    </div>
                  );
                }
                const ev = it.ev as MatchEvent;
                const meta = eventMeta(ev, 12);
                const desc = describeEvent(withChampionNames(ev, participants), t);
                return (
                  <div key={it.key} className="vp-tip__ev" style={{ color: meta.color }}>
                    {meta.icon}
                    <span>{desc || t(meta.label)}</span>
                  </div>
                );
              })}
          </div>
        )}

        {/* Rango del recortador. Del color de lo que va a producir: jade si es
            un clip, rojo si es un error. */}
        {isClippingMode && duration > 0 && (
          <div
            className="vp-track__clip"
            style={{
              top: BAR_TOP - 3,
              left: `${(clipStart / duration) * 100}%`,
              width: `${((clipEnd - clipStart) / duration) * 100}%`,
              "--clip": exportType === "clip" ? "var(--cool)" : "var(--loss)",
            } as React.CSSProperties}
          >
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
    );
  };

  // --- Transporte -------------------------------------------------------------
  // Lo que se hace en esta pantalla es saltar entre momentos, así que eso manda
  // a la izquierda, junto al play; los ajustes crípticos (sincronía del rastro
  // del ratón, capas del overlay) viven en un menú con nombres de verdad.
  //
  // Va debajo de la línea de tiempo, y solo flota sobre el vídeo en pantalla
  // completa.
  const speedLabel = (r: number) => `${lang === "es" ? String(r).replace(".", ",") : String(r)}×`;

  // Las miradas al mapa (por minuto y el rato más largo sin mirar), o el botón
  // que las busca en el vídeo. Vivían en una cabecera de la línea de tiempo.
  const lookStats = snapSummary?.analyzed ? (
    <span
      className="vp-looks"
      title={t("How often you moved the camera off yourself: minimap clicks and ally camera keys, counted from what you actually pressed. 'Blind' is the longest stretch without a single look.")}
    >
      <Eye size={14} />
      <span className="u-metric">{snapSummary.per_minute.toFixed(1)}/min</span>
      <span aria-hidden="true">·</span>
      <span className="u-metric" style={{ color: snapSummary.longest_gap_secs > 120 ? "var(--loss)" : "var(--win)" }}>
        {clock(snapSummary.longest_gap_secs)} {t("blind")}
      </span>
    </span>
  ) : (
    <button
      type="button"
      className="vp-tbtn vp-tbtn--text"
      onClick={runSnapAnalysis}
      disabled={snapBusy}
      title={t("Scan the video for camera moves. Only needed for imported VODs: a game recorded here already knows this from your clicks and keys.")}
    >
      <Eye size={14} />
      <span className="vp-tbtn__label">
        {snapBusy ? t("Scanning {pct}%", { pct: snapPct.toFixed(0) }) : t("Camera moves")}
      </span>
    </button>
  );

  const transportBar = (
    <div className={isFullscreen ? "vp-transport vp-transport--fs" : "vp-transport"}>
      <button
        type="button"
        className="vp-play"
        onClick={handlePlayPause}
        title={`${t(isPlaying ? "Pause" : "Play")} (Space)`}
        aria-label={t(isPlaying ? "Pause" : "Play")}
        aria-keyshortcuts="Space K"
      >
        {isPlaying ? <Pause fill="currentColor" size={16} /> : <Play fill="currentColor" size={16} />}
      </button>
      <button
        type="button"
        className="vp-tbtn"
        onClick={() => goToAdjacentEvent(-1)}
        title={t("Previous moment")}
        aria-label={t("Previous moment")}
        aria-keyshortcuts="P"
      >
        <SkipBack size={16} />
        <kbd className="u-kbd">P</kbd>
      </button>
      <button
        type="button"
        className="vp-tbtn"
        onClick={() => goToAdjacentEvent(1)}
        title={t("Next moment")}
        aria-label={t("Next moment")}
        aria-keyshortcuts="N"
      >
        <SkipForward size={16} />
        <kbd className="u-kbd">N</kbd>
      </button>

      {/* Centésimas: en una herramienta de revisión hace falta señalar un
          instante, no un minuto. */}
      <span className="u-time vp-clock">
        <b>{clock(currentTime)}.{String(Math.floor((currentTime % 1) * 100)).padStart(2, "0")}</b>
        <span> / {clock(duration)}</span>
      </span>

      <span className="vp-transport__fill" />

      {/* Lo primero que cede si no cabe: se queda en el icono. */}
      {!isFullscreen && <span className="vp-transport__aux">{lookStats}</span>}

      {/* Segmentado y no desplegable: durante una revisión la velocidad se
          cambia constantemente y un desplegable son dos clics cada vez. */}
      <span className="vp-speeds" role="group" aria-label={t("Playback speed")}>
        {SPEEDS.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setPlaybackRate(r)}
            aria-pressed={playbackRate === r}
            data-on={playbackRate === r ? "" : undefined}
          >
            {speedLabel(r)}
          </button>
        ))}
      </span>

      <div className="tp-vol vp-vol">
        <button
          type="button"
          className="vp-tbtn vp-tbtn--icon"
          onClick={toggleMute}
          title={t(muted ? "Unmute" : "Mute")}
          aria-label={t(muted ? "Unmute" : "Mute")}
          aria-keyshortcuts="M"
        >
          {muted || volume === 0 ? <VolumeX size={17} /> : volume < 0.5 ? <Volume1 size={17} /> : <Volume2 size={17} />}
        </button>
        <input
          type="range" min="0" max="1" step="0.05"
          className="vp-range"
          value={muted ? 0 : volume}
          onChange={handleVolumeChange}
          aria-label={t("Volume")}
        />
      </div>

      <details className="tp-more vp-more">
        <summary title={t("Playback settings")} aria-label={t("Playback settings")}>
          <MoreHorizontal size={17} />
        </summary>
        <div className="tp-pop">
          <label className="tp-pop__row">
            <span>{t("Broadcast overlay")}</span>
            <input type="checkbox" className="vp-check" checked={showEsportsHud} onChange={() => setShowEsportsHud((h) => !h)} />
          </label>
          <label className="tp-pop__row">
            <span>{t("Mouse trail")}</span>
            <input type="checkbox" className="vp-check" checked={showTracker} onChange={() => setShowTracker((v) => !v)} />
          </label>
          <div className="tp-pop__row tp-pop__row--stack">
            <span>
              {t("Mouse trail sync")}
              <em>{t("Shifts the trail against the video, in seconds.")}</em>
            </span>
            <div className="tp-pop__sync">
              <input
                type="range" min="-3" max="3" step="0.1" value={mouseSync}
                className="vp-range vp-range--wide"
                aria-label={t("Mouse trail sync")}
                onChange={(e) => updateMouseSync(parseFloat(e.target.value))}
              />
              <span className="tp-pop__val">{mouseSync > 0 ? `+${mouseSync.toFixed(1)}` : mouseSync.toFixed(1)}s</span>
            </div>
          </div>
          {/* Los atajos existían y no los sabía nadie: no estaban escritos en
              ningún sitio de la pantalla. */}
          <div className="tp-pop__row tp-pop__row--stack">
            <span>{t("Keyboard shortcuts")}</span>
            <div className="vp-keys">
              {SHORTCUTS.map(([keys, what]) => (
                <div key={keys} className="vp-keys__row">
                  <kbd className="u-kbd">{keys}</kbd>
                  <span>{t(what)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </details>

      <button
        type="button"
        className="vp-tbtn vp-tbtn--icon"
        onClick={toggleFullscreen}
        title={`${t("Fullscreen")} (F)`}
        aria-label={t("Fullscreen")}
        aria-keyshortcuts="F"
      >
        <Maximize size={17} />
      </button>
    </div>
  );

  // Cabecera de la pantalla: quién, cómo acabó, cuánto llevas revisado y las
  // dos acciones que producen un fichero (clip y error). Vivía en App.tsx con
  // el campeón y la fecha; aquí tiene a mano el resultado, la duración real del
  // vídeo y el recortador.
  const rankText =
    match.impact_rank != null
      ? t("{rank} of {total} by impact", {
          rank: match.impact_rank === 1 ? t("MVP") : t("#{n}", { n: match.impact_rank }),
          total: participants.length || 10,
        })
      : null;
  const when = (() => {
    const day = relativeDay(match.date, t);
    const d = new Date(match.date.replace(" ", "T"));
    if (Number.isNaN(d.getTime())) return day;
    return `${day} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  })();
  const metaLine = [
    match.is_vod ? null : t(queueKey(match.queue)),
    clock(duration),
    when,
    rankText,
  ]
    .filter(Boolean)
    .join(" · ");
  const resultTone = match.is_vod
    ? "var(--cool)"
    : result === "victory"
      ? "var(--win)"
      : result === "defeat"
        ? "var(--loss)"
        : "var(--hair-strong)";
  const doneCount = moments.filter((m) => m.reviewed).length;

  // El aviso del analizador. Sobre el vídeo, abajo a la izquierda; en pantalla
  // completa sube encima de la tira y el transporte para no taparlos.
  const noticeEl = activeNotice ? (
    <div className={isFullscreen ? "vp-notice vp-notice--fs" : "vp-notice"} role="status">
      <EyeOff size={16} className="vp-notice__icon" aria-hidden="true" />
      <span className="vp-notice__text">
        <b>{activeNotice.title}.</b> {activeNotice.detail}
      </span>
      <button
        type="button"
        className="vp-notice__x"
        onClick={() => setDismissedNotices((prev) => new Set(prev).add(activeNotice.id))}
        title={t("Dismiss")}
        aria-label={t("Dismiss")}
      >
        <X size={14} />
      </button>
    </div>
  ) : null;

  // `tl` son las etiquetas de tono (texto inglés + color), no `t`.
  const toneBadge = (tone: Tone) => {
    const tl = toneLabelAndIcon(tone);
    return (
      <span className="badge" style={{ color: tl.color, background: mix(tl.color, 13) }}>
        {t(tl.text)}
      </span>
    );
  };
  // Las filas neutras (definitivas, placas…) no llevan chip: un «Info» en cada
  // una era ruido que tapaba los que sí dicen algo.
  const chipFor = (r: ReviewRow) =>
    r.finding ? (
      <span className="badge vp-badge--finding">{t("Finding")}</span>
    ) : r.tone === "neutral" ? null : (
      toneBadge(r.tone)
    );

  return (
    <div className="vp" ref={vpRef}>
      <header className="vp-top">
        {onBack && (
          <button type="button" className="vp-iconbtn" onClick={onBack} title={t("Back")} aria-label={t("Back")}>
            <ArrowLeft size={16} />
          </button>
        )}
        <span className="vp-top__face" style={{ boxShadow: `0 0 0 2px ${resultTone}` }}>
          <ChampionAvatar champion={match.champion} size={36} />
        </span>
        <div className="vp-top__block">
          <div className="vp-top__title">
            <h2>{match.champion}</h2>
            {(match.is_vod || result !== "unknown") && (
              <span className="vp-top__result" style={{ color: resultTone }}>
                {match.is_vod ? t("Imported VOD") : t(isWin ? "Victory" : "Defeat")}
              </span>
            )}
            {lpDelta != null && lpDelta !== 0 && (
              <span className="vp-top__lp" data-down={lpDelta < 0 || undefined}>
                {lpDelta > 0 ? "+" : "−"}{Math.abs(lpDelta)} LP
              </span>
            )}
          </div>
          <span className="vp-top__meta">{metaLine}</span>
        </div>
        <span className="vp-top__fill" />
        {moments.length > 0 && (
          <div className="vp-top__progress">
            <span>{t("{done} of {total} moments reviewed", { done: doneCount, total: moments.length })}</span>
            <div
              className="vp-meter"
              role="progressbar"
              aria-label={t("Moments reviewed")}
              aria-valuemin={0}
              aria-valuemax={moments.length}
              aria-valuenow={doneCount}
            >
              <div style={{ width: `${(doneCount / moments.length) * 100}%` }} />
            </div>
          </div>
        )}
        {hasVideo && (
          <div className="vp-top__actions">
            <span className="vp-top__sep" aria-hidden="true" />
            <button
              type="button"
              className="vp-sbtn"
              aria-pressed={isClippingMode && exportType === "clip"}
              aria-keyshortcuts="C"
              onClick={() => toggleClipMode("clip", currentTime, duration)}
              title={`${t("Export video clip")} ([ / ])`}
            >
              <Scissors size={15} color="var(--muted)" />
              {t("Create clip")}
              <kbd className="u-kbd">C</kbd>
            </button>
            <button
              type="button"
              className="vp-sbtn"
              aria-pressed={isClippingMode && exportType === "error"}
              aria-keyshortcuts="E"
              onClick={() => toggleClipMode("error", currentTime, duration)}
            >
              <Flag size={15} color="var(--loss)" />
              {t("Mark error")}
              <kbd className="u-kbd">E</kbd>
            </button>
          </div>
        )}
      </header>

      {/* El cuerpo es lo que entra en pantalla completa: vídeo y, en la
          rejilla normal, el inspector a su derecha. */}
      <div
        ref={containerRef}
        className={isFullscreen ? "vp-body vp-body--fs" : "vp-body"}
        style={{ gridTemplateColumns: isFullscreen ? "minmax(0, 1fr)" : `minmax(0, 1fr) ${sidebarWidth}px` }}
      >
        <div className="vp-left">
          <div className="vp-video">
            {/* Sin vídeo no se monta el elemento: un `<video src="">` dispara un
                error de carga y acabaríamos enseñando "el fichero está dañado"
                para una partida que nunca llegó a grabarse. Son dos cosas
                distintas y se dicen distinto. */}
            {hasVideo ? (
              <video
                ref={videoRef}
                src={videoSrc}
                style={styles.video}
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={handleLoadedMetadata}
                onClick={handlePlayPause}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                // El estado de error existía y era inalcanzable: nadie lo ponía.
                // Un fichero borrado a mano dejaba un rectángulo negro eterno.
                onError={() => setLoadState("error")}
                preload="auto"
              />
            ) : (
              <div style={styles.centerOverlay}>
                <EmptyState
                  icon={<VideoOff size={30} color="var(--faint)" />}
                  title={t("This game was tracked but not recorded")}
                  text={
                    noVideoReason
                      ? t("The recording failed: {reason}. Its events, stats and impact are all still here.", { reason: noVideoReason })
                      : t("The recording did not produce a file. Its events, stats and impact are all still here.")
                  }
                />
              </div>
            )}
            {hasVideo && loadState === "loading" && <div style={styles.centerOverlay}><div className="spinner" /></div>}
            {hasVideo && loadState === "error" && (
              <div style={styles.centerOverlay}>
                <EmptyState
                  icon={<AlertTriangle size={30} color="var(--loss)" />}
                  title={t("The video file is missing or damaged")}
                  text={t("It was moved, deleted or written incomplete. Everything else about this game still works.")}
                  action={
                    <button className="btn btn--ghost btn--sm" onClick={revealVideo}>
                      <FolderOpen size={13} /> {t("Reveal in folder")}
                    </button>
                  }
                />
              </div>
            )}
            <canvas ref={canvasRef} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 5, opacity: showTracker ? 1 : 0, transition: "opacity var(--t-quick) var(--e-move)" }} />

            {/* Overlay eSports Broadcast (HUD flotante sobre el vídeo) */}
            <EsportsPlayerOverlay
              currentTime={currentTime}
              match={currentMatch}
              visible={showEsportsHud && hasVideo}
            />

            {!isFullscreen && noticeEl}

            {isFullscreen && (
              <div style={styles.fsBottom}>
                {noticeEl}
                <div style={styles.fsTimeline}>{renderTrack(true)}</div>
                {transportBar}
              </div>
            )}
          </div>

          {/* Línea de tiempo y transporte, debajo del vídeo. La tira ES la
              barra de búsqueda de este reproductor; a su izquierda, el nombre
              de cada fila. */}
          {!isFullscreen && hasVideo && (
            <>
              <section className="vp-tl" aria-label={t("Game timeline")}>
                <div className="vp-tl__gutter" aria-hidden="true">
                  <span style={{ height: BAR_TOP + BAR_H + ROW_GAP }} />
                  <span className="vp-tl__g" style={{ height: APM_H }} title={t("Average APM")}>
                    <span>{t("APM")}</span>
                    {!!match.apm && <b className="u-metric">{Math.round(match.apm)}</b>}
                  </span>
                  <span style={{ height: ROW_GAP }} />
                  <span className="vp-tl__g vp-tl__g--lane" style={{ height: LANE_H }}>
                    <span>{t("Events")}</span>
                    {hasLookStrip && <span className="vp-tl__looks">{t("Looks")}</span>}
                  </span>
                </div>
                {renderTrack(false)}
              </section>
              {transportBar}
            </>
          )}
        </div>

        {/* Inspector: tres pestañas. Revisión reúne los sucesos, la cola y las
            notas —todo lo que se hace con el vídeo delante—; Partida e Impacto
            son lectura. */}
        {!isFullscreen && (
        <aside ref={asideRef} className="vp-insp" aria-label={t("Game review")}>
          <div style={styles.resizeHandle} onPointerDown={startResize} title={t("Drag to resize")} />
          <div className="vp-tabs" role="tablist" aria-label={t("Game panels")}>
            {(["review", "match", "impact"] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                className="vp-tab"
                aria-selected={tab === id}
                data-on={tab === id ? "" : undefined}
                onClick={() => setTab(id)}
              >
                {t(id === "review" ? "Review" : id === "match" ? "Game" : "Impact")}
              </button>
            ))}
          </div>

        {tab === "review" && (() => {
          const counts = { good: 0, neutral: 0, bad: 0 };
          rows.forEach((r) => { counts[r.bucket]++; });
          const shown = rows.filter((r) =>
            eventFilter === "all" ? true
              : eventFilter === "pending" ? !!r.moment && !r.moment.reviewed
              : r.bucket === eventFilter
          );
          // «Regulares» no cabe al ancho por defecto: sale cuando el panel es
          // ancho (se redimensiona desde su borde) o si ya está elegido. Sus
          // filas siguen todas bajo «Todas».
          const showNeutral = counts.neutral > 0 && (sidebarWidth >= 440 || eventFilter === "neutral");
          const chips: [typeof eventFilter, string, number, string | null][] = [
            ["all", "All", rows.length, null],
            ["good", "Good", counts.good, "var(--win)"],
            ["bad", "Bad", counts.bad, "var(--loss)"],
            ...(showNeutral ? [["neutral", "Neutral", counts.neutral, "var(--faint)"] as [typeof eventFilter, string, number, string | null]] : []),
            ["pending", "To review", moments.length - doneCount, null],
          ];
          return (
            <>
              <div className="vp-filters" role="group" aria-label={t("Filter moments")}>
                {chips.map(([id, label, n, dot]) => (
                  <button
                    key={id}
                    type="button"
                    className="vp-chip"
                    aria-pressed={eventFilter === id}
                    data-on={eventFilter === id ? "" : undefined}
                    onClick={() => setEventFilter(id)}
                  >
                    {dot && <i className="vp-chip__dot" style={{ background: dot }} />}
                    {t(label)} <span className="vp-chip__n">{n}</span>
                  </button>
                ))}
              </div>
              {reviewErr && <p className="vp-saveErr">{reviewErr}</p>}

              {/* La tarjeta del momento actual sólo aparece si hay algo elegido
                  o si el cursor está encima de un suceso: cuando de verdad se
                  refiere a algo. Con el primer suceso por defecto presidía la
                  pestaña el del minuto 2 como si fuera EL momento. */}
              {featured && (
                <section
                  className="vp-feat"
                  data-finding={featured.finding ? "" : undefined}
                  aria-label={t("Current moment")}
                >
                  <div className="vp-feat__meta">
                    <span className="u-time vp-feat__time">{clock(featured.time)}</span>
                    <span className="vp-feat__kicker">{t("Current moment")}</span>
                    <span className="vp-feat__fill" />
                    {chipFor(featured)}
                  </div>
                  <h3 className="vp-feat__name">{featured.text}</h3>
                  <p className="vp-feat__desc">
                    {featured.detail || `${featured.label} · ${t("minute")} ${Math.floor(featured.time / 60)}`}
                  </p>
                  <div className="vp-feat__actions">
                    {featured.moment && (
                      <button
                        type="button"
                        className="vp-sbtn vp-sbtn--sm"
                        aria-pressed={featured.moment.reviewed}
                        onClick={() => toggleReviewed(featured.moment!)}
                      >
                        <Check size={14} color="var(--win)" />
                        {t(featured.moment.reviewed ? "Mark as not reviewed" : "Mark as reviewed")}
                      </button>
                    )}
                    {hasVideo && (
                      <button
                        type="button"
                        className="vp-sbtn vp-sbtn--sm"
                        aria-pressed={isClippingMode && exportType === "clip"}
                        onClick={() => { if (!isClippingMode) toggleClipMode("clip", featured.time, duration); }}
                      >
                        <Scissors size={14} color="var(--muted)" />
                        {t("Create {n} s clip", { n: 20 })}
                      </button>
                    )}
                    {hasVideo && (
                      <button
                        type="button"
                        className="vp-sbtn vp-sbtn--sm vp-sbtn--icon"
                        aria-pressed={isClippingMode && exportType === "error"}
                        onClick={() => { if (!isClippingMode) toggleClipMode("error", featured.time, duration); }}
                        title={t("Mark error")}
                        aria-label={t("Mark error")}
                      >
                        <Flag size={14} color="var(--loss)" />
                      </button>
                    )}
                    <button
                      type="button"
                      className="vp-sbtn vp-sbtn--sm vp-sbtn--icon"
                      onClick={() => jumpToClip(featured.time)}
                      title={t("Jump to this moment")}
                      aria-label={t("Jump to this moment")}
                    >
                      <RotateCcw size={14} />
                    </button>
                  </div>
                </section>
              )}

              <div className="vp-list" ref={listRef} role="list" aria-label={t("Game moments")}>
                {shown.map((r, i) => {
                  const isActive = featured?.key === r.key;
                  return (
                    <div
                      key={`${r.key}:${i}`}
                      data-key={r.key}
                      role="listitem"
                      className="vp-ev"
                      data-on={isActive || undefined}
                      data-done={r.moment?.reviewed || undefined}
                      data-finding={r.finding ? "" : undefined}
                    >
                      <button
                        type="button"
                        className="vp-ev__main"
                        onClick={() => jumpToClip(r.time)}
                        title={r.detail ? `${r.text} · ${r.detail}` : r.text}
                      >
                        <span className="u-time vp-ev__time">{clock(r.time)}</span>
                        <span className="vp-ev__icon" style={{ color: r.color }}>{r.icon}</span>
                        <span className="vp-ev__text">{r.text}</span>
                        {chipFor(r)}
                      </button>
                      <span className="vp-ev__done">
                        {r.moment && (
                          <input
                            type="checkbox"
                            className="vp-check"
                            checked={r.moment.reviewed}
                            onChange={() => toggleReviewed(r.moment!)}
                            aria-label={t("Reviewed: {what}", { what: `${clock(r.time)} · ${r.text}` })}
                          />
                        )}
                      </span>
                    </div>
                  );
                })}
                {shown.length === 0 && (
                  <div style={styles.emptyEvents}>
                    {rows.length === 0
                      ? t("No events recorded in this game.")
                      : eventFilter === "pending" ? t("All reviewed") : t("No events match this filter.")}
                  </div>
                )}
              </div>

              {/* Notas ancladas al instante. La caja escribe en el instante
                  actual; las guardadas cuelgan debajo, con su hora, y se editan
                  en sitio. Guardar es la única acción en oro de la pantalla. */}
              <div className="vp-notes">
                <div className="vp-notes__row">
                  <label className="vp-notes__field">
                    <span className="u-time vp-notes__at" title={t("Will be anchored to this moment")}>
                      {clock(currentTime)}
                    </span>
                    <input
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") addComment(); }}
                      placeholder={t("What would you do differently here…")}
                      aria-label={t("Note for {time}", { time: clock(currentTime) })}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn btn--primary vp-notes__save"
                    onClick={addComment}
                    disabled={!newComment.trim()}
                    title={t("Add at current time")}
                  >
                    {t("Save note")}
                  </button>
                </div>
                {comments.length > 0 && (
                  <div className="vp-notes__list">
                    {comments.map((c, i) => (
                      <div key={i} className="vp-note">
                        <FileText size={14} className="vp-note__icon" aria-hidden="true" />
                        <button
                          type="button"
                          className="u-time vp-note__time"
                          onClick={() => seekTo(c.time, false)}
                          title={t("Jump to this moment")}
                        >
                          {clock(c.time)}
                        </button>
                        {editingNote === i ? (
                          <>
                            <input
                              className="vp-note__input"
                              value={editingText}
                              autoFocus
                              onChange={(e) => setEditingText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitEditNote();
                                if (e.key === "Escape") { setEditingNote(null); setEditingText(""); }
                              }}
                              onBlur={commitEditNote}
                              aria-label={t("Edit note")}
                            />
                            <button
                              type="button"
                              className="vp-note__btn"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => { setEditingNote(null); setEditingText(""); }}
                              title={t("Cancel")}
                              aria-label={t("Cancel")}
                            >
                              <X size={14} />
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="vp-note__text">{c.text}</span>
                            <button type="button" className="vp-note__btn" onClick={() => startEditNote(i)} title={t("Edit note")} aria-label={t("Edit note")}>
                              <Pencil size={14} />
                            </button>
                            <button type="button" className="vp-note__btn" onClick={() => deleteComment(i)} title={t("Delete note")} aria-label={t("Delete note")}>
                              <Trash2 size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          );
        })()}

        {tab === "match" && (
          <div className="insp">
            {/* El veredicto que abría la pestaña («Victoria · Gwen · 27:30») se
                ha ido: lo dice la cabecera de la pantalla, a la vista siempre. */}

            {/* ------------------------------------------------ tu partida */}
            <section>
              <div className="sect__head">
                <span className="u-label">{t("Your game")}</span>
                <i className="sect__rule" />
              </div>
              {match.kda && <InspRow label={t("KDA")} value={match.kda} />}
              {!!match.apm && <InspRow label={t("APM")} value={Math.round(match.apm)} />}
              {!!match.gold_earned && (
                <InspRow label={t("Gold")} value={`${(match.gold_earned / 1000).toFixed(1)}k`} />
              )}
              {selfP && (
                <>
                  <InspRow
                    label={t("Kill participation")}
                    value={teamKills > 0 ? `${Math.round(((selfP.kills + selfP.assists) / teamKills) * 100)}%` : "—"}
                  />
                  <InspRow label={t("CS / min")} value={durMin > 0 ? (selfP.cs / durMin).toFixed(1) : "—"} />
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

            {/* -------------------------------------- frente a tu rango
                Va justo detrás de "Tu partida" a propósito: las cifras de
                arriba no dicen si son buenas, y ésta es la respuesta. El
                widget pide los baremos al MONTARSE, y `InspSection` no monta
                sus hijos si está plegada: cerrarla no gasta nada. */}
            <InspSection id="benchmarks" title={t("Versus your rank")}>
              {match.is_vod || !match.riot_match_id ? (
                <EmptyState
                  icon={<BarChart3 size={26} color="var(--faint)" />}
                  title={t("No benchmarks for this game yet")}
                  text={t("Sync with Riot to compare against your rank")}
                />
              ) : (
                <BenchmarkWidget
                  matchId={match.id}
                  role={selfP?.role}
                  tierBucket={match.tier_bucket}
                />
              )}
            </InspSection>

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
              <InspSection id="lead" title={t("Lead over time")}>
                <GoldXpChart
                  frames={match.minute_frames}
                  videoOffset={match.video_offset ?? 0}
                  onSeek={(secs) => seekTo(secs, false)}
                />
              </InspSection>
            )}

            {/* --------------------------------------------- el marcador */}
            {participants.length > 0 ? (
              <section>
                <div className="sect__head">
                  <span className="u-label">{t("Scoreboard")}</span>
                  <i className="sect__rule" />
                </div>
                {/* Un bloque por equipo: su nombre y resultado hacen de cabecera
                    de las columnas. La cara del campeón y el icono de su
                    posición dicen quién era cada uno antes que el nick. */}
                {[100, 200].map((teamId) => {
                  const team = participants.filter((p) => p.team_id === teamId);
                  if (team.length === 0) return null;
                  const won = team[0].win;
                  const tone = won ? "var(--win)" : "var(--loss)";
                  return (
                    <div key={teamId} className="vp-sb">
                      <div className="vp-sb__head">
                        <span className="vp-sb__team">
                          <i style={{ background: tone }} />
                          {t(teamId === 100 ? "Blue Team" : "Red Team")}
                          <em style={{ color: tone }}>{t(won ? "Victory" : "Defeat")}</em>
                        </span>
                        <span>{t("K/D/A")}</span>
                        <span>{t("CS")}</span>
                        <span>{t("Gold")}</span>
                      </div>
                      {team.map((p, i) => {
                        const pos = normalizePosition(p.role);
                        return (
                          <div key={i} className="vp-sb__row" data-self={p.is_self || undefined}>
                            <ChampFace
                              champion={p.champion}
                              size={28}
                              className="vp-sb__face"
                              fallback={<span className="vp-sb__face vp-sb__face--empty" />}
                            />
                            <span className="vp-sb__who">
                              <span className="vp-sb__name">{p.is_self ? t("You") : (p.name || champLabel(p.champion))}</span>
                              <span className="vp-sb__champ">
                                {pos && (
                                  <PositionIcon position={pos} size={12} color="var(--faint)" title={t(POSITION_LABEL[pos])} />
                                )}
                                {champLabel(p.champion)}
                              </span>
                            </span>
                            <span className="u-metric vp-sb__kda">{p.kills}/{p.deaths}/{p.assists}</span>
                            <span className="u-metric vp-sb__num">{p.cs}</span>
                            <span className="u-metric vp-sb__num">{(p.gold / 1000).toFixed(1)}k</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </section>
            ) : match.is_vod ? (
              // Antes, en un VOD, aquí no salía nada: un hueco entre dos
              // secciones que se leía como "esto está roto".
              <section>
                <div className="sect__head">
                  <span className="u-label">{t("Scoreboard")}</span>
                  <i className="sect__rule" />
                </div>
                <EmptyState
                  title={t("No scoreboard for an imported VOD")}
                  text={t("The 10-player scoreboard comes from your own game synced with Riot. An imported video has no match behind it.")}
                />
              </section>
            ) : (
              <section>
                <p className="note">{t("The 10-player scoreboard is not loaded yet.")}</p>
                <button className="btn btn--primary btn--sm" onClick={handleSync} disabled={syncing}>
                  <RefreshCw size={13} style={syncing ? { animation: "spin 1s linear infinite" } : undefined} />
                  {syncing ? t("Syncing…") : t("Sync with Riot")}
                </button>
                <p className="note">{t("Needs your Riot API key set in Settings.")}</p>
              </section>
            )}

            {/* ------------------------------------------------ objetivos */}
            {objectives.length > 0 && (
              <section>
                <div className="sect__head">
                  <span className="u-label">{t("Objectives")}</span>
                  <i className="sect__rule" />
                </div>
                {/* "Equipo Azul" no cabe en una columna de 40px: se parte en
                    dos lineas encima de las cifras. Aqui basta el color. Cada
                    fila lleva el glifo de la línea de tiempo, en oro. */}
                <div className="drow drow--3 insp__objLegend vp-obj__legend">
                  <span />
                  <span>{t("Blue")}</span>
                  <span>{t("Red")}</span>
                </div>
                {([
                  ["Dragons", "dragons", <IconDragon size={15} />],
                  ["Barons", "barons", <IconBaron size={15} />],
                  ["Heralds", "heralds", <IconHerald size={15} />],
                  ["Towers", "towers", <IconTower size={15} />],
                  ["Inhibitors", "inhibitors", <IconTower size={15} />],
                ] as const).map(([label, key, icon]) => {
                  const blue = objectives.find((o) => o.team_id === 100);
                  const red = objectives.find((o) => o.team_id === 200);
                  return (
                    <div key={key} className="drow drow--3 vp-obj">
                      <span className="vp-obj__name">
                        <span className="vp-obj__icon">{icon}</span>
                        {t(label)}
                      </span>
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
                      <span className="u-time vp-buy__time">{clock(ip.time)}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* Los cinco widgets de analítica vivían aquí dentro de un
                desplegable cerrado llamado "Más análisis". Esconder por defecto
                lo que ya has calculado es la forma más cara de no enseñarlo:
                nadie abre un cajón para averiguar si dentro hay algo.
                Ahora son secciones, abiertas, y en el orden en que se leen —
                cómo va la partida, luego los ganks, luego lo del mapa. Se pueden
                cerrar, y se quedan cerradas; que es distinto de nacer así. */}
            <InspSection id="trends" title={t("Trends on {champion}", { champion: match.champion })}>
              <PerformanceTrendsWidget currentMatch={match} />
            </InspSection>

            {/* Los ganks sólo cuando significan algo: un support al que le salen
                cero emboscadas no necesita una sección que le diga cero. */}
            {(isJungler || hasGankMarkers) && (
              <InspSection id="ganks" title={t("Ganks")}>
                <GankEfficiencyWidget
                  markers={match.timeline_markers}
                  gankImpact15={match.gank_impact_15}
                  onSeek={(secs) => seekTo(secs, false)}
                />
              </InspSection>
            )}

            <InspSection id="spikes" title={t("Power spikes")}>
              <PowerSpikeWidget
                itemPurchases={itemPurchases}
                markers={match.timeline_markers}
                ddragonVer={ddragonVer}
                onSeek={(secs) => seekTo(secs, false)}
              />
            </InspSection>

            <InspSection id="deaths-map" title={t("Deaths on the map")}>
              <TacticalMap
                markers={match.timeline_markers ?? []}
                onSeek={(secs) => seekTo(secs, false)}
              />
            </InspSection>

            <InspSection id="awareness" title={t("Map awareness before deaths")}>
              <MapAwarenessWidget
                cameraSnaps={cameraSnaps}
                markers={match.timeline_markers}
                onSeek={(secs) => seekTo(secs, false)}
              />
            </InspSection>

            {/* Las dos caras de la mecánica: qué te comes y cómo estabas
                clicando cuando te lo comiste. Van juntas y en este orden porque
                la primera plantea el problema y la segunda enseña la mano con
                la que lo resolviste (o no). */}
            <InspSection id="spells" title={t("Spells you ate")}>
              <SpellDietWidget matchId={match.id} onSeek={(secs) => seekTo(secs, false)} />
            </InspSection>

            <InspSection id="hand" title={t("Your hand")}>
              <HandWidget matchId={match.id} />
            </InspSection>

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
        {tab === "impact" && match.is_vod && (
          // La pestaña entera estaba condicionada a `!match.is_vod` sin decir
          // nada: en un VOD se abría vacía y parecía un fallo.
          <div className="insp">
            <EmptyState
              title={t("No impact for an imported VOD")}
              text={t("Impact needs a recorded game synced with Riot; imported VODs have no match data behind them.")}
            />
          </div>
        )}

        {tab === "impact" && !match.is_vod && (
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
                      {/* El "º" es la abreviatura ORDINAL española, y salía
                          igual con la interfaz en inglés ("3º"). */}
                      {puesto === 1 ? t("MVP") : t("#{n}", { n: puesto })}
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
                    <span className="u-label">{t("Total")}</span>
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
                  <>
                    <p className="note">{t("Couldn't work out the credit split: {msg}", { msg: creditsErr })}</p>
                    <button className="btn btn--ghost btn--sm" onClick={reintentar}>
                      <RefreshCw size={13} /> {t("Retry")}
                    </button>
                  </>
                ) : (
                  <>
                    <p className="note">
                      {t("Kill gold as the scoreboard hands it out (last hit) versus how it splits by damage actually dealt.")}
                    </p>
                    <div className="insp__legend u-label">
                      <span>{t("Player")}</span><span>{t("Gap")}</span><span>{t("Win %")}</span><span>{t("Vs. role")}</span>
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

            {/* --------------------------------------- dónde miraste
                El clic de minimapa lleva posición, así que la pregunta deja de
                ser "¿miraste?" y pasa a ser "¿miraste DÓNDE?". El hueco por
                carril es lo que se corrige jugando: un número global no dice
                hacia qué lado tienes el punto ciego. */}
            {zonas.length > 0 && (() => {
              const CARRILES: Record<string, string> = { top: "Top", mid: "Mid", bot: "Bot" };
              const masMirado = Math.max(...zonas.map((z) => z.per_minute), 0.01);
              const peor = zonas.reduce((a, b) => (b.longest_gap_secs > a.longest_gap_secs ? b : a));
              return (
                <section>
                  <div className="sect__head">
                    <span className="u-label">{t("Where you looked")}</span>
                    <i className="sect__rule" />
                  </div>
                  <p className="note">
                    {t("Your minimap clicks, by lane. The gap is the longest stretch you left that lane unwatched.")}
                  </p>
                  {zonas.map((z) => {
                    // Sólo se marca el PEOR. Con datos reales los tres huecos
                    // pasan de dos minutos, así que pintarlos todos de rojo era
                    // gritar sin decir cuál corregir.
                    const malo = z.key === peor.key && z.longest_gap_secs > 120;
                    return (
                      <div key={z.key} className="imp__row">
                        <span className="imp__rowName">{t(CARRILES[z.key] ?? z.key)}</span>
                        <span className="imp__track">
                          <span
                            className="imp__bar"
                            style={{
                              background: "var(--cool)",
                              width: `${(z.per_minute / masMirado) * 50}%`,
                              left: "50%",
                            }}
                          />
                        </span>
                        <span
                          className="u-metric imp__rowNum"
                          style={{ color: malo ? "var(--loss)" : "var(--muted)" }}
                          title={`${z.looks} ${t("looks")} · ${z.per_minute.toFixed(1)}/min`}
                        >
                          {clock(z.longest_gap_secs)}
                        </span>
                      </div>
                    );
                  })}
                  <p className="note">
                    {t("Longest blind spot")}: {t(CARRILES[peor.key] ?? peor.key)} · {clock(peor.longest_gap_secs)}
                  </p>
                </section>
              );
            })()}

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
                {mmErr !== null && <p className="note" style={{ color: "var(--loss)" }}>{mmErr}</p>}
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
              const mios = (pressure ?? []).filter(w => w.participant_id === yo).sort((a, b) => a.start - b.start);
              return (
                <section>
                  <div className="sect__head">
                    <span className="u-label">{t("Pressure you absorbed")}</span>
                    <i className="sect__rule" />
                  </div>
                  {/* El resumen de la partida: cuánto rival ataste y lo que valió en
                      total. Cada tarjeta de abajo es un sumando que se puede ver. */}
                  {mios.length > 0 && mios.some(w => w.value) ? (() => {
                    const neto = mios.reduce((a, w) => a + (w.value?.net ?? 0), 0);
                    const atado = mios.reduce((a, w) => a + (w.value?.enemy_seconds ?? 0), 0);
                    return (
                      <p className="pe-sum">
                        {t("They came for you {n} times. You tied up {time} of enemy time and it was worth {gold} gold in total.", {
                          n: mios.length,
                          time: formatSeconds(atado),
                          gold: formatGold(neto, true),
                        })}
                      </p>
                    );
                  })() : (
                    <p className="note">{t("When 2 or more enemies come for you: how long you kept them busy and what it was worth in gold.")}</p>
                  )}
                  {/* Tres estados distinguibles: fallo, vacio de verdad, y datos. */}
                  {pressureErr !== null && (
                    <>
                      <p className="note">{t("Couldn't load the pressure stretches: {msg}", { msg: pressureErr })}</p>
                      <button className="btn btn--ghost btn--sm" onClick={reintentar}>
                        <RefreshCw size={13} /> {t("Retry")}
                      </button>
                    </>
                  )}
                  {pressureErr === null && mios.length === 0 && (
                    <p className="note">{t("No stretches detected in this game.")}</p>
                  )}
                  {mios.map(w => <PressureEpisodeCard key={w.participant_id + ":" + w.start}
                    window={w} gameStart={w.game_start}
                    gameEnd={w.game_end}
                    onSeek={match.video_path ? time => seekTo(Math.max(0, time - 5), true) : undefined} />)}

                </section>
              );
            })()}
          </div>
        )}

        </aside>
        )}

      {/* Barra de acciones del recortador.
          Iba con estilos inline sobre alias heredados y colores escritos a mano
          (un `color: "white"`, un radio de 5px que no es ningún radio del
          sistema, una sombra propia). Ahora son tokens y los botones de verdad. */}
      {isClippingMode && (
        <div style={styles.clipBar}>
          <span style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
            {exportType === "clip" ? (
              <Scissors size={18} color="var(--cool)" />
            ) : (
              <AlertTriangle size={18} color="var(--loss)" />
            )}
            <span>
              <span style={styles.clipTitle}>
                {t(exportType === "clip" ? "Export video clip" : "Mark error")}
              </span>
              <span className="u-time" style={styles.clipRange}>
                {clock(clipStart)} – {clock(clipEnd)} ({Math.round(Math.max(0.1, clipEnd - clipStart))}s)
              </span>
            </span>
          </span>

          {exportType === "error" && (
            <input
              type="text"
              placeholder={t("Write a note about this mistake…")}
              value={errorNote}
              onChange={(e) => setErrorNote(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              style={styles.clipNote}
            />
          )}

          <button
            className={exportType === "clip" ? "btn btn--primary btn--sm" : "btn btn--danger btn--sm"}
            onClick={doExport}
            disabled={isExporting}
            style={{ marginLeft: "auto" }}
          >
            {isExporting
              ? t("Exporting…")
              : t(exportType === "clip" ? "Export clip" : "Export error")}
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => setIsClippingMode(false)}>
            {t("Cancel")}
          </button>
        </div>
      )}
      </div>
    </div>
  );
};
