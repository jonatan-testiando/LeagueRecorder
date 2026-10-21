import React, { useMemo } from "react";
import type { TimelineMarker } from "../../../types";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { champLabel } from "../../../core/matchEvents";
import { JUNGLE_AGREEMENT_MIN, type DeathCost, type DeathTag } from "../../../core/tauri-ipc";
import { activityLabel } from "../jungleRoute";
import { useAttribution, useGoldReport, useJungleRoute, useSpellAutopsy } from "../useMatchData";
import type { MapFocus, OpenMap } from "../mapFocus";
import { formatGold, formatSigned } from "./pressureFormat";
import { BLIND_LOOKBACK_S as ANTES_S } from "./ReviewQueue";
import { HelpDot } from "./HelpDot";
import { wstyles } from "./videoPlayerStyles";
import { useDelayedLoading } from "../../../core/useDelayedLoading";
import { SkeletonLines } from "../../../components/ui/Skeleton";
import "./DeathsSection.css";
import "./MatchTab.css";

/**
 * Tus muertes, una por una, con todo lo que se sabe de cada una.
 *
 * Antes eran tres secciones que no se podían cruzar: "Atención al mapa antes
 * de morir" (miraste o no), "Lo que te comes" (qué te mató y cómo movías el
 * ratón) y, desde la ruta de jungla, qué estabas haciendo. Aquí cada muerte
 * es una fila: quién te mató y, en una frase, qué hacías, si miraste el mapa,
 * si ibas en línea recta y el oro sin gastar si la partida lo grabó. La fila
 * abre el Mapa en el sitio donde caíste.
 */

/** Más que esto sin gastar al morir es oro que no llegó a pelear. */
export const SIN_GASTAR = 1000;
/** Marca de la timeline y autopsia de la misma muerte: misma hora ±3 s. */
const MISMA_MUERTE_S = 3;

type T = ReturnType<typeof useT>;

function ranura(slot: number, basic: boolean): string {
  if (basic) return "AA";
  return ["Q", "W", "E", "R"][slot] ?? "";
}

export interface DeathRow {
  tVideo: number;
  tGame: number;
  /** Campeón (nombre de Riot, "MonkeyKing") que más daño te hizo. */
  quien: string | null;
  golpe: { key: string; damage: number } | null;
  recta: boolean | null;
  /** Miradas al mapa antes de morir. null: la partida no tiene miradas
   *  grabadas, y entonces "no miraste" sería mentira (igual que ReviewQueue). */
  miradas: number | null;
  actividad: string | null;
  oro: number | null;
  /** Dónde caíste (coordenadas de juego, de la timeline de Riot). */
  x: number | null;
  y: number | null;
  /** Lo que costó en probabilidad de victoria y por qué. null sin reparto:
   *  partida sin sincronizar, o sin clave de Riot. */
  precio: DeathCost | null;
}

/**
 * Las filas, compartidas con "Lo que decidió la partida": las dos cuentan las
 * muertes a ciegas con el mismo criterio, o dirían cifras distintas.
 *
 * `selfPid` (1-10) es quien grabó: de su reparto sale el precio de cada muerte.
 */
export function useDeathRows(
  matchId: string,
  markers: TimelineMarker[] | undefined,
  cameraSnaps: number[],
  videoOffset: number,
  selfPid: number | null
): { filas: DeathRow[]; cargando: boolean } {
  const autopsia = useSpellAutopsy(matchId);
  const ruta = useJungleRoute(matchId);
  const oro = useGoldReport(matchId);
  const reparto = useAttribution(selfPid ? matchId : null);

  const filas = useMemo<DeathRow[]>(() => {
    const r = ruta?.route && ruta.route.agreement >= JUNGLE_AGREEMENT_MIN ? ruta.route : null;
    const g = oro?.status === "ok" ? oro.report : null;
    const mias = reparto?.find((c) => c.participant_id === selfPid)?.deaths_detail ?? [];
    const marcas = (markers ?? []).filter((m) => m.event_type === "death");
    const base =
      autopsia && autopsia.autopsies.length > 0
        ? autopsia.autopsies.map((a) => ({
            tVideo: a.t_video,
            tGame: a.t_game,
            quien: a.top[0]?.champion || a.killer || null,
            golpe: a.top[0] ? { key: ranura(a.top[0].slot, a.top[0].basic), damage: a.top[0].damage } : null,
            recta: a.hand ? a.hand.straight : null,
          }))
        : marcas.map((m) => ({ tVideo: m.time, tGame: m.time - videoOffset, quien: null, golpe: null, recta: null }));
    return base.map((b) => {
      const marca = marcas.find((m) => Math.abs(m.time - b.tVideo) <= MISMA_MUERTE_S);
      return {
        ...b,
        miradas:
          cameraSnaps.length > 0 ? cameraSnaps.filter((s) => s >= b.tVideo - ANTES_S && s <= b.tVideo).length : null,
        actividad: r?.deaths.find((d) => Math.abs(d.time - b.tGame) <= MISMA_MUERTE_S)?.activity ?? null,
        oro: g?.deaths.find((d) => Math.abs(d.time - b.tGame) <= MISMA_MUERTE_S)?.unspent ?? null,
        x: marca?.position_x ?? null,
        y: marca?.position_y ?? null,
        precio: mias.find((d) => Math.abs(d.minute * 60 - b.tGame) <= MISMA_MUERTE_S) ?? null,
      };
    });
  }, [autopsia, ruta, oro, reparto, selfPid, markers, cameraSnaps, videoOffset]);

  // Se espera al reparto: si el precio llegara después, la fila cambiaría de
  // forma delante del usuario.
  return { filas, cargando: autopsia === undefined || (selfPid != null && reparto === undefined) };
}

