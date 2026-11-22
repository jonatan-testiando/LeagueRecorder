import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Volume2 } from "lucide-react";
import { getClickPatterns, type ClickPatterns, type ClickWindow } from "../../../core/tauri-ipc";
import type { MouseEventData } from "../../../types";
import { useT } from "../../../core/LanguageProvider";
import { useTheme } from "../../../core/ThemeProvider";
import { mmss } from "../../../core/time";
import { formatDecimal, withPercent } from "../../../core/benchmarkFormat";
import { useDelayedLoading } from "../../../core/useDelayedLoading";
import { SkeletonLines } from "../../../components/ui/Skeleton";
import { Segmented } from "../../../components/ui/Segmented";
import { EmptyState } from "../../../components/ui/EmptyState";
import { leerPaleta, rgb, type RGB } from "../mapDraw";
import { HelpDot } from "./HelpDot";
import "./MatchTab.css";
import "./ClicksSection.css";

/**
 * «Tus clics»: cómo se movió tu mano en esta partida.
 *
 * Lo que MicroLab enseña en su pestaña Inputs (docs/analisis-microlab-2026-11),
 * sacado de la estela que ya se graba. El cálculo vive en `clics.rs`; aquí se
 * pinta, y se hacen en el sitio las dos cosas que dependen de lo que hagas con
 * el ratón: el mapa de calor y la caja que cuenta tus visitas a una zona.
 *
 * Todo cuenta solo el tiempo vivo de la partida (los tramos `alive` del
 * backend): ni la carga, ni lo de después del nexo, ni tus muertes.
 */

type T = ReturnType<typeof useT>;

/** Celda del mapa de calor, en píxeles CSS del lienzo, y su desenfoque en
 *  celdas. Con el 1,2 de MicroLab cada muestra suelta salía como una cruz. */
const CELDA = 2;
const SIGMA = 1.8;
/** Una muestra pesa lo que el cursor se quedó en ella, hasta este tope. */
const PESO_MAX = 0.25;
/** Visitas a la caja (las de MicroLab): dos estancias a menos de 4 s son la
 *  misma, y una visita de menos de 1 s dentro no cuenta. */
const VISITA_HUECO = 4;
const VISITA_MIN = 1;
/** Momentos de la caja que se enseñan como botones. */
const VISITAS_VISIBLES = 12;
/** Tonos del metrónomo: el ataque más agudo que el movimiento. */
const TONO = { left: 880, right: 440 } as const;
/** Hasta aquí fuera de la pantalla es el borde apretado (`rdev` da x = −7); más
 *  allá, otro monitor. Lo mismo que `FUERA_TOLERANCIA` en clics.rs. */
const FUERA = 12;

interface Props {
  matchId: string;
  mouseEvents: MouseEventData[];
  videoOffset: number;
  /** Saltar en el vídeo (segundos de VÍDEO). */
  seekTo: (videoSeconds: number, play: boolean) => void;
}

/** Un punto del cursor ya filtrado al tiempo vivo. */
interface Pt {
  t: number;
  x: number;
  y: number;
  /** "left" | "right" | null (movimiento o tecla). */
  b: "left" | "right" | null;
}

interface Caja {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** El desfase de la estela respecto al vídeo que usa el reproductor (lo
 *  guarda useMouseTrailCanvas). Sin almacenamiento, su valor por defecto. */
function desfaseEstela(): number {
  try {
    const v = parseFloat(localStorage.getItem("mouseSyncOffset") || "1.0");
    return Number.isFinite(v) ? v : 1;
  } catch {
    return 1;
  }
}

/** El tramo vivo que contiene t, por bisección. */
function vivo(tramos: [number, number][], t: number): boolean {
  let lo = 0;
  let hi = tramos.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (t < tramos[m][0]) hi = m - 1;
    else if (t > tramos[m][1]) lo = m + 1;
    else return true;
  }
  return false;
}

