import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { HardDrive, KeyRound, Play, VolumeOff } from "lucide-react";
import {
  checkRiotKey,
  getAudioStatus,
  getDiskUsage,
  getHotkeys,
  type DiskSpaceInfo,
  type RecorderAlert,
} from "../core/tauri-ipc";
import { useLang, useT } from "../core/LanguageProvider";
import { useAppStore, useErrorClips } from "../store/useAppStore";
import { useToast } from "./ui/Toaster";
import { ChampionAvatar } from "./ChampionAvatar";
import { clock } from "../core/time";
import { formatDuration, outcome } from "../core/matchStats";
import { reviewProgress } from "../core/review";
import type { MatchMetadata } from "../types";

/**
 * Estado de captura: qué hace el grabador, en la barra de título.
 *
 * Sustituye a la caja del pie del rail (`RailStatus`), que no se veía dentro
 * del reproductor. Cinco estados y una sola píldora, por prioridad —lo que
 * pide actuar tapa a lo que solo informa—:
 *
 *   1. Disco casi lleno (< 3 GB, el mismo umbral que el aviso `disk_low` del
 *      backend; por debajo de 1 GB no se graba).
 *   2. Sin sonido del juego (la grabación sigue; "Arreglar" lleva al
 *      diagnóstico de audio de Ajustes › Captura).
 *   3. Grabando, con el cronómetro y la tecla del replay.
 *   4. Procesando la partida: desde que para la grabación hasta que la partida
 *      está guardada y sincronizada con Riot.
 *   5. La clave de Riot falla (lleva a Ajustes › Cuenta).
 *   y si no, listo para grabar.
 *
 * De aquí sale también el aviso de «Partida guardada»: el backend no emite
 * ningún evento al guardar, así que la partida nueva se detecta cuando crece
 * la lista del store (el refresco de fin de grabación de `useGallery`, y el
 * sondeo de abajo mientras dura el procesado).
 */

type KeyStatus = "ok" | "missing" | "expired" | "invalid";

export type Capture =
  | { kind: "disk"; freeGb: number }
  | { kind: "mute" }
  | { kind: "rec"; since: number | null; hotkey: string }
  | { kind: "proc"; pct: number | null }
  | { kind: "key"; status: Exclude<KeyStatus, "ok"> }
  | { kind: "ready" };

/** El mismo umbral que `DISK_LOW_BYTES` del backend (storage.rs). */
const DISK_LOW_GB = 3;
/** Sondeo de la lista mientras se procesa: la sincronización con Riot llega
 *  ~60 s después de guardar y no avisa. */
const PROC_POLL_MS = 15_000;
/** Si en este tiempo tras parar no aparece la partida, se deja de esperar. */
const PROC_SAVE_TIMEOUT_MS = 90_000;
/** Y si aparece pero Riot no la completa en este tiempo, se da por procesada
 *  igual (la sincronización puede reintentarse a mano desde la partida). */
const PROC_SYNC_TIMEOUT_MS = 150_000;

interface Proc {
  /** Cuándo paró la grabación (o cuándo apareció la partida, si se coló). */
  since: number;
  matchId: string | null;
  appearedAt: number | null;
}

const gb = (bytes: number) => bytes / 1024 ** 3;

/** GB con la coma o el punto del idioma ("2,0" en español): sin decimales
 *  desde 10, con uno por debajo, que es donde importa. */
