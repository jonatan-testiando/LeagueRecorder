import React, { useCallback, useEffect, useState } from "react";
import { Brain, ArrowLeft, Check, X, Eye, Timer, RefreshCw } from "lucide-react";
import { clock } from "../../../core/time";
import {
  AwarenessSummary,
  CameraStats,
  QuizPayload,
  QuizResult,
  generateAwarenessQuiz,
  listAwarenessRecords,
  submitAwarenessQuiz,
} from "../api";
import { useT } from "../../../core/LanguageProvider";
import { roleLabel } from "../../../core/roles";
import { getTrainingConfig } from "../api";

/**
 * Hueco ciego, en segundos, a partir del cual el reparto deja de ser un dato y
 * pasa a ser el problema.
 */
const BLIND_GAP_BAD = 120;

/** Aciertos (en %) de cada veredicto del quiz. */
const KNEW_IT = 80;
const HALF_OF_IT = 40;

/** A partir de aquí el resultado se lee como "bien" y no como "a medias". */
const PASS_PCT = 60;

/** Avisos del metrónomo atendidos que cuentan como responder de verdad. */
const METRONOME_OK = 0.8;

/** Preguntas que trae un quiz. */
const QUIZ_QUESTIONS = 5;

/** Tarjeta de métricas de uso de cámara de una partida. */
const CameraStatsRow: React.FC<{ stats: CameraStats }> = ({ stats }) => {
  const t = useT();
  return (
    <div style={styles.statsRow}>
      <div style={styles.stat}>
        <span style={styles.statLabel}>{t("Checks / min")}</span>
        <span style={styles.statValue}>{stats.presses_per_minute.toFixed(1)}</span>
      </div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>{t("Longest blind gap")}</span>
        <span
          style={{
            ...styles.statValue,
            color: stats.longest_gap_secs > BLIND_GAP_BAD ? "var(--loss)" : "var(--win)",
          }}
        >
          {clock(stats.longest_gap_secs)}
        </span>
      </div>
      <div style={styles.stat}>
        <span style={styles.statLabel}>{t("Total")}</span>
        <span style={styles.statValue}>{stats.total_presses}</span>
      </div>
      {stats.per_role.length > 0 && (
        <div style={styles.stat}>
          <span style={styles.statLabel}>{t("Split")}</span>
          <span style={styles.splitText}>
            {stats.per_role.map(([role, n]) => `${t(roleLabel(role))} ${n}`).join(" · ")}
          </span>
        </div>
      )}
    </div>
  );
};

/**
 * Quiz de awareness. Las respuestas correctas viven en el backend: aquí solo se
 * eligen opciones y se manda todo a corregir, así que no hay forma de hacer trampa
 * mirando el DOM (que sería hacerse trampa al solitario, pero aun así).
 */
