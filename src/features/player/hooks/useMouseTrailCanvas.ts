import { useEffect, useMemo, useRef, useState } from "react";
import { MatchMetadata, MouseEventData } from "../../../types";
import { EVENTOS_VIDEO, mouseSpace } from "../components/videoPlayerUtils";

/**
 * La estela del ratón sobre el vídeo: un canvas que se pinta siguiendo el
 * reloj del `<video>`.
 *
 * El hook es dueño del canvas y del desfase de sincronía (`mouseSync`,
 * persistido en localStorage); el componente solo coloca el `<canvas>`
 * devuelto encima del vídeo.
 *
 * El dibujo es «Cinta» (elegida por el usuario el 2026-11-21 entre cinco
 * propuestas sobre una pelea real): un solo trazo en el oro de la app que se
 * afila hacia atrás, con un filo oscuro para leerse sobre zonas claras; el
 * clic derecho (moverse) es un aro azul que se cierra y el izquierdo (atacar,
 * objetivo) un rombo rojo; cada habilidad sale con su tecla donde estaba el
 * cursor. Antes eran 1 s de trazo grueso del oro al azul y el mismo aro con
 * resplandor para los dos clics: no se distinguía moverse de atacar y en las
 * peleas tapaba el juego.
 */
type Rgb = readonly [number, number, number];

/**
 * Colores FIJOS, los del tema oscuro: la estela va sobre el vídeo, que no
 * cambia con el tema. Antes salían de los tokens y en el tema claro el trazo
 * era un oro oscuro sobre la partida.
 */
const ORO: Rgb = [209, 168, 86]; // --brand
const AZUL: Rgb = [90, 169, 242]; // --cool: tú, moverte
const ROJO: Rgb = [255, 90, 110]; // --signal: atacar
const TEXTO: Rgb = [198, 198, 203]; // --text
const PANEL: Rgb = [27, 27, 31]; // --panel
const FONDO: Rgb = [17, 17, 20]; // --ground
const MONO = "'JetBrains Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace";

/** Cuánto dura el trazo, el aro de un clic derecho, el rombo y la tecla (s). */
const COLA_S = 0.8;
const MOVER_S = 0.45;
const ATACAR_S = 0.6;
const TECLA_S = 0.9;
/** La misma tecla pulsada otra vez antes de esto es la misma ráfaga: una chapa. */
const RAFAGA_S = 0.5;
/** Cada cuánto se toma la posición para el trazo: la estela se graba a ~30
 *  muestras por segundo; entre medias se interpola y la cinta sale suave. */
const PASO_S = 1 / 60;

