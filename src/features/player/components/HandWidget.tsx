import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { getHandReport, type HandReport } from "../../../core/tauri-ipc";
import { useT } from "../../../core/LanguageProvider";
import { EmptyState } from "../../../components/ui/EmptyState";
import { wstyles } from "./videoPlayerStyles";

/**
 * La geometría de tus clics de movimiento.
 *
 * La idea que sostiene el panel entero: un clic derecho manda a tu campeón en
 * la DIRECCIÓN campeón→clic, y el ángulo de esa dirección es lo único que
 * decide si sales de la línea del proyectil. La distancia no cambia adónde vas,
 * pero decide cuánto cuesta apuntar: con un temblor de mano `e`, un clic a
 * radio `r` se desvía `atan(e/r)`. Clicar corto es clicar impreciso.
 *
 * El cálculo vive en `src-tauri/src/hands.rs`; aquí sólo se pinta.
 */

/** Bajo esto un clic es corto. Tiene que coincidir con `RADIO_CORTO` en Rust. */
const RADIO_CORTO = 0.2;

/** Confianza de ancla por debajo de la cual avisamos de la cámara suelta. */
const ANCLA_DUDOSA = 0.6;

interface HandWidgetProps {
  matchId: string;
}

/** Un punto del borde de la rosa, en coordenadas de SVG. */
function punto(cx: number, cy: number, r: number, deg: number): string {
  const rad = (deg * Math.PI) / 180;
  // El eje Y del SVG crece hacia abajo y el ángulo se mide hacia arriba.
  return `${(cx + r * Math.cos(rad)).toFixed(2)},${(cy - r * Math.sin(rad)).toFixed(2)}`;
}

/**
 * Una cuña de la rosa, aproximada con segmentos.
 *
 * Con `A` habría que acertar los flags de barrido, que en un eje Y invertido se
 * eligen al revés de lo que uno espera; seis segmentos se ven igual de curvos y
 * no pueden salir del revés.
 */
function cuna(cx: number, cy: number, r: number, deg: number, ancho: number): string {
  const pasos = 6;
  const desde = deg - ancho / 2;
  const puntos: string[] = [];
  for (let i = 0; i <= pasos; i++) {
    puntos.push(punto(cx, cy, r, desde + (ancho * i) / pasos));
  }
  return `M ${cx},${cy} L ${puntos.join(" L ")} Z`;
}

