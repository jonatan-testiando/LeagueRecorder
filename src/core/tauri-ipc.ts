import { invoke } from "@tauri-apps/api/core";
import { MatchMetadata, AudioStatus, VideoSettings, Comment } from "../types";

export const getRecordedMatches = async (): Promise<MatchMetadata[]> => {
  return await invoke<MatchMetadata[]>("get_recorded_matches");
};

export const deleteMatch = async (id: string): Promise<void> => {
  return await invoke<void>("delete_match", { id });
};

export const getRecorderStatus = async (): Promise<boolean> => {
  return await invoke<boolean>("get_recorder_status");
};

export const getAudioStatus = async (): Promise<AudioStatus> => {
  return await invoke<AudioStatus>("get_audio_status");
};

export const startManualRecording = async (id: string): Promise<string> => {
  return await invoke<string>("start_manual_recording", { id });
};

export const stopManualRecording = async (): Promise<void> => {
  return await invoke<void>("stop_manual_recording");
};

export const getVideoSettings = async (): Promise<VideoSettings> => {
  return await invoke<VideoSettings>("get_video_settings");
};

export const setVideoSettings = async (fps: number, quality: string): Promise<VideoSettings> => {
  return await invoke<VideoSettings>("set_video_settings", { fps, quality });
};

export interface ErrorEvent {
  id: string;
  time: number;
  text: string;
  category: string;
}

export interface ErrorClipMetadata {
  path: string;
  name: string;
  match_id: string;
  size: number;
  note: string;
  events: ErrorEvent[];
  /**
   * Segundo del vídeo de origen en que empieza el recorte. Ausente en los clips
   * exportados antes de que se guardara: hasta entonces la posición se perdía al
   * exportar, así que un error marcado no podía volver a la línea de tiempo.
   */
  start_time?: number;
  /** Marcado como visto en la cola de revisión. */
  reviewed?: boolean;
}

export const exportErrorClip = async (matchId: string, videoPath: string, startTime: number, duration: number, note: string): Promise<string> => {
  return await invoke<string>("export_error_clip", { matchId, videoPath, startTime, duration, note });
};

export const getAllErrorClips = async (): Promise<ErrorClipMetadata[]> => {
  return await invoke<ErrorClipMetadata[]>("get_all_error_clips");
};

export const updateErrorNote = async (path: string, note: string): Promise<void> => {
  return await invoke<void>("update_error_note", { path, note });
};

export const addErrorEvent = async (path: string, time: number, text: string, category: string): Promise<string> => {
  return await invoke<string>("add_error_event", { path, time, text, category });
};

export const deleteErrorEvent = async (path: string, eventId: string): Promise<void> => {
  return await invoke<void>("delete_error_event", { path, eventId });
};

export const editErrorEvent = async (path: string, eventId: string, text: string, category: string): Promise<void> => {
  return await invoke<void>("edit_error_event", { path, eventId, text, category });
};

export const toggleClipFavorite = async (path: string): Promise<boolean> => {
  return await invoke<boolean>("toggle_clip_favorite", { path });
};

export interface AppConfig {
  save_directory: string;
  riot_api_key: string;
  auto_dataset_generator: boolean;
  max_storage_gb: number;
  auto_prune_days: number;
  /** Idioma de la interfaz: "en" o "es". Se guarda en disco. */
  language: string;
}

export const getAppConfig = async (): Promise<AppConfig> => {
  return await invoke<AppConfig>("get_app_config");
};

export const setAppConfig = async (saveDirectory: string, riotApiKey: string, autoDatasetGenerator: boolean, maxStorageGb: number, autoPruneDays: number, language: string = "en"): Promise<void> => {
  return await invoke<void>("set_app_config", { saveDirectory, riotApiKey, autoDatasetGenerator, maxStorageGb, autoPruneDays, language });
};

export interface ProcessVodResponse {
  success: boolean;
  message: string;
  metadata: any | null;
}

