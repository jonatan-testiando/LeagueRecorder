import React, { useEffect, useMemo, useState } from "react";
import { BarChart3 } from "lucide-react";
import { MatchMetadata } from "../../../types";
import { getMatchBenchmarks, type MetricComparison } from "../../../core/tauri-ipc";
import {
  bandLabel,
  effectivePercentile,
  formatMetricValue,
  metricLabel,
  metricShort,
  sortByRelevance,
} from "../../../core/benchmarkFormat";
import { matchRole, ROLE_FILTERS, type RoleFilter, type RoleKey } from "../../../core/patterns";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Button } from "../../../components/ui/Button";
import { useT } from "../../../core/LanguageProvider";

/**
 * "¿Esto es bueno para alguien como yo?", pero sobre varias partidas.
 *
 * El reproductor ya compara UNA partida contra la población de tu tramo y tu
 * puesto. Una partida sola no es una respuesta: el CS/min de la que perdiste en
 * veinte minutos no dice nada de cómo farmeas. Aquí se promedia el percentil de
 * las últimas veinte, que es la escala a la que la comparación empieza a ser
 * una propiedad tuya y no del lobby que te tocó.
 *
 * Dos decisiones que conviene no deshacer:
 *
 *  - Se promedian PERCENTILES, no valores. Cada partida se compara contra su
 *    propio baremo (su tramo y su puesto), así que las partidas de rangos
 *    distintos se pueden mezclar sin falsear nada: un 70 en bajo y un 70 en
 *    alto significan lo mismo *dentro de su población*. Promediar los valores
 *    crudos sí mentiría.
 *  - La ventana de fechas y la píldora de puesto del panel mandan: las partidas
 *    llegan ya filtradas. Si esta tarjeta contara otras, sería la única de la
 *    pantalla que no responde a los filtros que el usuario acaba de tocar.
 */

/** Cuántas partidas como mucho entran en la media (y en la chispa). */
const MAX_GAMES = 20;
/** Mínimo para decir algo. Por debajo, la tarjeta dice cuánto le falta. */
const MIN_GAMES = 3;
/** Peticiones a la vez. El backend lee un DTO por partida; de cuatro en cuatro
 *  la tarjeta se llena rápido sin monopolizar el hilo de comandos. */
const CONCURRENCIA = 4;

/** Una métrica agregada sobre las partidas de la ventana. */
interface Fila {
  metric: string;
  /** Media del valor crudo (CS/min, muertes…). */
  value: number;
  /** Media del percentil ya leído en el sentido bueno, o null si nunca vino. */
  pct: number | null;
  /** Mediana de la población, de la partida más reciente que la traiga. */
  median: number | null;
  /** En cuántas partidas había percentil. */
  n: number;
  /** El percentil partida a partida, de la más vieja a la más nueva. */
  chispa: (number | null)[];
}

interface Agregado {
  filas: Fila[];
  /** Partidas que de verdad entraron. */
  games: number;
  /** Puesto con el que se ordena la lista, ya como etiqueta ("ADC"…). */
  role: string | null;
  /** ¿Había más de un puesto entre esas partidas? */
  rolesMixtos: boolean;
  /** Etiqueta del tramo, o null si no se conoce ninguno. */
  band: string | null;
  /** ¿Había más de un tramo? */
  tramosMixtos: boolean;
}

/**
 * El puesto, con la MISMA palabra que la píldora del panel ("ADC", no "Bot").
 *
 * La tarjeta vive dentro de Patrones: si el usuario acaba de pulsar "ADC" y la
 * cabecera le contesta "Bot", parece que está mirando otra cosa.
 */
const etiquetaPuesto = (r: RoleKey): string =>
  ROLE_FILTERS.find((f) => f.key === r)?.label ?? r;

/** Verde arriba, rojo abajo, gris en la mitad de en medio. Sin colorines. */
const tono = (p: number | null): string =>
  p == null ? "var(--faint)" : p >= 70 ? "var(--cool)" : p < 30 ? "var(--signal)" : "var(--muted)";

/**
 * El mismo tono, pero para el relleno de la barra.
 *
 * El gris neutro a pleno es casi blanco, y quince barras neutras a pleno son lo
 * más brillante de la pantalla para decir justo lo que no importa: que estás en
 * la media. Se atenúa para que sólo destaquen las que sí dicen algo.
 */
