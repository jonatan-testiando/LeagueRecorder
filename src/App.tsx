import React, { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useGallery } from "./features/gallery/useGallery";
import { MatchGallery } from "./features/gallery/components/MatchGallery";
import { ClipsGallery } from "./features/gallery/components/ClipsGallery";
import { PatternsPanel } from "./features/patterns/components/PatternsPanel";
import { ErrorsGallery } from "./features/gallery/components/ErrorsGallery";
import { VodGallery } from "./features/vod/components/VodGallery";
import { VideoPlayer } from "./features/player/components/VideoPlayer";
import { ErrorPlayer } from "./features/player/components/ErrorPlayer";
import { SettingsPanel } from "./features/settings/components/SettingsPanel";
import { TrainingPanel } from "./features/training/components/TrainingPanel";
import { Titlebar } from "./components/Titlebar";
import { Video, Settings2, Library, Film, ArrowLeft, TriangleAlert, ScanSearch, Target, ChartNoAxesColumn } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore } from "./store/useAppStore";

type Tab = "clips" | "errors" | "review" | "patterns" | "vod" | "training" | "settings";

type Panel = "/review" | "/clips" | "/errors" | "/patterns" | "/vod" | "/training" | "/settings";

// Un icono por sección y ninguno repetido: antes "Clips" y "VOD Analysis"
// compartían el mismo `Film`, que es lo que obliga a leer la etiqueta para saber
// dónde estás. Trazo de 1.6 y 17px en todos, para que pesen igual entre sí.
const NAV_ICON = { size: 17, strokeWidth: 1.6 } as const;

const NAV_ITEMS: { key: Tab; path: string; label: string; icon: React.ReactNode }[] = [
  { key: "review", path: "/review", label: "Library", icon: <Library {...NAV_ICON} /> },
  { key: "clips", path: "/clips", label: "Clips", icon: <Film {...NAV_ICON} /> },
  { key: "errors", path: "/errors", label: "Errors", icon: <TriangleAlert {...NAV_ICON} /> },
  // La unica seccion que mira mas de una partida a la vez.
  { key: "patterns", path: "/patterns", label: "Patterns", icon: <ChartNoAxesColumn {...NAV_ICON} /> },
  { key: "vod", path: "/vod", label: "Analysis", icon: <ScanSearch {...NAV_ICON} /> },
  { key: "training", path: "/training", label: "Training", icon: <Target {...NAV_ICON} /> },
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

  // "/games" era una segunda entrada al mismo panel que "/review"; se quitó del menú, pero la
  // ruta se redirige para no romper el estado de navegación guardado de versiones anteriores.
  React.useEffect(() => {
    if (currentPath === "/" || currentPath.startsWith("/games")) {
      navigate("/review", { replace: true });
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
      : "review";

  const activePanel: Panel =
    currentPath.startsWith("/settings")
      ? "/settings"
      : ((matchedNav?.path ?? "/review") as Panel);

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
  //
  // La clave `panelSeq` se incrementa en cada cambio de panel para reiniciar la
  // animación de entrada. Antes esto era un corte seco: la navegación, que es lo
  // único que se hace todo el rato, era lo único sin transición, mientras cada
  // tarjeta decorativa entraba con fundido.
  const panel = (path: Panel, content: React.ReactNode) => {
    const active = activePanel === path;
    return (
      <div
        key={path}
        className={active ? "panel-enter" : undefined}
        style={{
          display: active ? "flex" : "none",
          width: "100%",
          height: "100%",
          flexDirection: "column",
        }}
      >
        {mountedPanels.has(path) ? content : null}
      </div>
    );
  };

  return (
    <>
      <Titlebar />
      <div className="app-body" style={styles.appContainer}>
      {/* Sidebar (Ascent Style) */}
      <div style={styles.sidebar}>
        {/* La marca es una grabadora, no unas tijeras: las tijeras son "recortar
            un clip", que es una función más, no lo que hace la app. */}
        <div style={styles.logoArea}>
          <Video color="var(--brand)" size={20} strokeWidth={1.8} />
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
            <Settings2 {...NAV_ICON} />
            Settings
          </button>
          {appVersion && (
            <div className="u-meta" style={{ textAlign: "center", marginTop: "var(--space-2)" }}>
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
        {panel("/patterns", <PatternsPanel />)}

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
          "/review",
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
    fontWeight: 700,
    fontSize: "var(--font-lg)",
    letterSpacing: "0.02em",
    color: "var(--text)",
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
    color: "var(--text)",
    fontWeight: 600,
  },
  playerSub: {
    fontSize: "var(--font-xs)",
    color: "var(--text-muted)",
  }
};
