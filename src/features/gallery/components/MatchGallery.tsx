import React from "react";
import { MatchMetadata } from "../../../types";
import { computeKDA, kdaRatio, outcome, formatDuration } from "../../../core/matchStats";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { Film, Trash2 } from "lucide-react";

interface MatchGalleryProps {
  matches: MatchMetadata[];
  selectedMatch: MatchMetadata | null;
  onSelectMatch: (match: MatchMetadata) => void;
  onDeleteMatch: (id: string) => void;
  isRecording: boolean;
}

export const MatchGallery: React.FC<MatchGalleryProps> = ({
  matches,
  selectedMatch,
  onSelectMatch,
  onDeleteMatch,
  isRecording,
}) => {
  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.headerTop}>
          <h2 style={styles.title}>Partidas</h2>
          <span style={styles.count}>{matches.length}</span>
        </div>
        {isRecording && (
          <div style={styles.recordingIndicator}>
            <span style={styles.recordingDot} />
            <span>GRABANDO PARTIDA</span>
          </div>
        )}
      </div>

      {matches.length === 0 ? (
        <div style={styles.emptyState}>
          <Film size={48} color="var(--text-muted)" strokeWidth={1} style={{ marginBottom: "var(--space-4)", opacity: 0.7 }} />
          <h3 style={styles.emptyTitle}>Sin partidas grabadas</h3>
          <p style={styles.emptyText}>
            Abre League of Legends e inicia una partida. La app detectará el juego y grabará automáticamente.
          </p>
        </div>
      ) : (
        <div style={styles.list}>
          {matches.map((match) => {
            const isSelected = selectedMatch?.id === match.id;
            const result = outcome(match.result);
            const kda = computeKDA(match.events);
            const accent =
              result === "victory" ? "var(--color-victory)" : result === "defeat" ? "var(--color-defeat)" : "var(--text-muted)";
            const resultLabel = result === "victory" ? "VICTORIA" : result === "defeat" ? "DERROTA" : "—";

            return (
              <div
                key={match.id}
                onClick={() => onSelectMatch(match)}
                style={{
                  ...styles.card,
                  borderColor: isSelected ? "var(--border-focus)" : "var(--border-subtle)",
                  background: isSelected ? "var(--bg-elevated)" : "var(--bg-card)",
                  boxShadow: isSelected ? "var(--shadow-md), 0 0 0 1px var(--border-focus)" : "var(--shadow-sm)",
                  transform: isSelected ? "translateY(-1px)" : "none",
                }}
              >
                <div style={{ ...styles.accentBar, background: accent }} />

                <div style={styles.cardMain}>
                  <div style={styles.cardTop}>
                    <ChampionAvatar champion={match.champion} size={48} ring={accent} />
                    <div style={styles.champBlock}>
                      <span style={styles.championName}>{match.champion}</span>
                      <span style={styles.subLine}>
                        {formatDuration(match.game_duration)} · {match.date.split(" ")[0]}
                      </span>
                    </div>
                    <span style={{ ...styles.resultPill, color: accent, borderColor: accent, background: `color-mix(in srgb, ${accent} 10%, transparent)` }}>
                      {resultLabel}
                    </span>
                  </div>

                  <div style={styles.statsRow}>
                    <div style={styles.kdaGroup}>
                      <span style={{ color: "var(--text-primary)", fontWeight: 700 }}>{kda.kills}</span>
                      <span style={styles.kdaSep}>/</span>
                      <span style={{ color: "var(--color-death)", fontWeight: 700 }}>{kda.deaths}</span>
                      <span style={styles.kdaSep}>/</span>
                      <span style={{ color: "var(--accent-teal)", fontWeight: 700 }}>{kda.assists}</span>
                      <span style={styles.kdaLabel}>KDA</span>
                    </div>
                    <span style={styles.ratio}>{kdaRatio(kda)}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDeleteMatch(match.id); }}
                      style={styles.deleteBtn}
                      title="Eliminar grabación"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    width: "380px",
    height: "100%",
    background: "var(--bg-panel)",
    backdropFilter: "blur(16px)",
    borderRight: "1px solid var(--border-subtle)",
    boxSizing: "border-box",
    zIndex: 5,
  },
  header: {
    padding: "var(--space-6) var(--space-5) var(--space-4)",
    borderBottom: "1px solid var(--border-subtle)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  },
  headerTop: { display: "flex", alignItems: "center", gap: "var(--space-3)" },
  title: { margin: 0, fontSize: "var(--font-xl)", fontWeight: 800, letterSpacing: "-0.03em" },
  count: {
    fontSize: "var(--font-xs)",
    fontWeight: 700,
    color: "var(--text-primary)",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-full)",
    padding: "2px 10px",
  },
  recordingIndicator: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    fontSize: "var(--font-xs)",
    fontWeight: 800,
    color: "var(--color-defeat)",
    letterSpacing: "0.06em",
    marginTop: "var(--space-2)",
  },
  recordingDot: {
    width: "8px",
    height: "8px",
    borderRadius: "var(--radius-full)",
    backgroundColor: "var(--color-defeat)",
    boxShadow: "0 0 12px var(--color-defeat)",
    animation: "pulse 1.5s infinite",
  },
  list: {
    flex: 1,
    overflowY: "auto",
    padding: "var(--space-4) var(--space-3)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-3)",
  },
  card: {
    position: "relative",
    display: "flex",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border-subtle)",
    cursor: "pointer",
    overflow: "hidden",
    transition: "all 0.2s ease",
  },
  accentBar: { width: "4px", flexShrink: 0 },
  cardMain: {
    flex: 1,
    padding: "var(--space-4)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-3)",
    minWidth: 0,
  },
  cardTop: { display: "flex", alignItems: "center", gap: "var(--space-3)" },
  champBlock: { display: "flex", flexDirection: "column", gap: "2px", flex: 1, minWidth: 0 },
  championName: {
    fontSize: "var(--font-md)",
    fontWeight: 700,
    color: "var(--text-primary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    letterSpacing: "-0.01em",
  },
  subLine: { fontSize: "var(--font-xs)", color: "var(--text-muted)", fontWeight: 500 },
  resultPill: {
    fontSize: "10px",
    fontWeight: 800,
    letterSpacing: "0.08em",
    padding: "4px var(--space-3)",
    borderRadius: "var(--radius-full)",
    border: "1px solid currentColor",
    flexShrink: 0,
  },
  statsRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    paddingTop: "var(--space-3)",
    borderTop: "1px solid var(--border-subtle)",
  },
  kdaGroup: { display: "flex", alignItems: "center", gap: "6px", fontSize: "var(--font-sm)" },
  kdaSep: { color: "var(--text-muted)" },
  kdaLabel: {
    fontSize: "9px",
    fontWeight: 800,
    color: "var(--text-muted)",
    letterSpacing: "0.08em",
    marginLeft: "var(--space-1)",
  },
  ratio: {
    fontSize: "11px",
    fontWeight: 800,
    color: "var(--text-primary)",
    background: "hsla(320, 80%, 70%, 0.15)",
    border: "1px solid hsla(320, 80%, 70%, 0.3)",
    borderRadius: "var(--radius-sm)",
    padding: "2px var(--space-2)",
  },
  deleteBtn: {
    marginLeft: "auto",
    background: "transparent",
    border: "none",
    color: "var(--text-muted)",
    padding: "var(--space-2)",
    cursor: "pointer",
    borderRadius: "var(--radius-sm)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "color 0.2s, background 0.2s",
  },
  emptyState: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "var(--space-6)",
    textAlign: "center",
    color: "var(--text-muted)",
  },
  emptyTitle: { margin: 0, color: "var(--text-primary)", fontSize: "var(--font-md)", fontWeight: 700 },
  emptyText: { fontSize: "var(--font-sm)", marginTop: "var(--space-2)", lineHeight: "1.5", maxWidth: "260px" },
};
