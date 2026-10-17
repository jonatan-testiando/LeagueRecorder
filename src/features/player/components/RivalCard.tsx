import React, { useId, useState } from "react";
import type { MinuteFrameDto, Participant } from "../../../types";
import type { PlayerCredit } from "../../../core/tauri-ipc";
import { useT } from "../../../core/LanguageProvider";
import { champLabel } from "../../../core/matchEvents";
import { roleLabel } from "../../../core/roles";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { PositionIcon, normalizePosition } from "../../../components/PositionIcon";
import { formatGold, formatNumber, formatSigned } from "./pressureFormat";
import "./RivalCard.css";

/**
 * Tú contra tu rival directo: el del otro equipo con tu mismo puesto.
 *
 * Sustituye a «Crédito real», la tabla de los diez con su desfase de oro: esa
 * columna contestaba quién cobró remates ajenos, que es una pregunta sobre la
 * partida de todos y no ayuda a revisar la tuya. La comparación que sí se
 * hace al acabar es contra quien tenías delante, así que va frente a frente y
 * con la curva del duelo debajo.
 *
 * La curva sale de `minute_frames.self_*_diff`, que el backend ya calcula como
 * tú menos tu rival de línea (`rival_de_linea`, mismo criterio de puesto). En
 * Partida queda sólo la del oro del equipo.
 */

type T = (key: string, vars?: Record<string, string | number>) => string;

export interface RivalCardProps {
  me: Participant;
  rival: Participant;
  /** Los diez: hacen falta las kills de cada equipo para la participación. */
  participants: Participant[];
  meCredit?: PlayerCredit;
  rivalCredit?: PlayerCredit;
  frames?: MinuteFrameDto[];
  /** El puesto ya resuelto (el marcador o, en partidas viejas, el reparto). */
  role?: string;
  /** Jungla: entonces tiene sentido el CS de jungla, que es el único CS que
   *  traen los fotogramas (`self_jungle_cs_diff`). A un laner le saldría ~0. */
  jungle?: boolean;
  /** Saltar a un minuto de la curva (segundos de PARTIDA). */
  onSeekGame?: (gameSeconds: number) => void;
}

/** Por debajo de esto, ni oro ni XP cuentan como ventaja: el mismo umbral con
 *  el que el backend decide «saliste de línea igualado» (lane_result, ±300). */
const IGUALADO = 300;

/** La frase de la línea al minuto 15 (o al último minuto, si no llegó). */
function laneSentence(frames: MinuteFrameDto[] | undefined, rival: string, t: T): string | null {
  if (!frames || frames.length < 2) return null;
  const last = frames[frames.length - 1];
  const f = frames.find((x) => x.minute === 15) ?? (last.minute < 15 ? last : null);
  if (!f || f.minute < 1) return null;
  const g = f.self_gold_diff;
  const x = f.self_xp_diff;
  const m = f.minute;
  if (Math.abs(g) < IGUALADO && Math.abs(x) < IGUALADO) {
    return t("At minute {m} you were even with {rival}.", { m, rival });
  }
  if (g >= IGUALADO && x >= IGUALADO) {
    return t("At minute {m} you were {gold} gold and {xp} XP ahead of {rival}.", { m, rival, gold: formatNumber(g), xp: formatNumber(x) });
  }
  if (g <= -IGUALADO && x <= -IGUALADO) {
    return t("At minute {m} {rival} was {gold} gold and {xp} XP ahead of you.", { m, rival, gold: formatNumber(g), xp: formatNumber(x) });
  }
  // Oro y XP no dicen lo mismo: las dos cifras con su signo, sin elegir una.
  return t("At minute {m} you were {gold} gold and {xp} XP against {rival}.", {
    m, rival, gold: formatGold(g, true), xp: formatGold(x, true),
  });
}

function impactSentence(me: PlayerCredit | undefined, them: PlayerCredit | undefined, t: T): string | null {
  if (!me || !them) return null;
  const a = me.wpa * 100;
  const b = them.wpa * 100;
  // Medio punto de probabilidad de victoria es ruido del modelo, no una diferencia.
  if (Math.abs(a - b) < 0.5) return t("You finished with the same impact: {a}.", { a: formatSigned(a) });
  return t(a > b ? "You finished with more impact: {a} to {b}." : "You finished with less impact: {a} to {b}.", {
    a: formatSigned(a),
    b: formatSigned(b),
  });
}

interface Row {
  label: string;
  me: string;
  them: string;
  /** >0 mejor tú, <0 mejor el rival, 0 sin ganador claro. */
  cmp: number;
  /** Color por signo (impacto): el valor dice si sumó o restó. */
  signed?: [number, number];
}

