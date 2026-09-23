import type { PressureWindow, PressureEvidence } from "../../../core/tauri-ipc";
import { useT } from "../../../core/LanguageProvider";
import { clock } from "../../../core/time";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { formatGold, formatSeconds } from "./pressureFormat";
import "./PressureEpisodeCard.css";

/**
 * Un episodio de presión absorbida («hedge»): vinieron a por ti, ¿cuánto
 * tiempo les hiciste perder y cuánto oro valió?
 *
 * El número de arriba es el neto en oro y todo lo de debajo es su desglose:
 * cada línea suma o resta, y cada evento se puede ver en el vídeo. Así la
 * cifra se puede comprobar, que es lo que faltaba — la versión anterior solo
 * enseñaba cautelas ("asociación no es causalidad…") y ningún total.
 *
 * El cálculo vive en `src-tauri/src/pressure_value.rs`.
 */
const VERDICTS = {
  good: "Good trade",
  even: "Even trade",
  bad: "Costly trade",
} as const;

const KINDS: Record<PressureEvidence["kind"], string> = {
  kill: "Kill",
  death: "Your death",
  tower: "Tower",
  inhibitor: "Inhibitor",
  plate: "Plate",
  epic: "Epic monster",
};

export function PressureEpisodeCard({ window: w, gameStart, gameEnd, onSeek, label }: {
  window: PressureWindow;
  gameStart: number;
  gameEnd: number;
  onSeek?: (time: number) => void;
  label?: string;
}) {
  const t = useT();
  const v = w.value;
  const verdict = v?.verdict ?? "even";
  const dur = Math.max(0, Math.round(gameEnd - gameStart));
  const ties = w.ties ?? [];

  const evidence = (events: PressureEvidence[], sign: 1 | -1, tone: string) =>
    events.map((e) => {
      // Una kill "perdida" en el sitio es la muerte de un aliado.
      const kind = sign < 0 && e.kind === "kill" ? t("Ally death") : t(KINDS[e.kind] ?? e.kind);
      return (
        <li key={`${sign}:${e.id}`}>
          <button type="button" className="pe-ev" onClick={() => onSeek?.(e.time)} disabled={!onSeek}>
            <span className="u-time">{clock(e.game_time)}</span>
            <span className="pe-ev__what">
              {kind}
              {e.after_episode && <span className="pe-ev__after"> · {t("right after")}</span>}
            </span>
            <span className={`pe-ev__gold ${tone}`}>{formatGold(sign * e.gold, true)}</span>
          </button>
        </li>
      );
    });

  const localGains = (w.gains ?? []).filter((e) => e.local);
  const farGains = (w.gains ?? []).filter((e) => !e.local);
  const losses = w.losses ?? [];
  const context = w.context ?? [];

  return (
    <article className={`pe pe--${verdict}`}>
      <header className="pe__head">
        <div className="pe__when">
          {label && <span className="pe__label">{label}</span>}
          <span className="u-time">{clock(gameStart)}</span>
          <span> · {t("{n} s", { n: dur })}</span>
          {w.lane && <span> · {t(w.lane === "top" ? "Top lane" : w.lane === "mid" ? "Mid lane" : "Bot lane")}</span>}
        </div>
        {v ? (
          <div className="pe__net">
            <strong>{formatGold(v.net, true)}</strong>
            {/* "de oro" en español, "gold" en inglés: sale de la misma clave que la cifra. */}
            <span>{t("{n} gold", { n: "" }).trim()}</span>
          </div>
        ) : null}
      </header>

      <div className="pe__verdict-row">
        <span className={`pe__verdict pe__verdict--${verdict}`}>{t(VERDICTS[verdict])}</span>
        {onSeek && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => onSeek(w.start)}>
            {t("Watch episode")}
          </button>
        )}
      </div>

      {ties.length > 0 && (
        <div className="pe__ties">
          <div className="pe__faces" aria-hidden="true">
            {ties.slice(0, 5).map((tie) => (
              <ChampionAvatar key={`${tie.participant_id}:${tie.champion}`} champion={tie.champion} size={24} ring="var(--panel)" />
            ))}
          </div>
          <p>
            {t("You tied up {n} enemies · {time} of enemy time", {
              n: ties.length,
              // El total es la suma de lo que se enseña al lado, ya redondeado:
              // con el valor exacto salía "2 s + 2 s = 3 s".
              time: formatSeconds(ties.reduce((a, b) => a + Math.round(b.seconds), 0)),
            })}
            <span className="pe__tie-list">
              {ties.map((tie) => `${tie.champion} ${formatSeconds(tie.seconds)}`).join(" · ")}
            </span>
          </p>
        </div>
      )}

      {v ? (
        <dl className="pe__rows">
          <div>
            <dt>{t("Farm you denied them")}</dt>
            <dd className="pos">{formatGold(v.farm_denied, true)}</dd>
          </div>
          <div>
            <dt>{t("Your team, elsewhere")}</dt>
            <dd className={v.team_elsewhere > 0 ? "pos" : ""}>{formatGold(v.team_elsewhere, true)}</dd>
          </div>
          <div>
            <dt>{t("The fight where you were")}</dt>
            <dd className={v.local_gold > 0 ? "pos" : v.local_gold < 0 ? "neg" : ""}>{formatGold(v.local_gold, true)}</dd>
          </div>
          <div>
            <dt>{t("Your own farm meanwhile")}</dt>
            <dd className="neg">{formatGold(-v.own_farm_lost, true)}</dd>
          </div>
          {v.death_farm_lost > 0 && (
            <div>
              <dt>{t("Farm lost while dead")}</dt>
              <dd className="neg">{formatGold(-v.death_farm_lost, true)}</dd>
            </div>
          )}
          <div className="pe__total">
            <dt>{t("Net")}</dt>
            <dd>{formatGold(v.net, true)}</dd>
          </div>
        </dl>
      ) : (
        <p className="pe__note">{t("Recalculating this episode…")}</p>
      )}

      {v && v.enemy_elsewhere > 0 && (
        <p className="pe__note">
          {t("Meanwhile the enemy took {gold} elsewhere. It doesn't count against you: with the numbers on your side, that belongs to whoever was there.", {
            gold: formatGold(v.enemy_elsewhere),
          })}
        </p>
      )}

      {(farGains.length + localGains.length + losses.length + context.length) > 0 && (
        <details className="pe__details">
          <summary>{t("Every event, with its time")}</summary>
          {farGains.length > 0 && <><h4>{t("Your team, elsewhere")}</h4><ul>{evidence(farGains, 1, "pos")}</ul></>}
          {(localGains.length + losses.length) > 0 && (
            <>
              <h4>{t("The fight where you were")}</h4>
              <ul>{evidence(localGains, 1, "pos")}{evidence(losses, -1, "neg")}</ul>
            </>
          )}
          {context.length > 0 && <><h4>{t("Enemy, elsewhere (not counted)")}</h4><ul>{evidence(context, 1, "")}</ul></>}
        </details>
      )}

      <p className="pe__source">
        {t(w.from_video
          ? "Measured on the minimap video, second by second."
          : "Estimated from Riot's data (one position per minute). Process the video to measure it.")}
        {" "}
        {t("A floor, not a ceiling: enemy travel time and XP aren't counted.")}
      </p>
    </article>
  );
}
