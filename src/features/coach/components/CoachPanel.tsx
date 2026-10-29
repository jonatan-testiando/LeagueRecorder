import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Brain, Flag, Info, Library, Play, TrendingDown, TrendingUp, TriangleAlert, Zap } from "lucide-react";
import { useLang } from "../../../core/LanguageProvider";
import { useCoachSummary } from "../../../core/useCoachSummary";
import { useCoachPlan } from "../../../core/useCoachPlan";
import { useDelayedLoading } from "../../../core/useDelayedLoading";
import { useAppStore } from "../../../store/useAppStore";
import { useDialog } from "../../../components/ui/DialogProvider";
import { Button } from "../../../components/ui/Button";
import { Chip, type ChipTone } from "../../../components/ui/Chip";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Skeleton } from "../../../components/ui/Skeleton";
import { bandLabel, withPercent } from "../../../core/benchmarkFormat";
import { confidenceOf, sampleLabel } from "../../../core/patterns";
import {
  categoryHelp,
  categoryName,
  coachPlaylist,
  focusTitle,
  focusWhy,
  isOwnBaseline,
  liftText,
  planCounted,
  planErrorText,
  planTitle,
  tramoShort,
  wpPoints,
} from "../../../core/coach";
import type {
  CoachCategory,
  CoachPlan,
  CoachPlanState,
  CoachRow,
  CoachSummary,
  CoachVerdict,
} from "../../../core/tauri-ipc";
import { ScreenTitle } from "../../../components/ScreenTitle";
import "./CoachPanel.css";

/**
 * Coach: el plan de 10 partidas y de dónde sale (§2.4-2.5 de
 * `docs/coach-de-macro-diseno.md`; Figma, página Coach).
 *
 * De arriba abajo:
 *  1. El plan. En curso: el foco, las diez casillas (una por partida que mide
 *     el foco, con las jugadas que cargó), la línea de la última partida y la
 *     única acción oro, ver tus peores jugadas. Cerrado: antes, lo esperado sin
 *     cambiar nada y tus diez, con el intervalo y un veredicto que no dice más
 *     de lo que diez partidas permiten. Sin plan: el foco que se propone.
 *  2. Dónde se te va la partida: las categorías por coste, con la raya de su
 *     baremo y de dónde sale (el corpus o tu propia media).
 *  3. Tu nota por tramo (percentil frente a tu rol y franja) y los planes
 *     anteriores.
 *
 * Nada de esto avisa durante la partida (memoria «sin-overlays-en-partida»):
 * el plan se mira aquí y en Hoy.
 */

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/* ------------------------------------------------------------ cifras */

/** Puntos de victoria con signo: "+5,1", "−0,4". Cero sin signo. */
function signedPoints(x: number, lang: string): string {
  const s = wpPoints(x, lang);
  if (Math.abs(x) * 100 < 0.05) return s;
  return `${x > 0 ? "+" : "−"}${s}`;
}

/** Lo que te cuesta una categoría: «−9,4 %», y «0 %» si no llega a una décima (no «−0,0 %»). */
function lossText(x: number, lang: string): string {
  return Math.abs(x) * 100 < 0.05 ? withPercent(0) : `−${withPercent(wpPoints(x, lang))}`;
}

/**
 * Frente al baremo, en palabras: «5,6 peor», «5,5 mejor». Con signo («+5,6» en
 * rojo junto a un «−9,4 %») el «+» se leía como algo bueno.
 */
function excessText(x: number, t: (k: string, v?: Record<string, string | number>) => string, lang: string): string {
  if (Math.abs(x) * 100 < 0.05) return t("≈ baseline");
  return t(x > 0 ? "{p} worse" : "{p} better", { p: wpPoints(x, lang) });
}

