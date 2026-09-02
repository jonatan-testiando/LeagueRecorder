import React, { useEffect, useState, useRef, useMemo } from "react";
import { MatchMetadata } from "../../../types";
import { computeKDA, kdaRatio, outcome, formatDuration, lpDeltas, queueKey, type KDA } from "../../../core/matchStats";
import { DDRAGON_VER, itemIcon, spellIcon } from "../../player/components/videoPlayerUtils";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { rankIcon, rankLabel } from "../../../core/ddragon";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { matchRole, ROLE_FILTERS, type RoleFilter } from "../../../core/patterns";
import { isReviewed } from "../../../core/review";
import { useAppStore, useErrorClips } from "../../../store/useAppStore";
import { Check, HardDrive, ListChecks, Search, Trash2, Gamepad2, SearchX, TriangleAlert, RefreshCw, FolderOpen } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useDialog } from "../../../components/ui/DialogProvider";
import { useT } from "../../../core/LanguageProvider";

import { matchAge, relativeDay } from "../../../core/time";
interface DiskSpaceInfo {
  used_bytes: number;
  total_bytes: number;
}

/**
 * Fecha relativa. Con 19 partidas repartidas en cinco dias, "2026-08-12"
 * repetido no distingue nada; "hace 2 dias" si.
 */
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

/* Rejilla de la fila. La comparten la cabecera y las filas: son la misma tabla.
   avatar · quién · línea de tiempo (el resto del ancho) · 5 métricas · borrar */
const FILA_GRID = "90px minmax(150px, 220px) 1fr 170px 84px 26px 170px 84px 1fr 50px 62px";

/** El KDA guardado ("9/3/12") o el contado de los eventos, como números. */
const kdaDe = (m: MatchMetadata, contado: KDA): KDA => {
  if (m.kda) {
    const [k, d, a] = m.kda.split("/").map((x) => parseInt(x, 10));
    if ([k, d, a].every(Number.isFinite)) return { kills: k, deaths: d, assists: a };
  }
  return contado;
};

