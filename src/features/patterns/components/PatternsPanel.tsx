import React, { useEffect, useMemo, useState } from "react";
import { MatchMetadata } from "../../../types";
import {
  deathClock,
  errorCategories,
  confidenceOf,
  type Confidence,
} from "../../../core/patterns";
import { ErrorClipMetadata, getAllErrorClips, getRecordedMatches } from "../../../core/tauri-ipc";
import { EmptyState } from "../../../components/ui/EmptyState";
import { BarChart3 } from "lucide-react";

/**
 * Patrones: la única pantalla que mira más de una partida a la vez.
 *
 * El resto de la app trabaja siempre sobre una sola, y por eso datos como "en
 * qué minuto te mueres" llevaban meses en disco sin que nadie los enseñara.
 *
 * Regla de esta pantalla: no afirmar más de lo que aguanta la muestra. Con
 * quince partidas, dos muertes de diferencia entre tramos no son un hallazgo, y
 * presentarlas como tal sería mentir con gráficas.
 */

const CONFIDENCE_COPY: Record<Confidence, { label: string; note: string; color: string }> = {
  low: {
    label: "Early signal",
    note: "Under 15 games this points at a tendency, not a conclusion. It sharpens as you record more.",
    color: "var(--faint)",
  },
  medium: {
    label: "Likely pattern",
    note: "Enough games to steer by, though small gaps between windows are still noise.",
    color: "var(--gold)",
  },
  good: {
    label: "Solid pattern",
    note: "Enough games to trust the overall shape.",
    color: "var(--win)",
  },
};

const CATEGORY_COLOR: Record<string, string> = {
  "Decision Making": "var(--gold)",
  Positioning: "var(--flag)",
  Mechanics: "var(--cool)",
  Other: "var(--muted)",
};

