import React, { useEffect, useState } from "react";
import { useT } from "../../../core/LanguageProvider";
import { getHitsTakenCareer, type HitsReport } from "../../../core/tauri-ipc";
import { effectLabel } from "./HitsTaken";
import { wstyles } from "./videoPlayerStyles";
import "./DeathsSection.css";
import "./HitsTaken.css";

/**
 * "Golpes que te comes" sobre tus últimas partidas con el HUD leído: la cifra
 * que contesta "¿qué tan bien esquivo?" con lo que sí se puede medir (ver
 * `golpes.rs`). La lista golpe a golpe vive en la pestaña Partida.
 */

const pct = (n: number, d: number) => (d > 0 ? Math.round((100 * n) / d) : 0);

export const HitsCareer: React.FC = () => {
  const t = useT();
  const [r, setR] = useState<HitsReport | null | undefined>(undefined);

  useEffect(() => {
    let vivo = true;
    getHitsTakenCareer()
      .then((x) => vivo && setR(x))
      .catch(() => vivo && setR(null));
    return () => { vivo = false; };
  }, []);

  if (r === undefined) return <div className="ds-loading"><div className="spinner" /></div>;
  if (!r || r.status !== "ok" || r.matches === 0) {
    return (
      <p className="note" style={{ margin: 0 }}>
        {t("No game has its hits read yet. Measure them with the video (above) or from a game's Hits you take section.")}
      </p>
    );
  }

  const porPartida = r.openers / r.matches;
  const filas: [string, string, string][] = [
    [t("Fights started on you"), porPartida.toFixed(1), t("per game")],
    [t("In a straight line"), `${pct(r.straight, r.straight_known)}%`, t("of the first hits")],
    [t("From the fog"), `${pct(r.from_fog, r.openers)}%`, t("no enemy visible in the 4 s before")],
    [t("Ended in your death"), `${pct(r.died, r.openers)}%`, t("of those fights")],
  ];
  if (r.matches_with_keys > 0 && r.reaction_p50 != null) {
    filas.push([t("Reaction"), t("{s} s", { s: r.reaction_p50.toFixed(2) }), t("{n} of {m} with a key", { n: r.reaction_n, m: r.reaction_known })]);
  }

  return (
    <div style={wstyles.body}>
      <p className="ds-summary">
        {t("Over your last {n} games with the video read.", { n: r.matches })}
      </p>
      <div className="ht-career">
        {filas.map(([k, v, s]) => (
          <div key={k} className="ht-stat">
            <span className="u-label">{k}</span>
            <strong>{v} <small>{s}</small></strong>
          </div>
        ))}
      </div>
      {r.effects.length > 0 && (
        <div className="ht-stat">
          <span className="u-label">{t("What opened them most")}</span>
          <span className="ht-effects">
            {r.effects.map((c) => (
              <span key={c.effect.icon} className="ht-effect">
                {c.icon_url && <img src={c.icon_url} alt="" />}
                {effectLabel(c.effect, t)} ×{c.times}
              </span>
            ))}
          </span>
        </div>
      )}
      {r.matches_with_keys === 0 && (
        <p className="note" style={{ margin: 0 }}>
          {t("Your reaction time appears once you play games with this version: it now saves when you press Q W E R D F.")}
        </p>
      )}
    </div>
  );
};
