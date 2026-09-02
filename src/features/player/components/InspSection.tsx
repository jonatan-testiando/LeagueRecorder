import React, { useCallback, useState } from "react";
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
  children: React.ReactNode;
}

export const InspSection: React.FC<InspSectionProps> = ({ id, title, aside, children }) => {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(KEY(id)) !== "0";
    } catch {
      // Modo privado o almacenamiento bloqueado: abierta, que es el defecto.
      return true;
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

  return (
    <section>
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
