import React, { useRef, useState, useEffect, useCallback, useLayoutEffect } from "react";
import { MatchMetadata, MatchEvent, MouseEventData, Comment as MatchComment, Participant, ItemPurchase } from "../../../types";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { outcome, queueKey, lpDeltas } from "../../../core/matchStats";
import {
  ChevronRight, Eye, Maximize, Play, Pause,
  VolumeX, Volume1, Volume2, Scissors, AlertTriangle, Flag, Check, RotateCcw,
  Trash2, FileText, ChevronDown,
  SkipBack, SkipForward, MoreHorizontal, VideoOff, FolderOpen, Pencil, X,
} from "lucide-react";
import { getCameraLooks, getMatchDetails, saveMatchComments, syncMatchNow, type CameraLook, type MinuteSeries } from "../../../core/tauri-ipc";
import { analyzeCameraSnaps, getCameraSnapSummary, SnapSummary } from "../../training/api";
import { clock, relativeDay } from "../../../core/time";
import { formatDecimal } from "../../../core/benchmarkFormat";
import { RouteReplay } from "./RouteReplay";
import { EsportsPlayerOverlay } from "./EsportsPlayerOverlay";
import { MatchTab, type SeccionId } from "./MatchTab";
import { ImpactTab } from "./ImpactTab";
import { SummaryTab } from "./SummaryTab";
import type { MapFocus, OpenMap } from "../mapFocus";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Button } from "../../../components/ui/Button";
import { Chip } from "../../../components/ui/Chip";
import { Segmented } from "../../../components/ui/Segmented";
import { Tabs } from "../../../components/ui/Tabs";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { ScreenTitle } from "../../../components/ScreenTitle";
import { useDialog } from "../../../components/ui/DialogProvider";
import { useVideoPlayback } from "../hooks/useVideoPlayback";
import { useMouseTrailCanvas } from "../hooks/useMouseTrailCanvas";
import { useClipExporter } from "../hooks/useClipExporter";
import {
  eventMeta, markOf, sideOfEvent, toneLabelAndIcon, ChampFace,
  type Tone, type MarkTone,
} from "./eventMeta";
import { buildQueue, type Moment } from "./ReviewQueue";
import { formatSigned } from "./pressureFormat";
import { describeEvent } from "../../../core/eventText";
import { individualEvents, eventChampion, withChampionNames } from "../../../core/matchEvents";
import { ddragonUrl } from "../../../core/ddragon";
import { useLang } from "../../../core/LanguageProvider";
import { useAppStore, useErrorClips, useMatches } from "../../../store/useAppStore";
import { movimientoReducido, useCambio } from "../../../core/movimiento";
import { CabezaTira, HoverTira, type HoverTiraApi } from "./TiraEnVivo";
import { styles } from "./videoPlayerStyles";
import "./VideoPlayer.css";
import {
  DDRAGON_VER,
  streamUrl,
  CLIP_BEFORE,
  CLIP_AFTER,
} from "./videoPlayerUtils";
import {
  datosListos,
  olvidarPartida,
  precargarPartida,
  versionDdragonLista,
  versionDeDdragon,
  type DatosPartida,
} from "../datosPartida";

/** La lista vacía, siempre la misma: si un estado se pone a «vacío» y ya lo
 *  estaba, React no vuelve a pintar (con un `[]` nuevo, sí). */
const SIN: never[] = [];

/** El detalle manda en todo menos en los comentarios: si viene sin ellos se
 *  conservan los del listado en vez de vaciar la pestaña. */
const conDetalle = (m: MatchMetadata, full: MatchMetadata): MatchMetadata => ({
  ...full,
  comments: full.comments ?? m.comments,
});

/** Como useEffect, pero no al montar: solo cuando cambia algo de `deps`. Para
 *  lo que sigue a la partida de la lista y ya empezó bien al montar. */
