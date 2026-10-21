import React, { useEffect, useMemo, useState } from "react";
import { FolderOpen, Play, RefreshCw, Trash2, Users } from "lucide-react";
import { MatchMetadata } from "../../../types";
import { computeKDA, formatDuration, outcome } from "../../../core/matchStats";
import { rankLabel } from "../../../core/ddragon";
import { rankText } from "../../home/format";
import { clock } from "../../../core/time";
import { getMatchPlays, syncMatchNow, type MatchPlays } from "../../../core/tauri-ipc";
import { type ReviewProgress } from "../../../core/review";
import { useLang, useT } from "../../../core/LanguageProvider";
import { useAppStore, useErrorClips } from "../../../store/useAppStore";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { POSITION_LABEL, normalizePosition } from "../../../components/PositionIcon";
import { Button } from "../../../components/ui/Button";
import { Chip, type ChipTone } from "../../../components/ui/Chip";
import { Skeleton } from "../../../components/ui/Skeleton";
import { useDelayedLoading } from "../../../core/useDelayedLoading";
import { buildQueue, type Moment } from "../../player/components/ReviewQueue";
import { eventMeta, toneLabelAndIcon } from "../../player/components/eventMeta";
import {
  fmtDec,
  kdaDe,
  lpText,
  momentWpa,
  ordinal,
  ratioLabel,
  selfOf,
  shortDay,
  wpaText,
} from "./libraryShared";
import "./MatchDetailPanel.css";

/**
 * El detalle de la partida seleccionada en la biblioteca.
 *
 * Es la mitad derecha del maestro-detalle: la lista dice "cuál", esto dice
 * "cómo fue y qué te queda por mirar", y acaba en la única acción en oro de la
 * pantalla, abrirla. Todo sale de datos que la partida ya trae; lo que solo
 * sabe la sincronización con Riot (el marcador y las jugadas con su ΔWP) se
 * pide aquí mismo.
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

/** Cuántos momentos caben en el panel sin hacer scroll a 800 px de alto. */
const MOMENTOS = 3;

/**
 * La valoración de un momento de la cola, para los que no tienen ΔWP. La cola
 * solo guarda la gravedad; la palabra ("Error", "Impreciso", "Hallazgo") sale
 * del mismo `tone` que pinta el reproductor, reconstruido del suceso que
 * codifica el id.
 */
