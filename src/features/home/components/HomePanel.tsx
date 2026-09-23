import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { MatchMetadata } from "../../../types";
import {
  getBlindSpot,
  getCameraLooks,
  checkRiotKey,
  syncMatchNow,
  type BlindSpot,
  type CameraLook,
} from "../../../core/tauri-ipc";
import { mmss, relativeDay, matchAge } from "../../../core/time";
import { currentFocus, deathClock, confidenceOf, sampleLabel, BUCKET_SECONDS } from "../../../core/patterns";
import { outcome, formatDuration, computeKDA, kdaRatio, lpDeltas, queueKey, type KDA } from "../../../core/matchStats";
import { reviewProgress } from "../../../core/review";
import { laneLabel } from "../../../core/lanes";
import { rankIcon } from "../../../core/ddragon";
import { useCurrentRank } from "../../../core/useCurrentRank";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { ChampionWash } from "../../../components/ChampionWash";
import { PositionIcon } from "../../../components/PositionIcon";
import { Button } from "../../../components/ui/Button";
import { useAppStore, useErrorClips } from "../../../store/useAppStore";
import { Check, ChevronRight, CircleDot, KeyRound, Loader2, Play, RefreshCw, Target, Wand2 } from "lucide-react";
import { useLang } from "../../../core/LanguageProvider";
import "./HomePanel.css";
import { usePressureSummary } from "../../player/usePressureSummary";
import { PressureEpisodeCard } from "../../player/components/PressureEpisodeCard";
import { formatGold, formatSeconds } from "../../player/components/pressureFormat";
import { useOnboarding } from "../../onboarding/useOnboarding";
import { MomentCard } from "./MomentCard";
import { ChampionTile } from "./ChampionTile";
import { eventCount, pendingMoments, reviewMinutes, teachMoments } from "../moments";
import {
  fmtNum,
  impactPhrase,
  isApex,
  isToday,
  laneTitle,
  longDate,
  nextRank,
  ordinal,
  positionName,
  rankText,
} from "../format";

/**
 * Hoy: la sala post-partida.
 *
 * Se lee de arriba abajo en el orden en que se piensa al acabar una partida:
 *
 *  1. El héroe — cómo fue la última (resultado, LP, rango, cifras, tu puesto
 *     de impacto) y UNA acción: revisar sus momentos clave, o la siguiente
 *     partida por revisar si esta ya está hecha.
 *  2. Los tres momentos que más enseñan — el peor error, el hallazgo del
 *     analizador y la mejor jugada, cada uno abre el vídeo en su segundo.
 *  3. Tres señales en frases — punto ciego, presión que absorbes, impacto.
 *  4. A la derecha, el foco de la semana (el tramo en que más mueres) y la
 *     forma reciente con la cola de partidas por revisar.
 *
 * Lo que no cabe en esa lectura (detalles de la partida, qué mide cada señal,
 * la evidencia de presión episodio a episodio, dónde ocurrió el foco) vive en
 * un <details> discreto al final: se reubica, no se pierde.
 *
 * El estado de captura (grabando, clave de Riot, disco) no vive aquí: está en
 * la barra de título y se ve desde cualquier sección.
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
/** Retratos de la forma reciente. */
const FORM_GAMES = 9;

/** El KDA guardado ("9/3/12") o el contado de los eventos: el mismo criterio que la biblioteca. */
const kdaOf = (m: MatchMetadata): KDA => {
  if (m.kda) {
    const [k, d, a] = m.kda.split("/").map((x) => parseInt(x, 10));
    if ([k, d, a].every(Number.isFinite)) return { kills: k, deaths: d, assists: a };
  }
  return computeKDA(m.events);
};

