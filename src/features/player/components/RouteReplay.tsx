import React, { useEffect, useMemo, useRef, useState } from "react";
import { Video } from "lucide-react";
import type { MatchTrack } from "../../../core/tauri-ipc";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { EmptyState } from "../../../components/ui/EmptyState";
import { campLabel, SIDE_TONE } from "../jungleRoute";
import { useMatchTrack } from "../useMatchData";
import "./RouteReplay.css";

/**
 * El Recorrido: tu partida entera dibujada sobre el minimapa, sincronizada
 * con el vídeo.
 *
 * Idea del «Minimap Recorder» que se compartió por Discord (2026-10-07). Los
 * datos salen de `src-tauri/src/track.rs`; aquí sólo se pinta. El vídeo sigue
 * reproduciéndose debajo (tapado, no oculto: oculto el navegador dejaría de
 * decodificarlo), así que el play, la línea de tiempo y las velocidades del
 * reproductor mueven también esto. Las dos vistas pequeñas de la derecha se
 * copian del propio `<video>` con `drawImage` en cada fotograma: siempre van
 * sincronizadas y no hay un segundo vídeo que decodificar.
 */

/** Extensión del mapa en coordenadas de juego: la misma que usa el detector. */
const MAPA = 14870;
/** Recorte del minimapa en la grabación (fracciones de `minimap_positions.py`). */
const MM = { x0: 0.787, x1: 0.995, y0: 0.622, y1: 0.972 };
/** Un hueco mayor que esto en el rastro corta la línea (vuelta a base, icono perdido). */
const CORTE_S = 4;
const CORTE_U = 2500;
/** Lo que dura la estela corta. */
const ESTELA_S = 30;

type Modo = "recent" | "sofar" | "all";
type Fase = "all" | "early" | "mid" | "late";
const FASES: { key: Fase; label: string; from: number; to: number }[] = [
  { key: "all", label: "All", from: 0, to: Infinity },
  { key: "early", label: "Early", from: 0, to: 14 * 60 },
  { key: "mid", label: "Mid", from: 14 * 60, to: 25 * 60 },
  { key: "late", label: "Late", from: 25 * 60, to: Infinity },
];

interface Props {
  matchId: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Salta el VÍDEO a ese segundo. */
  onSeek: (videoSeconds: number) => void;
  /** Volver a la vista del vídeo. */
  onClose: () => void;
}

/** Color de un instante: de jade al principio a oro al final. */
const tono = (t: number, dur: number) =>
  `color-mix(in oklab, var(--brand) ${Math.round(Math.min(1, Math.max(0, t / dur)) * 100)}%, var(--cool))`;

/** Posición tuya en `t`, interpolada; `null` si cae en un hueco del rastro. */
function posicionEn(me: MatchTrack["me"], t: number): { x: number; y: number; stale: boolean } | null {
  if (me.length === 0) return null;
  let lo = 0;
  let hi = me.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (me[mid][0] <= t) lo = mid; else hi = mid - 1;
  }
  const a = me[lo];
  const b = me[lo + 1];
  if (a[0] > t) return { x: a[1], y: a[2], stale: true };
  if (!b) return { x: a[1], y: a[2], stale: t - a[0] > CORTE_S };
  const dt = b[0] - a[0];
  if (dt > CORTE_S || Math.hypot(b[1] - a[1], b[2] - a[2]) > CORTE_U) {
    return { x: a[1], y: a[2], stale: t - a[0] > CORTE_S };
  }
  const f = dt > 0 ? (t - a[0]) / dt : 0;
  return { x: a[1] + (b[1] - a[1]) * f, y: a[2] + (b[2] - a[2]) * f, stale: false };
}

