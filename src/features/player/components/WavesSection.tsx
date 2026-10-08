import React, { useEffect, useState } from "react";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { getWaves, type LanePush, type WavesReport } from "../../../core/tauri-ipc";
import { campLabel } from "../jungleRoute";
import { wstyles } from "./videoPlayerStyles";
import "./DeathsSection.css";
import "./WavesSection.css";

/**
 * Oleadas y macro (ver `oleadas.rs`): dónde estaba cada oleada toda la
 * partida, y con eso tres reglas concretas comprobadas — invadir con los
 * carriles cercanos empujados, ganquear con la oleada en tu lado, ir a los
 * objetivos con prioridad. Las oleadas se leen del minimapa en segundos.
 */

type T = ReturnType<typeof useT>;

/** Por encima, el choque está en su mitad (= `EMPUJADO` en oleadas.rs). */
const A_FAVOR = 0.5;

export const LANE_LABEL: Record<string, string> = { top: "Top", mid: "Mid", bot: "Bot" };

export const OBJECTIVE_LABEL: Record<string, string> = {
  DRAGON: "Dragon",
  BARON_NASHOR: "Baron Nashor",
  RIFTHERALD: "Rift Herald",
  HORDE: "Void Grubs",
  ATAKHAN: "Atakhan",
};

export function verdictTag(v: string, t: T): { text: string; tone: "good" | "bad" | "" } {
  switch (v) {
    case "prio": return { text: t("with priority"), tone: "good" };
    case "half": return { text: t("half priority"), tone: "" };
    case "none": return { text: t("without priority"), tone: "bad" };
    case "early": return { text: t("before the waves meet"), tone: "" };
    default: return { text: t("waves not seen"), tone: "" };
  }
}

export function setupTag(s: string, t: T): { text: string; tone: "good" | "bad" | "" } {
  switch (s) {
    case "good": return { text: t("wave on your side"), tone: "good" };
    case "dive": return { text: t("wave under their tower"), tone: "bad" };
    case "even": return { text: t("wave in the middle"), tone: "" };
    default: return { text: t("wave not seen"), tone: "" };
  }
}

const lanesText = (lanes: LanePush[], t: T) =>
  lanes
    .map((l) =>
      l.push == null
        ? t("{lane} not seen", { lane: LANE_LABEL[l.lane] })
        : l.push >= A_FAVOR
          ? t("{lane} pushed", { lane: LANE_LABEL[l.lane] })
          : t("{lane} on your side", { lane: LANE_LABEL[l.lane] }),
    )
    .join(" · ");

const Tag: React.FC<{ text: string; tone: string }> = ({ text, tone }) => (
  <span className={tone === "bad" ? "ds-tag ds-tag--bad" : tone === "good" ? "ds-tag ws-tag--good" : "ds-tag"}>{text}</span>
);

/** Tres franjas, una por carril: jade empujado a tu favor, rojo en tu lado. */
const LaneStrip: React.FC<{ series: WavesReport["series"]; duration: number; onSeek: (g: number) => void }> = ({ series, duration, onSeek }) => {
  const t = useT();
  if (series.length === 0 || duration <= 0) return null;
  const paso = Math.max(4, duration / 300);
  return (
    <div className="ws-strip">
      {["top", "mid", "bot"].map((lane, i) => (
        <div key={lane} className="ws-row">
          <span className="ws-lane">{LANE_LABEL[lane]}</span>
          <svg
            className="ws-svg"
            viewBox={`0 0 ${duration} 10`}
            preserveAspectRatio="none"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onSeek(((e.clientX - r.left) / r.width) * duration);
            }}
            role="img"
            aria-label={t("Where the {lane} wave was during the game", { lane: LANE_LABEL[lane] })}
          >
            {series.map((s, k) => {
              // Mediana con las lecturas vecinas (~4 s a cada lado): una sola
              // lectura salta de un lado a otro de la mitad y la franja parpadeaba.
              const vecinas = [series[k - 1], s, series[k + 1]]
                .map((x) => (x ? x[i + 1] : -1))
                .filter((x) => x >= 0)
                .sort((a, b) => a - b);
              if (s[i + 1] < 0 || vecinas.length === 0) return null;
              const v = vecinas[Math.floor(vecinas.length / 2)];
              const tono = v >= 0.55 ? "var(--cool)" : v <= 0.45 ? "var(--loss)" : "var(--faint)";
              return <rect key={k} x={s[0]} y={0} width={paso} height={10} fill={tono} opacity={0.35 + Math.min(0.6, Math.abs(v - 0.5) * 2)} />;
            })}
          </svg>
        </div>
      ))}
      <div className="ws-legend">
        <span><i style={{ background: "var(--cool)" }} />{t("pushed in your favour")}</span>
        <span><i style={{ background: "var(--faint)" }} />{t("middle")}</span>
        <span><i style={{ background: "var(--loss)" }} />{t("on your side")}</span>
        <span className="ws-soft">{t("blank: no wave seen")}</span>
      </div>
    </div>
  );
};

