import React from "react";
import { Play } from "lucide-react";
import type { MatchMetadata } from "../../../types";
import type { GameState, LaneState } from "../../../core/tauri-ipc";
import type { CourseRates, ScoreCalibration, StateRow } from "../../../core/gameStates";
import { confidenceOf, sampleLabel } from "../../../core/patterns";
import { formatDecimal, withPercent } from "../../../core/benchmarkFormat";
import { mmss } from "../../../core/time";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { Chip } from "../../../components/ui/Chip";
import { useT } from "../../../core/LanguageProvider";

/**
 * Las dos fichas de Patrones que salen de `estado_partida.rs`:
 *
 *  - «Por delante, igualada o por detrás» (3.3): cuánto ganas según cómo
 *    salgas de líneas, frente a lo que ganaría el corpus con tus mismos roles,
 *    y tus tiradas y remontadas con la curva de probabilidad de victoria.
 *  - «Tu nota frente al resultado» (3.4): tu winrate por tramo de nota de
 *    impacto, frente a la línea del corpus.
 *
 * Las dos dicen la muestra una vez, en su chip, y su cautela en la última
 * línea: con veinte partidas, un resultado mueve una fila diez puntos.
 */

export const STATE_LABEL: Record<LaneState, string> = { ahead: "Ahead", even: "Even", behind: "Behind" };

const pct = (num: number, den: number): number => Math.round((num / Math.max(1, den)) * 100);

/** Un carril con tu winrate relleno y una raya donde está el corpus. */
const WinBar: React.FC<{ value: number | null; corpus: number | null }> = ({ value, corpus }) => (
  <span className="pp-gs-track" aria-hidden="true">
    {value != null && <span className="pp-gs-fill" style={{ width: `${Math.round(value * 100)}%` }} />}
    {corpus != null && <span className="pp-gs-tick" style={{ left: `${Math.round(corpus * 100)}%` }} />}
  </span>
);

/** El chip de muestra, sólo mientras sea corta (como en el reloj de muertes). */
const SampleChip: React.FC<{ games: number }> = ({ games }) => {
  const t = useT();
  const conf = confidenceOf(games);
  if (conf === "good") return null;
  return (
    <Chip
      tone={conf === "low" ? "finding" : "neutral"}
      title={t(
        conf === "low"
          ? "Under 15 games this points at a tendency, not a conclusion. It sharpens as you record more."
          : "Enough games to steer by, though small gaps between windows are still noise."
      )}
    >
      {sampleLabel(conf, games, t)}
    </Chip>
  );
};

interface StateSplitProps {
  rows: StateRow[];
  rates: CourseRates;
  /** El estado elegido en la cabecera, para marcar su fila. */
  selected: LaneState | "all";
  /** Los cortes de oro, si todas las partidas son de un mismo rol. */
  cuts: [number, number] | null;
  matchesById: Map<string, MatchMetadata>;
  /** Abrir una partida en un segundo de vídeo. */
  onOpen: (matchId: string, videoSeconds?: number) => void;
}

