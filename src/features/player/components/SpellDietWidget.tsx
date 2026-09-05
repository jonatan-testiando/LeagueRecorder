import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Swords } from "lucide-react";
import {
  getSpellAutopsy,
  getSpellDiet,
  type SpellHit,
  type SpellReport,
} from "../../../core/tauri-ipc";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { EmptyState } from "../../../components/ui/EmptyState";
import { wstyles } from "./videoPlayerStyles";

/**
 * Qué hechizos te comes y qué hacía tu mano al comértelos.
 *
 * El desglose sale de `victimDamageReceived` de la Timeline v5, que es la única
 * fuente del juego que dice "te mató la Q de Ahri" en vez de "te mató Ahri". El
 * cálculo y sus tres límites están documentados en `src-tauri/src/spells.rs`; el
 * más importante hay que repetirlo en pantalla y por eso está en el pie: esto
 * mide las peleas que acabaron contigo en el suelo, no todos los hechizos que
 * te rozan.
 */

type Scope = "match" | "career";

interface SpellDietWidgetProps {
  matchId: string;
  onSeek: (seconds: number) => void;
}

/**
 * Q/W/E/R, AA para el autoataque, raya para pasivas, objetos y runas.
 *
 * `spellSlot` viene 0-INDEXADO. Medido contra 23 partidas reales: `garenq`
 * llega con slot 0, `vaynesilveredbolts` (la W) con 1, `garene` con 2 y tanto
 * `garenr` como `feast` (la R de Cho'Gath) con 3. Lo que no es habilidad usa
 * 63, 64, 46 o -1. Empezar el mapa en 1, que es lo que parece a simple vista,
 * corría todo un puesto y pintaba las ultis como E.
 */
function ranura(slot: number, basic: boolean): string {
  if (basic) return "AA";
  return ["Q", "W", "E", "R"][slot] ?? "—";
}

/**
 * El nombre interno de Riot, aligerado.
 *
 * No hay catálogo de nombres bonitos sin bajarse el `champion.json` de cada
 * campeón. Riot los manda en minúsculas y con el campeón pegado delante
 * (`garene`, `vaynesilveredbolts`, `quinnpassive`), así que se quita el prefijo
 * —sin mirar mayúsculas, porque no las hay— y se deja el resto. Cuando lo que
 * queda es sólo la letra de la habilidad no aporta nada sobre la casilla Q/W/E/R
 * que ya va al lado, y se devuelve vacío.
 */
function legible(spell: string, champion: string): string {
  const c = champion.toLowerCase();
  const s = spell.toLowerCase();
  const resto = c && s.startsWith(c) ? spell.slice(c.length) : spell;
  if (resto.length <= 2) return "";
  return resto.charAt(0).toUpperCase() + resto.slice(1);
}

const Fila: React.FC<{ s: SpellHit; max: number; t: ReturnType<typeof useT> }> = ({ s, max, t }) => (
  <div style={estilos.fila}>
    <span style={estilos.ranura} title={s.unit !== s.champion ? t("Dealt by {unit}", { unit: s.unit }) : undefined}>
      {ranura(s.slot, s.basic)}
    </span>
    <span style={estilos.nombre}>
      <strong>{s.champion || t("unknown")}</strong>
      <span className="note"> {legible(s.spell, s.champion)}</span>
    </span>
    <span style={estilos.barraHueco}>
      <span style={{ ...estilos.barra, width: `${Math.max(2, (s.damage / max) * 100)}%` }} />
    </span>
    <span className="u-metric" style={estilos.dano}>{s.damage.toLocaleString()}</span>
    <span className="note" style={estilos.veces}>
      {t("{deaths}×", { deaths: s.deaths })}
      {s.straight_deaths > 0 && (
        <span
          style={{ color: "var(--loss)" }}
          title={t("Deaths where your course never changed by 45° in the 3 s before dying")}
        >
          {" "}·{" "}{t("{n} in a straight line", { n: s.straight_deaths })}
        </span>
      )}
    </span>
  </div>
);