interface Props {
  matchId: string;
  videoOffset: number;
  onSeek: (videoSeconds: number) => void;
}

export const WavesSection: React.FC<Props> = ({ matchId, videoOffset, onSeek }) => {
  const t = useT();
  const [r, setR] = useState<WavesReport | null | undefined>(undefined);

  useEffect(() => {
    let vivo = true;
    setR(undefined);
    getWaves(matchId)
      .then((x) => vivo && setR(x))
      .catch(() => vivo && setR(null));
    return () => { vivo = false; };
  }, [matchId]);

  if (r === undefined) {
    return (
      <div className="ds-loading" role="status">
        <div className="spinner" />
        <span className="ws-soft">{t("Reading the waves from the minimap…")}</span>
      </div>
    );
  }
  if (!r || r.status !== "ok") {
    return <p className="note" style={{ margin: 0 }}>{t("The waves couldn't be read from this video.")}</p>;
  }

  const duracion = r.series.length ? r.series[r.series.length - 1][0] : 0;
  const invConDato = r.invades.filter((i) => i.verdict !== "early" && i.verdict !== "unknown");
  const gankConDato = r.ganks.filter((g) => g.setup !== "unknown");
  const objConDato = r.objectives.filter((o) => o.verdict !== "unknown");
  const resumen = [
    invConDato.length > 0 && t("Invades with priority: {n} of {m}", { n: invConDato.filter((i) => i.verdict === "prio").length, m: invConDato.length }),
    gankConDato.length > 0 && t("Ganks with the wave on your side: {n} of {m}", { n: gankConDato.filter((g) => g.setup === "good").length, m: gankConDato.length }),
    objConDato.length > 0 && t("Objectives with priority: {n} of {m}", { n: objConDato.filter((o) => o.verdict === "prio").length, m: objConDato.length }),
  ].filter(Boolean) as string[];

  return (
    <div style={wstyles.body}>
      {resumen.length > 0 && <p className="ds-summary">{resumen.join(" · ")}</p>}
      <LaneStrip series={r.series} duration={duracion} onSeek={(g) => onSeek(Math.max(0, g + videoOffset))} />

      {r.invades.length > 0 && (
        <div className="ws-group">
          <span className="u-label">{t("Your invades")}</span>
          <div className="ds-list">
            {r.invades.map((i, k) => {
              const v = verdictTag(i.verdict, t);
              return (
                <button key={k} type="button" className="ds-row" onClick={() => onSeek(Math.max(0, i.t_video - 5))} title={t("Jump to this moment")}>
                  <span className="u-time ds-time">{mmss(i.t_game)}</span>
                  <span className="ds-body">
                    <span className="ds-who">{campLabel(i.camp, t)}<span className="ds-soft"> · {lanesText(i.lanes, t)}</span></span>
                    <span className="ds-tags">
                      <Tag {...v} />
                      {i.died && <Tag text={t("you died")} tone="bad" />}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {r.ganks.length > 0 && (
        <div className="ws-group">
          <span className="u-label">{t("Your ganks")}</span>
          <div className="ds-list">
            {r.ganks.map((g, k) => {
              const s = setupTag(g.setup, t);
              return (
                <button key={k} type="button" className="ds-row" onClick={() => onSeek(Math.max(0, g.t_video - 8))} title={t("Jump to this moment")}>
                  <span className="u-time ds-time">{mmss(g.t_game)}</span>
                  <span className="ds-body">
                    <span className="ds-who">{t("Gank {lane}", { lane: LANE_LABEL[g.lane] })}</span>
                    <span className="ds-tags">
                      <Tag {...s} />
                      <Tag
                        text={g.outcome === "success" ? t("it worked") : g.outcome === "failed" ? t("it failed") : t("no result")}
                        tone={g.outcome === "success" ? "good" : g.outcome === "failed" ? "bad" : ""}
                      />
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {r.objectives.length > 0 && (
        <div className="ws-group">
          <span className="u-label">{t("Objectives")}</span>
          <div className="ds-list">
            {r.objectives.map((o, k) => {
              const v = verdictTag(o.verdict, t);
              return (
                <button key={k} type="button" className="ds-row" onClick={() => onSeek(Math.max(0, o.t_video - 20))} title={t("Jump to this moment")}>
                  <span className="u-time ds-time">{mmss(o.t_game)}</span>
                  <span className="ds-body">
                    <span className="ds-who">
                      {t(OBJECTIVE_LABEL[o.kind] ?? o.kind)}
                      <span className="ds-soft"> · {o.ours ? t("your team took it") : t("the enemy took it")} · {lanesText(o.lanes, t)}</span>
                    </span>
                    <span className="ds-tags"><Tag {...v} /></span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <p className="note" style={{ margin: 0 }}>
        {t("The rules: invade with the two nearby lanes pushed in your favour (their laners can't rotate first); gank with the wave on your side (the enemy far from their tower); contest objectives with priority in the nearby lanes. Waves are read from the minimap's minion dots every ~4 s.")}
      </p>
    </div>
  );
};