export const HomePanel: React.FC<HomePanelProps> = ({ matches, onOpenMatch, onGoTraining }) => {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const setLibraryFilter = useAppStore((s) => s.setLibraryFilter);
  const refreshMatches = useAppStore((s) => s.refreshMatches);
  const setPendingSeek = useAppStore((s) => s.setPendingSeek);
  const { clips: errorClips } = useErrorClips();
  const { restart: abrirAsistente } = useOnboarding();

  const [ciego, setCiego] = useState<BlindSpot | null>(null);
  const [ciegoFallo, setCiegoFallo] = useState(false);
  const { data: presion, error: pressureError, retry: retryPressure } = usePressureSummary("/home");
  // Arriba del todo, con el resto de hooks: más abajo hay un return anticipado
  // (sin partidas) y un hook detrás de él rompe el orden (error #310 de React).
  const rankNow = useCurrentRank();
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [mant, setMant] = useState<MaintenanceProgress | null>(null);
  const [sincronizando, setSincronizando] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [looks, setLooks] = useState<CameraLook[]>([]);

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
  const porFecha = useMemo(() => [...own].sort((a, b) => (a.date < b.date ? 1 : -1)), [own]);
  const ultima = porFecha[0] ?? null;
  const lp = useMemo(() => lpDeltas(own), [own]);
  const hoy = useMemo(() => own.filter((m) => isToday(m.date)).length, [own]);

  // Las miradas al mapa de la última partida: de ahí sale el hueco más largo
  // sin mirar un carril, uno de los hallazgos candidatos.
  const ultimaId = ultima?.id ?? null;
  useEffect(() => {
    if (!ultimaId) return;
    let vivo = true;
    getCameraLooks(ultimaId)
      .then((l) => vivo && setLooks(Array.isArray(l) ? l : []))
      .catch(() => vivo && setLooks([]));
    return () => { vivo = false; };
  }, [ultimaId]);

  /** Las partidas donde ocurre la debilidad, de más reciente a más antigua. */
  const affected = useMemo(() => {
    if (!focus) return [];
    const { from, to } = focus.bucket;
    return porFecha
      .filter((m) => {
        const off = m.video_offset ?? 0;
        return m.events.some((ev) => {
          if (ev.type !== "ChampionKill" || ev.subtype !== "death") return false;
          const min = Math.max(0, ev.time - off) / 60;
          return min >= from && min < to;
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

  /**
   * La acción oro: revisar los momentos pendientes de la última partida, o, si
   * ya está revisada (o no tiene vídeo), los de la siguiente partida por revisar.
   * Mismo criterio de "momento por revisar" que la cola del reproductor.
   */
  const objetivo = useMemo(() => {
    const candidatas = ultima ? [ultima, ...pendientes.filter((m) => m.id !== ultima.id)] : pendientes;
    for (const m of candidatas) {
      if (!m.video_path) continue;
      if (reviewProgress(m, errorClips).reviewed) continue;
      const mom = pendingMoments(m, errorClips);
      if (mom.length > 0) return { match: m, moments: mom, next: m.id !== ultima?.id };
    }
    return null;
  }, [ultima, pendientes, errorClips]);

  const momentos = useMemo(
    () =>
      ultima
        ? teachMoments({
            match: ultima,
            errorClips,
            episodes: presion?.episodes ?? [],
            looks,
            focusWindow: focus ? { from: focus.bucket.from, to: focus.bucket.to } : null,
            t,
          })
        : [],
    [ultima, errorClips, presion, looks, focus, t]
  );

  /** Tendencia: las 10 últimas contra las 10 anteriores, solo con lo local. */
  const trend = useMemo(() => {
    const ult = porFecha.slice(0, 10);
    const ant = porFecha.slice(10, 20);
    if (ult.length < 3) return null;
    const wr = (xs: MatchMetadata[]) =>
      xs.length ? xs.filter((m) => outcome(m.result) === "victory").length / xs.length : null;
    const pcts = (xs: MatchMetadata[]) => xs.map((m) => m.impact_percentile).filter((x): x is number => x != null);
    const pct = (xs: MatchMetadata[]) => {
      const v = pcts(xs);
      return v.length >= 3 ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const hayAnt = ant.length >= 3;
    return {
      n: ult.length,
      nPrev: ant.length,
      nPct: pcts(ult).length,
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

  /** Abre una partida en un segundo del vídeo (el reproductor retrocede 5 s solo). */
  const abrirEn = useCallback(
    (m: MatchMetadata, seconds: number | null) => {
      if (seconds != null && m.video_path) setPendingSeek(seconds);
      onOpenMatch(m);
    },
    [onOpenMatch, setPendingSeek]
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
  const irAClave = () => navigate("/settings?cat=account");
  const textoClave = keyStatus === "missing" ? t("Add your Riot key") : t("Fix your Riot key");

  /* ------------------------------------------------------------ cabecera */
  const cabecera = (
    <header className="home-head">
      <h1 className="home-h1">{t("Today")}</h1>
      <span className="home-sub">
        {longDate(lang)}
        {own.length > 0 && (
          <>
            {" · "}
            {hoy === 0 ? t("no games yet today") : hoy === 1 ? t("1 game") : t("{n} games", { n: hoy })}
          </>
        )}
      </span>
      {/* El mantenimiento de arranque, en voz baja: no se puede pulsar nada y
          termina solo, pero explica por qué la biblioteca se mueve sola. */}
      {mant && (
        <span className="home-mant" role="status">
          <Loader2 size={13} className="home-spin" />
          {t("Updating library")}
          {mant.total > 0 ? ` ${mant.done}/${mant.total}` : ""}
        </span>
      )}
    </header>
  );

  /* --------------------------------------------------------- sin partidas */
  if (own.length === 0 || !ultima) {
    return (
      <div className="panel-enter home-panel">
        <div className="home-page">
          {cabecera}
          <section className="home-hero home-hero--empty">
            <div className="home-empty">
              <h2 className="home-empty__title">{t("Play a game — it records itself")}</h2>
              <p className="home-prose">
                {t("LeagueRecorder watches for the League client. When a game starts it begins recording, and when it ends it syncs with Riot and files the game here. There is nothing to press.")}
              </p>
              <div className="home-empty__actions">
                <Button variant="primary" className="home-btn" icon={<Wand2 size={15} />} onClick={() => { abrirAsistente().catch(console.error); }}>
                  {t("Open the setup assistant")}
                </Button>
                <Button variant="ghost" className="home-btn" icon={<Play size={14} />} onClick={() => navigate("/settings?cat=recording")}>
                  {t("10-second test")}
                </Button>
                {claveMal && (
                  <Button variant="ghost" className="home-btn" icon={<KeyRound size={14} />} onClick={irAClave}>
                    {textoClave}
                  </Button>
                )}
                <Button variant="ghost" className="home-btn" onClick={() => navigate("/vod")}>
                  {t("Import a VOD")}
                </Button>
              </div>
              <p className="home-prose home-prose--faint">
                {keyStatus === "ok"
                  ? t("Your Riot key is working: the scoreboard, your rank and your impact score will be there from the first game.")
                  : t("Without a Riot key the app still records and tracks your games; the scoreboard, rank and impact score need one.")}
              </p>
            </div>
          </section>
        </div>
      </div>
    );
  }

  /* -------------------------------------------------------------- héroe */
  const res = outcome(ultima.result);
  const parts = ultima.participants ?? [];
  const yo = parts.find((p) => p.is_self) ?? null;
  const kda = kdaOf(ultima);
  const sinVideo = ultima.video_path === "";
  const sinScoreboard = parts.length === 0;
  const deltaLp = lp.get(ultima.id);
  const progUltima = reviewProgress(ultima, errorClips);
  const rol = yo?.role ?? null;
  const rolNombre = positionName(rol, t);
  const minutos = ultima.game_duration / 60;

  // Participación en kills: solo con el marcador completo, que es el que tiene
  // las kills de todo tu equipo.
  const killsEquipo =
    yo && parts.length >= 10
      ? parts.filter((p) => p.team_id === yo.team_id).reduce((a, p) => a + p.kills, 0)
      : 0;
  const kp = killsEquipo > 0 ? Math.round(((kda.kills + kda.assists) / killsEquipo) * 100) : null;
  const ratio = kdaRatio(kda);
  const ratioTxt = ratio === "Perfect" ? t("Perfect") : fmtNum(Number(ratio), lang, 2);

  // Rango: el de Riot en vivo, el mismo que el rail y Patrones; sin conexión,
  // el de la última partida grabada que lo trae (una normal no lo lleva).
  const tier = rankNow?.tier ?? null;
  const divisionRango = rankNow?.division ?? undefined;
  const lpRango = rankNow?.lp ?? null;
  const siguiente = tier ? nextRank(tier, divisionRango, t) : null;

  const resultadoTexto =
    res === "victory" ? t("Victory") : res === "defeat" ? t("Defeat") : t("No result");
  const tono = res === "victory" ? "win" : res === "defeat" ? "loss" : "none";

  const accionOro = objetivo
    ? objetivo.next
      ? {
          label: t("Review next game"),
          aside: `${objetivo.match.champion} · ~${reviewMinutes(objetivo.moments.length)} min`,
        }
      : {
          label:
            objetivo.moments.length === 1
              ? t("Review 1 key moment")
              : t("Review {n} key moments", { n: objetivo.moments.length }),
          aside: `~${reviewMinutes(objetivo.moments.length)} min`,
        }
    : null;

  /* ----------------------------------------------------------- señales */
  const ciegoOk = !!ciego && ciego.games_worst >= 3 && ciego.avg_gap_secs >= 90;
  const presionOk = !!presion && presion.windows > 0;
  const nEventos = eventCount(ultima);
  const recientes = porFecha.slice(0, FORM_GAMES);
  const ganadas = recientes.filter((m) => outcome(m.result) === "victory").length;
  const perdidas = recientes.filter((m) => outcome(m.result) === "defeat").length;
  const trendDelta =
    trend && trend.wrPrev != null && trend.wr != null ? Math.round((trend.wr - trend.wrPrev) * 100) : null;

  const focoFrase = (() => {
    if (!focus) return "";
    const vars = {
      n: focus.bucket.total,
      total: clock.total,
      pct: Math.round(focus.share * 100),
    };
    if (focus.bucket.to <= 15) return t("{n} of your {total} deaths ({pct}%) fall in that stretch, during the laning phase.", vars);
    if (focus.bucket.from >= 25) return t("{n} of your {total} deaths ({pct}%) fall in that stretch, in the late game.", vars);
    return t("{n} of your {total} deaths ({pct}%) fall in that stretch, when the objective fights start.", vars);
  })();

  return (
    <div className="panel-enter home-panel">
      <div className="home-page">
        {cabecera}

        {/* ================================================== héroe */}
        <section className={`home-hero home-hero--${tono}`} aria-labelledby="home-hero-lbl">
          <ChampionWash champion={ultima.champion} intensity={0.55} />
          <div className="home-hero__in">
            <div className="home-hero__top">
              <div className="home-hero__portrait">
                <ChampionAvatar champion={ultima.champion} size={96} />
                {yo?.level ? <span className="home-hero__lvl">{yo.level}</span> : null}
              </div>

              <div className="home-hero__who">
                <span id="home-hero-lbl" className="home-hero__kicker">
                  {t("Last game")} · {t(queueKey(ultima.queue))} · {matchAge(ultima.date, t)}
                </span>
                <div className="home-hero__resrow">
                  <span className="home-hero__res">{resultadoTexto}</span>
                  {deltaLp != null && (
                    <span className={`home-hero__lp ${deltaLp > 0 ? "is-win" : deltaLp < 0 ? "is-loss" : ""}`}>
                      {deltaLp > 0 ? "+" : deltaLp < 0 ? "−" : "±"}
                      {Math.abs(deltaLp)} LP
                    </span>
                  )}
                </div>
                <span className="home-hero__line">
                  {ultima.champion}
                  <span className="home-hero__faint">
                    {rolNombre && (
                      <>
                        {" · "}
                        <PositionIcon position={rol} size={14} />
                        {" "}
                        {rolNombre}
                      </>
                    )}
                    {" · "}
                    {formatDuration(ultima.game_duration)}
                    {ultima.patch ? ` · ${t("patch {v}", { v: ultima.patch })}` : ""}
                  </span>
                </span>
                {(progUltima.reviewed || sinScoreboard || claveMal) && (
                  <span className="home-hero__status">
                    {progUltima.reviewed && (
                      <span className="home-pill home-pill--win">
                        <Check size={12} />
                        {t("Game reviewed")}
                      </span>
                    )}
                    {sinScoreboard && (
                      <button type="button" className="home-link" onClick={sincronizar} disabled={sincronizando}>
                        <RefreshCw size={12} className={sincronizando ? "home-spin" : undefined} />
                        {sincronizando ? t("Syncing…") : t("Sync with Riot")}
                      </button>
                    )}
                    {claveMal && (
                      <button type="button" className="home-link home-link--warn" onClick={irAClave}>
                        <KeyRound size={12} />
                        {textoClave}
                      </button>
                    )}
                  </span>
                )}
              </div>

              {/* Rango actual: lo primero que un jugador reconoce como suyo. */}
              {tier && (
                <div className="home-rank">
                  <img
                    className="home-rank__crest"
                    src={rankIcon(tier)}
                    alt=""
                    onError={(e) => ((e.currentTarget.style.visibility = "hidden"))}
                  />
                  <div className="home-rank__txt">
                    <div className="home-rank__row">
                      <span className="home-rank__name" title={rankNow && !rankNow.live && rankNow.date ? t("Rank from your last recorded game ({date})", { date: rankNow.date.slice(0, 10) }) : undefined}>{rankText(tier, divisionRango, t)}</span>
                      {lpRango != null && <span className="home-rank__lp">{lpRango} LP</span>}
                    </div>
                    {lpRango != null && !isApex(tier) && (
                      <>
                        <div
                          className="home-rank__track"
                          role="progressbar"
                          aria-label={t("LP towards the next division")}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.min(100, Math.max(0, lpRango))}
                        >
                          <i style={{ width: `${Math.min(100, Math.max(0, lpRango))}%` }} />
                        </div>
                        {siguiente && lpRango < 100 && (
                          <span className="home-rank__next">
                            {t("{n} LP to {rank}", { n: 100 - lpRango, rank: siguiente })}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="home-hero__bottom">
              {/* Cifras de la partida: sans con números tabulares. */}
              <div className="home-stats">
                <div className="home-stat">
                  <span className="home-stat__k">{t("KDA")}</span>
                  <span className="home-stat__v">{kda.kills} / {kda.deaths} / {kda.assists}</span>
                  <span className="home-stat__s">
                    {kp != null
                      ? t("{r} KDA · {p}% kill participation", { r: ratioTxt, p: kp })
                      : t("{r} KDA", { r: ratioTxt })}
                  </span>
                </div>
                <div className="home-stat">
                  <span className="home-stat__k">{t("Minions")}</span>
                  <span className="home-stat__v">{yo ? yo.cs : "—"}</span>
                  <span className="home-stat__s">
                    {yo && minutos > 0
                      ? t("{n} per minute", { n: fmtNum(yo.cs / minutos, lang, 1) })
                      : t("needs a Riot sync")}
                  </span>
                </div>
                <div className="home-stat home-stat--wide">
                  <span className="home-stat__k">{t("Impact in the game")}</span>
                  {ultima.impact_rank != null ? (
                    <>
                      <span className="home-stat__v">
                        {ordinal(ultima.impact_rank, lang)} <small>{t("of 10")}</small>
                      </span>
                      <span className="home-stat__s">
                        {ultima.impact_rank === 1
                          ? t("MVP of the game")
                          : ultima.impact_percentile != null
                            ? impactPhrase(rol, Math.round(ultima.impact_percentile), t)
                            : t("of 10 by impact")}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="home-stat__v">—</span>
                      <span className="home-stat__s">{t("impact not computed yet")}</span>
                    </>
                  )}
                </div>
              </div>

              <div className="home-hero__actions">
                <Button variant="ghost" className="home-btn" onClick={() => onOpenMatch(ultima)}>
                  {sinVideo ? t("Open this game") : t("See full game")}
                </Button>
                {objetivo && accionOro && (
                  <Button
                    variant="primary"
                    className="home-btn home-btn--gold"
                    icon={<Play size={14} fill="currentColor" />}
                    onClick={() => abrirEn(objetivo.match, objetivo.moments[0].time)}
                    title={objetivo.next ? t("This game is reviewed: next up is the most recent one still pending.") : undefined}
                  >
                    {accionOro.label}
                    <span className="home-btn__aside">{accionOro.aside}</span>
                  </Button>
                )}
              </div>
            </div>

            {sinVideo && (
              <p className="home-note">
                {t("Tracked without video — the recording could not start, so only the data of this game was kept.")}
              </p>
            )}
            {syncError && <p className="home-note home-loss">{syncError}</p>}
          </div>
        </section>

        <div className="home-grid">
          {/* ============================================ columna izquierda */}
          <div className="home-col">
            <section className="home-sec" aria-labelledby="home-mo-lbl">
              <div className="home-sec__head">
                <h2 id="home-mo-lbl" className="home-h2">
                  {momentos.length === 3 ? t("The 3 moments that teach you the most") : t("The moments that teach you the most")}
                </h2>
                {nEventos > 0 && (
                  <button type="button" className="home-link" onClick={() => onOpenMatch(ultima)}>
                    {t("See all {n} events", { n: nEventos })}
                  </button>
                )}
              </div>
              {momentos.length > 0 ? (
                <div className="home-mo-grid">
                  {momentos.map((m) => (
                    <MomentCard key={`${m.kind}:${m.time}`} moment={m} onPlay={() => abrirEn(ultima, m.time)} />
                  ))}
                </div>
              ) : (
                <p className="home-card home-card--quiet home-prose">
                  {t("This game has no events to learn from yet. They appear once it records or syncs with Riot.")}
                </p>
              )}
            </section>

            {/* Señales, en frases. */}
            <div className="home-sig-grid">
              {/* CUÁNDO te mueres lo dice el foco; esto dice HACIA DÓNDE no miras. */}
              <button type="button" className="home-card home-sig" onClick={() => navigate("/patterns")}>
                <span className="home-card__label">{t("Blind spot")}</span>
                <span className="home-sig__title">
                  {ciegoOk
                    ? laneTitle(ciego!.lane, t)
                    : ciegoFallo
                      ? t("Couldn't read your camera looks")
                      : !ciego
                        ? t("No camera data yet")
                        : t("No lane stands out yet")}
                </span>
                <span className="home-sig__body">
                  {ciegoOk
                    ? t("You go {avg} without looking at it, on average. In {n} of {total} games.", {
                        avg: mmss(ciego!.avg_gap_secs),
                        n: ciego!.games_worst,
                        total: ciego!.games,
                      })
                    : ciegoFallo
                      ? t("The look reports are on disk but could not be read this time. It retries on the next visit.")
                      : !ciego
                        ? t("This comes from the minimap looks detected in your recorded games. It appears once a game has been analysed.")
                        : t("Across {games} games with look data, no lane is clearly the worst yet ({n} games and a 1:30 gap are needed).", {
                            games: ciego!.games,
                            n: 3,
                          })}
                </span>
              </button>

              {/* Lo que compró tu presencia: el número que nadie más te cuenta. */}
              {pressureError ? (
                <div className="home-card home-sig">
                  <span className="home-card__label">{t("Pressure you absorb")}</span>
                  <span className="home-sig__title">{t("Couldn't load pressure evidence")}</span>
                  <span className="home-sig__body">
                    <button type="button" className="home-link" onClick={retryPressure}>{t("Retry")}</button>
                  </span>
                </div>
              ) : (
                <button type="button" className="home-card home-sig" onClick={() => navigate("/patterns")}>
                  <span className="home-card__label">{t("Pressure you absorb")}</span>
                  <span className="home-sig__title">
                    {presionOk && presion!.net_gold != null
                      ? t("{time} of enemy time per game", { time: formatSeconds(presion!.enemy_seconds / Math.max(1, presion!.games)) })
                      : presionOk
                        ? t("You draw enemies {n} times", { n: presion!.windows })
                        : presion && presion.games > 0
                          ? t("No episodes yet")
                          : t("Nothing measured yet")}
                  </span>
                  <span className="home-sig__body">
                    {presionOk && presion!.net_gold != null
                      ? (() => {
                          // Lo que creas (farmeo que les quitas + lo que saca tu
                          // equipo lejos) frente a lo que se va en la pelea donde
                          // estás. El neto es la suma de las dos, por partida.
                          const g = Math.max(1, presion!.games);
                          const creas = (presion!.farm_denied + presion!.team_elsewhere) / g;
                          const neto = presion!.net_gold / g;
                          return t("Worth {net} gold per game: you create {created} and lose {lost} in the fight where you are.", {
                            net: formatGold(neto, true),
                            created: formatGold(creas, true),
                            lost: formatGold(neto - creas, true),
                          });
                        })()
                      : presionOk
                      ? t("Meanwhile your team takes {towers} towers and {gold}k gold elsewhere, across {games} games.", {
                          towers: presion!.towers,
                          gold: fmtNum(presion!.gold / 1000, lang, 1),
                          games: presion!.games,
                        })
                      : presion && presion.games > 0
                        ? t("{games} games analysed; no qualifying episodes.", { games: presion.games })
                        : t("Pressure is read from the enemy positions of your synced games. It appears once a few games have synced with Riot.")}
                  </span>
                </button>
              )}

              <button type="button" className="home-card home-sig" onClick={() => navigate("/patterns")}>
                <span className="home-card__label">{t("Your average impact")}</span>
                <span className="home-sig__title">
                  {trend && trend.pct != null
                    ? t("Better than {p}%", { p: Math.round(trend.pct) })
                    : t("Not computed yet")}
                </span>
                <span className="home-sig__body">
                  {trend && trend.pct != null
                    ? t("Of players in your role, across {n} recent games.", { n: trend.nPct })
                    : t("Impact is computed when you open a game's Impact tab. It shows here after three games.")}
                </span>
              </button>
            </div>
          </div>

          {/* ============================================== columna derecha */}
          <aside className="home-col">
            <section className="home-card home-focus" aria-labelledby="home-focus-lbl">
              <div className="home-card__head">
                <span id="home-focus-lbl" className="home-card__label">{t("Your focus this week")}</span>
                {focus && (
                  <span className="home-pill home-pill--gold">
                    {sampleLabel(conf, own.length, t)}
                  </span>
                )}
              </div>

              {focus ? (
                <>
                  <div className="home-focus__text">
                    <span className="home-focus__title">
                      {t("You die most between minutes {a} and {b}", { a: focus.bucket.from, b: focus.bucket.to })}
                    </span>
                    <span className="home-focus__why">{focoFrase}</span>
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
                    <div className="home-bars__axis">
                      {HISTO_FROM.map((f, i) => (
                        <span key={f} className={i === focoIdx ? "home-flag" : undefined}>
                          {i === HISTO_FROM.length - 1 ? `${f}'+` : `${f}'`}
                        </span>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <p className="home-focus__why">
                  {t("Nothing to point at yet. Record a few games and this turns into the one thing worth working on.")}
                </p>
              )}

              {/* Sin nada por revisar, la acción de la pantalla pasa a ser entrenar. */}
              {objetivo ? (
                <button type="button" className="home-sbtn" onClick={onGoTraining}>
                  <Target size={16} className="home-sbtn__icon" />
                  {t("Train camera control")}
                </button>
              ) : (
                <Button variant="primary" className="home-btn home-btn--block" icon={<Target size={16} />} onClick={onGoTraining}>
                  {t("Train camera control")}
                </Button>
              )}
            </section>

            <section className="home-card home-form" aria-labelledby="home-form-lbl">
              <div className="home-card__head">
                <span id="home-form-lbl" className="home-card__label">{t("Recent form")}</span>
                <span className="home-form__wl">
                  <span className="home-win">{t("{n} W", { n: ganadas })}</span>
                  <span className="home-form__dot">·</span>
                  <span className="home-loss">{t("{n} L", { n: perdidas })}</span>
                </span>
              </div>
              <div className="home-form__strip">
                {recientes.map((m, i) => {
                  const r = outcome(m.result);
                  const rev = !pendientes.some((p) => p.id === m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      className={`home-form__game${i === 0 ? " is-last" : ""}`}
                      onClick={() => onOpenMatch(m)}
                      title={`${m.champion} · ${r === "victory" ? t("Victory") : r === "defeat" ? t("Defeat") : t("No result")} · ${relativeDay(m.date, t)}${rev ? "" : ` · ${t("to review")}`}`}
                    >
                      <ChampionTile champion={m.champion} size={34} fluid />
                      <span className={`home-form__bar home-form__bar--${r}`} />
                    </button>
                  );
                })}
              </div>
              <div className="home-form__sep" />
              {pendientes.length > 0 ? (
                <button type="button" className="home-form__queue" onClick={() => verBiblioteca("unreviewed")}>
                  <span>
                    {pendientes.length === 1
                      ? t("1 game to review")
                      : t("{n} games to review", { n: pendientes.length })}
                  </span>
                  <span className="home-form__open">
                    {t("Open the queue")}
                    <ChevronRight size={14} />
                  </span>
                </button>
              ) : (
                /* La cola vacía es el estado bueno y merece decirse. */
                <p className="home-form__done">
                  <CircleDot size={12} className="home-win" />
                  {t("Nothing pending: you went through every recorded game.")}
                </p>
              )}
            </section>
          </aside>
        </div>

        {/* ======================= lo que no cabe en la lectura principal */}
        <details className="home-more">
          <summary>{t("More about this game and your signals")}</summary>
          <div className="home-more__body">
            <div className="home-more__col">
              <h3 className="home-h3">{t("Performance details")}</h3>
              <dl className="home-dl">
                {ultima.lane_result && (
                  <div>
                    <dt>{t("lane")}</dt>
                    {/* Los tres valores del backend son claves inglesas
                        ("Win"/"Loss"/"Even") que se usan en más sitios; se
                        traducen por su significado AQUÍ. */}
                    <dd className={ultima.lane_result === "Win" ? "home-win" : ultima.lane_result === "Loss" ? "home-loss" : undefined}>
                      {t(ultima.lane_result === "Win" ? "won" : ultima.lane_result === "Loss" ? "lost" : "even")}
                    </dd>
                  </div>
                )}
                {ultima.gold_diff_15 != null && (
                  <div>
                    <dt>{t("gold @15")}</dt>
                    <dd className={ultima.gold_diff_15 >= 0 ? "home-win" : "home-loss"}>
                      {ultima.gold_diff_15 >= 0 ? "+" : "−"}
                      {Math.abs(ultima.gold_diff_15)}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>{t("moments reviewed")}</dt>
                  <dd>{progUltima.done} / {progUltima.total}</dd>
                </div>
                <div>
                  <dt>{t("Riot")}</dt>
                  <dd>
                    {sinScoreboard ? (
                      <button type="button" className="home-link" onClick={sincronizar} disabled={sincronizando}>
                        {sincronizando ? t("Syncing…") : t("Sync with Riot")}
                      </button>
                    ) : (
                      t("Synced with Riot")
                    )}
                  </dd>
                </div>
                {trend && trend.wr != null && (
                  <div>
                    <dt>{t("Win rate")}</dt>
                    <dd>
                      {Math.round(trend.wr * 100)} %
                      {trendDelta != null && (
                        <span className={trendDelta >= 0 ? "home-win" : "home-loss"}>
                          {" "}
                          {t("({d} pts vs the {p} before)", {
                            d: `${trendDelta >= 0 ? "+" : "−"}${Math.abs(trendDelta)}`,
                            p: trend.nPrev,
                          })}
                        </span>
                      )}
                    </dd>
                  </div>
                )}
              </dl>

              {affected.length > 0 && focus && (
                <>
                  <h3 className="home-h3">
                    {t("Where it happened: deaths between minutes {a} and {b}", { a: focus.bucket.from, b: focus.bucket.to })}
                  </h3>
                  <div className="home-chips">
                    {affected.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className="home-chip"
                        onClick={() => onOpenMatch(m)}
                        title={`${m.champion} · ${relativeDay(m.date, t)}`}
                      >
                        <ChampionAvatar champion={m.champion} size={20} />
                        {m.champion}
                        <span className="home-chip__meta">{relativeDay(m.date, t)}</span>
                      </button>
                    ))}
                    {focus.games > affected.length && (
                      <span className="home-chip__meta">
                        {t("latest {n} of {total}", { n: affected.length, total: focus.games })}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="home-more__col">
              <h3 className="home-h3">{t("What does this measure?")}</h3>
              <p className="home-prose home-prose--sm">
                <strong>{t("Blind spot")}.</strong>{" "}
                {ciegoOk
                  ? t("{lane} is the lane you leave unwatched the longest, in {n} of your last {total} games.", {
                      lane: laneLabel(ciego!.lane, t),
                      n: ciego!.games_worst,
                      total: ciego!.games,
                    }) +
                    " " +
                    t("On average {avg} without a single look; your worst was {worst}.", {
                      avg: mmss(ciego!.avg_gap_secs),
                      worst: mmss(ciego!.worst_gap_secs),
                    })
                  : t("This comes from the minimap looks detected in your recorded games. It appears once a game has been analysed.")}
              </p>
              <p className="home-prose home-prose--sm">
                <strong>{t("Pressure you absorb")}.</strong>{" "}
                {presionOk &&
                  presion!.good != null &&
                  `${t("{good} good · {even} even · {bad} costly, in {games} games", {
                    good: presion!.good,
                    even: presion!.even,
                    bad: presion!.bad,
                    games: presion!.games,
                  })}. `}
                {presionOk
                  ? t("Each time 2 or more enemies come for you, it adds the farm they lose chasing you, what your team takes elsewhere and the result of the fight where you are, and subtracts your own lost farm. Measured on the video when it's processed; otherwise estimated from Riot's data.")
                  : t("Pressure is read from the enemy positions of your synced games. It appears once a few games have synced with Riot.")}
              </p>
              <p className="home-prose home-prose--sm">
                <strong>{t("Your average impact")}.</strong>{" "}
                {t("Your win probability added, ranked against players in your role. From your recorded games only: it points at a direction, it doesn't grade you.")}
              </p>
              <p className="home-prose home-prose--sm">
                <strong>{t("The moments")}.</strong>{" "}
                {t("The worst mistake (one you flagged, a death that cost an objective, or one in your worst stretch), the analyzer's most useful finding and your best play. The review button counts the same moments as the player's review queue.")}
              </p>
            </div>

            {presion && (presion.episodes?.length ?? 0) > 0 && (
              <div className="home-more__wide">
                <h3 className="home-h3">{t("Pressure evidence · {n} episodes", { n: presion.windows })}</h3>
                <div className="home-episodes">
                  {presion.episodes.map((episode) => {
                    const recorded = matches.find((m) => m.id === episode.match_id);
                    return (
                      <PressureEpisodeCard
                        key={episode.match_id + ":" + episode.game_start}
                        window={episode.window}
                        gameStart={episode.game_start}
                        gameEnd={episode.game_end}
                        label={`${episode.window.champion} · ${relativeDay(episode.date, t)}`}
                        onSeek={recorded?.video_path ? (seconds) => abrirEn(recorded, seconds) : undefined}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </details>
      </div>
    </div>
  );
};
