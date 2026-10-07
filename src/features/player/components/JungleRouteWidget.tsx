import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  getJungleRoutes,
  JUNGLE_AGREEMENT_MIN,
  type JungleRoute,
} from "../../../core/tauri-ipc";
import { useJungleRoute } from "../useMatchData";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { EmptyState } from "../../../components/ui/EmptyState";
import { activityLabel, BUDGET_PARTS, campLabel, SIDE_TONE } from "../jungleRoute";
import { wstyles } from "./videoPlayerStyles";
import "./JungleRouteWidget.css";

/**
 * Tu ruta de jungla: qué campamento, cuándo, y en qué se te fue el tiempo.
 *
 * Sale del rastro del minimapa (2 veces por segundo) cruzado con los súbditos
 * de jungla que la API cuenta por minuto. El cálculo vive en
 * `src-tauri/src/jungle_route.rs`; aquí sólo se pinta.
 */

interface Props {
  matchId: string;
  onSeek: (videoSeconds: number) => void;
}

/** Segundos que se retrocede al saltar: interesa llegar, no el último golpe. */
const LEAD_IN = 3;

export const JungleRouteWidget: React.FC<Props> = ({ matchId, onSeek }) => {
  const t = useT();
  // Compartida con "Tus muertes" y el Recorrido: se pide una vez.
  const resp = useJungleRoute(matchId);
  const [mediana, setMediana] = useState<number | null>(null);

  useEffect(() => {
    let vivo = true;
    // La referencia: tu primer clear de siempre. Va aparte y puede fallar sin
    // que el resto del panel lo note.
    getJungleRoutes()
      .then((rs) => {
        if (!vivo) return;
        const fc = rs
          .filter((g) => g.match_id !== matchId && g.route.full_clear && g.route.agreement >= JUNGLE_AGREEMENT_MIN)
          .map((g) => g.route.first_clear_end as number)
          .sort((a, b) => a - b);
        setMediana(fc.length >= 3 ? fc[Math.floor(fc.length / 2)] : null);
      })
      .catch(() => {});
    return () => { vivo = false; };
  }, [matchId]);

  if (resp === null) {
    return <EmptyState title={t("Could not read the route")} text={t("Try opening the game again.")} />;
  }
  if (resp === undefined) {
    return <div className="jr-loading"><div className="spinner" /></div>;
  }
  if (resp.status === "no_minimap") {
    return (
      <EmptyState
        title={t("Measure this game with video to see your route")}
        text={t("The route comes from your icon on the minimap. Measure it from the Impact tab, in Video analysis.")}
      />
    );
  }
  if (resp.status !== "ok" || !resp.route) {
    return (
      <EmptyState
        title={t("No route for this game")}
        text={resp.status === "no_riot"
          ? t("It needs the game synced with Riot.")
          : t("The video could not follow your icon well enough.")}
      />
    );
  }
  return <Ruta r={resp.route} mediana={mediana} onSeek={onSeek} />;
};

