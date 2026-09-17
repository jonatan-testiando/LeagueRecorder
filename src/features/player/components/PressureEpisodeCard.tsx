import type { PressureWindow, PressureEvidence } from "../../../core/tauri-ipc";
import { useT } from "../../../core/LanguageProvider";
import { clock } from "../../../core/time";
import "./PressureEpisodeCard.css";

const ASSESSMENTS = {
  no_gain: "No observed gain",
  cost_without_gain: "Cost without observed gain",
  gain_without_observed_cost: "Gain without observed cost",
  mixed: "Mixed exchange",
};
const KINDS = { kill: "Kill", death: "Your death", tower: "Tower", inhibitor: "Inhibitor", plate: "Plate", epic: "Epic monster" };

export function PressureEpisodeCard({ window: w, gameStart, gameEnd, onSeek, label }: {
  window: PressureWindow;
  gameStart: number;
  gameEnd: number;
  onSeek?: (time: number) => void;
  label?: string;
}) {
  const t = useT();
  const evidence = (events: PressureEvidence[]) => events.length ? <ul>{events.map(e => <li key={e.id}>
    <span>{clock(e.game_time)} · {t(KINDS[e.kind])}{e.gold > 0 ? ` · ${Math.round(e.gold)} ${t("gold")}` : ""}
      {e.after_episode && <small> · {t("After episode")}</small>}</span>
    {onSeek && <button type="button" onClick={() => onSeek(e.time)}>{t("View event")}</button>}
  </li>)}</ul> : <p>{t("None observed")}</p>;
  return <article className="pressure-episode">
    <div className="pressure-episode__head"><strong>{label ? `${label} · ` : ""}{clock(gameStart)}–{clock(gameEnd)}</strong>
      {onSeek ? <button type="button" onClick={() => onSeek(w.start)}>{t("Watch episode")}</button> : <span>{t("Video unavailable")}</span>}
    </div>
    <p>{t("Estimated nearby enemies")}: {w.enemy_count} · {Math.max(0, Math.round(gameEnd - gameStart))} s · {t(w.died ? "Death recorded" : "No death recorded")}</p>
    <p className="pressure-episode__source">{t(w.from_video ? "Timing refined with video; enemy count estimated from API" : "API estimate; duration may be incomplete")}</p>
    <strong className="pressure-episode__assessment">{t(ASSESSMENTS[w.assessment] ?? "No observed gain")}</strong>
    <details><summary>{t("Evidence and exchange")}</summary>
      <h4>{t("Team gains elsewhere")}</h4>{evidence(w.gains ?? [])}
      <h4>{t("Concurrent team losses")}</h4>{evidence(w.losses ?? [])}
      {w.died && <p>{t("Gold awarded for your death: {n}", { n: Math.round(w.death_gold ?? 0) })}</p>}
      <p className="pressure-episode__source">{t("Includes events up to 20 seconds after pressure. Association is not causation. Missed farm, XP and future opportunities are not estimated; no overall net score is assigned.")}</p>
    </details>
  </article>;
}
