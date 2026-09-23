import React, { useEffect, useMemo, useState } from "react";
import { BarChart3, TrendingUp } from "lucide-react";
import { MatchMetadata } from "../../../types";
import { getMatchBenchmarks, type MetricComparison } from "../../../core/tauri-ipc";
import {
  bandLabel,
  effectivePercentile,
  formatMetricValue,
  headlineMetrics,
  metricLabel,
  metricLever,
  metricOrder,
  metricShort,
  sortByRelevance,
} from "../../../core/benchmarkFormat";
import { matchRole, ROLE_FILTERS, type RoleFilter, type RoleKey } from "../../../core/patterns";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Button } from "../../../components/ui/Button";
import { PositionIcon } from "../../../components/PositionIcon";
import { useT } from "../../../core/LanguageProvider";

/**
 * "¿Esto es bueno para alguien como yo?", en dos escalas.
 *
 *  - La TARJETA (fila principal de Patrones) enseña tu última partida contra
 *    tu rango y tu puesto: cuatro filas que se leen de un vistazo y una frase
 *    con la palanca que más rinde. Es la que contesta "¿y ahora qué hago?".
 *  - La TABLA (ficha "Frente a tu rango" de Explorar) promedia el percentil de
 *    las últimas veinte, que es la escala a la que la comparación empieza a ser
 *    una propiedad tuya y no del lobby que te tocó. Una partida sola no es una
 *    respuesta; por eso la media no se ha ido, solo se ha movido.
 *
 * Dos decisiones que conviene no deshacer:
 *
 *  - Se promedian PERCENTILES, no valores. Cada partida se compara contra su
 *    propio baremo (su tramo y su puesto), así que las partidas de rangos
 *    distintos se pueden mezclar sin falsear nada: un 70 en bajo y un 70 en
 *    alto significan lo mismo *dentro de su población*. Promediar los valores
 *    crudos sí mentiría.
 *  - La ventana de fechas y el puesto del panel mandan: las partidas llegan ya
 *    filtradas. Si esto contara otras, sería lo único de la pantalla que no
 *    responde a los filtros que el usuario acaba de tocar.
 *
 * La carga vive en un hook (`useRankBenchmarks`) que el panel llama UNA vez y
 * reparte a la tarjeta y a la tabla: las dos leen los mismos baremos y pedirlos
 * dos veces sería el doble de lecturas para lo mismo.
 */

/** Cuántas partidas como mucho entran en la media (y en la chispa). */
const MAX_GAMES = 20;
/** Mínimo para decir algo. Por debajo, la tarjeta dice cuánto le falta. */
const MIN_GAMES = 3;
/** Peticiones a la vez. El backend lee un DTO por partida; de cuatro en cuatro
 *  la tarjeta se llena rápido sin monopolizar el hilo de comandos. */
const CONCURRENCIA = 4;
/** Por debajo de este percentil una métrica se propone como palanca. */
const PALANCA_BAJO = 40;

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

/** Una métrica de UNA partida: la última. */
interface FilaUltima {
  metric: string;
  value: number;
  pct: number;
  median: number | null;
}

interface Ultima {
  matchId: string;
  champion: string;
  /** Puesto con el que se leen sus filas. */
  role: RoleKey | null;
  /** Etiqueta del tramo de esa partida, o null si no se conoce. */
  band: string | null;
  filas: FilaUltima[];
}

export interface Agregado {
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
  /** La partida más reciente con baremos, o null si ninguna los trajo. */
  ultima: Ultima | null;
}

/** El estado de los baremos, tal y como lo leen la tarjeta y la tabla. */
export type RankBench =
  | { kind: "needs"; n: number }
  | { kind: "loading" }
  | { kind: "error"; msg: string | null; retry: () => void }
  | { kind: "ok"; data: Agregado };

/**
 * El puesto, con la MISMA palabra que el selector del panel ("ADC", no "Bot").
 *
 * La tarjeta vive dentro de Patrones: si el usuario acaba de elegir "ADC" y la
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

/** Las dos métricas más altas y las dos más bajas, por percentil medio. */
export const extremos = (filas: Fila[]): { fuertes: Fila[]; flojas: Fila[] } => {
  const ordenadas = filas
    .filter((f) => f.pct != null)
    .sort((a, b) => (b.pct as number) - (a.pct as number));
  return { fuertes: ordenadas.slice(0, 2), flojas: ordenadas.slice(-2).reverse() };
};

/**
 * Carga los baremos de las partidas de la ventana (las veinte más recientes
 * que se puedan comparar) y los agrega. Se redispara al cambiar la ventana o el
 * puesto, no en cada render.
 */
