import React, { useState } from "react";
import { useGallery } from "./features/gallery/useGallery";
import { MatchGallery } from "./features/gallery/components/MatchGallery";
import { VideoPlayer } from "./features/player/components/VideoPlayer";
import { SettingsPanel } from "./features/settings/components/SettingsPanel";

type Tab = "matches" | "settings";

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>("matches");
  const {
    matches,
    selectedMatch,
    setSelectedMatch,
    isRecording,
    deleteMatch
  } = useGallery();

  return (
    <div style={styles.appContainer}>
      {/* Barra de Navegación Lateral (Sidebar) */}
      <div style={styles.sidebar}>
        <div style={styles.logoArea}>
          <span style={styles.logoIcon}>🛡️</span>
          <span style={styles.logoText}>LeagueRecorder</span>
        </div>

        <div style={styles.navLinks}>
          <button
            onClick={() => setActiveTab("matches")}
            style={{
              ...styles.navBtn,
              backgroundColor: activeTab === "matches" ? "var(--bg-elevated)" : "transparent",
              color: activeTab === "matches" ? "var(--text-primary)" : "var(--text-muted)",
              fontWeight: activeTab === "matches" ? 700 : 500,
              boxShadow: activeTab === "matches" ? "inset 3px 0 0 var(--accent-violet)" : "none",
            }}
          >
            🎬 Partidas
          </button>

          <button
            onClick={() => setActiveTab("settings")}
            style={{
              ...styles.navBtn,
              backgroundColor: activeTab === "settings" ? "var(--bg-elevated)" : "transparent",
              color: activeTab === "settings" ? "var(--text-primary)" : "var(--text-muted)",
              fontWeight: activeTab === "settings" ? 700 : 500,
              boxShadow: activeTab === "settings" ? "inset 3px 0 0 var(--accent-violet)" : "none",
            }}
          >
            ⚙️ Control
          </button>
        </div>

        <div style={styles.footerArea}>
          <div style={styles.footerVersion}>v1.0.0 (Local)</div>
        </div>
      </div>

      {/* Contenido Principal */}
      <div style={styles.mainContent}>
        {activeTab === "matches" ? (
          <div style={styles.galleryLayout}>
            {/* Listado lateral de partidas */}
            <MatchGallery
              matches={matches}
              selectedMatch={selectedMatch}
              onSelectMatch={setSelectedMatch}
              onDeleteMatch={deleteMatch}
              isRecording={isRecording}
            />
            
            {/* Visor central del Video y el Timeline */}
            <div style={styles.playerWrapper}>
              {selectedMatch ? (
                <VideoPlayer match={selectedMatch} />
              ) : (
                <div style={styles.selectPrompt}>
                  <span style={styles.promptIcon}>📺</span>
                  <h3>Ninguna partida seleccionada</h3>
                  <p>Selecciona una partida de la lista lateral para reproducir el video e interactuar con el timeline de eventos.</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <SettingsPanel />
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
  },
  sidebar: {
    width: "232px",
    background: "linear-gradient(180deg, var(--bg-panel), var(--bg-app))",
    borderRight: "1px solid var(--border-subtle)",
    display: "flex",
    flexDirection: "column",
    padding: "var(--space-5) var(--space-4)",
    boxSizing: "border-box",
  },
  logoArea: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    padding: "var(--space-1) var(--space-2) var(--space-6) var(--space-2)",
    borderBottom: "1px solid var(--border-subtle)",
  },
  logoIcon: {
    fontSize: "var(--font-2xl)",
    filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.5))",
  },
  logoText: {
    fontWeight: 800,
    fontSize: "var(--font-md)",
    letterSpacing: "-0.02em",
    background: "var(--gradient-violet)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    backgroundClip: "text",
  },
  navLinks: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
    marginTop: "var(--space-6)",
    flex: 1,
  },
  navBtn: {
    border: "none",
    background: "transparent",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-3) var(--space-4)",
    textAlign: "left",
    fontSize: "var(--font-sm)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    letterSpacing: "-0.01em",
  },
  footerArea: {
    paddingTop: "var(--space-4)",
    borderTop: "1px solid var(--border-subtle)",
  },
  footerVersion: {
    fontSize: "var(--font-xs)",
    color: "var(--text-muted)",
    textAlign: "center",
  },
  mainContent: {
    flex: 1,
    height: "100%",
    overflow: "hidden",
    boxSizing: "border-box",
    background: "var(--gradient-app)",
  },
  galleryLayout: {
    display: "flex",
    width: "100%",
    height: "100%",
    overflow: "hidden",
  },
  playerWrapper: {
    flex: 1,
    height: "100%",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  selectPrompt: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--text-muted)",
    padding: "var(--space-12)",
    textAlign: "center",
  },
  promptIcon: {
    fontSize: "72px",
    marginBottom: "var(--space-5)",
    opacity: 0.85,
    filter: "drop-shadow(0 6px 18px rgba(0,0,0,0.5))",
  },
};
export default App;
