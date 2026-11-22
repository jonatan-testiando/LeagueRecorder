import React, { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ChevronRight, ScanLine } from "lucide-react";
import { PanelActiveContext, ScreenTitle } from "../../../components/ScreenTitle";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { EmptyState } from "../../../components/ui/EmptyState";
import { SkeletonLines } from "../../../components/ui/Skeleton";
import { useT } from "../../../core/LanguageProvider";
import { useNavigate } from "../../../core/navegar";
import { matchAge, mmss } from "../../../core/time";
import { champLabel } from "../../../core/matchEvents";
import { outcome as resultado } from "../../../core/matchStats";
import { formatDecimal, withPercent } from "../../../core/benchmarkFormat";
import { useDelayedLoading } from "../../../core/useDelayedLoading";
import {
  getClickCareer,
  readMatchHud,
  type ClickCareer,
  type ClickGame,
  type ClickStats,
  type DopaStats,
} from "../../../core/tauri-ipc";
import { useAppStore, useMatches } from "../../../store/useAppStore";
import { HelpDot } from "../../player/components/HelpDot";
import "../../player/components/MatchTab.css";
import "../../player/components/ClicksSection.css";
import "./ClicksPanel.css";

/**
 * Tus clics: tu mano partida a partida, y frente a la regla de 45° de DOPA.
 *
 * Lo de UNA partida (el mapa de calor, los tramos, el ritmo) sigue en la hoja
 * de estadísticas del reproductor, porque lleva al vídeo de esa partida; cada
 * fila de aquí abre la partida en ese bloque. Esta pantalla es lo que no cabe
 * en una sola: cómo te va a lo largo de las partidas y la comparación con DOPA
 * Tools (maurogarih.com/herramientas/dopa), que necesita saber dónde estaba tu
 * campeón en el vídeo (`clics.rs`, «DOPA, 45°»).
 */

type T = ReturnType<typeof useT>;

/** Un clic al azar cae en las cuatro franjas de ±18° el 40 % de las veces. */
const AZAR = 0.4;
/** Partidas que dibuja cada minigráfica. */
const PUNTOS = 20;

const pct = (n: number, de: number) => (de > 0 ? n / de : 0);

interface Cifra {
  key: string;
  label: string;
  help: string;
  valor: (s: ClickStats) => number | null;
  mediana: number | null | undefined;
  fmt: (v: number) => string;
  /** Qué dirección es buena: null = ninguna (estilo, no nivel). */
  mejor: "up" | "down" | null;
}

/** Minigráfica de la cifra en tus últimas partidas, de la más vieja a la más nueva. */
const Linea: React.FC<{ valores: number[]; mejor: Cifra["mejor"] }> = ({ valores, mejor }) => {
  if (valores.length < 2) return <span className="ck-spark ck-spark--vacia" aria-hidden="true" />;
  const w = 120;
  const h = 28;
  const min = Math.min(...valores);
  const max = Math.max(...valores);
  const rango = max - min || 1;
  const x = (i: number) => (i / (valores.length - 1)) * (w - 4) + 2;
  const y = (v: number) => h - 3 - ((v - min) / rango) * (h - 6);
  const d = valores.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const ultimo = valores[valores.length - 1];
  const tono = mejor == null ? "muted" : (ultimo >= valores[valores.length - 2]) === (mejor === "up") ? "win" : "loss";
  return (
    <svg className="ck-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} className="ck-spark__line" />
      <circle cx={x(valores.length - 1)} cy={y(ultimo)} r={2.6} className="ck-spark__dot" data-tone={tono} />
    </svg>
  );
};

