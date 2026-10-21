import React, { useCallback, useEffect, useState } from "react";
import { Zap, Brain, Keyboard, TrendingUp } from "lucide-react";
import { DrillSession, TrainingConfig, getDrillSessions, getTrainingConfig } from "../api";
import { ReflexDrill } from "./ReflexDrill";
import { RecallDrill } from "./RecallDrill";
import { AwarenessQuiz } from "./AwarenessQuiz";
import { TrainingSetup } from "./TrainingSetup";
import { useT } from "../../../core/LanguageProvider";
import { useDelayedLoading } from "../../../core/useDelayedLoading";
import { useDialog } from "../../../components/ui/DialogProvider";
import { Segmented } from "../../../components/ui/Segmented";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Skeleton, SkeletonLines } from "../../../components/ui/Skeleton";
import "./TrainingPanel.css";

type Section = "drills" | "awareness" | "setup";

const SECTIONS: { key: Section; label: string; icon: React.ReactNode }[] = [
  { key: "drills", label: "Drills", icon: <Zap size={14} /> },
  { key: "awareness", label: "Awareness", icon: <Brain size={14} /> },
  { key: "setup", label: "Setup", icon: <Keyboard size={14} /> },
];

/**
 * Umbral de lectura consciente, en milisegundos. Por debajo de esto la lectura
 * deja de pasar por la parte que se da cuenta, que es todo el objetivo del
 * ejercicio: aparece como línea de referencia en la curva.
 */
const CONSCIOUS_MS = 400;

/** Curva de latencia media de las últimas sesiones: la única prueba de que mejoras. */
const ProgressChart: React.FC<{ sessions: DrillSession[] }> = ({ sessions }) => {
  const t = useT();
  const data = sessions
    .filter((s) => s.kind === "reflex" && s.avg_latency_ms > 0)
    .slice(0, 20)
    .reverse();
  if (data.length < 2) return null;

  const w = 100;
  const h = 34;
  const max = Math.max(...data.map((d) => d.avg_latency_ms), 600);
  const refY = h - (CONSCIOUS_MS / max) * h;
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
    <section className="card trn-card">
      <header className="trn-card__head">
        <TrendingUp size={16} />
        <h2 className="trn-card__title t-card">{t("Avg latency, last {n} sessions", { n: data.length })}</h2>
      </header>
      {/* 400 ms es el umbral en que la lectura deja de ser consciente, y es la
          única razón por la que esa línea está ahí. */}
      <div className="trn-spark">
        <span className="trn-spark__ref t-label" style={{ "--y": CONSCIOUS_MS / max } as React.CSSProperties}>
          {t("{n} ms", { n: CONSCIOUS_MS })}
        </span>
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
          <line
            x1="0"
            x2={w}
            y1={refY}
            y2={refY}
            stroke="var(--line)"
            strokeWidth="0.4"
            strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
          />
          <polyline
            points={pts}
            fill="none"
            stroke="var(--cool)"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      <div className="trn-spark__foot t-small">
        <span>{t("{n} ms", { n: last.toFixed(0) })}</span>
        {/* La frase ya dice el sentido: con el signo delante salía «+48 ms más
            lento» y, al mejorar, «-48 ms más rápido». */}
        <span className="trn-tone" data-tone={delta <= 0 ? "good" : "bad"}>
          {t(delta <= 0 ? "{ms} ms faster than your first" : "{ms} ms slower than your first", {
            ms: Math.abs(delta).toFixed(0),
          })}
        </span>
      </div>
    </section>
  );
};

export const TrainingPanel: React.FC = () => {
  const [section, setSection] = useState<Section>("drills");
  const [config, setConfig] = useState<TrainingConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<DrillSession[]>([]);
  // Cambios sin guardar en Ajustes. Salir de la pestaña los tira sin decir
  // nada, así que se pregunta antes.
  const [setupDirty, setSetupDirty] = useState(false);
  const t = useT();
  const { showConfirm } = useDialog();
  // Esqueleto solo si la configuración tarda: por debajo de 150 ms, nada.
  const showSkeleton = useDelayedLoading(config === null && configError === null);

  const goTo = async (next: Section) => {
    if (next === section) return;
    if (section === "setup" && setupDirty) {
      const ok = await showConfirm({
        title: t("Discard unsaved changes?"),
        message: t("Your camera keys and drill settings have changes that were never saved."),
        confirmText: t("Discard"),
        destructive: true,
      });
      if (!ok) return;
      setSetupDirty(false);
    }
    setSection(next);
  };

  const loadSessions = useCallback(() => {
    getDrillSessions(30).then(setSessions).catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    // Antes un fallo aquí dejaba «Cargando…» para siempre.
    getTrainingConfig()
      .then(setConfig)
      .catch((e) => setConfigError(String(e)));
    loadSessions();
  }, [loadSessions]);

  const body = () => {
    if (configError !== null) {
      return <p className="trn-error t-body">{t("Couldn't load the training settings: {msg}", { msg: configError })}</p>;
    }
    if (!config) {
      return showSkeleton ? (
        <div className="card trn-card" role="status" aria-busy="true" aria-label={t("Loading…")}>
          <Skeleton width="40%" height={16} />
          <SkeletonLines lines={2} />
          <Skeleton shape="block" height={96} />
        </div>
      ) : null;
    }
    if (section === "setup") {
      return <TrainingSetup config={config} onSaved={setConfig} onDirtyChange={setSetupDirty} />;
    }
    if (section === "awareness") return <AwarenessQuiz />;
    if (config.bindings.length === 0) {
      return (
        <div className="card">
          <EmptyState
            icon={<Keyboard />}
            title={t("No camera keys configured")}
            text={t("Set which key you press for each ally in Setup, then come back.")}
            action={
              <Button variant="primary" onClick={() => { void goTo("setup"); }}>
                {t("Go to Setup")}
              </Button>
            }
          />
        </div>
      );
    }
    return (
      <>
        <ReflexDrill config={config} onFinished={loadSessions} />
        <RecallDrill config={config} onFinished={loadSessions} />
        <ProgressChart sessions={sessions} />
      </>
    );
  };

  return (
    <div className="trn">
      <div className="trn__col">
        <header className="trn__head">
          <h1 className="trn__title t-page">{t("Training")}</h1>
          <p className="trn__sub t-body">
            {t("Camera keys are not a speed problem. They are a habit, a 400 ms read, and a question you are trying to answer.")}
          </p>
        </header>

        <Segmented
          label={t("Training")}
          value={section}
          onChange={(k) => { void goTo(k); }}
          options={SECTIONS.map((s) => ({ value: s.key, label: t(s.label), icon: s.icon }))}
        />

        <div className="trn__body">{body()}</div>
      </div>
    </div>
  );
};
