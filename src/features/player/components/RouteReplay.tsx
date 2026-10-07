import React, { useEffect, useRef, useState } from "react";
import { Download, FolderOpen, Video } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { exportRouteVideo } from "../../../core/tauri-ipc";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { SIDE_TONE } from "../jungleRoute";
import { useMatchTrack } from "../useMatchData";
import "./RouteReplay.css";

/**
 * El Recorrido: el vídeo de la partida a la izquierda y, a la derecha, el
 * minimapa de la propia grabación ampliado, con tu estela pintada encima.
 *
 * Idea del «Minimap Recorder» que se compartió por Discord (2026-10-07). La
 * primera versión llevaba también un mapa dibujado; con la estela sobre el
 * minimapa real era el mismo dato dos veces, y el usuario prefirió ver el
 * vídeo. Ahora este componente no tapa el vídeo: convierte `.vp-video` en una
 * rejilla (`.vp-video--route`, ver RouteReplay.css) y el `<video>` de siempre
 * ocupa la celda de la izquierda. El minimapa se copia de ese mismo `<video>`
 * con `drawImage` en cada fotograma: siempre sincronizado y sin un segundo
 * vídeo que decodificar.
 *
 * Los datos del rastro salen de `src-tauri/src/track.rs`. La descarga
 * (`export_route_video`) hace lo mismo con ffmpeg, acelerado.
 */

/** Recorte del minimapa en la grabación (fracciones de `minimap_positions.py`). */
const MM = { x0: 0.787, x1: 0.995, y0: 0.622, y1: 0.972 };
/** Extensión del mapa en coordenadas de juego: la misma que usa el detector. */
const MAPA = 14870;
/** Un hueco mayor que esto corta la estela (vuelta a base, icono perdido). El
 *  rastro salta muestras sin tu icono (hasta 15 s, ver `minimap.rs`): por
 *  debajo de 8 s se une con una recta. */
const CORTE_S = 8;
const CORTE_U = 2500;
const ESTELA_S = 30;

type Modo = "off" | "recent" | "sofar" | "all";
type Fase = "all" | "early" | "mid" | "late";
const FASES: { key: Fase; label: string; from: number; to: number }[] = [
  { key: "all", label: "All", from: 0, to: Infinity },
  { key: "early", label: "Early", from: 0, to: 14 * 60 },
  { key: "mid", label: "Mid", from: 14 * 60, to: 25 * 60 },
  { key: "late", label: "Late", from: 25 * 60, to: Infinity },
];
const VELOCIDADES = [4, 8, 16, 32];
const MODO_KEY = "routeReplay:recTrail";
const ANCHO_KEY = "routeReplay:mmFrac";
/** Con esto el vídeo 16:9 y el minimapa cuadrado salen de la misma altura:
 *  mm = (ancho − tirador) · 9/25. */
const ANCHO_DEF = 0.36;

/** "#3CB787" → [60, 183, 135]. */
function rgb(hex: string): [number, number, number] {
  const h = hex.trim().replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6), 16);
  return Number.isNaN(n) ? [200, 170, 110] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Degradado jade→oro por tiempo, en RGB: un lienzo no entiende `var()`. */
