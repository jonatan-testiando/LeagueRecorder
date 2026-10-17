import { Map as MapIcon, Play } from "lucide-react";
import type { PressureWindow, PressureEvidence } from "../../../core/tauri-ipc";
import { useT } from "../../../core/LanguageProvider";
import { clock } from "../../../core/time";
import { champLabel } from "../../../core/matchEvents";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { formatGold, formatSeconds, joinList } from "./pressureFormat";
import { EpisodeStrip } from "./EpisodeStrip";
import type { MapFocus, MapMark, OpenMap } from "../mapFocus";
import "./PressureEpisodeCard.css";

/**
 * Un episodio de presión absorbida («hedge»): vinieron a por ti, ¿cuánto
 * tiempo les hiciste perder y cuánto oro valió?
 *
 * Primero se CUENTA: quién vino, cuánto rato, qué sacó tu equipo lejos y cómo
 * saliste. La versión anterior abría con el libro de cuentas (neto, veredicto,
 * cinco filas de desglose y la lista de eventos) y había que reconstruir la
 * jugada a partir de las cifras. Las cifras siguen, plegadas, para quien
 * quiera comprobar la cuenta; el neto y el veredicto quedan en pequeño.
 *
 * Con `matchId` lleva la franja segundo a segundo (vida y rivales encima), y
 * con `onOpenMap` el botón de verlo en el Mapa. Hoy y Patrones no pasan
 * ninguna de las dos y la tarjeta sigue funcionando como antes.
 *
 * El cálculo vive en `src-tauri/src/pressure_value.rs`.
 */
const VERDICTS = {
  good: "Good trade",
  even: "Even trade",
  bad: "Costly trade",
} as const;

const KINDS: Record<PressureEvidence["kind"], string> = {
  kill: "Kill",
  death: "Your death",
  tower: "Tower",
  inhibitor: "Inhibitor",
  plate: "Plate",
  epic: "Epic monster",
};

/** Lo que tu equipo puede sacar lejos, en el orden en que pesa: una torre se
 *  nombra antes que una kill aunque haya más kills. */
const FAR: [PressureEvidence["kind"], string, string][] = [
  ["inhibitor", "an inhibitor", "{n} inhibitors"],
  ["tower", "a tower", "{n} towers"],
  ["epic", "an epic monster", "{n} epic monsters"],
  ["plate", "a plate", "{n} plates"],
  ["kill", "a kill", "{n} kills"],
];

type T = (key: string, vars?: Record<string, string | number>) => string;

const LANES: Record<string, string> = { top: "Top lane", mid: "Mid lane", bot: "Bot lane" };

/**
 * La frase del episodio, hecha sólo con lo que trae: rivales atados, la
 * duración, lo que tu equipo sacó lejos (`gains` no locales) y el resultado en
 * el sitio (`gains` locales, `losses`). Sin `ties` (cachés viejas) se dice
 * cuántos eran, no quiénes.
 */
export function episodeStory(w: PressureWindow, from: number, to: number, t: T): string {
  const dur = formatSeconds(Math.max(0, to - from));
  const ties = w.ties ?? [];
  const who = ties.length > 0
    ? joinList(ties.map((x) => champLabel(x.champion)), t)
    : t("{n} enemies", { n: Math.max(2, Math.round(w.enemy_count || w.max_enemies || 2)) });

  const gains = w.gains ?? [];
  const losses = w.losses ?? [];
  const far = gains.filter((e) => !e.local);
  const what = FAR.flatMap(([kind, one, many]) => {
    const n = far.filter((e) => e.kind === kind).length;
    return n === 0 ? [] : [n === 1 ? t(one) : t(many, { n })];
  });
  const first = what.length > 0
    ? t("You had {who} on you for {time}; meanwhile your team took {what} elsewhere.", { who, time: dur, what: joinList(what, t) })
    : t("You had {who} on you for {time}, and your team took nothing elsewhere.", { who, time: dur });

  // La pelea en el sitio: kills de tu equipo contra muertes de tu equipo, la
  // tuya incluida. Un "2–1" sin decir para quién no se lee.
  const died = w.died || losses.some((e) => e.kind === "death");
  const k = gains.filter((e) => e.local && e.kind === "kill").length;
  const d = losses.filter((e) => e.kind === "kill").length + (died ? 1 : 0);
  const fight = k > 0 || d > (died ? 1 : 0);
  const second = died
    ? (fight ? t("You died; the fight there went {k}–{d} for your team.", { k, d }) : t("You died."))
    : (fight ? t("You got out alive; the fight there went {k}–{d} for your team.", { k, d }) : t("You got out alive."));
  return `${first} ${second}`;
}

