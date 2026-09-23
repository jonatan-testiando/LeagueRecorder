import type { MatchEvent, MatchMetadata, Participant } from "../../types";
import type { CameraLook, ErrorClipMetadata, PressureEpisode } from "../../core/tauri-ipc";
import { individualEvents } from "../../core/matchEvents";
import { describeEventFull, type Translate } from "../../core/eventText";
import { eventMeta } from "../player/components/eventMeta";
import { analyzerFindings, buildQueue, type Moment } from "../player/components/ReviewQueue";
import { laneLabel } from "../../core/lanes";
import { mmss } from "../../core/time";

/**
 * «Los 3 momentos que más te enseñan» de una partida: el peor error, el
 * hallazgo del analizador más relevante y la mejor jugada.
 *
 * No hay datos nuevos: todo sale de lo que la partida ya trae (sucesos del
 * directo y de la Timeline, marcadores de ganks, errores que marcaste, miradas
 * al mapa y episodios de presión). La valoración es la misma que pinta el
 * reproductor (`eventMeta().tone`); aquí solo se ELIGE, y la línea de
 * explicación solo aparece cuando hay un hecho medido que contar — nunca una
 * frase de relleno.
 *
 * Todas las horas van en el eje del VÍDEO, que es el que entiende
 * `setPendingSeek` y el que enseña la lista del reproductor.
 */

export type MomentKind = "error" | "finding" | "best";
/** La clave inglesa de la valoración (se traduce al pintar). */
export type MomentVerdict = "Mistake" | "Finding" | "Excellent" | "Good";
/** Qué va en la cabecera cuando no hay duelo de campeones que enseñar. */
export type MomentGlyph = "objective" | "flag" | "eye" | "gank" | "pressure" | "death" | "kill";

export interface TeachMoment {
  kind: MomentKind;
  verdict: MomentVerdict;
  /** Segundo del vídeo. */
  time: number;
  title: string;
  why?: string;
  /** Tu campeón y el otro del duelo (quien te mata / a quien matas). */
  you?: string | null;
  other?: string | null;
  glyph?: MomentGlyph;
  /** Texto corto junto al glifo ("Dragón infernal", "Detectado por el analizador"). */
  caption?: string;
  /** El suceso de un objetivo, para pintar su glifo (el mismo que en el reproductor). */
  event?: MatchEvent;
}

/* ------------------------------------------------------------------ nombres */

const bare = (s: string) => s.split("#")[0].trim().toLowerCase();
const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Nombre de un suceso → campeón. La API en directo manda el nombre del
 * INVOCADOR ("Zeru"), no el campeón; con el marcador de Riot sincronizado se
 * cruza con los diez participantes. Sin marcador no se adivina: sin retrato.
 */
export function championOf(name: string | undefined | null, parts: Participant[]): string | null {
  if (!name || parts.length === 0) return null;
  const n = bare(name);
  const byName = parts.find((p) => bare(p.name) === n);
  if (byName) return byName.champion;
  const byChamp = parts.find((p) => letters(p.champion) === letters(n));
  return byChamp ? byChamp.champion : null;
}

/** "Ahri", "Ahri y Zed", "Ahri, Zed y Lux". */
export function joinNames(names: string[], t: Translate): string {
  if (names.length <= 1) return names[0] ?? "";
  return t("{a} and {b}", { a: names.slice(0, -1).join(", "), b: names[names.length - 1] });
}

/* ------------------------------------------------------------------ ayudas */

const isDeath = (e: MatchEvent) => e.type === "ChampionKill" && e.subtype === "death";
const isKill = (e: MatchEvent) => e.type === "ChampionKill" && e.subtype === "kill";
const isTakedown = (e: MatchEvent) =>
  e.type === "ChampionKill" && (e.subtype === "kill" || e.subtype === "assist");

/** Lo que te cuesta un objetivo rival o una estructura tuya, para ordenar. */
const costWeight = (e: MatchEvent): number => {
  const detail = (e.detail ?? "").toLowerCase();
  if (e.type === "BaronKill" && e.subtype === "enemy") return 5;
  if (e.type === "DragonKill" && e.subtype === "enemy") return detail.includes("elder") ? 5 : 3;
  if (e.type === "InhibKill" && e.subtype === "ally") return 4;
  if (e.type === "HeraldKill" && e.subtype === "enemy") return 2;
  if (e.type === "TowerKill" && e.subtype === "ally") return 2;
  return 0;
};

