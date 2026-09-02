import React, { useCallback, useEffect, useRef, useState } from "react";
import { Play, RotateCcw, Zap, Target, Check, X } from "lucide-react";
import {
  CameraBinding,
  DrillSession,
  RoleChampion,
  TrainingConfig,
  getChampionPool,
  normalizeKey,
  saveDrillSession,
} from "../api";
import { useChampionIcon } from "../../../core/ddragon";
import { roleLabel } from "../../../core/roles";
import { useT } from "../../../core/LanguageProvider";

/** Cuánto esperamos una respuesta antes de contar la ronda como fallada. */
const TIMEOUT_MS = 3000;
/** Pausa entre rondas, con jitter para que no se pueda anticipar el ritmo. */
const ISI_MIN_MS = 350;
const ISI_MAX_MS = 900;
/** Cuenta atrás antes de empezar, y lo que dura cada número. */
const COUNTDOWN_FROM = 3;
const COUNTDOWN_STEP_MS = 700;
/**
 * Latencia por debajo de la cual el mapeo ha dejado de ser consciente. Es el
 * objetivo del ejercicio y la referencia que se pinta en el resultado.
 */
const CONSCIOUS_MS = 400;

type Phase = "idle" | "countdown" | "running" | "done";
type Mode = "role" | "champion";

interface Round {
  role: string;
  expectedKey: string;
  pressedKey: string;
  latencyMs: number;
  ok: boolean;
}

interface Prompt {
  binding: CameraBinding;
  champion: string | null;
}

/** Retrato del campeón (o monograma si Data Dragon no lo resuelve). */
const ChampionPrompt: React.FC<{ champion: string }> = ({ champion }) => {
  const icon = useChampionIcon(champion);
  return (
    <div style={styles.champWrap}>
      {icon ? (
        <img src={icon} alt={champion} style={styles.champImg} />
      ) : (
        <div style={{ ...styles.champImg, ...styles.champFallback }}>
          {champion.slice(0, 2).toUpperCase()}
        </div>
      )}
      <span style={styles.champName}>{champion}</span>
    </div>
  );
};

/**
 * Drill de mapeo: sale un rol (o un campeón) y tienes que pulsar su tecla de
 * cámara. Mide latencia y acierto por rol para enseñarte dónde dudas.
 *
 * El objetivo no es la velocidad bruta sino que el mapeo deje de ser consciente:
 * por debajo de 400 ms con >95% de acierto ya no lo estás pensando.
 */
