import React from "react";
import { TimelineMarker } from "../../../types";
import { EyeOff, AlertTriangle } from "lucide-react";

interface MapAwarenessWidgetProps {
  cameraSnaps?: number[];
  markers?: TimelineMarker[];
  onSeek: (seconds: number) => void;
}

export const MapAwarenessWidget: React.FC<MapAwarenessWidgetProps> = ({
  cameraSnaps = [],
  markers = [],
  onSeek,
}) => {
  const deaths = markers.filter((m) => m.event_type === "death");

  if (deaths.length === 0) return null;

  // Analizar si en los 10 segundos anteriores a cada muerte hubo algún salto de cámara (camera_snaps)
  const blindDeaths = deaths.map((d) => {
    const snapsBefore = cameraSnaps.filter(
      (s) => s >= d.time - 12 && s <= d.time
    );
    return {
      marker: d,
      snapsCount: snapsBefore.length,
      isBlind: snapsBefore.length === 0,
    };
  });

  const totalBlindCount = blindDeaths.filter((bd) => bd.isBlind).length;

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  return (
    <div
      style={{
        backgroundColor: "var(--bg-card)",
        border: "1px solid var(--border-subtle)",
        borderTop: "3px solid var(--color-defeat)",
        borderRadius: "var(--radius-lg)",
        padding: "16px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        boxShadow: "0 4px 16px rgba(0, 0, 0, 0.2)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--text)", fontWeight: 700, fontSize: "13px" }}>
          <EyeOff size={16} color="var(--color-defeat)" />
          <span>Diagnóstico de Conciencia de Mapa</span>
        </div>
        <span
          style={{
            fontSize: "11px",
            fontWeight: 800,
            padding: "2px 8px",
            borderRadius: "12px",
            background: totalBlindCount > 0 ? "color-mix(in srgb, var(--color-defeat) 15%, transparent)" : "color-mix(in srgb, var(--color-victory) 15%, transparent)",
            color: totalBlindCount > 0 ? "var(--color-defeat)" : "var(--color-victory)",
            border: `1px solid ${totalBlindCount > 0 ? "color-mix(in srgb, var(--color-defeat) 30%, transparent)" : "color-mix(in srgb, var(--color-victory) 30%, transparent)"}`,
          }}
        >
          {totalBlindCount > 0 ? `${totalBlindCount} Muertes a ciegas` : "Excelente visión"}
        </span>
      </div>

      <p style={{ fontSize: "11px", color: "var(--text-muted)", margin: 0, lineHeight: 1.4 }}>
        Evalúa si chequeaste el minimapa o tus aliados en los 10 segundos previos a morir.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {blindDeaths.map((item, idx) => (
          <div
            key={idx}
            onClick={() => onSeek(item.marker.time)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 12px",
              borderRadius: "6px",
              background: "var(--bg-app)",
              border: "1px solid var(--border-subtle)",
              cursor: "pointer",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "11px",
                  fontWeight: 700,
                  color: "var(--text-secondary)",
                  background: "rgba(255, 255, 255, 0.06)",
                  padding: "2px 6px",
                  borderRadius: "4px",
                }}
              >
                {formatTime(item.marker.time)}
              </span>
              <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text)" }}>
                {item.isBlind ? "Muerte sin información previa" : "Chequeo de mapa registrado"}
              </span>
            </div>
            {item.isBlind ? (
              <span style={{ fontSize: "11px", color: "var(--color-defeat)", fontWeight: 700, display: "flex", alignItems: "center", gap: 4 }}>
                <AlertTriangle size={12} /> A ciegas
              </span>
            ) : (
              <span style={{ fontSize: "11px", color: "var(--color-victory)", fontWeight: 700 }}>
                {item.snapsCount} miradas
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