const rgba = (c: Rgb, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;

/** Primer índice con `t >= t0` en un array ordenado por `t`. */
function desde(eventos: MouseEventData[], t0: number): number {
  let lo = 0;
  let hi = eventos.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (eventos[mid].t < t0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Dónde estaba el cursor en el instante t, interpolando entre dos muestras. */
function cursorEn(movs: MouseEventData[], t: number): [number, number] {
  const i = desde(movs, t);
  if (i <= 0) return [movs[0].x, movs[0].y];
  if (i >= movs.length) return [movs[movs.length - 1].x, movs[movs.length - 1].y];
  const a = movs[i - 1];
  const b = movs[i];
  const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
  return [a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k];
}

export function useMouseTrailCanvas(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  match: MatchMetadata,
  mouseEvents: MouseEventData[]
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Ordenada por tiempo, una vez, y partida en dos: los movimientos (el trazo)
  // y las marcas (clics y teclas). Cada fotograma busca su ventana por
  // bisección en vez de filtrar las ~36.000 muestras de la partida.
  const { movs, marcas, huecos } = useMemo(() => {
    let lista = mouseEvents;
    for (let i = 1; i < lista.length; i++) {
      if (lista[i].t < lista[i - 1].t) {
        lista = [...mouseEvents].sort((a, b) => a.t - b.t);
        break;
      }
    }
    // Una chapa por ráfaga, no por pulsación: en las peleas la misma tecla se
    // pulsa 2-4 veces seguidas (0,1-0,2 s entre una y otra) y solo la primera
    // lanza la habilidad. Con una chapa por pulsación parecía que la lanzabas
    // el triple. Medido en una partida de Gwen: 172 E grabadas, 134 ráfagas,
    // 128 casteos según Riot (Q 459 / 159 / 160, R 53 / 33 / 35).
    const ultimaPulsacion = new Map<string, number>();
    const marcas = lista.filter((e) => {
      if (e.evt === "move") return false;
      if (!e.evt.startsWith("key_")) return true;
      const anterior = ultimaPulsacion.get(e.evt);
      ultimaPulsacion.set(e.evt, e.t);
      return anterior === undefined || e.t - anterior >= RAFAGA_S;
    });
    // Teclas distintas casi a la vez (E y Q en el mismo segundo) caían en el
    // mismo sitio y una chapa tapaba a la otra. Cada chapa toma el primer hueco
    // a la derecha que no ocupe otra todavía visible y cercana. Se decide una
    // vez aquí, no en cada fotograma, para que una chapa no salte de sitio
    // cuando se apaga la de al lado.
    const huecos = new Array<number>(marcas.length).fill(0);
    const cerca = 0.025 * (match.mouse_space_w || 2560);
    const vivas: { t: number; x: number; y: number; hueco: number }[] = [];
    marcas.forEach((m, i) => {
      if (!m.evt.startsWith("key_")) return;
      while (vivas.length > 0 && m.t - vivas[0].t >= TECLA_S) vivas.shift();
      const ocupados = new Set(
        vivas.filter((v) => Math.abs(v.x - m.x) < cerca && Math.abs(v.y - m.y) < cerca).map((v) => v.hueco)
      );
      let h = 0;
      while (ocupados.has(h)) h++;
      huecos[i] = h;
      vivas.push({ t: m.t, x: m.x, y: m.y, hueco: h });
    });
    return { movs: lista.filter((e) => e.evt === "move"), marcas, huecos };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mouseEvents, match.mouse_space_w]);

  const [mouseSync, setMouseSync] = useState<number>(() => {
    return parseFloat(localStorage.getItem("mouseSyncOffset") || "1.0");
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Solo se pinta cuando el vídeo cambia de instante: mientras se reproduce,
    // con cada fotograma del vídeo; parado, una vez al buscar, al cargar o al
    // cambiar de tamaño. Antes el bucle de requestAnimationFrame no paraba nunca, ni con
    // el vídeo en pausa ni con el reproductor oculto en otra pantalla: 240
    // repintados por segundo que tenían el hilo principal despierto en cada
    // fotograma y competían con todas las animaciones de la app (medido).
    let raf = 0;
    /** Hay algo dibujado que borrar antes del siguiente fotograma. */
    let lleno = false;

    const pintar = () => {
      const v = videoRef.current;
      if (!v) return;
      if (lleno) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        lleno = false;
      }
      if (movs.length === 0 || canvas.width === 0) return;

      // Las coordenadas del ratón vienen de rdev y están en el espacio del
      // ESCRITORIO, no del vídeo. Escalar por las dimensiones del vídeo desplazaba
      // toda la estela cuando se grababa a una resolución distinta a la del monitor
      // (1080p en un monitor 1440p = todo dibujado un 33% más lejos del origen).
      const videoW = v.videoWidth || 1920;
      const videoH = v.videoHeight || 1080;
      const [spaceW, spaceH] = mouseSpace(match, videoW, videoH);

      // El <video> se pinta con `object-fit: contain`, asi que cuando la
      // proporcion del contenedor no coincide con la del video quedan barras y
      // la imagen ocupa solo una parte. El canvas, en cambio, cubre el
      // contenedor entero: hay que mapear sobre el rectangulo donde el video se
      // pinta de verdad.
      const fit = Math.min(canvas.width / videoW, canvas.height / videoH);
      const paintedW = videoW * fit;
      const paintedH = videoH * fit;
      const offX = (canvas.width - paintedW) / 2;
      const offY = (canvas.height - paintedH) / 2;
      const px = (x: number) => offX + x * (paintedW / spaceW);
      const py = (y: number) => offY + y * (paintedH / spaceH);
      // Grosores y tamaños en proporción al vídeo pintado: los mismos a
      // cualquier tamaño de ventana y en pantalla completa.
      const s = paintedW / 1100;

      const t = v.currentTime - mouseSync;
      const inicio = Math.max(t - COLA_S, movs[0].t);
      if (t < movs[0].t || inicio > movs[movs.length - 1].t + COLA_S) return;
      lleno = true;

      // --- La cinta: posiciones cada PASO_S, de lo viejo a lo nuevo.
      const pts: [number, number, number][] = [];
      for (let u = inicio; u <= t + 1e-9; u += PASO_S) {
        const [x, y] = cursorEn(movs, u);
        pts.push([u, px(x), py(y)]);
      }
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const n = pts.length;
      // Primero el filo oscuro de todo el trazo y luego el oro encima: si van
      // alternados, cada tramo tapa el oro del anterior en las curvas cerradas.
      // El color se fija una vez por pasada y lo que cambia por tramo es
      // globalAlpha (un número): construir y leer un rgba() por tramo era la
      // mitad del coste del dibujo.
      for (let pasada = 0; pasada < 2; pasada++) {
        ctx.strokeStyle = pasada === 0 ? rgba(FONDO, 1) : rgba(ORO, 1);
        for (let i = 1; i < n; i++) {
          const [, xa, ya] = pts[i - 1];
          const [u, xb, yb] = pts[i];
          const e = Math.max(0, 1 - (t - u) / COLA_S);
          const ancho = (0.8 + 4.2 * e * e) * s;
          ctx.lineWidth = pasada === 0 ? ancho + 2.6 * s : ancho;
          ctx.globalAlpha = pasada === 0 ? 0.5 * (i / n) : Math.pow(e, 1.1);
          ctx.beginPath();
          ctx.moveTo(xa, ya);
          ctx.lineTo(xb, yb);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      // --- Clics y teclas recientes.
      for (let i = desde(marcas, t - TECLA_S); i < marcas.length; i++) {
        const m = marcas[i];
        if (m.t > t) break;
        const edad = t - m.t;
        const x = px(m.x);
        const y = py(m.y);
        if (m.evt === "right_click") {
          // Moverte: un aro azul que se cierra sobre el punto, como el del juego.
          const k = edad / MOVER_S;
          if (k > 1) continue;
          ctx.lineWidth = 2 * s;
          ctx.strokeStyle = rgba(AZUL, 1 - k);
          ctx.beginPath();
          ctx.arc(x, y, (13 - 8 * k) * s, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = rgba(AZUL, 0.9 * (1 - k));
          ctx.beginPath();
          ctx.arc(x, y, 1.8 * s, 0, Math.PI * 2);
          ctx.fill();
        } else if (m.evt === "left_click") {
          // Atacar o elegir objetivo: un rombo rojo.
          const k = edad / ATACAR_S;
          if (k > 1) continue;
          // Un cuadrado girado 45°: las puntas quedan a 7 (escalado) del centro.
          const l = (7 * s) / Math.SQRT2;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(Math.PI / 4);
          ctx.lineWidth = 2 * s;
          ctx.strokeStyle = rgba(ROJO, 1 - k);
          ctx.fillStyle = rgba(ROJO, 0.25 * (1 - k));
          ctx.beginPath();
          ctx.rect(-l, -l, 2 * l, 2 * l);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        } else if (m.evt.startsWith("key_")) {
          // Una habilidad o un hechizo: su tecla, junto al cursor, subiendo un poco.
          const k = edad / TECLA_S;
          if (k > 1) continue;
          const letra = m.evt.slice(4, 6).toUpperCase();
          const a = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
          const tam = Math.max(9, 11 * s);
          const w = tam * (letra.length > 1 ? 1.6 : 1) + 9 * s;
          const h = tam + 7 * s;
          const cx = x + 14 * s + huecos[i] * (w + 3 * s);
          const cy = y - 16 * s - 6 * s * k;
          ctx.fillStyle = rgba(PANEL, 0.88 * a);
          ctx.strokeStyle = rgba(TEXTO, 0.22 * a);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(cx - w / 2, cy - h / 2, w, h, 4 * s);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = rgba(TEXTO, a);
          ctx.font = `600 ${tam}px ${MONO}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(letra, cx, cy + 0.5);
        }
      }
    };

    /** Mientras se reproduce, se pinta con cada fotograma NUEVO del vídeo
     *  (requestVideoFrameCallback), no con cada refresco del monitor: a 240 Hz
     *  el bucle de requestAnimationFrame pintaba cuatro veces cada fotograma de
     *  un vídeo a 60, y la estela iba además por delante de la imagen. */
    let vfc: { v: HTMLVideoElement; id: number } | null = null;
    const seguir = () => {
      const v = videoRef.current;
      if (!v || v.paused || v.ended || document.hidden || canvas.width === 0) return;
      if (typeof v.requestVideoFrameCallback === "function") {
        if (!vfc) vfc = { v, id: v.requestVideoFrameCallback(alFotograma) };
      } else if (!raf) {
        raf = requestAnimationFrame(bucle);
      }
    };
    const alFotograma = () => {
      vfc = null;
      pintar();
      seguir();
    };
    const bucle = () => {
      raf = 0;
      pintar();
      seguir();
    };
    const despertar = () => {
      if (!raf) raf = requestAnimationFrame(bucle);
    };

    const resizeObserver = new ResizeObserver(() => {
      // En pixeles de dispositivo, no CSS: en una pantalla HiDPI el trazo salia
      // borroso porque el buffer tenia menos resolucion que la pantalla.
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      lleno = false;
      despertar();
    });
    resizeObserver.observe(canvas);

    // Los eventos del <video> no burbujean, pero se ven en la captura del
    // documento: así da igual que el elemento cambie.
    const alVideo = (e: Event) => {
      if (e.target === videoRef.current) despertar();
    };
    for (const ev of EVENTOS_VIDEO) document.addEventListener(ev, alVideo, true);
    despertar();
    return () => {
      cancelAnimationFrame(raf);
      if (vfc) vfc.v.cancelVideoFrameCallback(vfc.id);
      resizeObserver.disconnect();
      for (const ev of EVENTOS_VIDEO) document.removeEventListener(ev, alVideo, true);
    };
    // `match` solo importa aquí a través de mouseSpace (resolución del
    // escritorio grabado); cambia junto con mouseEvents, que sí está.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movs, marcas, huecos, mouseSync]);

  const updateMouseSync = (val: number) => {
    setMouseSync(val);
    localStorage.setItem("mouseSyncOffset", val.toString());
  };

  return { canvasRef, mouseSync, updateMouseSync };
}