/** Y lo que te da uno tuyo. */
const gainWeight = (e: MatchEvent): number => {
  const detail = (e.detail ?? "").toLowerCase();
  if (e.type === "BaronKill" && e.subtype === "ally") return 5;
  if (e.type === "DragonKill" && e.subtype === "ally") return detail.includes("elder") ? 5 : 3;
  if (e.type === "HeraldKill" && e.subtype === "ally") return 2;
  if (e.type === "InhibKill" && e.subtype === "enemy") return 2;
  if (e.type === "TowerKill" && e.subtype === "enemy") return 1;
  return 0;
};

/**
 * Texto de un suceso. El de la API ya compone la frase; los que vienen de un
 * marcador de la Timeline no traen nada, y ahí vale la etiqueta del tipo.
 */
function eventTitle(ev: MatchEvent, t: Translate): string {
  const { text } = describeEventFull(ev, t);
  const raw = text.trim();
  if (!raw || raw.toLowerCase() === (ev.subtype ?? "").toLowerCase() || raw.toLowerCase() === ev.type.toLowerCase()) {
    return t(eventMeta(ev).label);
  }
  return raw;
}

/** Nombre corto del objetivo ("Dragón infernal", "Barón Nashor"). */
function objectiveName(ev: MatchEvent, t: Translate): string {
  if (ev.type === "BaronKill") return t("Baron Nashor");
  if (ev.type === "HeraldKill") return t("Rift Herald");
  if (ev.type === "DragonKill") {
    const kind = (ev.detail ?? "").split(",").map((d) => d.trim().toLowerCase()).find((d) => d && d !== "stolen");
    switch (kind) {
      case "mountain": return t("Mountain Dragon");
      case "ocean": return t("Ocean Dragon");
      case "infernal": return t("Infernal Dragon");
      case "cloud": return t("Cloud Dragon");
      case "hextech": return t("Hextech Dragon");
      case "chemtech": return t("Chemtech Dragon");
      case "elder": return t("Elder Dragon");
      default: return t("Dragon");
    }
  }
  return t(eventMeta(ev).label);
}

/** Quién te mata, dicho para una persona: una torre no es "Turret_T2_C_05_A". */
function killedByTitle(ev: MatchEvent, champ: string | null, t: Translate): string {
  const who = ev.actor ?? "";
  if (champ) return t("Killed by {actor}", { actor: champ });
  if (/turret|tower/i.test(who)) return t("Killed by a tower");
  if (/minion/i.test(who)) return t("Killed by minions");
  return eventTitle(ev, t);
}

/* ------------------------------------------------------------ el peor error */

interface Ctx {
  match: MatchMetadata;
  evs: MatchEvent[];
  parts: Participant[];
  self: string;
  t: Translate;
}

function pickError(
  ctx: Ctx,
  clips: ErrorClipMetadata[],
  focusWindow: { from: number; to: number } | null
): TeachMoment | null {
  const { match, evs, parts, self, t } = ctx;

  // 1. Lo que marcaste tú como error: la señal más deliberada que hay.
  const marcados = clips
    .filter((c) => c.match_id === match.id && c.start_time != null)
    .sort((a, b) => Number(!!a.reviewed) - Number(!!b.reviewed) || (a.start_time ?? 0) - (b.start_time ?? 0));
  if (marcados.length > 0) {
    const c = marcados[0];
    const first = c.events?.[0];
    return {
      kind: "error",
      verdict: "Mistake",
      time: c.start_time as number,
      title: first?.text || t("Flagged error"),
      why: c.note && c.note !== first?.text ? c.note : first?.category ? t(first.category) : undefined,
      glyph: "flag",
      caption: t("You flagged this"),
      you: self,
    };
  }

  const deaths = evs.filter(isDeath);
  if (deaths.length === 0) {
    // Sin muertes, lo que se perdió: el objetivo o la estructura que más cuesta.
    const perdido = evs
      .filter((e) => costWeight(e) > 0)
      .sort((a, b) => costWeight(b) - costWeight(a) || a.time - b.time)[0];
    if (!perdido) return null;
    return {
      kind: "error",
      verdict: "Mistake",
      time: perdido.time,
      title: eventTitle(perdido, t),
      glyph: "objective",
      caption: objectiveName(perdido, t),
      event: perdido,
    };
  }

  const off = match.video_offset ?? 0;
  const gameMin = (e: MatchEvent) => Math.max(0, e.time - off) / 60;

  // 2. La muerte que costó algo: el objetivo o la estructura que cae después.
  const conCoste = deaths
    .map((d) => {
      const coste = evs
        .filter((e) => costWeight(e) > 0 && e.time > d.time && e.time - d.time <= 60)
        .sort((a, b) => costWeight(b) - costWeight(a) || a.time - b.time)[0];
      return { d, coste };
    })
    .filter((x) => !!x.coste)
    .sort((a, b) => costWeight(b.coste!) - costWeight(a.coste!) || a.d.time - b.d.time)[0];

  let death: MatchEvent;
  let why: string;
  if (conCoste) {
    death = conCoste.d;
    why = t("{what} {n} s later.", {
      what: eventTitle(conCoste.coste!, t),
      n: Math.round(conCoste.coste!.time - death.time),
    });
  } else {
    // 3. La que cae en el tramo donde más mueres; 4. si no, la primera.
    const enTramo = focusWindow
      ? deaths.find((d) => gameMin(d) >= focusWindow.from && gameMin(d) < focusWindow.to)
      : undefined;
    if (enTramo && focusWindow) {
      death = enTramo;
      why = t("It falls between minutes {a} and {b}, the stretch where you die most.", {
        a: focusWindow.from,
        b: focusWindow.to,
      });
    } else {
      death = deaths[0];
      why = t("Your first death of the game, at minute {m}.", { m: Math.floor(gameMin(death)) });
    }
  }

  const killer = championOf(death.actor, parts);
  return {
    kind: "error",
    verdict: "Mistake",
    time: death.time,
    title: killedByTitle(death, killer, t),
    why,
    you: self,
    other: killer,
    glyph: killer ? undefined : "death",
  };
}

