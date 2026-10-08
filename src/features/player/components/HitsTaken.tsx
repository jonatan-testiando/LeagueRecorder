import React, { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import {
  getHitsTaken,
  readMatchHud,
  type HitEffect,
  type HitsReport,
} from "../../../core/tauri-ipc";
import { wstyles } from "./videoPlayerStyles";
import "./DeathsSection.css";
import "./HitsTaken.css";

/**
 * Golpes que te comes: cada pelea que te empezó un rival (ver `golpes.rs`).
 *
 * El "% de esquiva" no se puede medir —nada registra las habilidades que te
 * fallan—, así que esto mira lo que sí: el primer golpe de cada pelea, leído
 * de tu barra de vida, y qué hacías cuando llegó. Necesita leer el HUD del
 * vídeo una vez (1-4 min); el lote de "Medir con vídeo" lo hace solo.
 */

/** Filas que se ven antes de "ver todas". */
const VISIBLES = 8;

type T = ReturnType<typeof useT>;

export function effectLabel(e: HitEffect, t: T): string {
  if (!e.ability) return t("an effect from {champion}", { champion: e.champion });
  if (e.ability === "P") return t("{champion}'s passive", { champion: e.champion });
  return t("{ability} of {champion}", { ability: e.ability, champion: e.champion });
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((100 * n) / d) : 0);

interface Props {
  matchId: string;
  onSeek: (videoSeconds: number) => void;
}

export const HitsTaken: React.FC<Props> = ({ matchId, onSeek }) => {
  const t = useT();
  const [r, setR] = useState<HitsReport | null | undefined>(undefined);
  const [avance, setAvance] = useState<number | null>(null);
  const [todas, setTodas] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const leer = useCallback(() => {
    getHitsTaken(matchId)
      .then((x) => {
        setR(x);
        if (x.status === "reading") setAvance((a) => a ?? 0);
      })
      .catch(() => setR(null));
  }, [matchId]);

  useEffect(() => {
    setR(undefined);
    setAvance(null);
    setTodas(false);
    leer();
    const off = listen<[string, number]>("hud_progress", (e) => {
      const [id, p] = e.payload;
      if (id !== matchId) return;
      if (p >= 100 || p < 0) {
        setAvance(null);
        if (p < 0) setError(t("The video couldn't be read."));
        leer();
      } else {
        setAvance(p);
      }
    });
    return () => { void off.then((f) => f()).catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId, leer]);

  const empezar = () => {
    setError(null);
    setAvance(0);
    readMatchHud(matchId).catch((e) => {
      setAvance(null);
      setError(String(e));
    });
  };

  if (r === undefined) return <div className="ds-loading"><div className="spinner" /></div>;
  if (r === null) return <p className="note" style={{ margin: 0 }}>{t("Couldn't load this section.")}</p>;

  if (avance != null || r.status === "reading") {
    return (
      <div className="ht-read" role="status">
        <div className="ht-read__row"><span>{t("Reading your health bar from the video…")}</span></div>
        <div className="ht-read__track" aria-hidden="true"><i style={{ width: `${Math.max(3, avance ?? 0)}%` }} /></div>
      </div>
    );
  }

  if (r.status === "no_hud") {
    return (
      <div className="ht-read">
        <div className="ht-read__row">
          <span>{t("Read every hit you take from your health bar in the video.")}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={empezar}>{t("Read the video")}</button>
        </div>
        <p className="ht-read__note">{t("About 1-4 min. It also reads which enemy ability hit you when its icon is recognised.")}</p>
        {error && <p className="ht-read__note ht-read__note--err">{error}</p>}
      </div>
    );
  }
  if (r.status === "no_minimap") {
    return <p className="note" style={{ margin: 0 }}>{t("It needs the minimap measured to know which hits came from champions: Patterns → Measure with the video.")}</p>;
  }
  if (r.status !== "ok") {
    return <p className="note" style={{ margin: 0 }}>{t("Your health bar wasn't found in this video. It's read at the default HUD scale.")}</p>;
  }
  if (r.openers === 0) {
    return <p className="note" style={{ margin: 0 }}>{t("No enemy started a fight on you this game.")}</p>;
  }

  const filas = todas ? r.list : r.list.slice(0, VISIBLES);
  const conTeclas = r.matches_with_keys > 0;

  return (
    <div style={wstyles.body}>
      <p className="ds-summary">
        {t("{n} fights started with a hit on you.", { n: r.openers })}{" "}
        {[
          r.straight_known > 0 && t("{p}% while moving in a straight line", { p: pct(r.straight, r.straight_known) }),
          t("{p}% from the fog", { p: pct(r.from_fog, r.openers) }),
          t("{p}% ended in your death", { p: pct(r.died, r.openers) }),
        ].filter(Boolean).join(" · ")}
      </p>
      {r.line_known > 0 && (
        <p className="note" style={{ margin: 0 }}>
          {t("When the first hit landed you were moving sideways in {lat}% of them, away along their line in {away}% and towards them in {tow}% (moving at random, sideways would be about 67%).", {
            lat: pct(r.line_lateral, r.line_known),
            away: pct(r.line_away, r.line_known),
            tow: pct(r.line_toward, r.line_known),
          })}
        </p>
      )}

      <div className="ht-stats">
        <div className="ht-stat">
          <span className="u-label">{t("Reaction")}</span>
          {conTeclas ? (
            <strong>
              {r.reaction_p50 != null ? t("{s} s", { s: r.reaction_p50.toFixed(2) }) : "—"}
              <small> {t("{n} of {m} with a key", { n: r.reaction_n, m: r.reaction_known })}</small>
            </strong>
          ) : (
            <small>{t("Measured in games recorded from this version on (Q W E R D F are saved).")}</small>
          )}
        </div>
        {r.effects.length > 0 && (
          <div className="ht-stat">
            <span className="u-label">{t("What opened them")}</span>
            <span className="ht-effects">
              {r.effects.map((c) => (
                <span key={c.effect.icon} className="ht-effect" title={c.effect.icon}>
                  {c.icon_url && <img src={c.icon_url} alt="" />}
                  {effectLabel(c.effect, t)} ×{c.times}
                </span>
              ))}
            </span>
          </div>
        )}
      </div>

      <div className="ds-list">
        {filas.map((a, i) => (
          <button key={i} type="button" className="ds-row" onClick={() => onSeek(Math.max(0, a.t_video - 3))} title={t("Jump to this moment")}>
            <span className="u-time ds-time">{mmss(Math.max(0, a.t_game))}</span>
            <span className="ds-body">
              <span className="ds-who">
                {t("−{p}% in one hit", { p: Math.round(a.hit_pct) })}
                {a.effect && <span className="ds-soft"> · {effectLabel(a.effect, t)}</span>}
                {a.fight_hits > 1 && (
                  <span className="ds-soft"> · {t("fight −{p}%", { p: Math.round(a.fight_pct) })}</span>
                )}
              </span>
              <span className="ds-tags">
                {a.died && <span className="ds-tag ds-tag--bad">{t("ended in your death")}</span>}
                {a.straight === true && <span className="ds-tag ds-tag--bad">{t("straight line")}</span>}
                {a.from_fog && <span className="ds-tag">{t("from the fog")}</span>}
                {a.line === "lateral" && <span className="ds-tag">{t("moving sideways")}</span>}
                {a.line === "away" && <span className="ds-tag ds-tag--bad">{t("fleeing along their line")}</span>}
                {a.line === "toward" && <span className="ds-tag">{t("moving towards them")}</span>}
                {a.line === "offscreen" && <span className="ds-tag">{t("enemy off your screen")}</span>}
                {a.enemies_near > 1 && <span className="ds-tag">{t("{n} enemies close", { n: a.enemies_near })}</span>}
                {a.reaction && (
                  <span className="ds-tag">{t("{key} after {s} s", { key: a.reaction.key, s: a.reaction.secs.toFixed(2) })}</span>
                )}
                {conTeclas && !a.reaction && <span className="ds-tag">{t("no key within 2 s")}</span>}
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
        {t("A fight starts with the first hit of 5%+ of your health after 5 s without taking any, with an enemy within reach on the minimap. From the fog: no enemy was visible near you in the 4 s before. Sideways or along their line: your last move order against the closest enemy on your screen, from the health bars above the champions. Missed abilities can't be counted: nothing records them.")}
      </p>
    </div>
  );
};