export function useRankBenchmarks(matches: MatchMetadata[], roleFilter: RoleFilter): RankBench {
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
    // Se piden de la más nueva hacia atrás: la tarjeta de la última partida es
    // la que se ve primero.
    let siguiente = orden.length - 1;
    // Un fallo suelto no tumba la tarjeta: se pierde esa partida y las demás
    // siguen contando. Sólo cuando fallan TODAS hay algo que decir.
    const obrero = async (): Promise<void> => {
      for (;;) {
        const i = siguiente--;
        if (i < 0) return;
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
        // render, que es quien sabe en qué idioma está la app AHORA.
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

        // Sin percentil no hay comparación, y esto es sólo comparación: el
        // valor crudo ya lo enseña el reproductor partida a partida.
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

        // --- la última partida con baremos
        let ultima: Ultima | null = null;
        for (let i = orden.length - 1; i >= 0 && !ultima; i--) {
          const lista = res[i];
          if (!lista) continue;
          const m = orden[i];
          const filasU: FilaUltima[] = [];
          for (const c of lista) {
            const p = effectivePercentile(c);
            if (p != null) filasU.push({ metric: c.metric, value: c.value, pct: p, median: c.median });
          }
          if (filasU.length === 0) continue;
          ultima = {
            matchId: m.id,
            champion: m.champion,
            role: roleFilter !== "all" ? roleFilter : matchRole(m),
            band: bandLabel(m.tier_bucket),
            filas: filasU,
          };
        }

        setDatos({
          filas: sortByRelevance(filas, rolMostrado),
          games: conDatos,
          role: rolMostrado ? etiquetaPuesto(rolMostrado) : null,
          rolesMixtos: roles.size > 1,
          band: tramos.size === 1 ? bandLabel([...tramos][0]) : null,
          tramosMixtos: tramos.size > 1,
          ultima,
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

  if (candidatas.length < MIN_GAMES) return { kind: "needs", n: MIN_GAMES - candidatas.length };
  if (cargando) return { kind: "loading" };
  if (error || !datos || datos.filas.length === 0) {
    return { kind: "error", msg: error, retry: () => setIntento((n) => n + 1) };
  }
  return { kind: "ok", data: datos };
}

// ======================================================================
// La barra de percentil: peor a la izquierda, mediana en medio, mejor a la
// derecha. Es la misma en la tarjeta y en la tabla.
// ======================================================================

const BarraPercentil: React.FC<{ pct: number; label: string }> = ({ pct, label }) => {
  const p = Math.max(1, Math.min(99, pct));
  const color = tono(pct);
  return (
    <div className="pp-pbar" role="img" aria-label={label}>
      <div className="pp-pbar-track" />
      {/* El tramo entre la mediana y tú: lo que te separa de "lo normal". */}
      <div
        className="pp-pbar-gap"
        style={{
          left: `${Math.min(50, p)}%`,
          width: `${Math.abs(p - 50)}%`,
          background: `color-mix(in srgb, ${color} 30%, transparent)`,
        }}
      />
      <div className="pp-pbar-median" />
      <div
        className="pp-pbar-dot"
        style={{
          left: `${p}%`,
          background: color,
          boxShadow: `0 0 0 2px var(--panel), 0 0 0 5px color-mix(in srgb, ${color} 18%, transparent)`,
        }}
      />
    </div>
  );
};

// ======================================================================
// Tarjeta: tu última partida frente a tu rango.
// ======================================================================

export const RankBenchmarkCard: React.FC<{ bench: RankBench }> = ({ bench }) => {
  const t = useT();

  const titulo = <h2 className="pp-cardtitle">{t("Your last game vs your rank")}</h2>;

  if (bench.kind === "needs") {
    return (
      <section className="card pp-card pp-rank" aria-label={t("Your last game vs your rank")}>
        <div className="pp-cardhead">{titulo}</div>
        <EmptyState
          icon={<BarChart3 size={26} color="var(--faint)" />}
          title={t("Not enough synced ranked games")}
          text={
            bench.n === 1
              ? t("Needs 1 more synced ranked game")
              : t("Needs {n} more synced ranked games", { n: bench.n })
          }
        />
      </section>
    );
  }

  // Esqueleto, no ruleta: la forma de la tarjeta ya está decidida y enseñarla
  // evita que la página dé un salto cuando llegan los datos.
  if (bench.kind === "loading") {
    return (
      <section className="card pp-card pp-rank" aria-label={t("Your last game vs your rank")} aria-busy="true">
        <div className="pp-cardhead">
          {titulo}
          <span className="skeleton" style={{ display: "inline-block", width: 120, height: 10 }} />
        </div>
        <div className="pp-rank-rows">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="pp-rank-row">
              <div className="pp-rank-line">
                <span className="skeleton" style={{ height: 12, width: 120 }} />
                <span className="skeleton" style={{ height: 12, width: 90 }} />
              </div>
              <span className="skeleton" style={{ height: 6, width: "100%" }} />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (bench.kind === "error" || !bench.data.ultima) {
    const msg = bench.kind === "error" ? bench.msg : null;
    return (
      <section className="card pp-card pp-rank" aria-label={t("Your last game vs your rank")}>
        <div className="pp-cardhead">{titulo}</div>
        <p className="pp-prose">
          {t("Couldn't load the benchmarks: {msg}", { msg: msg ?? t("no benchmarks came back") })}
        </p>
        {bench.kind === "error" && (
          <div>
            <Button variant="ghost" size="sm" onClick={bench.retry}>
              {t("Retry")}
            </Button>
          </div>
        )}
      </section>
    );
  }

  const u = bench.data.ultima;
  const porMetrica = new Map(u.filas.map((f) => [f.metric, f]));

  // La palanca: de las ocho métricas que más pesan en tu puesto, la que peor
  // sale. Sólo si de verdad sale mal: por encima de 40 no hay palanca que
  // proponer, y decir "tu punto débil" de algo que está en la media es
  // inventarse un problema.
  const relevantes = metricOrder(u.role).slice(0, 8);
  const palanca =
    relevantes
      .map((m) => porMetrica.get(m))
      .filter((f): f is FilaUltima => !!f && f.pct < PALANCA_BAJO && metricLever(f.metric) != null)
      .sort((a, b) => a.pct - b.pct)[0] ?? null;

  // Las filas: las cuatro de cabecera del puesto. Si la palanca no está entre
  // ellas, ocupa el sitio del KDA (el menos accionable: mezcla lo que otras
  // filas ya dicen) — la frase de abajo tiene que poder verse en una barra.
  const cabecera = headlineMetrics(u.role).filter((m) => porMetrica.has(m));
  if (palanca && !cabecera.includes(palanca.metric)) {
    const i = cabecera.indexOf("kda");
    if (i >= 0) cabecera[i] = palanca.metric;
    else cabecera.push(palanca.metric);
  }
  const filas = cabecera.map((m) => porMetrica.get(m) as FilaUltima);

  return (
    <section className="card pp-card pp-rank" aria-label={t("Your last game vs your rank")}>
      <div className="pp-cardhead">
        {titulo}
        <span className="pp-meta pp-rank-scope">
          {u.band && <span>{t(u.band)}</span>}
          {u.band && u.role && <span aria-hidden="true">·</span>}
          {u.role && (
            <span className="pp-inline-icon">
              <PositionIcon position={u.role} size={14} />
              {t(etiquetaPuesto(u.role))}
            </span>
          )}
        </span>
      </div>

      <div className="pp-rank-rows">
        {filas.map((f) => (
          <div key={f.metric} className="pp-rank-row">
            <div className="pp-rank-line">
              <span className="pp-rank-name">{t(metricLabel(f.metric))}</span>
              <span className="pp-meta pp-num">
                <span className="pp-rank-value" style={{ color: tono(f.pct) }}>
                  {formatMetricValue(f.metric, f.value)}
                </span>
                {f.median != null && (
                  <> · {t("the median is {v}", { v: formatMetricValue(f.metric, f.median) })}</>
                )}
              </span>
            </div>
            <BarraPercentil
              pct={f.pct}
              label={t("Percentile {p} in your rank", { p: Math.round(f.pct) })}
            />
          </div>
        ))}
        <div className="pp-pbar-axis" aria-hidden="true">
          <span>{t("Worse")}</span>
          <span>{t("Your rank's median")}</span>
          <span>{t("Better")}</span>
        </div>
      </div>

      <div className="pp-lever">
        <TrendingUp size={16} aria-hidden="true" className="pp-lever-icon" />
        {palanca ? (
          <p className="pp-prose">
            <span className="pp-lever-strong">
              {t("Where you gain most: {lever}.", { lever: t(metricLever(palanca.metric) as string) })}
            </span>{" "}
            {palanca.median != null
              ? t("You were at {v}; your rank's median is {m}.", {
                  v: formatMetricValue(palanca.metric, palanca.value),
                  m: formatMetricValue(palanca.metric, palanca.median),
                })
              : t("You were at {v}.", { v: formatMetricValue(palanca.metric, palanca.value) })}
          </p>
        ) : (
          <p className="pp-prose">
            {t("Nothing in this game falls clearly below your rank's median.")}
          </p>
        )}
      </div>
    </section>
  );
};

// ======================================================================
// Tabla: la media de tus últimas partidas, métrica a métrica (ficha de
// Explorar). Es la tarjeta de antes, con las etiquetas en la voz nueva.
// ======================================================================

/** Resumen de una línea para la ficha plegada. */
export function benchmarkSummaryText(
  bench: RankBench,
  t: (key: string, vars?: Record<string, string | number>) => string
): React.ReactNode {
  if (bench.kind === "loading") {
    return <span className="skeleton" style={{ display: "inline-block", width: 160, height: 10 }} />;
  }
  if (bench.kind === "needs") {
    return bench.n === 1
      ? t("Needs 1 more synced ranked game")
      : t("Needs {n} more synced ranked games", { n: bench.n });
  }
  if (bench.kind === "error") {
    return t("Couldn't load the benchmarks: {msg}", { msg: bench.msg ?? t("no benchmarks came back") });
  }
  const { fuertes, flojas } = extremos(bench.data.filas);
  const [a, b] = fuertes;
  const [c, d] = flojas;
  return a && b && c && d
    ? t("Strongest: {a} and {b} · weakest: {c} and {d}", {
        a: t(metricShort(a.metric)), b: t(metricShort(b.metric)), c: t(metricShort(c.metric)), d: t(metricShort(d.metric)),
      })
    : `${bench.data.games} ${t(bench.data.games === 1 ? "game" : "games")}`;
}

export const RankBenchmarkTable: React.FC<{ bench: RankBench }> = ({ bench }) => {
  const t = useT();
  if (bench.kind !== "ok") return null;
  const datos = bench.data;
  const { fuertes, flojas } = extremos(datos.filas);
  const banda = datos.tramosMixtos ? t("mixed ranks") : datos.band ? t(datos.band) : null;

  return (
    <div className="card pp-card">
      <div className="pp-cardhead">
        <h3 className="pp-cardtitle">{t("Versus your rank")}</h3>
        <span className="pp-meta">
          {datos.games} {t(datos.games === 1 ? "game" : "games")}
          {datos.role ? ` · ${t(datos.role)}` : ""}
          {banda ? ` · ${banda}` : ""}
        </span>
      </div>
      {/* El puesto ordena las filas, así que cuando la muestra mezcla puestos
          hay que decir con cuál se ordenó: si no, el orden parece arbitrario. */}
      {datos.rolesMixtos && datos.role && (
        <div className="pp-meta">
          {t("Mixed roles in this window, ordered for {role}", { role: t(datos.role) })}
        </div>
      )}

      <div className="pp-avg-rows">
        {datos.filas.map((f) => {
          const p = f.pct;
          const color = tono(p);
          return (
            <div key={f.metric} className="pp-avg-row">
              <span className="pp-avg-name">{t(metricLabel(f.metric))}</span>
              <span className="pp-num pp-avg-value">{formatMetricValue(f.metric, f.value)}</span>
              {/* La barra es el percentil, no el valor: la muesca del 50 es la
                  mediana de la población y es la única referencia que importa. */}
              <div
                className="pp-avg-track"
                title={f.median != null ? t("median {v}", { v: formatMetricValue(f.metric, f.median) }) : undefined}
              >
                <div
                  className="pp-avg-fill"
                  style={{ width: `${Math.max(1, Math.min(100, p ?? 0))}%`, background: tonoBarra(p) }}
                />
                <div className="pp-avg-median" title={t("rank median")} />
              </div>
              <span className="pp-num pp-avg-pct" style={{ color }}>
                {p == null ? "—" : Math.round(p)}
              </span>
              <Chispa valores={f.chispa} color={color} />
            </div>
          );
        })}
      </div>

      {fuertes.length === 2 && flojas.length === 2 && (
        <p className="pp-prose">
          {t("Strongest: {a} and {b} · weakest: {c} and {d}", {
            a: t(metricShort(fuertes[0].metric)),
            b: t(metricShort(fuertes[1].metric)),
            c: t(metricShort(flojas[0].metric)),
            d: t(metricShort(flojas[1].metric)),
          })}
        </p>
      )}
      <div className="pp-meta">{t("average percentile against players of your rank in your role")}</div>
    </div>
  );
};

/**
 * El percentil de esa métrica partida a partida. Veinte puntos en sesenta
 * píxeles no se leen uno a uno: lo que se lee es si la línea sube o baja, que
 * es justo lo que la media de al lado no puede decir.
 */
const Chispa: React.FC<{ valores: (number | null)[]; color: string }> = ({ valores, color }) => {
  const W = 60;
  const H = 16;
  const puntos = valores
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => p.v != null);
  if (puntos.length < 2) return <span style={{ width: W, height: H, display: "inline-block", flex: "none" }} />;
  const n = Math.max(1, valores.length - 1);
  const d = puntos
    .map((p) => `${((p.i / n) * W).toFixed(1)},${(H - 1 - (p.v / 100) * (H - 2)).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={W} height={H} style={{ display: "block", flex: "0 0 auto" }} aria-hidden="true">
      {/* La mediana de la población, para saber de qué lado va la línea. */}
      <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="var(--hair)" strokeWidth="1" />
      <polyline points={d} fill="none" stroke={color} strokeWidth="1.25" opacity={0.9} />
    </svg>
  );
};
