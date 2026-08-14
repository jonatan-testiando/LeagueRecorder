import React, { useEffect, useState, useRef, useMemo } from "react";
import { MatchMetadata } from "../../../types";
import { computeKDA, kdaRatio, outcome, formatDuration } from "../../../core/matchStats";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { MatchTimeline } from "./MatchTimeline";
import { Metric } from "../../../components/ui/Metric";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { HardDrive, Search, Trash2, Gamepad2, SearchX } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";

interface DiskSpaceInfo {
  used_bytes: number;
  total_bytes: number;
}

// queueId de Riot → nombre legible de la cola.
const queueLabel = (q?: number): string => {
  switch (q) {
    case 420: return "Ranked Solo/Duo";
    case 440: return "Ranked Flex";
    case 400: return "Normal Draft";
    case 430: return "Normal Blind";
    case 490: return "Normal";
    case 450: return "ARAM";
    case 700: return "Clash";
    case 830: case 840: case 850: return "Co-op vs AI";
    case 900: case 1010: case 1900: return "URF";
    case 0: return "Custom";
    default: return "Synced";
  }
};

/**
 * Fecha relativa. Con 19 partidas repartidas en cinco dias, "2026-08-12"
 * repetido no distingue nada; "hace 2 dias" si.
 */
const relativeDay = (iso: string): string => {
  const d = new Date(iso.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return iso.split(" ")[0];
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(today) - start(d)) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return iso.split(" ")[0];
};

type Filter = "all" | "unreviewed" | "defeats";

interface MatchGalleryProps {
  matches: MatchMetadata[];
  onSelectMatch: (match: MatchMetadata) => void;
  onDeleteMatch: (id: string) => void;
  isRecording: boolean;
}

