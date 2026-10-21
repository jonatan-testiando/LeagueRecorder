import React, { useState } from "react";
import type { TimelineMarker } from "../../../types";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import type { OpenMap } from "../mapFocus";
import { cap, invadeTally, moveFocus, moveText, useMoves, type Move } from "./matchMoves";
import { HelpDot } from "./HelpDot";
import { wstyles } from "./videoPlayerStyles";
import { useDelayedLoading } from "../../../core/useDelayedLoading";
import { SkeletonLines } from "../../../components/ui/Skeleton";
import "./DeathsSection.css";
import "./MatchTab.css";

/**
 * Invasiones y ganks en una sola lista, por orden de partida, y encima una
 * línea por tema con su cifra.
 *
 * Sustituye a dos secciones: "Oleadas y macro" (resumen, franjas, invasiones,
 * ganks, objetivos y un párrafo de reglas) y "Ganks" (filtros por carril y
 * resultado, la misma lista de ganks a otra hora). Cada fila dice una frase
 * —qué viste y si salió bien— y abre el Mapa en ese momento, con los carriles
 * y el campamento señalados. De dónde sale cada dato: `matchMoves.ts`.
 */

/** Filas antes de "ver todas": una partida de jungla trae 15-20. */
const VISIBLES = 8;
/** Con más incertidumbre que esto, la hora del gank se marca "~". */
const HORA_APROX_S = 5;

interface Props {
  matchId: string;
  markers?: TimelineMarker[];
  videoOffset: number;
  isJungler: boolean;
  /** Equipo rival (100/200): dueño de los campamentos que invades. */
  enemyTeam: number;
  /** Participación en las kills de tu equipo al 15 (sólo jungla). */
  gankImpact15?: number;
  onOpenMap: OpenMap;
}

