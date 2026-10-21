import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { MatchMetadata } from "../../../types";
import {
  getBlindSpot,
  getCameraLooks,
  getMatchPlays,
  checkRiotKey,
  syncMatchNow,
  type BlindSpot,
  type CameraLook,
  type MatchPlays,
} from "../../../core/tauri-ipc";
import { mmss, relativeDay, matchAge } from "../../../core/time";
import { confidenceOf, sampleLabel } from "../../../core/patterns";
import { useCoachSummary } from "../../../core/useCoachSummary";
import { useCoachPlan } from "../../../core/useCoachPlan";
import {
  categoryHelp,
  coachPlaylist,
  focusTitle,
  focusWhy,
  isOwnBaseline,
  liftText,
  planCounted,
  planErrorText,
  planIsRow,
  planTitle,
  rowsByTramo,
  tramoShort,
  tramoWindow,
  wpPoints,
} from "../../../core/coach";
import { outcome, formatDuration, computeKDA, kdaRatio, lpDeltas, queueKey, type KDA } from "../../../core/matchStats";
import { reviewProgress } from "../../../core/review";
import { laneLabel } from "../../../core/lanes";
import { rankIcon } from "../../../core/ddragon";
import { useCurrentRank } from "../../../core/useCurrentRank";
import { useDelayedLoading } from "../../../core/useDelayedLoading";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { ChampionWash } from "../../../components/ChampionWash";
import { Button } from "../../../components/ui/Button";
import { Chip } from "../../../components/ui/Chip";
import { Skeleton } from "../../../components/ui/Skeleton";
import { useAppStore, useErrorClips } from "../../../store/useAppStore";
import { Check, ChevronRight, CircleDot, Flag, KeyRound, Loader2, Play, RefreshCw, Target, Wand2 } from "lucide-react";
import { useLang } from "../../../core/LanguageProvider";
import "./HomePanel.css";
import { usePressureSummary } from "../../player/usePressureSummary";
import { PressureEpisodeCard } from "../../player/components/PressureEpisodeCard";
import { formatGold, formatSeconds } from "../../player/components/pressureFormat";
import { useOnboarding } from "../../onboarding/useOnboarding";
import { MomentCard } from "./MomentCard";
import { ChampionTile } from "./ChampionTile";
import { eventCount, momentWp, pendingMoments, reviewMinutes, teachMoments } from "../moments";
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
 *  1. Si la partida más nueva aún no tiene datos de Riot, una franja de una
 *     línea que lo dice y la sincroniza. No se gasta el héroe en ella.
 *  2. El héroe — la última partida CON DATOS (resultado, LP, rango, cifras, tu
 *     puesto de impacto) y UNA acción: revisar sus momentos clave, o la
 *     siguiente partida por revisar si esta ya está hecha (también con Enter).
 *  3. Los tres momentos que más enseñan — el peor error, el hallazgo del
 *     analizador y la mejor jugada, con lo que movió cada uno tu probabilidad
 *     de victoria cuando es una jugada medida. Cada uno abre el vídeo en su
 *     segundo. Debajo, tres señales en frases.
 *  4. A la derecha, el foco del coach (la categoría × tramo que más te cuesta
 *     por encima de su baremo, `coach.rs`) con sus barras por tramo y el plan
 *     de 10 partidas, y la forma reciente con la cola por revisar.
 *
 * Todo cabe en `--content-max` y se centra: a 1920 el héroe ya no se estira a
 * 1.640 px con un hueco en medio.
 *
 * Lo que no cabe en esa lectura (detalles de la partida, qué mide cada señal,
 * la evidencia de presión episodio a episodio, las jugadas del foco) vive en
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
  /** La biblioteca aún no se ha leído: ni partidas ni «no hay partidas». */
  loading?: boolean;
  isRecording: boolean;
  onOpenMatch: (match: MatchMetadata) => void;
  onGoTraining: () => void;
}

/** Retratos de la forma reciente. */
const FORM_GAMES = 10;

/** La primera visita de la sesión entra escalonada; las siguientes, no. */
const VISTO_KEY = "hoy-visto";
const yaVisto = (): boolean => {
  try {
    return sessionStorage.getItem(VISTO_KEY) === "1";
  } catch {
    return false;
  }
};
const marcarVisto = () => {
  try {
    sessionStorage.setItem(VISTO_KEY, "1");
  } catch {
    /* sin almacenamiento: se vuelve a escalonar, que no rompe nada */
  }
};

