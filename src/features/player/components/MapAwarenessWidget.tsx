import React, { useMemo } from "react";
import { TimelineMarker } from "../../../types";
import { AlertTriangle } from "lucide-react";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { EmptyState } from "../../../components/ui/EmptyState";
import { wstyles } from "./videoPlayerStyles";

interface MapAwarenessWidgetProps {
  cameraSnaps?: number[];
  markers?: TimelineMarker[];
  onSeek: (seconds: number) => void;
}

/**
 * Ventana que se mira antes de cada muerte.
 *
 * Estaba en dos sitios y no coincidían: el código miraba 12 segundos y tanto el
 * comentario como la frase de la pantalla decían 10. Se queda en 10 —el número
 * que el usuario había leído— y ahora hay UNA constante, así que la frase no
 * puede volver a mentir sobre el cálculo.
 */
const LOOKBACK_SECS = 10;

export const MapAwarenessWidget: React.FC<MapAwarenessWidgetProps> = ({
  cameraSnaps = [],
  markers = [],
  onSeek,
}) => {
  const t = useT();

  const deaths = useMemo(
    () => (markers ?? []).filter((m) => m.event_type === "death"),
    [markers]
  );

  const rows = useMemo(
    () =>
      deaths.map((d) => {
        const looks = cameraSnaps.filter((s) => s >= d.time - LOOKBACK_SECS && s <= d.time).length;
        return { marker: d, looks, blind: looks === 0 };
      }),
    [deaths, cameraSnaps]
  );

  if (deaths.length === 0) {
    return (
      <EmptyState
        title={t("No deaths in this game")}
        text={t("This panel checks what you looked at in the {n} seconds before each death.", { n: LOOKBACK_SECS })}
      />
    );
  }

  const blindCount = rows.filter((r) => r.blind).length;

  return (
    <div style={wstyles.body}>
      <p className="note" style={{ marginTop: 0 }}>
        {t("Whether you checked the minimap or an ally in the {n} seconds before dying.", { n: LOOKBACK_SECS })}
      </p>

      <div style={wstyles.list}>
        {rows.map((r, idx) => (
          <button
            key={idx}
            className="insp__press"
            onClick={() => onSeek(r.marker.time)}
            title={t("Jump to this moment")}
          >
            <span className="u-metric">{mmss(r.marker.time)}</span>
            <span className="insp__pressWhat">
              {r.blind ? t("Died with no information") : t("Map check on record")}
            </span>
            <span
              className="insp__pressGain"
              style={{ color: r.blind ? "var(--loss)" : "var(--win)" }}
            >
              {r.blind ? (
                <>
                  <AlertTriangle size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                  {t("blind")}
                </>
              ) : (
                t("looks: {n}", { n: r.looks })
              )}
            </span>
          </button>
        ))}
      </div>

      <p className="note">
        {blindCount > 0
          ? t("No look in the previous {secs} s before {n} of your {total} deaths.", {
              n: blindCount,
              total: rows.length,
              secs: LOOKBACK_SECS,
            })
          : t("Every death had a look behind it. The problem was not information.")}
      </p>
    </div>
  );
};
