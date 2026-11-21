import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useNavigate } from "./core/navegar";
import { useGallery } from "./features/gallery/useGallery";
import { PlaylistBar } from "./features/patterns/components/PlaylistBar";
import { HomePanel } from "./features/home/components/HomePanel";
import { Titlebar } from "./components/Titlebar";
import { BrandMark } from "./components/BrandMark";
import { PanelActiveContext, TitleOff, TitleSlotContext } from "./components/ScreenTitle";
import { Settings2, Library, Film, TriangleAlert, ScanSearch, Target, ChartNoAxesColumn, CircleDot, GraduationCap, Swords, Route as RouteIcon } from "lucide-react";
import { RiotKeyBanner } from "./components/RiotKeyBanner";
import { CaptureStatus } from "./components/CaptureStatus";
import { RailProfile } from "./components/RailProfile";
import { CommandPalette } from "./components/CommandPalette";
import { PostGameFlow } from "./components/PostGameFlow";
import { ChampSelectFlow, CHAMP_SELECT_PATH } from "./components/ChampSelectFlow";
import { useChampSelect } from "./core/useChampSelect";
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
import { perezoso, precargarEnReposo } from "./core/perezoso";

// Las pantallas que no se ven al arrancar van en su propio trozo de JS (ver
// core/perezoso.tsx). Hoy, el raíl y la barra van en el principal.
const MatchGallery = perezoso(() => import("./features/gallery/components/MatchGallery").then((m) => m.MatchGallery));
const ClipsGallery = perezoso(() => import("./features/gallery/components/ClipsGallery").then((m) => m.ClipsGallery));
const PatternsPanel = perezoso(() => import("./features/patterns/components/PatternsPanel").then((m) => m.PatternsPanel));
const ErrorsGallery = perezoso(() => import("./features/gallery/components/ErrorsGallery").then((m) => m.ErrorsGallery));
const VodGallery = perezoso(() => import("./features/vod/components/VodGallery").then((m) => m.VodGallery));
const VideoPlayer = perezoso(() => import("./features/player/components/VideoPlayer").then((m) => m.VideoPlayer));
const ErrorPlayer = perezoso(() => import("./features/player/components/ErrorPlayer").then((m) => m.ErrorPlayer));
const SettingsPanel = perezoso(() => import("./features/settings/components/SettingsPanel").then((m) => m.SettingsPanel));
const TrainingPanel = perezoso(() => import("./features/training/components/TrainingPanel").then((m) => m.TrainingPanel));
const CoachPanel = perezoso(() => import("./features/coach/components/CoachPanel").then((m) => m.CoachPanel));
const ChampSelectPanel = perezoso(() => import("./features/champselect/components/ChampSelectPanel").then((m) => m.ChampSelectPanel));
const ClearsPanel = perezoso(() => import("./features/clears/components/ClearsPanel").then((m) => m.ClearsPanel));
const OnboardingWizard = perezoso(() => import("./features/onboarding/components/OnboardingWizard").then((m) => m.OnboardingWizard));

/** Qué trozo necesita cada sección del raíl, para precargarlo al pasar por encima. */
const TROZOS: Record<string, Array<{ precargar: () => Promise<unknown> }>> = {
  "/review": [MatchGallery, VideoPlayer],
  "/clips": [ClipsGallery],
  "/errors": [ErrorsGallery, ErrorPlayer],
  "/patterns": [PatternsPanel],
  "/coach": [CoachPanel],
  "/vod": [VodGallery, VideoPlayer],
  "/training": [TrainingPanel],
  "/settings": [SettingsPanel],
  "/champ-select": [ChampSelectPanel],
  "/clears": [ClearsPanel],
};
import { useAppStore } from "./store/useAppStore";
import { useT } from "./core/LanguageProvider";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { originOf, setNavOrigin, type NavOrigin } from "./core/navOrigin";
import { useEntradaPrimeraVez } from "./core/movimiento";
import { BootSplash } from "./components/BootSplash";

import { withPercent } from "./core/benchmarkFormat";
import { jungleRoutesOnce } from "./features/player/components/matchMoves";
type Tab = "home" | "clips" | "errors" | "review" | "coach" | "patterns" | "vod" | "training" | "clears" | "settings";

