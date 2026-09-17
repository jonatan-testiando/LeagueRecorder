import React, { useEffect, useMemo, useState } from "react";
import { usePressureSummary } from "../../player/usePressureSummary";
import { useNavigate } from "react-router-dom";
import { MatchEvent, MatchMetadata } from "../../../types";
import {
  deathClock,
  errorCategories,
  confidenceOf,
  forecastRank,
  ladderLp,
  filterByRole,
  ROLE_FILTERS,
  type DeathClock,
  type RoleFilter,
  type Confidence,
} from "../../../core/patterns";
import { mapImageUrl, rankIcon, rankLabel, useDdragonVersion } from "../../../core/ddragon";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import {
  ErrorClipMetadata,
  getAllErrorClips,
  getCameraZoneHistory,
  getSeasonForm,
  type SeasonForm,
  type ZoneHistoryRow,
} from "../../../core/tauri-ipc";
import { computeKDA, outcome } from "../../../core/matchStats";
import { laneLabel, SIDE_LANES } from "../../../core/lanes";
import { mmss } from "../../../core/time";
import { metricShort } from "../../../core/benchmarkFormat";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { BarChart3, ChevronRight } from "lucide-react";
import { useT } from "../../../core/LanguageProvider";
import { useAppStore, useMatches } from "../../../store/useAppStore";
import { RankBenchmarkCard, type BenchmarkSummary } from "./RankBenchmarkCard";
import "./PatternsPanel.css";

/**
 * Patrones: la única pantalla que mira más de una partida a la vez.
 *
 * El resto de la app trabaja siempre sobre una sola, y por eso datos como "en
 * qué minuto te mueres" llevaban meses en disco sin que nadie los enseñara.
 *
 * Regla de esta pantalla: no afirmar más de lo que aguanta la muestra. Con
 * quince partidas, dos muertes de diferencia entre tramos no son un hallazgo, y
 * presentarlas como tal sería mentir con gráficas.
 *
 * Estructura (maqueta 2026-09): arriba las tres preguntas con las que se entra
 * (dónde mueres, cuándo, y cómo va la escalada); debajo, seis fichas de una
 * línea que se abren enteras al pulsarlas. Antes eran doce secciones apiladas
 * con el mismo peso y la pantalla no tenía por dónde empezar a leerse.
 */

const CONFIDENCE_COPY: Record<Confidence, { label: string; note: string; under: string | null }> = {
  low: {
    label: "Early signal",
    note: "Under 15 games this points at a tendency, not a conclusion. It sharpens as you record more.",
    under: "under 15 games",
  },
  medium: {
    label: "Likely pattern",
    note: "Enough games to steer by, though small gaps between windows are still noise.",
    under: "under 40 games",
  },
  good: {
    label: "Solid pattern",
    note: "Enough games to trust the overall shape.",
    under: null,
  },
};

const CATEGORY_COLOR: Record<string, string> = {
  "Decision Making": "var(--brand)",
  Positioning: "var(--flag)",
  Mechanics: "var(--cool)",
  Other: "var(--muted)",
};

/** Fases de partida para filtrar el mapa de muertes, en minutos de partida. */
type Phase = "all" | "early" | "mid" | "late";
/** `short` es lo que cabe en el chip; `label` (con el rango) va en el title. */
const PHASES: { key: Phase; short: string; label: string }[] = [
  { key: "all", short: "All", label: "All" },
  { key: "early", short: "Early", label: "Early (<14m)" },
  { key: "mid", short: "Mid", label: "Mid (14–25m)" },
  { key: "late", short: "Late", label: "Late (>25m)" },
];
const inPhase = (gameMin: number, fase: Phase): boolean => {
  if (fase === "all") return true;
  if (fase === "early") return gameMin < 14;
  if (fase === "mid") return gameMin >= 14 && gameMin <= 25;
  return gameMin > 25;
};

/**
 * Ventana temporal de la pantalla.
 *
 * Un agregado sin ventana mezcla el jugador que eres con el que eras: las
 * cincuenta partidas de hace tres meses pesan lo mismo que las diez de esta
 * semana y tapan cualquier cambio. "Este parche" existe porque los cambios de
 * parche son la otra frontera real: un carril que dejó de funcionar el martes
 * no debería seguir contando desde el lunes.
 */
type Range = "all" | "30d" | "last10" | "patch";
const RANGES: { key: Range; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "30d", label: "Last 30 days" },
  { key: "last10", label: "Last 10 games" },
  { key: "patch", label: "This patch" },
];