/** "−6,3% de victoria". */
export const costText = (wpa: number, t: T): string => t("{p}% win chance", { p: formatSigned(wpa * 100) });

const OBJETIVO: Record<string, string> = {
  dragon: "Dragon",
  baron: "Baron Nashor",
  herald: "Rift Herald",
  grubs: "Void Grubs",
  tower: "Tower",
  inhibitor: "Inhibitor",
  plate: "Plate",
};

/** De dónde sale el precio, para el `title` del chip. */
function costDetail(p: DeathCost, t: T): string {
  const muerte = formatSigned(p.wpa_death * 100);
  if (p.wpa_objective < 0 && p.objective) {
    return t("The death {a}% · {objective} right after {b}%", {
      a: muerte,
      objective: t(OBJETIVO[p.objective] ?? p.objective),
      b: formatSigned(p.wpa_objective * 100),
    });
  }
  return t("What this death cost your team in win probability");
}

/** Texto y explicación de cada etiqueta. Las desconocidas no se pintan. */
const TAGS: Record<DeathTag, { text: string; help: string }> = {
  jungla: { text: "enemy jungler", help: "The enemy jungler killed you or assisted." },
  fuera_de_zona: { text: "away from your lane", help: "Before 14:00, more than 2,500 units from your lane." },
  bajo_torre_pre14: {
    text: "at a tower before 14:00",
    help: "Before 14:00, next to a standing tower (yours or theirs), or their tower hit you.",
  },
  poco_dano_devuelto: {
    text: "little damage back",
    help: "What you dealt before dying is in the lowest 10% for your role at that point of the game.",
  },
  sin_mirar_mapa: { text: "no look at the map", help: "No look at the map in the 10 s before dying." },
  desde_niebla: { text: "from the fog", help: "The fight that killed you was opened with no enemy in sight." },
};

/** Las etiquetas que pintar. "Sin mirar el mapa" ya lo dice la frase cuando
 *  se saben las miradas, así que no se repite. */
export function deathTags(f: DeathRow, t: T): { text: string; help: string }[] {
  return (f.precio?.tags ?? [])
    .filter((k) => !(k === "sin_mirar_mapa" && f.miradas != null))
    .map((k) => TAGS[k as DeathTag])
    .filter(Boolean)
    .map((e) => ({ text: t(e.text), help: t(e.help) }));
}

export const deathTitle = (f: DeathRow, t: T): string =>
  f.quien ? t("Killed by {champion}", { champion: champLabel(f.quien) }) : t("Death");

/** Lo que se sabe de la muerte, en trozos: los malos se pintan en rojo. */
export function deathParts(f: DeathRow, t: T): { text: string; bad: boolean }[] {
  const out: { text: string; bad: boolean }[] = [];
  if (f.actividad) out.push({ text: activityLabel(f.actividad, t), bad: false });
  if (f.miradas != null) {
    out.push(
      f.miradas === 0
        ? { text: t("no look at the map"), bad: true }
        : { text: f.miradas === 1 ? t("one look at the map") : t("{n} looks at the map", { n: f.miradas }), bad: false }
    );
  }
  if (f.recta === true) out.push({ text: t("moving in a straight line"), bad: true });
  if (f.oro != null && f.oro >= SIN_GASTAR) out.push({ text: t("{g} gold unspent", { g: formatGold(f.oro) }), bad: true });
  if (out.length > 0) out[0] = { ...out[0], text: out[0].text.charAt(0).toUpperCase() + out[0].text.slice(1) };
  return out;
}

