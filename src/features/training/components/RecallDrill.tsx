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

  const resultsRef = useRef<Round[]>([]);
  const answerShownAt = useRef(0);
  const timerRef = useRef<number | null>(null);
  const usedRef = useRef<Set<string>>(new Set());
  const brokenRef = useRef<Set<string>>(new Set());
  const failuresRef = useRef(0);
  const nextRoundRef = useRef<() => void>(() => {});

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

  if (frames === null) {
    return <div style={styles.panel}>{t("Loading frames…")}</div>;
  }

  if (frames.length === 0) {
    return (
      <div style={styles.panel}>
        <div style={styles.headerRow}>
          <Eye size={18} color="var(--cool)" />
          <h3 style={styles.title}>{t("Fast-read drill")}</h3>
        </div>
        <div className="empty-state" style={{ padding: "var(--space-6)" }}>
          <div className="empty-state__icon">
            <ImageOff size={28} color="var(--faint)" />
          </div>
          <p className="empty-state__title">{t("No frames yet")}</p>
          <p className="empty-state__text">
            {t("Open a recorded game in Review and hit \"Camera moves\" on the timeline. Every camera reposition it finds becomes a frame for this drill.")}
          </p>
        </div>
      </div>
    );
  }

  if (phase === "idle") {
    return (
      <div style={styles.panel}>
        <div style={styles.headerRow}>
          <Eye size={18} color="var(--cool)" />
          <h3 style={styles.title}>{t("Fast-read drill")}</h3>
        </div>
        <p style={styles.desc}>
          {t("A frame from your own games flashes for {ms} ms, then one question. Commit to an answer before revealing — you grade yourself honestly or this measures nothing. Change the flash duration in Setup.", { ms: config.flash_ms })}
        </p>
        <div style={styles.optionRow}>
          <span style={styles.optionLabel}>{t("Rounds")}</span>
          {[10, 15, 25].map((n) => (
            <button
              key={n}
              className="btn btn--ghost btn--sm" aria-pressed={n === rounds}
              style={styles.chip}
              onClick={() => setRounds(n)}
            >
              {n}
            </button>
          ))}
          <span style={styles.poolNote}>{t("{n} frames available", { n: frames.length })}</span>
        </div>
        <button className="btn btn--primary" style={styles.bigBtn} onClick={start}>
          <Play size={18} /> {t("Start")}
        </button>
      </div>
    );
  }

  if (phase === "done") {
    const hits = results.filter((r) => r.ok).length;
    const acc = results.length ? (hits / results.length) * 100 : 0;
    return (
      <div style={styles.panel}>
        <div style={styles.headerRow}>
          <Eye size={18} color="var(--cool)" />
          <h3 style={styles.title}>{t("Session complete")}</h3>
        </div>
        <div style={styles.statRow}>
          <div style={styles.stat}>
            <span style={styles.statLabel}>{t("Accuracy")}</span>
            <span
              style={{
                ...styles.statValue,
                color: acc >= 70 ? "var(--win)" : "var(--brand)",
              }}
            >
              {acc.toFixed(0)}%
            </span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>{t("Rounds")}</span>
            <span style={styles.statValue}>{results.length}</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statLabel}>{t("Flash")}</span>
            <span style={styles.statValue}>{config.flash_ms} ms</span>
          </div>
        </div>
        {skipped > 0 && (
          <p style={{ ...styles.desc, color: "var(--brand)" }}>
            {t("Frames skipped because the image would not load: {n}. They were not counted.", { n: skipped })}
          </p>
        )}
        <p style={styles.desc}>
          {t(
            acc >= SOLID_ACCURACY
              ? "Solid. Drop the flash duration in Setup and make it harder."
              : "Keep this flash duration until you are consistently above 80%."
          )}
        </p>
        <div style={{ display: "flex", gap: "var(--space-3)" }}>
          <button className="btn btn--primary" style={styles.bigBtn} onClick={start}>
            <RotateCcw size={18} /> {t("Again")}
          </button>
          <button className="btn btn--ghost" style={styles.bigBtn} onClick={reset}>
            {t("Back")}
          </button>
        </div>
      </div>
    );
  }

  const src = frame ? streamUrl(frame.path) : "";

  return (
    <div style={styles.panel}>
      <div style={styles.progressRow}>
        <span style={styles.progressText}>
          {results.length} / {rounds}
        </span>
        <div style={styles.progressTrack}>
          <div
            style={{ ...styles.progressFill, width: `${(results.length / rounds) * 100}%` }}
          />
        </div>
        <button className="btn btn--ghost" style={styles.chip} onClick={reset}>
          {t("Stop")}
        </button>
      </div>

      <div style={styles.stage}>
        {phase === "loading" && <span style={styles.loadingText}>{t("Loading…")}</span>}
        {phase === "flash" && <img src={src} alt="" style={styles.frameImg} />}
        {phase === "answer" && <span style={styles.hiddenText}>{t("What did you see?")}</span>}
        {phase === "reveal" && <img src={src} alt="" style={styles.frameImg} />}
      </div>

      {(phase === "answer" || phase === "reveal") && (
        <>
          <div style={styles.questionText}>{t(question.prompt)}</div>
          {phase === "answer" ? (
            <div style={styles.options}>
              {question.options.map((opt) => (
                <button
                  key={opt}
                  className="btn btn--ghost"
                  style={styles.option}
                  onClick={() => choose(opt)}
                >
                  {t(opt)}
                </button>
              ))}
            </div>
          ) : (
            <div style={styles.gradeRow}>
              <span style={styles.gradePrompt}>
                {t("You said")}{" "}
                <strong style={{ color: "var(--text)" }}>{chosen ? t(chosen) : ""}</strong>{" "}
                {t("— were you right?")}
              </span>
              <button className="btn btn--ghost" style={styles.gradeBtn} onClick={() => grade(true)}>
                <Check size={16} color="var(--win)" /> {t("Yes")}
              </button>
              <button className="btn btn--ghost" style={styles.gradeBtn} onClick={() => grade(false)}>
                <X size={16} color="var(--loss)" /> {t("No")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  panel: {
    background: "var(--surface-1)",
    border: "1px solid var(--line-soft)",
    borderRadius: "var(--radius-xl)",
    padding: "var(--space-6)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-4)",
  },
  headerRow: { display: "flex", alignItems: "center", gap: "var(--space-3)" },
  title: { margin: 0, fontSize: "var(--font-lg)", fontWeight: 700, color: "var(--text)" },
  desc: { margin: 0, fontSize: "var(--font-sm)", color: "var(--muted)", maxWidth: 620 },
  optionRow: { display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" },
  optionLabel: {
    fontSize: "var(--font-xs)",
    fontWeight: 700,
    color: "var(--faint)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    width: 70,
  },
  poolNote: { fontSize: "var(--font-xs)", color: "var(--faint)", marginLeft: "var(--space-3)" },
  chip: { padding: "6px 14px", fontSize: "var(--font-xs)" },
  bigBtn: { padding: "10px 20px", alignSelf: "flex-start", justifyContent: "center" },
  stage: {
    position: "relative",
    aspectRatio: "16 / 9",
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--sunken)",
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--line-soft)",
    overflow: "hidden",
  },
  frameImg: { width: "100%", height: "100%", objectFit: "contain", display: "block" },
  loadingText: { color: "var(--faint)", fontSize: "var(--font-sm)" },
  hiddenText: {
    color: "var(--faint)",
    fontSize: "var(--font-lg)",
    fontWeight: 600,
    letterSpacing: "0.04em",
  },
  questionText: { fontSize: "var(--font-md)", fontWeight: 600, color: "var(--text)" },
  options: { display: "flex", gap: "var(--space-2)", flexWrap: "wrap" },
  option: { padding: "8px 18px", fontSize: "var(--font-sm)" },
  gradeRow: { display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" },
  gradePrompt: { fontSize: "var(--font-sm)", color: "var(--muted)", marginRight: "auto" },
  gradeBtn: { padding: "8px 18px", fontSize: "var(--font-sm)" },
  progressRow: { display: "flex", alignItems: "center", gap: "var(--space-3)" },
  progressText: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-xs)",
    color: "var(--faint)",
    minWidth: 60,
  },
  progressTrack: {
    flex: 1,
    height: 4,
    background: "var(--surface-2)",
    borderRadius: "var(--radius-full)",
    overflow: "hidden",
  },
  progressFill: { height: "100%", background: "var(--accent-violet)", transition: "width 0.2s ease" },
  statRow: { display: "flex", gap: "var(--space-6)", flexWrap: "wrap" },
  stat: { display: "flex", flexDirection: "column", gap: 2 },
  statLabel: {
    fontSize: "var(--font-xs)",
    color: "var(--faint)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    fontWeight: 700,
  },
  statValue: { fontSize: "var(--font-2xl)", fontWeight: 800, fontFamily: "var(--font-mono)", color: "var(--text)" },
};
