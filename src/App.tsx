import React, { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useGallery } from "./features/gallery/useGallery";
import { MatchGallery } from "./features/gallery/components/MatchGallery";
import { ClipsGallery } from "./features/gallery/components/ClipsGallery";
import { PatternsPanel } from "./features/patterns/components/PatternsPanel";
import { HomePanel } from "./features/home/components/HomePanel";
import { ErrorsGallery } from "./features/gallery/components/ErrorsGallery";
import { VodGallery } from "./features/vod/components/VodGallery";
import { VideoPlayer } from "./features/player/components/VideoPlayer";
import { ErrorPlayer } from "./features/player/components/ErrorPlayer";
import { SettingsPanel } from "./features/settings/components/SettingsPanel";
import { TrainingPanel } from "./features/training/components/TrainingPanel";
import { Titlebar } from "./components/Titlebar";
import { Settings2, Library, Film, ArrowLeft, TriangleAlert, ScanSearch, Target, ChartNoAxesColumn, CircleDot } from "lucide-react";
import { BrandMark } from "./components/BrandMark";
import { getVersion } from "@tauri-apps/api/app";
import { getPendingUpdate, onUpdateReady, type PendingUpdate } from "./core/updates";
import { useAppStore } from "./store/useAppStore";
import { useT } from "./core/LanguageProvider";

type Tab = "home" | "clips" | "errors" | "review" | "patterns" | "vod" | "training" | "settings";

type Panel = "/home" | "/review" | "/clips" | "/errors" | "/patterns" | "/vod" | "/training" | "/settings";

// Un icono por sección y ninguno repetido: antes "Clips" y "VOD Analysis"
// compartían el mismo `Film`, que es lo que obliga a leer la etiqueta para saber
// dónde estás. Trazo de 1.6 y 17px en todos, para que pesen igual entre sí.
const NAV_ICON = { size: 17, strokeWidth: 1.6 } as const;

const NAV_ITEMS: { key: Tab; path: string; label: string; icon: React.ReactNode }[] = [
  // Lo primero al abrir deja de ser una lista de ficheros y pasa a ser en que
  // estas trabajando. La app estaba organizada por tipo de archivo, y eso
  // contesta "donde estan mis cosas", que no es la pregunta de nadie.
  { key: "home", path: "/home", label: "Today", icon: <CircleDot {...NAV_ICON} /> },
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
  // Actualización ya descargada por detrás. El aviso vive aquí, junto a la
  // versión, y no en un modal: no interrumpe, solo deja de decir "v1.2.11".
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate | null>(null);
  const t = useT();

  const selectedError = useAppStore(state => state.selectedError);
  const setSelectedError = useAppStore(state => state.setSelectedError);
  const selectedVod = useAppStore(state => state.selectedVod);
  const setSelectedVod = useAppStore(state => state.setSelectedVod);

  React.useEffect(() => {
    getVersion().then(setAppVersion).catch(console.error);
    // Puede haberse descargado antes de montar este componente (o en otra
    // sesión de la ventana), así que se pregunta además de escuchar.
    getPendingUpdate().then(setPendingUpdate).catch(() => {});
    const stop = onUpdateReady(setPendingUpdate);
    return () => { stop.then((f) => f()).catch(() => {}); };
  }, []);

  const currentPath = location.pathname;

  // "/games" era una segunda entrada al mismo panel que "/review"; se quitó del menú, pero la
  // ruta se redirige para no romper el estado de navegación guardado de versiones anteriores.
  React.useEffect(() => {
    if (currentPath === "/" || currentPath.startsWith("/games")) {
      navigate("/home", { replace: true });
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
      : "home";

  const activePanel: Panel =
    currentPath.startsWith("/settings")
      ? "/settings"
      : ((matchedNav?.path ?? "/home") as Panel);

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
        {/* La marca propia sustituye al icono prestado de la libreria: un
            marcapaginas, que es lo que se hace aqui — marcar el momento que
            duele para volver a el. */}
        <div style={styles.logoArea}>
          <span style={{ color: "var(--brand)", display: "flex" }}>
            <BrandMark size={18} />
          </span>
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
              {t(item.label)}
            </button>
          ))}
          <button
            onClick={() => goTo("/settings")}
            className={`nav-btn${activeTabKey === "settings" ? " nav-btn--active" : ""}`}
            style={{ marginTop: "auto" }}
          >
            <Settings2 {...NAV_ICON} />
            {t("Settings")}
          </button>
          {pendingUpdate ? (
            <button
              className="updpill"
              onClick={() => goTo("/settings")}
              title={t("Downloaded and ready. Installing takes a few seconds.")}
            >
              <span className="updpill__dot" />
              {t("Update ready")} · v{pendingUpdate.version}
            </button>
          ) : appVersion ? (
            <div className="u-meta" style={{ textAlign: "center", marginTop: "var(--space-2)" }}>
              v{appVersion}
            </div>
          ) : null}
        </div>
      </div>

      {/* Main Content Area */}
      <div style={styles.mainContent}>
        {panel("/settings", <SettingsPanel />)}

        {panel("/training", <TrainingPanel />)}

        {panel("/clips", <ClipsGallery />)}
        {panel("/patterns", <PatternsPanel />)}

        {panel(
          "/home",
          <HomePanel
            matches={matches}
            isRecording={isRecording}
            onOpenMatch={(m) => { setSelectedMatch(m); navigate("/review"); }}
            onGoTraining={() => navigate("/training")}
          />
        )}

        {panel(
          "/vod",
          selectedVod ? (
            <div style={styles.playerWrapper}>
              <div style={styles.playerTopBar}>
                <button style={styles.backBtn} onClick={() => setSelectedVod(null)}>
                  <ArrowLeft size={20} />
                </button>
                <div style={styles.playerTitleBlock}>
                  <h2 style={styles.playerTitle}>{t("AI Analysis")}</h2>
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
    // El rail no tapa el fondo: lo filtra. Su degradado va perdiendo opacidad
    // hacia abajo, así que el lavado de color de la ventana se le ve por debajo
    // y el rail no parte la pantalla en dos bloques planos.
    background: "var(--rail)",
    backdropFilter: "var(--glass-blur)",
    borderRight: "1px solid var(--glass-line-soft)",
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
    background: "transparent",
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
    background: "transparent",
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
