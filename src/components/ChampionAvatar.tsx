import React, { useState, useEffect } from "react";
import { useChampionIcon } from "../core/ddragon";
import { championInitials } from "../core/matchStats";

interface Props {
  champion: string;
  size: number;
  ring?: string;
}

export const ChampionAvatar: React.FC<Props> = ({ champion, size, ring }) => {
  const url = useChampionIcon(champion);
  const [failed, setFailed] = useState(false);

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
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
          alt={champion}
        />
      ) : (
        championInitials(champion)
      )}
    </div>
  );
};
