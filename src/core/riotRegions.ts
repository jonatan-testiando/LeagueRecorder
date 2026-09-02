/**
 * Las regiones de Riot, en un solo sitio.
 *
 * La lista la impone el backend (es la que acepta `riot_platform`), así que su
 * definición vive junto al resto del contrato IPC. Lo que faltaba era un punto
 * de importación común: el asistente de primer arranque y la pantalla de
 * ajustes preguntan lo MISMO ("¿dónde juegas?") y estaban a un copiar-pegar de
 * tener dos listas que se irían separando en la primera región nueva.
 *
 * Quien pinte un selector de región importa de aquí, no de `tauri-ipc`.
 */

export { RIOT_PLATFORMS, platformLabel } from "./tauri-ipc";

/** Valor que le dice al backend que sondee la región con tus partidas. */
export const AUTO_PLATFORM = "auto";