/* --------------------------------------------------- el hallazgo más útil */

/** El hueco más largo sin mirar un carril, entre dos miradas (no el arranque ni el final). */
function longestBlindGap(looks: CameraLook[]): { lane: string; from: number; to: number } | null {
  let best: { lane: string; from: number; to: number } | null = null;
  for (const lane of ["top", "mid", "bot"]) {
    const ts = looks.filter((l) => l.lane === lane).map((l) => l.t).sort((a, b) => a - b);
    for (let i = 1; i < ts.length; i++) {
      const gap = ts[i] - ts[i - 1];
      if (!best || gap > best.to - best.from) best = { lane, from: ts[i - 1], to: ts[i] };
    }
  }
  return best;
}

/** Por debajo de esto, un hueco sin mirar es ritmo normal y no un hallazgo. */
const MIN_BLIND_GAP = 120;

function pickFinding(
  ctx: Ctx,
  episodes: PressureEpisode[],
  looks: CameraLook[],
  focusWindow: { from: number; to: number } | null,
  /** Segundo del error ya elegido: su misma muerte no se cuenta dos veces. */
  errorTime: number | null
): TeachMoment | null {
  const { match, evs, t } = ctx;
  const detected = t("Detected by the analyzer");

  // 0. Una muerte a ciegas: el MISMO hallazgo que marca el reproductor
  //    (`analyzerFindings`): ni un clic de minimapa ni una cámara aliada en los
  //    segundos antes de morir. Se prefiere una del tramo donde más mueres.
  const deathTimes = evs.filter(isDeath).map((e) => e.time);
  const lookTimes = [...(match.camera_snaps ?? []), ...looks.map((l) => l.t)];
  const ciegas = analyzerFindings(deathTimes, lookTimes, [], t).filter((f) => f.end !== errorTime);
  if (ciegas.length > 0) {
    const off = match.video_offset ?? 0;
    const enTramo = focusWindow
      ? ciegas.find((f) => {
          const min = Math.max(0, f.end - off) / 60;
          return min >= focusWindow.from && min < focusWindow.to;
        })
      : undefined;
    const f = enTramo ?? ciegas[0];
    return { kind: "finding", verdict: "Finding", time: f.time, title: f.title, why: f.detail, glyph: "eye", caption: detected };
  }

  // 1. Un episodio de presión de esta partida: te sujetan varios y el equipo
  //    cobra (o no) en otro sitio. Primero los que acaban en muerte.
  const mios = episodes
    .filter((e) => e.match_id === match.id && match.video_path)
    .sort(
      (a, b) =>
        Number(b.window.died) - Number(a.window.died) ||
        b.window.enemy_count - a.window.enemy_count
    );
  if (mios.length > 0) {
    const w = mios[0].window;
    const n = Math.round(w.enemy_count);
    const title = w.died
      ? n >= 2 ? t("You draw {n} enemies and die", { n }) : t("You draw enemies and die")
      : n >= 2 ? t("You draw {n} enemies", { n }) : t("You draw enemies");
    const why =
      w.towers_elsewhere > 0
        ? t("Meanwhile your team takes {n} towers elsewhere.", { n: w.towers_elsewhere })
        : w.gold_elsewhere >= 100
          ? t("Meanwhile your team earns {g} gold elsewhere.", { g: Math.round(w.gold_elsewhere) })
          : t("Nothing observed for your team elsewhere meanwhile.");
    return { kind: "finding", verdict: "Finding", time: w.start, title, why, glyph: "pressure", caption: detected };
  }

  const ganks = (match.timeline_markers ?? []).filter((m) => m.event_type === "gank_attempt" && m.lane);

  // 2. Un gank fallido: el detector lo resolvió con carril, resultado y ángulo.
  const fallido = ganks.find((g) => g.outcome === "failed");
  if (fallido) {
    return {
      kind: "finding",
      verdict: "Finding",
      time: fallido.time,
      title: t("Failed gank in {lane}", { lane: laneLabel(fallido.lane!, t) }),
      why:
        fallido.approach === "front"
          ? t("You go in head-on instead of cutting off their escape.")
          : undefined,
      glyph: "gank",
      caption: detected,
    };
  }

  // 3. El hueco más largo sin mirar un carril, de los clics de minimapa.
  const hueco = longestBlindGap(looks);
  if (hueco && hueco.to - hueco.from >= MIN_BLIND_GAP) {
    return {
      kind: "finding",
      verdict: "Finding",
      time: hueco.from,
      title: t("{lane} unwatched for {gap}", { lane: laneLabel(hueco.lane, t), gap: mmss(hueco.to - hueco.from) }),
      why: t("From {a} to {b}, not one look at that lane.", { a: mmss(hueco.from), b: mmss(hueco.to) }),
      glyph: "eye",
      caption: detected,
    };
  }

  // 4. Cualquier otro gank detectado.
  const otro = ganks[0];
  if (otro) {
    return {
      kind: "finding",
      verdict: "Finding",
      time: otro.time,
      title:
        otro.outcome === "success"
          ? t("Successful gank in {lane}", { lane: laneLabel(otro.lane!, t) })
          : t("Gank with no result in {lane}", { lane: laneLabel(otro.lane!, t) }),
      glyph: "gank",
      caption: detected,
    };
  }

  // 5. Un salto de cámara, cuando son pocos (el mismo criterio que la cola).
  const snaps = match.camera_snaps ?? [];
  if (snaps.length > 0 && snaps.length <= 24) {
    return {
      kind: "finding",
      verdict: "Finding",
      time: snaps[0],
      title: t("Camera jump"),
      glyph: "eye",
      caption: detected,
    };
  }
  return null;
}

