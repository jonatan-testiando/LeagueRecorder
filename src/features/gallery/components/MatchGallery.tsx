import React, { useEffect, useState, useRef, useMemo } from "react";
import { MatchMetadata } from "../../../types";
import { computeKDA, outcome, formatDuration, lpDeltas, queueKey } from "../../../core/matchStats";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { rankLabel } from "../../../core/ddragon";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { PositionIcon, POSITION_LABEL, normalizePosition } from "../../../components/PositionIcon";
import { ROLE_FILTERS, matchRole, type RoleFilter } from "../../../core/patterns";
import { reviewProgress, type ReviewProgress } from "../../../core/review";
import { useAppStore, useErrorClips } from "../../../store/useAppStore";
import {
  ArrowDownWideNarrow,
  Check,
  ChevronDown,
  FolderOpen,
  Gamepad2,
  HardDrive,
  Link2Off,
  ListChecks,
  RefreshCw,
  Search,
  SearchX,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useDialog } from "../../../components/ui/DialogProvider";
import { useLang, useT } from "../../../core/LanguageProvider";
import { relativeDay } from "../../../core/time";
import { MatchDetailPanel } from "./MatchDetailPanel";
import { cap, fmtDec, kdaDe, laneRival, lpText, ordinal, ratioLabel, ratioTone, selfOf } from "./libraryShared";
import "./MatchGallery.css";

interface DiskSpaceInfo {
  used_bytes: number;
  total_bytes: number;
  /** Hueco real del volumen. 0 si el backend no pudo leerlo. */
  free_bytes?: number;
}

/** Filtro de estado. "defeats"/"unreviewed" son también los que pide "Hoy". */
type Filter = "all" | "unreviewed" | "wins" | "defeats";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unreviewed", label: "To review" },
  { key: "wins", label: "Wins" },
  { key: "defeats", label: "Losses" },
];

/** Orden de la lista. "Nota" es el percentil de impacto de la partida. */
type Sort = "newest" | "oldest" | "best" | "worst";

const SORTS: { key: Sort; label: string }[] = [
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
  { key: "best", label: "Best score" },
  { key: "worst", label: "Worst score" },
];

