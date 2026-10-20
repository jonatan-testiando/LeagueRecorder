import React, { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { Play } from "lucide-react";
import { useT } from "../core/LanguageProvider";
import { useToast, type ToastOptions } from "./ui/Toaster";
import { ChampionAvatar } from "./ChampionAvatar";
import { useAppStore } from "../store/useAppStore";
import { formatDuration, outcome } from "../core/matchStats";
import { reviewProgress } from "../core/review";
import type { PostGameEvent } from "../core/tauri-ipc";
import type { MatchMetadata } from "../types";

/**
 * Lo que pasa al acabar una partida, sin que el usuario tenga que ir a buscarla.
 *
 * El backend emite `post_game` dos veces: al guardar la partida (`analyzing`) y
 * al terminar la sincronización con Riot, que es también su análisis (`ready`).
 * Aquí eso se convierte en:
 *
 *  - Un aviso de progreso, «Analizando tu última partida…», que cambia en su
 *    sitio a «Lista: abriéndola» (o al fallo, con su motivo).
 *  - Atención en la barra de tareas (informativa: parpadea hasta que la
 *    ventana tiene el foco, no roba nada).
 *  - La partida abierta en Biblioteca. **Salvo** que se esté viendo otra cosa:
 *    un vídeo sonando, el reproductor de otra partida delante, o Training. Ahí
 *    el aviso lleva «Abrir» y se queda hasta que se decide. Es el
 *    `blockNavigation` de iTero: arrancarle a alguien el vídeo que está viendo
 *    por una partida que puede esperar es peor que no avisar.
 *
 * No pinta nada por sí mismo. Se monta una vez, dentro del router.
 */

type Fase = "analyzing" | "ready";

/** Partidas de las que se ha oído `post_game`, y en qué fase. `CaptureStatus`
 *  lo mira para no repetir su propio aviso de «Partida guardada». */
const fases = new Map<string, Fase>();
export const postGameStage = (matchId: string): Fase | undefined => fases.get(matchId);

/** ¿Suena algún vídeo? Los paneles ocultos siguen montados, y un vídeo con
 *  `display: none` sigue sonando: también cuenta. */
function videoSonando(): boolean {
  return Array.from(document.querySelectorAll("video")).some(
    (v) => !v.paused && !v.ended && v.readyState > 2
  );
}

export type Bloqueo = "training" | "player" | "video";

/**
 * Por qué no se abre sola la partida `matchId`, o `null` si se puede.
 *
 * «Reproductor abierto» es lo mismo que pliega el rail en `App`: un
 * reproductor DELANTE. Uno que se quedó abierto en otra pestaña se sustituye
 * sin más; lo que no se hace es cambiarle a alguien lo que está mirando.
 */
export function bloqueoDeNavegacion(path: string, matchId: string): Bloqueo | null {
  if (path.startsWith("/training")) return "training";
  const s = useAppStore.getState();
  const reproductor =
    (path.startsWith("/review") && !!s.selectedMatch && s.selectedMatch.id !== matchId) ||
    (path.startsWith("/vod") && !!s.selectedVod) ||
    (path.startsWith("/errors") && !!s.selectedError);
  if (reproductor) return "player";
  if (videoSonando()) return "video";
  return null;
}

export const PostGameFlow: React.FC = () => {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast, update, dismiss } = useToast();
  const refreshMatches = useAppStore((s) => s.refreshMatches);
  const setSelectedMatch = useAppStore((s) => s.setSelectedMatch);

  // La ruta de AHORA, no la del render en que se suscribió el listener.
  const path = useRef(location.pathname);
  path.current = location.pathname;

  /** Aviso de progreso de cada partida, para cambiarlo en su sitio. */
  const avisos = useRef(new Map<string, string>());
  /** Los eventos se atienden en fila: sin clave, `ready` llega a la vez que
   *  `analyzing`, y si se adelantara quedaría un «Analizando…» huérfano. */
  const cola = useRef<Promise<void>>(Promise.resolve());
  /** Hay un parpadeo pedido en la barra de tareas. */
  const atencion = useRef(false);

  /* ----------------------------------------------- atención en la barra */
  const pedirAtencion = useCallback(async () => {
    try {
      const w = getCurrentWindow();
      if (await w.isFocused()) return;
      await w.requestUserAttention(UserAttentionType.Informational);
      atencion.current = true;
    } catch (e) {
      console.error(e);
    }
  }, []);

  // Windows ya deja de parpadear al tomar el foco; se retira igualmente para
  // no depender de eso en otras plataformas.
  useEffect(() => {
    const w = getCurrentWindow();
    const stop = w.onFocusChanged(({ payload: enfocada }) => {
      if (enfocada && atencion.current) {
        atencion.current = false;
        w.requestUserAttention(null).catch(() => {});
      }
    });
    return () => {
      stop.then((f) => f()).catch(() => {});
    };
  }, []);

  /* ----------------------------------------------------------- avisos */
  const abrir = useCallback(
    (id: string) => {
      const m = useAppStore.getState().matches.find((x) => x.id === id);
      if (!m) return;
      setSelectedMatch(m);
      navigate("/review");
    },
    [navigate, setSelectedMatch]
  );

  /** Retrato, línea de resultado y momentos por revisar: lo que dice de QUÉ
   *  partida se habla. */
  const partes = useCallback(
    (m: MatchMetadata | undefined): Pick<ToastOptions, "media" | "body"> => {
      if (!m) return {};
      const res = outcome(m.result);
      const color =
        res === "victory" ? "var(--win)" : res === "defeat" ? "var(--loss)" : "var(--faint)";
      return {
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
            {m.champion} ·{" "}
            <span style={{ color }}>
              {t(res === "victory" ? "Victory" : res === "defeat" ? "Defeat" : "No result")}
            </span>{" "}
            · {formatDuration(m.game_duration)}
          </>
        ),
      };
    },
    [t]
  );

  const momentos = useCallback(
    (m: MatchMetadata): string | undefined => {
      const prog = reviewProgress(m, useAppStore.getState().errorClips);
      const n = Math.max(0, prog.total - prog.done);
      if (n === 0) return undefined;
      return n === 1 ? t("1 moment ready to review") : t("{n} moments ready to review", { n });
    },
    [t]
  );

  const motivo = useCallback(
    (ev: PostGameEvent): string => {
      switch (ev.reason) {
        case "no_tag":
          return t("Your Riot ID has no tag (#EUW, #LAN…), so Riot can't find the game.");
        case "not_published":
          return t("Riot hasn't published it yet.");
        case "not_found":
          return t("Your Riot ID isn't among the ten players.");
        default:
          return ev.detail || t("Riot didn't answer.");
      }
    },
    [t]
  );

  const atender = useCallback(
    async (ev: PostGameEvent) => {
      const id = ev.match_id;
      fases.set(id, ev.stage);
      // La partida recién escrita (al guardar) o ya con los datos de Riot.
      await refreshMatches().catch(() => {});
      const m = useAppStore.getState().matches.find((x) => x.id === id);

      if (ev.stage === "analyzing") {
        avisos.current.set(
          id,
          toast({
            tone: "info",
            title: t("Analysing your last game…"),
            ...partes(m),
            note: t("Waiting for Riot's game data."),
            progress: true,
            duration: 0,
          })
        );
        return;
      }

      const previo = avisos.current.get(id);
      avisos.current.delete(id);
      const mostrar = (o: ToastOptions) => (previo ? update(previo, o) : toast(o));
      if (!m) {
        // Borrada mientras se analizaba: no hay nada que abrir.
        if (previo) dismiss(previo);
        return;
      }
      const res = outcome(m.result);
      const abrirAccion = {
        label: t("Open"),
        icon: <Play size={11} fill="currentColor" aria-hidden="true" />,
        onClick: () => abrir(id),
      };

      if (ev.status === "ok") {
        const bloqueo = bloqueoDeNavegacion(path.current, id);
        if (!bloqueo) {
          abrir(id);
          mostrar({
            tone: res === "victory" ? "success" : "info",
            title: t("Ready: opening it"),
            meta: t("now"),
            ...partes(m),
            note: momentos(m),
          });
        } else {
          // Se queda hasta que se decide: quien está viendo un vídeo puede
          // tardar en mirar la esquina.
          mostrar({
            tone: res === "victory" ? "success" : "info",
            title: t("Your last game is ready"),
            meta: t("now"),
            ...partes(m),
            note: momentos(m),
            action: abrirAccion,
            secondary: { label: t("Later"), onClick: () => {} },
            duration: 0,
          });
        }
        void pedirAtencion();
        return;
      }

      if (ev.reason === "no_key") {
        // Sin clave es lo de siempre, no un fallo de esta partida: guardada,
        // con vídeo y eventos, y la píldora de la barra ya dice cómo arreglarlo.
        mostrar({
          tone: "info",
          title: t("Game saved"),
          meta: t("now"),
          ...partes(m),
          note: t("Without a working key there is no scoreboard, rank or impact."),
          action: abrirAccion,
          secondary: { label: t("Later"), onClick: () => {} },
          duration: 15_000,
        });
        return;
      }

      mostrar({
        tone: "warning",
        title: t("Your last game was saved without Riot's analysis"),
        ...partes(m),
        note: motivo(ev),
        action: abrirAccion,
        secondary: { label: t("Later"), onClick: () => {} },
        duration: 0,
      });
    },
    [abrir, dismiss, momentos, motivo, partes, pedirAtencion, refreshMatches, t, toast, update]
  );

  useEffect(() => {
    const stop = listen<PostGameEvent>("post_game", (e) => {
      cola.current = cola.current.then(() => atender(e.payload)).catch(console.error);
    });
    return () => {
      stop.then((f) => f()).catch(() => {});
    };
  }, [atender]);

  return null;
};