/** El KDA guardado ("9/3/12") o el contado de los eventos: el mismo criterio que la biblioteca. */
const kdaOf = (m: MatchMetadata): KDA => {
  if (m.kda) {
    const [k, d, a] = m.kda.split("/").map((x) => parseInt(x, 10));
    if ([k, d, a].every(Number.isFinite)) return { kills: k, deaths: d, assists: a };
  }
  return computeKDA(m.events);
};

/** Tiene datos de Riot: el mismo criterio que la píldora de captura. */
const sincronizada = (m: MatchMetadata): boolean => !!m.riot_match_id || (m.participants?.length ?? 0) > 0;

/** El índice de la entrada escalonada, como variable CSS. */
const paso = (i: number) => ({ "--i": i }) as React.CSSProperties;

export const HomePanel: React.FC<HomePanelProps> = ({ matches, loading = false, onOpenMatch, onGoTraining }) => {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const setLibraryFilter = useAppStore((s) => s.setLibraryFilter);
  const refreshMatches = useAppStore((s) => s.refreshMatches);
  const setPendingSeek = useAppStore((s) => s.setPendingSeek);
  const startPlaylist = useAppStore((s) => s.startPlaylist);
  const { clips: errorClips } = useErrorClips();
  const { restart: abrirAsistente } = useOnboarding();

  const [ciego, setCiego] = useState<BlindSpot | null>(null);
  const [ciegoFallo, setCiegoFallo] = useState(false);
  const { data: presion, error: pressureError, retry: retryPressure } = usePressureSummary("/home");
  // Arriba del todo, con el resto de hooks: más abajo hay un return anticipado
  // (sin partidas) y un hook detrás de él rompe el orden (error #310 de React).
  const rankNow = useCurrentRank();
  const coach = useCoachSummary();
  const { plan: coachPlan, busy: planBusy, error: planError, start: startPlan } = useCoachPlan();
  const esqueleto = useDelayedLoading(loading);
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [mant, setMant] = useState<MaintenanceProgress | null>(null);
  const [sincronizando, setSincronizando] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [looks, setLooks] = useState<CameraLook[]>([]);
  const [plays, setPlays] = useState<MatchPlays | null>(null);
  // Se decide al montar: volver a Hoy en la misma sesión no repite la entrada.
  // Y se apaga al acabar, para que lo que monte después (una tarjeta que llega
  // con las miradas, la franja tras sincronizar) no entre escalonado.
  const [entrada, setEntrada] = useState(() => !yaVisto());

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
  // El foco lo elige el coach (`coach.rs`), sin ventana de tiempo: por eso la
  // tarjeta ya no dice «esta semana».
  const focus = coach?.focus ?? null;
  const focusWindow = useMemo(() => (focus?.tramo != null ? tramoWindow(focus.tramo) : null), [focus]);

  /** De más reciente a más antigua. La lista llega así, pero no se promete. */
  const porFecha = useMemo(() => [...own].sort((a, b) => (a.date < b.date ? 1 : -1)), [own]);
  const masNueva = porFecha[0] ?? null;
  /**
   * El héroe: la última partida CON DATOS de Riot. Una partida recién acabada
   * sin sincronizar no tiene resultado, marcador ni impacto, y gastaba en tres
   * guiones lo más valioso de la pantalla. Solo si no hay ninguna con datos se
   * queda la más nueva, tal cual.
   */
  const ultima = useMemo(() => porFecha.find(sincronizada) ?? masNueva, [porFecha, masNueva]);
  /** La más nueva, si es otra y aún no tiene datos: va en la franja de encima. */
  const sinDatos = masNueva && ultima && masNueva.id !== ultima.id && !sincronizada(masNueva) ? masNueva : null;
  const lp = useMemo(() => lpDeltas(own), [own]);
  const hoy = useMemo(() => own.filter((m) => isToday(m.date)).length, [own]);

  // Las miradas al mapa de la partida del héroe: de ahí sale el hueco más
  // largo sin mirar un carril, uno de los hallazgos candidatos. Y sus jugadas
  // con la probabilidad de victoria, para el ΔWP de cada momento.
  const ultimaId = ultima?.id ?? null;
  useEffect(() => {
    if (!ultimaId) return;
    let vivo = true;
    setPlays(null);
    getCameraLooks(ultimaId)
      .then((l) => vivo && setLooks(Array.isArray(l) ? l : []))
      .catch(() => vivo && setLooks([]));
    // Sin jugadas (sin sincronizar, o el comando falla) los momentos van sin
    // cifra: nada más depende de ellas.
    getMatchPlays(ultimaId)
      .then((p) => vivo && setPlays(p ?? null))
      .catch(() => vivo && setPlays(null));
    return () => { vivo = false; };
  }, [ultimaId]);

  // Una sola definición de "revisada" en toda la app (`core/review.ts`): la cola
  // de momentos tachada, o notas escritas a mano.
  const pendientes = useMemo(
    () => porFecha.filter((m) => !reviewProgress(m, errorClips).reviewed),
    [porFecha, errorClips]
  );

  /**
   * La acción oro: revisar los momentos pendientes de la partida del héroe, o,
   * si ya está revisada (o no tiene vídeo), los de la siguiente partida por
   * revisar. Mismo criterio de "momento por revisar" que la cola del reproductor.
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
            focusWindow,
            t,
          })
        : [],
    [ultima, errorClips, presion, looks, focusWindow, t]
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

  // La que se sincroniza: la de la franja, o la del héroe si ninguna tiene datos.
  const aSincronizar = sinDatos ?? ultima;
  const sincronizar = useCallback(async () => {
    if (!aSincronizar) return;
    setSincronizando(true);
    setSyncError(null);
    try {
      await syncMatchNow(aSincronizar.id);
      await refreshMatches();
    } catch (e) {
      setSyncError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setSincronizando(false);
    }
  }, [aSincronizar, refreshMatches]);

  // La entrada escalonada se pinta una vez por sesión, cuando hay algo que
  // pintar (no el esqueleto).
  const listo = !loading && !esqueleto;
  useEffect(() => {
    if (!listo) return;
    marcarVisto();
    const id = window.setTimeout(() => setEntrada(false), 600);
    return () => window.clearTimeout(id);
  }, [listo]);

  // Enter revisa lo que dice el botón oro, como Enter en la Biblioteca abre la
  // fila. Solo con nada enfocado: Enter sobre un botón o un campo es suyo.
  useEffect(() => {
    if (!listo || !objetivo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && tgt !== document.body && tgt.closest("input, textarea, select, button, a, label, summary, [contenteditable='true'], [role='dialog']")) return;
      e.preventDefault();
      abrirEn(objetivo.match, objetivo.moments[0].time);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listo, objetivo, abrirEn]);

  const claveMal = keyStatus !== null && keyStatus !== "ok";
  const irAClave = () => navigate("/settings?cat=account");
  const textoClave = keyStatus === "missing" ? t("Add your Riot key") : t("Fix your Riot key");

  /* ------------------------------------------------------------ cabecera */
  const cabecera = (
    <header className="home-head">
      <h1 className="t-page home-h1">{t("Today")}</h1>
      <span className="t-small home-sub">
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
        <span className="t-small home-mant" role="status">
          <Loader2 size={14} className="home-spin" />
          {t("Updating library")}
          {mant.total > 0 ? ` ${mant.done}/${mant.total}` : ""}
        </span>
      )}
    </header>
  );

  /* ------------------------------------------------------------ cargando */
  // Tres estados y no dos: mientras se lee la biblioteca NUNCA el «Juega una
  // partida», que decía que no tenías partidas durante 150-300 ms en cada
  // arranque. Los primeros 150 ms, solo la cabecera; después, el esqueleto con
  // la forma del héroe y la rejilla, para que nada salte al llegar los datos.
  if (loading || esqueleto) {
    return (
      <div className="panel-enter home-panel">
        <div className="home-page" aria-busy="true">
          <div className="home-wrap">
            {cabecera}
            {esqueleto && <HomeSkeleton label={t("Loading your games…")} />}
          </div>
        </div>
      </div>
    );
  }

  // Primera visita: escalonado de héroe, momentos y columna lateral, sin el
  // fundido de navegación encima (serían dos movimientos a la vez).
  const raiz = entrada ? "home-panel hoy--entrada" : "panel-enter home-panel";

  /* --------------------------------------------------------- sin partidas */
  if (own.length === 0 || !ultima) {
    return (
      <div className={raiz}>
        <div className="home-page">
          <div className="home-wrap">
            {cabecera}
            <section className="home-hero home-hero--empty" style={paso(0)}>
              <div className="home-empty">
                <h2 className="t-section home-empty__title">{t("Play a game — it records itself")}</h2>
                <p className="t-body home-prose">
                  {t("LeagueRecorder watches for the League client. When a game starts it begins recording, and when it ends it syncs with Riot and files the game here. There is nothing to press.")}
                </p>
                <div className="home-empty__actions">
                  <Button variant="primary" icon={<Wand2 size={16} />} onClick={() => { abrirAsistente().catch(console.error); }}>
                    {t("Open the setup assistant")}
                  </Button>
                  <Button variant="ghost" icon={<Play size={16} />} onClick={() => navigate("/settings?cat=recording")}>
                    {t("10-second test")}
                  </Button>
                  {claveMal && (
                    <Button variant="ghost" icon={<KeyRound size={16} />} onClick={irAClave}>
                      {textoClave}
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => navigate("/vod")}>
                    {t("Import a VOD")}
                  </Button>
                </div>
                <p className="t-small home-prose home-prose--faint">
                  {keyStatus === "ok"
                    ? t("Your Riot key is working: the scoreboard, your rank and your impact score will be there from the first game.")
                    : t("Without a Riot key the app still records and tracks your games; the scoreboard, rank and impact score need one.")}
                </p>
              </div>
            </section>
          </div>
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
          // El campeón va en el tooltip: con él el botón no cabía junto a las
          // cifras a 1280.
          label: t("Review next game"),
          aside: `${reviewMinutes(objetivo.moments.length)} min`,
        }
      : {
          label:
            objetivo.moments.length === 1
              ? t("Review 1 key moment")
              : t("Review {n} key moments", { n: objetivo.moments.length }),
          aside: `${reviewMinutes(objetivo.moments.length)} min`,
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
    trend && trend.wr != null && trend.wrPrev != null ? Math.round((trend.wr - trend.wrPrev) * 100) : null;
  const offset = ultima.video_offset ?? 0;

  /* -------------------------------------------------------------- foco */
  // Lo que cuesta la categoría del foco en cada tramo: se ve de un vistazo que
  // el tramo elegido es el que se dispara. El baremo va en la frase y en el
  // tooltip de cada barra.
  const barras = focus && coach ? rowsByTramo(coach, focus.category) : [];
  const barrasMax = Math.max(1e-9, ...barras.map((r) => r.user));
  const altura = (x: number) => Math.max(0, Math.min(1, x / barrasMax));
  const listaFoco = focus ? coachPlaylist(focus, t, lang) : [];
  const lift = focus ? liftText(focus, t, lang) : null;
  const verFoco = () => {
    if (!focus || listaFoco.length === 0) return;
    startPlaylist(focusTitle(focus, t), listaFoco);
    navigate("/review");
  };
  // El plan de 10 partidas (§2.4): aquí sólo empezarlo y ver cuánto lleva. El
  // cierre y el historial son de la pantalla Coach.
  const planActivo = coachPlan?.active ?? null;
  const planAqui = !!planActivo && !!focus && planIsRow(planActivo, focus);
  const sinFoco =
    coach === undefined
      ? t("Working out your focus…")
      : coach === null
        ? t("Couldn't work out your focus this time. It retries on the next visit.")
        : coach.games < coach.min_games
          ? t("The focus needs {n} games synced with Riot; you have {k}. Until then nothing is solid enough to point at.", {
              n: coach.min_games,
              k: coach.games,
            })
          : t("Nothing costs you more than its baseline yet, in any stretch with {n} games or more.", { n: coach.min_games });

  return (
    <div className={raiz}>
      <div className="home-page">
        <div className="home-wrap">
          {cabecera}

          {/* ===================================== la más nueva, sin datos */}
          {sinDatos && (
            <div className="home-pend">
              <ChampionAvatar champion={sinDatos.champion} size={24} />
              <p className="t-small home-pend__txt">
                {sinDatos.champion} · {t(queueKey(sinDatos.queue))} · {matchAge(sinDatos.date, t)}
                {syncError ? (
                  <span className="home-loss"> — {syncError}</span>
                ) : (
                  <> — {t("no Riot data yet")}</>
                )}
              </p>
              {claveMal ? (
                <Button variant="ghost" size="sm" className="home-pend__btn" icon={<KeyRound size={16} />} onClick={irAClave}>
                  {textoClave}
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="home-pend__btn"
                  icon={<RefreshCw size={16} />}
                  loading={sincronizando}
                  loadingLabel={t("Syncing…")}
                  onClick={sincronizar}
                >
                  {t("Sync")}
                </Button>
              )}
            </div>
          )}

          {/* ================================================== héroe */}
          <section className={`home-hero home-hero--${tono}`} aria-labelledby="home-hero-lbl" style={paso(0)}>
            <ChampionWash champion={ultima.champion} intensity={0.3} />
            <div className="home-hero__main">
              <div className="home-hero__id">
                <div className="home-hero__portrait">
                  <ChampionAvatar champion={ultima.champion} size={72} />
                </div>
                <div className="home-hero__who">
                  <span id="home-hero-lbl" className="t-label home-hero__kicker">
                    {t("Last game")} · {t(queueKey(ultima.queue))} · {matchAge(ultima.date, t)}
                  </span>
                  <div className="home-hero__resrow">
                    <span className="t-hero home-hero__res">{resultadoTexto}</span>
                    {deltaLp != null && (
                      <Chip tone={deltaLp > 0 ? "win" : deltaLp < 0 ? "loss" : "neutral"}>
                        {deltaLp > 0 ? "+" : deltaLp < 0 ? "−" : "±"}
                        {Math.abs(deltaLp)} LP
                      </Chip>
                    )}
                    {progUltima.reviewed && (
                      <Chip tone="outline" icon={<Check size={12} />}>
                        {t("Game reviewed")}
                      </Chip>
                    )}
                  </div>
                  <span className="t-body home-hero__line">
                    {[ultima.champion, rolNombre, formatDuration(ultima.game_duration), ultima.patch ? t("patch {v}", { v: ultima.patch }) : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {/* Sin franja, los avisos van aquí: la partida del héroe sin
                      datos (no hay ninguna con datos) o la clave caída. */}
                  {!sinDatos && (sinScoreboard || claveMal) && (
                    <span className="home-hero__status">
                      {sinScoreboard && (
                        <button type="button" className="t-small home-link" onClick={sincronizar} disabled={sincronizando}>
                          <RefreshCw size={14} className={sincronizando ? "home-spin" : undefined} />
                          {sincronizando ? t("Syncing…") : t("Sync with Riot")}
                        </button>
                      )}
                      {claveMal && (
                        <button type="button" className="t-small home-link home-link--warn" onClick={irAClave}>
                          <KeyRound size={14} />
                          {textoClave}
                        </button>
                      )}
                    </span>
                  )}
                </div>
              </div>

              {/* Cifras de la partida: sans con números tabulares. */}
              <div className="home-stats">
                <div className="home-stat">
                  <span className="t-label home-stat__k">{t("KDA")}</span>
                  <span className="t-metric home-stat__v">
                    {kda.kills} / {kda.deaths} / {kda.assists}
                  </span>
                  <span className="t-small home-stat__s">
                    {kp != null
                      ? t("{r} KDA · {p}% kill participation", { r: ratioTxt, p: kp })
                      : t("{r} KDA", { r: ratioTxt })}
                  </span>
                </div>
                <div className="home-stat">
                  <span className="t-label home-stat__k">{t("Minions")}</span>
                  <span className="t-metric home-stat__v">{yo ? yo.cs : "—"}</span>
                  <span className="t-small home-stat__s">
                    {yo && minutos > 0
                      ? t("{n} per minute", { n: fmtNum(yo.cs / minutos, lang, 1) })
                      : t("needs a Riot sync")}
                  </span>
                </div>
                <div className="home-stat">
                  <span className="t-label home-stat__k">{t("Impact")}</span>
                  {ultima.impact_rank != null ? (
                    <>
                      <span className="t-metric home-stat__v">
                        {ordinal(ultima.impact_rank, lang)} {t("of 10")}
                      </span>
                      <span className="t-small home-stat__s">
                        {ultima.impact_rank === 1
                          ? t("MVP of the game")
                          : ultima.impact_percentile != null
                            ? impactPhrase(rol, Math.round(ultima.impact_percentile), t)
                            : t("of 10 by impact")}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="t-metric home-stat__v">—</span>
                      <span className="t-small home-stat__s">{t("impact not computed yet")}</span>
                    </>
                  )}
                </div>
              </div>

              {sinVideo && (
                <p className="t-small home-note">
                  {t("Tracked without video — the recording could not start, so only the data of this game was kept.")}
                </p>
              )}
              {syncError && !sinDatos && <p className="t-small home-note home-loss">{syncError}</p>}
            </div>

            <div className="home-hero__side">
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
                    <div className="t-body-strong home-rank__row">
                      <span
                        className="home-rank__name"
                        title={rankNow && !rankNow.live && rankNow.date ? t("Rank from your last recorded game ({date})", { date: rankNow.date.slice(0, 10) }) : undefined}
                      >
                        {rankText(tier, divisionRango, t)}
                      </span>
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
                          <i style={{ "--p": Math.min(100, Math.max(0, lpRango)) / 100 } as React.CSSProperties} />
                        </div>
                        {siguiente && lpRango < 100 && (
                          <span className="t-small home-rank__next">
                            {t("{n} LP to {rank}", { n: 100 - lpRango, rank: siguiente })}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}

              <div className="home-hero__actions">
                <Button variant="ghost" onClick={() => onOpenMatch(ultima)}>
                  {sinVideo ? t("Open this game") : t("Open match")}
                </Button>
                {objetivo && accionOro && (
                  <Button
                    variant="primary"
                    className="home-cta"
                    icon={<Play size={16} />}
                    aria-keyshortcuts="Enter"
                    onClick={() => abrirEn(objetivo.match, objetivo.moments[0].time)}
                    title={
                      objetivo.next
                        ? `${t("This game is reviewed: next up is the most recent one still pending.")} (${objetivo.match.champion})`
                        : undefined
                    }
                  >
                    {accionOro.label} · {accionOro.aside}
                    <kbd className="u-kbd home-cta__kbd">Enter</kbd>
                  </Button>
                )}
              </div>
            </div>
          </section>

          <div className="home-grid">
            {/* ============================================ columna izquierda */}
            <div className="home-col">
              <section className="home-sec" aria-labelledby="home-mo-lbl">
                <div className="home-sec__head">
                  <h2 id="home-mo-lbl" className="t-card home-h2">
                    {momentos.length === 3 ? t("The 3 moments that teach you the most") : t("The moments that teach you the most")}
                  </h2>
                  {nEventos > 0 && (
                    <button type="button" className="t-small home-link" onClick={() => onOpenMatch(ultima)}>
                      {t("See all {n} events", { n: nEventos })}
                    </button>
                  )}
                </div>
                {momentos.length > 0 ? (
                  <div className="home-mo-grid">
                    {momentos.map((m, i) => (
                      <MomentCard
                        key={`${m.kind}:${m.time}`}
                        moment={m}
                        wp={momentWp(m, plays, offset, yo?.team_id)}
                        index={i + 1}
                        onPlay={() => abrirEn(ultima, m.time)}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="t-body home-card home-card--quiet home-prose">
                    {t("This game has no events to learn from yet. They appear once it records or syncs with Riot.")}
                  </p>
                )}
              </section>

              {/* Señales, en frases. */}
              <div className="home-sig-grid">
                {/* CUÁNDO te mueres lo dice el foco; esto dice HACIA DÓNDE no miras. */}
                <button type="button" className="home-card home-sig" onClick={() => navigate("/patterns")}>
                  <span className="t-label home-card__label">{t("Blind spot")}</span>
                  <span className="t-card home-sig__title">
                    {ciegoOk
                      ? laneTitle(ciego!.lane, t)
                      : ciegoFallo
                        ? t("Couldn't read your camera looks")
                        : !ciego
                          ? t("No camera data yet")
                          : t("No lane stands out yet")}
                  </span>
                  <span className="t-small home-sig__body">
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
                    <span className="t-label home-card__label">{t("Pressure you absorb")}</span>
                    <span className="t-card home-sig__title">{t("Couldn't load pressure evidence")}</span>
                    <span className="t-small home-sig__body">
                      <button type="button" className="t-small home-link" onClick={retryPressure}>{t("Retry")}</button>
                    </span>
                  </div>
                ) : (
                  <button type="button" className="home-card home-sig" onClick={() => navigate("/patterns")}>
                    <span className="t-label home-card__label">{t("Pressure you absorb")}</span>
                    <span className="t-card home-sig__title">
                      {presionOk && presion!.net_gold != null
                        ? t("{time} of enemy time per game", { time: formatSeconds(presion!.enemy_seconds / Math.max(1, presion!.games)) })
                        : presionOk
                          ? t("You draw enemies {n} times", { n: presion!.windows })
                          : presion && presion.games > 0
                            ? t("No episodes yet")
                            : t("Nothing measured yet")}
                    </span>
                    <span className="t-small home-sig__body">
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
                  <span className="t-label home-card__label">{t("Your average impact")}</span>
                  <span className="t-card home-sig__title">
                    {trend && trend.pct != null
                      ? t("Better than {p}%", { p: Math.round(trend.pct) })
                      : t("Not computed yet")}
                  </span>
                  <span className="t-small home-sig__body">
                    {trend && trend.pct != null
                      ? t("Of players in your role, across {n} recent games.", { n: trend.nPct })
                      : t("Impact is computed when you open a game's Impact tab. It shows here after three games.")}
                  </span>
                </button>
              </div>
            </div>

            {/* ============================================== columna derecha */}
            <aside className="home-col home-col--side">
              <section className="home-card home-focus" aria-labelledby="home-focus-lbl" style={paso(2)}>
                <div className="home-card__head">
                  <span id="home-focus-lbl" className="t-label home-card__label">
                    {planAqui ? t("Your focus · {n}-game plan", { n: planActivo!.target }) : t("Your focus")}
                  </span>
                  {planAqui ? (
                    <Chip tone="gold">{t("{k} of {n}", { k: planCounted(planActivo!), n: planActivo!.target })}</Chip>
                  ) : (
                    focus && <Chip tone="gold">{sampleLabel(confidenceOf(focus.games), focus.games, t)}</Chip>
                  )}
                </div>

                {focus && coach ? (
                  <>
                    <div className="home-focus__text">
                      <span className="t-card home-focus__title" title={categoryHelp(focus.category, t)}>
                        {focusTitle(focus, t)}
                      </span>
                      <span className="t-small home-focus__why">{focusWhy(focus, coach, t, lang)}</span>
                      {lift && <span className="t-small home-focus__why">{lift}</span>}
                      {isOwnBaseline(focus) && (
                        <span className="t-small home-focus__note">
                          {t("Riot's data can't see this, so the baseline is your own average, not your rank's.")}
                        </span>
                      )}
                    </div>
                    {barras.length > 0 && (
                      <div
                        className="home-tramos"
                        role="img"
                        aria-label={t("What it costs you per game in each stretch of the game, with its baseline")}
                      >
                        {barras.map((r) => {
                          const hot = r.tramo === focus.tramo;
                          return (
                            <div
                              key={r.tramo}
                              className={`home-tramo${hot ? " home-tramo--hot" : ""}`}
                              title={t("{n} games · you {user}% · baseline {base}%", {
                                n: r.games,
                                user: wpPoints(r.user, lang),
                                base: r.base != null ? wpPoints(r.base, lang) : "—",
                              })}
                            >
                              <span className="home-tramo__track">
                                <i className="home-tramo__bar" style={{ "--h": altura(r.user) } as React.CSSProperties} />
                              </span>
                              <span className="t-label home-tramo__lbl">{tramoShort(r.tramo ?? 0)}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div className="home-focus__actions">
                      {listaFoco.length > 0 && (
                        <Button variant="ghost" size="sm" className="home-focus__btn" icon={<Play size={16} />} onClick={verFoco}>
                          {listaFoco.length === 1
                            ? t("Watch the play that cost you most")
                            : t("Watch your {n} worst plays", { n: listaFoco.length })}
                        </Button>
                      )}
                      {!planActivo && coachPlan && coachPlan.state !== "few_games" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="home-focus__btn"
                          icon={<Flag size={16} />}
                          loading={planBusy}
                          onClick={() => startPlan(focus.category, focus.tramo ?? undefined)}
                        >
                          {t("Start a {n}-game plan", { n: coachPlan.target })}
                        </Button>
                      )}
                      {planActivo && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="home-focus__btn"
                          icon={<ChevronRight size={16} />}
                          onClick={() => navigate("/coach")}
                        >
                          {t("See the plan")}
                        </Button>
                      )}
                    </div>
                    {/* Un plan en curso sobre OTRO foco: se dice cuál y cuánto lleva. */}
                    {planActivo && !planAqui && (
                      <span className="t-small home-focus__note">
                        {t("Plan in progress ({focus}): {k} of {n} games", {
                          focus: planTitle(planActivo, t),
                          k: planCounted(planActivo),
                          n: planActivo.target,
                        })}
                      </span>
                    )}
                    {planError && (
                      <span className="t-small home-focus__note">{planErrorText(planError, t, coachPlan?.min_before ?? 10)}</span>
                    )}
                  </>
                ) : (
                  <p className="t-small home-focus__why">{sinFoco}</p>
                )}

                {/* Sin nada por revisar, la acción oro de la pantalla pasa a ser
                    entrenar; con algo por revisar, el oro es del héroe. */}
                {!objetivo && (
                  <Button variant="primary" className="home-focus__train" icon={<Target size={16} />} onClick={onGoTraining}>
                    {t("Train camera control")}
                  </Button>
                )}
              </section>

              <section className="home-card home-form" aria-labelledby="home-form-lbl" style={paso(3)}>
                <div className="home-card__head">
                  <span id="home-form-lbl" className="t-label home-card__label">{t("Recent form")}</span>
                  <span className="t-small home-form__wl">
                    {t("{n} W", { n: ganadas })} · {t("{n} L", { n: perdidas })}
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
                        <ChampionTile champion={m.champion} size={24} radius={999} fluid />
                        <span className={`home-form__bar home-form__bar--${r}`} />
                      </button>
                    );
                  })}
                </div>
                {pendientes.length > 0 ? (
                  <button type="button" className="t-small home-form__queue" onClick={() => verBiblioteca("unreviewed")}>
                    <span>
                      {pendientes.length === 1
                        ? t("1 game to review")
                        : t("{n} games to review", { n: pendientes.length })}
                    </span>
                    <span className="t-small-strong home-form__open">
                      {t("Open the queue")}
                      <ChevronRight size={14} />
                    </span>
                  </button>
                ) : (
                  /* La cola vacía es el estado bueno y merece decirse. */
                  <p className="t-small home-form__done">
                    <CircleDot size={14} className="home-win" />
                    {t("Nothing pending: you went through every recorded game.")}
                  </p>
                )}
              </section>
            </aside>
          </div>

          {/* ======================= lo que no cabe en la lectura principal */}
          <details className="home-more">
            <summary className="t-small">{t("More about this game and your signals")}</summary>
            <div className="home-more__body">
              <div className="home-more__col">
                <h3 className="t-body-strong home-h3">{t("Performance details")}</h3>
                <dl className="t-small home-dl">
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
                        <button type="button" className="t-small home-link" onClick={sincronizar} disabled={sincronizando}>
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

                {focus && focus.worst.length > 0 && (
                  <>
                    <h3 className="t-body-strong home-h3">{t("Where your focus happened")}</h3>
                    <div className="home-chips">
                      {focus.worst.map((p) => {
                        const m = matches.find((x) => x.id === p.match_id);
                        if (!m) return null;
                        return (
                          <button
                            key={`${p.match_id}:${p.time}`}
                            type="button"
                            className="t-small home-chip"
                            onClick={() => abrirEn(m, p.video_time)}
                            title={`${p.champion} · ${relativeDay(m.date, t)}`}
                          >
                            <ChampionAvatar champion={p.champion} size={20} />
                            {mmss(p.time)}
                            <span className="home-chip__meta">−{wpPoints(p.lost, lang)}%</span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>

              <div className="home-more__col">
                <h3 className="t-body-strong home-h3">{t("What does this measure?")}</h3>
                <p className="t-small home-prose">
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
                <p className="t-small home-prose">
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
                <p className="t-small home-prose">
                  <strong>{t("Your average impact")}.</strong>{" "}
                  {t("Your win probability added, ranked against players in your role. From your recorded games only: it points at a direction, it doesn't grade you.")}
                </p>
                <p className="t-small home-prose">
                  <strong>{t("The moments")}.</strong>{" "}
                  {t("The worst mistake (one you flagged, a death that cost an objective, or one in your worst stretch), the analyzer's most useful finding and your best play. The review button counts the same moments as the player's review queue.")}
                </p>
              </div>

              {presion && (presion.episodes?.length ?? 0) > 0 && (
                <div className="home-more__wide">
                  <h3 className="t-body-strong home-h3">{t("Pressure evidence · {n} episodes", { n: presion.windows })}</h3>
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
    </div>
  );
};

/**
 * Esqueleto de Hoy: el héroe (retrato, quién, cifras, rango y acciones) y la
 * rejilla de debajo con las mismas clases que la pantalla de verdad, así que
 * mide lo mismo y nada salta al llegar los datos.
 */
const HomeSkeleton: React.FC<{ label: string }> = ({ label }) => (
  <div className="home-skel" role="status" aria-label={label}>
    <section className="home-hero" aria-hidden="true">
      <div className="home-hero__main">
        <div className="home-hero__id">
          <Skeleton shape="circle" className="home-skel__portrait" />
          <div className="home-hero__who">
            <Skeleton width={180} />
            <Skeleton shape="block" width={220} height={40} />
            <Skeleton width={200} height={14} />
          </div>
        </div>
        <div className="home-stats">
          {[0, 1, 2].map((i) => (
            <div className="home-stat" key={i}>
              <Skeleton width={40} />
              <Skeleton shape="block" width={90} height={24} />
              <Skeleton width={140} />
            </div>
          ))}
        </div>
      </div>
      <div className="home-hero__side">
        <Skeleton shape="block" className="home-skel__rank" />
        <div className="home-hero__actions">
          <Skeleton shape="block" width={110} height={36} />
          <Skeleton shape="block" width={210} height={36} />
        </div>
      </div>
    </section>
    <div className="home-grid" aria-hidden="true">
      <div className="home-col">
        <Skeleton width={260} height={16} />
        <div className="home-mo-grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="home-skel__mo">
              <Skeleton shape="block" className="home-skel__thumb" />
              <div className="home-skel__mo-body">
                <Skeleton width="70%" />
                <Skeleton width="100%" />
                <Skeleton width="60%" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <aside className="home-col home-col--side">
        <Skeleton shape="block" className="home-skel__focus" />
        <Skeleton shape="block" className="home-skel__form" />
      </aside>
    </div>
  </div>
);