export const PatternsPanel: React.FC = () => {
  const [matches, setMatches] = useState<MatchMetadata[]>([]);
  const [clips, setClips] = useState<ErrorClipMetadata[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    Promise.all([getRecordedMatches(), getAllErrorClips().catch(() => [])])
      .then(([ms, cs]) => {
        if (!alive) return;
        setMatches(ms);
        setClips(cs);
      })
      .catch(console.error)
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  // Los VODs importados no son partidas tuyas: mezclarlos falsearía el reloj.
  const own = useMemo(() => matches.filter((m) => !m.is_vod), [matches]);
  const clock = useMemo(() => deathClock(own), [own]);
  const cats = useMemo(() => errorCategories(clips), [clips]);
  const conf = confidenceOf(own.length);
  const maxBucket = useMemo(
    () => clock.buckets.reduce((a, b) => Math.max(a, b.total), 0),
    [clock]
  );
  const maxCat = useMemo(() => cats.reduce((a, c) => Math.max(a, c.count), 0), [cats]);

  if (loading) {
    return (
      <div style={styles.container} className="panel-enter">
        <div style={styles.center}><div className="spinner" /></div>
      </div>
    );
  }

  if (clock.total === 0) {
    return (
      <div style={styles.container} className="panel-enter">
        <div style={styles.header}>
          <h1 style={styles.title}>Patterns</h1>
        </div>
        <EmptyState
          icon={<BarChart3 size={30} color="var(--faint)" />}
          title="Not enough games yet"
          text="Once a few games are recorded, this screen starts showing what they have in common."
        />
      </div>
    );
  }

  const c = CONFIDENCE_COPY[conf];

  return (
    <div style={styles.container} className="panel-enter">
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Patterns</h1>
          <div className="u-meta" style={{ marginTop: 4 }}>
            {own.length} games · {clock.total} deaths · {clock.wins}W {clock.losses}L
          </div>
        </div>
        <span style={{ ...styles.confidence, color: c.color, borderColor: c.color }}>
          {c.label}
        </span>
      </div>

      <div style={styles.grid}>
        {/* ---------------------------------------------------- reloj */}
        <div className="card" style={styles.card}>
          <div style={styles.cardHead}>
            <span className="u-label">When you die</span>
            <span className="u-meta">by minute of game</span>
          </div>

          <div style={styles.clock}>
            {clock.buckets.map((b) => {
              const isPeak = clock.peak !== null && b.from === clock.peak.from;
              return (
                <div
                  key={b.from}
                  style={styles.clockRow}
                  title={`${b.total} deaths · ${b.inWins} in wins, ${b.inLosses} in losses`}
                >
                  <span
                    className="u-metric"
                    style={{
                      ...styles.clockTime,
                      color: isPeak ? "var(--loss)" : "var(--faint)",
                    }}
                  >
                    {b.from}–{b.to}
                  </span>
                  <span style={styles.clockTrack}>
                    <span
                      style={{
                        ...styles.clockFill,
                        width: `${maxBucket ? (b.total / maxBucket) * 100 : 0}%`,
                        opacity: isPeak ? 1 : 0.45,
                      }}
                    />
                  </span>
                  <span className="u-metric" style={styles.clockValue}>{b.total}</span>
                </div>
              );
            })}
          </div>

          {clock.peak && (
            <div style={styles.insight}>
              <p style={styles.insightText}>
                <strong style={{ color: "var(--text)" }}>
                  Minute {clock.peak.from}–{clock.peak.to} is your worst window.
                </strong>{" "}
                {clock.peak.total} of your {clock.total} deaths land there
                {" "}({Math.round((clock.peak.total / clock.total) * 100)}%).
              </p>
              <p style={{ ...styles.insightText, color: "var(--faint)", marginTop: 6 }}>
                {c.note}
              </p>
            </div>
          )}

          {clock.deathsPerWin !== null && clock.deathsPerLoss !== null && (
            <div style={styles.split}>
              <div>
                <div className="u-metric" style={{ fontSize: 16, color: "var(--win)" }}>
                  {clock.deathsPerWin.toFixed(1)}
                </div>
                <div className="u-label" style={{ marginTop: 3 }}>deaths per win</div>
              </div>
              <div>
                <div className="u-metric" style={{ fontSize: 16, color: "var(--loss)" }}>
                  {clock.deathsPerLoss.toFixed(1)}
                </div>
                <div className="u-label" style={{ marginTop: 3 }}>deaths per loss</div>
              </div>
            </div>
          )}
        </div>

        {/* ---------------------------------------------- tus etiquetas */}
        <div className="card" style={styles.card}>
          <div style={styles.cardHead}>
            <span className="u-label">What you flag yourself</span>
            <span className="u-meta">{cats.reduce((a, x) => a + x.count, 0)} notes</span>
          </div>

          {cats.length === 0 ? (
            <p style={styles.insightText}>
              You haven't categorised any errors yet. The chart on the left comes from the
              recorded data; this one would come from your own reading of it.
            </p>
          ) : (
            <div style={styles.cats}>
              {cats.map((x) => (
                <div key={x.category} style={styles.catRow}>
                  <div style={{ minWidth: 0 }}>
                    <div style={styles.catLabel}>{x.category}</div>
                    <div style={styles.catTrack}>
                      <span
                        style={{
                          ...styles.catFill,
                          width: `${maxCat ? (x.count / maxCat) * 100 : 0}%`,
                          background: CATEGORY_COLOR[x.category] ?? "var(--muted)",
                        }}
                      />
                    </div>
                  </div>
                  <span className="u-metric" style={styles.catValue}>{x.count}</span>
                </div>
              ))}
            </div>
          )}

          {/* La pantalla es honesta sobre su propia cobertura: si marcas poco,
              lo dice, en vez de presentar tres notas como si fueran un perfil. */}
          {clock.total > 0 && (
            <div style={{ ...styles.insight, borderLeftColor: "var(--gold)" }}>
              <p style={styles.insightText}>
                <strong style={{ color: "var(--text)" }}>
                  {cats.reduce((a, x) => a + x.count, 0)} notes across {clock.total} deaths.
                </strong>{" "}
                The window above comes from the data, not from your reading of it. Flagging
                even one moment per game is what turns "when" into "why".
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: "var(--space-6) var(--space-8)",
    height: "100%",
    boxSizing: "border-box",
    overflowY: "auto",
    backgroundColor: "var(--bg-app)",
  },
  center: { display: "grid", placeItems: "center", height: "100%" },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "var(--space-4)",
    marginBottom: "var(--space-5)",
  },
  title: { margin: 0, fontSize: "var(--font-xl)" },
  confidence: {
    fontFamily: "var(--font-mono)",
    fontSize: "10px",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    padding: "4px 10px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
    gap: "var(--space-4)",
    alignItems: "start",
  },
  card: { padding: "var(--space-4)" },
  cardHead: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: "var(--space-4)",
  },
  clock: { display: "flex", flexDirection: "column", gap: "4px" },
  clockRow: {
    display: "grid",
    gridTemplateColumns: "56px 1fr 28px",
    gap: "var(--space-3)",
    alignItems: "center",
  },
  clockTime: { fontSize: "10px" },
  clockTrack: {
    height: "11px",
    background: "var(--sunken)",
    borderRadius: "2px",
    overflow: "hidden",
  },
  clockFill: {
    display: "block",
    height: "100%",
    borderRadius: "2px",
    background: "var(--loss)",
  },
  clockValue: { fontSize: "10.5px", textAlign: "right", color: "var(--muted)" },
  insight: {
    marginTop: "var(--space-4)",
    padding: "var(--space-3)",
    borderLeft: "2px solid var(--loss)",
    background: "color-mix(in srgb, var(--loss) 7%, transparent)",
    borderRadius: "0 var(--radius-sm) var(--radius-sm) 0",
  },
  insightText: {
    margin: 0,
    fontSize: "var(--font-xs)",
    lineHeight: 1.55,
    color: "var(--muted)",
  },
  split: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "var(--space-4)",
    marginTop: "var(--space-4)",
    paddingTop: "var(--space-4)",
    borderTop: "1px solid var(--line-soft)",
  },
  cats: { display: "flex", flexDirection: "column", gap: "var(--space-3)" },
  catRow: {
    display: "grid",
    gridTemplateColumns: "1fr 32px",
    gap: "var(--space-3)",
    alignItems: "center",
  },
  catLabel: { fontSize: "var(--font-xs)", color: "var(--muted)" },
  catTrack: {
    height: "4px",
    background: "var(--sunken)",
    borderRadius: "2px",
    overflow: "hidden",
    marginTop: "5px",
  },
  catFill: { display: "block", height: "100%", borderRadius: "2px" },
  catValue: { fontSize: "11px", textAlign: "right", color: "var(--muted)" },
};