const Ruta: React.FC<{ r: JungleRoute; mediana: number | null; onSeek: (s: number) => void }> = ({ r, mediana, onSeek }) => {
  const t = useT();
  const ir = (gameSec: number) => onSeek(Math.max(0, gameSec + r.video_offset - LEAD_IN));
  const dur = Math.max(1, r.game_duration);
  const pct = (s: number) => `${Math.min(100, Math.max(0, (s / dur) * 100))}%`;

  // La primera vuelta, tal como la cuenta el backend: hasta su último
  // campamento propio. Se reconstruye aquí sólo para pintar las fichas.
  const primera = useMemo(() => {
    if (r.first_clear_end == null) return [];
    return r.clears.filter((c) => c.start <= (r.first_clear_end as number)).slice(0, 8);
  }, [r]);

  const totalBudget = BUDGET_PARTS.reduce((a, p) => a + r.budget[p.key], 0) || 1;
  const dudosa = r.agreement < JUNGLE_AGREEMENT_MIN;
  const delta = r.first_clear_end != null && mediana != null ? r.first_clear_end - mediana : null;

  return (
    <div style={wstyles.body}>
      {dudosa && (
        <p className="jr-warn">
          <AlertTriangle size={13} aria-hidden="true" />
          {t("The video lost your icon for much of this game: only {p}% of your jungle minutes have a camp in the route. Take it as a sketch.", {
            p: Math.round(r.agreement * 100),
          })}
        </p>
      )}

      <div style={wstyles.statGrid}>
        <div style={wstyles.statBox}>
          <span className="u-label">{t("First clear")}</span>
          <span style={wstyles.statValue}>{r.first_clear_end != null ? mmss(r.first_clear_end) : "—"}</span>
          <span className="note">
            {r.full_clear
              ? t("all 6 camps")
              : t("{n} camps", { n: r.first_clear_camps })}
            {delta != null && (
              <span style={{ color: delta > 10 ? "var(--loss)" : delta < -10 ? "var(--win)" : undefined }}>
                {" · "}
                {t("your median {m}", { m: mmss(mediana as number) })}
              </span>
            )}
          </span>
        </div>
        <div style={wstyles.statBox}>
          <span className="u-label">{t("Invades")}</span>
          <span style={wstyles.statValue}>{r.invades}</span>
          <span className="note">{t("camps taken in the enemy jungle")}</span>
        </div>
        <div style={wstyles.statBox}>
          <span className="u-label">{t("Late to your camps")}</span>
          <span style={wstyles.statValue}>{r.mean_delay != null ? mmss(r.mean_delay) : "—"}</span>
          <span className="note">{t("on average, from respawn to you")}</span>
        </div>
        <div style={wstyles.statBox}>
          <span className="u-label">{t("Recalls")}</span>
          <span style={wstyles.statValue}>{r.recalls.length}</span>
          <span className="note">{t("{n} scuttles", { n: r.scuttles })}</span>
        </div>
      </div>

      {/* ------------------------------------------------ la tira */}
      <div className="jr-strip" role="group" aria-label={t("Camps over the game")}>
        {r.clears.map((c, i) => (
          <button
            key={i}
            type="button"
            className="jr-camp"
            style={{ left: pct(c.start), width: `max(4px, ${pct(c.end - c.start)})`, background: SIDE_TONE[c.side] }}
            title={`${mmss(c.start)} · ${campLabel(c.camp, t)}${c.side === "enemy" ? ` · ${t("enemy jungle")}` : ""}`}
            aria-label={`${mmss(c.start)} ${campLabel(c.camp, t)}`}
            onClick={() => ir(c.start)}
          />
        ))}
        {r.recalls.map((s, i) => (
          <span key={`b${i}`} className="jr-tick jr-tick--base" style={{ left: pct(s) }} title={`${mmss(s)} · ${t("Recall")}`} />
        ))}
        {r.deaths.map((d, i) => (
          <button
            key={`d${i}`}
            type="button"
            className="jr-tick jr-tick--death"
            style={{ left: pct(d.time) }}
            title={`${mmss(d.time)} · ${t("Death")} · ${activityLabel(d.activity, t)}`}
            aria-label={`${t("Death")} ${mmss(d.time)}`}
            onClick={() => ir(d.time)}
          />
        ))}
      </div>
      <div className="jr-legend">
        <span><i style={{ background: SIDE_TONE.own }} />{t("your jungle")}</span>
        <span><i style={{ background: SIDE_TONE.enemy }} />{t("enemy jungle")}</span>
        <span><i style={{ background: SIDE_TONE.river }} />{t("scuttle")}</span>
        <span><i className="jr-legend-base" />{t("recall")}</span>
        <span><i className="jr-legend-death" />{t("death")}</span>
      </div>

      {/* ------------------------------------------------ primera vuelta */}
      {primera.length > 0 && (
        <>
          <div className="sect__head" style={{ marginTop: "var(--space-1)" }}>
            <span className="u-label">{t("First clear")}</span>
            <i className="sect__rule" />
          </div>
          <div className="jr-chips">
            {primera.map((c, i) => (
              <button key={i} type="button" className="jr-chip" onClick={() => ir(c.start)}>
                <i style={{ background: SIDE_TONE[c.side] }} />
                {campLabel(c.camp, t)}
                <span className="u-time">{mmss(c.start)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* ------------------------------------------------ el tiempo */}
      <div className="sect__head" style={{ marginTop: "var(--space-1)" }}>
        <span className="u-label">{t("Where your time went")}</span>
        <i className="sect__rule" />
      </div>
      <div className="jr-budget" aria-hidden="true">
        {BUDGET_PARTS.map((p) =>
          r.budget[p.key] > 0 ? (
            <span key={p.key} style={{ width: `${(r.budget[p.key] / totalBudget) * 100}%`, background: p.tone }} />
          ) : null
        )}
      </div>
      <div className="jr-budget-legend">
        {BUDGET_PARTS.filter((p) => r.budget[p.key] >= 30).map((p) => (
          <span key={p.key}>
            <i style={{ background: p.tone }} />
            {t(p.label)}
            <b className="u-metric">{Math.round(r.budget[p.key] / 60)} min</b>
          </span>
        ))}
      </div>

      {/* ------------------------------------------------ tus muertes */}
      {r.deaths.length > 0 && (
        <>
          <div className="sect__head" style={{ marginTop: "var(--space-1)" }}>
            <span className="u-label">{t("What you were doing when you died")}</span>
            <i className="sect__rule" />
          </div>
          <div style={wstyles.list}>
            {r.deaths.map((d, i) => (
              <button key={i} type="button" className="jr-death" onClick={() => ir(d.time)}>
                <span className="u-time">{mmss(d.time)}</span>
                <span>
                  {activityLabel(d.activity, t)}
                  {d.camp && <span className="jr-death-camp"> · {campLabel(d.camp, t)}</span>}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
