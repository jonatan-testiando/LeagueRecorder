import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { MatchMetadata, Participant, ItemPurchase } from "../../../types";
import { useT } from "../../../core/LanguageProvider";
import { champLabel } from "../../../core/matchEvents";
import { sameRole } from "../../../core/roles";
import { PositionIcon, POSITION_LABEL, normalizePosition } from "../../../components/PositionIcon";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Button } from "../../../components/ui/Button";
import { ChampFace } from "./eventMeta";
import { GoldXpChart } from "./GoldXpChart";
import { LeadChart } from "./LeadChart";
import { JungleRouteWidget } from "./JungleRouteWidget";
import { DeathsSection } from "./DeathsSection";
import { HitsTaken } from "./HitsTaken";
import { AimSection } from "./AimSection";
import { GoldPurchases } from "./GoldPurchases";
import { InspSection } from "./InspSection";
import { InspNotice, SyncNotice } from "./InspNotice";
import { BenchmarkWidget } from "./BenchmarkWidget";
import { JungleMoves } from "./JungleMoves";
import { MatchSummary, type BlockId } from "./MatchSummary";
import type { OpenMap } from "../mapFocus";
import { formatGold } from "./pressureFormat";
import "./DeathsSection.css";
import "./MatchTab.css";

/**
 * Pestaña Partida del reproductor: qué pasó en esta partida.
 *
 * Rehecha el 2026-10-17. El usuario: "es demasiado y no entiendo nada… se ve
 * muy pequeño para ser tanta info". Eran diez secciones al mismo peso en una
 * columna de 400 px, con el mismo gank a dos horas distintas (una en reloj de
 * vídeo) y los objetivos y las invasiones contados dos veces. Ahora:
 *
 *  1. "Lo que decidió la partida" (`MatchSummary`): tres frases como mucho,
 *     cada una lleva a su sitio.
 *  2. Cuatro bloques con nombre llano: Ventaja, Muertes, Jungla (u "Oleadas y
 *     ganks" si no eres jungla) y Oro, y el Marcador, de consulta.
 *
 * Rediseño «Ritmo», fase 3 (auditoría E3): aun así medía 2,8 pantallas. Los
 * bloques son ahora un acordeón con UN bloque abierto (Ventaja, la primera
 * vez) y una barra de anclas fija arriba para saltar entre ellos sin
 * desplazarse. Lo abierto se recuerda en la sesión, no en disco: al volver a
 * la app, otra vez solo la Ventaja.
 *
 * Un solo reloj en toda la pestaña: el de la PARTIDA, el del HUD del juego.
 * Para saltar al vídeo se suma `video_offset` (vídeo − partida). Las filas que
 * hablan de un sitio (muertes, golpes, invasiones, ganks) abren el Mapa ahí.
 */

type SeccionId = BlockId | "match-scoreboard";

/** El bloque abierto, para toda la sesión: cambiar de partida o de pestaña no
 *  lo cierra. null es que el usuario los plegó todos. */
let abiertoEnLaSesion: SeccionId | null = "match-lead";

const diffTone = (n: number): string => (n >= 0 ? "win" : "loss");

export interface MatchTabProps {
  match: MatchMetadata;
  participants: Participant[];
  itemPurchases: ItemPurchase[];
  ddragonVer: string;
  /** Miradas al mapa (segundos de VÍDEO). Lo que ReviewQueue llama "looks":
   *  saltos de cámara y, si se pasan, las cámaras aliadas. */
  cameraSnaps: number[];
  syncing: boolean;
  onSync: () => void;
  /** Saltar en el vídeo (segundos de VÍDEO). */
  seekTo: (videoSeconds: number, play: boolean) => void;
  /** Dónde va el vídeo (segundos de VÍDEO): el cabezal de la curva de Ventaja. */
  videoTime: number;
  /** Abrir el Mapa en un momento con lo suyo dibujado. */
  onOpenMap: OpenMap;
}

