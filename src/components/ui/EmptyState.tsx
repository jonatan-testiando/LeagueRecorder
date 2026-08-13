import React from "react";

/**
 * Estado vacío. El texto explica qué hacer para llenarlo, no solo que está
 * vacío: "no hay nada" sin salida es lo que hace pensar que algo falla.
 */
export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  text?: string;
  action?: React.ReactNode;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, text, action }) => (
  <div className="empty-state">
    {icon && <div className="empty-state__icon">{icon}</div>}
    <p className="empty-state__title">{title}</p>
    {text && <p className="empty-state__text">{text}</p>}
    {action}
  </div>
);
