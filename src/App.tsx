import React, { useState } from "react";
import { useGallery } from "./features/gallery/useGallery";
import { MatchGallery } from "./features/gallery/components/MatchGallery";
import { ClipsGallery } from "./features/gallery/components/ClipsGallery";
import { ErrorsGallery } from "./features/gallery/components/ErrorsGallery";
import { VodGallery } from "./features/vod/components/VodGallery";
import { VideoPlayer } from "./features/player/components/VideoPlayer";
import { ErrorPlayer } from "./features/player/components/ErrorPlayer";
import { SettingsPanel } from "./features/settings/components/SettingsPanel";
import { Titlebar } from "./components/Titlebar";
import { Scissors, Gamepad2, Settings, MonitorPlay, Film, ArrowLeft, AlertTriangle } from "lucide-react";
import { ErrorClipMetadata } from "./core/tauri-ipc";
import { motion, AnimatePresence } from "framer-motion";
import { getVersion } from "@tauri-apps/api/app";

type Tab = "games" | "clips" | "errors" | "review" | "vod" | "settings";

const NAV_ITEMS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: "games", label: "Games", icon: <Gamepad2 size={18} /> },
  { key: "clips", label: "Clips", icon: <Film size={18} /> },
  { key: "errors", label: "Errors", icon: <AlertTriangle size={18} /> },
  { key: "review", label: "Review", icon: <MonitorPlay size={18} /> },
  { key: "vod", label: "VOD Analysis", icon: <Film size={18} /> },
];

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>("games");
  const [selectedError, setSelectedError] = useState<ErrorClipMetadata | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");
  
  React.useEffect(() => {
    getVersion().then(setAppVersion).catch(console.error);
  }, []);
  
  const {
    matches,
    selectedMatch,
    setSelectedMatch,
    isRecording,
    deleteMatch
  } = useGallery();

  const goTo = (tab: Tab) => { setActiveTab(tab); setSelectedMatch(null); };

  return (
    <>
      <Titlebar />
      <div className="app-body" style={styles.appContainer}>
      {/* Sidebar (Ascent Style) */}
      <div style={styles.sidebar}>
        <div style={styles.logoArea}>
          <Scissors color="var(--accent-violet)" size={28} strokeWidth={2.5} style={{ transform: "rotate(-45deg)" }} />
          <span style={styles.logoText}>LeagueRecorder</span>
        </div>

        <div style={styles.navLinks}>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              onClick={() => goTo(item.key)}
              className={`nav-btn${activeTab === item.key ? " nav-btn--active" : ""}`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
          <button
            onClick={() => goTo("settings")}
            className={`nav-btn${activeTab === "settings" ? " nav-btn--active" : ""}`}
            style={{ marginTop: "auto" }}
          >
            <Settings size={18} />
            Settings
          </button>
          {appVersion && (
            <div style={{ textAlign: "center", marginTop: "var(--space-2)", fontSize: "11px", color: "var(--text-muted)", fontWeight: 600 }}>
              v{appVersion}
            </div>
          )}
        </div>
      </div>

      {/* Main Content Area */}
      <div style={styles.mainContent}>
        <AnimatePresence mode="wait">
          <motion.div
            key={selectedError ? "errorPlayer" : activeTab === "games" && selectedMatch ? "videoPlayer" : activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}
          >
            {activeTab === "settings" ? (
              <SettingsPanel />
            ) : activeTab === "clips" ? (
              <ClipsGallery />
            ) : activeTab === "vod" ? (
              <>
                {selectedMatch && (
                  <div style={styles.playerWrapper}>
                    <div style={styles.playerTopBar}>
                      <button style={styles.backBtn} onClick={() => setSelectedMatch(null)}>
                        <ArrowLeft size={20} />
                      </button>
                      <div style={styles.playerTitleBlock}>
                        <h2 style={styles.playerTitle}>AI Analysis</h2>
                        <span style={styles.playerSub}>{selectedMatch.date}</span>
                      </div>
                    </div>
                    <VideoPlayer match={selectedMatch} />
                  </div>
                )}
                <div style={{ display: selectedMatch ? "none" : "block", width: "100%", height: "100%" }}>
                  <VodGallery onSelectMatch={setSelectedMatch} />
                </div>
              </>
            ) : activeTab === "errors" ? (
              selectedError ? (
                <ErrorPlayer 
                  clip={selectedError} 
                  onUpdate={() => {}} 
                  onClose={() => setSelectedError(null)} 
                />
              ) : (
                <ErrorsGallery onSelectError={setSelectedError} />
              )
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
          </motion.div>
        </AnimatePresence>
      </div>
      </div>
    </>
  );
};

const styles: Record<string, React.CSSProperties> = {
  appContainer: {
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
