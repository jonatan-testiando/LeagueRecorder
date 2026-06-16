import { useEffect, useState } from "react";

// Resolución de iconos de campeón vía Data Dragon (CDN público de Riot).
// La API del juego nos da el NOMBRE de display ("Miss Fortune", "Cassiopeia"),
// pero los iconos usan el ID interno ("MissFortune"). Cargamos champion.json una vez
// para mapear nombre->id correctamente (incluye casos especiales: Wukong->MonkeyKing, etc.).

const FALLBACK_VERSION = "15.11.1";

let versionPromise: Promise<string> | null = null;
let champMapPromise: Promise<{ version: string; map: Map<string, string> }> | null = null;

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function getVersion(): Promise<string> {
  if (!versionPromise) {
    versionPromise = fetch("https://ddragon.leagueoflegends.com/api/versions.json")
      .then((r) => r.json())
      .then((v: string[]) => (Array.isArray(v) && v[0] ? v[0] : FALLBACK_VERSION))
      .catch(() => FALLBACK_VERSION);
  }
  return versionPromise;
}

async function getChampMap(): Promise<{ version: string; map: Map<string, string> }> {
  if (!champMapPromise) {
    champMapPromise = (async () => {
      const version = await getVersion();
      const map = new Map<string, string>();
      try {
        const res = await fetch(
          `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`
        );
        const json = await res.json();
        for (const key of Object.keys(json.data ?? {})) {
          const champ = json.data[key];
          map.set(norm(champ.name), champ.id); // "miss fortune" -> "MissFortune"
          map.set(norm(champ.id), champ.id); // "missfortune"  -> "MissFortune"
        }
      } catch {
        /* sin red: devolvemos un mapa vacío y se usará el monograma */
      }
      return { version, map };
    })();
  }
  return champMapPromise;
}

export async function resolveChampionIcon(displayName: string): Promise<string | null> {
  if (!displayName || displayName.toLowerCase() === "unknown") return null;
  const { version, map } = await getChampMap();
  const id = map.get(norm(displayName));
  if (!id) return null;
  return `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${id}.png`;
}

/** Hook React que resuelve la URL del icono del campeón (null mientras carga o si no existe). */
export function useChampionIcon(champion: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setUrl(null);
    resolveChampionIcon(champion)
      .then((u) => {
        if (active) setUrl(u);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [champion]);
  return url;
}
