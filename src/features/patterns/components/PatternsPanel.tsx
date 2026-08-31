import React, { useEffect, useMemo, useState } from "react";
import { MatchMetadata } from "../../../types";
import {
  deathClock,
  errorCategories,
  confidenceOf,
  type Confidence,
} from "../../../core/patterns";
import {
  ErrorClipMetadata,
  getAllErrorClips,
  getCameraZoneHistory,
  getPressureSummary,
  getRecordedMatches,
  type PressureSummary,
  type ZoneHistoryRow,
} from "../../../core/tauri-ipc";
import { computeKDA } from "../../../core/matchStats";
import { mmss } from "../../../core/time";
import { EmptyState } from "../../../components/ui/EmptyState";
import { BarChart3 } from "lucide-react";
import { useT } from "../../../core/LanguageProvider";

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

export const PatternsPanel: React.FC = () => {
  const [matches, setMatches] = useState<MatchMetadata[]>([]);
  const [clips, setClips] = useState<ErrorClipMetadata[]>([]);
  const [zonas, setZonas] = useState<ZoneHistoryRow[]>([]);
  const [presion, setPresion] = useState<PressureSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const t = useT();

  useEffect(() => {
    let alive = true;
    Promise.all([
      getRecordedMatches(),
      getAllErrorClips().catch(() => []),
      getCameraZoneHistory().catch(() => []),
      getPressureSummary().catch(() => null),
    ])
      .then(([ms, cs, zs, pr]) => {
        if (!alive) return;
        setMatches(ms);
        setClips(cs);
        setZonas(zs);
        setPresion(pr);
      })
      .catch(console.error)
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  // Los VODs importados no son partidas tuyas: mezclarlos falsearía el reloj.
  const own = useMemo(() => matches.filter((m) => !m.is_vod), [matches]);
  const clock = useMemo(() => deathClock(own), [own]);
  const cats = useMemo(() => errorCategories(clips), [clips]);
  const conf = confidenceOf(own.length);
  const maxBucket = useMemo(
    () => clock.buckets.reduce((a, b) => Math.max(a, b.total), 0),
    [clock]
  );
  const maxCat = useMemo(() => cats.reduce((a, c) => Math.max(a, c.count), 0), [cats]);

  // Todas tus muertes con sitio, de todas las partidas. La marca de muerte de
  // la timeline de Riot ya es sólo tuya y lleva coordenadas de mapa.
  const muertes = useMemo(
    () =>
      own.flatMap((m) =>
        (m.timeline_markers ?? []).filter(
          (tm) => tm.event_type === "death" && tm.position_x != null && tm.position_y != null
        )
      ),
    [own]
  );

  // Tu puesto, de la más antigua a la más nueva (para leerse como una línea).
  const puestos = useMemo(
    () =>
      own
        .filter((m) => m.impact_rank != null)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-15),
    [own]
  );

  // Cruce miradas ↔ muertes: se parten tus partidas por la mediana de
  // miradas/min y se comparan las muertes medias de cada mitad. No es
  // causalidad y la pantalla no la promete: es la comparación honesta que se
  // puede hacer con quince partidas.
  const cruceMiradas = useMemo(() => {
    const filas = own
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
  }, [own]);

  // Cruce oro@15 ↔ resultado.
  const cruceOro = useMemo(() => {
    const con = own.filter((m) => m.gold_diff_15 != null);
    const g = (xs: MatchMetadata[]) =>
      xs.length ? xs.reduce((a, m) => a + (m.gold_diff_15 ?? 0), 0) / xs.length : null;
    const vic = g(con.filter((m) => m.result === "Victory"));
    const der = g(con.filter((m) => m.result !== "Victory"));
    if (vic === null || der === null || con.length < 6) return null;
    return { vic: Math.round(vic), der: Math.round(der), n: con.length };
  }, [own]);

  if (loading) {
    return (
      <div style={styles.container} className="panel-enter">
        <div style={styles.center}><div className="spinner" /></div>
      </div>
    );
  }

  if (clock.total === 0) {
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

  return (
    <div style={styles.container} className="panel-enter">
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>{t("Patterns")}</h1>
          <div className="u-meta" style={{ marginTop: 4 }}>
            {own.length} {t("games")} · {clock.total} {t("deaths")} · {clock.wins}W {clock.losses}L
          </div>
        </div>
        <span style={{ ...styles.confidence, color: c.color, borderColor: c.color }}>
          {t(c.label)}
        </span>
      </div>

      {/* ------------------------------------------------- dónde mueres */}
      {/* El hero de la página, y por eso lleva la aureola (una por pantalla):
          la pregunta con la que se entra aquí es "¿qué me está matando?", y el
          DÓNDE enseña más que el cuándo. */}
      <div style={styles.heroRow}>
        <div className="card surface-hero" style={styles.card}>
          <div style={styles.cardHead}>
            <span className="u-label">{t("Where you die")}</span>
            <span className="u-meta">{muertes.length} {t("deaths")} · {own.length} {t("games")}</span>
          </div>
          {muertes.length === 0 ? (
            <p style={styles.insightText}>{t("Deaths get a map position when the game syncs with Riot.")}</p>
          ) : (
            <div style={styles.mapWrap}>
              <img
                src="https://ddragon.leagueoflegends.com/cdn/14.1.1/img/map/map11.png"
                alt=""
                style={styles.mapImg}
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              />
              {muertes.map((d, i) => (
                <span
                  key={i}
                  style={{
                    ...styles.deathDot,
                    left: `${Math.max(1, Math.min(99, (d.position_x! / 14820) * 100))}%`,
                    top: `${Math.max(1, Math.min(99, (1 - d.position_y! / 14881) * 100))}%`,
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* ---------------------------------------------------- reloj */}
        <div className="card" style={styles.card}>
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
          <div className="card" style={styles.card}>
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
            <div className="card" style={styles.card}>
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

      <div style={styles.grid}>
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
          <div className="card" style={styles.card}>
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
    alignItems: "start",
  },
  heroRow: {
    display: "grid",
    // mapa | reloj | puesto+presencia: las tres preguntas de la pantalla en la
    // primera fila, sin dejar el ancho muerto que dejaba el reloj viviendo abajo.
    gridTemplateColumns: "minmax(360px, 480px) minmax(340px, 1fr) minmax(300px, 400px)",
    gap: "var(--space-4)",
    alignItems: "start",
    marginBottom: "var(--space-4)",
  },
  sideCol: { display: "flex", flexDirection: "column", gap: "var(--space-4)" },
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
     acumulación, no cada punto. */
  deathDot: {
    position: "absolute",
    width: 9,
    height: 9,
    borderRadius: "50%",
    background: "color-mix(in srgb, var(--loss) 75%, transparent)",
    boxShadow: "0 0 8px 3px color-mix(in srgb, var(--loss) 45%, transparent)",
    transform: "translate(-50%, -50%)",
    pointerEvents: "none",
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
    marginTop: "var(--space-4)",
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
