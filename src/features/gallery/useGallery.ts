import { useState, useEffect, useCallback } from "react";
import { MatchMetadata } from "../../types";
import { getRecordedMatches, deleteMatch, getRecorderStatus } from "../../core/tauri-ipc";

export const useGallery = () => {
  const [matches, setMatches] = useState<MatchMetadata[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<MatchMetadata | null>(null);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMatches = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await getRecordedMatches();
      setMatches(data);
      
      // Si la partida seleccionada ya no existe (por ejemplo, tras borrarse), deseleccionarla
      if (selectedMatch) {
        const stillExists = data.some(m => m.id === selectedMatch.id);
        if (!stillExists) {
          setSelectedMatch(null);
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

  const handleDelete = async (id: string) => {
    if (confirm("¿Estás seguro de que quieres borrar esta grabación? Se eliminarán permanentemente el video y los eventos.")) {
      try {
        await deleteMatch(id);
        await fetchMatches();
      } catch (err) {
        alert("Error al borrar la partida: " + err);
      }
    }
  };

  useEffect(() => {
    fetchMatches();
    checkStatus();

    // Polling cada 3 segundos para el estado de la grabadora y refrescar la lista si hay nuevas partidas
    const interval = setInterval(() => {
      checkStatus();
      // Refrescar lista de partidas en background para ver si terminó una grabación automática
      getRecordedMatches().then(data => {
        setMatches(data);
      }).catch(() => {});
    }, 3000);

    return () => clearInterval(interval);
  }, [fetchMatches, checkStatus]);

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
