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
  | 'Ultimate';

export interface MatchEvent {
  type: MatchEventType | string;
  // kill/death/assist para ChampionKill; ally/enemy para objetivos; win/lose para GameEnd; R para Ultimate
  subtype?: 'kill' | 'death' | 'assist' | 'ally' | 'enemy' | 'win' | 'lose' | 'R' | string;
  time: number; // Marca de tiempo en segundos
  description: string;
}

export interface UltimateSettings {
  enabled: boolean;
  key: string;
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
  items?: number[]; // item0..item6 (0 = casilla vacía)
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
  riot_match_id?: string;
  kda?: string;
  gold_earned?: number;
  damage_dealt?: number;
  participants?: Participant[]; // scoreboard de los 10 (vacío hasta sincronizar con Riot)
  comments?: Comment[]; // comentarios con marca de tiempo
  is_vod?: boolean; // VOD importado/analizado: la UI oculta el panel Victoria/Derrota
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