export const MatchGallery: React.FC<MatchGalleryProps> = ({
  matches,
  onSelectMatch,
  onDeleteMatch,
  onDeleteMatches,
  isRecording,
  loadError,
  onRetry,
}) => {
  // `null` hasta que el backend contesta. Antes arrancaba en "0 / 100 GB", que
  // es un disco inventado: en el primer cuadro la barra decía 0% de un total
  // que no era el del usuario.
  const [diskSpace, setDiskSpace] = useState<DiskSpaceInfo | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [sort, setSort] = useState<Sort>("newest");
  // Selección por lotes: se entra con el botón o con Ctrl/Shift+clic sobre una
  // ficha, y mientras dura, el clic selecciona en vez de abrir.
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

  // El buscador y los filtros existen de verdad: antes el campo estaba
  // `disabled` con un placeholder y la fila de pestañas tenía una sola pestaña
  // siempre activa. Un control que se ve pero no hace nada es lo que más rápido
  // delata un prototipo, y los datos para filtrar ya estaban aquí.
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

  /**
   * La lista que se pinta: cabeceras de dia intercaladas entre las partidas.
   *
   * Van en la misma lista plana y no en un contenedor aparte porque la lista
   * esta virtualizada: el virtualizador solo entiende un indice lineal.
   *
   * El agrupado es por tramos consecutivos, asi que si algun dia llegara
   * desordenado se veria como dos tramos en vez de mentir juntandolos.
   */
  // LP que dio o quitó cada partida. El cálculo vive en `core/matchStats`: "Hoy"
  // enseña el mismo número para la última partida y no puede ser otra resta.
  const lpDelta = useMemo(() => lpDeltas(matches), [matches]);

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
        // ya disparó antes del reset) y se quedan en la estimación: con la
        // estimación corta las fichas se pisan, con la larga se abren huecos.
        // Tras el reset, se remiden a mano los que están en el DOM.
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
    // de otra fila (una ficha con la medida de un separador se pisa con la
    // siguiente — el bug que vio el usuario al eliminar).
    getItemKey: (index) => rows[index].key,
    getScrollElement: () => parentRef.current,
    // Estimación inicial; la altura real se mide con `measureElement`. Cerca
    // de la real (ficha 112 + aire) para que el primer cuadro no baile.
    estimateSize: () => 124,
    overscan: 5,
  });

  useEffect(() => {
    invoke<DiskSpaceInfo>("get_disk_usage")
      .then(setDiskSpace)
      .catch(console.error);
  }, [matches]);

  const usedGb = diskSpace ? (diskSpace.used_bytes / (1024 * 1024 * 1024)).toFixed(1) : null;
  const totalGb = diskSpace ? (diskSpace.total_bytes / (1024 * 1024 * 1024)).toFixed(0) : null;
  const pct = diskSpace && diskSpace.total_bytes > 0
    ? Math.min(100, Math.round((diskSpace.used_bytes / diskSpace.total_bytes) * 100))
    : 0;
  // El disco solo pide atención cuando queda poco. Por debajo del 85% es un
  // dato, no un aviso, y se pinta apagado.
  const diskTight = diskSpace !== null && pct >= 85;

  // La MISMA definición que usa el reproductor y "Hoy" (ver `core/review.ts`):
  // la cabecera decía "revisada" con una nota suelta mientras la cola de
  // revisión de esa partida seguía con veinte momentos sin tachar.
  const reviewed = revisadas.size;

  return (
    <div style={styles.container} className="panel-enter">
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>{t("Library")}</h1>
          <div className="u-meta" style={{ marginTop: 4 }}>
            {matches.length} {t("games")} · {reviewed} {t("reviewed")} · {matches.length - reviewed} {t("to review")}
          </div>
        </div>

        <div style={styles.tools}>
          <label style={styles.searchBox}>
            <Search size={14} color="var(--faint)" />
            <input
              type="text"
              placeholder={t("champion, queue, date…")}
              aria-label={t("Filter games")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={styles.searchInput}
            />
          </label>
          {([["all", "All"], ["unreviewed", "To review"], ["defeats", "Defeats"]] as const).map(([key, label]) => (
            <Button
              key={key}
              variant="ghost"
              size="sm"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {t(label)}
            </Button>
          ))}
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
      </div>

      {/* La biblioteca no pudo leerse. Se dice, con salida: sin esto la pantalla
          enseñaba "Aún no hay partidas grabadas", que es una respuesta distinta
          y hace pensar que se han perdido. */}
      {loadError && (
        <div style={styles.notice}>
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

      {/* Filtro por rol: el puesto llega con la sincronización de Riot, así que
          las partidas sin él solo aparecen en "Todos". */}
      <div style={styles.roleRow}>
        {ROLE_FILTERS.map((r) => (
          <Button
            key={r.key}
            variant="ghost"
            size="sm"
            aria-pressed={roleFilter === r.key}
            onClick={() => setRoleFilter(r.key)}
          >
            {t(r.label)}
          </Button>
        ))}
        <span style={{ flex: 1 }} />
        {/* Orden. La nota es lo único de la fila que separa una partida buena de
            una mala, así que ordenar por ella es lo que convierte la lista en
            "enséñame lo peor", que es a lo que se viene. */}
        <span className="u-label" style={{ marginRight: 2 }}>{t("Sort")}</span>
        {SORTS.map((s) => (
          <Button
            key={s.key}
            variant="ghost"
            size="sm"
            aria-pressed={sort === s.key}
            onClick={() => setSort(s.key)}
          >
            {t(s.label)}
          </Button>
        ))}
      </div>

      <div style={styles.statusRow}>
        <div style={styles.statusItem}>
          <HardDrive size={14} color="var(--faint)" />
          <span className="u-metric" style={{ fontSize: 12 }}>
            {diskSpace ? `${usedGb} / ${totalGb} GB` : "— / — GB"}
          </span>
          <span style={styles.barBg}>
            <span
              style={{
                ...styles.barFill,
                width: `${pct}%`,
                background: diskTight ? "var(--loss)" : "var(--cool-fill)",
              }}
            />
          </span>
          <span className="u-meta">{diskSpace ? `${pct}%` : "—"}</span>
        </div>

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

        {isRecording && (
          <div style={styles.recording}>
            <span className="rec-dot" /> {t("RECORDING")}
          </div>
        )}
      </div>

      {/* La cabecera vieja (flex) vivía aquí: no compartía rejilla con las
          filas, así que sus columnas nunca caían en la misma vertical. La
          cabecera real es la de dentro de la lista, que usa FILA_GRID. */}

      <div style={styles.list} ref={parentRef}>
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
          <>
          <div style={styles.headRow}>
            <span />
            <span className="u-label">{t("Summoner")}</span>
            <span />
            <span className="u-label">{t("Game")}</span>
            <span className="u-label">{t("Build")}</span>
            <span />
            <span className="u-label">{t("Rival")}</span>
            <span className="u-label">{t("Build")}</span>
            <span />
            <span className="u-label" style={{ textAlign: "right" }}>{t("Score")}</span>
            <span />
          </div>
          <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];

              if (row.kind === "day") {
                return (
                  <div
                    key={row.key}
                    data-index={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <div className="day-sep">
                      <span className="day-sep__label">{t(row.label)}</span>
                      <span className="day-sep__rule" />
                      <span className="day-sep__count">
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
              const objetos = (yo?.items ?? []).filter((it) => it > 0).slice(0, 6);
              // El rival de tu ROL: Riot ordena 1-5 azul / 6-10 rojo por
              // posición, así que es el espejo de tu índice (el mismo truco que
              // usa el backend para el gank y el impacto).
              const idxYo = match.participants?.findIndex((p) => p.is_self) ?? -1;
              const rival =
                idxYo >= 0 && match.participants!.length === 10
                  ? match.participants![(idxYo + 5) % 10]
                  : null;
              const res = outcome(match.result);
              const accent =
                res === "victory" ? "var(--win)" : res === "defeat" ? "var(--loss)" : "var(--line)";
              const unreviewed = !revisadas.has(match.id);
              const isSelected = selected.has(match.id);
              // Ctrl/Shift+clic selecciona aunque no esté el modo activo (y lo
              // enciende); dentro del modo, el clic normal también selecciona.
              const handleCardClick = (e: React.MouseEvent | React.KeyboardEvent) => {
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
                <div
                  key={row.key}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    paddingBottom: "var(--space-2)",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {/* Sin `animateIn`: esta lista está virtualizada y la
                      animación de entrada se redispararía al hacer scroll. */}
                  <div
                    className="card card--interactive filaficha"
                    style={{
                      ...styles.row,
                      borderLeft: `2px solid ${accent}`,
                      // El resultado tiñe la ficha desde arriba, como en la
                      // referencia: la derrota sangra rojo, la victoria jade.
                      background: `linear-gradient(180deg, color-mix(in srgb, ${accent} 12%, var(--panel)) 0%, var(--panel) 78%)`,
                      boxShadow: isSelected ? "inset 0 0 0 1px var(--brand)" : undefined,
                    }}
                    onClick={handleCardClick}
                    role="button"
                    tabIndex={0}
                    aria-selected={selectMode ? isSelected : undefined}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleCardClick(e); }
                    }}
                  >
                    <div style={styles.rowGrid}>
                      <div style={styles.colIzq}>
                        <span style={styles.cola}>{t(queueKey(match.queue))}</span>
                        <span className="u-meta">{matchAge(match.date, t)}</span>
                        <span className="u-meta">{match.patch ? `${t("Patch")} ${match.patch}` : " "}</span>
                        <span className="u-meta">{formatDuration(match.game_duration)}</span>
                      </div>
                      {/* Invocador y su rango al jugarla, con los LP de la partida. */}
                      <div style={{ minWidth: 0 }}>
                        <div style={styles.nombreInv}>
                          {yo?.name || match.champion}
                          {yo?.tag ? <span className="u-meta">#{yo.tag}</span> : null}
                        </div>
                        {match.rank_tier && (
                          <div style={styles.rangoLinea}>
                            <img src={rankIcon(match.rank_tier)} alt="" style={styles.rangoIcono} loading="lazy" />
                            {(() => {
                              const lp = lpDelta.get(match.id);
                              return (
                                <>
                                  <span className="u-meta" style={{ color: "var(--muted)" }}>
                                    {rankLabel(match.rank_tier, match.rank_division)}
                                    {/* El absoluto solo cuando no hay resta que enseñar:
                                        juntos no caben y el delta dice más. */}
                                    {lp == null && match.rank_lp != null ? ` · ${match.rank_lp} LP` : ""}
                                  </span>
                                  {lp != null && lp !== 0 && (
                                    <span style={{ color: lp > 0 ? "var(--win)" : "var(--loss)", fontWeight: 700, fontSize: 12 }}>
                                      {lp > 0 ? "+" : "−"}{Math.abs(lp)} LP
                                    </span>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        )}
                        <div style={styles.meta}>
                          <span style={{ ...styles.result, color: accent }}>
                            {t(res === "victory" ? "VICTORY" : res === "defeat" ? "DEFEAT" : "NO RESULT")}
                          </span>
                          {unreviewed && (
                            <span className="u-meta" style={{ color: "var(--flag)" }}>{t("· to review")}</span>
                          )}
                        </div>
                      </div>

                      <span />

                      {/* Tú: avatar, summoners, KDA y cs, como en la referencia. */}
                      <div style={styles.bloque} title={match.champion}>
                        <ChampionAvatar champion={match.champion} size={44} />
                        {yo?.spells && yo.spells.length > 0 && (
                          <div style={styles.spellCol}>
                            {yo.spells.slice(0, 2).map((sp, si) => {
                              const src = spellIcon(DDRAGON_VER, sp);
                              return src ? <img key={si} src={src} alt="" style={styles.spellIcon} loading="lazy" /> : null;
                            })}
                          </div>
                        )}
                        <div style={{ minWidth: 0 }}>
                          <div style={styles.kdaLinea}>
                            {kda.kills}/<span style={{ color: "var(--loss)" }}>{kda.deaths}</span>/{kda.assists}
                          </div>
                          <div className="u-meta" style={{ whiteSpace: "nowrap" }}>
                            {yo ? `${yo.cs} cs${csmin ? ` (${csmin})` : ""}` : `${t(kdaRatio(kda))} KDA`}
                          </div>
                        </div>
                      </div>

                      {/* Tu build, 2×3. */}
                      <div style={styles.itemsGrid}>
                        {objetos.length > 0
                          ? objetos.map((it, n) => (
                              <img
                                key={n}
                                src={itemIcon(DDRAGON_VER, it)}
                                alt=""
                                style={styles.itemIcon}
                                loading="lazy"
                                onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
                              />
                            ))
                          : <span className="u-meta">—</span>}
                      </div>

                      <div className="u-meta" style={{ textAlign: "center", letterSpacing: "0.06em" }}>{t("VS")}</div>

                      {/* El rival de tu rol, en espejo. */}
                      <div style={styles.bloque} title={rival?.champion}>
                        {rival ? (
                          <>
                            <ChampionAvatar champion={rival.champion} size={44} />
                            {rival.spells && rival.spells.length > 0 && (
                              <div style={styles.spellCol}>
                                {rival.spells.slice(0, 2).map((sp, si) => {
                                  const src = spellIcon(DDRAGON_VER, sp);
                                  return src ? <img key={si} src={src} alt="" style={styles.spellIcon} loading="lazy" /> : null;
                                })}
                              </div>
                            )}
                            <div style={{ minWidth: 0 }}>
                              <div style={styles.kdaLinea}>
                                {rival.kills}/<span style={{ color: "var(--loss)" }}>{rival.deaths}</span>/{rival.assists}
                              </div>
                              <div className="u-meta" style={{ whiteSpace: "nowrap" }}>
                                {rival.cs} cs{match.game_duration > 0 ? ` (${(rival.cs / (match.game_duration / 60)).toFixed(1)})` : ""}
                              </div>
                            </div>
                          </>
                        ) : (
                          // El rival sale de los 10 participantes, que solo
                          // llegan con la sincronización de Riot. Un guion suelto
                          // parecía un dato que falta por un fallo; esto dice qué
                          // hacer. Una sola vez por fila y en voz baja: la
                          // columna de su build se queda con el guion.
                          <span className="u-meta" style={{ lineHeight: 1.35 }}>
                            {t("Sync with Riot to see your lane opponent")}
                          </span>
                        )}
                      </div>

                      {/* Su build. */}
                      <div style={styles.itemsGrid}>
                        {rival && (rival.items ?? []).some((it) => it > 0)
                          ? (rival.items ?? []).filter((it) => it > 0).slice(0, 6).map((it, ii) => (
                              <img key={ii} src={itemIcon(DDRAGON_VER, it)} alt="" style={styles.itemIcon} loading="lazy" />
                            ))
                          : <span className="u-meta">—</span>}
                      </div>

                      <span />

                      {/* Score y puesto, juntos: la nota grande y el puesto
                          debajo, que es como se lee la referencia. */}
                      <div style={{ textAlign: "right" }}>
                        {match.impact_percentile != null ? (
                          <>
                            <div
                              className="u-metric"
                              style={{
                                fontSize: 18,
                                fontWeight: 700,
                                color: match.impact_percentile >= 50 ? "var(--win)" : "var(--loss)",
                              }}
                            >
                              {Math.round(match.impact_percentile)}
                            </div>
                            <div
                              className="u-meta"
                              style={{ color: match.impact_rank === 1 ? "var(--gold)" : undefined }}
                            >
                              {/* El ordinal era "º", que en inglés no existe.
                                  "#3" se lee igual en los dos idiomas. */}
                              {match.impact_rank === 1 ? "MVP" : match.impact_rank ? `#${match.impact_rank}` : ""}
                            </div>
                          </>
                        ) : (
                          <span className="u-meta">—</span>
                        )}
                      </div>

                      <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        {selectMode ? (
                          <span
                            style={{
                              ...styles.checkBox,
                              ...(isSelected ? styles.checkBoxOn : {}),
                            }}
                            aria-hidden
                          >
                            {isSelected && <Check size={13} />}
                          </span>
                        ) : (
                          <>
                            {/* Abrir la carpeta del vídeo. Hasta ahora la única
                                forma de llegar al fichero era buscarlo a mano en
                                el disco. */}
                            <Button
                              variant="icon"
                              size="sm"
                              title={t("Reveal in folder")}
                              aria-label={t("Reveal in folder")}
                              onClick={(e) => { e.stopPropagation(); revelar(match); }}
                              icon={<FolderOpen size={15} />}
                            />
                            <Button
                              variant="danger"
                              size="sm"
                              title={t("Delete game")}
                              aria-label={t("Delete the {champion} game", { champion: match.champion })}
                              onClick={(e) => { e.stopPropagation(); onDeleteMatch(match.id); }}
                              icon={<Trash2 size={15} />}
                            />
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          </>
        )}
      </div>

      {/* Barra contextual del lote: fuera de la lista virtualizada para que no
          se la lleve el scroll ni la mida el virtualizador. */}
      {selected.size > 0 && (
        <div style={styles.batchBar}>
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

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    padding: "var(--space-6) var(--space-8)",
    boxSizing: "border-box",
  },
  header: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: "var(--space-5)",
    marginBottom: "var(--space-4)",
  },
  pageTitle: {
    margin: 0,
    fontSize: "var(--font-xl)",
  },
  tools: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
  },
  roleRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    flexWrap: "wrap",
    marginBottom: "var(--space-3)",
  },
  notice: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    padding: "var(--space-3) var(--space-4)",
    marginBottom: "var(--space-3)",
    background: "color-mix(in srgb, var(--signal) 8%, var(--panel))",
    border: "1px solid color-mix(in srgb, var(--signal) 28%, transparent)",
    borderRadius: "var(--radius-md)",
    color: "var(--muted)",
    fontSize: "var(--font-xs)",
    overflowWrap: "anywhere",
  },
  batchBar: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-4)",
    padding: "var(--space-3) var(--space-4)",
    marginTop: "var(--space-3)",
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius-md)",
  },
  checkBox: {
    width: 20,
    height: 20,
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--line)",
    background: "var(--sunken)",
    display: "grid",
    placeItems: "center",
    color: "transparent",
    boxShadow: "var(--inset-sunken)",
  },
  checkBoxOn: {
    borderColor: "var(--brand)",
    color: "var(--brand)",
    background: "color-mix(in srgb, var(--brand) 14%, transparent)",
  },
  searchBox: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    background: "var(--sunken)",
    border: "1px solid var(--line-soft)",
    borderRadius: "var(--radius-md)",
    padding: "5px var(--space-3)",
    minWidth: "210px",
    boxShadow: "var(--inset-sunken)",
  },
  searchInput: {
    background: "transparent",
    border: "none",
    color: "var(--text)",
    outline: "none",
    width: "100%",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-4)",
    padding: "var(--space-3) 0",
    borderTop: "1px solid var(--line-soft)",
    borderBottom: "1px solid var(--line-soft)",
    marginBottom: "var(--space-4)",
  },
  statusItem: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
  },
  barBg: {
    width: "160px",
    height: "3px",
    background: "var(--sunken)",
    borderRadius: "var(--radius-full)",
    overflow: "hidden",
    boxShadow: "var(--inset-sunken)",
  },
  barFill: {
    display: "block",
    height: "100%",
    borderRadius: "var(--radius-full)",
    boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.22)",
  },
  recording: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    fontFamily: "var(--font-mono)",
    fontSize: "10px",
    letterSpacing: "0.14em",
    color: "var(--signal)",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    overflowY: "auto",
    position: "relative",
    paddingTop: "var(--space-2)",
    // El mismo aire que a la izquierda: sin esto la ficha roza el scroll.
    // A 8px seguía rozando (lo señaló el usuario): 16px.
    paddingRight: "var(--space-4)",
  },
  row: {
    padding: "var(--space-1) var(--space-3)",
    borderRadius: "var(--radius-md)",
  },
  rowGrid: {
    display: "grid",
    gridTemplateColumns: FILA_GRID,
    gap: "var(--space-2)",
    alignItems: "center",
    // Ficha, no fila: la columna izquierda apila cuatro líneas.
    minHeight: 104,
  },
  rangoLinea: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    whiteSpace: "nowrap",
  },
  rangoIcono: {
    width: 18,
    height: 18,
    display: "block",
  },
  bloque: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
  },
  nombreInv: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    display: "flex",
    alignItems: "baseline",
    gap: 3,
  },
  kdaLinea: {
    fontSize: 14,
    fontWeight: 700,
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  spellCol: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  spellIcon: {
    width: 20,
    height: 20,
    borderRadius: 3,
    display: "block",
  },
  itemsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 26px)",
    gap: 2,
    alignContent: "center",
  },
  colIzq: {
    display: "flex",
    flexDirection: "column",
    gap: 1,
    minWidth: 0,
  },
  cola: {
    // 11px porque "Ranked Solo/Duo" tiene que caber entero en 96px.
    fontSize: 11,
    fontWeight: 600,
    color: "var(--text)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  rivalCell: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    minWidth: 0,
  },
  rivalNombre: {
    fontSize: 12,
    fontWeight: 500,
    color: "var(--muted)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  itemsCell: {
    display: "flex",
    gap: 3,
    alignItems: "center",
  },
  itemIcon: {
    width: 26,
    height: 26,
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--line-soft)",
    background: "var(--sunken)",
    display: "block",
  },
  headRow: {
    display: "grid",
    gridTemplateColumns: FILA_GRID,
    gap: "var(--space-2)",
    alignItems: "center",
    // 2px del borde de resultado + el padding horizontal de la fila,
    // para que las columnas caigan en la misma vertical.
    padding: "0 var(--space-3) var(--space-2) calc(var(--space-3) + 2px)",
  },
  result: {
    fontFamily: "var(--font-mono)",
    fontSize: "10px",
    letterSpacing: "0.12em",
  },
  champ: {
    fontSize: "var(--font-sm)",
    fontWeight: 600,
    color: "var(--text)",
    lineHeight: 1.25,
  },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    marginTop: "2px",
    flexWrap: "wrap",
  },
};