/** Milisegundos de la fecha de una partida, o 0 si no se puede leer. */
const fechaMs = (m: MatchMetadata): number => {
  const ms = new Date(m.date.replace(" ", "T")).getTime();
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * Por debajo de este ancho de ventana el panel de detalle no cabe: se oculta,
 * la lista ocupa todo y el clic abre la partida directamente, como antes del
 * maestro-detalle.
 */
const WIDE_QUERY = "(min-width: 1280px)";

function useWide(): boolean {
  const [wide, setWide] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(WIDE_QUERY).matches : true
  );
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

interface MatchGalleryProps {
  matches: MatchMetadata[];
  onSelectMatch: (match: MatchMetadata) => void;
  onDeleteMatch: (id: string) => void;
  /** Borrado por lotes con confirmación. Devuelve true si se llegó a borrar. */
  onDeleteMatches: (ids: string[]) => Promise<boolean>;
  isRecording: boolean;
  /** Motivo del último fallo al leer la biblioteca, en crudo. */
  loadError?: string | null;
  /** Vuelve a intentar la lectura. */
  onRetry?: () => void;
}

/* Alturas estimadas de las clases de fila. La real la mide `measureElement`;
   esto solo evita que el primer cuadro baile. */
const ALTO_FILA = 64;
const ALTO_DIA = 32;
const ALTO_MAS = 52;

type Row =
  | { kind: "day"; label: string; count: number; lp: number | null; key: string }
  | { kind: "match"; match: MatchMetadata; key: string }
  | { kind: "more"; hidden: number; key: string };

export const MatchGallery: React.FC<MatchGalleryProps> = ({
  matches,
  onSelectMatch,
  onDeleteMatch,
  onDeleteMatches,
  isRecording,
  loadError,
  onRetry,
}) => {
  // `null` hasta que el backend contesta: antes arrancaba en "0 / 100 GB", que
  // es un disco inventado.
  const [diskSpace, setDiskSpace] = useState<DiskSpaceInfo | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [sort, setSort] = useState<Sort>("newest");
  // Selección por lotes: se entra con el botón o con Ctrl/Shift+clic sobre una
  // fila, y mientras dura, el clic marca en vez de seleccionar.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // La fila SELECCIONADA (la que enseña el panel de detalle y abre Enter). No
  // es la selección por lotes de arriba: esa marca varias para borrarlas.
  const [currentId, setCurrentId] = useState<string | null>(null);
  const wide = useWide();
  const t = useT();
  const { lang } = useLang();
  const { showError } = useDialog();
  const setPendingSeek = useAppStore((s) => s.setPendingSeek);
  // Los errores que marcaste tú también cuentan como momentos a revisar, así
  // que hacen falta aquí para saber si una partida está revisada.
  const { clips: errorClips } = useErrorClips();

  const rootRef = useRef<HTMLDivElement>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  // Filtro pedido desde otra pantalla ("Ver todas" de Hoy). Se consume una vez
  // y se limpia: si se quedara puesto, volver a la biblioteca por el menú
  // reaplicaría un filtro que el usuario ya había quitado.
  const pendingFilter = useAppStore((s) => s.libraryFilter);
  const setPendingFilter = useAppStore((s) => s.setLibraryFilter);
  useEffect(() => {
    if (!pendingFilter) return;
    setFilter(pendingFilter as Filter);
    setRoleFilter("all");
    setQuery("");
    setPendingFilter(null);
  }, [pendingFilter, setPendingFilter]);

  /**
   * El avance de revisión de cada partida, calculado UNA vez.
   *
   * `reviewProgress` monta la cola de momentos de la partida (sucesos, saltos
   * de cámara y errores marcados), así que llamarla por fila y en cada render
   * era rehacer ese trabajo cientos de veces por scroll. La columna "Revisión"
   * y la cabecera leen de aquí.
   */
  const progreso = useMemo(() => {
    const out = new Map<string, ReviewProgress>();
    for (const m of matches) out.set(m.id, reviewProgress(m, errorClips));
    return out;
  }, [matches, errorClips]);
  const revisadas = useMemo(
    () => new Set([...progreso].filter(([, p]) => p.reviewed).map(([id]) => id)),
    [progreso]
  );

  /** Abre el explorador con el vídeo de la partida seleccionado. */
  const revelar = async (m: MatchMetadata) => {
    try {
      await revealItemInDir(m.video_path);
    } catch (e) {
      showError(t("Couldn't open the folder: {msg}", { msg: String(e) }));
    }
  };

  /** Abre el reproductor; con `seek`, en ese segundo del vídeo. */
  const abrir = (m: MatchMetadata, seek?: number) => {
    if (seek != null) setPendingSeek(seek);
    onSelectMatch(m);
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => {
    setSelected(new Set());
    setSelectMode(false);
  };

  const deleteSelected = async () => {
    if (await onDeleteMatches([...selected])) clearSelection();
  };

  const clearFilters = () => {
    setQuery("");
    setFilter("all");
    setRoleFilter("all");
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtradas = matches.filter((m) => {
      if (filter === "defeats" && outcome(m.result) !== "defeat") return false;
      if (filter === "wins" && outcome(m.result) !== "victory") return false;
      if (filter === "unreviewed" && revisadas.has(m.id)) return false;
      if (roleFilter !== "all" && matchRole(m) !== roleFilter) return false;
      if (!q) return true;
      const cola = queueKey(m.queue);
      return (
        m.champion.toLowerCase().includes(q) ||
        // Se busca contra las DOS: escribir "clasificatoria" con la interfaz en
        // español no encontraba nada porque solo se comparaba el inglés.
        cola.toLowerCase().includes(q) ||
        t(cola).toLowerCase().includes(q) ||
        m.date.toLowerCase().includes(q)
      );
    });

    // La lista llega ya ordenada de nueva a vieja; solo se reordena si se pide
    // otra cosa. Las partidas sin nota van al final en los órdenes por nota:
    // no tener nota no es tenerla baja.
    if (sort === "newest") return filtradas;
    const out = [...filtradas];
    if (sort === "oldest") out.sort((a, b) => fechaMs(a) - fechaMs(b));
    else {
      const dir = sort === "best" ? -1 : 1;
      out.sort((a, b) => {
        const pa = a.impact_percentile, pb = b.impact_percentile;
        if (pa == null && pb == null) return 0;
        if (pa == null) return 1;
        if (pb == null) return -1;
        return dir * (pa - pb);
      });
    }
    return out;
  }, [matches, query, filter, roleFilter, sort, t, revisadas]);

  // Cuántas hay de cada estado, para las píldoras. Sobre la biblioteca entera:
  // el número dice cuántas verás al pulsarla, no cuántas quedan en pantalla.
  const counts = useMemo(
    () => ({
      all: matches.length,
      unreviewed: matches.length - revisadas.size,
      wins: matches.filter((m) => outcome(m.result) === "victory").length,
      defeats: matches.filter((m) => outcome(m.result) === "defeat").length,
    }),
    [matches, revisadas]
  );

  // Candidatas de la limpieza rápida: revisadas (con notas) y con más de 30
  // días. Los VODs importados no entran: los trajo el usuario a mano.
  const viejasRevisadas = useMemo(() => {
    const corte = Date.now() - 30 * 24 * 3600 * 1000;
    return matches
      .filter((m) => !m.is_vod && revisadas.has(m.id))
      .filter((m) => {
        const ms = new Date(m.date.replace(" ", "T")).getTime();
        return Number.isFinite(ms) && ms < corte;
      })
      .map((m) => m.id);
  }, [matches, revisadas]);

  // LP que dio o quitó cada partida. El cálculo vive en `core/matchStats`: "Hoy"
  // enseña el mismo número para la última partida y no puede ser otra resta.
  const lpDelta = useMemo(() => lpDeltas(matches), [matches]);

  // Saldo de LP de cada día, sobre TODAS las partidas del día: el encabezado
  // dice cómo te fue el día, y eso no cambia porque filtres las derrotas.
  const lpPorDia = useMemo(() => {
    const out = new Map<string, number>();
    for (const m of matches) {
      const d = lpDelta.get(m.id);
      if (d == null) continue;
      const k = relativeDay(m.date, t);
      out.set(k, (out.get(k) ?? 0) + d);
    }
    return out;
  }, [matches, lpDelta, t]);

  const hayFiltro = filter !== "all" || roleFilter !== "all" || query.trim() !== "";
  const ocultas = matches.length - visible.length;

  /**
   * La lista que se pinta: cabeceras de día intercaladas entre las partidas.
   *
   * Van en la misma lista plana y no en un contenedor aparte porque la lista
   * está virtualizada: el virtualizador solo entiende un índice lineal.
   *
   * El agrupado es por tramos consecutivos, así que si algún día llegara
   * desordenado se vería como dos tramos en vez de mentir juntándolos.
   */
  const rows = useMemo(() => {
    const out: Row[] = [];
    // Agrupar por día solo tiene sentido con el orden cronológico. Ordenando por
    // nota, cada partida caería en su propia cabecera de día y la lista se
    // llenaría de separadores de una fila.
    if (sort === "best" || sort === "worst") {
      out.push(...visible.map((m) => ({ kind: "match" as const, match: m, key: m.id })));
    } else {
      let i = 0;
      while (i < visible.length) {
        const label = relativeDay(visible[i].date, t);
        let j = i;
        while (j < visible.length && relativeDay(visible[j].date, t) === label) j++;
        out.push({ kind: "day", label, count: j - i, lp: lpPorDia.get(label) ?? null, key: `day-${label}-${i}` });
        for (let k = i; k < j; k++) {
          out.push({ kind: "match", match: visible[k], key: visible[k].id });
        }
        i = j;
      }
    }
    // Al final, cuántas deja fuera el filtro y la salida para verlas.
    if (hayFiltro && ocultas > 0 && visible.length > 0) {
      out.push({ kind: "more", hidden: ocultas, key: "more" });
    }
    return out;
  }, [visible, sort, t, lpPorDia, hayFiltro, ocultas]);

  /**
   * La fila seleccionada, resuelta contra lo que se ve.
   *
   * Si la elegida desaparece porque se BORRÓ, se pasa a la que ocupa su hueco
   * (la siguiente), que es lo que espera quien borra varias seguidas con Supr.
   * Si solo la oculta un filtro, se vuelve a la primera.
   */
  const idxRef = useRef(0);
  const current = useMemo(() => {
    if (visible.length === 0) return null;
    const found = currentId ? visible.find((m) => m.id === currentId) : undefined;
    if (found) return found;
    if (currentId && !matches.some((m) => m.id === currentId)) {
      return visible[Math.min(idxRef.current, visible.length - 1)];
    }
    return visible[0];
  }, [visible, currentId, matches]);
  useEffect(() => {
    if (current) idxRef.current = visible.indexOf(current);
  }, [current, visible]);

  // Las rutas de la app se ocultan con display:none SIN desmontarse. Si llega
  // una partida mientras la biblioteca está oculta, el virtualizador mide las
  // filas a altura 0 y los desplazamientos quedan corruptos al volver: las más
  // recientes "desaparecen" hasta un Ctrl+R o hasta entrar y salir de una
  // partida (que sí remonta este componente). Al volver a ser visible, se
  // remide todo.
  const anchoPrevio = useRef(0);
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (anchoPrevio.current === 0 && w > 0) {
        // Si la lista se montó ya oculta (abrir una partida desde Hoy o desde
        // el mapa de muertes de Patrones monta /review con la galería en
        // display:none), el virtualizador se queda con su rect interno a 0 y
        // su propio observer no siempre lo repone al reaparecer: la lista
        // vuelve VACÍA aunque el contenedor mida bien. Se le escribe el rect
        // real antes de remedir, que es la única pieza que no repone measure().
        rowVirtualizer.scrollRect = { width: w, height: el.clientHeight };
        // measure() limpia la caché, pero los elementos que SIGUIERON montados
        // bajo display:none no se vuelven a medir solos (su observer interno
        // ya disparó antes del reset) y se quedan en la estimación. Tras el
        // reset, se remiden a mano los que están en el DOM.
        rowVirtualizer.measure();
        requestAnimationFrame(() => {
          el.querySelectorAll("[data-index]").forEach((n) =>
            rowVirtualizer.measureElement(n as HTMLElement)
          );
        });
      }
      anchoPrevio.current = w;
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    // Clave ESTABLE por fila: sin ella las medidas se cachean por índice y al
    // borrar una partida todo lo de debajo cambia de índice y hereda la altura
    // de otra fila (una fila con la medida de un separador se pisa con la
    // siguiente — el bug que vio el usuario al eliminar).
    getItemKey: (index) => rows[index].key,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) =>
      rows[index].kind === "day" ? ALTO_DIA : rows[index].kind === "more" ? ALTO_MAS : ALTO_FILA,
    overscan: 8,
  });

  /* ---------------------------------------------------------------- teclado
     ↑/↓ mueven la fila seleccionada, Enter la abre (o la marca, en modo de
     selección), Supr la borra con la confirmación de siempre. Escucha en la
     ventana para que funcione nada más llegar, sin tener que hacer clic en la
     lista, pero solo con la biblioteca a la vista y sin un diálogo delante. */
  const focusPending = useRef(false);
  const mover = (delta: number) => {
    if (visible.length === 0) return;
    const i = current ? visible.indexOf(current) : -1;
    const next = visible[Math.max(0, Math.min(visible.length - 1, i + delta))];
    setCurrentId(next.id);
    const rowIdx = rows.findIndex((r) => r.kind === "match" && r.match.id === next.id);
    if (rowIdx >= 0) {
      // Subiendo, se enseña también el encabezado del día si va justo encima.
      const conDia = delta < 0 && rows[rowIdx - 1]?.kind === "day" ? rowIdx - 1 : rowIdx;
      rowVirtualizer.scrollToIndex(conDia, { align: "auto" });
    }
    focusPending.current = true;
  };
  const teclado = useRef({
    mover,
    enter: () => {},
    espacio: () => {},
    borrar: () => {},
  });
  teclado.current = {
    mover,
    enter: () => {
      if (!current) return;
      if (selectMode) toggleSelected(current.id);
      else abrir(current);
    },
    espacio: () => {
      if (current && selectMode) toggleSelected(current.id);
    },
    borrar: () => {
      if (selectMode && selected.size > 0) deleteSelected();
      else if (current) onDeleteMatch(current.id);
    },
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || root.offsetParent === null) return;
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (document.querySelector('[role="dialog"]')) return;
      const tgt = e.target instanceof HTMLElement ? e.target : null;
      const enCuerpo = !tgt || tgt === document.body;
      if (!enCuerpo && !root.contains(tgt)) return;
      if (tgt?.closest("input, textarea, select, [contenteditable='true']")) return;
      const enFila = !!tgt?.closest(".lib-tr");
      // Enter y Espacio sobre un botón son de ese botón.
      const enControl = !enFila && !!tgt?.closest("button, a, label");
      switch (e.key) {
        case "ArrowDown":
        case "ArrowUp":
          e.preventDefault();
          teclado.current.mover(e.key === "ArrowDown" ? 1 : -1);
          break;
        case "Enter":
          if (enControl) return;
          e.preventDefault();
          teclado.current.enter();
          break;
        case " ":
          if (enControl) return;
          e.preventDefault();
          teclado.current.espacio();
          break;
        case "Delete":
          e.preventDefault();
          teclado.current.borrar();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Tras mover con el teclado, el foco va a la fila nueva (cuando el
  // virtualizador ya la ha pintado).
  useEffect(() => {
    if (!focusPending.current || !current) return;
    focusPending.current = false;
    requestAnimationFrame(() => {
      const el = parentRef.current?.querySelector<HTMLElement>(
        `[data-match-id="${CSS.escape(current.id)}"]`
      );
      el?.focus({ preventScroll: true });
    });
  }, [current]);

  useEffect(() => {
    invoke<DiskSpaceInfo>("get_disk_usage")
      .then(setDiskSpace)
      .catch(console.error);
  }, [matches]);

  const GB = 1024 * 1024 * 1024;
  const usedGb = diskSpace ? (diskSpace.used_bytes / GB).toFixed(0) : "—";
  const totalGb = diskSpace ? (diskSpace.total_bytes / GB).toFixed(0) : "—";
  // El hueco real del disco: el MISMO número que enseña el pie del rail.
  const freeGb = diskSpace?.free_bytes ? (diskSpace.free_bytes / GB).toFixed(0) : null;
  const pct = diskSpace && diskSpace.total_bytes > 0
    ? Math.min(100, Math.round((diskSpace.used_bytes / diskSpace.total_bytes) * 100))
    : null;
  // El disco solo pide atención cuando queda poco. Por debajo del 85% es un
  // dato, no un aviso, y se pinta apagado.
  const diskTight = pct !== null && pct >= 85;

  // La MISMA definición que usa el reproductor y "Hoy" (ver `core/review.ts`):
  // la cabecera decía "revisada" con una nota suelta mientras la cola de
  // revisión de esa partida seguía con veinte momentos sin tachar.
  const reviewed = revisadas.size;
  const porRevisar = matches.length - reviewed;

  // Clic: selecciona (con el panel a la vista) o abre (sin él, como siempre).
  // Ctrl/Shift+clic marca para el lote aunque no esté el modo activo (y lo
  // enciende); dentro del modo, el clic normal también marca.
  const onRowClick = (m: MatchMetadata, e: React.MouseEvent) => {
    const conModificador = e.ctrlKey || e.metaKey || e.shiftKey;
    setCurrentId(m.id);
    if (selectMode || conModificador) {
      if (!selectMode) setSelectMode(true);
      toggleSelected(m.id);
      return;
    }
    if (!wide) abrir(m);
  };
  const onRowDoubleClick = (m: MatchMetadata) => {
    if (selectMode || !wide) return;
    abrir(m);
  };

  const sortLabel = t(SORTS.find((s) => s.key === sort)!.label);

  return (
    <div ref={rootRef} className={`lib panel-enter${wide ? "" : " lib--narrow"}`}>
      {/* Cabecera: título, censo y el disco en una línea. */}
      <div className="lib-head">
        <h1>{t("Library")}</h1>
        <span className="lib-head__sub">
          {matches.length} {t("games")} · {reviewed} {t("reviewed")} · {porRevisar} {t("to review")}
        </span>
        <div className="lib-head__right">
          {isRecording && (
            <span className="lib-recording">
              <span className="rec-dot" /> {t("Recording")}
            </span>
          )}
          {/* Con el disco ajustado, la salida rápida: lo ya revisado y viejo es
              lo único que se puede borrar sin perder nada por aprender. */}
          {diskTight && viejasRevisadas.length > 0 && (
            <button type="button" className="lib-tool" onClick={() => onDeleteMatches(viejasRevisadas)}>
              <Trash2 size={14} aria-hidden />
              {t("Delete reviewed games older than 30 days")} · {viejasRevisadas.length}
            </button>
          )}
          <span
            className={`lib-disk${diskTight ? " lib-disk--tight" : ""}`}
            title={`${t("Disk")}: ${usedGb} ${t("of")} ${totalGb} GB · ${pct === null ? "—" : `${pct} %`}`}
          >
            <HardDrive size={15} aria-hidden />
            {t("{n} GB in recordings", { n: usedGb })}
            {freeGb && <> · {t("{n} GB free", { n: freeGb })}</>}
          </span>
        </div>
      </div>

      {/* Una fila: estado · puesto · campeón · orden · seleccionar. */}
      <div className="lib-filters">
        <div className="lib-seg" role="group" aria-label={t("Filter by status")}>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className="lib-seg__btn"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {t(f.label)}
              <span className={`lib-seg__n${f.key === "unreviewed" ? " lib-seg__n--gold" : ""}`}>
                {counts[f.key]}
              </span>
            </button>
          ))}
        </div>

        <span className="lib-sep" aria-hidden />

        {/* Filtro por puesto, con los iconos del cliente. El puesto llega con
            la sincronización de Riot, así que las partidas sin él solo
            aparecen sin filtro. Pulsar el activo lo quita. */}
        <div className="lib-pos" role="group" aria-label={t("Filter by position")}>
          {ROLE_FILTERS.filter((r) => r.key !== "all").map((r) => (
            <button
              key={r.key}
              type="button"
              className="lib-pos__btn"
              aria-pressed={roleFilter === r.key}
              aria-label={t(r.label)}
              title={t(r.label)}
              onClick={() => setRoleFilter(roleFilter === r.key ? "all" : r.key)}
            >
              <PositionIcon position={r.key} size={18} />
            </button>
          ))}
        </div>

        <label className="lib-search">
          <Search size={14} aria-hidden />
          <input
            type="search"
            placeholder={t("champion, queue, date…")}
            aria-label={t("Filter games")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        <span className="lib-grow" aria-hidden />

        {/* Orden. La nota es lo único de la fila que separa una partida buena de
            una mala, así que ordenar por ella es lo que convierte la lista en
            "enséñame lo peor", que es a lo que se viene. */}
        <label className="lib-sort">
          <ArrowDownWideNarrow size={15} aria-hidden className="lib-sort__ico" />
          <span>{sortLabel}</span>
          <ChevronDown size={14} aria-hidden className="lib-sort__chev" />
          <select aria-label={t("Sort")} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>{t(s.label)}</option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="lib-tool"
          aria-pressed={selectMode}
          title={t("Select several games to delete them at once")}
          onClick={() => (selectMode ? clearSelection() : setSelectMode(true))}
        >
          <ListChecks size={15} aria-hidden />
          <span className="lib-tool__txt">{t("Select")}</span>
        </button>
      </div>

      {/* La biblioteca no pudo leerse. Se dice, con salida: sin esto la pantalla
          enseñaba "Aún no hay partidas grabadas", que es una respuesta distinta
          y hace pensar que se han perdido. */}
      {loadError && (
        <div className="lib-notice">
          <TriangleAlert size={14} color="var(--signal)" />
          <span style={{ flex: 1, minWidth: 0 }}>
            {t("Couldn't load your games: {msg}", { msg: loadError })}
          </span>
          {onRetry && (
            <Button variant="ghost" size="sm" icon={<RefreshCw size={13} />} onClick={onRetry}>
              {t("Retry")}
            </Button>
          )}
        </div>
      )}

      {/* Maestro-detalle: la lista a la izquierda y la partida seleccionada a
          la derecha. */}
      <div className="lib-md">
        <div className="lib-master">
          <section className="lib-card" aria-label={t("Library")}>
            {visible.length > 0 && (
              <div className="lib-grid lib-th" aria-hidden>
                <span />
                <span>{t("Game")}</span>
                <span>{t("Result")}</span>
                <span>{t("KDA")}</span>
                <span>{t("CS")}</span>
                <span className="lib-col-rival">{t("Lane opponent")}</span>
                <span>{t("Impact")}</span>
                <span>{t("Review")}</span>
              </div>
            )}

            <div
              className="lib-scroll"
              ref={parentRef}
              role="listbox"
              aria-label={t("Games")}
              aria-multiselectable={selectMode || undefined}
            >
              {matches.length === 0 ? (
                <EmptyState
                  icon={<Gamepad2 size={30} color="var(--faint)" />}
                  title={t("No games recorded yet")}
                  text={t("Play a match and it will show up here automatically.")}
                />
              ) : visible.length === 0 ? (
                <EmptyState
                  icon={<SearchX size={30} color="var(--faint)" />}
                  title={t("No games match this filter")}
                  text={t("Try a different search term, or switch back to All.")}
                  action={
                    <Button variant="ghost" size="sm" onClick={clearFilters}>
                      {t("Clear filters")}
                    </Button>
                  }
                />
              ) : (
                <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const row = rows[virtualRow.index];
                    const wrap: React.CSSProperties = {
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                    };

                    if (row.kind === "day") {
                      return (
                        <div key={row.key} data-index={virtualRow.index} ref={rowVirtualizer.measureElement} style={wrap} role="presentation">
                          <div className="lib-day">
                            <span>
                              {cap(row.label)}
                              {row.count > 1 && ` · ${row.count} ${t("games")}`}
                            </span>
                            {row.lp != null && <span className="lib-day__lp">{lpText(row.lp)}</span>}
                          </div>
                        </div>
                      );
                    }

                    if (row.kind === "more") {
                      return (
                        <div key={row.key} data-index={virtualRow.index} ref={rowVirtualizer.measureElement} style={wrap} role="presentation">
                          <div className="lib-more">
                            <span>
                              {t(row.hidden === 1 ? "{n} game hidden by the filter" : "{n} games hidden by the filter", { n: row.hidden })}
                            </span>
                            <span aria-hidden>·</span>
                            <button type="button" className="lib-link" onClick={clearFilters}>
                              {t("Show all")}
                            </button>
                          </div>
                        </div>
                      );
                    }

                    const match = row.match;
                    const next = rows[virtualRow.index + 1];
                    const isCurrent = current?.id === match.id;
                    const beforeCurrent = next?.kind === "match" && next.match.id === current?.id;
                    const lastOfGroup = !next || next.kind !== "match";
                    return (
                      <div key={row.key} data-index={virtualRow.index} ref={rowVirtualizer.measureElement} style={wrap} role="presentation">
                        {/* Sin animación de entrada: esta lista está virtualizada y
                            se redispararía al hacer scroll. */}
                        <LibraryRow
                          match={match}
                          current={isCurrent}
                          divider={!isCurrent && !beforeCurrent && !lastOfGroup}
                          selectMode={selectMode}
                          checked={selected.has(match.id)}
                          narrow={!wide}
                          progress={progreso.get(match.id)}
                          lp={lpDelta.get(match.id)}
                          lang={lang}
                          onClick={(e) => onRowClick(match, e)}
                          onDoubleClick={() => onRowDoubleClick(match)}
                          onReveal={() => revelar(match)}
                          onDelete={() => onDeleteMatch(match.id)}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          {/* Barra contextual del lote: fuera de la lista virtualizada para que no
              se la lleve el scroll ni la mida el virtualizador. Mientras hay
              lote, ocupa el sitio de la ayuda de teclado. */}
          {selected.size > 0 ? (
            <div className="lib-batch">
              <span className="lib-batch__n">
                {t(selected.size === 1 ? "{n} game selected" : "{n} games selected", { n: selected.size })}
              </span>
              <div className="lib-batch__acts">
                <Button variant="ghost" size="sm" onClick={clearSelection}>
                  {t("Cancel")}
                </Button>
                <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={deleteSelected}>
                  {t("Delete selected")}
                </Button>
              </div>
            </div>
          ) : (
            visible.length > 0 && (
              <div className="lib-keys" aria-hidden>
                <span><kbd className="u-kbd lib-kbd">↑</kbd><kbd className="u-kbd lib-kbd">↓</kbd>{t("move")}</span>
                <span><kbd className="u-kbd lib-kbd">Enter</kbd>{t(wide ? "review" : "open")}</span>
                <span><kbd className="u-kbd lib-kbd">{t("Del")}</kbd>{t("delete")}</span>
                <span><kbd className="u-kbd lib-kbd">Ctrl</kbd>{t("click to select several")}</span>
              </div>
            )
          )}
        </div>

        {wide && current && (
          <MatchDetailPanel
            match={current}
            progress={progreso.get(current.id)}
            lpDelta={lpDelta.get(current.id)}
            onOpen={(seek) => abrir(current, seek)}
            onReveal={() => revelar(current)}
            onDelete={() => onDeleteMatch(current.id)}
          />
        )}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------------
   Una fila de partida. Misma rejilla que la cabecera de columnas (.lib-grid).
   ------------------------------------------------------------------------ */
interface RowProps {
  match: MatchMetadata;
  current: boolean;
  divider: boolean;
  selectMode: boolean;
  checked: boolean;
  /** Sin panel de detalle: las acciones de fila vuelven a la fila. */
  narrow: boolean;
  progress: ReviewProgress | undefined;
  lp: number | undefined;
  lang: string;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onReveal: () => void;
  onDelete: () => void;
}

const LibraryRow: React.FC<RowProps> = ({
  match,
  current,
  divider,
  selectMode,
  checked,
  narrow,
  progress,
  lp,
  lang,
  onClick,
  onDoubleClick,
  onReveal,
  onDelete,
}) => {
  const t = useT();
  const kda = kdaDe(match, computeKDA(match.events));
  // Lo que sólo sabe la sincronización con Riot. Sin ella, "—".
  const yo = selfOf(match);
  const pos = normalizePosition(yo?.role);
  const minutos = match.game_duration / 60;
  const csmin = yo && minutos > 0 ? fmtDec(yo.cs / minutos, 1, lang) : null;
  const rival = laneRival(match);
  const res = outcome(match.result);

  // LP que dio o quitó; el absoluto solo cuando no hay resta que enseñar.
  const rango = rankLabel(match.rank_tier, match.rank_division);
  const lpTxt =
    lp != null && lp !== 0 ? lpText(lp) : match.rank_lp != null ? `${match.rank_lp} LP` : null;

  const nota = match.impact_percentile != null ? Math.round(match.impact_percentile) : null;
  const rank = match.impact_rank ?? null;

  return (
    <div
      className="lib-grid lib-tr"
      data-result={res === "victory" ? "win" : res === "defeat" ? "loss" : undefined}
      data-current={current || undefined}
      data-divider={divider || undefined}
      data-match-id={match.id}
      role="option"
      aria-selected={selectMode ? checked : current}
      tabIndex={current ? 0 : -1}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {/* Retrato con la insignia del puesto; en modo lote, la casilla encima. */}
      <span className="lib-portrait">
        <ChampionAvatar champion={match.champion} size={44} />
        {pos && (
          <span className="lib-portrait__pos" title={t(POSITION_LABEL[pos])}>
            <PositionIcon position={pos} size={12} />
          </span>
        )}
        {selectMode && (
          <span className={`lib-check${checked ? " lib-check--on" : ""}`} aria-hidden>
            {checked && <Check size={12} />}
          </span>
        )}
      </span>

      {/* Campeón y cola. */}
      <span className="lib-cell" title={match.champion}>
        <span className="lib-champ">{match.champion}</span>
        <span className="lib-sub">
          {t(queueKey(match.queue))} · {formatDuration(match.game_duration)}
        </span>
      </span>

      {/* Resultado y LP. */}
      <span className="lib-cell">
        <span className={`lib-res${res === "victory" ? " lib-res--win" : res === "defeat" ? " lib-res--loss" : ""}`}>
          {t(res === "victory" ? "Victory" : res === "defeat" ? "Defeat" : "No result")}
        </span>
        {lpTxt && <span className="lib-sub lib-sub--muted" title={rango ?? undefined}>{lpTxt}</span>}
      </span>

      {/* KDA: cifra grande y el ratio con su tono. */}
      <span className="lib-cell">
        <span className="lib-big">{kda.kills} / {kda.deaths} / {kda.assists}</span>
        <span className={`lib-sub lib-ratio--${ratioTone(kda)}`}>{ratioLabel(kda, t, lang)}</span>
      </span>

      {/* CS y por minuto. Solo lo sabe la sincronización. */}
      <span className="lib-cell">
        {yo ? (
          <>
            <span className="lib-big">{yo.cs}</span>
            {csmin && <span className="lib-sub">{csmin}/min</span>}
          </>
        ) : (
          <span className="lib-sub">—</span>
        )}
      </span>

      {/* El rival de tu puesto. Sin sincronizar, una palabra y el porqué en
          el título, no una frase repetida en cada fila. */}
      <span className="lib-col-rival lib-rival">
        {rival ? (
          <span
            className="lib-rival__in"
            title={`${rival.name ? `${rival.name}${rival.tag ? `#${rival.tag}` : ""} · ` : ""}${rival.kills}/${rival.deaths}/${rival.assists} · ${rival.cs} CS`}
          >
            <span className="lib-rival__img"><ChampionAvatar champion={rival.champion} size={24} /></span>
            <span className="lib-rival__name">{rival.champion}</span>
          </span>
        ) : (
          <span className="lib-nosync" title={t("Sync with Riot to see your lane opponent")}>
            <Link2Off size={12} aria-hidden />
            <span>{t("Not synced")}</span>
          </span>
        )}
      </span>

      {/* Impacto: el puesto entre los diez (o MVP) y, debajo, la nota, que es
          por lo que ordenan "Mejor/Peor nota". */}
      <span className="lib-cell lib-impact">
        {rank === 1 ? (
          <span className="lib-mvp">{t("MVP")}</span>
        ) : rank ? (
          <span className="lib-rank">{ordinal(rank, t)}</span>
        ) : (
          <span className="lib-sub">—</span>
        )}
        {nota != null && <span className="lib-sub">{t("Score {n}", { n: nota })}</span>}
      </span>

      {/* Revisión: hecha, a medias (barra y cuenta) o por empezar. */}
      <span className="lib-review">
        {progress?.reviewed ? (
          <span className="lib-pill lib-pill--done">
            <Check size={12} strokeWidth={2.4} aria-hidden />
            {t("Reviewed")}
          </span>
        ) : progress && progress.done > 0 ? (
          <span className="lib-prog" title={t("{done} of {total} reviewed", { done: progress.done, total: progress.total })}>
            <span className="lib-prog__bar">
              <span style={{ width: `${Math.max(8, Math.round((progress.done / Math.max(1, progress.total)) * 100))}%` }} />
            </span>
            <span className="lib-sub lib-sub--muted">{progress.done}/{progress.total}</span>
          </span>
        ) : (
          <span className="lib-pill lib-pill--todo">{t("To review")}</span>
        )}
      </span>

      {/* Sin panel de detalle, abrir la carpeta y borrar vuelven a la fila, al
          pasar el cursor. */}
      {narrow && !selectMode && (
        <span className="lib-actions">
          <Button
            variant="icon"
            size="sm"
            title={t("Reveal in folder")}
            aria-label={t("Reveal in folder")}
            onClick={(e) => { e.stopPropagation(); onReveal(); }}
            onDoubleClick={(e) => e.stopPropagation()}
            icon={<FolderOpen size={14} />}
          />
          <Button
            variant="danger"
            size="sm"
            title={t("Delete game")}
            aria-label={t("Delete the {champion} game", { champion: match.champion })}
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            onDoubleClick={(e) => e.stopPropagation()}
            icon={<Trash2 size={14} />}
          />
        </span>
      )}
    </div>
  );
};