/** Tramos continuos del rastro entre `from` y `to`, troceados para colorear por tiempo. */
function tramos(me: MatchTrack["me"], from: number, to: number, dur: number): { d: string; color: string }[] {
  const out: { d: string; color: string }[] = [];
  let pts: string[] = [];
  let t0 = 0;
  let prev: [number, number, number] | null = null;
  const cerrar = () => {
    if (pts.length > 1) out.push({ d: `M${pts.join("L")}`, color: tono(t0, dur) });
    pts = [];
  };
  for (const p of me) {
    if (p[0] < from || p[0] > to) continue;
    const roto = prev && (p[0] - prev[0] > CORTE_S || Math.hypot(p[1] - prev[1], p[2] - prev[2]) > CORTE_U);
    // Trozos de ~20 s: cada uno lleva el color de su momento.
    if (roto || (pts.length > 0 && p[0] - t0 > 20)) {
      const ultimo = !roto && pts.length ? pts[pts.length - 1] : null;
      cerrar();
      if (ultimo) pts.push(ultimo);
    }
    if (pts.length === 0) t0 = p[0];
    pts.push(`${Math.round(p[1])} ${Math.round(MAPA - p[2])}`);
    prev = p;
  }
  cerrar();
  return out;
}

export const RouteReplay: React.FC<Props> = ({ matchId, videoRef, onSeek, onClose }) => {
  const t = useT();
  const resp = useMatchTrack(matchId);

  if (resp === undefined) {
    return <div className="rr rr--center"><div className="spinner" /></div>;
  }
  if (!resp || resp.status !== "ok" || !resp.track) {
    const st = resp?.status;
    return (
      <div className="rr rr--center">
        <EmptyState
          title={st === "no_minimap" ? t("Measure this game with video to see its route") : t("No route for this game")}
          text={
            st === "no_minimap"
              ? t("The route comes from your icon on the minimap. Measure it from the Impact tab, in Video analysis.")
              : st === "no_riot"
                ? t("It needs the game synced with Riot.")
                : t("The video could not follow your icon well enough.")
          }
          action={
            <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
              <Video size={13} /> {t("Back to the video")}
            </button>
          }
        />
      </div>
    );
  }
  return <Mapa tr={resp.track} videoRef={videoRef} onSeek={onSeek} onClose={onClose} />;
};