export const AwarenessQuiz: React.FC = () => {
  const t = useT();
  const [records, setRecords] = useState<AwarenessSummary[] | null>(null);
  const [quiz, setQuiz] = useState<QuizPayload | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<QuizResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Si el muestreo está apagado no habrá partidas NUNCA, y el vacío sin más
  // parece que la app no ha guardado nada. Se pregunta a la config para poder
  // señalar el interruptor concreto.
  const [samplingOff, setSamplingOff] = useState(false);

  const refresh = useCallback(() => {
    listAwarenessRecords()
      .then(setRecords)
      .catch(() => setRecords([]));
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    getTrainingConfig()
      .then((c) => setSamplingOff(!c.awareness_quiz_enabled))
      .catch(() => setSamplingOff(false));
  }, []);

  const openQuiz = async (matchId: string, regenerate = false) => {
    setBusy(true);
    setError(null);
    setResult(null);
    setAnswers({});
    try {
      setQuiz(await generateAwarenessQuiz(matchId, QUIZ_QUESTIONS, regenerate));
    } catch (e) {
      setError(t("Couldn't build the quiz: {msg}", { msg: String(e) }));
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
      setError(t("Couldn't mark the quiz: {msg}", { msg: String(e) }));
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
        <button className="btn btn--ghost" style={styles.backBtn} onClick={close}>
          <ArrowLeft size={16} /> {t("Back")}
        </button>
        <div style={styles.scoreBlock}>
          <span
            style={{
              ...styles.bigScore,
              color: pct >= PASS_PCT ? "var(--win)" : "var(--brand)",
            }}
          >
            {result.score}/{result.total}
          </span>
          <span style={styles.scoreCaption}>
            {t(
              pct >= KNEW_IT
                ? "You actually knew what your team was doing."
                : pct >= HALF_OF_IT
                ? "Half the information reached you. That is the gap to close."
                : "You were pressing keys without reading. This is the real starting point."
            )}
          </span>
        </div>

        <div style={styles.answerList}>
          {result.answers.map((a) => (
            <div key={a.question_id} style={styles.answerRow}>
              {a.is_correct ? (
                <Check size={18} color="var(--win)" style={{ flexShrink: 0 }} />
              ) : (
                <X size={18} color="var(--loss)" style={{ flexShrink: 0 }} />
              )}
              <div style={{ flex: 1 }}>
                <div style={styles.answerPrompt}>{a.prompt}</div>
                <div style={styles.answerDetail}>
                  {a.is_correct ? (
                    <span style={{ color: "var(--win)" }}>{a.correct}</span>
                  ) : (
                    <>
                      <span style={{ color: "var(--loss)" }}>
                        {a.chosen || t("no answer")}
                      </span>
                      <span style={{ color: "var(--faint)" }}> → {t("right answer")}: </span>
                      <span style={{ color: "var(--win)" }}>{a.correct}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        <button
          className="btn btn--ghost"
          style={styles.chip}
          onClick={() => openQuiz(quiz.match_id, true)}
        >
          <RefreshCw size={14} /> {t("New questions from this game")}
        </button>
      </div>
    );
  }

  // --- Quiz en curso ---
  if (quiz) {
    const allAnswered = quiz.questions.every((q) => answers[q.id]);
    return (
      <div style={styles.panel}>
        <button className="btn btn--ghost" style={styles.backBtn} onClick={close}>
          <ArrowLeft size={16} /> {t("Back")}
        </button>
        {quiz.camera && <CameraStatsRow stats={quiz.camera} />}
        <p style={styles.desc}>
          {t("No looking anything up. If you do not remember, guess — a wrong answer is the measurement, not a failure.")}
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
                  className="btn btn--ghost" aria-pressed={answers[q.id] === opt}
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
          className="btn btn--primary"
          style={{ ...styles.bigBtn, opacity: allAnswered && !busy ? 1 : 0.5 }}
          onClick={submit}
          disabled={!allAnswered || busy}
        >
          {t("Submit")}
        </button>
      </div>
    );
  }

  // --- Listado de partidas ---
  if (records === null) {
    // Un panel con la palabra "Cargando" y nada más no dice qué está cargando.
    return (
      <div style={styles.panel}>
        <div style={styles.headerRow}>
          <Brain size={18} color="var(--cool)" />
          <span style={styles.loadingTitle}>{t("Loading your sampled games…")}</span>
        </div>
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon">
          <Brain size={30} color="var(--faint)" />
        </div>
        <p className="empty-state__title">{t("No games recorded yet")}</p>
        <p className="empty-state__text">
          {samplingOff
            ? t("Post-game quiz sampling is off, so no game state is being recorded. Turn it on in Setup and play a game.")
            : t("Play a game with LeagueRecorder running. It samples the live game state so it can ask you afterwards what you actually knew.")}
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
              {r.champion || t("Unknown champion")}
              <span style={styles.recordDate}>{r.date}</span>
            </div>
            <div style={styles.recordMeta}>
              <span style={styles.metaItem}>
                <Eye size={13} /> {r.camera.presses_per_minute.toFixed(1)} {t("checks/min")}
              </span>
              <span style={styles.metaItem}>
                <Timer size={13} /> {clock(r.camera.longest_gap_secs)} {t("blind")}
              </span>
              {r.metronome && (
                <span
                  style={{
                    ...styles.metaItem,
                    color:
                      r.metronome[0] / Math.max(1, r.metronome[1]) >= METRONOME_OK
                        ? "var(--win)"
                        : "var(--brand)",
                  }}
                  title={t("Metronome prompts you answered in time")}
                >
                  <Timer size={13} /> {t("metronome")} {r.metronome[0]}/{r.metronome[1]}
                </span>
              )}
              {r.answered && (
                <span
                  style={{
                    ...styles.metaItem,
                    color:
                      (r.last_score ?? 0) / Math.max(1, r.last_total ?? 1) >= PASS_PCT / 100
                        ? "var(--win)"
                        : "var(--brand)",
                  }}
                >
                  {t("last quiz")} {r.last_score}/{r.last_total}
                </span>
              )}
            </div>
          </div>
          <button
            className="btn btn--primary"
            style={styles.chip}
            onClick={() => openQuiz(r.match_id, r.answered)}
            disabled={busy}
          >
            {t(r.answered ? "Retake" : "Take quiz")}
          </button>
        </div>
      ))}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  headerRow: { display: "flex", alignItems: "center", gap: "var(--space-3)" },
  loadingTitle: { fontSize: "var(--font-sm)", color: "var(--muted)" },
  panel: {
    background: "var(--surface-1)",
    border: "1px solid var(--line-soft)",
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
  recordDate: { fontSize: "var(--font-xs)", color: "var(--faint)", fontWeight: 500 },
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
    color: "var(--muted)",
    fontFamily: "var(--font-mono)",
  },
  statsRow: {
    display: "flex",
    gap: "var(--space-6)",
    flexWrap: "wrap",
    paddingBottom: "var(--space-4)",
    borderBottom: "1px solid var(--line-soft)",
  },
  stat: { display: "flex", flexDirection: "column", gap: 2 },
  statLabel: {
    fontSize: "var(--font-xs)",
    color: "var(--faint)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    fontWeight: 700,
  },
  statValue: { fontSize: "var(--font-xl)", fontWeight: 800, fontFamily: "var(--font-mono)", color: "var(--text)" },
  splitText: { fontSize: "var(--font-xs)", color: "var(--muted)", fontFamily: "var(--font-mono)" },
  desc: { margin: 0, fontSize: "var(--font-sm)", color: "var(--muted)" },
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
    background: "var(--surface-2)",
    color: "var(--faint)",
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
  scoreCaption: { fontSize: "var(--font-sm)", color: "var(--muted)", maxWidth: 520 },
  answerList: { display: "flex", flexDirection: "column", gap: "var(--space-3)" },
  answerRow: { display: "flex", gap: "var(--space-3)", alignItems: "flex-start" },
  answerPrompt: { fontSize: "var(--font-sm)", color: "var(--text)" },
  answerDetail: { fontSize: "var(--font-xs)", fontFamily: "var(--font-mono)", marginTop: 2 },
  error: {
    padding: "var(--space-3)",
    borderRadius: "var(--radius-md)",
    background: "var(--danger-soft)",
    color: "var(--loss)",
    fontSize: "var(--font-sm)",
  },
};
