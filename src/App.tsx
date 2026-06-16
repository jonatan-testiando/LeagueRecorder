import React, { useState } from "react";
import { useGallery } from "./features/gallery/useGallery";
import { MatchGallery } from "./features/gallery/components/MatchGallery";
import { VideoPlayer } from "./features/player/components/VideoPlayer";
import { SettingsPanel } from "./features/settings/components/SettingsPanel";
import { Scissors, Film, Settings, MonitorPlay } from "lucide-react";

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
          <div style={styles.logoIconWrapper}>
            <Scissors color="var(--accent-teal)" size={26} strokeWidth={2.5} />
          </div>
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
              boxShadow: activeTab === "matches" ? "inset 3px 0 0 var(--accent-teal)" : "none",
            }}
          >
            <Film size={18} strokeWidth={activeTab === "matches" ? 2.5 : 2} />
            Partidas
          </button>

          <button
            onClick={() => setActiveTab("settings")}
            style={{
              ...styles.navBtn,
              backgroundColor: activeTab === "settings" ? "var(--bg-elevated)" : "transparent",
              color: activeTab === "settings" ? "var(--text-primary)" : "var(--text-muted)",
              fontWeight: activeTab === "settings" ? 700 : 500,
              boxShadow: activeTab === "settings" ? "inset 3px 0 0 var(--accent-teal)" : "none",
            }}
          >
            <Settings size={18} strokeWidth={activeTab === "settings" ? 2.5 : 2} />
            Control
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
                  <div style={styles.promptIconWrapper}>
                    <MonitorPlay size={64} color="var(--accent-teal)" strokeWidth={1} />
                  </div>
                  <h3 style={styles.promptTitle}>Ninguna partida seleccionada</h3>
                  <p style={styles.promptText}>Selecciona una partida de la lista lateral para reproducir el video e interactuar con el timeline de eventos.</p>
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
    width: "240px",
    background: "var(--bg-panel)",
    backdropFilter: "blur(16px)",
    borderRight: "1px solid var(--border-subtle)",
    display: "flex",
    flexDirection: "column",
    padding: "var(--space-6) var(--space-4)",
    boxSizing: "border-box",
    zIndex: 10,
  },
  logoArea: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    paddingBottom: "var(--space-6)",
    borderBottom: "1px solid var(--border-subtle)",
  },
  logoIconWrapper: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "hsla(186, 100%, 69%, 0.15)",
    borderRadius: "var(--radius-md)",
    width: "42px",
    height: "42px",
    border: "1px solid hsla(186, 100%, 69%, 0.3)",
    boxShadow: "0 0 16px hsla(186, 100%, 69%, 0.2)",
  },
  logoText: {
    fontWeight: 800,
    fontSize: "var(--font-md)",
    letterSpacing: "-0.03em",
    background: "var(--gradient-teal)",
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
    transition: "all 0.2s ease",
  },
  footerArea: {
    paddingTop: "var(--space-4)",
    borderTop: "1px solid var(--border-subtle)",
  },
  footerVersion: {
    fontSize: "var(--font-xs)",
    color: "var(--text-muted)",
    textAlign: "center",
    fontWeight: 600,
    letterSpacing: "0.05em",
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
    position: "relative",
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
    background: "var(--bg-app)",
  },
  promptIconWrapper: {
    marginBottom: "var(--space-5)",
    opacity: 0.6,
    filter: "drop-shadow(0 0 32px hsla(186, 100%, 69%, 0.3))",
  },
  promptTitle: {
    color: "var(--text-primary)",
    margin: "0 0 var(--space-3) 0",
    fontSize: "var(--font-lg)",
    fontWeight: 700,
  },
  promptText: {
    maxWidth: "360px",
    lineHeight: 1.5,
    margin: 0,
  }
};
export default App;
