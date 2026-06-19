import React, { useEffect, useState } from "react";
import { MatchMetadata } from "../../../types";
import { computeKDA, kdaRatio, outcome, formatDuration } from "../../../core/matchStats";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { HardDrive, Search, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

interface DiskSpaceInfo {
  used_bytes: number;
  total_bytes: number;
}

interface MatchGalleryProps {
  matches: MatchMetadata[];
  onSelectMatch: (match: MatchMetadata) => void;
  onDeleteMatch: (id: string) => void;
  isRecording: boolean;
}

export const MatchGallery: React.FC<MatchGalleryProps> = ({
  matches,
  onSelectMatch,
  onDeleteMatch,
  isRecording,
}) => {
  const [diskSpace, setDiskSpace] = useState<DiskSpaceInfo>({ used_bytes: 0, total_bytes: 100 * 1024 * 1024 * 1024 });

  useEffect(() => {
    invoke<DiskSpaceInfo>("get_disk_usage")
      .then(setDiskSpace)
      .catch(console.error);
  }, [matches]);

  const usedGb = (diskSpace.used_bytes / (1024 * 1024 * 1024)).toFixed(1);
  const totalGb = (diskSpace.total_bytes / (1024 * 1024 * 1024)).toFixed(0);
  const pct = Math.min(100, Math.round((diskSpace.used_bytes / diskSpace.total_bytes) * 100));

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>Game Library</h1>
        <p style={styles.pageSubtitle}>Browse and manage your recorded games</p>
      </div>

      <div style={styles.storageCardsRow}>
        <div style={styles.storageCard}>
          <div style={styles.storageHeader}>
            <div style={styles.storageIconWrapper}>
              <HardDrive size={18} color="var(--accent-violet)" />
            </div>
            <div>
              <div style={styles.storageTitle}>Local Storage</div>
              <div style={styles.storageSubtitle}>LeagueRecorder Folder</div>
            </div>
            <div style={styles.storagePercent}>{pct}%</div>
          </div>
          <div style={styles.storageBarBg}>
            <div style={{ ...styles.storageBarFill, width: `${pct}%`, background: "var(--accent-violet)" }} />
          </div>
          <div style={styles.storageFooter}>
            <span>Used Space</span>
            <span>{usedGb} GB of {totalGb} GB</span>
          </div>
        </div>
      </div>

      <div style={styles.filtersRow}>
        <div style={styles.searchBox}>
          <Search size={16} color="var(--text-muted)" />
          <input type="text" placeholder="Search games..." style={styles.searchInput} disabled />
        </div>
      </div>

      <div style={styles.tabsRow}>
        <button style={styles.tabBtnActive}>
          League of Legends <span style={styles.tabBadge}>{matches.length}</span>
        </button>
        {isRecording && (
          <div style={styles.recordingIndicator}>
            <span style={styles.recordingDot} /> GRABANDO PARTIDA EN CURSO
          </div>
        )}
      </div>

      <div style={styles.tableHeader}>
        <div style={{ ...styles.th, flex: 2 }}>GAME</div>
        <div style={{ ...styles.th, flex: 1.5 }}>TIME</div>
        <div style={{ ...styles.th, flex: 1.5 }}>STATS (APM)</div>
        <div style={{ ...styles.th, flex: 1.5 }}>KDA</div>
        <div style={{ ...styles.th, width: "40px" }} />
      </div>

      <div style={styles.list}>
        {matches.length === 0 ? (
          <div style={styles.emptyState}>
            <span style={styles.emptyIcon}>🎮</span>
            <p style={styles.emptyText}>No games recorded yet. Play a match to get started.</p>
          </div>
        ) : (
          matches.map((match) => {
            const kda = computeKDA(match.events);
            const res = outcome(match.result);
            const isWin = res === "victory";
            
            return (
              <div
                key={match.id}
                onClick={() => onSelectMatch(match)}
                style={styles.row}
                className="game-row"
              >
                <div style={{ ...styles.td, flex: 2, display: "flex", alignItems: "center", gap: "var(--space-4)" }}>
                  <div style={styles.avatarWrapper}>
                    <ChampionAvatar champion={match.champion} size={48} />
                    <div style={{ ...styles.resultDot, background: isWin ? "var(--color-victory)" : "var(--color-defeat)" }} />
                  </div>
                  <div>
                    <div style={styles.champName}>{match.champion}</div>
                    <div style={styles.gameType}>
                      {match.riot_match_id ? (
                        <span style={{...styles.localBadge, borderColor: "var(--accent-violet)", color: "var(--accent-violet)"}}>Ranked / Normal Sync</span>
                      ) : (
                        <span style={styles.localBadge}>Custom Game</span>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ ...styles.td, flex: 1.5 }}>
                  <div style={styles.primaryText}>{match.date.split(" ")[0]}</div>
                  <div style={styles.secondaryText}>{formatDuration(match.game_duration)}</div>
                </div>

                <div style={{ ...styles.td, flex: 1.5 }}>
                  <div style={styles.primaryText}>{Math.round(match.apm || 0)} <span style={{fontSize:"11px", color:"var(--text-muted)", fontWeight:500}}>APM</span></div>
                  <div style={styles.secondaryText}>Actions per min</div>
                </div>

                <div style={{ ...styles.td, flex: 1.5 }}>
                  <div style={styles.primaryText}>
                    {match.kda ? (
                      <span>{match.kda.replace(/\//g, " / ")}</span>
                    ) : (
                      <>{kda.kills} / <span style={{ color: "var(--color-defeat)" }}>{kda.deaths}</span> / {kda.assists}</>
                    )}
                  </div>
                  <div style={styles.secondaryText}>
                    {match.gold_earned ? `💰 ${(match.gold_earned / 1000).toFixed(1)}k Gold` : `${kdaRatio(kda)} KDA`}
                  </div>
                </div>

                <div style={{ ...styles.td, width: "40px", justifyContent: "flex-end" }}>
                  <button 
                    style={styles.actionBtn}
                    onClick={(e) => { e.stopPropagation(); onDeleteMatch(match.id); }}
                    title="Delete Match"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    padding: "var(--space-8) 10%",
    overflowY: "auto",
    boxSizing: "border-box",
  },
  header: {
    marginBottom: "var(--space-6)",
  },
  pageTitle: {
    margin: 0,
    fontSize: "var(--font-2xl)",
    fontWeight: 700,
    color: "#fff",
  },
  pageSubtitle: {
    margin: "var(--space-2) 0 0 0",
    fontSize: "var(--font-sm)",
    color: "var(--text-secondary)",
  },
  storageCardsRow: {
    display: "flex",
    gap: "var(--space-4)",
    marginBottom: "var(--space-6)",
  },
  storageCard: {
    flex: 1,
    backgroundColor: "var(--bg-card)",
    borderRadius: "var(--radius-lg)",
    padding: "var(--space-4)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-4)",
    border: "1px solid var(--border-subtle)",
  },
  storageHeader: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
  },
  storageIconWrapper: {
    width: "36px",
    height: "36px",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--bg-elevated)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  storageTitle: {
    fontSize: "var(--font-sm)",
    fontWeight: 600,
    color: "#fff",
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
  },
  storageSubtitle: {
    fontSize: "var(--font-xs)",
    color: "var(--text-muted)",
  },
  proBadge: {
    backgroundColor: "var(--accent-violet)",
    color: "#fff",
    fontSize: "10px",
    padding: "2px 6px",
    borderRadius: "4px",
    fontWeight: 700,
  },
  storagePercent: {
    marginLeft: "auto",
    fontSize: "var(--font-lg)",
    fontWeight: 700,
    color: "#fff",
  },
  storageBarBg: {
    height: "4px",
    backgroundColor: "var(--bg-elevated)",
    borderRadius: "var(--radius-full)",
    overflow: "hidden",
  },
  storageBarFill: {
    height: "100%",
    borderRadius: "var(--radius-full)",
  },
  storageFooter: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: "var(--font-xs)",
    color: "var(--text-muted)",
  },
  filtersRow: {
    display: "flex",
    marginBottom: "var(--space-4)",
  },
  searchBox: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    backgroundColor: "var(--bg-card)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-2) var(--space-3)",
    width: "300px",
  },
  searchInput: {
    background: "transparent",
    border: "none",
    color: "#fff",
    outline: "none",
    width: "100%",
    fontSize: "var(--font-sm)",
  },
  tabsRow: {
    display: "flex",
    gap: "var(--space-3)",
    marginBottom: "var(--space-6)",
    alignItems: "center",
  },
  tabBtnActive: {
    backgroundColor: "var(--accent-violet)",
    color: "#fff",
    border: "none",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-2) var(--space-4)",
    fontSize: "var(--font-sm)",
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    cursor: "pointer",
  },
  tabBtnDefault: {
    backgroundColor: "transparent",
    color: "var(--text-secondary)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-2) var(--space-4)",
    fontSize: "var(--font-sm)",
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    cursor: "pointer",
  },
  tabBadge: {
    backgroundColor: "rgba(0,0,0,0.2)",
    padding: "2px 6px",
    borderRadius: "var(--radius-full)",
    fontSize: "11px",
  },
  recordingIndicator: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    fontSize: "11px",
    fontWeight: 800,
    color: "var(--color-defeat)",
  },
  recordingDot: {
    width: "8px",
    height: "8px",
    borderRadius: "var(--radius-full)",
    backgroundColor: "var(--color-defeat)",
    boxShadow: "0 0 8px var(--color-defeat)",
    animation: "pulse 1.5s infinite",
  },
  tableHeader: {
    display: "flex",
    padding: "0 var(--space-4) var(--space-3) var(--space-4)",
    borderBottom: "1px solid var(--border-subtle)",
    marginBottom: "var(--space-2)",
  },
  th: {
    fontSize: "11px",
    fontWeight: 700,
    color: "var(--text-muted)",
    letterSpacing: "0.05em",
  },
  list: {
    display: "flex",
    flexDirection: "column",
  },
  row: {
    display: "flex",
    padding: "var(--space-4)",
    borderBottom: "1px solid var(--border-subtle)",
    cursor: "pointer",
    transition: "background 0.2s",
  },
  td: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
  },
  avatarWrapper: {
    position: "relative",
  },
  resultDot: {
    position: "absolute",
    top: "-2px",
    left: "-2px",
    width: "12px",
    height: "12px",
    borderRadius: "var(--radius-full)",
    border: "2px solid var(--bg-app)",
  },
  champName: {
    fontSize: "var(--font-md)",
    fontWeight: 700,
    color: "#fff",
    marginBottom: "2px",
  },
  gameType: {
    fontSize: "var(--font-sm)",
    color: "var(--text-secondary)",
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
  },
  localBadge: {
    fontSize: "10px",
    border: "1px solid var(--border-strong)",
    padding: "2px 6px",
    borderRadius: "4px",
    color: "var(--text-muted)",
  },
  primaryText: {
    fontSize: "var(--font-sm)",
    fontWeight: 700,
    color: "#fff",
    marginBottom: "4px",
  },
  secondaryText: {
    fontSize: "12px",
    color: "var(--text-secondary)",
  },
  actionBtn: {
    background: "transparent",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    padding: "var(--space-2)",
  },
  emptyState: {
    padding: "var(--space-12)",
    textAlign: "center",
    color: "var(--text-muted)",
  },
  emptyIcon: {
    fontSize: "48px",
  },
  emptyText: {
    marginTop: "var(--space-4)",
    fontSize: "var(--font-sm)",
  }
};
