/**
 * Proxy de la API de Riot para LeagueRecorder.
 *
 * El problema que resuelve: una clave de desarrollo caduca cada 24 h. Sin esto,
 * CADA usuario tiene que sacarse una y renovarla a diario, y el día que se le
 * olvida la app deja de traer marcador, rango e impacto. Con el proxy la clave
 * vive en un sitio y se renueva una vez para todos.
 *
 * Forma de las peticiones (la que construye `RiotApiClient::url` en Rust):
 *
 *     GET {proxy}/{host}/{ruta}
 *     GET https://mi-proxy.workers.dev/europe.api.riotgames.com/lol/match/v5/matches/EUW1_1
 *
 * El host viaja en la ruta para no tener que replicar aquí el mapa de regiones:
 * el cliente ya sabe a qué región va cada llamada.
 */

export interface Env {
  /** `wrangler secret put RIOT_API_KEY`. */
  RIOT_API_KEY: string;
  /** Límite por IP declarado en wrangler.toml. */
  LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

/** Rutas regionales: account-v1 y match-v5. */
const REGIONAL = ["americas", "europe", "asia", "sea"];

/** Plataformas: league-v4, summoner-v4, spectator… */
const PLATFORMS = [
  "la1", "la2", "na1", "br1", "euw1", "eun1", "tr1", "ru", "kr", "jp1", "oc1", "ph2", "sg2",
  "th2", "tw2", "vn2", "me1",
];

/**
 * Allowlist de hosts. Sin esto el worker sería un proxy abierto a cualquier
 * sitio de internet, firmado con nuestra IP y nuestra cuota.
 */
const HOSTS = new Set(
  [...REGIONAL, ...PLATFORMS].map((h) => `${h}.api.riotgames.com`)
);

/** Un detalle o una timeline de partida ya jugada no cambia nunca. */
const INMUTABLE = /^\/lol\/match\/v5\/matches\/[^/]+(\/timeline)?$/;
const TTL_INMUTABLE = 60 * 60 * 24 * 30; // 30 días
const TTL_NORMAL = 60; // el resto: un minuto, para no repetir ráfagas

const json = (status: number, body: unknown, extra?: HeadersInit): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(extra ?? {}) },
  });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET") {
      return json(405, { error: "solo GET" }, { allow: "GET" });
    }

    const url = new URL(request.url);
    // "/euw1.api.riotgames.com/lol/…" → host + resto.
    const [, host, ...resto] = url.pathname.split("/");
    if (!host || !HOSTS.has(host)) {
      return json(400, {
        error:
          "primer segmento de la ruta = host de Riot (p. ej. /europe.api.riotgames.com/lol/…)",
      });
    }
    if (!env.RIOT_API_KEY) {
      return json(500, { error: "al proxy le falta RIOT_API_KEY" });
    }

    // Límite por IP. Vale que sea aproximado: es para que un cliente con un
    // bucle no se lleve por delante la cuota de todos los demás.
    const ip = request.headers.get("CF-Connecting-IP") ?? "desconocida";
    if (env.LIMITER) {
      const { success } = await env.LIMITER.limit({ key: ip });
      if (!success) {
        return json(429, { error: "demasiadas peticiones" }, { "retry-after": "60" });
      }
    }

    const ruta = `/${resto.join("/")}`;
    const destino = new URL(`https://${host}${ruta}${url.search}`);

    // La caché se consulta con el destino como clave: así dos usuarios que
    // piden la misma partida gastan UNA sola llamada de cuota.
    const cache = caches.default;
    const clave = new Request(destino.toString(), { method: "GET" });
    const cacheada = await cache.match(clave);
    if (cacheada) return cacheada;

    const arriba = await fetch(destino.toString(), {
      headers: { "X-Riot-Token": env.RIOT_API_KEY, accept: "application/json" },
    });

    // El estado y el cuerpo pasan tal cual: el cliente ya sabe interpretar los
    // 404, los 429 y los 403 de Riot, y `Retry-After` es lo que hace que sus
    // reintentos esperen lo que toca en vez de insistir a ciegas.
    const headers = new Headers({
      "content-type": arriba.headers.get("content-type") ?? "application/json",
    });
    const retry = arriba.headers.get("Retry-After");
    if (retry) headers.set("Retry-After", retry);

    if (!arriba.ok) {
      return new Response(await arriba.text(), { status: arriba.status, headers });
    }

    const ttl = INMUTABLE.test(ruta) ? TTL_INMUTABLE : TTL_NORMAL;
    headers.set("cache-control", `public, max-age=${ttl}`);
    const resp = new Response(await arriba.text(), { status: 200, headers });
    // Guardar sin bloquear la respuesta al cliente.
    ctx.waitUntil(cache.put(clave, resp.clone()));
    return resp;
  },
};
