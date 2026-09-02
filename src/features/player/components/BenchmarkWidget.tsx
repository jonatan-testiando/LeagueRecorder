import React, { useEffect, useState } from "react";
import { BarChart3, RefreshCw } from "lucide-react";
import { getMatchBenchmarks, type MetricComparison } from "../../../core/tauri-ipc";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Button } from "../../../components/ui/Button";
import { useT } from "../../../core/LanguageProvider";
import { roleLabel } from "../../../core/roles";
// Las etiquetas, el formato y el orden por puesto viven en `benchmarkFormat`
// porque Patrones enseña este mismo baremo (la media de varias partidas): con
// una tabla en cada sitio la misma métrica acaba con dos nombres.
import {
  bandLabel,
  effectivePercentile,
  formatMetricValue,
  METRIC_META,
  metricLabel,
  metricShort,
  sortByRelevance,
} from "../../../core/benchmarkFormat";

/**
 * "¿Esto es bueno para alguien como yo?"
 *
 * Las otras dos comparaciones de la app se quedan cortas: contra tus propias
 * partidas sólo dice si vas mejor que ayer, y contra el lobby depende de si te
 * tocó flojo. Aquí la referencia es una población — los que juegan TU puesto en
 * TU tramo de rango — que es la única que contesta esa pregunta.
 *
 * Dos cosas que hay que respetar al pintar:
 *
 *  - El percentil que manda el backend es SIEMPRE el crudo. Donde lo bueno es
 *    tener menos (`lower_is_better`), un 90 significa "mueres más que el 90%",
 *    así que aquí se invierte (`100 - p`) antes de colorear o de decir "top".
 *  - `percentile` y `median` pueden venir a null: esa métrica no está en el
 *    baremo o no se sabe el puesto. El valor crudo se enseña igual — esconder
 *    tu propio dato porque falta el de los demás es perder las dos cosas.
 */

/** Verde arriba, rojo abajo y gris en la mitad de en medio: sin colorines. */
const tono = (p: number | null): string =>
  p == null ? "var(--faint)" : p >= 70 ? "var(--cool)" : p < 30 ? "var(--signal)" : "var(--muted)";

export interface BenchmarkWidgetProps {
  matchId: string;
  /** Puesto de Riot ("JUNGLE"), o el que traiga el participante propio. */
  role?: string | null;
  /** "bajo" | "medio" | "alto". null = baremo sólo por puesto. */
  tierBucket?: string | null;
}

