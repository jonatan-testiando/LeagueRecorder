import React, { useCallback, useEffect, useState } from "react";
import { Brain, ArrowLeft, Check, X, Eye, Timer, RefreshCw } from "lucide-react";
import {
  AwarenessSummary,
  CameraStats,
  QuizPayload,
  QuizResult,
  fmtClock,
  generateAwarenessQuiz,
  listAwarenessRecords,
  submitAwarenessQuiz,
} from "../api";

/** Tarjeta de métricas de uso de cámara de una partida. */
const CameraStatsRow: React.FC<{ stats: CameraStats }> = ({ stats }) => (
  <div style={styles.statsRow}>
    <div style={styles.stat}>
      <span style={styles.statLabel}>Checks / min</span>
      <span style={styles.statValue}>{stats.presses_per_minute.toFixed(1)}</span>
    </div>
    <div style={styles.stat}>
      <span style={styles.statLabel}>Longest blind gap</span>
      <span
        style={{
          ...styles.statValue,
          color: stats.longest_gap_secs > 120 ? "var(--color-defeat)" : "var(--color-victory)",
        }}
      >
        {fmtClock(stats.longest_gap_secs)}
      </span>
    </div>
    <div style={styles.stat}>
      <span style={styles.statLabel}>Total</span>
      <span style={styles.statValue}>{stats.total_presses}</span>
    </div>
    {stats.per_role.length > 0 && (
      <div style={styles.stat}>
        <span style={styles.statLabel}>Split</span>
        <span style={styles.splitText}>
          {stats.per_role.map(([role, n]) => `${role} ${n}`).join(" · ")}
        </span>
      </div>
    )}
  </div>
);

/**
 * Quiz de awareness. Las respuestas correctas viven en el backend: aquí solo se
 * eligen opciones y se manda todo a corregir, así que no hay forma de hacer trampa
 * mirando el DOM (que sería hacerse trampa al solitario, pero aun así).
 */
