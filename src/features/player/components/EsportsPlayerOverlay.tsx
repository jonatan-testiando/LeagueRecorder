import React, { useMemo } from "react";
import { MatchMetadata } from "../../../types";
import { Tv, Camera, TrendingUp, TrendingDown, Sparkles, UserCheck } from "lucide-react";
import { clock } from "../../../core/time";
import { roleLabel, sameRole } from "../../../core/roles";
import { useT } from "../../../core/LanguageProvider";

interface EsportsPlayerOverlayProps {
  currentTime: number;
  match: MatchMetadata;
  visible: boolean;
}

/** Margen para dar por activo un salto de cámara o un suceso alrededor del segundo actual. */
const SNAP_WINDOW = 1.5;
const EVENT_WINDOW = 3;

/**
 * HUD estilo retransmisión sobre el vídeo.
 *
 * Los tiempos de esta pantalla son SEGUNDOS DE VÍDEO, y los `minute_frames` de
 * Riot son MINUTOS DE PARTIDA. El vídeo empieza antes (la pantalla de carga
 * también se graba), así que hay que restar `video_offset` para preguntar por el
 * minuto correcto — el resto de la app ya lo hace (core/patterns.ts). Sin eso, en
 * una grabación con 40 s de carga el marcador de oro iba un minuto adelantado.
 */
