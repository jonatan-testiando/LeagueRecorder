import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Eye, EyeOff, FolderOpen, Check, X } from "lucide-react";
import {
  getAppConfig,
  setAppConfig,
  getVideoSettings,
  setVideoSettings,
  getDiskUsage,
  getHotkeys,
  checkRiotKey,
  type AppConfig,
  type DiskSpaceInfo,
} from "../../../core/tauri-ipc";
import { RIOT_PLATFORMS, platformLabel, AUTO_PLATFORM } from "../../../core/riotRegions";
import { RIOT_DEV_PORTAL } from "../../../components/RiotKeyBanner";
import { BrandMark } from "../../../components/BrandMark";
import { Button } from "../../../components/ui/Button";
import { useLang } from "../../../core/LanguageProvider";
import { LANGUAGES, type Language } from "../../../core/i18n";
import type { VideoSettings } from "../../../types";

/**
 * Primer arranque.
 *
 * Tres pantallas y ni una más. La app hace su trabajo sola —detecta League,
 * graba, sincroniza— así que el asistente no es una lista de cosas que hay que
 * configurar: es la explicación de que no hay que hacer nada, con los tres
 * datos que la app no puede adivinar (idioma, región, clave) y los dos que
 * conviene mirar una vez (carpeta y calidad).
 *
 * Todo lo que se toca aquí se guarda al momento y vive también en Ajustes: si
 * alguien lo cierra a mitad no se pierde nada, y el paso 3 es el único que
 * marca `onboarding_done`.
 */

const PASOS = 3;

/** Lo que hace el asistente al escribir un campo, en un solo sitio. */
type KeyState = null | "saving" | "ok" | "bad";