/** El Mapa abierto en el episodio, con lo que pasó dibujado donde pasó. Sólo
 *  los sucesos con posición: las cachés anteriores no la traen y entonces el
 *  mapa enseña el aro y tu rastro, sin marcas. */
export function episodeMapFocus(w: PressureWindow, from: number, to: number, t: T, detail: string): MapFocus {
  const marks: MapMark[] = [];
  const add = (e: PressureEvidence, kind: MapMark["kind"], tone: "good" | "bad", gold: number) => {
    if (e.x == null || e.y == null) return;
    marks.push({ x: e.x, y: e.y, kind, tone, label: formatGold(gold, true), t: e.game_time });
  };
  for (const e of w.gains ?? []) add(e, e.kind, "good", e.gold);
  for (const e of w.losses ?? []) {
    add(e, e.kind === "death" ? "death" : e.kind === "kill" ? "ally_death" : e.kind, "bad", -e.gold);
  }
  const verdict = w.value?.verdict;
  return {
    kind: "pressure",
    t: from,
    until: to,
    lead: 3,
    // El radio con el que se mide "encima" (ver ventanas-de-presion): el aro
    // del mapa es la misma regla que la cuenta.
    ring: 1200,
    episode: { from, to },
    title: t("Pressure · {time}", { time: clock(from) }),
    detail,
    tone: verdict === "good" ? "good" : verdict === "bad" ? "bad" : "neutral",
    marks,
  };
}