export const EsportsPlayerOverlay: React.FC<EsportsPlayerOverlayProps> = ({
  currentTime,
  match,
  visible,
}) => {
  const t = useT();

  const gameTime = Math.max(0, currentTime - (match.video_offset ?? 0));

  const { teamGoldDiff, selfGoldDiff } = useMemo(() => {
    const frames = match.minute_frames || [];
    let team: number | null = null;
    let self: number | null = null;

    if (frames.length > 0) {
      const min = Math.floor(gameTime / 60);
      const prev = frames.find((f) => f.minute === min) || frames[0];
      const next = frames.find((f) => f.minute === min + 1);

      if (prev && next) {
        const span = (next.minute - prev.minute) * 60;
        const p = span > 0 ? Math.max(0, Math.min(1, (gameTime - prev.minute * 60) / span)) : 0;
        team = Math.round(prev.team_gold_diff + p * (next.team_gold_diff - prev.team_gold_diff));
        self = Math.round(prev.self_gold_diff + p * (next.self_gold_diff - prev.self_gold_diff));
      } else if (prev) {
        team = prev.team_gold_diff;
        self = prev.self_gold_diff;
      }
    }

    // Respaldos si `minute_frames` todavía no está.
    if (team === null && match.gold_diff_15 != null) team = match.gold_diff_15;

    if (team === null && match.participants && match.participants.length > 0) {
      const oro = (id: number) =>
        match.participants!.filter((p) => p.team_id === id).reduce((s, p) => s + (p.gold || 0), 0);
      const azul = oro(100);
      const rojo = oro(200);
      const mio = match.participants.find((p) => p.is_self)?.team_id || 100;
      if (azul > 0 || rojo > 0) team = mio === 100 ? azul - rojo : rojo - azul;
    }

    return { teamGoldDiff: team, selfGoldDiff: self };
  }, [match, gameTime]);

  /**
   * Contra QUIÉN es la diferencia individual. Estaba escrito "Jungla rival" a
   * fuego: un support veía que su oro se comparaba con el de la jungla enemiga,
   * que no es lo que mide el dato.
   */
  const rival = useMemo(() => {
    const ps = match.participants ?? [];
    const yo = ps.find((p) => p.is_self);
    if (!yo?.role) return null;
    const otro = ps.find((p) => p.team_id !== yo.team_id && sameRole(p.role, yo.role));
    return otro ? { role: roleLabel(otro.role), champion: otro.champion } : null;
  }, [match.participants]);

  const isCameraSnap = (match.camera_snaps || []).some(
    (s) => Math.abs(s - currentTime) <= SNAP_WINDOW
  );
  const activeEvent = (match.timeline_markers || []).find(
    (m) => Math.abs(m.time - currentTime) <= EVENT_WINDOW
  );

  if (!visible) return null;

  return (
    <div style={styles.layer}>
      <div style={styles.topRow}>
        {/* Telemetría de oro en vivo y reloj de partida. */}
        <div style={styles.hud}>
          <span style={styles.clockCell}>
            <Tv size={13} color="var(--cool)" />
            <span className="u-metric">{clock(gameTime)}</span>
          </span>

          {teamGoldDiff !== null ? (
            <span
              style={{
                ...styles.pill,
                color: teamGoldDiff >= 0 ? "var(--win)" : "var(--loss)",
                background: `color-mix(in srgb, ${teamGoldDiff >= 0 ? "var(--win)" : "var(--loss)"} 18%, transparent)`,
                border: `1px solid color-mix(in srgb, ${teamGoldDiff >= 0 ? "var(--win)" : "var(--loss)"} 36%, transparent)`,
              }}
              title={t("Your team's total gold lead over the enemy team, updated second by second")}
            >
              {teamGoldDiff >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
              {t("{v}g team", { v: teamGoldDiff >= 0 ? `+${teamGoldDiff.toLocaleString()}` : teamGoldDiff.toLocaleString() })}
            </span>
          ) : (
            // Decía "Sincronizando oro…" para siempre en cualquier partida sin
            // datos de Riot. No estaba sincronizando nada.
            <span style={{ ...styles.pill, color: "var(--faint)", background: "var(--sunken)" }}>
              {t("No gold data")}
            </span>
          )}

          {selfGoldDiff !== null && (
            <span
              style={{
                ...styles.pill,
                color: selfGoldDiff >= 0 ? "var(--cool)" : "var(--brand)",
                background: `color-mix(in srgb, ${selfGoldDiff >= 0 ? "var(--cool)" : "var(--brand)"} 18%, transparent)`,
                border: `1px solid color-mix(in srgb, ${selfGoldDiff >= 0 ? "var(--cool)" : "var(--brand)"} 36%, transparent)`,
              }}
              title={
                rival
                  ? t("Your gold against your direct opponent ({role}, {champion}), in real time", {
                      role: t(rival.role),
                      champion: rival.champion,
                    })
                  : t("Your gold against your direct lane opponent, in real time")
              }
            >
              <UserCheck size={11} />
              {t("{v}g vs {role}", {
                v: selfGoldDiff >= 0 ? `+${selfGoldDiff.toLocaleString()}` : selfGoldDiff.toLocaleString(),
                role: rival ? t(rival.role) : t("lane"),
              })}
            </span>
          )}
        </div>

        <div style={styles.topRight}>
          {isCameraSnap && (
            <span style={styles.snapPill}>
              <Camera size={12} />
              {t("Camera jump")}
            </span>
          )}
          {!!match.apm && (
            <span style={{ ...styles.hud, color: "var(--cool)" }}>
              <Sparkles size={11} />
              <span className="u-metric">{t("{n} APM", { n: Math.round(match.apm) })}</span>
            </span>
          )}
        </div>
      </div>

      {activeEvent && (
        <div style={styles.banner}>
          <span style={styles.bannerDot} />
          <span>{activeEvent.description}</span>
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  layer: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    zIndex: 6,
    padding: "var(--space-4)",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
  },
  topRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  topRight: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--space-2)" },
  // El HUD flota sobre el vídeo, así que aquí sí hay lámina: es de las pocas
  // superficies del sistema que se apoyan sobre algo que no controlamos.
  hud: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "6px var(--space-3)",
    borderRadius: "var(--radius-md)",
    background: "color-mix(in srgb, var(--ground) 86%, transparent)",
    backdropFilter: "blur(10px)",
    border: "1px solid var(--glass-line)",
    fontSize: "11px",
  },
  clockCell: { display: "inline-flex", alignItems: "center", gap: "5px", color: "var(--text)" },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "2px var(--space-2)",
    borderRadius: "var(--radius-sm)",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    fontVariantNumeric: "tabular-nums",
  },
  snapPill: {
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    padding: "5px var(--space-3)",
    borderRadius: "var(--radius-full)",
    background: "color-mix(in srgb, var(--flag) 22%, transparent)",
    border: "1px solid color-mix(in srgb, var(--flag) 45%, transparent)",
    color: "var(--text)",
    fontSize: "11px",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
  banner: {
    alignSelf: "center",
    marginBottom: "var(--space-8)",
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "6px var(--space-4)",
    borderRadius: "var(--radius-full)",
    background: "color-mix(in srgb, var(--ground) 88%, transparent)",
    backdropFilter: "blur(10px)",
    border: "1px solid var(--glass-line)",
    color: "var(--text)",
    fontSize: "12px",
  },
  bannerDot: {
    width: "6px",
    height: "6px",
    borderRadius: "var(--radius-full)",
    background: "var(--cool)",
  },
};