export const JungleMoves: React.FC<Props> = ({ matchId, markers, videoOffset, isJungler, enemyTeam, gankImpact15, onOpenMap }) => {
  const t = useT();
  const [todas, setTodas] = useState(false);
  const { moves, waves, route, loading, wavesLoading, doubtful } = useMoves(matchId, markers, videoOffset, true);

  const inv = moves.filter((m): m is Extract<Move, { kind: "invade" }> => m.kind === "invade");
  const gk = moves.filter((m): m is Extract<Move, { kind: "gank" }> => m.kind === "gank");
  const objetivos = waves?.status === "ok" ? waves.objectives : [];

  // Ganks del detector viejo: los marcadores no traen carril y no se pintan.
  // Mejor decirlo que enseñar una lista sin ganks como si no los hubiera.
  const resincronizar =
    gk.length === 0 && (markers ?? []).some((m) => m.event_type === "gank_attempt" && !m.lane);

  const esperando = loading && moves.length === 0;
  const esqueleto = useDelayedLoading(esperando);
  if (esperando || esqueleto) return esqueleto ? <SkeletonLines /> : null;

  // Una línea por tema. La cifra de invasiones es la de la lista de abajo (la
  // ruta), y no otra: "Oleadas" decía "6 de 13" porque quitaba del total las
  // que no tenían dato, y la ruta decía 14.
  const lineas: React.ReactNode[] = [];
  if (inv.length > 0) {
    const muertas = inv.filter((i) => i.died).length;
    lineas.push(
      <>
        {invadeTally(inv, t)}.
        {muertas > 0 && <span className="mt-bad"> {t("You died in {n} of them.", { n: muertas })}</span>}
      </>
    );
  }
  if (gk.length > 0) {
    const salieron = gk.filter((g) => g.outcome === "success").length;
    const conZona = gk.filter((g) => g.zone != null);
    lineas.push(
      <>
        {gk.length === 1
          ? t("One gank: {result}.", { result: moveText(gk[0], t).verdict })
          : t("You ganked {n} times: {m} worked.", { n: gk.length, m: salieron })}
        {conZona.length > 0 &&
          ` ${t("The wave was in a gankable zone (1 or 2) in {m} of {k}.", {
            m: conZona.filter((g) => g.zone !== "own_3" && g.zone !== "enemy_3").length,
            k: conZona.length,
          })}`}
      </>
    );
  }
  // Los objetivos no llevan lista (se quitó en la v1.2.32 por repetida y se
  // había vuelto a colar en Oleadas); queda su cifra, que sólo sabe esto.
  if (objetivos.length > 0) {
    lineas.push(
      t("{n} objectives in the game: {m} with both nearby lanes pushed.", {
        n: objetivos.length,
        m: objetivos.filter((o) => o.verdict === "prio").length,
      })
    );
  }
  if (isJungler && gankImpact15 != null) {
    lineas.push(t("You took part in {p}% of your team's kills by minute 15.", { p: Math.round(gankImpact15) }));
  }

  const lista = todas ? moves : moves.slice(0, VISIBLES);

  return (
    <div style={wstyles.body}>
      {lineas.length > 0 && (
        <ul className="mt-tally">
          {lineas.map((l, i) => (
            <li key={i}>
              {l}
              {i === 0 && (
                <HelpDot text={t("The rules: invade with the two nearby lanes pushed in your favour (their laners can't rotate first). Gank by where the wave is, from your outer tower to theirs: the 1, the middle (in top and bot, the corner), is gankable; the 2 on each side is the last chance; the 3 next to each tower is ungankable; the best side is your 2. Contest objectives with priority in the nearby lanes. Waves are read from the minimap's minion dots every ~4 s.")} />
              )}
            </li>
          ))}
        </ul>
      )}
      {wavesLoading && (
        <p className="mt-sum__wait" role="status">
          <span className="spinner" />
          {t("Reading the waves from the minimap…")}
        </p>
      )}
      {doubtful && inv.length > 0 && (
        <p className="note" style={{ margin: 0 }}>{t("The route is a sketch for this game: some invades may be missing or wrong.")}</p>
      )}

      {resincronizar && (
        <p className="note" style={{ margin: 0 }}>
          {t("Analyzed with the old detector")}. {t("Hit \"Refresh Riot data\" to recompute these ganks with lane, outcome and a precise timestamp.")}
        </p>
      )}

      {moves.length > 0 ? (
        <div className="ds-list">
          {lista.map((m, i) => {
            const txt = moveText(m, t);
            const aprox = m.kind === "gank" && m.precision >= HORA_APROX_S;
            return (
              <button
                key={`${m.kind}${m.t}${i}`}
                type="button"
                className="ds-row"
                onClick={() => onOpenMap(moveFocus(m, t, enemyTeam))}
                title={t("Open the map at this moment")}
              >
                <span
                  className="u-time ds-time"
                  title={
                    m.kind === "gank"
                      ? m.precision > 0
                        ? t("Estimated by interpolating between minute frames: ±{n} s", { n: Math.round(m.precision) })
                        : t("Exact instant: anchored to a game event")
                      : undefined
                  }
                >
                  {aprox && "~"}
                  {mmss(Math.max(0, m.t))}
                </span>
                <span className="ds-body">
                  <span className="ds-who">{txt.title}</span>
                  {(txt.facts || txt.verdict) && (
                    <span className="mt-line">
                      {txt.facts}
                      {txt.facts && txt.verdict && ": "}
                      {txt.verdict && (
                        <span className={txt.tone === "good" ? "mt-good" : txt.tone === "bad" ? "mt-bad" : undefined}>
                          {txt.facts ? txt.verdict : cap(txt.verdict)}
                        </span>
                      )}
                      {txt.note && <span className="mt-soft"> · {txt.note}</span>}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        !loading && !resincronizar && (route || !isJungler) && (
          <p className="note" style={{ margin: 0 }}>
            {isJungler ? t("No invades or ganks detected this game.") : t("No ganks detected this game.")}
          </p>
        )
      )}
      {moves.length > VISIBLES && (
        <button type="button" className="btn btn--ghost btn--sm mt-showall" onClick={() => setTodas((x) => !x)}>
          {todas ? t("Show fewer") : t("Show all {n}", { n: moves.length })}
        </button>
      )}
    </div>
  );
};
