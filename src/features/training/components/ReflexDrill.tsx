import React, { useCallback, useEffect, useRef, useState } from "react";
import { Play, RotateCcw, Zap, Target, Check, X, Lock } from "lucide-react";
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
import { Button } from "../../../components/ui/Button";
import { Segmented } from "../../../components/ui/Segmented";
import "./TrainingPanel.css";

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
    <div className="trn-champ">
      {icon ? (
        <img src={icon} alt={champion} className="trn-champ__img" />
      ) : (
        <div className="trn-champ__img trn-champ__img--none t-page">
          {champion.slice(0, 2).toUpperCase()}
        </div>
      )}
      <span className="trn-stage__big t-section">{champion}</span>
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
    // «Campeón» sin campeones grabados se desactiva con candado y tooltip, no
    // solo con el color: antes parecía apagado sin estarlo (auditoría V5).
    const champLocked = !champModeAvailable && !poolFailed && !poolLoading;
    return (
      <section className="card trn-card">
        <header className="trn-card__head">
          <Zap size={18} />
          <h2 className="trn-card__title t-card">{t("Key mapping drill")}</h2>
        </header>
        <p className="trn-desc t-body">
          {t("A role appears — press its camera key. Target: under {ms} ms with 95% accuracy, without looking at the keyboard.", { ms: CONSCIOUS_MS })}
        </p>

        <div className="trn-opts">
          <span className="trn-opts__label t-small">{t("Rounds")}</span>
          <div className="trn-opts__ctl">
            <Segmented
              label={t("Rounds")}
              value={rounds}
              onChange={setRounds}
              options={[20, 30, 50].map((n) => ({ value: n, label: n }))}
            />
          </div>

          <span className="trn-opts__label t-small">{t("Prompt")}</span>
          <div className="trn-opts__ctl">
            {/* Con un fallo de la petición el modo NO se desactiva: se puede
                reintentar sin salir de la pantalla. Antes quedaba gris con el
                mensaje de "juega una partida primero", que era mentira. */}
            <Segmented
              label={t("Prompt")}
              value={mode}
              onChange={(m) => {
                if (m === "role") setMode("role");
                else if (champModeAvailable) setMode("champion");
                else if (poolFailed) loadPool();
              }}
              options={[
                { value: "role" as const, label: t("Role") },
                {
                  value: "champion" as const,
                  label: t("Champion"),
                  icon: champLocked ? <Lock size={12} /> : undefined,
                  disabled: !champModeAvailable && !poolFailed,
                  title: t(
                    poolFailed
                      ? "Couldn't read your champion pool. Click to try again."
                      : champModeAvailable
                      ? "Uses champions seen in your recorded games"
                      : "Play a recorded game first to build your champion pool"
                  ),
                },
              ]}
            />
            {poolFailed && (
              <span className="trn-opts__error t-small">
                {t("Couldn't read your champion pool.")}
                <Button size="sm" onClick={loadPool}>{t("Retry")}</Button>
              </span>
            )}
          </div>

          <span className="trn-opts__label t-small">{t("Load")}</span>
          <div className="trn-opts__ctl">
            <Segmented
              label={t("Load")}
              value={withLoad ? "tracking" : "none"}
              onChange={(v) => setWithLoad(v === "tracking")}
              options={[
                { value: "none" as const, label: t("No load") },
                {
                  value: "tracking" as const,
                  label: t("Mouse tracking"),
                  icon: <Target size={14} />,
                  title: t("Adds a mouse-tracking task on top — this is where most people break"),
                },
              ]}
            />
          </div>
        </div>

        <div className="trn-actions">
          <Button variant="primary" icon={<Play size={16} />} onClick={start}>
            {t("Start")}
          </Button>
        </div>
      </section>
    );
  }

  if (phase === "countdown") {
    return (
      <section className="card trn-card">
        <div className="trn-stage" aria-live="assertive">
          <span className="trn-stage__big trn-stage__big--count t-hero">
            {countdown === 0 ? t("Go!") : countdown}
          </span>
          <span className="trn-stage__hint t-body">{t("Hands on the keys.")}</span>
        </div>
      </section>
    );
  }

  if (phase === "done") {
    const acc = done.length ? (hits / done.length) * 100 : 0;
    const roles = Array.from(new Set(done.map((r) => r.role)));
    return (
      <section className="card trn-card">
        <header className="trn-card__head">
          <Zap size={18} />
          <h2 className="trn-card__title t-card">{t("Session complete")}</h2>
        </header>
        <div className="trn-stats">
          <Stat label={t("Accuracy")} value={`${acc.toFixed(0)}%`} good={acc >= 95} />
          <Stat label={t("Avg latency")} value={`${avg.toFixed(0)} ms`} good={avg > 0 && avg < CONSCIOUS_MS} />
          <Stat
            label={t("Best")}
            value={`${hits ? Math.min(...done.filter((r) => r.ok).map((r) => r.latencyMs)).toFixed(0) : "—"} ms`}
          />
          {withLoad && <Stat label={t("Tracking")} value={`${tracking.toFixed(0)}%`} />}
        </div>

        <div className="trn-break">
          {roles.map((role) => {
            const rr = done.filter((r) => r.role === role);
            const rh = rr.filter((r) => r.ok);
            const rAvg = rh.length ? rh.reduce((a, r) => a + r.latencyMs, 0) / rh.length : 0;
            const rAcc = (rh.length / rr.length) * 100;
            return (
              <div key={role} className="trn-break__row t-small">
                <span className="trn-break__role">{t(roleLabel(role))}</span>
                <div className="trn-bar">
                  <span
                    className="trn-bar__fill"
                    data-tone={rAvg < CONSCIOUS_MS ? "good" : undefined}
                    style={{ "--p": Math.min(1, rAvg / 800) } as React.CSSProperties}
                  />
                </div>
                <span className="trn-break__val">{rAvg ? `${rAvg.toFixed(0)} ms` : "—"}</span>
                <span className="trn-break__acc trn-tone" data-tone={rAcc >= 95 ? "good" : "bad"}>
                  {rAcc.toFixed(0)}%
                </span>
              </div>
            );
          })}
        </div>

        <div className="trn-actions">
          <Button variant="primary" icon={<RotateCcw size={16} />} onClick={start}>
            {t("Again")}
          </Button>
          <Button onClick={reset}>{t("Back")}</Button>
        </div>
      </section>
    );
  }

  // --- running ---
  return (
    <section className="card trn-card">
      <div className="trn-run">
        <span className="trn-run__count t-small">
          {done.length} / {rounds}
        </span>
        <div
          className="trn-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={rounds}
          aria-valuenow={done.length}
        >
          <span className="trn-progress__fill" style={{ "--p": done.length / rounds } as React.CSSProperties} />
        </div>
        <Button size="sm" onClick={reset}>{t("Stop")}</Button>
      </div>

      {withLoad && <TrackingTask onScore={setTracking} />}

      <div className="trn-stage">
        {feedback ? (
          feedback.ok ? (
            <>
              <Check size={40} className="trn-ic-ok" />
              <span className="trn-stage__ok t-metric">{feedback.latencyMs.toFixed(0)} ms</span>
            </>
          ) : (
            <>
              <X size={40} className="trn-ic-miss" />
              <span className="trn-stage__miss t-metric">
                {feedback.pressedKey
                  ? t("{pressed} — it was {expected}", {
                      pressed: feedback.pressedKey,
                      expected: feedback.expectedKey,
                    })
                  : t("Too slow")}
              </span>
            </>
          )
        ) : prompt ? (
          prompt.champion ? (
            <ChampionPrompt champion={prompt.champion} />
          ) : (
            <span className="trn-stage__big t-hero">{t(roleLabel(prompt.binding.role))}</span>
          )
        ) : null}
      </div>

      <div className="trn-live t-small">
        <span>
          {hits}/{done.length} {t("correct")}
        </span>
        <span>{avg ? t("{ms} ms avg", { ms: avg.toFixed(0) }) : "—"}</span>
      </div>
    </section>
  );
};

/** Métrica del resultado: jade si ya está en el objetivo, oro si todavía no. */
const Stat: React.FC<{ label: string; value: string; good?: boolean }> = ({
  label,
  value,
  good,
}) => (
  <div className="trn-stat">
    <span className="trn-stat__label t-label">{label}</span>
    <span
      className="trn-stat__value t-metric"
      data-tone={good === undefined ? undefined : good ? "good" : "warn"}
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
    <div ref={areaRef} className="trn-track">
      {/* La posición cambia en cada fotograma: es lo único que va en línea. */}
      <div className="trn-track__dot" style={{ left: `${pos.x}%`, top: `${pos.y}%` }} />
      <span className="trn-track__hint t-label">{t("Keep the cursor on the dot")}</span>
    </div>
  );
};