/** La ficha de 3.3: la tabla por estado y las tiradas y remontadas. */
export const StateSplitCard: React.FC<StateSplitProps> = ({ rows, rates, selected, cuts, matchesById, onOpen }) => {
  const t = useT();
  const total = rows.reduce((a, r) => a + r.games, 0);
  const oro = (n: number) => `${n > 0 ? "+" : "−"}${Math.abs(Math.round(n))}`;
  const rango: Record<LaneState, string> = cuts
    ? {
        ahead: t("over {gold} gold", { gold: oro(cuts[1]) }),
        even: t("{a} to {b} gold", { a: oro(cuts[0]), b: oro(cuts[1]) }),
        behind: t("under {gold} gold", { gold: oro(cuts[0]) }),
      }
    : {
        ahead: t("top third of your role"),
        even: t("middle third"),
        behind: t("bottom third"),
      };

  /** Una tirada o una remontada, con el momento en que estuvo más arriba o más abajo. */
  const fila = (g: GameState, cual: "peak" | "low") => {
    const m = matchesById.get(g.match_id);
    const c = g.course!;
    const [p, seg] = cual === "peak" ? [c.max, c.max_time] : [c.min, c.min_time];
    const video = m?.video_path ? Math.max(0, seg + (m.video_offset ?? 0) - 5) : undefined;
    return (
      <button
        key={g.match_id}
        type="button"
        className="pp-gs-game"
        onClick={() => onOpen(g.match_id, video)}
        title={video != null ? t("Open this game at that moment") : t("Open this game")}
      >
        {m && <ChampionAvatar champion={m.champion} size={22} />}
        <span className="pp-gs-game-name">{m?.champion ?? g.match_id}</span>
        <span className="pp-meta pp-num">{m?.date.slice(5, 10)}</span>
        <span className="pp-num pp-gs-game-at">
          {t("{p}% at {time}", { p: Math.round(p * 100), time: mmss(seg) })}
        </span>
        {video != null && <Play size={12} fill="currentColor" aria-hidden="true" className="pp-gs-game-play" />}
      </button>
    );
  };

  return (
    <div className="card pp-card">
      <div className="pp-cardhead">
        <h3 className="pp-cardtitle">{t("Ahead, even or behind at 14:00")}</h3>
        <SampleChip games={total} />
      </div>
      <div className="pp-gs-table" role="table" aria-label={t("Win rate by lane state at 14:00")}>
        <div className="pp-gs-row pp-gs-row--head" role="row">
          <span className="pp-cap" role="columnheader">{t("Gold vs your lane opponent")}</span>
          <span className="pp-cap pp-right" role="columnheader">{t("Games")}</span>
          <span className="pp-cap" role="columnheader">{t("Win rate · line = corpus")}</span>
          <span className="pp-cap pp-right" role="columnheader">{t("You")}</span>
          <span className="pp-cap pp-right" role="columnheader">{t("Corpus")}</span>
          <span className="pp-cap pp-right" role="columnheader">{t("Deaths / game")}</span>
        </div>
        {rows.map((r) => {
          const wr = r.games > 0 ? r.wins / r.games : null;
          return (
            <div key={r.state} className="pp-gs-row" role="row" data-selected={selected === r.state || undefined}>
              <span className="pp-gs-label" role="cell">
                <span className="pp-gs-state">{t(STATE_LABEL[r.state])}</span>
                <span className="pp-meta pp-num">{rango[r.state]}</span>
              </span>
              <span className={`pp-num pp-right ${r.games < 5 ? "pp-prose--faint" : "pp-soft"}`} role="cell">{r.games}</span>
              <span role="cell"><WinBar value={wr} corpus={r.corpusWin} /></span>
              <span className={`pp-num pp-right pp-gs-you ${r.games > 0 && r.games < 5 ? "pp-gs-few" : ""}`.trim()} role="cell">
                {wr != null ? withPercent(Math.round(wr * 100)) : "—"}
              </span>
              <span className="pp-num pp-right pp-soft" role="cell">
                {r.corpusWin != null ? withPercent(Math.round(r.corpusWin * 100)) : "—"}
              </span>
              <span className="pp-num pp-right pp-soft" role="cell">
                {r.deathsPerGame != null ? formatDecimal(r.deathsPerGame) : "—"}
              </span>
            </div>
          );
        })}
      </div>

      <h4 className="pp-route-sub">{t("Throws and comebacks")}</h4>
      {rates.measured === 0 ? (
        <p className="pp-prose pp-prose--faint">{t("They appear once your games have their win-chance curve (synced with Riot, 15 minutes or more).")}</p>
      ) : (
        <div className="pp-two">
          {(
            [
              {
                key: "thrown",
                label: t("Throws"),
                num: rates.thrown.length,
                den: rates.withLead,
                text: t("Of the {n} games you had at 65% or more, you lost {k}.", { n: rates.withLead, k: rates.thrown.length }),
                games: rates.thrown,
                at: "peak" as const,
              },
              {
                key: "comebacks",
                label: t("Comebacks"),
                num: rates.comebacks.length,
                den: rates.behind,
                text: t("Of the {n} games you were down to 35% or less, you won {k}.", { n: rates.behind, k: rates.comebacks.length }),
                games: rates.comebacks,
                at: "low" as const,
              },
            ]
          ).map((x) => (
            <div key={x.key} className="pp-gs-rate">
              <span className="pp-cap">{x.label}</span>
              <span className="pp-gs-rate-line">
                <span className="pp-gs-rate-big pp-num">{x.den > 0 ? withPercent(pct(x.num, x.den)) : "—"}</span>
                {rates.corpusFlip != null && (
                  <span className="pp-meta pp-num">{t("corpus {p}%", { p: Math.round(rates.corpusFlip * 100) })}</span>
                )}
              </span>
              <p className="pp-prose pp-num">{x.text}</p>
              {x.games.length > 0 && <div className="pp-gs-games">{x.games.map((g) => fila(g, x.at))}</div>}
            </div>
          ))}
        </div>
      )}
      <p className="pp-note">
        {t("Ahead or behind: your gold against your lane opponent at 14:00, split in thirds by the corpus for your role. The win chance is the model's, minute by minute and after every play.")}
      </p>
    </div>
  );
};

