import React, { useCallback, useEffect, useRef, useState } from "react";
import { Eye, Play, RotateCcw, Check, X, ImageOff } from "lucide-react";
import {
  DrillSession,
  RecallFrame,
  TrainingConfig,
  listRecallFrames,
  saveDrillSession,
  streamUrl,
} from "../api";
import { useT } from "../../../core/LanguageProvider";
import { useDelayedLoading } from "../../../core/useDelayedLoading";
import { Button } from "../../../components/ui/Button";
import { Segmented } from "../../../components/ui/Segmented";
import { EmptyState } from "../../../components/ui/EmptyState";
import { SkeletonLines } from "../../../components/ui/Skeleton";
import "./TrainingPanel.css";

/**
 * Banco de preguntas. Todas se contestan mirando UN fotograma durante ~400 ms,
 * y todas son cosas que de verdad cambian una decisión en partida. Se corrigen
 * a ojo (la imagen no lleva verdad de referencia), y por eso el flujo obliga a
 * comprometerse con una respuesta ANTES de revelar: si no, el cerebro siempre
 * cree que lo sabía.
 */
const QUESTIONS: { prompt: string; options: string[] }[] = [
  { prompt: "How much HP did the ally have?", options: ["< 25%", "25–50%", "50–75%", "> 75%"] },
  { prompt: "How many enemies were visible on the minimap?", options: ["0", "1–2", "3–4", "5"] },
  {
    prompt: "What was the ally doing?",
    options: ["Pushing", "Holding", "Backing off", "Fighting"],
  },
  { prompt: "Which side of the map was the camera on?", options: ["Top", "Mid", "Bot", "Base"] },
  {
    prompt: "Was the wave pushing toward the ally or away?",
    options: ["Toward", "Away", "Even", "No wave"],
  },
  { prompt: "Were there any allies nearby?", options: ["None", "One", "Two or more", "Whole team"] },
];

type Phase = "idle" | "loading" | "flash" | "answer" | "reveal" | "done";

/**
 * Mínimo del destello. Por debajo de esto no da tiempo ni a que el monitor lo
 * pinte, así que el ejercicio dejaría de medir nada.
 */
const MIN_FLASH_MS = 80;

/**
 * Fotogramas seguidos que pueden fallar al cargar antes de rendirse. Sin este
 * tope, una carpeta entera de fotogramas rotos dejaba el ejercicio saltando de
 * ronda en ronda para siempre.
 */
const MAX_LOAD_FAILURES = 5;

/** Acierto a partir del cual conviene bajar el destello. */
const SOLID_ACCURACY = 80;

interface Round {
  question: string;
  chosen: string;
  ok: boolean;
  latencyMs: number;
}

/**
 * Drill de lectura rápida (occlusion): el fotograma aparece 400 ms y desaparece.
 * Entrena lo que realmente cuesta — extraer información de un vistazo — con
 * material tuyo: los fotogramas salen de los saltos de cámara de tus partidas.
 */