/* ------------------------------------------------------- la mejor jugada */

function pickBest(ctx: Ctx, taken: number[]): TeachMoment | null {
  const { match, evs, parts, self, t } = ctx;
  const libre = (time: number) => !taken.some((x) => Math.abs(x - time) < 4);

  /**
   * Víctimas tuyas en una ventana: el campeón si el marcador lo resuelve y, si
   * no, el nombre tal cual llega (el del invocador), que sirve para la frase
   * pero no para buscar un retrato.
   */
  const victims = (from: number, to: number) =>
    evs
      .filter((e) => isKill(e) && e.time >= from && e.time <= to && !!e.target)
      .map((e) => ({ name: championOf(e.target, parts) ?? e.target!, champ: championOf(e.target, parts) }));

  // Asesinato múltiple: la API lo manda aparte, con la racha en `detail`.
  const multis = match.events
    .filter((e) => e.type === "Multikill" && libre(e.time))
    .map((e) => ({ e, n: Number((e.detail ?? "").split(",")[0]) || 2 }))
    .sort((a, b) => b.n - a.n || a.e.time - b.e.time);

  const objetivos = evs
    .filter((e) => gainWeight(e) >= 2 && libre(e.time))
    .sort((a, b) => gainWeight(b) - gainWeight(a) || a.time - b.time);

  const multiMoment = (m: { e: MatchEvent; n: number }): TeachMoment => {
    const vs = victims(m.e.time - 12, m.e.time + 2);
    const face = [...vs].reverse().find((v) => !!v.champ)?.champ ?? null;
    return {
      kind: "best",
      verdict: "Excellent",
      time: m.e.time,
      title: eventTitle(m.e, t),
      why: vs.length >= 2 ? t("You take down {names}.", { names: joinNames(vs.map((v) => v.name), t) }) : undefined,
      you: self,
      other: face,
      glyph: face ? undefined : "kill",
    };
  };

  const objMoment = (o: MatchEvent): TeachMoment => {
    const antes = evs.filter((e) => isTakedown(e) && e.time <= o.time && o.time - e.time <= 30).length;
    const dragones = evs.filter((e) => e.type === "DragonKill" && e.subtype === "ally" && e.time <= o.time).length;
    return {
      kind: "best",
      verdict: "Excellent",
      time: o.time,
      title: eventTitle(o, t),
      why:
        antes > 0
          ? t("You're in the fight: {n} takedowns in the 30 s before.", { n: antes })
          : o.type === "DragonKill" && dragones >= 2
            ? t("Your team is up to {n} dragons.", { n: dragones })
            : undefined,
      glyph: "objective",
      caption: objectiveName(o, t),
      event: o,
    };
  };

  // Racha de tres o más, y el barón, por delante de todo.
  if (multis[0] && multis[0].n >= 3) return multiMoment(multis[0]);
  if (objetivos[0] && gainWeight(objetivos[0]) >= 5) return objMoment(objetivos[0]);
  if (multis[0]) return multiMoment(multis[0]);

  const sangre = match.events.find((e) => e.type === "FirstBlood" && libre(e.time));
  if (sangre) {
    const victima = evs.find((e) => isKill(e) && Math.abs(e.time - sangre.time) <= 3);
    return {
      kind: "best",
      verdict: "Excellent",
      time: sangre.time,
      title: t("First Blood"),
      why: t("The first kill of the game is yours."),
      you: self,
      other: victima ? championOf(victima.target, parts) : null,
      glyph: "kill",
    };
  }
  if (objetivos[0]) return objMoment(objetivos[0]);

  // Una kill: la que abre un objetivo, si la hay; si no, la primera.
  const kills = evs.filter((e) => isKill(e) && libre(e.time));
  if (kills.length === 0) return null;
  const conPremio = kills
    .map((k) => ({
      k,
      premio: evs.find((e) => gainWeight(e) > 0 && e.time > k.time && e.time - k.time <= 60),
    }))
    .find((x) => !!x.premio);
  const kill = conPremio?.k ?? kills[0];
  const victim = championOf(kill.target, parts);
  return {
    kind: "best",
    verdict: "Good",
    time: kill.time,
    title: victim ? t("Killed {target}", { target: victim }) : eventTitle(kill, t),
    why: conPremio
      ? t("{what} {n} s later.", { what: eventTitle(conPremio.premio!, t), n: Math.round(conPremio.premio!.time - kill.time) })
      : kill === kills[0]
        ? t("Your first kill of the game.")
        : undefined,
    you: self,
    other: victim,
    glyph: victim ? undefined : "kill",
  };
}

