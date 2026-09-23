import React, { useEffect, useMemo, useState } from "react";
import { FolderOpen, Loader2, Play, RefreshCw, Trash2, Users } from "lucide-react";
import { MatchMetadata } from "../../../types";
import { computeKDA, formatDuration, outcome } from "../../../core/matchStats";
import { rankLabel } from "../../../core/ddragon";
import { clock, relativeDay } from "../../../core/time";
import { syncMatchNow } from "../../../core/tauri-ipc";
import { type ReviewProgress } from "../../../core/review";
import { useLang, useT } from "../../../core/LanguageProvider";
import { useAppStore, useErrorClips } from "../../../store/useAppStore";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { ChampionWash } from "../../../components/ChampionWash";
import { PositionIcon, POSITION_LABEL, normalizePosition } from "../../../components/PositionIcon";
import { buildQueue, type Moment } from "../../player/components/ReviewQueue";
import { eventMeta, toneLabelAndIcon } from "../../player/components/eventMeta";
import {
  fmtDec,
  hourOf,
  kdaDe,
  lpText,
  ordinal,
  ratioLabel,
  ratioTone,
  selfOf,
} from "./libraryShared";
import "./MatchDetailPanel.css";

/**
 * El detalle de la partida seleccionada en la biblioteca.
 *
 * Es la mitad derecha del maestro-detalle: la lista dice "cuál", esto dice
 * "cómo fue y qué te queda por mirar", y acaba en la única acción en oro de la
 * pantalla, abrirla. Todo sale de datos que la partida ya trae; lo que solo
 * sabe la sincronización con Riot (el marcador) se pide aquí mismo.
 */
interface Props {
  match: MatchMetadata;
  progress: ReviewProgress | undefined;
  /** LP que dio o quitó (la resta con la anterior), si se sabe. */
  lpDelta: number | undefined;
  /** Abre el reproductor; con `seek`, en ese segundo de vídeo. */
  onOpen: (seek?: number) => void;
  onReveal: () => void;
  onDelete: () => void;
}

type ChipTone = "loss" | "gold" | "flag";

/**
 * La valoración de un momento de la cola. La cola solo guarda la gravedad; la
 * palabra ("Error", "Regalo", "Impreciso") sale del mismo `tone` que pinta el
 * reproductor, reconstruido del suceso que codifica el id.
 */
const rating = (m: Moment): { text: string; tone: ChipTone } => {
  if (m.source === "error") return { text: "Flagged", tone: "loss" };
  if (m.id.startsWith("snap:")) return { text: "Finding", tone: "flag" };
  const [, , type = "", subtype = ""] = m.id.split(":");
  const tone = eventMeta({ type, subtype, time: m.time, description: "" }).tone;
  const text = toneLabelAndIcon(tone).text;
  return { text, tone: tone === "inaccuracy" ? "gold" : "loss" };
};

