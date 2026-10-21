import React, { useCallback, useEffect, useState } from "react";
import { Brain, ArrowLeft, Check, X, Eye, Timer, RefreshCw } from "lucide-react";
import { clock, matchAge } from "../../../core/time";
import { formatDecimal } from "../../../core/benchmarkFormat";
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
import { useDelayedLoading } from "../../../core/useDelayedLoading";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Skeleton } from "../../../components/ui/Skeleton";
import "./TrainingPanel.css";

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

/** Métricas de uso de cámara de una partida, encima del quiz. */
const CameraStatsRow: React.FC<{ stats: CameraStats }> = ({ stats }) => {
  const t = useT();
  return (
    <div className="trn-stats trn-stats--rule">
      <div className="trn-stat">
        <span className="trn-stat__label t-label">{t("Checks / min")}</span>
        <span className="trn-stat__value t-metric">{formatDecimal(stats.presses_per_minute)}</span>
      </div>
      <div className="trn-stat">
        <span className="trn-stat__label t-label">{t("Longest blind gap")}</span>
        <span className="trn-stat__value t-metric" data-tone={stats.longest_gap_secs > BLIND_GAP_BAD ? "bad" : "good"}>
          {clock(stats.longest_gap_secs)}
        </span>
      </div>
      <div className="trn-stat">
        <span className="trn-stat__label t-label">{t("Total")}</span>
        <span className="trn-stat__value t-metric">{stats.total_presses}</span>
      </div>
      {stats.per_role.length > 0 && (
        <div className="trn-stat">
          <span className="trn-stat__label t-label">{t("Split")}</span>
          <span className="trn-stat__split t-small">
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
  // La partida cuyo quiz se está generando: su botón lleva el spinner.
  const [openingId, setOpeningId] = useState<string | null>(null);
  const showSkeleton = useDelayedLoading(records === null);

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
    setOpeningId(matchId);
    setError(null);
    setResult(null);
    setAnswers({});
    try {
      setQuiz(await generateAwarenessQuiz(matchId, QUIZ_QUESTIONS, regenerate));
    } catch (e) {
      setError(t("Couldn't build the quiz: {msg}", { msg: String(e) }));
    } finally {
      setBusy(false);
      setOpeningId(null);
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
      <section className="card trn-card">
        <div>
          <Button size="sm" icon={<ArrowLeft size={14} />} onClick={close}>
            {t("Back")}
          </Button>
        </div>
        <div className="trn-score">
          <span className="trn-stat__value t-hero" data-tone={pct >= PASS_PCT ? "good" : "warn"}>
            {result.score}/{result.total}
          </span>
          <p className="trn-score__caption t-body">
            {t(
              pct >= KNEW_IT
                ? "You actually knew what your team was doing."
                : pct >= HALF_OF_IT
                ? "Half the information reached you. That is the gap to close."
                : "You were pressing keys without reading. This is the real starting point."
            )}
          </p>
        </div>

        <div className="trn-answer-list">
          {result.answers.map((a) => (
            <div key={a.question_id} className="trn-answer">
              {a.is_correct ? <Check size={18} className="trn-ic-ok" /> : <X size={18} className="trn-ic-miss" />}
              <div>
                <p className="trn-answer__prompt t-body">{a.prompt}</p>
                <p className="trn-answer__detail t-small">
                  {a.is_correct ? (
                    <span className="trn-tone" data-tone="good">{a.correct}</span>
                  ) : (
                    <>
                      <span className="trn-tone" data-tone="bad">{a.chosen || t("no answer")}</span>
                      {" → "}
                      {t("right answer")}:{" "}
                      <span className="trn-tone" data-tone="good">{a.correct}</span>
                    </>
                  )}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="trn-actions">
          <Button size="sm" icon={<RefreshCw size={14} />} onClick={() => openQuiz(quiz.match_id, true)}>
            {t("New questions from this game")}
          </Button>
        </div>
      </section>
    );
  }

  // --- Quiz en curso ---
  if (quiz) {
    const allAnswered = quiz.questions.every((q) => answers[q.id]);
    return (
      <section className="card trn-card">
        <div>
          <Button size="sm" icon={<ArrowLeft size={14} />} onClick={close}>
            {t("Back")}
          </Button>
        </div>
        {quiz.camera && <CameraStatsRow stats={quiz.camera} />}
        <p className="trn-desc t-body">
          {t("No looking anything up. If you do not remember, guess — a wrong answer is the measurement, not a failure.")}
        </p>

        {quiz.questions.map((q, i) => (
          <div key={q.id} className="trn-q">
            <p className="trn-q__prompt t-body-strong">
              <span className="trn-q__num t-label">{i + 1}</span>
              {q.prompt}
            </p>
            <div className="trn-answers" role="group" aria-label={q.prompt}>
              {q.options.map((opt) => (
                <Button
                  key={opt}
                  aria-pressed={answers[q.id] === opt}
                  onClick={() => setAnswers((a) => ({ ...a, [q.id]: opt }))}
                >
                  {opt}
                </Button>
              ))}
            </div>
          </div>
        ))}

        {error && <p className="trn-error t-body">{error}</p>}
        <div className="trn-actions">
          <Button
            variant="primary"
            onClick={submit}
            disabled={!allAnswered}
            loading={busy}
            loadingLabel={t("Grading…")}
          >
            {t("Submit")}
          </Button>
        </div>
      </section>
    );
  }

  // --- Listado de partidas ---
  if (records === null) {
    // Esqueleto con la forma de la lista, y solo si la carga tarda.
    return showSkeleton ? (
      <div className="trn-list" role="status" aria-busy="true" aria-label={t("Loading your sampled games…")}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="card trn-record">
            <div className="trn-record__main">
              <Skeleton width="32%" height={16} />
              <Skeleton width="56%" />
            </div>
            <Skeleton shape="block" width={96} height={28} />
          </div>
        ))}
      </div>
    ) : null;
  }

  if (records.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon={<Brain />}
          title={t("No games recorded yet")}
          text={
            samplingOff
              ? t("Post-game quiz sampling is off, so no game state is being recorded. Turn it on in Setup and play a game.")
              : t("Play a game with LeagueRecorder running. It samples the live game state so it can ask you afterwards what you actually knew.")
          }
        />
      </div>
    );
  }

  return (
    <div className="trn-list">
      {error && <p className="trn-error t-body">{error}</p>}
      {records.map((r, i) => (
        <div key={r.match_id} className="card card-interactive trn-record">
          <div className="trn-record__main">
            <div className="trn-record__title">
              <span className="t-card">{r.champion || t("Unknown champion")}</span>
              <span className="trn-record__date t-small" title={r.date}>{matchAge(r.date, t)}</span>
            </div>
            <div className="trn-record__meta t-small">
              <span className="trn-meta">
                <Eye size={14} /> {formatDecimal(r.camera.presses_per_minute)} {t("checks/min")}
              </span>
              <span className="trn-meta">
                <Timer size={14} /> {clock(r.camera.longest_gap_secs)} {t("blind")}
              </span>
              {r.metronome && (
                <span
                  className="trn-meta trn-tone"
                  data-tone={r.metronome[0] / Math.max(1, r.metronome[1]) >= METRONOME_OK ? "good" : "warn"}
                  title={t("Metronome prompts you answered in time")}
                >
                  <Timer size={14} /> {t("metronome")} {r.metronome[0]}/{r.metronome[1]}
                </span>
              )}
              {r.answered && (
                <span
                  className="trn-meta trn-tone"
                  data-tone={(r.last_score ?? 0) / Math.max(1, r.last_total ?? 1) >= PASS_PCT / 100 ? "good" : "warn"}
                >
                  {t("last quiz")} {r.last_score}/{r.last_total}
                </span>
              )}
            </div>
          </div>
          {/* Oro solo en la primera (la partida más reciente): una acción de
              oro por pantalla. Las demás, en superficie. */}
          <Button
            variant={i === 0 ? "primary" : "ghost"}
            onClick={() => openQuiz(r.match_id, r.answered)}
            disabled={busy && openingId !== r.match_id}
            loading={openingId === r.match_id}
          >
            {t(r.answered ? "Retake" : "Take quiz")}
          </Button>
        </div>
      ))}
    </div>
  );
};
