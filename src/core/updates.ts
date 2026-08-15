/**
 * Actualización de la app, en dos tiempos.
 *
 * La descarga la arranca el backend solo, poco después de abrir (ver
 * `src-tauri/src/app_update.rs`): cuando aquí llega `update-ready` el paquete ya
 * está bajado y verificado en memoria, así que instalar son segundos, no la
 * espera de ~100 MB que había antes.
 *
 * `installPendingUpdate()` no devuelve nunca en Windows: el instalador toma el
 * relevo y mata el proceso. La app vuelve sola al terminar.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface PendingUpdate {
  version: string;
  notes: string | null;
}

export interface UpdateProgress {
  percent: number;
  version: string;
}

export const getPendingUpdate = async (): Promise<PendingUpdate | null> =>
  await invoke<PendingUpdate | null>("get_pending_update");

export const installPendingUpdate = async (): Promise<void> =>
  await invoke<void>("install_pending_update");

/** Comprobación a petición: si hay algo nuevo, lo deja descargado y lo devuelve. */
export const checkForUpdateNow = async (): Promise<PendingUpdate | null> =>
  await invoke<PendingUpdate | null>("check_for_update_now");

export const onUpdateReady = (fn: (u: PendingUpdate) => void): Promise<UnlistenFn> =>
  listen<PendingUpdate>("update-ready", (e) => fn(e.payload));

export const onUpdateProgress = (fn: (p: UpdateProgress) => void): Promise<UnlistenFn> =>
  listen<UpdateProgress>("update-progress", (e) => fn(e.payload));
