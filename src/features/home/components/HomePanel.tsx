import React, { useEffect, useMemo, useState } from "react";
import { MatchMetadata } from "../../../types";
import { currentFocus, deathClock, confidenceOf } from "../../../core/patterns";
import { outcome, formatDuration } from "../../../core/matchStats";
import { invoke } from "@tauri-apps/api/core";
import { HardDrive, Target, Radio } from "lucide-react";
import { useT } from "../../../core/LanguageProvider";

/**
 * Hoy: en qué estás trabajando.
 *
 * Lo primero al abrir la app deja de ser una lista de ficheros. La app estaba
 * organizada por tipo de archivo —vídeos, clips, errores, VODs, drills— y eso
 * contesta "¿dónde están mis cosas?", que no es la pregunta de nadie. Aquí lo
 * primero es la debilidad en la que toca trabajar.
 *
 * La grabación baja a una tira de estado: es algo que la app HACE, no un sitio
 * al que vas.
 */

interface DiskSpaceInfo {
  used_bytes: number;
  total_bytes: number;
}

const relativeDay = (iso: string): string => {
  const d = new Date(iso.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return iso.split(" ")[0];
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(d)) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return iso.split(" ")[0];
};

export interface HomePanelProps {
  matches: MatchMetadata[];
  isRecording: boolean;
  onOpenMatch: (match: MatchMetadata) => void;
  onGoTraining: () => void;
}