function tonoRGB(t: number, dur: number, a: [number, number, number], b: [number, number, number]): string {
  const f = Math.min(1, Math.max(0, t / dur));
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function leerModo(): Modo {
  try {
    const v = localStorage.getItem(MODO_KEY);
    return v === "off" || v === "recent" || v === "sofar" || v === "all" ? v : "recent";
  } catch {
    return "recent";
  }
}

function leerAncho(): number {
  try {
    return parseFloat(localStorage.getItem(ANCHO_KEY) ?? "") || ANCHO_DEF;
  } catch {
    return ANCHO_DEF;
  }
}

interface Props {
  matchId: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Volver a la vista del vídeo. */
  onClose: () => void;
}

export const RouteReplay: React.FC<Props> = ({ matchId, videoRef, onClose }) => {
  const t = useT();
  const resp = useMatchTrack(matchId);
  const tr = resp?.status === "ok" ? resp.track : null;
  const [modo, setModoState] = useState<Modo>(leerModo);
  const [fase, setFase] = useState<Fase>("all");
  const [now, setNow] = useState(0);
  const lienzo = useRef<HTMLCanvasElement>(null);
  const barra = useRef<HTMLDivElement>(null);
  // El bucle de pintado lee estado sin rehacerse cada vez que cambia.
  const estado = useRef({ modo, fase });
  estado.current = { modo, fase };

  const setModo = (m: Modo) => {
    setModoState(m);
    try { localStorage.setItem(MODO_KEY, m); } catch { /* sólo esta vez */ }
  };

  // ---------------------------------------------------- ancho del minimapa
  // Una fracción del ancho del escenario, guardada; el máximo lo pone el alto
  // disponible (es un cuadrado) y el mínimo deja sitio al vídeo. Así cuadra
  // en cualquier resolución: se recalcula al cambiar el tamaño.
  const aplicarAncho = (frac: number) => {
    const rejilla = barra.current?.parentElement;
    if (!rejilla) return;
    const r = rejilla.getBoundingClientRect();
    const altoUtil = r.height - (barra.current?.offsetHeight ?? 40) - 64;
    const px = Math.max(220, Math.min(frac * r.width, r.width - 360, altoUtil));
    rejilla.style.setProperty("--rr-mm", `${Math.round(px)}px`);
  };
  useEffect(() => {
    const rejilla = barra.current?.parentElement;
    if (!rejilla) return;
    aplicarAncho(leerAncho());
    const ro = new ResizeObserver(() => aplicarAncho(leerAncho()));
    ro.observe(rejilla);
    return () => {
      ro.disconnect();
      rejilla.style.removeProperty("--rr-mm");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const arrastrar = (e: React.PointerEvent<HTMLDivElement>) => {
    const rejilla = barra.current?.parentElement;
    if (!rejilla) return;
    e.preventDefault();
    const r = rejilla.getBoundingClientRect();
    const mover = (ev: PointerEvent) => {
      const frac = (r.right - ev.clientX - 16) / r.width;
      aplicarAncho(frac);
      try { localStorage.setItem(ANCHO_KEY, String(frac)); } catch { /* sólo esta vez */ }
    };
    const soltar = () => {
      window.removeEventListener("pointermove", mover);
      window.removeEventListener("pointerup", soltar);
    };
    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", soltar);
  };

  // ---------------------------------------------------- pintado
  useEffect(() => {
    let raf = 0;
    let ultimo = -1;
    const css = getComputedStyle(document.documentElement);
    const color = (k: string, def: string) => css.getPropertyValue(k).trim() || def;
    const desde = rgb(color("--cool", "#3CB787"));
    const hasta = rgb(color("--brand", "#C8AA6E"));
    const tick = () => {
      const v = videoRef.current;
      const c = lienzo.current;
      const cx = c?.getContext("2d");
      if (v && c && cx && v.readyState >= 2 && v.videoWidth > 0) {
        const g = v.currentTime - (tr?.video_offset ?? 0);
        if (Math.abs(g - ultimo) > 0.2) {
          ultimo = g;
          setNow(g);
        }
        // El lienzo a la resolución con que se ve (nítido al ampliarlo); el
        // recorte, encajado sin deformar.
        const dpr = window.devicePixelRatio || 1;
        const cw = Math.max(1, Math.round(c.clientWidth * dpr));
        const ch = Math.max(1, Math.round(c.clientHeight * dpr));
        if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
        const sx = v.videoWidth * MM.x0;
        const sy = v.videoHeight * MM.y0;
        const sw = v.videoWidth * (MM.x1 - MM.x0);
        const sh = v.videoHeight * (MM.y1 - MM.y0);
        const k = Math.min(cw / sw, ch / sh);
        const dw = sw * k;
        const dh = sh * k;
        const ox = (cw - dw) / 2;
        const oy = (ch - dh) / 2;
        cx.clearRect(0, 0, cw, ch);
        cx.drawImage(v, sx, sy, sw, sh, ox, oy, dw, dh);

        const { modo: m, fase: fz } = estado.current;
        if (tr && m !== "off") {
          const dur = Math.max(1, tr.duration);
          const f = FASES.find((x) => x.key === fz) ?? FASES[0];
          const [t0, t1] = m === "recent" ? [g - ESTELA_S, g] : m === "sofar" ? [0, g] : [f.from, f.to];
          // Misma conversión que el detector, al revés.
          const px = (x: number) => ox + (x / MAPA) * dw;
          const py = (y: number) => oy + (1 - y / MAPA) * dh;
          const ancho = Math.max(2, dw / 160);
          const trazos: { pts: [number, number][]; t: number }[] = [];
          let cur: { pts: [number, number][]; t: number } | null = null;
          let prev: [number, number, number] | null = null;
          for (const p of tr.me) {
            if (p[0] < t0) continue;
            if (p[0] > t1) break;
            const roto = prev && (p[0] - prev[0] > CORTE_S || Math.hypot(p[1] - prev[1], p[2] - prev[2]) > CORTE_U);
            if (!cur || roto || p[0] - cur.t > 20) {
              const enlace: [number, number] | null = cur && !roto ? cur.pts[cur.pts.length - 1] : null;
              cur = { pts: enlace ? [enlace] : [], t: p[0] };
              trazos.push(cur);
            }
            cur.pts.push([px(p[1]), py(p[2])]);
            prev = p;
          }
          cx.lineCap = "round";
          cx.lineJoin = "round";
          // Debajo, un trazo oscuro: sin él el oro del final se pierde sobre
          // las calles beige. Tenue: encima hay iconos que leer.
          for (const [halo, w] of [[true, ancho * 2], [false, ancho]] as [boolean, number][]) {
            cx.lineWidth = w;
            cx.globalAlpha = halo ? 0.35 : 0.8;
            for (const tz of trazos) {
              if (tz.pts.length < 2) continue;
              cx.strokeStyle = halo ? "#0B1018" : tonoRGB(tz.t, dur, desde, hasta);
              cx.beginPath();
              cx.moveTo(tz.pts[0][0], tz.pts[0][1]);
              for (const q of tz.pts.slice(1)) cx.lineTo(q[0], q[1]);
              cx.stroke();
            }
          }
          // Campamentos (en tu posición de ese momento) y muertes del tramo.
          cx.globalAlpha = 0.95;
          const dondeEstabas = (s: number): [number, number] | null => {
            let best: [number, number, number] | null = null;
            for (const p of tr.me) { if (p[0] > s) break; best = p; }
            return best && s - best[0] < CORTE_S ? [px(best[1]), py(best[2])] : null;
          };
          for (const cl of tr.clears) {
            if (cl.start < t0 || cl.start > t1) continue;
            const q = dondeEstabas((cl.start + cl.end) / 2);
            if (!q) continue;
            cx.fillStyle = cl.side === "own" ? color("--cool", "#3CB787") : cl.side === "enemy" ? color("--loss", "#F26073") : color("--flag", "#A589F1");
            cx.beginPath();
            cx.arc(q[0], q[1], ancho * 1.6, 0, Math.PI * 2);
            cx.fill();
          }
          cx.strokeStyle = color("--loss", "#F26073");
          cx.lineWidth = ancho * 1.2;
          for (const d of tr.deaths) {
            if (d.t < t0 || d.t > t1) continue;
            const x = px(d.x);
            const y = py(d.y);
            const r = ancho * 2.5;
            cx.beginPath();
            cx.moveTo(x - r, y - r); cx.lineTo(x + r, y + r);
            cx.moveTo(x + r, y - r); cx.lineTo(x - r, y + r);
            cx.stroke();
          }
          cx.globalAlpha = 1;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoRef, tr]);

  const seg = <K extends string>(opts: [K, string][], val: K, set: (k: K) => void) => (
    <span className="tp-seg">
      {opts.map(([k, l]) => (
        <button key={k} type="button" aria-pressed={val === k} data-on={val === k ? "" : undefined} onClick={() => set(k)}>
          {t(l)}
        </button>
      ))}
    </span>
  );

  const aviso =
    resp === undefined
      ? null
      : resp?.status === "no_minimap"
        ? t("Measure this game with video to draw your trail on it (Impact tab, Video analysis).")
        : !tr
          ? t("The video could not follow your icon well enough to draw your trail.")
          : null;

  return (
    <>
      <div className="rr-bar" ref={barra}>
        <span className="rr-group">
          <span className="u-label">{t("Your trail")}</span>
          {seg<Modo>([["off", "Off"], ["recent", "Last 30 s"], ["sofar", "So far"], ["all", "Whole game"]], modo, setModo)}
          {modo === "all" && seg<Fase>(FASES.map((x) => [x.key, x.label] as [Fase, string]), fase, setFase)}
        </span>
        <span className="rr-fill" />
        <Descarga matchId={matchId} disponible={!!tr} desde={Math.max(0, now)} modo={modo} />
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} title={`${t("Back to the video")} (R)`}>
          <Video size={13} /> {t("Video only")}
        </button>
      </div>
      <div className="rr-handle" onPointerDown={arrastrar} role="separator" aria-orientation="vertical" title={t("Drag to resize")} />
      <figure className="rr-mm">
        <canvas ref={lienzo} className="rr-crop" />
        <figcaption className="rr-cap">
          {aviso ?? (
            <>
              <span>{t("Your recording's minimap")}</span>
              {tr && modo !== "off" && (
                <>
                  <span className="rr-grad" aria-hidden="true" />
                  <span className="u-time">0:00 → {mmss(tr.duration)}</span>
                  <span><i className="rr-k rr-k--death" />{t("death")}</span>
                  {tr.clears.length > 0 && <span><i className="rr-k" style={{ background: SIDE_TONE.own }} />{t("camp")}</span>}
                </>
              )}
            </>
          )}
        </figcaption>
      </figure>
    </>
  );
};

type Tramo = "all" | "here" | "early" | "mid" | "late";

/** El botón de descarga: el minimapa con tu estela, acelerado, a un MP4. */
const Descarga: React.FC<{ matchId: string; disponible: boolean; desde: number; modo: Modo }> = ({ matchId, disponible, desde, modo }) => {
  const t = useT();
  const [abierto, setAbierto] = useState(false);
  const [vel, setVel] = useState(16);
  const [tramo, setTramo] = useState<Tramo>("all");
  const [pct, setPct] = useState<number | null>(null);
  const [hecho, setHecho] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let quitar: (() => void) | undefined;
    let vivo = true;
    listen<[string, number]>("route_export_progress", (e) => {
      if (e.payload[0] === matchId) setPct(e.payload[1]);
    }).then((u) => { if (vivo) quitar = u; else u(); });
    return () => { vivo = false; quitar?.(); };
  }, [matchId]);

  const generar = async () => {
    const rango: Record<Tramo, [number, number]> = {
      all: [0, 1e9],
      here: [desde, 1e9],
      early: [0, 14 * 60],
      mid: [14 * 60, 25 * 60],
      late: [25 * 60, 1e9],
    };
    const [a, b] = rango[tramo];
    setError(null);
    setHecho(null);
    setPct(0);
    try {
      // La estela "completa" no tiene sentido en un vídeo que avanza: se
      // exporta como "hasta ahora", que la va dibujando.
      const ruta = await exportRouteVideo(matchId, vel, a, b, modo === "off" ? "off" : modo === "recent" ? "recent" : "sofar");
      setHecho(ruta);
      revealItemInDir(ruta).catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setPct(null);
    }
  };

  const tramos: [Tramo, string][] = [["all", "Whole game"], ["here", "From here"], ["early", "Early"], ["mid", "Mid"], ["late", "Late"]];
  return (
    <span className="rr-dl">
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        aria-expanded={abierto}
        disabled={!disponible}
        onClick={() => setAbierto((x) => !x)}
        title={disponible ? undefined : t("Needs the minimap measured with video")}
      >
        <Download size={13} /> {pct != null ? t("Exporting {p}%", { p: Math.round(pct) }) : t("Download")}
      </button>
      {abierto && (
        <div className="rr-pop tp-pop" role="dialog" aria-label={t("Download the route")}>
          <div className="rr-pop-row">
            <span className="u-label">{t("Speed")}</span>
            <span className="tp-seg">
              {VELOCIDADES.map((v) => (
                <button key={v} type="button" aria-pressed={vel === v} data-on={vel === v ? "" : undefined} onClick={() => setVel(v)}>
                  {v}×
                </button>
              ))}
            </span>
          </div>
          <div className="rr-pop-row">
            <span className="u-label">{t("Stretch")}</span>
            <span className="tp-seg">
              {tramos.map(([k, l]) => (
                <button key={k} type="button" aria-pressed={tramo === k} data-on={tramo === k ? "" : undefined} onClick={() => setTramo(k)}>
                  {t(l)}
                </button>
              ))}
            </span>
          </div>
          <p className="note" style={{ margin: 0 }}>
            {modo === "off"
              ? t("Without trail (it is off). Turn it on to draw it in the video.")
              : t("With your trail as you see it now ({m}).", { m: t(modo === "recent" ? "last 30 s" : "so far") })}
          </p>
          <div className="rr-pop-row">
            <button type="button" className="btn btn--primary btn--sm" onClick={generar} disabled={pct != null}>
              <Download size={13} /> {pct != null ? t("Exporting {p}%", { p: Math.round(pct) }) : t("Create MP4")}
            </button>
            {hecho && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => revealItemInDir(hecho).catch(() => {})}>
                <FolderOpen size={13} /> {t("Show in folder")}
              </button>
            )}
          </div>
          {error && <p className="note" style={{ margin: 0, color: "var(--loss)" }}>{error}</p>}
        </div>
      )}
    </span>
  );
};