export const MatchTab: React.FC<MatchTabProps> = ({
  match, participants, itemPurchases, ddragonVer, cameraSnaps, syncing, onSync, seekTo, videoTime, onOpenMap,
}) => {
  const t = useT();
  const selfP = participants.find((p) => p.is_self);
  // El jugador grabado: su puesto decide el baremo de rango y el bloque de
  // jungla; su equipo, de quién son los campamentos que invade.
  const isJungler = sameRole(selfP?.role, "JUNGLE");
  const enemyTeam = selfP?.team_id === 200 ? 100 : 200;
  // Los ganks de un no-jungla sólo cuando los hay: a un support al que le
  // salen cero emboscadas no le hace falta un bloque que le diga cero.
  const hasGankMarkers = (match.timeline_markers ?? []).some((m) => m.event_type === "gank_attempt");
  const videoOffset = match.video_offset ?? 0;
  // Todo lo de los bloques sale de la timeline de Riot. Sin ella, cada bloque
  // decía a su manera que faltaba algo (y "Tus muertes" decía que no habías
  // muerto): mejor una sola explicación y el botón.
  const synced = !match.is_vod && !!match.riot_match_id;
  const seek = useCallback((secs: number) => seekTo(secs, false), [seekTo]);
  const seekGame = useCallback((gameSecs: number) => seekTo(Math.max(0, gameSecs + videoOffset), false), [seekTo, videoOffset]);

  // Los bloques de esta partida, en orden: el acordeón y sus anclas.
  const secciones: { id: SeccionId; title: string; anchor: string }[] = [
    ...(synced
      ? [
          { id: "match-lead" as const, title: t("Lead"), anchor: t("Lead") },
          { id: "match-deaths" as const, title: t("Deaths"), anchor: t("Deaths") },
          ...(isJungler || hasGankMarkers
            ? [{ id: "match-jungle" as const, title: isJungler ? t("Jungle") : t("Waves and ganks"), anchor: isJungler ? t("Jungle") : t("Ganks") }]
            : []),
          { id: "match-gold" as const, title: t("Gold"), anchor: t("Gold") },
        ]
      : []),
    ...(participants.length > 0 ? [{ id: "match-scoreboard" as const, title: t("Scoreboard"), anchor: t("Scoreboard") }] : []),
  ];
  const ids = secciones.map((s) => s.id);

  // Un bloque abierto como mucho. Si el recordado no existe en esta partida
  // (la jungla de un mid), el primero.
  const [abiertoPedido, setAbiertoPedido] = useState<SeccionId | null>(abiertoEnLaSesion);
  const abierto = abiertoPedido === null ? null : ids.includes(abiertoPedido) ? abiertoPedido : ids[0] ?? null;

  // Abrir un bloque lo trae a la vista. `n` hace que pedir dos veces el
  // mismo funcione; `block` dice cuánto: una frase del resumen o un ancla lo
  // ponen arriba ("start"); su propia cabecera, solo si se ha ido de la
  // vista al plegarse el de encima ("nearest").
  const [aLaVista, setALaVista] = useState<{ id: SeccionId; n: number; block: ScrollLogicalPosition } | null>(null);
  const abrir = useCallback((id: SeccionId, block: ScrollLogicalPosition) => {
    abiertoEnLaSesion = id;
    setAbiertoPedido(id);
    setALaVista((r) => ({ id, n: (r?.n ?? 0) + 1, block }));
  }, []);
  const alternar = (id: SeccionId) => {
    if (abierto === id) {
      abiertoEnLaSesion = null;
      setAbiertoPedido(null);
    } else {
      abrir(id, "nearest");
    }
  };
  useEffect(() => {
    if (!aLaVista) return;
    // Se espera a pintarlo abierto: desplazarse antes apunta al bloque
    // plegado, y lo que se abre o se cierra encima lo mueve.
    const raf = requestAnimationFrame(() => {
      const quieto = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      document.getElementById(aLaVista.id)?.scrollIntoView({ block: aLaVista.block, behavior: quieto ? "auto" : "smooth" });
    });
    return () => cancelAnimationFrame(raf);
  }, [aLaVista]);

  // La puntería se pide al abrirla, no al montar la pestaña.
  const [aimOpen, setAimOpen] = useState(false);

  const hasCurve = !!match.minute_frames && match.minute_frames.length > 1;
  const has15 = match.gold_diff_15 != null || match.xp_diff_15 != null || match.jungle_cs_diff_15 != null;

  const seccion = (id: SeccionId, children: React.ReactNode) => {
    const s = secciones.find((x) => x.id === id);
    if (!s) return null;
    return (
      <InspSection id={id} title={s.title} open={abierto === id} onToggle={() => alternar(id)}>
        {children}
      </InspSection>
    );
  };

  return (
    <div className="insp mt">
      {!match.is_vod && !synced && (
        <SyncNotice
          text={t("The lead, your deaths, the route and your gold come from Riot's timeline of the game.")}
          syncing={syncing}
          onSync={onSync}
        />
      )}

      {synced && (
        <MatchSummary
          match={match}
          isJungler={isJungler}
          wantsMoves={isJungler || hasGankMarkers}
          enemyTeam={enemyTeam}
          cameraSnaps={cameraSnaps}
          onOpenMap={onOpenMap}
          onReveal={(id) => abrir(id, "start")}
        />
      )}

      {/* Las anclas: fijas arriba al desplazarse, con el bloque abierto
          marcado. Pulsar una abre su bloque y lo trae. */}
      {secciones.length > 1 && (
        <nav className="mt-anchors" aria-label={t("Game sections")}>
          {secciones.map((s) => (
            <button
              key={s.id}
              type="button"
              className="mt-anchor"
              aria-current={abierto === s.id || undefined}
              onClick={() => abrir(s.id, "start")}
            >
              {s.anchor}
            </button>
          ))}
        </nav>
      )}

      <div className="mt-blocks">
        {/* ------------------------------------------------------- Ventaja.
            La curva por minuto con modos (oro, XP, daño; contra tu rival, la
            media rival, equipo contra equipo o los diez), la franja de
            objetivos y la probabilidad de victoria con sus jugadas (LeadChart).
            Sin la timeline guardada, la curva vieja del oro del equipo. Debajo,
            la línea del minuto 15 y frente a tu rango, corto. El duelo con tu
            rival directo sigue en Impacto → "Tú contra tu rival". */}
        {seccion(
          "match-lead",
          <div className="mt-block">
            <LeadChart
              matchId={match.id}
              videoTime={videoTime}
              videoOffset={videoOffset}
              onSeekGame={seekGame}
              fallback={
                hasCurve ? (
                  <GoldXpChart frames={match.minute_frames ?? []} videoOffset={videoOffset} onSeek={seek} />
                ) : undefined
              }
            />
            {has15 && (
              <p className="ds-summary">
                {t("At minute 15:")}{" "}
                {([
                  [t("gold"), match.gold_diff_15],
                  [t("XP"), match.xp_diff_15],
                  // Los campamentos sólo dicen algo del jungla: a un mid le salía
                  // "jungla +0" en todas las partidas.
                  [t("jungle CS"), isJungler ? match.jungle_cs_diff_15 : null],
                ] as [string, number | null | undefined][])
                  .filter(([, v]) => v != null)
                  .map(([l, v], i) => (
                    <React.Fragment key={l}>
                      {i > 0 && " · "}
                      {l} <b className="u-metric mt-diff" data-tone={diffTone(v as number)}>{formatGold(v as number, true)}</b>
                    </React.Fragment>
                  ))}
                {match.lane_result && (
                  <>
                    {". "}
                    {t(
                      match.lane_result === "Win" ? "You came out of lane ahead."
                        : match.lane_result === "Loss" ? "You came out of lane behind."
                        : "You came out of lane even."
                    )}
                  </>
                )}
              </p>
            )}
            <div className="mt-sub">
              <span className="u-label">{t("Versus your rank")}</span>
              <i className="sect__rule" />
            </div>
            <BenchmarkWidget matchId={match.id} role={selfP?.role} tierBucket={match.tier_bucket} limit={3} compact />
          </div>
        )}

        {/* ------------------------------------------------------- Muertes.
            Tus muertes y las peleas que te empezaron. La puntería va plegada
            al final y marcada como sin validar: se construyó con las teclas
            grabadas, pero aún no se ha contrastado con el vídeo. Enseñarla al
            mismo peso que lo medido la haría pasar por cierta; quitarla del
            todo dejaría sin sitio donde contrastarla. */}
        {seccion(
          "match-deaths",
          <div className="mt-block">
            <DeathsSection
              matchId={match.id}
              markers={match.timeline_markers}
              cameraSnaps={cameraSnaps}
              videoOffset={videoOffset}
              selfPid={selfP ? participants.indexOf(selfP) + 1 : null}
              onOpenMap={onOpenMap}
            />
            <div className="mt-sub">
              <span className="u-label">{t("Fights started on you")}</span>
              <i className="sect__rule" />
            </div>
            <HitsTaken matchId={match.id} onOpenMap={onOpenMap} />
            <details className="mt-more" onToggle={(e) => setAimOpen(e.currentTarget.open)}>
              <summary>
                {t("Your aim")}
                <em>· {t("not validated yet")}</em>
              </summary>
              {aimOpen && (
                <div className="mt-more__body">
                  <AimSection matchId={match.id} videoOffset={videoOffset} onSeek={seek} />
                </div>
              )}
            </details>
          </div>
        )}

        {/* ------------------------------------------- Jungla / Oleadas y ganks.
            Las cifras de tu ruta y UNA lista con tus invasiones y tus ganks
            (antes: la ruta, "Oleadas y macro" y "Ganks", con dos cifras de
            invasiones y el mismo gank a dos horas). Las franjas de oleadas por
            carril las dibuja el Mapa al abrir cada fila. */}
        {seccion(
          "match-jungle",
          <div className="mt-block">
            {isJungler && <JungleRouteWidget matchId={match.id} onOpenMap={onOpenMap} />}
            {isJungler && (
              <div className="mt-sub">
                <span className="u-label">{t("Invades and ganks")}</span>
                <i className="sect__rule" />
              </div>
            )}
            <JungleMoves
              matchId={match.id}
              markers={match.timeline_markers}
              videoOffset={videoOffset}
              isJungler={isJungler}
              enemyTeam={enemyTeam}
              gankImpact15={match.gank_impact_15}
              onOpenMap={onOpenMap}
            />
          </div>
        )}

        {/* ------------------------------------------------- Oro: compras y bases */}
        {seccion(
          "match-gold",
          <GoldPurchases
            matchId={match.id}
            itemPurchases={itemPurchases}
            markers={match.timeline_markers}
            ddragonVer={ddragonVer}
            videoOffset={videoOffset}
            onSeek={seek}
          />
        )}

        {/* --------------------------------------------- el marcador.
            Un bloque por equipo: su nombre y resultado hacen de cabecera de
            las columnas. La cara del campeón y el icono de su posición dicen
            quién era cada uno antes que el nick. */}
        {seccion(
          "match-scoreboard",
          [100, 200].map((teamId) => {
            const team = participants.filter((p) => p.team_id === teamId);
            if (team.length === 0) return null;
            const won = team[0].win;
            const tone = won ? "win" : "loss";
            return (
              <div key={teamId} className="vp-sb">
                <div className="vp-sb__head">
                  <span className="vp-sb__team">
                    <i className="mt-teamDot" data-tone={tone} />
                    {t(teamId === 100 ? "Blue Team" : "Red Team")}
                    <em className="mt-teamResult" data-tone={tone}>{t(won ? "Victory" : "Defeat")}</em>
                  </span>
                  <span>{t("K/D/A")}</span>
                  <span>{t("CS")}</span>
                  <span>{t("Gold")}</span>
                </div>
                {team.map((p, i) => {
                  const pos = normalizePosition(p.role);
                  return (
                    <div key={i} className="vp-sb__row" data-self={p.is_self || undefined}>
                      <ChampFace
                        champion={p.champion}
                        size={28}
                        className="vp-sb__face"
                        fallback={<span className="vp-sb__face vp-sb__face--empty" />}
                      />
                      <span className="vp-sb__who">
                        <span className="vp-sb__name">{p.is_self ? t("You") : (p.name || champLabel(p.champion))}</span>
                        <span className="vp-sb__champ">
                          {pos && (
                            <PositionIcon position={pos} size={12} color="var(--faint)" title={t(POSITION_LABEL[pos])} />
                          )}
                          {champLabel(p.champion)}
                        </span>
                      </span>
                      <span className="u-metric vp-sb__kda">{p.kills}/{p.deaths}/{p.assists}</span>
                      <span className="u-metric vp-sb__num">{p.cs}</span>
                      <span className="u-metric vp-sb__num">{(p.gold / 1000).toFixed(1)}k</span>
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>

      {match.is_vod ? (
        // Antes, en un VOD, aquí no salía nada: un hueco que se leía como
        // "esto está roto".
        <EmptyState
          title={t("No scoreboard for an imported VOD")}
          text={t("The 10-player scoreboard comes from your own game synced with Riot. An imported video has no match behind it.")}
        />
      ) : synced && participants.length === 0 ? (
        // Sincronizada pero sin los diez: falta sólo el marcador.
        <InspNotice
          title={t("The 10-player scoreboard is not loaded yet.")}
          action={
            <Button size="sm" icon={<RefreshCw size={14} />} loading={syncing} loadingLabel={t("Syncing…")} onClick={onSync}>
              {t("Sync with Riot")}
            </Button>
          }
        />
      ) : null}

      {synced && participants.length > 0 && (
        <Button size="sm" className="insp__resync" icon={<RefreshCw size={14} />} loading={syncing} loadingLabel={t("Updating…")} onClick={onSync}>
          {t("Refresh Riot data")}
        </Button>
      )}
    </div>
  );
};
