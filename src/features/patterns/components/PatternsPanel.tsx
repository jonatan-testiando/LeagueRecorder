import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MatchEvent, MatchMetadata } from "../../../types";
import {
  deathClock,
  errorCategories,
  confidenceOf,
  forecastRank,
  ladderLp,
  filterByRole,
  ROLE_FILTERS,
  type RoleFilter,
  type Confidence,
} from "../../../core/patterns";
import { ddragonUrl, rankIcon, rankLabel } from "../../../core/ddragon";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import {
  ErrorClipMetadata,
  getAllErrorClips,
  getCameraZoneHistory,
  getPressureSummary,
  getSeasonForm,
  type SeasonForm,
  type PressureSummary,
  type ZoneHistoryRow,
} from "../../../core/tauri-ipc";
import { computeKDA, outcome } from "../../../core/matchStats";
import { mmss } from "../../../core/time";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { BarChart3 } from "lucide-react";
import { useT } from "../../../core/LanguageProvider";
import { useAppStore, useMatches } from "../../../store/useAppStore";

/**
 * Patrones: la única pantalla que mira más de una partida a la vez.
 *
 * El resto de la app trabaja siempre sobre una sola, y por eso datos como "en
 * qué minuto te mueres" llevaban meses en disco sin que nadie los enseñara.
 *
 * Regla de esta pantalla: no afirmar más de lo que aguanta la muestra. Con
 * quince partidas, dos muertes de diferencia entre tramos no son un hallazgo, y
 * presentarlas como tal sería mentir con gráficas.
 */

const CONFIDENCE_COPY: Record<Confidence, { label: string; note: string; color: string }> = {
  low: {
    label: "Early signal",
    note: "Under 15 games this points at a tendency, not a conclusion. It sharpens as you record more.",
    color: "var(--faint)",
  },
  medium: {
    label: "Likely pattern",
    note: "Enough games to steer by, though small gaps between windows are still noise.",
    color: "var(--gold)",
  },
  good: {
    label: "Solid pattern",
    note: "Enough games to trust the overall shape.",
    color: "var(--win)",
  },
};

const CATEGORY_COLOR: Record<string, string> = {
  "Decision Making": "var(--gold)",
  Positioning: "var(--flag)",
  Mechanics: "var(--cool)",
  Other: "var(--muted)",
};

/** Fases de partida para filtrar el mapa de muertes, en minutos de partida. */
type Phase = "all" | "early" | "mid" | "late";
const PHASES: { key: Phase; label: string }[] = [
  { key: "all", label: "All" },
  { key: "early", label: "Early (<14m)" },
  { key: "mid", label: "Mid (14–25m)" },
  { key: "late", label: "Late (>25m)" },
];
const inPhase = (gameMin: number, fase: Phase): boolean => {
  if (fase === "all") return true;
  if (fase === "early") return gameMin < 14;
  if (fase === "mid") return gameMin >= 14 && gameMin <= 25;
  return gameMin > 25;
};

/** Una muerte tuya con sitio en el mapa, ya atada a su partida. */
interface DeathPoint {
  matchId: string;
  /** Segundo del VÍDEO (para saltar al reproductor). */
  time: number;
  /** Segundo de PARTIDA (para el tooltip y la fase). */
  gameSec: number;
  x: number;
  y: number;
  result: ReturnType<typeof outcome>;
  killer: string | null;
}

/** El asesino de un evento de muerte: el campo estructurado si existe, o la
 *  frase legada ("Killed by X" / "Te mató X") si no. */
const killerOf = (ev: MatchEvent): string | null => {
  if (ev.actor) return ev.actor;
  const m = /^(?:Killed by|Te mató)\s+(.+)$/.exec(ev.description ?? "");
  return m ? m[1] : null;
};

