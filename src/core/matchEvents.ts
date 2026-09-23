import { MatchEvent, Participant, TimelineMarker } from "../types";

/**
 * Los sucesos de una partida, uno por uno.
 *
 * Una partida llega por dos vías que se solapan: la API en directo (`events`,
 * con actor y víctima) y la Timeline de Riot (`timeline_markers`, con
 * coordenadas). La misma kill aparece en las dos, y encima la API en directo
 * manda `Multikill` y `FirstBlood` *además* de las kills que los provocaron.
 * Pintado tal cual, un doble asesinato deja cuatro marcas en la línea de
 * tiempo para dos kills.
 *
 * Aquí se resuelve una sola vez: cada suceso real produce exactamente una
 * entrada, y solo los del jugador (las dos fuentes ya filtran por él).
 */

/** Margen para dar por hecho que dos fuentes hablan del mismo suceso. */
const SAME_EVENT_S = 6;

/** Clave de emparejamiento entre un marcador de Riot y un evento del directo. */
const kindOf = (ev: MatchEvent): string | null => {
  switch (ev.type) {
    case "ChampionKill":
      return ev.subtype === "death" ? "death" : ev.subtype === "assist" ? "assist" : "kill";
    case "FirstBlood":
      return "kill";
    case "DragonKill":
      return "dragon";
    case "HeraldKill":
    case "BaronKill":
      return "herald";
    case "TowerKill":
      // Una placa no es la torre: la API en directo no manda placas, así que
      // confundirlas haría desaparecer la placa por culpa de la torre de al lado.
      return ev.subtype === "plate" ? "plate" : "tower";
    case "InhibKill":
      return "tower";
    default:
      return null;
  }
};

/** Marcador de la Timeline de Riot → suceso, con el mismo vocabulario que el directo. */
const fromMarker = (tm: TimelineMarker): MatchEvent | null => {
  // Sin `description`. La del marcador es una frase fija en español
  // ("Asesinato", "Dragón abatido") que no dice nada que el tipo y el icono no
  // digan ya, y que se colaba en una lista por lo demás traducida. El tipo lleva
  // toda la información que trae un marcador de Riot: quién no lo sabe.
  const ev = (t: string, s?: string): MatchEvent => ({
    type: t,
    subtype: s,
    time: tm.time,
    description: "",
  });
  switch (tm.event_type) {
    case "kill":
      // Las partidas analizadas antes de que existiera el tipo 'assist' guardan
      // las asistencias como 'kill'; solo las distingue la descripción.
      return tm.description === "Asistencia" ? ev("ChampionKill", "assist") : ev("ChampionKill", "kill");
    case "assist":
      return ev("ChampionKill", "assist");
    case "death":
      return ev("ChampionKill", "death");
    case "dragon":
      return ev("DragonKill", "ally");
    case "herald":
      return ev("HeraldKill", "ally");
    case "tower":
      return ev("TowerKill", "ally");
    case "plate":
      return ev("TowerKill", "plate");
    default:
      // 'gank_attempt' es materia prima del widget de ganks (una marca por minuto
      // de presencia en línea), no un suceso que pintar.
      return null;
  }
};

/**
 * `events` del directo, ya sin los que duplican a otro:
 * - `Multikill`: sus kills ya van una a una.
 * - `FirstBlood`: es la misma kill que el `ChampionKill` de al lado.
 */
const withoutDuplicates = (events: MatchEvent[]): MatchEvent[] =>
  events.filter((ev, i) => {
    if (ev.type === "Multikill") return false;
    if (ev.type === "FirstBlood") {
      return !events.some(
        (o, j) =>
          j !== i &&
          o.type === "ChampionKill" &&
          o.subtype !== "death" &&
          Math.abs(o.time - ev.time) <= 3
      );
    }
    return true;
  });

/**
 * Lista definitiva de sucesos para pintar: una marca por suceso, ordenada por
 * tiempo. `GameStart`/`GameEnd` quedan fuera: son los extremos del vídeo, no
 * algo que revisar.
 */
