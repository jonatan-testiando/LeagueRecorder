import React, { useState } from "react";
import { useGallery } from "./features/gallery/useGallery";
import { MatchGallery } from "./features/gallery/components/MatchGallery";
import { ClipsGallery } from "./features/gallery/components/ClipsGallery";
import { VideoPlayer } from "./features/player/components/VideoPlayer";
import { SettingsPanel } from "./features/settings/components/SettingsPanel";
import { Scissors, Gamepad2, Settings, MonitorPlay, Film, ArrowLeft } from "lucide-react";

type Tab = "games" | "clips" | "review" | "settings";

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>("games");
  
  const {
    matches,
    selectedMatch,
    setSelectedMatch,
    isRecording,
    deleteMatch
  } = useGallery();

  return (
    <div style={styles.appContainer}>
      {/* Sidebar (Ascent Style) */}
      <div style={styles.sidebar}>
        <div style={styles.logoArea}>
          <Scissors color="var(--accent-violet)" size={28} strokeWidth={2.5} style={{ transform: "rotate(-45deg)" }} />
          <span style={styles.logoText}>My Recorder</span>
        </div>

        <div style={styles.navSection}>
          <span style={styles.navHeader}>COMMUNITIES</span>
          <div style={styles.navItem}>
            <div style={styles.commIcon}>WTL</div>
            <span style={styles.navText}>We Teach League</span>
          </div>
        </div>

        <div style={styles.navLinks}>
          <button
            onClick={() => { setActiveTab("games"); setSelectedMatch(null); }}
            style={{
              ...styles.navBtn,
              backgroundColor: activeTab === "games" ? "var(--accent-violet)" : "transparent",
              color: activeTab === "games" ? "#fff" : "var(--text-secondary)",
              fontWeight: activeTab === "games" ? 700 : 500,
            }}
          >
            <Gamepad2 size={18} />
            Games
          </button>
          <button
            onClick={() => setActiveTab("clips")}
            style={{
              ...styles.navBtn,
              backgroundColor: activeTab === "clips" ? "var(--accent-violet)" : "transparent",
              color: activeTab === "clips" ? "#fff" : "var(--text-secondary)",
            }}
          >
            <Film size={18} />
            Clips
          </button>
          <button
            onClick={() => setActiveTab("review")}
            style={{
              ...styles.navBtn,
              backgroundColor: activeTab === "review" ? "var(--accent-violet)" : "transparent",
              color: activeTab === "review" ? "#fff" : "var(--text-secondary)",
            }}
          >
            <MonitorPlay size={18} />
            Review
          </button>
          <button
            onClick={() => { setActiveTab("settings"); setSelectedMatch(null); }}
            style={{
              ...styles.navBtn,
              backgroundColor: activeTab === "settings" ? "var(--accent-violet)" : "transparent",
              color: activeTab === "settings" ? "#fff" : "var(--text-secondary)",
              marginTop: "auto"
            }}
          >
            <Settings size={18} />
            Settings
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div style={styles.mainContent}>
        {activeTab === "settings" ? (
          <SettingsPanel />
        ) : activeTab === "clips" ? (
          <ClipsGallery />
        ) : selectedMatch ? (
          <div style={styles.playerWrapper}>
            <div style={styles.playerTopBar}>
              <button style={styles.backBtn} onClick={() => setSelectedMatch(null)}>
                <ArrowLeft size={20} />
              </button>
              <div style={styles.playerTitleBlock}>
                <h2 style={styles.playerTitle}>{selectedMatch.champion}</h2>
                <span style={styles.playerSub}>Recorded {selectedMatch.date}</span>
              </div>
            </div>
            <VideoPlayer match={selectedMatch} />
          </div>
        ) : (
          <MatchGallery
            matches={matches}
            onSelectMatch={setSelectedMatch}
            onDeleteMatch={deleteMatch}
            isRecording={isRecording}
          />
        )}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  appContainer: {
    display: "flex",
    width: "100vw",
    height: "100vh",
    overflow: "hidden",
    boxSizing: "border-box",
    backgroundColor: "var(--bg-app)",
  },
  sidebar: {
    width: "240px",
    backgroundColor: "var(--bg-sidebar)",
    display: "flex",
    flexDirection: "column",
    padding: "var(--space-6) var(--space-4)",
    boxSizing: "border-box",
  },
  logoArea: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    paddingBottom: "var(--space-8)",
  },
  logoText: {
    fontWeight: 800,
    fontSize: "var(--font-xl)",
    letterSpacing: "0.05em",
    color: "#fff",
  },
  navSection: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-3)",
    marginBottom: "var(--space-8)",
  },
  navHeader: {
    fontSize: "11px",
    fontWeight: 700,
    color: "var(--text-muted)",
    letterSpacing: "0.1em",
  },
  navItem: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    cursor: "pointer",
  },
  commIcon: {
    width: "28px",
    height: "28px",
    borderRadius: "6px",
    backgroundColor: "#fff",
    color: "#000",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "9px",
    fontWeight: 800,
  },
  navText: {
    fontSize: "var(--font-sm)",
    fontWeight: 600,
    color: "var(--text-secondary)",
  },
  navLinks: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
    flex: 1,
  },
  navBtn: {
    border: "none",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-3) var(--space-4)",
    textAlign: "left",
    fontSize: "var(--font-sm)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    fontWeight: 600,
  },
  mainContent: {
    flex: 1,
    height: "100%",
    overflow: "hidden",
    boxSizing: "border-box",
    backgroundColor: "var(--bg-app)",
    display: "flex",
    flexDirection: "column",
  },
  playerWrapper: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    width: "100%",
  },
  playerTopBar: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-4)",
    padding: "var(--space-4) var(--space-6)",
    backgroundColor: "var(--bg-app)",
  },
  backBtn: {
    background: "transparent",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    padding: "var(--space-2)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  playerTitleBlock: {
    display: "flex",
    flexDirection: "column",
  },
  playerTitle: {
    margin: 0,
    fontSize: "var(--font-lg)",
    color: "#fff",
    fontWeight: 700,
  },
  playerSub: {
    fontSize: "var(--font-xs)",
    color: "var(--text-muted)",
  }
};
