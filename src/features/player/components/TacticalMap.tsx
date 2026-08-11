import React, { useState } from "react";
import { TimelineMarker } from "../../../types";
import { Map } from "lucide-react";

interface TacticalMapProps {
  markers: TimelineMarker[];
  onSeek: (seconds: number) => void;
}

type MapFilter = "all" | "kill" | "death" | "objective";

export const TacticalMap: React.FC<TacticalMapProps> = ({ markers, onSeek }) => {
  const [filter, setFilter] = useState<MapFilter>("all");
  const [activeMarker, setActiveMarker] = useState<TimelineMarker | null>(null);

  // Filtrar marcadores que tengan coordenadas (x, y) de la API de Riot
  const validMarkers = (markers || []).filter((m) => m.position_x !== undefined && m.position_y !== undefined);

  if (validMarkers.length === 0) return null;

  const filtered = validMarkers.filter((m) => {
    if (filter === "all") return true;
    if (filter === "kill") return m.event_type === "kill";
    if (filter === "death") return m.event_type === "death";
    if (filter === "objective") return m.event_type === "dragon" || m.event_type === "herald" || m.event_type === "tower";
    return true;
  });

  // Convertir coordenadas de Riot (0..14820, 0..14881) a porcentajes precisos de mapa
  // En Riot, y=0 es esquina inferior izquierda (Blue side nexus), SVG y=0 es arriba
  const toPct = (x: number, y: number) => {
    const px = Math.max(2, Math.min(98, (x / 14820) * 100));
    const py = Math.max(2, Math.min(98, (1 - y / 14881) * 100));
    return { px, py };
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  const getMarkerColor = (type: string) => {
    if (type === "kill") return "#22c55e";
    if (type === "death") return "#ef4444";
    if (type === "dragon" || type === "herald") return "#f59e0b";
    if (type === "tower" || type === "plate") return "#38bdf8";
    return "#818cf8";
  };

  return (
    <div style={{
      backgroundColor: "var(--bg-card)",
      border: "1px solid var(--border-subtle)",
      borderRadius: "var(--radius-lg)",
      padding: "16px",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      boxShadow: "0 4px 16px rgba(0, 0, 0, 0.2)",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#fff", fontWeight: 700, fontSize: "13px" }}>
          <Map size={16} color="var(--accent-violet)" />
          <span>Mapa Táctico de la Grieta ({validMarkers.length} Eventos)</span>
        </div>
        <div style={{ display: "flex", gap: "4px", background: "var(--bg-app)", padding: "2px", borderRadius: "6px" }}>
          <button
            onClick={() => setFilter("all")}
            style={{
              background: filter === "all" ? "var(--accent-violet-soft)" : "transparent",
              color: filter === "all" ? "#fff" : "var(--text-muted)",
              border: "none",
              borderRadius: "4px",
              padding: "4px 8px",
              fontSize: "11px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Todos
          </button>
          <button
            onClick={() => setFilter("kill")}
            style={{
              background: filter === "kill" ? "rgba(34, 197, 94, 0.2)" : "transparent",
              color: filter === "kill" ? "#22c55e" : "var(--text-muted)",
              border: "none",
              borderRadius: "4px",
              padding: "4px 8px",
              fontSize: "11px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Kills
          </button>
          <button
            onClick={() => setFilter("death")}
            style={{
              background: filter === "death" ? "rgba(239, 68, 68, 0.2)" : "transparent",
              color: filter === "death" ? "#ef4444" : "var(--text-muted)",
              border: "none",
              borderRadius: "4px",
              padding: "4px 8px",
              fontSize: "11px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Muertes
          </button>
        </div>
      </div>

      <div style={{
        position: "relative",
        width: "100%",
        aspectRatio: "1 / 1",
        background: "#090d14",
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        border: "1px solid var(--border-subtle)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}>
        {/* Imagen Oficial de la Grieta del Invocador (Data Dragon map11.png) */}
        <img
          src="https://ddragon.leagueoflegends.com/cdn/14.1.1/img/map/map11.png"
          alt="Summoner's Rift Map"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "fill",
            position: "absolute",
            inset: 0,
            filter: "brightness(0.85) contrast(1.1)",
          }}
        />

        {/* Renderizado de Nodos de Eventos */}
        {filtered.map((m, idx) => {
          const { px, py } = toPct(m.position_x!, m.position_y!);
          const color = getMarkerColor(m.event_type);
          return (
            <div
              key={idx}
              onClick={() => onSeek(m.time)}
              onMouseEnter={() => setActiveMarker(m)}
              onMouseLeave={() => setActiveMarker(null)}
              style={{
                position: "absolute",
                left: `${px}%`,
                top: `${py}%`,
                transform: "translate(-50%, -50%)",
                width: "18px",
                height: "18px",
                borderRadius: "50%",
                background: color,
                border: "2px solid #fff",
                boxShadow: `0 0 10px ${color}`,
                cursor: "pointer",
                zIndex: activeMarker === m ? 20 : 10,
                transition: "transform 0.15s ease",
              }}
            />
          );
        })}

        {/* Tooltip de Evento Seleccionado en el Mapa */}
        {activeMarker && (
          <div style={{
            position: "absolute",
            bottom: "12px",
            left: "12px",
            right: "12px",
            background: "rgba(18, 23, 33, 0.95)",
            border: "1px solid var(--border-strong)",
            borderRadius: "6px",
            padding: "8px 12px",
            fontSize: "12px",
            color: "#fff",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
            pointerEvents: "none",
          }}>
            <span style={{ fontWeight: 700 }}>
              {formatTime(activeMarker.time)} · {activeMarker.description}
            </span>
            <span style={{ fontSize: "10px", color: "var(--accent-violet)", fontWeight: 800 }}>
              Clic para saltar
            </span>
          </div>
        )}
      </div>

      <span style={{ fontSize: "10px", color: "var(--text-muted)", textAlign: "center" }}>
        Haz clic en cualquier punto del mapa para saltar el vídeo al momento exacto de esa jugada.
      </span>
    </div>
  );
};
