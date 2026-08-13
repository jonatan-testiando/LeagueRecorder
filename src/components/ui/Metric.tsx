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
}

export const Metric: React.FC<MetricProps> = ({
  value,
  label,
  tone = "default",
  align = "right",
  title,
}) => (
  <div className="metric" style={{ textAlign: align }} title={title}>
    <div className="metric__value" style={{ color: TONE_VAR[tone] }}>
      {value}
    </div>
    {label && <div className="metric__label">{label}</div>}
  </div>
);