export function individualEvents(
  events: MatchEvent[] = [],
  markers: TimelineMarker[] = []
): MatchEvent[] {
  const live = withoutDuplicates(
    events.filter((e) => e.type !== "GameStart" && e.type !== "GameEnd")
  );

  // Emparejamiento 1:1 con el directo: un marcador se descarta solo si consume
  // un evento del directo que no haya consumido ya otro marcador. Comparar
  // "¿hay alguno cerca?" descartaba las dos marcas de un doble asesinato
  // cuando el directo solo había registrado una.
  const taken = new Set<number>();
  const extra = markers
    .map(fromMarker)
    .filter((e): e is MatchEvent => e !== null)
    .filter((cand) => {
      const kind = kindOf(cand);
      const twin = live.findIndex(
        (ev, i) =>
          !taken.has(i) && kindOf(ev) === kind && Math.abs(ev.time - cand.time) <= SAME_EVENT_S
      );
      if (twin === -1) return true;
      taken.add(twin);
      return false;
    });

  return [...live, ...extra].sort((a, b) => a.time - b.time);
}

/**
 * Nombre de un campeón tal y como se lee, a partir del id de Data Dragon que
 * traen los `participants` ("MissFortune" → "Miss Fortune"). Los que no salen
 * partiendo por mayúsculas —apóstrofos, Wukong— van en la tabla.
 */
const CHAMP_LABEL: Record<string, string> = {
  MonkeyKing: "Wukong",
  Kaisa: "Kai'Sa",
  Khazix: "Kha'Zix",
  Chogath: "Cho'Gath",
  Velkoz: "Vel'Koz",
  Belveth: "Bel'Veth",
  KogMaw: "Kog'Maw",
  RekSai: "Rek'Sai",
  Leblanc: "LeBlanc",
  KSante: "K'Sante",
  JarvanIV: "Jarvan IV",
  DrMundo: "Dr. Mundo",
  Nunu: "Nunu & Willump",
  FiddleSticks: "Fiddlesticks",
};

export const champLabel = (id: string): string =>
  CHAMP_LABEL[id] ?? id.replace(/([a-z])([A-Z])/g, "$1 $2");

/** Un nombre de jugador o de campeón, sin el "#TAG" y sin nada que no sea letra o cifra. */
const normName = (s?: string): string =>
  (s ?? "").split("#")[0].toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * El campeón del otro lado de un suceso de combate: a quién mataste (kill o
 * asistencia) o quién te mató (muerte).
 *
 * La API en directo manda NOMBRES DE JUGADOR (`actor`, `target`); el marcador
 * de Riot (`participants`) sabe qué campeón llevaba cada uno. Se busca solo en
 * el equipo rival: si el nombre casa con un aliado, el dato está mal y es mejor
 * enseñar el icono que la cara equivocada. `null` cuando no se puede saber —
 * partida sin sincronizar, marcadores de la Timeline (no traen nombres) o
 * partidas grabadas antes de que existieran esos campos.
 */
export function eventChampion(ev: MatchEvent, participants: Participant[] = []): string | null {
  if (ev.type !== "ChampionKill") return null;
  const who = normName(ev.subtype === "death" ? ev.actor : ev.target);
  if (!who || participants.length === 0) return null;
  const self = participants.find((p) => p.is_self);
  const rivals = self ? participants.filter((p) => p.team_id !== self.team_id) : participants;
  const p =
    rivals.find((x) => normName(x.name) === who) ??
    rivals.find((x) => normName(x.champion) === who);
  return p?.champion ?? null;
}

/**
 * El mismo suceso con el nombre del campeón en lugar del del jugador, para
 * componer la frase ("Te mata Kai'Sa" y no "Te mata xXNoobXx"): en una revisión
 * lo que se reconoce es la cara del campeón, no el nick.
 */
export function withChampionNames(ev: MatchEvent, participants: Participant[] = []): MatchEvent {
  const champ = eventChampion(ev, participants);
  if (!champ) return ev;
  return ev.subtype === "death"
    ? { ...ev, actor: champLabel(champ) }
    : { ...ev, target: champLabel(champ) };
}
