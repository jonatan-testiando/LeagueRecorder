import React, { useEffect, useState, useRef, useMemo } from "react";
import { MatchMetadata } from "../../../types";
import { computeKDA, kdaRatio, outcome, formatDuration, type KDA } from "../../../core/matchStats";
import { DDRAGON_VER, itemIcon, spellIcon } from "../../player/components/videoPlayerUtils";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { Metric } from "../../../components/ui/Metric";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { HardDrive, Search, Trash2, Gamepad2, SearchX } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useT } from "../../../core/LanguageProvider";

import { matchAge, relativeDay } from "../../../core/time";
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
type Filter = "all" | "unreviewed" | "defeats";

interface MatchGalleryProps {
  matches: MatchMetadata[];
  onSelectMatch: (match: MatchMetadata) => void;
  onDeleteMatch: (id: string) => void;
  isRecording: boolean;
}

/* Rejilla de la fila. La comparten la cabecera y las filas: son la misma tabla.
   avatar · quién · línea de tiempo (el resto del ancho) · 5 métricas · borrar */
const FILA_GRID = "90px 44px minmax(104px, 1fr) 72px 48px 36px 52px 126px minmax(120px, 170px) 50px 26px";

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
  isRecording,
}) => {
  const [diskSpace, setDiskSpace] = useState<DiskSpaceInfo>({ used_bytes: 0, total_bytes: 100 * 1024 * 1024 * 1024 });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const t = useT();

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
  }, [visible]);

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
      if (anchoPrevio.current === 0 && w > 0) rowVirtualizer.measure();
      anchoPrevio.current = w;
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
              <Button variant="ghost" size="sm" onClick={() => { setQuery(""); setFilter("all"); }}>
                {t("Clear filters")}
              </Button>
            }
          />
        ) : (
          <>
          <div style={styles.headRow}>
            <span />
            <span />
            <span className="u-label">{t("Game")}</span>
            <span className="u-label" style={{ textAlign: "right" }}>KDA</span>
            <span className="u-label" style={{ textAlign: "right" }}>CS</span>
            <span className="u-label" style={{ textAlign: "right" }}>KP</span>
            <span className="u-label" style={{ textAlign: "right" }}>{t("Gold @15")}</span>
            <span className="u-label">{t("Items")}</span>
            <span className="u-label">{t("vs rival")}</span>
            <span className="u-label" style={{ textAlign: "right" }}>Score</span>
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
              const kills_equipo = yo
                ? match.participants!.filter((p) => p.team_id === yo.team_id).reduce((a, p) => a + p.kills, 0)
                : 0;
              const kp = yo && kills_equipo > 0 ? Math.round(((yo.kills + yo.assists) / kills_equipo) * 100) : null;
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
                    className="card card--interactive filaficha"
                    style={{
                      ...styles.row,
                      borderLeft: `2px solid ${accent}`,
                      // El resultado tiñe la ficha desde arriba, como en la
                      // referencia: la derrota sangra rojo, la victoria jade.
                      background: `linear-gradient(180deg, color-mix(in srgb, ${accent} 12%, var(--panel)) 0%, var(--panel) 78%)`,
                    }}
                    onClick={() => onSelectMatch(match)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectMatch(match); }
                    }}
                  >
                    <div style={styles.rowGrid}>
                      <div style={styles.colIzq}>
                        <span style={styles.cola}>{queueLabel(match.queue)}</span>
                        <span className="u-meta">{matchAge(match.date, t)}</span>
                        <span className="u-meta">{match.patch ? `${t("Patch")} ${match.patch}` : " "}</span>
                        <span className="u-meta">{formatDuration(match.game_duration)}</span>
                      </div>
                      <div style={styles.caraCell}>
                        <ChampionAvatar champion={match.champion} size={28} />
                        {yo?.spells && yo.spells.length > 0 && (
                          <div style={styles.spellCol}>
                            {yo.spells.slice(0, 2).map((sp, si) => {
                              const src = spellIcon(DDRAGON_VER, sp);
                              return src ? <img key={si} src={src} alt="" style={styles.spellIcon} loading="lazy" /> : null;
                            })}
                          </div>
                        )}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={styles.champ}>{match.champion}</div>
                        <div style={styles.meta}>
                          <span style={{ ...styles.result, color: accent }}>
                            {t(res === "victory" ? "VICTORY" : res === "defeat" ? "DEFEAT" : "NO RESULT")}
                          </span>

                          {unreviewed && (
                            <span className="u-meta" style={{ color: "var(--flag)" }}>{t("· to review")}</span>
                          )}
                        </div>
                      </div>

                      <Metric
                        value={<>{kda.kills}/<span style={{ color: "var(--loss)" }}>{kda.deaths}</span>/{kda.assists}</>}
                        label={`${kdaRatio(kda)} KDA`}
                      />
                      <Metric
                        value={yo ? yo.cs : "—"}
                        label={csmin ? `${csmin}/min` : undefined}
                        tone={yo ? "default" : "muted"}
                      />
                      <Metric
                        value={kp !== null ? `${kp}%` : "—"}
                        tone={kp === null ? "muted" : kp >= 60 ? "win" : kp < 35 ? "loss" : "default"}
                        title={t("Kill participation")}
                      />
                      <Metric
                        value={
                          match.gold_diff_15 === undefined || match.gold_diff_15 === null
                            ? "—"
                            : `${match.gold_diff_15 >= 0 ? "+" : "−"}${Math.abs(match.gold_diff_15)}`
                        }
                        emphasis="lead"
                        tone={
                          match.gold_diff_15 === undefined || match.gold_diff_15 === null
                            ? "muted"
                            : match.gold_diff_15 >= 0 ? "win" : "loss"
                        }
                        title={match.lane_result ? `Lane: ${match.lane_result}` : undefined}
                      />
                      <div style={styles.itemsCell}>
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

                      {/* El rival de tu rol, como en la referencia. */}
                      <div style={styles.rivalCell}>
                        {rival ? (
                          <>
                            <div style={styles.caraCell}>
                              <ChampionAvatar champion={rival.champion} size={26} />
                              {rival.spells && rival.spells.length > 0 && (
                                <div style={styles.spellCol}>
                                  {rival.spells.slice(0, 2).map((sp, si) => {
                                    const src = spellIcon(DDRAGON_VER, sp);
                                    return src ? <img key={si} src={src} alt="" style={styles.spellIconSm} loading="lazy" /> : null;
                                  })}
                                </div>
                              )}
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <div style={styles.rivalNombre}>{rival.champion}</div>
                              <div className="u-meta" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {rival.kills}/<span style={{ color: "var(--loss)" }}>{rival.deaths}</span>/{rival.assists} · {rival.cs} cs
                              </div>
                              <div style={styles.rivalItems}>
                                {(rival.items ?? []).filter((it) => it > 0).slice(0, 6).map((it, ii) => (
                                  <img key={ii} src={itemIcon(DDRAGON_VER, it)} alt="" style={styles.rivalItemIcon} loading="lazy" />
                                ))}
                              </div>
                            </div>
                          </>
                        ) : (
                          <span className="u-meta">—</span>
                        )}
                      </div>

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
                              {match.impact_rank === 1 ? "MVP" : match.impact_rank ? `${match.impact_rank}º` : ""}
                            </div>
                          </>
                        ) : (
                          <span className="u-meta">—</span>
                        )}
                      </div>

                      <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        <Button
                          variant="danger"
                          size="sm"
                          title={t("Delete game")}
                          aria-label={`Delete ${match.champion} game`}
                          onClick={(e) => { e.stopPropagation(); onDeleteMatch(match.id); }}
                          icon={<Trash2 size={15} />}
                        />
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
    minHeight: 92,
  },
  caraCell: {
    display: "flex",
    alignItems: "center",
    gap: 3,
  },
  spellCol: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  spellIcon: {
    width: 13,
    height: 13,
    borderRadius: 3,
    display: "block",
  },
  spellIconSm: {
    width: 12,
    height: 12,
    borderRadius: 3,
    display: "block",
  },
  rivalItems: {
    display: "flex",
    gap: 2,
    marginTop: 3,
  },
  rivalItemIcon: {
    width: 16,
    height: 16,
    borderRadius: 3,
    display: "block",
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
    width: 19,
    height: 19,
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