export const RivalCard: React.FC<RivalCardProps> = ({
  me, rival, participants, meCredit, rivalCredit, frames, role, jungle, onSeekGame,
}) => {
  const t = useT();
  const rivalName = champLabel(rival.champion);
  const rol = role || me.role || rival.role || "";
  const pos = normalizePosition(rol);

  const lane = laneSentence(frames, rivalName, t);
  const impact = impactSentence(meCredit, rivalCredit, t);

  const teamKills = (team: number) =>
    participants.filter((p) => p.team_id === team).reduce((s, p) => s + p.kills, 0);
  const kp = (p: Participant): number | null => {
    const tk = teamKills(p.team_id);
    return tk > 0 ? (p.kills + p.assists) / tk : null;
  };
  const kda = (p: Participant) => (p.kills + p.assists) / Math.max(1, p.deaths);

  const rows: Row[] = [];
  if (meCredit && rivalCredit) {
    rows.push({
      label: t("Impact"),
      me: formatSigned(meCredit.wpa * 100),
      them: formatSigned(rivalCredit.wpa * 100),
      cmp: meCredit.wpa - rivalCredit.wpa,
      signed: [meCredit.wpa, rivalCredit.wpa],
    });
  }
  rows.push({
    label: t("K/D/A"),
    me: `${me.kills}/${me.deaths}/${me.assists}`,
    them: `${rival.kills}/${rival.deaths}/${rival.assists}`,
    cmp: kda(me) - kda(rival),
  });
  const kpMe = kp(me);
  const kpThem = kp(rival);
  if (kpMe !== null && kpThem !== null) {
    rows.push({
      label: t("Kill participation"),
      me: `${Math.round(kpMe * 100)}%`,
      them: `${Math.round(kpThem * 100)}%`,
      cmp: Math.round(kpMe * 100) - Math.round(kpThem * 100),
    });
  }
  rows.push({ label: t("CS"), me: String(me.cs), them: String(rival.cs), cmp: me.cs - rival.cs });
  rows.push({ label: t("Gold"), me: formatNumber(me.gold), them: formatNumber(rival.gold), cmp: me.gold - rival.gold });
  if (me.damage != null && rival.damage != null) {
    rows.push({ label: t("Damage"), me: formatNumber(me.damage), them: formatNumber(rival.damage), cmp: me.damage - rival.damage });
  }
  if (me.vision_score != null && rival.vision_score != null) {
    rows.push({ label: t("Vision"), me: String(me.vision_score), them: String(rival.vision_score), cmp: me.vision_score - rival.vision_score });
  }

  const valueClass = (cmp: number, side: 1 | -1) =>
    `rv__v${cmp * side > 0 ? " rv__v--best" : ""}`;
  const tone = (v?: number) => (v === undefined ? undefined : v >= 0 ? "var(--win)" : "var(--loss)");

  return (
    <div className="rv">
      {(lane || impact) && (
        <p className="rv__verdict">
          {lane}
          {lane && impact ? " " : ""}
          {impact}
        </p>
      )}

      <div className="rv__faces">
        <div className="rv__side">
          <ChampionAvatar champion={me.champion} size={34} />
          <span className="rv__who">
            <b>{t("You")}</b>
            <span>{champLabel(me.champion)}</span>
          </span>
        </div>
        <span className="rv__pos">
          {pos && <PositionIcon position={pos} size={13} color="var(--faint)" />}
          {rol && t(roleLabel(rol))}
        </span>
        <div className="rv__side rv__side--them">
          <span className="rv__who">
            <b>{rivalName}</b>
            {rival.name && <span>{rival.name}</span>}
          </span>
          <ChampionAvatar champion={rival.champion} size={34} />
        </div>
      </div>

      <div className="rv__rows">
        {rows.map((r) => (
          <div key={r.label} className="rv__row">
            <span className={`u-metric ${valueClass(r.cmp, 1)}`} style={{ color: tone(r.signed?.[0]) }}>{r.me}</span>
            <span className="rv__label">{r.label}</span>
            <span className={`u-metric ${valueClass(r.cmp, -1)}`} style={{ color: tone(r.signed?.[1]) }}>{r.them}</span>
          </div>
        ))}
      </div>

      {frames && frames.length > 1 && <DuelCurve frames={frames} jungle={jungle} onSeekGame={onSeekGame} />}
    </div>
  );
};

// ----------------------------------------------------------------- la curva

type Metric = "gold" | "xp" | "cs";

const METRICS: { key: Metric; label: string; floor: number }[] = [
  { key: "gold", label: "Gold", floor: 300 },
  { key: "xp", label: "XP", floor: 300 },
  { key: "cs", label: "Jungle CS", floor: 5 },
];

const W = 600;
const H = 72;

const valueOf = (f: MinuteFrameDto, m: Metric): number =>
  m === "gold" ? f.self_gold_diff : m === "xp" ? f.self_xp_diff : f.self_jungle_cs_diff;

/**
 * Tú menos tu rival, minuto a minuto. Por encima de cero en verde y por debajo
 * en rojo: la misma línea cambia de color al cruzar, que es justo el minuto en
 * que el duelo se dio la vuelta.
 */
