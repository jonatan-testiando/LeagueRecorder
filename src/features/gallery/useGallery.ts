import { useState, useEffect, useCallback, useRef } from "react";
import { MatchMetadata } from "../../types";
import { useDialog } from "../../components/ui/DialogProvider";
import { getRecordedMatches, deleteMatch as deleteMatchIpc, getRecorderStatus } from "../../core/tauri-ipc";

export const useGallery = () => {
  const [matches, setMatches] = useState<MatchMetadata[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<MatchMetadata | null>(null);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const { showConfirm, showError } = useDialog();

  const fetchMatches = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await getRecordedMatches();
      setMatches(data);
      
      // Si la partida seleccionada ya no existe (por ejemplo, tras borrarse), deseleccionarla
      if (selectedMatch) {
        if (!selectedMatch.id.startsWith("vod_")) {
          const stillExists = data.some(m => m.id === selectedMatch.id);
          if (!stillExists) {
            setSelectedMatch(null);
          }
        }
      }
    } catch (err) {
      setError(err as string);
    } finally {
      setIsLoading(false);
    }
  }, [selectedMatch]);

  const checkStatus = useCallback(async () => {
    try {
      const status = await getRecorderStatus();
      setIsRecording(status);
    } catch {
      // Ignorar errores de polling de status
    }
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    const isConfirmed = await showConfirm({
      title: "Eliminar partida",
      message: "¿Estás seguro de que quieres borrar esta grabación? Se eliminarán permanentemente el video y los eventos.",
      confirmText: "Eliminar",
      cancelText: "Cancelar",
      type: "error"
    });
    
    if (isConfirmed) {
      try {
        await deleteMatchIpc(id);
        await fetchMatches();
      } catch (err) {
        showError("Error al borrar la partida: " + err);
      }
    }
  }, [showConfirm, showError]);

  useEffect(() => {
    fetchMatches();
    checkStatus();

    // El estado de la grabadora es barato (un bool en memoria): lo consultamos
    // seguido para que el indicador de "grabando" responda al instante.
    const statusInterval = setInterval(checkStatus, 5000);

    // La lista de partidas SÍ es cara de refrescar (lee los JSON de todas las
    // partidas). Como una partida dura ~30 min, basta con refrescarla cada 5 min.
    // Además, la refrescamos al instante cuando termina una grabación (efecto de
    // abajo), así que no perdemos la utilidad de ver la partida nueva enseguida.
    const listInterval = setInterval(() => {
      getRecordedMatches().then(setMatches).catch(() => {});
    }, 5 * 60 * 1000);

    return () => {
      clearInterval(statusInterval);
      clearInterval(listInterval);
    };
  }, [fetchMatches, checkStatus]);

  // Refresco inmediato de la lista cuando una grabación pasa de activa a inactiva
  // (acaba de terminar una partida): así la nueva grabación aparece al momento
  // sin necesidad de pollear la lista con frecuencia.
  const prevRecording = useRef(false);
  useEffect(() => {
    if (prevRecording.current && !isRecording) {
      getRecordedMatches().then(setMatches).catch(() => {});
    }
    prevRecording.current = isRecording;
  }, [isRecording]);

  return {
    matches,
    selectedMatch,
    setSelectedMatch,
    isRecording,
    isLoading,
    error,
    refreshMatches: fetchMatches,
    deleteMatch: handleDelete
  };
};
