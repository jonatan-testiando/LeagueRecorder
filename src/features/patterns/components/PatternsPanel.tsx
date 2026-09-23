import React, { useEffect, useMemo, useRef, useState } from "react";
import { usePressureSummary } from "../../player/usePressureSummary";
import { useNavigate } from "react-router-dom";
import { MatchEvent, MatchMetadata } from "../../../types";
import {
  deathClock,
  errorCategories,
  confidenceOf,
  sampleLabel,
  forecastRank,
  ladderLp,
  filterByRole,
  ROLE_FILTERS,
  type DeathClock,
  type RoleFilter,
  type Confidence,
} from "../../../core/patterns";
import { rankIcon, rankLabel } from "../../../core/ddragon";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { PositionIcon } from "../../../components/PositionIcon";
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
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import {
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  EyeOff,
  Flag,
  Gauge,
  GitCompareArrows,
  Map as MapIcon,
  Play,
  Swords,
  TrendingUp,
  Users,
} from "lucide-react";
import { useT } from "../../../core/LanguageProvider";
import { useAppStore, useMatches, type PlaylistItem } from "../../../store/useAppStore";
import {
  RankBenchmarkCard,
  RankBenchmarkTable,
  benchmarkSummaryText,
  useRankBenchmarks,
} from "./RankBenchmarkCard";
import { RiftMap, riftPercent, RIFT_SQUARE_PCT } from "./RiftMap";
import { hotSpots, RIFT_H, RIFT_W, type Side } from "../riftZones";
import { PressureBreakdown } from "./PressureBreakdown";
import { formatGold, formatSeconds } from "../../player/components/pressureFormat";
import { formatDecimal } from "../../../core/benchmarkFormat";
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
 * Estructura (rediseño «Post-partida», 2026-09): de datos a UNA acción.
 *  - Héroe: dónde mueres, sobre la Grieta, con el peor tramo como filtro.
 *  - Derecha: tu foco (el peor tramo en una frase y la acción oro: ver esas
 *    muertes seguidas, partida tras partida) y tu última partida frente a tu
 *    rango, con la palanca que más rinde.
 *  - Explorar: el resto, en fichas de una línea que se abren enteras debajo.
 *
 * Los textos de cautela ("indicio", "comparaciones, no causas", "apunta, no
 * promete", "asociaciones, no mérito") se dicen UNA vez por tarjeta, en su
 * sitio discreto: el chip de muestra del foco, o la última línea del cuerpo de
 * cada ficha. Repetidos en cada resumen eran ruido y se dejaban de leer.
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

/**
 * Tramos de partida para el mapa. `worst` es el peor tramo de cinco minutos
 * del histograma: el mismo que nombra la tarjeta del foco, para poder VER en
 * el mapa las muertes de las que habla.
 */
type Phase = "all" | "early" | "mid" | "late" | "worst";
/** `short` es lo que cabe en el chip; `label` (con el rango) va en el title. */
const PHASES: { key: Exclude<Phase, "worst">; short: string; label: string }[] = [
  { key: "all", short: "All", label: "All" },
  { key: "early", short: "Early", label: "Early (<14m)" },
  { key: "mid", short: "Mid", label: "Mid (14–25m)" },
  { key: "late", short: "Late", label: "Late (>25m)" },
];
const inPhase = (gameMin: number, fase: Exclude<Phase, "worst">): boolean => {
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
  { key: "30d", label: "30 days" },
  { key: "last10", label: "Last 10" },
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

/** ¿Cae este minuto de partida en el tramo? */
const enTramo = (gameMin: number, tr: Tramo): boolean =>
  gameMin >= tr.from && (tr.to === null || gameMin < tr.to);

/** Una muerte tuya con sitio en el mapa, ya atada a su partida. */
interface DeathPoint {
  matchId: string;
  /** Segundo del VÍDEO (para saltar al reproductor). */
  time: number;
  /** Segundo de PARTIDA (para el tooltip y la fase). */
  gameSec: number;
  /** Posición normalizada: u de izquierda a derecha, v de abajo arriba. */
  u: number;
  v: number;
  side: Side;
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

/** Nombre → campeón, del scoreboard de la partida. Insensible a mayúsculas:
 *  la API en vivo guarda los nombres en minúscula ("singed") y el scoreboard
 *  con su grafía real ("Singed"). */
const campeonesDe = (m: MatchMetadata): Map<string, string> =>
  new Map((m.participants ?? []).map((p) => [p.name.trim().toLowerCase(), p.champion]));

/** El lado en que jugaste: 100 es el azul (abajo a la izquierda). */
const ladoDe = (m: MatchMetadata): Side => {
  const yo = m.participants?.find((p) => p.is_self);
  return yo?.team_id === 100 ? "blue" : yo?.team_id === 200 ? "red" : null;
};

/** Segundos de vídeo que cuesta ver una muerte de la lista (antes y después). */
const SEGUNDOS_POR_MUERTE = 16;

/** El color de un puesto en la partida: MVP en marca, los últimos en derrota. */
const colorPuesto = (rank: number): string =>
  rank === 1 ? "var(--brand)" : rank >= 8 ? "var(--loss)" : "var(--text)";

/** Un chip píldora. `aria-pressed` es el estado; el CSS lo pinta. */
const Chip: React.FC<
  { on: boolean } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type">
> = ({ on, className = "", ...rest }) => (
  <button type="button" aria-pressed={on} className={`pp-chip ${className}`.trim()} {...rest} />
);

/** El icono de "todas las posiciones", como el de relleno del cliente. */
const AllPositionsIcon: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 15 15 3" />
    <path d="M9 21 21 9" />
  </svg>
);

/**
 * El selector de posición: un botón con el icono de la calle y un menú.
 *
 * Seis píldoras en fila ocupaban media cabecera para una decisión que se toma
 * una vez; el menú deja la cabecera en una sola fila con el periodo.
 */
const PositionMenu: React.FC<{ value: RoleFilter; onChange: (r: RoleFilter) => void }> = ({ value, onChange }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const boton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const etiqueta = (k: RoleFilter) =>
    k === "all" ? t("All roles") : t(ROLE_FILTERS.find((r) => r.key === k)?.label ?? k);

  useEffect(() => {
    if (!open) return;
    // Al abrir, el foco va a la opción elegida: es la que se quiere cambiar.
    const sel = menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    sel?.focus();
    const fuera = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!menu.current?.contains(n) && !boton.current?.contains(n)) setOpen(false);
    };
    document.addEventListener("mousedown", fuera);
    return () => document.removeEventListener("mousedown", fuera);
  }, [open]);

  const elegir = (k: RoleFilter) => {
    onChange(k);
    setOpen(false);
    boton.current?.focus();
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); boton.current?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  };

  return (
    <div className="pp-posmenu">
      <button
        ref={boton}
        type="button"
        className="pp-posbtn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t("Position")}: ${etiqueta(value)}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); }
        }}
      >
        {value === "all" ? <AllPositionsIcon /> : <PositionIcon position={value} size={16} />}
        <span>{etiqueta(value)}</span>
        <ChevronDown size={14} className="pp-posbtn-chev" aria-hidden="true" />
      </button>
      {open && (
        <div ref={menu} className="pp-posmenu-list" role="menu" aria-label={t("Position")} onKeyDown={onMenuKey}>
          {ROLE_FILTERS.map((r) => (
            <button
              key={r.key}
              type="button"
              role="menuitemradio"
              aria-checked={value === r.key}
              tabIndex={-1}
              className="pp-posmenu-item"
              onClick={() => elegir(r.key)}
            >
              {r.key === "all" ? <AllPositionsIcon /> : <PositionIcon position={r.key} size={16} />}
              <span>{etiqueta(r.key)}</span>
              {value === r.key && <Check size={14} className="pp-posmenu-check" aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Una ficha de "Explorar": etiqueta, el valor en una frase y un chevron. Al
 * pulsarla, el cuerpo entero sale DEBAJO, a todo el ancho de la rejilla.
 *
 * El cuerpo se queda montado aunque esté plegado (`hidden`): así abrir y
 * cerrar no repite cargas ni pierde el estado de dentro.
 */
interface FichaProps {
  id: string;
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  /** Sin nada que abrir: la ficha dice qué le falta y no se despliega. */
  disabled?: boolean;
  children?: React.ReactNode;
}
const Ficha: React.FC<FichaProps> = ({ id, icon, label, value, open, onToggle, disabled, children }) => {
  const bodyId = `pp-ex-${id}`;
  const titleId = `pp-ex-${id}-title`;
  return (
    <>
      <button
        type="button"
        className={`pp-ex ${open ? "is-open" : ""}`.trim()}
        aria-expanded={disabled ? undefined : open}
        aria-controls={disabled ? undefined : bodyId}
        disabled={disabled}
        onClick={onToggle}
      >
        <span className="pp-ex-text">
          <span className="pp-ex-label" id={titleId}>
            {icon}
            <span>{label}</span>
          </span>
          <span className="pp-ex-value">{value}</span>
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
  const t = useT();
  const navigate = useNavigate();
  const setSelectedMatch = useAppStore((s) => s.setSelectedMatch);
  const setPendingSeek = useAppStore((s) => s.setPendingSeek);
  const startPlaylist = useAppStore((s) => s.startPlaylist);

  useEffect(() => {
    let alive = true;
    // Cada fuente falla por su cuenta y se apunta cuál. Un fallo de lectura no
    // puede salir como "no hay datos", que es lo mismo que se ve al empezar.
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
      // ficha de la escalada lo usa para decir qué falta, no solo callar.
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
  // recorta a la misma ventana que el resto de la pantalla.
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
  const bench = useRankBenchmarks(propias, rol);

  // Todas tus muertes con sitio, de las partidas del filtro. La marca de muerte
  // de la timeline de Riot ya es sólo tuya y lleva coordenadas de mapa; el
  // asesino se recupera emparejándola con tu evento de muerte más cercano.
  const muertes = useMemo<DeathPoint[]>(() => {
    const out: DeathPoint[] = [];
    for (const m of propias) {
      const offset = m.video_offset ?? 0;
      const res = outcome(m.result);
      const side = ladoDe(m);
      // Los eventos guardan el NOMBRE del asesino; su campeón está en el
      // scoreboard. Si la partida no está sincronizada, el nombre sigue valiendo.
      const campeonDe = campeonesDe(m);
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
          u: Math.max(0, Math.min(1, tm.position_x / RIFT_W)),
          v: Math.max(0, Math.min(1, tm.position_y / RIFT_H)),
          side,
          result: res,
          killer,
        });
      }
    }
    return out;
  }, [propias]);

  // El tramo de la fase elegida. "Todas" no resalta nada: es el mapa entero.
  const peak = histo.peak;
  const enFase = (d: DeathPoint): boolean =>
    fase === "worst" ? (peak ? enTramo(d.gameSec / 60, peak) : true) : inPhase(d.gameSec / 60, fase);
  const resaltadas = useMemo(
    () => muertes.filter((d) => enFase(d)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [muertes, fase, peak]
  );
  // Si el filtro de periodo o de puesto deja sin peor tramo, la fase vuelve a
  // "todas" en vez de quedarse apuntando a un tramo que ya no existe.
  useEffect(() => {
    if (fase === "worst" && !peak) setFase("all");
  }, [fase, peak]);
  const calientes = useMemo(() => hotSpots(resaltadas), [resaltadas]);
  const partidasConMapa = useMemo(() => new Set(muertes.map((d) => d.matchId)).size, [muertes]);

  const abrirPartida = (id: string, seek?: number) => {
    const m = matches.find((x) => x.id === id);
    if (!m) return;
    setSelectedMatch(m);
    if (seek != null) setPendingSeek(seek);
    navigate("/review");
  };
  const abrirMuerte = (d: DeathPoint) => abrirPartida(d.matchId, d.time);

  // La lista de reproducción del foco: todas las muertes del peor tramo, de
  // las partidas que conservan su vídeo, de la más reciente a la más vieja.
  // Salen de los EVENTOS (como el histograma), no de las marcas del mapa: el
  // número del botón tiene que ser el mismo que el de la frase de encima.
  const listaFoco = useMemo<PlaylistItem[]>(() => {
    if (!peak) return [];
    const items: (PlaylistItem & { fecha: number })[] = [];
    for (const m of propias) {
      if (!m.video_path) continue;
      const offset = m.video_offset ?? 0;
      const campeonDe = campeonesDe(m);
      for (const ev of m.events) {
        if (ev.type !== "ChampionKill" || ev.subtype !== "death") continue;
        if (!enTramo(Math.max(0, ev.time - offset) / 60, peak)) continue;
        const nombre = killerOf(ev);
        const killer = nombre ? campeonDe.get(nombre.trim().toLowerCase()) ?? nombre : null;
        items.push({
          matchId: m.id,
          time: ev.time,
          label: killer ? t("Killed by {champion}", { champion: killer }) : t("Death"),
          fecha: fechaMs(m),
        });
      }
    }
    items.sort((a, b) => b.fecha - a.fecha || a.time - b.time);
    return items.map(({ fecha: _f, ...it }) => it);
  }, [propias, peak, t]);

  const verFoco = () => {
    if (!peak || listaFoco.length === 0) return;
    const titulo =
      peak.to === null
        ? t("Deaths from minute {a}", { a: peak.from })
        : t("Deaths {a}–{b}", { a: peak.from, b: peak.to });
    startPlaylist(titulo, listaFoco);
    navigate("/review");
  };

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

  // Miradas al minimapa por minuto. El total sale de los saltos de cámara
  // grabados (todos, tengan carril o no); el reparto por carril, del historial
  // de zonas. Sin saltos grabados, el total se reconstruye de las zonas.
  const miradas = useMemo(() => {
    const dur = new Map(propias.map((m) => [m.id, m.game_duration]));
    let zLooks = 0;
    let zSecs = 0;
    let zN = 0;
    const porCarril = [0, 0, 0];
    for (const z of zonasRango) {
      const d = dur.get(z.match_id);
      if (!d || d < 60) continue;
      zLooks += z.looks[0] + z.looks[1] + z.looks[2];
      zSecs += d;
      zN += 1;
      z.looks.forEach((l, i) => { porCarril[i] += l; });
    }
    let sLooks = 0;
    let sSecs = 0;
    let sN = 0;
    for (const m of propias) {
      if (!m.camera_snaps?.length || m.game_duration < 60) continue;
      sLooks += m.camera_snaps.length;
      sSecs += m.game_duration;
      sN += 1;
    }
    if (sN === 0 && zN === 0) return null;
    return {
      perMin: sN > 0 ? (sLooks / sSecs) * 60 : (zLooks / zSecs) * 60,
      n: sN > 0 ? sN : zN,
      porCarril: zN > 0 ? porCarril.map((l) => (l / zSecs) * 60) : null,
    };
  }, [propias, zonasRango]);

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
  // dice si entrenar ese carril está sirviendo, así que enseña el cambio.
  const resumenCiego = useMemo(() => {
    if (zonasRango.length < 3) return null;
    const orden = [...zonasRango].sort((a, b) => a.date.localeCompare(b.date));
    const medias = SIDE_LANES.map((_, i) => orden.reduce((a, z) => a + z.gaps[i], 0) / orden.length);
    const peor = medias.indexOf(Math.max(...medias));
    const mitad = Math.floor(orden.length / 2);
    const media = (xs: ZoneHistoryRow[]) => xs.reduce((a, z) => a + z.gaps[peor], 0) / xs.length;
    return {
      lane: SIDE_LANES[peor],
      media: media(orden),
      de: media(orden.slice(0, mitad)),
      a: media(orden.slice(mitad)),
      n: orden.length,
    };
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
   * Desaparecer no se distingue de un fallo ni de un dato que la app no recoge.
   */
  const faltan = (n: number) =>
    Math.max(1, n) === 1 ? t("Needs 1 more game") : t("Needs {n} more games", { n: Math.max(1, n) });

  /** "EMERALD" + "II" → "Esmeralda II": el nombre del rango, traducido. */
  const rangoTxt = (tier: string, division?: string | null): string => {
    const base = rankLabel(tier, division) ?? tier;
    const nombre = tier.charAt(0) + tier.slice(1).toLowerCase();
    return base.replace(nombre, t(nombre));
  };

  const tramoTxt = (tr: Tramo) =>
    tr.to === null ? t("Minute {a}+", { a: tr.from }) : t("Minute {a}–{b}", { a: tr.from, b: tr.to });

  // ------------------------------------------------ valores de las fichas
  const valorCiego: React.ReactNode =
    resumenCiego === null ? (
      faltan(3 - zonasRango.length)
    ) : (
      <>
        <span className="pp-ex-strong">{laneLabel(resumenCiego.lane, t)}</span>
        <span className="pp-ex-soft">
          {" · "}
          {/* La media es la misma cifra que da Hoy; la tendencia va después y
              dicha como tal. "de 4:45 a 4:49 sin mirarla" se leía como un
              intervalo del reloj, no como antes y ahora. */}
          {t("{avg} without a look on average · was {a}, now {b}", {
            avg: mmss(resumenCiego.media),
            a: mmss(resumenCiego.de),
            b: mmss(resumenCiego.a),
          })}
        </span>
      </>
    );

  const valorMiradas: React.ReactNode =
    miradas === null ? (
      t("No camera data in this window")
    ) : (
      <>
        <span className="pp-ex-strong">{t("{x} per minute", { x: formatDecimal(miradas.perMin) })}</span>
        <span className="pp-ex-soft"> · {`${miradas.n} ${t(miradas.n === 1 ? "game" : "games")}`}</span>
      </>
    );

  const presionTxt = pressureError
    ? t("Couldn't load pressure evidence")
    : presion === null
      ? t("Measured from the enemy positions of your synced games. It appears once a few games have synced with Riot.")
      : presion.windows === 0
        ? presion.games > 0
          ? t("{games} games analysed; no qualifying episodes.", { games: presion.games })
          : t("Measured from the enemy positions of your synced games. It appears once a few games have synced with Riot.")
        : null;
  const valorPresion: React.ReactNode =
    presion !== null && presion.windows > 0 && !pressureError ? (
      <>
        <span className="pp-ex-strong">
          {t("{time} of enemy time per game", { time: formatSeconds(presion.enemy_seconds / Math.max(1, presion.games)) })}
        </span>
        <span className="pp-ex-soft">
          {" · "}{t("{gold} gold per game", { gold: formatGold(presion.net_gold / Math.max(1, presion.games), true) })}
        </span>
      </>
    ) : (
      presionTxt
    );

  const valorPool: React.ReactNode =
    pool.length < 2 ? (
      faltan(2 - propias.length)
    ) : (
      <span className="pp-ex-pool" title={pool.slice(0, 3).map((p) => `${p.champion} ${Math.round(p.wr * 100)}%`).join(" · ")}>
        <span className="pp-ex-faces">
          {pool.slice(0, 3).map((p) => (
            <ChampionAvatar key={p.champion} champion={p.champion} size={22} ring="var(--panel)" />
          ))}
        </span>
        <span className="pp-ex-strong">{pool.slice(0, 3).map((p) => p.champion).join(", ")}</span>
      </span>
    );

  const valorEscalada: React.ReactNode = forma?.tier ? (
    <span className="pp-ex-pool">
      <img src={rankIcon(forma.tier)} alt="" className="pp-ex-emblem" />
      <span className="pp-ex-strong pp-ex-keep">{rangoTxt(forma.tier, forma.division)}</span>
      <span className="pp-ex-soft">
        {" · "}{forma.lp} LP
        {prediccion && (
          <>
            {" · "}
            <span style={{ color: prediccion.netPerGame >= 0 ? "var(--win)" : "var(--loss)" }}>
              {prediccion.netPerGame >= 0 ? "+" : "−"}{formatDecimal(Math.abs(prediccion.netPerGame))} LP
            </span>
          </>
        )}
      </span>
    </span>
  ) : codigoForma === "no_key" ? (
    t("The rank forecast needs your Riot API key.")
  ) : codigoForma === "key_invalid" ? (
    t("Your Riot API key is invalid or has expired.")
  ) : codigoForma ? (
    t("Couldn't load: {what}", { what: t("Rank forecast") })
  ) : forma ? (
    t("At least 8 ranked games are needed to compute the projection ({n} so far).", { n: forma.games.length })
  ) : (
    <span className="skeleton" style={{ display: "inline-block", width: 140, height: 10 }} />
  );

  const valorCruces: React.ReactNode =
    cruceMiradas === null && cruceOro === null
      ? faltan(6 - propias.length)
      : cruceOro !== null
        ? t("Gold @15: {vic} in wins, {der} in losses", { vic: signo(cruceOro.vic), der: signo(cruceOro.der) })
        : cruceMiradas!.pct > 0
          ? t("In your low map-checking games you die {pct}% more than in the high ones ({n} games).", { pct: cruceMiradas!.pct, n: cruceMiradas!.n })
          : t("Your deaths barely change with how much you check the map ({n} games).", { n: cruceMiradas!.n });

  const valorNotas: React.ReactNode =
    totalNotas === 0 ? (
      t("No notes yet")
    ) : (
      <>
        <span className="pp-ex-strong">{totalNotas} {t("notes")}</span>
        <span className="pp-ex-soft"> · {cats.map((x) => `${t(x.category)} ${x.count}`).join(" · ")}</span>
      </>
    );

  const minutosFoco = Math.max(1, Math.round((listaFoco.length * SEGUNDOS_POR_MUERTE) / 60));
  const hot = calientes[0] ?? null;

  return (
    <div className="pp panel-enter">
      {/* ------------------------------------------------------ cabecera */}
      <header className="pp-head">
        <div className="pp-title">
          <h1>{t("Patterns")}</h1>
          <span className="pp-sub">
            {propias.length} {t("games")} · {clock.total} {t("deaths")} · {t("{w}W {l}L", { w: clock.wins, l: clock.losses })}
          </span>
        </div>
        {/* Filtros: cada agregado de abajo se recalcula solo con las partidas
            jugadas en ese puesto Y dentro de esa ventana temporal. */}
        <div className="pp-filters">
          <div className="pp-seg" role="group" aria-label={t("Period")}>
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
          <PositionMenu value={rol} onChange={(r) => { setRol(r); setHover(null); }} />
        </div>
        {/* En voz baja, pero dicho: un panel que se queda vacío por un fallo de
            lectura es indistinguible de uno que se queda vacío por falta de
            datos, y esa duda contamina todo lo demás de la pantalla. */}
        {fuentesRotas.length > 0 && (
          <span className="pp-meta pp-broken">
            {t("Couldn't load: {what}", { what: fuentesRotas.map((f) => t(f)).join(", ") })}
          </span>
        )}
      </header>

      {/* La ventana puede dejar la pantalla sin nada que agregar. Se dice, en
          vez de enseñar una rejilla de tarjetas vacías. */}
      {propias.length === 0 && (
        <p className="pp-prose">
          {t("No games in this window. Widen the range or clear the role filter.")}
        </p>
      )}

      {/* =================================================== fila principal */}
      <div className="pp-main">
        {/* ------------------------------------------------ dónde mueres */}
        <section className="card pp-hero" aria-labelledby="pp-hero-title">
          <div className="pp-hero-head">
            <div className="pp-hero-title">
              <h2 id="pp-hero-title">{t("Where you die")}</h2>
              <span className="pp-sub">
                {fase !== "all"
                  ? t("{n} of {total} deaths", { n: resaltadas.length, total: muertes.length })
                  : muertes.length === 1
                    ? t("1 death in 1 game")
                    : partidasConMapa === 1
                      ? t("{n} deaths in 1 game", { n: muertes.length })
                      : t("{n} deaths in {g} games", { n: muertes.length, g: partidasConMapa })}
                {/* Si faltan partidas respecto a la cabecera, se dice por qué: "99 en
                    23" junto a "26 partidas" parecía un error y eran 3 sin muertes. */}
                {fase === "all" && propias.length > partidasConMapa && partidasConMapa > 0 &&
                  ` · ${t("none recorded in the other {k}", { k: propias.length - partidasConMapa })}`}
              </span>
            </div>
            {muertes.length > 0 && (
              <div className="pp-phase" role="group" aria-label={t("Game phase")}>
                {PHASES.map((p) => (
                  <Chip
                    key={p.key}
                    on={fase === p.key}
                    title={t(p.label)}
                    onClick={() => { setFase(p.key); setHover(null); }}
                  >
                    {t(p.short)}
                  </Chip>
                ))}
                {/* El peor tramo: el mismo del foco, para ver en el mapa las
                    muertes de las que habla la frase de al lado. */}
                {peak && (
                  <Chip
                    on={fase === "worst"}
                    className="pp-chip--worst"
                    title={t("Your worst window")}
                    onClick={() => { setFase("worst"); setHover(null); }}
                  >
                    <span className="pp-chip-dot" aria-hidden="true" />
                    {tramoTxt(peak)}
                  </Chip>
                )}
              </div>
            )}
          </div>

          <div className="pp-rift-wrap">
            <div className="pp-rift">
              <RiftMap />
              {/* Zonas calientes: donde las muertes se aprietan, no donde hay más
                  sueltas. Se calculan sobre las que se ven resaltadas. */}
              {calientes.map((h, i) => {
                const { left, top } = riftPercent(h.u, h.v);
                return (
                  <span
                    key={i}
                    className="pp-halo"
                    aria-hidden="true"
                    style={{
                      left: `${left}%`,
                      top: `${top}%`,
                      width: `${RIFT_SQUARE_PCT * (i === 0 ? 0.4 : 0.32)}%`,
                    }}
                  />
                );
              })}
              {muertes.map((d, i) => {
                const { left, top } = riftPercent(d.u, d.v);
                const on = enFase(d);
                return (
                  <button
                    key={`${d.matchId}-${d.time}-${i}`}
                    type="button"
                    className={`pp-dot ${fase !== "all" ? (on ? "is-on" : "is-off") : ""}`.trim()}
                    style={{ left: `${left}%`, top: `${top}%` }}
                    tabIndex={on ? 0 : -1}
                    aria-hidden={on ? undefined : true}
                    aria-label={`${t("Open this death in the player")} · ${mmss(d.gameSec)}${d.killer ? ` · ${d.killer}` : ""}`}
                    onMouseEnter={() => on && setHover({ d, left, top })}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover({ d, left, top })}
                    onBlur={() => setHover(null)}
                    onClick={() => on && abrirMuerte(d)}
                  />
                );
              })}
              {hover && (
                <div
                  className="pp-tip"
                  style={{
                    left: `${hover.left}%`,
                    top: `${hover.top}%`,
                    // Cerca de un borde, el tooltip se aparta hacia dentro: el
                    // mapa recorta lo que se sale.
                    transform: `translate(${hover.left < 20 ? "-12%" : hover.left > 80 ? "-88%" : "-50%"}, ${
                      hover.top < 14 ? "14px" : "calc(-100% - 12px)"
                    })`,
                  }}
                >
                  <span className="pp-time">{mmss(hover.d.gameSec)}</span>
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
              {muertes.length === 0 && (
                <div className="pp-rift-empty">
                  <p className="pp-prose">{t("Deaths get a map position when the game syncs with Riot.")}</p>
                </div>
              )}
            </div>
          </div>

          {muertes.length > 0 && (
            <div className="pp-legend">
              <span className="pp-legend-item">
                <span className="pp-legend-dot" aria-hidden="true" />
                {t("Each dot opens that game at that moment.")}
              </span>
              {hot && (
                <span className="pp-legend-item">
                  <span className="pp-legend-halo" aria-hidden="true" />
                  <span>
                    {t("Hot zone:")} <span className="pp-legend-strong">{t(hot.name)}</span>
                  </span>
                </span>
              )}
            </div>
          )}
        </section>

        {/* --------------------------------------------- qué hacer con esto */}
        <div className="pp-side">
          {/* ------------------------------------------------ tu foco */}
          <section className="card pp-card pp-focus" aria-labelledby="pp-focus-title">
            <div className="pp-cardhead">
              <span className="pp-cap">{t("Your focus")}</span>
              {/* Cuánto aguanta la muestra, dicho UNA vez: aquí. Con la muestra
                  sólida no se dice nada, es lo que se da por supuesto. */}
              {c.under && (
                <span className={`pp-sample ${conf === "low" ? "pp-sample--low" : ""}`.trim()} title={t(c.note)}>
                  {sampleLabel(conf, propias.length, t)}
                </span>
              )}
            </div>
            {peak ? (
              <>
                <div className="pp-focus-text">
                  <h2 id="pp-focus-title" className="pp-focus-title">
                    {peak.to === null
                      ? t("You die the most from minute {a} on", { a: peak.from })
                      : t("You die the most between minute {a} and {b}", { a: peak.from, b: peak.to })}
                  </h2>
                  <p className="pp-prose pp-num">
                    {t("{n} of your {total} deaths land there ({pct}%).", {
                      n: peak.total,
                      total: clock.total,
                      pct: Math.round((peak.total / clock.total) * 100),
                    })}
                    {clock.deathsPerWin !== null && clock.deathsPerLoss !== null && (
                      <>
                        {" "}
                        {t("{w} deaths per win, {l} per loss.", {
                          w: formatDecimal(clock.deathsPerWin),
                          l: formatDecimal(clock.deathsPerLoss),
                        })}
                      </>
                    )}
                  </p>
                </div>
                <div className="pp-histo">
                  <div className="pp-bars" aria-hidden="true">
                    {histo.tramos.map((b) => {
                      const esPeor = b.from === peak.from;
                      return (
                        <div
                          key={b.from}
                          className={`pp-bar-col ${esPeor ? "is-hot" : ""}`.trim()}
                          title={t("{total} deaths · {w} in wins, {l} in losses", { total: b.total, w: b.inWins, l: b.inLosses })}
                        >
                          <span className="pp-bar-n">{b.total}</span>
                          {/* 18 px son la cifra de encima y su hueco. */}
                          <span
                            className="pp-bar"
                            style={{
                              height: `max(3px, calc(${histo.max ? (b.total / histo.max).toFixed(3) : 0} * (100% - 18px)))`,
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>
                  <div className="pp-axis" aria-hidden="true">
                    {histo.tramos.map((b) => (
                      <span key={b.from} className={b.from === peak.from ? "is-hot" : undefined}>
                        {b.to === null ? `${b.from}'+` : `${b.from}'`}
                      </span>
                    ))}
                  </div>
                </div>
                {/* La acción de la pantalla: las muertes del peor tramo, una
                    detrás de otra, partida tras partida. */}
                <button
                  type="button"
                  className="btn btn--primary pp-cta"
                  disabled={listaFoco.length === 0}
                  title={listaFoco.length === 0 ? t("The videos of these games are missing") : undefined}
                  onClick={verFoco}
                >
                  <Play size={14} fill="currentColor" aria-hidden="true" />
                  <span>
                    {listaFoco.length === 1
                      ? t("Watch the death")
                      : t("Watch the {n} deaths in a row", { n: listaFoco.length })}
                  </span>
                  {listaFoco.length > 0 && (
                    <span className="pp-cta-dur">~{t("{n} min", { n: minutosFoco })}</span>
                  )}
                </button>
              </>
            ) : (
              <p className="pp-prose">{t("No deaths in this window.")}</p>
            )}
          </section>

          {/* ------------------------------ tu última partida frente a tu rango */}
          <RankBenchmarkCard bench={bench} />
        </div>
      </div>

      {/* ======================================================= explorar */}
      <section className="pp-explore-wrap" aria-labelledby="pp-explore-title">
        <div className="pp-explore-head">
          <h2 id="pp-explore-title">{t("Explore")}</h2>
          <span className="pp-sub">
            {propias.length === 1
              ? t("More patterns from the same game")
              : t("More patterns from the same {n} games", { n: propias.length })}
          </span>
        </div>
        <div className="pp-explore">
          {/* --------------------------------------- el punto ciego, por partida */}
          <Ficha
            id="ciego"
            icon={<EyeOff size={14} aria-hidden="true" />}
            label={t("Blind spot")}
            value={valorCiego}
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
                    <h3 className="pp-cardtitle">{t("Blind spot, game by game")}</h3>
                    <span className="pp-meta">{t("longest stretch without a look, per lane")}</span>
                  </div>
                  <div className="pp-zone">
                    <span />
                    {SIDE_LANES.map((l) => (
                      <span key={l} className="pp-cap" style={{ textAlign: "right" }}>{laneLabel(l, t)}</span>
                    ))}
                    {filas.map((z) => {
                      const peor = peorDe(z.gaps);
                      return (
                        <React.Fragment key={z.match_id}>
                          <span className="pp-meta pp-num">{z.date.slice(5, 10)}</span>
                          {z.gaps.map((g, i) => (
                            <span
                              key={i}
                              className="pp-num"
                              style={{ textAlign: "right", color: i === peor ? "var(--loss)" : "var(--muted)" }}
                            >
                              {mmss(g)}
                            </span>
                          ))}
                        </React.Fragment>
                      );
                    })}
                  </div>
                  <p className="pp-note">
                    {t("This is the row to watch after training a lane: it is the only screen that can tell whether it is working.")}
                  </p>
                </div>
              );
            })()}
          </Ficha>

          {/* ------------------------------------------- miradas al minimapa */}
          <Ficha
            id="miradas"
            icon={<MapIcon size={14} aria-hidden="true" />}
            label={t("Minimap looks")}
            value={valorMiradas}
            open={abiertas.has("miradas")}
            onToggle={() => toggle("miradas")}
            disabled={miradas === null}
          >
            {miradas !== null && (
              <div className="card pp-card">
                <div className="pp-cardhead">
                  <h3 className="pp-cardtitle">{t("Minimap looks")}</h3>
                  <span className="pp-meta">{`${miradas.n} ${t(miradas.n === 1 ? "game" : "games")}`}</span>
                </div>
                <p className="pp-prose pp-num">
                  {t("You look at the map {x} times per minute.", { x: formatDecimal(miradas.perMin) })}
                </p>
                {miradas.porCarril && (() => {
                  const max = Math.max(...miradas.porCarril, 0.01);
                  return (
                    <div className="pp-cats">
                      {SIDE_LANES.map((l, i) => (
                        <div key={l} className="pp-cat">
                          <div style={{ minWidth: 0 }}>
                            <div className="pp-cat-label">{laneLabel(l, t)}</div>
                            <div className="pp-track">
                              <span
                                className="pp-fill"
                                style={{ width: `${(miradas.porCarril![i] / max) * 100}%`, background: "var(--cool)" }}
                              />
                            </div>
                          </div>
                          <span className="pp-num pp-cat-n">{formatDecimal(miradas.porCarril![i])}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                <p className="pp-note">{t("Looks per minute at each lane, from the camera jumps of your games.")}</p>
              </div>
            )}
          </Ficha>

          {/* -------------------------------------- lo que compra tu presencia.
              El backend lo agrega sobre TODA la biblioteca (sale de la caché de
              Riot, no de la metadata que hay aquí), así que es la única ficha
              que la ventana temporal no puede recortar. Se dice en su cuerpo
              en vez de fingir que sigue el filtro. */}
          <Ficha
            id="presion"
            icon={<Swords size={14} aria-hidden="true" />}
            label={t("Pressure you absorbed")}
            value={valorPresion}
            open={abiertas.has("presion")}
            onToggle={() => toggle("presion")}
          >
            {presion === null || presion.windows === 0 || pressureError ? (
              <div className="card pp-card">
                <div className="pp-cardhead">
                  <h3 className="pp-cardtitle">{t("Pressure you absorbed")}</h3>
                </div>
                <p className="pp-prose">{presionTxt}</p>
                {pressureError && (
                  <div>
                    <Button variant="ghost" size="sm" onClick={retryPressure}>{t("Retry")}</Button>
                  </div>
                )}
              </div>
            ) : (
              <PressureBreakdown summary={presion} onOpen={abrirPartida} />
            )}
          </Ficha>

          {/* ------------------------------------------ tu pool y tus rivales */}
          <Ficha
            id="pool"
            icon={<Users size={14} aria-hidden="true" />}
            label={t("Your pool")}
            value={valorPool}
            open={abiertas.has("pool")}
            onToggle={() => toggle("pool")}
            disabled={pool.length < 2}
          >
            <div className="pp-two">
              <div className="card pp-card">
                <div className="pp-cardhead">
                  <h3 className="pp-cardtitle">{t("Your pool")}</h3>
                  <span className="pp-meta">{t("who you actually win with")}</span>
                </div>
                <div>
                  {pool.map((p) => (
                    <div key={p.champion} className="pp-list-row">
                      <ChampionAvatar champion={p.champion} size={24} />
                      <span className="pp-list-name">{p.champion}</span>
                      <span className="pp-meta">{p.games} {t(p.games === 1 ? "game" : "games")}</span>
                      <span
                        className="pp-num"
                        style={{ marginLeft: "auto", color: p.wr >= 0.5 ? "var(--win)" : "var(--loss)", fontWeight: 500 }}
                      >
                        {Math.round(p.wr * 100)}%
                      </span>
                      <span className="pp-meta pp-num" style={{ width: 74, textAlign: "right" }}>
                        {p.d > 0 ? formatDecimal((p.k + p.a) / p.d) : "∞"} KDA
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="card pp-card">
                <div className="pp-cardhead">
                  <h3 className="pp-cardtitle">{t("Your rivals")}</h3>
                  <span className="pp-meta">{t("the lane opponents that beat you")}</span>
                </div>
                {rivales.length < 2 ? (
                  <p className="pp-prose pp-prose--faint">{faltan(2 - rivales.length)}</p>
                ) : (
                  <div>
                    {rivales.map((r) => (
                      <div key={r.champion} className="pp-list-row">
                        <ChampionAvatar champion={r.champion} size={24} />
                        <span className="pp-list-name">vs {r.champion}</span>
                        <span className="pp-meta">{r.games} {t(r.games === 1 ? "game" : "games")}</span>
                        <span
                          className="pp-num"
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

          {/* ------------------------------------------- escalada y puesto.
              Con la forma de la CUENTA (grabadas o no). Cuenta por qué no
              está en vez de desaparecer: sin clave, con la clave caducada o
              con poca muestra. */}
          <Ficha
            id="escalada"
            icon={<TrendingUp size={14} aria-hidden="true" />}
            label={t("Your climb")}
            value={valorEscalada}
            open={abiertas.has("escalada")}
            onToggle={() => toggle("escalada")}
          >
            <div className="pp-two">
              <section className="card pp-card" aria-label={t("Your climb")}>
                <div className="pp-cardhead">
                  <h3 className="pp-cardtitle">{t("Your climb")}</h3>
                  {forma && (
                    <span className="pp-meta">
                      {t("your last {n} ranked games, recorded or not", { n: forma.games.length })}
                    </span>
                  )}
                </div>
                {forma?.tier ? (
                  <div className="pp-bigv-row">
                    <img src={rankIcon(forma.tier)} alt="" />
                    <span className="pp-bigv">{rangoTxt(forma.tier, forma.division)}</span>
                  </div>
                ) : (
                  !codigoForma && !forma && (
                    <span className="skeleton" style={{ display: "inline-block", width: 180, height: 32 }} />
                  )
                )}
                {prediccion && forma?.tier && (
                  <>
                    <div className="pp-climb-row">
                      <span className="pp-num">{forma.lp} LP</span>
                      <span className="pp-meta">→</span>
                      <img src={rankIcon(prediccion.pred.tier)} alt="" />
                      <span>{rangoTxt(prediccion.pred.tier, prediccion.pred.division)}</span>
                      <span className="pp-meta">{t("in ~20 games")}</span>
                    </div>
                    <p
                      className="pp-prose pp-num"
                      title={t("Record and performance, blended: your score inside each lobby corrects the winrate (losing while outplaying projects up). LP swings measured from your own games. It points, it doesn't promise.")}
                    >
                      {t("{w}W {l}L", { w: prediccion.wins, l: prediccion.losses })}
                      {prediccion.avgScore != null && ` · ${Math.round(prediccion.avgScore)} ${t("score")}`}
                      {" · "}
                      <span style={{ color: prediccion.netPerGame >= 0 ? "var(--win)" : "var(--loss)" }}>
                        {prediccion.netPerGame >= 0 ? "+" : "−"}{formatDecimal(Math.abs(prediccion.netPerGame))} LP
                      </span>{" "}
                      {t("per game at this pace")}.
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
                {/* Un fallo que no es ninguno de los conocidos: se dice con la
                    misma frase que las otras fuentes rotas. */}
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
                      <span className="pp-meta">
                        {t("your climb, LP across {n} recorded games", { n: escalada.length })}
                      </span>
                    </div>
                  );
                })()}
                {prediccion && forma?.tier && (
                  <p className="pp-note">{t("It points, it doesn't promise.")}</p>
                )}
              </section>

              {/* Tu puesto, las últimas cinco partidas de la ventana. */}
              <section className="card pp-card" aria-label={t("Your rank, last 5")}>
                <h3 className="pp-cardtitle">{t("Your rank, last 5")}</h3>
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
                        <ChampionAvatar champion={m.champion} size={28} />
                        {/* "#3" y no "3º": el ordinal español no se lee en inglés. */}
                        <b style={{ color: colorPuesto(m.impact_rank as number) }}>
                          {m.impact_rank === 1 ? "MVP" : `#${m.impact_rank}`}
                        </b>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </Ficha>

          {/* ------------------------------ la media frente a tu rango */}
          <Ficha
            id="rango"
            icon={<Gauge size={14} aria-hidden="true" />}
            label={t("Versus your rank")}
            value={benchmarkSummaryText(bench, t)}
            open={abiertas.has("rango")}
            onToggle={() => toggle("rango")}
            disabled={bench.kind !== "ok"}
          >
            <RankBenchmarkTable bench={bench} />
          </Ficha>

          {/* ------------------------------------------------ cruces honestos */}
          <Ficha
            id="cruces"
            icon={<GitCompareArrows size={14} aria-hidden="true" />}
            label={t("Crossings")}
            value={valorCruces}
            open={abiertas.has("cruces")}
            onToggle={() => toggle("cruces")}
            disabled={cruceMiradas === null && cruceOro === null}
          >
            <div className="card pp-card pp-sheen">
              <div className="pp-cardhead">
                <h3 className="pp-cardtitle">{t("Crossings")}</h3>
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
              {/* Las dos cautelas de la ficha, juntas y en un solo sitio. */}
              <p className="pp-note">
                {sampleLabel(conf, propias.length, t)} · {t("Comparisons, not causes: with this sample they point, they don't prove.")}
              </p>
            </div>
          </Ficha>

          {/* -------------------------------------------------- tus etiquetas */}
          <Ficha
            id="notas"
            icon={<Flag size={14} aria-hidden="true" />}
            label={t("What you flag yourself")}
            value={valorNotas}
            open={abiertas.has("notas")}
            onToggle={() => toggle("notas")}
          >
            <div className="card pp-card">
              <div className="pp-cardhead">
                <h3 className="pp-cardtitle">{t("What you flag yourself")}</h3>
                <span className="pp-meta">{totalNotas} {t("notes")}</span>
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
                      <span className="pp-num pp-cat-n">{x.count}</span>
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
      </section>
    </div>
  );
};
