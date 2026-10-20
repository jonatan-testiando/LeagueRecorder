import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  getMatchPlays,
  getMinuteSeries,
  type MatchObjective,
  type MatchPlay,
  type MatchPlays,
  type MinuteSeries,
  type MinuteSeriesPlayer,
} from "../../../core/tauri-ipc";
import { useT } from "../../../core/LanguageProvider";
import { champLabel } from "../../../core/matchEvents";
import { clock } from "../../../core/time";
import { ChampFace, IconBaron, IconDragon, IconHerald, IconTower } from "./eventMeta";
import { formatGold, formatNumber, formatSigned } from "./pressureFormat";
import "./LeadChart.css";

/**
 * La ventaja minuto a minuto, con modos (fila 3.2 de docs/coach-de-macro-diseno.md).
 *
 * iTero enseña una curva por minuto con cuatro comparaciones y una franja de
 * objetivos. Aquí va lo mismo con dos cosas que ellos no tienen: el cabezal del
 * vídeo cruza la gráfica (lo que ves en pantalla está en la curva) y debajo va
 * la probabilidad de victoria con cada jugada como un punto que lleva al vídeo.
 *
 * Tres paneles con el mismo eje de tiempo y un solo cursor:
 *  1. La serie elegida (oro, XP, daño hecho o recibido) en el modo elegido.
 *     En los modos de diferencia, verde por encima de cero y rojo por debajo,
 *     como la curva del duelo de Impacto.
 *  2. La franja de objetivos: arriba los tuyos, abajo los suyos.
 *  3. La probabilidad de victoria de tu equipo. Va en su propio panel y no
 *     sobre la serie: son dos escalas y dos ejes en una gráfica se leen mal.
 *
 * Un solo reloj, el de la PARTIDA. Para el vídeo se suma `video_offset`.
 */

type Serie = "gold" | "xp" | "dealt" | "taken";
type Modo = "rival" | "enemyAvg" | "teams" | "all";

const SERIES: { key: Serie; label: string; floor: number }[] = [
  { key: "gold", label: "Gold", floor: 300 },
  { key: "xp", label: "XP", floor: 300 },
  { key: "dealt", label: "Damage dealt", floor: 1000 },
  { key: "taken", label: "Damage taken", floor: 1000 },
];

const MODOS: { key: Modo; label: string }[] = [
  { key: "rival", label: "Opponent" },
  { key: "enemyAvg", label: "Enemy avg." },
  { key: "teams", label: "Teams" },
  { key: "all", label: "All 10" },
];

/** La elección se recuerda al cambiar de partida mientras la app siga
 *  abierta: quien revisa el oro de su rival quiere verlo en la siguiente. */
let recordado: { serie: Serie; modo: Modo } = { serie: "gold", modo: "teams" };

/** ΔWP mínimo para que una jugada lleve punto en la curva. */
const MIN_PUNTO = 0.02;

/** Segundos de vídeo antes de un objetivo o una jugada desde los que se salta:
 *  los mismos que usa el Mapa, para ver cómo se llega y no sólo el final. */
const LEAD = 5;

// Geometría en unidades del viewBox. El alto es el real en píxeles (la
// gráfica no se estira en vertical), así que lo que va encima en HTML (puntos,
// iconos, etiquetas) se coloca con `top` en px y `left` en %.
const W = 600;
const H = 116;
const PAD = 8;
const WH = 84;
const WPAD = 6;

const serieDe = (p: MinuteSeriesPlayer, s: Serie): number[] =>
  s === "gold" ? p.gold : s === "xp" ? p.xp : s === "dealt" ? p.damage_dealt : p.damage_taken;

/** "+2,1k", "−850", "12,4k". Las cifras de eje y de lectura, cortas. */
function corto(v: number, signed: boolean): string {
  if (Math.abs(v) < 1000) return formatGold(v, signed);
  const s = formatSigned(v / 1000, 1);
  return `${signed ? s : s.replace(/^\+/, "")}k`;
}