/** Visitas del cursor a la caja: [inicio, fin, segundos dentro]. */
function visitas(pts: Pt[], c: Caja): [number, number, number][] {
  const out: [number, number, number][] = [];
  let actual: [number, number, number] | null = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < c.x0 || p.x > c.x1 || p.y < c.y0 || p.y > c.y1) continue;
    const sig = pts[i + 1];
    const peso = sig ? Math.min(Math.max(sig.t - p.t, 0), PESO_MAX) : 1 / 60;
    if (actual && p.t - actual[1] <= VISITA_HUECO) {
      actual[1] = p.t;
      actual[2] += peso;
    } else {
      if (actual) out.push(actual);
      actual = [p.t, p.t, peso];
    }
  }
  if (actual) out.push(actual);
  return out.filter((v) => v[2] >= VISITA_MIN);
}

/** Núcleo gaussiano 1D normalizado (el desenfoque es separable). */
function nucleo(sigma: number): Float32Array {
  const r = Math.ceil(2.5 * sigma);
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    s += k[i + r];
  }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

/** Densidad en rejilla, desenfocada. */
function densidad(cols: number, rows: number, puntos: [number, number, number][]): Float32Array {
  const g = new Float32Array(cols * rows);
  for (const [cx, cy, w] of puntos) {
    const x = Math.floor(cx);
    const y = Math.floor(cy);
    if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
    g[y * cols + x] += w;
  }
  const k = nucleo(SIGMA);
  const r = (k.length - 1) / 2;
  const tmp = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i;
        if (xx >= 0 && xx < cols) s += g[y * cols + xx] * k[i + r];
      }
      tmp[y * cols + x] = s;
    }
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i;
        if (yy >= 0 && yy < rows) s += tmp[yy * cols + x] * k[i + r];
      }
      g[y * cols + x] = s;
    }
  return g;
}

const mezcla = (a: RGB, b: RGB, f: number): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * f),
  Math.round(a[1] + (b[1] - a[1]) * f),
  Math.round(a[2] + (b[2] - a[2]) * f),
];

/** El metrónomo: un pitido por intervalo, mientras suena. Solo después de la
 *  partida, en la hoja: nada de esto va encima del juego. */
function useMetronomo() {
  const ctx = useRef<AudioContext | null>(null);
  const timer = useRef<number | null>(null);
  const [sonando, setSonando] = useState<"left" | "right" | null>(null);

  const parar = useCallback(() => {
    if (timer.current != null) window.clearInterval(timer.current);
    timer.current = null;
    setSonando(null);
  }, []);

  const pitido = useCallback((freq: number) => {
    const c = ctx.current;
    if (!c) return;
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.18, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.08);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + 0.09);
  }, []);

  const alternar = useCallback(
    (boton: "left" | "right", hz: number) => {
      if (sonando === boton) {
        parar();
        return;
      }
      parar();
      if (!ctx.current) ctx.current = new AudioContext();
      void ctx.current.resume();
      pitido(TONO[boton]);
      timer.current = window.setInterval(() => pitido(TONO[boton]), 1000 / hz);
      setSonando(boton);
    },
    [sonando, parar, pitido]
  );

  useEffect(
    () => () => {
      if (timer.current != null) window.clearInterval(timer.current);
      void ctx.current?.close();
    },
    []
  );
  return { sonando, alternar, parar };
}

/** La diferencia con tu mediana, lista para pintar. `puntos` = la cifra es
 *  una proporción y la diferencia va en puntos; si no, en %. `mejor` dice qué
 *  dirección es buena (null = ninguna: más APM no es mejor ni peor). */
function delta(
  actual: number | null | undefined,
  base: number | null | undefined,
  puntos: boolean,
  mejor: "up" | "down" | null,
  t: T
): { text: string; tone: "win" | "loss" | "muted"; title: string } | null {
  if (actual == null || base == null || base === 0) return null;
  const d = puntos ? (actual - base) * 100 : ((actual - base) / Math.abs(base)) * 100;
  if (Math.abs(d) < 0.5) return null;
  const flecha = d > 0 ? "▲" : "▼";
  const cifra = Math.round(Math.abs(d));
  const text = puntos
    ? cifra === 1
      ? t("{arrow} 1 point", { arrow: flecha })
      : t("{arrow} {n} points", { arrow: flecha, n: cifra })
    : `${flecha} ${withPercent(cifra)}`;
  const tone = mejor == null ? "muted" : (d > 0) === (mejor === "up") ? "win" : "loss";
  return { text, tone, title: "" };
}

interface Tarjeta {
  label: string;
  value: string;
  sub: string;
  help: string;
  d: ReturnType<typeof delta>;
  base: string | null;
}