export const HomePanel: React.FC<HomePanelProps> = ({
  matches,
  isRecording,
  onOpenMatch,
  onGoTraining,
}) => {
  const [disk, setDisk] = useState<DiskSpaceInfo | null>(null);
  const t = useT();

  useEffect(() => {
    invoke<DiskSpaceInfo>("get_disk_usage").then(setDisk).catch(() => {});
  }, [matches]);

  const own = useMemo(() => matches.filter((m) => !m.is_vod), [matches]);
  const focus = useMemo(() => currentFocus(own), [own]);
  const clock = useMemo(() => deathClock(own), [own]);
  const conf = confidenceOf(own.length);

  /** Las partidas donde ocurre la debilidad, de más reciente a más antigua. */
  const affected = useMemo(() => {
    if (!focus) return [];
    const { from, to } = focus.bucket;
    return own
      .filter((m) => {
        const off = m.video_offset ?? 0;
        return m.events.some((ev) => {
          if (ev.type !== "ChampionKill" || ev.subtype !== "death") return false;
          const t = Math.max(0, ev.time - off) / 60;
          return t >= from && t < to;
        });
      })
      .slice(0, 4);
  }, [own, focus]);

  const toReview = useMemo(
    () => own.filter((m) => (m.comments?.length ?? 0) === 0).slice(0, 4),
    [own]
  );

  const usedGb = disk ? (disk.used_bytes / 1024 ** 3).toFixed(1) : "—";
  const totalGb = disk ? (disk.total_bytes / 1024 ** 3).toFixed(0) : "—";

  return (
    <div style={styles.container} className="panel-enter">
      {/* Tira de captura: el estado más importante de una app siempre encendida,
          visible sin ir a ninguna parte. */}
      <div style={styles.capture}>
        {isRecording ? (
          <span style={{ ...styles.capItem, color: "var(--signal)" }}>
            <span className="rec-dot" /> {t("Recording")}
          </span>
        ) : (
          <span style={styles.capItem}>
            <Radio size={13} color="var(--faint)" /> {t("Idle — records itself when a game starts")}
          </span>
        )}
        <span style={styles.capItem}>
          <HardDrive size={13} color="var(--faint)" />
          <span className="u-metric" style={{ fontSize: 11 }}>{usedGb} / {totalGb} GB</span>
        </span>
      </div>

      <div style={styles.body}>
        {focus ? (
          <section>
            <div className="u-label" style={{ marginBottom: 10 }}>{t("What to work on")}</div>

            <div style={styles.focus}>
              {/* Marca de agua. Es la única superficie de la app con imagen; de
                  momento es luz, no arte: el splash del campeón iría aquí. */}
              <div style={styles.focusArt} aria-hidden="true" />

              <div style={styles.focusIn}>
                <span style={styles.focusTag}>
                  {focus.bucket.total} {t("deaths")} · {focus.games} {t("games")}
                </span>

                <h1 style={styles.focusTitle}>
                  {t("You die between minute {a} and {b}", { a: focus.bucket.from, b: focus.bucket.to })}
                </h1>

                <p style={styles.focusText}>
                  It is your worst window: <strong style={{ color: "var(--text)" }}>
                  {focus.bucket.total} of your {clock.total} deaths</strong> land there
                  {" "}({Math.round(focus.share * 100)}% of them).
                  {conf === "low" && (
                    <span style={{ color: "var(--faint)" }}>
                      {" "}With {own.length} games this is a lead, not a conclusion — it sharpens as you record more.
                    </span>
                  )}
                </p>

                {affected.length > 0 && (
                  <div style={styles.affected}>
                    <div className="u-label" style={{ marginBottom: 8 }}>
                      {t("Where it happened")}
                      {focus.games > affected.length && ` · latest ${affected.length} of ${focus.games}`}
                    </div>
                    {affected.map((m) => {
                      const res = outcome(m.result);
                      const color =
                        res === "victory" ? "var(--win)" : res === "defeat" ? "var(--loss)" : "var(--line)";
                      return (
                        <div
                          key={m.id}
                          style={styles.mini}
                          role="button"
                          tabIndex={0}
                          onClick={() => onOpenMatch(m)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenMatch(m); }
                          }}
                        >
                          <span style={{ ...styles.miniStripe, background: color }} />
                          <span style={styles.miniName}>
                            {m.champion}
                            <span className="u-meta" style={{ display: "block", marginTop: 2 }}>
                              {t(res === "victory" ? "victory" : res === "defeat" ? "defeat" : "no result")} · {t(relativeDay(m.date))}
                            </span>
                          </span>
                          <span className="u-metric" style={styles.miniDur}>
                            {formatDuration(m.game_duration)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                <button
                  type="button"
                  className="btn btn--ghost btn--md"
                  style={{ marginTop: "var(--space-4)" }}
                  onClick={onGoTraining}
                >
                  <Target size={14} /> {t("Train camera control")}
                </button>
              </div>
            </div>
          </section>
        ) : (
          <section style={styles.emptyFocus}>
            <div className="u-label" style={{ marginBottom: 8 }}>{t("What to work on")}</div>
            <p style={styles.focusText}>
              {t("Nothing to point at yet. Record a few games and this turns into the one thing worth working on.")}
            </p>
          </section>
        )}

        {toReview.length > 0 && (
          <section>
            <div className="u-label" style={{ marginBottom: 10 }}>
              {t("To review")} · {own.filter((m) => (m.comments?.length ?? 0) === 0).length} {t("games")}
            </div>
            <div style={styles.reviewGrid}>
              {toReview.map((m) => {
                const res = outcome(m.result);
                const color =
                  res === "victory" ? "var(--win)" : res === "defeat" ? "var(--loss)" : "var(--line)";
                const gold = m.gold_diff_15;
                return (
                  <div
                    key={m.id}
                    className="card card--interactive"
                    style={{ ...styles.reviewCard, borderLeft: `2px solid ${color}` }}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenMatch(m)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenMatch(m); }
                    }}
                  >
                    <div style={styles.reviewName}>{m.champion}</div>
                    <div className="u-meta" style={{ marginTop: 3 }}>{t(relativeDay(m.date))}</div>
                    <div
                      className="u-metric"
                      style={{
                        fontSize: 16,
                        fontWeight: 600,
                        marginTop: "var(--space-3)",
                        color:
                          gold === undefined || gold === null
                            ? "var(--muted)"
                            : gold >= 0 ? "var(--win)" : "var(--loss)",
                      }}
                    >
                      {gold === undefined || gold === null
                        ? "—"
                        : `${gold >= 0 ? "+" : "−"}${Math.abs(gold)}`}
                    </div>
                    <div className="u-label" style={{ marginTop: 3 }}>{t("gold @15")}</div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    boxSizing: "border-box",
    backgroundColor: "var(--bg-app)",
    overflow: "hidden",
  },
  capture: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-5)",
    padding: "var(--space-2) var(--space-8)",
    background: "var(--panel)",
    borderBottom: "1px solid var(--line-soft)",
  },
  capItem: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    fontFamily: "var(--font-mono)",
    fontSize: "10.5px",
    letterSpacing: "0.05em",
    color: "var(--faint)",
  },
  body: {
    flex: 1,
    overflowY: "auto",
    padding: "var(--space-6) var(--space-8)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-6)",
  },
  focus: {
    position: "relative",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius-lg)",
    background: "var(--panel)",
    overflow: "hidden",
  },
  focusArt: {
    position: "absolute",
    inset: 0,
    background:
      "radial-gradient(60% 120% at 80% 25%, color-mix(in srgb, var(--brand) 14%, transparent) 0%, transparent 60%)," +
      "radial-gradient(80% 140% at 96% 75%, color-mix(in srgb, var(--cool) 10%, transparent) 0%, transparent 55%)",
    pointerEvents: "none",
  },
  focusIn: {
    position: "relative",
    padding: "var(--space-5) var(--space-6)",
    maxWidth: "62ch",
  },
  focusTag: {
    display: "inline-flex",
    alignItems: "center",
    fontFamily: "var(--font-mono)",
    fontSize: "9.5px",
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: "var(--loss)",
    background: "color-mix(in srgb, var(--loss) 12%, transparent)",
    border: "1px solid color-mix(in srgb, var(--loss) 30%, transparent)",
    padding: "3px 9px",
    borderRadius: "var(--radius-sm)",
  },
  focusTitle: {
    fontSize: "24px",
    fontWeight: 600,
    letterSpacing: "-0.02em",
    margin: "var(--space-3) 0 var(--space-2)",
    color: "var(--text)",
  },
  focusText: {
    margin: 0,
    fontSize: "var(--font-sm)",
    lineHeight: 1.55,
    color: "var(--muted)",
    maxWidth: "58ch",
  },
  affected: {
    marginTop: "var(--space-4)",
    paddingTop: "var(--space-4)",
    borderTop: "1px solid var(--line-soft)",
  },
  mini: {
    display: "grid",
    gridTemplateColumns: "2px 1fr auto",
    gap: "var(--space-3)",
    alignItems: "center",
    padding: "var(--space-2) 0",
    borderBottom: "1px solid var(--line-soft)",
    cursor: "pointer",
  },
  miniStripe: { alignSelf: "stretch", borderRadius: "1px" },
  miniName: { fontSize: "var(--font-xs)", color: "var(--text)", minWidth: 0 },
  miniDur: { fontSize: "11px", color: "var(--faint)" },
  emptyFocus: {
    border: "1px solid var(--line-soft)",
    borderRadius: "var(--radius-lg)",
    padding: "var(--space-5) var(--space-6)",
    background: "var(--panel)",
  },
  reviewGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
    gap: "var(--space-3)",
  },
  reviewCard: { padding: "var(--space-3) var(--space-4) var(--space-4)" },
  reviewName: { fontSize: "var(--font-sm)", fontWeight: 600, color: "var(--text)" },
};