/** La rosa de rumbos con las franjas de DOPA. */
const Rosa: React.FC<{ sectores: number[]; t: T }> = ({ sectores, t }) => {
  const C = 100;
  const R = 88;
  const max = Math.max(1, ...sectores);
  const paso = 360 / sectores.length;
  const punto = (r: number, deg: number) => {
    const rad = (deg * Math.PI) / 180;
    return `${(C + r * Math.cos(rad)).toFixed(2)},${(C - r * Math.sin(rad)).toFixed(2)}`;
  };
  const cuna = (r0: number, r1: number, desde: number, hasta: number) => {
    const n = 6;
    const ext: string[] = [];
    const int: string[] = [];
    for (let i = 0; i <= n; i++) {
      const a = desde + ((hasta - desde) * i) / n;
      ext.push(punto(r1, a));
      int.unshift(punto(r0, a));
    }
    return `M ${ext.join(" L ")} L ${int.join(" L ")} Z`;
  };
  return (
    <svg viewBox="0 0 200 200" className="ck-rose" role="img" aria-label={t("Direction of your movement orders in fights")}>
      <circle cx={C} cy={C} r={R} className="ck-rose__bg" />
      {[45, 135, 225, 315].map((d) => (
        <path key={d} d={cuna(0, R, d - 18, d + 18)} className="ck-rose__band" />
      ))}
      {sectores.map((n, i) => (
        <path key={i} d={cuna(6, 6 + (R - 6) * Math.sqrt(n / max), i * paso + 1, (i + 1) * paso - 1)} className="ck-rose__bar" />
      ))}
      <circle cx={C} cy={C} r={3} className="ck-rose__you" />
    </svg>
  );
};

/** Una cifra de DOPA: tu % con la marca del azar. */
const BarraDopa: React.FC<{ label: string; help: string; n: number; de: number; unidad: string; azar?: number; t: T }> = ({
  label,
  help,
  n,
  de,
  unidad,
  azar,
  t,
}) => {
  const p = pct(n, de);
  const tono = azar == null ? "muted" : p >= azar + 0.05 ? "win" : p <= azar - 0.05 ? "loss" : "muted";
  return (
    <div className="ck-dbar">
      <div className="ck-dbar__head">
        <span className="ck-dbar__label">
          {label}
          <HelpDot text={help} />
        </span>
        <b className="u-metric ck-dbar__val" data-tone={tono}>{withPercent(Math.round(p * 100))}</b>
      </div>
      <div className="ck-dbar__track" aria-hidden="true">
        <i style={{ width: `${Math.round(p * 100)}%` }} data-tone={tono} />
        {azar != null && <em style={{ left: `${azar * 100}%` }} />}
      </div>
      <span className="ck-dbar__sub">
        {t("{n} of {total} {unit}", { n: n.toLocaleString(), total: de.toLocaleString(), unit: unidad })}
        {azar != null && ` · ${t("at random: {p}", { p: withPercent(Math.round(azar * 100)) })}`}
      </span>
    </div>
  );
};

/** Lo que dicen tus cifras de DOPA, en una frase. */
function lecturaDopa(d: DopaStats, t: T): string {
  const todas = pct(d.diagonal, d.orders);
  const giros = pct(d.turns_diagonal, d.turns);
  if (todas < AZAR + 0.05 && giros < AZAR + 0.05) {
    return t("Your orders land on the diagonals about as often as random clicks would: you aren't looking for the 45° angle yet. That's exactly what DOPA trains.");
  }
  if (giros >= todas + 0.05) {
    return t("When you change direction you look for the diagonal more than when you just walk: the habit is there, now it has to be in every dodge.");
  }
  return t("You land on the diagonals more often than random clicks would. Keep it up in the turns, which are the dodges.");
}

