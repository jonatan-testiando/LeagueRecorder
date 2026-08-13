import React, { useCallback, useEffect, useState } from "react";
import { Zap, Brain, Keyboard, TrendingUp } from "lucide-react";
import { DrillSession, TrainingConfig, getDrillSessions, getTrainingConfig } from "../api";
import { ReflexDrill } from "./ReflexDrill";
import { RecallDrill } from "./RecallDrill";
import { AwarenessQuiz } from "./AwarenessQuiz";
import { TrainingSetup } from "./TrainingSetup";

type Section = "drills" | "awareness" | "setup";

const SECTIONS: { key: Section; label: string; icon: React.ReactNode }[] = [
  { key: "drills", label: "Drills", icon: <Zap size={16} /> },
  { key: "awareness", label: "Awareness", icon: <Brain size={16} /> },
  { key: "setup", label: "Setup", icon: <Keyboard size={16} /> },
];

/** Curva de latencia media de las últimas sesiones: la única prueba de que mejoras. */
const ProgressChart: React.FC<{ sessions: DrillSession[] }> = ({ sessions }) => {
  const data = sessions
    .filter((s) => s.kind === "reflex" && s.avg_latency_ms > 0)
    .slice(0, 20)
    .reverse();
  if (data.length < 2) return null;

  const w = 100;
  const h = 34;
  const max = Math.max(...data.map((d) => d.avg_latency_ms), 600);
  const pts = data
    .map((d, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - (d.avg_latency_ms / max) * h;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const first = data[0].avg_latency_ms;
  const last = data[data.length - 1].avg_latency_ms;
  const delta = last - first;

  return (
    <div style={styles.progressCard}>
      <div style={styles.progressHead}>
        <TrendingUp size={16} color="var(--accent-violet)" />
        <span style={styles.progressTitle}>Avg latency, last {data.length} sessions</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={styles.spark}>
        {/* Línea de referencia de los 400 ms: el umbral en que deja de ser consciente. */}
        <line
          x1="0"
          x2={w}
          y1={h - (400 / max) * h}
          y2={h - (400 / max) * h}
          stroke="var(--border-strong)"
          strokeWidth="0.4"
          strokeDasharray="2 2"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={pts}
          fill="none"
          stroke="var(--accent-violet)"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div style={styles.progressFoot}>
        <span style={{ fontFamily: "var(--font-mono)" }}>{last.toFixed(0)} ms</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            color: delta <= 0 ? "var(--color-victory)" : "var(--accent-gold)",
          }}
        >
          {delta <= 0 ? "" : "+"}
          {delta.toFixed(0)} ms vs first
        </span>
      </div>
    </div>
  );
};

export const TrainingPanel: React.FC = () => {
  const [section, setSection] = useState<Section>("drills");
  const [config, setConfig] = useState<TrainingConfig | null>(null);
  const [sessions, setSessions] = useState<DrillSession[]>([]);

  const loadSessions = useCallback(() => {
    getDrillSessions(30).then(setSessions).catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    getTrainingConfig().then(setConfig).catch(console.error);
    loadSessions();
  }, [loadSessions]);

  if (!config) {
    return <div style={styles.wrapper}>Loading…</div>;
  }

  const noBindings = config.bindings.length === 0;

  return (
    <div style={styles.wrapper}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.pageTitle}>Training</h2>
          <p style={styles.pageSub}>
            Camera keys are not a speed problem. They are a habit, a 400&nbsp;ms read, and a
            question you are trying to answer.
          </p>
        </div>
      </div>

      <div style={styles.tabs}>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            className={section === s.key ? "btn-primary" : "btn-ghost"}
            style={styles.tab}
            onClick={() => setSection(s.key)}
          >
            {s.icon}
            {s.label}
          </button>
        ))}
      </div>

      <div style={styles.content}>
        {section === "setup" ? (
          <TrainingSetup config={config} onSaved={setConfig} />
        ) : section === "awareness" ? (
          <AwarenessQuiz />
        ) : noBindings ? (
          <div className="empty-state">
            <div className="empty-state__icon">
              <Keyboard size={30} color="var(--text-muted)" />
            </div>
            <p className="empty-state__title">No camera keys configured</p>
            <p className="empty-state__text">
              Set which key you press for each ally in Setup, then come back.
            </p>
            <button className="btn-primary" style={styles.tab} onClick={() => setSection("setup")}>
              Go to Setup
            </button>
          </div>
        ) : (
          <div style={styles.drillsGrid}>
            <ReflexDrill config={config} onFinished={loadSessions} />
            <RecallDrill config={config} onFinished={loadSessions} />
            <ProgressChart sessions={sessions} />
          </div>
        )}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    padding: "var(--space-6)",
    gap: "var(--space-5)",
    overflowY: "auto",
    boxSizing: "border-box",
  },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  pageTitle: { margin: 0, fontSize: "var(--font-2xl)", fontWeight: 800, color: "var(--text)" },
  pageSub: {
    margin: "var(--space-2) 0 0",
    fontSize: "var(--font-sm)",
    color: "var(--text-secondary)",
    maxWidth: 620,
  },
  tabs: { display: "flex", gap: "var(--space-2)" },
  tab: { padding: "8px 16px", fontSize: "var(--font-sm)" },
  content: { flex: 1, minHeight: 0 },
  drillsGrid: { display: "flex", flexDirection: "column", gap: "var(--space-4)", maxWidth: 820 },
  progressCard: {
    background: "var(--bg-card)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-xl)",
    padding: "var(--space-5)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-3)",
  },
  progressHead: { display: "flex", alignItems: "center", gap: "var(--space-2)" },
  progressTitle: { fontSize: "var(--font-sm)", fontWeight: 600, color: "var(--text-secondary)" },
  spark: { width: "100%", height: 60, display: "block" },
  progressFoot: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: "var(--font-xs)",
    color: "var(--text-muted)",
  },
};
