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
  "Impact": "Impacto",
  // "Stats" y "Analytics" eran dos pestañas para lo mismo: ahora son "Match".
  "Match": "Partida",

  // ---------------------------------------------------------------- ajustes
  "What the recorder does, where it saves, and how it talks to Riot.":
    "Qué graba, dónde lo guarda y cómo habla con Riot.",
  "Recorder": "Grabador",
  "Video": "Vídeo",
  "Idle": "En espera",
  "Game sound": "Sonido del juego",
  "No capture device": "Sin dispositivo de captura",
  "Re-detect": "Volver a detectar",
  "Disk": "Disco",
  "How to enable game sound capture": "Cómo activar la captura del sonido del juego",
  "Install Screen Capturer Recorder (already in your Downloads folder): run the setup as administrator. It adds the virtual-audio-capturer device, which captures exactly what you hear. Then hit Re-detect. Meanwhile it records with the microphone if there is one.":
    "Instala Screen Capturer Recorder (ya está en tu carpeta de Descargas): ejecuta el instalador como administrador. Añade el dispositivo virtual-audio-capturer, que captura exactamente lo que oyes. Luego pulsa «Volver a detectar». Mientras tanto graba con el micrófono, si hay.",
  "Quality": "Calidad",
  "Constant quality: a lower CQ is sharper and heavier.":
    "Calidad constante: un CQ más bajo es más nítido y más pesado.",
  "High": "Alta",
  "Medium": "Media",
  "Low": "Baja",
  "Frame rate": "Fotogramas",
  "Captured at 1080p on the GPU (NVENC); higher resolutions are scaled down.":
    "Se captura a 1080p en la GPU (NVENC); las resoluciones mayores se reescalan.",
  "Change": "Cambiar",
  "Save location": "Carpeta de guardado",
  "Directory where videos and clips are saved": "Carpeta donde se guardan los vídeos y los clips",
  "Max Storage Quota (GB)": "Cuota máxima de disco (GB)",
  "Oldest matches are deleted first when the folder goes over this. Minimum {n} GB.":
    "Se borran primero las partidas más antiguas cuando la carpeta pasa de aquí. Mínimo {n} GB.",
  "Auto-prune Age (Days)": "Borrado automático (días)",
  "Deletes matches older than this, with their clips. 0 disables it. Imported VODs and matches with favourited clips are never touched.":
    "Borra las partidas más viejas que esto, con sus clips. 0 lo desactiva. Los VODs importados y las partidas con clips favoritos no se tocan nunca.",
  "Interface and account": "Interfaz y cuenta",
  "Riot API key": "Clave de la API de Riot",
  "Needed for the scoreboard and your stats. Saved when you leave the field. A development key expires every 24 hours; a personal one does not.":
    "Hace falta para el marcador y tus cifras. Se guarda al salir del campo. La clave de desarrollo caduca cada 24 horas; la personal no.",
  "Key saved and working": "Clave guardada y funcionando",
  "The key is not valid": "La clave no es válida",
  "Pressure you absorbed": "Presión que absorbiste",
  "Confirmed frame by frame in the video": "Confirmado cuadro a cuadro en el vídeo",
  "Lower bound: the API only gives one position per minute": "Cota inferior: la API solo da una posición por minuto",
  "No stretches detected in this game.": "No se detectó ningún tramo en esta partida.",
  "Stretches where more enemies were on you than allies. What your team took elsewhere is what your presence bought.":
    "Tramos con más rivales encima de ti que aliados. Lo que tu equipo se llevó en otra zona es lo que compró tu presencia.",
  "enemies on you": "rivales encima",
  "you die": "mueres",
  "tower": "torre",
  "towers": "torres",
  "inhibitor": "inhibidor",
  "inhibitors": "inhibidores",
  "plate": "placa",
  "plates": "placas",
  "epic": "épico",
  "epics": "épicos",
  "objectives": "objetivos",
  "win %": "% victoria",
  "vs role": "vs rol",
  "of 10": "de 10",
  "rank · score": "puesto · nota",
  "Open the game to compute it": "Abre la partida para calcularlo",
  "total": "total",
  "Your team": "Tu equipo",
  "Enemy team": "Equipo rival",
  "Real credit": "Crédito real",
  "Kill gold as the scoreboard hands it out (last hit) versus how it splits by damage actually dealt.":
    "El oro de los asesinatos como lo reparte el marcador (al que remata) frente a cómo se reparte por el daño que puso cada uno.",
  "scoreboard": "marcador",
  "real": "real",
  "gap": "desfase",
  "Most expensive death": "Muerte más cara",
  "minute": "minuto",
  "Advanced": "Avanzado",
  "AI dataset generator": "Generador de dataset para la IA",
  "Extracts frames at the moment of each click to train the detector. Off unless you are working on the model.":
    "Extrae fotogramas en el momento de cada clic para entrenar el detector. Apagado salvo que estés trabajando en el modelo.",
  "Updates": "Actualizaciones",
  "Version {v} installed.": "Versión {v} instalada.",
  "Check for Updates": "Buscar actualizaciones",
  "Checking…": "Comprobando…",
  "Starting download…": "Empezando la descarga…",
  "Downloading…": "Descargando…",
  "Update ready": "Actualización lista",
  "Downloaded and ready. Installing takes a few seconds.":
    "Descargada y lista. Instalarla son unos segundos.",
  "Restart and install": "Reiniciar e instalar",
  "Version {v} downloaded and ready. Installing takes a few seconds and the app reopens by itself.":
    "Versión {v} descargada y lista. Instalarla son unos segundos y la app se vuelve a abrir sola.",
  "Installing update…": "Instalando la actualización…",
  "The app will close and reopen by itself when it finishes. Do not close it.":
    "La app se cerrará y volverá a abrirse sola al terminar. No la cierres tú.",
  "Your app is already on the latest version.": "Ya tienes la última versión.",
  "Your app is already up to date.": "Ya estás al día.",
  "Failed to check for updates.": "No se han podido buscar actualizaciones.",
  "Tools": "Herramientas",
  "Manual test recording": "Grabación manual de prueba",
  "Checks that FFmpeg and GPU encoding work before trusting a real match.":
    "Comprueba que FFmpeg y la codificación por GPU funcionan antes de fiarte en una partida de verdad.",
  "Stop and save": "Parar y guardar",
  "Record screen": "Grabar pantalla",
  "name": "nombre",
  "How automatic recording works": "Cómo funciona la grabación automática",
  "The background service connects to the in-game API on port 2999 when a match starts.":
    "El servicio en segundo plano se conecta a la API del juego en el puerto 2999 al empezar una partida.",
  "It records locally at 1080p with hardware encoding, so your FPS is untouched.":
    "Graba en local a 1080p con codificación por hardware, así que no te toca los FPS.",
  "It logs kills, deaths, assists and objectives with their timestamps.":
    "Apunta kills, muertes, asistencias y objetivos con su marca de tiempo.",
  "It saves everything when the match ends, with no action from you.":
    "Lo guarda todo al terminar la partida, sin que hagas nada.",
  "It needs ffmpeg on your Windows PATH; without it the recorder cannot start.":
    "Necesita ffmpeg en el PATH de Windows; sin él el grabador no puede arrancar.",
  "Detected audio devices": "Dispositivos de audio detectados",
  "used for the game": "usado para el juego",

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
  "Riot Developer API": "API de desarrollador de Riot",
  "API Key (Development)": "Clave de API (desarrollo)",
  "Game Sound Capture": "Captura de sonido del juego",
  "Ready to record game sound": "Listo para grabar el sonido del juego",
  "Video Recording Quality": "Calidad de grabación",
  "Manual Test Recording": "Grabación de prueba manual",
  "Language": "Idioma",
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
