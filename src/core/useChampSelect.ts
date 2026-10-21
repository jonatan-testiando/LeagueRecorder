import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { getChampSelect, type ChampSelectView, type LanePosition } from "./tauri-ipc";

/**
 * La selección de campeón en curso (`champ_select.rs`), compartida por la
 * pantalla, el rail y `ChampSelectFlow`.
 *
 * El backend avisa con `champ-select` (`{ active }`) en cada cambio de la
 * sesión (una elección, un baneo); la vista se vuelve a pedir entera, con el
 * rol que el usuario haya puesto a mano. Es una sola suscripción para toda la
 * app: con un hook por componente, cada elección eran tres peticiones.
 *
 * - `view`: la de ahora; `undefined` mientras no se ha preguntado, `null`
 *   fuera de la selección.
 * - `last`: la última que hubo, para que la pantalla no se quede en blanco al
 *   empezar la partida o si alguien se sale.
 * - `session`: sube en cada selección nueva. Es lo que mira `ChampSelectFlow`
 *   para ponerse delante una vez por selección y no en cada elección.
 * - `role`: el rol puesto a mano; se olvida al acabar la selección.
 */
export interface ChampSelectState {
  view: ChampSelectView | null | undefined;
  last: ChampSelectView | null;
  session: number;
  role: LanePosition | null;
}

let state: ChampSelectState = { view: undefined, last: null, session: 0, role: null };
const subs = new Set<() => void>();
/** Sube con cada petición y con cada cierre: una respuesta que llega tarde no
 *  pisa a la siguiente ni resucita una selección que ya acabó. */
let peticion = 0;
let arrancado = false;

function poner(p: Partial<ChampSelectState>) {
  state = { ...state, ...p };
  subs.forEach((f) => f());
}

async function pedir() {
  const n = ++peticion;
  let v: ChampSelectView | null;
  try {
    v = await getChampSelect(state.role);
  } catch {
    v = null;
  }
  if (n !== peticion) return;
  const nueva = !!v && !state.view;
  poner({ view: v, last: v ?? state.last, session: nueva ? state.session + 1 : state.session });
}

function arrancar() {
  if (arrancado) return;
  arrancado = true;
  listen<{ active: boolean }>("champ-select", (e) => {
    if (e.payload?.active) {
      void pedir();
    } else {
      peticion++;
      poner({ view: null, role: null });
    }
  }).catch(() => {});
  void pedir();
}

/** Pone el rol a mano (o lo quita con null) y rehace la vista. */
export function setChampSelectRole(role: LanePosition | null) {
  poner({ role });
  void pedir();
}

const suscribir = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};

export function useChampSelect(): ChampSelectState {
  useEffect(arrancar, []);
  return useSyncExternalStore(suscribir, () => state);
}