export const RecallDrill: React.FC<{
  config: TrainingConfig;
  onFinished?: () => void;
}> = ({ config, onFinished }) => {
  const [frames, setFrames] = useState<RecallFrame[] | null>(null);
  const [rounds, setRounds] = useState(15);
  const [phase, setPhase] = useState<Phase>("idle");
  const [frame, setFrame] = useState<RecallFrame | null>(null);
  const [question, setQuestion] = useState(QUESTIONS[0]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [results, setResults] = useState<Round[]>([]);
  // Fotogramas que no se pudieron cargar en esta sesión. Se enseña porque una
  // ronda que salta sola sin decir por qué se lee como que el ejercicio falla.
  const [skipped, setSkipped] = useState(0);
  const t = useT();
  const showSkeleton = useDelayedLoading(frames === null);

  const resultsRef = useRef<Round[]>([]);
  const answerShownAt = useRef(0);
  const timerRef = useRef<number | null>(null);
  const usedRef = useRef<Set<string>>(new Set());
  const brokenRef = useRef<Set<string>>(new Set());
  const failuresRef = useRef(0);
  const nextRoundRef = useRef<() => void>(() => {});
  // La tarjeta en curso. Al empezar se trae entera a la vista: este ejercicio
  // va debajo del de reflejos y, sin esto, el fotograma y la pregunta salían
  // por debajo del pliegue y había que bajar a contestar.
  const cardRef = useRef<HTMLElement>(null);
  const scrollPending = useRef(false);

  useEffect(() => {
    listRecallFrames()
      .then(setFrames)
      .catch(() => setFrames([]));
  }, []);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  useEffect(() => () => clearTimer(), []);

  /**
   * Prepara la siguiente ronda. La imagen se precarga ANTES de enseñarla: un
   * destello de 400 ms no mide nada si 300 se van en descargar el JPEG.
   */
  const nextRound = useCallback(() => {
    if (!frames || frames.length === 0) return;
    if (resultsRef.current.length >= rounds) {
      setPhase("done");
      return;
    }
    // Sin repetir fotograma mientras queden sin usar, y sin los que ya se sabe
    // que no cargan.
    const sanos = frames.filter((f) => !brokenRef.current.has(f.path));
    if (sanos.length === 0) {
      setPhase("done");
      return;
    }
    let pool = sanos.filter((f) => !usedRef.current.has(f.path));
    if (pool.length === 0) {
      usedRef.current.clear();
      pool = sanos;
    }
    const f = pool[Math.floor(Math.random() * pool.length)];
    usedRef.current.add(f.path);
    const q = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];

    setFrame(f);
    setQuestion(q);
    setChosen(null);
    setPhase("loading");

    const img = new Image();
    img.onload = () => {
      failuresRef.current = 0;
      setPhase("flash");
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        setPhase("answer");
        answerShownAt.current = performance.now();
      }, Math.max(MIN_FLASH_MS, config.flash_ms));
    };
    // Un fotograma que no carga NO es una ronda: antes se seguía igualmente y se
    // preguntaba "¿cuánta vida le quedaba?" sobre un rectángulo negro, y esa
    // respuesta —siempre fallada— contaba en la nota de la sesión.
    img.onerror = () => {
      setSkipped((n) => n + 1);
      failuresRef.current += 1;
      if (failuresRef.current >= MAX_LOAD_FAILURES) {
        setPhase("done");
        return;
      }
      // Se descarta el fotograma y se prueba con otro.
      brokenRef.current.add(f.path);
      window.setTimeout(() => nextRoundRef.current(), 0);
    };
    img.src = streamUrl(f.path);
  }, [frames, rounds, config.flash_ms]);

  useEffect(() => { nextRoundRef.current = nextRound; }, [nextRound]);

  const choose = (opt: string) => {
    setChosen(opt);
    setPhase("reveal");
  };

  const grade = (ok: boolean) => {
    const round: Round = {
      question: question.prompt,
      chosen: chosen ?? "",
      ok,
      latencyMs: performance.now() - answerShownAt.current,
    };
    resultsRef.current = [...resultsRef.current, round];
    setResults(resultsRef.current);
    nextRound();
  };

  // Guardado al terminar.
  useEffect(() => {
    if (phase !== "done") return;
    const rs = resultsRef.current;
    if (rs.length === 0) return;
    const hits = rs.filter((r) => r.ok);
    const session: DrillSession = {
      id: `recall_${Date.now()}`,
      date: new Date().toISOString().slice(0, 19).replace("T", " "),
      kind: "recall",
      rounds: rs.length,
      hits: hits.length,
      avg_latency_ms: rs.length ? rs.reduce((a, r) => a + r.latencyMs, 0) / rs.length : 0,
      best_latency_ms: rs.length ? Math.min(...rs.map((r) => r.latencyMs)) : 0,
      per_role: [],
      mode: `flash${config.flash_ms}`,
    };
    saveDrillSession(session).then(() => onFinished?.()).catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const start = () => {
    scrollPending.current = true;
    resultsRef.current = [];
    usedRef.current.clear();
    brokenRef.current.clear();
    failuresRef.current = 0;
    setSkipped(0);
    setResults([]);
    setPhase("loading");
    // nextRound lee resultsRef, ya vaciado.
    setTimeout(nextRound, 0);
  };

  useEffect(() => {
    if (!scrollPending.current || phase === "idle") return;
    scrollPending.current = false;
    const quieto = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // "start" y no "nearest": la pregunta llega después del destello, y con
    // "nearest" la tarjeta se alineaba por abajo cuando aún no la tenía.
    cardRef.current?.scrollIntoView({ block: "start", behavior: quieto ? "auto" : "smooth" });
  }, [phase]);

  const reset = () => {
    clearTimer();
    resultsRef.current = [];
    failuresRef.current = 0;
    setSkipped(0);
    setResults([]);
    setPhase("idle");
    setFrame(null);
  };

  // -------------------------------------------------------------------------

  const head = (title: string) => (
    <header className="trn-card__head">
      <Eye size={18} />
      <h2 className="trn-card__title t-card">{title}</h2>
    </header>
  );

  if (frames === null) {
    // La cabecera ya, y el cuerpo en esqueleto solo si tarda.
    return (
      <section ref={cardRef} className="card trn-card">
        {head(t("Fast-read drill"))}
        {showSkeleton && <SkeletonLines lines={2} />}
      </section>
    );
  }

  if (frames.length === 0) {
    return (
      <section ref={cardRef} className="card trn-card">
        {head(t("Fast-read drill"))}
        <EmptyState
          icon={<ImageOff />}
          title={t("No frames yet")}
          text={t("Open a recorded game in Review and hit \"Camera moves\" on the timeline. Every camera reposition it finds becomes a frame for this drill.")}
        />
      </section>
    );
  }

  if (phase === "idle") {
    return (
      <section ref={cardRef} className="card trn-card">
        {head(t("Fast-read drill"))}
        <p className="trn-desc t-body">
          {t("A frame from your own games flashes for {ms} ms, then one question. Commit to an answer before revealing — you grade yourself honestly or this measures nothing. Change the flash duration in Setup.", { ms: config.flash_ms })}
        </p>
        <div className="trn-opts">
          <span className="trn-opts__label t-small">{t("Rounds")}</span>
          <div className="trn-opts__ctl">
            <Segmented
              label={t("Rounds")}
              value={rounds}
              onChange={setRounds}
              options={[10, 15, 25].map((n) => ({ value: n, label: n }))}
            />
            <span className="trn-note t-small">{t("{n} frames available", { n: frames.length })}</span>
          </div>
        </div>
        {/* En superficie: el oro de la pantalla es el "Empezar" del primer
            ejercicio, que va encima. */}
        <div className="trn-actions">
          <Button icon={<Play size={16} />} onClick={start}>
            {t("Start")}
          </Button>
        </div>
      </section>
    );
  }

  if (phase === "done") {
    const hits = results.filter((r) => r.ok).length;
    const acc = results.length ? (hits / results.length) * 100 : 0;
    return (
      <section ref={cardRef} className="card trn-card">
        {head(t("Session complete"))}
        <div className="trn-stats">
          <div className="trn-stat">
            <span className="trn-stat__label t-label">{t("Accuracy")}</span>
            <span className="trn-stat__value t-metric" data-tone={acc >= 70 ? "good" : "warn"}>
              {acc.toFixed(0)}%
            </span>
          </div>
          <div className="trn-stat">
            <span className="trn-stat__label t-label">{t("Rounds")}</span>
            <span className="trn-stat__value t-metric">{results.length}</span>
          </div>
          <div className="trn-stat">
            <span className="trn-stat__label t-label">{t("Flash")}</span>
            <span className="trn-stat__value t-metric">{config.flash_ms} ms</span>
          </div>
        </div>
        {skipped > 0 && (
          <p className="trn-desc trn-tone t-body" data-tone="warn">
            {t("Frames skipped because the image would not load: {n}. They were not counted.", { n: skipped })}
          </p>
        )}
        <p className="trn-desc t-body">
          {t(
            acc >= SOLID_ACCURACY
              ? "Solid. Drop the flash duration in Setup and make it harder."
              : "Keep this flash duration until you are consistently above 80%."
          )}
        </p>
        <div className="trn-actions">
          <Button variant="primary" icon={<RotateCcw size={16} />} onClick={start}>
            {t("Again")}
          </Button>
          <Button onClick={reset}>{t("Back")}</Button>
        </div>
      </section>
    );
  }

  const src = frame ? streamUrl(frame.path) : "";

  return (
    <section ref={cardRef} className="card trn-card">
      <div className="trn-run">
        <span className="trn-run__count t-small">
          {results.length} / {rounds}
        </span>
        <div
          className="trn-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={rounds}
          aria-valuenow={results.length}
        >
          <span className="trn-progress__fill" style={{ "--p": results.length / rounds } as React.CSSProperties} />
        </div>
        <Button size="sm" onClick={reset}>{t("Stop")}</Button>
      </div>

      <div className="trn-stage trn-stage--frame">
        {phase === "loading" && <span className="trn-stage__hint t-body">{t("Loading…")}</span>}
        {phase === "flash" && <img src={src} alt="" className="trn-stage__frame" />}
        {phase === "answer" && <span className="trn-stage__hint t-section">{t("What did you see?")}</span>}
        {phase === "reveal" && <img src={src} alt="" className="trn-stage__frame" />}
      </div>

      {(phase === "answer" || phase === "reveal") && (
        <>
          <p className="trn-question t-card">{t(question.prompt)}</p>
          {phase === "answer" ? (
            <div className="trn-answers">
              {question.options.map((opt) => (
                <Button key={opt} onClick={() => choose(opt)}>
                  {t(opt)}
                </Button>
              ))}
            </div>
          ) : (
            <div className="trn-grade">
              <span className="trn-grade__text t-body">
                {t("You said")} <strong>{chosen ? t(chosen) : ""}</strong> {t("— were you right?")}
              </span>
              <Button icon={<Check size={16} className="trn-ic-ok" />} onClick={() => grade(true)}>
                {t("Yes")}
              </Button>
              <Button icon={<X size={16} className="trn-ic-miss" />} onClick={() => grade(false)}>
                {t("No")}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
};
