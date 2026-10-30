import React, { useEffect, useState } from "react";
import { BarChart3 } from "lucide-react";
import type { MatchMetadata, Participant } from "../../../types";
import type { PlayerCredit } from "../../../core/tauri-ipc";
import { useT } from "../../../core/LanguageProvider";
import { sameRole } from "../../../core/roles";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { fetchAttribution } from "../useMatchData";
import { SyncNotice } from "./InspNotice";
import { MatchSummary } from "./MatchSummary";
import { MatchCost } from "./MatchCost";
import { RivalCard, findRival } from "./RivalCard";
import type { SeccionId } from "./MatchTab";
import type { OpenMap } from "../mapFocus";
import "./SummaryTab.css";

/**
 * Pestaña Resumen del reproductor (2026-10-29): sustituye a Partida e Impacto.
 *
 * El usuario: «hay tanta data que es difícil de seguir». Eran dos pestañas de
 * 1.058 y 1.936 px en un panel de 450, con dos selectores de cuatro opciones
 * en la primera gráfica. Ahora el panel dice solo lo que se corrige jugando,
 * en frases que llevan al vídeo:
 *
 *  1. Lo que decidió la partida (`MatchSummary`).
 *  2. Lo que te costó, una línea por jugada (`MatchCost` en corto).
 *  3. Tú contra tu rival, su frase (`RivalCard` en corto).
 *
 * Todo lo demás (curvas, muertes, jungla, oro, marcador, impacto) está en la
 * hoja ancha de estadísticas, que se abre encima del vídeo con el botón de
 * abajo o desde una frase que habla de un bloque.
 */

export interface SummaryTabProps {
  match: MatchMetadata;
  participants: Participant[];
  /** Miradas al mapa (segundos de VÍDEO), las mismas que cuenta la tira. */
  cameraSnaps: number[];
  syncing: boolean;
  onSync: () => void;
  /** Saltar en el vídeo (segundos de VÍDEO). */
  seekTo: (videoSeconds: number, play: boolean) => void;
  onOpenMap: OpenMap;
  /** Abrir la hoja de estadísticas, en un bloque si se dice cuál. */
  onOpenStats: (block?: SeccionId) => void;
}

export const SummaryTab: React.FC<SummaryTabProps> = ({
  match, participants, cameraSnaps, syncing, onSync, seekTo, onOpenMap, onOpenStats,
}) => {
  const t = useT();
  const synced = !match.is_vod && !!match.riot_match_id;

  // El reparto (WPA) de los diez: da lo que te costó y el impacto del duelo.
  // Es la misma promesa que pide la hoja, así que abrirla después es gratis.
  const [credits, setCredits] = useState<PlayerCredit[] | null | undefined>(undefined);
  useEffect(() => {
    setCredits(undefined);
    if (!synced) return;
    let vivo = true;
    fetchAttribution(match.id)
      .then((rows) => { if (vivo) setCredits(rows); })
      .catch(() => { if (vivo) setCredits(null); });
    return () => { vivo = false; };
  }, [match.id, synced]);

  if (match.is_vod) {
    return (
      <div className="insp">
        <EmptyState
          title={t("No summary for an imported VOD")}
          text={t("The summary needs a recorded game synced with Riot; imported VODs have no match data behind them.")}
        />
      </div>
    );
  }

  const { meIdx, rivalIdx, role } = findRival(participants, credits);
  const me = meIdx >= 0 ? participants[meIdx] : undefined;
  const rival = rivalIdx >= 0 ? participants[rivalIdx] : undefined;
  const creditOf = (i: number) => credits?.find((c) => c.participant_id === i + 1);
  const isJungler = sameRole(me?.role, "JUNGLE");
  const hasGankMarkers = (match.timeline_markers ?? []).some((m) => m.event_type === "gank_attempt");
  const offset = match.video_offset ?? 0;
  const conVideo = !!match.video_path;

  return (
    <div className="insp sum">
      {!synced && (
        <SyncNotice
          text={t("What decided the game, what it cost you and your rival come from Riot's data for the game.")}
          syncing={syncing}
          onSync={onSync}
        />
      )}

      {synced && (
        <MatchSummary
          match={match}
          isJungler={isJungler}
          wantsMoves={isJungler || hasGankMarkers}
          enemyTeam={me?.team_id === 200 ? 100 : 200}
          cameraSnaps={cameraSnaps}
          onOpenMap={onOpenMap}
          onReveal={(block) => onOpenStats(block)}
        />
      )}

      {synced && meIdx >= 0 && credits !== null && (
        <MatchCost
          match={match}
          selfPid={meIdx + 1}
          credit={credits === undefined ? undefined : creditOf(meIdx) ?? null}
          onSeekVideo={conVideo ? (v) => seekTo(v, true) : undefined}
          onOpenMap={onOpenMap}
          compact
        />
      )}

      {me && rival && (
        <section>
          <div className="sect__head">
            <span className="u-label">{t("You vs your opponent")}</span>
            <i className="sect__rule" />
          </div>
          <RivalCard
            me={me}
            rival={rival}
            participants={participants}
            meCredit={creditOf(meIdx)}
            rivalCredit={creditOf(rivalIdx)}
            frames={match.minute_frames}
            role={role}
            jungle={sameRole(role, "JUNGLE")}
            onSeekGame={conVideo ? (g) => seekTo(Math.max(0, g + offset), false) : undefined}
            compact
          />
        </section>
      )}

      <Button className="sum__more" icon={<BarChart3 size={16} aria-hidden="true" />} onClick={() => onOpenStats()}>
        {t("See full stats")}
      </Button>
    </div>
  );
};
