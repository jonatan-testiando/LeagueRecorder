import { useEffect, useRef, useState } from "react";
import { MatchMetadata, MouseEventData } from "../../../types";
import { mouseSpace } from "../components/videoPlayerUtils";

/**
 * La estela del ratón sobre el vídeo: un canvas que se pinta por
 * `requestAnimationFrame` siguiendo el reloj del `<video>`.
 *
 * Extraído de `VideoPlayer.tsx` tal cual. El hook es dueño del canvas y del
 * desfase de sincronía (`mouseSync`, persistido en localStorage); el componente
 * solo coloca el `<canvas>` devuelto encima del vídeo.
 */
export function useMouseTrailCanvas(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  match: MatchMetadata,
  mouseEvents: MouseEventData[]
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  const [mouseSync, setMouseSync] = useState<number>(() => {
    return parseFloat(localStorage.getItem("mouseSyncOffset") || "1.0");
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resizeObserver = new ResizeObserver(() => {
      // En pixeles de dispositivo, no CSS: en una pantalla HiDPI el trazo salia
      // borroso porque el buffer tenia menos resolucion que la pantalla.
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
    });
    resizeObserver.observe(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const render = () => {
      rafRef.current = requestAnimationFrame(render);
      const v = videoRef.current;
      if (!v) return;

      const ct = v.currentTime;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (mouseEvents.length === 0) return;

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
      // contenedor entero. Mapear sobre `canvas.width/height` estiraba la estela
      // sobre las barras y la dejaba desplazada; solo cuadraba en pantalla
      // completa, que es justo cuando las proporciones coinciden y no hay barras.
      //
      // Hay que mapear sobre el rectangulo donde el video se pinta de verdad.
      const fit = Math.min(canvas.width / videoW, canvas.height / videoH);
      const paintedW = videoW * fit;
      const paintedH = videoH * fit;
      const offX = (canvas.width - paintedW) / 2;
      const offY = (canvas.height - paintedH) / 2;
      const scaleX = paintedW / spaceW;
      const scaleY = paintedH / spaceH;
      const px = (x: number) => offX + x * scaleX;
      const py = (y: number) => offY + y * scaleY;

      const TRAIL_DURATION = 1.0;
      const adjustedCt = ct - mouseSync;
      const recentEvents = mouseEvents.filter(e => e.t <= adjustedCt && e.t >= adjustedCt - TRAIL_DURATION);
      if (recentEvents.length === 0) return;
      const moves = recentEvents.filter(e => e.evt === "move");
      if (moves.length > 1) {
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (let i = 0; i < moves.length - 1; i++) {
          const p1 = moves[i];
          const p2 = moves[i + 1];
          const ageRatio = Math.max(0, 1 - (adjustedCt - p2.t) / TRAIL_DURATION);
          ctx.beginPath();
          ctx.moveTo(px(p1.x), py(p1.y));
          ctx.lineTo(px(p2.x), py(p2.y));
          ctx.lineWidth = 2.5 + ageRatio * 4;
          // Rampa oro -> turquesa: lo viejo se apaga hacia el oro, lo reciente
          // llega en turquesa. Va en números porque es canvas y `fillStyle` no
          // entiende var(); son los mismos dos tintes del sistema.
          const r = Math.floor(200 + ageRatio * (10 - 200));
          const g = Math.floor(170 + ageRatio * (200 - 170));
          const b = Math.floor(110 + ageRatio * (185 - 110));
          ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${ageRatio})`;
          ctx.stroke();
        }
      }
      const clicks = recentEvents.filter(e => e.evt === "left_click" || e.evt === "right_click");
      for (const click of clicks) {
        const age = adjustedCt - click.t;
        if (age > 0.6) continue;
        const ageRatio = Math.max(0, 1 - (age / 0.6));
        const radius = 8 + (1 - ageRatio) * 15;
        const opacity = ageRatio;

        const r = Math.floor(255 + ageRatio * (0 - 255));
        const g = Math.floor(200 + ageRatio * (150 - 200));
        const b = Math.floor(50 + ageRatio * (255 - 50));

        ctx.save();
        ctx.shadowBlur = 10;
        ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${opacity})`;

        // Anillo exterior
        ctx.beginPath();
        ctx.arc(px(click.x), py(click.y), radius, 0, Math.PI * 2);
        ctx.lineWidth = 4;
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${opacity * 0.8})`;
        ctx.stroke();

        // Núcleo interior brillante
        ctx.beginPath();
        ctx.arc(px(click.x), py(click.y), radius * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
        ctx.fill();
        ctx.restore();
      }
    };
    rafRef.current = requestAnimationFrame(render);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      resizeObserver.disconnect();
    };
    // `match` solo importa aquí a través de mouseSpace (resolución del
    // escritorio grabado); cambia junto con mouseEvents, que sí está.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mouseEvents, mouseSync]);

  const updateMouseSync = (val: number) => {
    setMouseSync(val);
    localStorage.setItem("mouseSyncOffset", val.toString());
  };

  return { canvasRef, mouseSync, updateMouseSync };
}