export const ReflexDrill: React.FC<{
  config: TrainingConfig;
  onFinished?: () => void;
}> = ({ config, onFinished }) => {
  const [rounds, setRounds] = useState(30);
  const [mode, setMode] = useState<Mode>("role");
  const [withLoad, setWithLoad] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [countdown, setCountdown] = useState(COUNTDOWN_FROM);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [done, setDone] = useState<Round[]>([]);
  const [feedback, setFeedback] = useState<Round | null>(null);
  const [pool, setPool] = useState<RoleChampion[]>([]);
  // `null` = todavía no ha respondido; `true` = la petición falló. Sin esto,
  // "no tienes campeones grabados" y "la petición reventó" eran el mismo
  // botón gris con el mismo tooltip.
  const [poolFailed, setPoolFailed] = useState(false);
  const [poolLoading, setPoolLoading] = useState(true);
  const [tracking, setTracking] = useState(0);
  const t = useT();

  // Refs para no cerrar sobre estado obsoleto dentro de los listeners y timers.
  const promptRef = useRef<Prompt | null>(null);
  const shownAtRef = useRef(0);
  const resultsRef = useRef<Round[]>([]);
  const timeoutRef = useRef<number | null>(null);
  const nextRoundRef = useRef<() => void>(() => {});
  const phaseRef = useRef<Phase>("idle");

  const bindings = config.bindings;

  const loadPool = useCallback(() => {
    setPoolLoading(true);
    setPoolFailed(false);
    getChampionPool()
      .then((p) => setPool(p))
      .catch(() => { setPool([]); setPoolFailed(true); })
      .finally(() => setPoolLoading(false));
  }, []);

  useEffect(loadPool, [loadPool]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const championsFor = useCallback(
    (role: string) => pool.filter((p) => p.role === role).map((p) => p.champion),
    [pool]
  );

  const champModeAvailable = bindings.some((b) => championsFor(b.role).length > 0);

  const clearTimer = () => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  /** Cierra la ronda actual, guarda el resultado y encadena la siguiente. */
  const settle = useCallback(
    (pressedKey: string, latencyMs: number) => {
      const p = promptRef.current;
      if (!p) return;
      clearTimer();
      const round: Round = {
        role: p.binding.role,
        expectedKey: p.binding.key.toUpperCase(),
        pressedKey,
        latencyMs,
        ok: pressedKey === p.binding.key.toUpperCase(),
      };
      resultsRef.current = [...resultsRef.current, round];
      promptRef.current = null;
      setPrompt(null);
      setDone(resultsRef.current);
      setFeedback(round);

      const isi = ISI_MIN_MS + Math.random() * (ISI_MAX_MS - ISI_MIN_MS);
      timeoutRef.current = window.setTimeout(() => {
        setFeedback(null);
        nextRoundRef.current();
      }, isi);
    },
    []
  );

  const nextRound = useCallback(() => {
    if (resultsRef.current.length >= rounds) {
      setPhase("done");
      return;
    }
    // Evitamos repetir el mismo rol dos veces seguidas: si no, se responde por
    // inercia en vez de leyendo el prompt.
    const last = promptRef.current?.binding.role;
    const pickable = bindings.length > 1 ? bindings.filter((b) => b.role !== last) : bindings;
    const binding = pickable[Math.floor(Math.random() * pickable.length)];

    let champion: string | null = null;
    if (mode === "champion") {
      const champs = championsFor(binding.role);
      if (champs.length > 0) champion = champs[Math.floor(Math.random() * champs.length)];
    }

    const p: Prompt = { binding, champion };
    promptRef.current = p;
    setPrompt(p);
    shownAtRef.current = performance.now();

    clearTimer();
    timeoutRef.current = window.setTimeout(() => settle("", TIMEOUT_MS), TIMEOUT_MS);
  }, [bindings, championsFor, mode, rounds, settle]);

  useEffect(() => {
    nextRoundRef.current = nextRound;
  }, [nextRound]);

  // --- Entrada de teclado ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phaseRef.current !== "running" || !promptRef.current) return;
      const k = normalizeKey(e);
      if (!k) return;
      // Solo cuentan las teclas de cámara: pulsar otra cosa no es "confundirse
      // de aliado", que es el error que este drill quiere medir.
      if (!bindings.some((b) => b.key.toUpperCase() === k)) return;
      e.preventDefault();
      settle(k, performance.now() - shownAtRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bindings, settle]);

  // --- Cuenta atrás ---
  useEffect(() => {
    if (phase !== "countdown") return;
    if (countdown <= 0) {
      setPhase("running");
      nextRoundRef.current();
      return;
    }
    const t = window.setTimeout(() => setCountdown((c) => c - 1), COUNTDOWN_STEP_MS);
    return () => window.clearTimeout(t);
  }, [phase, countdown]);

  // --- Guardado al terminar ---
  useEffect(() => {
    if (phase !== "done") return;
    const rs = resultsRef.current;
    if (rs.length === 0) return;
    const hits = rs.filter((r) => r.ok);
    const roles = Array.from(new Set(rs.map((r) => r.role)));
    const session: DrillSession = {
      id: `drill_${Date.now()}`,
      date: new Date().toISOString().slice(0, 19).replace("T", " "),
      kind: "reflex",
      rounds: rs.length,
      hits: hits.length,
      avg_latency_ms: hits.length ? hits.reduce((a, r) => a + r.latencyMs, 0) / hits.length : 0,
      best_latency_ms: hits.length ? Math.min(...hits.map((r) => r.latencyMs)) : 0,
      per_role: roles.map((role) => {
        const rr = rs.filter((r) => r.role === role);
        const rh = rr.filter((r) => r.ok);
        return {
          role,
          attempts: rr.length,
          hits: rh.length,
          avg_latency_ms: rh.length ? rh.reduce((a, r) => a + r.latencyMs, 0) / rh.length : 0,
        };
      }),
      mode: withLoad ? `${mode}+load` : mode,
    };
    saveDrillSession(session).then(() => onFinished?.()).catch(console.error);
    // Solo al entrar en "done"; las dependencias restantes son estables en ese momento.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => () => clearTimer(), []);

  const start = () => {
    resultsRef.current = [];
    promptRef.current = null;
    setDone([]);
    setFeedback(null);
    setPrompt(null);
    setTracking(0);
    setCountdown(COUNTDOWN_FROM);
    setPhase("countdown");
  };

  const reset = () => {
    clearTimer();
    resultsRef.current = [];
    promptRef.current = null;
    setPhase("idle");
    setPrompt(null);
    setFeedback(null);
    setDone([]);
  };

  const hits = done.filter((r) => r.ok).length;
  const avg = hits ? done.filter((r) => r.ok).reduce((a, r) => a + r.latencyMs, 0) / hits : 0;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (phase === "idle") {
    return (
      <div style={styles.panel}>
        <div style={styles.headerRow}>
          <Zap size={18} color="var(--cool)" />
          <h3 style={styles.title}>{t("Key mapping drill")}</h3>
        </div>
        <p style={styles.desc}>
          {t("A role appears — press its camera key. Target: under {ms} ms with 95% accuracy, without looking at the keyboard.", { ms: CONSCIOUS_MS })}
        </p>

        <div style={styles.optionRow}>
          <span style={styles.optionLabel}>{t("Rounds")}</span>
          {[20, 30, 50].map((n) => (
            <button
              key={n}
              className="btn btn--ghost btn--sm" aria-pressed={n === rounds}
              style={styles.chip}
              onClick={() => setRounds(n)}
            >
              {n}
            </button>
          ))}
        </div>

        <div style={styles.optionRow}>
          <span style={styles.optionLabel}>{t("Prompt")}</span>
          <button
            className="btn btn--ghost btn--sm" aria-pressed={mode === "role"}
            style={styles.chip}
            onClick={() => setMode("role")}
          >
            {t("Role")}
          </button>
          {/* Con un fallo de la petición el modo NO se desactiva: se puede
              reintentar sin salir de la pantalla. Antes quedaba gris con el
              mensaje de "juega una partida primero", que era mentira. */}
          <button
            className="btn btn--ghost btn--sm" aria-pressed={mode === "champion"}
            style={{ ...styles.chip, opacity: champModeAvailable || poolFailed ? 1 : 0.4 }}
            onClick={() => (champModeAvailable ? setMode("champion") : poolFailed && loadPool())}
            disabled={!champModeAvailable && !poolFailed && !poolLoading}
            title={t(
              poolFailed
                ? "Couldn't read your champion pool. Click to try again."
                : champModeAvailable
                ? "Uses champions seen in your recorded games"
                : "Play a recorded game first to build your champion pool"
            )}
          >
            {t("Champion")}
          </button>
          {poolFailed && (
            <span style={styles.poolError}>
              {t("Couldn't read your champion pool.")}{" "}
              <button className="btn btn--ghost btn--sm" onClick={loadPool}>{t("Retry")}</button>
            </span>
          )}
        </div>

        <div style={styles.optionRow}>
          <span style={styles.optionLabel}>{t("Load")}</span>
          <button
            className="btn btn--ghost btn--sm" aria-pressed={withLoad}
            style={styles.chip}
            onClick={() => setWithLoad((v) => !v)}
            title={t("Adds a mouse-tracking task on top — this is where most people break")}
          >
            <Target size={14} /> {t("Mouse tracking")}
          </button>
        </div>

        <button className="btn btn--primary" style={styles.bigBtn} onClick={start}>
          <Play size={18} /> {t("Start")}
        </button>
      </div>
    );
  }

  if (phase === "countdown") {
    return (
      <div style={styles.panel}>
        <div style={styles.countdown}>{countdown === 0 ? t("GO") : countdown}</div>
        <p style={styles.desc}>{t("Hands on the keys.")}</p>
      </div>
    );
  }

  if (phase === "done") {
    const acc = done.length ? (hits / done.length) * 100 : 0;
    const roles = Array.from(new Set(done.map((r) => r.role)));
    return (
      <div style={styles.panel}>
        <div style={styles.headerRow}>
          <Zap size={18} color="var(--cool)" />
          <h3 style={styles.title}>{t("Session complete")}</h3>
        </div>
        <div style={styles.statRow}>
          <Stat label={t("Accuracy")} value={`${acc.toFixed(0)}%`} good={acc >= 95} />
          <Stat label={t("Avg latency")} value={`${avg.toFixed(0)} ms`} good={avg > 0 && avg < CONSCIOUS_MS} />
          <Stat
            label={t("Best")}
            value={`${hits ? Math.min(...done.filter((r) => r.ok).map((r) => r.latencyMs)).toFixed(0) : "—"} ms`}
          />
          {withLoad && <Stat label={t("Tracking")} value={`${tracking.toFixed(0)}%`} />}
        </div>

        <div style={styles.breakdown}>
          {roles.map((role) => {
            const rr = done.filter((r) => r.role === role);
            const rh = rr.filter((r) => r.ok);
            const rAvg = rh.length ? rh.reduce((a, r) => a + r.latencyMs, 0) / rh.length : 0;
            const rAcc = (rh.length / rr.length) * 100;
            return (
              <div key={role} style={styles.breakdownRow}>
                <span style={styles.breakdownRole}>{t(roleLabel(role))}</span>
                <div style={styles.bar}>
                  <div
                    style={{
                      ...styles.barFill,
                      width: `${Math.min(100, (rAvg / 800) * 100)}%`,
                      background: rAvg < CONSCIOUS_MS ? "var(--win)" : "var(--brand)",
                    }}
                  />
                </div>
                <span style={styles.breakdownVal}>{rAvg ? `${rAvg.toFixed(0)} ms` : "—"}</span>
                <span
                  style={{
                    ...styles.breakdownAcc,
                    color: rAcc >= 95 ? "var(--win)" : "var(--loss)",
                  }}
                >
                  {rAcc.toFixed(0)}%
                </span>
              </div>
            );
          })}
        </div>

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

  // --- running ---
  return (
    <div style={styles.panel}>
      <div style={styles.progressRow}>
        <span style={styles.progressText}>
          {done.length} / {rounds}
        </span>
        <div style={styles.progressTrack}>
          <div style={{ ...styles.progressFill, width: `${(done.length / rounds) * 100}%` }} />
        </div>
        <button className="btn btn--ghost" style={styles.chip} onClick={reset}>
          {t("Stop")}
        </button>
      </div>

      {withLoad && <TrackingTask onScore={setTracking} />}

      <div style={styles.stage}>
        {feedback ? (
          <div style={styles.feedback}>
            {feedback.ok ? (
              <>
                <Check size={48} color="var(--win)" />
                <span style={{ ...styles.feedbackMs, color: "var(--win)" }}>
                  {feedback.latencyMs.toFixed(0)} ms
                </span>
              </>
            ) : (
              <>
                <X size={48} color="var(--loss)" />
                <span style={{ ...styles.feedbackMs, color: "var(--loss)" }}>
                  {feedback.pressedKey
                    ? t("{pressed} — it was {expected}", {
                        pressed: feedback.pressedKey,
                        expected: feedback.expectedKey,
                      })
                    : t("Too slow")}
                </span>
              </>
            )}
          </div>
        ) : prompt ? (
          prompt.champion ? (
            <ChampionPrompt champion={prompt.champion} />
          ) : (
            <div style={styles.roleprompt}>{t(roleLabel(prompt.binding.role))}</div>
          )
        ) : null}
      </div>

      <div style={styles.liveStats}>
        <span>
          {hits}/{done.length} {t("correct")}
        </span>
        <span>{avg ? t("{ms} ms avg", { ms: avg.toFixed(0) }) : "—"}</span>
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string; good?: boolean }> = ({
  label,
  value,
  good,
}) => (
  <div style={styles.stat}>
    <span style={styles.statLabel}>{label}</span>
    <span
      style={{
        ...styles.statValue,
        color: good === undefined ? "var(--text)" : good ? "var(--win)" : "var(--brand)",
      }}
    >
      {value}
    </span>
  </div>
);

/**
 * Tarea de carga: un objetivo que deriva y que hay que seguir con el ratón.
 * Sirve para que el mapeo tenga que salir mientras la cabeza está ocupada, que es
 * la única condición en la que importa.
 */
const TrackingTask: React.FC<{ onScore: (pct: number) => void }> = ({ onScore }) => {
  const t = useT();
  const areaRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 50, y: 50 });
  const posRef = useRef({ x: 50, y: 50, vx: 0.35, vy: 0.25 });
  const mouseRef = useRef({ x: -999, y: -999 });
  const samplesRef = useRef({ inside: 0, total: 0 });

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(50, now - last);
      last = now;
      const p = posRef.current;
      // Rebote en los bordes con un empujón aleatorio para que no sea predecible.
      p.x += p.vx * dt * 0.06;
      p.y += p.vy * dt * 0.06;
      if (p.x < 5 || p.x > 95) {
        p.vx *= -1;
        p.vy += (Math.random() - 0.5) * 0.2;
      }
      if (p.y < 10 || p.y > 90) {
        p.vy *= -1;
        p.vx += (Math.random() - 0.5) * 0.2;
      }
      p.x = Math.max(5, Math.min(95, p.x));
      p.y = Math.max(10, Math.min(90, p.y));
      setPos({ x: p.x, y: p.y });

      const rect = areaRef.current?.getBoundingClientRect();
      if (rect) {
        const tx = rect.left + (p.x / 100) * rect.width;
        const ty = rect.top + (p.y / 100) * rect.height;
        const d = Math.hypot(mouseRef.current.x - tx, mouseRef.current.y - ty);
        samplesRef.current.total += 1;
        if (d < 40) samplesRef.current.inside += 1;
        onScore((samplesRef.current.inside / samplesRef.current.total) * 100);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    const onMove = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMove);
    };
  }, [onScore]);

  return (
    <div ref={areaRef} style={styles.trackArea}>
      <div style={{ ...styles.trackTarget, left: `${pos.x}%`, top: `${pos.y}%` }} />
      <span style={styles.trackHint}>{t("Keep the cursor on the dot")}</span>
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
  desc: { margin: 0, fontSize: "var(--font-sm)", color: "var(--muted)", maxWidth: 560 },
  optionRow: { display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" },
  poolError: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-2)",
    fontSize: "var(--font-xs)",
    color: "var(--loss)",
  },
  optionLabel: {
    fontSize: "var(--font-xs)",
    fontWeight: 700,
    color: "var(--faint)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    width: 70,
  },
  chip: { padding: "6px 14px", fontSize: "var(--font-xs)" },
  bigBtn: {
    padding: "10px 20px",
    fontSize: "var(--font-sm)",
    alignSelf: "flex-start",
    justifyContent: "center",
  },
  countdown: {
    fontSize: 96,
    fontWeight: 800,
    color: "var(--accent-violet)",
    textAlign: "center",
    fontFamily: "var(--font-mono)",
  },
  stage: {
    height: 220,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--bg-app)",
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--line-soft)",
  },
  roleprompt: {
    fontSize: 56,
    fontWeight: 800,
    letterSpacing: "0.06em",
    color: "var(--text)",
  },
  champWrap: { display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--space-3)" },
  champImg: {
    width: 112,
    height: 112,
    borderRadius: "var(--radius-full)",
    border: "2px solid var(--line)",
    objectFit: "cover",
  },
  champFallback: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--surface-2)",
    fontWeight: 800,
    fontSize: 32,
    color: "var(--muted)",
  },
  champName: { fontSize: "var(--font-xl)", fontWeight: 700, color: "var(--text)" },
  feedback: { display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--space-2)" },
  feedbackMs: { fontSize: "var(--font-lg)", fontWeight: 700, fontFamily: "var(--font-mono)" },
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
  progressFill: {
    height: "100%",
    background: "var(--accent-violet)",
    transition: "width 0.2s ease",
  },
  liveStats: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: "var(--font-xs)",
    color: "var(--faint)",
    fontFamily: "var(--font-mono)",
  },
  statRow: { display: "flex", gap: "var(--space-6)", flexWrap: "wrap" },
  stat: { display: "flex", flexDirection: "column", gap: 2 },
  statLabel: {
    fontSize: "var(--font-xs)",
    color: "var(--faint)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    fontWeight: 700,
  },
  statValue: { fontSize: "var(--font-2xl)", fontWeight: 800, fontFamily: "var(--font-mono)" },
  breakdown: { display: "flex", flexDirection: "column", gap: "var(--space-2)" },
  breakdownRow: { display: "flex", alignItems: "center", gap: "var(--space-3)" },
  breakdownRole: {
    width: 90,
    fontSize: "var(--font-xs)",
    fontWeight: 700,
    color: "var(--muted)",
  },
  bar: {
    flex: 1,
    height: 6,
    background: "var(--surface-2)",
    borderRadius: "var(--radius-full)",
    overflow: "hidden",
  },
  barFill: { height: "100%", borderRadius: "var(--radius-full)" },
  breakdownVal: {
    width: 70,
    textAlign: "right",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-xs)",
    color: "var(--muted)",
  },
  breakdownAcc: {
    width: 50,
    textAlign: "right",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-xs)",
    fontWeight: 700,
  },
  trackArea: {
    position: "relative",
    height: 90,
    background: "var(--bg-app)",
    border: "1px dashed var(--line)",
    borderRadius: "var(--radius-lg)",
    overflow: "hidden",
  },
  trackTarget: {
    position: "absolute",
    width: 26,
    height: 26,
    marginLeft: -13,
    marginTop: -13,
    borderRadius: "var(--radius-full)",
    background: "var(--accent-teal)",
    boxShadow: "0 0 12px color-mix(in srgb, var(--cool) 50%, transparent)",
  },
  trackHint: {
    position: "absolute",
    left: "var(--space-3)",
    bottom: "var(--space-2)",
    fontSize: 10,
    color: "var(--faint)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  },
};
