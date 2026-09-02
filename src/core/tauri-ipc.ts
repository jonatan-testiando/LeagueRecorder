import { invoke } from "@tauri-apps/api/core";
import { MatchMetadata, AudioStatus, VideoSettings, Comment } from "../types";

export const getRecordedMatches = async (): Promise<MatchMetadata[]> => {
  return await invoke<MatchMetadata[]>("get_recorded_matches");
};

export const deleteMatch = async (id: string): Promise<void> => {
  return await invoke<void>("delete_match", { id });
};

/** Borrado por lotes en una sola llamada. Devuelve los ids que fallaron. */
export const deleteMatches = async (ids: string[]): Promise<string[]> => {
  return await invoke<string[]>("delete_matches", { ids });
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

/** `resolution` es opcional: omitirlo deja la que ya estuviera guardada. */
export const setVideoSettings = async (
  fps: number,
  quality: string,
  resolution?: VideoSettings["resolution"]
): Promise<VideoSettings> => {
  return await invoke<VideoSettings>("set_video_settings", { fps, quality, resolution });
};

export interface DiskSpaceInfo {
  /** Lo que ocupa la carpeta de grabaciones. */
  used_bytes: number;
  /** La CUOTA configurada en ajustes, no el tamaño del disco. */
  total_bytes: number;
  /** Bytes libres reales del volumen donde se graba. 0 si no se pudo consultar. */
  free_bytes: number;
  /** Capacidad total de ese volumen. 0 si no se pudo consultar. */
  drive_total_bytes: number;
}

export const getDiskUsage = async (): Promise<DiskSpaceInfo> => {
  return await invoke<DiskSpaceInfo>("get_disk_usage");
};

/** Atajos globales. Se guardan en su propio fichero (`hotkeys.json`). */
export interface HotkeyConfig {
  /** Tecla que guarda los últimos 30 s del replay buffer. Por defecto "F8". */
  replay: string;
}

export const getHotkeys = async (): Promise<HotkeyConfig> => {
  return await invoke<HotkeyConfig>("get_hotkeys");
};

/** Rechaza si la tecla no se reconoce (letras, dígitos y F1–F12). */
export const setHotkeys = async (replay: string): Promise<HotkeyConfig> => {
  return await invoke<HotkeyConfig>("set_hotkeys", { replay });
};

/**
 * Aviso de la grabadora. Llega por el evento `recorder_alert`, que el backend
 * emite cuando una grabación no arranca, se muere sola, el disco se queda sin
 * sitio o se guarda (o falla) un clip del replay buffer.
 */
export interface RecorderAlert {
  kind:
    | "start_failed"
    | "stopped_unexpectedly"
    | "disk_low"
    | "disk_full"
    | "replay_saved"
    | "replay_failed";
  message: string;
  /** Motivo técnico, o la ruta del clip en `replay_saved`. */
  detail?: string;
}

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

/**
 * Edita una nota de un clip de error.
 *
 * `time` es opcional: omitirlo deja el instante como estaba. Mover una nota ya
 * no exige borrarla y volver a crearla (lo que le cambiaba el id).
 */
export const editErrorEvent = async (
  path: string,
  eventId: string,
  text: string,
  category: string,
  time?: number
): Promise<void> => {
  return await invoke<void>("edit_error_event", { path, eventId, text, category, time });
};

/** Borra un clip de error y su JSON (nota y sucesos marcados incluidos). */
export const deleteErrorClip = async (path: string): Promise<void> => {
  return await invoke<void>("delete_error_clip", { path });
};

export const toggleClipFavorite = async (path: string): Promise<boolean> => {
  return await invoke<boolean>("toggle_clip_favorite", { path });
};

/** Borra un recorte y su JSON de al lado (con él se va el estado de favorito). */
export const deleteClip = async (path: string): Promise<void> => {
  return await invoke<void>("delete_clip", { path });
};

/**
 * Progreso de una subida, evento `clip_upload_progress`.
 *
 * `path` dice de qué clip se habla (puede haber varias subidas a la vez) y
 * `total` viaja en cada aviso, así que entrar a mitad de subida basta para
 * pintar el porcentaje.
 */
export interface UploadProgress {
  path: string;
  sent: number;
  total: number;
}

export interface AppConfig {
  save_directory: string;
  riot_api_key: string;
  auto_dataset_generator: boolean;
  max_storage_gb: number;
  auto_prune_days: number;
  /** Idioma de la interfaz: "en" o "es". Se guarda en disco. */
  language: string;
  /** Tamaño del minimapa respecto al estándar (1.0). Calibra la detección de
   *  clics de minimapa cuando League corre con la interfaz reescalada. */
  minimap_scale: number;
  /** Plataforma de Riot ("la1", "euw1", "kr"…) o "auto" para sondearla. */
  riot_platform: string;
  /** La sondeada con "auto". Solo lectura desde la UI: la escribe el backend. */
  riot_platform_detected: string;
  /** Proxy que pone la clave de Riot por el usuario. Vacío = clave propia. */
  riot_proxy_url: string;
  /** Si el asistente de primer arranque ya se completó. */
  onboarding_done: boolean;
  /**
   * Carpeta espejo donde se copia el JSON de cada partida al guardarlo. Vacío =
   * desactivado. Apuntándola a OneDrive/Drive se obtiene copia en la nube: sólo
   * viajan los metadatos (notas, comentarios, revisados), nunca los vídeos.
   */
  backup_mirror_dir: string;
}

/** Las plataformas que acepta el backend, con su etiqueta para la UI. */
export const RIOT_PLATFORMS: { code: string; label: string }[] = [
  { code: "la1", label: "LAN" },
  { code: "la2", label: "LAS" },
  { code: "na1", label: "NA" },
  { code: "br1", label: "BR" },
  { code: "euw1", label: "EUW" },
  { code: "eun1", label: "EUNE" },
  { code: "tr1", label: "TR" },
  { code: "ru", label: "RU" },
  { code: "kr", label: "KR" },
  { code: "jp1", label: "JP" },
  { code: "oc1", label: "OCE" },
  { code: "ph2", label: "PH" },
  { code: "sg2", label: "SG" },
  { code: "th2", label: "TH" },
  { code: "tw2", label: "TW" },
  { code: "vn2", label: "VN" },
  { code: "me1", label: "ME" },
];

/** "euw1" → "EUW". Devuelve el propio código si no está en la lista. */
export const platformLabel = (code: string): string =>
  RIOT_PLATFORMS.find((p) => p.code === code)?.label ?? code.toUpperCase();

export const getAppConfig = async (): Promise<AppConfig> => {
  return await invoke<AppConfig>("get_app_config");
};

/**
 * Guarda SOLO los campos que se pasen.
 *
 * Era posicional y con siete argumentos: quien olvidaba uno lo reseteaba sin
 * enterarse (así se perdía la calibración del minimapa al cambiar de idioma).
 * Con un parche, lo que no se menciona no se toca.
 */
export const setAppConfig = async (patch: Partial<AppConfig>): Promise<void> => {
  return await invoke<void>("set_app_config", { patch });
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

/** El hueco ciego por carril de UNA partida, para la tendencia de Patrones. */
export interface ZoneHistoryRow {
  match_id: string;
  date: string;
  /** [top, mid, bot], en segundos. */
  gaps: [number, number, number];
  looks: [number, number, number];
}

export const getCameraZoneHistory = async (): Promise<ZoneHistoryRow[]> => {
  return await invoke<ZoneHistoryRow[]>("get_camera_zone_history");
};

/** Lo que compró tu presencia, sumado entre partidas (sólo caché de Riot). */
export interface PressureSummary {
  games: number;
  windows: number;
  wpa: number;
  towers: number;
  gold: number;
}

export const getPressureSummary = async (): Promise<PressureSummary> => {
  return await invoke<PressureSummary>("get_pressure_summary");
};

/** Una ranked de la TEMPORADA (grabada o no), resumida para la forma reciente. */
export interface SeasonGame {
  riot_match_id: string;
  win: boolean;
  champion: string;
  kills: number;
  deaths: number;
  assists: number;
  game_end_ms: number;
  /** Nota de rendimiento 0–100 dentro del lobby de esa partida. */
  score: number;
}

/** La forma de la cuenta: últimos ranked, rango actual y LP medios por partida. */
export interface SeasonForm {
  games: SeasonGame[];
  tier: string | null;
  division: string | null;
  lp: number | null;
  avg_gain: number | null;
  avg_loss: number | null;
}

export const getSeasonForm = async (): Promise<SeasonForm> => {
  return await invoke<SeasonForm>("get_season_form");
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

// ---------------------------------------------------------------------------
// Baremos de población
// ---------------------------------------------------------------------------

/**
 * Una métrica tuya al lado de la población de tu rango y tu puesto.
 *
 * `percentile` es SIEMPRE el crudo, también donde lo bueno es tener menos: en
 * `deaths_per_game` un 90 significa "mueres más que el 90%". Quien lo pinte
 * tiene que mirar `lower_is_better` e invertirlo (`100 - percentile`) o dibujar
 * el arco al revés. Se dejó así a propósito, para que el signo se vea donde se
 * pinta y no quede escondido en una tabla.
 *
 * `percentile` y `median` vienen a `null` cuando esa métrica no está en el
 * baremo (o el puesto no se conoce): el valor crudo se enseña igualmente.
 */
export interface MetricComparison {
  /** Clave del baremo: "cs_per_min", "kda", "gold_diff_15"… */
  metric: string;
  value: number;
  percentile: number | null;
  median: number | null;
  lower_is_better: boolean;
}

/**
 * Compara una partida contra quienes juegan tu puesto en tu rango.
 *
 * La lista puede venir más corta de las 17 métricas: las que salen del DTO
 * crudo de Riot faltan si esa partida no lo tiene cacheado.
 */
export const getMatchBenchmarks = async (matchId: string): Promise<MetricComparison[]> => {
  return await invoke<MetricComparison[]>("get_match_benchmarks", { matchId });
};

// ---------------------------------------------------------------------------
// Copia de seguridad
// ---------------------------------------------------------------------------

/** Qué hizo una restauración. Ver `import_backup` en el backend. */
export interface ImportReport {
  /** Partidas que ya existían aquí y se les completó algo. */
  restored: number;
  /** Partidas que no existían y se han creado sin vídeo (notas y stats sí). */
  created_without_video: number;
  /** Entradas que no aportaban nada o no se pudieron leer. */
  skipped: number;
}

/**
 * Escribe `LeagueRecorder-backup-YYYYMMDD-HHMM.zip` en `destDir` y devuelve la
 * ruta del fichero. Sin vídeos: sólo los JSON (notas, comentarios, momentos
 * revisados, entrenamiento y ajustes SIN la clave de Riot).
 */
export const exportBackup = async (destDir: string): Promise<string> => {
  return await invoke<string>("export_backup", { destDir });
};

/**
 * Restaura una copia. Es aditiva: nunca pisa un dato local que ya tenga
 * contenido, y las partidas cuyo vídeo falta se crean igual (sin `video_path`).
 */
export const importBackup = async (zipPath: string): Promise<ImportReport> => {
  return await invoke<ImportReport>("import_backup", { zipPath });
};

/**
 * Progreso del mantenimiento de la biblioteca al arrancar, evento
 * `library_maintenance`. Se puede ignorar: el trabajo corre igual por detrás.
 */
export interface MaintenanceProgress {
  /** "migration" | "camera" | "impact" | "done". */
  phase: string;
  done: number;
  total: number;
}