/** Índice del fotograma más cercano a un minuto. */
function cercano(minutes: number[], m: number): number {
  let best = 0;
  for (let i = 1; i < minutes.length; i++) {
    if (Math.abs(minutes[i] - m) < Math.abs(minutes[best] - m)) best = i;
  }
  return best;
}

const DRAGONES: Record<string, string> = {
  FIRE_DRAGON: "Infernal Dragon",
  WATER_DRAGON: "Ocean Dragon",
  EARTH_DRAGON: "Mountain Dragon",
  AIR_DRAGON: "Cloud Dragon",
  HEXTECH_DRAGON: "Hextech Dragon",
  CHEMTECH_DRAGON: "Chemtech Dragon",
};

const CARRILES: Record<string, string> = { TOP_LANE: "Top lane", MID_LANE: "Mid lane", BOT_LANE: "Bot lane" };

type T = (key: string, vars?: Record<string, string | number>) => string;

function nombreObjetivo(o: MatchObjective, t: T): string {
  switch (o.kind) {
    case "dragon": return t(DRAGONES[o.detail ?? ""] ?? "Dragon");
    case "elder": return t("Elder Dragon");
    case "baron": return t("Baron Nashor");
    case "herald": return t("Rift Herald");
    case "grubs": return t("Void Grubs");
    case "atakhan": return t("Atakhan");
    case "inhibitor": return o.lane && CARRILES[o.lane] ? `${t("Inhibitor")} · ${t(CARRILES[o.lane])}` : t("Inhibitor");
    default: return o.lane && CARRILES[o.lane] ? `${t("Tower")} · ${t(CARRILES[o.lane])}` : t("Tower");
  }
}

