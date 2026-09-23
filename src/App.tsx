import React, { useMemo, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useGallery } from "./features/gallery/useGallery";
import { MatchGallery } from "./features/gallery/components/MatchGallery";
import { ClipsGallery } from "./features/gallery/components/ClipsGallery";
import { PatternsPanel } from "./features/patterns/components/PatternsPanel";
import { PlaylistBar } from "./features/patterns/components/PlaylistBar";
import { HomePanel } from "./features/home/components/HomePanel";
import { ErrorsGallery } from "./features/gallery/components/ErrorsGallery";
import { VodGallery } from "./features/vod/components/VodGallery";
import { VideoPlayer } from "./features/player/components/VideoPlayer";
import { ErrorPlayer } from "./features/player/components/ErrorPlayer";
import { SettingsPanel } from "./features/settings/components/SettingsPanel";
import { TrainingPanel } from "./features/training/components/TrainingPanel";
import { Titlebar } from "./components/Titlebar";
import { Settings2, Library, Film, TriangleAlert, ScanSearch, Target, ChartNoAxesColumn, CircleDot } from "lucide-react";
import { RiotKeyBanner } from "./components/RiotKeyBanner";
import { CaptureStatus } from "./components/CaptureStatus";
import { RailProfile } from "./components/RailProfile";
import { CommandPalette } from "./components/CommandPalette";
import { isReviewed } from "./core/review";
import { OnboardingWizard } from "./features/onboarding/components/OnboardingWizard";
import { useOnboarding } from "./features/onboarding/useOnboarding";
import { getVersion } from "@tauri-apps/api/app";
import {
  getPendingUpdate,
  installPendingUpdate,
  onUpdateProgress,
  onUpdateReady,
  type PendingUpdate,
  type UpdateProgress,
} from "./core/updates";
import { useAppStore, useErrorClips } from "./store/useAppStore";
import { useT } from "./core/LanguageProvider";

type Tab = "home" | "clips" | "errors" | "review" | "patterns" | "vod" | "training" | "settings";

type Panel = "/home" | "/review" | "/clips" | "/errors" | "/patterns" | "/vod" | "/training" | "/settings";

// Un icono por sección y ninguno repetido: antes "Clips" y "VOD Analysis"
// compartían el mismo `Film`, que es lo que obliga a leer la etiqueta para saber
// dónde estás. Trazo de 1.8 y 18px en todos, para que pesen igual entre sí.
const NAV_ICON = { size: 18, strokeWidth: 1.8 } as const;

type NavItem = { key: Tab; path: string; label: string; icon: React.ReactNode };

