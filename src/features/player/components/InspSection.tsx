import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

/**
 * Sección plegable del inspector.
 *
 * Los seis widgets de análisis vivían dentro de un `<details>` llamado "Más
 * análisis", cerrado. Esconder por defecto lo que has calculado es la forma más
 * cara de no enseñarlo: nadie abre un desplegable para averiguar si dentro hay
 * algo. Ahora cada uno es una sección de verdad, abierta, y quien quiera
 * cerrarla la cierra — y se queda cerrada, que es distinto de nacer cerrada.
 *
 * El estado se recuerda por `id` en localStorage, no por partida: es una
 * preferencia sobre la pantalla, no sobre esta partida concreta.
 */

const KEY = (id: string) => `playerSection:${id}`;

export interface InspSectionProps {
  /** Identidad estable para recordar el plegado. */
  id: string;
  title: string;
  /** Contenido a la derecha del título (una cifra, un filtro). */
  aside?: React.ReactNode;
  /** Cómo nace la primera vez (luego manda lo que el usuario dejó). */
  defaultOpen?: boolean;
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

export const InspSection: React.FC<InspSectionProps> = ({ id, title, aside, defaultOpen = true, reveal, children }) => {
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(KEY(id));
      return v === null ? defaultOpen : v !== "0";
    } catch {
      // Modo privado o almacenamiento bloqueado: lo que pida la sección.
      return defaultOpen;
    }
  });

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(KEY(id), next ? "1" : "0");
      } catch {
        /* no poder recordarlo no puede impedir plegarla */
      }
      return next;
    });
  }, [id]);

  useEffect(() => {
    if (!reveal) return;
    setOpen(true);
    // Se espera a pintarla abierta: desplazarse antes apunta a la sección
    // plegada, y lo que se abre encima de ella la empuja fuera de la vista.
    const raf = requestAnimationFrame(() => {
      const quieto = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      ref.current?.scrollIntoView({ block: "start", behavior: quieto ? "auto" : "smooth" });
    });
    return () => cancelAnimationFrame(raf);
  }, [reveal]);

  return (
    <section ref={ref}>
      <div className="sect__head">
        <button type="button" onClick={toggle} aria-expanded={open} style={styles.toggle}>
          <ChevronDown
            size={13}
            style={{
              transform: open ? "none" : "rotate(-90deg)",
              transition: "transform var(--t-quick) var(--e-move)",
            }}
          />
          <span className="u-label">{title}</span>
        </button>
        <i className="sect__rule" />
        {aside}
      </div>
      {open && children}
    </section>
  );
};

const styles: Record<string, React.CSSProperties> = {
  toggle: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: 0,
    background: "none",
    border: "none",
    color: "var(--faint)",
    cursor: "pointer",
    font: "inherit",
  },
};