export const formatGb = (v: number, lang: string): string => {
  const dec = v >= 10 ? 0 : 1;
  return v.toLocaleString(lang === "es" ? "es-ES" : "en-US", {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
};

export interface CaptureInfo {
  capture: Capture;
  /** GB libres del volumen de grabación, o null si no se pudo consultar. */
  freeGb: number | null;
}

export function useCaptureStatus(isRecording: boolean): CaptureInfo {
  const t = useT();
  const navigate = useNavigate();
  const { toast } = useToast();
  const matches = useAppStore((s) => s.matches);
  const matchesLoaded = useAppStore((s) => s.matchesLoaded);
  const refreshMatches = useAppStore((s) => s.refreshMatches);
  const setSelectedMatch = useAppStore((s) => s.setSelectedMatch);
  const { clips: errorClips } = useErrorClips();

  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [disk, setDisk] = useState<DiskSpaceInfo | null>(null);
  const [audioOk, setAudioOk] = useState<boolean | null>(null);
  const [hotkey, setHotkey] = useState("F8");
  const [recSince, setRecSince] = useState<number | null>(null);
  const [proc, setProc] = useState<Proc | null>(null);
  const [minimap, setMinimap] = useState<{ pct: number; at: number } | null>(null);

  const mountedAt = useRef(Date.now());

  const refreshDisk = useCallback(() => {
    getDiskUsage().then(setDisk).catch(() => {});
  }, []);
  const refreshAudio = useCallback(() => {
    getAudioStatus()
      .then((a) => setAudioOk(a.ready_for_game_audio))
      .catch(() => {});
  }, []);

  /* ---------------------------------------------- clave, disco, audio, tecla */
  useEffect(() => {
    let vivo = true;
    refreshDisk();
    refreshAudio();
    getHotkeys()
      .then((h) => vivo && h?.replay && setHotkey(h.replay))
      .catch(() => {});
    // El backend solo emite `riot_key_status` cuando una llamada choca con un
    // 401/403, así que además se pregunta al arrancar.
    checkRiotKey()
      .then(() => vivo && setKeyStatus("ok"))
      .catch((e) => {
        if (!vivo) return;
        const msg = String(e).toLowerCase();
        setKeyStatus(msg.includes("no_key") || msg.includes("missing") ? "missing" : "invalid");
      });
    const paraClave = listen<{ status: KeyStatus }>("riot_key_status", (e) => setKeyStatus(e.payload.status));
    // Un aviso de disco del grabador es la señal de volver a medir YA, no a
    // los dos minutos.
    const paraAlerta = listen<RecorderAlert>("recorder_alert", (e) => {
      if (e.payload.kind === "disk_low" || e.payload.kind === "disk_full") refreshDisk();
    });
    // El procesado del vídeo (posiciones del minimapa) sí da porcentaje.
    const paraMinimapa = listen<[string, number]>("minimap_progress", (e) => {
      const pct = e.payload?.[1];
      if (typeof pct !== "number" || pct < 0 || pct >= 100) setMinimap(null);
      else setMinimap({ pct, at: Date.now() });
    });
    const cada = setInterval(() => {
      refreshDisk();
      refreshAudio();
    }, 120_000);
    return () => {
      vivo = false;
      clearInterval(cada);
      paraClave.then((f) => f()).catch(() => {});
      paraAlerta.then((f) => f()).catch(() => {});
      paraMinimapa.then((f) => f()).catch(() => {});
    };
  }, [refreshDisk, refreshAudio]);

  // Un porcentaje que deja de llegar no se queda congelado en la píldora.
  useEffect(() => {
    if (!minimap) return;
    const id = setTimeout(() => setMinimap(null), 20_000);
    return () => clearTimeout(id);
  }, [minimap]);

  /* ----------------------------------------------------- grabando / procesando */
  const prevRec = useRef(false);
  useEffect(() => {
    const antes = prevRec.current;
    prevRec.current = isRecording;
    if (isRecording && !antes) {
      // Si ya grababa al abrir la app, no se sabe desde cuándo: el cronómetro
      // no se inventa. El estado llega por sondeo (5 s), así que el reloj va
      // como mucho esos segundos por detrás.
      setRecSince(Date.now() - mountedAt.current < 4000 ? null : Date.now());
      setProc(null);
      // Con la tubería en marcha el backend ya puede decir si entra audio.
      const id = setTimeout(refreshAudio, 8000);
      return () => clearTimeout(id);
    }
    if (!isRecording && antes) {
      setRecSince(null);
      setProc({ since: Date.now(), matchId: null, appearedAt: null });
      refreshDisk();
      refreshAudio();
    }
    return undefined;
  }, [isRecording, refreshAudio, refreshDisk]);

  // Partidas conocidas. Se siembran con la primera carga: lo que ya estaba al
  // abrir la app no es "nuevo".
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!matchesLoaded) return;
    if (!known.current) {
      known.current = new Set(matches.map((m) => m.id));
      return;
    }
    const nuevas = matches.filter((m) => !known.current!.has(m.id));
    nuevas.forEach((m) => known.current!.add(m.id));
    // Solo partidas propias y recién jugadas: un VOD importado o las partidas
    // que devuelve una copia de seguridad también hacen crecer la lista, y
    // ninguna de ellas es "la partida que acabas de terminar".
    const reciente = (iso: string) => {
      const ms = new Date(iso.replace(" ", "T")).getTime();
      return Number.isFinite(ms) && Date.now() - ms < 3 * 3600_000;
    };
    const propia = nuevas
      .filter((m) => !m.is_vod && reciente(m.date))
      .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    if (!propia) return;
    setProc((p) =>
      p && !p.matchId
        ? { ...p, matchId: propia.id, appearedAt: Date.now() }
        : // Se coló sin que viéramos parar la grabación (una partida más corta
          // que el sondeo, o el refresco de 5 min): se procesa igual.
          p ?? { since: Date.now(), matchId: propia.id, appearedAt: Date.now() }
    );
  }, [matches, matchesLoaded]);

  // Mientras se procesa, se relee la lista: es la única forma de enterarse de
  // que llegó la sincronización con Riot.
  useEffect(() => {
    if (!proc) return;
    const id = setInterval(() => {
      refreshMatches().catch(() => {});
    }, PROC_POLL_MS);
    return () => clearInterval(id);
  }, [proc, refreshMatches]);

  const openMatch = useCallback(
    (id: string) => {
      const m = useAppStore.getState().matches.find((x) => x.id === id);
      if (!m) return;
      setSelectedMatch(m);
      navigate("/review");
    },
    [navigate, setSelectedMatch]
  );

  const avisar = useCallback(
    (m: MatchMetadata) => {
      const res = outcome(m.result);
      const color = res === "victory" ? "var(--win)" : res === "defeat" ? "var(--loss)" : "var(--faint)";
      const prog = reviewProgress(m, errorClips);
      const pendientes = Math.max(0, prog.total - prog.done);
      toast({
        tone: res === "victory" ? "success" : "info",
        title: t("Game saved"),
        meta: t("now"),
        media: (
          <span
            style={{
              display: "flex",
              borderRadius: "50%",
              boxShadow: `0 6px 16px -6px color-mix(in srgb, ${color} 45%, transparent)`,
            }}
          >
            <ChampionAvatar champion={m.champion} size={40} ring={color} />
          </span>
        ),
        body: (
          <>
            {m.champion} · <span style={{ color }}>{t(res === "victory" ? "Victory" : res === "defeat" ? "Defeat" : "No result")}</span> ·{" "}
            {formatDuration(m.game_duration)}
          </>
        ),
        note:
          pendientes > 0
            ? pendientes === 1
              ? t("1 moment ready to review")
              : t("{n} moments ready to review", { n: pendientes })
            : undefined,
        action: {
          label: t("Review now"),
          icon: <Play size={11} fill="currentColor" aria-hidden="true" />,
          onClick: () => openMatch(m.id),
        },
        secondary: { label: t("Later"), onClick: () => {} },
        duration: 15_000,
      });
    },
    [errorClips, openMatch, t, toast]
  );

  // ¿Terminó el procesado? Se mira al cambiar la lista, y además se programa
  // una vuelta para cuando venza el plazo que toque (corre aunque la lista no
  // cambie). `tick` solo existe para esa vuelta.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!proc) return;
    const ahora = Date.now();
    const revisarEn = (deadline: number) => {
      const id = setTimeout(() => setTick((n) => n + 1), Math.max(0, deadline - ahora) + 50);
      return () => clearTimeout(id);
    };
    if (!proc.matchId) {
      if (ahora - proc.since > PROC_SAVE_TIMEOUT_MS) {
        setProc(null);
        return;
      }
      return revisarEn(proc.since + PROC_SAVE_TIMEOUT_MS);
    }
    const m = matches.find((x) => x.id === proc.matchId);
    if (!m) return;
    // La prueba de 10 s de Ajustes también es una grabación, pero ya la cuenta
    // su propio panel y no se sincroniza nunca: sin aviso.
    const esPrueba = m.id.startsWith("test-");
    const sincronizada = !!m.riot_match_id || (m.participants?.length ?? 0) > 0;
    const sinClave = keyStatus !== null && keyStatus !== "ok";
    const aparecio = proc.appearedAt ?? ahora;
    const plazo = ahora - aparecio > PROC_SYNC_TIMEOUT_MS;
    if (esPrueba || sincronizada || sinClave || plazo) {
      setProc(null);
      if (!esPrueba) avisar(m);
      return;
    }
    return revisarEn(aparecio + PROC_SYNC_TIMEOUT_MS);
  }, [proc, matches, keyStatus, avisar, tick]);

  /* ------------------------------------------------------------------ estado */
  const freeGb = disk && disk.drive_total_bytes > 0 ? gb(disk.free_bytes) : null;
  let capture: Capture;
  if (freeGb !== null && freeGb < DISK_LOW_GB) capture = { kind: "disk", freeGb };
  else if (audioOk === false) capture = { kind: "mute" };
  else if (isRecording) capture = { kind: "rec", since: recSince, hotkey };
  else if (proc || minimap) capture = { kind: "proc", pct: minimap ? minimap.pct : null };
  else if (keyStatus && keyStatus !== "ok") capture = { kind: "key", status: keyStatus };
  else capture = { kind: "ready" };

  return { capture, freeGb };
}