export const MatchDetailPanel: React.FC<Props> = ({ match, progress, lpDelta, onOpen, onReveal, onDelete }) => {
  const t = useT();
  const { lang } = useLang();
  const { clips } = useErrorClips();
  const refreshMatches = useAppStore((s) => s.refreshMatches);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // El error de sincronizar es de ESA partida: al cambiar de fila se olvida.
  useEffect(() => {
    setSyncError(null);
  }, [match.id]);

  const res = outcome(match.result);
  const color = res === "victory" ? "var(--win)" : res === "defeat" ? "var(--loss)" : "var(--faint)";
  const kda = kdaDe(match, computeKDA(match.events));
  const yo = selfOf(match);
  const pos = normalizePosition(yo?.role);
  const minutos = match.game_duration / 60;
  const csmin = yo && minutos > 0 ? fmtDec(yo.cs / minutos, 1, lang) : null;

  const rango = rankLabel(match.rank_tier, match.rank_division);
  const lp =
    lpDelta != null && lpDelta !== 0
      ? { text: lpText(lpDelta), tone: lpDelta > 0 ? "win" : "loss" }
      : match.rank_lp != null
        ? { text: `${match.rank_lp} LP`, tone: "neutral" }
        : null;

  // "hoy 18:32" y "ayer 21:10"; más atrás la hora ya no ubica y basta el día.
  const dia = relativeDay(match.date, t);
  const hora = hourOf(match.date);
  const cuando = hora && (dia === t("today") || dia === t("yesterday")) ? `${dia} ${hora}` : dia;

  // Impacto: el puesto entre los diez y, si hay, la nota de la partida.
  const rank = match.impact_rank ?? null;
  const nota = match.impact_percentile != null ? Math.round(match.impact_percentile) : null;
  const impacto = rank === 1 ? t("MVP") : rank ? ordinal(rank, t) : "—";
  const impactoSub =
    nota != null
      ? t("Score {n}", { n: nota })
      : rank === 1
        ? t("Best of the game")
        : rank
          ? t("of 10 players")
          : yo
            ? t("Not calculated")
            : t("Not synced");

  // Marcador: solo con los diez. Riot ordena por posición en cada equipo, así
  // que la fila i de cada lado es el mismo puesto.
  const board = useMemo(() => {
    const ps = match.participants;
    const me = ps?.find((p) => p.is_self);
    if (!ps || ps.length !== 10 || !me) return null;
    const allies = ps.filter((p) => p.team_id === me.team_id);
    const enemies = ps.filter((p) => p.team_id !== me.team_id);
    if (allies.length !== 5 || enemies.length !== 5) return null;
    return allies.map((a, i) => ({ ally: a, enemy: enemies[i] }));
  }, [match.participants]);

  // La cola de revisión: la misma que tacha el reproductor.
  const moments = useMemo(
    () => buildQueue(match, clips.filter((c) => c.match_id === match.id), t),
    [match, clips, t]
  );
  const pendientes = moments.filter((m) => !m.reviewed);
  const lista = (pendientes.length > 0 ? pendientes : moments).slice(0, 3);
  const revisada = progress?.reviewed ?? false;

  const sincronizar = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncError(null);
    try {
      await syncMatchNow(match.id);
      await refreshMatches();
    } catch (e) {
      setSyncError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setSyncing(false);
    }
  };

  const ratio = ratioTone(kda);

  return (
    <aside className="mdp" aria-label={t("Game details")}>
      {/* Cabecera: tu campeón como ambiente, el resultado como titular. */}
      <div className="mdp-hero">
        <ChampionWash champion={match.champion} side="top" intensity={0.5} />
        <div className="mdp-hero__row">
          <span className="mdp-portrait" style={{ "--ring": color } as React.CSSProperties}>
            <ChampionAvatar champion={match.champion} size={64} />
          </span>
          <div className="mdp-hero__txt">
            <div className="mdp-hero__res">
              <span className="mdp-res" style={{ color }}>
                {t(res === "victory" ? "Victory" : res === "defeat" ? "Defeat" : "No result")}
              </span>
              {lp && (
                <span className={`mdp-lp mdp-lp--${lp.tone}`} title={rango ?? undefined}>
                  {lp.text}
                </span>
              )}
            </div>
            <span className="mdp-meta">
              <span className="mdp-meta__champ">{match.champion}</span>
              {pos && <> · {t(POSITION_LABEL[pos])}</>}
              {" · "}
              {formatDuration(match.game_duration)} · {cuando}
            </span>
          </div>
        </div>
      </div>

      {/* Tres cifras. */}
      <div className="mdp-figs">
        <div className="mdp-fig">
          <span className="mdp-fig__lbl">{t("KDA")}</span>
          <span className="mdp-fig__val">
            {kda.kills} / {kda.deaths} / {kda.assists}
          </span>
          <span className={`mdp-fig__sub lib-ratio--${ratio}`}>
            {t("Ratio {r}", { r: ratioLabel(kda, t, lang) })}
          </span>
        </div>
        <div className="mdp-fig">
          <span className="mdp-fig__lbl">{t("CS per minute")}</span>
          <span className="mdp-fig__val">{csmin ?? "—"}</span>
          <span className="mdp-fig__sub">{yo ? t("{n} CS", { n: yo.cs }) : t("Not synced")}</span>
        </div>
        <div className="mdp-fig">
          <span className="mdp-fig__lbl">{t("Impact")}</span>
          <span
            className="mdp-fig__val"
            style={{ color: rank === 1 ? "var(--brand)" : rank ? undefined : "var(--faint)" }}
          >
            {impacto}
          </span>
          <span className="mdp-fig__sub">{impactoSub}</span>
        </div>
      </div>

      <div className="mdp-body">
        {/* Marcador de los diez, o cómo conseguirlo. */}
        {board ? (
          <div className="mdp-board">
            <div className="mdp-board__head">
              <span><span className="mdp-dot mdp-dot--win" />{t("Your team")}</span>
              <span />
              <span className="mdp-board__right">{t("Enemy team")}<span className="mdp-dot mdp-dot--loss" /></span>
            </div>
            {board.map(({ ally, enemy }, i) => {
              const rol = ally.role || enemy.role;
              const rolKey = normalizePosition(rol);
              return (
                <div key={i} className="mdp-board__row">
                  <span className={`mdp-side${ally.is_self ? " mdp-side--me" : ""}`} title={ally.name ? `${ally.name}${ally.tag ? `#${ally.tag}` : ""}` : undefined}>
                    <span className="mdp-sq"><ChampionAvatar champion={ally.champion} size={26} /></span>
                    <span className="mdp-side__name">{ally.champion}</span>
                    <span className="mdp-side__kda">{ally.kills}/{ally.deaths}/{ally.assists}</span>
                  </span>
                  <span className="mdp-board__pos">
                    {rolKey && <PositionIcon position={rolKey} size={14} title={t(POSITION_LABEL[rolKey])} />}
                  </span>
                  <span className="mdp-side mdp-side--enemy" title={enemy.name ? `${enemy.name}${enemy.tag ? `#${enemy.tag}` : ""}` : undefined}>
                    <span className="mdp-sq"><ChampionAvatar champion={enemy.champion} size={26} /></span>
                    <span className="mdp-side__name">{enemy.champion}</span>
                    <span className="mdp-side__kda">{enemy.kills}/{enemy.deaths}/{enemy.assists}</span>
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mdp-empty">
            <span className="mdp-empty__icon"><Users size={18} aria-hidden /></span>
            <span className="mdp-empty__txt">
              {match.is_vod
                ? t("Imported videos have no Riot scoreboard")
                : t("The scoreboard of the 10 players appears after syncing with Riot")}
            </span>
            {!match.is_vod && (
              <button type="button" className="mdp-sbtn" onClick={sincronizar} disabled={syncing}>
                {syncing ? (
                  <Loader2 size={14} className="mdp-spin" aria-hidden />
                ) : (
                  <RefreshCw size={14} color="var(--cool)" aria-hidden />
                )}
                {syncing ? t("Syncing…") : t("Sync now")}
              </button>
            )}
            {syncError && (
              <span className="mdp-empty__err">{t("Couldn't sync with Riot: {msg}", { msg: syncError })}</span>
            )}
          </div>
        )}

        {/* Lo que queda por mirar, en frases. Clic: abre en ese instante. */}
        <div className="mdp-sec">
          <div className="mdp-sec__head">
            <span>{t(revisada || pendientes.length === 0 ? "Key moments" : "Moments to review")}</span>
            <span className="mdp-sec__aside">
              {revisada
                ? t("Game reviewed")
                : progress && progress.total > 0
                  ? t("{done} of {total} reviewed", { done: progress.done, total: progress.total })
                  : null}
            </span>
          </div>
          {lista.length === 0 ? (
            <p className="mdp-none">{t("Nothing flagged in this game yet")}</p>
          ) : (
            <div className="mdp-list">
              {lista.map((m) => {
                const r = rating(m);
                return (
                  <button key={m.id} type="button" className="mdp-moment" onClick={() => onOpen(m.time)}>
                    <span className="u-time mdp-time">{clock(m.time)}</span>
                    <span className="mdp-moment__txt">{m.title}</span>
                    <span className={`mdp-chip mdp-chip--${r.tone}`}>{t(r.text)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

      </div>

      {/* Una sola acción en oro; el resto, superficie. */}
      <div className="mdp-actions">
        <button type="button" className="btn btn--primary mdp-cta" aria-keyshortcuts="Enter" onClick={() => onOpen()}>
          <Play size={14} fill="currentColor" aria-hidden />
          {t("Review game")}
          <kbd className="mdp-cta__kbd">Enter</kbd>
        </button>
        <div className="mdp-actions__row">
          <button type="button" className="mdp-sbtn" onClick={onReveal}>
            <FolderOpen size={15} aria-hidden />
            {t("Open folder")}
          </button>
          <button type="button" className="mdp-sbtn mdp-sbtn--danger" onClick={onDelete} aria-keyshortcuts="Delete">
            <Trash2 size={15} aria-hidden />
            {t("Delete")}
          </button>
        </div>
      </div>
    </aside>
  );
};