const tonoBarra = (p: number | null): string =>
  p == null || (p < 70 && p >= 30)
    ? "color-mix(in srgb, var(--muted) 45%, transparent)"
    : tono(p);

/** ¿Es una partida de la que el backend puede sacar baremos? */
const usable = (m: MatchMetadata): boolean =>
  !m.is_vod &&
  (m.queue === 420 || m.queue === 440) &&
  (m.participants?.length ?? 0) > 0;

/** La más reciente primero. */
const porFecha = (a: MatchMetadata, b: MatchMetadata): number =>
  b.date.localeCompare(a.date);

export interface RankBenchmarkCardProps {
  /** Las partidas YA filtradas por la ventana temporal y el puesto del panel. */
  matches: MatchMetadata[];
  /** La píldora de puesto activa: manda sobre el puesto mayoritario. */
  roleFilter: RoleFilter;
}

export const RankBenchmarkCard: React.FC<RankBenchmarkCardProps> = ({ matches, roleFilter }) => {
  const t = useT();
  const [datos, setDatos] = useState<Agregado | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Se incrementa al pulsar "Reintentar": es lo que redispara el efecto. */
  const [intento, setIntento] = useState(0);

  // De la más nueva a la más vieja, recortadas a veinte.
  const candidatas = useMemo(
    () => matches.filter(usable).sort(porFecha).slice(0, MAX_GAMES),
    [matches]
  );
  // La identidad de la ventana. Sin esto el efecto se redispara con cada
  // render del panel (el array es nuevo cada vez) y la tarjeta pide baremos en
  // bucle.
  const clave = useMemo(() => candidatas.map((m) => m.id).join("|"), [candidatas]);

  useEffect(() => {
    if (candidatas.length < MIN_GAMES) {
      setDatos(null);
      setCargando(false);
      setError(null);
      return;
    }
    let vivo = true;
    setCargando(true);
    setError(null);

    // De la más vieja a la más nueva: es el eje de la chispa, que se lee de
    // izquierda a derecha como el tiempo.
    const orden = [...candidatas].reverse();
    const res: (MetricComparison[] | null)[] = new Array(orden.length).fill(null);
    let siguiente = 0;
    // Un fallo suelto no tumba la tarjeta: se pierde esa partida y las demás
    // siguen contando. Sólo cuando fallan TODAS hay algo que decir.
    const obrero = async (): Promise<void> => {
      for (;;) {
        const i = siguiente++;
        if (i >= orden.length) return;
        try {
          res[i] = await getMatchBenchmarks(orden[i].id);
        } catch (e) {
          console.error("benchmarks", orden[i].id, e);
        }
      }
    };

    Promise.all(Array.from({ length: Math.min(CONCURRENCIA, orden.length) }, obrero))
      .then(() => {
        if (!vivo) return;
        // Sin datos no se guarda un mensaje ya traducido: el texto lo pone el
        // render, que es quien sabe en qué idioma está la app AHORA. Guardarlo
        // aquí dejaba el fallo en el idioma en que ocurrió.
        const conDatos = res.filter((r) => r != null).length;
        if (conDatos === 0) {
          setDatos(null);
          return;
        }

        // --- puesto y tramo de la muestra
        const roles = new Set<RoleKey>();
        const tramos = new Set<string>();
        const cuenta = new Map<RoleKey, number>();
        orden.forEach((m, i) => {
          if (res[i] == null) return;
          const r = matchRole(m);
          if (r) {
            roles.add(r);
            cuenta.set(r, (cuenta.get(r) ?? 0) + 1);
          }
          if (m.tier_bucket) tramos.add(m.tier_bucket);
        });
        const mayoritario = [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        const rolMostrado = roleFilter !== "all" ? roleFilter : mayoritario;

        // --- agregado por métrica
        const acc = new Map<
          string,
          { sumV: number; nV: number; sumP: number; nP: number; median: number | null; chispa: (number | null)[] }
        >();
        orden.forEach((_, i) => {
          const lista = res[i];
          if (!lista) return;
          for (const c of lista) {
            const e =
              acc.get(c.metric) ??
              { sumV: 0, nV: 0, sumP: 0, nP: 0, median: null, chispa: new Array(orden.length).fill(null) };
            e.sumV += c.value;
            e.nV += 1;
            const p = effectivePercentile(c);
            if (p != null) {
              e.sumP += p;
              e.nP += 1;
              e.chispa[i] = p;
            }
            if (c.median != null) e.median = c.median;
            acc.set(c.metric, e);
          }
        });

        // Sin percentil no hay comparación, y esta tarjeta es sólo comparación:
        // el valor crudo ya lo enseña el reproductor partida a partida.
        const filas: Fila[] = [...acc.entries()]
          .filter(([, e]) => e.nP > 0 && e.nV > 0)
          .map(([metric, e]) => ({
            metric,
            value: e.sumV / e.nV,
            pct: e.sumP / e.nP,
            median: e.median,
            n: e.nP,
            chispa: e.chispa,
          }));

        setDatos({
          filas: sortByRelevance(filas, rolMostrado),
          games: conDatos,
          role: rolMostrado ? etiquetaPuesto(rolMostrado) : null,
          rolesMixtos: roles.size > 1,
          band: tramos.size === 1 ? bandLabel([...tramos][0]) : null,
          tramosMixtos: tramos.size > 1,
        });
      })
      .catch((e) => {
        if (!vivo) return;
        setError(typeof e === "string" ? e : String(e));
        setDatos(null);
      })
      .finally(() => {
        if (vivo) setCargando(false);
      });

    return () => {
      vivo = false;
    };
    // `clave` resume las partidas: el array cambia de identidad en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave, roleFilter, intento]);

  const cabecera = (meta?: React.ReactNode) => (
    <div style={styles.cardHead}>
      <span className="u-label">{t("Versus your rank")}</span>
      {meta}
    </div>
  );

  // ------------------------------------------------------------ poca muestra
  if (candidatas.length < MIN_GAMES) {
    const faltan = MIN_GAMES - candidatas.length;
    return (
      <div className="card" style={styles.card}>
        {cabecera(<span className="u-meta">{t("players of your rank in your role")}</span>)}
        <EmptyState
          icon={<BarChart3 size={26} color="var(--faint)" />}
          title={t("Not enough synced ranked games")}
          text={
            faltan === 1
              ? t("Needs 1 more synced ranked game")
              : t("Needs {n} more synced ranked games", { n: faltan })
          }
        />
      </div>
    );
  }

  // ------------------------------------------------------------------- carga
  // Esqueleto, no ruleta: la forma de la tarjeta ya está decidida y enseñarla
  // evita que la página dé un salto cuando llegan los datos.
  if (cargando) {
    return (
      <div className="card" style={styles.card}>
        {cabecera(<span className="skeleton" style={{ display: "inline-block", width: 120, height: 10 }} />)}
        <div style={styles.filas}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} style={styles.fila}>
              <span className="skeleton" style={{ height: 10, width: 96 }} />
              <span className="skeleton" style={{ height: 10, width: 44 }} />
              <span className="skeleton" style={{ height: 6, flex: 1 }} />
              <span className="skeleton" style={{ height: 10, width: 28 }} />
              <span className="skeleton" style={{ height: 14, width: 60 }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------- fallo
  if (error || !datos || datos.filas.length === 0) {
    return (
      <div className="card" style={styles.card}>
        {cabecera()}
        <p style={styles.texto}>
          {t("Couldn't load the benchmarks: {msg}", { msg: error ?? t("no benchmarks came back") })}
        </p>
        <div>
          <Button variant="ghost" size="sm" onClick={() => setIntento((n) => n + 1)}>
            {t("Retry")}
          </Button>
        </div>
      </div>
    );
  }

  const conPct = datos.filas.filter((f) => f.pct != null);
  const ordenadas = [...conPct].sort((a, b) => (b.pct as number) - (a.pct as number));
  const fuertes = ordenadas.slice(0, 2);
  const flojas = ordenadas.slice(-2).reverse();
  const banda = datos.tramosMixtos ? t("mixed ranks") : datos.band ? t(datos.band) : null;

  return (
    <div className="card" style={styles.card}>
      {cabecera(
        <span className="u-meta">
          {datos.games} {t(datos.games === 1 ? "game" : "games")}
          {datos.role ? ` · ${t(datos.role)}` : ""}
          {banda ? ` · ${banda}` : ""}
        </span>
      )}
      {/* El puesto ordena las filas, así que cuando la muestra mezcla puestos
          hay que decir con cuál se ordenó: si no, el orden parece arbitrario. */}
      {datos.rolesMixtos && datos.role && (
        <div className="u-meta" style={{ marginBottom: 6 }}>
          {t("Mixed roles in this window, ordered for {role}", { role: t(datos.role) })}
        </div>
      )}

      <div style={styles.filas}>
        {datos.filas.map((f) => {
          const p = f.pct;
          const color = tono(p);
          return (
            <div key={f.metric} style={styles.fila}>
              <span style={styles.etiqueta}>{t(metricLabel(f.metric))}</span>
              <span className="u-metric" style={styles.valor}>
                {formatMetricValue(f.metric, f.value)}
              </span>
              {/* La barra es el percentil, no el valor: la muesca del 50 es la
                  mediana de la población y es la única referencia que importa. */}
              <div
                style={styles.pista}
                title={f.median != null ? t("median {v}", { v: formatMetricValue(f.metric, f.median) }) : undefined}
              >
                <div
                  style={{
                    ...styles.relleno,
                    width: `${Math.max(1, Math.min(100, p ?? 0))}%`,
                    background: tonoBarra(p),
                  }}
                />
                <div style={styles.muesca} title={t("rank median")} />
              </div>
              <span className="u-metric" style={{ ...styles.pct, color }}>
                {p == null ? "—" : Math.round(p)}
              </span>
              <Chispa valores={f.chispa} color={color} />
            </div>
          );
        })}
      </div>

      {fuertes.length === 2 && flojas.length === 2 && (
        <p style={styles.texto}>
          {t("Strongest: {a} and {b} · weakest: {c} and {d}", {
            a: t(metricShort(fuertes[0].metric)),
            b: t(metricShort(fuertes[1].metric)),
            c: t(metricShort(flojas[0].metric)),
            d: t(metricShort(flojas[1].metric)),
          })}
        </p>
      )}
      <div className="u-meta">{t("average percentile against players of your rank in your role")}</div>
    </div>
  );
};

/**
 * El percentil de esa métrica partida a partida. Veinte puntos en sesenta
 * píxeles no se leen uno a uno: lo que se lee es si la línea sube o baja, que
 * es justo lo que la media de arriba no puede decir.
 */
const Chispa: React.FC<{ valores: (number | null)[]; color: string }> = ({ valores, color }) => {
  const W = 60;
  const H = 16;
  const puntos = valores
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => p.v != null);
  if (puntos.length < 2) return <span style={{ width: W, height: H, display: "inline-block" }} />;
  const n = Math.max(1, valores.length - 1);
  const d = puntos
    .map((p) => `${((p.i / n) * W).toFixed(1)},${(H - 1 - (p.v / 100) * (H - 2)).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={W} height={H} style={{ display: "block", flex: "0 0 auto" }} aria-hidden="true">
      {/* La mediana de la población, para saber de qué lado va la línea. */}
      <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="var(--line-soft)" strokeWidth="1" />
      <polyline points={d} fill="none" stroke={color} strokeWidth="1.25" opacity={0.9} />
    </svg>
  );
};

const styles: Record<string, React.CSSProperties> = {
  card: {
    padding: "var(--space-4)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  },
  cardHead: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "var(--space-3)",
    marginBottom: 2,
  },
  filas: { display: "flex", flexDirection: "column", gap: 5 },
  fila: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "3px 0",
    borderBottom: "1px solid var(--line-soft)",
  },
  etiqueta: { fontSize: 12, color: "var(--muted)", flex: "0 0 132px", minWidth: 0 },
  valor: { flex: "0 0 56px", textAlign: "right", fontSize: 12, fontWeight: 600 },
  pista: {
    position: "relative",
    flex: 1,
    minWidth: 90,
    height: 6,
    background: "var(--sunken)",
    borderRadius: "var(--radius-sm)",
  },
  relleno: {
    position: "absolute",
    left: 0,
    top: 0,
    height: "100%",
    borderRadius: "var(--radius-sm)",
  },
  /* La muesca del 50 SOBRESALE de la barra por arriba y por abajo a propósito.
     Dentro se perdía: sobre el relleno claro no se distinguía, y es justo en
     las filas que rondan la mediana donde hay que verla. */
  muesca: {
    position: "absolute",
    left: "50%",
    top: -3,
    width: 1,
    height: 12,
    background: "var(--faint)",
    zIndex: 1,
  },
  pct: { flex: "0 0 26px", textAlign: "right", fontSize: 12, fontWeight: 700 },
  texto: { margin: 0, fontSize: 12, color: "var(--muted)", lineHeight: 1.5 },
};