const Mapa: React.FC<{
  tr: MatchTrack;
  videoRef: Props["videoRef"];
  onSeek: Props["onSeek"];
  onClose: Props["onClose"];
}> = ({ tr, videoRef, onSeek, onClose }) => {
  const t = useT();
  const [modo, setModo] = useState<Modo>("sofar");
  const [fase, setFase] = useState<Fase>("all");
  const [otros, setOtros] = useState(true);
  // El instante, en segundos de PARTIDA. Se refresca en cada fotograma: el
  // `currentTime` del reproductor sólo llega ~4 veces por segundo y el icono
  // iría a saltos.
  const [now, setNow] = useState(0);
  const recorte = useRef<HTMLCanvasElement>(null);
  const vista = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let raf = 0;
    let ultimo = -1;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        const g = v.currentTime - tr.video_offset;
        if (Math.abs(g - ultimo) > 0.03) {
          ultimo = g;
          setNow(g);
        }
        if (v.readyState >= 2 && v.videoWidth > 0) {
          const c = recorte.current;
          const cx = c?.getContext("2d");
          if (c && cx) {
            const sx = v.videoWidth * MM.x0;
            const sy = v.videoHeight * MM.y0;
            const sw = v.videoWidth * (MM.x1 - MM.x0);
            const sh = v.videoHeight * (MM.y1 - MM.y0);
            if (c.width !== Math.round(sw)) { c.width = Math.round(sw); c.height = Math.round(sh); }
            cx.drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
          }
          const p = vista.current;
          const px = p?.getContext("2d");
          if (p && px) px.drawImage(v, 0, 0, p.width, p.height);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoRef, tr.video_offset]);

  const dur = Math.max(1, tr.duration);
  const f = FASES.find((x) => x.key === fase) ?? FASES[0];
  // La estela se recalcula a saltos (cada 2 s en "hasta ahora", cada 0,5 s en
  // la corta): rehacer 4.000 puntos en cada fotograma no aporta nada visible.
  const cubo = modo === "sofar" ? Math.floor(now / 2) : modo === "recent" ? Math.floor(now * 2) : 0;
  const [desde, hasta] =
    modo === "all" ? [f.from, f.to] : modo === "recent" ? [now - ESTELA_S, now] : [0, now];
  const estela = useMemo(
    () => tramos(tr.me, desde, hasta, dur),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tr, modo, fase, cubo, dur]
  );
  // La estela es lo caro (hasta ~2.000 trazos en "completa"): se memoriza el
  // ELEMENTO, no sólo los datos, para que el refresco de cada fotograma —que
  // sólo mueve tu icono— no haga a React recorrerla entera. Debajo de cada
  // trazo va otro oscuro: el oro del final de partida se perdía sobre las
  // calles beige del minimapa.
  const estelaEl = useMemo(
    () => (
      <>
        <g className="rr-trail-halo">
          {estela.map((s, i) => <path key={i} d={s.d} />)}
        </g>
        <g className="rr-trail">
          {estela.map((s, i) => <path key={i} d={s.d} style={{ stroke: s.color }} />)}
        </g>
      </>
    ),
    [estela]
  );
  const visible = (x: number) => x >= desde && x <= hasta;
  const ir = (gameSec: number) => onSeek(Math.max(0, gameSec + tr.video_offset - 3));

  const yo = posicionEn(tr.me, now);
  const demas = useMemo(() => {
    if (!otros) return null;
    let mejor: MatchTrack["others"][number] | null = null;
    let d = 1.2;
    // Las muestras van una por segundo: basta mirar alrededor del índice.
    const i = Math.max(0, Math.min(tr.others.length - 1, Math.round(now - (tr.others[0]?.t ?? 0))));
    for (let k = Math.max(0, i - 3); k <= Math.min(tr.others.length - 1, i + 3); k++) {
      const dd = Math.abs(tr.others[k].t - now);
      if (dd < d) { d = dd; mejor = tr.others[k]; }
    }
    return mejor;
  }, [tr, now, otros]);

  const enMapa = (x: number, y: number) => ({ x, y: MAPA - y });
  const clipId = "rr-face";

  return (
    <div className="rr">
      <div className="rr-map" role="img" aria-label={t("Your route on the minimap")}>
        <img src="/map/rift.png" alt="" draggable={false} />
        <svg viewBox={`0 0 ${MAPA} ${MAPA}`} preserveAspectRatio="none">
          <defs>
            <clipPath id={clipId}><circle r="330" cx="0" cy="0" /></clipPath>
          </defs>

          {/* La estela, coloreada por tiempo. */}
          {estelaEl}

          {/* Campamentos, vueltas a base y muertes del tramo visible. */}
          {tr.clears.filter((c) => visible(c.start)).map((c, i) => {
            const p = posicionEn(tr.me, (c.start + c.end) / 2);
            if (!p) return null;
            const q = enMapa(p.x, p.y);
            return (
              <g key={`c${i}`} className="rr-mark" onClick={() => ir(c.start)}>
                <title>{`${mmss(c.start)} · ${campLabel(c.camp, t)}`}</title>
                <circle cx={q.x} cy={q.y} r="150" style={{ fill: SIDE_TONE[c.side] }} />
              </g>
            );
          })}
          {tr.recalls.filter(visible).map((s, i) => {
            const p = posicionEn(tr.me, s - 10);
            if (!p) return null;
            const q = enMapa(p.x, p.y);
            return (
              <g key={`b${i}`} className="rr-mark rr-mark--base" onClick={() => ir(s - 10)}>
                <title>{`${mmss(s)} · ${t("Recall")}`}</title>
                <rect x={q.x - 140} y={q.y - 140} width="280" height="280" rx="50" />
              </g>
            );
          })}
          {tr.deaths.filter((d) => visible(d.t)).map((d, i) => {
            const q = enMapa(d.x, d.y);
            return (
              <g key={`d${i}`} className="rr-mark rr-mark--death" onClick={() => ir(d.t)}>
                <title>{`${mmss(d.t)} · ${t("Death")}`}</title>
                <circle cx={q.x} cy={q.y} r="260" className="rr-hit" />
                <path d={`M${q.x - 190} ${q.y - 190}L${q.x + 190} ${q.y + 190}M${q.x + 190} ${q.y - 190}L${q.x - 190} ${q.y + 190}`} />
              </g>
            );
          })}

          {/* Los demás en este instante: aliados siempre, rivales si se veían. */}
          {demas && (
            <g className="rr-others">
              {demas.a.map(([x, y], i) => {
                const q = enMapa(x, y);
                return <circle key={`a${i}`} cx={q.x} cy={q.y} r="230" className="rr-ally" />;
              })}
              {demas.e.map(([x, y], i) => {
                const q = enMapa(x, y);
                return <circle key={`e${i}`} cx={q.x} cy={q.y} r="230" className="rr-enemy" />;
              })}
            </g>
          )}

          {/* Tú. */}
          {yo && (() => {
            const q = enMapa(yo.x, yo.y);
            return (
              <g transform={`translate(${q.x} ${q.y})`} className={yo.stale ? "rr-me rr-me--stale" : "rr-me"}>
                <circle r="380" className="rr-me__ring" />
                <image
                  href={`/champions/${tr.champion}.png`}
                  x="-330" y="-330" width="660" height="660"
                  clipPath={`url(#${clipId})`}
                  preserveAspectRatio="xMidYMid slice"
                />
              </g>
            );
          })()}
        </svg>
      </div>

      <div className="rr-side">
        <div className="rr-ctl">
          <span className="u-label">{t("Trail")}</span>
          <span className="tp-seg">
            {([
              ["recent", "Last 30 s"],
              ["sofar", "So far"],
              ["all", "Whole game"],
            ] as [Modo, string][]).map(([k, l]) => (
              <button key={k} type="button" aria-pressed={modo === k} data-on={modo === k ? "" : undefined} onClick={() => setModo(k)}>
                {t(l)}
              </button>
            ))}
          </span>
          {modo === "all" && (
            <span className="tp-seg">
              {FASES.map((x) => (
                <button key={x.key} type="button" aria-pressed={fase === x.key} data-on={fase === x.key ? "" : undefined} onClick={() => setFase(x.key)}>
                  {t(x.label)}
                </button>
              ))}
            </span>
          )}
          <label className="rr-check">
            <input type="checkbox" className="vp-check" checked={otros} onChange={() => setOtros((o) => !o)} />
            {t("Show allies and visible enemies")}
          </label>
        </div>

        <div className="rr-legend">
          <span className="rr-grad" aria-hidden="true" />
          <span className="rr-grad-labels"><span>0:00</span><span>{mmss(dur)}</span></span>
          <span className="rr-keys">
            <span><i className="rr-k rr-k--ally" />{t("ally")}</span>
            <span><i className="rr-k rr-k--enemy" />{t("enemy")}</span>
            <span><i className="rr-k rr-k--base" />{t("recall")}</span>
            <span><i className="rr-k rr-k--death" />{t("death")}</span>
            {tr.clears.length > 0 && <span><i className="rr-k" style={{ background: SIDE_TONE.own }} />{t("camp")}</span>}
          </span>
        </div>

        <figure className="rr-fig">
          <canvas ref={recorte} className="rr-crop" />
          <figcaption>{t("Your recording's minimap")}</figcaption>
        </figure>
        <figure className="rr-fig">
          <button type="button" className="rr-preview" onClick={onClose} title={t("Back to the video")}>
            <canvas ref={vista} width={320} height={180} />
          </button>
          <figcaption>{t("Video")} · <span className="u-time">{mmss(Math.max(0, now))}</span></figcaption>
        </figure>
      </div>
    </div>
  );
};