/** La ficha de 3.4: tu winrate por tramo de nota frente al corpus. */
export const ScoreCalibrationCard: React.FC<{ cal: ScoreCalibration }> = ({ cal }) => {
  const t = useT();
  const tramos = [...cal.bins].reverse();
  return (
    <div className="card pp-card">
      <div className="pp-cardhead">
        <h3 className="pp-cardtitle">
          {cal.mvpGames > 0
            ? t("When you're MVP you win {p}%", { p: pct(cal.mvpWins, cal.mvpGames) })
            : t("Your score vs. the result")}
        </h3>
        {/* La muestra del titular: las partidas en que saliste MVP, no todas. */}
        <SampleChip games={cal.mvpGames > 0 ? cal.mvpGames : cal.games} />
      </div>
      <p className="pp-prose pp-num">
        {cal.mvpGames > 0
          ? t("MVP in {n} of your {total} games. In the corpus the MVP wins {p}%.", {
              n: cal.mvpGames,
              total: cal.games,
              p: Math.round(cal.corpusMvp * 100),
            })
          : t("No MVP yet in these {n} games. In the corpus the MVP wins {p}%.", {
              n: cal.games,
              p: Math.round(cal.corpusMvp * 100),
            })}
      </p>
      <div className="pp-gs-table" role="table" aria-label={t("Win rate by impact score")}>
        <div className="pp-gs-row pp-gs-row--score pp-gs-row--head" role="row">
          <span className="pp-cap" role="columnheader">{t("Impact score")}</span>
          <span className="pp-cap pp-right" role="columnheader">{t("Games")}</span>
          <span className="pp-cap" role="columnheader">{t("Win rate · line = corpus")}</span>
          <span className="pp-cap pp-right" role="columnheader">{t("You")}</span>
          <span className="pp-cap pp-right" role="columnheader">{t("Corpus")}</span>
        </div>
        {tramos.map((b) => {
          const wr = b.games > 0 ? b.wins / b.games : null;
          return (
            <div key={b.from} className="pp-gs-row pp-gs-row--score" role="row">
              <span className="pp-gs-state pp-num" role="cell">{`${Math.round(b.from)}–${Math.round(b.to)}`}</span>
              <span className={`pp-num pp-right ${b.games < 5 ? "pp-prose--faint" : "pp-soft"}`} role="cell">{b.games}</span>
              <span role="cell"><WinBar value={wr} corpus={b.corpus} /></span>
              <span className={`pp-num pp-right pp-gs-you ${b.games > 0 && b.games < 5 ? "pp-gs-few" : ""}`.trim()} role="cell">
                {wr != null ? withPercent(Math.round(wr * 100)) : "—"}
              </span>
              <span className="pp-num pp-right pp-soft" role="cell">{withPercent(Math.round(b.corpus * 100))}</span>
            </div>
          );
        })}
      </div>
      <p className="pp-note">
        {t("Your impact score is your win-probability added, as a percentile of your role. If it measures something, higher scores win more. Rows under 5 games swing a lot on one result.")}
      </p>
    </div>
  );
};
