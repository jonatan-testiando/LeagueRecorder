import React, { useEffect, useState } from "react";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { getAim, type AimBucket, type AimReport } from "../../../core/tauri-ipc";
import { wstyles } from "./videoPlayerStyles";
import "./DeathsSection.css";
import "./HitsTaken.css";
import "./WavesSection.css";

/**
 * Tu puntería (ver `barras.rs`): en cada Q/W/E/R con un rival en la dirección
 * del cursor, si apuntaste adonde estaba, adonde iba o por detrás, y si perdió
 * vida después. Necesita las teclas grabadas (desde la v1.2.35) y las barras
 * de vida leídas del vídeo.
 */

const VISIBLES = 8;

const pct = (b?: AimBucket) => (b && b.known > 0 ? `${Math.round((100 * b.hits) / b.known)}%` : "—");

interface Props {
  matchId: string;
  videoOffset: number;
  onSeek: (videoSeconds: number) => void;
}

export const AimSection: React.FC<Props> = ({ matchId, videoOffset, onSeek }) => {
  const t = useT();
  const [r, setR] = useState<AimReport | null | undefined>(undefined);
  const [todas, setTodas] = useState(false);

  useEffect(() => {
    let vivo = true;
    setR(undefined);
    getAim(matchId)
      .then((x) => vivo && setR(x))
      .catch(() => vivo && setR(null));
    return () => { vivo = false; };
  }, [matchId]);

  if (r === undefined) return <div className="ds-loading"><div className="spinner" /></div>;
  if (!r || r.status === "no_keys" || r.status === "no_match") {
    return (
      <p className="note" style={{ margin: 0 }}>
        {t("Your aim is measured in games recorded from version 1.2.35 on: it needs when you pressed each ability and where your cursor was.")}
      </p>
    );
  }
  if (r.status === "no_bars") {
    return <p className="note" style={{ margin: 0 }}>{t("Read the video first (Hits you take → Read the video): the aim comes from the health bars above the champions.")}</p>;
  }
  if (r.aimed === 0) {
    return <p className="note" style={{ margin: 0 }}>{t("No ability aimed at a visible enemy this game.")}</p>;
  }

  const porApunte = (k: string) => r.by_aim.find((b) => b.key === k);
  const aimLabel: Record<string, string> = {
    direct: t("where they were"),
    lead: t("where they were going"),
    behind: t("behind their movement"),
    still: t("enemy standing still"),
  };
  const filas = todas ? r.list : r.list.slice(0, VISIBLES);

  return (
    <div style={wstyles.body}>
      <p className="ds-summary">
        {t("{n} of your {m} abilities went towards a visible enemy.", { n: r.aimed, m: r.presses })}
      </p>
      <div className="ht-career">
        {(["lead", "direct", "behind", "still"] as const).map((k) => {
          const b = porApunte(k);
          if (!b) return null;
          return (
            <div key={k} className="ht-stat">
              <span className="u-label">{aimLabel[k]}</span>
              <strong>{pct(b)} <small>{t("hit · {n} shots", { n: b.n })}</small></strong>
            </div>
          );
        })}
      </div>
      <div className="ht-effects">
        {r.by_key.map((b) => (
          <span key={b.key} className="ht-effect">{t("{key}: {p} hit of {n}", { key: b.key, p: pct(b), n: b.n })}</span>
        ))}
      </div>
      <div className="ds-list">
        {filas.map((s, i) => (
          <button key={i} type="button" className="ds-row" onClick={() => onSeek(Math.max(0, s.t_video - 2))} title={t("Jump to this moment")}>
            <span className="u-time ds-time">{mmss(Math.max(0, s.t_video - videoOffset))}</span>
            <span className="ds-body">
              <span className="ds-who">{s.key}<span className="ds-soft"> · {aimLabel[s.aim]} · {t("{d}° off", { d: Math.abs(s.offset_deg).toFixed(0) })}</span></span>
              <span className="ds-tags">
                {s.hit === true && <span className="ds-tag ws-tag--good">{t("hit")}</span>}
                {s.hit === false && <span className="ds-tag ds-tag--bad">{t("missed")}</span>}
                {s.hit == null && <span className="ds-tag">{t("lost sight of them")}</span>}
              </span>
            </span>
          </button>
        ))}
      </div>
      {r.list.length > VISIBLES && (
        <button type="button" className="btn btn--ghost btn--sm ht-more" onClick={() => setTodas((v) => !v)}>
          {todas ? t("Show fewer") : t("Show all {n}", { n: r.list.length })}
        </button>
      )}
      <p className="note" style={{ margin: 0 }}>
        {t("Where they were going: you aimed to the side they were moving to, which is how a skillshot is meant to be thrown at range. Hit: the enemy lost 3%+ of their health in the next second. It counts every ability, not only skillshots.")}
      </p>
    </div>
  );
};