const DuelCurve: React.FC<{
  frames: MinuteFrameDto[];
  jungle?: boolean;
  onSeekGame?: (gameSeconds: number) => void;
}> = ({ frames, jungle, onSeekGame }) => {
  const t = useT();
  const [metric, setMetric] = useState<Metric>("gold");
  const [hover, setHover] = useState<number | null>(null);
  // useId trae caracteres que no valen en url(#…): se limpian.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  const modes = METRICS.filter((m) => m.key !== "cs" || jungle);
  const floor = METRICS.find((m) => m.key === metric)?.floor ?? 300;
  const fs = [...frames].sort((a, b) => a.minute - b.minute);
  const vals = fs.map((f) => valueOf(f, metric));
  const m0 = fs[0].minute;
  const m1 = Math.max(m0 + 1, fs[fs.length - 1].minute);
  const max = Math.max(floor, ...vals.map((v) => Math.abs(v)));
  const PAD = 6;
  const y = (v: number) => PAD + (1 - (v + max) / (2 * max)) * (H - 2 * PAD);
  const x = (minute: number) => ((minute - m0) / (m1 - m0)) * W;
  const zeroY = y(0);

  const pts = fs.map((f, i) => `${x(f.minute).toFixed(1)} ${y(vals[i]).toFixed(1)}`);
  const line = `M ${pts.join(" L ")}`;
  const area = `M ${x(fs[0].minute).toFixed(1)} ${zeroY.toFixed(1)} L ${pts.join(" L ")} L ${x(fs[fs.length - 1].minute).toFixed(1)} ${zeroY.toFixed(1)} Z`;

  const at15 = fs.find((f) => f.minute === 15);
  const end = fs[fs.length - 1];
  const fmt = (v: number) => formatGold(v, true);

  const indexAt = (e: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>): number => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = r.width > 0 ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
    const minute = m0 + f * (m1 - m0);
    let best = 0;
    fs.forEach((fr, i) => { if (Math.abs(fr.minute - minute) < Math.abs(fs[best].minute - minute)) best = i; });
    return best;
  };

  const h = hover !== null ? fs[hover] : null;

  return (
    <div className="rv__curve">
      <div className="rv__curveHead">
        <span className="u-label">{t("The duel, minute by minute")}</span>
        {modes.length > 1 && (
          <div className="tp-seg">
            {modes.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setMetric(m.key)}
                aria-pressed={metric === m.key}
                data-on={metric === m.key ? "" : undefined}
              >
                {t(m.label)}
              </button>
            ))}
          </div>
        )}
      </div>
      <svg
        className="rv__svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ height: H }}
        data-seek={onSeekGame ? "" : undefined}
        role="img"
        aria-label={t("You minus your opponent, minute by minute")}
        onPointerMove={(e) => setHover(indexAt(e))}
        onPointerLeave={() => setHover(null)}
        onClick={onSeekGame ? (e) => onSeekGame(fs[indexAt(e)].minute * 60) : undefined}
      >
        <defs>
          <clipPath id={`${uid}-up`}><rect x={0} y={0} width={W} height={zeroY} /></clipPath>
          <clipPath id={`${uid}-dn`}><rect x={0} y={zeroY} width={W} height={H - zeroY} /></clipPath>
        </defs>
        <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke="var(--line)" strokeDasharray="4 4" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {at15 && (
          <line x1={x(15)} y1={0} x2={x(15)} y2={H} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        )}
        <g clipPath={`url(#${uid}-up)`}>
          <path d={area} fill="var(--win)" fillOpacity={0.18} />
          <path d={line} fill="none" stroke="var(--win)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </g>
        <g clipPath={`url(#${uid}-dn)`}>
          <path d={area} fill="var(--loss)" fillOpacity={0.16} />
          <path d={line} fill="none" stroke="var(--loss)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </g>
        {h && (
          <line x1={x(h.minute)} y1={0} x2={x(h.minute)} y2={H} stroke="var(--muted)" strokeDasharray="2 2" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      <div className="rv__curveFoot">
        {h ? (
          <span>
            {t("min {n}", { n: h.minute })}{" "}
            <b className="u-metric" style={{ color: valueOf(h, metric) >= 0 ? "var(--win)" : "var(--loss)" }}>{fmt(valueOf(h, metric))}</b>
          </span>
        ) : (
          <>
            {at15 ? (
              <span>
                {t("At minute {n}", { n: 15 })}{" "}
                <b className="u-metric" style={{ color: valueOf(at15, metric) >= 0 ? "var(--win)" : "var(--loss)" }}>{fmt(valueOf(at15, metric))}</b>
              </span>
            ) : <span />}
            <span>
              {t("At the end")}{" "}
              <b className="u-metric" style={{ color: valueOf(end, metric) >= 0 ? "var(--win)" : "var(--loss)" }}>{fmt(valueOf(end, metric))}</b>
            </span>
          </>
        )}
      </div>
    </div>
  );
};