function useAlCambiar(deps: unknown[], fn: () => void) {
  const antes = useRef(deps);
  useEffect(() => {
    const cambio = deps.some((d, i) => !Object.is(d, antes.current[i]));
    antes.current = deps;
    if (cambio) fn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// Línea de tiempo «a favor / en contra»: dos filas, arriba lo que salió bien
// (tus kills y asistencias, objetivos y torres de tu equipo) y abajo lo que
// salió mal (tus muertes, lo que se llevó el rival, los errores que marcaste),
// con la ventaja de oro del equipo entre las dos. Sustituye a una pista por tipo
// de suceso con APM, miradas y hallazgos: el usuario la encontraba confusa. En
// cada fila, una chapa por suceso: el glifo en tinta sobre el color de lo que
// fue. Dos chapas de la misma pista se funden en una con «×N» cuando quedarían
// a menos de 4 px, y nunca a menos de 22 entre centros: cada botón conserva
// sus 22 propios (A6). La colocación se hace en píxeles: el solapamiento es un
// hecho de pantalla y depende del ancho de la ventana. Las alturas de las
// filas viven en VideoPlayer.css (--tl-*): aquí solo hace falta el ancho.
const CHAPA_W = 18;
/** La chapa con «×N» (y con «×NN»). */
const CLUSTER_W = 36;
const CLUSTER_W2 = 42;
const MARK_AIR = 4;
const MIN_PITCH = 22;
/** Medio botón de un racimo, para no salirse de la pista. */
const CLUSTER_HALF = 21;
const HIT_HALF = 12;
/** Cuántos sucesos de un racimo se listan en su etiqueta. */
const CLUSTER_LIST = 5;
/** El tinte de un racimo: el que más pesa, y a igualdad, el que más importa
 *  revisar (una muerte antes que un objetivo). */
const TONE_ORDER: MarkTone[] = ["loss", "flag", "win", "brand", "neutral"];

/** Un elemento de la línea de tiempo: un suceso de la partida o un error que
 *  marcaste tú (un clip de error con su instante). */
interface TimelineItem {
  key: string;
  time: number;
  ev?: MatchEvent;
  error?: Moment;
}

/** Una marca dibujada: un suceso suelto o un racimo de los que se tocan. */
interface MarkGroup {
  items: TimelineItem[];
  /** Centro, en px desde el borde izquierdo de la pista. */
  x: number;
  tone: MarkTone;
  /** La fila donde va. */
  side: Side;
}

type Side = "for" | "against" | "ult";
/** Las filas, de arriba abajo; `label` es la clave de i18n. La de tus
 *  definitivas va debajo y fina, y solo si las hay: el usuario las echó de
 *  menos al quitar las pistas (2026-10-30), pero no son ni a favor ni en
 *  contra. */
const SIDES: { id: Side; label: string }[] = [
  { id: "for", label: "For you" },
  { id: "against", label: "Against you" },
  { id: "ult", label: "Your ult" },
];
/** De qué fila es un elemento (ver `sideOfEvent`); un error marcado, en
 *  contra; tus definitivas, en la suya. */
const sideOf = (it: TimelineItem): Side | null =>
  it.error ? "against" : it.ev?.type === "Ultimate" ? "ult" : sideOfEvent(it.ev as MatchEvent);
/** El tinte de una chapa: el de su lado; el error marcado, en el suyo; la
 *  definitiva, neutra. */
const toneOfItem = (it: TimelineItem): MarkTone => {
  if (it.error) return "flag";
  const s = sideOf(it);
  if (s === "ult") return "neutral";
  if (s === "against") return "loss";
  return markOf(it.ev as MatchEvent).tone === "brand" ? "brand" : "win";
};
/** El glifo de una chapa: el mismo que la fila del inspector. */
const glyphOf = (it: TimelineItem, size: number) =>
  it.error ? <Flag size={size} /> : eventMeta(it.ev as MatchEvent, size).icon;

/** «+2,1k», «−850»: la ventaja de oro en la etiqueta y junto a la curva. */
const goldShort = (v: number): string => {
  const r = Math.round(v);
  if (Math.abs(r) < 1000) return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r)}`;
  return `${formatSigned(r / 1000, 1)}k`;
};

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
  /** Explicación: la categoría de un error marcado. */
  detail: string;
  tone: Tone;
  bucket: Bucket;
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
  /** El nombre de esa lista, para la miga de la barra de título («Biblioteca › Gwen»). */
  backLabel?: string;
}


export const VideoPlayer: React.FC<VideoPlayerProps> = ({ match, onBack, backLabel }) => {
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
  /** La línea y la etiqueta bajo el ratón viven en HoverTira (TiraEnVivo.tsx):
   *  moverse por la tira no repinta el reproductor. */
  const hoverApi = useRef<HoverTiraApi>(null);
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
  // La pestaña por defecto es la de los momentos, no las estadísticas: al abrir
  // una partida lo que quieres saber es qué mirar, no cómo te fue.
  const { t, lang } = useLang();
  // Dos pestañas: Revisión (los sucesos y las notas: todo lo que se hace CON
  // el vídeo) y Resumen (lo que decidió la partida y lo que te costó, en
  // frases). Partida e Impacto eran dos pestañas más con tanto dato que no se
  // podían seguir en 450 px: su detalle vive ahora en la hoja de estadísticas,
  // que se abre ancha encima del vídeo. Sin vídeo, la revisión no lleva a
  // ningún sitio: se abre por el Resumen.
  const [tab, setTabRaw] = useState<"review" | "summary">(match.video_path ? "review" : "summary");
  const [tabN, setTabN] = useState(0);
  const setTab = useCallback((v: "review" | "summary") => {
    setTabRaw(v);
    setTabN((n) => n + 1);
  }, []);
  /** La hoja de estadísticas abierta, y en qué bloque; `n` hace que pedir dos
   *  veces el mismo bloque funcione. */
  const [stats, setStats] = useState<{ focus: SeccionId | null; n: number } | null>(null);


  // Lo que se pidió antes de abrir (datosPartida.ts): si ya llegó, el
  // reproductor se monta con todo y no se vuelve a pintar al recibirlo.
  const [alAbrir] = useState(() => datosListos(match.id));

  // Los momentos que merecen una mirada. Los errores que marcaste tú viven en
  // clips aparte: son los de la lista compartida (la de la galería de
  // Errores), ya cargada al arrancar. Antes se volvían a leer de disco en cada
  // apertura y llegaban tarde, con otro repintado.
  const { clips: todosLosErrores } = useErrorClips();
  const errorClips = React.useMemo(
    () => todosLosErrores.filter((c) => c.match_id === match.id),
    [todosLosErrores, match.id]
  );

  // La cola se recompone también al cambiar de idioma: los títulos llevan
  // nombres dentro ("Te mata Ahri"), así que se escriben aquí y no se pueden
  // traducir después. `match` entero en las deps: la cola sale de sus eventos y
  // sus saltos de cámara, no sólo de su id.
  const moments = React.useMemo<Moment[]>(() => buildQueue(match, errorClips, t), [match, errorClips, t]);

  // La ventaja de oro del equipo, minuto a minuto: la columna de la línea de
  // tiempo. Sale de la timeline de Riot guardada; sin ella (partida sin
  // sincronizar, VOD importado) la tira se queda en las dos filas.
  const [series, setSeries] = useState<MinuteSeries | null>(alAbrir?.serie ?? null);
  const [newComment, setNewComment] = useState<string>("");
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const v = parseInt(localStorage.getItem("reviewSidebarWidth") || "392", 10);
    return isNaN(v) ? 392 : Math.min(700, Math.max(300, v));
  });
  const [ddragonVer, setDdragonVer] = useState<string>(() => versionDdragonLista() ?? DDRAGON_VER);
  const [participants, setParticipants] = useState<Participant[]>(
    alAbrir?.detalle?.participants ?? match.participants ?? SIN
  );
  const [itemPurchases, setItemPurchases] = useState<ItemPurchase[]>(
    alAbrir?.detalle?.item_purchases ?? match.item_purchases ?? SIN
  );
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
  const [eventFilter, setEventFilter] = useState<"all" | "good" | "neutral" | "bad">("all");
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

  // La hoja de estadísticas. Al abrirla el vídeo se para: se lee con él quieto.
  // Lo que dentro de ella lleva al vídeo o al Mapa la cierra primero, porque
  // la hoja los tapa.
  const openStats = useCallback((block?: SeccionId) => {
    videoRef.current?.pause();
    setStats((s) => ({ focus: block ?? null, n: (s?.n ?? 0) + 1 }));
  }, [videoRef]);
  const closeStats = useCallback(() => {
    const el = sheetRef.current;
    if (!el || cerrandoHoja.current || document.documentElement.dataset.nav === "kbd" || movimientoReducido() || typeof el.animate !== "function") {
      setStats(null);
      return;
    }
    cerrandoHoja.current = true;
    const a = el.animate([{ transform: "none" }, { transform: "translateY(100%)" }], {
      duration: 200,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
      fill: "forwards",
    });
    a.onfinish = a.oncancel = () => {
      cerrandoHoja.current = false;
      setStats(null);
    };
  }, []);
  // La hoja sube como un cajón (VideoPlayer.css) y baja en 200 ms: la salida,
  // más corta. Con el teclado (Esc) se cierra al momento. Si se le pide otro
  // bloque estando abierta, lo de dentro cambia con un fundido corto.
  const sheetRef = useRef<HTMLElement>(null);
  const cerrandoHoja = useRef(false);
  useCambio(sheetRef, stats && stats.n > 1 ? stats.n : null, ":scope > :not(.vp-sheet__head)");
  const sheetSeek = useCallback(
    (videoSeconds: number, play: boolean) => {
      setStats(null);
      seekTo(videoSeconds, play);
    },
    [seekTo]
  );
  const sheetMap: OpenMap = useCallback(
    (focus) => {
      setStats(null);
      openMap(focus);
    },
    [openMap]
  );
  // En pantalla completa no hay hoja: se va con el panel de la derecha.
  useEffect(() => {
    if (isFullscreen) setStats(null);
  }, [isFullscreen]);
  // Otra partida, otra hoja: no se queda abierta la de la anterior.
  useEffect(() => setStats(null), [match.id]);
  // Si se llegó desde otra pantalla pidiendo un bloque (Tus clics), se abre
  // la hoja en él. Va después de cerrar la de la partida anterior.
  const pendingStats = useAppStore((s) => s.pendingStats);
  const setPendingStats = useAppStore((s) => s.setPendingStats);
  useEffect(() => {
    if (!pendingStats || isFullscreen) return;
    setPendingStats(null);
    openStats(pendingStats as SeccionId);
  }, [pendingStats, match.id, isFullscreen, openStats, setPendingStats]);

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

  // La estela del ratón (mouse_events) NO viene en el listado por rendimiento:
  // llega con el detalle (datosPartida.ts), en binario.
  const [currentMatch, setCurrentMatch] = useState<MatchMetadata>(() =>
    alAbrir?.detalle ? conDetalle(match, alAbrir.detalle) : match
  );
  const [mouseEvents, setMouseEvents] = useState<MouseEventData[]>(alAbrir?.estela ?? match.mouse_events ?? SIN);

  // Los comentarios NO tienen estado propio: se derivan de `currentMatch`, que es lo que se
  // persiste. Antes vivían a la vez en un useState, en currentMatch.comments y en el backend,
  // sincronizados a mano por dos efectos, y bastaba con que uno se quedara atrás para que la
  // lista mostrara algo distinto de lo guardado.
  const comments: MatchComment[] = currentMatch.comments ?? [];

  // Lo que sigue a la partida de la lista, solo cuando CAMBIA (al montar ya se
  // empezó con lo bueno: volver a ponerlo era un repintado más en la apertura).
  useAlCambiar([match], () => setCurrentMatch(match));
  useAlCambiar([match.id, match.participants, match.objectives], () => setParticipants(match.participants ?? SIN));
  // Las compras de objetos ya no vienen en la lista (solo en el detalle): al
  // cambiar de partida se vacían y las pone el detalle. Depender de
  // `match.item_purchases` las borraría cada vez que se refresca la lista.
  useAlCambiar([match.id], () => setItemPurchases(match.item_purchases ?? SIN));

  // Última versión de Data Dragon (para los iconos de items): una vez por sesión.
  useEffect(() => {
    if (versionDdragonLista()) return;
    let vivo = true;
    versionDeDdragon(ddragonUrl("/api/versions.json")).then((v) => {
      if (vivo && v) setDdragonVer(v);
    });
    return () => { vivo = false; };
  }, []);

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
      hoverApi.current?.set(pct);

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
    hoverApi.current?.set(null);
  };

  const handlePointerLeave = () => {
    if (!isDragging) hoverApi.current?.set(null);
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
  const [snapSummary, setSnapSummary] = useState<SnapSummary | null>(alAbrir?.saltos ?? null);
  const [snapBusy, setSnapBusy] = useState(false);
  const [snapPct, setSnapPct] = useState(0);
  const [cameraSnaps, setCameraSnaps] = useState<number[]>(match.camera_snaps ?? SIN);
  // Las mismas miradas, pero sabiendo a qué carril fue cada una.
  const [cameraLooks, setCameraLooks] = useState<CameraLook[]>(alAbrir?.miradas ?? SIN);

  // Si la lista trae saltos nuevos (el análisis de fondo acabó), el resumen y
  // las miradas se releen.
  useAlCambiar([match.camera_snaps], () => {
    setCameraSnaps(match.camera_snaps ?? SIN);
    getCameraSnapSummary(match.id).then(setSnapSummary).catch(() => setSnapSummary(null));
    getCameraLooks(match.id).then(setCameraLooks).catch(() => setCameraLooks(SIN));
  });

  // Todo lo que no viene en el listado, de una vez (datosPartida.ts): un solo
  // repintado cuando llega, y ninguno si llegó antes de abrir.
  const aplicado = useRef<string | null>(alAbrir ? match.id : null);
  const montadaCon = useRef(match.id);
  useEffect(() => {
    const id = match.id;
    const otra = montadaCon.current !== id;
    montadaCon.current = id;
    if (aplicado.current === id) {
      olvidarPartida(id);
      return;
    }
    const aplicar = (d: DatosPartida) => {
      aplicado.current = id;
      olvidarPartida(id);
      if (d.detalle) {
        setCurrentMatch(conDetalle(match, d.detalle));
        if (d.detalle.participants) setParticipants(d.detalle.participants);
        if (d.detalle.item_purchases) setItemPurchases(d.detalle.item_purchases);
      }
      setMouseEvents(d.estela ?? match.mouse_events ?? SIN);
      setSeries(d.serie);
      setCameraLooks(d.miradas);
      setSnapSummary(d.saltos);
    };
    // Otra partida con el reproductor abierto: si lo suyo ya está, entra de
    // golpe; si no, se vacía lo de la anterior mientras llega.
    const listos = datosListos(id);
    if (listos) {
      aplicar(listos);
      return;
    }
    if (otra) {
      setMouseEvents(match.mouse_events ?? SIN);
      setSeries(null);
      setCameraLooks(SIN);
      setSnapSummary(null);
    }
    let vivo = true;
    precargarPartida(id).then((d) => {
      if (vivo) aplicar(d);
    });
    return () => { vivo = false; };
    // Solo al cambiar de partida: `match` se lee para los comentarios del
    // listado, como hacía el efecto del detalle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match.id]);

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

  // La lista única de la línea de tiempo: los sucesos que caen de un lado o de
  // otro y los errores que marcaste, por orden. Es lo que colocan los racimos y
  // lo que recorren «momento anterior/siguiente».
  const timelineItems = React.useMemo<TimelineItem[]>(
    () =>
      [
        ...timedEvents.map((ev) => ({ key: `event:${ev.time}:${ev.type}:${ev.subtype ?? ""}`, time: ev.time, ev })),
        ...moments
          .filter((m) => m.source === "error")
          .map((m) => ({ key: m.id, time: m.time, error: m })),
      ]
        .filter((it: TimelineItem) => sideOf(it) !== null)
        .sort((a, b) => a.time - b.time),
    [timedEvents, moments]
  );

  // Una sola lista para la pestaña Revisión: lo MISMO que pinta la tira (los
  // sucesos de un lado o de otro, marcadores de Riot incluidos) y los errores
  // que marcaste. Las definitivas y los neutros se quedaron fuera de las dos:
  // eran casi la mitad de las filas y nadie las revisaba.
  const rows = React.useMemo<ReviewRow[]>(() => {
    const out: ReviewRow[] = timedEvents
      .filter((ev) => sideOfEvent(ev) !== null)
      .map((ev) => {
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
      });
    }
    return out.sort((a, b) => a.time - b.time);
  }, [timedEvents, moments, participants, t]);

  // Las filas de la lista, al abrir con animación, llegan un instante después:
  // el primer fotograma (el que hace esperar a la transición) sale sin ellas y
  // React las pinta justo detrás, mientras el panel aún entra casi
  // transparente. Con el teclado no hay animación ni espera: van a la vez.
  const [diferirFilas] = useState(() => document.documentElement.dataset.vt === "open");
  const filas = React.useDeferredValue(rows, diferirFilas ? SIN : rows);

  // El momento actual de la tarjeta: el elegido (una marca, una fila, las
  // flechas) o el suceso más cercano al cursor.
  const featured = React.useMemo<ReviewRow | undefined>(() => {
    const exact = rows.find((r) => r.time === activeEventTime);
    if (exact) return exact;
    let best: ReviewRow | undefined;
    let bestD = Infinity;
    for (const r of rows) {
      const d = Math.abs(r.time - currentTime);
      if (d <= FEATURED_NEAR && d < bestD) { best = r; bestD = d; }
    }
    return best;
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
    // `filas`: si se abrió con las filas aún por llegar, se recoloca cuando llegan.
  }, [featuredKey, tab, filas]);

  // Los LP que dio o quitó esta partida: la resta con la clasificatoria anterior
  // del mismo rango, la MISMA cuenta que enseñan la biblioteca y «Hoy».
  const { matches: library } = useMatches();
  const lpDelta = React.useMemo(() => lpDeltas(library).get(match.id), [library, match.id]);

  const goToAdjacentEvent = useCallback((dir: 1 | -1) => {
    // P y N recorren lo que salió a favor y en contra, no cada definitiva.
    const times = timelineItems.filter((it) => sideOf(it) !== "ult").map((it) => it.time);
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
  // Abrir una partida: la View Transition del store (el retrato vuela de la
  // fila a la miga) y, dentro, el panel de la derecha entra 18 px con la curva
  // de los cajones. Al cambiar de pestaña, lo de la pestaña se funde.
  useLayoutEffect(() => {
    const el = asideRef.current;
    if (!el || typeof el.animate !== "function" || document.documentElement.dataset.nav === "kbd") return;
    // El reproductor entero se funde (una capa: el vídeo va dentro sin que
    // nada se repinte) mientras el retrato vuela a la miga.
    vpRef.current?.animate(
      [
        { opacity: 0, transform: movimientoReducido() ? "none" : "scale(0.99)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 240, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "backwards" }
    );
    el.animate(
      [
        { opacity: 0, transform: movimientoReducido() ? "none" : "translateX(18px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 320, delay: 40, easing: "cubic-bezier(0.32, 0.72, 0, 1)", fill: "backwards" }
    );
  }, [match.id]);
  useCambio(asideRef, tabN > 0 ? tabN : null, ":scope > :not(.vp-resize):not(.tabs)");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Un diálogo abierto encima (el vídeo del récord de jungla, la paleta) se
      // queda sus teclas: si no, la barra espaciadora pausaba tu partida detrás.
      if (document.querySelector("[role=dialog][aria-modal=true]")) return;
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
          else if (stats) { e.preventDefault(); setStats(null); }
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
  }, [handlePlayPause, seekTo, goToAdjacentEvent, toggleFullscreen, setMuted, setClipBound, toggleClipMode, duration, hasVideo, videoRef, clipEndRef, stats]);

  // --- Ventaja de oro ------------------------------------------------------
  // Tu equipo menos el rival, minuto a minuto, colocada en tiempo de VÍDEO
  // (minuto de partida + pantalla de carga) para caer bajo las mismas marcas.
  const goldLead = React.useMemo(() => {
    if (!series || series.status !== "ok" || series.minutes.length < 2 || series.players.length === 0) return null;
    const me = series.players.find((p) => p.participant_id === series.self_id);
    const myTeam = me?.team_id ?? participants.find((p) => p.is_self)?.team_id ?? 100;
    const pts = series.minutes.map((m, i) => {
      let d = 0;
      for (const p of series.players) d += (p.team_id === myTeam ? 1 : -1) * (p.gold[i] ?? 0);
      return { t: m * 60 + gameOffset, d };
    });
    return pts;
  }, [series, participants, gameOffset]);
  /** La ventaja en un instante de vídeo, interpolada entre minutos. */
  const leadAt = useCallback(
    (videoSecs: number): number | null => {
      if (!goldLead || videoSecs < goldLead[0].t) return null;
      for (let i = 1; i < goldLead.length; i++) {
        const a = goldLead[i - 1];
        const b = goldLead[i];
        if (videoSecs <= b.t) return a.d + ((b.d - a.d) * (videoSecs - a.t)) / Math.max(1e-6, b.t - a.t);
      }
      return goldLead[goldLead.length - 1].d;
    },
    [goldLead]
  );

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

  // Cuántos sucesos tiene cada fila, para su nombre a la izquierda.
  const sideCount = React.useMemo(() => {
    const n: Record<Side, number> = { for: 0, against: 0, ult: 0 };
    for (const it of timelineItems) {
      const s = sideOf(it);
      if (s) n[s]++;
    }
    return n;
  }, [timelineItems]);
  /** Las filas que se pintan: la de las definitivas, solo si las hay. */
  const sidesShown = SIDES.filter((s) => s.id !== "ult" || sideCount.ult > 0);

  const markGroups = React.useMemo<MarkGroup[]>(() => {
    if (!isFinite(duration) || duration <= 0) return [];
    const w = trackSize.w || 1000;
    const drawn = (n: number) => (n === 1 ? CHAPA_W : n < 10 ? CLUSTER_W : CLUSTER_W2);
    const half = (n: number) => (n === 1 ? HIT_HALF : CLUSTER_HALF);
    // Centro de un grupo: la media de sus instantes reales, dentro de la pista.
    const centro = (g: { n: number; sum: number }) =>
      Math.min(w - half(g.n), Math.max(half(g.n), g.sum / g.n));

    // Cada fila funde lo suyo; en pantalla completa también van las dos.
    const out: MarkGroup[] = [];
    for (const side of SIDES.map((s) => s.id)) {
      // Se funden los vecinos que se tocarían. Fundir corre el centro hacia
      // la media, que puede tocar al de detrás: por eso se vuelve un paso
      // atrás tras cada fusión. Cada vuelta quita un grupo, así que acaba.
      // Ninguna chapa se aparta de su instante: o está en su sitio o está
      // dentro del racimo de su momento.
      const gs = timelineItems
        .filter((it) => sideOf(it) === side)
        .map((it) => ({ items: [it], n: 1, sum: (it.time / duration) * w }));
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
      for (const g of gs) {
        const counts = new Map<MarkTone, number>();
        for (const it of g.items) {
          const tone = toneOfItem(it);
          counts.set(tone, (counts.get(tone) ?? 0) + 1);
        }
        const tone = TONE_ORDER.reduce((best, x) => ((counts.get(x) ?? 0) > (counts.get(best) ?? 0) ? x : best));
        out.push({ items: g.items, x: centro(g), tone, side });
      }
    }
    return out;
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
  const pct = (secs: number) => `${(secs / duration) * 100}%`;

  // La curva de ventaja, en un lienzo de 0-100 de ancho y de −1 a 1 de alto
  // (arriba, vais por delante). La escala es la de la partida, con un suelo de
  // 3.000: una ventaja de 400 no tiene que llenar la banda.
  const goldPaths = React.useMemo(() => {
    if (!goldLead || duration <= 0) return null;
    const max = Math.max(3000, ...goldLead.map((p) => Math.abs(p.d)));
    const xy = goldLead.map((p) => [Math.min(100, (p.t / duration) * 100), -p.d / max] as const);
    const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(3)},${y.toFixed(4)}`).join(" ");
    const area = `M${xy[0][0].toFixed(3)},0 ${line.replace(/^M/, "L")} L${xy[xy.length - 1][0].toFixed(3)},0 Z`;
    return { line, area };
  }, [goldLead, duration]);

  /** Una fila de la etiqueta: la cara del campeón (o el glifo), la frase y la hora. */
  const tipRow = (it: TimelineItem) => {
    if (it.error) {
      return (
        <div key={it.key} className="vp-tip__ev">
          <span className="vp-tip__glyph" style={{ color: "var(--loss)" }}>
            <Flag size={14} />
          </span>
          <span className="vp-tip__text">{it.error.title}</span>
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
    if (it.error) return `${gclock(it.error.time)} · ${t("Flagged error")} – ${it.error.title}`;
    const ev = it.ev as MatchEvent;
    const desc = describeEvent(withChampionNames(ev, participants), t);
    return [`${gclock(ev.time)} · ${t(eventMeta(ev, 12).label)}`, desc].filter(Boolean).join(" – ");
  };

  /** La etiqueta del instante bajo el ratón: la hora y la ventaja de oro. */
  const etiquetaHover = useCallback(
    (p: number) => {
      const segundos = p * duration;
      const d = leadAt(segundos);
      return (
        <div className="vp-tip__head">
          <span className="t-time">{gclock(segundos)}</span>
          {d != null && (
            <span className="vp-tip__gold" data-side={d >= 0 ? "up" : "down"}>
              {t("{n} gold", { n: goldShort(d) })}
            </span>
          )}
        </div>
      );
    },
    [duration, leadAt, gclock, t]
  );

  const renderTrack = (compact: boolean) => {
    const w = trackSize.w || 1000;
    const group = hoverGroup !== null ? markGroups[hoverGroup] : undefined;
    // La etiqueta del racimo bajo el ratón (o con el foco); la del instante
    // bajo el ratón la pone HoverTira. Pegada a un borde no cabe centrada: se
    // ancla por el lado que tiene sitio.
    const tipX = group ? group.x : null;
    const tipAlign = tipX === null || (tipX >= 120 && tipX <= w - 120) ? undefined : tipX < 120 ? "start" : "end";
    return (
      <div
        className={compact ? "vp-track vp-track--compact" : "vp-track"}
        data-curve={(!compact && goldPaths) || undefined}
        data-ult={sideCount.ult > 0 || undefined}
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

        {/* La ventaja de oro de tu equipo, entre las dos filas: azul por
            encima de la raya (vais por delante), rojo por debajo. */}
        {!compact && goldPaths && (
          <svg className="vp-track__gold" viewBox="0 -1 100 2" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <clipPath id="vp-gold-up"><rect x="0" y="-1" width="100" height="1" /></clipPath>
              <clipPath id="vp-gold-down"><rect x="0" y="0" width="100" height="1" /></clipPath>
            </defs>
            <line className="vp-track__zero" x1="0" y1="0" x2="100" y2="0" vectorEffect="non-scaling-stroke" />
            <path d={goldPaths.area} className="vp-track__goldArea" data-side="up" clipPath="url(#vp-gold-up)" />
            <path d={goldPaths.area} className="vp-track__goldArea" data-side="down" clipPath="url(#vp-gold-down)" />
            <path d={goldPaths.line} className="vp-track__goldLine" data-side="up" clipPath="url(#vp-gold-up)" vectorEffect="non-scaling-stroke" />
            <path d={goldPaths.line} className="vp-track__goldLine" data-side="down" clipPath="url(#vp-gold-down)" vectorEffect="non-scaling-stroke" />
          </svg>
        )}

        {/* Los sucesos: arriba lo que salió a favor, abajo lo que salió en
            contra; en cada fila una chapa por suceso o, si se tocarían, un
            racimo con su número. */}
        {sidesShown.map((s) => (
          <div key={s.id} className="vp-track__lane" data-side={s.id}>
            {duration > 0 &&
              markGroups.map((g, gi) => {
                if (g.side !== s.id) return null;
                const first = g.items[0];
                const many = g.items.length > 1;
                return (
                  <button
                    key={first.key}
                    type="button"
                    className={many ? "vp-mark vp-mark--cluster" : "vp-mark"}
                    data-tone={g.tone}
                    data-on={g.items.some((it) => it.time === activeEventTime) || undefined}
                    // `--d`: dónde cae en la tira (0-1), para aparecer cuando
                    // la curva pasa por ahí al abrir la partida.
                    style={{ left: `${g.x}px`, "--d": (g.x / w).toFixed(3) } as React.CSSProperties}
                    aria-label={
                      many
                        ? `${t("{n} moments", { n: g.items.length })}: ${g.items.map(itemLabel).join("; ")}`
                        : itemLabel(first)
                    }
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerEnter={() => setHoverGroup(gi)}
                    onPointerLeave={() => setHoverGroup((h) => (h === gi ? null : h))}
                    onFocus={() => setHoverGroup(gi)}
                    onBlur={() => setHoverGroup((h) => (h === gi ? null : h))}
                    // Un racimo salta a su primer suceso: desde ahí, N recorre el resto.
                    onClick={(e) => {
                      e.stopPropagation();
                      jumpToClip(first.time);
                    }}
                  >
                    <span className="vp-chapa" aria-hidden="true">
                      {glyphOf(first, 11)}
                    </span>
                    {many && <span className="vp-mark__n">×{g.items.length}</span>}
                  </button>
                );
              })}
          </div>
        ))}

        {/* Cursor de reproducción, en oro. Lo mueven la mano o el vídeo: va
            sin transición, también en los saltos (latencia cero), y sigue al
            vídeo fotograma a fotograma sin pasar por React (TiraEnVivo.tsx). */}
        <CabezaTira videoRef={videoRef} duration={duration} />
        <HoverTira ref={hoverApi} ancho={w} oculta={!!group} etiqueta={etiquetaHover} />

        {/* Etiqueta. Cuelga de la propia tira, que es a lo que se refiere: en
            `position: fixed` con una altura a fuego flotaba en mitad del vídeo
            en pantalla completa. */}
        {group && tipX !== null && (
          <div className="vp-tip" data-align={tipAlign} style={{ left: `${tipX}px` }}>
            {group.items.slice(0, CLUSTER_LIST).map(tipRow)}
            {group.items.length > CLUSTER_LIST && (
              <span className="vp-tip__more">{t("+{n} more", { n: group.items.length - CLUSTER_LIST })}</span>
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

  // Cabecera de la pantalla: quién, cómo acabó y las dos acciones que producen un fichero (clip y error). Vivía en App.tsx con
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
  const chipFor = (r: ReviewRow) => (r.tone === "neutral" ? null : toneBadge(r.tone));

  return (
    <div className="vp" ref={vpRef}>
      {/* Quién y cómo acabó, en la barra de título (piel A): la miga vuelve a
          la lista. El detalle (hora, puesto por impacto) sale en una etiqueta
          tras 400 ms en reposo, o con el foco del teclado. */}
      <ScreenTitle
        title={
          <span className="crumb">
            {onBack && (
              <>
                <button type="button" className="crumb__back" onClick={onBack}>
                  {backLabel ?? t("Back")}
                </button>
                <ChevronRight size={16} className="crumb__sep" aria-hidden="true" />
              </>
            )}
            <span className="crumb__face" data-retrato-destino="">
              <ChampionAvatar champion={match.champion} size={22} />
            </span>
            <span className="crumb__name">{match.champion}</span>
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
          </span>
        }
        sub={
          <>
            <span className="vp-top__meta" tabIndex={0} aria-describedby="vp-top-detail">
              {metaLine}
            </span>
            <span className="vp-hint" id="vp-top-detail" role="tooltip">
              {metaDetail.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </span>
          </>
        }
      />

      {/* Encima del escenario, solo las herramientas: Vídeo | Mapa a la vista
          (el Mapa es donde viven las estadísticas de mapa; cada fila de
          Partida e Impacto lo abre en su momento) y las dos acciones. */}
      {(hasVideo || moments.length > 0) && (
        <header className="vp-top">
          {hasVideo && (
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
          )}
          <span className="vp-top__fill" />
          {hasVideo && (
            <div className="vp-top__actions">
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
      )}

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

            {isFullscreen && (
              <div className="vp-fs">
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
              <section
                className="vp-tl"
                data-curve={goldPaths ? "" : undefined}
                data-ult={sideCount.ult > 0 || undefined}
                aria-label={t("Game timeline")}
              >
                {/* El nombre de cada fila, a la altura de la suya (--tl-*), con
                    cuántos sucesos tiene; entre las dos, la ventaja de oro en
                    el instante del cursor. */}
                <div className="vp-tl__gutter" aria-hidden="true">
                  {sidesShown.map((s) => (
                    <span key={s.id} className="vp-tl__g vp-tl__lane" data-side={s.id}>
                      <i className="vp-tl__dot" />
                      <span className="vp-tl__name">{t(s.label)}</span>
                      <span className="vp-tl__n">{sideCount[s.id]}</span>
                    </span>
                  ))}
                  {goldPaths && (() => {
                    const d = leadAt(currentTime);
                    return (
                      <span className="vp-tl__g" data-row="gold">
                        <span className="vp-tl__name">{t("Gold")}</span>
                        {d != null && (
                          <span className="vp-tl__n vp-tl__gold" data-side={d >= 0 ? "up" : "down"}>
                            {goldShort(d)}
                          </span>
                        )}
                      </span>
                    );
                  })()}
                </div>
                {renderTrack(false)}
              </section>
              {transportBar}
            </>
          )}

          {/* La hoja de estadísticas: ancha, encima del vídeo, la línea de
              tiempo y el transporte. Los bloques de antes (Ventaja, Muertes,
              Jungla, Oro, Marcador) y el Impacto entero, con su barra. */}
          {stats && !isFullscreen && (
            <section ref={sheetRef} className="vp-sheet" aria-label={t("Game stats")}>
              <header className="vp-sheet__head">
                <h2 className="vp-sheet__title">{t("Game stats")}</h2>
                <span className="vp-sheet__fill" />
                <button type="button" className="vp-sbtn vp-sbtn--sm" onClick={closeStats} aria-keyshortcuts="Escape">
                  <X size={14} aria-hidden="true" />
                  {t("Close")}
                  <kbd className="u-kbd">Esc</kbd>
                </button>
              </header>
              <MatchTab
                key={match.id}
                match={currentMatch}
                participants={participants}
                itemPurchases={itemPurchases}
                ddragonVer={ddragonVer}
                // Las mismas miradas que cuenta la tira (saltos de cámara +
                // clics de minimapa): si no, "sin mirar el mapa" diría una
                // cosa aquí y otra allí.
                cameraSnaps={allLooks}
                syncing={syncing}
                onSync={handleSync}
                seekTo={sheetSeek}
                videoTime={currentTime}
                onOpenMap={sheetMap}
                mouseEvents={mouseEvents}
                showSummary={false}
                focus={stats.focus ? { id: stats.focus, n: stats.n } : null}
                extra={{
                  id: "match-impact",
                  title: t("Impact"),
                  node: (
                    <ImpactTab
                      match={currentMatch}
                      participants={participants}
                      syncing={syncing}
                      onSync={handleSync}
                      seekTo={sheetSeek}
                      onOpenMap={sheetMap}
                    />
                  ),
                }}
              />
            </section>
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
              { value: "summary", label: t("Summary") },
            ]}
          />

        {tab === "review" && (() => {
          const counts = { good: 0, neutral: 0, bad: 0 };
          rows.forEach((r) => { counts[r.bucket]++; });
          const shown = filas.filter((r) => eventFilter === "all" || r.bucket === eventFilter);
          // «Regulares» no cabe al ancho por defecto: sale cuando el panel es
          // ancho (se redimensiona desde su borde) o si ya está elegido. Sus
          // filas siguen todas bajo «Todas».
          const showNeutral = counts.neutral > 0 && (sidebarWidth >= 440 || eventFilter === "neutral");
          const chips: [typeof eventFilter, string, number, string | null][] = [
            ["all", "All", rows.length, null],
            ["good", "Good", counts.good, "var(--win)"],
            ["bad", "Bad", counts.bad, "var(--loss)"],
            ...(showNeutral ? [["neutral", "Neutral", counts.neutral, "var(--faint)"] as [typeof eventFilter, string, number, string | null]] : []),
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

              {/* La tarjeta del momento actual sólo aparece si hay algo elegido
                  o si el cursor está encima de un suceso: cuando de verdad se
                  refiere a algo. Con el primer suceso por defecto presidía la
                  pestaña el del minuto 2 como si fuera EL momento. */}
              {featured && (
                <section className="vp-feat" aria-label={t("Current moment")}>
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
                      data-enter-item
                      data-on={isActive || undefined}
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
                    </div>
                  );
                })}
                {shown.length === 0 && filas === rows && (
                  <div style={styles.emptyEvents}>
                    {rows.length === 0
                      ? t("No events recorded in this game.")
                      : t("No events match this filter.")}
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

        {/* Resumen: qué decidió la partida y qué te costó. Ver SummaryTab.tsx. */}
        {tab === "summary" && (
          <SummaryTab
            match={currentMatch}
            participants={participants}
            cameraSnaps={allLooks}
            syncing={syncing}
            onSync={handleSync}
            seekTo={seekTo}
            onOpenMap={openMap}
            onOpenStats={openStats}
          />
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
