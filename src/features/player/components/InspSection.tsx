import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import "./MatchTab.css";

/**
 * Sección plegable del inspector.
 *
 * Los seis widgets de análisis vivían dentro de un `<details>` llamado "Más
 * análisis", cerrado. Esconder por defecto lo que has calculado es la forma más
 * cara de no enseñarlo: nadie abre un desplegable para averiguar si dentro hay
 * algo. Ahora cada uno es una sección de verdad, abierta, y quien quiera
 * cerrarla la cierra — y se queda cerrada, que es distinto de nacer cerrada.
 *
 * Dos modos:
 *  - Suelta: el estado se recuerda por `id` en localStorage, no por partida:
 *    es una preferencia sobre la pantalla, no sobre esta partida concreta.
 *  - Controlada (`open` + `onToggle`): la lleva quien la pinta. La pestaña
 *    Partida la usa así para su acordeón, con solo el primer bloque abierto.
 */

const KEY = (id: string) => `playerSection:${id}`;

export interface InspSectionProps {
  /** Identidad estable para recordar el plegado (y ancla de la sección). */
  id: string;
  title: string;
  /** Contenido a la derecha del título (una cifra, un filtro). */
  aside?: React.ReactNode;
  /** Cómo nace la primera vez (luego manda lo que el usuario dejó). */
  defaultOpen?: boolean;
  /** Modo controlado: abierta o no, y qué hacer al pulsar la cabecera. */
  open?: boolean;
  onToggle?: () => void;
  /**
   * Cada vez que cambia (y no es 0/undefined), la sección se abre y se pone a
   * la vista. Lo usa "Lo que decidió la partida": una frase que habla de un
   * bloque entero lleva a él, aunque el usuario lo dejara plegado. No se
   * guarda como preferencia: abrirla para mirar no es decidir que nazca
   * abierta.
   */
  reveal?: number;
  children: React.ReactNode;
}

export const InspSection: React.FC<InspSectionProps> = ({
  id, title, aside, defaultOpen = true, open: openProp, onToggle, reveal, children,
}) => {
  const ref = useRef<HTMLElement>(null);
  const controlled = openProp !== undefined;
  const [openLocal, setOpenLocal] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(KEY(id));
      return v === null ? defaultOpen : v !== "0";
    } catch {
      // Modo privado o almacenamiento bloqueado: lo que pida la sección.
      return defaultOpen;
    }
  });
  const open = controlled ? openProp : openLocal;

  const toggle = useCallback(() => {
    if (controlled) {
      onToggle?.();
      return;
    }
    setOpenLocal((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(KEY(id), next ? "1" : "0");
      } catch {
        /* no poder recordarlo no puede impedir plegarla */
      }
      return next;
    });
  }, [controlled, onToggle, id]);

  useEffect(() => {
    if (!reveal) return;
    if (!controlled) setOpenLocal(true);
    // Se espera a pintarla abierta: desplazarse antes apunta a la sección
    // plegada, y lo que se abre encima de ella la empuja fuera de la vista.
    const raf = requestAnimationFrame(() => {
      const quieto = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      ref.current?.scrollIntoView({ block: "start", behavior: quieto ? "auto" : "smooth" });
    });
    return () => cancelAnimationFrame(raf);
    // `controlled` no cambia en la vida de una sección.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  const bodyId = `${id}-body`;
  return (
    <section ref={ref} id={id} className="isec" data-open={open || undefined}>
      <div className="sect__head">
        <button type="button" className="isec__toggle" onClick={toggle} aria-expanded={open} aria-controls={bodyId}>
          <ChevronDown size={14} className="isec__chev" aria-hidden="true" />
          <span className="u-label">{title}</span>
        </button>
        <i className="sect__rule" />
        {aside}
      </div>
      {open && <div id={bodyId}>{children}</div>}
    </section>
  );
};
