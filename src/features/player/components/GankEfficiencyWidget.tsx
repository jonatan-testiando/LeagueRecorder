import React, { useMemo, useState } from "react";
import { TimelineMarker } from "../../../types";
import { CheckCircle2, AlertCircle, XCircle, Compass } from "lucide-react";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { EmptyState } from "../../../components/ui/EmptyState";
import { wstyles } from "./videoPlayerStyles";

interface GankEfficiencyWidgetProps {
  markers?: TimelineMarker[];
  gankImpact15?: number;
  onSeek: (seconds: number) => void;
}

type Lane = "top" | "mid" | "bot";
type LaneFilter = "all" | Lane;
type Outcome = "success" | "neutral" | "failed";
type OutcomeFilter = "all" | Outcome;

/** Segundos que se retrocede al saltar: interesa la entrada, no el desenlace. */
const LEAD_IN = 5;

/** Confianza a partir de la cual el detector se considera firme. */
const CONFIDENT = 0.75;

const LANE_LABEL: Record<Lane, string> = { top: "Top", mid: "Mid", bot: "Bot" };
const LANE_TONE: Record<Lane, string> = {
  top: "var(--cool)",
  mid: "var(--brand)",
  bot: "var(--flag)",
};

const OUTCOME_TONE: Record<Outcome, string> = {
  success: "var(--win)",
  neutral: "var(--brand)",
  failed: "var(--loss)",
};

const OUTCOME_LABEL: Record<Outcome, string> = {
  success: "Converted",
  neutral: "No result",
  failed: "Failed / you died",
};

const OutcomeIcon: React.FC<{ outcome: Outcome }> = ({ outcome }) =>
  outcome === "success" ? <CheckCircle2 size={12} />
    : outcome === "neutral" ? <AlertCircle size={12} />
    : <XCircle size={12} />;

interface Gank {
  marker: TimelineMarker;
  lane: Lane;
  outcome: Outcome;
  isFlank: boolean;
  confidence: number;
  precision: number;
}

/**
 * Lo que de verdad dicen estos ganks, en una línea.
 *
 * Aquí había dos párrafos de "Consejo" escritos a mano que salían igual para
 * todas las entradas frontales de todas las partidas: "rodea por el río", "mira
 * si usó Destello". Un consejo que no ha mirado tus datos no es un consejo, es
 * relleno — y encima aparecía repetido debajo de cada fila. Lo que queda son
 * cuentas: cuántas de tus entradas por detrás convirtieron y cuántas de las
 * frontales, que es lo único que este widget sabe y el usuario no.
 */
const readout = (
  ganks: Gank[],
  t: (k: string, v?: Record<string, string | number>) => string
): string[] => {
  if (ganks.length === 0) return [];
  const out: string[] = [];

  const flanks = ganks.filter((g) => g.isFlank);
  const fronts = ganks.filter((g) => !g.isFlank);
  const won = (list: Gank[]) => list.filter((g) => g.outcome === "success").length;

  if (flanks.length > 0 && fronts.length > 0) {
    out.push(
      t("{a} of {b} flanks converted, {c} of {d} frontal entries.", {
        a: won(flanks), b: flanks.length, c: won(fronts), d: fronts.length,
      })
    );
  } else if (flanks.length > 0) {
    out.push(t("{a} of {b} flanks converted. No frontal entries this game.", { a: won(flanks), b: flanks.length }));
  } else if (fronts.length > 0) {
    out.push(t("{a} of {b} frontal entries converted. You never cut the retreat.", { a: won(fronts), b: fronts.length }));
  }

  // El carril donde más entraste sin sacar nada: es el que hay que dejar de
  // visitar o visitar de otra forma.
  const perLane = (["top", "mid", "bot"] as Lane[]).map((lane) => {
    const list = ganks.filter((g) => g.lane === lane);
    return { lane, total: list.length, won: won(list) };
  });
  const dry = perLane
    .filter((l) => l.total >= 2 && l.won === 0)
    .sort((a, b) => b.total - a.total)[0];
  if (dry) {
    out.push(t("{n} visits to {lane} with nothing to show for them.", { n: dry.total, lane: LANE_LABEL[dry.lane] }));
  }

  const deaths = ganks.filter((g) => g.outcome === "failed").length;
  if (deaths > 0) {
    out.push(t("You ended up dead in {n} of them.", { n: deaths }));
  }
  return out;
};