export function deathFocus(f: DeathRow, t: T): MapFocus {
  return {
    kind: "death",
    t: f.tGame,
    // Se ve llegar la muerte: el mismo tramo en el que se miran las miradas.
    lead: ANTES_S,
    title: deathTitle(f, t),
    detail: deathParts(f, t).map((p) => p.text).join(", ") || undefined,
    tone: "bad",
    marks: f.x != null && f.y != null ? [{ x: f.x, y: f.y, kind: "death", tone: "bad" }] : undefined,
  };
}

const golpeText = (g: NonNullable<DeathRow["golpe"]>, t: T) =>
  g.key === "AA"
    ? t("basic attacks for {n}", { n: g.damage.toLocaleString() })
    : t("{key} for {n}", { key: g.key, n: g.damage.toLocaleString() });

interface Props {
  matchId: string;
  /** Marcas de la timeline (tiempo de VÍDEO): respaldo sin autopsia y posición. */
  markers?: TimelineMarker[];
  /** Miradas al mapa, en tiempo de VÍDEO. */
  cameraSnaps: number[];
  videoOffset: number;
  /** Quién grabó (1-10), para el precio de cada muerte. */
  selfPid: number | null;
  onOpenMap: OpenMap;
}

export const DeathsSection: React.FC<Props> = ({ matchId, markers, cameraSnaps, videoOffset, selfPid, onOpenMap }) => {
  const t = useT();
  const { filas, cargando } = useDeathRows(matchId, markers, cameraSnaps, videoOffset, selfPid);

  const esqueleto = useDelayedLoading(cargando);
  if (cargando || esqueleto) return esqueleto ? <SkeletonLines lines={4} /> : null;
  if (filas.length === 0) return <p className="note" style={{ margin: 0 }}>{t("You didn't die this game.")}</p>;

  const ciegas = filas.filter((f) => f.miradas === 0).length;
  const rectas = filas.filter((f) => f.recta === true).length;
  const caras = filas.filter((f) => (f.oro ?? 0) >= SIN_GASTAR).length;
  const partes = [
    ciegas > 0 && t("{n} without a look at the map", { n: ciegas }),
    rectas > 0 && t("{n} in a straight line", { n: rectas }),
    caras > 0 && t("{n} with {g}+ gold unspent", { n: caras, g: formatGold(SIN_GASTAR) }),
  ].filter(Boolean) as string[];
  const conPrecio = filas.filter((f) => f.precio);
  const total = conPrecio.reduce((s, f) => s + (f.precio?.wpa ?? 0), 0);

  return (
    <div style={wstyles.body}>
      <p className="ds-summary">
        {filas.length === 1 ? t("One death") : t("{n} deaths", { n: filas.length })}
        {conPrecio.length > 0 && ` (${costText(total, t)})`}
        {partes.length > 0 && `: ${partes.join(" · ")}`}
        <HelpDot
          text={[
            conPrecio.length > 0 &&
              t("Win chance: what each death cost your team in the win-probability model, plus its share of what the enemy took in the next 60 s. Vision isn't in the model, so a death that gave away vision costs more than this says."),
            t("Looks: minimap clicks and ally camera keys in the {n} s before dying. Straight line: your course never turned 45° in the last 3 s.", { n: ANTES_S }),
          ]
            .filter(Boolean)
            .join(" ")}
        />
      </p>
      <div className="ds-list">
        {filas.map((f, i) => {
          const trozos = deathParts(f, t);
          const tags = deathTags(f, t);
          return (
            <button key={i} type="button" className="ds-row ds-row--priced" onClick={() => onOpenMap(deathFocus(f, t))} title={t("Open the map at this moment")}>
              <span className="u-time ds-time">{mmss(Math.max(0, f.tGame))}</span>
              <span className="ds-body">
                <span className="ds-who">
                  {deathTitle(f, t)}
                  {f.golpe && <span className="ds-soft"> · {golpeText(f.golpe, t)}</span>}
                </span>
                {trozos.length > 0 && (
                  <span className="mt-line">
                    {trozos.map((p, k) => (
                      <React.Fragment key={k}>
                        {k > 0 && ", "}
                        <span className={p.bad ? "mt-bad" : undefined}>{p.text}</span>
                      </React.Fragment>
                    ))}
                  </span>
                )}
                {tags.length > 0 && (
                  <span className="ds-tags">
                    {tags.map((g) => (
                      <span key={g.text} className="ds-tag" title={g.help}>{g.text}</span>
                    ))}
                  </span>
                )}
              </span>
              {f.precio ? (
                <span className="ds-cost" title={costDetail(f.precio, t)}>{costText(f.precio.wpa, t)}</span>
              ) : (
                <span />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