/** Milisegundos de la fecha de una partida, o 0 si no se puede leer. */
const fechaMs = (m: MatchMetadata): number => {
  const ms = new Date(m.date.replace(" ", "T")).getTime();
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * Aplica la ventana. `parche` es el más reciente de TUS partidas, no el del
 * juego: la app no sabe qué parche corre hoy, sabe en cuál jugaste la última.
 */
function inRange(matches: MatchMetadata[], rango: Range, parche: string | null): MatchMetadata[] {
  if (rango === "all") return matches;
  if (rango === "patch") return parche ? matches.filter((m) => m.patch === parche) : matches;
  if (rango === "30d") {
    const corte = Date.now() - 30 * 24 * 3600 * 1000;
    return matches.filter((m) => fechaMs(m) >= corte);
  }
  return [...matches].sort((a, b) => fechaMs(b) - fechaMs(a)).slice(0, 10);
}

/**
 * El reloj de muertes en ocho tramos fijos (0–5 … 30–35, 35+).
 *
 * `deathClock` devuelve solo los tramos con muertes y sin tope por arriba; un
 * histograma necesita los ocho siempre en el mismo sitio, con los huecos a
 * cero, o la forma cambia de una ventana a otra y no se puede comparar.
 */
interface Tramo {
  from: number;
  /** null en el último: "35+". */
  to: number | null;
  total: number;
  inWins: number;
  inLosses: number;
}
const TRAMOS_DESDE = [0, 5, 10, 15, 20, 25, 30, 35];
function histograma(clock: DeathClock): { tramos: Tramo[]; peak: Tramo | null; max: number } {
  const tramos: Tramo[] = TRAMOS_DESDE.map((from, i) => ({
    from,
    to: i === TRAMOS_DESDE.length - 1 ? null : from + 5,
    total: 0,
    inWins: 0,
    inLosses: 0,
  }));
  for (const b of clock.buckets) {
    const t = tramos[Math.min(tramos.length - 1, Math.max(0, Math.floor(b.from / 5)))];
    t.total += b.total;
    t.inWins += b.inWins;
    t.inLosses += b.inLosses;
  }
  const peak = tramos.reduce<Tramo | null>(
    (best, t) => (t.total > 0 && (best === null || t.total > best.total) ? t : best),
    null
  );
  return { tramos, peak, max: tramos.reduce((a, t) => Math.max(a, t.total), 0) };
}

/** Una muerte tuya con sitio en el mapa, ya atada a su partida. */
interface DeathPoint {
  matchId: string;
  /** Segundo del VÍDEO (para saltar al reproductor). */
  time: number;
  /** Segundo de PARTIDA (para el tooltip y la fase). */
  gameSec: number;
  x: number;
  y: number;
  result: ReturnType<typeof outcome>;
  killer: string | null;
}

/** El asesino de un evento de muerte: el campo estructurado si existe, o la
 *  frase legada ("Killed by X" / "Te mató X") si no. */
const killerOf = (ev: MatchEvent): string | null => {
  if (ev.actor) return ev.actor;
  const m = /^(?:Killed by|Te mató)\s+(.+)$/.exec(ev.description ?? "");
  return m ? m[1] : null;
};

/** El color de un puesto en la partida: MVP en marca, los últimos en derrota. */
const colorPuesto = (rank: number): string =>
  rank === 1 ? "var(--brand)" : rank >= 8 ? "var(--loss)" : "var(--text)";

/** Un chip píldora. `aria-pressed` es el estado; el CSS lo pinta. */
const Chip: React.FC<
  { on: boolean; small?: boolean } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type">
> = ({ on, small, className = "", ...rest }) => (
  <button
    type="button"
    aria-pressed={on}
    className={`pp-chip ${small ? "pp-chip--sm" : ""} ${className}`.trim()}
    {...rest}
  />
);

/**
 * Una ficha de "Explorar": una línea con el resumen y, al pulsarla, el cuerpo
 * entero DEBAJO, a todo el ancho de la rejilla.
 *
 * El cuerpo se queda montado aunque esté plegado (`hidden`): la ficha del
 * rango carga baremos y su resumen sale de esa carga, así que desmontarlo
 * sería volver a pedirlos en cada apertura.
 */
interface FichaProps {
  id: string;
  title: string;
  summary: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  /** Brillo de hallazgo (lo que descubrió el analizador). */
  sheen?: boolean;
  /** Sin nada que abrir: la ficha dice qué le falta y no se despliega. */
  disabled?: boolean;
  children?: React.ReactNode;
}
const Ficha: React.FC<FichaProps> = ({ id, title, summary, open, onToggle, sheen, disabled, children }) => {
  const bodyId = `pp-ex-${id}`;
  const titleId = `pp-ex-${id}-title`;
  return (
    <>
      <button
        type="button"
        className={`card pp-ex ${sheen ? "pp-ex--sheen" : ""} ${open ? "is-open" : ""}`.trim()}
        aria-expanded={disabled ? undefined : open}
        aria-controls={disabled ? undefined : bodyId}
        disabled={disabled}
        onClick={onToggle}
      >
        <span className="pp-ex-text">
          <span className="pp-ex-title" id={titleId}>{title}</span>
          <span className="u-meta">{summary}</span>
        </span>
        {!disabled && <ChevronRight size={16} className="pp-ex-chev" aria-hidden="true" />}
      </button>
      {!disabled && (
        <div id={bodyId} className="pp-ex-body" role="region" aria-labelledby={titleId} hidden={!open}>
          {children}
        </div>
      )}
    </>
  );
};

export const PatternsPanel: React.FC = () => {
  // La biblioteca sale del store compartido: si la galería ya la cargó, aquí
  // no hay segunda lectura de disco.
  const { matches, loaded: matchesLoaded } = useMatches();
  const [clips, setClips] = useState<ErrorClipMetadata[]>([]);
  const [zonas, setZonas] = useState<ZoneHistoryRow[]>([]);
  const { data: presion, error: pressureError, retry: retryPressure } = usePressureSummary("/patterns");
  const [forma, setForma] = useState<SeasonForm | null>(null);
  const [formaError, setFormaError] = useState<string | null>(null);
  /** Fuentes que no se pudieron leer. Se dicen en voz baja bajo la cabecera. */
  const [fuentesRotas, setFuentesRotas] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [rol, setRol] = useState<RoleFilter>("all");
  const [rango, setRango] = useState<Range>("all");
  const [fase, setFase] = useState<Phase>("all");
  const [hover, setHover] = useState<{ d: DeathPoint; left: number; top: number } | null>(null);
  /** Fichas de "Explorar" abiertas. Varias a la vez: plegar una para abrir
   *  otra obligaría a elegir entre dos comparaciones que se quieren juntas. */
  const [abiertas, setAbiertas] = useState<Set<string>>(() => new Set());
  const [benchResumen, setBenchResumen] = useState<BenchmarkSummary | null>(null);
  const t = useT();
  // La versión viva de Data Dragon. Estaba clavada a 14.1.1 aquí dentro, así
  // que el mapa era el de hace dos años y medio.
  const ddVersion = useDdragonVersion();
  const navigate = useNavigate();
  const setSelectedMatch = useAppStore((s) => s.setSelectedMatch);
  const setPendingSeek = useAppStore((s) => s.setPendingSeek);

  useEffect(() => {
    let alive = true;
    // Cada fuente falla por su cuenta y se apunta cuál. Antes las tres se
    // tragaban en un `catch(() => [])`: un fallo de lectura salía como "no hay
    // datos", que es lo mismo que se ve al empezar, y no había forma de
    // distinguir "aún no has grabado nada" de "no se ha podido leer".
    const fallos: string[] = [];
    const fallo = (que: string) => (e: unknown) => {
      console.error(que, e);
      fallos.push(que);
      return null;
    };
    Promise.all([
      getAllErrorClips().catch(fallo("Flagged errors")),
      getCameraZoneHistory().catch(fallo("Camera history")),
    ])
      .then(([cs, zs]) => {
        if (!alive) return;
        setClips(cs ?? []);
        setZonas(zs ?? []);
        setFuentesRotas(fallos);
      })
      .catch(console.error)
      .finally(() => alive && setLoading(false));
    // La forma de temporada va aparte: puede tardar (hasta 20 detalles de la
    // API la primera vez) y la página no tiene por qué esperarla.
    getSeasonForm()
      .then((f) => alive && setForma(f))
      // El motivo llega con un código estable delante ("no_key: …"): la
      // tarjeta de la predicción lo usa para decir qué falta, no solo callar.
      .catch((e) => alive && setFormaError(typeof e === "string" ? e : String(e)));
    return () => { alive = false; };
  }, []);

  // Los VODs importados no son partidas tuyas: mezclarlos falsearía el reloj.
  const own = useMemo(() => matches.filter((m) => !m.is_vod), [matches]);
  // El parche más reciente en el que jugaste. De la partida más nueva que lo
  // traiga: las viejas pueden no tenerlo (el backfill va partida a partida).
  const parcheActual = useMemo(() => {
    const con = own.filter((m) => m.patch).sort((a, b) => fechaMs(b) - fechaMs(a));
    return con.length ? (con[0].patch as string) : null;
  }, [own]);
  // El filtro de rol se aplica ANTES de agregar: mezclar el reloj de muertes de
  // support con el de jungla es exactamente el ruido que esta pantalla evita.
  const propias = useMemo(
    () => inRange(filterByRole(own, rol), rango, parcheActual),
    [own, rol, rango, parcheActual]
  );
  /** Los ids de la ventana: lo que traen otras fuentes se recorta con ellos. */
  const idsRango = useMemo(() => new Set(propias.map((m) => m.id)), [propias]);
  // El historial de zonas llega del backend con TODAS las partidas: aquí se
  // recorta a la misma ventana que el resto de la pantalla, o la ficha del
  // punto ciego contaría partidas que ninguna otra está contando.
  const zonasRango = useMemo(
    () => zonas.filter((z) => idsRango.has(z.match_id)),
    [zonas, idsRango]
  );
  const clock = useMemo(() => deathClock(propias), [propias]);
  const histo = useMemo(() => histograma(clock), [clock]);
  const cats = useMemo(() => errorCategories(clips), [clips]);
  const totalNotas = useMemo(() => cats.reduce((a, x) => a + x.count, 0), [cats]);
  const conf = confidenceOf(propias.length);
  const maxCat = useMemo(() => cats.reduce((a, c) => Math.max(a, c.count), 0), [cats]);

  // Todas tus muertes con sitio, de las partidas del filtro. La marca de muerte
  // de la timeline de Riot ya es sólo tuya y lleva coordenadas de mapa; el
  // asesino se recupera emparejándola con tu evento de muerte más cercano.
  const muertes = useMemo<DeathPoint[]>(() => {
    const out: DeathPoint[] = [];
    for (const m of propias) {
      const offset = m.video_offset ?? 0;
      const res = outcome(m.result);
      // Los eventos guardan el NOMBRE del asesino; su campeón está en el
      // scoreboard. Se resuelve aquí para que el tooltip diga "Kaisa" y no un
      // nick — y si la partida no está sincronizada, el nombre sigue valiendo.
      // Insensible a mayúsculas: la API en vivo guarda los nombres en minúscula
      // ("singed") y el scoreboard con su grafía real ("Singed").
      const campeonDe = new Map(
        (m.participants ?? []).map((p) => [p.name.trim().toLowerCase(), p.champion])
      );
      const eventosMuerte = m.events
        .filter((ev) => ev.type === "ChampionKill" && ev.subtype === "death")
        .map((ev) => {
          const nombre = killerOf(ev);
          return {
            time: ev.time,
            killer: nombre ? campeonDe.get(nombre.trim().toLowerCase()) ?? nombre : null,
          };
        });
      for (const tm of m.timeline_markers ?? []) {
        if (tm.event_type !== "death" || tm.position_x == null || tm.position_y == null) continue;
        // El marcador y el evento en directo son la misma muerte con relojes
        // distintos; a más de 15 s ya no es ella y mejor no inventar asesino.
        let killer: string | null = null;
        let mejor = 15;
        for (const ev of eventosMuerte) {
          const d = Math.abs(ev.time - tm.time);
          if (d < mejor && ev.killer) { mejor = d; killer = ev.killer; }
        }
        out.push({
          matchId: m.id,
          time: tm.time,
          gameSec: Math.max(0, tm.time - offset),
          x: tm.position_x,
          y: tm.position_y,
          result: res,
          killer,
        });
      }
    }
    return out;
  }, [propias]);

  const muertesFase = useMemo(
    () => muertes.filter((d) => inPhase(d.gameSec / 60, fase)),
    [muertes, fase]
  );

  const abrirPartida = (id: string, seek?: number) => {
    const m = matches.find((x) => x.id === id);
    if (!m) return;
    setSelectedMatch(m);
    if (seek != null) setPendingSeek(seek);
    navigate("/review");
  };
  const abrirMuerte = (d: DeathPoint) => abrirPartida(d.matchId, d.time);

  // Tu puesto, de la más antigua a la más nueva (para leerse como una línea).
  const puestos = useMemo(
    () =>
      propias
        .filter((m) => m.impact_rank != null)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-5),
    [propias]
  );

  // Cruce miradas ↔ muertes: se parten tus partidas por la mediana de
  // miradas/min y se comparan las muertes medias de cada mitad. No es
  // causalidad y la pantalla no la promete: es la comparación honesta que se
  // puede hacer con quince partidas.
  const cruceMiradas = useMemo(() => {
    const filas = propias
      .filter((m) => (m.camera_snaps?.length ?? 0) > 0 && m.game_duration > 60)
      .map((m) => ({
        ritmo: (m.camera_snaps!.length / m.game_duration) * 60,
        muertes: computeKDA(m.events).deaths,
      }));
    if (filas.length < 6) return null;
    const orden = [...filas].sort((a, b) => a.ritmo - b.ritmo);
    const mitad = Math.floor(orden.length / 2);
    const media = (xs: typeof filas) => xs.reduce((a, x) => a + x.muertes, 0) / xs.length;
    const pocaVista = media(orden.slice(0, mitad));
    const muchaVista = media(orden.slice(orden.length - mitad));
    if (muchaVista === 0) return null;
    return { pct: Math.round(((pocaVista - muchaVista) / muchaVista) * 100), n: filas.length };
  }, [propias]);

  // La predicción, con la forma de la CUENTA (grabadas o no).
  const prediccion = useMemo(
    () =>
      forma
        ? forecastRank(forma.games, forma.tier, forma.division, forma.lp, forma.avg_gain, forma.avg_loss)
        : null,
    [forma]
  );

  // La escalada: LP absoluto en la escalera, partida grabada a partida.
  const escalada = useMemo(() => {
    return propias
      .filter((m) => m.rank_lp != null && m.rank_tier)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((m) => ladderLp(m.rank_tier as string, m.rank_division, m.rank_lp as number));
  }, [propias]);

  // Tu pool: con quién juegas y con quién GANAS, del histórico grabado.
  const poolTodos = useMemo(() => {
    const por = new Map<string, { games: number; wins: number; k: number; d: number; a: number }>();
    for (const m of propias) {
      const e = por.get(m.champion) ?? { games: 0, wins: 0, k: 0, d: 0, a: 0 };
      e.games += 1;
      if (m.result === "Victory") e.wins += 1;
      const kda = (m.kda ?? "").split("/").map(Number);
      if (kda.length === 3 && kda.every((x) => !Number.isNaN(x))) {
        e.k += kda[0]; e.d += kda[1]; e.a += kda[2];
      }
      por.set(m.champion, e);
    }
    return [...por.entries()]
      .map(([champion, e]) => ({ champion, ...e, wr: e.wins / e.games }))
      .sort((a, b) => b.games - a.games);
  }, [propias]);
  const pool = useMemo(() => poolTodos.slice(0, 6), [poolTodos]);

  // Tus rivales de carril: el espejo de índice, agregado.
  const rivales = useMemo(() => {
    const por = new Map<string, { games: number; losses: number }>();
    for (const m of propias) {
      const ps = m.participants;
      if (!ps || ps.length !== 10) continue;
      const idx = ps.findIndex((p) => p.is_self);
      if (idx < 0) continue;
      const rival = ps[(idx + 5) % 10];
      const e = por.get(rival.champion) ?? { games: 0, losses: 0 };
      e.games += 1;
      if (m.result !== "Victory") e.losses += 1;
      por.set(rival.champion, e);
    }
    return [...por.entries()]
      .map(([champion, e]) => ({ champion, ...e, wr: (e.games - e.losses) / e.games }))
      .filter((r) => r.games >= 1)
      .sort((a, b) => b.losses - a.losses || b.games - a.games)
      .slice(0, 6);
  }, [propias]);

  // Cruce oro@15 ↔ resultado.
  const cruceOro = useMemo(() => {
    const con = propias.filter((m) => m.gold_diff_15 != null);
    const g = (xs: MatchMetadata[]) =>
      xs.length ? xs.reduce((a, m) => a + (m.gold_diff_15 ?? 0), 0) / xs.length : null;
    const vic = g(con.filter((m) => m.result === "Victory"));
    const der = g(con.filter((m) => m.result !== "Victory"));
    if (vic === null || der === null || con.length < 6) return null;
    return { vic: Math.round(vic), der: Math.round(der), n: con.length };
  }, [propias]);

  // El punto ciego en una línea: el carril con el hueco medio más largo, y
  // cómo ha ido de la mitad vieja de la ventana a la nueva. Es la fila que
  // dice si entrenar ese carril está sirviendo, así que el resumen enseña el
  // cambio y no solo el valor.
  const resumenCiego = useMemo(() => {
    if (zonasRango.length < 3) return null;
    const orden = [...zonasRango].sort((a, b) => a.date.localeCompare(b.date));
    const medias = SIDE_LANES.map((_, i) => orden.reduce((a, z) => a + z.gaps[i], 0) / orden.length);
    const peor = medias.indexOf(Math.max(...medias));
    const mitad = Math.floor(orden.length / 2);
    const media = (xs: ZoneHistoryRow[]) => xs.reduce((a, z) => a + z.gaps[peor], 0) / xs.length;
    return { lane: SIDE_LANES[peor], de: media(orden.slice(0, mitad)), a: media(orden.slice(mitad)), n: orden.length };
  }, [zonasRango]);

  const toggle = (id: string) =>
    setAbiertas((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  if (loading || !matchesLoaded) {
    return (
      <div className="pp panel-enter">
        <div className="pp-center"><div className="spinner" /></div>
      </div>
    );
  }

  // El estado vacío global solo cuando de verdad no hay nada que agregar. Con
  // un rol filtrado a cero, la página sigue en pie (y el filtro, a la vista)
  // para poder volver a "Todos".
  if (rol === "all" && rango === "all" && clock.total === 0) {
    return (
      <div className="pp panel-enter">
        <header className="pp-head">
          <h1>{t("Patterns")}</h1>
        </header>
        <EmptyState
          icon={<BarChart3 size={30} color="var(--faint)" />}
          title={t("Not enough games yet")}
          text={t("Once a few games are recorded, this screen starts showing what they have in common.")}
        />
      </div>
    );
  }

  const c = CONFIDENCE_COPY[conf];
  const codigoForma = formaError ? formaError.split(":")[0].trim() : null;
  const signo = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n)}`;

  /**
   * Una ficha que no llega al umbral no desaparece: dice cuánto le falta.
   *
   * Desaparecer es lo peor que puede hacer, porque no se distingue de un fallo
   * ni de un dato que la app no recoge — y desde fuera parece que la pantalla
   * cambia de contenido al azar cada vez que grabas.
   */
  const faltan = (n: number) =>
    // Una entrada aparte para el singular: "Faltan 1 partidas" es el plural
    // sin concordancia que delata una plantilla.
    Math.max(1, n) === 1 ? t("Needs 1 more game") : t("Needs {n} more games", { n: Math.max(1, n) });

  // ------------------------------------------------ resúmenes de las fichas
  const resumenRango: React.ReactNode = (() => {
    if (!benchResumen || benchResumen.kind === "loading") {
      return <span className="skeleton" style={{ display: "inline-block", width: 160, height: 10 }} />;
    }
    if (benchResumen.kind === "needs") {
      return benchResumen.n === 1
        ? t("Needs 1 more synced ranked game")
        : t("Needs {n} more synced ranked games", { n: benchResumen.n });
    }
    if (benchResumen.kind === "error") {
      return t("Couldn't load the benchmarks: {msg}", { msg: benchResumen.msg ?? t("no benchmarks came back") });
    }
    const [a, b] = benchResumen.strongest;
    const [cc, d] = benchResumen.weakest;
    return a && b && cc && d
      ? t("Strongest: {a} and {b} · weakest: {c} and {d}", {
          a: t(metricShort(a)), b: t(metricShort(b)), c: t(metricShort(cc)), d: t(metricShort(d)),
        })
      : `${benchResumen.games} ${t(benchResumen.games === 1 ? "game" : "games")}`;
  })();

  const resumenPool =
    pool.length < 2
      ? faltan(2 - propias.length)
      : `${pool.slice(0, 3).map((p) => `${p.champion} ${Math.round(p.wr * 100)}%`).join(" · ")} · ${t("{n} champions", { n: poolTodos.length })}`;

  const resumenCiegoTxt =
    resumenCiego === null
      ? faltan(3 - zonasRango.length)
      : `${t("{lane}: from {a} to {b} without a look across {n} games", {
          lane: laneLabel(resumenCiego.lane, t),
          a: mmss(resumenCiego.de),
          b: mmss(resumenCiego.a),
          n: resumenCiego.n,
        })} · ${t("the row that tells whether training works")}`;

  const resumenPresion = pressureError
    ? t("Couldn't load pressure evidence")
    : presion === null
      ? t("Measured from the enemy positions of your synced games. It appears once a few games have synced with Riot.")
      : presion.windows === 0
        ? presion.games > 0
          ? t("{games} games analysed; no qualifying episodes.", { games: presion.games })
          : t("Measured from the enemy positions of your synced games. It appears once a few games have synced with Riot.")
        : `${presion.windows} ${t("stretches")} · ${presion.towers} ${t("towers")} · ${Math.round(presion.gold / 1000)}k ${t("gold")} · ${t("associations, not credit")}`;

  const resumenCruces =
    cruceMiradas === null && cruceOro === null
      ? faltan(6 - propias.length)
      : `${
          cruceOro !== null
            ? t("Gold @15: {vic} in wins, {der} in losses", { vic: signo(cruceOro.vic), der: signo(cruceOro.der) })
            : cruceMiradas!.pct > 0
              ? t("In your low map-checking games you die {pct}% more than in the high ones ({n} games).", { pct: cruceMiradas!.pct, n: cruceMiradas!.n })
              : t("Your deaths barely change with how much you check the map ({n} games).", { n: cruceMiradas!.n })
        } · ${t("comparisons, not causes")}`;

  const resumenNotas =
    totalNotas === 0
      ? t("No notes yet")
      : `${totalNotas} ${t("notes")} · ${cats.map((x) => `${t(x.category)} ${x.count}`).join(" · ")}`;

  return (
    <div className="pp panel-enter">
      {/* ------------------------------------------------------ cabecera */}
      <header className="pp-head">
        <h1>{t("Patterns")}</h1>
        <span className="pp-sub">
          {propias.length} {t("games")} · {clock.total} {t("deaths")} · {t("{w}W {l}L", { w: clock.wins, l: clock.losses })}
        </span>
        {/* Cuánto aguanta la muestra. Con pocas partidas se dice en azul de
            hallazgo; con muchas, en gris; con la muestra sólida, nada: es lo
            que se da por supuesto. */}
        {c.under && (
          <span className={`pp-badge ${conf === "low" ? "pp-badge--flag" : "pp-badge--quiet"}`} title={t(c.note)}>
            {t(c.label)} · {t(c.under)}
          </span>
        )}
        {/* En voz baja, pero dicho: un panel que se queda vacío por un fallo de
            lectura es indistinguible de uno que se queda vacío por falta de
            datos, y esa duda contamina todo lo demás de la pantalla. */}
        {fuentesRotas.length > 0 && (
          <span className="u-meta pp-broken">
            {t("Couldn't load: {what}", { what: fuentesRotas.map((f) => t(f)).join(", ") })}
          </span>
        )}
      </header>

      {/* Filtros: cada agregado de abajo se recalcula solo con las partidas
          jugadas en ese puesto Y dentro de esa ventana temporal. */}
      <div className="pp-chips" role="group" aria-label={t("Patterns")}>
        {ROLE_FILTERS.map((r) => (
          <Chip key={r.key} on={rol === r.key} onClick={() => setRol(r.key)}>
            {r.key === "all" ? t("All roles") : t(r.label)}
          </Chip>
        ))}
        <span className="pp-sep" aria-hidden="true" />
        {RANGES.map((r) => (
          <Chip
            key={r.key}
            on={rango === r.key}
            disabled={r.key === "patch" && !parcheActual}
            title={r.key === "patch" && parcheActual ? t("Patch {v}", { v: parcheActual }) : undefined}
            onClick={() => { setRango(r.key); setHover(null); }}
          >
            {t(r.label)}
          </Chip>
        ))}
      </div>

      {/* La ventana puede dejar la pantalla sin nada que agregar. Se dice, en
          vez de enseñar una rejilla de tarjetas vacías. */}
      {propias.length === 0 && (
        <p className="pp-prose">
          {t("No games in this window. Widen the range or clear the role filter.")}
        </p>
      )}

      {/* ======================================================== fila 1 */}
      <div className="pp-row1">
        {/* ------------------------------------------------ dónde mueres */}
        {/* El héroe de la página, y por eso lleva la aureola (una por
            pantalla): la pregunta con la que se entra aquí es "¿qué me está
            matando?", y el DÓNDE enseña más que el cuándo. */}
        <section className="card pp-card pp-hero" aria-label={t("Where you die")}>
          <div className="pp-where-text">
            <span className="u-label">{t("Where you die")} · {muertesFase.length} {t("deaths")}</span>
            {muertes.length === 0 ? (
              <p className="pp-prose">{t("Deaths get a map position when the game syncs with Riot.")}</p>
            ) : (
              <>
                {/* Selector de fase: el early y el late cuentan historias
                    distintas y mezclados se tapan. */}
                <div className="pp-chips pp-chips--sm">
                  {PHASES.map((p) => (
                    <Chip
                      key={p.key}
                      small
                      on={fase === p.key}
                      title={t(p.label)}
                      onClick={() => { setFase(p.key); setHover(null); }}
                    >
                      {t(p.short)}
                    </Chip>
                  ))}
                </div>
                <p className="pp-prose pp-prose--faint pp-where-hint">
                  {t("Each dot opens that game at that moment.")}
                </p>
              </>
            )}
          </div>
          {muertes.length > 0 && (
            <div className="pp-map">
              <img
                src={mapImageUrl(ddVersion)}
                alt=""
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              />
              {muertesFase.map((d, i) => {
                const left = Math.max(1, Math.min(99, (d.x / 14820) * 100));
                const top = Math.max(1, Math.min(99, (1 - d.y / 14881) * 100));
                return (
                  <span
                    key={`${d.matchId}-${d.time}-${i}`}
                    className="pp-dot"
                    style={{ left: `${left}%`, top: `${top}%` }}
                    role="button"
                    tabIndex={0}
                    aria-label={t("Open this death in the player")}
                    onMouseEnter={() => setHover({ d, left, top })}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover({ d, left, top })}
                    onBlur={() => setHover(null)}
                    onClick={() => abrirMuerte(d)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); abrirMuerte(d); }
                    }}
                  />
                );
              })}
              {hover && (
                <div className="pp-tip" style={{ left: `${hover.left}%`, top: `${hover.top}%` }}>
                  <span className="u-metric">{mmss(hover.d.gameSec)}</span>
                  {hover.d.killer && <span> · {hover.d.killer}</span>}
                  <span
                    style={{
                      color:
                        hover.d.result === "victory"
                          ? "var(--win)"
                          : hover.d.result === "defeat"
                            ? "var(--loss)"
                            : "var(--faint)",
                    }}
                  >
                    {" · "}
                    {t(
                      hover.d.result === "victory"
                        ? "victory"
                        : hover.d.result === "defeat"
                          ? "defeat"
                          : "no result"
                    )}
                  </span>
                </div>
              )}
            </div>
          )}
        </section>

        {/* ------------------------------------------------ cuándo mueres */}
        <section className="card pp-card" aria-label={t("When you die")}>
          <span className="u-label">{t("When you die")} · {t("by minute of game")}</span>
          <div className="pp-bars" aria-hidden="true">
            {histo.tramos.map((b) => {
              const hot = histo.peak !== null && b.from === histo.peak.from;
              return (
                <div
                  key={b.from}
                  className={`pp-bar ${hot ? "is-hot" : ""}`.trim()}
                  style={{ height: `${histo.max ? (b.total / histo.max) * 100 : 0}%` }}
                  title={t("{total} deaths · {w} in wins, {l} in losses", { total: b.total, w: b.inWins, l: b.inLosses })}
                >
                  <i>{b.total}</i>
                </div>
              );
            })}
          </div>
          <div className="pp-axis u-meta">
            {histo.tramos.map((b) => (
              <span key={b.from} className={histo.peak !== null && b.from === histo.peak.from ? "is-hot" : undefined}>
                {b.to === null ? `${b.from}+` : b.from}
              </span>
            ))}
          </div>
          {histo.peak && (
            <p className="pp-prose">
              {histo.peak.to === null
                ? t("From minute {a} on is your worst window.", { a: histo.peak.from })
                : t("Minute {a}–{b} is your worst window.", { a: histo.peak.from, b: histo.peak.to })}{" "}
              {t("{n} of your {total} deaths land there ({pct}%).", {
                n: histo.peak.total,
                total: clock.total,
                pct: Math.round((histo.peak.total / clock.total) * 100),
              })}
            </p>
          )}
          {clock.deathsPerWin !== null && clock.deathsPerLoss !== null && (
            <div className="pp-split">
              <div>
                <span className="u-metric">{clock.deathsPerWin.toFixed(1)}</span>
                <div className="u-label">{t("deaths per win")}</div>
              </div>
              <div>
                <span className="u-metric">{clock.deathsPerLoss.toFixed(1)}</span>
                <div className="u-label">{t("deaths per loss")}</div>
              </div>
            </div>
          )}
        </section>

        {/* ------------------------------------------- escalada y puesto */}
        <div className="pp-side">
          {/* Tu escalada: dónde estás y hacia dónde vas, con la forma de la
              CUENTA (grabadas o no). Cuenta por qué no está en vez de
              desaparecer: sin clave, con la clave caducada o con poca muestra. */}
          <section className="card pp-card" aria-label={t("Your climb")}>
            <div className="pp-cardhead">
              <span className="u-label">{t("Your climb")}</span>
              {forma && (
                <span className="u-meta">
                  {t("your last {n} ranked games, recorded or not", { n: forma.games.length })}
                </span>
              )}
            </div>
            {forma?.tier ? (
              <div className="pp-bigv-row">
                <img src={rankIcon(forma.tier)} alt="" />
                <span className="pp-bigv">{rankLabel(forma.tier, forma.division)}</span>
              </div>
            ) : (
              !codigoForma && !forma && (
                <span className="skeleton" style={{ display: "inline-block", width: 180, height: 32 }} />
              )
            )}
            {prediccion && forma?.tier && (
              <>
                <div className="pp-climb-row">
                  <span className="u-metric">{forma.lp} LP</span>
                  <span className="u-meta">→</span>
                  <img src={rankIcon(prediccion.pred.tier)} alt="" />
                  <span>{rankLabel(prediccion.pred.tier, prediccion.pred.division)}</span>
                  <span className="u-meta">{t("in ~20 games")}</span>
                </div>
                <p
                  className="u-meta"
                  title={t("Record and performance, blended: your score inside each lobby corrects the winrate (losing while outplaying projects up). LP swings measured from your own games. It points, it doesn't promise.")}
                >
                  {t("{w}W {l}L", { w: prediccion.wins, l: prediccion.losses })}
                  {prediccion.avgScore != null && ` · ${Math.round(prediccion.avgScore)} ${t("score")}`}
                  {" · "}
                  <span style={{ color: prediccion.netPerGame >= 0 ? "var(--win)" : "var(--loss)" }}>
                    {prediccion.netPerGame >= 0 ? "+" : "−"}{Math.abs(prediccion.netPerGame).toFixed(1)} LP
                  </span>{" "}
                  {t("per game at this pace")}. {t("It points, it doesn't promise.")}
                </p>
              </>
            )}
            {!prediccion && (codigoForma === "no_key" || codigoForma === "key_invalid") && (
              <div className="pp-climb-aviso">
                <p className="pp-prose">
                  {t(
                    codigoForma === "no_key"
                      ? "The rank forecast needs your Riot API key."
                      : "Your Riot API key is invalid or has expired."
                  )}
                </p>
                <Button variant="ghost" size="sm" onClick={() => navigate("/settings")}>
                  {t("Go to Settings to set up the Riot API key")}
                </Button>
              </div>
            )}
            {!prediccion && codigoForma === "rate_limited" && (
              <p className="pp-prose">
                {t("Riot is rate limiting requests right now; the forecast retries on the next visit.")}
              </p>
            )}
            {/* Un fallo que no es ninguno de los conocidos: se dice con la misma
                frase que las otras fuentes rotas, en vez de dejar la tarjeta
                con la etiqueta sola. */}
            {!prediccion && codigoForma && !["no_key", "key_invalid", "rate_limited"].includes(codigoForma) && (
              <p className="pp-prose pp-prose--faint">
                {t("Couldn't load: {what}", { what: t("Rank forecast") })}
              </p>
            )}
            {!prediccion && !codigoForma && forma && forma.games.length < 8 && (
              <p className="pp-prose">
                {t("At least 8 ranked games are needed to compute the projection ({n} so far).", {
                  n: forma.games.length,
                })}
              </p>
            )}
            {escalada.length >= 3 && (() => {
              const min = Math.min(...escalada);
              const max = Math.max(...escalada);
              const span = Math.max(1, max - min);
              const W = 200;
              const H = 36;
              const pts = escalada
                .map((v, i) => `${((i / (escalada.length - 1)) * W).toFixed(1)},${(H - 4 - ((v - min) / span) * (H - 8)).toFixed(1)}`)
                .join(" ");
              const sube = escalada[escalada.length - 1] >= escalada[0];
              return (
                <div>
                  <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="pp-climb-spark" aria-hidden="true">
                    <polyline points={pts} fill="none" stroke={sube ? "var(--win)" : "var(--loss)"} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                  </svg>
                  <span className="u-meta">
                    {t("your climb, LP across {n} recorded games", { n: escalada.length })}
                  </span>
                </div>
              );
            })()}
          </section>

          {/* Tu puesto, las últimas cinco partidas de la ventana. */}
          <section className="card pp-card" aria-label={t("Your rank, last 5")}>
            <span className="u-label">{t("Your rank, last 5")}</span>
            {puestos.length === 0 ? (
              <p className="pp-prose">{t("Ranks appear as games sync with Riot.")}</p>
            ) : (
              <div className="pp-rk-row">
                {puestos.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    className="pp-rk"
                    title={`${m.champion} · ${m.date} · ${t("Open this game")}`}
                    onClick={() => abrirPartida(m.id)}
                  >
                    {/* "#3" y no "3º": el ordinal español no se lee en inglés. */}
                    <b style={{ color: colorPuesto(m.impact_rank as number) }}>
                      {m.impact_rank === 1 ? "MVP" : `#${m.impact_rank}`}
                    </b>
                    <span className="u-meta">{m.champion}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* ======================================================= explorar */}
      <div className="pp-explore-head">
        <span className="u-label">{t("Explore")}</span>
        <span className="u-meta">{t("each card opens in full when clicked")}</span>
      </div>
      <div className="pp-explore">
        {/* ------------------------------------- contra tu propio rango */}
        <Ficha
          id="rango"
          title={t("Versus your rank")}
          summary={resumenRango}
          open={abiertas.has("rango")}
          onToggle={() => toggle("rango")}
        >
          <RankBenchmarkCard matches={propias} roleFilter={rol} onSummary={setBenchResumen} />
        </Ficha>

        {/* ------------------------------------------ tu pool y tus rivales */}
        <Ficha
          id="pool"
          title={t("Your pool")}
          summary={resumenPool}
          open={abiertas.has("pool")}
          onToggle={() => toggle("pool")}
          disabled={pool.length < 2}
        >
          <div className="pp-two">
            <div className="card pp-card">
              <div className="pp-cardhead">
                <span className="u-label">{t("Your pool")}</span>
                <span className="u-meta">{t("who you actually win with")}</span>
              </div>
              <div>
                {pool.map((p) => (
                  <div key={p.champion} className="pp-list-row">
                    <ChampionAvatar champion={p.champion} size={22} />
                    <span className="pp-list-name">{p.champion}</span>
                    <span className="u-meta">{p.games} {t(p.games === 1 ? "game" : "games")}</span>
                    <span
                      className="u-metric"
                      style={{ marginLeft: "auto", color: p.wr >= 0.5 ? "var(--win)" : "var(--loss)", fontWeight: 500 }}
                    >
                      {Math.round(p.wr * 100)}%
                    </span>
                    <span className="u-meta" style={{ width: 74, textAlign: "right" }}>
                      {p.d > 0 ? ((p.k + p.a) / p.d).toFixed(1) : "∞"} KDA
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="card pp-card">
              <div className="pp-cardhead">
                <span className="u-label">{t("Your rivals")}</span>
                <span className="u-meta">{t("the lane opponents that beat you")}</span>
              </div>
              {rivales.length < 2 ? (
                <p className="pp-prose pp-prose--faint">{faltan(2 - rivales.length)}</p>
              ) : (
                <div>
                  {rivales.map((r) => (
                    <div key={r.champion} className="pp-list-row">
                      <ChampionAvatar champion={r.champion} size={22} />
                      <span className="pp-list-name">vs {r.champion}</span>
                      <span className="u-meta">{r.games} {t(r.games === 1 ? "game" : "games")}</span>
                      <span
                        className="u-metric"
                        style={{ marginLeft: "auto", color: r.wr >= 0.5 ? "var(--win)" : "var(--loss)", fontWeight: 500 }}
                      >
                        {Math.round(r.wr * 100)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Ficha>

        {/* --------------------------------------- el punto ciego, por partida */}
        <Ficha
          id="ciego"
          title={t("Blind spot, game by game")}
          summary={resumenCiegoTxt}
          sheen
          open={abiertas.has("ciego")}
          onToggle={() => toggle("ciego")}
          disabled={resumenCiego === null}
        >
          {resumenCiego !== null && (() => {
            const filas = zonasRango.slice(-12);
            const peorDe = (g: [number, number, number]) => g.indexOf(Math.max(...g));
            return (
              <div className="card pp-card pp-sheen">
                <div className="pp-cardhead">
                  <span className="u-label">{t("Blind spot, game by game")}</span>
                  <span className="u-meta">{t("longest stretch without a look, per lane")}</span>
                </div>
                <div className="pp-zone">
                  <span />
                  {/* Los tres carriles de línea, del helper compartido. */}
                  {SIDE_LANES.map((l) => (
                    <span key={l} className="u-label" style={{ textAlign: "right" }}>{laneLabel(l, t)}</span>
                  ))}
                  {filas.map((z) => {
                    const peor = peorDe(z.gaps);
                    return (
                      <React.Fragment key={z.match_id}>
                        <span className="u-meta">{z.date.slice(5, 10)}</span>
                        {z.gaps.map((g, i) => (
                          <span
                            key={i}
                            className="u-metric"
                            style={{ textAlign: "right", color: i === peor ? "var(--loss)" : "var(--muted)" }}
                          >
                            {mmss(g)}
                          </span>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </div>
                <p className="pp-prose pp-prose--faint">
                  {t("This is the row to watch after training a lane: it is the only screen that can tell whether it is working.")}
                </p>
              </div>
            );
          })()}
        </Ficha>

        {/* -------------------------------------- lo que compra tu presencia.
            El backend lo agrega sobre TODA la biblioteca (sale de la caché de
            Riot, no de la metadata que hay aquí), así que es la única ficha
            que la ventana temporal no puede recortar. Se dice en la cabecera
            en vez de fingir que sigue el filtro. */}
        <Ficha
          id="presion"
          title={t("Pressure you absorbed")}
          summary={resumenPresion}
          open={abiertas.has("presion")}
          onToggle={() => toggle("presion")}
        >
          {presion === null || presion.windows === 0 ? (
            <div className="card pp-card">
              <div className="pp-cardhead">
                <span className="u-label">{t("Pressure you absorbed")}</span>
              </div>
              <p className="pp-prose pp-prose--faint">{resumenPresion}</p>
              {pressureError && (
                <div>
                  <Button variant="ghost" size="sm" onClick={retryPressure}>{t("Retry")}</Button>
                </div>
              )}
            </div>
          ) : (
            <div className="card pp-card">
              <div className="pp-cardhead">
                <span className="u-label">{t("Pressure you absorbed")}</span>
                <span className="u-meta">{presion.games} {t("games")} · {t("all time")}</span>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span className="u-metric" style={{ fontSize: 22, color: "var(--win)" }}>
                  {presion.with_gains} / {presion.windows}
                </span>
                <span className="u-meta">{t("Episodes with observed gains")}</span>
              </div>
              <p className="pp-prose">
                {presion.windows} {t("stretches")} · {presion.towers} {t("towers")} · {Math.round(presion.gold / 1000)}k {t("gold")}
              </p>
              <p className="u-meta">{t("Benefits are associations, not personal credit.")}</p>
            </div>
          )}
        </Ficha>

        {/* ------------------------------------------------ cruces honestos */}
        <Ficha
          id="cruces"
          title={t("Crossings")}
          summary={resumenCruces}
          sheen
          open={abiertas.has("cruces")}
          onToggle={() => toggle("cruces")}
          disabled={cruceMiradas === null && cruceOro === null}
        >
          <div className="card pp-card pp-sheen">
            <div className="pp-cardhead">
              <span className="u-label">{t("Crossings")}</span>
              <span className="u-meta">{t(c.label)}</span>
            </div>
            {cruceMiradas !== null && (
              <p className="pp-prose">
                {cruceMiradas.pct > 0
                  ? t("In your low map-checking games you die {pct}% more than in the high ones ({n} games).", { pct: cruceMiradas.pct, n: cruceMiradas.n })
                  : t("Your deaths barely change with how much you check the map ({n} games).", { n: cruceMiradas.n })}
              </p>
            )}
            {cruceOro !== null && (
              <p className="pp-prose">
                {t("Gold @15 averages {vic} in your wins and {der} in your losses ({n} games).", {
                  vic: `${cruceOro.vic >= 0 ? "+" : ""}${cruceOro.vic}`,
                  der: `${cruceOro.der >= 0 ? "+" : ""}${cruceOro.der}`,
                  n: cruceOro.n,
                })}
              </p>
            )}
            <p className="pp-prose pp-prose--faint">
              {t("Comparisons, not causes: with this sample they point, they don't prove.")}
            </p>
          </div>
        </Ficha>

        {/* -------------------------------------------------- tus etiquetas */}
        <Ficha
          id="notas"
          title={t("What you flag yourself")}
          summary={resumenNotas}
          open={abiertas.has("notas")}
          onToggle={() => toggle("notas")}
        >
          <div className="card pp-card">
            <div className="pp-cardhead">
              <span className="u-label">{t("What you flag yourself")}</span>
              <span className="u-meta">{totalNotas} {t("notes")}</span>
            </div>
            {cats.length === 0 ? (
              <p className="pp-prose">
                {t("You haven't categorised any errors yet. The chart on the left comes from the recorded data; this one would come from your own reading of it.")}
              </p>
            ) : (
              <div className="pp-cats">
                {cats.map((x) => (
                  <div key={x.category} className="pp-cat">
                    <div style={{ minWidth: 0 }}>
                      {/* Se guardan en inglés (identificador del backend); se pintan traducidas. */}
                      <div className="pp-cat-label">{t(x.category)}</div>
                      <div className="pp-track">
                        <span
                          className="pp-fill"
                          style={{
                            width: `${maxCat ? (x.count / maxCat) * 100 : 0}%`,
                            background: CATEGORY_COLOR[x.category] ?? "var(--muted)",
                          }}
                        />
                      </div>
                    </div>
                    <span className="u-metric" style={{ fontSize: 11, textAlign: "right", color: "var(--muted)" }}>{x.count}</span>
                  </div>
                ))}
              </div>
            )}
            {/* La pantalla es honesta sobre su propia cobertura: si marcas poco,
                lo dice, en vez de presentar tres notas como si fueran un perfil. */}
            {clock.total > 0 && (
              <div className="pp-insight">
                <p className="pp-prose">
                  <span style={{ color: "var(--text)" }}>
                    {t("{n} notes across {total} deaths.", { n: totalNotas, total: clock.total })}
                  </span>{" "}
                  {t("The window above comes from the data, not from your reading of it. Flagging even one moment per game is what turns \"when\" into \"why\".")}
                </p>
              </div>
            )}
          </div>
        </Ficha>
      </div>
    </div>
  );
};
