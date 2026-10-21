import React, { useMemo } from "react";
import { MatchMetadata } from "../../../types";
import { Camera, Zap } from "lucide-react";
import { clock } from "../../../core/time";
import { roleLabel, sameRole } from "../../../core/roles";
import { champLabel } from "../../../core/matchEvents";
import { useT } from "../../../core/LanguageProvider";
import { formatGold, formatSigned } from "./pressureFormat";

interface EsportsPlayerOverlayProps {
  currentTime: number;
  match: MatchMetadata;
  visible: boolean;
}

/** Margen para dar por activo un salto de cámara o un suceso alrededor del segundo actual. */
const SNAP_WINDOW = 1.5;
const EVENT_WINDOW = 3;

/** "+1,2k" / "−850" / "0": la ventaja de equipo se lee de un vistazo, y a
 *  partir de mil el detalle de las unidades no cambia nada. */
const compactGold = (n: number): string =>
  Math.abs(n) >= 1000 ? `${formatSigned(n / 1000, 1)}k` : formatGold(n, true);

/**
 * HUD sobre el vídeo: dos láminas de vidrio arriba (reloj y oro a la
 * izquierda, APM a la derecha) y, si toca, el salto de cámara y el suceso del
 * momento. Va dentro del escenario, que es oscuro en los dos temas: sus clases
 * (`vp-hud*`, VideoPlayer.css) toman los tokens del ámbito `.stage-dark`, no
 * los del tema claro. Antes eran píldoras teñidas con los colores del claro
 * sobre el vídeo, y suspendían AA (3,8).
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
   * que no es lo que mide el dato. Se nombra por el campeón, que es lo que se
   * ve en el vídeo; el puesto queda en la ayuda.
   */
  const rival = useMemo(() => {
    const ps = match.participants ?? [];
    const yo = ps.find((p) => p.is_self);
    if (!yo?.role) return null;
    const otro = ps.find((p) => p.team_id !== yo.team_id && sameRole(p.role, yo.role));
    return otro ? { role: roleLabel(otro.role), champion: champLabel(otro.champion) } : null;
  }, [match.participants]);

  const isCameraSnap = (match.camera_snaps || []).some(
    (s) => Math.abs(s - currentTime) <= SNAP_WINDOW
  );
  const activeEvent = (match.timeline_markers || []).find(
    (m) => Math.abs(m.time - currentTime) <= EVENT_WINDOW
  );

  if (!visible) return null;

  return (
    <div className="vp-hud">
      <div className="vp-hud__row">
        {/* Reloj de partida y oro en vivo, en una sola lámina. */}
        <div className="vp-hud__pill">
          <span className="t-time vp-hud__clock">{clock(gameTime)}</span>
          {teamGoldDiff !== null ? (
            <span
              className="vp-hud__gold"
              data-down={teamGoldDiff < 0 || undefined}
              title={t("Your team's total gold lead over the enemy team, updated second by second")}
            >
              {t("Team {v} gold", { v: compactGold(teamGoldDiff) })}
            </span>
          ) : (
            // Decía "Sincronizando oro…" para siempre en cualquier partida sin
            // datos de Riot. No estaba sincronizando nada.
            <span className="vp-hud__soft">{t("No gold data")}</span>
          )}
          {selfGoldDiff !== null && (
            <span
              className="vp-hud__rival"
              title={
                rival
                  ? t("Your gold against your direct opponent ({role}, {champion}), in real time", {
                      role: t(rival.role),
                      champion: rival.champion,
                    })
                  : t("Your gold against your direct lane opponent, in real time")
              }
            >
              <span className="vp-hud__dot" aria-hidden="true">·</span>
              {rival
                ? t("{v} vs {champion}", { v: formatGold(selfGoldDiff, true), champion: rival.champion })
                : t("{v} vs your lane opponent", { v: formatGold(selfGoldDiff, true) })}
            </span>
          )}
        </div>

        <div className="vp-hud__side">
          {!!match.apm && (
            <span className="vp-hud__pill">
              <Zap size={14} className="vp-hud__icon" aria-hidden="true" />
              <span className="u-metric">{t("{n} APM", { n: Math.round(match.apm) })}</span>
            </span>
          )}
          {isCameraSnap && (
            <span className="vp-hud__pill">
              <Camera size={14} className="vp-hud__icon vp-hud__icon--flag" aria-hidden="true" />
              {t("Camera jump")}
            </span>
          )}
        </div>
      </div>

      {activeEvent && (
        <div className="vp-hud__pill vp-hud__banner">
          <span className="vp-hud__bannerDot" aria-hidden="true" />
          <span>{activeEvent.description}</span>
        </div>
      )}
    </div>
  );
};
