import React, { useState, useEffect } from "react";
import { getRecorderStatus, startManualRecording, stopManualRecording, getAudioStatus, getVideoSettings, setVideoSettings, getAppConfig, setAppConfig, checkRiotKey, getDiskUsage, getHotkeys, setHotkeys, exportBackup, importBackup, AppConfig, type DiskSpaceInfo, type HotkeyConfig, type MaintenanceProgress } from "../../../core/tauri-ipc";
// La lista de regiones se comparte con el asistente de primer arranque.
import { RIOT_PLATFORMS, platformLabel } from "../../../core/riotRegions";
import { AudioStatus, VideoSettings } from "../../../types";
import { Archive, Download, Eye, EyeOff, FolderOpen, RefreshCw, RotateCcw, Upload, Wand2, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { RIOT_DEV_PORTAL } from "../../../components/RiotKeyBanner";
import { useDialog } from "../../../components/ui/DialogProvider";
import { useToast } from "../../../components/ui/Toaster";
import { listen } from "@tauri-apps/api/event";
import { useOnboarding } from "../../onboarding/useOnboarding";
import { useAppStore } from "../../../store/useAppStore";
import { DiskMeter } from "./DiskMeter";
import { HotkeyCapture } from "./HotkeyCapture";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdateNow, getPendingUpdate, installPendingUpdate, onUpdateProgress, onUpdateReady, type PendingUpdate } from "../../../core/updates";
import { useLang } from "../../../core/LanguageProvider";
import { LANGUAGES, type Language } from "../../../core/i18n";

// Mismos límites que aplica el backend (`storage::MIN_STORAGE_GB` y el clamp de
// `set_app_config`). Los dos campos gobiernan borrados de ficheros, así que un 0
// colado por un campo vacío significaría "vacía la biblioteca".
const MIN_STORAGE_GB = 10;
const MAX_STORAGE_GB = 100_000;
const MAX_PRUNE_DAYS = 3650;

/** Los mismos valores de fábrica que el backend (`VideoSettings::default`). */
const VIDEO_DEFAULTS: Required<Pick<VideoSettings, "fps" | "quality">> & {
  resolution: NonNullable<VideoSettings["resolution"]>;
} = { fps: 60, quality: "High", resolution: "native" };

/** Y los de almacenamiento (`AppConfig::default`). La carpeta NO se toca. */
const STORAGE_DEFAULTS = { max_storage_gb: 100, auto_prune_days: 0 };

const clampStorageGb = (raw: string): number => {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return MIN_STORAGE_GB;
  return Math.min(Math.max(n, MIN_STORAGE_GB), MAX_STORAGE_GB);
};

const clampPruneDays = (raw: string): number => {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), MAX_PRUNE_DAYS);
};

/** Escala del minimapa en % (100 = estándar). Misma cota que el backend. */
const clampMinimapPct = (raw: string): number => {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 100;
  return Math.min(Math.max(n, 50), 200);
};

