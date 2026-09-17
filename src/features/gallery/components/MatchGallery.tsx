import React, { useEffect, useState, useRef, useMemo } from "react";
import { MatchMetadata } from "../../../types";
import { computeKDA, kdaRatio, outcome, formatDuration, lpDeltas, queueKey, type KDA } from "../../../core/matchStats";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { rankLabel } from "../../../core/ddragon";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { matchRole, ROLE_FILTERS, type RoleFilter } from "../../../core/patterns";
import { isReviewed } from "../../../core/review";
import { useAppStore, useErrorClips } from "../../../store/useAppStore";
import { Check, ChevronDown, ListChecks, Search, Trash2, Gamepad2, SearchX, TriangleAlert, RefreshCw, FolderOpen } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useDialog } from "../../../components/ui/DialogProvider";
import { useT } from "../../../core/LanguageProvider";
import { matchAge, relativeDay } from "../../../core/time";
import "./MatchGallery.css";

interface DiskSpaceInfo {
  used_bytes: number;
  total_bytes: number;
}

type Filter = "all" | "unreviewed" | "defeats";

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

/** El KDA guardado ("9/3/12") o el contado de los eventos, como números. */
const kdaDe = (m: MatchMetadata, contado: KDA): KDA => {
  if (m.kda) {
    const [k, d, a] = m.kda.split("/").map((x) => parseInt(x, 10));
    if ([k, d, a].every(Number.isFinite)) return { kills: k, deaths: d, assists: a };
  }
  return contado;
};

/* Alturas estimadas de las dos clases de fila. La real la mide
   `measureElement`; esto solo evita que el primer cuadro baile. */