export const PatternsPanel: React.FC = () => {
  // La biblioteca sale del store compartido: si la galería ya la cargó, aquí
  // no hay segunda lectura de disco.
  const { matches, loaded: matchesLoaded } = useMatches();
  const [clips, setClips] = useState<ErrorClipMetadata[]>([]);
  const [zonas, setZonas] = useState<ZoneHistoryRow[]>([]);
  const [presion, setPresion] = useState<PressureSummary | null>(null);
  const [forma, setForma] = useState<SeasonForm | null>(null);
  const [formaError, setFormaError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rol, setRol] = useState<RoleFilter>("all");
  const [fase, setFase] = useState<Phase>("all");
  const [hover, setHover] = useState<{ d: DeathPoint; left: number; top: number } | null>(null);
  const t = useT();
  const navigate = useNavigate();
  const setSelectedMatch = useAppStore((s) => s.setSelectedMatch);
  const setPendingSeek = useAppStore((s) => s.setPendingSeek);

  useEffect(() => {
    let alive = true;
    Promise.all([
      getAllErrorClips().catch(() => []),
      getCameraZoneHistory().catch(() => []),
      getPressureSummary().catch(() => null),
    ])
      .then(([cs, zs, pr]) => {
        if (!alive) return;
        setClips(cs);
        setZonas(zs);
        setPresion(pr);
      })
      .catch(console.error)
      .finally(() => alive && setLoading(false));
    // La forma de temporada va aparte: puede tardar (hasta 20 detalles de la
    // API la primera vez) y la página no tiene por qué esperarla.
    getSeasonForm()
      .then((f) => alive && setForma(f))
      // El motivo llega con un código estable delante ("no_key: …"): la
      // tarjeta de la predicción lo usa para decir qué falta, no solo callar.
      .catch((e) => alive && setFormaError(typeof e === "string" ? e : String(e)));
    return () => { alive = false; };
  }, []);

  // Los VODs importados no son partidas tuyas: mezclarlos falsearía el reloj.
  const own = useMemo(() => matches.filter((m) => !m.is_vod), [matches]);
  // El filtro de rol se aplica ANTES de agregar: mezclar el reloj de muertes de
  // support con el de jungla es exactamente el ruido que esta pantalla evita.
  const propias = useMemo(() => filterByRole(own, rol), [own, rol]);
  const clock = useMemo(() => deathClock(propias), [propias]);
  const cats = useMemo(() => errorCategories(clips), [clips]);
  const conf = confidenceOf(propias.length);
  const maxBucket = useMemo(
    () => clock.buckets.reduce((a, b) => Math.max(a, b.total), 0),
    [clock]
  );
  const maxCat = useMemo(() => cats.reduce((a, c) => Math.max(a, c.count), 0), [cats]);

  // Todas tus muertes con sitio, de las partidas del filtro. La marca de muerte
  // de la timeline de Riot ya es sólo tuya y lleva coordenadas de mapa; el
  // asesino se recupera emparejándola con tu evento de muerte más cercano.
  const muertes = useMemo<DeathPoint[]>(() => {
    const out: DeathPoint[] = [];
    for (const m of propias) {
      const offset = m.video_offset ?? 0;
      const res = outcome(m.result);
      const eventosMuerte = m.events
        .filter((ev) => ev.type === "ChampionKill" && ev.subtype === "death")
        .map((ev) => ({ time: ev.time, killer: killerOf(ev) }));
      for (const tm of m.timeline_markers ?? []) {
        if (tm.event_type !== "death" || tm.position_x == null || tm.position_y == null) continue;
        // El marcador y el evento en directo son la misma muerte con relojes
        // distintos; a más de 15 s ya no es ella y mejor no inventar asesino.
        let killer: string | null = null;
        let mejor = 15;
        for (const ev of eventosMuerte) {
          const d = Math.abs(ev.time - tm.time);
          if (d < mejor && ev.killer) { mejor = d; killer = ev.killer; }
        }
        out.push({
          matchId: m.id,
          time: tm.time,
          gameSec: Math.max(0, tm.time - offset),
          x: tm.position_x,
          y: tm.position_y,
          result: res,
          killer,
        });
      }
    }
    return out;
  }, [propias]);

  const muertesFase = useMemo(
    () => muertes.filter((d) => inPhase(d.gameSec / 60, fase)),
    [muertes, fase]
  );

  const abrirMuerte = (d: DeathPoint) => {
    const m = matches.find((x) => x.id === d.matchId);
    if (!m) return;
    setSelectedMatch(m);
    setPendingSeek(d.time);
    navigate("/review");
  };

  // Tu puesto, de la más antigua a la más nueva (para leerse como una línea).
  const puestos = useMemo(
    () =>
      propias
        .filter((m) => m.impact_rank != null)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-15),
    [propias]
  );

  // Cruce miradas ↔ muertes: se parten tus partidas por la mediana de
  // miradas/min y se comparan las muertes medias de cada mitad. No es
  // causalidad y la pantalla no la promete: es la comparación honesta que se
  // puede hacer con quince partidas.
  const cruceMiradas = useMemo(() => {
    const filas = propias
      .filter((m) => (m.camera_snaps?.length ?? 0) > 0 && m.game_duration > 60)
      .map((m) => ({
        ritmo: (m.camera_snaps!.length / m.game_duration) * 60,
        muertes: computeKDA(m.events).deaths,
      }));
    if (filas.length < 6) return null;
    const orden = [...filas].sort((a, b) => a.ritmo - b.ritmo);
    const mitad = Math.floor(orden.length / 2);
    const media = (xs: typeof filas) => xs.reduce((a, x) => a + x.muertes, 0) / xs.length;
    const pocaVista = media(orden.slice(0, mitad));
    const muchaVista = media(orden.slice(orden.length - mitad));
    if (muchaVista === 0) return null;
    return { pct: Math.round(((pocaVista - muchaVista) / muchaVista) * 100), n: filas.length };
  }, [propias]);

  // Cruce oro@15 ↔ resultado.
  // La predicción, con la forma de la CUENTA (grabadas o no).
  const prediccion = useMemo(
    () =>
      forma
        ? forecastRank(forma.games, forma.tier, forma.division, forma.lp, forma.avg_gain, forma.avg_loss)
        : null,
    [forma]
  );

  // La escalada: LP absoluto en la escalera, partida grabada a partida.
  const escalada = useMemo(() => {
    return propias
      .filter((m) => m.rank_lp != null && m.rank_tier)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((m) => ladderLp(m.rank_tier as string, m.rank_division, m.rank_lp as number));
  }, [propias]);

  // Tu pool: con quién juegas y con quién GANAS, del histórico grabado.
  const pool = useMemo(() => {
    const por = new Map<string, { games: number; wins: number; k: number; d: number; a: number }>();
    for (const m of propias) {
      const e = por.get(m.champion) ?? { games: 0, wins: 0, k: 0, d: 0, a: 0 };
      e.games += 1;
      if (m.result === "Victory") e.wins += 1;
      const kda = (m.kda ?? "").split("/").map(Number);
      if (kda.length === 3 && kda.every((x) => !Number.isNaN(x))) {
        e.k += kda[0]; e.d += kda[1]; e.a += kda[2];
      }
      por.set(m.champion, e);
    }
    return [...por.entries()]
      .map(([champion, e]) => ({ champion, ...e, wr: e.wins / e.games }))
      .sort((a, b) => b.games - a.games)
      .slice(0, 6);
  }, [propias]);

  // Tus rivales de carril: el espejo de índice, agregado.
  const rivales = useMemo(() => {
    const por = new Map<string, { games: number; losses: number }>();
    for (const m of propias) {
      const ps = m.participants;
      if (!ps || ps.length !== 10) continue;
      const idx = ps.findIndex((p) => p.is_self);
      if (idx < 0) continue;
      const rival = ps[(idx + 5) % 10];
      const e = por.get(rival.champion) ?? { games: 0, losses: 0 };
      e.games += 1;
      if (m.result !== "Victory") e.losses += 1;
      por.set(rival.champion, e);
    }
    return [...por.entries()]
      .map(([champion, e]) => ({ champion, ...e, wr: (e.games - e.losses) / e.games }))
      .filter((r) => r.games >= 1)
      .sort((a, b) => b.losses - a.losses || b.games - a.games)
      .slice(0, 6);
  }, [propias]);

  const cruceOro = useMemo(() => {
    const con = propias.filter((m) => m.gold_diff_15 != null);
    const g = (xs: MatchMetadata[]) =>
      xs.length ? xs.reduce((a, m) => a + (m.gold_diff_15 ?? 0), 0) / xs.length : null;
    const vic = g(con.filter((m) => m.result === "Victory"));
    const der = g(con.filter((m) => m.result !== "Victory"));
    if (vic === null || der === null || con.length < 6) return null;
    return { vic: Math.round(vic), der: Math.round(der), n: con.length };
  }, [propias]);

  if (loading || !matchesLoaded) {
    return (
      <div style={styles.container} className="panel-enter">
        <div style={styles.center}><div className="spinner" /></div>
      </div>
    );
  }

  // El estado vacío global solo cuando de verdad no hay nada que agregar. Con
  // un rol filtrado a cero, la página sigue en pie (y el filtro, a la vista)
  // para poder volver a "Todos".
  if (rol === "all" && clock.total === 0) {
    return (
      <div style={styles.container} className="panel-enter">
        <div style={styles.header}>
          <h1 style={styles.title}>{t("Patterns")}</h1>
        </div>
        <EmptyState
          icon={<BarChart3 size={30} color="var(--faint)" />}
          title={t("Not enough games yet")}
          text={t("Once a few games are recorded, this screen starts showing what they have in common.")}
        />
      </div>
    );
  }

  const c = CONFIDENCE_COPY[conf];
  const codigoForma = formaError ? formaError.split(":")[0].trim() : null;

  return (
    <div style={styles.container} className="panel-enter">
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>{t("Patterns")}</h1>
          <div className="u-meta" style={{ marginTop: 4 }}>
            {propias.length} {t("games")} · {clock.total} {t("deaths")} · {clock.wins}W {clock.losses}L
          </div>
        </div>
        <span style={{ ...styles.confidence, color: c.color, borderColor: c.color }}>
          {t(c.label)}
        </span>
      </div>

      {/* Filtro de rol: cada agregado de abajo se recalcula solo con las
          partidas jugadas en ese puesto. */}
      <div style={styles.roleRow}>
        {ROLE_FILTERS.map((r) => (
          <Button
            key={r.key}
            variant="ghost"
            size="sm"
            aria-pressed={rol === r.key}
            onClick={() => setRol(r.key)}
          >
            {t(r.label)}
          </Button>
        ))}
      </div>

      {/* ------------------------------------------------- dónde mueres */}
      {/* El hero de la página, y por eso lleva la aureola (una por pantalla):
          la pregunta con la que se entra aquí es "¿qué me está matando?", y el
          DÓNDE enseña más que el cuándo. */}
      <div style={styles.heroRow}>
        <div className="card surface-hero" style={styles.card}>
          <div style={styles.cardHead}>
            <span className="u-label">{t("Where you die")}</span>
            <span className="u-meta">{muertesFase.length} {t("deaths")} · {propias.length} {t("games")}</span>
          </div>
          {muertes.length === 0 ? (
            <p style={styles.insightText}>{t("Deaths get a map position when the game syncs with Riot.")}</p>
          ) : (
            <>
              {/* Selector de fase: el early y el late cuentan historias
                  distintas y mezclados se tapan. */}
              <div style={styles.phaseRow}>
                {PHASES.map((p) => (
                  <Button
                    key={p.key}
                    variant="ghost"
                    size="sm"
                    aria-pressed={fase === p.key}
                    onClick={() => { setFase(p.key); setHover(null); }}
                  >
                    {t(p.label)}
                  </Button>
                ))}
              </div>
              <div style={styles.mapWrap}>
                <img
                  src={ddragonUrl("/cdn/14.1.1/img/map/map11.png")}
                  alt=""
                  style={styles.mapImg}
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                />
                {muertesFase.map((d, i) => {
                  const left = Math.max(1, Math.min(99, (d.x / 14820) * 100));
                  const top = Math.max(1, Math.min(99, (1 - d.y / 14881) * 100));
                  return (
                    <span
                      key={`${d.matchId}-${d.time}-${i}`}
                      style={{ ...styles.deathDot, left: `${left}%`, top: `${top}%` }}
                      role="button"
                      tabIndex={0}
                      aria-label={t("Open this death in the player")}
                      onMouseEnter={() => setHover({ d, left, top })}
                      onMouseLeave={() => setHover(null)}
                      onClick={() => abrirMuerte(d)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); abrirMuerte(d); }
                      }}
                    />
                  );
                })}
                {hover && (
                  <div style={{ ...styles.deathTip, left: `${hover.left}%`, top: `${hover.top}%` }}>
                    <span className="u-metric">{mmss(hover.d.gameSec)}</span>
                    {hover.d.killer && <span> · {hover.d.killer}</span>}
                    <span
                      style={{
                        color:
                          hover.d.result === "victory"
                            ? "var(--win)"
                            : hover.d.result === "defeat"
                              ? "var(--loss)"
                              : "var(--faint)",
                      }}
                    >
                      {" · "}
                      {t(
                        hover.d.result === "victory"
                          ? "victory"
                          : hover.d.result === "defeat"
                            ? "defeat"
                            : "no result"
                      )}
                    </span>
                  </div>
                )}
              </div>
              <p style={{ ...styles.insightText, color: "var(--faint)", marginTop: 8 }}>
                {t("Click a death to open that game at that exact moment.")}
              </p>
            </>
          )}
        </div>

        {/* ---------------------------------------------------- reloj */}
        <div className="card" style={{ ...styles.card, display: "flex", flexDirection: "column" }}>
          <div style={styles.cardHead}>
            <span className="u-label">{t("When you die")}</span>
            <span className="u-meta">{t("by minute of game")}</span>
          </div>

          <div style={styles.clock}>
            {clock.buckets.map((b) => {
              const isPeak = clock.peak !== null && b.from === clock.peak.from;
              return (
                <div
                  key={b.from}
                  style={styles.clockRow}
                  title={`${b.total} deaths · ${b.inWins} in wins, ${b.inLosses} in losses`}
                >
                  <span
                    className="u-metric"
                    style={{
                      ...styles.clockTime,
                      color: isPeak ? "var(--loss)" : "var(--faint)",
                    }}
                  >
                    {b.from}–{b.to}
                  </span>
                  <span style={styles.clockTrack}>
                    <span
                      style={{
                        ...styles.clockFill,
                        width: `${maxBucket ? (b.total / maxBucket) * 100 : 0}%`,
                        opacity: isPeak ? 1 : 0.45,
                      }}
                    />
                  </span>
                  <span className="u-metric" style={styles.clockValue}>{b.total}</span>
                </div>
              );
            })}
          </div>

          {clock.peak && (
            <div style={styles.insight}>
              <p style={styles.insightText}>
                <strong style={{ color: "var(--text)" }}>
                  {t("Minute {a}–{b} is your worst window.", { a: clock.peak.from, b: clock.peak.to })}
                </strong>{" "}
                {t("{n} of your {total} deaths land there ({pct}%).", {
                  n: clock.peak.total,
                  total: clock.total,
                  pct: Math.round((clock.peak.total / clock.total) * 100),
                })}
              </p>
              <p style={{ ...styles.insightText, color: "var(--faint)", marginTop: 6 }}>
                {t(c.note)}
              </p>
            </div>
          )}

          {clock.deathsPerWin !== null && clock.deathsPerLoss !== null && (
            <div style={styles.split}>
              <div>
                <div className="u-metric" style={{ fontSize: 16, color: "var(--win)" }}>
                  {clock.deathsPerWin.toFixed(1)}
                </div>
                <div className="u-label" style={{ marginTop: 3 }}>{t("deaths per win")}</div>
              </div>
              <div>
                <div className="u-metric" style={{ fontSize: 16, color: "var(--loss)" }}>
                  {clock.deathsPerLoss.toFixed(1)}
                </div>
                <div className="u-label" style={{ marginTop: 3 }}>{t("deaths per loss")}</div>
              </div>
            </div>
          )}
        </div>

        <div style={styles.sideCol}>
          {/* Tu puesto, partida a partida. */}
          <div className="card" style={{ ...styles.card, flex: 1 }}>
            <div style={styles.cardHead}>
              <span className="u-label">{t("Your rank, game by game")}</span>
              <span className="u-meta">{puestos.length ? `${t("latest")} ${puestos.length}` : ""}</span>
            </div>
            {puestos.length === 0 ? (
              <p style={styles.insightText}>{t("Ranks appear as games sync with Riot.")}</p>
            ) : (
              <div style={styles.rankStrip}>
                {puestos.map((m) => (
                  <span
                    key={m.id}
                    className="u-metric"
                    title={`${m.champion} · ${m.date}`}
                    style={{
                      ...styles.rankChip,
                      color:
                        m.impact_rank === 1 ? "var(--gold)" : m.impact_rank! >= 8 ? "var(--loss)" : "var(--text)",
                      borderColor:
                        m.impact_rank === 1 ? "var(--gold)" : "var(--line)",
                    }}
                  >
                    {m.impact_rank === 1 ? "MVP" : `${m.impact_rank}º`}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Lo que compra tu presencia. */}
          {presion !== null && presion.windows > 0 && (
            <div className="card" style={{ ...styles.card, flex: 1 }}>
              <div style={styles.cardHead}>
                <span className="u-label">{t("What your presence buys")}</span>
                <span className="u-meta">{presion.games} {t("games")}</span>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span className="u-metric" style={{ fontSize: 22, fontWeight: 700, color: "var(--win)" }}>
                  +{(presion.wpa * 100).toFixed(0)}%
                </span>
                <span className="u-meta">{t("win prob. your team took elsewhere")}</span>
              </div>
              <p style={{ ...styles.insightText, marginTop: 8 }}>
                {presion.windows} {t("stretches")} · {presion.towers} {t("towers")} · {Math.round(presion.gold / 1000)}k {t("gold")}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ------------------------- trayectoria: dónde estás y hacia dónde vas */}
      {(prediccion || escalada.length >= 3 || codigoForma || (forma && forma.games.length < 8)) && (
        <div className="card" style={{ ...styles.card, marginBottom: "var(--space-4)" }}>
          <div style={styles.cardHead}>
            <span className="u-label">{t("Rank forecast")}</span>
            {forma && (
              <span className="u-meta">
                {t("your last {n} ranked games, recorded or not", { n: forma.games.length })}
              </span>
            )}
          </div>
          {/* La predicción cuenta por qué no está, en vez de desaparecer:
              sin clave, con la clave caducada o con poca muestra. */}
          {!prediccion && (codigoForma === "no_key" || codigoForma === "key_invalid") && (
            <div style={styles.formaAviso}>
              <p style={styles.insightText}>
                {t(
                  codigoForma === "no_key"
                    ? "The rank forecast needs your Riot API key."
                    : "Your Riot API key is invalid or has expired."
                )}
              </p>
              <Button variant="ghost" size="sm" onClick={() => navigate("/settings")}>
                {t("Go to Settings to set up the Riot API key")}
              </Button>
            </div>
          )}
          {!prediccion && codigoForma === "rate_limited" && (
            <p style={styles.insightText}>
              {t("Riot is rate limiting requests right now; the forecast retries on the next visit.")}
            </p>
          )}
          {!prediccion && !codigoForma && forma && forma.games.length < 8 && (
            <p style={styles.insightText}>
              {t("At least 8 ranked games are needed to compute the projection ({n} so far).", {
                n: forma.games.length,
              })}
            </p>
          )}
          <div style={styles.trayRow}>
            {prediccion && forma?.tier && (
              <div style={styles.predBlock}>
                <div style={styles.predChip}>
                  <img src={rankIcon(forma.tier)} alt="" style={styles.predIcono} />
                  <div>
                    <div style={styles.predRango}>{rankLabel(forma.tier, forma.division)}</div>
                    <div className="u-meta">{forma.lp} LP</div>
                  </div>
                </div>
                <span style={styles.predFlecha}>→</span>
                <div style={{ ...styles.predChip, borderColor: "var(--brand)" }}>
                  <img src={rankIcon(prediccion.pred.tier)} alt="" style={styles.predIcono} />
                  <div>
                    <div style={styles.predRango}>
                      {rankLabel(prediccion.pred.tier, prediccion.pred.division)}
                    </div>
                    <div className="u-meta">
                      {t("in ~20 games")}
                    </div>
                  </div>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="u-metric" style={{ fontSize: 15, fontWeight: 700 }}>
                    {prediccion.wins}V {prediccion.losses}D
                    {prediccion.avgScore != null && (
                      <span style={{ marginLeft: 8, color: "var(--brand)" }} title={t("Performance percentile inside each game's lobby, recent games weigh double")}>
                        {Math.round(prediccion.avgScore)} {t("score")}
                      </span>
                    )}
                    <span
                      style={{
                        marginLeft: 8,
                        color: prediccion.netPerGame >= 0 ? "var(--win)" : "var(--loss)",
                      }}
                    >
                      {prediccion.netPerGame >= 0 ? "+" : "−"}
                      {Math.abs(prediccion.netPerGame).toFixed(1)} LP
                    </span>
                    <span className="u-meta"> {t("per game at this pace")}</span>
                  </div>
                  <p style={{ ...styles.insightText, marginTop: 4 }}>
                    {t("Record and performance, blended: your score inside each lobby corrects the winrate (losing while outplaying projects up). LP swings measured from your own games. It points, it doesn't promise.")}
                  </p>
                </div>
              </div>
            )}
            {escalada.length >= 3 && (() => {
              const min = Math.min(...escalada);
              const max = Math.max(...escalada);
              const rango = Math.max(1, max - min);
              const W = 220;
              const H = 44;
              const pts = escalada
                .map((v, i) => `${((i / (escalada.length - 1)) * W).toFixed(1)},${(H - 4 - ((v - min) / rango) * (H - 8)).toFixed(1)}`)
                .join(" ");
              const sube = escalada[escalada.length - 1] >= escalada[0];
              return (
                <div style={styles.escaladaBlock}>
                  <svg width={W} height={H} style={{ display: "block" }}>
                    <polyline
                      points={pts}
                      fill="none"
                      stroke={sube ? "var(--win)" : "var(--loss)"}
                      strokeWidth="1.5"
                    />
                  </svg>
                  <span className="u-meta">
                    {t("your climb, LP across {n} recorded games", { n: escalada.length })}
                  </span>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      <div style={styles.grid}>
        {/* ------------------------------------------------ tu pool y tus rivales */}
        {pool.length >= 2 && (
          <div className="card" style={styles.card}>
            <div style={styles.cardHead}>
              <span className="u-label">{t("Your pool")}</span>
              <span className="u-meta">{t("who you actually win with")}</span>
            </div>
            {pool.map((c) => (
              <div key={c.champion} style={styles.poolRow}>
                <ChampionAvatar champion={c.champion} size={22} />
                <span style={styles.poolNombre}>{c.champion}</span>
                <span className="u-meta">{c.games} {t(c.games === 1 ? "game" : "games")}</span>
                <span
                  className="u-metric"
                  style={{ marginLeft: "auto", color: c.wr >= 0.5 ? "var(--win)" : "var(--loss)", fontWeight: 600 }}
                >
                  {Math.round(c.wr * 100)}%
                </span>
                <span className="u-meta" style={{ width: 74, textAlign: "right" }}>
                  {c.d > 0 ? ((c.k + c.a) / c.d).toFixed(1) : "∞"} KDA
                </span>
              </div>
            ))}
          </div>
        )}

        {rivales.length >= 2 && (
          <div className="card" style={styles.card}>
            <div style={styles.cardHead}>
              <span className="u-label">{t("Your rivals")}</span>
              <span className="u-meta">{t("the lane opponents that beat you")}</span>
            </div>
            {rivales.map((r) => (
              <div key={r.champion} style={styles.poolRow}>
                <ChampionAvatar champion={r.champion} size={22} />
                <span style={styles.poolNombre}>vs {r.champion}</span>
                <span className="u-meta">{r.games} {t(r.games === 1 ? "game" : "games")}</span>
                <span
                  className="u-metric"
                  style={{ marginLeft: "auto", color: r.wr >= 0.5 ? "var(--win)" : "var(--loss)", fontWeight: 600 }}
                >
                  {Math.round(r.wr * 100)}%
                </span>
              </div>
            ))}
          </div>
        )}
      {/* --------------------------------------- el punto ciego, por partida */}
      {zonas.length >= 3 && (() => {
        const filas = zonas.slice(-12);
        const peorDe = (g: [number, number, number]) => g.indexOf(Math.max(...g));
        return (
          <div className="card" style={styles.card}>
            <div style={styles.cardHead}>
              <span className="u-label">{t("Blind spot, game by game")}</span>
              <span className="u-meta">{t("longest stretch without a look, per lane")}</span>
            </div>
            <div style={styles.zoneGrid}>
              <span />
              <span className="u-label" style={{ textAlign: "right" }}>Top</span>
              <span className="u-label" style={{ textAlign: "right" }}>Mid</span>
              <span className="u-label" style={{ textAlign: "right" }}>Bot</span>
              {filas.map((z) => {
                const peor = peorDe(z.gaps);
                return (
                  <React.Fragment key={z.match_id}>
                    <span className="u-meta">{z.date.slice(5, 10)}</span>
                    {z.gaps.map((g, i) => (
                      <span
                        key={i}
                        className="u-metric"
                        style={{ textAlign: "right", color: i === peor ? "var(--loss)" : "var(--muted)" }}
                      >
                        {mmss(g)}
                      </span>
                    ))}
                  </React.Fragment>
                );
              })}
            </div>
            <p style={{ ...styles.insightText, color: "var(--faint)", marginTop: 10 }}>
              {t("This is the row to watch after training a lane: it is the only screen that can tell whether it is working.")}
            </p>
          </div>
        );
      })()}

        {/* ---------------------------------------------- tus etiquetas */}
        <div className="card" style={styles.card}>
          <div style={styles.cardHead}>
            <span className="u-label">{t("What you flag yourself")}</span>
            <span className="u-meta">{cats.reduce((a, x) => a + x.count, 0)} {t("notes")}</span>
          </div>

          {cats.length === 0 ? (
            <p style={styles.insightText}>
              {t("You haven't categorised any errors yet. The chart on the left comes from the recorded data; this one would come from your own reading of it.")}
            </p>
          ) : (
            <div style={styles.cats}>
              {cats.map((x) => (
                <div key={x.category} style={styles.catRow}>
                  <div style={{ minWidth: 0 }}>
                    <div style={styles.catLabel}>{x.category}</div>
                    <div style={styles.catTrack}>
                      <span
                        style={{
                          ...styles.catFill,
                          width: `${maxCat ? (x.count / maxCat) * 100 : 0}%`,
                          background: CATEGORY_COLOR[x.category] ?? "var(--muted)",
                        }}
                      />
                    </div>
                  </div>
                  <span className="u-metric" style={styles.catValue}>{x.count}</span>
                </div>
              ))}
            </div>
          )}

          {/* La pantalla es honesta sobre su propia cobertura: si marcas poco,
              lo dice, en vez de presentar tres notas como si fueran un perfil. */}
          {clock.total > 0 && (
            <div style={{ ...styles.insight, borderLeftColor: "var(--gold)" }}>
              <p style={styles.insightText}>
                <strong style={{ color: "var(--text)" }}>
                  {t("{n} notes across {total} deaths.", {
                    n: cats.reduce((a, x) => a + x.count, 0),
                    total: clock.total,
                  })}
                </strong>{" "}
                {t("The window above comes from the data, not from your reading of it. Flagging even one moment per game is what turns \"when\" into \"why\".")}
              </p>
            </div>
          )}
        </div>

        {/* ------------------------------------------------ cruces honestos */}
        {(cruceMiradas !== null || cruceOro !== null) && (
          <div className="card" style={{ ...styles.card, background: "var(--media-sheen)" }}>
            <div style={styles.cardHead}>
              <span className="u-label">{t("Crossings")}</span>
              <span className="u-meta">{t(c.label)}</span>
            </div>
            {cruceMiradas !== null && (
              <p style={styles.insightText}>
                {cruceMiradas.pct > 0
                  ? t("In your low map-checking games you die {pct}% more than in the high ones ({n} games).", { pct: cruceMiradas.pct, n: cruceMiradas.n })
                  : t("Your deaths barely change with how much you check the map ({n} games).", { n: cruceMiradas.n })}
              </p>
            )}
            {cruceOro !== null && (
              <p style={styles.insightText}>
                {t("Gold @15 averages {vic} in your wins and {der} in your losses ({n} games).", {
                  vic: `${cruceOro.vic >= 0 ? "+" : ""}${cruceOro.vic}`,
                  der: `${cruceOro.der >= 0 ? "+" : ""}${cruceOro.der}`,
                  n: cruceOro.n,
                })}
              </p>
            )}
            <p style={{ ...styles.insightText, color: "var(--faint)", marginTop: 6 }}>
              {t("Comparisons, not causes: with this sample they point, they don't prove.")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: "var(--space-6) var(--space-8)",
    height: "100%",
    boxSizing: "border-box",
    overflowY: "auto",
    background: "transparent",
  },
  center: { display: "grid", placeItems: "center", height: "100%" },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "var(--space-4)",
    marginBottom: "var(--space-5)",
  },
  title: { margin: 0, fontSize: "var(--font-xl)" },
  confidence: {
    fontFamily: "var(--font-mono)",
    fontSize: "10px",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    padding: "4px 10px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
    gap: "var(--space-4)",
  },
  trayRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-5)",
    flexWrap: "wrap",
  },
  predBlock: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    flex: 1,
    minWidth: 320,
  },
  predChip: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 12px",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--line)",
    background: "var(--raised)",
  },
  predIcono: { width: 28, height: 28, display: "block" },
  predRango: { fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" },
  predFlecha: { color: "var(--faint)", fontSize: 16 },
  escaladaBlock: { display: "flex", flexDirection: "column", gap: 4 },
  poolRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "5px 0",
    borderBottom: "1px solid var(--line-soft)",
  },
  poolNombre: { fontSize: 13, fontWeight: 500 },
  heroRow: {
    display: "grid",
    // mapa | reloj | puesto+presencia: las tres preguntas de la pantalla en la
    // primera fila, sin dejar el ancho muerto que dejaba el reloj viviendo abajo.
    gridTemplateColumns: "minmax(360px, 480px) minmax(340px, 1fr) minmax(300px, 400px)",
    gap: "var(--space-4)",
    // stretch, no start: en una fila, todas las tarjetas al mismo alto. El
    // desnivel era lo que el usuario leía como "raro".
    marginBottom: "var(--space-4)",
  },
  sideCol: { display: "flex", flexDirection: "column", gap: "var(--space-4)", height: "100%" },
  mapWrap: {
    position: "relative",
    width: "100%",
    aspectRatio: "1 / 1",
    background: "var(--sunken)",
    borderRadius: "var(--radius-md)",
    overflow: "hidden",
    border: "1px solid var(--line-soft)",
  },
  mapImg: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "fill",
    filter: "brightness(0.55) saturate(0.7)",
  },
  /* Punto de muerte: pequeño y translúcido a propósito — el calor lo hace la
     acumulación, no cada punto. Ahora responde al ratón: tooltip y salto. */
  deathDot: {
    position: "absolute",
    width: 9,
    height: 9,
    borderRadius: "50%",
    background: "color-mix(in srgb, var(--loss) 75%, transparent)",
    boxShadow: "0 0 8px 3px color-mix(in srgb, var(--loss) 45%, transparent)",
    transform: "translate(-50%, -50%)",
    cursor: "pointer",
  },
  /* Tooltip propio sobre el mapa: el `title` nativo tarda un segundo en salir
     y no puede colorear el resultado. */
  deathTip: {
    position: "absolute",
    transform: "translate(-50%, calc(-100% - 10px))",
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius-sm)",
    padding: "4px 8px",
    fontSize: 11,
    color: "var(--text)",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    zIndex: 3,
  },
  roleRow: {
    display: "flex",
    gap: "var(--space-2)",
    flexWrap: "wrap",
    marginBottom: "var(--space-4)",
  },
  phaseRow: {
    display: "flex",
    gap: "var(--space-1)",
    flexWrap: "wrap",
    marginBottom: "var(--space-3)",
  },
  formaAviso: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "var(--space-2)",
    marginBottom: "var(--space-3)",
  },
  rankStrip: { display: "flex", flexWrap: "wrap", gap: 6 },
  rankChip: {
    padding: "2px 7px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--line)",
    fontSize: 12,
    fontWeight: 700,
  },
  zoneGrid: {
    display: "grid",
    gridTemplateColumns: "56px 1fr 1fr 1fr",
    gap: "4px 12px",
    alignItems: "baseline",
  },
  card: { padding: "var(--space-4)" },
  cardHead: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: "var(--space-4)",
  },
  clock: { display: "flex", flexDirection: "column", gap: "4px" },
  clockRow: {
    display: "grid",
    gridTemplateColumns: "56px 1fr 28px",
    gap: "var(--space-3)",
    alignItems: "center",
  },
  clockTime: { fontSize: "10px" },
  // Pista hundida y relleno con filo: es el mismo modelo de luz que el resto,
  // aplicado a lo que en esta pantalla lleva el dato. La sombra le entra a la
  // pista por arriba; la barra que la rellena la recibe.
  clockTrack: {
    height: "11px",
    background: "var(--sunken)",
    borderRadius: "2px",
    overflow: "hidden",
    boxShadow: "var(--inset-sunken)",
  },
  clockFill: {
    display: "block",
    height: "100%",
    borderRadius: "2px",
    background: "var(--loss)",
    boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.22)",
  },
  clockValue: { fontSize: "10.5px", textAlign: "right", color: "var(--muted)" },
  insight: {
    marginTop: "var(--space-4)",
    padding: "var(--space-3)",
    borderLeft: "2px solid var(--loss)",
    background: "color-mix(in srgb, var(--loss) 7%, transparent)",
    borderRadius: "0 var(--radius-sm) var(--radius-sm) 0",
  },
  insightText: {
    margin: 0,
    // 13px, no 12: es prosa que se LEE, no una etiqueta que se reconoce. La
    // queja de "no sé si es la fuente" era en parte este escalón que faltaba.
    fontSize: "13px",
    lineHeight: 1.6,
    color: "var(--muted)",
  },
  split: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "var(--space-4)",
    // auto y no un margen fijo: con la tarjeta estirada a la altura del mapa,
    // el par victoria/derrota se ancla al pie en vez de flotar a media altura.
    marginTop: "auto",
    paddingTop: "var(--space-4)",
    borderTop: "1px solid var(--line-soft)",
  },
  cats: { display: "flex", flexDirection: "column", gap: "var(--space-3)" },
  catRow: {
    display: "grid",
    gridTemplateColumns: "1fr 32px",
    gap: "var(--space-3)",
    alignItems: "center",
  },
  catLabel: { fontSize: "var(--font-xs)", color: "var(--muted)" },
  catTrack: {
    height: "4px",
    background: "var(--sunken)",
    borderRadius: "2px",
    overflow: "hidden",
    marginTop: "5px",
    boxShadow: "var(--inset-sunken)",
  },
  catFill: {
    display: "block",
    height: "100%",
    borderRadius: "2px",
    boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.22)",
  },
  catValue: { fontSize: "11px", textAlign: "right", color: "var(--muted)" },
};