// El rail va en tres grupos, por lo que haces y no por tipo de fichero:
// revisar (lo de cada partida), mejorar (lo que agrega partidas) y
// herramientas. El pie del rail es la tarjeta de perfil (rango, LP, puesto,
// región); el estado de captura subió a la barra de título, donde se ve
// también con el reproductor abierto.
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Reviewing",
    items: [
      { key: "home", path: "/home", label: "Today", icon: <CircleDot {...NAV_ICON} /> },
      { key: "review", path: "/review", label: "Library", icon: <Library {...NAV_ICON} /> },
      { key: "clips", path: "/clips", label: "Clips", icon: <Film {...NAV_ICON} /> },
      { key: "errors", path: "/errors", label: "Errors", icon: <TriangleAlert {...NAV_ICON} /> },
    ],
  },
  {
    label: "Improving",
    items: [
      // La unica seccion que mira mas de una partida a la vez.
      { key: "patterns", path: "/patterns", label: "Patterns", icon: <ChartNoAxesColumn {...NAV_ICON} /> },
      { key: "training", path: "/training", label: "Training", icon: <Target {...NAV_ICON} /> },
    ],
  },
  {
    label: "Tools",
    items: [
      // "Analysis" a secas se confundia con el analisis de una partida grabada.
      { key: "vod", path: "/vod", label: "Video analysis", icon: <ScanSearch {...NAV_ICON} /> },
      { key: "settings", path: "/settings", label: "Settings", icon: <Settings2 {...NAV_ICON} /> },
    ],
  },
];
const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export const App: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [appVersion, setAppVersion] = useState<string>("");
  // Actualización ya descargada por detrás. El aviso vive aquí, junto a la
  // versión, y no en un modal: no interrumpe, solo deja de decir "v1.2.11".
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate | null>(null);
  // Progreso de la descarga en segundo plano, para que la actualización se VEA
  // llegar en vez de aparecer de golpe como "lista".
  const [updProgress, setUpdProgress] = useState<UpdateProgress | null>(null);
  const [installing, setInstalling] = useState(false);
  const t = useT();

  // El asistente de primer arranque. Se decide arriba del todo porque tapa la
  // app entera: mientras `done` es null (la config aún no ha llegado) NO se
  // enseña nada, para no parpadear en cada arranque.
  const onboarding = useOnboarding();

  const selectedError = useAppStore(state => state.selectedError);
  const setSelectedError = useAppStore(state => state.setSelectedError);
  const selectedVod = useAppStore(state => state.selectedVod);
  const setSelectedVod = useAppStore(state => state.setSelectedVod);
  const refreshErrorClips = useAppStore(state => state.refreshErrorClips);
  const { clips: errorClips } = useErrorClips();

  // La paleta de comandos: Ctrl K (Cmd K en Mac) desde cualquier sitio, y el
  // buscador de la barra de título. Durante el asistente de primer arranque no
  // hay nada que buscar.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const onboardingPending = onboarding.done === false;
  React.useEffect(() => {
    if (onboardingPending) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onboardingPending]);

  React.useEffect(() => {
    getVersion().then(setAppVersion).catch(console.error);
    // Puede haberse descargado antes de montar este componente (o en otra
    // sesión de la ventana), así que se pregunta además de escuchar.
    getPendingUpdate().then(setPendingUpdate).catch(() => {});
    const stop = onUpdateReady((u) => {
      setPendingUpdate(u);
      setUpdProgress(null);
    });
    const stopProg = onUpdateProgress(setUpdProgress);
    // Los dos listeners se desmontan. El de progreso se estaba tirando a `void`,
    // así que en StrictMode (que monta, desmonta y vuelve a montar) quedaba uno
    // huérfano por cada montaje escribiendo en un estado ya muerto.
    return () => {
      stop.then((f) => f()).catch(() => {});
      stopProg.then((f) => f()).catch(() => {});
    };
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
    error: matchesError,
    refreshMatches,
    deleteMatch,
    deleteMatches
  } = useGallery();

  const goTo = (path: string) => {
    navigate(path);
  };

  // Partidas por revisar, junto a «Biblioteca». La MISMA cuenta que «Hoy» y el
  // filtro de la biblioteca (`core/review.ts`): partidas propias —sin VODs
  // importados— sin la cola de momentos tachada ni notas.
  const toReview = useMemo(
    () => matches.filter((m) => !m.is_vod && !isReviewed(m, errorClips)).length,
    [matches, errorClips]
  );

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
  const [mountedPanels, setMountedPanels] = useState<Set<Panel>>(() => new Set());
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

  // Primer arranque: en lugar de los paneles, el asistente. La barra de título
  // sigue puesta (hay que poder mover y cerrar la ventana), y al terminar se
  // guarda `onboarding_done` y aparece la app ya configurada.
  if (onboarding.done === false) {
    return (
      <>
        <Titlebar />
        <OnboardingWizard onDone={() => { onboarding.finish().catch(console.error); }} />
      </>
    );
  }

  // Con una partida abierta en el reproductor el rail se pliega a iconos: el
  // vídeo necesita el ancho, y la navegación sigue a un clic.
  const playerOpen =
    (activePanel === "/review" && !!selectedMatch) ||
    (activePanel === "/vod" && !!selectedVod) ||
    (activePanel === "/errors" && !!selectedError);

  return (
    <>
      <Titlebar
        onSearch={() => setPaletteOpen(true)}
        status={<CaptureStatus isRecording={isRecording} />}
      />
      <div className="app-body" style={styles.appContainer}>
      {/* Rail. La marca se fue a la barra de título: aquí empieza la
          navegación. */}
      <nav className={`rail${playerOpen ? " rail--collapsed" : ""}`} aria-label={t("Sections")}>
        <div className="rail__nav">
          {NAV_GROUPS.map((group) => (
            <React.Fragment key={group.label}>
              <div className="nav-grp" aria-hidden={playerOpen ? true : undefined}>{t(group.label)}</div>
              {group.items.map((item) => {
                const activo = activeTabKey === item.key;
                const cuenta = item.key === "review" && toReview > 0 ? toReview : 0;
                const label = t(item.label);
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => goTo(item.path)}
                    className={`nav-btn${activo ? " nav-btn--active" : ""}`}
                    aria-current={activo ? "page" : undefined}
                    aria-label={cuenta ? `${label} · ${t("{n} to review", { n: cuenta })}` : label}
                    title={playerOpen ? label : undefined}
                  >
                    {item.icon}
                    <span className="nav-btn__label">{label}</span>
                    {cuenta > 0 && (
                      <span className="nav-btn__count" aria-hidden="true">{cuenta}</span>
                    )}
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </div>

        <RailProfile collapsed={playerOpen} />
        {pendingUpdate ? (
          <button
            className="updpill updpill--lista"
            onClick={async () => {
              // En Windows esto no vuelve: el instalador toma el relevo y la
              // /R del NSIS relanza la app sola. El velo cubre ese tránsito —
              // y se le dan unos segundos de escena ANTES de lanzar el
              // instalador, porque el cierre real es tan rápido que sin la
              // pausa el velo ni se ve y el reinicio parece un crash.
              setInstalling(true);
              await new Promise((r) => setTimeout(r, 4500));
              try {
                await installPendingUpdate();
              } catch (e) {
                console.error(e);
                setInstalling(false);
              }
            }}
            title={t("Downloaded and ready. One click: it installs and the app comes back by itself.")}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span className="updpill__dot" />
              {t("Install v{v}", { v: pendingUpdate.version })}
            </span>
          </button>
        ) : updProgress ? (
          <div className="updpill" style={{ cursor: "default" }} title={t("Downloading in the background. You can keep using the app.")}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span className="updpill__dot" />
              <span>v{updProgress.version} · {updProgress.percent}%</span>
            </div>
            <div className="updpill__track">
              <div className="updpill__fill" style={{ width: `${updProgress.percent}%` }} />
            </div>
          </div>
        ) : appVersion ? (
          <div className="rail-version">v{appVersion}</div>
        ) : null}
      </nav>

      {/* Main Content Area */}
      <div style={styles.mainContent}>
        <RiotKeyBanner />
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
              {/* La cabecera (campeón, resultado, clip y error) la pinta el
                  propio reproductor: es quien sabe la duración real del vídeo
                  y tiene el recortador a mano. */}
              <VideoPlayer match={selectedVod} onBack={() => setSelectedVod(null)} />
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
              // Era `() => {}`, así que guardar una nota no refrescaba nada: la
              // nota estaba en disco y en pantalla seguía sin aparecer. Ahora
              // relee los errores al store, que además vuelve a apuntar el clip
              // abierto a su versión fresca.
              onUpdate={() => { refreshErrorClips().catch(console.error); }}
              onClose={() => setSelectedError(null)}
            />
          ) : (
            <ErrorsGallery onSelectError={setSelectedError} />
          )
        )}

        {panel(
          "/review",
          <>
            {selectedMatch && (
              <div style={styles.playerWrapper}>
                <VideoPlayer match={selectedMatch} onBack={() => setSelectedMatch(null)} />
              </div>
            )}
            {/* La galería NO se desmonta al abrir una partida: se oculta, igual
                que las rutas. Montarla de cero al volver hacía que el
                virtualizador recolocara todo desde una estimación (fichas
                pisándose unas a otras un instante) y perdía el scroll. Oculta,
                su ResizeObserver ya sabe remedir al reaparecer. */}
            <div
              style={{
                display: selectedMatch ? "none" : "flex",
                flexDirection: "column",
                flex: 1,
                minHeight: 0,
              }}
            >
              <MatchGallery
                matches={matches}
                onSelectMatch={setSelectedMatch}
                onDeleteMatch={deleteMatch}
                onDeleteMatches={deleteMatches}
                isRecording={isRecording}
                loadError={matchesError}
                onRetry={refreshMatches}
              />
            </div>
          </>
        )}

        {/* Lista de reproducción entre partidas ("las 11 muertes seguidas"),
            flotando abajo sobre el reproductor. La pinta Patrones; aquí solo
            se le da el sitio. Sin lista activa no pinta nada, y el hueco no
            se come los clics del vídeo. */}
        <div className="playlist-dock">
          <PlaylistBar />
        </div>
      </div>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />

      {/* El tránsito de la actualización: el instalador cierra este proceso y
          la app vuelve sola en unos segundos. Sin el velo eso se lee como un
          cierre inesperado; con él, como una continuación. */}
      {installing && (
        <div className="upd-veil">
          <div className="spinner" />
          <div style={{ marginTop: 14, fontWeight: 500 }}>
            {t("Installing v{v}…", { v: pendingUpdate?.version ?? "" })}
          </div>
          <div className="u-meta" style={{ marginTop: 6 }}>
            {t("The app restarts by itself in a few seconds.")}
          </div>
        </div>
      )}
    </>
  );
};

const styles: Record<string, React.CSSProperties> = {
  appContainer: {
    boxSizing: "border-box",
    backgroundColor: "var(--bg-app)",
  },
  mainContent: {
    // Relativo: es el marco de la lista de reproducción flotante.
    position: "relative",
    flex: 1,
    minWidth: 0,
    height: "100%",
    overflow: "hidden",
    boxSizing: "border-box",
    background: "transparent",
    display: "flex",
    flexDirection: "column",
  },
  // El reproductor pinta su propia cabecera (ver VideoPlayer.tsx); aquí sólo
  // queda el marco que lo hace ocupar la pantalla entera.
  playerWrapper: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    width: "100%",
    minHeight: 0,
  },
};