export const processVod = async (videoPath: string): Promise<ProcessVodResponse> => {
  return await invoke<ProcessVodResponse>("process_vod", { videoPath });
};

export const cancelVod = async (): Promise<void> => {
  return await invoke<void>("cancel_vod");
};

// Detalle completo de una partida/VOD (incluye mouse_events). El listado los
// omite por rendimiento; el reproductor los pide aquí bajo demanda.
export const getMatchDetails = async (id: string): Promise<MatchMetadata | null> => {
  return await invoke<MatchMetadata | null>("get_match_details", { id });
};

// Persiste los comentarios (con marca de tiempo) de una partida en su JSON.
export const saveMatchComments = async (matchId: string, comments: Comment[]): Promise<void> => {
  return await invoke<void>("save_match_comments", { matchId, comments });
};

// Rellena el scoreboard (10 jugadores) de una partida ya sincronizada con Riot.
export const syncMatchNow = async (matchId: string): Promise<MatchMetadata> => {
  return await invoke<MatchMetadata>("sync_match_now", { matchId });
};

// Comprueba la clave de Riot ya guardada. Resuelve si sirve, y rechaza con el
// motivo si no.
export const checkRiotKey = async (): Promise<void> => {
  return await invoke<void>("check_riot_key");
};

// Una muerte concreta y lo que costó en tiempo fuera de la partida.
export interface DeathCost {
  minute: number;
  seconds_dead: number;
}

// Reparto de crédito de un jugador. `killing_blow_gold` es lo que ve un KDA (oro
// de kills por rematar); `damage_credit_gold` es ese mismo oro repartido por el
// daño que puso cada uno, y `credit_gap` la diferencia entre ambos.
export interface PlayerCredit {
  participant_id: number;
  champion: string;
  team_id: number;
  kills: number;
  deaths: number;
  assists: number;
  killing_blow_gold: number;
  damage_credit_gold: number;
  credit_gap: number;
  /** Oro de objetivos y estructuras que le corresponde. */
  objective_gold: number;
  /** Asesinatos + objetivos: el primer numero unico por jugador. */
  total_value: number;
  /** Probabilidad de victoria aportada. La moneda comun: sabe que una torre en
   *  el minuto 30 vale mas que la misma torre en el 10. */
  wpa: number;
  /** De donde salio ese WPA. Las cuatro partes suman `wpa`: un puesto no dice
   *  nada, pero "aportaste mucho y moriste mucho" si. */
  wpa_kills: number;
  wpa_objectives: number;
  wpa_structures: number;
  /** Lo que costaron tus muertes. Nunca positivo. */
  wpa_deaths: number;
  /** Puesto: TOP, JUNGLE, MIDDLE, BOTTOM, UTILITY. */
  role: string;
  /** Percentil de su WPA dentro de su rol (0-100). El unico numero comparable
   *  entre puestos: el techo de un support es mas bajo que el de un carry. */
  role_percentile: number;
  death_gold_given: number;
  time_dead: number;
  deaths_detail: DeathCost[];
  damage_participation: number;
  mean_damage_share: number;
}

// Reparto de crédito de los 10 jugadores. Tira de caché en disco: tras la primera
// vez no gasta cuota de la API.
export const getMatchAttribution = async (matchId: string): Promise<PlayerCredit[]> => {
  return await invoke<PlayerCredit[]>("get_match_attribution", { matchId });
};

// Un tramo con más rivales encima que aliados, y lo que el equipo sacó lejos de
// allí mientras tanto. `start`/`end` van en segundos del VÍDEO, no de la partida.
export interface PressureWindow {
  participant_id: number;
  champion: string;
  start: number;
  end: number;
  /** Suma de confianzas, así que puede ser 3.4: la posición no es certeza. */
  max_enemies: number;
  x: number;
  y: number;
  /** Carril en el que te sujetaron: "top", "mid", "bot" — o null si fue lejos
   *  de los tres (jungla profunda, base). */
  lane: string | null;
  died: boolean;
  gold_elsewhere: number;
  /** Probabilidad de victoria que tu equipo gano lejos de ti. Se ENSENA aparte,
   *  no se suma al wpa del jugador: los que ejecutaron ya la tienen. */
  wpa_elsewhere: number;
  towers_elsewhere: number;
  inhibs_elsewhere: number;
  plates_elsewhere: number;
  epics_elsewhere: number;
  /** Si los limites se afinaron con el video. Si es false, la duracion es una
   *  cota inferior: la API solo da una posicion por minuto. */
  from_video: boolean;
}

