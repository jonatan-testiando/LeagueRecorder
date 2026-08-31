export type MatchEventType =
  | 'GameStart'
  | 'GameEnd'
  | 'ChampionKill'
  | 'Multikill'
  | 'FirstBlood'
  | 'TowerKill'
  | 'InhibKill'
  | 'DragonKill'
  | 'BaronKill'
  | 'HeraldKill'
  // Ya no se generan (la detección por tecla se retiró), pero las partidas
  // grabadas antes lo llevan y el reproductor las sigue pintando.
  | 'Ultimate';

export interface MatchEvent {
  type: MatchEventType | string;
  // kill/death/assist para ChampionKill; ally/enemy para objetivos; win/lose para GameEnd; R para Ultimate
  subtype?: 'kill' | 'death' | 'assist' | 'ally' | 'enemy' | 'win' | 'lose' | 'R' | string;
  time: number; // Marca de tiempo en segundos
  /**
   * Frase ya montada por el backend. Legado: las partidas grabadas antes de que
   * existieran los campos de abajo solo llevan esto, y en español. Se usa como
   * último recurso en `describeEvent`.
   */
  description: string;

  // Datos estructurados. Solo en partidas grabadas a partir de la versión que
  // los introdujo; `describeEvent` compone la frase a partir de ellos.
  actor?: string;   // quién lo hizo
  target?: string;  // sobre quién o qué
  detail?: string;  // matiz: tipo de dragón, racha, "stolen" (separado por comas)
}

export interface MouseEventData {
  t: number;
  x: number;
  y: number;
  evt: string; // "move", "left_click", "right_click"
}

// Comentario del usuario anclado a una marca de tiempo del vídeo.
export interface Comment {
  time: number; // segundos
  text: string;
}

// Un jugador de la partida (scoreboard, de la API Match-V5 de Riot).
export interface Participant {
  champion: string;
  name: string;
  team_id: number; // 100 = azul, 200 = rojo
  win: boolean;
  level: number;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  gold: number;
  is_self: boolean;
  items?: number[];
  /** Hechizos de invocador [summoner1Id, summoner2Id]. */
  spells?: number[];
  /** El "#KR2" del riot id. */
  tag?: string; // item0..item6 (0 = casilla vacía)
  damage?: number;
  vision_score?: number;
  wards_placed?: number;
}

export interface TeamObjectives {
  team_id: number; // 100 = azul, 200 = rojo
  win: boolean;
  dragons: number;
  barons: number;
  towers: number;
  heralds: number;
  inhibitors: number;
}

export interface ItemPurchase {
  time: number; // segundos de partida
  item_id: number;
}

export interface TimelineMarker {
  time: number; // segundos en el vídeo
  // 'assist' es posterior: las partidas analizadas antes lo guardan como 'kill'
  // y solo lo delata la descripción ("Asistencia"). Ver core/matchEvents.ts.
  event_type: 'kill' | 'assist' | 'death' | 'dragon' | 'herald' | 'tower' | 'plate' | 'gank_attempt' | string;
  description: string;
  position_x?: number;
  position_y?: number;
  // Sólo en 'gank_attempt'. El backend (src-tauri/src/gank.rs) ya resuelve
  // carril, resultado y ángulo de entrada: la UI no deduce nada de las
  // coordenadas, que es de donde salían los falsos positivos.
  lane?: 'top' | 'mid' | 'bot';
  outcome?: 'success' | 'neutral' | 'failed';
  confidence?: number; // 0..1
  /** Incertidumbre del instante, en segundos. 0 = anclado a un evento exacto. */
  time_precision?: number;
  /** 'flank' = le cortas la retirada; 'front' = entrada directa. */
  approach?: 'flank' | 'front';
}

export interface MinuteFrameDto {
  minute: number;
  team_gold_diff: number;
  self_gold_diff: number;
  self_xp_diff: number;
  self_jungle_cs_diff: number;
}

export interface MatchMetadata {
  id: string;
  game_duration: number;
  video_path: string;
  result: string; // 'Victory' | 'Defeat' | 'Unknown'
  champion: string;
  date: string; // Formato YYYY-MM-DD HH:MM:SS
  events: MatchEvent[];
  apm?: number; // Acciones por minuto promedio
  apm_series?: number[]; // APM por minuto de juego
  mouse_events?: MouseEventData[];
  // Resolución del escritorio donde se capturaron mouse_events (rdev da coords de
  // pantalla, no de vídeo). 0/ausente = partida antigua, el player usa heurística.
  mouse_space_w?: number;
  mouse_space_h?: number;
  riot_match_id?: string;
  kda?: string;
  gold_earned?: number;
  damage_dealt?: number;
  participants?: Participant[]; // scoreboard de los 10 (vacío hasta sincronizar con Riot)
  queue?: number; // queueId de Riot (420=clasif solo, 440=flex, 450=ARAM, 0=custom…)
  objectives?: TeamObjectives[]; // objetivos por equipo
  item_purchases?: ItemPurchase[]; // compras de items del jugador con su minuto
  gold_diff_15?: number;
  xp_diff_15?: number;
  jungle_cs_diff_15?: number;
  gank_impact_15?: number;
  lane_result?: 'Win' | 'Loss' | 'Even' | string;
  /** Puesto de 1 a 10 por impacto en la partida. 1 = el mejor de los diez.
   *  Se rellena al abrir la pestaña Impacto de esa partida. */
  impact_rank?: number | null;
  /** Percentil de tu WPA dentro de tu rol (0-100). */
  impact_percentile?: number | null;
  /** Parche en que se jugó ("16.13"). */
  patch?: string | null;
  /** Rango exacto al jugarla: "MASTER", "EMERALD"... */
  rank_tier?: string | null;
  /** División dentro del rango ("I".."IV"). */
  rank_division?: string | null;
  /** LP al sincronizar, justo tras la partida. */
  rank_lp?: number | null;
  timeline_markers?: TimelineMarker[];
  minute_frames?: MinuteFrameDto[];
  comments?: Comment[]; // comentarios con marca de tiempo
  /**
   * Segundos de los momentos ya revisados.
   *
   * Vive aquí y NO dentro de `events[]` a propósito: la lista de sucesos la
   * reescriben varias rutas del backend, así que cualquier estado del usuario
   * metido ahí dentro se pierde en silencio la próxima vez que algo regenere
   * eventos. Que es exactamente lo que pasó.
   */
  reviewed_moments?: number[];
  is_vod?: boolean; // VOD importado/analizado: la UI oculta el panel Victoria/Derrota
  camera_snaps?: number[]; // segundos en que la cámara saltó (tecla de cámara aliada)
  // Segundos de vídeo anteriores al 0:00 de la partida (la pantalla de carga también se
  // graba). El backend ya entrega todos los tiempos en el eje del vídeo; esto es
  // informativo, por si hace falta volver al reloj de la partida: t_partida = t - offset.
  video_offset?: number | null;
}

export interface ClipMetadata {
  path: string;
  name: string;
  match_id: string;
  size: number; // Tamaño del archivo en bytes
  favorite: boolean;
}

export interface AudioStatus {
  system_audio_device: string | null;
  all_devices: string[];
  ready_for_game_audio: boolean;
}

export interface VideoSettings {
  fps: number;
  quality: string;
}