// Glifos que no tiene eventMeta, con el mismo trazo que los suyos.
const Glyph: React.FC<{ size: number; children: React.ReactNode }> = ({ size, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
/** Larvas: tres cuerpos. */
const IconGrubs: React.FC<{ size: number }> = ({ size }) => (
  <Glyph size={size}>
    <circle cx="7" cy="14" r="3.2" />
    <circle cx="17" cy="14" r="3.2" />
    <circle cx="12" cy="8" r="3.2" />
  </Glyph>
);
/** Atakhan: cabeza con cuernos. */
const IconAtakhan: React.FC<{ size: number }> = ({ size }) => (
  <Glyph size={size}>
    <path d="M5 4c0 3 1.5 5 3.5 6M19 4c0 3-1.5 5-3.5 6" />
    <path d="M7 12c0-2.5 2.2-4 5-4s5 1.5 5 4v3c0 2.5-2.2 4.5-5 4.5S7 17.5 7 15v-3Z" />
    <path d="M10 13.5h.01M14 13.5h.01" />
  </Glyph>
);
/** Inhibidor: el cristal. */
const IconInhib: React.FC<{ size: number }> = ({ size }) => (
  <Glyph size={size}>
    <path d="M12 3.5 18 9l-6 11.5L6 9l6-5.5Z" />
    <path d="M6 9h12" />
  </Glyph>
);

function glifo(kind: MatchObjective["kind"]): React.ReactNode {
  switch (kind) {
    case "dragon": return <IconDragon size={12} />;
    case "elder": return <IconDragon size={14} />;
    case "baron": return <IconBaron size={14} />;
    case "herald": return <IconHerald size={12} />;
    case "grubs": return <IconGrubs size={11} />;
    case "atakhan": return <IconAtakhan size={13} />;
    case "inhibitor": return <IconInhib size={11} />;
    default: return <IconTower size={11} />;
  }
}

/** El nombre de una jugada para la lectura. */
function nombreJugada(p: MatchPlay, players: MinuteSeriesPlayer[], t: T): string {
  switch (p.kind) {
    // Una ejecución es una muerte sin campeón que remate (torre, súbdito o
    // monstruo): para quien la mira es lo mismo, alguien cae.
    case "kill":
    case "execution": {
      const v = players.find((x) => x.participant_id === p.victim);
      return v ? t("{champ} dies", { champ: champLabel(v.champion) }) : t("Kill");
    }
    case "tower": return t("Tower");
    case "inhibitor": return t("Inhibitor");
    case "plate": return t("Plate");
    case "dragon": return t("Dragon");
    case "elder": return t("Elder Dragon");
    case "baron": return t("Baron Nashor");
    case "herald": return t("Rift Herald");
    case "grubs": return t("Void Grubs");
    case "atakhan": return t("Atakhan");
    default: return p.kind;
  }
}

export interface LeadChartProps {
  matchId: string;
  /** Dónde va el vídeo (segundos de VÍDEO). Pinta el cabezal en la gráfica y,
   *  sin el ratón encima, la lectura de abajo es la de ese instante. */
  videoTime: number;
  /** vídeo − partida. */
  videoOffset: number;
  /** Saltar en el vídeo (segundos de PARTIDA). */
  onSeekGame: (gameSeconds: number) => void;
  /** Lo que se enseña si la partida no tiene timeline guardada (partidas
   *  sincronizadas antes de guardarla): la curva vieja del oro del equipo. */
  fallback?: React.ReactNode;
}

export const LeadChart: React.FC<LeadChartProps> = ({ matchId, videoTime, videoOffset, onSeekGame, fallback }) => {
  const t = useT();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [data, setData] = useState<MinuteSeries | null | undefined>(undefined);
  const [plays, setPlays] = useState<MatchPlays | null>(null);
  const [serie, setSerie] = useState<Serie>(recordado.serie);
  const [modo, setModo] = useState<Modo>(recordado.modo);
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const [hiPid, setHiPid] = useState<number | null>(null);
  const [hoverMin, setHoverMin] = useState<number | null>(null);
  const [hoverPlay, setHoverPlay] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let vivo = true;
    setData(undefined);
    setPlays(null);
    setHidden(new Set());
    getMinuteSeries(matchId)
      .then((d) => vivo && setData(d))
      .catch(() => vivo && setData(null));
    getMatchPlays(matchId).then((p) => vivo && setPlays(p));
    return () => {
      vivo = false;
    };
  }, [matchId]);

  useEffect(() => {
    recordado = { serie, modo };
  }, [serie, modo]);

  const ok = data && data.status === "ok" && data.minutes.length > 1 && data.players.length > 0;
  const me = ok ? data.players.find((p) => p.participant_id === data.self_id) : undefined;
  const rival = ok ? data.players.find((p) => p.participant_id === data.rival_id) : undefined;
  // Sin jugador grabado, todo desde el azul y sin los modos que hablan de "ti".
  const myTeam = me?.team_id ?? 100;
  const modoEf: Modo = !me && (modo === "rival" || modo === "enemyAvg") ? "teams" : modo;
  const floor = SERIES.find((s) => s.key === serie)?.floor ?? 300;
  // El daño recibido no es bueno ni malo en sí (un tanque lo busca): su
  // diferencia va sin verde ni rojo.
  const judged = serie !== "taken";

  const minutes = ok ? data.minutes : [];
  const tEnd = minutes.length ? Math.max(1, minutes[minutes.length - 1]) : 1;
  const x = (m: number) => (m / tEnd) * W;
  const pct = (m: number) => `${Math.max(0, Math.min(100, (m / tEnd) * 100))}%`;

  // ------------------------------------------------- la serie en el modo
  const diff = useMemo(() => {
    if (!ok || modoEf === "all") return null;
    const allies = data.players.filter((p) => p.team_id === myTeam);
    const enemies = data.players.filter((p) => p.team_id !== myTeam);
    return data.minutes.map((_, i) => {
      const v = (p: MinuteSeriesPlayer) => serieDe(p, serie)[i] ?? 0;
      const sum = (ps: MinuteSeriesPlayer[]) => ps.reduce((s, p) => s + v(p), 0);
      if (modoEf === "teams") return { d: sum(allies) - sum(enemies), a: sum(allies), b: sum(enemies) };
      if (!me) return { d: 0, a: 0, b: 0 };
      if (modoEf === "rival") {
        const r = rival ? v(rival) : 0;
        return { d: v(me) - r, a: v(me), b: r };
      }
      const avg = enemies.length ? sum(enemies) / enemies.length : 0;
      return { d: v(me) - avg, a: v(me), b: avg };
    });
  }, [ok, data, modoEf, serie, myTeam, me, rival]);

  const visibles = ok ? data.players.filter((p) => !hidden.has(p.participant_id)) : [];

  // Escala. En diferencia, simétrica alrededor del cero; con los diez, de 0
  // al máximo de lo que se ve (ocultar a uno reescala a los demás).
  const max = useMemo(() => {
    if (diff) return Math.max(floor, ...diff.map((r) => Math.abs(r.d)));
    return Math.max(floor, ...visibles.flatMap((p) => serieDe(p, serie)));
  }, [diff, visibles, serie, floor]);
  const yDiff = (v: number) => PAD + (1 - (v + max) / (2 * max)) * (H - 2 * PAD);
  const yAbs = (v: number) => PAD + (1 - v / max) * (H - 2 * PAD);
  const zeroY = yDiff(0);

  // --------------------------------------------- probabilidad de victoria
  // La curva: el antes y el después de cada jugada (el salto) y, si el
  // comando la da, la probabilidad en cada fotograma (lo que derivan el oro y
  // la XP entre jugadas). Salen del mismo estado del modelo, así que se mezclan
  // sin costuras.
  const wp = useMemo(() => {
    if (!ok || !plays || plays.plays.length === 0) return null;
    const ps = [...plays.plays].sort((a, b) => a.time - b.time);
    const mia = (p: MatchPlay, v: number) => (p.team_id === myTeam ? v : 1 - v);
    const pts: [number, number][] = [];
    for (const p of ps) pts.push([p.time / 60, mia(p, p.before)], [p.time / 60, mia(p, p.after)]);
    if (plays.curve) {
      for (const c of plays.curve) pts.push([c.time / 60, myTeam === 100 ? c.p100 : 1 - c.p100]);
      // Orden estable: a la misma hora, el antes de una jugada va antes que su después.
      pts.sort((a, b) => a[0] - b[0]);
    }
    if (pts[0][0] > 0) pts.unshift([0, plays.curve ? (myTeam === 100 ? plays.curve[0].p100 : 1 - plays.curve[0].p100) : pts[0][1]]);
    if (pts[pts.length - 1][0] < tEnd) pts.push([tEnd, pts[pts.length - 1][1]]);
    const dots = ps
      .map((p, i) => {
        const delta = p.team_id === myTeam ? p.wpa : -p.wpa;
        const yours = !!me && (p.victim === me.participant_id || p.shares.some(([pid]) => pid === me.participant_id));
        return { i, p, m: p.time / 60, v: mia(p, p.after), delta, yours };
      })
      // Por debajo de 2 puntos son sobre todo placas y asesinatos sueltos de
      // media partida: en una partida real eran 69 de 104 jugadas y tapaban la
      // curva. Siguen contando en la curva; sólo no llevan punto.
      .filter((d) => Math.abs(d.delta) >= MIN_PUNTO);
    return { pts, dots };
  }, [ok, plays, myTeam, me, tEnd]);
  const yWp = (v: number) => WPAD + (1 - v) * (WH - 2 * WPAD);
  const wpAt = (m: number): number | null => {
    if (!wp) return null;
    let v = wp.pts[0][1];
    for (const [pm, pv] of wp.pts) {
      if (pm > m) break;
      v = pv;
    }
    return v;
  };

  if (data === undefined) return <div className="lc lc--loading" aria-busy="true" />;
  if (!ok) return <>{fallback ?? null}</>;

  // ------------------------------------------------- cursor y cabezal
  const gameNow = (videoTime - videoOffset) / 60;
  const playhead = gameNow >= 0 && gameNow <= tEnd ? gameNow : null;
  const cursor = hoverMin ?? playhead;
  const idx = cursor !== null ? cercano(minutes, cursor) : minutes.length - 1;

  const minAt = (e: React.PointerEvent | React.MouseEvent): number => {
    const r = (plotRef.current ?? (e.currentTarget as HTMLElement)).getBoundingClientRect();
    const f = r.width > 0 ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
    return f * tEnd;
  };

  // ------------------------------------------------- trazados
  const linePath = (vals: number[], y: (v: number) => number) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"} ${x(minutes[i]).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");

  let diffLine = "";
  let diffArea = "";
  if (diff) {
    diffLine = linePath(diff.map((r) => r.d), yDiff);
    diffArea = `${diffLine} L ${x(tEnd).toFixed(1)} ${zeroY.toFixed(1)} L 0 ${zeroY.toFixed(1)} Z`;
  }

  const allyOf = (p: MinuteSeriesPlayer) => p.team_id === myTeam;
  const tone = (p: MinuteSeriesPlayer) => (allyOf(p) ? "var(--cool)" : "var(--loss)");

  // Marcas del eje: cada 5 minutos (cada 10 en partidas largas).
  const paso = tEnd > 40 ? 10 : 5;
  const marcas: number[] = [];
  for (let m = paso; m < tEnd - paso / 3; m += paso) marcas.push(m);

  const wpLine = wp ? wp.pts.map(([m, v], i) => `${i === 0 ? "M" : "L"} ${x(m).toFixed(1)} ${yWp(v).toFixed(1)}`).join(" ") : "";
  const wpArea = wp ? `${wpLine} L ${x(tEnd).toFixed(1)} ${yWp(0.5).toFixed(1)} L 0 ${yWp(0.5).toFixed(1)} Z` : "";

  // ------------------------------------------------- textos
  const rivalName = rival ? champLabel(rival.champion) : "";
  const caption =
    modoEf === "rival" ? t("You minus {champ}, your lane opponent.", { champ: rivalName })
      : modoEf === "enemyAvg" ? t("You minus the enemy team's average.")
      : modoEf === "teams" ? t("Your team minus the enemy team.")
      : t("Each player's running total. Click a face to hide or show its line.");

  const valueTone = (v: number) => (!judged || v === 0 ? "var(--text)" : v > 0 ? "var(--win)" : "var(--loss)");
  const etiquetaB = modoEf === "rival" ? rivalName : modoEf === "enemyAvg" ? t("enemy avg.") : t("them");
  const etiquetaA = modoEf === "teams" ? t("your team") : t("you");
  const cuando = cursor === null ? t("At the end") : clock(minutes[idx] * 60);

  const hp = hoverPlay !== null && wp ? wp.dots.find((d) => d.i === hoverPlay) : undefined;
  const wpCursor = cursor !== null ? wpAt(cursor) : wp ? wp.pts[wp.pts.length - 1][1] : null;

  const toggle = (pid: number) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(pid)) n.delete(pid);
      else n.add(pid);
      return n;
    });

  const cara = (p: MinuteSeriesPlayer) => (
    <button
      key={p.participant_id}
      type="button"
      className="lc-face"
      aria-pressed={!hidden.has(p.participant_id)}
      data-team={allyOf(p) ? "ally" : "enemy"}
      data-self={p.participant_id === data.self_id || undefined}
      title={`${champLabel(p.champion)}${p.participant_id === data.self_id ? ` · ${t("You")}` : ""}`}
      onClick={() => toggle(p.participant_id)}
      onPointerEnter={() => setHiPid(p.participant_id)}
      onPointerLeave={() => setHiPid(null)}
      onFocus={() => setHiPid(p.participant_id)}
      onBlur={() => setHiPid(null)}
    >
      <ChampFace champion={p.champion} size={22} fallback={<span className="lc-face__empty" />} />
    </button>
  );

  return (
    <div className="lc">
      <div className="lc-controls">
        <div className="tp-seg" role="group" aria-label={t("Series")}>
          {SERIES.map((s) => (
            <button key={s.key} type="button" aria-pressed={serie === s.key} data-on={serie === s.key ? "" : undefined} onClick={() => setSerie(s.key)}>
              {t(s.label)}
            </button>
          ))}
        </div>
        <div className="tp-seg" role="group" aria-label={t("Compare")}>
          {MODOS.map((m) => {
            const off = !me && (m.key === "rival" || m.key === "enemyAvg");
            return (
              <button
                key={m.key}
                type="button"
                disabled={off}
                aria-pressed={modoEf === m.key}
                data-on={modoEf === m.key ? "" : undefined}
                onClick={() => setModo(m.key)}
              >
                {t(m.label)}
              </button>
            );
          })}
        </div>
      </div>
      <p className="lc-caption">
        {caption}
        {!judged && modoEf !== "all" && <> {t("No color: taking more damage isn't good or bad by itself.")}</>}
      </p>

      {modoEf === "all" && (
        <div className="lc-faces">
          <div className="lc-faces__team">{data.players.filter(allyOf).map(cara)}</div>
          <span className="lc-faces__vs">{t("vs")}</span>
          <div className="lc-faces__team">{data.players.filter((p) => !allyOf(p)).map(cara)}</div>
          {hidden.size > 0 && (
            <button type="button" className="lc-faces__all" onClick={() => setHidden(new Set())}>
              {t("Show all")}
            </button>
          )}
        </div>
      )}

      <div
        className="lc-plot"
        ref={plotRef}
        onPointerMove={(e) => setHoverMin(minAt(e))}
        onPointerLeave={() => {
          setHoverMin(null);
          setHoverPlay(null);
        }}
      >
        {/* ------------------------------------------- 1. la serie */}
        <div className="lc-chart" style={{ height: H }}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="lc-svg"
            role="img"
            aria-label={caption}
            onClick={(e) => onSeekGame(minAt(e) * 60)}
          >
            <defs>
              <clipPath id={`${uid}-up`}><rect x={0} y={0} width={W} height={zeroY} /></clipPath>
              <clipPath id={`${uid}-dn`}><rect x={0} y={zeroY} width={W} height={H - zeroY} /></clipPath>
            </defs>
            {marcas.map((m) => (
              <line key={m} x1={x(m)} y1={0} x2={x(m)} y2={H} className="lc-grid" vectorEffect="non-scaling-stroke" />
            ))}
            {diff ? (
              <>
                <line x1={0} y1={zeroY} x2={W} y2={zeroY} className="lc-zero" vectorEffect="non-scaling-stroke" />
                {judged ? (
                  <>
                    <g clipPath={`url(#${uid}-up)`}>
                      <path d={diffArea} fill="var(--win)" fillOpacity={0.14} />
                      <path d={diffLine} className="lc-line" stroke="var(--win)" vectorEffect="non-scaling-stroke" />
                    </g>
                    <g clipPath={`url(#${uid}-dn)`}>
                      <path d={diffArea} fill="var(--loss)" fillOpacity={0.12} />
                      <path d={diffLine} className="lc-line" stroke="var(--loss)" vectorEffect="non-scaling-stroke" />
                    </g>
                  </>
                ) : (
                  <>
                    <path d={diffArea} fill="var(--muted)" fillOpacity={0.1} />
                    <path d={diffLine} className="lc-line" stroke="var(--muted)" vectorEffect="non-scaling-stroke" />
                  </>
                )}
              </>
            ) : (
              // Los diez: el tuyo encima y más grueso; tu rival entero; el
              // resto atenuado. Pasar por una cara resalta su línea.
              [...visibles]
                .sort((a, b) => {
                  const peso = (p: MinuteSeriesPlayer) =>
                    p.participant_id === hiPid ? 3 : p.participant_id === data.self_id ? 2 : p.participant_id === data.rival_id ? 1 : 0;
                  return peso(a) - peso(b);
                })
                .map((p) => {
                  const self = p.participant_id === data.self_id;
                  const riv = p.participant_id === data.rival_id;
                  const hi = hiPid === p.participant_id;
                  const dim = hiPid !== null && !hi;
                  return (
                    <path
                      key={p.participant_id}
                      d={linePath(serieDe(p, serie), yAbs)}
                      className="lc-line"
                      stroke={tone(p)}
                      strokeWidth={hi || self ? 2.5 : riv ? 2 : 1.5}
                      strokeOpacity={dim ? 0.18 : hi || self || riv ? 1 : 0.5}
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })
            )}
            {playhead !== null && (
              <line x1={x(playhead)} y1={0} x2={x(playhead)} y2={H} className="lc-head" vectorEffect="non-scaling-stroke" />
            )}
            {hoverMin !== null && (
              <line x1={x(minutes[idx])} y1={0} x2={x(minutes[idx])} y2={H} className="lc-hover" vectorEffect="non-scaling-stroke" />
            )}
          </svg>
          <span className="lc-tick lc-tick--top">{corto(max, !!diff)}</span>
          {diff && <span className="lc-tick lc-tick--bottom">{corto(-max, true)}</span>}
          {hoverMin !== null && diff && (
            <i className="lc-dot" style={{ left: pct(minutes[idx]), top: yDiff(diff[idx].d) }} />
          )}
        </div>

        {/* ------------------------------------------- eje */}
        <div className="lc-axis">
          {marcas.map((m) => (
            <span key={m} style={{ left: pct(m) }}>{m}</span>
          ))}
        </div>

        {/* ------------------------------------------- 2. objetivos */}
        <div className="lc-objs" aria-label={t("Objectives")}>
          {data.objectives.map((o, i) => {
            const ours = o.team_id === myTeam;
            const estructura = o.kind === "tower" || o.kind === "inhibitor";
            return (
              <button
                key={i}
                type="button"
                className="lc-obj"
                data-row={ours ? "ours" : "theirs"}
                data-tone={!ours ? "enemy" : estructura ? "structure" : "objective"}
                style={{ left: pct(o.time / 60) }}
                title={`${clock(o.time)} · ${nombreObjetivo(o, t)} · ${t(ours ? "Your team" : "Enemy team")}`}
                aria-label={`${clock(o.time)} · ${nombreObjetivo(o, t)} · ${t(ours ? "Your team" : "Enemy team")}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSeekGame(Math.max(0, o.time - LEAD));
                }}
              >
                {glifo(o.kind)}
              </button>
            );
          })}
          {playhead !== null && <i className="lc-objs__head" style={{ left: pct(playhead) }} />}
        </div>

        {/* ------------------------------------------- la lectura de la serie, pegada a ella */}
        <div className="lc-foot">
          {diff ? (
            <span className="lc-read">
              {cuando}{" "}
              <b className="u-metric" style={{ color: valueTone(diff[idx].d) }}>{formatGold(diff[idx].d, true)}</b>
              <span className="lc-read__parts">
                {etiquetaA} {formatNumber(diff[idx].a)} · {etiquetaB} {formatNumber(diff[idx].b)}
              </span>
            </span>
          ) : (
            <div className="lc-read lc-read--all">
              <span>{cuando}</span>
              {[...visibles]
                .sort((a, b) => (serieDe(b, serie)[idx] ?? 0) - (serieDe(a, serie)[idx] ?? 0))
                .map((p) => (
                  <span key={p.participant_id} className="lc-chip" data-self={p.participant_id === data.self_id || undefined}>
                    <i style={{ background: tone(p) }} />
                    {champLabel(p.champion)} <b className="u-metric">{corto(serieDe(p, serie)[idx] ?? 0, false)}</b>
                  </span>
                ))}
            </div>
          )}
        </div>

        {/* ------------------------------------------- 3. probabilidad de victoria */}
        {wp && (
          <div className="lc-wp">
            <div className="lc-wp__head">
              <span className="u-label">{t("Win probability")}</span>
              {hp ? (
                <span className="lc-read">
                  {clock(hp.p.time)} · {nombreJugada(hp.p, data.players, t)}{" "}
                  <b className="u-metric" style={{ color: hp.delta >= 0 ? "var(--win)" : "var(--loss)" }}>
                    {formatSigned(hp.delta * 100)} %
                  </b>
                </span>
              ) : (
                wpCursor !== null && (
                  <span className="lc-read">
                    <b className="u-metric">{Math.round(wpCursor * 100)} %</b>
                  </span>
                )
              )}
            </div>
            <div className="lc-chart" style={{ height: WH }}>
              <svg
                viewBox={`0 0 ${W} ${WH}`}
                preserveAspectRatio="none"
                className="lc-svg"
                role="img"
                aria-label={t("Your team's win probability")}
                onClick={(e) => onSeekGame(minAt(e) * 60)}
              >
                <defs>
                  <clipPath id={`${uid}-wup`}><rect x={0} y={0} width={W} height={yWp(0.5)} /></clipPath>
                  <clipPath id={`${uid}-wdn`}><rect x={0} y={yWp(0.5)} width={W} height={WH - yWp(0.5)} /></clipPath>
                </defs>
                <line x1={0} y1={yWp(0.5)} x2={W} y2={yWp(0.5)} className="lc-zero" vectorEffect="non-scaling-stroke" />
                <g clipPath={`url(#${uid}-wup)`}>
                  <path d={wpArea} fill="var(--win)" fillOpacity={0.12} />
                  <path d={wpLine} className="lc-line lc-line--wp" stroke="var(--win)" vectorEffect="non-scaling-stroke" />
                </g>
                <g clipPath={`url(#${uid}-wdn)`}>
                  <path d={wpArea} fill="var(--loss)" fillOpacity={0.1} />
                  <path d={wpLine} className="lc-line lc-line--wp" stroke="var(--loss)" vectorEffect="non-scaling-stroke" />
                </g>
                {playhead !== null && (
                  <line x1={x(playhead)} y1={0} x2={x(playhead)} y2={WH} className="lc-head" vectorEffect="non-scaling-stroke" />
                )}
                {hoverMin !== null && hoverPlay === null && (
                  <line x1={x(hoverMin)} y1={0} x2={x(hoverMin)} y2={WH} className="lc-hover" vectorEffect="non-scaling-stroke" />
                )}
              </svg>
              <span className="lc-tick lc-tick--mid">50 %</span>
              {wp.dots.map((d) => {
                // El tamaño dice cuánto movió; el aro claro, que estabas tú.
                const r = Math.min(5, 2.5 + Math.abs(d.delta) * 30);
                return (
                  <button
                    key={d.i}
                    type="button"
                    className="lc-play"
                    data-good={d.delta >= 0 || undefined}
                    data-yours={d.yours || undefined}
                    data-on={hoverPlay === d.i || undefined}
                    style={{ left: pct(d.m), top: yWp(d.v), ["--r" as string]: `${r}px` }}
                    aria-label={`${clock(d.p.time)} · ${nombreJugada(d.p, data.players, t)} · ${formatSigned(d.delta * 100)} %`}
                    onPointerEnter={() => setHoverPlay(d.i)}
                    onPointerLeave={() => setHoverPlay(null)}
                    onFocus={() => setHoverPlay(d.i)}
                    onBlur={() => setHoverPlay(null)}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSeekGame(Math.max(0, d.p.time - LEAD));
                    }}
                  />
                );
              })}
            </div>
            <p className="lc-caption">{t("Each dot is a play that moved the odds 2 points or more; the bigger, the more. Bright and ringed: you took part. Click one to watch it.")}</p>
          </div>
        )}
      </div>

    </div>
  );
};