export const MatchGallery: React.FC<MatchGalleryProps> = ({
  matches,
  onSelectMatch,
  onDeleteMatch,
  isRecording,
}) => {
  const [diskSpace, setDiskSpace] = useState<DiskSpaceInfo>({ used_bytes: 0, total_bytes: 100 * 1024 * 1024 * 1024 });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const parentRef = useRef<HTMLDivElement>(null);

  // El buscador y los filtros existen de verdad: antes el campo estaba
  // `disabled` con un placeholder y la fila de pestañas tenía una sola pestaña
  // siempre activa. Un control que se ve pero no hace nada es lo que más rápido
  // delata un prototipo, y los datos para filtrar ya estaban aquí.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return matches.filter((m) => {
      if (filter === "defeats" && outcome(m.result) !== "defeat") return false;
      if (filter === "unreviewed" && (m.comments?.length ?? 0) > 0) return false;
      if (!q) return true;
      return (
        m.champion.toLowerCase().includes(q) ||
        queueLabel(m.queue).toLowerCase().includes(q) ||
        m.date.toLowerCase().includes(q)
      );
    });
  }, [matches, query, filter]);

  /**
   * La lista que se pinta: cabeceras de dia intercaladas entre las partidas.
   *
   * Van en la misma lista plana y no en un contenedor aparte porque la lista
   * esta virtualizada: el virtualizador solo entiende un indice lineal.
   *
   * El agrupado es por tramos consecutivos, asi que si algun dia llegara
   * desordenado se veria como dos tramos en vez de mentir juntandolos.
   */
  const rows = useMemo(() => {
    type Row =
      | { kind: "day"; label: string; count: number; key: string }
      | { kind: "match"; match: MatchMetadata; key: string };
    const out: Row[] = [];
    let i = 0;
    while (i < visible.length) {
      const label = relativeDay(visible[i].date);
      let j = i;
      while (j < visible.length && relativeDay(visible[j].date) === label) j++;
      out.push({ kind: "day", label, count: j - i, key: `day-${label}-${i}` });
      for (let k = i; k < j; k++) {
        out.push({ kind: "match", match: visible[k], key: visible[k].id });
      }
      i = j;
    }
    return out;
  }, [visible]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    // Estimación inicial; la altura real se mide con `measureElement` porque la
    // línea de tiempo hace que la fila sea más alta de lo que parece.
    estimateSize: () => 92,
    overscan: 5,
  });

  useEffect(() => {
    invoke<DiskSpaceInfo>("get_disk_usage")
      .then(setDiskSpace)
      .catch(console.error);
  }, [matches]);

  const usedGb = (diskSpace.used_bytes / (1024 * 1024 * 1024)).toFixed(1);
  const totalGb = (diskSpace.total_bytes / (1024 * 1024 * 1024)).toFixed(0);
  const pct = Math.min(100, Math.round((diskSpace.used_bytes / diskSpace.total_bytes) * 100));
  // El disco solo pide atención cuando queda poco. Por debajo del 85% es un
  // dato, no un aviso, y se pinta apagado.
  const diskTight = pct >= 85;

  const reviewed = matches.filter((m) => (m.comments?.length ?? 0) > 0).length;

  return (
    <div style={styles.container} className="panel-enter">
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>Library</h1>
          <div className="u-meta" style={{ marginTop: 4 }}>
            {matches.length} games · {reviewed} reviewed · {matches.length - reviewed} to review
          </div>
        </div>

        <div style={styles.tools}>
          <label style={styles.searchBox}>
            <Search size={14} color="var(--faint)" />
            <input
              type="text"
              placeholder="champion, queue, date…"
              aria-label="Filter games"
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
              {label}
            </Button>
          ))}
        </div>
      </div>

      <div style={styles.statusRow}>
        <div style={styles.statusItem}>
          <HardDrive size={14} color="var(--faint)" />
          <span className="u-metric" style={{ fontSize: 12 }}>
            {usedGb} / {totalGb} GB
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
          <span className="u-meta">{pct}%</span>
        </div>

        {isRecording && (
          <div style={styles.recording}>
            <span className="rec-dot" /> RECORDING
          </div>
        )}
      </div>

      <div style={styles.tableHeader}>
        <span className="u-label" style={{ flex: 1 }}>Game</span>
        <span className="u-label" style={styles.thNum}>KDA</span>
        <span className="u-label" style={styles.thNum}>Gold @15</span>
        <span className="u-label" style={styles.thNum}>Duration</span>
        <span className="u-label" style={styles.thNum}>APM</span>
        <span style={{ width: 36 }} />
      </div>

      <div style={styles.list} ref={parentRef}>
        {matches.length === 0 ? (
          <EmptyState
            icon={<Gamepad2 size={30} color="var(--faint)" />}
            title="No games recorded yet"
            text="Play a match and it will show up here automatically."
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<SearchX size={30} color="var(--faint)" />}
            title="No games match this filter"
            text="Try a different search term, or switch back to All."
            action={
              <Button variant="ghost" size="sm" onClick={() => { setQuery(""); setFilter("all"); }}>
                Clear filters
              </Button>
            }
          />
        ) : (
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
                      <span className="day-sep__label">{row.label}</span>
                      <span className="day-sep__rule" />
                      <span className="day-sep__count">
                        {row.count} {row.count === 1 ? "game" : "games"}
                      </span>
                    </div>
                  </div>
                );
              }

              const match = row.match;
              const kda = computeKDA(match.events);
              const res = outcome(match.result);
              const accent =
                res === "victory" ? "var(--win)" : res === "defeat" ? "var(--loss)" : "var(--line)";
              const unreviewed = (match.comments?.length ?? 0) === 0;

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
                    className="card card--interactive"
                    style={{ ...styles.row, borderLeft: `2px solid ${accent}` }}
                    onClick={() => onSelectMatch(match)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectMatch(match); }
                    }}
                  >
                    <div style={styles.rowTop}>
                      <div style={styles.who}>
                        <ChampionAvatar champion={match.champion} size={30} />
                        <div style={{ minWidth: 0 }}>
                          <div style={styles.champ}>{match.champion}</div>
                          {/* La cola sale de la fila: es "Ranked Solo/Duo" en las
                              15 partidas sincronizadas, o sea 0% de dispersion.
                              Un dato identico en todas las filas no es
                              informacion, es ruido con ancho. Sigue estando en
                              el buscador. */}
                          <div style={styles.meta}>
                            <span style={{ ...styles.result, color: accent }}>
                              {res === "victory" ? "VICTORY" : res === "defeat" ? "DEFEAT" : "NO RESULT"}
                            </span>
                            <span className="u-meta">{relativeDay(match.date)}</span>
                            {unreviewed && (
                              <span className="u-meta" style={{ color: "var(--flag)" }}>· to review</span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* El peso va por dispersion. En estas 19 partidas el oro@15
                          va de -2587 a +2710 y el APM de 219 a 307: uno separa una
                          partida de otra y el otro es casi el mismo numero
                          siempre. Antes se pintaban igual. */}
                      <Metric
                        value={
                          match.kda
                            ? match.kda.replace(/\//g, " / ")
                            : <>{kda.kills} / <span style={{ color: "var(--loss)" }}>{kda.deaths}</span> / {kda.assists}</>
                        }
                        label="K D A"
                        title={`${kdaRatio(kda)} KDA`}
                      />
                      <Metric
                        value={
                          match.gold_diff_15 === undefined || match.gold_diff_15 === null
                            ? "—"
                            : `${match.gold_diff_15 >= 0 ? "+" : "−"}${Math.abs(match.gold_diff_15)}`
                        }
                        label="Gold @15"
                        emphasis="lead"
                        tone={
                          match.gold_diff_15 === undefined || match.gold_diff_15 === null
                            ? "muted"
                            : match.gold_diff_15 >= 0 ? "win" : "loss"
                        }
                        title={match.lane_result ? `Lane: ${match.lane_result}` : undefined}
                      />
                      <Metric value={formatDuration(match.game_duration)} label="Dur." />
                      <Metric value={Math.round(match.apm || 0)} label="APM" tone="muted" />

                      <div style={{ width: 36, display: "flex", justifyContent: "flex-end" }}>
                        <Button
                          variant="danger"
                          size="sm"
                          title="Delete game"
                          aria-label={`Delete ${match.champion} game`}
                          onClick={(e) => { e.stopPropagation(); onDeleteMatch(match.id); }}
                          icon={<Trash2 size={15} />}
                        />
                      </div>
                    </div>

                    <MatchTimeline
                      events={match.events}
                      duration={match.game_duration}
                      apmSeries={match.apm_series}
                      cameraSnaps={match.camera_snaps}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="mtl-legend" style={styles.legend}>
        <span><i style={{ background: "var(--loss)" }} />Death</span>
        <span><i style={{ background: "var(--win)" }} />Kill</span>
        <span><i style={{ background: "var(--gold)" }} />Objective</span>
        <span><i style={{ background: "var(--cool-fill)" }} />Structure</span>
        <span><i style={{ background: "var(--apm-line)" }} />APM</span>
      </div>
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
  searchBox: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    background: "var(--sunken)",
    border: "1px solid var(--line-soft)",
    borderRadius: "var(--radius-md)",
    padding: "5px var(--space-3)",
    minWidth: "210px",
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
  },
  barFill: {
    display: "block",
    height: "100%",
    borderRadius: "var(--radius-full)",
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
  tableHeader: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-4)",
    padding: "0 var(--space-4) var(--space-2)",
    borderBottom: "1px solid var(--line-soft)",
  },
  thNum: {
    width: "84px",
    textAlign: "right",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    overflowY: "auto",
    position: "relative",
    paddingTop: "var(--space-2)",
  },
  row: {
    padding: "var(--space-2) var(--space-4) var(--space-3)",
    borderRadius: "var(--radius-md)",
  },
  result: {
    fontFamily: "var(--font-mono)",
    fontSize: "10px",
    letterSpacing: "0.12em",
  },
  rowTop: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-4)",
  },
  who: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    flex: 1,
    minWidth: 0,
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
  legend: {
    display: "flex",
    gap: "var(--space-4)",
    flexWrap: "wrap",
    paddingTop: "var(--space-3)",
    fontFamily: "var(--font-mono)",
    fontSize: "9px",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "var(--faint)",
  },
};