/** "17 oct" / "Oct 17". */
function shortDate(iso: string | null | undefined, lang: string): string {
  if (!iso) return "";
  const d = new Date(iso.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return iso.split(" ")[0];
  return new Intl.DateTimeFormat(lang === "es" ? "es-ES" : "en-US", { day: "numeric", month: "short" }).format(d);
}

/* ------------------------------------------------------------ textos */

const VERDICT: Record<CoachVerdict, { label: string; tone: ChipTone }> = {
  improved: { label: "Improved", tone: "win" },
  same: { label: "Same", tone: "neutral" },
  worse: { label: "Got worse", tone: "loss" },
  short_sample: { label: "Short sample", tone: "outline" },
};

/** El ejercicio de Training de las categorías de mapa (§2.4.3). Las demás no
 *  tienen uno que las entrene. */
const EXERCISE: Partial<Record<CoachCategory, { section: "drills" | "awareness"; label: string }>> = {
  sin_mirar_mapa: { section: "drills", label: "Exercise: camera control" },
  desde_niebla: { section: "awareness", label: "Exercise: map reading" },
  jungla: { section: "awareness", label: "Exercise: map reading" },
};

/** Las categorías que sólo ve el vídeo: su baremo es tu propia media. */
const OWN_BASELINE = new Set<CoachCategory>(["sin_mirar_mapa", "desde_niebla"]);

/** De dónde sale el baremo de una fila, para la línea de debajo del nombre. */
function baselineText(row: CoachRow, summary: CoachSummary, t: Translate): string {
  if (row.base == null) return t("no baseline yet");
  if (isOwnBaseline(row)) return t("baseline: your own average (Riot's data can't see it)");
  const band = bandLabel(summary.band);
  if (band && summary.band_uniform) return t("baseline: your role in {band}", { band: t(band) });
  return t("baseline: your role in the rank of each game");
}

/** La fila del coach de un foco (categoría × tramo), si el resumen la trae. */
const rowOf = (summary: CoachSummary | null | undefined, category: CoachCategory, tramo: number | null) =>
  summary?.rows.find((r) => r.category === category && r.tramo === tramo) ?? null;

/* ============================================================ panel */

export const CoachPanel: React.FC = () => {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const summary = useCoachSummary();
  const { plan, busy, error, start, abandon } = useCoachPlan();
  const startPlaylist = useAppStore((s) => s.startPlaylist);
  const refreshMatches = useAppStore((s) => s.refreshMatches);
  const { showConfirm } = useDialog();
  const [howOpen, setHowOpen] = useState(false);

  const loading = plan === undefined || summary === undefined;
  const skeleton = useDelayedLoading(loading);

  // El foco que se resalta en las categorías y en los tramos: el del plan en
  // curso, o el que se propone, o el del coach.
  const focus = useMemo((): { category: CoachCategory; tramo: number | null } | null => {
    if (plan?.active) return { category: plan.active.category, tramo: plan.active.tramo };
    const r = plan?.proposal?.row ?? summary?.focus ?? null;
    return r ? { category: r.category, tramo: r.tramo } : null;
  }, [plan, summary]);

  const watch = (row: CoachRow | null, title: string) => {
    if (!row) return;
    const items = coachPlaylist(row, t, lang);
    if (items.length === 0) return;
    startPlaylist(title, items);
    navigate("/review");
  };
  const train = (category: CoachCategory) => {
    const ex = EXERCISE[category];
    // La sección va en la URL; Training la lee cuando lo sepa hacer (fase 3g).
    navigate(ex ? `/training?section=${ex.section}` : "/training");
  };
  const askAbandon = async (p: CoachPlan) => {
    const ok = await showConfirm({
      title: t("Abandon the plan?"),
      message: t("The {k} games you've played stay in your history as an abandoned plan. You can start another whenever you like.", {
        k: planCounted(p),
      }),
      confirmText: t("Abandon"),
      destructive: true,
    });
    if (ok) await abandon();
  };

  // ------------------------------------------------------------ cabecera
  const sub = (() => {
    if (!summary || plan?.state === "few_games") return plan ? t("{n} games", { n: plan.games }) : "";
    const band = bandLabel(summary.band);
    const base =
      band && summary.band_uniform
        ? t("baseline: your role in {band}", { band: t(band) })
        : t("baseline: your role in the rank of each game");
    return `${t("{n} games", { n: summary.games })} · ${base}`;
  })();

  const head = (
    <>
      {/* Título, censo y «Cómo se calcula» en la barra de título (piel A);
          la explicación se abre en la página, encima de todo. */}
      <ScreenTitle align="content" title={t("Coach")} sub={sub || undefined}>
        {/* En icono: con el texto, en la barra no cabía el censo a 1280. */}
        <Button
          variant="icon"
          size="sm"
          icon={<Info size={15} />}
          aria-label={t("How it's calculated")}
          title={t("How it's calculated")}
          aria-expanded={howOpen}
          aria-controls="coach-how"
          onClick={() => setHowOpen((o) => !o)}
        />
      </ScreenTitle>
      {howOpen && (
        <section id="coach-how" className="coach-card coach-how" aria-label={t("How it's calculated")}>
          <p className="t-small">
            {t(
              "Every play that lowers your team's win chance with you involved goes into a category. Its cost is the win chance lost, per game."
            )}
          </p>
          <p className="t-small">
            {t(
              "The line on each bar is its baseline: players of your role and rank in a corpus of games, or your own average for what only the video sees (map looks, fog)."
            )}
          </p>
          <p className="t-small">
            {t(
              "A plan lasts {n} games. At the end they're compared with what was expected without changing anything (a focus picked for being your worst comes down on its own), and it only says you improved if the 90% interval rules out chance.",
              { n: plan?.target ?? 10 }
            )}
          </p>
        </section>
      )}
    </>
  );

  // ------------------------------------------------------------ estados
  let body: React.ReactNode;
  if (loading) {
    body = skeleton ? <CoachSkeleton /> : null;
  } else if (plan === null && summary === null) {
    body = (
      <section className="coach-card coach-state">
        <EmptyState
          icon={<TriangleAlert />}
          title={t("Couldn't load the Coach")}
          text={t("Your games are fine: the Coach couldn't read its data this time.")}
          action={
            <Button variant="ghost" onClick={() => refreshMatches().catch(() => {})}>
              {t("Retry")}
            </Button>
          }
        />
      </section>
    );
  } else if (plan?.state === "few_games" || (!plan && summary && summary.games < summary.min_games)) {
    const need = plan?.min_before ?? summary?.min_games ?? 10;
    const have = plan?.games ?? summary?.games ?? 0;
    body = <FewGames need={need} have={have} onPatterns={() => navigate("/patterns")} />;
  } else {
    // El último plan, si se cerró con su resultado: va arriba y no se repite en
    // los anteriores.
    const last = plan && !plan.active && plan.state === "closed" ? plan.history[0] ?? null : null;
    const shownInHero = last?.result ? last : null;
    body = (
      <>
        {plan?.active ? (
          <ActivePlan
            plan={plan.active}
            row={rowOf(summary, plan.active.category, plan.active.tramo)}
            busy={busy}
            error={error}
            minBefore={plan.min_before}
            onWatch={watch}
            onTrain={train}
            onAbandon={() => askAbandon(plan.active as CoachPlan)}
          />
        ) : shownInHero ? (
          <ClosedPlan
            plan={shownInHero}
            state={plan as CoachPlanState}
            summary={summary ?? null}
            busy={busy}
            error={error}
            onStart={start}
            onWatch={watch}
          />
        ) : (
          <Proposal
            state={plan ?? null}
            summary={summary ?? null}
            busy={busy}
            error={error}
            onStart={start}
            onWatch={watch}
            onTrain={train}
          />
        )}

        <div className="coach-detail">
          <Categories
            summary={summary ?? null}
            focus={focus?.category ?? null}
            // Tras un cierre, lo marcado es lo que se propone, aún no tu foco.
            focusLabel={shownInHero ? t("Next focus") : t("Your focus")}
          />
          <div className="coach-col">
            <Tramos summary={summary ?? null} focusTramo={focus?.tramo ?? null} />
            <History plans={(plan?.history ?? []).filter((p) => p !== shownInHero)} loadFailed={plan === null} />
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="coach-panel">
      <div className="coach-page">
        {head}
        {body}
      </div>
    </div>
  );
};

/* ============================================================ el plan */

interface WatchProps {
  onWatch: (row: CoachRow | null, title: string) => void;
}

/** «Ver tus 5 peores jugadas»: la lista de reproducción de la fila del foco. */
const WatchButton: React.FC<{ row: CoachRow | null; title: string; primary: boolean } & WatchProps> = ({
  row,
  title,
  primary,
  onWatch,
}) => {
  const { t, lang } = useLang();
  const n = row ? coachPlaylist(row, t, lang).length : 0;
  return (
    <Button
      variant={primary ? "primary" : "ghost"}
      className="coach-actions__btn"
      icon={<Play size={16} />}
      disabled={n === 0}
      title={n === 0 ? t("None of these plays kept its video.") : undefined}
      onClick={() => onWatch(row, title)}
    >
      {n === 0
        ? t("Watch your worst plays")
        : n === 1
          ? t("Watch your worst play")
          : t("Watch your {n} worst plays", { n })}
    </Button>
  );
};

const ExerciseButton: React.FC<{ category: CoachCategory; onTrain: (c: CoachCategory) => void }> = ({ category, onTrain }) => {
  const t = useLang().t;
  const ex = EXERCISE[category];
  if (!ex) return null;
  return (
    <Button
      variant="ghost"
      className="coach-actions__btn"
      icon={ex.section === "drills" ? <Zap size={16} /> : <Brain size={16} />}
      onClick={() => onTrain(category)}
    >
      {t(ex.label)}
    </Button>
  );
};

const PlanError: React.FC<{ error: string | null; minBefore: number }> = ({ error, minBefore }) => {
  const t = useLang().t;
  if (!error) return null;
  return (
    <p className="t-small coach-error" role="alert">
      {planErrorText(error, t, minBefore)}
    </p>
  );
};

/** El plan en curso: el foco, las diez casillas y la última partida. */
const ActivePlan: React.FC<
  {
    plan: CoachPlan;
    row: CoachRow | null;
    busy: boolean;
    error: string | null;
    minBefore: number;
    onTrain: (c: CoachCategory) => void;
    onAbandon: () => void;
  } & WatchProps
> = ({ plan, row, busy, error, minBefore, onWatch, onTrain, onAbandon }) => {
  const { t, lang } = useLang();
  const title = planTitle(plan, t);
  const counted = plan.games.filter((g) => g.cost != null);
  const skipped = plan.games.length - counted.length;
  const last = counted[counted.length - 1] ?? null;
  const own = row ? isOwnBaseline(row) : OWN_BASELINE.has(plan.category);

  // Lo que costaba antes, frente a su baremo, y lo que se espera sin cambiar
  // nada: el número con el que se va a comparar al cerrar.
  const before = { before: wpPoints(plan.before_cost, lang), base: wpPoints(plan.before_base ?? 0, lang) };
  const why =
    plan.before_base == null
      ? t("Before the plan they cost you {before}% win chance per game.", before)
      : own
        ? t("Before the plan they cost you {before}% win chance per game; at your usual rate, {base}%.", before)
        : t("Before the plan they cost you {before}% win chance per game; in your rank, {base}%.", before);
  const expected =
    plan.regression > 0 && plan.expected_cost < plan.before_cost
      ? t("Without changing anything, {p}% is expected: a focus picked for being your worst comes down on its own.", {
          p: wpPoints(plan.expected_cost, lang),
        })
      : null;

  // La línea de la última partida que midió el foco.
  const lastLine = (() => {
    // Las que entraron no midieron el foco: se dice, para que no parezca que
    // la partida no llegó.
    if (!last) return skipped === 0 ? null : skipped === 1 ? t("1 didn't measure the focus") : t("{n} didn't measure the focus", { n: skipped });
    const parts = [
      last.plays === 0
        ? t("Last game: clean")
        : last.plays === 1
          ? t("Last game: 1 play, −{p}%", { p: wpPoints(last.cost ?? 0, lang) })
          : t("Last game: {n} plays, −{p}%", { n: last.plays, p: wpPoints(last.cost ?? 0, lang) }),
    ];
    if (plan.after_cost != null) parts.push(t("plan average −{p}%", { p: wpPoints(plan.after_cost, lang) }));
    parts.push(t("expected −{p}%", { p: wpPoints(plan.expected_cost, lang) }));
    if (skipped > 0) parts.push(skipped === 1 ? t("1 didn't measure the focus") : t("{n} didn't measure the focus", { n: skipped }));
    return parts.join(" · ");
  })();
  const LastIcon = plan.after_cost != null && plan.after_cost > plan.expected_cost ? TrendingUp : TrendingDown;

  return (
    <section className="surface-hero coach-hero" aria-labelledby="coach-plan-title">
      <div className="coach-hero__main">
        <div className="coach-hero__labels">
          <span className="t-label coach-faint">
            {t("{n}-game plan · since {date}", { n: plan.target, date: shortDate(plan.started_at, lang) })}
          </span>
          <Chip tone="gold">{t("In progress")}</Chip>
        </div>
        <h2 id="coach-plan-title" className="t-section coach-title" title={categoryHelp(plan.category, t)}>
          {title}
        </h2>
        <p className="t-body coach-why">
          {why}
          {expected && ` ${expected}`}
        </p>

        <div className="coach-boxes">
          <ol className="coach-boxes__row" aria-label={t("Plays of your focus in each game of the plan")}>
            {Array.from({ length: plan.target }, (_, i) => {
              const g = counted[i];
              if (!g) {
                return (
                  <li key={i} className="coach-box coach-box--empty" aria-label={t("Game {i}: still to play", { i: i + 1 })}>
                    {i + 1}
                  </li>
                );
              }
              // Limpia (sin jugadas del foco), peor que tu antes, o entre medias.
              const tono = g.plays === 0 ? "clean" : (g.cost ?? 0) > plan.before_cost ? "worse" : "even";
              const desc = t("{champion} · {date} · plays: {n} · −{p}% win chance", {
                champion: g.champion,
                date: shortDate(g.date, lang),
                n: g.plays,
                p: wpPoints(g.cost ?? 0, lang),
              });
              return (
                <li key={g.match_id} className={`coach-box coach-box--${tono}`} title={desc} aria-label={desc}>
                  {g.plays}
                </li>
              );
            })}
          </ol>
          <div className="coach-boxes__legend">
            <span className="t-small coach-strong">
              {t("{k} of {n} games", { k: planCounted(plan), n: plan.target })}
            </span>
            <span className="t-small coach-faint">{t("focus plays")}</span>
          </div>
        </div>

        {lastLine ? (
          <p
            className="t-small coach-last"
            title={skipped > 0 ? t("A game that ended before the stretch, or without the video the category needs, doesn't measure the focus.") : undefined}
          >
            <LastIcon size={16} aria-hidden="true" />
            {lastLine}
          </p>
        ) : (
          <p className="t-small coach-last">
            {t("No games yet. Each game synced with Riot comes in by itself.")}
          </p>
        )}
      </div>

      <div className="coach-actions">
        <WatchButton row={row} title={title} primary onWatch={onWatch} />
        <ExerciseButton category={plan.category} onTrain={onTrain} />
        <p className="t-small coach-faint coach-actions__note">
          {t("No reminders during the game: the plan lives here and in Today.")}
        </p>
        <Button variant="danger" size="sm" className="coach-actions__abandon" loading={busy} onClick={onAbandon}>
          {t("Abandon the plan")}
        </Button>
        <PlanError error={error} minBefore={minBefore} />
      </div>
    </section>
  );
};

/** Sin plan en curso: el foco que se propone, para empezarlo. */
const Proposal: React.FC<
  {
    state: CoachPlanState | null;
    summary: CoachSummary | null;
    busy: boolean;
    error: string | null;
    onStart: (category?: CoachCategory, tramo?: number) => Promise<void>;
    onTrain: (c: CoachCategory) => void;
  } & WatchProps
> = ({ state, summary, busy, error, onStart, onWatch, onTrain }) => {
  const { t, lang } = useLang();
  const proposal = state?.proposal ?? null;
  const row = proposal?.row ?? summary?.focus ?? null;

  if (!row || row.tramo == null) {
    // Hay partidas de sobra, pero nada pierde por encima de su baremo.
    return (
      <section className="surface-hero coach-hero coach-hero--quiet">
        <div className="coach-hero__main">
          <span className="t-label coach-faint">{t("Your focus")}</span>
          <p className="t-body coach-why">
            {state === null
              ? t("Couldn't read your plans. It retries on the next game.")
              : t("Nothing costs you more than its baseline yet, in any stretch with {n} games or more.", {
                  n: summary?.min_games ?? state.min_before,
                })}
          </p>
        </div>
      </section>
    );
  }

  const title = focusTitle(row, t);
  const lift = liftText(row, t, lang);
  const last = state?.history[0] ?? null;
  const label =
    state?.state === "abandoned" && last
      ? t("Your focus · you abandoned the last plan on {date}", { date: shortDate(last.ended_at, lang) })
      : t("Your focus");
  const target = state?.target ?? 10;

  return (
    <section className="surface-hero coach-hero" aria-labelledby="coach-plan-title">
      <div className="coach-hero__main">
        <div className="coach-hero__labels">
          <span className="t-label coach-faint">{label}</span>
          <Chip tone="gold">{sampleLabel(confidenceOf(row.games), row.games, t)}</Chip>
        </div>
        <h2 id="coach-plan-title" className="t-section coach-title" title={categoryHelp(row.category, t)}>
          {title}
        </h2>
        <p className="t-body coach-why">
          {summary ? focusWhy(row, summary, t, lang) : null}
          {lift && ` ${lift}`}
        </p>
        <p className="t-small coach-muted">
          {proposal
            ? t("A plan: play {n} games with this in mind. At the end, your last {k} games before it ({p}% per game) are compared with the {n} of the plan, with their margin of error.", {
                n: target,
                k: proposal.before_games,
                p: wpPoints(proposal.before_cost, lang),
              })
            : t("A plan: play {n} games with this in mind. At the end they're compared with your games before it, with their margin of error.", {
                n: target,
              })}
        </p>
      </div>

      <div className="coach-actions">
        {state && (
          <Button
            variant="primary"
            className="coach-actions__btn"
            icon={<Flag size={16} />}
            loading={busy}
            onClick={() => onStart(row.category, row.tramo ?? undefined)}
          >
            {proposal?.repeat ? t("Try this plan again") : t("Start a {n}-game plan", { n: target })}
          </Button>
        )}
        <WatchButton row={row} title={title} primary={!state} onWatch={onWatch} />
        <ExerciseButton category={row.category} onTrain={onTrain} />
        <PlanError error={error} minBefore={state?.min_before ?? 10} />
      </div>
    </section>
  );
};

/** El último plan, cerrado: antes, lo esperado y tus diez, con su intervalo. */
const ClosedPlan: React.FC<
  {
    plan: CoachPlan;
    state: CoachPlanState;
    summary: CoachSummary | null;
    busy: boolean;
    error: string | null;
    onStart: (category?: CoachCategory, tramo?: number) => Promise<void>;
  } & WatchProps
> = ({ plan, state, summary, busy, error, onStart, onWatch }) => {
  const { t, lang } = useLang();
  const r = plan.result!;
  const v = VERDICT[r.verdict];
  const next = state.proposal;
  const p = (x: number) => wpPoints(x, lang);

  // Lo que dice el veredicto, con las cifras del intervalo. «Muestra corta» es
  // lo normal tras diez partidas y se cuenta como lo que es: no se sabe.
  const range = r.low != null && r.high != null ? { a: signedPoints(r.low, lang), b: signedPoints(r.high, lang) } : null;
  const reading = (() => {
    switch (r.verdict) {
      case "improved":
        return t("Improved: even at the edge of the interval, your ten games cost you less than expected without changing anything.");
      case "worse":
        return t("Worse: even at the edge of the interval, your ten games cost you more than expected.");
      case "same":
        return t("Same: if there was a change it was small; the interval fits within ±{p} points per game.", { p: p(r.relevant) });
      default:
        return range
          ? t("With ten games it can't be told apart: the change is between {a} and {b} points per game. It doesn't say you didn't improve; it says ten games aren't enough to know.", range)
          : t("With so few games that measure the focus, it can't be told apart. It doesn't say you didn't improve; it says there isn't enough to know.");
    }
  })();

  // El intervalo sobre un eje que contiene el cero y el margen de «igual».
  // Con un cuarto de aire a cada lado: la banda no llega nunca a los bordes y
  // se ve dónde acaba.
  const lo0 = Math.min(r.low ?? 0, -r.relevant, 0);
  const hi0 = Math.max(r.high ?? 0, r.relevant, 0);
  const lo = lo0 - (hi0 - lo0) * 0.25;
  const hi = hi0 + (hi0 - lo0) * 0.25;
  const span = Math.max(1e-9, hi - lo);
  const at = (x: number) => `${(((x - lo) / span) * 100).toFixed(2)}%`;
  const touchesZero = r.low != null && r.high != null && r.low <= 0 && r.high >= 0;

  const nextRow = next?.row ?? null;
  const afterTone = r.verdict === "improved" ? "coach-num--win" : r.verdict === "worse" ? "coach-num--loss" : "";

  return (
    <section className="surface-hero coach-hero" aria-labelledby="coach-plan-title">
      <div className="coach-hero__main">
        <div className="coach-hero__labels">
          <span className="t-label coach-faint">
            {t("Plan finished · {k} of {n} games · {from} – {to}", {
              k: r.n_after,
              n: plan.target,
              from: shortDate(plan.started_at, lang),
              to: shortDate(plan.ended_at, lang),
            })}
          </span>
          <Chip tone={v.tone}>{t(v.label)}</Chip>
        </div>
        <h2 id="coach-plan-title" className="t-section coach-title" title={categoryHelp(plan.category, t)}>
          {planTitle(plan, t)}
        </h2>

        <div className="coach-result">
          {/* La frase del cierre en tres cifras: «antes 3,0 · sin cambiar nada
              se esperaba 2,0 · tus diez 1,9». La del medio es la que manda:
              el foco se eligió por ser lo peor y baja solo. */}
          <dl className="coach-nums">
            <div className="coach-num">
              <dt className="t-label coach-faint">{t("Before")}</dt>
              <dd className="t-hero coach-num__v">
                {p(r.before)}
                <span className="coach-num__unit">%</span>
              </dd>
              <dd className="t-small coach-faint">{t("per game · {n} earlier", { n: r.n_before })}</dd>
            </div>
            <div className="coach-num">
              <dt className="t-label coach-faint">{t("Expected without changing anything")}</dt>
              <dd className="t-hero coach-num__v coach-num--expected">
                {p(r.expected)}
                <span className="coach-num__unit">%</span>
              </dd>
              <dd className="t-small coach-faint">{t("it comes down on its own")}</dd>
            </div>
            <div className="coach-num">
              <dt className="t-label coach-faint">{t("Your ten")}</dt>
              <dd className={`t-hero coach-num__v ${afterTone}`.trim()}>
                {p(r.after)}
                <span className="coach-num__unit">%</span>
              </dd>
              <dd className="t-small coach-faint">{t("per game · {n} of the plan", { n: r.n_after })}</dd>
            </div>
          </dl>

          {range && (
            <div className="coach-ci">
              <span className="t-label coach-faint">
                {t("Change against what was expected ({p}% interval)", { p: Math.round(r.level * 100) })}
              </span>
              <div className="coach-ci__axis" aria-hidden="true">
                <i className="coach-ci__line" />
                <i className="coach-ci__margin" style={{ left: at(-r.relevant), right: `calc(100% - ${at(r.relevant)})` }} />
                <i
                  className={`coach-ci__band coach-ci__band--${r.verdict}`}
                  style={{ left: at(r.low as number), right: `calc(100% - ${at(r.high as number)})` }}
                />
                <i className="coach-ci__zero" style={{ left: at(0) }} />
              </div>
              <span className="t-small coach-muted">
                {t("{a} to {b} per game", range)} · {touchesZero ? t("touches zero") : t("doesn't touch zero")}
              </span>
            </div>
          )}
        </div>

        <p className="t-small coach-muted coach-reading">{reading}</p>
      </div>

      <div className="coach-actions coach-next">
        {nextRow && nextRow.tramo != null ? (
          <>
            <span className="t-label coach-faint">{next?.repeat ? t("Same focus, another try") : t("Next proposed focus")}</span>
            <span className="t-body coach-strong">{focusTitle(nextRow, t)}</span>
            <span className="t-small coach-muted">
              {t("−{p}% per game in your last {n} games", { p: p(next!.before_cost), n: next!.before_games })}
            </span>
            <Button
              variant="primary"
              className="coach-actions__btn"
              icon={<Flag size={16} />}
              loading={busy}
              onClick={() => onStart(nextRow.category, nextRow.tramo ?? undefined)}
            >
              {next?.repeat ? t("Try this plan again") : t("Start the plan")}
            </Button>
            <WatchButton row={nextRow} title={focusTitle(nextRow, t)} primary={false} onWatch={onWatch} />
          </>
        ) : (
          <p className="t-small coach-muted">
            {t("Nothing costs you more than its baseline yet, in any stretch with {n} games or more.", {
              n: summary?.min_games ?? state.min_before,
            })}
          </p>
        )}
        <PlanError error={error} minBefore={state.min_before} />
      </div>
    </section>
  );
};

/* ============================================================ detalle */

/** Las categorías por coste, con la raya del baremo. */
const Categories: React.FC<{ summary: CoachSummary | null; focus: CoachCategory | null; focusLabel: string }> = ({
  summary,
  focus,
  focusLabel,
}) => {
  const { t, lang } = useLang();
  const rows = useMemo(
    () => (summary ? summary.rows.filter((r) => r.tramo == null).sort((a, b) => b.user - a.user) : []),
    [summary]
  );
  const max = Math.max(1e-9, ...rows.map((r) => Math.max(r.user, r.base ?? 0)));

  return (
    <section className="coach-card coach-cats" aria-labelledby="coach-cats-title">
      <header className="coach-card__head">
        <h2 id="coach-cats-title" className="t-card coach-strong">
          {t("Where the game slips away")}
        </h2>
        <span className="t-label coach-faint">{t("win chance lost per game · line = baseline")}</span>
      </header>
      {!summary ? (
        <p className="t-small coach-muted">{t("Couldn't work this out this time. It retries on the next game.")}</p>
      ) : rows.length === 0 ? (
        <p className="t-small coach-muted">{t("No category has cost you anything yet.")}</p>
      ) : (
        <ul className="coach-cats__list">
          {rows.map((r) => {
            const over = (r.excess ?? 0) > 0;
            return (
              <li key={r.category} className="coach-cat">
                <div className="coach-cat__name">
                  <span className="coach-cat__line">
                    <span className="t-body coach-strong" title={categoryHelp(r.category, t)}>
                      {categoryName(r.category, t)}
                    </span>
                    {r.category === focus && <Chip tone="gold">{focusLabel}</Chip>}
                  </span>
                  <span className="t-small coach-faint">{baselineText(r, summary, t)}</span>
                </div>
                <div
                  className="coach-cat__bar"
                  role="img"
                  aria-label={t("{n} games · you {user}% · baseline {base}%", {
                    n: r.games,
                    user: wpPoints(r.user, lang),
                    base: r.base != null ? wpPoints(r.base, lang) : "—",
                  })}
                >
                  <i
                    className={`coach-cat__fill${over ? " coach-cat__fill--over" : ""}`}
                    style={{ "--p": r.user / max } as React.CSSProperties}
                  />
                  {r.base != null && <i className="coach-cat__base" style={{ left: `${(r.base / max) * 100}%` }} />}
                </div>
                <span className={`t-body coach-cat__user${over ? " coach-loss" : ""}`}>{lossText(r.user, lang)}</span>
                <span
                  className={`t-small coach-cat__excess ${r.excess == null || Math.abs(r.excess) * 100 < 0.05 ? "coach-faint" : over ? "coach-loss" : "coach-win"}`}
                  title={r.excess != null ? t("Against the baseline, in points of win chance per game") : undefined}
                >
                  {r.excess != null ? excessText(r.excess, t, lang) : "—"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

/** Percentil = la convención de RankBenchmarkCard: verde arriba, rojo abajo. */
const pctTone = (p: number | null) => (p == null ? "coach-faint" : p >= 70 ? "coach-win" : p < 30 ? "coach-loss" : "coach-muted");

/**
 * Tu nota por tramo: tu impacto en victoria frente a tu rol y franja.
 *
 * Las barras salen de la mediana (percentil 50) hacia arriba o hacia abajo.
 * Medidas desde cero, unos percentiles de 44 a 59 daban barras de 28 a 38 px
 * que se leían planas. El tramo del foco se marca en la etiqueta y no tiñendo
 * la barra: el foco es la categoría que más te cuesta DENTRO de ese tramo, y
 * una barra dorada en tu mejor tramo se leía como «aquí vas bien».
 */
const Tramos: React.FC<{ summary: CoachSummary | null; focusTramo: number | null }> = ({ summary, focusTramo }) => {
  const t = useLang().t;
  const tramos = summary?.tramos ?? [];
  return (
    <section className="coach-card coach-tramos" aria-labelledby="coach-tramos-title">
      <header className="coach-card__head">
        <span id="coach-tramos-title" className="t-label coach-faint">
          {t("Your grade by stretch")}
        </span>
        <span className="t-label coach-faint">{t("percentile in your rank · line = median")}</span>
      </header>
      {tramos.length === 0 ? (
        <p className="t-small coach-muted">{t("Couldn't work this out this time. It retries on the next game.")}</p>
      ) : (
        <div className="coach-tramos__bars">
          {tramos.map((tr) => {
            const pct = tr.percentile == null ? null : Math.round(tr.percentile);
            const hot = tr.tramo === focusTramo;
            // ±25 puntos (un cuartil) llenan la columna: a ±50, los tramos
            // reales (44-59) daban bultos de 4-7 px que no se veían.
            const d = pct == null ? 0 : Math.max(-1, Math.min(1, (pct - 50) / 25));
            return (
              <div
                key={tr.tramo}
                className={`coach-tramo${hot ? " coach-tramo--hot" : ""}`}
                title={hot ? t("{n} games · your focus is in this stretch", { n: tr.games }) : t("{n} games", { n: tr.games })}
              >
                <span className={`t-small coach-tramo__pct ${pctTone(pct)}`}>{pct ?? "—"}</span>
                <span className="coach-tramo__plot">
                  <i
                    className={`coach-tramo__bar ${d >= 0 ? "coach-tramo__bar--up" : "coach-tramo__bar--down"}`}
                    style={{ "--d": Math.abs(d) } as React.CSSProperties}
                  />
                </span>
                <span className={`t-label coach-tramo__label ${hot ? "coach-brand" : "coach-faint"}`}>{tramoShort(tr.tramo)}</span>
              </div>
            );
          })}
        </div>
      )}
      {focusTramo != null && tramos.some((tr) => tr.tramo === focusTramo) && (
        <p className="t-small coach-faint coach-tramos__note">{t("Underlined: the stretch of your focus.")}</p>
      )}
    </section>
  );
};

/** Los planes acabados, el último primero. */
const History: React.FC<{ plans: CoachPlan[]; loadFailed: boolean }> = ({ plans, loadFailed }) => {
  const { t, lang } = useLang();
  const shown = plans.slice(0, 6);
  return (
    <section className="coach-card coach-hist" aria-labelledby="coach-hist-title">
      <span id="coach-hist-title" className="t-label coach-faint">
        {t("Earlier plans")}
      </span>
      {loadFailed ? (
        <p className="t-small coach-muted">{t("Couldn't read your plans. It retries on the next game.")}</p>
      ) : shown.length === 0 ? (
        <p className="t-small coach-muted">{t("None yet. When you finish one, its before and after stay here.")}</p>
      ) : (
        <ul className="coach-hist__list">
          {shown.map((p) => {
            const r = p.result;
            const chip =
              p.status === "abandoned" || !r ? { label: "Abandoned", tone: "outline" as ChipTone } : VERDICT[r.verdict];
            const line =
              p.status === "abandoned" || !r
                ? t("abandoned after {k} of {n} games", { k: planCounted(p), n: p.target })
                : t("from {a}% to {b}% per game", { a: wpPoints(r.before, lang), b: wpPoints(r.after, lang) });
            return (
              <li
                key={p.id}
                className="coach-hist__row"
                title={`${shortDate(p.started_at, lang)} – ${shortDate(p.ended_at, lang)}`}
              >
                <div className="coach-hist__text">
                  <span className="t-small coach-strong">
                    {categoryName(p.category, t)} · {tramoShort(p.tramo)}
                  </span>
                  <span className="t-small coach-faint">{line}</span>
                </div>
                <Chip tone={chip.tone}>{t(chip.label)}</Chip>
              </li>
            );
          })}
        </ul>
      )}
      {plans.length > shown.length && (
        <span className="t-small coach-faint">{t("and {n} more", { n: plans.length - shown.length })}</span>
      )}
    </section>
  );
};

/* ============================================================ estados */

/** Menos partidas de las que pide un foco: cualquier cosa sería ruido. */
const FewGames: React.FC<{ need: number; have: number; onPatterns: () => void }> = ({ need, have, onPatterns }) => {
  const t = useLang().t;
  return (
    <section className="coach-card coach-state">
      <EmptyState
        icon={<Library />}
        title={t("The Coach needs {n} analysed games", { n: need })}
        text={t("You have {k}. With fewer, any focus would be noise. Meanwhile, Patterns shows what can already be seen, marked as a lead.", {
          k: have,
        })}
        action={
          <Button variant="ghost" onClick={onPatterns}>
            {t("Go to Patterns")}
          </Button>
        }
      />
      <div className="coach-few">
        <div
          className="coach-few__track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={need}
          aria-valuenow={Math.min(have, need)}
          aria-label={t("{k} of {n} games", { k: have, n: need })}
        >
          <i className="coach-few__fill" style={{ "--p": Math.min(1, have / need) } as React.CSSProperties} />
        </div>
        <span className="t-small coach-faint">
          {t("{k} of {n} · up to 14 games the focus comes marked as a lead", { k: have, n: need })}
        </span>
      </div>
    </section>
  );
};

/** La forma de la pantalla mientras llega la primera carga. */
const CoachSkeleton: React.FC = () => {
  const t = useLang().t;
  return (
    <div className="coach-skel" role="status" aria-busy="true" aria-label={t("Loading…")}>
      <Skeleton shape="block" height={232} />
      <div className="coach-detail">
        <Skeleton shape="block" height={420} />
        <div className="coach-col">
          <Skeleton shape="block" height={160} />
          <Skeleton shape="block" height={200} />
        </div>
      </div>
    </div>
  );
};