const ALTO_FILA = 56;
const ALTO_DIA = 40;

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
  // fila, y mientras dura, el clic selecciona en vez de abrir.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const t = useT();
  const { showError } = useDialog();
  // Los errores que marcaste tú también cuentan como momentos a revisar, así
  // que hacen falta aquí para saber si una partida está revisada.
  const { clips: errorClips } = useErrorClips();

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
   * Las partidas ya revisadas, calculadas UNA vez.
   *
   * `isReviewed` monta la cola de momentos de la partida (sucesos, saltos de
   * cámara y errores marcados), así que llamarla por fila y en cada render era
   * rehacer ese trabajo cientos de veces por scroll.
   */
  const revisadas = useMemo(
    () => new Set(matches.filter((m) => isReviewed(m, errorClips)).map((m) => m.id)),
    [matches, errorClips]
  );

  const parentRef = useRef<HTMLDivElement>(null);

  /** Abre el explorador con el vídeo de la partida seleccionado. */
  const revelar = async (m: MatchMetadata) => {
    try {
      await revealItemInDir(m.video_path);
    } catch (e) {
      showError(t("Couldn't open the folder: {msg}", { msg: String(e) }));
    }
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

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtradas = matches.filter((m) => {
      if (filter === "defeats" && outcome(m.result) !== "defeat") return false;
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
    type Row =
      | { kind: "day"; label: string; count: number; key: string }
      | { kind: "match"; match: MatchMetadata; key: string };
    const out: Row[] = [];
    // Agrupar por día solo tiene sentido con el orden cronológico. Ordenando por
    // nota, cada partida caería en su propia cabecera de día y la lista se
    // llenaría de separadores de una fila.
    if (sort === "best" || sort === "worst") {
      return visible.map((m) => ({ kind: "match" as const, match: m, key: m.id }));
    }
    let i = 0;
    while (i < visible.length) {
      const label = relativeDay(visible[i].date, t);
      let j = i;
      while (j < visible.length && relativeDay(visible[j].date, t) === label) j++;
      out.push({ kind: "day", label, count: j - i, key: `day-${label}-${i}` });
      for (let k = i; k < j; k++) {
        out.push({ kind: "match", match: visible[k], key: visible[k].id });
      }
      i = j;
    }
    return out;
  }, [visible, sort, t]);

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
    estimateSize: (index) => (rows[index].kind === "day" ? ALTO_DIA : ALTO_FILA),
    overscan: 8,
  });

  useEffect(() => {
    invoke<DiskSpaceInfo>("get_disk_usage")
      .then(setDiskSpace)
      .catch(console.error);
  }, [matches]);

  const usedGb = diskSpace ? (diskSpace.used_bytes / (1024 * 1024 * 1024)).toFixed(0) : "—";
  const totalGb = diskSpace ? (diskSpace.total_bytes / (1024 * 1024 * 1024)).toFixed(0) : "—";
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

  const roleLabel = (r: { key: RoleFilter; label: string }) =>
    r.key === "all" ? t("All roles") : t(r.label);

  return (
    <div className="lib panel-enter">
      {/* Cabecera: título, censo y el disco en una línea. */}
      <div className="lib-head">
        <h1>{t("Library")}</h1>
        <span className="lib-head__sub">
          {matches.length} {t("games")} · {reviewed} {t("reviewed")} · {porRevisar} {t("to review")}
        </span>
        <div className="lib-head__right">
          {isRecording && (
            <span className="lib-recording">
              <span className="rec-dot" /> {t("RECORDING")}
            </span>
          )}
          {/* Con el disco ajustado, la salida rápida: lo ya revisado y viejo es
              lo único que se puede borrar sin perder nada por aprender. */}
          {diskTight && viejasRevisadas.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Trash2 size={13} />}
              onClick={() => onDeleteMatches(viejasRevisadas)}
            >
              {t("Delete reviewed games older than 30 days")} · {viejasRevisadas.length}
            </Button>
          )}
          <span
            className={`u-meta lib-disk${diskTight ? " lib-disk--tight" : ""}`}
            title={t("Disk")}
          >
            {usedGb} {t("of")} {totalGb} GB · {pct === null ? "—" : `${pct} %`}
          </span>
        </div>
      </div>

      {/* Una fila de chips: estado · puesto · orden · buscador · seleccionar. */}
      <div className="lib-filters">
        {([["all", "All"], ["unreviewed", "To review"], ["defeats", "Losses"]] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="lib-chip"
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
          >
            {t(label)}
            {key === "unreviewed" && porRevisar > 0 && (
              <span className="lib-chip__count">{porRevisar}</span>
            )}
          </button>
        ))}

        <span className="lib-sep" aria-hidden />

        {/* Filtro por puesto: el puesto llega con la sincronización de Riot,
            así que las partidas sin él solo aparecen en "Todos los puestos". */}
        {ROLE_FILTERS.map((r) => (
          <button
            key={r.key}
            type="button"
            className="lib-chip"
            aria-pressed={roleFilter === r.key}
            onClick={() => setRoleFilter(r.key)}
          >
            {roleLabel(r)}
          </button>
        ))}

        <span className="lib-sep" aria-hidden />

        {/* Orden. La nota es lo único de la fila que separa una partida buena de
            una mala, así que ordenar por ella es lo que convierte la lista en
            "enséñame lo peor", que es a lo que se viene. */}
        <label className="lib-chip lib-chip--select">
          {t(SORTS.find((s) => s.key === sort)!.label)}
          <ChevronDown size={13} aria-hidden />
          <select
            aria-label={t("Sort")}
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>{t(s.label)}</option>
            ))}
          </select>
        </label>

        <label className="field lib-search">
          <Search size={14} aria-hidden />
          <input
            type="search"
            placeholder={t("champion, queue, date…")}
            aria-label={t("Filter games")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        <Button
          variant="ghost"
          size="sm"
          aria-pressed={selectMode}
          title={t("Select several games to delete them at once")}
          icon={<ListChecks size={14} />}
          onClick={() => (selectMode ? clearSelection() : setSelectMode(true))}
        >
          {t("Select")}
        </Button>
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

      {/* La tabla: cabecera fija y lista con scroll, dentro de la misma tarjeta.
          `filaficha` hace que las cifras (.u-metric) hablen en sans, como pidió
          el usuario para esta pantalla. */}
      <section className="card lib-card filaficha" aria-label={t("Library")}>
        {visible.length > 0 && (
          <div className="lib-grid lib-th">
            <span className="u-label">{t("Game")}</span>
            <span className="u-label">{t("Result")}</span>
            <span className="u-label">{t("KDA")}</span>
            <span className="u-label">{t("CS")}</span>
            <span className="u-label">{t("Lane opponent")}</span>
            <span className="u-label lib-right">{t("Score")}</span>
            <span className="u-label lib-right">{t("Position")}</span>
            <span />
          </div>
        )}

        <div className="lib-scroll" ref={parentRef}>
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
                <Button
                  variant="ghost"
                  size="sm"
                  // El filtro de rol también es un filtro: dejarlo puesto hacía
                  // que "Quitar filtros" no quitara nada visible.
                  onClick={() => { setQuery(""); setFilter("all"); setRoleFilter("all"); }}
                >
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
                    <div key={row.key} data-index={virtualRow.index} ref={rowVirtualizer.measureElement} style={wrap}>
                      <div className="lib-day">
                        <span className="u-label">{row.label}</span>
                        <span className="u-meta">
                          {row.count} {t(row.count === 1 ? "game" : "games")}
                        </span>
                      </div>
                    </div>
                  );
                }

                const match = row.match;
                const kda = kdaDe(match, computeKDA(match.events));
                // Lo que sólo sabe la sincronización con Riot. Sin ella, "—".
                const yo = match.participants?.find((p) => p.is_self);
                const csmin = yo && match.game_duration > 0 ? (yo.cs / (match.game_duration / 60)).toFixed(1) : null;
                // El rival de tu ROL: Riot ordena 1-5 azul / 6-10 rojo por
                // posición, así que es el espejo de tu índice (el mismo truco que
                // usa el backend para el gank y el impacto).
                const idxYo = match.participants?.findIndex((p) => p.is_self) ?? -1;
                const rival =
                  idxYo >= 0 && match.participants!.length === 10
                    ? match.participants![(idxYo + 5) % 10]
                    : null;
                const res = outcome(match.result);
                const unreviewed = !revisadas.has(match.id);
                const isSelected = selected.has(match.id);

                // Meta del resultado: rango al jugarla y los LP que dio o quitó.
                // El absoluto solo cuando no hay resta que enseñar: juntos no
                // caben y el delta dice más.
                const lp = lpDelta.get(match.id);
                const metaResultado: string[] = [];
                const rango = rankLabel(match.rank_tier, match.rank_division);
                if (rango) metaResultado.push(rango);
                if (lp != null && lp !== 0) metaResultado.push(`${lp > 0 ? "+" : "−"}${Math.abs(lp)} LP`);
                else if (match.rank_lp != null) metaResultado.push(`${match.rank_lp} LP`);

                // Ctrl/Shift+clic selecciona aunque no esté el modo activo (y lo
                // enciende); dentro del modo, el clic normal también selecciona.
                const handleRowClick = (e: React.MouseEvent | React.KeyboardEvent) => {
                  const conModificador =
                    "ctrlKey" in e && (e.ctrlKey || e.metaKey || e.shiftKey);
                  if (selectMode || conModificador) {
                    if (!selectMode) setSelectMode(true);
                    toggleSelected(match.id);
                  } else {
                    onSelectMatch(match);
                  }
                };

                return (
                  <div key={row.key} data-index={virtualRow.index} ref={rowVirtualizer.measureElement} style={wrap}>
                    {/* Sin animación de entrada: esta lista está virtualizada y
                        se redispararía al hacer scroll. */}
                    <div
                      className="lib-grid lib-tr"
                      data-result={res === "victory" ? "win" : res === "defeat" ? "loss" : undefined}
                      onClick={handleRowClick}
                      role="button"
                      tabIndex={0}
                      aria-selected={selectMode ? isSelected : undefined}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleRowClick(e); }
                      }}
                    >
                      {/* Partida: avatar, campeón y la meta "cola · hace X · duración". */}
                      <div className="lib-game" title={match.champion}>
                        <ChampionAvatar champion={match.champion} size={38} />
                        <div className="lib-cell">
                          <span className="lib-name">
                            <span>{match.champion}</span>
                            {unreviewed && <span className="lib-badge lib-badge--flag">{t("to review")}</span>}
                          </span>
                          <span className="u-meta">
                            {t(queueKey(match.queue))} · {matchAge(match.date, t)} · {formatDuration(match.game_duration)}
                          </span>
                        </div>
                      </div>

                      {/* Resultado, con rango y LP debajo. */}
                      <div className="lib-cell">
                        <span className={res === "victory" ? "lib-win" : res === "defeat" ? "lib-loss" : undefined}>
                          {t(res === "victory" ? "Victory" : res === "defeat" ? "Defeat" : "No result")}
                        </span>
                        {metaResultado.length > 0 && (
                          <span className="u-meta">{metaResultado.join(" · ")}</span>
                        )}
                      </div>

                      {/* KDA: cifra y ratio. */}
                      <div className="lib-cell">
                        <span className="u-metric">{kda.kills} / {kda.deaths} / {kda.assists}</span>
                        <span className="u-meta">{t(kdaRatio(kda))}</span>
                      </div>

                      {/* CS: cifra y por minuto. Solo lo sabe la sincronización. */}
                      <div className="lib-cell">
                        {yo ? (
                          <>
                            <span className="u-metric">{yo.cs}</span>
                            {csmin && <span className="u-meta">{csmin} / min</span>}
                          </>
                        ) : (
                          <span className="u-meta">—</span>
                        )}
                      </div>

                      {/* El rival de tu rol, en espejo. Sin sincronizar se dice
                          qué hacer, en voz baja, y no se rompe la fila. */}
                      <div className="lib-cell" title={rival?.champion}>
                        {rival ? (
                          <>
                            <span className="lib-name">
                              <span>{rival.name || rival.champion}</span>
                              {rival.tag && <span className="u-meta">#{rival.tag}</span>}
                            </span>
                            <span className="u-meta">
                              {rival.champion} · {rival.kills} / {rival.deaths} / {rival.assists} · {rival.cs} cs
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="u-meta">{t("Not synced")}</span>
                            <span className="u-meta">{t("Sync with Riot to see your lane opponent")}</span>
                          </>
                        )}
                      </div>

                      {/* Nota: el percentil de impacto. */}
                      {match.impact_percentile != null ? (
                        <span className="u-metric lib-right">{Math.round(match.impact_percentile)}</span>
                      ) : (
                        <span className="u-meta lib-right">—</span>
                      )}

                      {/* Puesto: "#N", o MVP. El ordinal era "º", que en inglés
                          no existe; "#3" se lee igual en los dos idiomas. */}
                      {match.impact_rank === 1 ? (
                        <span className="lib-badge lib-badge--mvp">{t("MVP")}</span>
                      ) : match.impact_rank ? (
                        <span className="u-metric lib-right">#{match.impact_rank}</span>
                      ) : (
                        <span className="u-meta lib-right">—</span>
                      )}

                      {/* Acciones: casilla en modo selección; si no, abrir la
                          carpeta y borrar, solo al pasar el cursor. */}
                      <div className={`lib-actions${selectMode ? " lib-actions--always" : ""}`}>
                        {selectMode ? (
                          <span className={`lib-check${isSelected ? " lib-check--on" : ""}`} aria-hidden>
                            {isSelected && <Check size={12} />}
                          </span>
                        ) : (
                          <>
                            <Button
                              variant="icon"
                              size="sm"
                              title={t("Reveal in folder")}
                              aria-label={t("Reveal in folder")}
                              onClick={(e) => { e.stopPropagation(); revelar(match); }}
                              icon={<FolderOpen size={14} />}
                            />
                            <Button
                              variant="danger"
                              size="sm"
                              title={t("Delete game")}
                              aria-label={t("Delete the {champion} game", { champion: match.champion })}
                              onClick={(e) => { e.stopPropagation(); onDeleteMatch(match.id); }}
                              icon={<Trash2 size={14} />}
                            />
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Barra contextual del lote: fuera de la lista virtualizada para que no
          se la lleve el scroll ni la mida el virtualizador. */}
      {selected.size > 0 && (
        <div className="lib-batch">
          <span className="u-metric" style={{ fontSize: 13 }}>
            {t(selected.size === 1 ? "{n} game selected" : "{n} games selected", { n: selected.size })}
          </span>
          <div style={{ display: "flex", gap: "var(--space-2)", marginLeft: "auto" }}>
            <Button variant="ghost" size="sm" onClick={clearSelection}>
              {t("Cancel")}
            </Button>
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 size={14} />}
              onClick={deleteSelected}
            >
              {t("Delete selected")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
