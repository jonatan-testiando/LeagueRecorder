/**
 * Traducción de la interfaz.
 *
 * La clave es la propia cadena en inglés, no un identificador inventado
 * (`t("Library")`, no `t("nav.library")`). Tres razones:
 *
 *  - No hay que mantener un catálogo de claves en paralelo al texto.
 *  - Si falta una traducción se ve el inglés, no una clave rota. La app nunca
 *    queda visiblemente a medias mientras se traduce.
 *  - Leer el código sigue diciendo qué pone en pantalla.
 *
 * El precio es que cambiar el texto en inglés huérfana su traducción. Con dos
 * idiomas y una app de este tamaño, sale a cuenta.
 */

export type Language = "en" | "es";

export const LANGUAGES: { code: Language; label: string }[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
];

/**
 * Diccionario español. Solo hace falta este: el inglés es la clave.
 */
const ES: Record<string, string> = {
  // ---------------------------------------------------------------- navegación
  "Today": "Hoy",
  "Library": "Biblioteca",
  "Clips": "Clips",
  "Errors": "Errores",
  "Patterns": "Patrones",
  "Analysis": "Análisis",
  "Training": "Entrenamiento",
  "Settings": "Ajustes",

  // ---------------------------------------------------------------- comunes
  "All": "Todas",
  "To review": "Por revisar",
  "Defeats": "Derrotas",
  "Cancel": "Cancelar",
  "Save": "Guardar",
  "Clear filters": "Quitar filtros",
  "today": "hoy",
  "yesterday": "ayer",
  "game": "partida",
  "games": "partidas",
  "victory": "victoria",
  "defeat": "derrota",
  "no result": "sin resultado",
  "VICTORY": "VICTORIA",
  "DEFEAT": "DERROTA",
  "NO RESULT": "SIN RESULTADO",
  "Custom": "Personalizada",
  "· to review": "· por revisar",

  // ---------------------------------------------------------------- biblioteca
  "champion, queue, date…": "campeón, cola, fecha…",
  "Filter games": "Filtrar partidas",
  "KDA": "KDA",
  "Gold @15": "Oro @15",
  "Duration": "Duración",
  "APM": "APM",
  "Dur.": "Dur.",
  "Game": "Partida",
  "No games recorded yet": "Aún no hay partidas grabadas",
  "Play a match and it will show up here automatically.":
    "Juega una partida y aparecerá aquí sola.",
  "No games match this filter": "Ninguna partida coincide con el filtro",
  "Try a different search term, or switch back to All.":
    "Prueba con otra búsqueda, o vuelve a Todas.",
  "Delete game": "Eliminar partida",
  "Death": "Muerte",
  "Kill": "Kill",
  "Objective": "Objetivo",
  "Structure": "Estructura",
  "reviewed": "revisadas",
  "to review": "por revisar",

  // colas de Riot
  "Ranked Solo/Duo": "Clasificatoria Solo/Dúo",
  "Ranked Flex": "Clasificatoria Flexible",
  "Normal Draft": "Normal Draft",
  "Normal Blind": "Normal Blind",
  "Normal": "Normal",
  "ARAM": "ARAM",
  "Clash": "Clash",
  "Co-op vs AI": "Co-op vs IA",
  "URF": "URF",
  "Synced": "Sincronizada",

  // ---------------------------------------------------------------- hoy
  "What to work on": "En qué trabajar",
  "Where it happened": "Dónde ocurrió",
  "You die between minute {a} and {b}": "Te mueres entre el minuto {a} y el {b}",
  "Train camera control": "Entrenar control de cámara",
  "Recording": "Grabando",
  "Idle — records itself when a game starts":
    "En espera — se graba sola al detectar partida",
  "Nothing to point at yet. Record a few games and this turns into the one thing worth working on.":
    "Todavía no hay nada que señalar. Graba unas cuantas partidas y esto se convierte en lo único que merece la pena trabajar.",
  "deaths": "muertes",
  "gold @15": "oro @15",

  // ---------------------------------------------------------------- patrones
  "When you die": "Cuándo mueres",
  "by minute of game": "por minuto de partida",
  "What you flag yourself": "Lo que marcas tú",
  "notes": "notas",
  "deaths per win": "muertes por victoria",
  "deaths per loss": "muertes por derrota",
  "Early signal": "Indicio",
  "Likely pattern": "Patrón probable",
  "Solid pattern": "Patrón sólido",
  "Under 15 games this points at a tendency, not a conclusion. It sharpens as you record more.":
    "Con menos de 15 partidas esto marca una tendencia, no una conclusión. Se afina según grabas más.",
  "Enough games to steer by, though small gaps between windows are still noise.":
    "Ya hay partidas suficientes para orientarse, aunque las diferencias pequeñas entre tramos siguen siendo ruido.",
  "Enough games to trust the overall shape.":
    "Partidas suficientes para fiarse de la forma general.",
  "Not enough games yet": "Aún no hay partidas suficientes",
  "Once a few games are recorded, this screen starts showing what they have in common.":
    "Cuando haya unas cuantas grabadas, esta pantalla empieza a enseñar qué tienen en común.",
  "You haven't categorised any errors yet. The chart on the left comes from the recorded data; this one would come from your own reading of it.":
    "Todavía no has categorizado ningún error. El gráfico de la izquierda sale de los datos grabados; este saldría de tu lectura de ellos.",

  // ---------------------------------------------------------------- revisión
  "Review": "Revisión",
  "Events": "Eventos",
  "Notes": "Notas",
  // "Stats" y "Analytics" eran dos pestañas para lo mismo: ahora son "Match".
  "Match": "Partida",

  // ------------------------------------------------- inspector de la partida
  "Your game": "Tu partida",
  "Kill participation": "Participación en kills",
  "of team": "del equipo",
  "Vision score": "Puntuación de visión",
  "Early game": "Fase temprana",
  "minute 15": "minuto 15",
  "XP difference": "Diferencia de XP",
  "Jungle CS difference": "Diferencia de jungla",
  "Gank pressure": "Presión de ganks",
  "You came out of lane ahead.": "Saliste de línea por delante.",
  "You came out of lane behind.": "Saliste de línea por detrás.",
  "You came out of lane even.": "Saliste de línea igualado.",
  "Lead over time": "Ventaja minuto a minuto",
  "Scoreboard": "Marcador",
  "You": "Tú",
  "player": "jugador",
  "gold": "oro",
  "The 10-player scoreboard is not loaded yet.":
    "El marcador de los 10 jugadores todavía no está cargado.",
  "Sync with Riot": "Sincronizar con Riot",
  "Syncing…": "Sincronizando…",
  "Needs your Riot API key set in Settings.":
    "Necesita tu clave de la API de Riot configurada en Ajustes.",
  "Refresh Riot data": "Actualizar datos de Riot",
  "Updating…": "Actualizando…",
  "Objectives": "Objetivos",
  "Dragons": "Dragones",
  "Barons": "Barones",
  "Heralds": "Heraldos",
  "Towers": "Torres",
  "Inhibitors": "Inhibidores",
  "Item purchases": "Compras de objetos",
  "More analysis": "Más análisis",
  "Nothing flagged": "Nada marcado",
  "No deaths or detected mistakes in this game.":
    "Ni muertes ni errores detectados en esta partida.",
  "All reviewed": "Todo revisado",
  "You went through every flagged moment in this game.":
    "Has repasado todos los momentos marcados de esta partida.",
  "Mark as reviewed": "Marcar como revisado",
  "Mark as not reviewed": "Desmarcar",
  "Camera jump": "Salto de cámara",
  "detected by the analyzer": "detectado por el analizador",
  "you flagged this": "lo marcaste tú",
  "Flagged error": "Error marcado",
  "Victory": "Victoria",
  "Defeat": "Derrota",
  "Blue Team": "Equipo Azul",
  "Blue": "Azul",
  // Etiquetas de tono de los eventos (eventMeta.tsx)
  "Excellent": "Excelente",
  "Good": "Bien",
  "Inaccuracy": "Impreciso",
  "Mistake": "Error",
  "Throw": "Regalo",
  "Info": "Info",
  "Previous": "Anterior",
  "Next": "Siguiente",
  "of": "de",
  "Red": "Rojo",
  "Red Team": "Equipo Rojo",
  "Your performance": "Tu rendimiento",
  "Damage to champions": "Daño a campeones",
  "Damage / min": "Daño / min",
  "Wards placed": "Wards colocadas",
  "Gold difference": "Diferencia de oro",
  "Level": "Nivel",
  "Gold": "Oro",
  "Damage": "Daño",
  "Imported VOD": "VOD importado",
  "Cursor and APM analysis.": "Análisis de cursor y APM.",
  "No events match this filter.": "Ningún evento coincide con el filtro.",
  "Jump to this moment": "Ir a este momento",
  "Add at current time": "Añadir en el minuto actual",
  "Mark error": "Marcar error",
  "Will be anchored to this moment": "Se anclará a este momento",
  "Drag to resize": "Arrastra para redimensionar",
  "Camera moves": "Movimientos de cámara",
  "Clip": "Clip",
  "Error": "Error",

  // transporte
  "Play": "Reproducir",
  "Pause": "Pausa",
  "Previous moment": "Momento anterior",
  "Next moment": "Momento siguiente",
  "Previous note": "Nota anterior",
  "Next note": "Nota siguiente",
  "Fullscreen": "Pantalla completa",
  "Mute": "Silenciar",
  "Unmute": "Quitar silencio",
  "Volume": "Volumen",
  "Playback speed": "Velocidad",
  "Playback settings": "Ajustes de reproducción",
  "Broadcast overlay": "Overlay de retransmisión",
  "Mouse trail": "Rastro del ratón",
  "Mouse trail sync": "Sincronía del rastro",
  "Shifts the trail against the video, in seconds.":
    "Desplaza el rastro respecto al vídeo, en segundos.",
  "Add note": "Añadir nota",
  "Back": "Volver",
  "Error Notebook": "Cuaderno de errores",
  "What went wrong here? What could you have done better?":
    "¿Qué salió mal aquí? ¿Qué podrías haber hecho mejor?",
  "No notes on this clip yet. Pause the video and add one.":
    "Este clip aún no tiene notas. Pausa el vídeo y añade una.",
  "Note at": "Nota en",
  "Write a note at the current time": "Escribir una nota en el minuto actual",

  // ---------------------------------------------------------------- errores
  "No errors flagged yet": "Aún no has marcado ningún error",
  "Use the Error tool in the player to save a mistake and the lesson you took from it.":
    "Usa la herramienta Error del reproductor para guardar un fallo y la lección que sacaste.",
  "flagged": "marcados",
  "across": "en",
  "No note yet — open it to write what you learned.":
    "Sin nota — ábrelo para escribir qué aprendiste.",
  "more": "más",

  // ---------------------------------------------------------------- clips
  "No clips yet": "Aún no hay clips",
  "Use the clipping tool in the player to create clips of your best moments.":
    "Usa la herramienta de recorte del reproductor para crear clips de tus mejores momentos.",

  // ---------------------------------------------------------------- ajustes
  "Control Panel": "Panel de control",
  "Recorder status, audio capture and automatic match detection.":
    "Estado del grabador, captura de audio y detección automática de partidas.",
  "Storage": "Almacenamiento",
  "Save location": "Carpeta de guardado",
  "Directory where videos and clips are saved":
    "Carpeta donde se guardan los vídeos y los clips",
  "Change": "Cambiar",
  "Max Storage Quota (GB)": "Cuota máxima de disco (GB)",
  "Auto-prune Age (Days)": "Borrado automático (días)",
  "Riot Developer API": "API de desarrollador de Riot",
  "API Key (Development)": "Clave de API (desarrollo)",
  "Updates": "Actualizaciones",
  "Check for Updates": "Buscar actualizaciones",
  "Game Sound Capture": "Captura de sonido del juego",
  "Re-detect": "Volver a detectar",
  "Ready to record game sound": "Listo para grabar el sonido del juego",
  "Video Recording Quality": "Calidad de grabación",
  "Manual Test Recording": "Grabación de prueba manual",
  "Language": "Idioma",
  "Checking…": "Comprobando…",
  "Interface language. Saved with your settings.":
    "Idioma de la interfaz. Se guarda con tus ajustes.",
};

const DICTS: Record<Language, Record<string, string>> = {
  en: {},
  es: ES,
};

/**
 * Traduce. Si no hay entrada, devuelve la propia clave, que ya es el inglés.
 *
 * `vars` interpola `{nombre}`: `t("{n} games", { n: 19 })`.
 */
export function translate(
  key: string,
  lang: Language,
  vars?: Record<string, string | number>
): string {
  let out = DICTS[lang][key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.split(`{${k}}`).join(String(v));
    }
  }
  return out;
}

/** Cuántas cadenas quedan sin traducir, para saber por dónde va la cobertura. */
export function coverage(keys: string[], lang: Language): { done: number; total: number } {
  if (lang === "en") return { done: keys.length, total: keys.length };
  const done = keys.filter((k) => DICTS[lang][k] !== undefined).length;
  return { done, total: keys.length };
}
