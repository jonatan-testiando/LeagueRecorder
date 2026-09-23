import React from "react";
import type { PressureEpisode, PressureSummary } from "../../../core/tauri-ipc";
import { useT } from "../../../core/LanguageProvider";
import { clock } from "../../../core/time";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { formatGold, formatSeconds } from "../../player/components/pressureFormat";
import "./PressureBreakdown.css";

/**
 * La presión absorbida entre partidas, en oro y con su desglose.
 *
 * Responde a "no me fío de las cifras": cada línea es un sumando del neto, y
 * los mejores y peores episodios se abren en el vídeo en su instante. El
 * cálculo es el de `src-tauri/src/pressure_value.rs`.
 *
 * La frase de abajo señala la palanca: el sumando que más resta.
 */
export const PressureBreakdown: React.FC<{
  summary: PressureSummary;
  onOpen: (matchId: string, seconds?: number) => void;
}> = ({ summary: s, onOpen }) => {
  const t = useT();
  const games = Math.max(1, s.games);
  const perGame = (n: number) => formatGold(n / games, true);
  // El tiempo muerto no viaja agregado: es lo que falta para cuadrar el neto.
  const deadFarm = s.net_gold - (s.farm_denied + s.team_elsewhere + s.local_gold - s.own_farm_lost);
  const rows: { label: string; value: number }[] = [
    { label: t("Farm you denied them"), value: s.farm_denied },
    { label: t("Your team, elsewhere"), value: s.team_elsewhere },
    { label: t("The fight where you were"), value: s.local_gold },
    { label: t("Your own farm meanwhile"), value: -s.own_farm_lost },
    { label: t("Farm lost while dead"), value: Math.min(0, deadFarm) },
  ];
  const peak = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  const worstRow = rows.reduce((a, b) => (b.value < a.value ? b : a));

  const valued = s.episodes.filter((e) => e.window.value);
  const byNet = [...valued].sort((a, b) => (b.window.value!.net - a.window.value!.net));
  const best = byNet.slice(0, 3).filter((e) => e.window.value!.net > 0);
  const worst = byNet.slice(-3).reverse().filter((e) => e.window.value!.net < 0);

  const total = Math.max(1, s.good + s.even + s.bad);

  const episodeRow = (e: PressureEpisode) => (
    <li key={e.match_id + ":" + e.game_start}>
      <button type="button" className="pb-ep" onClick={() => onOpen(e.match_id, e.window.start)}>
        <ChampionAvatar champion={e.window.champion} size={24} />
        <span className="pb-ep__what">
          {e.window.champion}
          <span className="pb-ep__meta">
            {" · "}<span className="u-time">{clock(e.game_start)}</span>
            {" · "}{t("{n} enemies", { n: e.window.ties?.length || e.window.enemy_count })}
            {e.window.died ? ` · ${t("you died")}` : ""}
          </span>
        </span>
        <span className={`pb-ep__net ${e.window.value!.net >= 0 ? "pos" : "neg"}`}>
          {formatGold(e.window.value!.net, true)}
        </span>
      </button>
    </li>
  );

  return (
    <div className="card pp-card pb">
      <div className="pp-cardhead">
        <h3 className="pp-cardtitle">{t("Pressure you absorbed")}</h3>
        <span className="pp-meta">{t("{games} games · all time", { games: s.games })}</span>
      </div>

      <div className="pb-head">
        <div>
          <span className={`pb-net ${s.net_gold >= 0 ? "pos" : "neg"}`}>{perGame(s.net_gold)}</span>
          <span className="pp-meta"> {t("gold per game")}</span>
        </div>
        <p className="pp-prose">
          {t("They came for you {n} times. You tied up {time} of enemy time, {pg} per game.", {
            n: s.windows,
            time: formatSeconds(s.enemy_seconds),
            pg: formatSeconds(s.enemy_seconds / games),
          })}
        </p>
      </div>

      <div className="pb-verdicts" role="img" aria-label={t("{good} good · {even} even · {bad} costly, in {games} games", { good: s.good, even: s.even, bad: s.bad, games: s.games })}>
        <span className="pb-v pb-v--good" style={{ flexGrow: s.good / total }} />
        <span className="pb-v pb-v--even" style={{ flexGrow: s.even / total }} />
        <span className="pb-v pb-v--bad" style={{ flexGrow: s.bad / total }} />
      </div>
      <p className="pb-legend">
        <span className="pos">{t("{n} good", { n: s.good })}</span>
        {" · "}{t("{n} even", { n: s.even })}
        {" · "}<span className="neg">{t("{n} costly", { n: s.bad })}</span>
      </p>

      <dl className="pb-rows">
        {rows.map((r) => (
          <div key={r.label} className="pb-row">
            <dt>{r.label}</dt>
            <dd>
              <span className="pb-bar" aria-hidden="true">
                <span className={r.value >= 0 ? "pos" : "neg"} style={{ width: `${(Math.abs(r.value) / peak) * 100}%` }} />
              </span>
              <span className={`pb-val ${r.value > 0 ? "pos" : r.value < 0 ? "neg" : ""}`}>{perGame(r.value)}</span>
            </dd>
          </div>
        ))}
        <div className="pb-row pb-row--total">
          <dt>{t("Net per game")}</dt>
          <dd><span className={`pb-val ${s.net_gold >= 0 ? "pos" : "neg"}`}>{perGame(s.net_gold)}</span></dd>
        </div>
      </dl>

      {worstRow.value < 0 && (
        <p className="pb-lever">
          {worstRow.label === t("The fight where you were")
            ? t("What costs you most is the fight where you are: you die in {d} of {n} episodes. Surviving (or letting go earlier) turns your pressure into profit.", { d: s.deaths, n: s.windows })
            : t("What costs you most: {what}.", { what: worstRow.label.toLowerCase() })}
        </p>
      )}

      {(best.length > 0 || worst.length > 0) && (
        <div className="pb-eps">
          {best.length > 0 && (
            <div>
              <h4>{t("Your best episodes")}</h4>
              <ul>{best.map(episodeRow)}</ul>
            </div>
          )}
          {worst.length > 0 && (
            <div>
              <h4>{t("The ones that cost you most")}</h4>
              <ul>{worst.map(episodeRow)}</ul>
            </div>
          )}
        </div>
      )}

      <p className="pp-note">
        {t("Per episode: the farm they lose chasing you, what your team takes elsewhere and the fight where you are, minus your own farm. A floor: enemy travel time and XP aren't counted.")}
      </p>
    </div>
  );
};
