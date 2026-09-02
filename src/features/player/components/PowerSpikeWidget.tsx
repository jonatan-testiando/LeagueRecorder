import React, { useMemo, useState } from "react";
import { ItemPurchase, TimelineMarker } from "../../../types";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { EmptyState } from "../../../components/ui/EmptyState";
import { itemIcon } from "./videoPlayerUtils";
import { wstyles } from "./videoPlayerStyles";

interface PowerSpikeWidgetProps {
  itemPurchases?: ItemPurchase[];
  markers?: TimelineMarker[];
  /**
   * Versión de Data Dragon YA RESUELTA por el reproductor. Antes este widget
   * usaba la constante de respaldo mientras la pantalla de al lado pintaba los
   * mismos objetos con la versión viva: dos iconos del mismo ítem servidos de
   * dos parches distintos, y los de un parche viejo fallando en silencio.
   */
  ddragonVer: string;
  onSeek: (seconds: number) => void;
}

/** Ventana en la que una compra se considera responsable de una participación. */
const IMPACT_WINDOW_SECS = 180;

/** Compras visibles antes de pedir el resto. */
const FIRST_PAGE = 8;

export const PowerSpikeWidget: React.FC<PowerSpikeWidgetProps> = ({
  itemPurchases = [],
  markers = [],
  ddragonVer,
  onSeek,
}) => {
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  // Participación, no remates: una asistencia justo después de comprar el ítem
  // dice lo mismo del pico de poder que una kill. ('assist' es un tipo nuevo;
  // las partidas viejas guardan las asistencias como 'kill'.)
  const rows = useMemo(() => {
    const kills = (markers ?? []).filter(
      (m) => m.event_type === "kill" || m.event_type === "assist"
    );
    return itemPurchases.map((ip) => ({
      purchase: ip,
      after: kills.filter((k) => k.time >= ip.time && k.time <= ip.time + IMPACT_WINDOW_SECS).length,
    }));
  }, [itemPurchases, markers]);

  if (itemPurchases.length === 0) {
    return (
      <EmptyState
        title={t("No purchases recorded")}
        text={t("Item purchases come from Riot's timeline. Sync the game with Riot to see them.")}
      />
    );
  }

  const visible = expanded ? rows : rows.slice(0, FIRST_PAGE);
  const hidden = rows.length - visible.length;

  return (
    <div style={wstyles.body}>
      <p className="note" style={{ marginTop: 0 }}>
        {t("Kills and assists you took in the {n} minutes after each purchase.", {
          n: Math.round(IMPACT_WINDOW_SECS / 60),
        })}
      </p>

      <div style={wstyles.buyGrid}>
        {visible.map((item, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => onSeek(item.purchase.time)}
            style={wstyles.buyCell}
            title={`${mmss(item.purchase.time)} · ${t("Jump to this moment")}`}
          >
            <img
              src={itemIcon(ddragonVer, item.purchase.item_id)}
              alt=""
              style={wstyles.buyIconSm}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
              }}
            />
            <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span className="u-metric" style={{ fontSize: 11 }}>{mmss(item.purchase.time)}</span>
              {item.after > 0 && (
                <span style={{ fontSize: 10, color: "var(--win)" }}>
                  {t("+{n} K/A", { n: item.after })}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>

      {(hidden > 0 || expanded) && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          style={{ alignSelf: "flex-start" }}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? t("Show fewer") : t("Show {n} more", { n: hidden })}
        </button>
      )}
    </div>
  );
};