export function PressureEpisodeCard({
  window: w, gameStart, gameEnd, onSeek, label, matchId, onOpenMap, onSeekGame,
}: {
  window: PressureWindow;
  gameStart: number;
  gameEnd: number;
  /** Saltar en el vídeo (segundos de VÍDEO). */
  onSeek?: (time: number) => void;
  label?: string;
  /** Con él, la franja segundo a segundo. */
  matchId?: string;
  /** Con él, el botón «Ver en el mapa». */
  onOpenMap?: OpenMap;
  /** Saltar a un instante de PARTIDA (clic en la franja). Sin él se usa
   *  `onSeek`, con el desfase vídeo↔partida del propio episodio. */
  onSeekGame?: (gameSeconds: number) => void;
}) {
  const t = useT();
  const v = w.value;
  const verdict = v?.verdict ?? "even";
  const ties = w.ties ?? [];
  const story = episodeStory(w, gameStart, gameEnd, t);
  const seekGame = onSeekGame ?? (onSeek ? (g: number) => onSeek(g + (w.start - gameStart)) : undefined);

  const evidence = (events: PressureEvidence[], sign: 1 | -1, tone: string) =>
    events.map((e) => {
      // Una kill "perdida" en el sitio es la muerte de un aliado.
      const kind = sign < 0 && e.kind === "kill" ? t("Ally death") : t(KINDS[e.kind] ?? e.kind);
      return (
        <li key={`${sign}:${e.id}`}>
          <button type="button" className="pe-ev" onClick={() => onSeek?.(e.time)} disabled={!onSeek}>
            <span className="u-time">{clock(e.game_time)}</span>
            <span className="pe-ev__what">
              {kind}
              {e.after_episode && <span className="pe-ev__after"> · {t("right after")}</span>}
            </span>
            <span className={`pe-ev__gold ${tone}`}>{formatGold(sign * e.gold, true)}</span>
          </button>
        </li>
      );
    });

  const localGains = (w.gains ?? []).filter((e) => e.local);
  const farGains = (w.gains ?? []).filter((e) => !e.local);
  const losses = w.losses ?? [];
  const context = w.context ?? [];

  return (
    <article className={`pe pe--${verdict}`}>
      <header className="pe__head">
        <div className="pe__when">
          {label && <span className="pe__label">{label}</span>}
          <span className="u-time">{clock(gameStart)}</span>
          <span> · {formatSeconds(Math.max(0, gameEnd - gameStart))}</span>
          {w.lane && LANES[w.lane] && <span> · {t(LANES[w.lane])}</span>}
          {!w.from_video && (
            <span className="pe__est" title={t("Estimated from Riot's data (one position per minute). Process the video to measure it.")}>
              {" · "}{t("estimated")}
            </span>
          )}
        </div>
        {v && (
          <span className={`pe__verdict pe__verdict--${verdict}`}>
            {t(VERDICTS[verdict])} · {t("{n} gold", { n: formatGold(v.net, true) })}
          </span>
        )}
      </header>

      <div className="pe__story">
        {ties.length > 0 && (
          <div className="pe__faces" aria-hidden="true">
            {ties.slice(0, 5).map((tie) => (
              <ChampionAvatar key={`${tie.participant_id}:${tie.champion}`} champion={tie.champion} size={24} ring="var(--panel)" />
            ))}
          </div>
        )}
        <p>{story}</p>
      </div>

      {matchId && <EpisodeStrip matchId={matchId} from={gameStart} to={gameEnd} onSeekGame={seekGame} />}

      {(onOpenMap || onSeek) && (
        <div className="pe__actions">
          {onOpenMap && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => onOpenMap(episodeMapFocus(w, gameStart, gameEnd, t, story))}
            >
              <MapIcon size={13} /> {t("See on the map")}
            </button>
          )}
          {onSeek && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onSeek(w.start)}>
              <Play size={13} /> {t("Watch episode")}
            </button>
          )}
        </div>
      )}

      {/* La cuenta, para comprobarla. Mismas filas que antes de rehacer la
          tarjeta: el neto de arriba es su suma. */}
      <details className="pe__details">
        <summary>{t("How the gold adds up")}</summary>
        <div className="pe__detailsBody">
          {ties.length > 0 && (
            <p className="pe__note">
              {t("You tied up {n} enemies · {time} of enemy time", {
                n: ties.length,
                // El total es la suma de lo que se enseña al lado, ya redondeado:
                // con el valor exacto salía "2 s + 2 s = 3 s".
                time: formatSeconds(ties.reduce((a, b) => a + Math.round(b.seconds), 0)),
              })}
              <span className="pe__tie-list">
                {ties.map((tie) => `${champLabel(tie.champion)} ${formatSeconds(tie.seconds)}`).join(" · ")}
              </span>
            </p>
          )}

          {v ? (
            <dl className="pe__rows">
              <div>
                <dt>{t("Farm you denied them")}</dt>
                <dd className="pos">{formatGold(v.farm_denied, true)}</dd>
              </div>
              <div>
                <dt>{t("Your team, elsewhere")}</dt>
                <dd className={v.team_elsewhere > 0 ? "pos" : ""}>{formatGold(v.team_elsewhere, true)}</dd>
              </div>
              <div>
                <dt>{t("The fight where you were")}</dt>
                <dd className={v.local_gold > 0 ? "pos" : v.local_gold < 0 ? "neg" : ""}>{formatGold(v.local_gold, true)}</dd>
              </div>
              <div>
                <dt
                  title={v.camps_waiting != null
                    ? t("You had camps waiting for {p}% of this stretch: only that time counts as lost farm.", { p: Math.round(v.camps_waiting * 100) })
                    : undefined}
                >
                  {t("Your own farm meanwhile")}
                  {v.camps_waiting != null && (
                    <span className="pe__aside"> · {t("camps waiting {p}%", { p: Math.round(v.camps_waiting * 100) })}</span>
                  )}
                </dt>
                <dd className="neg">{formatGold(-v.own_farm_lost, true)}</dd>
              </div>
              {v.death_farm_lost > 0 && (
                <div>
                  <dt>{t("Farm lost while dead")}</dt>
                  <dd className="neg">{formatGold(-v.death_farm_lost, true)}</dd>
                </div>
              )}
              <div className="pe__total">
                <dt>{t("Net")}</dt>
                <dd>{formatGold(v.net, true)}</dd>
              </div>
            </dl>
          ) : (
            <p className="pe__note">{t("Recalculating this episode…")}</p>
          )}

          {v && v.enemy_elsewhere > 0 && (
            <p className="pe__note">
              {t("Meanwhile the enemy took {gold} elsewhere. It doesn't count against you: with the numbers on your side, that belongs to whoever was there.", {
                gold: formatGold(v.enemy_elsewhere),
              })}
            </p>
          )}

          {farGains.length > 0 && <><h4>{t("Your team, elsewhere")}</h4><ul>{evidence(farGains, 1, "pos")}</ul></>}
          {(localGains.length + losses.length) > 0 && (
            <>
              <h4>{t("The fight where you were")}</h4>
              <ul>{evidence(localGains, 1, "pos")}{evidence(losses, -1, "neg")}</ul>
            </>
          )}
          {context.length > 0 && <><h4>{t("Enemy, elsewhere (not counted)")}</h4><ul>{evidence(context, 1, "")}</ul></>}

          <p className="pe__source">
            {t(w.from_video
              ? "Measured on the minimap video, second by second."
              : "Estimated from Riot's data (one position per minute). Process the video to measure it.")}
            {" "}
            {t("A floor, not a ceiling: enemy travel time and XP aren't counted.")}
          </p>
        </div>
      </details>
    </article>
  );
}
