/**
 * De una ruta de disco a una URL que el `<video>` sepa abrir.
 *
 * El esquema NO es un detalle: tiene que ser `http://stream.localhost`. Con
 * `asset://` o con la ruta a pelo el reproductor no puede buscar dentro del
 * vídeo (no hay peticiones por rangos), que es justo lo que hace toda esta app.
 * El backend levanta ese servidor local (`streamer.rs`). Ojo también con el
 * esquema a secas: `stream://localhost/` no resuelve dentro del WebView.
 *
 * Estaba escrito cinco veces, así que cambiar de esquema significaba acordarse
 * de cinco sitios.
 */
export const streamUrl = (path: string): string =>
  `http://stream.localhost/${encodeURIComponent(path)}`;