export const ClicksPanel: React.FC = () => {
  const t = useT();
  const activo = useContext(PanelActiveContext);
  const navigate = useNavigate();
  const { matches } = useMatches();
  const setSelectedMatch = useAppStore((s) => s.setSelectedMatch);
  const setPendingStats = useAppStore((s) => s.setPendingStats);
  const [c, setC] = useState<ClickCareer | null | undefined>(undefined);
  /** Partidas cuyo vídeo se está leyendo, con el avance del HUD (null = las barras). */
  const [leyendo, setLeyendo] = useState<Record<string, number | null>>({});
  const [fallos, setFallos] = useState<Record<string, string>>({});

  const cargar = useCallback(() => {
    getClickCareer().then(setC, () => setC((x) => (x === undefined ? null : x)));
  }, []);
  // Al entrar en la pantalla: puede haber partidas nuevas desde la última vez.
  useEffect(() => {
    if (activo) cargar();
  }, [activo, cargar]);

  // La lectura del vídeo avisa del avance del HUD y, al acabar las barras,
  // otra vez con 100: entonces llega la comparación con DOPA.
  useEffect(() => {
    const off = listen<[string, number]>("hud_progress", (e) => {
      const [id, p] = e.payload;
      setLeyendo((l) => (id in l ? { ...l, [id]: p >= 100 ? null : p } : l));
      if (p < 0) {
        setLeyendo(({ [id]: _, ...resto }) => resto);
        setFallos((f) => ({ ...f, [id]: t("The video couldn't be read.") }));
      }
      if (p >= 100 || p < 0) cargar();
    });
    return () => {
      void off.then((f) => f()).catch(() => {});
    };
  }, [cargar, t]);
  // Lo que ya tiene su comparación deja de estar «leyendo».
  useEffect(() => {
    if (!c) return;
    setLeyendo((l) => {
      const listas = c.games.filter((g) => g.dopa && g.id in l).map((g) => g.id);
      if (listas.length === 0) return l;
      const n = { ...l };
      listas.forEach((id) => delete n[id]);
      return n;
    });
  }, [c]);

  const leer = (id: string) => {
    setFallos(({ [id]: _, ...resto }) => resto);
    setLeyendo((l) => ({ ...l, [id]: 0 }));
    readMatchHud(id).catch((e) => {
      setLeyendo(({ [id]: _, ...resto }) => resto);
      setFallos((f) => ({ ...f, [id]: String(e) }));
    });
  };

  const abrir = (g: ClickGame) => {
    const m = matches.find((x) => x.id === g.id);
    if (!m) return;
    setSelectedMatch(m);
    setPendingStats("match-clicks");
    navigate("/review");
  };

  const cifras = useMemo<Cifra[]>(() => {
    const md = c?.median;
    return [
      {
        key: "apm",
        label: t("APM"),
        help: t("Keys and clicks per minute, the same APM as in the rest of the app."),
        valor: (s) => s.apm,
        mediana: md?.apm,
        fmt: (v) => String(Math.round(v)),
        mejor: null,
      },
      {
        key: "travel",
        label: t("Mouse travel"),
        help: t("How far your cursor moved per minute alive, in metres of a 1080p screen at 96 dpi: the same unit for every game, whatever your monitor."),
        valor: (s) => s.traveled_m_min,
        mediana: md?.traveled_m_min,
        fmt: (v) => t("{n} m/min", { n: formatDecimal(v) }),
        mejor: null,
      },
      {
        key: "eff",
        label: t("Efficiency"),
        help: t("The straight line from one click to the next, divided by the path your cursor actually took. 100% is always in a straight line; detours and wiggles bring it down. Pairs of clicks more than 5 s apart, or with a trip to the screen edge in between (a camera pan), don't count."),
        valor: (s) => s.efficiency,
        mediana: md?.efficiency,
        fmt: (v) => withPercent(Math.round(v * 100)),
        mejor: "up",
      },
      {
        key: "pans",
        label: t("Edge pans"),
        help: t("Times your cursor went to the edge of the screen. With the camera unlocked that pans it; with it locked, it's a trip for nothing. They don't count against your efficiency."),
        valor: (s) => s.edge_pans_min,
        mediana: md?.edge_pans_min,
        fmt: (v) => t("{n}/min", { n: formatDecimal(v) }),
        mejor: null,
      },
      {
        key: "rate",
        label: t("Clicks per second"),
        help: t("Left and right clicks per second alive."),
        valor: (s) => s.tempo_hz,
        mediana: md?.tempo_hz,
        fmt: (v) => formatDecimal(v),
        mejor: null,
      },
      {
        key: "idle",
        label: t("Mouse still"),
        help: t("Stretches of 1 s or more in which the cursor stayed within 5 px of where it stopped, alive only. Recalls and waiting for a wave count too."),
        valor: (s) => s.idle_ratio,
        mediana: md?.idle_ratio,
        fmt: (v) => withPercent(Math.round(v * 100)),
        mejor: "down",
      },
    ];
  }, [c, t]);

  const esqueleto = useDelayedLoading(c === undefined);
  const titulo = (
    <ScreenTitle align="content" title={t("Your clicks")} sub={t("Your hand game after game")} />
  );
  if (c === undefined || esqueleto) return <div className="ck">{titulo}{esqueleto ? <div className="ck-col"><SkeletonLines /></div> : null}</div>;
  if (c === null || c.games.length === 0) {
    return (
      <div className="ck">
        {titulo}
        <div className="ck-col">
          <EmptyState
            title={c === null ? t("Couldn't load this section.") : t("No games with a mouse trail yet")}
            text={t("Wardline records your mouse while you play. Play a game with the app open and it will show up here.")}
          />
        </div>
      </div>
    );
  }

  const n = Math.min(10, c.games.length);
  const ultima = c.games[0];
  // De la más vieja a la más nueva, para leer las minigráficas de izquierda a derecha.
  const serie = c.games.slice(0, PUNTOS).reverse();
  const d = c.dopa;
  const porLeer = c.games.filter((g) => !g.dopa && g.can_read).length;

  return (
    <div className="ck">
      {titulo}
      <div className="ck-col">
        {/* ---------------------------------------------- tu mano */}
        <section className="ck-sec">
          <div className="sect__head">
            <h2 className="ck-h">{n === 1 ? t("Your hand in your last game") : t("Your hand in your last {n} games", { n })}</h2>
            <i className="sect__rule" />
          </div>
          <p className="ck-lead">
            {t("Your median, with how the most recent game went underneath. Only the time your champion was alive counts. Efficiency is better higher and mouse still is better lower; the rest are your style, neither good nor bad.")}
          </p>
          <div className="cl-cards">
            {cifras.map((x) => {
              const valores = serie.map((g) => x.valor(g.stats)).filter((v): v is number => v != null);
              const ult = x.valor(ultima.stats);
              return (
                <div key={x.key} className="cl-card">
                  <span className="cl-card__label">
                    {x.label}
                    <HelpDot text={x.help} />
                  </span>
                  <span className="cl-card__value u-metric">{x.mediana != null ? x.fmt(x.mediana) : "—"}</span>
                  <span className="cl-card__sub">{ult != null ? t("last game: {v}", { v: x.fmt(ult) }) : " "}</span>
                  <Linea valores={valores} mejor={x.mejor} />
                </div>
              );
            })}
          </div>
        </section>

        {/* ---------------------------------------------- DOPA */}
        <section className="ck-sec">
          <div className="sect__head">
            <h2 className="ck-h">{t("Against DOPA · the 45° angle")}</h2>
            <i className="sect__rule" />
          </div>
          <p className="ck-lead">
            {t("DOPA Tools only counts a movement order as good if it sends your champion along one of the four diagonals, with 18° of margin on each side. Your right clicks in fights are judged the same way here, measured from where your champion was in the video, not from the centre of the screen: your camera is unlocked and the centre isn't you.")}
          </p>
          {d.orders === 0 ? (
            <div className="ck-empty">
              <ScanLine size={18} aria-hidden="true" />
              <p>
                {t("To compare you, Wardline has to read where your champion was in the video of each game (about 15 minutes per game, in the background).")}{" "}
                {porLeer > 0
                  ? t("Use «Read the video» on any game in the list below.")
                  : t("None of these games can be read right now: they need the video and Riot's data.")}
              </p>
            </div>
          ) : (
            <div className="ck-dopa">
              <figure className="ck-dopa__rose">
                <Rosa sectores={d.sectors} t={t} />
                <figcaption>{t("Where you send your champion in fights. The shaded bands are DOPA's diagonals.")}</figcaption>
              </figure>
              <div className="ck-dopa__bars">
                <BarraDopa
                  label={t("On a diagonal")}
                  help={t("Share of your movement orders in fights that fall within 18° of a diagonal: what DOPA's «Evaluate 45° angle» accepts. A random click would land there 40% of the time.")}
                  n={d.diagonal}
                  de={d.orders}
                  unidad={t("orders")}
                  azar={AZAR}
                  t={t}
                />
                <BarraDopa
                  label={t("When you change direction")}
                  help={t("The same, only for orders that turn 60° or more from the previous one (less than 2 s before): those are the dodges.")}
                  n={d.turns_diagonal}
                  de={d.turns}
                  unidad={t("turns")}
                  azar={AZAR}
                  t={t}
                />
                <BarraDopa
                  label={t("Purist mode")}
                  help={t("On a diagonal and within DOPA's 400 px ring (on a 1080p scale): the only clicks its purist mode moves you with.")}
                  n={d.purist}
                  de={d.orders}
                  unidad={t("orders")}
                  t={t}
                />
                <p className="ck-read">{lecturaDopa(d, t)}</p>
                <p className="ck-soft">
                  {c.dopa_games === 1
                    ? t("From 1 game with its video read.")
                    : t("From {n} games with their video read.", { n: c.dopa_games })}
                </p>
              </div>
            </div>
          )}
        </section>

        {/* ---------------------------------------------- partida a partida */}
        <section className="ck-sec">
          <div className="sect__head">
            <h2 className="ck-h">{t("Game by game")}</h2>
            <i className="sect__rule" />
          </div>
          <div className="ck-table" role="table" aria-label={t("Game by game")}>
            <div className="ck-row ck-row--head" role="row">
              <span role="columnheader">{t("Game")}</span>
              <span role="columnheader">{t("APM")}</span>
              <span role="columnheader">{t("Efficiency")}</span>
              <span role="columnheader">{t("Edge pans")}</span>
              <span role="columnheader">{t("Mouse still")}</span>
              <span role="columnheader">{t("DOPA 45°")}</span>
            </div>
            {c.games.map((g) => {
              const s = g.stats;
              const lee = g.id in leyendo;
              const avance = leyendo[g.id];
              return (
                <div key={g.id} className="ck-row" role="row">
                  <button type="button" className="ck-game" onClick={() => abrir(g)} title={t("Open this game on Your clicks")}>
                    <ChampionAvatar champion={g.champion} size={28} />
                    <span className="ck-game__who">
                      <b>{champLabel(g.champion)}</b>
                      <small>
                        <span data-tone={resultado(g.result) === "victory" ? "win" : resultado(g.result) === "defeat" ? "loss" : undefined}>
                          {t(resultado(g.result) === "victory" ? "Victory" : resultado(g.result) === "defeat" ? "Defeat" : "No result")}
                        </span>
                        {" · "}
                        {matchAge(g.date, t)}
                        {" · "}
                        {mmss(s.alive_s)} {t("alive")}
                      </small>
                    </span>
                    <ChevronRight size={14} className="ck-game__go" aria-hidden="true" />
                  </button>
                  <span className="u-metric" role="cell">{s.apm != null ? Math.round(s.apm) : "—"}</span>
                  <span className="u-metric" role="cell">{s.efficiency != null ? withPercent(Math.round(s.efficiency * 100)) : "—"}</span>
                  <span className="u-metric" role="cell">{formatDecimal(s.edge_pans_min)}</span>
                  <span className="u-metric" role="cell">{s.idle_ratio != null ? withPercent(Math.round(s.idle_ratio * 100)) : "—"}</span>
                  <span role="cell" className="ck-dopacell">
                    {g.dopa && g.dopa.orders > 0 ? (
                      <b className="u-metric" title={t("{n} of {total} orders in fights on a diagonal", { n: g.dopa.diagonal, total: g.dopa.orders })}>
                        {withPercent(Math.round(pct(g.dopa.diagonal, g.dopa.orders) * 100))}
                      </b>
                    ) : g.dopa ? (
                      <span className="ck-soft">{t("no fights read")}</span>
                    ) : lee ? (
                      <span className="ck-soft" role="status">
                        {avance == null ? t("Reading the bars…") : t("Reading… {p}", { p: withPercent(Math.round(avance)) })}
                      </span>
                    ) : g.can_read ? (
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => leer(g.id)}>
                        {t("Read the video")}
                      </button>
                    ) : (
                      <span className="ck-soft" title={t("It needs the video and Riot's data.")}>—</span>
                    )}
                    {fallos[g.id] && <small className="ck-err">{fallos[g.id]}</small>}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
};
