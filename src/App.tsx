import React, { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useGallery } from "./features/gallery/useGallery";
import { MatchGallery } from "./features/gallery/components/MatchGallery";
import { ClipsGallery } from "./features/gallery/components/ClipsGallery";
import { ErrorsGallery } from "./features/gallery/components/ErrorsGallery";
import { VodGallery } from "./features/vod/components/VodGallery";
import { VideoPlayer } from "./features/player/components/VideoPlayer";
import { ErrorPlayer } from "./features/player/components/ErrorPlayer";
import { SettingsPanel } from "./features/settings/components/SettingsPanel";
import { TrainingPanel } from "./features/training/components/TrainingPanel";
import { Titlebar } from "./components/Titlebar";
import { Scissors, Gamepad2, Settings, MonitorPlay, Film, ArrowLeft, AlertTriangle, Crosshair } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore } from "./store/useAppStore";

type Tab = "games" | "clips" | "errors" | "review" | "vod" | "training" | "settings";

/** Paneles con contenido propio. "review" no está: reutiliza el de "/games". */
type Panel = "/games" | "/clips" | "/errors" | "/vod" | "/training" | "/settings";

const NAV_ITEMS: { key: Tab; path: string; label: string; icon: React.ReactNode }[] = [
  { key: "games", path: "/games", label: "Games", icon: <Gamepad2 size={18} /> },
  { key: "clips", path: "/clips", label: "Clips", icon: <Film size={18} /> },
  { key: "errors", path: "/errors", label: "Errors", icon: <AlertTriangle size={18} /> },
  { key: "review", path: "/review", label: "Review", icon: <MonitorPlay size={18} /> },
  { key: "vod", path: "/vod", label: "VOD Analysis", icon: <Film size={18} /> },
  { key: "training", path: "/training", label: "Training", icon: <Crosshair size={18} /> },
];

export const App: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [appVersion, setAppVersion] = useState<string>("");

  const selectedError = useAppStore(state => state.selectedError);
  const setSelectedError = useAppStore(state => state.setSelectedError);
  const selectedVod = useAppStore(state => state.selectedVod);
  const setSelectedVod = useAppStore(state => state.setSelectedVod);

  React.useEffect(() => {
    getVersion().then(setAppVersion).catch(console.error);
  }, []);

  const currentPath = location.pathname;

  React.useEffect(() => {
    if (currentPath === "/") {
      navigate("/games", { replace: true });
    }
  }, [currentPath, navigate]);

  const {
    matches,
    selectedMatch,
    setSelectedMatch,
    isRecording,
    deleteMatch
  } = useGallery();

  const goTo = (path: string) => {
    navigate(path);
  };

  const matchedNav = NAV_ITEMS.find(n => currentPath.startsWith(n.path));
  const activeTabKey: string = matchedNav
    ? matchedNav.key
    : currentPath.startsWith("/settings")
      ? "settings"
      : "games";

  // Panel visible ahora mismo. "Review" comparte panel con "Games": es la lista de
  // partidas desde la que se abre una para revisarla, como antes de las rutas.
  const activePanel: Panel =
    currentPath.startsWith("/settings")
      ? "/settings"
      : activeTabKey === "review"
        ? "/games"
        : ((matchedNav?.path ?? "/games") as Panel);

  // Los paneles se quedan montados una vez visitados para no perder su estado (el
  // punto del vídeo, el scroll), pero no se montan de entrada: al abrir la app solo
  // arranca el panel inicial, no las seis pestañas con sus fetches y sus listeners.
  const [mountedPanels, setMountedPanels] = useState<Set<Panel>>(() => new Set<Panel>());
  // useLayoutEffect y no useEffect: así el panel se monta antes de pintar y al
  // cambiar de pestaña no se ve un fotograma en blanco.
  React.useLayoutEffect(() => {
    setMountedPanels(prev => (prev.has(activePanel) ? prev : new Set(prev).add(activePanel)));
  }, [activePanel]);

  // Envuelve un panel: oculto con display:none en vez de desmontarlo, y sin renderizar
  // su contenido hasta la primera visita.
  const panel = (path: Panel, content: React.ReactNode) => (
    <div
      key={path}
      style={{
        display: activePanel === path ? "flex" : "none",
        width: "100%",
        height: "100%",
        flexDirection: "column",
      }}
    >
      {mountedPanels.has(path) ? content : null}
    </div>
  );

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
              onClick={() => goTo(item.path)}
              className={`nav-btn${activeTabKey === item.key ? " nav-btn--active" : ""}`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
          <button
            onClick={() => goTo("/settings")}
            className={`nav-btn${activeTabKey === "settings" ? " nav-btn--active" : ""}`}
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
        {panel("/settings", <SettingsPanel />)}

        {panel("/training", <TrainingPanel />)}

        {panel("/clips", <ClipsGallery />)}

        {panel(
          "/vod",
          selectedVod ? (
            <div style={styles.playerWrapper}>
              <div style={styles.playerTopBar}>
                <button style={styles.backBtn} onClick={() => setSelectedVod(null)}>
                  <ArrowLeft size={20} />
                </button>
                <div style={styles.playerTitleBlock}>
                  <h2 style={styles.playerTitle}>AI Analysis</h2>
                  <span style={styles.playerSub}>{selectedVod.date}</span>
                </div>
              </div>
              <VideoPlayer match={selectedVod} />
            </div>
          ) : (
            <VodGallery onSelectMatch={setSelectedVod} />
          )
        )}

        {panel(
          "/errors",
          selectedError ? (
            <ErrorPlayer
              clip={selectedError}
              onUpdate={() => {}}
              onClose={() => setSelectedError(null)}
            />
          ) : (
            <ErrorsGallery onSelectError={setSelectedError} />
          )
        )}

        {panel(
          "/games",
          selectedMatch ? (
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
          )
        )}
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