const rating = (m: Moment): { text: string; tone: ChipTone } => {
  if (m.source === "error") return { text: "Flagged", tone: "loss" };
  if (m.id.startsWith("snap:")) return { text: "Finding", tone: "finding" };
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
  // Las jugadas de Riot con su ΔWP. `undefined` mientras se leen: los chips
  // de los momentos esperan a saberlo para no cambiar de «Error» a «−6 %»
  // delante del usuario.
  const [plays, setPlays] = useState<MatchPlays | null | undefined>(undefined);

  const yo = selfOf(match);
  const sincronizada = !!yo;

  // El error de sincronizar es de ESA partida: al cambiar de fila se olvida.
  useEffect(() => {
    setSyncError(null);
  }, [match.id]);

  // Solo con la partida sincronizada hay jugadas; el comando lee de disco
  // (y cachea), así que pedirlas al seleccionar una fila no cuesta.
  useEffect(() => {
    if (!sincronizada) {
      setPlays(null);
      return;
    }
    let vivo = true;
    setPlays(undefined);
    getMatchPlays(match.id)
      .then((p) => vivo && setPlays(p ?? null))
      .catch(() => vivo && setPlays(null));
    return () => {
      vivo = false;
    };
  }, [match.id, sincronizada]);

  const res = outcome(match.result);
  const tono = res === "victory" ? "win" : res === "defeat" ? "loss" : "none";
  const kda = kdaDe(match, computeKDA(match.events));
  const pos = normalizePosition(yo?.role);
  const minutos = match.game_duration / 60;
  const csmin = yo && minutos > 0 ? fmtDec(yo.cs / minutos, 1, lang) : null;

  const rango = rankLabel(match.rank_tier, match.rank_division);
  // El LP que dio o quitó, con signo. Si no se sabe, el rango con su LP
  // («Maestro 16 LP»): un «16 LP» suelto junto a «Victoria» se leía como una
  // ganancia.
  const lp: { text: string; tone: ChipTone } | null =
    lpDelta != null && lpDelta !== 0
      ? { text: lpText(lpDelta), tone: lpDelta > 0 ? "win" : "loss" }
      : match.rank_lp != null && match.rank_tier
        ? { text: `${rankText(match.rank_tier.toUpperCase(), match.rank_division, t)} ${match.rank_lp} LP`, tone: "neutral" }
        : null;

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
  const revisada = progress?.reviewed ?? false;

  /**
   * Los momentos que se enseñan, con su ΔWP. De los que quedan por revisar,
   * primero los que más te costaron (si se sabe), y luego en el orden de la
   * partida: tres sitios no dan para la cola entera y el panel tiene que
   * decir por dónde empezar.
   */
  const lista = useMemo(() => {
    const offset = match.video_offset ?? 0;
    const myTeam = yo?.team_id ?? null;
    const pendientes = moments.filter((m) => !m.reviewed);
    const base = pendientes.length > 0 ? pendientes : moments;
    const conWpa = base.map((m) => ({ m, wpa: plays ? momentWpa(m, plays, offset, myTeam) : null }));
    const peso = (x: { wpa: number | null }) => (x.wpa == null ? -1 : Math.abs(x.wpa));
    return [...conWpa]
      .sort((a, b) => peso(b) - peso(a) || a.m.time - b.m.time)
      .slice(0, MOMENTOS)
      .sort((a, b) => a.m.time - b.m.time);
  }, [moments, plays, match.video_offset, yo?.team_id]);
  const hayPendientes = moments.some((m) => !m.reviewed);
  // Hasta tener las jugadas no se sabe qué tres enseñar (van por coste): se
  // guarda el sitio y, si tarda, su esqueleto. Así la lista no se reordena
  // delante del usuario.
  const leyendo = plays === undefined && lista.length > 0;
  const esqueleto = useDelayedLoading(leyendo);

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

  return (
    <aside className="mdp" aria-label={t("Game details")}>
      {/* Cabecera: retrato, el resultado como titular y su LP. */}
      <div className="mdp-head">
        <span className="mdp-avatar">
          <ChampionAvatar champion={match.champion} size={48} />
        </span>
        <div className="mdp-head__txt">
          <div className="mdp-head__res">
            <span className={`mdp-res mdp-res--${tono}`}>
              {t(res === "victory" ? "Victory" : res === "defeat" ? "Defeat" : "No result")}
            </span>
            {lp && (
              <Chip tone={lp.tone} title={rango ?? undefined}>
                {lp.text}
              </Chip>
            )}
          </div>
          <span className="mdp-meta">
            {match.champion}
            {pos && <> · {t(POSITION_LABEL[pos])}</>}
            {" · "}
            {formatDuration(match.game_duration)} · {shortDay(match.date, t, lang)}
          </span>
        </div>
      </div>

      {/* Tres cifras, separadas por aire y no por cajas. */}
      <div className="mdp-figs">
        <div className="mdp-fig">
          <span className="mdp-fig__lbl">{t("KDA")}</span>
          <span className="mdp-fig__val">
            {kda.kills} / {kda.deaths} / {kda.assists}
          </span>
          <span className="mdp-fig__sub">{t("Ratio {r}", { r: ratioLabel(kda, t, lang) })}</span>
        </div>
        <div className="mdp-fig">
          <span className="mdp-fig__lbl">{t("CS/min")}</span>
          <span className={`mdp-fig__val${csmin ? "" : " mdp-none"}`}>{csmin ?? "—"}</span>
          <span className="mdp-fig__sub">{yo ? t("{n} CS", { n: yo.cs }) : t("Not synced")}</span>
        </div>
        <div className="mdp-fig mdp-fig--end">
          <span className="mdp-fig__lbl">{t("Impact")}</span>
          <span className={`mdp-fig__val${rank ? "" : " mdp-none"}`}>{impacto}</span>
          <span className="mdp-fig__sub">{impactoSub}</span>
        </div>
      </div>

      <div className="mdp-body">
        {/* Los dos equipos, o cómo conseguirlos. */}
        {board ? (
          <div className="mdp-board">
            <div className="mdp-board__head">
              <span>{t("Your team")}</span>
              <span>{t("Enemy team")}</span>
            </div>
            {board.map(({ ally, enemy }, i) => (
              <div key={i} className="mdp-board__row">
                <span
                  className={`mdp-side${ally.is_self ? " mdp-side--me" : ""}`}
                  title={ally.name ? `${ally.name}${ally.tag ? `#${ally.tag}` : ""}` : undefined}
                >
                  <span className="mdp-face"><ChampionAvatar champion={ally.champion} size={20} /></span>
                  <span className="mdp-side__name">{ally.champion}</span>
                  <span className="mdp-side__kda">{ally.kills}/{ally.deaths}/{ally.assists}</span>
                </span>
                <span
                  className="mdp-side mdp-side--enemy"
                  title={enemy.name ? `${enemy.name}${enemy.tag ? `#${enemy.tag}` : ""}` : undefined}
                >
                  <span className="mdp-side__kda">{enemy.kills}/{enemy.deaths}/{enemy.assists}</span>
                  <span className="mdp-side__name">{enemy.champion}</span>
                  <span className="mdp-face"><ChampionAvatar champion={enemy.champion} size={20} /></span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="mdp-empty">
            <span className="mdp-empty__icon"><Users size={16} aria-hidden /></span>
            <span className="mdp-empty__txt">
              {match.is_vod
                ? t("Imported videos have no Riot scoreboard")
                : t("The scoreboard of the 10 players appears after syncing with Riot")}
            </span>
            {!match.is_vod && (
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw size={14} aria-hidden />}
                loading={syncing}
                loadingLabel={t("Syncing…")}
                onClick={sincronizar}
              >
                {t("Sync now")}
              </Button>
            )}
            {syncError && (
              <span className="mdp-empty__err">{t("Couldn't sync with Riot: {msg}", { msg: syncError })}</span>
            )}
          </div>
        )}

        {/* Lo que queda por mirar, con lo que te costó. Clic: abre en ese
            instante. */}
        <div className="mdp-sec">
          <div className="mdp-sec__head">
            <span>{t(revisada || !hayPendientes ? "Key moments" : "Moments to review")}</span>
            <span>
              {revisada
                ? t("Game reviewed")
                : progress && progress.total > 0
                  ? t("{done} of {total} reviewed", { done: progress.done, total: progress.total })
                  : null}
            </span>
          </div>
          {lista.length === 0 ? (
            <p className="mdp-none-txt">{t("Nothing flagged in this game yet")}</p>
          ) : leyendo || esqueleto ? (
            <div className="mdp-list" aria-busy="true">
              {esqueleto &&
                lista.map(({ m }) => (
                  <span key={m.id} className="mdp-moment mdp-moment--skel" aria-hidden="true">
                    <Skeleton width={46} height={20} />
                    <Skeleton width="55%" />
                  </span>
                ))}
            </div>
          ) : (
            <div className="mdp-list">
              {lista.map(({ m, wpa }) => {
                const r = rating(m);
                return (
                  <button key={m.id} type="button" className="mdp-moment" onClick={() => onOpen(m.time)}>
                    <span className="t-time mdp-time">{clock(m.time)}</span>
                    <span className="mdp-moment__txt">{m.title}</span>
                    {/* El ΔWP si la jugada está en la timeline de Riot; si no,
                        la valoración del suceso. */}
                    {wpa != null ? (
                      <Chip tone={wpa < 0 ? "loss" : wpa > 0 ? "win" : "neutral"} title={t("Win probability")}>
                        {wpaText(wpa, lang)}
                      </Chip>
                    ) : (
                      <Chip tone={r.tone}>{t(r.text)}</Chip>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Una sola acción en oro; las otras dos, en pequeño debajo. */}
      <div className="mdp-actions">
        <Button
          variant="primary"
          className="mdp-cta"
          icon={<Play size={16} aria-hidden />}
          aria-keyshortcuts="Enter"
          onClick={() => onOpen()}
        >
          {t("Review game")}
          <kbd className="u-kbd mdp-cta__kbd">Enter</kbd>
        </Button>
        <div className="mdp-actions__row">
          <Button variant="ghost" size="sm" className="mdp-quiet" icon={<FolderOpen size={16} aria-hidden />} onClick={onReveal}>
            {t("Open folder")}
          </Button>
          <Button
            variant="danger"
            size="sm"
            className="mdp-del"
            icon={<Trash2 size={16} aria-hidden />}
            onClick={onDelete}
            aria-keyshortcuts="Delete"
          >
            {t("Delete")}
          </Button>
        </div>
      </div>
    </aside>
  );
};