/* ------------------------------------------------------------------ entrada */

export function teachMoments(opts: {
  match: MatchMetadata;
  errorClips: ErrorClipMetadata[];
  episodes: PressureEpisode[];
  looks: CameraLook[];
  focusWindow: { from: number; to: number } | null;
  t: Translate;
}): TeachMoment[] {
  const { match, t } = opts;
  const parts = match.participants ?? [];
  const self = parts.find((p) => p.is_self)?.champion ?? match.champion;
  const ctx: Ctx = { match, evs: individualEvents(match.events, match.timeline_markers ?? []), parts, self, t };

  const out: TeachMoment[] = [];
  const err = pickError(ctx, opts.errorClips, opts.focusWindow);
  if (err) out.push(err);
  const find = pickFinding(ctx, opts.episodes, opts.looks, opts.focusWindow, err?.kind === "error" ? err.time : null);
  if (find && !out.some((m) => Math.abs(m.time - find.time) < 4)) out.push(find);
  const best = pickBest(ctx, out.map((m) => m.time));
  if (best) out.push(best);
  return out;
}

/** Cuántos sucesos enseña la lista del reproductor para esta partida. */
export const eventCount = (match: MatchMetadata): number =>
  individualEvents(match.events, match.timeline_markers ?? []).length;

/**
 * Los momentos por revisar: la MISMA cola que el reproductor y la biblioteca
 * (`buildQueue`, vía `core/review.ts`), sin los ya tachados.
 */
export function pendingMoments(match: MatchMetadata, errorClips: ErrorClipMetadata[]): Moment[] {
  const suyos = errorClips.filter((c) => c.match_id === match.id);
  return buildQueue(match, suyos, (k) => k).filter((m) => !m.reviewed);
}

/** Minutos que lleva revisar N momentos: medio minuto por momento, redondeando arriba. */
export const reviewMinutes = (n: number): number => Math.max(1, Math.ceil((n * 30) / 60));