/* ========================================================================= */

/** Cronómetro de la grabación, con su propio tic para no repintar la app. */
const Chrono: React.FC<{ since: number }> = ({ since }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="u-time">{clock((now - since) / 1000)}</span>;
};

/**
 * La píldora con su espacio libre al lado. El estado vive AQUÍ y no en App: el
 * progreso del procesado y los sondeos repintan solo esta píldora, no la app
 * entera con el reproductor dentro.
 */
export const CaptureStatus: React.FC<{ isRecording: boolean }> = ({ isRecording }) => {
  const info = useCaptureStatus(isRecording);
  return <CapturePill info={info} />;
};

export const CapturePill: React.FC<{ info: CaptureInfo }> = ({ info }) => {
  const t = useT();
  const { lang } = useLang();
  const navigate = useNavigate();
  const { capture, freeGb } = info;

  const pill = (() => {
    switch (capture.kind) {
      case "disk":
        return (
          <button
            type="button"
            className="cap"
            data-tone="signal"
            onClick={() => navigate("/settings?cat=storage")}
            title={t("Below 1 GB free the recorder won't start. Free up space or change the folder.")}
          >
            <HardDrive size={14} color="var(--signal)" aria-hidden="true" />
            <span className="cap__main">
              {t("Disk almost full")} <span className="cap__sub">·</span>{" "}
              <span style={{ color: "var(--signal)", fontVariantNumeric: "tabular-nums" }}>
                {t("{n} GB", { n: formatGb(capture.freeGb, lang) })}
              </span>
            </span>
          </button>
        );
      case "mute":
        return (
          <span
            className="cap cap--tight"
            data-tone="gold"
            title={t("The recording goes on without game sound. Fix opens the audio diagnostics.")}
          >
            <VolumeOff size={14} color="var(--brand)" aria-hidden="true" />
            <span className="cap__main">{t("No game sound")}</span>
            <button type="button" className="cap__fix" onClick={() => navigate("/settings?cat=recording")}>
              {t("Fix")}
            </button>
          </span>
        );
      case "rec":
        return (
          <span
            className="cap"
            data-tone="signal"
            title={t("{key} saves the last 30 seconds.", { key: capture.hotkey })}
          >
            <span className="cap__dot cap__dot--rec" aria-hidden="true" />
            <span className="cap__main">
              {t("Recording")}
              {capture.since !== null && (
                <>
                  {" "}
                  <span className="cap__sub">·</span> <Chrono since={capture.since} />
                </>
              )}
            </span>
            <span className="cap__sep" aria-hidden="true" />
            <span className="cap__hint">
              <kbd className="u-kbd">{capture.hotkey}</kbd>
              {t("save replay")}
            </span>
          </span>
        );
      case "proc":
        return (
          <span
            className="cap"
            data-tone="gold"
            title={t("Syncing with Riot and analysing the video. You can keep using the app.")}
          >
            <span className="cap__main">
              {t("Processing the game")}
              {capture.pct !== null && (
                <>
                  {" "}
                  <span className="cap__sub">·</span>{" "}
                  <span className="cap__pct">{Math.round(capture.pct)} %</span>
                </>
              )}
            </span>
            <span
              className={capture.pct === null ? "cap__bar cap__bar--indet" : "cap__bar"}
              role="progressbar"
              aria-label={t("Processing the game")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={capture.pct === null ? undefined : Math.round(capture.pct)}
            >
              <span style={capture.pct === null ? undefined : { width: `${capture.pct}%` }} />
            </span>
          </span>
        );
      case "key":
        return (
          <span
            className="cap cap--tight"
            data-tone="gold"
            title={t("Without a working key there is no scoreboard, rank or impact.")}
          >
            <KeyRound size={14} color="var(--brand)" aria-hidden="true" />
            <span className="cap__main">
              {capture.status === "missing"
                ? t("No Riot key")
                : capture.status === "expired"
                  ? t("Riot key expired")
                  : t("Riot key rejected")}
            </span>
            <button type="button" className="cap__fix" onClick={() => navigate("/settings?cat=account")}>
              {t("Fix")}
            </button>
          </span>
        );
      default:
        return (
          <span className="cap" title={t("Recording starts by itself when a game begins.")}>
            <span className="cap__dot cap__dot--ready" aria-hidden="true" />
            <span className="cap__main">{t("Ready to record")}</span>
            <span className="cap__sub">· {t("starts when a game begins")}</span>
          </span>
        );
    }
  })();

  return (
    <>
      {/* `key` fuerza el fundido de entrada al cambiar de estado. */}
      <span role="status" aria-live="polite" style={{ display: "contents" }} key={capture.kind}>
        {pill}
      </span>
      {freeGb !== null && capture.kind !== "disk" && (
        <span className="titlebar__free">{t("{n} GB free", { n: formatGb(freeGb, lang) })}</span>
      )}
    </>
  );
};
