import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { EVENTOS_VIDEO } from "./videoPlayerUtils";

/**
 * Lo que se mueve en la tira sin pasar por el reproductor.
 *
 * Antes el cursor de reproducción y la línea del ratón eran estado de
 * VideoPlayer (2.200 líneas): cada movimiento del ratón por la tira repintaba
 * el reproductor entero (un 28-35 % del hilo principal pasando el ratón,
 * medido), y el cursor avanzaba a saltos, cuatro veces por segundo, al ritmo
 * de `timeupdate`.
 */

/**
 * El cursor de reproducción: sigue al vídeo fotograma a fotograma mientras se
 * reproduce y se coloca una vez al buscar, al cargar o al cambiar de tamaño.
 * Se mueve con `transform` en su propia capa: ni React ni maquetación.
 */
export const CabezaTira: React.FC<{
  videoRef: React.RefObject<HTMLVideoElement | null>;
  duration: number;
}> = ({ videoRef, duration }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const tira = el?.parentElement;
    if (!el || !tira) return;
    let ancho = tira.clientWidth;
    let raf = 0;
    const colocar = () => {
      const v = videoRef.current;
      const p = v && duration > 0 ? Math.min(1, Math.max(0, v.currentTime / duration)) : 0;
      el.style.transform = `translateX(${(p * ancho).toFixed(2)}px)`;
    };
    const bucle = () => {
      raf = 0;
      colocar();
      const v = videoRef.current;
      if (v && !v.paused && !v.ended && !document.hidden) raf = requestAnimationFrame(bucle);
    };
    const despertar = () => {
      if (!raf) raf = requestAnimationFrame(bucle);
    };
    const alVideo = (e: Event) => {
      if (e.target === videoRef.current) despertar();
    };
    const ro = new ResizeObserver(() => {
      ancho = tira.clientWidth;
      despertar();
    });
    ro.observe(tira);
    for (const ev of EVENTOS_VIDEO) document.addEventListener(ev, alVideo, true);
    colocar();
    despertar();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      for (const ev of EVENTOS_VIDEO) document.removeEventListener(ev, alVideo, true);
    };
  }, [videoRef, duration]);
  return <div ref={ref} className="vp-track__head" />;
};

export interface HoverTiraApi {
  /** Dónde está el ratón en la tira (0-1), o null si ha salido. */
  set: (p: number | null) => void;
}

/**
 * La línea bajo el ratón y su etiqueta (la hora y la ventaja de oro en ese
 * instante). Su posición es estado SUYO: VideoPlayer se la pasa con `set` y
 * moverse por la tira solo repinta esto. La etiqueta se calla mientras hay un
 * racimo de sucesos bajo el ratón (`oculta`), que lleva la suya.
 */
export const HoverTira = React.memo(
  React.forwardRef<
    HoverTiraApi,
    {
      ancho: number;
      oculta: boolean;
      /** Lo que dice la etiqueta en ese punto de la tira (0-1). */
      etiqueta: (p: number) => React.ReactNode;
    }
  >(function HoverTira({ ancho, oculta, etiqueta }, ref) {
    const [p, setP] = useState<number | null>(null);
    useImperativeHandle(ref, () => ({ set: setP }), []);
    if (p === null) return null;
    const x = p * ancho;
    // Pegada a un borde no cabe centrada: se ancla por el lado que tiene sitio.
    const align = x >= 120 && x <= ancho - 120 ? undefined : x < 120 ? "start" : "end";
    return (
      <>
        <div className="vp-track__hover" style={{ left: `${p * 100}%` }} />
        {!oculta && (
          <div className="vp-tip" data-align={align} style={{ left: `${x}px` }}>
            {etiqueta(p)}
          </div>
        )}
      </>
    );
  })
);