type Panel = "/home" | "/review" | "/clips" | "/errors" | "/coach" | "/patterns" | "/vod" | "/training" | "/clears" | "/settings" | "/champ-select";

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
      // El plan de 10 partidas: primero, porque es lo que te dice qué mejorar.
      { key: "coach", path: "/coach", label: "Coach", icon: <GraduationCap {...NAV_ICON} /> },
      { key: "patterns", path: "/patterns", label: "Patterns", icon: <ChartNoAxesColumn {...NAV_ICON} /> },
      { key: "training", path: "/training", label: "Training", icon: <Target {...NAV_ICON} /> },
      // El primer clear récord de cada campeón, de la hoja comunitaria.
      { key: "clears", path: "/clears", label: "Clears", icon: <RouteIcon {...NAV_ICON} /> },
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

// La selección de campeón solo está en el rail mientras dura (o mientras se
// mira lo que quedó de ella): fuera de ahí no tiene nada que enseñar.
const CHAMP_SELECT_ITEM = {
  path: CHAMP_SELECT_PATH,
  label: "Champ select",
  icon: <Swords {...NAV_ICON} />,
};

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
  // A · el hueco de la barra de título donde cada pantalla pinta su título.
  const [titleSlot, setTitleSlot] = useState<HTMLDivElement | null>(null);
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

  // La paleta de comandos: Ctrl K (Cmd K en Mac) desde cualquier sitio, y el
  // buscador de la barra de título. Durante el asistente de primer arranque no
  // hay nada que buscar.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Cómo se abrió: con el teclado no se anima el panel, solo el velo.
  const [paletteBy, setPaletteBy] = useState<NavOrigin>("kbd");
  const openPalette = (origin: NavOrigin) => {
    setPaletteBy(origin);
    setPaletteOpen(true);
  };
  const onboardingPending = onboarding.done === false;
  React.useEffect(() => {
    if (onboardingPending) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteBy("kbd");
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
  const { view: champSelect } = useChampSelect();
  const onChampSelect = currentPath.startsWith(CHAMP_SELECT_PATH);

  // "/games" era una segunda entrada al mismo panel que "/review"; se quitó del menú, pero la
  // ruta se redirige para no romper el estado de navegación guardado de versiones anteriores.
  React.useEffect(() => {
    if (currentPath === "/" || currentPath.startsWith("/games")) {
      navigate("/home", { replace: true });
    }
  }, [currentPath, navigate]);

  // Las rutas de jungla de todas las partidas tardan en leerse y las espera
  // «Lo que decidió la partida» (la mediana del primer clear). Se adelantan en
  // segundo plano la primera vez que se entra donde se van a usar; luego
  // quedan para toda la sesión (jungleRoutesOnce).
  React.useEffect(() => {
    if (currentPath !== "/review" && currentPath !== "/patterns") return;
    const id = window.setTimeout(() => jungleRoutesOnce().catch(() => {}), 400);
    return () => window.clearTimeout(id);
  }, [currentPath]);

  const {
    matches,
    selectedMatch,
    setSelectedMatch,
    isRecording,
    isLoading: matchesLoading,
    error: matchesError,
    refreshMatches,
    deleteMatch,
    deleteMatches
  } = useGallery();
  // La PRIMERA lectura de la biblioteca: mientras dura, Hoy y la Biblioteca
  // enseñan su esqueleto y nunca el «Juega una partida». Los refrescos de
  // después (tras borrar, al acabar una partida) ya tienen lista que enseñar.
  const matchesLoaded = useAppStore(state => state.matchesLoaded);
  const firstLoad = matchesLoading && !matchesLoaded;
  // La bienvenida del arranque (BootSplash): mientras está, las pantallas no
  // hacen su entrada escalonada, que pasaría debajo sin verse; la hacen al irse.
  const [splash, setSplash] = useState(true);
  /** La bienvenida ya se está yendo: la pantalla de debajo entra a la vez. */
  const [splashSaliendo, setSplashSaliendo] = useState(false);

  // La píldora del raíl. Antes era un `layoutId` de framer-motion, que mide el
  // layout de la página al montar (~30 ms en el arranque, medido) y metía
  // framer en el paquete principal. Ahora es un solo elemento que se mueve con
  // `transform` (lo anima el compositor, sin JS por fotograma) hasta el botón
  // activo; la curva de muelle sin rebote está en CSS (`.rail__pill`).
  const railNavRef = useRef<HTMLDivElement>(null);
  const pildoraRef = useRef<HTMLSpanElement>(null);
  const pildoraColocada = useRef(false);
  const colocarPildora = useCallback((animar: boolean) => {
    const nav = railNavRef.current;
    const pildora = pildoraRef.current;
    if (!nav || !pildora) return;
    const activo = nav.querySelector<HTMLElement>(".nav-btn--active");
    if (!activo) {
      pildora.style.opacity = "0";
      return;
    }
    // La primera vez (y al cambiar el tamaño del raíl) aparece en su sitio,
    // sin viajar desde la esquina.
    pildora.style.transition = animar && pildoraColocada.current ? "" : "none";
    pildora.style.width = `${activo.offsetWidth}px`;
    pildora.style.height = `${activo.offsetHeight}px`;
    pildora.style.transform = `translate3d(${activo.offsetLeft}px, ${activo.offsetTop}px, 0)`;
    pildora.style.opacity = "1";
    pildoraColocada.current = true;
  }, []);
  const goTo = (path: string, origin: NavOrigin = "ptr") => {
    setNavOrigin(origin);
    navigate(path);
  };

  const matchedNav = NAV_ITEMS.find(n => currentPath.startsWith(n.path));
  const activeTabKey: string = matchedNav
    ? matchedNav.key
    : currentPath.startsWith("/settings")
      ? "settings"
      : onChampSelect
        ? "champ-select"
        : "home";

  const activePanel: Panel =
    currentPath.startsWith("/settings")
      ? "/settings"
      : onChampSelect
        ? "/champ-select"
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
  // El cambio de pantalla lo anima una View Transition (core/navegar.ts). La
  // primera vez que se ve, además, sus bloques entran escalonados (`Shown`,
  // core/movimiento.ts). Con el teclado no se anima nada.
  // El contenido de cada pantalla, memorizado. App se vuelve a pintar en cada
  // navegación (cambia la ruta) y, con los elementos creados de nuevo, React
  // volvía a pintar TODAS las pantallas ya montadas: 23 ms medidos en cada
  // cambio, con la pantalla congelada mientras tanto. Con el mismo elemento,
  // React se las salta.
  const cSettings = useMemo(() => <SettingsPanel />, []);
  const cTraining = useMemo(() => <TrainingPanel />, []);
  const cClips = useMemo(() => <ClipsGallery />, []);
  const cPatterns = useMemo(() => <PatternsPanel />, []);
  const cCoach = useMemo(() => <CoachPanel />, []);
  const cChamp = useMemo(() => <ChampSelectPanel />, []);
  const cClears = useMemo(() => <ClearsPanel />, []);
  const cHome = useMemo(
    () => (
      <HomePanel
        matches={matches}
        loading={firstLoad}
        isRecording={isRecording}
        onOpenMatch={(m) => { setSelectedMatch(m); navigate("/review"); }}
        onGoTraining={() => navigate("/training")}
      />
    ),
    [matches, firstLoad, isRecording, setSelectedMatch, navigate]
  );
  const cVod = useMemo(
    () =>
      selectedVod ? (
        <div style={styles.playerWrapper}>
          {/* La cabecera (campeón, resultado, clip y error) la pinta el
              propio reproductor: es quien sabe la duración real del vídeo
              y tiene el recortador a mano. */}
          <VideoPlayer match={selectedVod} onBack={() => setSelectedVod(null)} backLabel={t("Video analysis")} />
        </div>
      ) : (
        <VodGallery onSelectMatch={setSelectedVod} />
      ),
    [selectedVod, setSelectedVod, t]
  );
  const cErrors = useMemo(
    () =>
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
      ),
    [selectedError, refreshErrorClips, setSelectedError]
  );
  // La Biblioteca, aparte: abrir o cerrar una partida no le cambia nada y
  // antes se volvía a pintar entera dentro de la transición (medido).
  const galeria = useMemo(
    () => (
      <MatchGallery
        matches={matches}
        loading={firstLoad}
        onSelectMatch={setSelectedMatch}
        onDeleteMatch={deleteMatch}
        onDeleteMatches={deleteMatches}
        loadError={matchesError}
        onRetry={refreshMatches}
      />
    ),
    [matches, firstLoad, setSelectedMatch, deleteMatch, deleteMatches, matchesError, refreshMatches]
  );
  const cReview = useMemo(
    () => (
      <>
        {selectedMatch && (
          <div style={styles.playerWrapper}>
            <VideoPlayer match={selectedMatch} onBack={() => setSelectedMatch(null)} backLabel={t("Library")} />
          </div>
        )}
        {/* La galería NO se desmonta al abrir una partida: se oculta, igual
            que las rutas. Montarla de cero al volver hacía que el
            virtualizador recolocara todo desde una estimación (fichas
            pisándose unas a otras un instante) y perdía el scroll. Oculta,
            su ResizeObserver ya sabe remedir al reaparecer. */}
        <Shown
          when={!selectedMatch}
          skipInitial
          fundirAlVolver
          style={{
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
          }}
        >
          <TitleOff off={selectedMatch != null}>{galeria}</TitleOff>
        </Shown>
      </>
    ),
    [selectedMatch, setSelectedMatch, t, galeria]
  );

  const panel = (path: Panel, content: React.ReactNode) => {
    const active = activePanel === path;
    return (
      <Shown
        key={path}
        when={active}
        ready={mountedPanels.has(path) && (!splash || splashSaliendo)}
        style={{
          width: "100%",
          height: "100%",
          flexDirection: "column",
        }}
      >
        {/* Cada panel con su red: si uno revienta al pintar, cae solo él y
            la barra de título y el rail siguen ahí. */}
        {mountedPanels.has(path) ? (
          <ErrorBoundary name={t([...NAV_ITEMS, CHAMP_SELECT_ITEM].find((n) => n.path === path)?.label ?? "Section")}>
            {/* Solo la pantalla visible pinta su título en la barra. */}
            <PanelActiveContext.Provider value={active}>{content}</PanelActiveContext.Provider>
          </ErrorBoundary>
        ) : null}
      </Shown>
    );
  };

  // La píldora sigue a la sección activa (ver `colocarPildora`). Antes del
  // `return` del asistente: los hooks no pueden ir detrás de un return
  // condicional.
  useLayoutEffect(() => {
    colocarPildora(true);
  }, [activeTabKey, onChampSelect, champSelect, colocarPildora, onboarding.done]);
  useEffect(() => {
    const nav = railNavRef.current;
    if (!nav || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => colocarPildora(false));
    ro.observe(nav);
    return () => ro.disconnect();
    // Tras el asistente aparece el raíl: hay que engancharse a él entonces.
  }, [colocarPildora, onboarding.done]);

  // Primer arranque: en lugar de los paneles, el asistente. La barra de título
  // sigue puesta (hay que poder mover y cerrar la ventana), y al terminar se
  // guarda `onboarding_done` y aparece la app ya configurada.
  if (onboarding.done === false) {
    return (
      <>
        <Titlebar brand />
        <OnboardingWizard onDone={() => { onboarding.finish().catch(console.error); }} />
      </>
    );
  }


  return (
    <TitleSlotContext.Provider value={titleSlot}>
      {splash && (
        <BootSplash
          ready={matchesLoaded || !!matchesError}
          games={matches.length}
          onLeaving={() => setSplashSaliendo(true)}
          onGone={() => {
            performance.mark("wl:bienvenida-fuera");
            setSplash(false);
            // Con Hoy ya a la vista y su entrada en marcha, el resto de
            // pantallas se cargan en ratos ociosos: la primera visita no espera.
            precargarEnReposo([MatchGallery, VideoPlayer, PatternsPanel, CoachPanel, ErrorsGallery, ErrorPlayer, ClipsGallery, SettingsPanel, TrainingPanel, VodGallery, ChampSelectPanel, ClearsPanel]);
          }}
        />
      )}
      <div className="app-body" style={styles.appContainer}>
      {/* Raíl de A: sube hasta arriba con la marca y solo lleva iconos, siempre
          (ya no se pliega con el reproductor: mide lo mismo que plegado). El
          nombre de cada sección sale al pasar el ratón o con el teclado. */}
      <nav className="rail" aria-label={t("Sections")}>
        <div className="rail__brand" data-tauri-drag-region>
          <BrandMark size={30} />
        </div>
        <div className="rail__nav" ref={railNavRef}>
          {/* El círculo de la sección activa: uno solo que se desplaza hasta el
              botón activo (ver `colocarPildora`). */}
          <span ref={pildoraRef} className="rail__pill" aria-hidden="true" />
          {(!!champSelect || onChampSelect) && (
            <>
              <div className="nav-grp" aria-hidden="true">{t("Now")}</div>
              <button
                type="button"
                onClick={(e) => goTo(CHAMP_SELECT_ITEM.path, originOf(e))}
                className={`nav-btn${onChampSelect ? " nav-btn--active" : ""}`}
                aria-current={onChampSelect ? "page" : undefined}
                aria-label={t(CHAMP_SELECT_ITEM.label)}
              >
                {CHAMP_SELECT_ITEM.icon}
                <span className="nav-btn__label">{t(CHAMP_SELECT_ITEM.label)}</span>
                {!!champSelect && <span className="nav-btn__live" aria-hidden="true" />}
              </button>
            </>
          )}
          {NAV_GROUPS.map((group) => (
            <React.Fragment key={group.label}>
              <div className="nav-grp" aria-hidden="true">{t(group.label)}</div>
              {group.items.map((item) => {
                const activo = activeTabKey === item.key;
                const label = t(item.label);
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={(e) => goTo(item.path, originOf(e))}
                    onPointerEnter={() => TROZOS[item.path]?.forEach((x) => { x.precargar().catch(() => {}); })}
                    className={`nav-btn${activo ? " nav-btn--active" : ""}`}
                    aria-current={activo ? "page" : undefined}
                    aria-label={label}
                  >
                    {item.icon}
                    <span className="nav-btn__label">{label}</span>
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </div>

        <RailProfile collapsed />
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
              <span>v{updProgress.version} · {withPercent(updProgress.percent)}</span>
            </div>
            <div className="updpill__track">
              <div className="updpill__fill" style={{ "--p": updProgress.percent / 100 } as React.CSSProperties} />
            </div>
          </div>
        ) : appVersion ? (
          <div className="rail-version">v{appVersion}</div>
        ) : null}
      </nav>

      {/* A la derecha del raíl: la barra de título y, debajo, el contenido,
          marcado como región principal (los lectores de pantalla saltan a él
          desde el raíl). */}
      <div className="app-col">
      <Titlebar
        onSearch={openPalette}
        status={<CaptureStatus isRecording={isRecording} />}
        slotRef={setTitleSlot}
      />
      <main className="app-main" style={styles.mainContent}>
        <RiotKeyBanner />
        {panel("/settings", cSettings)}

        {panel("/training", cTraining)}

        {panel("/clips", cClips)}
        {panel("/patterns", cPatterns)}
        {panel("/coach", cCoach)}
        {panel("/champ-select", cChamp)}
        {panel("/clears", cClears)}

        {panel("/home", cHome)}

        {panel("/vod", cVod)}

        {panel("/errors", cErrors)}

        {panel("/review", cReview)}

        {/* Lista de reproducción entre partidas ("las 11 muertes seguidas"),
            flotando abajo sobre el reproductor. La pinta Patrones; aquí solo
            se le da el sitio. Sin lista activa no pinta nada, y el hueco no
            se come los clics del vídeo. */}
        <div className="playlist-dock">
          <PlaylistBar />
        </div>
      </main>
      </div>
      </div>

      <CommandPalette open={paletteOpen} openedBy={paletteBy} onClose={() => setPaletteOpen(false)} />

      {/* Fin de partida: aviso, atención en la barra de tareas y la partida
          abierta cuando Riot la tiene analizada. Fuera del asistente de primer
          arranque: ahí no hay a dónde llevar a nadie. */}
      <PostGameFlow />

      {/* Entrada en la selección de campeón: la app delante sin quitar el
          foco y la pantalla de la selección abierta, salvo que estés con otra
          cosa. Solo en la ventana de la app: nunca en el juego. */}
      <ChampSelectFlow />

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
    </TitleSlotContext.Provider>
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
    // Lo que anima la View Transition al cambiar de pantalla (index.css).
    viewTransitionName: "pantalla",
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

/**
 * Una caja que se oculta con `display: none` (sin desmontar lo de dentro) y
 * que, la PRIMERA vez que se ve, hace entrar sus bloques escalonados. Al
 * volver, solo la transición de pantalla: lo que se ve decenas de veces al
 * día no hace esperar. Es el envoltorio de cada pantalla y el de la
 * Biblioteca bajo el reproductor. `ready` espera a que el contenido exista:
 * la primera visita a una pantalla lo monta un render después de enseñarla.
 */
const Shown: React.FC<{
  when: boolean;
  ready?: boolean;
  /** No animar la primera vez: si lo de fuera ya entra con ella (la
   *  Biblioteca dentro de su pantalla), se sumarían las dos entradas. */
  skipInitial?: boolean;
  /** Fundido corto cada vez que vuelve a verse (la Biblioteca al cerrar el
   *  reproductor: mientras, el retrato vuelve volando a su fila). */
  fundirAlVolver?: boolean;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ when, ready = true, skipInitial = false, fundirAlVolver = false, style, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEntradaPrimeraVez(ref, when && ready, { saltarPrimera: skipInitial });
  const antes = useRef(when);
  useLayoutEffect(() => {
    const volvio = when && !antes.current;
    antes.current = when;
    if (!volvio || !fundirAlVolver || document.documentElement.dataset.nav === "kbd") return;
    ref.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "backwards" });
  }, [when, fundirAlVolver]);
  return (
    <div ref={ref} style={{ ...style, display: when ? "flex" : "none" }}>
      {children}
    </div>
  );
};
