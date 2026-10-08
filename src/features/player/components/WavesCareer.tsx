import React, { useEffect, useState } from "react";
import { useT } from "../../../core/LanguageProvider";
import { getWavesCareer, type WavesReport } from "../../../core/tauri-ipc";
import { wstyles } from "./videoPlayerStyles";
import "./DeathsSection.css";
import "./WavesSection.css";

/**
 * Las tres reglas de macro de `oleadas.rs` sobre tus últimas partidas: cuántas
 * veces las cumpliste y qué pasó cuando sí y cuando no. La comparación es lo
 * que dice si la regla te importa a ti, no sólo a las guías.
 */

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((100 * n) / d)}%` : "—");

export const WavesCareer: React.FC = () => {
  const t = useT();
  const [r, setR] = useState<WavesReport | null | undefined>(undefined);

  useEffect(() => {
    let vivo = true;
    getWavesCareer()
      .then((x) => vivo && setR(x))
      .catch(() => vivo && setR(null));
    return () => { vivo = false; };
  }, []);

  if (r === undefined) return <div className="ds-loading"><div className="spinner" /></div>;
  if (!r || r.status !== "ok" || r.matches === 0) {
    return (
      <p className="note" style={{ margin: 0 }}>
        {t("No game has its waves read yet. Open a game's Waves and macro section, or measure them with the video (above).")}
      </p>
    );
  }

  const inv = r.invades.filter((i) => i.verdict !== "early" && i.verdict !== "unknown");
  const invPrio = inv.filter((i) => i.verdict === "prio");
  const invSin = inv.filter((i) => i.verdict !== "prio");
  const gk = r.ganks.filter((g) => g.setup !== "unknown");
  const gkBien = gk.filter((g) => g.setup === "good");
  const gkDive = gk.filter((g) => g.setup === "dive");
  const ok = (v: { outcome: string }[]) => v.filter((g) => g.outcome === "success").length;
  const ob = r.objectives.filter((o) => o.verdict !== "unknown");
  const obPrio = ob.filter((o) => o.verdict === "prio");
  const obSin = ob.filter((o) => o.verdict === "none");

  const filas: [string, string, string][] = [];
  if (inv.length > 0) {
    filas.push([t("Invades with priority"), pct(invPrio.length, inv.length), t("{n} invades", { n: inv.length })]);
    filas.push([
      t("You died invading"),
      `${pct(invPrio.filter((i) => i.died).length, invPrio.length)} / ${pct(invSin.filter((i) => i.died).length, invSin.length)}`,
      t("with priority / without"),
    ]);
  }
  if (gk.length > 0) {
    filas.push([t("Ganks with the wave on your side"), pct(gkBien.length, gk.length), t("{n} ganks", { n: gk.length })]);
    filas.push([
      t("Ganks that worked"),
      `${pct(ok(gkBien), gkBien.length)} / ${pct(ok(gkDive), gkDive.length)}`,
      t("wave on your side / under their tower"),
    ]);
  }
  if (ob.length > 0) {
    filas.push([t("Objectives with priority"), pct(obPrio.length, ob.length), t("{n} objectives", { n: ob.length })]);
    filas.push([
      t("Taken by your team"),
      `${pct(obPrio.filter((o) => o.ours).length, obPrio.length)} / ${pct(obSin.filter((o) => o.ours).length, obSin.length)}`,
      t("with priority / without"),
    ]);
  }

  return (
    <div style={wstyles.body}>
      <p className="ds-summary">{t("Over your last {n} games with the waves read.", { n: r.matches })}</p>
      <div className="ws-career">
        {filas.map(([k, v, s]) => (
          <div key={k} className="ws-stat">
            <span className="u-label">{k}</span>
            <strong>{v} <small>{s}</small></strong>
          </div>
        ))}
      </div>
      <p className="note" style={{ margin: 0 }}>
        {t("Priority: the clash of the nearby lanes (side lane and mid) past the middle, towards their base. Waves are read from the minimap every ~4 s.")}
      </p>
    </div>
  );
};