export interface OnboardingWizardProps {
  /** Lo llama el paso 3. Guarda `onboarding_done` y devuelve la app. */
  onDone: () => void;
}

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({ onDone }) => {
  const { lang, setLang, t } = useLang();
  const [paso, setPaso] = useState(0);

  const [config, setConfig] = useState<AppConfig | null>(null);
  const [video, setVideo] = useState<VideoSettings | null>(null);
  const [disk, setDisk] = useState<DiskSpaceInfo | null>(null);
  const [replayKey, setReplayKey] = useState<string>("F8");

  const [showKey, setShowKey] = useState(false);
  const [keyState, setKeyState] = useState<KeyState>(null);
  const [keyMsg, setKeyMsg] = useState("");

  const cajaRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let vivo = true;
    getAppConfig().then((c) => vivo && setConfig(c)).catch(console.error);
    getVideoSettings().then((v) => vivo && setVideo(v)).catch(console.error);
    getDiskUsage().then((d) => vivo && setDisk(d)).catch(() => {});
    // El atajo vive en su propio fichero, no en la config: si no se puede leer
    // se dice F8, que es el de fábrica, en vez de callar.
    getHotkeys()
      .then((h) => vivo && setReplayKey(h.replay || "F8"))
      .catch(() => {});
    return () => { vivo = false; };
  }, []);

  /** Guarda un parche y deja la copia local en pie aunque el disco falle. */
  const guardar = useCallback(async (patch: Partial<AppConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
    await setAppConfig(patch).catch(console.error);
  }, []);

  const guardarVideo = useCallback(
    async (fps: number, quality: string, resolution?: VideoSettings["resolution"]) => {
      try {
        setVideo(await setVideoSettings(fps, quality, resolution));
      } catch (e) {
        console.error(e);
      }
    },
    []
  );

  const comprobarClave = useCallback(async () => {
    const clave = (config?.riot_api_key ?? "").trim();
    if (!clave) {
      setKeyState("bad");
      setKeyMsg(t("Paste a key first, or skip this: the app records without it."));
      return;
    }
    setKeyState("saving");
    setKeyMsg("");
    try {
      await guardar({ riot_api_key: clave });
      await checkRiotKey();
      setKeyState("ok");
    } catch (e) {
      setKeyState("bad");
      setKeyMsg(String(e).replace(/^Error:\s*/, ""));
    }
  }, [config, guardar, t]);

  const elegirCarpeta = useCallback(async () => {
    try {
      const elegida = await open({
        directory: true,
        multiple: false,
        defaultPath: config?.save_directory || undefined,
      });
      if (typeof elegida !== "string") return;
      await guardar({ save_directory: elegida });
      // Otra carpeta puede ser otro volumen: lo libre cambia.
      getDiskUsage().then(setDisk).catch(() => {});
    } catch (e) {
      console.error(e);
    }
  }, [config, guardar]);

  const avanzar = useCallback(() => {
    if (paso < PASOS - 1) setPaso((p) => p + 1);
    else onDone();
  }, [paso, onDone]);

  /**
   * Enter avanza; Escape NO hace nada.
   *
   * A propósito: la tecla de cerrar diálogos aquí dejaría la app a medio
   * configurar y sin forma obvia de volver, que es exactamente el sitio en el
   * que nadie sabe qué ha pasado. Se sale por el botón, que además guarda.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return; }
      if (e.key !== "Enter") return;
      // Enter dentro del campo de la clave la comprueba en vez de saltar de
      // paso: es lo que se espera al acabar de pegarla.
      // `instanceof` y no un cast: el objetivo de un evento sintético puede ser
      // `window`, que no tiene `getAttribute` y reventaba el manejador entero.
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el?.dataset.onbKey === "1") {
        e.preventDefault();
        comprobarClave();
        return;
      }
      if (el && (el.tagName === "BUTTON" || el.tagName === "SELECT")) return;
      e.preventDefault();
      avanzar();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [avanzar, comprobarClave]);

  // Al cambiar de paso el foco vuelve arriba: sin esto el lector de pantalla se
  // queda en el botón "Siguiente" mientras la pantalla entera ha cambiado.
  useEffect(() => { cajaRef.current?.focus(); }, [paso]);

  const etiquetaAuto = config?.riot_platform_detected
    ? t("Auto (detected: {region})", { region: platformLabel(config.riot_platform_detected) })
    : t("Auto");

  const libreGb = disk && disk.free_bytes > 0 ? (disk.free_bytes / 1024 ** 3).toFixed(0) : null;
  const discoGb = disk && disk.drive_total_bytes > 0 ? (disk.drive_total_bytes / 1024 ** 3).toFixed(0) : null;

  const titulos = useMemo(
    // "Recording" no puede ser la clave del título: la tira de estado ya usa esa
    // misma cadena para "grabando ahora mismo" y en español serían la misma
    // palabra diciendo dos cosas distintas.
    () => [t("Language & account"), t("How it records"), t("After the game")],
    [t]
  );

  return (
    <div style={styles.veil} role="dialog" aria-modal="true" aria-label={t("Set up LeagueRecorder")}>
      <div style={styles.sheet} ref={cajaRef} tabIndex={-1}>
        <header style={styles.head}>
          <span style={{ color: "var(--brand)", display: "flex" }}>
            <BrandMark size={20} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={styles.headTitle}>{t("Set up LeagueRecorder")}</div>
            <div className="u-meta">{t("Step {n} of {total}", { n: paso + 1, total: PASOS })}</div>
          </div>
          <div style={styles.dots} role="tablist" aria-label={t("Set up LeagueRecorder")}>
            {Array.from({ length: PASOS }, (_, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === paso}
                aria-label={t("Go to step {n}", { n: i + 1 })}
                title={titulos[i]}
                onClick={() => setPaso(i)}
                style={{
                  ...styles.dot,
                  background: i === paso ? "var(--brand)" : i < paso ? "var(--cool)" : "var(--line)",
                  width: i === paso ? 22 : 8,
                }}
              />
            ))}
          </div>
        </header>

        <div style={styles.body}>
          <h1 style={styles.stepTitle}>{titulos[paso]}</h1>

          {/* ------------------------------------------------------ paso 1 */}
          {paso === 0 && (
            <>
              <p style={styles.lead}>
                {t("Three things the app cannot guess. Everything else it works out on its own.")}
              </p>

              <div style={styles.row}>
                <label style={styles.rowLabel} htmlFor="onb-lang">{t("Interface language")}</label>
                <div className="tp-seg" id="onb-lang">
                  {LANGUAGES.map((l) => (
                    <button
                      key={l.code}
                      type="button"
                      onClick={() => setLang(l.code as Language)}
                      {...(lang === l.code ? { "data-on": true } : {})}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              </div>

              <div style={styles.row}>
                <label style={styles.rowLabel} htmlFor="onb-region">{t("Region")}</label>
                <div style={styles.rowField}>
                  <select
                    id="onb-region"
                    className="field"
                    value={config?.riot_platform ?? AUTO_PLATFORM}
                    disabled={config === null}
                    onChange={(e) => guardar({ riot_platform: e.target.value })}
                  >
                    <option value={AUTO_PLATFORM}>{etiquetaAuto}</option>
                    {RIOT_PLATFORMS.map((p) => (
                      <option key={p.code} value={p.code}>{p.label}</option>
                    ))}
                  </select>
                  <p style={styles.hint}>
                    {t("Where you play. Auto figures it out from your recent matches the first time.")}
                  </p>
                </div>
              </div>

              <div style={styles.row}>
                <label style={styles.rowLabel} htmlFor="onb-key">
                  {t("Riot API key")} <span className="u-meta">· {t("optional")}</span>
                </label>
                <div style={styles.rowField}>
                  <div style={styles.keyLine}>
                    <input
                      id="onb-key"
                      data-onb-key="1"
                      type={showKey ? "text" : "password"}
                      className="field"
                      placeholder="RGAPI-…"
                      value={config?.riot_api_key ?? ""}
                      disabled={config === null}
                      onChange={(e) => {
                        const v = e.target.value;
                        setKeyState(null);
                        setConfig((prev) => (prev ? { ...prev, riot_api_key: v } : prev));
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn--icon btn--sm"
                      onClick={() => setShowKey((v) => !v)}
                      title={showKey ? t("Hide key") : t("Show key")}
                      aria-label={showKey ? t("Hide key") : t("Show key")}
                    >
                      {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                    <Button variant="ghost" size="sm" onClick={comprobarClave}>
                      {t("Check key")}
                    </Button>
                  </div>

                  {keyState !== null && (
                    <p
                      style={{
                        ...styles.hint,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        color:
                          keyState === "ok" ? "var(--win)" : keyState === "bad" ? "var(--loss)" : "var(--muted)",
                      }}
                    >
                      {keyState === "ok" && <Check size={13} />}
                      {keyState === "bad" && <X size={13} />}
                      {keyState === "saving" && t("Checking…")}
                      {keyState === "ok" && t("Key saved and working")}
                      {keyState === "bad" && (keyMsg || t("The key is not valid"))}
                    </p>
                  )}

                  <p style={styles.hint}>
                    {t("Without a key the app still records and tracks your games. With one it also brings the scoreboard, your impact score, your rank and the pressure you absorbed.")}
                  </p>
                  <Button variant="ghost" size="sm" onClick={() => openUrl(RIOT_DEV_PORTAL)}>
                    {t("Get a key at developer.riotgames.com")}
                  </Button>
                </div>
              </div>
            </>
          )}

          {/* ------------------------------------------------------ paso 2 */}
          {paso === 1 && (
            <>
              <p style={styles.lead}>
                {t("League is detected automatically; nothing to press.")}
              </p>

              <div style={styles.row}>
                <label style={styles.rowLabel}>{t("Save folder")}</label>
                <div style={styles.rowField}>
                  <div style={styles.keyLine}>
                    <input
                      className="field field--path"
                      readOnly
                      value={config?.save_directory ?? ""}
                      title={config?.save_directory ?? ""}
                    />
                    <Button variant="ghost" size="sm" icon={<FolderOpen size={13} />} onClick={elegirCarpeta}>
                      {t("Change")}
                    </Button>
                  </div>
                  {libreGb && discoGb && (
                    <p style={styles.hint}>
                      {t("Drive: {free} GB free of {total} GB", { free: libreGb, total: discoGb })}
                    </p>
                  )}
                </div>
              </div>

              <div style={styles.row}>
                <label style={styles.rowLabel}>{t("Quality")}</label>
                <div className="tp-seg">
                  {(["High", "Medium", "Low"] as const).map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => video && guardarVideo(video.fps, q)}
                      {...(video?.quality === q ? { "data-on": true } : {})}
                    >
                      {t(q)}
                    </button>
                  ))}
                </div>
              </div>

              <div style={styles.row}>
                <label style={styles.rowLabel}>{t("Frame rate")}</label>
                <div className="tp-seg">
                  {[60, 30].map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => video && guardarVideo(f, video.quality)}
                      {...(video?.fps === f ? { "data-on": true } : {})}
                    >
                      {f} FPS
                    </button>
                  ))}
                </div>
              </div>

              <div style={styles.row}>
                <label style={styles.rowLabel}>{t("Resolution")}</label>
                <div style={styles.rowField}>
                  <div className="tp-seg">
                    {([
                      { key: "native", label: t("Native") },
                      { key: "1080p", label: "1080p" },
                      { key: "1440p", label: "1440p" },
                    ] as const).map((r) => (
                      <button
                        key={r.key}
                        type="button"
                        onClick={() => video && guardarVideo(video.fps, video.quality, r.key)}
                        {...((video?.resolution ?? "native") === r.key ? { "data-on": true } : {})}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                  <p style={styles.hint}>
                    {t("Encoded on the GPU (NVENC), so your in-game FPS is untouched.")}
                  </p>
                </div>
              </div>
            </>
          )}

          {/* ------------------------------------------------------ paso 3 */}
          {paso === 2 && (
            <>
              <p style={styles.lead}>{t("That is the whole setup. This is what happens next.")}</p>
              <ol style={styles.steps}>
                <li>
                  <strong style={styles.stepStrong}>{t("You play.")}</strong>{" "}
                  {t("The recorder starts and stops with the game. You never press anything.")}
                </li>
                <li>
                  <strong style={styles.stepStrong}>{t("It syncs about a minute after the game ends.")}</strong>{" "}
                  {t("Scoreboard, rank, impact score and the pressure you absorbed land on their own.")}
                </li>
                <li>
                  <strong style={styles.stepStrong}>{t("Today tells you what to work on.")}</strong>{" "}
                  {t("One weakness at a time, with the games where it happened.")}
                </li>
                <li>
                  <strong style={styles.stepStrong}>{t("Library keeps every game")}</strong>{" "}
                  {t("with its video and its review queue.")}
                </li>
                <li>
                  <strong style={styles.stepStrong}>{t("{key} saves the last 30 seconds", { key: replayKey })}</strong>{" "}
                  {t("while a game is being recorded, without stopping it.")}
                </li>
              </ol>
              <p style={styles.hint}>
                {t("You can change all of this later in Settings.")}
              </p>
            </>
          )}
        </div>

        <footer style={styles.foot}>
          <Button
            variant="ghost"
            size="md"
            onClick={() => setPaso((p) => Math.max(0, p - 1))}
            disabled={paso === 0}
          >
            {t("Back")}
          </Button>
          <span style={{ flex: 1 }} />
          <Button variant="primary" size="md" onClick={avanzar}>
            {paso === PASOS - 1 ? t("Start") : t("Next")}
          </Button>
        </footer>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  veil: {
    position: "fixed",
    inset: 0,
    zIndex: 90,
    display: "grid",
    placeItems: "center",
    padding: "var(--space-6)",
    background: "var(--bg-app)",
    boxSizing: "border-box",
  },
  sheet: {
    width: "min(720px, 100%)",
    maxHeight: "100%",
    display: "flex",
    flexDirection: "column",
    background: "var(--surface-1)",
    backdropFilter: "var(--glass-blur)",
    border: "1px solid var(--glass-line)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-2, 0 24px 60px rgba(0,0,0,.45))",
    outline: "none",
    overflow: "hidden",
  },
  head: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    padding: "var(--space-4) var(--space-6)",
    borderBottom: "1px solid var(--glass-line-soft)",
  },
  headTitle: { fontSize: "var(--font-sm)", fontWeight: 600, color: "var(--text)" },
  dots: { display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" },
  dot: {
    height: 8,
    borderRadius: "var(--radius-full)",
    border: "none",
    padding: 0,
    cursor: "pointer",
    transition: "width var(--t-base, .18s) var(--e-out, ease), background var(--t-base, .18s)",
  },
  body: {
    padding: "var(--space-6)",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-4)",
  },
  stepTitle: { margin: 0, fontSize: "var(--font-xl)", fontWeight: 600, letterSpacing: "-0.02em" },
  lead: { margin: 0, fontSize: "var(--font-sm)", lineHeight: 1.55, color: "var(--muted)", maxWidth: "58ch" },
  row: {
    display: "grid",
    gridTemplateColumns: "180px 1fr",
    gap: "var(--space-4)",
    alignItems: "start",
    paddingTop: "var(--space-3)",
    borderTop: "1px solid var(--line-soft)",
  },
  rowLabel: { fontSize: "var(--font-sm)", color: "var(--text)", paddingTop: 6 },
  rowField: { display: "flex", flexDirection: "column", gap: "var(--space-2)", minWidth: 0 },
  keyLine: { display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 },
  hint: { margin: 0, fontSize: "var(--font-xs)", lineHeight: 1.5, color: "var(--faint)", maxWidth: "54ch" },
  steps: {
    margin: 0,
    paddingLeft: "1.2em",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-3)",
    fontSize: "var(--font-sm)",
    lineHeight: 1.55,
    color: "var(--muted)",
    maxWidth: "60ch",
  },
  stepStrong: { color: "var(--text)", fontWeight: 600 },
  foot: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    padding: "var(--space-4) var(--space-6)",
    borderTop: "1px solid var(--glass-line-soft)",
  },
};