export const GankEfficiencyWidget: React.FC<GankEfficiencyWidgetProps> = ({
  markers = [],
  gankImpact15,
  onSeek,
}) => {
  const t = useT();
  const [lane, setLane] = useState<LaneFilter>("all");
  const [result, setResult] = useState<OutcomeFilter>("all");

  // El backend ya manda carril, resultado, confianza y ángulo resueltos, y sólo
  // emite ganks de la fase temprana. Aquí no se deduce nada de coordenadas: esa
  // era justo la fuente de los falsos positivos (las cajas de carril cubrían el
  // mapa entero, bases y junglas incluidas).
  const ganks = useMemo<Gank[]>(
    () =>
      (markers ?? [])
        .filter((m) => m.event_type === "gank_attempt" && !!m.lane)
        .map((m) => ({
          marker: m,
          lane: m.lane as Lane,
          outcome: (m.outcome ?? "neutral") as Outcome,
          isFlank: m.approach === "flank",
          confidence: m.confidence ?? 0,
          precision: m.time_precision ?? 0,
        }))
        .sort((a, b) => a.marker.time - b.marker.time),
    [markers]
  );

  // Partidas analizadas con el detector viejo: sus marcadores no traen carril
  // ni resultado, así que no se pintan. Mejor decirlo que enseñar una lista
  // vacía como si no hubieras ganqueado nunca.
  const needsResync =
    ganks.length === 0 && (markers ?? []).some((m) => m.event_type === "gank_attempt" && !m.lane);

  const counts = useMemo(
    () => ({
      success: ganks.filter((g) => g.outcome === "success").length,
      neutral: ganks.filter((g) => g.outcome === "neutral").length,
      failed: ganks.filter((g) => g.outcome === "failed").length,
    }),
    [ganks]
  );

  const perLane = useMemo(
    () => ({
      top: ganks.filter((g) => g.lane === "top").length,
      mid: ganks.filter((g) => g.lane === "mid").length,
      bot: ganks.filter((g) => g.lane === "bot").length,
    }),
    [ganks]
  );

  const shown = ganks.filter(
    (g) => (lane === "all" || g.lane === lane) && (result === "all" || g.outcome === result)
  );

  const lines = useMemo(() => readout(ganks, t), [ganks, t]);

  if (needsResync) {
    return (
      <EmptyState
        title={t("Analyzed with the old detector")}
        text={t("Hit \"Refresh Riot data\" to recompute these ganks with lane, outcome and a precise timestamp.")}
      />
    );
  }

  if (ganks.length === 0 && gankImpact15 === undefined) {
    return (
      <EmptyState
        title={t("No ganks detected")}
        text={t("The detector only looks at the early game, and only at lanes you actually entered.")}
      />
    );
  }

  return (
    <div style={wstyles.body}>
      {gankImpact15 !== undefined && (
        <p className="note" style={{ marginTop: 0 }}>
          {/* El mismo número se llamaba aquí "Participación en kills" y a dos
              centímetros, en la ficha de la partida, "Gank pressure". Un nombre. */}
          {t("Gank pressure")}: <b className="u-metric">{gankImpact15}%</b>
        </p>
      )}

      {ganks.length > 0 && (
        <>
          <div style={wstyles.toolbar}>
            <span className="tp-seg">
              <button
                onClick={() => setLane("all")}
                aria-pressed={lane === "all"}
                data-on={lane === "all" ? "" : undefined}
              >
                {t("All")} ({ganks.length})
              </button>
              {(["top", "mid", "bot"] as Lane[]).map((l) => (
                <button
                  key={l}
                  onClick={() => setLane(lane === l ? "all" : l)}
                  aria-pressed={lane === l}
                  data-on={lane === l ? "" : undefined}
                  style={lane === l ? { color: LANE_TONE[l] } : undefined}
                >
                  {t(LANE_LABEL[l])} ({perLane[l]})
                </button>
              ))}
            </span>
          </div>

          <div style={wstyles.toolbar}>
            <span className="tp-seg">
              <button
                onClick={() => setResult("all")}
                aria-pressed={result === "all"}
                data-on={result === "all" ? "" : undefined}
              >
                {t("Any result")}
              </button>
              {(["success", "neutral", "failed"] as Outcome[]).map((o) => (
                <button
                  key={o}
                  onClick={() => setResult(result === o ? "all" : o)}
                  aria-pressed={result === o}
                  data-on={result === o ? "" : undefined}
                  style={result === o ? { color: OUTCOME_TONE[o] } : undefined}
                >
                  {t(OUTCOME_LABEL[o])} ({counts[o]})
                </button>
              ))}
            </span>
          </div>
        </>
      )}

      {shown.length > 0 ? (
        <div style={wstyles.list}>
          {shown.map((g, idx) => (
            <button
              key={idx}
              className="insp__press"
              onClick={() => onSeek(Math.max(0, g.marker.time - LEAD_IN))}
              title={t("Jump to this moment")}
            >
              <span
                className="u-metric"
                title={
                  g.precision > 0
                    ? t("Estimated by interpolating between minute frames: ±{n} s", { n: Math.round(g.precision) })
                    : t("Exact instant: anchored to a game event")
                }
              >
                {mmss(g.marker.time)}
                {g.precision > 0 && (
                  <span style={{ color: "var(--faint)" }}> ±{Math.round(g.precision)}s</span>
                )}
              </span>
              <span className="insp__pressWhat">
                <span style={{ color: LANE_TONE[g.lane] }}>{t(LANE_LABEL[g.lane])}</span>
                {" · "}
                <Compass
                  size={11}
                  style={{ verticalAlign: "-1px", color: g.isFlank ? "var(--cool)" : "var(--faint)" }}
                />{" "}
                {t(g.isFlank ? "Cut the retreat" : "Straight down the lane")}
                {g.confidence > 0 && (
                  <span
                    className="u-metric"
                    style={{
                      marginLeft: 6,
                      fontSize: 10,
                      color: g.confidence >= CONFIDENT ? "var(--muted)" : "var(--faint)",
                    }}
                    title={t("How sure the detector is: it rises with the enemy on top of you, the ally present, and the time you held the lane.")}
                  >
                    {t("confidence {n}%", { n: Math.round(g.confidence * 100) })}
                  </span>
                )}
              </span>
              <span className="insp__pressGain" style={{ color: OUTCOME_TONE[g.outcome] }}>
                <OutcomeIcon outcome={g.outcome} />{" "}
                {t(OUTCOME_LABEL[g.outcome])}
              </span>
            </button>
          ))}
        </div>
      ) : (
        ganks.length > 0 && (
          <p className="note">{t("No ganks match this filter.")}</p>
        )
      )}

      {lines.length > 0 && (
        <p className="note">{lines.join(" ")}</p>
      )}
    </div>
  );
};