export const ClicksSection: React.FC<Props> = ({ matchId, mouseEvents, videoOffset, seekTo }) => {
  const t = useT();
  const { resolved: tema } = useTheme();
  const [r, setR] = useState<ClickPatterns | null | undefined>(undefined);
  const [modo, setModo] = useState<"cursor" | "clicks">("cursor");
  // Primero los más torcidos: los más rectos salen casi siempre al 100 % y
  // no dicen nada; los torcidos son donde la mano gastó camino.
  const [lado, setLado] = useState<"best" | "worst">("worst");
  const [elegido, setElegido] = useState<ClickWindow | null>(null);
  const [caja, setCaja] = useState<Caja | null>(null);
  const { sonando, alternar, parar } = useMetronomo();

  useEffect(() => {
    let vivoEfecto = true;
    setR(undefined);
    setElegido(null);
    setCaja(null);
    parar();
    getClickPatterns(matchId)
      .then((x) => vivoEfecto && setR(x))
      .catch(() => vivoEfecto && setR(null));
    return () => {
      vivoEfecto = false;
    };
  }, [matchId, parar]);

  // Los puntos del cursor en tiempo vivo y dentro de la pantalla, en orden.
  const pts = useMemo<Pt[]>(() => {
    if (!r || r.screen_w <= 0) return [];
    const out: Pt[] = [];
    const [w, h] = [r.screen_w, r.screen_h];
    for (const e of mouseEvents) {
      if (e.x < -FUERA || e.y < -FUERA || e.x > w + FUERA || e.y > h + FUERA) continue;
      if (!vivo(r.alive, e.t)) continue;
      const x = Math.min(Math.max(e.x, 0), w);
      const y = Math.min(Math.max(e.y, 0), h);
      out.push({ t: e.t, x, y, b: e.evt === "left_click" ? "left" : e.evt === "right_click" ? "right" : null });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }, [mouseEvents, r]);

  const vis = useMemo(() => (caja ? visitas(pts, caja) : []), [pts, caja]);

  const esqueleto = useDelayedLoading(r === undefined);
  if (r === undefined || esqueleto) return esqueleto ? <SkeletonLines /> : null;
  if (r === null) return <p className="note" style={{ margin: 0 }}>{t("Couldn't load this section.")}</p>;
  if (r.stats.clicks === 0) {
    return (
      <EmptyState
        title={t("No clicks recorded in this game")}
        text={t("This panel needs the mouse trail of a game recorded here; imported VODs have no input behind them.")}
      />
    );
  }

  const s = r.stats;
  const b = r.baseline;
  const tarjetas: Tarjeta[] = [
    {
      label: t("APM"),
      value: s.apm != null ? String(Math.round(s.apm)) : "—",
      sub: t("actions per minute"),
      help: t("Keys and clicks per minute, the same APM as in the rest of the app."),
      d: delta(s.apm, b?.apm, false, null, t),
      base: b?.apm != null ? String(Math.round(b.apm)) : null,
    },
    {
      label: t("Mouse travel"),
      value: t("{n} m/min", { n: formatDecimal(s.traveled_m_min) }),
      sub: t("{n} m in total", { n: Math.round(s.traveled_m) }),
      help: t("How far your cursor moved per minute alive, in metres of a 1080p screen at 96 dpi: the same unit for every game, whatever your monitor."),
      d: delta(s.traveled_m_min, b?.traveled_m_min, false, null, t),
      base: b?.traveled_m_min != null ? t("{n} m/min", { n: formatDecimal(b.traveled_m_min) }) : null,
    },
    {
      label: t("Efficiency"),
      value: s.efficiency != null ? withPercent(Math.round(s.efficiency * 100)) : "—",
      sub: s.spread_px != null
        ? t("straight between clicks, {px} px apart", { px: Math.round(s.spread_px) })
        : t("straight line between clicks"),
      help: t("The straight line from one click to the next, divided by the path your cursor actually took. 100% is always in a straight line; detours and wiggles bring it down. Pairs of clicks more than 5 s apart, or with a trip to the screen edge in between (a camera pan), don't count."),
      d: delta(s.efficiency, b?.efficiency, true, "up", t),
      base: b?.efficiency != null ? withPercent(Math.round(b.efficiency * 100)) : null,
    },
    {
      label: t("Edge pans"),
      value: t("{n}/min", { n: formatDecimal(s.edge_pans_min) }),
      sub: t("{n} in the game", { n: s.edge_pans }),
      help: t("Times your cursor went to the edge of the screen. With the camera unlocked that pans it; with it locked, it's a trip for nothing. They don't count against your efficiency."),
      d: delta(s.edge_pans_min, b?.edge_pans_min, false, null, t),
      base: b?.edge_pans_min != null ? t("{n}/min", { n: formatDecimal(b.edge_pans_min) }) : null,
    },
    {
      label: t("Clicks per second"),
      value: s.tempo_hz != null ? formatDecimal(s.tempo_hz) : "—",
      sub: t("{n} clicks", { n: s.clicks.toLocaleString() }),
      help: t("Left and right clicks per second alive."),
      d: delta(s.tempo_hz, b?.tempo_hz, false, null, t),
      base: b?.tempo_hz != null ? formatDecimal(b.tempo_hz) : null,
    },
    {
      label: t("Mouse still"),
      value: s.idle_ratio != null ? withPercent(Math.round(s.idle_ratio * 100)) : "—",
      sub: t("{time} of your time alive", { time: mmss(s.idle_s) }),
      help: t("Stretches of 1 s or more in which the cursor stayed within 5 px of where it stopped, alive only. Recalls and waiting for a wave count too."),
      d: delta(s.idle_ratio, b?.idle_ratio, true, "down", t),
      base: b?.idle_ratio != null ? withPercent(Math.round(b.idle_ratio * 100)) : null,
    },
  ];

  const lista = lado === "best" ? r.best : r.worst;
  // La estela se pinta con el desfase de sincronía del reproductor
  // (`mouseSyncOffset`, useMouseTrailCanvas): un punto de la estela en `t` sale
  // en el vídeo en `t + desfase`. Se salta con el mismo, y un poco antes.
  const irA = (t: number, antes: number) => seekTo(Math.max(0, t + desfaseEstela() - antes), true);
  const ver = (w: ClickWindow) => irA(w.start, 1);

  return (
    <div className="mt-block cl">
      <p className="mt-line">
        {t("How your hand moved in this game, only while your champion was alive.")}{" "}
        {!b
          ? t("There are no earlier games with a mouse trail to compare with yet.")
          : b.matches === 1
            ? t("The arrows compare with your previous game.")
            : t("The arrows compare with your median of the previous {n} games.", { n: b.matches })}
        {!r.deaths_known && <> {t("Without Riot's timeline your deaths aren't known, so they count as time alive.")}</>}
      </p>

      <div className="cl-cards">
        {tarjetas.map((c) => (
          <div key={c.label} className="cl-card">
            <span className="cl-card__label">
              {c.label}
              <HelpDot text={c.help} />
            </span>
            <span className="cl-card__value u-metric">{c.value}</span>
            <span className="cl-card__sub">{c.sub}</span>
            {c.d ? (
              <span
                className="cl-card__delta"
                data-tone={c.d.tone}
                title={c.base ? t("Your median: {v}", { v: c.base }) : undefined}
              >
                {c.d.text}
              </span>
            ) : (
              b && c.base && (
                <span className="cl-card__delta" data-tone="muted" title={t("Your median: {v}", { v: c.base })}>
                  {t("as usual")}
                </span>
              )
            )}
          </div>
        ))}
      </div>

      <div className="cl-cols">
        <figure className="cl-screen">
          <div className="cl-screen__bar">
            <Segmented
              size="sm"
              label={t("What to draw")}
              value={modo}
              onChange={setModo}
              options={[
                { value: "cursor", label: t("Cursor") },
                { value: "clicks", label: t("Clicks") },
              ]}
            />
            <span className="cl-screen__hint">{t("Drag a box to count your visits")}</span>
          </div>
          <Pantalla
            r={r}
            pts={pts}
            modo={modo}
            tema={tema}
            caja={caja}
            onCaja={(k) => {
              setCaja(k);
              if (k) setElegido(null);
            }}
            elegido={elegido}
            t={t}
          />
          <figcaption className="cl-screen__cap">
            {caja ? (
              vis.length > 0 ? (
                <>
                  <span>
                    {t("{secs} s inside · {n} visits", {
                      secs: Math.round(vis.reduce((a, v) => a + v[2], 0)),
                      n: vis.length,
                    })}
                  </span>
                  <span className="cl-visits">
                    {vis.slice(0, VISITAS_VISIBLES).map((v) => (
                      <button
                        key={v[0]}
                        type="button"
                        className="cl-visit u-metric"
                        onClick={() => irA(v[0], 1.5)}
                        title={t("Watch this visit")}
                      >
                        {mmss(v[0] - videoOffset)}
                      </button>
                    ))}
                    {vis.length > VISITAS_VISIBLES && <span className="cl-soft">+{vis.length - VISITAS_VISIBLES}</span>}
                  </span>
                  <button type="button" className="cl-link" onClick={() => setCaja(null)}>{t("Clear")}</button>
                </>
              ) : (
                <>
                  <span>{t("Your cursor never stayed a second in that box.")}</span>
                  <button type="button" className="cl-link" onClick={() => setCaja(null)}>{t("Clear")}</button>
                </>
              )
            ) : elegido ? (
              <span>
                {t("Stretch at {time}: {pct} straight, {path} px of path for {straight} px of straight line.", {
                  time: mmss(elegido.start - videoOffset),
                  pct: withPercent(Math.round(elegido.efficiency * 100)),
                  path: Math.round(elegido.path_px).toLocaleString(),
                  straight: Math.round(elegido.straight_px).toLocaleString(),
                })}
              </span>
            ) : (
              <span>
                {modo === "cursor"
                  ? t("Where your cursor spent its time. The dashed box is the minimap; the cross, your champion with the camera locked.")
                  : t("Where you clicked, left and right together.")}
              </span>
            )}
          </figcaption>
        </figure>

        <div className="cl-side">
          <div className="mt-sub">
            <span className="u-label">{t("Your 10-click stretches")}</span>
            <HelpDot text={t("Ten clicks in a row without a pause or a death in between, ranked by efficiency. Stretches where the hand barely moved (ten clicks on the same target) don't enter.")} />
            <i className="sect__rule" />
          </div>
          <Segmented
            size="sm"
            label={t("Which stretches")}
            value={lado}
            onChange={(v) => {
              setLado(v);
              setElegido(null);
            }}
            options={[
              { value: "worst", label: t("Most crooked") },
              { value: "best", label: t("Straightest") },
            ]}
          />
          {lista.length === 0 ? (
            <p className="note" style={{ margin: 0 }}>{t("Not enough clicks in a row to rank.")}</p>
          ) : (
            <ol className="cl-wins">
              {lista.map((w) => {
                const activo = elegido?.start === w.start;
                return (
                  <li key={w.start} className="cl-win" data-active={activo || undefined}>
                    <button
                      type="button"
                      className="cl-win__pick"
                      aria-pressed={activo}
                      onClick={() => {
                        setCaja(null);
                        setElegido(activo ? null : w);
                      }}
                    >
                      <span className="u-metric cl-win__time">{mmss(w.start - videoOffset)}</span>
                      <span className="cl-win__bar" aria-hidden="true">
                        <i style={{ width: `${Math.round(w.efficiency * 100)}%` }} data-tone={lado === "best" ? "win" : "loss"} />
                      </span>
                      <span className="u-metric cl-win__pct">{withPercent(Math.round(w.efficiency * 100))}</span>
                      <span className="cl-win__dur">{t("{s} s", { s: formatDecimal(w.end - w.start) })}</span>
                    </button>
                    <button type="button" className="cl-win__go" onClick={() => ver(w)} title={t("Watch it in the video")} aria-label={t("Watch it in the video")}>
                      <Play size={12} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ol>
          )}

          <div className="mt-sub">
            <span className="u-label">{t("Your click rhythm")}</span>
            <HelpDot text={t("How often you click when you click in a row (gaps under 1.5 s). Regularity is 100 when every gap is the same and drops the more they vary. Listen plays it back as a metronome.")} />
            <i className="sect__rule" />
          </div>
          {r.rhythm.length === 0 ? (
            <p className="note" style={{ margin: 0 }}>{t("Not enough clicks in a row to measure a rhythm.")}</p>
          ) : (
            <div className="mt-facts">
              {r.rhythm.map((x) => (
                <div key={x.button} className="cl-rhythm">
                  <span className="cl-rhythm__what">
                    {x.button === "left" ? t("Attack · left click") : t("Movement · right click")}
                    <small>
                      {t("{hz} per second · every {ms} ms · regularity {c}/100", {
                        hz: formatDecimal(x.hz),
                        ms: Math.round(x.interval_ms),
                        c: Math.round(x.consistency),
                      })}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm cl-rhythm__play"
                    aria-pressed={sonando === x.button}
                    onClick={() => alternar(x.button, x.hz)}
                  >
                    {sonando === x.button ? <Pause size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
                    {sonando === x.button ? t("Stop") : t("Listen")}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface PantallaProps {
  r: ClickPatterns;
  pts: Pt[];
  modo: "cursor" | "clicks";
  tema: string;
  caja: Caja | null;
  onCaja: (c: Caja | null) => void;
  elegido: ClickWindow | null;
  t: T;
}

/** La pantalla de la partida: el mapa de calor, las guías, la caja y el tramo
 *  elegido. Coordenadas de la caja en píxeles de la PANTALLA de la partida. */
const Pantalla: React.FC<PantallaProps> = ({ r, pts, modo, tema, caja, onCaja, elegido, t }) => {
  const wrap = useRef<HTMLDivElement>(null);
  const lienzo = useRef<HTMLCanvasElement>(null);
  const [ancho, setAncho] = useState(0);
  const [arrastre, setArrastre] = useState<Caja | null>(null);
  const inicio = useRef<{ x: number; y: number } | null>(null);
  const alto = ancho > 0 ? Math.round((ancho * r.screen_h) / r.screen_w) : 0;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setAncho(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // El mapa de calor se calcula una vez por modo y tamaño, no en cada
  // arrastre de la caja.
  const calor = useMemo(() => {
    if (ancho <= 0 || alto <= 0 || pts.length === 0) return null;
    const cols = Math.ceil(ancho / CELDA);
    const rows = Math.ceil(alto / CELDA);
    const sx = cols / r.screen_w;
    const sy = rows / r.screen_h;
    const puntos: [number, number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (modo === "clicks") {
        if (p.b) puntos.push([p.x * sx, p.y * sy, 1]);
      } else {
        const sig = pts[i + 1];
        const peso = sig ? Math.min(Math.max(sig.t - p.t, 0), PESO_MAX) : 0;
        if (peso > 0) puntos.push([p.x * sx, p.y * sy, peso]);
      }
    }
    const g = densidad(cols, rows, puntos);
    const vivos = Array.from(g).filter((v) => v > 0).sort((a, b) => a - b);
    const norma = vivos.length ? vivos[Math.min(vivos.length - 1, Math.floor(vivos.length * 0.999))] : 1;
    return { g, cols, rows, norma };
  }, [pts, modo, ancho, alto, r.screen_w, r.screen_h]);

  useEffect(() => {
    const c = lienzo.current;
    if (!c || ancho <= 0 || alto <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(ancho * dpr);
    c.height = Math.round(alto * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, ancho, alto);
    const pal = leerPaleta();
    const cool = pal.coolRGB;
    const brand = pal.brandRGB;
    const sx = ancho / r.screen_w;
    const sy = alto / r.screen_h;

    // El calor: del azul («lo tuyo») al oro donde más se concentra.
    if (calor) {
      const { g, cols, rows, norma } = calor;
      const img = new ImageData(cols, rows);
      const ln = Math.log(1 + 20);
      for (let i = 0; i < g.length; i++) {
        if (g[i] <= 0) continue;
        const v = Math.min(1, g[i] / norma);
        const f = Math.log(1 + 20 * v) / ln;
        // Sin suelo de opacidad: lo poco denso se funde con el fondo. Con un
        // suelo, la pantalla entera quedaba bajo una neblina de bordes duros.
        const a = 0.9 * Math.pow(f, 1.3);
        if (a < 0.015) continue;
        const [cr, cg, cb] = mezcla(cool, brand, Math.pow(f, 1.6));
        img.data[i * 4] = cr;
        img.data[i * 4 + 1] = cg;
        img.data[i * 4 + 2] = cb;
        img.data[i * 4 + 3] = Math.round(255 * a * (elegido ? 0.35 : 1));
      }
      const off = document.createElement("canvas");
      off.width = cols;
      off.height = rows;
      off.getContext("2d")?.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, cols * CELDA, rows * CELDA);
    }

    // Guías: el minimapa, la franja del HUD y el centro (tu campeón con la
    // cámara bloqueada).
    const [mx0, mx1, my0, my1] = r.minimap;
    ctx.strokeStyle = pal.muted;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(mx0 * ancho + 0.5, my0 * alto + 0.5, (mx1 - mx0) * ancho, (my1 - my0) * alto);
    ctx.setLineDash([]);
    const cx = ancho / 2;
    const cy = alto / 2;
    ctx.beginPath();
    ctx.moveTo(cx - 6, cy);
    ctx.lineTo(cx + 6, cy);
    ctx.moveTo(cx, cy - 6);
    ctx.lineTo(cx, cy + 6);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // El tramo elegido: el camino del cursor y sus clics numerados.
    if (elegido) {
      const tramo = pts.filter((p) => p.t >= elegido.start && p.t <= elegido.end);
      ctx.strokeStyle = pal.text;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.beginPath();
      tramo.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x * sx, p.y * sy) : ctx.lineTo(p.x * sx, p.y * sy)));
      ctx.stroke();
      // Las rectas ideales entre clic y clic, punteadas: lo que habría sido el
      // 100 %.
      const clics = tramo.filter((p) => p.b);
      ctx.setLineDash([3, 3]);
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      clics.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x * sx, p.y * sy) : ctx.lineTo(p.x * sx, p.y * sy)));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.font = `600 10px ${pal.font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      clics.forEach((p, i) => {
        ctx.fillStyle = p.b === "left" ? pal.cool : pal.brand;
        ctx.beginPath();
        ctx.arc(p.x * sx, p.y * sy, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = pal.panel;
        ctx.fillText(String(i + 1), p.x * sx, p.y * sy + 0.5);
      });
    }

    // La caja (la que se arrastra o la ya puesta).
    const k = arrastre ?? caja;
    if (k) {
      ctx.strokeStyle = pal.text;
      ctx.lineWidth = 1.5;
      ctx.fillStyle = `rgba(${rgb(pal.text).join(",")}, 0.08)`;
      const x = k.x0 * sx;
      const y = k.y0 * sy;
      ctx.fillRect(x, y, (k.x1 - k.x0) * sx, (k.y1 - k.y0) * sy);
      ctx.strokeRect(x, y, (k.x1 - k.x0) * sx, (k.y1 - k.y0) * sy);
    }
  }, [calor, ancho, alto, r, pts, elegido, caja, arrastre, tema]);

  // La caja se arrastra con el puntero; un clic sin arrastrar la quita.
  const aPantalla = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    const y = Math.min(Math.max(e.clientY - rect.top, 0), rect.height);
    return { x: (x / rect.width) * r.screen_w, y: (y / rect.height) * r.screen_h, cx: x, cy: y };
  };
  const normal = (a: { x: number; y: number }, b: { x: number; y: number }): Caja => ({
    x0: Math.min(a.x, b.x),
    y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x),
    y1: Math.max(a.y, b.y),
  });

  return (
    <div ref={wrap} className="cl-screen__wrap">
      <canvas
        ref={lienzo}
        className="cl-screen__canvas"
        style={{ width: ancho, height: alto }}
        role="img"
        aria-label={t("Map of your cursor on the screen")}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const p = aPantalla(e);
          inicio.current = p;
          setArrastre(null);
        }}
        onPointerMove={(e) => {
          if (!inicio.current) return;
          setArrastre(normal(inicio.current, aPantalla(e)));
        }}
        onPointerUp={(e) => {
          const a = inicio.current;
          inicio.current = null;
          setArrastre(null);
          if (!a) return;
          const p = aPantalla(e);
          const k = normal(a, p);
          // Menos de 6 px de lienzo por lado es un clic, no una caja.
          const lado = Math.min(((k.x1 - k.x0) / r.screen_w) * ancho, ((k.y1 - k.y0) / r.screen_h) * alto);
          onCaja(lado >= 6 ? k : null);
        }}
        onPointerCancel={() => {
          inicio.current = null;
          setArrastre(null);
        }}
      />
    </div>
  );
};