export const SettingsPanel: React.FC = () => {
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [manualId, setManualId] = useState<string>("");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [audio, setAudio] = useState<AudioStatus | null>(null);
  const [audioLoading, setAudioLoading] = useState<boolean>(false);
  const [video, setVideo] = useState<VideoSettings>({ fps: 60, quality: "High" });
  // Atajos globales. Viven en su propio fichero, no en la config de la app.
  const [hotkeys, setHotkeysState] = useState<HotkeyConfig | null>(null);
  // null = todavía no ha llegado del backend. Antes había aquí una config
  // inventada (100 GB, español apagado…) que se pintaba medio segundo y luego
  // saltaba a la de verdad: el usuario veía valores que no eran los suyos.
  const [config, setConfig] = useState<AppConfig | null>(null);
  // Los dos campos numéricos se editan como texto: si se guardara el `Number()` de
  // cada pulsación, vaciar el campo enviaría un 0 al backend. Se acotan al salir.
  const [storageDraft, setStorageDraft] = useState<string>("");
  const [pruneDraft, setPruneDraft] = useState<string>("");
  const [minimapDraft, setMinimapDraft] = useState<string>("");
  const [proxyDraft, setProxyDraft] = useState<string>("");
  // La clave se enseña tapada; el ojo es para comprobar que se pegó entera.
  const [showKey, setShowKey] = useState<boolean>(false);
  // El disco es lo primero que se mira al entrar aqui y no se estaba pidiendo:
  // la cuota se ajustaba a ciegas, sin saber cuanto se lleva usado.
  // Trae también el hueco REAL del volumen: la cuota sola mentía (un disco lleno
  // se leía como "20% usado" mientras la grabadora ya se negaba a grabar).
  const [disk, setDisk] = useState<DiskSpaceInfo | null>(null);
  const [updateMsg, setUpdateMsg] = useState<string>("");
  const [isUpdating, setIsUpdating] = useState<boolean>(false);
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  // El instalador corre en silencio y la app se cierra sola para poder
  // reemplazar su .exe: sin este velo son unos segundos en negro que parecen
  // un cuelgue.
  const [isInstalling, setIsInstalling] = useState<boolean>(false);
  const [appVersion, setAppVersion] = useState<string>("");
  // Lo que el backend ya ha bajado por su cuenta y espera a que digas cuándo.
  const [pending, setPending] = useState<PendingUpdate | null>(null);
  const { showError, showSuccess, showConfirm } = useDialog();
  const { toast } = useToast();
  const { lang, setLang, t } = useLang();
  // El asistente de primer arranque, para poder volver a lanzarlo desde aquí.
  const { restart: restartOnboarding } = useOnboarding();
  // Copia de seguridad: se deshabilitan los botones mientras el zip se escribe
  // o se lee, que puede tardar unos segundos con la biblioteca llena.
  const [backupBusy, setBackupBusy] = useState<"export" | "import" | null>(null);
  /**
   * Mantenimiento de la biblioteca al arrancar (evento `library_maintenance`).
   *
   * Es trabajo que corre solo por detrás y se puede ignorar; se enseña en la
   * tira de estado y en voz baja porque explica por qué la app va lenta el
   * primer minuto tras actualizar, no porque haya que hacer nada.
   */
  const [maint, setMaint] = useState<MaintenanceProgress | null>(null);

  const checkStatus = async () => {
    try {
      const status = await getRecorderStatus();
      setIsRecording(status);
    } catch (err) {
      console.error(err);
    }
  };

  const refreshAudio = async () => {
    setAudioLoading(true);
    try {
      setAudio(await getAudioStatus());
    } catch (err) {
      console.error(err);
    } finally {
      setAudioLoading(false);
    }
  };

  const saveVideo = async (
    fps: number,
    quality: string,
    resolution?: VideoSettings["resolution"]
  ) => {
    try {
      setVideo(await setVideoSettings(fps, quality, resolution));
    } catch (err) {
      console.error(err);
      showError(t("Error: {msg}", { msg: String(err) }));
    }
  };

  /** Refresca el disco. Se llama al entrar y tras cambiar cuota o carpeta. */
  const refreshDisk = () => {
    getDiskUsage().then(setDisk).catch(() => {});
  };

  useEffect(() => {
    checkStatus();
    refreshAudio();
    getVideoSettings().then(setVideo).catch(console.error);
    refreshDisk();
    getHotkeys().then(setHotkeysState).catch(console.error);
    getVersion().then(setAppVersion).catch(console.error);
    getPendingUpdate().then(setPending).catch(() => {});
    getAppConfig()
      .then(c => {
        setConfig(c);
        setStorageDraft(String(c.max_storage_gb));
        setPruneDraft(String(c.auto_prune_days));
        setMinimapDraft(String(Math.round((c.minimap_scale ?? 1) * 100)));
        setProxyDraft(c.riot_proxy_url ?? "");
      })
      .catch(console.error);
    // La descarga la arranca el backend por su cuenta: si ocurre mientras estás
    // mirando esta pantalla, la barra se mueve sin que hayas pulsado nada.
    const stopProgress = onUpdateProgress(({ percent }) => {
      setIsDownloading(percent < 100);
      setDownloadProgress(percent);
      setUpdateMsg(`${t("Downloading…")} ${percent}%`);
    });
    const stopReady = onUpdateReady((u) => {
      setIsDownloading(false);
      setUpdateMsg("");
      setPending(u);
    });
    const interval = setInterval(checkStatus, 2000);
    return () => {
      clearInterval(interval);
      stopProgress.then((f) => f()).catch(() => {});
      stopReady.then((f) => f()).catch(() => {});
    };
  }, []);

  // Estado de la clave de Riot: null = sin comprobar. Existe porque una clave
  // que no se guarda o que no sirve era invisible hasta que fallaba algo mucho
  // despues, con un error que no la señalaba.
  const [keyState, setKeyState] = useState<"saving" | "ok" | "bad" | null>(null);
  const [keyMsg, setKeyMsg] = useState<string>("");

  /**
   * Guarda SOLO lo que se le pasa. El backend recibe un parche, así que ya no
   * hace falta reenviar la config entera — que es como se perdían campos: quien
   * olvidaba uno lo reseteaba sin enterarse.
   */
  const handleSaveConfig = async (patch: Partial<AppConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
    try {
      await setAppConfig(patch);
    } catch (e) {
      // Antes esto era un console.error: el fallo no salia de la consola. Y el
      // backend, encima, se tragaba los errores de escritura y decía que sí.
      showError(t("Error: {msg}", { msg: String(e) }));
      throw e;
    }
  };

  /**
   * Guarda el atajo. El backend es quien decide si la tecla vale: si no la sabe
   * registrar, rechaza y el mensaje sube tal cual al botón de captura.
   */
  const handleSaveHotkey = async (replay: string) => {
    setHotkeysState(await setHotkeys(replay));
  };

  /** Vuelve el vídeo a fábrica: 60 FPS, calidad alta y resolución nativa. */
  const handleResetVideo = async () => {
    const ok = await showConfirm({
      title: t("Reset to defaults"),
      message: t("Video goes back to 60 FPS, High quality and Native resolution."),
      confirmText: t("Reset"),
    });
    if (!ok) return;
    await saveVideo(VIDEO_DEFAULTS.fps, VIDEO_DEFAULTS.quality, VIDEO_DEFAULTS.resolution);
  };

  /**
   * Y el almacenamiento. La carpeta se queda como está a propósito: moverla no
   * es un ajuste que se pueda deshacer solo, porque los vídeos no viajan con
   * ella.
   */
  const handleResetStorage = async () => {
    const ok = await showConfirm({
      title: t("Reset to defaults"),
      message: t("Storage quota goes back to {n} GB and auto-prune is turned off. Your save location is not touched.", { n: STORAGE_DEFAULTS.max_storage_gb }),
      confirmText: t("Reset"),
    });
    if (!ok) return;
    setStorageDraft(String(STORAGE_DEFAULTS.max_storage_gb));
    setPruneDraft(String(STORAGE_DEFAULTS.auto_prune_days));
    await handleSaveConfig({ ...STORAGE_DEFAULTS });
    refreshDisk();
  };

  const handlePickDirectory = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: config?.save_directory || undefined,
    });
    if (selected === null) {
      return;
    } else {
      // Otra carpeta puede ser otro volumen: lo ocupado y lo libre cambian.
      handleSaveConfig({ save_directory: selected as string }).then(refreshDisk).catch(() => {});
    }
  };

  // El mantenimiento de la biblioteca. Al llegar "done" se apaga la línea:
  // dejarla puesta en 140/140 haría creer que sigue trabajando.
  useEffect(() => {
    let vivo = true;
    let quitar: (() => void) | null = null;
    listen<MaintenanceProgress>("library_maintenance", (e) => {
      if (!vivo) return;
      setMaint(e.payload?.phase === "done" ? null : e.payload ?? null);
    })
      .then((f) => { if (vivo) quitar = f; else f(); })
      .catch(console.error);
    return () => { vivo = false; if (quitar) quitar(); };
  }, []);

  /**
   * Escribe el zip donde diga el usuario.
   *
   * No lleva los vídeos: son el 99,9% del peso y se pueden volver a grabar. Lo
   * que no se puede recuperar es lo que escribiste tú.
   */
  const handleExportBackup = async () => {
    const destino = await open({
      directory: true,
      multiple: false,
      title: t("Choose where to save the backup"),
    });
    if (destino === null) return;
    setBackupBusy("export");
    try {
      const zip = await exportBackup(destino as string);
      toast({
        title: t("Backup saved"),
        body: zip,
        tone: "success",
        action: { label: t("Reveal"), onClick: () => { revealItemInDir(zip).catch(() => {}); } },
      });
    } catch (e) {
      showError(t("Couldn't export the backup: {msg}", { msg: String(e) }));
    } finally {
      setBackupBusy(null);
    }
  };

  /** Restaura una copia. Es aditiva: nunca pisa lo que ya tenga contenido. */
  const handleImportBackup = async () => {
    const elegido = await open({
      multiple: false,
      filters: [{ name: "Backup", extensions: ["zip"] }],
      title: t("Pick a backup to restore"),
    });
    if (elegido === null) return;
    const ok = await showConfirm({
      title: t("Restore a backup"),
      message: t("Nothing here is overwritten: only what is missing gets filled in. Games whose video is gone are recreated without it."),
      confirmText: t("Restore"),
      cancelText: t("Cancel"),
    });
    if (!ok) return;
    setBackupBusy("import");
    try {
      const r = await importBackup(elegido as string);
      // La biblioteca se relee: si no, las partidas recién restauradas no
      // aparecen hasta cambiar de pantalla y volver.
      useAppStore.getState().refreshMatches().catch(() => {});
      await showSuccess(
        t("Backup restored. Games completed: {n} · recreated without video: {m} · skipped: {s}", {
          n: r.restored,
          m: r.created_without_video,
          s: r.skipped,
        })
      );
    } catch (e) {
      showError(t("Couldn't import the backup: {msg}", { msg: String(e) }));
    } finally {
      setBackupBusy(null);
    }
  };

  /** Carpeta espejo: cada JSON de partida se copia ahí al guardarlo. */
  const handlePickMirror = async () => {
    const elegido = await open({
      directory: true,
      multiple: false,
      defaultPath: config?.backup_mirror_dir || undefined,
    });
    if (elegido === null) return;
    handleSaveConfig({ backup_mirror_dir: elegido as string }).catch(() => {});
  };

  /**
   * Vuelve a lanzar el asistente de primer arranque.
   *
   * No es un reset: aparece encima de la app con lo que ya está configurado
   * dentro. Se confirma igual porque tapa la pantalla entera y desde fuera
   * parece que la app se ha reiniciado.
   */
  const handleRestartOnboarding = async () => {
    const ok = await showConfirm({
      title: t("Run setup again"),
      message: t("The setup wizard opens over the app, with what you already configured inside. Nothing is deleted."),
      confirmText: t("Run setup"),
      cancelText: t("Cancel"),
    });
    if (!ok) return;
    await restartOnboarding();
  };

  /** Abre la carpeta de grabaciones en el explorador. */
  const handleOpenDirectory = async () => {
    if (!config?.save_directory) return;
    try {
      await revealItemInDir(config.save_directory);
    } catch (e) {
      showError(t("Error: {msg}", { msg: String(e) }));
    }
  };

  const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const riot_api_key = e.target.value;
    setConfig((prev) => (prev ? { ...prev, riot_api_key } : prev));
  };

  // Guarda y, acto seguido, le pregunta a Riot si la clave sirve. Guardar sin
  // comprobar es lo que dejaba al usuario creyendo que estaba lista.
  const handleApiKeyBlur = async () => {
    if (!config?.riot_api_key.trim()) {
      setKeyState(null);
      return;
    }
    setKeyState("saving");
    setKeyMsg("");
    try {
      await handleSaveConfig({ riot_api_key: config.riot_api_key });
      await checkRiotKey();
      setKeyState("ok");
    } catch (e) {
      setKeyState("bad");
      setKeyMsg(String(e).replace(/^Error:\s*/, ""));
    }
  };

  // Sin esto la clave sólo se guardaba al perder el foco: quien la pegaba y salía
  // del panel directo se quedaba sin guardarla, y sin ningún aviso.
  const handleApiKeyKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    }
  };

  const handleStartManual = async () => {
    if (!manualId.trim()) {
      showError(t("Enter an ID or name for the test recording"));
      return;
    }

    setIsProcessing(true);
    setStatusMsg(t("Starting test recording…"));
    try {
      await startManualRecording(manualId.trim());
      setIsRecording(true);
      setStatusMsg(t("Recording in progress. You can use your PC."));
    } catch (err) {
      setStatusMsg(t("Error: {msg}", { msg: String(err) }));
      showError(t("Failed to start: {msg}", { msg: String(err) }));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleStopManual = async () => {
    setIsProcessing(true);
    setStatusMsg(t("Stopping and saving clip…"));
    try {
      await stopManualRecording();
      setIsRecording(false);
      // Decía "la sección Partidas", que ya no existe: ese panel es Biblioteca.
      setStatusMsg(t("Clip saved successfully. Check the Library section."));
      setManualId("");
      showSuccess(t("Clip saved successfully."));
    } catch (err) {
      setStatusMsg(t("Failed to stop: {msg}", { msg: String(err) }));
      showError(t("Failed to stop: {msg}", { msg: String(err) }));
    } finally {
      setIsProcessing(false);
    }
  };

  /** Comprobar a mano. El backend deja el paquete descargado, no lo instala. */
  const checkForUpdates = async () => {
    setIsUpdating(true);
    setUpdateMsg(t("Checking for updates…"));
    try {
      const found = await checkForUpdateNow();
      if (found) {
        setPending(found);
        setUpdateMsg("");
      } else {
        setUpdateMsg(t("Your app is already on the latest version."));
        showSuccess(t("Your app is already up to date."));
      }
    } catch (err) {
      console.error(err);
      setUpdateMsg(t("Failed to check for updates."));
      showError(t("Update error: {msg}", { msg: String(err) }));
    } finally {
      setIsUpdating(false);
      setIsDownloading(false);
    }
  };

  /** Instalar lo ya descargado: son segundos, y la app vuelve sola. */
  const installUpdate = async () => {
    setIsInstalling(true);
    setUpdateMsg(t("Installing update…"));
    try {
      // En Windows esto no vuelve: el instalador toma el relevo y mata el proceso.
      await installPendingUpdate();
    } catch (err) {
      console.error(err);
      // Si falla, el proceso sigue vivo: hay que quitar el velo o la ventana se
      // queda tapada para siempre.
      setIsInstalling(false);
      setPending(null);
      setUpdateMsg(t("Failed to check for updates."));
      showError(t("Update error: {msg}", { msg: String(err) }));
    }
  };

  const hayProxy = !!config?.riot_proxy_url?.trim();
  // Con "auto" ya resuelto, decirlo: si no, no hay forma de saber si funcionó.
  const etiquetaAuto = config?.riot_platform_detected
    ? t("Auto (detected: {region})", { region: platformLabel(config.riot_platform_detected) })
    : t("Auto");

  const audioReady = audio?.ready_for_game_audio ?? false;
  const usedGb = disk ? (disk.used_bytes / 1024 ** 3).toFixed(1) : null;
  const diskPct = disk && disk.total_bytes > 0 ? Math.round((disk.used_bytes / disk.total_bytes) * 100) : null;
  // El aviso de la tira mira las DOS cosas: llenar la cuota solo borra lo viejo,
  // pero quedarse sin disco para la grabadora es que no se graba.
  const freeGb = disk && disk.drive_total_bytes > 0 ? disk.free_bytes / 1024 ** 3 : null;
  const discoApretado = freeGb !== null && freeGb < 3;

  /** Fila de ajuste: etiqueta y descripcion a la izquierda, control a la derecha. */
  const Row: React.FC<{
    label: string;
    desc?: string;
    /** Deja que los controles bajen de línea. Para las filas con varios. */
    wrap?: boolean;
    children: React.ReactNode;
  }> = ({ label, desc, wrap, children }) => (
    <div className="drow drow--set">
      <div>
        <span className="drow__label">{label}</span>
        {desc && <span className="drow__desc">{desc}</span>}
      </div>
      <div
        className="drow__control"
        style={wrap ? { flexWrap: "wrap", rowGap: "var(--space-2)" } : undefined}
      >
        {children}
      </div>
    </div>
  );

  return (
    <div className="setpage panel-enter">
      {isInstalling && (
        <div className="updv" role="status" aria-live="polite">
          <div className="updv__card">
            <RefreshCw size={22} color="var(--cool)" style={{ margin: "0 auto", animation: "spin 1s linear infinite" }} />
            <span className="updv__title">{t("Installing update…")}</span>
            <span className="updv__note">
              {t("The app will close and reopen by itself when it finishes. Do not close it.")}
            </span>
          </div>
        </div>
      )}

      <header>
        <h1 style={{ margin: 0, fontSize: "var(--font-xl)" }}>{t("Settings")}</h1>
        <p className="note">{t("What the recorder does, where it saves, and how it talks to Riot.")}</p>
      </header>

      {/* ------------------------------------------------------------ estado
          Antes esto estaba repartido en tres tarjetas ("Listo para grabar
          sonido", "Requisitos del sistema", "Deteccion de partidas") mezcladas
          con los ajustes de verdad. Pero el estado no se ajusta: se comprueba.
          Va arriba, en una tira, y contesta "esta todo listo" de un vistazo. */}
      <section className="status">
        <div className="status__item">
          <span className={isRecording ? "rec-dot" : "status__dot"} data-tone="idle" />
          <span className="status__label">{t("Recorder")}</span>
          <span className="status__value">{isRecording ? t("Recording") : t("Idle")}</span>
        </div>

        <div className="status__item">
          <span className="status__dot" data-tone={audioReady ? "ok" : "warn"} />
          <span className="status__label">{t("Game sound")}</span>
          <span className="status__value" title={audio?.system_audio_device ?? undefined}>
            {audioReady ? audio?.system_audio_device : t("No capture device")}
          </span>
          <button className="btn btn--ghost btn--sm" onClick={refreshAudio} disabled={audioLoading}>
            <RefreshCw size={12} style={audioLoading ? { animation: "spin 1s linear infinite" } : undefined} />
            {audioLoading ? t("Checking…") : t("Re-detect")}
          </button>
        </div>

        <div className="status__item">
          <span
            className="status__dot"
            data-tone={(diskPct !== null && diskPct > 90) || discoApretado ? "warn" : "ok"}
          />
          <span className="status__label">{t("Disk")}</span>
          <span className="status__value">
            {usedGb ? `${usedGb} GB · ${diskPct}%` : "—"}
            {freeGb !== null && ` · ${t("{n} GB free", { n: freeGb.toFixed(1) })}`}
          </span>
        </div>

        {/* En voz baja y solo mientras dura: explica por qué la app va lenta el
            primer minuto tras actualizar. No hay nada que hacer al respecto. */}
        {maint && (
          <div className="status__item">
            <span className="status__dot" data-tone="idle" />
            <span className="status__label">{t("Library")}</span>
            <span className="status__value">
              {t("Updating library: {phase} {done}/{total}", {
                phase: t(maint.phase),
                done: maint.done,
                total: maint.total,
              })}
            </span>
          </div>
        )}
      </section>

      {/* La receta para arreglar el audio solo aparece cuando hace falta. */}
      {!audioReady && (
        <details className="fold fold--warn">
          <summary>{t("How to enable game sound capture")}</summary>
          <p className="note">
            {t("Install Screen Capturer Recorder (already in your Downloads folder): run the setup as administrator. It adds the virtual-audio-capturer device, which captures exactly what you hear. Then hit Re-detect. Meanwhile it records with the microphone if there is one.")}
          </p>
        </details>
      )}

      {/* -------------------------------------------------------- grabacion */}
      <section>
        {/* No puede llamarse "Grabacion": la tira de estado de arriba ya usa
            "Grabando" para el estado del grabador y se leian como lo mismo. */}
        <div className="sect__head">
          <span className="u-label">{t("Video")}</span>
          <i className="sect__rule" />
          <button className="btn btn--ghost btn--sm" onClick={handleResetVideo} title={t("Reset to defaults")}>
            <RotateCcw size={12} />
            {t("Reset to defaults")}
          </button>
        </div>

        <Row label={t("Quality")} desc={t("Constant quality: a lower CQ is sharper and heavier.")}>
          <div className="tp-seg">
            {([
              { key: "High", label: t("High"), hint: t("Constant quality {cq}", { cq: 20 }) },
              { key: "Medium", label: t("Medium"), hint: t("Constant quality {cq}", { cq: 23 }) },
              { key: "Low", label: t("Low"), hint: t("Constant quality {cq}", { cq: 26 }) },
            ] as const).map((q) => (
              <button
                key={q.key}
                onClick={() => video && saveVideo(video.fps, q.key)}
                {...(video?.quality === q.key ? { "data-on": true } : {})}
                title={q.hint}
              >
                {q.label}
              </button>
            ))}
          </div>
        </Row>

        <Row label={t("Frame rate")} desc={t("Encoded on the GPU (NVENC), so your in-game FPS is untouched.")}>
          <div className="tp-seg">
            {[60, 30].map((f) => (
              <button
                key={f}
                onClick={() => video && saveVideo(f, video.quality)}
                {...(video?.fps === f ? { "data-on": true } : {})}
              >
                {f} FPS
              </button>
            ))}
          </div>
        </Row>

        {/* Antes esto no se podía elegir: se grababa a 1080p siempre, así que
            quien juega a 1440p perdía resolución de balde. */}
        <Row
          label={t("Resolution")}
          desc={t("Native records at the game's window size (up to 1440p)")}
        >
          <div className="tp-seg">
            {([
              { key: "native", label: t("Native") },
              { key: "1080p", label: "1080p" },
              { key: "1440p", label: "1440p" },
            ] as const).map((r) => (
              <button
                key={r.key}
                onClick={() => video && saveVideo(video.fps, video.quality, r.key)}
                {...((video?.resolution ?? "native") === r.key ? { "data-on": true } : {})}
              >
                {r.label}
              </button>
            ))}
          </div>
        </Row>
      </section>

      {/* --------------------------------------------------------- atajos */}
      <section>
        <div className="sect__head"><span className="u-label">{t("Hotkeys")}</span><i className="sect__rule" /></div>

        <Row
          label={t("Save replay")}
          desc={t("Saves the last 30 seconds as a clip while recording")}
        >
          <HotkeyCapture
            value={hotkeys?.replay ?? ""}
            disabled={hotkeys === null}
            onCapture={handleSaveHotkey}
          />
        </Row>
      </section>

      {/* --------------------------------------------------- almacenamiento */}
      <section>
        <div className="sect__head">
          <span className="u-label">{t("Storage")}</span>
          <i className="sect__rule" />
          <button className="btn btn--ghost btn--sm" onClick={handleResetStorage} title={t("Reset to defaults")}>
            <RotateCcw size={12} />
            {t("Reset to defaults")}
          </button>
        </div>

        {/* La cuota y el disco, separados: no son la misma cifra y confundirlos
            es lo que dejaba "20% usado" en un disco que ya no admitía grabar. */}
        <DiskMeter disk={disk} />

        <Row label={t("Save location")} desc={t("Directory where videos and clips are saved")} wrap>
          <input
            type="text"
            className="field field--path"
            value={config?.save_directory ?? ""}
            readOnly
            title={config?.save_directory ?? ""}
          />
          {/* El campo es de solo lectura, así que sin esto la ruta se veía pero
              no se podía ir a ella: había que copiarla a mano al explorador. */}
          <button
            onClick={handleOpenDirectory}
            className="btn btn--ghost btn--sm"
            disabled={!config?.save_directory}
            title={t("Open folder")}
          >
            <FolderOpen size={13} />
            {t("Open folder")}
          </button>
          <button onClick={handlePickDirectory} className="btn btn--ghost btn--sm">{t("Change")}</button>
        </Row>

        <Row
          label={t("Max Storage Quota (GB)")}
          desc={t("Oldest matches are deleted first when the folder goes over this. Minimum {n} GB.").replace("{n}", String(MIN_STORAGE_GB))}
        >
          <input
            type="number"
            min={MIN_STORAGE_GB}
            className="field field--num"
            value={storageDraft}
            onChange={(e) => setStorageDraft(e.target.value)}
            onBlur={() => {
              const gb = clampStorageGb(storageDraft);
              setStorageDraft(String(gb));
              // La barra de la cuota se queda mintiendo si no se relee: es el
              // mismo número que se acaba de cambiar.
              handleSaveConfig({ max_storage_gb: gb }).then(refreshDisk).catch(() => {});
            }}
          />
        </Row>

        <Row
          label={t("Auto-prune Age (Days)")}
          desc={t("Deletes matches older than this, with their clips. 0 disables it. Imported VODs and matches with favourited clips are never touched.")}
        >
          <input
            type="number"
            min="0"
            className="field field--num"
            value={pruneDraft}
            onChange={(e) => setPruneDraft(e.target.value)}
            onBlur={() => {
              const days = clampPruneDays(pruneDraft);
              setPruneDraft(String(days));
              handleSaveConfig({ auto_prune_days: days });
            }}
          />
        </Row>
      </section>

      {/* ---------------------------------------------- copia de seguridad */}
      <section>
        <div className="sect__head">
          <span className="u-label">{t("Backup")}</span>
          <i className="sect__rule" />
        </div>
        <p className="note">{t("Notes, flags, stats and settings. Videos are not included.")}</p>

        <Row
          label={t("Backup file")}
          desc={t("A single zip you can keep anywhere. Restoring it only fills in what is missing here.")}
          wrap
        >
          <button
            onClick={handleExportBackup}
            className="btn btn--ghost btn--sm"
            disabled={backupBusy !== null}
          >
            <Download size={13} />
            {backupBusy === "export" ? t("Exporting…") : t("Export backup…")}
          </button>
          <button
            onClick={handleImportBackup}
            className="btn btn--ghost btn--sm"
            disabled={backupBusy !== null}
          >
            <Upload size={13} />
            {backupBusy === "import" ? t("Restoring…") : t("Import backup…")}
          </button>
        </Row>

        <Row
          label={t("Mirror folder")}
          desc={t("Point this at a OneDrive or Google Drive folder and every note and stat is synced automatically.")}
          wrap
        >
          <input
            type="text"
            className="field field--path"
            value={config?.backup_mirror_dir || ""}
            placeholder={t("Not set")}
            readOnly
            title={config?.backup_mirror_dir || ""}
          />
          <button onClick={handlePickMirror} className="btn btn--ghost btn--sm">
            <Archive size={13} />
            {t("Change")}
          </button>
          <button
            onClick={() => handleSaveConfig({ backup_mirror_dir: "" }).catch(() => {})}
            className="btn btn--ghost btn--sm"
            disabled={!config?.backup_mirror_dir}
            title={t("Turn the mirror off")}
          >
            <X size={13} />
            {t("Clear")}
          </button>
        </Row>
      </section>

      {/* ------------------------------------------------------- asistente */}
      <section>
        <div className="sect__head">
          <span className="u-label">{t("First-run setup")}</span>
          <i className="sect__rule" />
        </div>
        <Row
          label={t("Run setup again")}
          desc={t("The setup wizard opens over the app, with what you already configured inside. Nothing is deleted.")}
        >
          <button onClick={handleRestartOnboarding} className="btn btn--ghost btn--sm">
            <Wand2 size={13} />
            {t("Run setup")}
          </button>
        </Row>
      </section>

      {/* ---------------------------------------------------------- cuenta */}
      <section>
        <div className="sect__head"><span className="u-label">{t("Interface and account")}</span><i className="sect__rule" /></div>

        <Row label={t("Language")} desc={t("Interface language. Saved with your settings.")}>
          <div className="tp-seg">
            {LANGUAGES.map((l) => (
              <button
                key={l.code}
                onClick={() => setLang(l.code as Language)}
                {...(lang === l.code ? { "data-on": true } : {})}
              >
                {l.label}
              </button>
            ))}
          </div>
        </Row>

        <Row
          label={t("Riot API key")}
          wrap
          desc={
            // La advertencia de las 24 h solo aplica a quien usa SU clave: con
            // un proxy configurado la pone el servidor y aquí no caduca nada.
            hayProxy
              ? t("Needed for the scoreboard and your stats. Your proxy is providing the key, so you do not need one here.")
              : t("Needed for the scoreboard and your stats. Saved when you leave the field. A development key expires every 24 hours; a personal one does not.")
          }
        >
          <input
            type={showKey ? "text" : "password"}
            className="field"
            placeholder="RGAPI-…"
            value={config?.riot_api_key ?? ""}
            disabled={config === null}
            onChange={handleApiKeyChange}
            onBlur={handleApiKeyBlur}
            onKeyDown={handleApiKeyKeyDown}
          />
          {/* Pegar una clave a ciegas y no poder comprobar que entró entera era
              la mitad de los "no me funciona". */}
          <button
            className="btn btn--icon btn--sm"
            onClick={() => setShowKey((v) => !v)}
            title={showKey ? t("Hide key") : t("Show key")}
            aria-label={showKey ? t("Hide key") : t("Show key")}
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          {keyState !== null && (
            <span
              className="u-meta"
              style={{
                color:
                  keyState === "ok" ? "var(--win)" : keyState === "bad" ? "var(--loss)" : undefined,
              }}
            >
              {keyState === "saving" && t("Checking…")}
              {keyState === "ok" && t("Key saved and working")}
              {keyState === "bad" && (keyMsg || t("The key is not valid"))}
            </span>
          )}
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => openUrl(RIOT_DEV_PORTAL)}
          >
            {t("Get a key at developer.riotgames.com")}
          </button>
        </Row>

        {/* La app nació clavada en LAN: fuera de América no llegaba nada de
            Riot y sin explicación. "Auto" lo averigua con tus partidas. */}
        <Row
          label={t("Region")}
          desc={t("Where you play. Auto figures it out from your recent matches the first time.")}
        >
          <select
            className="field"
            value={config?.riot_platform ?? "auto"}
            disabled={config === null}
            onChange={(e) => handleSaveConfig({ riot_platform: e.target.value })}
          >
            <option value="auto">{etiquetaAuto}</option>
            {RIOT_PLATFORMS.map((p) => (
              <option key={p.code} value={p.code}>
                {p.label}
              </option>
            ))}
          </select>
        </Row>
      </section>

      {/* -------------------------------------------------------- avanzado */}
      <section>
        <div className="sect__head"><span className="u-label">{t("Advanced")}</span><i className="sect__rule" /></div>

        <Row
          label={t("Minimap scale")}
          desc={t("Size of your in-game minimap versus the standard one, in percent. Calibrates minimap-click detection (map looks, blind spots) if you play with the HUD rescaled. Changing it recalculates past games in the background.")}
        >
          <input
            type="number"
            min={50}
            max={200}
            step={5}
            className="field field--num"
            value={minimapDraft}
            onChange={(e) => setMinimapDraft(e.target.value)}
            onBlur={() => {
              const pct = clampMinimapPct(minimapDraft);
              setMinimapDraft(String(pct));
              handleSaveConfig({ minimap_scale: pct / 100 });
            }}
          />
          <span className="u-meta">%</span>
        </Row>

        <Row
          label={t("Riot proxy URL")}
          desc={t("A server that holds the Riot key for you: with one, you never need your own key or to renew it.")}
        >
          <input
            type="text"
            className="field"
            placeholder="https://…"
            value={proxyDraft}
            disabled={config === null}
            onChange={(e) => setProxyDraft(e.target.value)}
            onBlur={() => {
              const url = proxyDraft.trim().replace(/\/+$/, "");
              setProxyDraft(url);
              if (url !== (config?.riot_proxy_url ?? "")) {
                handleSaveConfig({ riot_proxy_url: url });
              }
            }}
          />
        </Row>

        <Row label={t("AI dataset generator")} desc={t("Extracts frames at the moment of each click to train the detector. Off unless you are working on the model.")}>
          <input
            type="checkbox"
            className="check"
            checked={config?.auto_dataset_generator ?? false}
            onChange={(e) => handleSaveConfig({ auto_dataset_generator: e.target.checked })}
          />
        </Row>

        {/* La versión se pedía al backend, no se escribía a mano: estaba clavada
            en "1.2.8" mientras la app iba por la 1.2.11. */}
        {/* Tres estados: bajando (barra), lista (botón de instalar) y al día
            (botón de comprobar). La descarga ya no la dispara este botón: viene
            hecha de fondo, así que instalar son segundos. */}
        <Row
          label={t("Updates")}
          desc={
            isDownloading
              ? updateMsg
              : pending
                ? t("Version {v} downloaded and ready. Installing takes a few seconds and the app reopens by itself.").replace("{v}", pending.version)
                : (updateMsg || (appVersion ? t("Version {v} installed.").replace("{v}", appVersion) : ""))
          }
        >
          {isDownloading ? (
            <div className="upd">
              <span className="upd__track"><span className="upd__fill" style={{ width: `${downloadProgress}%` }} /></span>
              <span className="u-metric" style={{ fontSize: 11 }}>{downloadProgress}%</span>
            </div>
          ) : pending ? (
            <button onClick={installUpdate} className="btn btn--sm">
              {t("Restart and install")}
            </button>
          ) : (
            <button onClick={checkForUpdates} disabled={isUpdating} className="btn btn--ghost btn--sm">
              {isUpdating ? t("Checking…") : t("Check for Updates")}
            </button>
          )}
        </Row>
      </section>

      {/* ----------------------------------------------------- herramientas
          Grabar a mano no es un ajuste: es algo que se ejecuta. Por eso baja
          al final y se presenta como herramienta, no como preferencia. */}
      <section>
        <div className="sect__head"><span className="u-label">{t("Tools")}</span><i className="sect__rule" /></div>

        <Row label={t("Manual test recording")} desc={t("Checks that FFmpeg and GPU encoding work before trusting a real match.")}>
          {isRecording ? (
            <button onClick={handleStopManual} disabled={isProcessing} className="btn btn--primary btn--sm">
              {t("Stop and save")}
            </button>
          ) : (
            <>
              <input
                type="text"
                className="field field--num"
                style={{ width: 120 }}
                placeholder={t("name")}
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
                disabled={isProcessing}
              />
              <button onClick={handleStartManual} disabled={isProcessing} className="btn btn--primary btn--sm">
                {t("Record screen")}
              </button>
            </>
          )}
        </Row>
        {statusMsg && <p className="note">{statusMsg}</p>}
      </section>

      {/* La documentacion que estaba suelta en dos tarjetas: sigue disponible,
          pero plegada. No es algo que se ajuste. */}
      <details className="fold">
        <summary>{t("How automatic recording works")}</summary>
        <ul className="fold__list">
          <li>{t("The background service connects to the in-game API on port 2999 when a match starts.")}</li>
          <li>{t("It records locally with hardware encoding, at the resolution you picked, so your FPS is untouched.")}</li>
          <li>{t("It logs kills, deaths, assists and objectives with their timestamps.")}</li>
          <li>{t("It saves everything when the match ends, with no action from you.")}</li>
          <li>{t("It needs ffmpeg on your Windows PATH; without it the recorder cannot start.")}</li>
        </ul>
      </details>

      {audio && audio.all_devices.length > 0 && (
        <details className="fold">
          <summary>{t("Detected audio devices")} ({audio.all_devices.length})</summary>
          <ul className="fold__list">
            {audio.all_devices.map((d) => (
              <li key={d} style={{ color: d === audio.system_audio_device ? "var(--cool)" : undefined }}>
                {d}{d === audio.system_audio_device ? ` ← ${t("used for the game")}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
};
