import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { MatchMetadata } from "../../../types";
import {
  getBlindSpot,
  checkRiotKey,
  syncMatchNow,
  type BlindSpot,
} from "../../../core/tauri-ipc";
import { clock as reloj, relativeDay, matchAge } from "../../../core/time";
import { currentFocus, deathClock, confidenceOf, BUCKET_SECONDS } from "../../../core/patterns";
import {
  outcome,
  formatDuration,
  computeKDA,
  kdaRatio,
  lpDeltas,
  queueKey,
} from "../../../core/matchStats";
import { reviewProgress } from "../../../core/review";
import { laneLabel } from "../../../core/lanes";
import { rankLabel } from "../../../core/ddragon";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { Button } from "../../../components/ui/Button";
import { useAppStore, useErrorClips } from "../../../store/useAppStore";
import { Target, KeyRound, Loader2, Play, RefreshCw, ScanSearch, CircleDot } from "lucide-react";
import { useT } from "../../../core/LanguageProvider";
import "./HomePanel.css";
import { usePressureSummary } from "../../player/usePressureSummary";
import { PressureEpisodeCard } from "../../player/components/PressureEpisodeCard";

/**
 * Hoy: la última partida y una sola cosa en la que trabajar.
 *
 * Tres zonas, en este orden de lectura:
 *
 *  1. El héroe — qué pasó en la última partida, con lo que esta app sabe y
 *     nadie más: tu puesto de impacto en el lobby y su percentil en el rol.
 *  2. El foco — el tramo de partida en el que más mueres, con el reloj de
 *     muertes al lado para que se vea POR QUÉ es ese tramo y no otro.
 *  3. La columna derecha — tres señales de una línea (punto ciego, presión,
 *     tendencia) y la cola de partidas por revisar.
 *
 * El estado de captura (grabando, clave de Riot, disco) ya no vive aquí: está
 * fijo al pie del rail y se ve desde cualquier sección.
 */

type KeyStatus = "ok" | "invalid" | "expired" | "missing";

interface KeyStatusEvent {
  status: KeyStatus;
  message: string;
}

interface MaintenanceProgress {
  phase: string;
  done: number;
  total: number;
}

export interface HomePanelProps {
  matches: MatchMetadata[];
  isRecording: boolean;
  onOpenMatch: (match: MatchMetadata) => void;
  onGoTraining: () => void;
}

/** Tramos del histograma del foco: 0-5 … 30-35 y un último "35+" que recoge el resto. */
const HISTO_FROM = [0, 5, 10, 15, 20, 25, 30, 35];
const HISTO_LAST = HISTO_FROM[HISTO_FROM.length - 1];