export const BenchmarkWidget: React.FC<BenchmarkWidgetProps> = ({ matchId, role, tierBucket }) => {
  const t = useT();
  const [rows, setRows] = useState<MetricComparison[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [intento, setIntento] = useState(0);

  // Se pide al MONTAR, y este componente sólo se monta cuando la sección está
  // abierta (`InspSection` no renderiza sus hijos plegada). Así plegarla es de
  // verdad no pedir nada.
  useEffect(() => {
    let vivo = true;
    setRows(null);
    setErr(null);
    getMatchBenchmarks(matchId)
      .then((r) => { if (vivo) setRows(r); })
      .catch((e) => { if (vivo) setErr(String(e)); });
    return () => { vivo = false; };
  }, [matchId, intento]);

  const puesto = roleLabel(role);
  const banda = bandLabel(tierBucket);
  const subtitulo = !puesto
    ? null
    : banda
      ? t("Players in {band} on {role}", { role: t(puesto), band: t(banda) })
      : t("All players on {role}", { role: t(puesto) });

  if (err !== null) {
    return (
      <div style={styles.aviso}>
        <span className="u-meta" style={{ flex: 1, minWidth: 0 }}>
          {t("Couldn't load the benchmarks: {msg}", { msg: err })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw size={13} />}
          onClick={() => setIntento((n) => n + 1)}
        >
          {t("Retry")}
        </Button>
      </div>
    );
  }

  if (rows === null) {
    return (
      <div style={styles.cargando}>
        <div className="spinner" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<BarChart3 size={26} color="var(--faint)" />}
        title={t("No benchmarks for this game yet")}
        text={t("Sync with Riot to compare against your rank")}
      />
    );
  }

  // Orden por relevancia del puesto; lo que no esté en la tabla, detrás.
  const ordenadas = sortByRelevance(rows, role);

  // Lo mejor y lo peor, dos y dos. Sólo entran las que tienen percentil: sin
  // población no hay "fuerte" ni "flojo", sólo un número suelto.
  const conP = ordenadas
    .filter((m) => effectivePercentile(m) != null && METRIC_META[m.metric])
    .sort((a, b) => (effectivePercentile(b) as number) - (effectivePercentile(a) as number));
  const nombresDe = (lista: MetricComparison[]) =>
    lista.map((m) => t(metricShort(m.metric))).join(", ");
  const fuertes = conP.slice(0, 2);
  const flojas = conP.slice(-2).reverse();
  const resumen =
    conP.length >= 4
      ? t("Strong: {strong} · Work on: {weak}", {
          strong: nombresDe(fuertes),
          weak: nombresDe(flojas),
        })
      : null;

  return (
    <div>
      {subtitulo && <p className="note" style={styles.sub}>{subtitulo}</p>}
      {resumen && <p style={styles.resumen}>{resumen}</p>}

      <div style={styles.lista}>
        {ordenadas.map((m) => {
          if (!METRIC_META[m.metric]) return null;
          const p = effectivePercentile(m);
          const color = tono(p);
          return (
            <div key={m.metric} style={styles.fila}>
              <div style={styles.cabeza}>
                <span style={styles.etiqueta}>{t(metricLabel(m.metric))}</span>
                <span style={styles.valor}>{formatMetricValue(m.metric, m.value)}</span>
              </div>
              <div style={styles.pie}>
                <div
                  style={styles.pista}
                  title={
                    m.median != null
                      ? t("median {v}", { v: formatMetricValue(m.metric, m.median) })
                      : undefined
                  }
                >
                  {p != null && (
                    <span style={{ ...styles.relleno, width: `${Math.max(1, Math.min(100, p))}%`, background: color }} />
                  )}
                  {/* La mediana está SIEMPRE al 50 del eje de percentiles: la
                      marca no dice cuánto vale, dice dónde queda la mitad. */}
                  {m.median != null && <span style={styles.marca} />}
                </div>
                <span style={{ ...styles.percentil, color }}>
                  {p == null
                    ? "—"
                    : p >= 50
                      ? t("top {n}%", { n: Math.max(1, Math.round(100 - p)) })
                      : t("bottom {n}%", { n: Math.max(1, Math.round(p)) })}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  sub: {
    margin: "0 0 var(--space-2) 0",
  },
  resumen: {
    margin: "0 0 var(--space-3) 0",
    color: "var(--text)",
    fontSize: "var(--font-xs)",
    lineHeight: 1.5,
  },
  lista: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-3)",
  },
  fila: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  cabeza: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "var(--space-2)",
  },
  etiqueta: {
    color: "var(--muted)",
    fontSize: "var(--font-xs)",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  valor: {
    color: "var(--text)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-xs)",
    fontWeight: 600,
    flexShrink: 0,
  },
  pie: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
  },
  pista: {
    position: "relative",
    flex: 1,
    height: 5,
    minWidth: 40,
    background: "var(--sunken)",
    borderRadius: "var(--radius-full)",
    boxShadow: "var(--inset-sunken)",
    overflow: "hidden",
  },
  relleno: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: "var(--radius-full)",
  },
  marca: {
    position: "absolute",
    left: "50%",
    top: 0,
    bottom: 0,
    width: 1,
    // Un punto más clara que la pista: sobre `--line` la marca desaparecía y
    // la barra parecía no tener referencia ninguna.
    background: "var(--faint)",
    opacity: 0.7,
  },
  percentil: {
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    fontWeight: 600,
    flexShrink: 0,
    // Ancho fijo para que las barras queden alineadas entre filas. 92 es lo que
    // pide la cadena más larga en español ("31% más bajo") sin partirse.
    width: 92,
    whiteSpace: "nowrap",
    textAlign: "right",
  },
  cargando: {
    display: "grid",
    placeItems: "center",
    padding: "var(--space-5) 0",
  },
  aviso: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "var(--space-2) 0",
  },
};