// Pide que se procese el video de la partida para sacar posiciones densas del
// minimapa (dos por segundo, frente a una por minuto de la API). Vuelve
// enseguida: el trabajo va por detras y tarda ~2 min.
export const processMatchMinimap = async (matchId: string): Promise<void> => {
  return await invoke<void>("process_match_minimap", { matchId });
};

/** El carril que peor miras, mirando toda la biblioteca. */
export interface BlindSpot {
  lane: string;
  /** Partidas con datos de miradas. */
  games: number;
  /** En cuantas de ellas ESE carril fue el mas desatendido. */
  games_worst: number;
  avg_gap_secs: number;
  worst_gap_secs: number;
  worst_match_id: string;
}

/** null hasta que haya una partida grabada aqui con miradas. */
export const getBlindSpot = async (): Promise<BlindSpot | null> => {
  return await invoke<BlindSpot | null>("get_blind_spot");
};

/** Una mirada con el carril al que fue. */
export interface CameraLook {
  t: number;
  /** "top" | "mid" | "bot", o null si fue lejos de los tres o no se sabe. */
  lane: string | null;
}

export const getCameraLooks = async (matchId: string): Promise<CameraLook[]> => {
  return await invoke<CameraLook[]>("get_camera_looks", { matchId });
};

/** Cuanto miraste cada carril y cuanto lo tuviste desatendido. */
export interface ZoneStat {
  /** "top", "mid" o "bot". */
  key: string;
  looks: number;
  per_minute: number;
  /** El rato mas largo sin mirar ESE carril. */
  longest_gap_secs: number;
}

/** Vacio en los VODs importados: ahi se sabe que la camara salto, no adonde. */
export const getCameraZones = async (matchId: string): Promise<ZoneStat[]> => {
  return await invoke<ZoneStat[]>("get_camera_zones", { matchId });
};

/** En que punto esta el procesado del video de una partida. */
export type MinimapState = "hecha" | "en_curso" | "falta" | "no_disponible";

export interface MinimapStatus {
  state: MinimapState;
  /** 0-100 de lo ya calculado en pasadas anteriores, si quedo a medias. */
  saved_progress: number | null;
}

export const getMinimapStatus = async (matchId: string): Promise<MinimapStatus> => {
  return await invoke<MinimapStatus>("get_minimap_status", { matchId });
};

/** Para el procesado. Lo calculado se conserva y la siguiente pasada lo retoma. */
export const cancelMatchMinimap = async (matchId: string): Promise<void> => {
  return await invoke<void>("cancel_match_minimap", { matchId });
};

export const getMatchPressure = async (matchId: string): Promise<PressureWindow[]> => {
  return await invoke<PressureWindow[]>("get_match_pressure", { matchId });
};

// Marca o desmarca un suceso como revisado. El estado vive en el JSON de la
// partida, junto a los comentarios: revisar es una tarea con estado y tiene que
// sobrevivir a cerrar la app.
export const setEventReviewed = async (
  matchId: string,
  time: number,
  reviewed: boolean
): Promise<void> => {
  return await invoke<void>("set_event_reviewed", { matchId, time, reviewed });
};

// Marca o desmarca un clip de error como revisado. Vive en el JSON del clip y no
// en el de la partida porque un error marcado no es un suceso de la partida.
export const setErrorClipReviewed = async (
  path: string,
  reviewed: boolean
): Promise<void> => {
  return await invoke<void>("set_error_clip_reviewed", { path, reviewed });
};
