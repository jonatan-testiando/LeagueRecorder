import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Ban, Flag, Info, Play, Skull, Swords } from "lucide-react";
import { useLang } from "../../../core/LanguageProvider";
import { setChampSelectRole, useChampSelect } from "../../../core/useChampSelect";
import { useCoachPlan } from "../../../core/useCoachPlan";
import { useCoachSummary } from "../../../core/useCoachSummary";
import { useAppStore } from "../../../store/useAppStore";
import { Button } from "../../../components/ui/Button";
import { Chip, type ChipTone } from "../../../components/ui/Chip";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Segmented } from "../../../components/ui/Segmented";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { PositionIcon, POSITION_LABEL } from "../../../components/PositionIcon";
import { withPercent } from "../../../core/benchmarkFormat";
import { coachPlayLabel, focusTitle, focusWhy, planCounted, planTitle, wpPoints } from "../../../core/coach";
import { champLabel } from "../../../core/matchEvents";
import { fmtDec, wpaText } from "../../gallery/components/libraryShared";
import {
  LANE_ORDER,
  type ChampSelectEnemy,
  type ChampSelectRecord,
  type ChampSelectView,
  type CoachPlay,
  type LanePosition,
} from "../../../core/tauri-ipc";
import { ScreenTitle } from "../../../components/ScreenTitle";
import "./ChampSelectPanel.css";

/**
 * La selección de campeón (§4 de `docs/coach-de-macro-diseno.md`), en la
 * ventana de la app y nunca en el juego. Se abre sola al entrar en la
 * selección del cliente (`ChampSelectFlow`).
 *
 *  1. Tu rival de carril: los cinco rivales con el puesto que se les supone
 *     (el cliente no lo da en clasificatoria) y, contra el tuyo, tu historial:
 *     victorias, WPA medio, muertes y las tres jugadas que más te costaron,
 *     con su clip. Se puede tocar otro rival para ver el tuyo contra él.
 *  2. Tu plan de 10 partidas (o tu foco, sin plan): lo que hoy hay que tener
 *     en la cabeza.
 *  3. Sugerencia de baneo: los rivales de carril contra los que más pierdes.
 *  4. Tu pool para el rol, en tiers con los cortes de iTero sobre tu WR
 *     ajustado por la muestra.
 *
 * Solo campeones: de la selección no se lee quién es nadie.
 */

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const PHASE: Record<string, string> = {
  PLANNING: "Planning",
  BAN_PICK: "Bans and picks",
  FINALIZATION: "Last seconds",
};

/** S+ y S en victoria, A+ y A neutras, B y C en contorno, D e INT en derrota. */
function tierTone(tier: string): ChipTone {
  if (tier === "S+" || tier === "S") return "win";
  if (tier === "A+" || tier === "A") return "neutral";
  if (tier === "B" || tier === "C") return "outline";
  return "loss";
}

const pct = (x: number) => withPercent(Math.round(x * 100));

const laneName = (l: LanePosition | null | undefined, t: Translate) => (l ? t(POSITION_LABEL[l]) : "");