export const HomePanel: React.FC<HomePanelProps> = ({
  matches,
  onOpenMatch,
  onGoTraining,
}) => {
  const t = useT();
  const navigate = useNavigate();
  const setLibraryFilter = useAppStore((s) => s.setLibraryFilter);
  const refreshMatches = useAppStore((s) => s.refreshMatches);
  const { clips: errorClips } = useErrorClips();

  const [ciego, setCiego] = useState<BlindSpot | null>(null);
  const [ciegoFallo, setCiegoFallo] = useState(false);
  const { data: presion, error: pressureError, retry: retryPressure } = usePressureSummary("/home");
  const setPendingSeek = useAppStore((s) => s.setPendingSeek);
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [mant, setMant] = useState<MaintenanceProgress | null>(null);
  const [sincronizando, setSincronizando] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    // El backend solo emite `riot_key_status` cuando una llamada choca con un
    // 401/403, así que además se pregunta: al abrir la app con la clave ya
    // caducada no llegaría nada hasta la primera sincronización.
    checkRiotKey()
      .then(() => vivo && setKeyStatus("ok"))
      .catch((e) => {
        if (!vivo) return;
        const msg = String(e).toLowerCase();
        setKeyStatus(msg.includes("no_key") || msg.includes("missing") ? "missing" : "invalid");
      });
    return () => { vivo = false; };
  }, []);

  useEffect(() => {
    const paraClave = listen<KeyStatusEvent>("riot_key_status", (e) => setKeyStatus(e.payload.status));
    const paraMant = listen<MaintenanceProgress>("library_maintenance", (e) => {
      // "done" es la etapa final: se apaga la línea en vez de dejarla al 100%.
      setMant(e.payload.phase === "done" ? null : e.payload);
    });
    return () => {
      paraClave.then((f) => f()).catch(() => {});
      paraMant.then((f) => f()).catch(() => {});
    };
  }, []);

  // El punto ciego se pide al backend porque sale de los informes de miradas de
  // TODAS las partidas, no de la metadata que ya está en memoria.
  useEffect(() => {
    let vivo = true;
    getBlindSpot()
      .then((b) => { if (vivo) { setCiego(b); setCiegoFallo(false); } })
      .catch(() => { if (vivo) { setCiego(null); setCiegoFallo(true); } });
    return () => { vivo = false; };
  }, [matches.length]);

  const own = useMemo(() => matches.filter((m) => !m.is_vod), [matches]);
  const focus = useMemo(() => currentFocus(own), [own]);
  const clock = useMemo(() => deathClock(own), [own]);
  const conf = confidenceOf(own.length);

  /** Conteos por tramo para el histograma: los ≥35 se juntan en el último. */
  const histo = useMemo(() => {
    const counts = HISTO_FROM.map(() => 0);
    for (const b of clock.buckets) {
      const i = b.from >= HISTO_LAST ? HISTO_FROM.length - 1 : HISTO_FROM.indexOf(b.from);
      if (i >= 0) counts[i] += b.total;
    }
    return counts;
  }, [clock]);
  const histoMax = Math.max(1, ...histo);
  const focoIdx = focus
    ? focus.bucket.from >= HISTO_LAST ? HISTO_FROM.length - 1 : HISTO_FROM.indexOf(focus.bucket.from)
    : -1;

  /** De más reciente a más antigua. La lista llega así, pero no se promete. */
  const porFecha = useMemo(
    () => [...own].sort((a, b) => (a.date < b.date ? 1 : -1)),
    [own]
  );
  const ultima = porFecha[0] ?? null;
  const lp = useMemo(() => lpDeltas(own), [own]);

  /** Las partidas donde ocurre la debilidad, de más reciente a más antigua. */
  const affected = useMemo(() => {
    if (!focus) return [];
    const { from, to } = focus.bucket;
    return porFecha
      .filter((m) => {
        const off = m.video_offset ?? 0;
        return m.events.some((ev) => {
          if (ev.type !== "ChampionKill" || ev.subtype !== "death") return false;
          const t = Math.max(0, ev.time - off) / 60;
          return t >= from && t < to;
        });
      })
      .slice(0, 4);
  }, [porFecha, focus]);

  // Una sola definición de "revisada" en toda la app (`core/review.ts`): la cola
  // de momentos tachada, o notas escritas a mano.
  const pendientes = useMemo(
    () => porFecha.filter((m) => !reviewProgress(m, errorClips).reviewed),
    [porFecha, errorClips]
  );
  const toReview = pendientes.slice(0, 4);

  /** Tendencia: las 10 últimas contra las 10 anteriores, solo con lo local. */
  const trend = useMemo(() => {
    const ult = porFecha.slice(0, 10);
    const ant = porFecha.slice(10, 20);
    if (ult.length < 3) return null;
    const wr = (xs: MatchMetadata[]) =>
      xs.length ? xs.filter((m) => outcome(m.result) === "victory").length / xs.length : null;
    const pct = (xs: MatchMetadata[]) => {
      const v = xs.map((m) => m.impact_percentile).filter((x): x is number => x != null);
      return v.length >= 3 ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const hayAnt = ant.length >= 3;
    return {
      n: ult.length,
      nPrev: ant.length,
      wr: wr(ult),
      wrPrev: hayAnt ? wr(ant) : null,
      pct: pct(ult),
      pctPrev: hayAnt ? pct(ant) : null,
    };
  }, [porFecha]);

  const verBiblioteca = useCallback(
    (f: "all" | "unreviewed" | "defeats") => {
      setLibraryFilter(f);
      navigate("/review");
    },
    [navigate, setLibraryFilter]
  );

  const sincronizar = useCallback(async () => {
    if (!ultima) return;
    setSincronizando(true);
    setSyncError(null);
    try {
      await syncMatchNow(ultima.id);
      await refreshMatches();
    } catch (e) {
      setSyncError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setSincronizando(false);
    }
  }, [ultima, refreshMatches]);

  const claveMal = keyStatus !== null && keyStatus !== "ok";

  /* ------------------------------------------------------------ cabecera */
  const cabecera = (
    <header className="home-head">
      <div className="home-head__row">
        <h1 className="home-h1">{t("Today")}</h1>
        <span className="home-sub">{t("The last game and one thing to work on")}</span>
      </div>
      {/* El mantenimiento de arranque, en voz baja: no se puede pulsar nada y
          termina solo, pero explica por qué la biblioteca se mueve sola. */}
      {mant && (
        <span className="u-meta home-mant" role="status">
          <Loader2 size={12} className="home-spin" />
          {t("Updating library")}
          {mant.total > 0 ? ` ${mant.done}/${mant.total}` : ""}
        </span>
      )}
    </header>
  );

  /* --------------------------------------------------------- sin partidas */
  if (own.length === 0) {
    return (
      <div className="panel-enter home-panel">
        <div className="home-page">
          {cabecera}
          <div className="surface-hero">
            <div className="home-empty">
              <h2 className="home-empty__title">{t("Play a game — it records itself")}</h2>
              <p className="home-prose">
                {t("LeagueRecorder watches for the League client. When a game starts it begins recording, and when it ends it syncs with Riot and files the game here. There is nothing to press.")}
              </p>
              <div className="home-empty__actions">
                {claveMal && (
                  <Button variant="primary" size="md" icon={<KeyRound size={14} />} onClick={() => navigate("/settings?cat=account")}>
                    {keyStatus === "missing" ? t("Add your Riot key") : t("Fix your Riot key")}
                  </Button>
                )}
                <Button variant="ghost" size="md" icon={<ScanSearch size={14} />} onClick={() => navigate("/vod")}>
                  {t("Import a VOD")}
                </Button>
              </div>
              <p className="home-prose home-prose--faint">
                {keyStatus === "ok"
                  ? t("Your Riot key is working: the scoreboard, your rank and your impact score will be there from the first game.")
                  : t("Without a Riot key the app still records and tracks your games; the scoreboard, rank and impact score need one.")}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* -------------------------------------------------------------- héroe */
  const res = ultima ? outcome(ultima.result) : "unknown";
  const kda = ultima ? computeKDA(ultima.events) : null;
  const kdaGuardado = ultima?.kda;
  const sinVideo = !!ultima && ultima.video_path === "";
  const sinScoreboard = !!ultima && (ultima.participants?.length ?? 0) === 0;
  const deltaLp = ultima ? lp.get(ultima.id) : undefined;
  const yo = ultima?.participants?.find((p) => p.is_self) ?? null;
  const csMin =
    yo && ultima && ultima.game_duration > 0 ? (yo.cs / (ultima.game_duration / 60)).toFixed(1) : null;
  const progUltima = ultima ? reviewProgress(ultima, errorClips) : null;
  const rango = ultima ? rankLabel(ultima.rank_tier, ultima.rank_division) : null;

  const resultadoTexto = (r: ReturnType<typeof outcome>) =>
    t(r === "victory" ? "Victory" : r === "defeat" ? "Defeat" : "No result");
  const resultadoClase = (r: ReturnType<typeof outcome>) =>
    r === "victory" ? "home-win" : r === "defeat" ? "home-loss" : "home-muted";

  /* ----------------------------------------------------------- señales */
  const ciegoOk = !!ciego && ciego.games_worst >= 3 && ciego.avg_gap_secs >= 90;
  const ciegoMeta = ciegoOk
    ? t("{avg} unwatched on average · {n} of {total} games", {
        avg: reloj(ciego!.avg_gap_secs),
        n: ciego!.games_worst,
        total: ciego!.games,
      })
    : ciegoFallo
      ? t("Couldn't read your camera looks")
      : !ciego
        ? t("No camera data yet")
        : t("No lane stands out yet");
  const ciegoDetalle = ciegoOk
    ? t("{lane} is the lane you leave unwatched the longest, in {n} of your last {total} games.", {
        lane: laneLabel(ciego!.lane, t),
        n: ciego!.games_worst,
        total: ciego!.games,
      }) + " " + t("On average {avg} without a single look; your worst was {worst}.", {
        avg: reloj(ciego!.avg_gap_secs),
        worst: reloj(ciego!.worst_gap_secs),
      })
    : ciegoFallo
      ? t("The look reports are on disk but could not be read this time. It retries on the next visit.")
      : !ciego
        ? t("This comes from the minimap looks detected in your recorded games. It appears once a game has been analysed.")
        : t("Across {games} games with look data, no lane is clearly the worst yet ({n} games and a 1:30 gap are needed).", {
            games: ciego!.games,
            n: 3,
          });

  const presionOk = !!presion && presion.windows > 0;
  const presionMeta = presionOk
    ? t("{towers} towers · {gold}k gold associated", {
        towers: presion!.towers,
        gold: Math.round(presion!.gold / 100) / 10,
      })
    : pressureError
      ? t("Couldn't load pressure evidence")
      : presion && presion.games > 0
        ? t("{games} games analysed; no qualifying episodes.", { games: presion.games })
        : t("Nothing measured yet");

  const trendMeta = trend
    ? trend.pct != null
      ? t("avg impact percentile {p} · last {n}", { p: Math.round(trend.pct), n: trend.n })
      : trend.nPrev >= 3
        ? t("last {n} games vs the {p} before", { n: trend.n, p: trend.nPrev })
        : t("your last {n} games", { n: trend.n })
    : t("Needs at least 3 recorded games");
  const trendDelta =
    trend && trend.wrPrev != null && trend.wr != null
      ? Math.round((trend.wr - trend.wrPrev) * 100)
      : null;

  return (
    <div className="panel-enter home-panel">
      <div className="home-page">
        {cabecera}

        <div className="home-grid">
          {/* ============================================ columna izquierda */}
          <div className="home-col">
            {/* ------------------------------------------- última partida */}
            {ultima && (
              <section className="card home-hero" aria-labelledby="home-hero-lbl">
                <span id="home-hero-lbl" className="u-label">{t("Last game")}</span>

                <div className="home-hero__top">
                  <ChampionAvatar champion={ultima.champion} size={64} />
                  <div className="home-hero__who">
                    <h2 className="home-h2">
                      {ultima.champion}
                      <span className={`home-hero__res ${resultadoClase(res)}`}>{resultadoTexto(res)}</span>
                    </h2>
                    <span className="u-meta">
                      {t(queueKey(ultima.queue))} · {formatDuration(ultima.game_duration)} · {matchAge(ultima.date, t)}
                      {ultima.patch ? ` · ${t("patch {v}", { v: ultima.patch })}` : ""}
                    </span>
                  </div>

                  {/* Lo que esta app sabe y ningún marcador enseña. */}
                  <div className="home-hero__impact">
                    {ultima.impact_rank != null ? (
                      <>
                        <span className="home-bigv">#{ultima.impact_rank}</span>
                        <span className="u-meta">
                          {ultima.impact_rank === 1 ? `${t("MVP")} · ` : ""}
                          {t("of 10 by impact")}
                          {ultima.impact_percentile != null &&
                            ` · ${t("top {n}% in your role", { n: Math.max(1, Math.round(100 - ultima.impact_percentile)) })}`}
                        </span>
                      </>
                    ) : (
                      <span className="u-meta">{t("impact not computed yet")}</span>
                    )}
                  </div>
                </div>

                <div className="home-metrics">
                  <div className="home-metric">
                    <span className="u-label">{t("KDA")}</span>
                    <span className="u-metric home-metric__v">
                      {kdaGuardado ?? (kda ? `${kda.kills} / ${kda.deaths} / ${kda.assists}` : "—")}
                    </span>
                    <span className="u-meta">{kda ? t(kdaRatio(kda)) : "—"}</span>
                  </div>
                  <div className="home-metric">
                    <span className="u-label">{t("CS")}</span>
                    <span className="u-metric home-metric__v">{yo ? yo.cs : "—"}</span>
                    <span className="u-meta">{csMin ? t("{n} per minute", { n: csMin }) : t("needs a Riot sync")}</span>
                  </div>
                  <div className="home-metric">
                    <span className="u-label">{deltaLp != null ? t("LP") : t("Rank")}</span>
                    {deltaLp != null ? (
                      <span className={`u-metric home-metric__v ${deltaLp > 0 ? "home-win" : deltaLp < 0 ? "home-loss" : ""}`}>
                        {deltaLp > 0 ? "+" : deltaLp < 0 ? "−" : ""}{Math.abs(deltaLp)}
                      </span>
                    ) : (
                      <span className="u-metric home-metric__v">{rango ?? "—"}</span>
                    )}
                    <span className="u-meta">
                      {deltaLp != null
                        ? `${rango ?? ""}${rango && ultima.rank_lp != null ? " · " : ""}${ultima.rank_lp != null ? `${ultima.rank_lp} LP` : ""}`
                        : ultima.rank_lp != null
                          ? `${ultima.rank_lp} LP`
                          : t("no rank yet")}
                    </span>
                  </div>
                  <div className="home-metric">
                    <span className="u-label">{t("Moments")}</span>
                    <span className="u-metric home-metric__v">
                      {progUltima ? `${progUltima.done} / ${progUltima.total}` : "—"}
                    </span>
                    <span className="u-meta">{t("moments reviewed")}</span>
                  </div>
                </div>

                <div className="home-hero__actions">
                  <Button variant="primary" size="md" icon={<Play size={14} />} onClick={() => onOpenMatch(ultima)}>
                    {sinVideo ? t("Open this game") : t("Review this game")}
                  </Button>
                  <Button variant="ghost" size="md" onClick={() => verBiblioteca("all")}>
                    {t("See the library")}
                  </Button>
                  <span className="u-meta home-hero__side">
                    {sinScoreboard ? (
                      <button type="button" className="home-link" onClick={sincronizar} disabled={sincronizando}>
                        <RefreshCw size={12} className={sincronizando ? "home-spin" : undefined} />
                        {sincronizando ? t("Syncing…") : t("Sync with Riot")}
                      </button>
                    ) : (
                      <span>{t("Synced with Riot")}</span>
                    )}
                    {claveMal && (
                      <>
                        <span aria-hidden="true">·</span>
                        <button type="button" className="home-link home-link--warn" onClick={() => navigate("/settings?cat=account")}>
                          <KeyRound size={12} />
                          {keyStatus === "missing" ? t("Add your Riot key") : t("Fix your Riot key")}
                        </button>
                      </>
                    )}
                  </span>
                </div>

                {sinVideo && (
                  <p className="u-meta home-note">
                    {t("Tracked without video — the recording could not start, so only the data of this game was kept.")}
                  </p>
                )}
                {syncError && <p className="u-meta home-note home-loss">{syncError}</p>}

                {(ultima.lane_result || ultima.gold_diff_15 != null) && (
                  <details className="home-details" key={ultima.id}>
                    <summary>{t("Performance details")}</summary>
                    <div className="home-details__body u-meta">
                      {ultima.lane_result && (
                        <span>
                          {t("lane")}:{" "}
                          {/* Los tres valores del backend son claves inglesas
                              ("Win"/"Loss"/"Even") que se usan en más sitios; se
                              traducen por su significado AQUÍ, no metiendo un
                              "Win" suelto en el diccionario. */}
                          <span className={ultima.lane_result === "Win" ? "home-win" : ultima.lane_result === "Loss" ? "home-loss" : "home-muted"}>
                            {t(ultima.lane_result === "Win" ? "won" : ultima.lane_result === "Loss" ? "lost" : "even")}
                          </span>
                        </span>
                      )}
                      {ultima.gold_diff_15 != null && (
                        <span>
                          {t("gold @15")}:{" "}
                          <span className={`u-metric ${ultima.gold_diff_15 >= 0 ? "home-win" : "home-loss"}`} style={{ fontSize: 11 }}>
                            {ultima.gold_diff_15 >= 0 ? "+" : "−"}{Math.abs(ultima.gold_diff_15)}
                          </span>
                        </span>
                      )}
                    </div>
                  </details>
                )}
              </section>
            )}

            {/* ------------------------------------------- en qué trabajar */}
            {focus ? (
              <section className="card home-focus" aria-labelledby="home-focus-lbl">
                <div className="home-focus__grid">
                  <div className="home-focus__text">
                    <span id="home-focus-lbl" className="u-label home-flag">
                      {t("What to work on")}
                      {" · "}
                      {conf === "low"
                        ? t("lead, {n} games", { n: own.length })
                        : `${focus.bucket.total} ${t("deaths")} · ${focus.games} ${t("games")}`}
                    </span>
                    <h2 className="home-h2">
                      {t("Deaths between minutes {a} and {b}", { a: focus.bucket.from, b: focus.bucket.to })}
                    </h2>
                    <p className="home-prose">
                      {t("This window contains {n} of your {total} deaths ({pct}%).", {
                        n: focus.bucket.total,
                        total: clock.total,
                        pct: Math.round(focus.share * 100),
                      })}
                      {conf === "low" && (
                        <>
                          {" "}
                          {t("With {n} games this is a lead, not a conclusion — it sharpens as you record more.", { n: own.length })}
                        </>
                      )}
                    </p>
                  </div>

                  <div
                    className="home-histo"
                    role="img"
                    aria-label={t("Deaths per game minute, in {n}-minute windows", { n: BUCKET_SECONDS / 60 })}
                  >
                    <div className="home-bars">
                      {histo.map((n, i) => (
                        <div
                          key={HISTO_FROM[i]}
                          className={`home-bar${i === focoIdx ? " home-bar--hot" : ""}`}
                          style={{ height: `${Math.max(4, Math.round((n / histoMax) * 100))}%` }}
                          title={`${n}`}
                        />
                      ))}
                    </div>
                    <div className="home-bars__axis u-meta">
                      {HISTO_FROM.map((f, i) => (
                        <span key={f} className={i === focoIdx ? "home-flag" : undefined}>
                          {i === HISTO_FROM.length - 1 ? `${f}+` : f}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="home-focus__foot">
                  {affected.length > 0 && (
                    <>
                      <span className="u-label home-focus__where">{t("Where it happened")}</span>
                      {affected.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className="home-chip"
                          onClick={() => onOpenMatch(m)}
                          title={`${m.champion} · ${relativeDay(m.date, t)}`}
                        >
                          <ChampionAvatar champion={m.champion} size={18} />
                          {m.champion}
                          <span className="u-meta">{formatDuration(m.game_duration)}</span>
                        </button>
                      ))}
                      {focus.games > affected.length && (
                        <span className="u-meta">
                          {t("latest {n} of {total}", { n: affected.length, total: focus.games })}
                        </span>
                      )}
                    </>
                  )}
                  <Button variant="ghost" size="sm" icon={<Target size={13} />} className="home-focus__train" onClick={onGoTraining}>
                    {t("Train camera control")}
                  </Button>
                </div>
              </section>
            ) : (
              <section className="card home-focus home-focus--empty" aria-labelledby="home-focus-lbl">
                <span id="home-focus-lbl" className="u-label">{t("What to work on")}</span>
                <p className="home-prose">
                  {t("Nothing to point at yet. Record a few games and this turns into the one thing worth working on.")}
                </p>
              </section>
            )}
          </div>

          {/* ============================================== columna derecha */}
          <aside className="home-col">
            {/* ------------------------------------------------- señales */}
            <section className="card home-signals" aria-labelledby="home-sig-lbl">
              <span id="home-sig-lbl" className="u-label">{t("Signals")}</span>
              <div className="home-sig__list">
                {/* CUÁNDO te mueres lo dice el foco; esto dice HACIA DÓNDE no miras. */}
                <div className="home-sig">
                  <div className="home-sig__text">
                    <div className="home-sig__title">{t("Blind spot")}</div>
                    <div className="u-meta">{ciegoMeta}</div>
                  </div>
                  <span className="u-metric home-sig__v">{ciegoOk ? laneLabel(ciego!.lane, t) : "—"}</span>
                </div>

                {/* Lo que compró tu presencia: el número que nadie más te cuenta. */}
                <div className="home-sig">
                  <div className="home-sig__text">
                    <div className="home-sig__title">{t("Pressure absorbed")}</div>
                    <div className="u-meta">
                      {presionMeta}
                      {pressureError && (
                        <>
                          {" · "}
                          <button type="button" className="home-link" onClick={retryPressure}>{t("Retry")}</button>
                        </>
                      )}
                    </div>
                  </div>
                  <span className="u-metric home-sig__v">{presionOk ? presion!.windows : "—"}</span>
                </div>

                <div className="home-sig">
                  <div className="home-sig__text">
                    <div className="home-sig__title">{t("Trend")}</div>
                    <div className="u-meta">{trendMeta}</div>
                  </div>
                  <span className="home-sig__vwrap">
                    <span className="u-metric home-sig__v">
                      {trend && trend.wr != null ? `${Math.round(trend.wr * 100)} %` : "—"}
                    </span>
                    {trendDelta != null && (
                      <span className={`u-meta ${trendDelta >= 0 ? "home-win" : "home-loss"}`}>
                        {trendDelta >= 0 ? "+" : "−"}{Math.abs(trendDelta)} {t("pts")}
                      </span>
                    )}
                  </span>
                </div>
              </div>

              <button type="button" className="home-link home-link--nav" onClick={() => navigate("/patterns")}>
                {t("See in Patterns")}
              </button>

              {/* Todo lo que antes se desplegaba por defecto: qué mide cada
                  señal y la evidencia de presión episodio a episodio. */}
              <details className="home-details home-details--signals">
                <summary>{t("What does this measure?")}</summary>
                <div className="home-details__prose">
                  <p className="home-prose home-prose--sm">
                    <span className="u-label">{t("Blind spot")}</span> {ciegoDetalle}
                  </p>
                  <p className="home-prose home-prose--sm">
                    <span className="u-label">{t("Pressure absorbed")}</span>{" "}
                    {presionOk &&
                      `${t("{yes} with gains · {no} without gains · {games} analysed games", { yes: presion!.with_gains, no: presion!.without_gains, games: presion!.games })}. `}
                    {presionOk
                      ? t("Every event is counted once per player and match. Both views use the same episodes, refined with video when available. Benefits are associations, not personal credit.")
                      : t("Pressure is read from the enemy positions of your synced games. It appears once a few games have synced with Riot.")}
                  </p>
                  <p className="home-prose home-prose--sm">
                    <span className="u-label">{t("Trend")}</span>{" "}
                    {trend && trend.pctPrev != null && trend.pct != null
                      ? `${t("avg impact percentile")}: ${trend.pct >= trend.pctPrev ? "+" : "−"}${Math.abs(Math.round(trend.pct - trend.pctPrev))}. `
                      : trend ? `${t("needs impact on more games")}. ` : ""}
                    {t("From your recorded games only. Two windows of ten: it points at a direction, it doesn't grade you.")}
                  </p>
                  {presion && presion.episodes?.length > 0 && (
                    <div className="home-episodes">
                      <span className="u-label">{t("Pressure evidence · {n} episodes", { n: presion.windows })}</span>
                      {presion.episodes.map((episode) => {
                        const recorded = matches.find((m) => m.id === episode.match_id);
                        return (
                          <PressureEpisodeCard
                            key={episode.match_id + ":" + episode.game_start}
                            window={episode.window}
                            gameStart={episode.game_start}
                            gameEnd={episode.game_end}
                            label={`${episode.window.champion} · ${relativeDay(episode.date, t)}`}
                            onSeek={recorded?.video_path ? (seconds) => { setPendingSeek(seconds); onOpenMatch(recorded); } : undefined}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              </details>
            </section>

            {/* ---------------------------------------------- por revisar */}
            <section className="card home-review" aria-labelledby="home-rev-lbl">
              <div className="home-review__head">
                <span id="home-rev-lbl" className="u-label">
                  {t("To review")}
                  {pendientes.length > 0 && ` · ${pendientes.length} ${t("games")}`}
                </span>
                <button type="button" className="home-link home-link--nav" onClick={() => verBiblioteca("unreviewed")}>
                  {t("See all")}
                </button>
              </div>

              {toReview.length > 0 ? (
                <div className="home-review__list">
                  {toReview.map((m) => {
                    const r = outcome(m.result);
                    const prog = reviewProgress(m, errorClips);
                    const pct = prog.total > 0 ? Math.min(100, (prog.done / prog.total) * 100) : 0;
                    return (
                      <button key={m.id} type="button" className="home-row" onClick={() => onOpenMatch(m)}>
                        <ChampionAvatar champion={m.champion} size={32} />
                        <span className="home-row__text">
                          <span className="home-row__name">
                            {m.champion}
                            <span className={`home-row__res ${resultadoClase(r)}`}>{resultadoTexto(r)}</span>
                          </span>
                          <span className="u-meta">{relativeDay(m.date, t)} · {formatDuration(m.game_duration)}</span>
                        </span>
                        <span className="home-row__prog">
                          <span className="u-meta">{prog.done} / {prog.total}</span>
                          <span
                            className="home-prog"
                            role="progressbar"
                            aria-label={t("moments reviewed")}
                            aria-valuemin={0}
                            aria-valuemax={prog.total}
                            aria-valuenow={prog.done}
                          >
                            <i style={{ width: `${pct}%` }} />
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                /* La cola vacía es el estado bueno y merece decirse. */
                <p className="home-prose home-review__empty">
                  <CircleDot size={12} className="home-review__ok" />
                  {t("Nothing pending: you went through every recorded game.")}
                </p>
              )}

              {pendientes.length > toReview.length && (
                <p className="u-meta home-review__more">
                  {t("And {n} more.", { n: pendientes.length - toReview.length })}
                </p>
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
};
