import React from "react";
import { ItemPurchase, TimelineMarker } from "../../../types";
import { Zap } from "lucide-react";

interface PowerSpikeWidgetProps {
  itemPurchases?: ItemPurchase[];
  markers?: TimelineMarker[];
  onSeek: (seconds: number) => void;
}

const DDRAGON_VER = "16.13.1";
const itemIcon = (id: number) =>
  `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VER}/img/item/${id}.png`;

export const PowerSpikeWidget: React.FC<PowerSpikeWidgetProps> = ({
  itemPurchases = [],
  markers = [],
  onSeek,
}) => {
  if (itemPurchases.length === 0) return null;

  const kills = markers.filter((m) => m.event_type === "kill");

  // Calcular Kills dentro de los 3 minutos posteriores a cada compra
  const purchasesWithImpact = itemPurchases.map((ip) => {
    const killsAfter = kills.filter(
      (k) => k.time >= ip.time && k.time <= ip.time + 180
    ).length;
    return {
      purchase: ip,
      killsAfter,
    };
  });

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
        borderTop: "3px solid #fbbf24",
        borderRadius: "var(--radius-lg)",
        padding: "16px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        boxShadow: "0 4px 16px rgba(0, 0, 0, 0.2)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#fff", fontWeight: 700, fontSize: "13px" }}>
          <Zap size={16} color="#fbbf24" />
          <span>Línea de Compras y Power Spikes</span>
        </div>
        <span
          style={{
            fontSize: "11px",
            fontWeight: 800,
            padding: "2px 8px",
            borderRadius: "12px",
            background: "rgba(251, 191, 36, 0.15)",
            color: "#fbbf24",
            border: "1px solid rgba(251, 191, 36, 0.3)",
          }}
        >
          {itemPurchases.length} Compras clave
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
          gap: "8px",
        }}
      >
        {purchasesWithImpact.slice(0, 8).map((item, idx) => (
          <div
            key={idx}
            onClick={() => onSeek(item.purchase.time)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "6px 10px",
              borderRadius: "6px",
              background: "var(--bg-app)",
              border: "1px solid var(--border-subtle)",
              cursor: "pointer",
            }}
            title={`Comprado en ${formatTime(item.purchase.time)} · Ir a ese momento`}
          >
            <img
              src={itemIcon(item.purchase.item_id)}
              alt=""
              style={{ width: "24px", height: "24px", borderRadius: "4px" }}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
              }}
            />
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "10px",
                  fontWeight: 700,
                  color: "var(--text-secondary)",
                }}
              >
                {formatTime(item.purchase.time)}
              </span>
              {item.killsAfter > 0 && (
                <span style={{ fontSize: "10px", color: "#22c55e", fontWeight: 800 }}>
                  +{item.killsAfter} Kills
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
