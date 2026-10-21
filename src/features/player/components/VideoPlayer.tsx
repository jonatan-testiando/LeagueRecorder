import React, { useRef, useState, useEffect, useCallback } from "react";
import { MatchMetadata, MatchEvent, MouseEventData, Comment as MatchComment, Participant, ItemPurchase } from "../../../types";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { outcome, queueKey, lpDeltas } from "../../../core/matchStats";
import {
  ArrowLeft, Eye, EyeOff, Maximize, Play, Pause,
  VolumeX, Volume1, Volume2, Scissors, AlertTriangle, Flag, Check, RotateCcw,
  Trash2, FileText, ChevronDown,
  SkipBack, SkipForward, MoreHorizontal, VideoOff, FolderOpen, Pencil, X,
} from "lucide-react";
import { getAllErrorClips, getCameraLooks, getMatchDetails, saveMatchComments, setErrorClipReviewed, setEventReviewed, syncMatchNow, type CameraLook, type ErrorClipMetadata } from "../../../core/tauri-ipc";
import { analyzeCameraSnaps, getCameraSnapSummary, SnapSummary } from "../../training/api";
import { clock, relativeDay } from "../../../core/time";
import { formatDecimal } from "../../../core/benchmarkFormat";
import { RouteReplay } from "./RouteReplay";
import { EsportsPlayerOverlay } from "./EsportsPlayerOverlay";
import { MatchTab } from "./MatchTab";
import { ImpactTab } from "./ImpactTab";
import type { MapFocus, OpenMap } from "../mapFocus";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Button } from "../../../components/ui/Button";
import { Chip } from "../../../components/ui/Chip";
import { Segmented } from "../../../components/ui/Segmented";
import { Tabs } from "../../../components/ui/Tabs";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { useDialog } from "../../../components/ui/DialogProvider";
import { useVideoPlayback } from "../hooks/useVideoPlayback";
import { useMouseTrailCanvas } from "../hooks/useMouseTrailCanvas";
import { useClipExporter } from "../hooks/useClipExporter";
import {
  eventMeta, markOf, toneLabelAndIcon, ChampFace, IconFinding, type Tone, type MarkTone,
} from "./eventMeta";
import { buildQueue, analyzerFindings, type Moment, type Finding } from "./ReviewQueue";
import { describeEvent } from "../../../core/eventText";
import { individualEvents, eventChampion, withChampionNames } from "../../../core/matchEvents";
import { ddragonUrl } from "../../../core/ddragon";
import { useLang } from "../../../core/LanguageProvider";
import { useMatches } from "../../../store/useAppStore";
import { styles } from "./videoPlayerStyles";
import "./VideoPlayer.css";
import {
  DDRAGON_VER,
  streamUrl,
  smoothLinePath,
  CLIP_BEFORE,
  CLIP_AFTER,
} from "./videoPlayerUtils";

// Marcas de la línea de tiempo (Figma, «Marca de línea de tiempo»). El dibujo
// mide 10 px (el racimo, 26; con dos cifras, 33) y el botón 24 (auditoría
// A6). Dos marcas se funden en un racimo con número cuando sus dibujos
// quedarían a menos de 8 px, y nunca a menos de 20 entre centros: así los
// botones se pisan 4 px como mucho y cada uno conserva 20 propios. Con 24
// enteros, en una partida normal casi todo acababa en racimos. Las alturas de
// las filas viven en VideoPlayer.css (--tl-*): aquí solo hace falta el ancho.
const MARK_W = 10;
const CLUSTER_W = 26;
const CLUSTER_W2 = 33;
const MARK_AIR = 8;
const MIN_PITCH = 20;
/** Medio botón de un racimo (30 px), para no salirse de la pista. */
const CLUSTER_HALF = 15;
const HIT_HALF = 12;
/** Cuántos sucesos de un racimo se listan en su etiqueta. */
const CLUSTER_LIST = 5;
/** El tinte de un racimo: el que más pesa, y a igualdad, el que más importa
 *  revisar (una muerte antes que un objetivo). */
const TONE_ORDER: MarkTone[] = ["loss", "flag", "win", "brand", "neutral"];

/** Un elemento de la línea de tiempo: un suceso de la partida o un hallazgo. */
interface TimelineItem {
  key: string;
  time: number;
  ev?: MatchEvent;
  finding?: Finding;
}

/** Una marca dibujada: un suceso suelto o un racimo de los que se tocan. */
interface MarkGroup {
  items: TimelineItem[];
  /** Centro, en px desde el borde izquierdo de la pista. */
  x: number;
  tone: MarkTone;
}

const toneOfItem = (it: TimelineItem): MarkTone => (it.finding ? "flag" : markOf(it.ev as MatchEvent).tone);

/**
 * Menú de velocidad del transporte: un botón «1× velocidad» y la lista encima.
 * Sustituye al segmentado de cinco botones, que ocupaba 230 px y recortaba la
 * cabecera y el transporte a 1280 (auditoría I7).
 *
 * Es propio y no el `Select`: el menú del Select va en un portal a `body`, y en
 * pantalla completa solo se ve lo que cuelga del nodo que la ocupa. Este se
 * abre dentro del propio transporte, con la Elevación 1 de los menús.
 *
 * Teclado: ↑ ↓ Intro o Espacio lo abren sobre la velocidad actual; dentro, ↑ ↓
 * Inicio Fin mueven, Intro o Espacio eligen y Esc cierra. Las teclas que usa
 * no siguen hasta los atajos del reproductor (el espacio no pausa el vídeo).
 */
