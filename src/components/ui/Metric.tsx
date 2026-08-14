import React from "react";

/**
 * Una cifra con su etiqueta. Siempre en mono y con cifras tabulares: es la
 * única forma de que dos filas seguidas se puedan comparar de un vistazo, que
 * es justo lo que se hace en la biblioteca.
 */
export type MetricTone = "default" | "win" | "loss" | "muted";

const TONE_VAR: Record<MetricTone, string> = {
  default: "var(--text)",
  win: "var(--win)",
  loss: "var(--loss)",
  muted: "var(--muted)",
};

export interface MetricProps {
  value: React.ReactNode;
  label?: string;
  tone?: MetricTone;
  align?: "left" | "right";
  title?: string;
  /**
   * `lead` la pinta más grande.
   *
   * Se reserva para la cifra que de verdad separa una fila de otra. En una lista
   * donde todas las métricas pesan igual, ninguna orienta: si un dato apenas
   * varía entre filas no merece el mismo tamaño que el que sí lo hace.
   */
  emphasis?: "normal" | "lead";
}

export const Metric: React.FC<MetricProps> = ({
  value,
  label,
  tone = "default",
  align = "right",
  title,
  emphasis = "normal",
}) => (
  <div className="metric" style={{ textAlign: align }} title={title}>
    <div
      className={emphasis === "lead" ? "metric__value metric__value--lead" : "metric__value"}
      style={{ color: TONE_VAR[tone] }}
    >
      {value}
    </div>
    {label && <div className="metric__label">{label}</div>}
  </div>
);
