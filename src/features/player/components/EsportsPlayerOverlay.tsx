import React from "react";
import { MatchMetadata } from "../../../types";
import { Tv, Camera, TrendingUp, TrendingDown, Sparkles, UserCheck } from "lucide-react";

interface EsportsPlayerOverlayProps {
  currentTime: number;
  match: MatchMetadata;
  visible: boolean;
}

export const EsportsPlayerOverlay: React.FC<EsportsPlayerOverlayProps> = ({
  currentTime,
  match,
  visible,
}) => {
  if (!visible) return null;

  // Formato MM:SS del tiempo en vivo del vídeo
  const mins = Math.floor(currentTime / 60);
  const secs = Math.floor(currentTime % 60);
  const formattedClock = `${mins < 10 ? `0${mins}` : mins}:${secs < 10 ? `0${secs}` : secs}`;

  // 1. Interpolación lineal en TIEMPO REAL segundo a segundo entre los frames de minutos
  const frames = match.minute_frames || [];
  let teamGoldDiff: number | null = null;
  let selfGoldDiff: number | null = null;

  if (frames.length > 0) {
    const currentMin = Math.floor(currentTime / 60);
    const prevFrame = frames.find((f) => f.minute === currentMin) || frames[0];
    const nextFrame = frames.find((f) => f.minute === currentMin + 1);

    if (prevFrame && nextFrame) {
      const prevSec = prevFrame.minute * 60;
      const nextSec = nextFrame.minute * 60;
      const progress = Math.max(0, Math.min(1, (currentTime - prevSec) / (nextSec - prevSec)));

      teamGoldDiff = Math.round(prevFrame.team_gold_diff + progress * (nextFrame.team_gold_diff - prevFrame.team_gold_diff));
      selfGoldDiff = Math.round(prevFrame.self_gold_diff + progress * (nextFrame.self_gold_diff - prevFrame.self_gold_diff));
    } else if (prevFrame) {
      teamGoldDiff = prevFrame.team_gold_diff;
      selfGoldDiff = prevFrame.self_gold_diff;
    }
  }

  // Fallbacks si minute_frames no está presente todavía
  if (teamGoldDiff === null && match.gold_diff_15 !== undefined && match.gold_diff_15 !== null) {
    teamGoldDiff = match.gold_diff_15;
  }

  if (teamGoldDiff === null && match.participants && match.participants.length > 0) {
    const team100Gold = match.participants.filter((p) => p.team_id === 100).reduce((sum, p) => sum + (p.gold || 0), 0);
    const team200Gold = match.participants.filter((p) => p.team_id === 200).reduce((sum, p) => sum + (p.gold || 0), 0);
    const selfTeam = match.participants.find((p) => p.is_self)?.team_id || 100;
    if (team100Gold > 0 || team200Gold > 0) {
      teamGoldDiff = selfTeam === 100 ? team100Gold - team200Gold : team200Gold - team100Gold;
    }
  }

  // Verificar si hay un salto de cámara detectado en el segundo actual (+/- 1.5s)
  const isCameraSnap = (match.camera_snaps || []).some(
    (snapSec) => Math.abs(snapSec - currentTime) <= 1.5
  );

  // Buscar si hay un marcador de evento activo alrededor de este segundo (+/- 3s)
  const activeEvent = (match.timeline_markers || []).find(
    (m) => Math.abs(m.time - currentTime) <= 3
  );

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 6,
        padding: "16px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        transition: "opacity 0.2s ease",
      }}
    >
      {/* Barra Superior del HUD Broadcast */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        {/* Badge Superior Izquierdo: Telemetría de Oro en Tiempo Real y Reloj MM:SS */}
        <div
          style={{
            background: "color-mix(in srgb, var(--ground) 90%, transparent)",
            backdropFilter: "blur(12px)",
            border: "1px solid rgba(255, 255, 255, 0.15)",
            borderRadius: "8px",
            padding: "8px 12px",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.5)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <Tv size={14} color="var(--accent-violet)" />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 800, color: "var(--text)" }}>
              {formattedClock}
            </span>
          </div>

          {/* Oro de Equipo en Tiempo Real */}
          {teamGoldDiff !== null ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "4px",
                fontSize: "11px",
                fontWeight: 800,
                padding: "3px 8px",
                borderRadius: "6px",
                background: teamGoldDiff >= 0 ? "color-mix(in srgb, var(--color-victory) 25%, transparent)" : "color-mix(in srgb, var(--color-defeat) 25%, transparent)",
                color: teamGoldDiff >= 0 ? "var(--color-victory)" : "var(--color-defeat)",
                border: `1px solid ${teamGoldDiff >= 0 ? "color-mix(in srgb, var(--color-victory) 40%, transparent)" : "color-mix(in srgb, var(--color-defeat) 40%, transparent)"}`,
                transition: "all 0.1s linear",
              }}
              title="Diferencia de Oro total de tu Equipo vs Equipo Enemigo (Actualizado en tiempo real segundo a segundo)"
            >
              {teamGoldDiff >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
              <span>{teamGoldDiff >= 0 ? `+${teamGoldDiff.toLocaleString()}g Equipo` : `${teamGoldDiff.toLocaleString()}g Equipo`}</span>
            </div>
          ) : (
            <div
              style={{
                fontSize: "10px",
                fontWeight: 700,
                padding: "2px 6px",
                borderRadius: "4px",
                background: "rgba(255, 255, 255, 0.08)",
                color: "var(--text-muted)",
              }}
            >
              Sincronizando oro...
            </div>
          )}

          {/* Oro Individual vs Rival Directo en Tiempo Real */}
          {selfGoldDiff !== null && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "4px",
                fontSize: "11px",
                fontWeight: 800,
                padding: "3px 8px",
                borderRadius: "6px",
                background: selfGoldDiff >= 0 ? "color-mix(in srgb, var(--accent-blue) 25%, transparent)" : "color-mix(in srgb, var(--color-objective) 25%, transparent)",
                color: selfGoldDiff >= 0 ? "var(--accent-blue)" : "var(--color-objective)",
                border: `1px solid ${selfGoldDiff >= 0 ? "color-mix(in srgb, var(--accent-blue) 40%, transparent)" : "color-mix(in srgb, var(--color-objective) 40%, transparent)"}`,
                transition: "all 0.1s linear",
              }}
              title="Tu diferencia de Oro individual contra tu rival directo de rol (Jungla rival) en tiempo real"
            >
              <UserCheck size={12} />
              <span>{selfGoldDiff >= 0 ? `+${selfGoldDiff.toLocaleString()}g vs Rival` : `${selfGoldDiff.toLocaleString()}g vs Rival`}</span>
            </div>
          )}
        </div>

        {/* Badge Superior Derecho: Alerta de Cámara & APM Meter */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "8px" }}>
          {/* Indicador de Salto de Cámara */}
          {isCameraSnap && (
            <div
              style={{
                background: "linear-gradient(135deg, color-mix(in srgb, var(--flag) 90%, transparent), color-mix(in srgb, var(--accent-blue) 90%, transparent))",
                color: "var(--text)",
                fontSize: "11px",
                fontWeight: 800,
                padding: "6px 12px",
                borderRadius: "20px",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                boxShadow: "0 0 16px color-mix(in srgb, var(--flag) 60%, transparent)",
                animation: "pulse 1s infinite alternate",
              }}
            >
              <Camera size={14} />
              <span>SALTO DE CÁMARA</span>
            </div>
          )}

          {/* APM Meter */}
          {match.apm && (
            <div
              style={{
                background: "color-mix(in srgb, var(--ground) 90%, transparent)",
                backdropFilter: "blur(12px)",
                border: "1px solid rgba(255, 255, 255, 0.15)",
                borderRadius: "8px",
                padding: "6px 10px",
                fontSize: "11px",
                fontWeight: 800,
                color: "var(--accent-blue)",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                boxShadow: "0 4px 16px rgba(0, 0, 0, 0.3)",
              }}
            >
              <Sparkles size={12} />
              <span>{Math.round(match.apm)} APM</span>
            </div>
          )}
        </div>
      </div>

      {/* Banner Inferior Central: Notificación de Evento Destacado */}
      {activeEvent && (
        <div
          style={{
            alignSelf: "center",
            marginBottom: "40px",
            background: "color-mix(in srgb, var(--panel) 92%, transparent)",
            backdropFilter: "blur(16px)",
            border: "1px solid var(--accent-violet-soft)",
            borderRadius: "30px",
            padding: "8px 18px",
            color: "var(--text)",
            fontSize: "12px",
            fontWeight: 800,
            display: "flex",
            alignItems: "center",
            gap: "8px",
            boxShadow: "0 8px 32px rgba(0, 0, 0, 0.6)",
          }}
        >
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--accent-violet)" }} />
          <span>{activeEvent.description}</span>
        </div>
      )}
    </div>
  );
};