const SpeedMenu: React.FC<{ rate: number; onChange: (r: number) => void; format: (r: number) => string }> = ({
  rate,
  onChange,
  format,
}) => {
  const { t } = useLang();
  const menuId = `vp-speed-${React.useId().replace(/:/g, "")}`;
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const focusOnOpen = useRef<number | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const close = useCallback((refocus = false) => {
    setClosing(true);
    window.clearTimeout(timer.current);
    // La salida es un fundido de 100 ms (--t-quick-exit): se desmonta después.
    timer.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 100);
    if (refocus) btnRef.current?.focus();
  }, []);

  const openMenu = (focusIdx: number | null) => {
    window.clearTimeout(timer.current);
    focusOnOpen.current = focusIdx;
    setClosing(false);
    setOpen(true);
  };

  useEffect(() => {
    if (!open || closing || focusOnOpen.current === null) return;
    itemRefs.current[focusOnOpen.current]?.focus();
    focusOnOpen.current = null;
  }, [open, closing]);

  // Fuera de él, se cierra.
  useEffect(() => {
    if (!open || closing) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, closing, close]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const current = Math.max(0, SPEEDS.indexOf(rate));
  const choose = (r: number) => {
    onChange(r);
    close(true);
  };

  const onButtonKey = (e: React.KeyboardEvent) => {
    const isOpen = open && !closing;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      // Abierto con el ratón, el foco sigue en el botón: las flechas lo bajan.
      if (isOpen) itemRefs.current[current]?.focus();
      else openMenu(current);
    } else if (e.key === "Escape" && isOpen) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const onItemKey = (e: React.KeyboardEvent, i: number) => {
    const n = SPEEDS.length;
    const go = (j: number) => itemRefs.current[(j + n) % n]?.focus();
    switch (e.key) {
      case "ArrowDown": go(i + 1); break;
      case "ArrowUp": go(i - 1); break;
      case "Home": go(0); break;
      case "End": go(n - 1); break;
      case "Enter":
      case " ": choose(SPEEDS[i]); break;
      case "Escape": close(true); break;
      case "Tab": close(); return;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="vp-speed" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="vp-speed__btn"
        aria-haspopup="menu"
        aria-expanded={open && !closing}
        aria-controls={open ? menuId : undefined}
        title={t("Playback speed")}
        onClick={() => (open && !closing ? close() : openMenu(null))}
        onKeyDown={onButtonKey}
      >
        <ChevronDown size={16} className="vp-speed__chev" aria-hidden="true" />
        <span className="vp-speed__val">{format(rate)}</span>
        <span className="vp-speed__label">{t("speed")}</span>
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={t("Playback speed")}
          className="vp-speed__menu"
          data-closing={closing || undefined}
        >
          {SPEEDS.map((r, i) => (
            <button
              key={r}
              ref={(el) => { itemRefs.current[i] = el; }}
              type="button"
              role="menuitemradio"
              aria-checked={r === rate}
              tabIndex={-1}
              className="vp-speed__opt"
              onClick={() => choose(r)}
              onKeyDown={(e) => onItemKey(e, i)}
            >
              <span>{format(r)}</span>
              {r === rate && <Check size={14} className="vp-speed__check" aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

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

/** Velocidades del menú del transporte. */
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
  /** La marca o el racimo bajo el ratón (o con el foco): su etiqueta enseña
   *  los sucesos con el retrato, en vez del instante suelto. */
  const [hoverGroup, setHoverGroup] = useState<number | null>(null);
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
  const [itemPurchases, setItemPurchases] = useState<ItemPurchase[]>(match.item_purchases ?? []);
  /** Qué ocupa el escenario: el vídeo o el Mapa (el minimapa de la grabación
   *  ampliado junto al vídeo). El vídeo sigue sonando en los dos casos. */
  const [stage, setStageRaw] = useState<"video" | "route">("video");
  /** Lo que el Mapa enseña al abrirse desde una fila de Partida o Impacto. */
  const [mapFocus, setMapFocus] = useState<MapFocus | null>(null);
  const setStage = useCallback((next: "video" | "route" | ((x: "video" | "route") => "video" | "route")) => {
    setStageRaw((prev) => {
      const v = typeof next === "function" ? next(prev) : next;
      // Volver al vídeo cierra el foco: al reabrir el Mapa a mano se espera
      // el mapa de siempre, no la última invasión que se miró.
      if (v === "video") setMapFocus(null);
      return v;
    });
  }, []);
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

  /** Abre el Mapa en un momento: salta el vídeo un poco antes y reproduce,
   *  para ver llegar la jugada. Sin vídeo no hay minimapa que enseñar: salta
   *  sólo el tiempo (no hace nada visible, pero tampoco rompe). */
  const openMap: OpenMap = useCallback(
    (focus) => {
      const offset = match.video_offset ?? 0;
      if (hasVideo) {
        setMapFocus(focus);
        setStageRaw("route");
      }
      seekTo(Math.max(0, focus.t + offset - (focus.lead ?? 5)), true);
    },
    [hasVideo, match.video_offset, seekTo]
  );

  /**
   * Un solo reloj en todo el reproductor: el de la PARTIDA, el que se ve en el
   * HUD del juego. Antes la lista de Revisión, la regla y el transporte iban
   * en tiempo de vídeo y la pestaña Partida en tiempo de partida: el mismo gank
   * salía a las 9:13 en un sitio y a las 10:11 en otro (58 s de pantalla de
   * carga). Lo que se GUARDA y se busca sigue en tiempo de vídeo; esto es sólo
   * cómo se enseña. Antes de empezar la partida (la pantalla de carga) sale en
   * negativo.
   */
  const gameOffset = match.video_offset ?? 0;
  const gclock = useCallback(
    (videoSecs: number) => {
      const g = videoSecs - gameOffset;
      return g < 0 ? `−${clock(-g)}` : clock(g);
    },
    [gameOffset]
  );

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
      setItemPurchases(updated.item_purchases ?? []);
    } catch (e) {
      showError(t("Couldn't sync with Riot: {msg}", { msg: String(e) }));
    } finally {
      setSyncing(false);
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
    // En tiempo de PARTIDA (ver `gclock`): el 0 de la regla es el 00:00 del
    // juego, no el primer fotograma del vídeo. Se devuelven en tiempo de vídeo
    // para colocarlos.
    const juego = duration - gameOffset;
    const steps = [15, 30, 60, 120, 300, 600, 900]; // 15s..15min
    let step = steps.find((paso) => juego <= paso * 6) ?? Math.ceil(juego / 6);
    if (step <= 0) step = 15; // prevent infinite loop
    const marks: number[] = [];
    for (let t = 0; t < juego; t += step) marks.push(t + gameOffset);
    return marks;
  }, [duration, gameOffset]);
  
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

  /** Todas tus miradas al mapa (segundos de vídeo): saltos de cámara y clics
   *  de minimapa. La cola de Revisión y la pestaña Partida cuentan lo mismo. */
  const allLooks = React.useMemo(() => {
    // Las dos listas suelen ser los MISMOS clics (los saltos de cámara salen
    // de los clics de minimapa grabados; las miradas les añaden el carril):
    // sin quitar repetidos, "3 miradas al mapa" eran 6. Se unen por décima.
    const vistos = new Set<number>();
    const out: number[] = [];
    for (const t of [...cameraSnaps, ...cameraLooks.map((l) => l.t)]) {
      const k = Math.round(t * 10);
      if (vistos.has(k)) continue;
      vistos.add(k);
      out.push(t);
    }
    return out.sort((a, b) => a - b);
  }, [cameraSnaps, cameraLooks]);

  // --- Hallazgos del analizador -------------------------------------------
  // Lecturas de lo que hiciste sacadas de datos ya grabados (miradas al mapa,
  // saltos de cámara), no sucesos de Riot. Van en violeta en la línea de tiempo,
  // en la lista y, si son de los que avisan, sobre el propio vídeo.
  const findings = React.useMemo<Finding[]>(() => {
    const deaths = timedEvents
      .filter((e) => e.type === "ChampionKill" && e.subtype === "death")
      .map((e) => e.time);
    const looks = allLooks;
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
        case "r": if (hasVideo) { e.preventDefault(); setStage((x) => (x === "route" ? "video" : "route")); } break;
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

  // Marcas de la línea de tiempo: una forma pequeña por suceso y, cuando dos se
  // tocarían, un racimo con el número. Antes eran retratos de 20 px en dos
  // filas que se pisaban en cada pelea, con guías cruzadas hasta su instante
  // (auditoría V6); el retrato sale ahora en la etiqueta al pasar por encima.
  // La colocación se hace en píxeles: el solapamiento es un hecho de pantalla,
  // no de porcentaje, y depende de lo ancha que esté la ventana.
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

  const markGroups = React.useMemo<MarkGroup[]>(() => {
    if (!isFinite(duration) || duration <= 0) return [];
    const w = trackSize.w || 1000;
    const drawn = (n: number) => (n === 1 ? MARK_W : n < 10 ? CLUSTER_W : CLUSTER_W2);
    const half = (n: number) => (n === 1 ? HIT_HALF : CLUSTER_HALF);
    // Centro de un grupo: la media de sus instantes reales, dentro de la pista.
    const centro = (g: { n: number; sum: number }) =>
      Math.min(w - half(g.n), Math.max(half(g.n), g.sum / g.n));

    // Se funden los vecinos que se tocarían. Fundir corre el centro hacia la
    // media, que puede tocar al de detrás: por eso se vuelve un paso atrás
    // tras cada fusión. Cada vuelta quita un grupo, así que acaba. A
    // diferencia del empuje de antes, ninguna marca se aparta de su instante:
    // o está en su sitio o está dentro del racimo de su momento.
    const gs = timelineItems.map((it) => ({ items: [it], n: 1, sum: (it.time / duration) * w }));
    let i = 0;
    while (i < gs.length - 1) {
      const a = gs[i];
      const b = gs[i + 1];
      const pitch = Math.max(MIN_PITCH, (drawn(a.n) + drawn(b.n)) / 2 + MARK_AIR);
      if (centro(b) - centro(a) < pitch) {
        gs.splice(i, 2, { items: [...a.items, ...b.items], n: a.n + b.n, sum: a.sum + b.sum });
        i = Math.max(0, i - 1);
      } else {
        i++;
      }
    }

    return gs.map((g) => {
      const counts = new Map<MarkTone, number>();
      for (const it of g.items) {
        const tone = toneOfItem(it);
        counts.set(tone, (counts.get(tone) ?? 0) + 1);
      }
      const tone = TONE_ORDER.reduce((best, x) => ((counts.get(x) ?? 0) > (counts.get(best) ?? 0) ? x : best));
      return { items: g.items, x: centro(g), tone };
    });
  }, [timelineItems, duration, trackSize.w]);

  // Si cambia la colocación (otra ventana, otra partida), la etiqueta abierta
  // ya no señala al mismo racimo.
  useEffect(() => setHoverGroup(null), [markGroups]);

  const result = outcome(match.result);
  const isWin = result === "victory";

  // La estela del ratón vive en su hook: canvas, rAF y sincronía.
  const { canvasRef, mouseSync, updateMouseSync } = useMouseTrailCanvas(videoRef, match, mouseEvents);

  // --- Línea de tiempo ------------------------------------------------------
  // La tira ES la barra de búsqueda de este reproductor: en pantalla completa
  // también tiene que existir (sin ella no había forma de saltar a un minuto,
  // que fue lo que señaló el usuario). Allí va compacta, sin la curva de APM,
  // que taparía media imagen.
  //
  // Regla, curva y carriles son UNA superficie de búsqueda con un solo ancho
  // —el que mide `progressBarRef` para colocar las marcas—, así que pinchar en
  // cualquiera busca ese instante. Las alturas de las filas son de
  // VideoPlayer.css (--tl-*), que las comparte con los nombres de la izquierda.
  const hasLookStrip = duration > 0 && (cameraLooks.some((l) => l.lane) || cameraSnaps.length > 0);
  const pct = (secs: number) => `${(secs / duration) * 100}%`;

  /** Una fila de la etiqueta: la cara del campeón (o el glifo), la frase y la hora. */
  const tipRow = (it: TimelineItem) => {
    if (it.finding) {
      return (
        <div key={it.key} className="vp-tip__ev">
          <span className="vp-tip__glyph" style={{ color: "var(--flag)" }}>
            <IconFinding size={14} />
          </span>
          <span className="vp-tip__text">{it.finding.title}</span>
          <span className="t-time vp-tip__at">{gclock(it.time)}</span>
        </div>
      );
    }
    const ev = it.ev as MatchEvent;
    const meta = eventMeta(ev, 14);
    const champ = eventChampion(ev, participants);
    const desc = describeEvent(withChampionNames(ev, participants), t);
    const glyph = (
      <span className="vp-tip__glyph" style={{ color: meta.color }}>
        {meta.icon}
      </span>
    );
    return (
      <div key={it.key} className="vp-tip__ev">
        {champ ? <ChampFace champion={champ} size={20} className="vp-tip__face" fallback={glyph} /> : glyph}
        <span className="vp-tip__text">{desc || t(meta.label)}</span>
        <span className="t-time vp-tip__at">{gclock(ev.time)}</span>
      </div>
    );
  };

  /** Lo que dice una marca a un lector de pantalla. */
  const itemLabel = (it: TimelineItem) => {
    if (it.finding) return `${gclock(it.finding.time)} · ${it.finding.title}`;
    const ev = it.ev as MatchEvent;
    const desc = describeEvent(withChampionNames(ev, participants), t);
    return [`${gclock(ev.time)} · ${t(eventMeta(ev, 12).label)}`, desc].filter(Boolean).join(" – ");
  };

  const renderTrack = (compact: boolean) => {
    const w = trackSize.w || 1000;
    const group = hoverGroup !== null ? markGroups[hoverGroup] : undefined;
    // La etiqueta: la del racimo bajo el ratón (o con el foco) o, si no, la
    // del instante bajo el ratón. Pegada a un borde no cabe centrada: se ancla
    // por el lado que tiene sitio.
    const tipX = group ? group.x : hoverPct !== null ? hoverPct * w : null;
    const tipAlign = tipX === null || (tipX >= 120 && tipX <= w - 120) ? undefined : tipX < 120 ? "start" : "end";
    return (
      <div
        className={compact ? "vp-track vp-track--compact" : "vp-track"}
        data-looks={hasLookStrip || undefined}
        ref={progressBarRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
      >
        {/* Regla de minutos, en tiempo de partida y en mono de 12. El último
            rótulo es la duración, pegado a la derecha; el que lo pisaría se
            calla. */}
        <div className="vp-track__ruler">
          {axisMarks
            .filter((m) => ((duration - m) / duration) * w >= 68)
            .map((m) => (
              <span
                key={m}
                className="t-time"
                // El 00:00 del juego cae a unos segundos del borde (la pantalla
                // de carga): si no cabe centrado, se pega a la izquierda.
                data-edge={(m / duration) * w < 24 ? "start" : undefined}
                style={{ left: pct(m) }}
              >
                {gclock(m)}
              </span>
            ))}
          {duration > 0 && (
            <span className="t-time" data-edge="end" style={{ left: "100%" }}>
              {gclock(duration)}
            </span>
          )}
        </div>

        {/* Curva de APM: ambiental, una línea sin tinte. */}
        {!compact && apmSeries.length >= 2 && (
          <svg className="vp-track__apm" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <path d={apmLinePath} fill="none" stroke="var(--apm-line)" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
          </svg>
        )}

        {/* Sucesos: una marca por suceso o, si se tocarían, un racimo con su
            número. El dibujo mide 8-10 px y el botón 24 (A6). */}
        <div className="vp-track__lane">
          {duration > 0 &&
            markGroups.map((g, gi) => {
              const first = g.items[0];
              const common = {
                type: "button" as const,
                "data-tone": g.tone,
                "data-on": g.items.some((it) => it.time === activeEventTime) || undefined,
                style: { left: `${g.x}px` },
                onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
                onPointerEnter: () => setHoverGroup(gi),
                onPointerLeave: () => setHoverGroup((h) => (h === gi ? null : h)),
                onFocus: () => setHoverGroup(gi),
                onBlur: () => setHoverGroup((h) => (h === gi ? null : h)),
                // Un racimo salta a su primer suceso: desde ahí, N recorre el resto.
                onClick: (e: React.MouseEvent) => {
                  e.stopPropagation();
                  jumpToClip(first.time);
                },
              };
              if (g.items.length > 1) {
                return (
                  <button
                    key={first.key}
                    {...common}
                    className="vp-mark vp-mark--cluster"
                    aria-label={`${t("{n} moments", { n: g.items.length })}: ${g.items.map(itemLabel).join("; ")}`}
                  >
                    <span className="vp-mark__cluster">
                      <i aria-hidden="true" />
                      {g.items.length}
                    </span>
                  </button>
                );
              }
              return (
                <button
                  key={first.key}
                  {...common}
                  className="vp-mark"
                  data-shape={first.finding ? "diamond" : markOf(first.ev as MatchEvent).shape}
                  aria-label={itemLabel(first)}
                >
                  <i className="vp-mark__shape" aria-hidden="true" />
                </button>
              );
            })}
        </div>

        {/* Miradas al mapa. Los huecos anchos son exactamente los minutos en
            que no miraste.

            Tres carriles en vez de uno: con 250 miradas por partida una sola
            fila era un peine ilegible, y partirla por carril baja la densidad
            Y dice de qué lado tienes el punto ciego — el hueco se ve en su
            fila. De arriba abajo, top / mid / bot, como en el mapa. Las
            miradas que no caen en ningún carril (jungla profunda, base, o las
            teclas de cámara, que no saben adónde) no se pintan aquí. */}
        {hasLookStrip && (
          <div className="vp-track__looks" aria-hidden="true">
            {cameraLooks.some((l) => l.lane) ? (
              (["top", "mid", "bot"] as const).map((carril) => (
                <div key={carril} className="vp-track__looksRow">
                  {cameraLooks
                    .filter((l) => l.lane === carril)
                    .map((l, i) => (
                      <i key={i} style={{ left: pct(l.t) }} />
                    ))}
                </div>
              ))
            ) : (
              <div className="vp-track__looksRow">
                {cameraSnaps.map((s, i) => (
                  <i key={i} style={{ left: pct(s) }} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Cursor de reproducción, en oro. Lo mueven la mano o el vídeo: va
            sin transición, también en los saltos (latencia cero). */}
        <div className="vp-track__head" style={{ left: `${progressPct}%` }} />
        {hoverPct !== null && <div className="vp-track__hover" style={{ left: `${hoverPct * 100}%` }} />}

        {/* Etiqueta. Cuelga de la propia tira, que es a lo que se refiere: en
            `position: fixed` con una altura a fuego flotaba en mitad del vídeo
            en pantalla completa. */}
        {tipX !== null && (
          <div className="vp-tip" data-align={tipAlign} style={{ left: `${tipX}px` }}>
            {group ? (
              <>
                {group.items.slice(0, CLUSTER_LIST).map(tipRow)}
                {group.items.length > CLUSTER_LIST && (
                  <span className="vp-tip__more">{t("+{n} more", { n: group.items.length - CLUSTER_LIST })}</span>
                )}
              </>
            ) : (
              <div className="vp-tip__head">
                <span className="t-time">{gclock((hoverPct ?? 0) * duration)}</span>
                {apmSeries.length > 0 && (
                  <span className="vp-tip__apm">
                    {t("{n} APM", {
                      n: Math.round(apmSeries[Math.min(apmSeries.length - 1, Math.floor((hoverPct ?? 0) * apmSeries.length))]),
                    })}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Rango del recortador. Del color de lo que va a producir: jade si es
            un clip, rojo si es un error. */}
        {isClippingMode && duration > 0 && (
          <div
            className="vp-track__clip"
            data-kind={exportType}
            style={{ left: pct(clipStart), width: pct(clipEnd - clipStart) }}
          >
            <div className="vp-track__clipThumb" data-side="start" onPointerDown={(e) => handleThumbPointerDown(e, "start")} />
            <div className="vp-track__clipThumb" data-side="end" onPointerDown={(e) => handleThumbPointerDown(e, "end")} />
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
      <Eye size={16} aria-hidden="true" />
      <span className="u-metric">{formatDecimal(snapSummary.per_minute)}/min</span>
      <span aria-hidden="true">·</span>
      <span className="u-metric vp-looks__gap" data-long={snapSummary.longest_gap_secs > 120 || undefined}>
        {clock(snapSummary.longest_gap_secs)} {t("blind")}
      </span>
    </span>
  ) : (
    <button
      type="button"
      className="vp-tbtn"
      onClick={runSnapAnalysis}
      disabled={snapBusy}
      title={t("Scan the video for camera moves. Only needed for imported VODs: a game recorded here already knows this from your clicks and keys.")}
    >
      <Eye size={16} aria-hidden="true" />
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
        className="vp-tbtn vp-tbtn--skip"
        onClick={() => goToAdjacentEvent(-1)}
        title={t("Previous moment")}
        aria-label={t("Previous moment")}
        aria-keyshortcuts="P"
      >
        <SkipBack size={18} />
        <kbd className="u-kbd">P</kbd>
      </button>
      <button
        type="button"
        className="vp-tbtn vp-tbtn--skip"
        onClick={() => goToAdjacentEvent(1)}
        title={t("Next moment")}
        aria-label={t("Next moment")}
        aria-keyshortcuts="N"
      >
        <SkipForward size={18} />
        <kbd className="u-kbd">N</kbd>
      </button>

      {/* Centésimas: en una herramienta de revisión hace falta señalar un
          instante, no un minuto (las flechas , y . avanzan de fotograma). */}
      <span className="t-time vp-clock">
        {gclock(currentTime)}
        <span className="vp-clock__cs">
          .{String(Math.floor((Math.abs(currentTime - gameOffset) % 1) * 100)).padStart(2, "0")}
        </span>
        <span className="vp-clock__total"> / {duration > 0 ? gclock(duration) : clock(0)}</span>
      </span>

      <span className="vp-transport__fill" />

      {/* Lo primero que cede si no cabe: se queda en el icono. */}
      {!isFullscreen && <span className="vp-transport__aux">{lookStats}</span>}

      {/* Un botón «1× velocidad» con su menú: el segmentado de cinco botones
          ocupaba 230 px y era lo que recortaba el transporte a 1280. */}
      <SpeedMenu rate={playbackRate} onChange={setPlaybackRate} format={speedLabel} />

      <div className="tp-vol vp-vol">
        <button
          type="button"
          className="vp-tbtn vp-tbtn--icon"
          onClick={toggleMute}
          title={t(muted ? "Unmute" : "Mute")}
          aria-label={t(muted ? "Unmute" : "Mute")}
          aria-keyshortcuts="M"
        >
          {muted || volume === 0 ? <VolumeX size={18} /> : volume < 0.5 ? <Volume1 size={18} /> : <Volume2 size={18} />}
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
          <MoreHorizontal size={18} />
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
              <span className="tp-pop__val">{mouseSync > 0 ? `+${formatDecimal(mouseSync)}` : formatDecimal(mouseSync)} s</span>
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
        <Maximize size={18} />
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
  const day = relativeDay(match.date, t);
  const when = (() => {
    const d = new Date(match.date.replace(" ", "T"));
    if (Number.isNaN(d.getTime())) return day;
    return `${day} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  })();
  const queueText = match.is_vod ? null : t(queueKey(match.queue));
  // La duración de la PARTIDA, no la del vídeo (que suma la pantalla de carga).
  // `game_duration` guarda lo que duró la GRABACIÓN (30:40 con 58 s de
  // pantalla de carga): con el vídeo cargado manda la misma cuenta que el
  // transporte, para que no digan dos duraciones distintas.
  const durationText = duration > 0 ? gclock(duration) : clock(match.game_duration);
  // La línea se queda en cola, duración y día, que caben a 1280 sin cortarse
  // (auditoría I7: «7.º de 10 por…» se perdía). La hora y el puesto por
  // impacto van en la etiqueta al pasar por encima.
  const metaLine = [queueText, durationText, day].filter(Boolean).join(" · ");
  const metaDetail = [queueText, `${durationText} · ${when}`, rankText].filter(Boolean) as string[];
  const resultState = match.is_vod ? "vod" : result === "victory" ? "win" : result === "defeat" ? "loss" : undefined;
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
      <Chip tone={tone === "excellent" || tone === "good" ? "win" : tone === "mistake" || tone === "throw" ? "loss" : "neutral"}>
        {t(tl.text)}
      </Chip>
    );
  };
  // Las filas neutras (definitivas, placas…) no llevan chip: un «Info» en cada
  // una era ruido que tapaba los que sí dicen algo.
  const chipFor = (r: ReviewRow) =>
    r.finding ? (
      <Chip tone="finding">{t("Finding")}</Chip>
    ) : r.tone === "neutral" ? null : (
      toneBadge(r.tone)
    );

  return (
    <div className="vp" ref={vpRef}>
      <header className="vp-top">
        {onBack && (
          <button type="button" className="vp-iconbtn" onClick={onBack} title={t("Back")} aria-label={t("Back")}>
            <ArrowLeft size={18} />
          </button>
        )}
        <span className="vp-top__face">
          <ChampionAvatar champion={match.champion} size={32} />
        </span>
        <div className="vp-top__block">
          <div className="vp-top__title">
            <h2>{match.champion}</h2>
            {resultState && (
              <span className="vp-top__result" data-result={resultState}>
                {match.is_vod ? t("Imported VOD") : t(isWin ? "Victory" : "Defeat")}
              </span>
            )}
            {lpDelta != null && lpDelta !== 0 && (
              <Chip tone={lpDelta > 0 ? "win" : "loss"} className="vp-top__lp">
                {lpDelta > 0 ? "+" : "−"}{Math.abs(lpDelta)} LP
              </Chip>
            )}
          </div>
          {/* El detalle (hora, puesto por impacto) en una etiqueta: aparece
              tras 400 ms en reposo, o con el foco del teclado. */}
          <span className="vp-top__meta" tabIndex={0} aria-describedby="vp-top-detail">
            {metaLine}
          </span>
          <span className="vp-hint" id="vp-top-detail" role="tooltip">
            {metaDetail.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </span>
        </div>
        <span className="vp-top__fill" />
        {moments.length > 0 && (
          <div className="vp-top__progress">
            <span className="vp-top__progressText">
              {t("{done} of {total} reviewed", { done: doneCount, total: moments.length })}
            </span>
            <div
              className="vp-meter"
              role="progressbar"
              aria-label={t("Moments reviewed")}
              aria-valuemin={0}
              aria-valuemax={moments.length}
              aria-valuenow={doneCount}
              style={{ "--p": doneCount / moments.length } as React.CSSProperties}
            >
              <div />
            </div>
          </div>
        )}
        {hasVideo && (
          <div className="vp-top__actions">
            {/* Vídeo o Mapa, a la vista y no escondido en la barra de
                transporte: el Mapa es donde viven las estadísticas de mapa
                (cada fila de Partida e Impacto lo abre en su momento). */}
            <Segmented
              label={t("View")}
              value={stage}
              onChange={(v) => setStage(v)}
              options={[
                { value: "video", label: t("Video"), title: t("The video on its own") },
                {
                  value: "route",
                  label: (
                    <>
                      {t("Map")} <kbd className="u-kbd">R</kbd>
                    </>
                  ),
                  title: t("Your video next to your recording's minimap, with your trail and the waves"),
                },
              ]}
            />
            <Button
              className="vp-hbtn"
              icon={<Scissors size={16} aria-hidden="true" />}
              aria-pressed={isClippingMode && exportType === "clip"}
              aria-keyshortcuts="C"
              onClick={() => toggleClipMode("clip", currentTime, duration)}
              title={`${t("Export video clip")} ([ / ])`}
            >
              <span className="vp-hbtn__text">{t("Create clip")}</span>
              <kbd className="u-kbd">C</kbd>
            </Button>
            <Button
              className="vp-hbtn"
              icon={<Flag size={16} aria-hidden="true" />}
              aria-pressed={isClippingMode && exportType === "error"}
              aria-keyshortcuts="E"
              onClick={() => toggleClipMode("error", currentTime, duration)}
              title={t("Mark error")}
            >
              <span className="vp-hbtn__text">{t("Mark error")}</span>
              <kbd className="u-kbd">E</kbd>
            </Button>
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
          {/* El escenario: marino en los dos temas (auditoría V3) y con los
              tokens del tema oscuro dentro (`.stage-dark`), porque todo lo que
              va encima —HUD, avisos, el Mapa— se lee sobre el vídeo. */}
          <div className={hasVideo && stage === "route" ? "vp-video stage-dark vp-video--route" : "vp-video stage-dark"}>
            {/* Sin vídeo no se monta el elemento: un `<video src="">` dispara un
                error de carga y acabaríamos enseñando "el fichero está dañado"
                para una partida que nunca llegó a grabarse. Son dos cosas
                distintas y se dicen distinto. */}
            {hasVideo ? (
              <video
                ref={videoRef}
                src={videoSrc}
                className="vp-media"
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
              <div className="vp-veil">
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
            {hasVideo && loadState === "loading" && <div className="vp-veil"><div className="spinner" /></div>}
            {hasVideo && loadState === "error" && (
              <div className="vp-veil">
                <EmptyState
                  icon={<AlertTriangle size={30} color="var(--loss)" />}
                  title={t("The video file is missing or damaged")}
                  text={t("It was moved, deleted or written incomplete. Everything else about this game still works.")}
                  action={
                    <Button size="sm" icon={<FolderOpen size={14} aria-hidden="true" />} onClick={revealVideo}>
                      {t("Reveal in folder")}
                    </Button>
                  }
                />
              </div>
            )}
            {/* La estela del ratón va pegada al vídeo a pantalla completa: en el
                Recorrido el vídeo es una celda y no cuadraría. */}
            <canvas
              ref={canvasRef}
              className="vp-trail"
              data-hidden={!showTracker || undefined}
              data-off={stage === "route" || undefined}
            />

            {/* Overlay eSports Broadcast (HUD flotante sobre el vídeo) */}
            <EsportsPlayerOverlay
              currentTime={currentTime}
              match={currentMatch}
              visible={showEsportsHud && hasVideo && stage !== "route"}
            />

            {hasVideo && stage === "route" && (
              <RouteReplay
                matchId={match.id}
                videoRef={videoRef}
                onClose={() => setStage("video")}
                focus={mapFocus}
                onClearFocus={() => setMapFocus(null)}
                selfTeam={participants.find((p) => p.is_self)?.team_id}
                videoOffset={match.video_offset ?? 0}
              />
            )}

            {!isFullscreen && stage !== "route" && noticeEl}

            {isFullscreen && (
              <div className="vp-fs">
                {noticeEl}
                <div className="vp-fs__track">{renderTrack(true)}</div>
                {transportBar}
              </div>
            )}
          </div>

          {/* Línea de tiempo y transporte, debajo del vídeo. La tira ES la
              barra de búsqueda de este reproductor; a su izquierda, el nombre
              de cada fila. */}
          {!isFullscreen && hasVideo && (
            <>
              <section className="vp-tl" data-looks={hasLookStrip || undefined} aria-label={t("Game timeline")}>
                {/* El nombre de cada fila, a la altura de la suya (--tl-*). */}
                <div className="vp-tl__gutter" aria-hidden="true">
                  <span className="vp-tl__g" data-row="apm">{t("APM")}</span>
                  <span className="vp-tl__g" data-row="lane">{t("Events")}</span>
                  {hasLookStrip && <span className="vp-tl__g" data-row="looks">{t("Looks")}</span>}
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
          <div className="vp-resize" onPointerDown={startResize} title={t("Drag to resize")} />
          <Tabs
            className="vp-tabs"
            label={t("Game panels")}
            value={tab}
            onChange={setTab}
            tabs={[
              { value: "review", label: t("Review") },
              { value: "match", label: t("Game") },
              { value: "impact", label: t("Impact") },
            ]}
          />

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
              <div className="vp-filters">
                {/* El de 34 px (Figma): el pequeño dejaba las opciones en 22 de
                    alto, por debajo del área de clic de 24 (A6). */}
                <Segmented
                  label={t("Filter moments")}
                  value={eventFilter}
                  onChange={setEventFilter}
                  options={chips.map(([id, label, n, dot]) => ({
                    value: id,
                    label: t(label),
                    count: n,
                    icon: dot ? <i className="vp-filters__dot" style={{ background: dot }} aria-hidden="true" /> : undefined,
                  }))}
                />
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
                    <span className="u-time vp-feat__time">{gclock(featured.time)}</span>
                    <span className="vp-feat__kicker">{t("Current moment")}</span>
                    <span className="vp-feat__fill" />
                    {chipFor(featured)}
                  </div>
                  <h3 className="vp-feat__name">{featured.text}</h3>
                  <p className="vp-feat__desc">
                    {featured.detail || `${featured.label} · ${t("minute")} ${Math.max(0, Math.floor((featured.time - gameOffset) / 60))}`}
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
                        <span className="u-time vp-ev__time">{gclock(r.time)}</span>
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
                            aria-label={t("Reviewed: {what}", { what: `${gclock(r.time)} · ${r.text}` })}
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
                      {gclock(currentTime)}
                    </span>
                    <input
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") addComment(); }}
                      placeholder={t("What would you do differently here…")}
                      aria-label={t("Note for {time}", { time: gclock(currentTime) })}
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
                          {gclock(c.time)}
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

        {/* Partida: qué pasó. Ver MatchTab.tsx. */}
        {tab === "match" && (
          <MatchTab
            match={currentMatch}
            participants={participants}
            itemPurchases={itemPurchases}
            ddragonVer={ddragonVer}
            // Las mismas miradas que cuenta la cola de Revisión (saltos de
            // cámara + clics de minimapa): si no, "sin mirar el mapa" diría
            // una cosa aquí y otra allí.
            cameraSnaps={allLooks}
            syncing={syncing}
            onSync={handleSync}
            seekTo={seekTo}
            videoTime={currentTime}
            onOpenMap={openMap}
          />
        )}

        {/* Impacto: qué significó. Ver ImpactTab.tsx. */}
        {tab === "impact" && (
          <ImpactTab match={match} participants={participants} seekTo={seekTo} onOpenMap={openMap} />
        )}

        </aside>
        )}

      {/* Barra de acciones del recortador.
          Iba con estilos inline sobre alias heredados y colores escritos a mano
          (un `color: "white"`, un radio de 5px que no es ningún radio del
          sistema, una sombra propia). Ahora son tokens y los botones de verdad. */}
      {isClippingMode && (
        <div className="vp-clipbar" data-kind={exportType}>
          <span className="vp-clipbar__what">
            {exportType === "clip" ? (
              <Scissors size={18} className="vp-clipbar__icon" aria-hidden="true" />
            ) : (
              <AlertTriangle size={18} className="vp-clipbar__icon" aria-hidden="true" />
            )}
            <span>
              <span className="vp-clipbar__title">
                {t(exportType === "clip" ? "Export video clip" : "Mark error")}
              </span>
              <span className="t-time vp-clipbar__range">
                {gclock(clipStart)} – {gclock(clipEnd)} ({Math.round(Math.max(0.1, clipEnd - clipStart))} s)
              </span>
            </span>
          </span>

          {exportType === "error" && (
            <input
              type="text"
              className="vp-clipbar__note"
              placeholder={t("Write a note about this mistake…")}
              value={errorNote}
              onChange={(e) => setErrorNote(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              aria-label={t("Write a note about this mistake…")}
            />
          )}

          <Button
            size="sm"
            variant={exportType === "clip" ? "primary" : "danger"}
            className="vp-clipbar__go"
            onClick={doExport}
            loading={isExporting}
            loadingLabel={t("Exporting…")}
          >
            {t(exportType === "clip" ? "Export clip" : "Export error")}
          </Button>
          <Button size="sm" onClick={() => setIsClippingMode(false)}>
            {t("Cancel")}
          </Button>
        </div>
      )}
      </div>
    </div>
  );
};