/** "17 oct" / "Oct 17". */
function shortDate(iso: string, lang: string): string {
  const d = new Date(iso.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return iso.split(" ")[0] ?? "";
  return new Intl.DateTimeFormat(lang === "es" ? "es-ES" : "en-US", { day: "numeric", month: "short" }).format(d);
}

/* ============================================================ panel */

export const ChampSelectPanel: React.FC = () => {
  const { t } = useLang();
  const { view, last, session } = useChampSelect();
  const v = view ?? last;

  if (!v) {
    return (
      <div className="cs-panel">
        <div className="cs-page cs-page--empty">
          <ScreenTitle align="content" title={t("Champion select")} />
          <EmptyState
            icon={<Swords size={28} aria-hidden="true" />}
            title={t("Champion select")}
            text={t(
              "When you enter champion select in the League client, this shows your record against your lane opponent, your pool for the role and your plan. Nothing here shows in the game."
            )}
          />
        </div>
      </div>
    );
  }
  return <Vista key={session} v={v} ended={view === null} />;
};

const Vista: React.FC<{ v: ChampSelectView; ended: boolean }> = ({ v, ended }) => {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const startPlaylist = useAppStore((s) => s.startPlaylist);
  const playlistGo = useAppStore((s) => s.playlistGo);

  // El rival que se mira: el de carril, salvo que se toque otro.
  const [picked, setPicked] = useState<number | null>(null);
  useEffect(() => {
    if (picked != null && !v.enemies[picked]?.champion) setPicked(null);
  }, [v.enemies, picked]);
  const idx = picked ?? v.rival;
  const enemy = idx != null ? v.enemies[idx] ?? null : null;

  const watch = (title: string, plays: CoachPlay[], from: number) => {
    const items = plays
      .filter((p) => p.video_time != null)
      .map((p) => ({ matchId: p.match_id, time: p.video_time as number, label: coachPlayLabel(p, t, lang) }));
    if (items.length === 0) return;
    startPlaylist(title, items);
    const i = items.findIndex((x) => x.matchId === plays[from]?.match_id && x.time === plays[from]?.video_time);
    if (i > 0) playlistGo(i);
    navigate("/review");
  };

  const phase = v.phase ? PHASE[v.phase] : null;

  return (
    <div className="cs-panel">
      <div className="cs-page">
        {/* Título y fase en la barra de título (piel A); aquí, el puesto. */}
        <ScreenTitle align="content" title={t("Champion select")}>
          {ended ? (
            <Chip tone="outline">{t("Champion select is over")}</Chip>
          ) : (
            phase && <Chip tone="gold" dot>{t(phase)}</Chip>
          )}
        </ScreenTitle>
        {v.rift && (
          <header className="cs-head">
            <RoleSwitch v={v} />
          </header>
        )}

        {!v.rift ? (
          <section className="cs-card cs-quiet">
            <p className="t-body cs-muted">
              {t("There are no lanes in this queue: your record and your pool are from Summoner's Rift.")}
            </p>
          </section>
        ) : (
          // Lo que se mira con el reloj corriendo, arriba y a la izquierda;
          // el pool, a la derecha, para cuando toca elegir.
          <div className="cs-grid">
            <div className="cs-col">
              <RivalHero v={v} enemy={enemy} idx={idx} onPick={setPicked} onWatch={watch} />
              <BanCard v={v} />
            </div>
            <aside className="cs-col cs-col--side">
              <PlanCard />
              <PoolCard v={v} />
              <p className="t-small cs-faint cs-privacy">
                <Info size={14} aria-hidden="true" />
                {t("Only champions are read from champion select, never who is playing them. Nothing here shows in the game.")}
              </p>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------ rol */

const RoleSwitch: React.FC<{ v: ChampSelectView }> = ({ v }) => {
  const { t } = useLang();
  const note =
    v.role_source === "assigned"
      ? t("your position, from the client")
      : v.role_source === "usual"
        ? t("the client doesn't say your position: this is the one you play most")
        : v.role_source === "chosen"
          ? t("chosen here")
          : t("pick your position");
  return (
    <div className="cs-role">
      <Segmented<LanePosition>
        size="sm"
        label={t("Your position")}
        value={v.role}
        onChange={(r) => setChampSelectRole(r)}
        options={LANE_ORDER.map((p) => ({
          value: p,
          label: <span className="cs-sr">{t(POSITION_LABEL[p])}</span>,
          icon: <PositionIcon position={p} size={16} />,
          title: t(POSITION_LABEL[p]),
        }))}
      />
      <span className="t-small cs-faint">{note}</span>
      {v.role_source === "chosen" && (
        <Button variant="ghost" size="sm" onClick={() => setChampSelectRole(null)}>
          {t("Undo")}
        </Button>
      )}
    </div>
  );
};

/* ------------------------------------------------------------ el rival */

const RivalHero: React.FC<{
  v: ChampSelectView;
  enemy: ChampSelectEnemy | null;
  idx: number | null;
  onPick: (i: number | null) => void;
  onWatch: (title: string, plays: CoachPlay[], from: number) => void;
}> = ({ v, enemy, idx, onPick, onWatch }) => {
  const { t, lang } = useLang();
  const isRival = idx != null && idx === v.rival;
  const role = laneName(v.role, t);

  // Arriba, quién es (o por qué aún no se sabe) junto a los cinco rivales;
  // debajo, tu historial contra él.
  const [top, rest] = ((): [React.ReactNode, React.ReactNode] => {
    if (!enemy?.champion) {
      const fijados = v.enemies.filter((e) => e.champion).length;
      return [
        <div className="cs-rival__wait">
          <span className="t-section cs-strong">{t("Your lane opponent isn't known yet")}</span>
          <p className="t-body cs-muted">
            {v.enemies.length === 0
              ? t("There's no enemy team in this champion select.")
              : fijados === 0
                ? t("It shows up when they lock in their champion. In blind pick that only happens on the loading screen.")
                : v.role
                  ? t("None of the enemies who have locked in plays {role} often enough yet.", { role })
                  : t("Pick your position to know who your opponent is.")}
          </p>
        </div>,
        null,
      ];
    }
    const champ = enemy.champion;
    const name = champLabel(champ);
    const rec = enemy.as_rival;
    const enemyRec = enemy.as_enemy;
    // Sin partidas contra él en tu carril, las de su equipo en otro puesto.
    const shown: ChampSelectRecord | null = rec && rec.games > 0 ? rec : enemyRec && enemyRec.games > 0 ? enemyRec : null;
    const scope = shown === rec ? "rival" : "enemy";
    const title = t("Against {champion}", { champion: name });
    return [
        <div className="cs-rival__who">
          <ChampionAvatar champion={champ} size={64} ring={isRival ? "var(--brand)" : undefined} />
          <div className="cs-rival__name">
            <span className="t-label cs-faint">
              {isRival ? t("Your lane opponent") : t("Enemy you picked")}
            </span>
            <h2 className="t-section cs-strong">{title}</h2>
            <span className="t-small cs-muted">
              {isRival && v.rival_probability != null
                ? v.rival_probability >= 0.9
                  ? t("{role} · from the champions they locked in", { role })
                  : t("Probably {role} ({p})", { role, p: pct(v.rival_probability) })
                : enemy.likely
                  ? t("Probably {role} ({p})", { role: laneName(enemy.likely, t), p: pct(Math.max(...enemy.lanes)) })
                  : t("Position unclear")}
            </span>
          </div>
        </div>,
        shown ? (
          <>
            <p className="t-small cs-muted cs-rival__scope">
              {scope === "rival"
                ? t("Your games with {champion} as your lane opponent, playing {role}", { champion: name, role })
                : t("Never your lane opponent; these are your games with {champion} on the enemy team, playing {role}", { champion: name, role })}
            </p>
            <dl className="cs-nums">
              <div className="cs-num">
                <dt className="t-label cs-faint">{t("Record")}</dt>
                <dd className={`t-metric ${2 * shown.wins >= shown.games ? "cs-win" : "cs-loss"}`}>
                  {t("{w}W {l}L", { w: shown.wins, l: shown.games - shown.wins })}
                </dd>
              </div>
              <div className="cs-num">
                <dt className="t-label cs-faint">{t("Average WPA")}</dt>
                <dd className={`t-metric ${shown.wpa == null ? "cs-faint" : shown.wpa >= 0 ? "cs-win" : "cs-loss"}`}>
                  {shown.wpa == null ? "—" : wpaText(shown.wpa, lang)}
                </dd>
              </div>
              <div className="cs-num">
                <dt className="t-label cs-faint">{t("Deaths per game")}</dt>
                <dd className="t-metric cs-strong">{fmtDec(shown.deaths, 1, lang)}</dd>
              </div>
            </dl>
            {shown.games < 3 && (
              <p className="t-small cs-faint">
                {shown.games === 1 ? t("Just 1 game: a reminder, not a pattern.") : t("Just {n} games: a reminder, not a pattern.", { n: shown.games })}
              </p>
            )}
            <Plays plays={shown.plays} title={title} onWatch={onWatch} />
          </>
        ) : (
          <p className="t-body cs-muted">
            {v.games === 0
              ? t("Without games synced with Riot there's no record to show yet.")
              : t("You haven't faced {champion} playing {role} in your recorded games.", { champion: name, role })}
          </p>
        ),
    ];
  })();

  return (
    <section className="surface-hero cs-hero" aria-labelledby="cs-rival-title">
      <h2 id="cs-rival-title" className="cs-sr">
        {t("Your lane opponent")}
      </h2>
      <div className="cs-hero__top">
        {top}
        {v.enemies.length > 0 && <EnemyStrip v={v} idx={idx} onPick={onPick} />}
      </div>
      {rest && <div className="cs-rival">{rest}</div>}
    </section>
  );
};

/** Los rivales, con el puesto que se les supone. Los que ya fijaron se tocan
 *  para ver tu historial contra ellos. */
const EnemyStrip: React.FC<{ v: ChampSelectView; idx: number | null; onPick: (i: number | null) => void }> = ({
  v,
  idx,
  onPick,
}) => {
  const { t } = useLang();
  return (
    <div className="cs-enemies">
      <span className="t-label cs-faint">{t("Enemy team")}</span>
      <ol className="cs-enemies__row" aria-label={t("Enemy team")}>
        {v.enemies.map((e, i) => {
          const best = Math.max(...e.lanes);
          const lane = LANE_ORDER[e.lanes.indexOf(best)];
          const label = e.champion
            ? e.likely
              ? t("{champion} · probably {role} ({p})", { champion: champLabel(e.champion), role: laneName(e.likely, t), p: pct(best) })
              : t("{champion} · position unclear", { champion: champLabel(e.champion) })
            : t("Not locked in yet");
          const sel = i === idx;
          const content = (
            <>
              {e.champion ? (
                <ChampionAvatar champion={e.champion} size={40} ring={i === v.rival ? "var(--brand)" : undefined} />
              ) : (
                <span className="cs-enemy__empty" aria-hidden="true">?</span>
              )}
              <span className="cs-enemy__lane t-small">
                {e.champion && e.likely ? (
                  <>
                    <PositionIcon position={lane} size={14} />
                    {pct(best)}
                  </>
                ) : (
                  <span className="cs-faint">—</span>
                )}
              </span>
            </>
          );
          return (
            <li key={i}>
              {e.champion ? (
                <button
                  type="button"
                  className={`cs-enemy${sel ? " cs-enemy--sel" : ""}`}
                  aria-pressed={sel}
                  aria-label={label}
                  title={label}
                  onClick={() => onPick(i === v.rival ? null : i)}
                >
                  {content}
                </button>
              ) : (
                <span className="cs-enemy cs-enemy--empty" title={label} aria-label={label}>
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
};

const Plays: React.FC<{
  plays: CoachPlay[];
  title: string;
  onWatch: (title: string, plays: CoachPlay[], from: number) => void;
}> = ({ plays, title, onWatch }) => {
  const { t, lang } = useLang();
  if (plays.length === 0) {
    return <p className="t-small cs-faint">{t("No play cost you win chance in those games.")}</p>;
  }
  const withVideo = plays.filter((p) => p.video_time != null).length;
  return (
    <div className="cs-plays">
      <div className="cs-plays__head">
        <span className="t-label cs-faint">
          {plays.length === 1 ? t("The play that cost you most") : t("The {n} plays that cost you most", { n: plays.length })}
        </span>
        {withVideo > 1 && (
          <Button variant="primary" size="sm" icon={<Play size={14} />} onClick={() => onWatch(title, plays, 0)}>
            {t("Watch all {n}", { n: withVideo })}
          </Button>
        )}
      </div>
      <ol className="cs-plays__list">
        {plays.map((p, i) => {
          const Icon = p.kind === "objective" ? Flag : Skull;
          const min = Math.floor(p.time / 60);
          return (
            <li key={`${p.match_id}-${p.time}`} className="cs-play">
              <Icon size={16} className="cs-play__icon" aria-hidden="true" />
              <span className="cs-play__text">
                <span className="t-body cs-strong">{coachPlayLabel(p, t, lang)}</span>
                <span className="t-small cs-faint">
                  {t("{champion} · {date} · minute {m}", { champion: champLabel(p.champion), date: shortDate(p.date, lang), m: min })}
                </span>
              </span>
              {p.video_time != null ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Play size={14} />}
                  aria-label={t("Watch the clip")}
                  onClick={() => onWatch(title, plays, i)}
                >
                  {t("Clip")}
                </Button>
              ) : (
                <span className="t-small cs-faint" title={t("This game no longer has its video.")}>
                  {t("No video")}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
};

/* ------------------------------------------------------------ plan */

const PlanCard: React.FC = () => {
  const { t, lang } = useLang();
  const { plan } = useCoachPlan();
  const summary = useCoachSummary();
  const navigate = useNavigate();
  const active = plan?.active ?? null;
  const focus = summary?.focus ?? null;
  if (!active && !focus) return null;

  if (active) {
    const k = planCounted(active);
    const parts = [t("{k} of {n}", { k, n: active.target })];
    if (active.after_cost != null) parts.push(t("plan average −{p}%", { p: wpPoints(active.after_cost, lang) }));
    return (
      <section className="cs-card cs-plan" aria-labelledby="cs-plan-title">
        <div className="cs-card__head">
          <span className="t-label cs-faint">{t("Your {n}-game plan", { n: active.target })}</span>
          <Chip tone="gold">{parts[0]}</Chip>
        </div>
        <h3 id="cs-plan-title" className="t-card cs-strong">{planTitle(active, t)}</h3>
        <p className="t-small cs-muted">
          {active.after_cost != null
            ? t("Keep it in mind this game. So far: {line}.", { line: parts.slice(1).join(" · ") })
            : t("Keep it in mind this game: it's the first of the plan.")}
        </p>
        <Button variant="ghost" size="sm" className="cs-plan__link" onClick={() => navigate("/coach")}>
          {t("See the plan")}
        </Button>
      </section>
    );
  }
  return (
    <section className="cs-card cs-plan" aria-labelledby="cs-plan-title">
      <span className="t-label cs-faint">{t("Your focus")}</span>
      <h3 id="cs-plan-title" className="t-card cs-strong">{focusTitle(focus!, t)}</h3>
      {summary && <p className="t-small cs-muted">{focusWhy(focus!, summary, t, lang)}</p>}
    </section>
  );
};

/* ------------------------------------------------------------ baneo */

const BanCard: React.FC<{ v: ChampSelectView }> = ({ v }) => {
  const { t } = useLang();
  const role = laneName(v.role, t);
  return (
    <section className="cs-card" aria-labelledby="cs-ban-title">
      <div className="cs-card__head">
        <h3 id="cs-ban-title" className="t-card cs-strong cs-iconed">
          <Ban size={16} aria-hidden="true" />
          {t("Ban suggestion")}
        </h3>
      </div>
      {v.ban_ideas.length === 0 ? (
        <p className="t-small cs-faint">
          {role
            ? t("No lane opponent beats you often enough playing {role} (2 games or more, more losses than wins).", { role })
            : t("Pick your position to see who beats you.")}
        </p>
      ) : (
        <>
          <ol className="cs-list">
            {v.ban_ideas.map((b) => (
              <li key={b.champion} className="cs-list__row">
                <ChampionAvatar champion={b.champion} size={28} />
                <span className="t-body cs-strong cs-list__name">{champLabel(b.champion)}</span>
                <span className="t-small cs-loss">{t("{w}W {l}L", { w: b.games - b.losses, l: b.losses })}</span>
              </li>
            ))}
          </ol>
          <p className="t-small cs-faint">{t("The lane opponents you lose to most playing {role}.", { role })}</p>
        </>
      )}
    </section>
  );
};

/* ------------------------------------------------------------ pool */

const PoolCard: React.FC<{ v: ChampSelectView }> = ({ v }) => {
  const { t, lang } = useLang();
  const role = laneName(v.role, t);
  const { pool } = v;
  const mine = v.my_champion;
  const rows = pool.rows;
  return (
    <section className="cs-card" aria-labelledby="cs-pool-title">
      <div className="cs-card__head">
        <h3 id="cs-pool-title" className="t-card cs-strong">
          {role ? t("Your pool playing {role}", { role }) : t("Your pool")}
        </h3>
        <span className="t-small cs-faint">
          {t("{n} games · your win rate {p}", { n: pool.games, p: pool.games ? pct(pool.mean) : "—" })}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="t-small cs-faint">
          {pool.games === 0
            ? t("No recorded games in this position yet.")
            : t("No champion has 3 games in this position yet.")}
        </p>
      ) : (
        <table className="cs-pool">
          <thead>
            <tr className="t-label cs-faint">
              <th scope="col">{t("Tier")}</th>
              <th scope="col">{t("Champion")}</th>
              <th scope="col" className="cs-num-col">{t("Win rate")}</th>
              <th scope="col" className="cs-num-col">{t("WPA")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.champion}
                className={r.champion === mine ? "cs-pool__mine" : undefined}
                title={r.champion === mine ? (v.my_locked ? t("locked in") : t("in your hand")) : undefined}
              >
                <td>
                  <Chip
                    tone={tierTone(r.tier)}
                    title={t("Win rate adjusted for the sample: {p}", { p: pct(r.adjusted) })}
                  >
                    {r.tier}
                  </Chip>
                </td>
                <td>
                  <span className="cs-pool__champ">
                    <ChampionAvatar champion={r.champion} size={24} />
                    <span className="cs-pool__name">
                      <span className="t-body cs-strong">{champLabel(r.champion)}</span>
                      <span className="t-small cs-faint cs-pool__sub">
                        {r.champion === mine && (
                          <span className="cs-sr">{v.my_locked ? t("locked in") : t("in your hand")} · </span>
                        )}
                        {t("{w}W {l}L", { w: r.wins, l: r.games - r.wins })}
                        {r.short && (
                          <span title={t("Under 15 games: a lead, not a verdict.")}> · {t("short sample")}</span>
                        )}
                      </span>
                    </span>
                  </span>
                </td>
                <td className={`cs-num-col t-body ${r.wr >= 0.5 ? "cs-win" : "cs-loss"}`}>{pct(r.wr)}</td>
                <td className={`cs-num-col t-body ${r.wpa == null ? "cs-faint" : r.wpa >= 0 ? "cs-win" : "cs-loss"}`}>
                  {r.wpa == null ? "—" : wpaText(r.wpa, lang)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p
        className="t-small cs-faint cs-pool__note"
        title={t("Tiers use iTero's cuts (S+ from 54%, S 52%, A+ 51%, A 50%, B 49%, C 48%, D 47%) on your win rate adjusted for the sample: with few games it stays close to your average, because 10 games can't tell one champion from another.")}
      >
        {t("Tier: iTero's cuts (S+ from 54%) on your win rate adjusted for the sample. With few games it stays close to your average.")}
        {pool.hidden > 0 &&
          ` ${pool.hidden === 1 ? t("1 champion with fewer than 3 games isn't listed.") : t("{n} champions with fewer than 3 games aren't listed.", { n: pool.hidden })}`}
      </p>
    </section>
  );
};