export const AwarenessQuiz: React.FC = () => {
  const [records, setRecords] = useState<AwarenessSummary[] | null>(null);
  const [quiz, setQuiz] = useState<QuizPayload | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<QuizResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    listAwarenessRecords()
      .then(setRecords)
      .catch(() => setRecords([]));
  }, []);

  useEffect(refresh, [refresh]);

  const openQuiz = async (matchId: string, regenerate = false) => {
    setBusy(true);
    setError(null);
    setResult(null);
    setAnswers({});
    try {
      setQuiz(await generateAwarenessQuiz(matchId, 5, regenerate));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!quiz) return;
    setBusy(true);
    try {
      setResult(await submitAwarenessQuiz(quiz.match_id, answers));
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setQuiz(null);
    setResult(null);
    setAnswers({});
    setError(null);
  };

  // --- Resultado corregido ---
  if (result && quiz) {
    const pct = (result.score / result.total) * 100;
    return (
      <div style={styles.panel}>
        <button className="btn-ghost" style={styles.backBtn} onClick={close}>
          <ArrowLeft size={16} /> Back
        </button>
        <div style={styles.scoreBlock}>
          <span
            style={{
              ...styles.bigScore,
              color: pct >= 60 ? "var(--color-victory)" : "var(--accent-gold)",
            }}
          >
            {result.score}/{result.total}
          </span>
          <span style={styles.scoreCaption}>
            {pct >= 80
              ? "You actually knew what your team was doing."
              : pct >= 40
              ? "Half the information reached you. That is the gap to close."
              : "You were pressing keys without reading. This is the real starting point."}
          </span>
        </div>

        <div style={styles.answerList}>
          {result.answers.map((a) => (
            <div key={a.question_id} style={styles.answerRow}>
              {a.is_correct ? (
                <Check size={18} color="var(--color-victory)" style={{ flexShrink: 0 }} />
              ) : (
                <X size={18} color="var(--color-defeat)" style={{ flexShrink: 0 }} />
              )}
              <div style={{ flex: 1 }}>
                <div style={styles.answerPrompt}>{a.prompt}</div>
                <div style={styles.answerDetail}>
                  {a.is_correct ? (
                    <span style={{ color: "var(--color-victory)" }}>{a.correct}</span>
                  ) : (
                    <>
                      <span style={{ color: "var(--color-defeat)" }}>
                        {a.chosen || "no answer"}
                      </span>
                      <span style={{ color: "var(--text-muted)" }}> → correct: </span>
                      <span style={{ color: "var(--color-victory)" }}>{a.correct}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        <button
          className="btn-ghost"
          style={styles.chip}
          onClick={() => openQuiz(quiz.match_id, true)}
        >
          <RefreshCw size={14} /> New questions from this game
        </button>
      </div>
    );
  }

  // --- Quiz en curso ---
  if (quiz) {
    const allAnswered = quiz.questions.every((q) => answers[q.id]);
    return (
      <div style={styles.panel}>
        <button className="btn-ghost" style={styles.backBtn} onClick={close}>
          <ArrowLeft size={16} /> Back
        </button>
        {quiz.camera && <CameraStatsRow stats={quiz.camera} />}
        <p style={styles.desc}>
          No looking anything up. If you do not remember, guess — a wrong answer is the
          measurement, not a failure.
        </p>

        {quiz.questions.map((q, i) => (
          <div key={q.id} style={styles.question}>
            <div style={styles.questionPrompt}>
              <span style={styles.questionNum}>{i + 1}</span>
              {q.prompt}
            </div>
            <div style={styles.options}>
              {q.options.map((opt) => (
                <button
                  key={opt}
                  className={answers[q.id] === opt ? "btn-primary" : "btn-ghost"}
                  style={styles.option}
                  onClick={() => setAnswers((a) => ({ ...a, [q.id]: opt }))}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
        ))}

        {error && <div style={styles.error}>{error}</div>}
        <button
          className="btn-primary"
          style={{ ...styles.bigBtn, opacity: allAnswered && !busy ? 1 : 0.5 }}
          onClick={submit}
          disabled={!allAnswered || busy}
        >
          Submit
        </button>
      </div>
    );
  }

  // --- Listado de partidas ---
  if (records === null) {
    return <div style={styles.panel}>Loading…</div>;
  }

  if (records.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon">
          <Brain size={30} color="var(--text-muted)" />
        </div>
        <p className="empty-state__title">No games recorded yet</p>
        <p className="empty-state__text">
          Play a game with LeagueRecorder running. It samples the live game state so it can
          ask you afterwards what you actually knew.
        </p>
      </div>
    );
  }

  return (
    <div style={styles.list}>
      {error && <div style={styles.error}>{error}</div>}
      {records.map((r) => (
        <div key={r.match_id} className="card card-interactive" style={styles.recordCard}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={styles.recordTitle}>
              {r.champion || "Unknown"}
              <span style={styles.recordDate}>{r.date}</span>
            </div>
            <div style={styles.recordMeta}>
              <span style={styles.metaItem}>
                <Eye size={13} /> {r.camera.presses_per_minute.toFixed(1)} checks/min
              </span>
              <span style={styles.metaItem}>
                <Timer size={13} /> {fmtClock(r.camera.longest_gap_secs)} blind
              </span>
              {r.metronome && (
                <span
                  style={{
                    ...styles.metaItem,
                    color:
                      r.metronome[0] / Math.max(1, r.metronome[1]) >= 0.8
                        ? "var(--color-victory)"
                        : "var(--accent-gold)",
                  }}
                  title="Metronome prompts you answered in time"
                >
                  <Timer size={13} /> metronome {r.metronome[0]}/{r.metronome[1]}
                </span>
              )}
              {r.answered && (
                <span
                  style={{
                    ...styles.metaItem,
                    color:
                      (r.last_score ?? 0) / Math.max(1, r.last_total ?? 1) >= 0.6
                        ? "var(--color-victory)"
                        : "var(--accent-gold)",
                  }}
                >
                  last quiz {r.last_score}/{r.last_total}
                </span>
              )}
            </div>
          </div>
          <button
            className="btn-primary"
            style={styles.chip}
            onClick={() => openQuiz(r.match_id, r.answered)}
            disabled={busy}
          >
            {r.answered ? "Retake" : "Take quiz"}
          </button>
        </div>
      ))}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  panel: {
    background: "var(--bg-card)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-xl)",
    padding: "var(--space-6)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-4)",
  },
  list: { display: "flex", flexDirection: "column", gap: "var(--space-3)" },
  recordCard: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-4)",
    padding: "var(--space-4)",
  },
  recordTitle: {
    display: "flex",
    alignItems: "baseline",
    gap: "var(--space-3)",
    fontSize: "var(--font-md)",
    fontWeight: 700,
    color: "var(--text)",
  },
  recordDate: { fontSize: "var(--font-xs)", color: "var(--text-muted)", fontWeight: 500 },
  recordMeta: {
    display: "flex",
    gap: "var(--space-4)",
    marginTop: "var(--space-2)",
    flexWrap: "wrap",
  },
  metaItem: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: "var(--font-xs)",
    color: "var(--text-secondary)",
    fontFamily: "var(--font-mono)",
  },
  statsRow: {
    display: "flex",
    gap: "var(--space-6)",
    flexWrap: "wrap",
    paddingBottom: "var(--space-4)",
    borderBottom: "1px solid var(--border-subtle)",
  },
  stat: { display: "flex", flexDirection: "column", gap: 2 },
  statLabel: {
    fontSize: "var(--font-xs)",
    color: "var(--text-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    fontWeight: 700,
  },
  statValue: { fontSize: "var(--font-xl)", fontWeight: 800, fontFamily: "var(--font-mono)", color: "var(--text)" },
  splitText: { fontSize: "var(--font-xs)", color: "var(--text-secondary)", fontFamily: "var(--font-mono)" },
  desc: { margin: 0, fontSize: "var(--font-sm)", color: "var(--text-secondary)" },
  question: { display: "flex", flexDirection: "column", gap: "var(--space-3)" },
  questionPrompt: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    fontSize: "var(--font-md)",
    color: "var(--text)",
    fontWeight: 600,
  },
  questionNum: {
    width: 24,
    height: 24,
    borderRadius: "var(--radius-full)",
    background: "var(--bg-elevated)",
    color: "var(--text-muted)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "var(--font-xs)",
    fontWeight: 700,
    flexShrink: 0,
  },
  options: { display: "flex", gap: "var(--space-2)", flexWrap: "wrap", paddingLeft: 36 },
  option: { padding: "8px 18px", fontFamily: "var(--font-mono)", fontSize: "var(--font-sm)" },
  chip: { padding: "6px 14px", fontSize: "var(--font-xs)", alignSelf: "flex-start" },
  bigBtn: { padding: "10px 24px", alignSelf: "flex-start", justifyContent: "center" },
  backBtn: { padding: "6px 12px", fontSize: "var(--font-xs)", alignSelf: "flex-start" },
  scoreBlock: { display: "flex", flexDirection: "column", gap: "var(--space-2)" },
  bigScore: { fontSize: 64, fontWeight: 800, fontFamily: "var(--font-mono)", lineHeight: 1 },
  scoreCaption: { fontSize: "var(--font-sm)", color: "var(--text-secondary)", maxWidth: 520 },
  answerList: { display: "flex", flexDirection: "column", gap: "var(--space-3)" },
  answerRow: { display: "flex", gap: "var(--space-3)", alignItems: "flex-start" },
  answerPrompt: { fontSize: "var(--font-sm)", color: "var(--text-primary)" },
  answerDetail: { fontSize: "var(--font-xs)", fontFamily: "var(--font-mono)", marginTop: 2 },
  error: {
    padding: "var(--space-3)",
    borderRadius: "var(--radius-md)",
    background: "var(--danger-soft)",
    color: "var(--color-defeat)",
    fontSize: "var(--font-sm)",
  },
};
