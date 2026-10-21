import React, { useEffect, useMemo, useRef, useState } from "react";
import { Download, FolderOpen, RotateCcw, Waves, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { exportRouteVideo, getWaves, type MatchTrack } from "../../../core/tauri-ipc";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { SIDE_TONE } from "../jungleRoute";
import { useMatchTrack } from "../useMatchData";
import type { MapFocus, MapMark, MapTone } from "../mapFocus";
import { LANES, LANE_NAME, smoothWaves, toAxis, waveAt, type Lane, type WaveSeries } from "../laneGeometry";
import {
  dibujarAro,
  dibujarCarril,
  dibujarMarca,
  dibujarRotulos,
  leerPaleta,
  MAPA,
  posicionEn,
  tonoEmpuje,
  type Paleta,
  type Rotulo,
  type Vista,
} from "../mapDraw";
import { EpisodeStrip } from "./EpisodeStrip";
import { Segmented } from "../../../components/ui/Segmented";
import "./RouteReplay.css";

/**
 * El Mapa (antes «Recorrido»): el vídeo de la partida a la izquierda y, a la
 * derecha, el minimapa de la propia grabación ampliado, con tu estela pintada
 * encima.
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
 * Las estadísticas de mapa (oleadas, invasiones, ganks, presión) escritas en
 * la columna lateral no se leían: cada fila de Partida o Impacto abre esto en
 * su momento con un `focus` (mapFocus.ts) y aquí se dibuja lo suyo encima del
 * minimapa, con una tarjeta que dice qué se está mirando.
 *
 * Los datos del rastro salen de `src-tauri/src/track.rs`; las oleadas, de
 * `oleadas.rs`. La descarga (`export_route_video`) hace lo mismo con ffmpeg.
 */

/** Recorte del minimapa en la grabación cuando el rastro no trae el suyo: el
 *  fijo de `minimap_positions.py` (el HUD de la máquina de desarrollo). */
const MM_FIJO = { x0: 0.787, x1: 0.995, y0: 0.622, y1: 0.972 };

/** El recorte con el que se midió este rastro (`track.minimap_rect`): la
 *  estela se pinta sobre el mismo trozo del vídeo del que salió. */
function recorteDe(tr: MatchTrack | null): typeof MM_FIJO {
  const r = tr?.minimap_rect;
  if (!r || r.length !== 4 || !r.every(Number.isFinite)) return MM_FIJO;
  const [x0, x1, y0, y1] = r;
  return 0 <= x0 && x0 < x1 && x1 <= 1 && 0 <= y0 && y0 < y1 && y1 <= 1 ? { x0, x1, y0, y1 } : MM_FIJO;
}
/** Un hueco mayor que esto corta la estela (vuelta a base, icono perdido). El
 *  rastro salta muestras sin tu icono (hasta 15 s, ver `minimap.rs`): por
 *  debajo de 8 s se une con una recta. */
const CORTE_S = 8;
const CORTE_U = 2500;
const ESTELA_S = 30;
/** Una marca con instante se enseña entera a ±esto de él; fuera, atenuada y
 *  con su hora, para que se sepa que no es de ahora. */
const MARCA_S = 8;

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
const OLAS_KEY = "routeReplay:waves";
/** Con esto el vídeo 16:9 y el minimapa cuadrado salen de la misma altura:
 *  mm = (ancho − tirador) · 9/25. */
const ANCHO_DEF = 0.36;

/** Oleadas ya leídas, por partida: el Mapa se monta y desmonta con la tecla R
 *  y `get_waves` vuelve a parsear la timeline cada vez. Sólo lo bueno: un
 *  fallo se reintenta al volver a encender la capa. */
const OLAS_CACHE = new Map<string, WaveSeries>();

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

function leerOlas(): boolean {
  try {
    return localStorage.getItem(OLAS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Sin tono, cada marca tiene el suyo natural: tu muerte y la de un aliado
 *  son malas, un kill bueno, lo demás neutro. */
function tonoPorDefecto(kind: MapMark["kind"]): MapTone {
  return kind === "death" || kind === "ally_death" ? "bad" : kind === "kill" ? "good" : "neutral";
}

/** El foco ya digerido para el bucle de pintado: ventana, carriles en la
 *  escala del eje y textos traducidos. Se rehace al cambiar el foco, no en
 *  cada fotograma. */
interface FocoPrep {
  desde: number;
  hasta: number;
  lanes: { lane: Lane; along: number | null; push: number | null; texto: string }[];
  ring?: number;
  ringTexto: string;
  marks: (MapMark & { tono: MapTone; hora: string | null })[];
}

interface Props {
  matchId: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Volver a la vista del vídeo. Ya no hay botón aquí (la cabecera tiene
   *  Vídeo | Mapa y la tecla R), pero se mantiene en el contrato. */
  onClose: () => void;
  /** El momento con el que se abrió desde una fila (ver mapFocus.ts). */
  focus?: MapFocus | null;
  /** Quitar el foco y volver al mapa de siempre. */
  onClearFocus?: () => void;
  /** Tu equipo (100 azul, 200 rojo): dice hacia dónde está "tu base" en las
   *  oleadas (0 = tu base, 1 = la suya). Sin él no se dibujan oleadas. */
  selfTeam?: number;
  /** Desfase vídeo→partida de la grabación (`match.video_offset`). Opcional:
   *  con rastro se usa el suyo; sin él (partida sin minimapa medido) hace
   *  falta para saber en qué segundo de partida está el vídeo. */
  videoOffset?: number;
}

export const RouteReplay: React.FC<Props> = ({ matchId, videoRef, focus, onClearFocus, selfTeam, videoOffset }) => {
  const t = useT();
  const resp = useMatchTrack(matchId);
  const tr = resp?.status === "ok" ? resp.track : null;
  const [modo, setModoState] = useState<Modo>(leerModo);
  const [fase, setFase] = useState<Fase>("all");
  const [olasOn, setOlasOnState] = useState<boolean>(leerOlas);
  const [olas, setOlas] = useState<WaveSeries | "loading" | "error" | null>(null);
  const [now, setNow] = useState(0);
  const lienzo = useRef<HTMLCanvasElement>(null);
  const barra = useRef<HTMLDivElement>(null);
  const figura = useRef<HTMLElement>(null);
  const equipo = selfTeam === 100 || selfTeam === 200 ? selfTeam : null;

  // El bucle de pintado lee estado sin rehacerse cada vez que cambia.
  const estado = useRef({ modo, fase, olasOn });
  estado.current = { modo, fase, olasOn };
  const olasRef = useRef<WaveSeries | null>(null);
  olasRef.current = Array.isArray(olas) ? olas : null;
  const equipoRef = useRef(equipo);
  equipoRef.current = equipo;

  // Desfase vídeo→partida: el del rastro, el que pase el reproductor o, si no
  // hay ninguno, el que se deduce del salto que hizo al abrir el foco (el
  // reproductor ya ha ido a `t + desfase − lead` cuando llega aquí).
  const offRef = useRef<number | null>(null);
  offRef.current = tr?.video_offset ?? videoOffset ?? null;
  const offEst = useRef<number | null>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (focus && v) offEst.current = v.currentTime - focus.t + (focus.lead ?? 5);
  }, [focus, videoRef]);
  const desfase = () => offRef.current ?? offEst.current ?? 0;

  const setModo = (m: Modo) => {
    setModoState(m);
    try { localStorage.setItem(MODO_KEY, m); } catch { /* sólo esta vez */ }
  };
  const setOlasOn = (on: boolean) => {
    setOlasOnState(on);
    try { localStorage.setItem(OLAS_KEY, on ? "1" : "0"); } catch { /* sólo esta vez */ }
  };

  // ---------------------------------------------------- oleadas
  // Sólo con la capa encendida: la primera vez `get_waves` lee el vídeo
  // (segundos) y no tiene que bloquear nada. Si otra pestaña está leyéndolas
  // a la vez, contesta "reading": se vuelve a preguntar en un rato.
  useEffect(() => {
    if (!olasOn) return;
    const ya = OLAS_CACHE.get(matchId);
    if (ya) {
      setOlas(ya);
      return;
    }
    let vivo = true;
    let espera = 0;
    let intentos = 0;
    setOlas("loading");
    const pedir = () => {
      getWaves(matchId)
        .then((r) => {
          if (!vivo) return;
          if (r.status === "ok" && r.series.length > 0) {
            const s = smoothWaves(r.series);
            OLAS_CACHE.set(matchId, s);
            setOlas(s);
          } else if (r.status === "reading" && intentos++ < 40) {
            espera = window.setTimeout(pedir, 3000);
          } else {
            setOlas("error");
          }
        })
        .catch(() => vivo && setOlas("error"));
    };
    pedir();
    return () => {
      vivo = false;
      window.clearTimeout(espera);
    };
  }, [olasOn, matchId]);

  // ---------------------------------------------------- foco
  const foco = useMemo<FocoPrep | null>(() => {
    if (!focus) return null;
    const lead = focus.lead ?? 5;
    return {
      desde: focus.t - lead - 2,
      hasta: (focus.until ?? focus.t) + 15,
      lanes: equipo
        ? (focus.lanes ?? []).map((l) => ({
            lane: l.lane,
            push: l.push,
            along: l.push == null ? null : toAxis(l.push, equipo),
            texto: t(LANE_NAME[l.lane]),
          }))
        : [],
      ring: focus.ring && focus.ring > 0 ? focus.ring : undefined,
      ringTexto: t("on top of you"),
      marks: (focus.marks ?? []).map((m) => ({ ...m, tono: m.tone ?? tonoPorDefecto(m.kind), hora: m.t != null ? mmss(m.t) : null })),
    };
  }, [focus, equipo, t]);
  const focoRef = useRef(foco);
  focoRef.current = foco;
  const nombres = useMemo(() => Object.fromEntries(LANES.map((l) => [l, t(LANE_NAME[l])])) as Record<Lane, string>, [t]);
  const nombresRef = useRef(nombres);
  nombresRef.current = nombres;

  const dentro = !!foco && now >= foco.desde && now <= foco.hasta;

  const saltarVideo = (videoSecs: number, play: boolean) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, videoSecs);
    if (play && v.paused) v.play().catch(() => {});
  };
  const repetir = () => {
    if (focus) saltarVideo(focus.t + desfase() - (focus.lead ?? 5), true);
  };

  // ---------------------------------------------------- colores
  // Los tokens, leídos una vez y otra al cambiar de tema (data-theme en
  // <html>): leerlos en cada fotograma costaba un getComputedStyle por trazo.
  const paleta = useRef<Paleta | null>(null);
  useEffect(() => {
    paleta.current = leerPaleta();
    const mo = new MutationObserver(() => { paleta.current = leerPaleta(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => mo.disconnect();
  }, []);

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

  // La tarjeta y la franja van encima y debajo del minimapa, no sobre él: el
  // cuadrado encoge lo que ellas ocupan (`--rr-extra`, ver RouteReplay.css).
  useEffect(() => {
    const fig = figura.current;
    if (!fig) return;
    const els = Array.from(fig.querySelectorAll<HTMLElement>("[data-rr-extra]"));
    const medir = () => {
      let h = 0;
      for (const el of els) if (el.offsetHeight > 0) h += el.offsetHeight + 6;
      fig.style.setProperty("--rr-extra", `${h}px`);
    };
    medir();
    const ro = new ResizeObserver(medir);
    els.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [focus]);

  // ---------------------------------------------------- pintado
  useEffect(() => {
    let raf = 0;
    let ultimo = -1;
    const mm = recorteDe(tr);
    // Se reutiliza en cada fotograma: los rótulos se pintan al final, encima
    // de todos los trazos.
    const rotulos: Rotulo[] = [];
    const tick = () => {
      const v = videoRef.current;
      const c = lienzo.current;
      const cx = c?.getContext("2d");
      const pal = paleta.current;
      if (v && c && cx && pal && v.readyState >= 2 && v.videoWidth > 0) {
        const g = v.currentTime - (offRef.current ?? offEst.current ?? 0);
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
        const sx = v.videoWidth * mm.x0;
        const sy = v.videoHeight * mm.y0;
        const sw = v.videoWidth * (mm.x1 - mm.x0);
        const sh = v.videoHeight * (mm.y1 - mm.y0);
        const k = Math.min(cw / sw, ch / sh);
        const dw = sw * k;
        const dh = sh * k;
        const ox = (cw - dw) / 2;
        const oy = (ch - dh) / 2;
        cx.clearRect(0, 0, cw, ch);
        cx.drawImage(v, sx, sy, sw, sh, ox, oy, dw, dh);

        // Misma conversión que el detector, al revés.
        const px = (x: number) => ox + (x / MAPA) * dw;
        const py = (y: number) => oy + (1 - y / MAPA) * dh;
        const ancho = Math.max(2, dw / 160);
        const vista: Vista = { ox, oy, dw, dh, cw, ch, u: ancho, fs: Math.round(Math.min(18 * dpr, Math.max(11.5 * dpr, dw / 46))) };

        const { modo: m, fase: fz, olasOn: conOlas } = estado.current;
        if (tr && m !== "off") {
          const dur = Math.max(1, tr.duration);
          const f = FASES.find((x) => x.key === fz) ?? FASES[0];
          // Con un momento abierto, la estela larga ("hasta ahora", "completa")
          // tapa justo los carriles y las marcas del foco: medio minuto de
          // partida pintado encima de una invasión era una maraña verde. Dentro
          // de su ventana se dibuja sólo lo reciente; fuera, lo que elegiste.
          const fo0 = focoRef.current;
          const corta = m === "recent" || (!!fo0 && g >= fo0.desde && g <= fo0.hasta);
          const [t0, t1] = corta ? [g - ESTELA_S, g] : m === "sofar" ? [0, g] : [f.from, f.to];
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
              cx.strokeStyle = halo ? "#0B1018" : tonoRGB(tz.t, dur, pal.coolRGB, pal.brandRGB);
              cx.beginPath();
              cx.moveTo(tz.pts[0][0], tz.pts[0][1]);
              for (const q of tz.pts.slice(1)) cx.lineTo(q[0], q[1]);
              cx.stroke();
            }
          }
          // Campamentos (en tu posición de ese momento) y muertes del tramo.
          cx.globalAlpha = 0.95;
          for (const cl of tr.clears) {
            if (cl.start < t0 || cl.start > t1) continue;
            const q = posicionEn(tr.me, (cl.start + cl.end) / 2, CORTE_S, CORTE_U);
            if (!q) continue;
            cx.fillStyle = cl.side === "own" ? pal.cool : cl.side === "enemy" ? pal.loss : pal.flag;
            cx.beginPath();
            cx.arc(px(q[0]), py(q[1]), ancho * 1.6, 0, Math.PI * 2);
            cx.fill();
          }
          cx.strokeStyle = pal.loss;
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

        rotulos.length = 0;
        const eq = equipoRef.current;
        const fo = focoRef.current;
        const enFoco = !!fo && g >= fo.desde && g <= fo.hasta;

        // Oleadas de ahora. Un carril que el foco ya señala no se repite: la
        // marca del foco es la del momento que se juzga.
        const serie = olasRef.current;
        if (conOlas && serie && eq) {
          LANES.forEach((lane, i) => {
            if (enFoco && fo.lanes.some((l) => l.lane === lane)) return;
            const val = waveAt(serie, g, (i + 1) as 1 | 2 | 3);
            if (val == null) return;
            dibujarCarril(cx, vista, pal, lane, toAxis(val, eq), eq === 100, tonoEmpuje(val, pal), nombresRef.current[lane], rotulos);
          });
        }

        if (enFoco && fo) {
          if (fo.ring && tr) {
            const yo = posicionEn(tr.me, g, CORTE_S, CORTE_U);
            if (yo) dibujarAro(cx, vista, pal, yo[0], yo[1], fo.ring, fo.ringTexto, rotulos);
          }
          for (const l of fo.lanes) {
            dibujarCarril(cx, vista, pal, l.lane, l.along, eq === 100, l.push == null ? pal.muted : tonoEmpuje(l.push, pal), l.texto, rotulos);
          }
          for (const mk of fo.marks) {
            const cerca = mk.t == null || Math.abs(g - mk.t) <= MARCA_S;
            const alpha = cerca ? 1 : 0.4;
            const tono = mk.tono === "good" ? pal.win : mk.tono === "bad" ? pal.loss : pal.brand;
            const r = dibujarMarca(cx, vista, pal, mk.kind, mk.x, mk.y, tono, alpha);
            const texto = cerca || !mk.hora ? mk.label : mk.label ? `${mk.label} · ${mk.hora}` : mk.hora;
            if (texto) {
              const X = vista.ox + (mk.x / MAPA) * dw;
              rotulos.push({ texto, x: X + r + ancho * 1.2, y: vista.oy + (1 - mk.y / MAPA) * dh, dx: 1, dy: 0, tono, alpha: cerca ? 1 : 0.7, mx: X });
            }
          }
        }
        dibujarRotulos(cx, vista, pal, rotulos);
        cx.globalAlpha = 1;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoRef, tr]);

  const seg = <K extends string>(opts: [K, string][], val: K, set: (k: K) => void, label: string) => (
    <Segmented size="sm" label={label} value={val} onChange={set} options={opts.map(([k, l]) => ({ value: k, label: t(l) }))} />
  );

  const aviso =
    resp === undefined
      ? null
      : resp?.status === "no_minimap"
        ? t("Measure this game with video to draw your trail on it (Impact tab, Video analysis).")
        : !tr
          ? t("The video could not follow your icon well enough to draw your trail.")
          : null;

  // La leyenda de colores de carril hace falta si hay alguno pintado: la capa
  // de oleadas o un foco con carriles en su momento.
  const leyendaOlas = (olasOn && Array.isArray(olas)) || (dentro && (foco?.lanes.length ?? 0) > 0);
  const tono = focus?.tone ?? "neutral";

  return (
    <>
      <div className="rr-bar" ref={barra}>
        <span className="rr-group">
          <span className="u-label">{t("Your trail")}</span>
          {seg<Modo>([["off", "Off"], ["recent", "Last 30 s"], ["sofar", "So far"], ["all", "Whole game"]], modo, setModo, t("Trail"))}
          {modo === "all" && seg<Fase>(FASES.map((x) => [x.key, x.label] as [Fase, string]), fase, setFase, t("Stretch"))}
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-pressed={olasOn}
          disabled={!equipo}
          onClick={() => setOlasOn(!olasOn)}
          title={equipo ? t("Show where each lane's wave is right now") : t("Needs your team to place the waves")}
        >
          <Waves size={13} /> {t("Waves")}
        </button>
        <span className="rr-fill" />
        <Descarga matchId={matchId} disponible={!!tr} desde={Math.max(0, now)} modo={modo} />
      </div>
      <div className="rr-handle" onPointerDown={arrastrar} role="separator" aria-orientation="vertical" title={t("Drag to resize")} />
      <figure className="rr-mm" ref={figura}>
        {focus && (
          <div
            className="rr-focus"
            data-rr-extra=""
            data-tone={tono}
            data-out={dentro ? undefined : ""}
            title={dentro ? undefined : t("Outside this moment. Replay brings it back.")}
            role="note"
          >
            <div className="rr-focus-txt">
              <div className="rr-focus-head">
                <span className="u-time">{mmss(focus.t)}{focus.until != null && focus.until > focus.t ? `–${mmss(focus.until)}` : ""}</span>
                <strong>{focus.title}</strong>
              </div>
              {focus.detail && <p>{focus.detail}</p>}
            </div>
            <button
              type="button"
              className={dentro ? "btn btn--ghost btn--sm" : "btn btn--primary btn--sm"}
              onClick={repetir}
              title={t("Play this moment again")}
            >
              <RotateCcw size={13} /> {t("Replay")}
            </button>
            {onClearFocus && (
              <button type="button" className="btn btn--icon" onClick={onClearFocus} title={t("Close")} aria-label={t("Close")}>
                <X size={14} />
              </button>
            )}
          </div>
        )}
        <canvas ref={lienzo} className="rr-crop" />
        {focus?.episode && (
          <div className="rr-strip" data-rr-extra="">
            <EpisodeStrip
              matchId={matchId}
              from={focus.episode.from}
              to={focus.episode.to}
              now={now}
              onSeekGame={(s) => saltarVideo(s + desfase(), false)}
              compact
            />
          </div>
        )}
        <figcaption className="rr-cap">
          {aviso && <span>{aviso}</span>}
          {!aviso && tr && modo !== "off" && (
            <>
              <span className="rr-grad" aria-hidden="true" />
              <span className="u-time">0:00 → {mmss(tr.duration)}</span>
              <span><i className="rr-k rr-k--death" />{t("death")}</span>
              {tr.clears.length > 0 && <span><i className="rr-k" style={{ background: SIDE_TONE.own }} />{t("camp")}</span>}
            </>
          )}
          {olasOn && olas === "loading" && <span>{t("Reading the waves from the minimap…")}</span>}
          {olasOn && olas === "error" && <span>{t("The waves couldn't be read from this video.")}</span>}
          {leyendaOlas && (
            <>
              <span><i className="rr-k rr-k--bar" style={{ background: "var(--cool)" }} />{t("pushed in your favour")}</span>
              <span><i className="rr-k rr-k--bar" style={{ background: "var(--muted)" }} />{t("middle")}</span>
              <span><i className="rr-k rr-k--bar" style={{ background: "var(--loss)" }} />{t("on your side")}</span>
            </>
          )}
          {!aviso && !(tr && modo !== "off") && !olasOn && !leyendaOlas && <span>{t("Your recording's minimap")}</span>}
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
            <Segmented size="sm" label={t("Speed")} value={vel} onChange={setVel} options={VELOCIDADES.map((v) => ({ value: v, label: `${v}×` }))} />
          </div>
          <div className="rr-pop-row">
            <span className="u-label">{t("Stretch")}</span>
            <Segmented size="sm" label={t("Stretch")} value={tramo} onChange={setTramo} options={tramos.map(([k, l]) => ({ value: k, label: t(l) }))} />
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