export const SpellDietWidget: React.FC<SpellDietWidgetProps> = ({ matchId, onSeek }) => {
  const t = useT();
  const [scope, setScope] = useState<Scope>("match");
  const [report, setReport] = useState<SpellReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let vivo = true;
    setLoading(true);
    setError(null);
    const p = scope === "match" ? getSpellAutopsy(matchId) : getSpellDiet();
    p.then((r) => vivo && setReport(r))
      .catch((e) => vivo && setError(String(e)))
      .finally(() => vivo && setLoading(false));
    return () => {
      vivo = false;
    };
  }, [matchId, scope]);

  const maxDano = useMemo(
    () => Math.max(1, ...(report?.spells ?? []).map((s) => s.damage)),
    [report]
  );

  const selector = (
    <div style={wstyles.toolbar}>
      <span className="tp-seg">
        {(["match", "career"] as Scope[]).map((s) => (
          <button
            key={s}
            onClick={() => setScope(s)}
            aria-pressed={scope === s}
            data-on={scope === s ? "" : undefined}
          >
            {s === "match" ? t("This game") : t("All synced games")}
          </button>
        ))}
      </span>
    </div>
  );

  if (loading) return <>{selector}<p className="note">{t("Reading the damage breakdown…")}</p></>;

  if (error) {
    return (
      <>
        {selector}
        <EmptyState title={t("No damage breakdown yet")} text={error} />
      </>
    );
  }

  if (!report || report.deaths === 0) {
    return (
      <>
        {selector}
        <EmptyState
          title={t("No deaths to open up")}
          text={t("Riot only ships the spell-by-spell breakdown inside death events, so a game without deaths has nothing to show here.")}
        />
      </>
    );
  }

  const rectaPct =
    report.deaths_with_hand > 0
      ? Math.round((report.straight_deaths / report.deaths_with_hand) * 100)
      : null;

  return (
    <div style={wstyles.body}>
      {selector}

      <div style={wstyles.statGrid}>
        <div style={wstyles.statBox}>
          <span className="u-label">{t("Deaths opened up")}</span>
          <span style={wstyles.statValue}>{report.deaths}</span>
          <span className="note">
            {scope === "career" ? t("across {n} games", { n: report.matches }) : t("this game")}
          </span>
        </div>
        <div style={wstyles.statBox}>
          <span className="u-label">{t("Damage from champions")}</span>
          <span style={wstyles.statValue}>{report.damage_champions.toLocaleString()}</span>
          <span className="note">{t("{n} from minions and turrets", { n: report.damage_other.toLocaleString() })}</span>
        </div>
        <div style={wstyles.statBox}>
          <span className="u-label">{t("Died in a straight line")}</span>
          <span style={{ ...wstyles.statValue, color: rectaPct !== null && rectaPct > 33 ? "var(--loss)" : "var(--text)" }}>
            {rectaPct === null ? "—" : `${rectaPct}%`}
          </span>
          <span className="note">
            {rectaPct === null
              ? t("needs the mouse trail")
              : t("{n} of {total} deaths with a trail", { n: report.straight_deaths, total: report.deaths_with_hand })}
          </span>
        </div>
      </div>

      <div style={wstyles.list}>
        {report.spells.slice(0, 14).map((s, i) => (
          <Fila key={`${s.champion}-${s.spell}-${i}`} s={s} max={maxDano} t={t} />
        ))}
      </div>

      {scope === "match" && report.autopsies.length > 0 && (
        <>
          <div className="sect__head" style={{ marginTop: "var(--space-2)" }}>
            <span className="u-label">{t("Death by death")}</span>
            <i className="sect__rule" />
          </div>
          <div style={wstyles.list}>
            {report.autopsies.map((a, i) => (
              <button
                key={i}
                className="insp__press"
                onClick={() => onSeek(Math.max(0, a.t_video - 5))}
                title={t("Jump to this moment")}
              >
                <span className="u-metric">{mmss(a.t_video)}</span>
                <span className="insp__pressWhat">
                  <Swords size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                  {a.top.length > 0
                    ? t("{champion} {slot} for {damage}", {
                        champion: a.top[0].champion || a.killer,
                        slot: ranura(a.top[0].slot, a.top[0].basic),
                        damage: a.top[0].damage.toLocaleString(),
                      })
                    : t("Killed by {champion}", { champion: a.killer })}
                </span>
                <span className="insp__pressGain" style={{ color: a.hand?.straight ? "var(--loss)" : "var(--muted)" }}>
                  {a.hand === null
                    ? t("no trail")
                    : a.hand.straight
                    ? (
                      <>
                        <AlertTriangle size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                        {t("straight · {deg}° at most", { deg: Math.round(a.hand.max_turn_deg) })}
                      </>
                    )
                    : t("{n} orders · {deg}° turn", {
                        n: a.hand.orders,
                        deg: Math.round(a.hand.max_turn_deg),
                      })}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      <p className="note">
        {t("Riot ships this breakdown only inside death events, so this is what hits you in the fights that end with you on the floor — a sample, not a census. Damage instances carry no timestamp of their own, so the hand window is measured against the moment of death.")}
      </p>
    </div>
  );
};

const estilos: Record<string, React.CSSProperties> = {
  fila: {
    display: "grid",
    gridTemplateColumns: "26px minmax(96px, 1.4fr) minmax(40px, 1fr) 58px auto",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "5px 0",
    borderBottom: "1px solid var(--line-soft)",
  },
  ranura: {
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    textAlign: "center",
    color: "var(--brand)",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius-sm)",
    padding: "1px 0",
  },
  nombre: { fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  barraHueco: {
    height: "6px",
    background: "var(--sunken)",
    borderRadius: "var(--radius-full)",
    overflow: "hidden",
  },
  barra: { display: "block", height: "100%", background: "var(--loss)", opacity: 0.8 },
  dano: { textAlign: "right", fontVariantNumeric: "tabular-nums" },
  veces: { whiteSpace: "nowrap" },
};