export const HandWidget: React.FC<HandWidgetProps> = ({ matchId }) => {
  const t = useT();
  const [report, setReport] = useState<HandReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let vivo = true;
    setLoading(true);
    getHandReport(matchId)
      .then((r) => vivo && setReport(r))
      .catch(() => vivo && setReport(null))
      .finally(() => vivo && setLoading(false));
    return () => {
      vivo = false;
    };
  }, [matchId]);

  const maxShare = useMemo(
    () => Math.max(0.0001, ...(report?.sectors ?? []).map((s) => s.share)),
    [report]
  );
  const maxRing = useMemo(
    () => Math.max(0.0001, ...(report?.rings ?? []).map((b) => b.share)),
    [report]
  );

  if (loading) return <p className="note">{t("Reading your clicks…")}</p>;

  if (!report || report.clicks === 0) {
    return (
      <EmptyState
        title={t("No clicks recorded in this game")}
        text={t("This panel needs the mouse trail of a game recorded here; imported VODs have no input behind them.")}
      />
    );
  }

  const cortoPct = Math.round(report.short_ratio * 100);
  // El número que de verdad importa: si al cambiar de rumbo clicas MÁS CORTO
  // que andando, tu peor ángulo llega justo cuando más falta te hace.
  const acortaAlGirar =
    report.reactive.clicks >= 10 &&
    report.cruise.clicks >= 10 &&
    report.reactive.ring_px_p50 < report.cruise.ring_px_p50 * 0.9;

  const R = 84;
  const C = 100;

  return (
    <div style={wstyles.body}>
      <p className="note" style={{ marginTop: 0 }}>
        {t("Where your movement orders land relative to your champion. The angle decides the dodge; the distance decides how precisely you can aim it.")}
      </p>

      {report.anchor_conf < ANCLA_DUDOSA && (
        <p className="note" style={{ color: "var(--brand)" }}>
          <AlertTriangle size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
          {t("Your click cloud is off-centre, which usually means you play with the camera unlocked. The angles still hold; the distances are an upper bound.")}
        </p>
      )}

      <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
        {/* -------------------------------------------------- rosa de rumbos */}
        <figure style={{ margin: 0, flex: "1 1 200px", minWidth: 190 }}>
          <svg viewBox="0 0 200 200" style={{ width: "100%", height: "auto" }} role="img"
               aria-label={t("Direction of your movement orders")}>
            <circle cx={C} cy={C} r={R} fill="var(--sunken)" stroke="var(--line-soft)" />
            <circle cx={C} cy={C} r={R * 0.5} fill="none" stroke="var(--line-soft)" strokeDasharray="2 3" />
            {report.sectors.map((s, i) => (
              <path
                key={i}
                d={cuna(C, C, 18 + (R - 18) * (s.share / maxShare), s.deg, 22.5)}
                fill="var(--brand)"
                fillOpacity={0.22 + 0.55 * (s.share / maxShare)}
                stroke="var(--brand)"
                strokeOpacity={0.5}
              />
            ))}
            {/* Las cuatro diagonales: el repertorio de esquiva que entrenan las
                herramientas de coach, dibujado para poder comparar contra él. */}
            {[45, 135, 225, 315].map((d) => (
              <line
                key={d}
                x1={C}
                y1={C}
                x2={punto(C, C, R, d).split(",")[0]}
                y2={punto(C, C, R, d).split(",")[1]}
                stroke="var(--muted)"
                strokeDasharray="3 4"
                strokeOpacity={0.38}
              />
            ))}
            <circle cx={C} cy={C} r={3} fill="var(--faint)" />
          </svg>
          <figcaption className="note" style={{ textAlign: "center" }}>
            {t("Direction of your orders. Dashed lines are the four diagonals.")}
          </figcaption>
        </figure>

        {/* --------------------------------------------- histograma de radio */}
        <figure style={{ margin: 0, flex: "1 1 220px", minWidth: 200 }}>
          <svg viewBox="0 0 220 140" style={{ width: "100%", height: "auto" }} role="img"
               aria-label={t("How far from your champion you click")}>
            {report.rings.map((b, i) => {
              const alto = 104 * (b.share / maxRing);
              const corto = b.from < RADIO_CORTO;
              return (
                <rect
                  key={i}
                  x={6 + i * 19}
                  y={116 - alto}
                  width={15}
                  height={Math.max(alto, b.clicks > 0 ? 1.5 : 0)}
                  rx={2}
                  fill={corto ? "var(--loss)" : "var(--cool)"}
                  fillOpacity={0.75}
                >
                  <title>
                    {t("{pct}% of screen height · {n} clicks", {
                      pct: Math.round(b.from * 100),
                      n: b.clicks,
                    })}
                  </title>
                </rect>
              );
            })}
            <line x1={6 + (RADIO_CORTO / 0.05) * 19 - 2} y1={8} x2={6 + (RADIO_CORTO / 0.05) * 19 - 2} y2={120}
                  stroke="var(--brand)" strokeDasharray="3 3" />
            <line x1={4} y1={120} x2={216} y2={120} stroke="var(--line-soft)" />
            <text x={6 + (RADIO_CORTO / 0.05) * 19 + 2} y={16} fontSize="9" fill="var(--brand)">
              {t("short")}
            </text>
          </svg>
          <figcaption className="note" style={{ textAlign: "center" }}>
            {t("Distance from your champion, as a share of screen height.")}
          </figcaption>
        </figure>
      </div>

      <div style={wstyles.statGrid}>
        <div style={wstyles.statBox}>
          <span className="u-label">{t("Median click radius")}</span>
          <span style={wstyles.statValue}>{Math.round(report.ring_px_p50)} px</span>
          <span className="note">{Math.round(report.ring_pct_p50 * 100)}% {t("of screen height")}</span>
        </div>
        <div style={wstyles.statBox}>
          <span className="u-label">{t("Short clicks")}</span>
          <span style={{ ...wstyles.statValue, color: cortoPct > 35 ? "var(--loss)" : "var(--text)" }}>
            {cortoPct}%
          </span>
          <span className="note">{t("under {pct}% of height", { pct: Math.round(RADIO_CORTO * 100) })}</span>
        </div>
        <div style={wstyles.statBox}>
          <span className="u-label">{t("Measured hand tremor")}</span>
          <span style={wstyles.statValue}>
            {report.correction_px_p50 === null ? "—" : `${Math.round(report.correction_px_p50)} px`}
          </span>
          <span className="note">{t("from your own correction clicks")}</span>
        </div>
        <div style={wstyles.statBox}>
          <span className="u-label">{t("Angular cost")}</span>
          <span style={wstyles.statValue}>
            {report.angular_cost_deg === null ? "—" : `${report.angular_cost_deg.toFixed(1)}°`}
          </span>
          <span className="note">
            {report.angular_cost_reactive_deg === null
              ? t("what that tremor costs you")
              : t("{deg}° when you turn", { deg: report.angular_cost_reactive_deg.toFixed(1) })}
          </span>
        </div>
        <div style={wstyles.statBox}>
          <span className="u-label">{t("Turning clicks")}</span>
          <span style={wstyles.statValue}>{Math.round(report.reactive.ring_px_p50)} px</span>
          <span className="note">{t("{n} of them", { n: report.reactive.clicks })}</span>
        </div>
        <div style={wstyles.statBox}>
          <span className="u-label">{t("Cruising clicks")}</span>
          <span style={wstyles.statValue}>{Math.round(report.cruise.ring_px_p50)} px</span>
          <span className="note">{t("{n} of them", { n: report.cruise.clicks })}</span>
        </div>
      </div>

      <p className="note">
        {acortaAlGirar
          ? t("You click {react} px away when you change direction and {cruise} px when you just walk: your worst aiming angle arrives exactly when the dodge does. Clicking further out is free and it is the cheapest fix on this page.", {
              react: Math.round(report.reactive.ring_px_p50),
              cruise: Math.round(report.cruise.ring_px_p50),
            })
          : t("Your turning clicks are as far out as your walking ones, so the dodge is not being lost to a cramped click.")}
      </p>

      <p className="note">
        {t("{orders} movement orders · {corr}% of them were a correction of the previous one · {left} left clicks in the play area (attack-move shows up here) · {ui} discarded on the HUD or minimap.", {
          orders: report.clicks,
          corr: Math.round(report.correction_ratio * 100),
          left: report.left_in_play,
          ui: report.discarded_ui,
        })}
      </p>
    </div>
  );
};
