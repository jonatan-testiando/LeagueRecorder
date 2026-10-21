import React, { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { Swords } from "lucide-react";
import { useT } from "../core/LanguageProvider";
import { useToast } from "./ui/Toaster";
import { useChampSelect } from "../core/useChampSelect";
import { champSelectBringForward } from "../core/tauri-ipc";
import { bloqueoDeNavegacion } from "./PostGameFlow";

/** La ruta de la pantalla de la selección. */
export const CHAMP_SELECT_PATH = "/champ-select";

/**
 * Lo que pasa al entrar en la selección de campeón, como `PostGameFlow` al
 * acabar la partida. Una vez por selección:
 *
 *  - La app se pone delante SIN quitarle el teclado a nadie
 *    (`champ_select_bring_forward`). Si taparía la ventana que estás usando
 *    (el cliente, con un solo monitor), no se sube: parpadea en la barra de
 *    tareas.
 *  - Abre la pantalla de la selección, salvo que se esté viendo otra cosa en
 *    la app (Training, el reproductor delante, un vídeo sonando): ahí deja un
 *    aviso con «Abrir».
 *  - Al acabar la selección (empieza la partida o alguien se sale) vuelve a
 *    donde estabas, si fue ella la que te trajo y no te has movido.
 *
 * Nada de esto pasa en el juego: la selección es en el cliente, antes de la
 * partida (memoria «sin-overlays-en-partida»). No pinta nada por sí mismo.
 */
export const ChampSelectFlow: React.FC = () => {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast, dismiss } = useToast();
  const { session, view } = useChampSelect();

  const path = useRef(location.pathname);
  path.current = location.pathname;
  /** De dónde se vino, si fue la selección la que trajo hasta aquí. */
  const vuelta = useRef<string | null>(null);
  const aviso = useRef<string | null>(null);

  useEffect(() => {
    if (session === 0) return;
    const abrir = () => {
      if (!path.current.startsWith(CHAMP_SELECT_PATH)) navigate(CHAMP_SELECT_PATH);
    };
    if (!path.current.startsWith(CHAMP_SELECT_PATH)) {
      if (bloqueoDeNavegacion(path.current, "") === null) {
        vuelta.current = path.current;
        abrir();
      } else {
        aviso.current = toast({
          tone: "info",
          title: t("Champion select"),
          media: <Swords size={20} aria-hidden="true" />,
          note: t("Your record against your lane opponent, your pool and your plan."),
          action: { label: t("Open"), onClick: abrir },
          secondary: { label: t("Later"), onClick: () => {} },
          duration: 0,
        });
      }
    }
    void (async () => {
      try {
        const r = await champSelectBringForward();
        if (r === "raised" || r === "front") return;
        const w = getCurrentWindow();
        if (!(await w.isFocused())) await w.requestUserAttention(UserAttentionType.Informational);
      } catch (e) {
        console.error(e);
      }
    })();
    // Solo al empezar una selección: las elecciones de dentro no cuentan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    if (view !== null) return;
    if (aviso.current) {
      dismiss(aviso.current);
      aviso.current = null;
    }
    const a = vuelta.current;
    vuelta.current = null;
    if (a && path.current.startsWith(CHAMP_SELECT_PATH)) navigate(a);
  }, [view, dismiss, navigate]);

  return null;
};
