import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { MatchMetadata } from "../../../types";
import {
  getBlindSpot,
  getDiskUsage,
  getHotkeys,
  getPressureSummary,
  checkRiotKey,
  syncMatchNow,
  type BlindSpot,
  type DiskSpaceInfo,
  type PressureSummary,
} from "../../../core/tauri-ipc";
import { clock as reloj, relativeDay, matchAge } from "../../../core/time";
import { currentFocus, deathClock, confidenceOf } from "../../../core/patterns";
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
import { Badge } from "../../../components/ui/Badge";
import { EmptyState } from "../../../components/ui/EmptyState";
import { useAppStore, useErrorClips } from "../../../store/useAppStore";
import {
  HardDrive,
  Target,
  Radio,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  ScanSearch,
  Eye,
  Shield,
  TrendingUp,
  ListChecks,
  CircleDot,
} from "lucide-react";
import { useT } from "../../../core/LanguageProvider";

/**
 * Hoy: en qué estás trabajando.
 *
 * Lo primero al abrir la app deja de ser una lista de ficheros. La app estaba
 * organizada por tipo de archivo —vídeos, clips, errores, VODs, drills— y eso
 * contesta "¿dónde están mis cosas?", que no es la pregunta de nadie.
 *
 * Ahora la pantalla contesta tres, en este orden:
 *
 *  1. ¿Está la app haciendo su trabajo? — la tira de estado: grabadora, clave
 *     de Riot, disco y el mantenimiento de la biblioteca cuando corre. Son las
 *     cuatro cosas que, cuando fallan, hacen que todo lo demás parezca vacío.
 *  2. ¿Qué pasó en la última partida? — el héroe, con lo que esta app sabe y
 *     nadie más: tu puesto de impacto en el lobby y su percentil dentro del rol.
 *  3. ¿Qué toca trabajar? — el foco, el punto ciego, la presión que aguantaste
 *     y lo que queda por revisar.
 *
 * La grabación no es un sitio al que vas: es algo que la app HACE, y por eso
 * baja a una tira.
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

export const HomePanel: React.FC<HomePanelProps> = ({
  matches,
  isRecording,
  onOpenMatch,
  onGoTraining,
}) => {
  const t = useT();
  const navigate = useNavigate();
  const setLibraryFilter = useAppStore((s) => s.setLibraryFilter);
  const refreshMatches = useAppStore((s) => s.refreshMatches);
  const { clips: errorClips } = useErrorClips();

  const [disk, setDisk] = useState<DiskSpaceInfo | null>(null);
  const [ciego, setCiego] = useState<BlindSpot | null>(null);
  const [ciegoFallo, setCiegoFallo] = useState(false);
  const [presion, setPresion] = useState<PressureSummary | null>(null);
  const [replayKey, setReplayKey] = useState("F8");
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [mant, setMant] = useState<MaintenanceProgress | null>(null);
  const [sincronizando, setSincronizando] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    getDiskUsage().then(setDisk).catch(() => {});
  }, [matches]);

  useEffect(() => {
    let vivo = true;
    getHotkeys()
      .then((h) => vivo && setReplayKey(h.replay || "F8"))
      .catch(() => {});
    getPressureSummary()
      .then((p) => vivo && setPresion(p))
      .catch(() => vivo && setPresion(null));
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
      // "done" es la etapa final: se apaga la tira en vez de dejarla al 100%.
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
    return own
      .filter((m) => {
        const off = m.video_offset ?? 0;
        return m.events.some((ev) => {
          if (ev.type !== "ChampionKill" || ev.subtype !== "death") return false;
          const t = Math.max(0, ev.time - off) / 60;
          return t >= from && t < to;
        });
      })
      .slice(0, 4);
  }, [own, focus]);

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

  const libreGb = disk && disk.free_bytes > 0 ? (disk.free_bytes / 1024 ** 3).toFixed(0) : null;
  const discoGb =
    disk && disk.drive_total_bytes > 0 ? (disk.drive_total_bytes / 1024 ** 3).toFixed(0) : null;

  /* ------------------------------------------------------------------ tira */
  const tira = (
    <div style={styles.capture}>
      {isRecording ? (
        <>
          <span style={{ ...styles.capItem, color: "var(--signal)" }}>
            <span className="rec-dot" /> {t("Recording")}
          </span>
          <span style={styles.capItem}>
            {t("{key} saves the last 30 s", { key: replayKey })}
          </span>
        </>
      ) : (
        <span style={styles.capItem}>
          <Radio size={13} color="var(--faint)" /> {t("Idle — records itself when a game starts")}
        </span>
      )}

      <span
        style={{
          ...styles.capItem,
          color: keyStatus === "ok" ? "var(--faint)" : keyStatus == null ? "var(--faint)" : "var(--signal)",
          cursor: keyStatus && keyStatus !== "ok" ? "pointer" : "default",
        }}
        role={keyStatus && keyStatus !== "ok" ? "button" : undefined}
        tabIndex={keyStatus && keyStatus !== "ok" ? 0 : undefined}
        onClick={() => { if (keyStatus && keyStatus !== "ok") navigate("/settings"); }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && keyStatus && keyStatus !== "ok") {
            e.preventDefault();
            navigate("/settings");
          }
        }}
      >
        <KeyRound size={13} />
        {keyStatus === null
          ? t("Checking key…")
          : keyStatus === "ok"
            ? t("Riot key OK")
            : keyStatus === "missing"
              ? t("No Riot key")
              : keyStatus === "expired"
                ? t("Riot key expired")
                : t("Riot key rejected")}
      </span>

      <span style={styles.capItem}>
        <HardDrive size={13} color="var(--faint)" />
        <span className="u-metric" style={{ fontSize: 11 }}>
          {libreGb && discoGb ? t("{n} GB free", { n: libreGb }) : "—"}
        </span>
      </span>

      {/* El mantenimiento de arranque, en voz baja: no se puede pulsar nada y
          termina solo, pero explica por qué la biblioteca se mueve sola. */}
      {mant && (
        <span style={{ ...styles.capItem, color: "var(--cool)" }}>
          <Loader2 size={12} style={{ animation: "spin 1.1s linear infinite" }} />
          {t("Updating library")}
          {mant.total > 0 ? ` ${mant.done}/${mant.total}` : ""}
        </span>
      )}
    </div>
  );

  /* --------------------------------------------------------- sin partidas */
  if (own.length === 0) {
    return (
      <div style={styles.container} className="panel-enter">
        {tira}
        <div style={styles.body}>
          <div className="surface-hero">
            <div style={styles.focusIn}>
              <h1 style={styles.focusTitle}>{t("Play a game — it records itself")}</h1>
              <p style={styles.focusText}>
                {t("LeagueRecorder watches for the League client. When a game starts it begins recording, and when it ends it syncs with Riot and files the game here. There is nothing to press.")}
              </p>
              <div style={styles.emptyActions}>
                {keyStatus && keyStatus !== "ok" && (
                  <Button variant="primary" size="md" icon={<KeyRound size={14} />} onClick={() => navigate("/settings")}>
                    {keyStatus === "missing" ? t("Add your Riot key") : t("Fix your Riot key")}
                  </Button>
                )}
                <Button variant="ghost" size="md" icon={<ScanSearch size={14} />} onClick={() => navigate("/vod")}>
                  {t("Import a VOD")}
                </Button>
              </div>
              <p style={{ ...styles.focusText, marginTop: "var(--space-4)", color: "var(--faint)" }}>
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
  const heroColor =
    res === "victory" ? "var(--win)" : res === "defeat" ? "var(--loss)" : "var(--line)";

  return (
    <div style={styles.container} className="panel-enter">
      {tira}

      <div style={styles.body}>
        {/* ------------------------------------------------- última partida */}
        {ultima && (
          <section>
            <div style={styles.sectHead}>
              <span className="u-label">{t("Last game")}</span>
              <Button variant="ghost" size="sm" onClick={() => verBiblioteca("all")}>
                {t("See all")}
              </Button>
            </div>

            <div className="card" style={{ ...styles.hero, borderLeft: `2px solid ${heroColor}` }}>
              <ChampionAvatar champion={ultima.champion} size={54} ring={heroColor} />

              <div style={styles.heroMain}>
                <div style={styles.heroTop}>
                  <span style={{ ...styles.heroResult, color: heroColor }}>
                    {t(res === "victory" ? "VICTORY" : res === "defeat" ? "DEFEAT" : "NO RESULT")}
                  </span>
                  <span style={styles.heroChamp}>{ultima.champion}</span>
                  <span className="u-meta">{t(queueKey(ultima.queue))}</span>
                  <span className="u-meta">· {formatDuration(ultima.game_duration)}</span>
                  <span className="u-meta">· {matchAge(ultima.date, t)}</span>
                </div>

                <div style={styles.heroStats}>
                  <span className="u-metric" style={styles.heroKda}>
                    {kdaGuardado ?? (kda ? `${kda.kills}/${kda.deaths}/${kda.assists}` : "—")}
                  </span>
                  {kda && (
                    <span className="u-meta">{t(kdaRatio(kda))} {t("KDA")}</span>
                  )}

                  {/* Lo que esta app sabe y ningún marcador enseña. */}
                  {ultima.impact_rank != null ? (
                    <span style={styles.heroChip}>
                      {ultima.impact_rank === 1 ? (
                        <Badge tone="objective" emphasis="solid">{t("MVP")}</Badge>
                      ) : (
                        <span className="u-metric" style={{ fontWeight: 700 }}>#{ultima.impact_rank}</span>
                      )}
                      <span className="u-meta">{t("of 10 by impact")}</span>
                      {ultima.impact_percentile != null && (
                        <span className="u-meta">
                          · {t("top {n}% in your role", { n: Math.max(1, Math.round(100 - ultima.impact_percentile)) })}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="u-meta">{t("impact not computed yet")}</span>
                  )}

                  {ultima.rank_tier && (
                    <span style={styles.heroChip}>
                      <span className="u-meta">{rankLabel(ultima.rank_tier, ultima.rank_division)}</span>
                      {deltaLp != null && deltaLp !== 0 && (
                        <span
                          className="u-metric"
                          style={{ color: deltaLp > 0 ? "var(--win)" : "var(--loss)", fontWeight: 700 }}
                        >
                          {deltaLp > 0 ? "+" : "−"}{Math.abs(deltaLp)} LP
                        </span>
                      )}
                      {deltaLp == null && ultima.rank_lp != null && (
                        <span className="u-meta">{ultima.rank_lp} LP</span>
                      )}
                    </span>
                  )}

                  {ultima.lane_result && (
                    <span className="u-meta">
                      {t("lane")}:{" "}
                      <span
                        style={{
                          color:
                            ultima.lane_result === "Win"
                              ? "var(--win)"
                              : ultima.lane_result === "Loss"
                                ? "var(--loss)"
                                : "var(--muted)",
                        }}
                      >
                        {/* Los tres valores del backend son claves inglesas
                            ("Win"/"Loss"/"Even") que se usan en más sitios; se
                            traducen por su significado AQUÍ, no metiendo un
                            "Win" suelto en el diccionario. */}
                        {t(
                          ultima.lane_result === "Win"
                            ? "won"
                            : ultima.lane_result === "Loss"
                              ? "lost"
                              : "even"
                        )}
                      </span>
                    </span>
                  )}

                  {ultima.gold_diff_15 != null && (
                    <span className="u-meta">
                      {t("gold @15")}:{" "}
                      <span
                        className="u-metric"
                        style={{ color: ultima.gold_diff_15 >= 0 ? "var(--win)" : "var(--loss)" }}
                      >
                        {ultima.gold_diff_15 >= 0 ? "+" : "−"}{Math.abs(ultima.gold_diff_15)}
                      </span>
                    </span>
                  )}
                </div>

                {sinVideo && (
                  <p style={{ ...styles.focusText, color: "var(--faint)", marginTop: 6 }}>
                    {t("Tracked without video — the recording could not start, so only the data of this game was kept.")}
                  </p>
                )}
                {syncError && (
                  <p style={{ ...styles.focusText, color: "var(--loss)", marginTop: 6 }}>{syncError}</p>
                )}
              </div>

              <div style={styles.heroActions}>
                <Button
                  variant="primary"
                  size="md"
                  icon={<Play size={14} />}
                  onClick={() => onOpenMatch(ultima)}
                >
                  {sinVideo ? t("Open this game") : t("Review this game")}
                </Button>
                {sinScoreboard && (
                  <Button
                    variant="ghost"
                    size="md"
                    icon={<RefreshCw size={14} style={sincronizando ? { animation: "spin 1.1s linear infinite" } : undefined} />}
                    onClick={sincronizar}
                    disabled={sincronizando}
                  >
                    {sincronizando ? t("Syncing…") : t("Sync with Riot")}
                  </Button>
                )}
              </div>
            </div>
          </section>
        )}

        {/* ------------------------------------------------ en qué trabajar */}
        {focus ? (
          <section>
            <div className="u-label" style={{ marginBottom: 10 }}>{t("What to work on")}</div>

            {/* La aureola (oro arriba a la derecha, turquesa detrás) ya no se
                pinta aquí: es `.surface-hero` del sistema, y por eso la usan
                igual Patrones, Análisis y Entrenamiento. */}
            <div className="surface-hero">
              <div style={styles.focusIn}>
                <span style={styles.focusTag}>
                  {focus.bucket.total} {t("deaths")} · {focus.games} {t("games")}
                </span>

                <h1 style={styles.focusTitle}>
                  {t("You die between minute {a} and {b}", { a: focus.bucket.from, b: focus.bucket.to })}
                </h1>

                <p style={styles.focusText}>
                  {t("It is your worst window: {n} of your {total} deaths land there ({pct}%).", {
                    n: focus.bucket.total,
                    total: clock.total,
                    pct: Math.round(focus.share * 100),
                  })}
                  {conf === "low" && (
                    <span style={{ color: "var(--faint)" }}>
                      {" "}
                      {t("With {n} games this is a lead, not a conclusion — it sharpens as you record more.", { n: own.length })}
                    </span>
                  )}
                </p>

                {affected.length > 0 && (
                  <div style={styles.affected}>
                    <div className="u-label" style={{ marginBottom: 8 }}>
                      {t("Where it happened")}
                      {focus.games > affected.length &&
                        ` · ${t("latest {n} of {total}", { n: affected.length, total: focus.games })}`}
                    </div>
                    {affected.map((m) => {
                      const r = outcome(m.result);
                      const color =
                        r === "victory" ? "var(--win)" : r === "defeat" ? "var(--loss)" : "var(--line)";
                      return (
                        <div
                          key={m.id}
                          style={styles.mini}
                          role="button"
                          tabIndex={0}
                          onClick={() => onOpenMatch(m)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenMatch(m); }
                          }}
                        >
                          <span style={{ ...styles.miniStripe, background: color }} />
                          <span style={styles.miniName}>
                            {m.champion}
                            <span className="u-meta" style={{ display: "block", marginTop: 2 }}>
                              {t(r === "victory" ? "victory" : r === "defeat" ? "defeat" : "no result")} · {relativeDay(m.date, t)}
                            </span>
                          </span>
                          <span className="u-metric" style={styles.miniDur}>
                            {formatDuration(m.game_duration)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                <button
                  type="button"
                  className="btn btn--ghost btn--md"
                  style={{ marginTop: "var(--space-4)" }}
                  onClick={onGoTraining}
                >
                  <Target size={14} /> {t("Train camera control")}
                </button>
              </div>
            </div>
          </section>
        ) : (
          <section style={styles.emptyFocus}>
            <div className="u-label" style={{ marginBottom: 8 }}>{t("What to work on")}</div>
            <p style={styles.focusText}>
              {t("Nothing to point at yet. Record a few games and this turns into the one thing worth working on.")}
            </p>
          </section>
        )}

        {/* ------------------------------- punto ciego + presión, uno al lado */}
        <div style={styles.pairGrid}>
          {/* El segundo hallazgo, y de otra clase: el de arriba dice CUÁNDO te
              mueres, este dice HACIA DÓNDE no miras.

              Ya no desaparece cuando no llega al umbral: desaparecer sin decir
              nada es indistinguible de que la app no haya mirado. */}
          <section style={styles.blind}>
            <span className="u-label">{t("Your blind spot")}</span>
            {ciego && ciego.games_worst >= 3 && ciego.avg_gap_secs >= 90 ? (
              <p style={{ ...styles.focusText, marginTop: 8 }}>
                {t("{lane} is the lane you leave unwatched the longest, in {n} of your last {total} games.", {
                  lane: laneLabel(ciego.lane, t),
                  n: ciego.games_worst,
                  total: ciego.games,
                })}{" "}
                {t("On average {avg} without a single look; your worst was {worst}.", {
                  avg: reloj(ciego.avg_gap_secs),
                  worst: reloj(ciego.worst_gap_secs),
                })}
              </p>
            ) : (
              <EmptyState
                icon={<Eye size={22} color="var(--faint)" />}
                title={
                  ciegoFallo
                    ? t("Couldn't read your camera looks")
                    : !ciego
                      ? t("No camera data yet")
                      : t("No lane stands out yet")
                }
                text={
                  ciegoFallo
                    ? t("The look reports are on disk but could not be read this time. It retries on the next visit.")
                    : !ciego
                      ? t("This comes from the minimap looks detected in your recorded games. It appears once a game has been analysed.")
                      : t("Across {games} games with look data, no lane is clearly the worst yet ({n} games and a 1:30 gap are needed).", {
                          games: ciego.games,
                          n: 3,
                        })
                }
              />
            )}
          </section>

          {/* Lo que compró tu presencia: el número que nadie más te cuenta. */}
          <section style={styles.blind}>
            <span className="u-label">{t("Pressure you absorbed")}</span>
            {presion && presion.windows > 0 ? (
              <>
                <p style={{ ...styles.focusText, marginTop: 8 }}>
                  {t("In your last {games} games you absorbed {windows} stretches with more enemies on you than allies.", {
                    games: presion.games,
                    windows: presion.windows,
                  })}
                </p>
                <p style={{ ...styles.focusText, marginTop: 6 }}>
                  {t("Meanwhile your team took {towers} towers and {gold}k gold elsewhere — {wpa}% of win probability you did not get credit for.", {
                    towers: presion.towers,
                    gold: Math.round(presion.gold / 100) / 10,
                    wpa: (presion.wpa * 100).toFixed(0),
                  })}
                </p>
              </>
            ) : (
              <EmptyState
                icon={<Shield size={22} color="var(--faint)" />}
                title={t("Nothing measured yet")}
                text={t("Pressure is read from the enemy positions of your synced games. It appears once a few games have synced with Riot.")}
              />
            )}
          </section>
        </div>

        {/* ------------------------------------------------------ tendencia */}
        {trend && (
          <section style={styles.blind}>
            <div style={styles.sectHead}>
              <span className="u-label">{t("Trend")}</span>
              <span className="u-meta">
                {/* Sin ventana anterior no hay "frente a": decir "frente a las 0
                    anteriores" es una comparación que no existe. */}
                {trend.nPrev >= 3
                  ? t("last {n} games vs the {p} before", { n: trend.n, p: trend.nPrev })
                  : t("your last {n} games", { n: trend.n })}
              </span>
            </div>
            <div style={styles.trendRow}>
              <div>
                <div className="u-metric" style={styles.trendValue}>
                  {trend.wr != null ? `${Math.round(trend.wr * 100)}%` : "—"}
                </div>
                <div className="u-label" style={{ marginTop: 3 }}>{t("win rate")}</div>
                {trend.wrPrev != null && trend.wr != null && (
                  <div className="u-meta" style={{ marginTop: 3, color: trend.wr >= trend.wrPrev ? "var(--win)" : "var(--loss)" }}>
                    {trend.wr >= trend.wrPrev ? "+" : "−"}
                    {Math.abs(Math.round((trend.wr - trend.wrPrev) * 100))} {t("pts")}
                  </div>
                )}
              </div>
              <div>
                <div className="u-metric" style={styles.trendValue}>
                  {trend.pct != null ? Math.round(trend.pct) : "—"}
                </div>
                <div className="u-label" style={{ marginTop: 3 }}>{t("avg impact percentile")}</div>
                {trend.pctPrev != null && trend.pct != null ? (
                  <div className="u-meta" style={{ marginTop: 3, color: trend.pct >= trend.pctPrev ? "var(--win)" : "var(--loss)" }}>
                    {trend.pct >= trend.pctPrev ? "+" : "−"}
                    {Math.abs(Math.round(trend.pct - trend.pctPrev))}
                  </div>
                ) : (
                  <div className="u-meta" style={{ marginTop: 3 }}>{t("needs impact on more games")}</div>
                )}
              </div>
              <div style={{ marginLeft: "auto", alignSelf: "center" }}>
                <TrendingUp size={20} color="var(--faint)" />
              </div>
            </div>
            <p style={{ ...styles.focusText, color: "var(--faint)", marginTop: 8 }}>
              {t("From your recorded games only. Two windows of ten: it points at a direction, it doesn't grade you.")}
            </p>
          </section>
        )}

        {/* ------------------------------------------------------ por revisar */}
        {toReview.length > 0 && (
          <section>
            <div style={styles.sectHead}>
              <span className="u-label">
                <ListChecks size={12} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                {t("To review")} · {pendientes.length} {t("games")}
              </span>
              <Button variant="ghost" size="sm" onClick={() => verBiblioteca("unreviewed")}>
                {t("See all")}
              </Button>
            </div>
            <div style={styles.reviewGrid}>
              {toReview.map((m) => {
                const r = outcome(m.result);
                const color =
                  r === "victory" ? "var(--win)" : r === "defeat" ? "var(--loss)" : "var(--line)";
                const prog = reviewProgress(m, errorClips);
                return (
                  <div
                    key={m.id}
                    className="card card--interactive"
                    style={{ ...styles.reviewCard, borderLeft: `2px solid ${color}` }}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenMatch(m)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenMatch(m); }
                    }}
                  >
                    <div style={styles.reviewName}>{m.champion}</div>
                    <div className="u-meta" style={{ marginTop: 3 }}>{relativeDay(m.date, t)}</div>
                    <div
                      className="u-metric"
                      style={{
                        fontSize: 16,
                        fontWeight: 600,
                        marginTop: "var(--space-3)",
                        color: prog.done > 0 ? "var(--cool)" : "var(--muted)",
                      }}
                    >
                      {prog.done} / {prog.total}
                    </div>
                    <div className="u-label" style={{ marginTop: 3 }}>{t("moments reviewed")}</div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Cuando no queda nada pendiente la sección no desaparece sin más: la
            cola vacía es el estado bueno y merece decirse. */}
        {toReview.length === 0 && (
          <section style={styles.blind}>
            <span className="u-label">{t("To review")}</span>
            <p style={{ ...styles.focusText, marginTop: 8 }}>
              <CircleDot size={12} style={{ verticalAlign: "-1px", marginRight: 6, color: "var(--cool)" }} />
              {t("Nothing pending: you went through every recorded game.")}
            </p>
          </section>
        )}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    boxSizing: "border-box",
    background: "transparent",
    overflow: "hidden",
  },
  capture: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-5)",
    padding: "var(--space-2) var(--space-8)",
    background: "var(--surface-1)",
    backdropFilter: "var(--glass-blur)",
    borderBottom: "1px solid var(--glass-line-soft)",
    flexWrap: "wrap",
  },
  capItem: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    fontFamily: "var(--font-mono)",
    fontSize: "10.5px",
    letterSpacing: "0.05em",
    color: "var(--faint)",
  },
  body: {
    flex: 1,
    overflowY: "auto",
    padding: "var(--space-6) var(--space-8)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-6)",
  },
  sectHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--space-3)",
    marginBottom: 10,
  },
  hero: {
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--space-4)",
    padding: "var(--space-4) var(--space-5)",
  },
  heroMain: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 },
  heroTop: { display: "flex", alignItems: "baseline", gap: "var(--space-2)", flexWrap: "wrap" },
  heroResult: {
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    letterSpacing: "0.14em",
    fontWeight: 700,
  },
  heroChamp: { fontSize: "var(--font-lg)", fontWeight: 600, color: "var(--text)" },
  heroStats: { display: "flex", alignItems: "center", gap: "var(--space-4)", flexWrap: "wrap" },
  heroKda: { fontSize: 17, fontWeight: 700, color: "var(--text)" },
  heroChip: { display: "inline-flex", alignItems: "center", gap: 6 },
  heroActions: { display: "flex", flexDirection: "column", gap: "var(--space-2)", flexShrink: 0 },
  /** En el estado vacío los botones van en fila y a su ancho: en columna
   *  ocupaban los 62ch del bloque y parecían dos barras. */
  emptyActions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--space-3)",
    marginTop: "var(--space-4)",
  },
  focusIn: {
    position: "relative",
    padding: "var(--space-5) var(--space-6)",
    maxWidth: "62ch",
  },
  focusTag: {
    display: "inline-flex",
    alignItems: "center",
    fontFamily: "var(--font-mono)",
    fontSize: "9.5px",
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: "var(--loss)",
    background: "color-mix(in srgb, var(--loss) 12%, transparent)",
    border: "1px solid color-mix(in srgb, var(--loss) 30%, transparent)",
    padding: "3px 9px",
    borderRadius: "var(--radius-sm)",
  },
  focusTitle: {
    fontSize: "24px",
    fontWeight: 600,
    letterSpacing: "-0.02em",
    margin: "var(--space-3) 0 var(--space-2)",
    color: "var(--text)",
  },
  focusText: {
    margin: 0,
    fontSize: "var(--font-sm)",
    lineHeight: 1.55,
    color: "var(--muted)",
    maxWidth: "58ch",
  },
  affected: {
    marginTop: "var(--space-4)",
    paddingTop: "var(--space-4)",
    borderTop: "1px solid var(--line-soft)",
  },
  mini: {
    display: "grid",
    gridTemplateColumns: "2px 1fr auto",
    gap: "var(--space-3)",
    alignItems: "center",
    padding: "var(--space-2) 0",
    borderBottom: "1px solid var(--line-soft)",
    cursor: "pointer",
  },
  miniStripe: { alignSelf: "stretch", borderRadius: "1px" },
  miniName: { fontSize: "var(--font-xs)", color: "var(--text)", minWidth: 0 },
  miniDur: { fontSize: "11px", color: "var(--faint)" },
  pairGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: "var(--space-4)",
  },
  // Sin aureola: no compiten con el foco, lo acompañan.
  blind: {
    padding: "var(--space-4)",
    background: "var(--media-sheen)",
    border: "1px solid var(--line-soft)",
    borderRadius: "var(--radius-lg)",
  },
  trendRow: { display: "flex", alignItems: "flex-start", gap: "var(--space-6)", marginTop: 8 },
  trendValue: { fontSize: 22, fontWeight: 700, color: "var(--text)" },
  emptyFocus: {
    border: "1px solid var(--line-soft)",
    borderRadius: "var(--radius-lg)",
    padding: "var(--space-5) var(--space-6)",
    background: "var(--surface-1)",
    boxShadow: "var(--shadow-1)",
  },
  reviewGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
    gap: "var(--space-3)",
  },
  reviewCard: { padding: "var(--space-3) var(--space-4) var(--space-4)" },
  reviewName: { fontSize: "var(--font-sm)", fontWeight: 600, color: "var(--text)" },
};
