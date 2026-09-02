# riot-proxy

Cloudflare Worker que pone la clave de Riot por los usuarios de LeagueRecorder.

## Por qué

Una clave de desarrollo de Riot **caduca cada 24 horas**. Sin proxy, cada
usuario tiene que sacarse la suya en developer.riotgames.com y renovarla todos
los días; el día que se le olvida, la app deja de traer marcador, rango e
impacto (y hasta ahora, sin decir por qué).

Con el proxy la clave vive en un solo sitio: **se renueva una vez, del lado del
servidor, para todos**. El usuario solo pega la URL del proxy en
Ajustes → Avanzado → *Riot proxy URL* y deja de necesitar clave propia.

## Qué hace

Acepta `GET /{host}/{ruta}` donde `{host}` es uno de los hosts de la API de
Riot, y reenvía a `https://{host}/{ruta}` con la cabecera `X-Riot-Token`:

```
GET https://mi-proxy.workers.dev/europe.api.riotgames.com/lol/match/v5/matches/EUW1_7412345678
      →  https://europe.api.riotgames.com/lol/match/v5/matches/EUW1_7412345678
```

El host viaja en la ruta porque el cliente ya sabe a qué región va cada llamada
(regional para account-v1 y match-v5, de plataforma para league-v4); así el
proxy no tiene que replicar ese mapa. Es la forma exacta que construye
`RiotApiClient::url` en `src-tauri/src/riot_api.rs`.

- **Allowlist de hosts**: solo las 4 rutas regionales y las 17 plataformas. Sin
  ella esto sería un proxy abierto a todo internet firmado con tu cuenta.
- **Solo GET**: la app nunca escribe en la API de Riot.
- **Estado y cuerpo tal cual**, incluida la cabecera `Retry-After`: los
  reintentos del cliente ante un 429 siguen esperando lo que toca.
- **Caché** (Cache API de Cloudflare): los detalles y las timelines de partida
  (`/lol/match/v5/matches/{id}` y `/timeline`) no cambian nunca — se guardan 30
  días. El resto, 60 s. Dos usuarios que miran la misma partida gastan **una**
  llamada de cuota.
- **Límite por IP**: 60 peticiones por minuto, con el binding de rate limiting
  de Workers (declarado en `wrangler.toml`; no necesita KV ni infraestructura
  aparte). Es para que un cliente con un bucle no se lleve por delante la cuota
  de los demás. Si prefieres KV, sustituye el binding por un contador con TTL:
  la lógica está aislada en un único `if (env.LIMITER)`.

## Desplegar

Un solo comando, en PowerShell, desde esta carpeta:

```powershell
cd server
iot-proxy
.\deploy.ps1
```

Hace tres cosas y va diciendo cuál: (1) abre el navegador para entrar en
Cloudflare (o crear la cuenta gratis; el plan Free da 100.000 peticiones al
día), (2) pide la clave de Riot por teclado y la guarda como secreto en
Cloudflare, nunca en este repo, (3) despliega. Al final imprime la URL
(`https://leaguerecorder-riot-proxy.<cuenta>.workers.dev`): esa es la que va en
Ajustes → Avanzado → *Riot proxy URL*, sin barra final.

A mano, si prefieres verlo paso a paso: `npm install`, `npx wrangler login`,
`npx wrangler secret put RIOT_API_KEY`, `npx wrangler deploy`.

**Renovar la clave** (a diario si es de desarrollo): `.\deploy.ps1 -SoloClave`
(o `npx wrangler secret put RIOT_API_KEY`). No hace falta volver a desplegar, y ningún
usuario tiene que tocar nada.

Para que el editor typechee este worker: `npm i -D wrangler @cloudflare/workers-types`
y un `tsconfig.json` con `"types": ["@cloudflare/workers-types"]`. El `tsc` del
repo no mira esta carpeta (`tsconfig.json` de la raíz solo incluye `src`).

## Cuota

La cuota de Riot es de la clave, no del usuario: con muchos usuarios detrás de
una clave de desarrollo (20 req/s, 100 cada 2 min) el límite se nota. La caché
de partidas es lo que lo hace viable; para más gente hace falta una clave de
producción.
