import React from "react";
import { GraduationCap } from "lucide-react";
import type { CoachPlan, CoachPlanResult, CoachPlanState, CoachRow, CoachSummary } from "../../../core/tauri-ipc";
import {
  categoryHelp,
  focusTitle,
  isOwnBaseline,
  planCounted,
  planErrorText,
  planTitle,
  wpPoints,
} from "../../../core/coach";
import { confidenceOf, sampleLabel } from "../../../core/patterns";
import { useLang } from "../../../core/LanguageProvider";
import { Button } from "../../../components/ui/Button";
import { Chip, type ChipTone } from "../../../components/ui/Chip";
import { SkeletonLines } from "../../../components/ui/Skeleton";

/**
 * «Tu foco», del Coach: el resumen que Patrones enseña del plan de 10 partidas
 * (rediseño «Ritmo», fase 3d). Antes esta tarjeta era «el bloque de cinco
 * minutos en que más mueres» con su propia acción oro; ahora el foco lo elige
 * el Coach (`coach.rs`) y aquí solo se cuenta en qué punto está, con el antes
 * y el después, y se enlaza a la pantalla Coach para todo lo demás.
 *
 * Una regla que manda sobre el diseño (memoria del plan 4.3): el foco baja
 * solo por haberlo elegido por ser lo peor. Por eso, mientras dura el plan, lo
 * que se compara es con lo ESPERADO sin cambiar nada, y la cifra del plan no
 * se pinta de verde: con cuatro partidas no hay nada que celebrar. El color
 * llega con el veredicto, y el veredicto normal tras diez partidas es «muestra
 * corta», que se dice como tal y nunca como mejora.
 */

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Lo que enseña la tarjeta, decidido una vez y compartido con el mapa. */
export type CoachFocusView =
  | { kind: "loading" }
  | { kind: "active"; plan: CoachPlan; state: CoachPlanState }
  | { kind: "closed"; plan: CoachPlan; result: CoachPlanResult }
  | { kind: "focus"; row: CoachRow; summary: CoachSummary; state: CoachPlanState | null }
  | { kind: "none"; reason: "failed" | "few" | "nothing"; summary: CoachSummary | null };

/**
 * Qué toca enseñar. Primero el plan: si hay uno en curso, eso es en lo que
 * estás, aunque el Coach ya proponga otra cosa. Si el último se cerró, su
 * antes y después hasta que empiece otro. Sin plan, el foco del Coach.
 *
 * Se espera al plan antes de decidir: pintar el foco y que a los 100 ms lo
 * sustituya el plan en curso es justo el parpadeo que hay que evitar.
 */
export function coachFocusView(
  summary: CoachSummary | null | undefined,
  state: CoachPlanState | null | undefined
): CoachFocusView {
  if (state === undefined) return { kind: "loading" };
  if (state?.active) return { kind: "active", plan: state.active, state };
  const ultimo = state?.state === "closed" ? state.history[0] : undefined;
  if (ultimo?.result) return { kind: "closed", plan: ultimo, result: ultimo.result };
  if (summary === undefined) return { kind: "loading" };
  if (summary === null) return { kind: "none", reason: "failed", summary: null };
  if (summary.focus) return { kind: "focus", row: summary.focus, summary, state };
  return { kind: "none", reason: summary.games < summary.min_games ? "few" : "nothing", summary };
}

/** El tramo del foco (0-4), para resaltar sus muertes en el mapa; null sin foco. */
export function coachFocusTramo(view: CoachFocusView): number | null {
  if (view.kind === "active" || view.kind === "closed") return view.plan.tramo;
  if (view.kind === "focus") return view.row.tramo;
  return null;
}

/** «2,1%»: probabilidad de victoria (0-1) en puntos, como en Hoy y en el Coach. */
const pct = (x: number, lang: string): string => `${wpPoints(x, lang)}%`;

/** «−1,2» / «+0,8»: un extremo del intervalo, siempre con signo. */
const signed = (x: number, lang: string): string => `${x < 0 ? "−" : "+"}${wpPoints(x, lang)}`;

/** Una cifra con su etiqueta encima y su detalle debajo. */
const Kpi: React.FC<{ label: string; value: string; detail: string; tone?: "good" | "bad" }> = ({
  label,
  value,
  detail,
  tone,
}) => (
  <div className="pp-kpi">
    <dt className="pp-label">{label}</dt>
    <dd className={`pp-kpi-value${tone ? ` pp-kpi-value--${tone}` : ""}`}>{value}</dd>
    <dd className="pp-kpi-detail">{detail}</dd>
  </div>
);

const VERDICT: Record<CoachPlanResult["verdict"], { tone: ChipTone; label: string }> = {
  improved: { tone: "win", label: "Improved" },
  same: { tone: "neutral", label: "No change" },
  worse: { tone: "loss", label: "Worse" },
  short_sample: { tone: "outline", label: "Short sample" },
};

/** La frase del cierre. «Muestra corta» es lo normal y se dice sin adornos. */
function verdictText(r: CoachPlanResult, t: Translate, lang: string): string {
  const n = r.n_after;
  if (r.low == null || r.high == null) {
    return t("With {n} games it can't be told apart yet.", { n });
  }
  const vars = { n, a: signed(r.low, lang), b: signed(r.high, lang) };
  switch (r.verdict) {
    case "improved":
      return t("Below what was expected without changing anything: between {a} and {b} points per game.", vars);
    case "worse":
      return t("Above what was expected without changing anything: between {a} and {b} points per game.", vars);
    case "same":
      return t("The same as expected without changing anything: between {a} and {b} points per game.", vars);
    default:
      return t("With {n} games it can't be told apart: the change is between {a} and {b} points per game.", vars);
  }
}

