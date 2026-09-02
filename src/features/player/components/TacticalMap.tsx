import React, { useMemo, useState } from "react";
import { TimelineMarker } from "../../../types";
import { mmss } from "../../../core/time";
import { mapImageUrl, DDRAGON_MAP_FALLBACK, useDdragonVersion } from "../../../core/ddragon";
import { useT } from "../../../core/LanguageProvider";
import { EmptyState } from "../../../components/ui/EmptyState";
import { wstyles } from "./videoPlayerStyles";

interface TacticalMapProps {
  markers: TimelineMarker[];
  onSeek: (seconds: number) => void;
}

type MapFilter = "all" | "kill" | "death" | "objective";

/** Tamaño del mapa de la Grieta en coordenadas de Riot. */
const RIOT_MAX_X = 14820;
const RIOT_MAX_Y = 14881;

const FILTERS: { key: MapFilter; label: string; tone: string }[] = [
  { key: "all", label: "All", tone: "var(--text)" },
  { key: "kill", label: "Kills", tone: "var(--win)" },
  { key: "death", label: "Deaths", tone: "var(--loss)" },
  { key: "objective", label: "Objectives", tone: "var(--brand)" },
];

const markerColor = (type: string): string => {
  if (type === "kill" || type === "assist") return "var(--win)";
  if (type === "death") return "var(--loss)";
  if (type === "dragon" || type === "herald") return "var(--brand)";
  if (type === "tower" || type === "plate") return "var(--cool)";
  return "var(--flag)";
};

const matchesFilter = (type: string, filter: MapFilter): boolean => {
  switch (filter) {
    case "kill": return type === "kill" || type === "assist";
    case "death": return type === "death";
    case "objective": return type === "dragon" || type === "herald" || type === "tower" || type === "plate";
    default: return true;
  }
};

/**
 * Dónde pasó cada cosa.
 *
 * Sólo se pintan los marcadores que traen coordenadas: son los que vienen de la
 * Timeline de Riot. Los del directo no las tienen, y por eso el mapa puede estar
 * vacío en una partida con eventos de sobra — que es justo lo que había que
 * decir en vez de devolver `null` y desaparecer sin explicación.
 */
export const TacticalMap: React.FC<TacticalMapProps> = ({ markers, onSeek }) => {
  const t = useT();
  const version = useDdragonVersion();
  const [filter, setFilter] = useState<MapFilter>("all");
  const [active, setActive] = useState<TimelineMarker | null>(null);

  const valid = useMemo(
    () => (markers || []).filter((m) => m.position_x !== undefined && m.position_y !== undefined),
    [markers]
  );

  const shown = useMemo(
    () => valid.filter((m) => matchesFilter(m.event_type, filter)),
    [valid, filter]
  );

  if (valid.length === 0) {
    return (
      <EmptyState
        title={t("No positions for this game")}
        text={t("Map positions come from Riot's timeline. Sync the game with Riot and they show up here.")}
      />
    );
  }

  // Riot pone el origen abajo a la izquierda (nexo azul); el SVG, arriba.
  const toPct = (x: number, y: number) => ({
    px: Math.max(2, Math.min(98, (x / RIOT_MAX_X) * 100)),
    py: Math.max(2, Math.min(98, (1 - y / RIOT_MAX_Y) * 100)),
  });

  return (
    <div style={wstyles.body}>
      <div style={wstyles.toolbar}>
        <span className="tp-seg">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              data-on={filter === f.key ? "" : undefined}
              style={filter === f.key ? { color: f.tone } : undefined}
            >
              {t(f.label)}
            </button>
          ))}
        </span>
        <span className="u-meta" style={{ marginLeft: "auto" }}>
          {t("{n} of {total} events", { n: shown.length, total: valid.length })}
        </span>
      </div>

      <div style={wstyles.mapFrame}>
        <img
          src={mapImageUrl(version)}
          alt=""
          style={wstyles.mapImg}
          onError={(e) => {
            // Una versión recién publicada puede no tener aún el mapa en el CDN;
            // la de respaldo lleva años ahí. Sólo se reintenta una vez.
            const img = e.currentTarget as HTMLImageElement;
            const respaldo = mapImageUrl(DDRAGON_MAP_FALLBACK);
            if (img.src !== respaldo) img.src = respaldo;
            else img.style.visibility = "hidden";
          }}
        />

        {shown.map((m, idx) => {
          const { px, py } = toPct(m.position_x!, m.position_y!);
          const color = markerColor(m.event_type);
          const isActive = active === m;
          return (
            <button
              key={idx}
              type="button"
              onClick={() => onSeek(m.time)}
              onMouseEnter={() => setActive(m)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(m)}
              onBlur={() => setActive(null)}
              title={`${mmss(m.time)} · ${t("Jump to this moment")}`}
              style={{
                ...wstyles.mapDot,
                left: `${px}%`,
                top: `${py}%`,
                background: color,
                zIndex: isActive ? 20 : 10,
                transform: isActive
                  ? "translate(-50%, -50%) scale(1.35)"
                  : "translate(-50%, -50%)",
                transition: "transform var(--t-quick) var(--e-move)",
              }}
            />
          );
        })}

        {active && (
          <div style={wstyles.mapTip}>
            <span className="u-metric">{mmss(active.time)}</span>
            <span style={{ flex: 1, textAlign: "left" }}>{active.description}</span>
            <span className="u-label" style={{ color: "var(--cool)" }}>{t("Click to jump")}</span>
          </div>
        )}
      </div>

      <p className="note">
        {t("Click any point on the map to jump the video to that play.")}
      </p>
    </div>
  );
};
