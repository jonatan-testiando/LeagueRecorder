import React, { useState, useEffect } from "react";
import { champIcon, useChampionIcon } from "../core/ddragon";
import { championInitials } from "../core/matchStats";

interface Props {
  champion: string;
  size: number;
  ring?: string;
}

/**
 * Retrato del campeón: primero el fichero local, y sólo si no está se pregunta
 * al CDN de Riot.
 *
 * Iba al revés, y eso significaba **dos peticiones de red (versions.json y
 * champion.json) para pintar una lista de partidas cuyos 174 retratos ya viajan
 * dentro de la app**. Sin conexión —o con un DNS que no responde— fallaban en
 * silencio y la biblioteca entera se quedaba en iniciales.
 *
 * El CDN sigue haciendo falta para quien llega con el nombre de display
 * ("Miss Fortune"), que es lo que da la API en vivo: ahí el fichero local no
 * existe y el mapa nombre→id del CDN es la única salida.
 */
export const ChampionAvatar: React.FC<Props> = ({ champion, size, ring }) => {
  const [sinLocal, setSinLocal] = useState(false);
  const remoto = useChampionIcon(champion, sinLocal);
  const url = sinLocal ? remoto : champIcon(champion);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSinLocal(false);
    setFailed(false);
  }, [champion]);
  useEffect(() => setFailed(false), [url]);

  const showImg = !!url && !failed;

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "var(--radius-full)",
        overflow: "hidden",
        flexShrink: 0,
        boxShadow: ring ? `0 0 0 2px ${ring}` : undefined,
        background: "linear-gradient(160deg, var(--bg-elevated), var(--bg-app))",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 800,
        fontSize: size * 0.34,
        color: "var(--text-primary)",
      }}
    >
      {showImg ? (
        <img
          src={url!}
          onError={() => (sinLocal ? setFailed(true) : setSinLocal(true))}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
          alt={champion}
        />
      ) : (
        championInitials(champion)
      )}
    </div>
  );
};
