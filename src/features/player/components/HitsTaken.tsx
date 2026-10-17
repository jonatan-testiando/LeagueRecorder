import React, { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import {
  getHitsTaken,
  readMatchHud,
  type HitEffect,
  type HitOpener,
  type HitsReport,
} from "../../../core/tauri-ipc";
import type { MapFocus, OpenMap } from "../mapFocus";
import { HelpDot } from "./HelpDot";
import { wstyles } from "./videoPlayerStyles";
import "./DeathsSection.css";
import "./HitsTaken.css";
import "./MatchTab.css";

/**
 * Golpes que te comes: cada pelea que te empezó un rival (ver `golpes.rs`).
 *
 * El "% de esquiva" no se puede medir —nada registra las habilidades que te
 * fallan—, así que esto mira lo que sí: el primer golpe de cada pelea, leído
 * de tu barra de vida, y qué hacías cuando llegó. Necesita leer el HUD del
 * vídeo una vez (1-4 min); el lote de "Medir con vídeo" lo hace solo.
 *
 * Desde el 2026-10-17 va dentro del bloque Muertes y más corto: una frase de
 * resumen, una fila por pelea con una frase (antes, hasta ocho etiquetas), y
 * las definiciones en el "?" en vez de un párrafo al pie.
 */

/** Filas que se ven antes de "ver todas": son el detalle, no el resumen. */
const VISIBLES = 5;
/** Iconos de "qué las abrió": los que más se repiten. */
const EFECTOS_VISIBLES = 3;

type T = ReturnType<typeof useT>;

export function effectLabel(e: HitEffect, t: T): string {
  if (!e.ability) return t("an effect from {champion}", { champion: e.champion });
  if (e.ability === "P") return t("{champion}'s passive", { champion: e.champion });
  return t("{ability} of {champion}", { ability: e.ability, champion: e.champion });
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((100 * n) / d) : 0);

/** Lo que hacías cuando llegó el golpe, en trozos; los malos van en rojo. */
function openerParts(a: HitOpener, conTeclas: boolean, t: T): { text: string; bad: boolean }[] {
  const out: { text: string; bad: boolean }[] = [];
  if (a.from_fog) out.push({ text: t("from the fog"), bad: false });
  if (a.straight === true) out.push({ text: t("moving in a straight line"), bad: true });
  if (a.line === "lateral") out.push({ text: t("moving sideways"), bad: false });
  if (a.line === "away") out.push({ text: t("fleeing along their line"), bad: true });
  if (a.line === "toward") out.push({ text: t("moving towards them"), bad: false });
  if (a.line === "offscreen") out.push({ text: t("enemy off your screen"), bad: false });
  if (a.enemies_near > 1) out.push({ text: t("{n} enemies close", { n: a.enemies_near }), bad: false });
  if (a.reaction) out.push({ text: t("{key} after {s} s", { key: a.reaction.key, s: a.reaction.secs.toFixed(2) }), bad: false });
  else if (conTeclas) out.push({ text: t("no key within 2 s"), bad: false });
  if (a.died) out.push({ text: t("ended in your death"), bad: true });
  if (out.length > 0) out[0] = { ...out[0], text: out[0].text.charAt(0).toUpperCase() + out[0].text.slice(1) };
  return out;
}

interface Props {
  matchId: string;
  onOpenMap: OpenMap;
}

export const HitsTaken: React.FC<Props> = ({ matchId, onOpenMap }) => {
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
  // Cuentas y no porcentajes: en una partida son 10-20 peleas, y "3 desde la
  // niebla" se comprueba mirando la lista; "21%" no.
  const resumen = [
    r.straight > 0 && t("{n} while moving in a straight line", { n: r.straight }),
    r.from_fog > 0 && t("{n} from the fog", { n: r.from_fog }),
    r.died > 0 && t("{n} ended in your death", { n: r.died }),
  ].filter(Boolean) as string[];

  const foco = (a: HitOpener): MapFocus => ({
    kind: "moment",
    t: a.t_game,
    lead: 3,
    title: t("−{p}% in one hit", { p: Math.round(a.hit_pct) }),
    detail: openerParts(a, conTeclas, t).map((p) => p.text).join(", ") || undefined,
    tone: a.died ? "bad" : "neutral",
  });

  return (
    <div style={wstyles.body}>
      <p className="ds-summary">
        {r.openers === 1 ? t("One fight started with a hit on you") : t("{n} fights started with a hit on you", { n: r.openers })}
        {resumen.length > 0 ? `: ${resumen.join(", ")}.` : "."}
        <HelpDot
          text={t("A fight starts with the first hit of 5%+ of your health after 5 s without taking any, with an enemy within reach on the minimap. From the fog: no enemy was visible near you in the 4 s before. Sideways or along their line: your last move order against the closest enemy on your screen, from the health bars above the champions. Missed abilities can't be counted: nothing records them.")}
        />
      </p>
      {r.line_known > 0 && (
        <p className="note" style={{ margin: 0 }}>
          {t("Moving sideways when the first hit landed: {p}% (moving at random it would be about 67%).", {
            p: pct(r.line_lateral, r.line_known),
          })}
        </p>
      )}

      <div className="ht-stats">
        {/* Sin teclas grabadas (partidas anteriores a la 1.2.35) no hay
            reacción que enseñar: el aviso de "se mide desde esta versión"
            salía en casi todas las partidas y no decía nada de esta. */}
        {conTeclas && (
          <div className="ht-stat">
            <span className="u-label">{t("Reaction")}</span>
            <strong>
              {r.reaction_p50 != null ? t("{s} s", { s: r.reaction_p50.toFixed(2) }) : "—"}
              <small> {t("{n} of {m} with a key", { n: r.reaction_n, m: r.reaction_known })}</small>
            </strong>
          </div>
        )}
        {r.effects.length > 0 && (
          <div className="ht-stat">
            <span className="u-label">{t("What opened them")}</span>
            <span className="ht-effects">
              {r.effects.slice(0, EFECTOS_VISIBLES).map((c) => (
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
        {filas.map((a, i) => {
          const trozos = openerParts(a, conTeclas, t);
          return (
            <button key={i} type="button" className="ds-row" onClick={() => onOpenMap(foco(a))} title={t("Open the map at this moment")}>
              <span className="u-time ds-time">{mmss(Math.max(0, a.t_game))}</span>
              <span className="ds-body">
                <span className="ds-who">
                  {t("−{p}% in one hit", { p: Math.round(a.hit_pct) })}
                  {a.effect && <span className="ds-soft"> · {effectLabel(a.effect, t)}</span>}
                  {a.fight_hits > 1 && (
                    <span className="ds-soft"> · {t("fight −{p}%", { p: Math.round(a.fight_pct) })}</span>
                  )}
                </span>
                {trozos.length > 0 && (
                  <span className="mt-line">
                    {trozos.map((p, k) => (
                      <React.Fragment key={k}>
                        {k > 0 && ", "}
                        <span className={p.bad ? "mt-bad" : undefined}>{p.text}</span>
                      </React.Fragment>
                    ))}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {r.list.length > VISIBLES && (
        <button type="button" className="btn btn--ghost btn--sm ht-more" onClick={() => setTodas((v) => !v)}>
          {todas ? t("Show fewer") : t("Show all {n}", { n: r.list.length })}
        </button>
      )}
    </div>
  );
};