export const CoachFocusCard: React.FC<{ view: CoachFocusView; onOpenCoach: () => void }> = ({ view, onOpenCoach }) => {
  const { t, lang } = useLang();

  let chip: React.ReactNode = null;
  let body: React.ReactNode;

  if (view.kind === "loading") {
    body = <SkeletonLines lines={3} />;
  } else if (view.kind === "active") {
    const { plan } = view;
    const k = planCounted(plan);
    // Sin descuento por regresión (el foco no era candidato del Coach al
    // empezar), lo esperado ES el antes: la columna sobraría.
    const conEsperado = plan.regression > 0 && plan.expected_cost !== plan.before_cost;
    chip = <Chip tone="gold">{t("Plan {k} of {n}", { k, n: plan.target })}</Chip>;
    body = (
      <>
        <p className="pp-coach-title">{planTitle(plan, t)}</p>
        <dl className="pp-kpis" title={t("Win chance it costs you per game")}>
          <Kpi label={t("Before the plan")} value={pct(plan.before_cost, lang)} detail={t("per game")} />
          {conEsperado && (
            <Kpi label={t("Expected")} value={pct(plan.expected_cost, lang)} detail={t("if nothing changed")} />
          )}
          <Kpi
            label={t("In the plan")}
            value={k > 0 && plan.after_cost != null ? pct(plan.after_cost, lang) : "—"}
            detail={`${k} ${t(k === 1 ? "game" : "games")}`}
          />
        </dl>
      </>
    );
  } else if (view.kind === "closed") {
    const { plan, result } = view;
    const v = VERDICT[result.verdict];
    const conEsperado = plan.regression > 0 && result.expected !== result.before;
    chip = <Chip tone={v.tone}>{t(v.label)}</Chip>;
    body = (
      <>
        <p className="pp-coach-title">{planTitle(plan, t)}</p>
        <dl className="pp-kpis" title={t("Win chance it costs you per game")}>
          <Kpi label={t("Before the plan")} value={pct(result.before, lang)} detail={t("per game")} />
          {conEsperado && (
            <Kpi label={t("Expected")} value={pct(result.expected, lang)} detail={t("if nothing changed")} />
          )}
          <Kpi
            label={t("Your {n} games", { n: result.n_after })}
            value={pct(result.after, lang)}
            detail={t("per game")}
            tone={result.verdict === "improved" ? "good" : result.verdict === "worse" ? "bad" : undefined}
          />
        </dl>
        <p className="pp-prose">{verdictText(result, t, lang)}</p>
      </>
    );
  } else if (view.kind === "focus") {
    const { row, state } = view;
    const propia = isOwnBaseline(row);
    chip = <Chip tone="outline">{sampleLabel(confidenceOf(row.games), row.games, t)}</Chip>;
    body = (
      <>
        <p className="pp-coach-title" title={categoryHelp(row.category, t)}>
          {focusTitle(row, t)}
        </p>
        <dl className="pp-kpis" title={t("Win chance it costs you per game")}>
          <Kpi label={t("You")} value={pct(row.user, lang)} detail={t("per game")} />
          {row.base != null && (
            <Kpi
              label={propia ? t("Your usual rate") : t("Your rank")}
              value={pct(row.base, lang)}
              detail={t("per game")}
            />
          )}
        </dl>
        <p className="pp-prose">
          {state?.state === "few_games"
            ? planErrorText("few_games", t, state.min_before)
            : t("A {n}-game plan in the Coach measures the before and after.", { n: state?.target ?? 10 })}
        </p>
      </>
    );
  } else {
    const s = view.summary;
    body = (
      <p className="pp-prose">
        {view.reason === "failed"
          ? t("Couldn't work out your focus this time. It retries on the next visit.")
          : view.reason === "few" && s
            ? t("The focus needs {n} games synced with Riot; you have {k}. Until then nothing is solid enough to point at.", {
                n: s.min_games,
                k: s.games,
              })
            : t("Nothing costs you more than its baseline yet, in any stretch with {n} games or more.", {
                n: s?.min_games ?? 10,
              })}
      </p>
    );
  }

  return (
    <section
      className="card pp-card pp-coach"
      aria-labelledby="pp-coach-label"
      aria-busy={view.kind === "loading" || undefined}
    >
      <div className="pp-cardhead">
        <h2 id="pp-coach-label" className="pp-label">
          {t("Your focus · from the Coach")}
        </h2>
        {chip}
      </div>
      {body}
      {view.kind !== "loading" && (
        <div>
          {/* La ruta /coach la monta la pantalla Coach (fase 4.1). Mientras no
              exista, App cae en Hoy, que también enseña el foco: el enlace no
              lleva a ninguna parte rota. */}
          <Button
            variant="ghost"
            size="sm"
            className="pp-coach-open"
            icon={<GraduationCap size={16} aria-hidden="true" />}
            onClick={onOpenCoach}
          >
            {t("Open the Coach")}
          </Button>
        </div>
      )}
    </section>
  );
};
