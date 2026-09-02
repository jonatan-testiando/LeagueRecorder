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
  "{d}d ago": "hace {d}d",
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
  "Items": "Objetos",
  "Rival": "Rival",
  "Rank forecast": "Predicción de rango",
  "your last {n} ranked games, recorded or not": "tus últimas {n} ranked de la cuenta, grabadas o no",
  "in ~20 games": "en ~20 partidas",
  "per game at this pace": "por partida a este ritmo",
  "Record and performance, blended: your score inside each lobby corrects the winrate (losing while outplaying projects up). LP swings measured from your own games. It points, it doesn't promise.":
    "Marcador y rendimiento, mezclados: tu nota dentro de cada lobby corrige el winrate (perder jugando mejor proyecta subir). Los LP salen de tus propias partidas. Apunta, no promete.",
  "score": "de nota",
  "Performance percentile inside each game's lobby, recent games weigh double":
    "Percentil de rendimiento dentro del lobby de cada partida; las recientes pesan doble",
  "your climb, LP across {n} recorded games": "tu escalada: LP en {n} partidas grabadas",
  "Your pool": "Tu pool",
  "who you actually win with": "con quién ganas de verdad",
  "Your rivals": "Tus rivales",
  "the lane opponents that beat you": "los rivales de carril que te ganan",
  "Summoner": "Invocador",
  "Patch": "Parche",
  "just now": "ahora mismo",
  "{m} min ago": "hace {m} min",
  "{h} h ago": "hace {h} h",
  "{d} d ago · {date}": "hace {d} d · {date}",
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

  // filtro por rol (biblioteca y patrones)
  "Jungle": "Jungla",
  "ADC": "ADC",
  "Support": "Soporte",

  // selección por lotes
  "Select": "Seleccionar",
  "Select several games to delete them at once": "Selecciona varias partidas para eliminarlas de una vez",
  "{n} games selected": "{n} partidas seleccionadas",
  "{n} game selected": "{n} partida seleccionada",
  "Delete selected": "Eliminar seleccionadas",
  "Delete selected games": "Eliminar partidas seleccionadas",
  "This permanently deletes {n} recordings with their videos and events. Favourited clips are rescued to the clips folder.":
    "Se eliminarán permanentemente {n} grabaciones con sus vídeos y eventos. Los clips favoritos se rescatan a la carpeta de recortes.",
  "Could not delete {n} of the selected games.": "No se pudieron borrar {n} de las partidas seleccionadas.",
  "Delete": "Eliminar",
  "Delete reviewed games older than 30 days": "Eliminar revisadas con más de 30 días",

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
  "Your blind spot": "Tu punto ciego",
  "latest {n} of {total}": "las {n} últimas de {total}",
  "{lane} is the lane you leave unwatched the longest, in {n} of your last {total} games.":
    "{lane} es el carril que más rato dejas sin mirar, en {n} de tus últimas {total} partidas.",
  "On average {avg} without a single look; your worst was {worst}.":
    "De media {avg} sin mirarlo ni una vez; tu peor caso fueron {worst}.",
  "It is your worst window: {n} of your {total} deaths land there ({pct}%).":
    "Es tu peor tramo: {n} de tus {total} muertes caen ahí ({pct}%).",
  "With {n} games this is a lead, not a conclusion — it sharpens as you record more.":
    "Con {n} partidas esto es una pista, no una conclusión — se afina según grabas más.",
  "The window above comes from the data, not from your reading of it. Flagging even one moment per game is what turns \"when\" into \"why\".":
    "El tramo de arriba sale de los datos, no de tu lectura de ellos. Marcar aunque sea un momento por partida es lo que convierte el «cuándo» en «por qué».",
  "Couldn't load the video": "No se pudo cargar el vídeo",
  "AI Analysis": "Análisis por IA",
  "Recording": "Grabando",
  "Idle — records itself when a game starts":
    "En espera — se graba sola al detectar partida",
  "Nothing to point at yet. Record a few games and this turns into the one thing worth working on.":
    "Todavía no hay nada que señalar. Graba unas cuantas partidas y esto se convierte en lo único que merece la pena trabajar.",
  "deaths": "muertes",
  "gold @15": "oro @15",

  // ---------------------------------------------------------------- patrones
  "When you die": "Cuándo mueres",
  "Where you die": "Dónde mueres",
  "Deaths get a map position when the game syncs with Riot.":
    "Las muertes ganan posición en el mapa cuando la partida se sincroniza con Riot.",
  "Your rank, game by game": "Tu puesto, partida a partida",
  "Ranks appear as games sync with Riot.": "Los puestos aparecen según las partidas se sincronizan con Riot.",
  "latest": "últimas",
  "What your presence buys": "Lo que compra tu presencia",
  "win prob. your team took elsewhere": "de prob. de victoria que tu equipo sacó lejos de ti",
  "stretches": "tramos",
  "Blind spot, game by game": "El punto ciego, partida a partida",
  "longest stretch without a look, per lane": "el rato más largo sin mirar, por carril",
  "This is the row to watch after training a lane: it is the only screen that can tell whether it is working.":
    "Esta es la fila que hay que mirar después de entrenar un carril: es la única pantalla que puede decir si está funcionando.",
  "Crossings": "Cruces",
  "Minute {a}–{b} is your worst window.": "El minuto {a}–{b} es tu peor tramo.",
  "{n} of your {total} deaths land there ({pct}%).":
    "Ahí caen {n} de tus {total} muertes ({pct}%).",
  "{n} notes across {total} deaths.": "{n} notas sobre {total} muertes.",
  "In your low map-checking games you die {pct}% more than in the high ones ({n} games).":
    "En tus partidas de mirar poco el mapa mueres un {pct}% más que en las de mirar mucho ({n} partidas).",
  "Your deaths barely change with how much you check the map ({n} games).":
    "Tus muertes apenas cambian con cuánto miras el mapa ({n} partidas).",
  "Gold @15 averages {vic} in your wins and {der} in your losses ({n} games).":
    "El oro @15 promedia {vic} en tus victorias y {der} en tus derrotas ({n} partidas).",
  "Comparisons, not causes: with this sample they point, they don't prove.":
    "Comparaciones, no causas: con esta muestra apuntan, no demuestran.",
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

  // mapa de muertes interactivo
  "Early (<14m)": "Early (<14m)",
  "Mid (14–25m)": "Mid (14–25m)",
  "Late (>25m)": "Late (>25m)",
  "Click a death to open that game at that exact moment.":
    "Haz clic en una muerte para abrir esa partida en ese momento exacto.",
  "Open this death in the player": "Abrir esta muerte en el reproductor",

  // estado de la predicción de rango
  "The rank forecast needs your Riot API key.":
    "La predicción de rango necesita tu clave de la API de Riot.",
  "Your Riot API key is invalid or has expired.":
    "Tu clave de la API de Riot no es válida o ha caducado.",
  "Go to Settings to set up the Riot API key": "Ir a Ajustes para configurar la Riot API Key",
  "Riot is rate limiting requests right now; the forecast retries on the next visit.":
    "Riot está limitando las peticiones ahora mismo; la predicción se reintenta en la próxima visita.",
  "At least 8 ranked games are needed to compute the projection ({n} so far).":
    "Se necesitan al menos 8 partidas ranked para calcular la proyección (por ahora {n}).",

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
  "kills": "asesinatos",
  "structures": "estructuras",
  "Your impact": "Tu impacto",
  "Win probability you added, and where it came from. The four parts add up to your total.":
    "La probabilidad de victoria que aportaste, y de dónde salió. Las cuatro partes suman tu total.",

  // ------------------------------------------------- procesado del vídeo
  "Where you looked": "Dónde miraste",
  "Top": "Top",
  "Mid": "Mid",
  "Bot": "Bot",
  "Your minimap clicks, by lane. The gap is the longest stretch you left that lane unwatched.":
    "Tus clics de minimapa, por carril. El hueco es el rato más largo que dejaste ese carril sin mirar.",
  "Longest blind spot": "El punto ciego más largo",
  "looks": "miradas",
  "Video analysis": "Análisis del vídeo",
  "Positions read from the video: the stretches below are measured, not estimated.":
    "Posiciones leídas del vídeo: los tramos de abajo están medidos, no estimados.",
  "Not available for this game: it needs the video, the detector and the Riot data.":
    "No disponible en esta partida: hacen falta el vídeo, el detector y los datos de Riot.",
  "Without it each stretch is a lower bound: the API only gives one position per minute. Takes about two minutes and can be stopped; what it has done is kept.":
    "Sin él cada tramo es una cota inferior: la API solo da una posición por minuto. Tarda unos dos minutos y se puede parar; lo que lleve hecho no se pierde.",
  "Analyze the video": "Analizar el vídeo",
  "Resume analysis": "Reanudar el análisis",
  "reading the minimap, about two minutes": "leyendo el minimapa, unos dos minutos",
  "The video analysis failed. Check the log for details.":
    "El análisis del vídeo falló. El motivo está en el registro.",
  "Stop": "Parar",

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
  "Checking for updates…": "Buscando actualizaciones…",
  "MVP": "MVP",
  "Starting download…": "Empezando la descarga…",
  "Downloading…": "Descargando…",
  "Install v{v}": "Instalar v{v}",
  "Installing v{v}…": "Instalando v{v}…",
  "The app restarts by itself in a few seconds.": "La app se reinicia sola en unos segundos.",
  "Downloading in the background. You can keep using the app.":
    "Descargando en segundo plano. Puedes seguir usando la app.",
  "Downloaded and ready. One click: it installs and the app comes back by itself.":
    "Descargada y lista. Un clic: se instala y la app vuelve sola.",
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
  "How often you moved the camera off yourself: minimap clicks and ally camera keys, counted from what you actually pressed. 'Blind' is the longest stretch without a single look.":
    "Cuánto sacaste la cámara de ti: clics en el minimapa y teclas de cámara aliada, contados de lo que pulsaste de verdad. «Blind» es el rato más largo sin mirar ni una vez.",
  "Scan the video for camera moves. Only needed for imported VODs: a game recorded here already knows this from your clicks and keys.":
    "Buscar movimientos de cámara en el vídeo. Solo hace falta para VODs importados: una partida grabada aquí ya lo sabe por tus clics y tus teclas.",
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
  "Minimap scale": "Escala del minimapa",
  "Size of your in-game minimap versus the standard one, in percent. Calibrates minimap-click detection (map looks, blind spots) if you play with the HUD rescaled. Changing it recalculates past games in the background.":
    "Tamaño de tu minimapa en el juego respecto al estándar, en porcentaje. Calibra la detección de clics de minimapa (miradas, puntos ciegos) si juegas con la interfaz reescalada. Al cambiarlo se recalculan las partidas pasadas en segundo plano.",

  // ---------------------------------------------------------------- entrenamiento
  "Loading…": "Cargando…",
  "Drills": "Ejercicios",
  "Awareness": "Lectura de mapa",
  "Setup": "Configuración",
  "Camera keys are not a speed problem. They are a habit, a 400 ms read, and a question you are trying to answer.":
    "Las teclas de cámara no son un problema de velocidad. Son un hábito, una lectura de 400 ms y una pregunta que intentas responder.",
  "Avg latency, last {n} sessions": "Latencia media, últimas {n} sesiones",
  "{ms} ms faster than your first": "{ms} ms más rápido que tu primera",
  "{ms} ms slower than your first": "{ms} ms más lento que tu primera",
  "No camera keys configured": "No hay teclas de cámara configuradas",
  "Set which key you press for each ally in Setup, then come back.":
    "Configura en Configuración qué tecla pulsas para cada aliado y vuelve.",
  "Go to Setup": "Ir a Configuración",

  // drill de mapeo
  "Key mapping drill": "Ejercicio de mapeo de teclas",
  "A role appears — press its camera key. Target: under 400 ms with 95% accuracy, without looking at the keyboard.":
    "Aparece un rol — pulsa su tecla de cámara. Objetivo: menos de 400 ms con un 95% de acierto, sin mirar el teclado.",
  "Rounds": "Rondas",
  "Prompt": "Estímulo",
  "Role": "Rol",
  "Champion": "Campeón",
  "Load": "Carga",
  "Mouse tracking": "Seguimiento con el ratón",
  "Uses champions seen in your recorded games": "Usa campeones vistos en tus partidas grabadas",
  "Play a recorded game first to build your champion pool":
    "Graba antes una partida para construir tu pool de campeones",
  "Adds a mouse-tracking task on top — this is where most people break":
    "Añade encima una tarea de seguimiento con el ratón — aquí es donde se rompe la mayoría",
  "Start": "Empezar",
  "GO": "YA",
  "Hands on the keys.": "Manos en las teclas.",
  "Session complete": "Sesión completada",
  "Accuracy": "Acierto",
  "Avg latency": "Latencia media",
  "Best": "Mejor",
  "Tracking": "Seguimiento",
  "Again": "Otra vez",
  "{pressed} — it was {expected}": "{pressed} — era {expected}",
  "Too slow": "Demasiado lento",
  "correct": "aciertos",
  "{ms} ms avg": "{ms} ms de media",
  "Keep the cursor on the dot": "Mantén el cursor sobre el punto",

  // drill de lectura rápida
  "Loading frames…": "Cargando fotogramas…",
  "Fast-read drill": "Ejercicio de lectura rápida",
  "No frames yet": "Aún no hay fotogramas",
  "Open a recorded game in Review and hit \"Camera moves\" on the timeline. Every camera reposition it finds becomes a frame for this drill.":
    "Abre una partida grabada en la Biblioteca y pulsa «Movimientos de cámara» en la línea de tiempo. Cada reposición de cámara que encuentre se convierte en un fotograma para este ejercicio.",
  "A frame from your own games flashes for {ms} ms, then one question. Commit to an answer before revealing — you grade yourself honestly or this measures nothing. Change the flash duration in Setup.":
    "Un fotograma de tus propias partidas aparece {ms} ms y desaparece; luego, una pregunta. Comprométete con una respuesta antes de revelar — te corriges con honestidad o esto no mide nada. La duración del destello se cambia en Configuración.",
  "{n} frames available": "{n} fotogramas disponibles",
  "Flash": "Destello",
  "Solid. Drop the flash duration in Setup and make it harder.":
    "Sólido. Baja la duración del destello en Configuración y ponlo más difícil.",
  "Keep this flash duration until you are consistently above 80%.":
    "Mantén esta duración hasta estar por encima del 80% con consistencia.",
  "What did you see?": "¿Qué has visto?",
  "You said": "Dijiste",
  "— were you right?": "— ¿acertaste?",
  "Yes": "Sí",

  // preguntas del drill de lectura
  "How much HP did the ally have?": "¿Cuánta vida tenía el aliado?",
  "How many enemies were visible on the minimap?": "¿Cuántos enemigos se veían en el minimapa?",
  "What was the ally doing?": "¿Qué estaba haciendo el aliado?",
  "Pushing": "Empujando",
  "Holding": "Aguantando",
  "Backing off": "Retrocediendo",
  "Fighting": "Peleando",
  "Which side of the map was the camera on?": "¿En qué zona del mapa estaba la cámara?",
  "Base": "Base",
  "Was the wave pushing toward the ally or away?": "¿La oleada empujaba hacia el aliado o se alejaba?",
  "Toward": "Hacia él",
  "Away": "Se alejaba",
  "Even": "Igualada",
  "No wave": "Sin oleada",
  "Were there any allies nearby?": "¿Había aliados cerca?",
  "None": "Ninguno",
  "One": "Uno",
  "Two or more": "Dos o más",
  "Whole team": "Todo el equipo",

  // configuración del entrenamiento
  "Camera keys": "Teclas de cámara",
  "The key you actually press in game for each ally, in TAB order. Everything else — drills, metronome, post-game stats — reads from this.":
    "La tecla que pulsas de verdad en partida para cada aliado, en orden de TAB. Todo lo demás — ejercicios, metrónomo, estadísticas post-partida — lee de aquí.",
  "press…": "pulsa…",
  "Remove": "Quitar",
  "Add key": "Añadir tecla",
  "Recentre key": "Tecla de recentrar",
  "Snapping back to yourself has to be part of the same gesture.":
    "Volver a ti tiene que ser parte del mismo gesto.",
  "In-game metronome": "Metrónomo en partida",
  "A transparent overlay asks you to check an ally every N seconds.":
    "Un overlay transparente te pide mirar a un aliado cada N segundos.",
  "On": "Activado",
  "Off": "Apagado",
  "sec": "seg",
  "Test": "Probar",
  "Show the overlay for a few seconds. Run it with the game open to confirm it draws on top — it will not over exclusive fullscreen, only borderless.":
    "Muestra el overlay unos segundos. Pruébalo con el juego abierto para confirmar que se dibuja encima — no lo hace sobre pantalla completa exclusiva, solo sin bordes.",
  "Post-game quiz": "Quiz post-partida",
  "Samples the live game state every N seconds so the quiz can be auto-graded.":
    "Muestrea el estado de la partida cada N segundos para poder corregir el quiz automáticamente.",
  "Flash duration": "Duración del destello",
  "How long the recall drill shows each frame. Lower is harder.":
    "Cuánto tiempo muestra cada fotograma el ejercicio de lectura. Menos es más difícil.",
  "Key \"{k}\" is assigned to more than one role.": "La tecla «{k}» está asignada a más de un rol.",
  "Saved": "Guardado",

  // ------------------------------------------- reproductor (restos en duro)
  "Average APM": "APM medio",
  "Scanning {pct}%": "Escaneando {pct}%",
  "blind": "sin mirar",
  "No notes yet. Write one below and it anchors to the current minute of the video.":
    "Aún no hay notas. Escribe una abajo y se anclará al minuto actual del vídeo.",
  "Delete note": "Eliminar nota",
  "Note this moment…": "Comenta este momento…",
  "Export video clip": "Exportar clip de vídeo",
  "Write a note about this mistake…": "Escribe una nota sobre este error…",
  "Exporting…": "Exportando…",
  "Export clip": "Exportar clip",
  "Export error": "Exportar error",
  "No events recorded in this game.": "No hay eventos registrados en esta partida.",

  // ------------------------------------------- quiz de awareness y metrónomo
  "Checks / min": "Miradas / min",
  "Longest blind gap": "Mayor hueco sin mirar",
  "Total": "Total",
  "Split": "Reparto",
  "You actually knew what your team was doing.":
    "Sabías de verdad qué estaba haciendo tu equipo.",
  "Half the information reached you. That is the gap to close.":
    "Te llegó la mitad de la información. Ese es el hueco a cerrar.",
  "You were pressing keys without reading. This is the real starting point.":
    "Pulsabas teclas sin leer. Este es el punto de partida real.",
  "no answer": "sin respuesta",
  "right answer": "correcta",
  "New questions from this game": "Preguntas nuevas de esta partida",
  "No looking anything up. If you do not remember, guess — a wrong answer is the measurement, not a failure.":
    "Sin mirar nada. Si no te acuerdas, adivina — una respuesta errónea es la medición, no un fracaso.",
  "Submit": "Corregir",
  "Play a game with LeagueRecorder running. It samples the live game state so it can ask you afterwards what you actually knew.":
    "Juega una partida con LeagueRecorder abierto. Muestrea el estado en vivo para poder preguntarte después qué sabías de verdad.",
  "checks/min": "miradas/min",
  "metronome": "metrónomo",
  "last quiz": "último quiz",
  "Metronome prompts you answered in time": "Avisos del metrónomo respondidos a tiempo",
  "Retake": "Repetir",
  "Take quiz": "Hacer el quiz",
  "missed": "fallado",
  // Igual en ambos idiomas; la entrada existe para que la auditoría
  // (tools/i18n_huecos.py) no lo liste como hueco.
  "No": "No",
  // ---- región y clave de Riot (agente riot)
  "Region": "Región",
  "Where you play. Auto figures it out from your recent matches the first time.":
    "Dónde juegas. «Auto» lo averigua con tus últimas partidas la primera vez.",
  "Auto": "Auto",
  "Auto (detected: {region})": "Auto (detectada: {region})",
  "Show key": "Ver la clave",
  "Hide key": "Ocultar la clave",
  "Get a key at developer.riotgames.com": "Consigue una clave en developer.riotgames.com",
  "Needed for the scoreboard and your stats. Your proxy is providing the key, so you do not need one here.":
    "Hace falta para el marcador y tus estadísticas. Tu proxy pone la clave, así que aquí no necesitas ninguna.",
  "Riot proxy URL": "URL del proxy de Riot",
  "A server that holds the Riot key for you: with one, you never need your own key or to renew it.":
    "Un servidor que guarda la clave de Riot por ti: con uno, no necesitas clave propia ni renovarla.",
  "Open folder": "Abrir carpeta",
  "Constant quality {cq}": "Calidad constante {cq}",
  // Banner de la clave
  "Your Riot key expired. Development keys last 24 h.":
    "Tu clave de Riot ha caducado. Las de desarrollo duran 24 h.",
  "Riot rejected your key. Check it in Settings.":
    "Riot ha rechazado tu clave. Revísala en Ajustes.",
  "Add your Riot key to unlock scoreboard, impact and rank":
    "Añade tu clave de Riot para tener marcador, impacto y rango",
  "Renew key": "Renovar clave",
  "Open Settings": "Abrir Ajustes",
  "Dismiss": "Descartar",
  // Huecos que quedaban en Ajustes
  "Enter an ID or name for the test recording":
    "Introduce un ID o nombre para la prueba de grabación",
  "Starting test recording…": "Empezando la grabación de prueba…",
  "Recording in progress. You can use your PC.":
    "Grabando. Puedes seguir usando el PC.",
  "Stopping and saving clip…": "Parando y guardando el clip…",
  "Clip saved successfully. Check the Library section.":
    "Clip guardado. Lo tienes en Biblioteca.",
  "Clip saved successfully.": "Clip guardado.",
  "Error: {msg}": "Error: {msg}",
  "Failed to start: {msg}": "No se pudo empezar: {msg}",
  "Failed to stop: {msg}": "No se pudo parar: {msg}",
  "Update error: {msg}": "Error al actualizar: {msg}",

  // ---- galerías, errores, clips, VOD (agente galerías)
  // Nota: "Positioning"/"Mechanics"/"Decision Making"/"Other" y los nombres
  // de cola son IDENTIFICADORES que se guardan en disco en inglés; aquí solo
  // se traduce cómo se pintan.
  "at {t} in the game": "en el {t} de la partida",
  "clip": "clip",
  "clips": "clips",
  "Analysing the video…": "Analizando el vídeo…",
  "Analysing…": "Analizando…",
  "Analysis cancelled. Nothing was saved.": "Análisis cancelado. No se ha guardado nada.",
  "Anchor this note to where the video is now": "Anclar esta nota donde está el vídeo ahora",
  "Best score": "Mejor nota",
  "Build": "Build",
  "Camera history": "Historial de cámara",
  "Cancelling…": "Cancelando…",
  "Clip exported": "Clip exportado",
  "Clip uploaded. The link is on your clipboard.":
    "Clip subido. El enlace está en el portapapeles.",
  "Close": "Cerrar",
  "Confirm action": "Confirmar acción",
  "Copy link": "Copiar enlace",
  "Couldn't analyse the video: {msg}": "No se pudo analizar el vídeo: {msg}",
  "Couldn't cancel the analysis: {msg}": "No se pudo cancelar el análisis: {msg}",
  "Couldn't change the favourite: {msg}": "No se pudo cambiar el favorito: {msg}",
  "Couldn't delete the analysis: {msg}": "No se pudo borrar el análisis: {msg}",
  "Couldn't delete the game: {msg}": "No se pudo borrar la partida: {msg}",
  "Couldn't delete the games: {msg}": "No se pudieron borrar las partidas: {msg}",
  "Couldn't delete the note: {msg}": "No se pudo borrar la nota: {msg}",
  "Couldn't export the clip: {msg}": "No se pudo exportar el clip: {msg}",
  "Couldn't load your flagged errors: {msg}": "No se pudieron cargar los errores marcados: {msg}",
  "Couldn't load your games: {msg}": "No se pudieron cargar tus partidas: {msg}",
  "Couldn't load: {what}": "No se pudo cargar: {what}",
  "Couldn't open the folder: {msg}": "No se pudo abrir la carpeta: {msg}",
  "Couldn't save the note: {msg}": "No se pudo guardar la nota: {msg}",
  "Couldn't upload the clip: {msg}": "No se pudo subir el clip: {msg}",
  "Decision Making": "Decisiones",
  "Delete analysis": "Eliminar análisis",
  "Delete the {champion} game": "Eliminar la partida de {champion}",
  "Done": "Hecho",
  "Edit note": "Editar nota",
  "Error category": "Categoría del error",
  "Expires in ~{h} h": "Caduca en ~{h} h",
  "Expires in ~{m} min": "Caduca en ~{m} min",
  "Favourites": "Favoritos",
  "Flagged errors": "Errores marcados",
  "From {champion} · {date}": "De {champion} · {date}",
  "From {id}": "De {id}",
  "Generate a new link": "Generar un enlace nuevo",
  "GPU": "GPU",
  "How long the link lasts": "Cuánto dura el enlace",
  "Import a match recording and it comes back with the moments worth looking at.":
    "Importa la grabación de una partida y vuelve con los momentos que merece la pena mirar.",
  "Import a video and it reads the cursor and the clicks frame by frame, the same way it does with your own recordings.":
    "Importa un vídeo y lee el cursor y los clics fotograma a fotograma, igual que hace con tus propias grabaciones.",
  "Import video": "Importar vídeo",
  "Largest": "Más grandes",
  "Mark a clip with the heart and it shows up here.":
    "Marca un clip con el corazón y aparecerá aquí.",
  "Maximize": "Maximizar",
  "Mechanics": "Mecánica",
  "Minimize": "Minimizar",
  "Most notes": "Más notas",
  "Newest": "Recientes",
  "No errors match this filter": "Ningún error coincide con el filtro",
  "No favourite clips yet": "Aún no hay clips favoritos",
  "No videos analysed yet": "Aún no has analizado ningún vídeo",
  "Note deleted": "Nota eliminada",
  "Note saved": "Nota guardada",
  "Note updated": "Nota actualizada",
  "Notice": "Aviso",
  "Oldest": "Antiguas",
  "On CPU this takes about 1.5× the length of the video. You can keep using the app.":
    "En CPU tarda alrededor de 1,5× lo que dura el vídeo. Puedes seguir usando la app.",
  "Open in browser": "Abrir en el navegador",
  "Open match": "Abrir partida",
  "Open the game this clip came from": "Abrir la partida de la que salió este clip",
  "Other": "Otro",
  "Other queue": "Otra cola",
  "Over the {limit} limit of the permanent link. Pick a temporary one.":
    "Pasa del límite de {limit} del enlace permanente. Elige uno temporal.",
  "Over the {limit} limit. Clip a shorter moment.":
    "Pasa del límite de {limit}. Recorta un momento más corto.",
  "OK": "Vale",
  "Perfect": "Perfecto",
  "Permanent": "Permanente",
  "Permanent link": "Enlace permanente",
  "Positioning": "Posicionamiento",
  "Pressure": "Presión",
  "Re-upload": "Volver a subir",
  "Recorded {date}": "Grabada el {date}",
  "Restore": "Restaurar",
  "Retry": "Reintentar",
  "Reveal in folder": "Abrir en la carpeta",
  "RECORDING": "GRABANDO",
  "Saved to your clips folder.": "Guardado en tu carpeta de recortes.",
  "Saved to {path}": "Guardado en {path}",
  "Score": "Nota",
  "Share link": "Enlace para compartir",
  "Smallest": "Más pequeños",
  "Sort": "Orden",
  "Success": "Listo",
  "Sync with Riot to see your lane opponent": "Sincroniza con Riot para ver a tu rival de carril",
  "Temporary · 1 h": "Temporal · 1 h",
  "Temporary · 12 h": "Temporal · 12 h",
  "Temporary · 24 h": "Temporal · 24 h",
  "Temporary · 72 h": "Temporal · 72 h",
  "This note is deleted for good. The clip stays.":
    "La nota se borra para siempre. El clip se queda.",
  "This permanently deletes the analysis of {name} and everything found in it. The original video file is not touched.":
    "Se eliminará permanentemente el análisis de {name} y todo lo encontrado en él. El vídeo original no se toca.",
  "This permanently deletes the recording with its video and events. Favourited clips are rescued to the clips folder.":
    "Se eliminará permanentemente la grabación con su vídeo y sus eventos. Los clips favoritos se rescatan a la carpeta de recortes.",
  "Try another category, or go back to All.": "Prueba con otra categoría, o vuelve a Todas.",
  "Upload & share": "Subir y compartir",
  "Uploading…": "Subiendo…",
  "Use current time": "Usar el instante actual",
  "Video file missing": "Falta el fichero de vídeo",
  "VS": "VS",
  "With the GPU this runs at roughly the length of the video.":
    "Con la GPU tarda más o menos lo que dura el vídeo.",
  "Worst score": "Peor nota",
  "{s}s elapsed": "{s} s transcurridos",
  "{total} deaths · {w} in wins, {l} in losses":
    "{total} muertes · {w} en victorias, {l} en derrotas",
  "{w}W {l}L": "{w}V {l}D",

  // ---- reproductor, widgets y entrenamiento (agente reproductor)
  // sucesos de partida (core/eventText.ts y eventMeta.tsx)
  "Killed {target}": "Matas a {target}",
  "Killed by {actor}": "Te mata {actor}",
  "Assisted killing {target}": "Asistes matando a {target}",
  "Multi kill": "Asesinato múltiple",
  "Double kill": "Doble asesinato",
  "Triple kill": "Triple asesinato",
  "Quadra kill": "Cuádruple asesinato",
  "Pentakill": "Pentakill",
  "Dragon": "Dragón",
  "{kind} Dragon": "Dragón {kind}",
  "Mountain Dragon": "Dragón de Montaña",
  "Ocean Dragon": "Dragón de Océano",
  "Infernal Dragon": "Dragón Infernal",
  "Cloud Dragon": "Dragón de Nube",
  "Hextech Dragon": "Dragón Hextech",
  "Chemtech Dragon": "Dragón Quimtech",
  "Elder Dragon": "Dragón Ancestral",
  "Rift Herald": "Heraldo de la Grieta",
  "Baron Nashor": "Barón Nashor",
  "Your team took {what}": "Tu equipo se lleva {what}",
  "Your team stole {what}": "Tu equipo roba {what}",
  "Enemy took {what}": "El rival se lleva {what}",
  "Enemy stole {what}": "El rival roba {what}",
  "{what} (stolen)": "{what} (robado)",
  "Assist": "Asistencia",
  "Multi Kill": "Asesinato múltiple",
  "First Blood": "Primera sangre",
  "Baron": "Barón",
  "Herald": "Heraldo",
  "Tower": "Torre",
  "Inhibitor": "Inhibidor",
  "Ultimate (R)": "Definitiva (R)",
  "Game Start": "Inicio de partida",
  "Game End": "Fin de partida",

  // reproductor: vídeo ausente, atajos y notas
  "This game was tracked but not recorded": "Esta partida se siguió pero no se grabó",
  "The recording failed: {reason}. Its events, stats and impact are all still here.": "La grabación falló: {reason}. Sus eventos, cifras e impacto siguen aquí.",
  "The recording did not produce a file. Its events, stats and impact are all still here.": "La grabación no llegó a producir un fichero. Sus eventos, cifras e impacto siguen aquí.",
  "The video file is missing or damaged": "Falta el fichero de vídeo o está dañado",
  "It was moved, deleted or written incomplete. Everything else about this game still works.": "Se movió, se borró o se escribió a medias. Todo lo demás de esta partida sigue funcionando.",
  "Keyboard shortcuts": "Atajos de teclado",
  "Play or pause": "Reproducir o pausar",
  "Back or forward 5 s": "Atrás o adelante 5 s",
  "Step one frame": "Un fotograma",
  "Previous or next moment": "Momento anterior o siguiente",
  "Set clip in or out point": "Marcar entrada o salida del recorte",
  "Leave fullscreen": "Salir de pantalla completa",
  "Couldn't save the notes: {msg}": "No se pudieron guardar las notas: {msg}",
  "Couldn't save the reviewed state: {msg}": "No se pudo guardar el estado de revisión: {msg}",
  "Couldn't sync with Riot: {msg}": "No se pudo sincronizar con Riot: {msg}",
  "Couldn't start the video analysis: {msg}": "No se pudo empezar el análisis del vídeo: {msg}",
  "Couldn't work out the credit split: {msg}": "No se pudo calcular el reparto de crédito: {msg}",
  "Couldn't load the pressure stretches: {msg}": "No se pudieron cargar los tramos de presión: {msg}",
  "#{n}": "{n}º",
  "CS": "CS",
  "CS / min": "CS / min",
  "K/D/A": "K/D/A",
  "{n} APM": "{n} APM",
  "No impact for an imported VOD": "Sin impacto en un VOD importado",
  "Impact needs a recorded game synced with Riot; imported VODs have no match data behind them.": "El impacto necesita una partida grabada y sincronizada con Riot; un VOD importado no tiene datos de partida detrás.",
  "No scoreboard for an imported VOD": "Sin marcador en un VOD importado",
  "The 10-player scoreboard comes from your own game synced with Riot. An imported video has no match behind it.": "El marcador de los diez sale de tu partida sincronizada con Riot. Un vídeo importado no tiene partida detrás.",
  "Trends on {champion}": "Tendencias con {champion}",
  "Ganks": "Ganks",
  "Power spikes": "Picos de poder",
  "Deaths on the map": "Muertes en el mapa",
  "Map awareness before deaths": "Atención al mapa antes de morir",

  // widgets: mapa táctico
  "Kills": "Kills",
  "Deaths": "Muertes",
  "{n} of {total} events": "{n} de {total} eventos",
  "No positions for this game": "Sin posiciones en esta partida",
  "Map positions come from Riot's timeline. Sync the game with Riot and they show up here.": "Las posiciones del mapa salen de la timeline de Riot. Sincroniza la partida y aparecen aquí.",
  "Click to jump": "Clic para saltar",
  "Click any point on the map to jump the video to that play.": "Haz clic en cualquier punto del mapa para llevar el vídeo a esa jugada.",

  // widgets: atención al mapa
  "No deaths in this game": "Ninguna muerte en esta partida",
  "This panel checks what you looked at in the {n} seconds before each death.": "Este panel mira qué miraste en los {n} segundos previos a cada muerte.",
  "Whether you checked the minimap or an ally in the {n} seconds before dying.": "Si miraste el minimapa o a un aliado en los {n} segundos previos a morir.",
  "Died with no information": "Muerte sin información previa",
  "Map check on record": "Con miradas al mapa registradas",
  "looks: {n}": "miradas: {n}",
  "No look in the previous {secs} s before {n} of your {total} deaths.": "Sin una sola mirada en los {secs} s previos a {n} de tus {total} muertes.",
  "Every death had a look behind it. The problem was not information.": "Todas las muertes llevaban una mirada detrás. El problema no fue la información.",

  // widgets: picos de poder
  "No purchases recorded": "Sin compras registradas",
  "Item purchases come from Riot's timeline. Sync the game with Riot to see them.": "Las compras salen de la timeline de Riot. Sincroniza la partida para verlas.",
  "Kills and assists you took in the {n} minutes after each purchase.": "Kills y asistencias en los {n} minutos siguientes a cada compra.",
  "+{n} K/A": "+{n} K/A",
  "Show fewer": "Ver menos",
  "Show {n} more": "Ver {n} más",

  // widgets: ganks
  "Analyzed with the old detector": "Analizada con el detector antiguo",
  "Hit \"Refresh Riot data\" to recompute these ganks with lane, outcome and a precise timestamp.": "Pulsa «Actualizar datos de Riot» para recalcular los ganks con carril, resultado e instante precisos.",
  "No ganks detected": "Sin ganks detectados",
  "The detector only looks at the early game, and only at lanes you actually entered.": "El detector solo mira la fase temprana, y solo los carriles en los que entraste.",
  "Any result": "Cualquier resultado",
  "Converted": "Efectivo",
  "No result": "Sin resultado",
  "Failed / you died": "Fallido / muerte",
  "Cut the retreat": "Cortando la retirada",
  "Straight down the lane": "Entrada frontal",
  "confidence {n}%": "confianza {n}%",
  "How sure the detector is: it rises with the enemy on top of you, the ally present, and the time you held the lane.": "Cuánto se fía el detector: sube con el rival encima, el aliado presente y el rato que aguantaste en la línea.",
  "Estimated by interpolating between minute frames: ±{n} s": "Instante estimado interpolando entre fotogramas de minuto: ±{n} s",
  "Exact instant: anchored to a game event": "Instante exacto: anclado a un evento de la partida",
  "No ganks match this filter.": "Ningún gank coincide con el filtro.",
  "{a} of {b} flanks converted, {c} of {d} frontal entries.": "{a} de {b} flanqueos convertidos, {c} de {d} entradas frontales.",
  "{a} of {b} flanks converted. No frontal entries this game.": "{a} de {b} flanqueos convertidos. Ninguna entrada frontal esta partida.",
  "{a} of {b} frontal entries converted. You never cut the retreat.": "{a} de {b} entradas frontales convertidas. Nunca cortaste la retirada.",
  "{n} visits to {lane} with nothing to show for them.": "{n} visitas a {lane} sin sacar nada.",
  "You ended up dead in {n} of them.": "Terminaste muerto en {n} de ellos.",

  // widgets: curva de oro y tendencias
  "No minute-by-minute data": "Sin datos minuto a minuto",
  "The curve needs at least two minute frames from Riot's timeline.": "La curva necesita al menos dos fotogramas de minuto de la timeline de Riot.",
  "Team gold": "Oro del equipo",
  "Your gold": "Tu oro",
  "Your XP": "Tu XP",
  "min {n}": "min {n}",
  "g": "g",
  "XP": "XP",
  "Against your {n} previous games on {champion} in the same queue and role. Win rate {pct}%.": "Contra tus {n} partidas anteriores con {champion} en la misma cola y rol. Winrate {pct}%.",
  "First game on {champion} in this queue and role — nothing to compare against yet.": "Primera partida con {champion} en esta cola y rol — todavía no hay con qué compararla.",
  "avg {v}": "media {v}",
  "same as your average": "igual que tu media",
  "{v}g vs your average": "{v}g respecto a tu media",
  "{v}% vs your average": "{v}% respecto a tu media",
  "{v} APM vs your average": "{v} APM respecto a tu media",

  // HUD sobre el vídeo
  "No gold data": "Sin datos de oro",
  "Your team's total gold lead over the enemy team, updated second by second": "La ventaja total de oro de tu equipo sobre el rival, actualizada segundo a segundo",
  "Your gold against your direct opponent ({role}, {champion}), in real time": "Tu oro contra tu rival directo ({role}, {champion}), en tiempo real",
  "Your gold against your direct lane opponent, in real time": "Tu oro contra tu rival directo de carril, en tiempo real",
  "{v}g team": "{v}g equipo",
  "{v}g vs {role}": "{v}g vs {role}",
  "lane": "carril",

  // entrenamiento
  "Change key": "Cambiar tecla",
  "Press a key, or Escape to cancel": "Pulsa una tecla, o Escape para cancelar",
  "Modifiers on their own can't be a camera key.": "Un modificador suelto no puede ser una tecla de cámara.",
  "The in-game reader doesn't understand numpad keys yet.": "El lector de partida todavía no entiende el teclado numérico.",
  "Unsupported key. Use a letter, a number, F1–F12, Space or Tab.": "Tecla no admitida. Usa una letra, un número, F1–F12, Espacio o Tab.",
  "Unsaved changes": "Cambios sin guardar",
  "Discard unsaved changes?": "¿Descartar los cambios sin guardar?",
  "Your camera keys and drill settings have changes that were never saved.": "Tus teclas de cámara y los ajustes de los ejercicios tienen cambios que no se guardaron.",
  "Discard": "Descartar",
  "Couldn't save the training settings: {msg}": "No se pudieron guardar los ajustes de entrenamiento: {msg}",
  "Couldn't show the overlay: {msg}": "No se pudo mostrar el aviso: {msg}",
  "It only draws over borderless or windowed games. In exclusive fullscreen the game owns the screen and nothing can paint on top.": "Solo se dibuja sobre partidas en ventana o en ventana sin bordes. En pantalla completa exclusiva el juego es dueño de la pantalla y nada puede pintar encima.",
  "Show the overlay for a few seconds. Run it with the game open to confirm it draws on top.": "Muestra el aviso unos segundos. Pruébalo con el juego abierto para confirmar que se dibuja encima.",
  "{n} ms": "{n} ms",
  "Loading your sampled games…": "Cargando tus partidas muestreadas…",
  "Post-game quiz sampling is off, so no game state is being recorded. Turn it on in Setup and play a game.": "El muestreo del quiz está apagado, así que no se está guardando el estado de la partida. Actívalo en Ajustes y juega una partida.",
  "Unknown champion": "Campeón desconocido",
  "Couldn't build the quiz: {msg}": "No se pudo montar el quiz: {msg}",
  "Couldn't mark the quiz: {msg}": "No se pudo corregir el quiz: {msg}",
  "Couldn't read your champion pool.": "No se pudo leer tu pool de campeones.",
  "Couldn't read your champion pool. Click to try again.": "No se pudo leer tu pool de campeones. Pulsa para reintentar.",
  "Frames skipped because the image would not load: {n}. They were not counted.": "Fotogramas saltados porque la imagen no cargaba: {n}. No cuentan.",
  "A role appears — press its camera key. Target: under {ms} ms with 95% accuracy, without looking at the keyboard.": "Sale un rol — pulsa su tecla de cámara. Objetivo: menos de {ms} ms con un 95% de acierto, sin mirar el teclado.",

  // ---- ajustes: grabación, teclas, disco (agente ajustes)
  "Resolution": "Resolución",
  "Native": "Nativa",
  "Native records at the game's window size (up to 1440p)":
    "Nativa graba al tamaño de la ventana del juego (hasta 1440p)",
  "Encoded on the GPU (NVENC), so your in-game FPS is untouched.":
    "Se codifica en la GPU (NVENC), así que tus FPS en partida no se tocan.",
  "It records locally with hardware encoding, at the resolution you picked, so your FPS is untouched.":
    "Graba en local con codificación por hardware, a la resolución que elijas, así que tus FPS no se tocan.",
  "Hotkeys": "Atajos de teclado",
  "Save replay": "Guardar repetición",
  "Saves the last 30 seconds as a clip while recording":
    "Guarda los últimos 30 segundos como clip mientras grabas",
  "Saving…": "Guardando…",
  "Reset": "Restablecer",
  "Reset to defaults": "Valores por defecto",
  "Video goes back to 60 FPS, High quality and Native resolution.":
    "El vídeo vuelve a 60 FPS, calidad alta y resolución nativa.",
  "Storage quota goes back to {n} GB and auto-prune is turned off. Your save location is not touched.":
    "La cuota vuelve a {n} GB y el borrado automático se apaga. Tu carpeta de guardado no se toca.",
  "{used} GB of {total} GB quota used": "{used} GB de la cuota de {total} GB",
  "Drive: {free} GB free of {total} GB": "Disco: {free} GB libres de {total} GB",
  "{n} GB free": "{n} GB libres",
  "Recording stops below 1 GB free": "Por debajo de 1 GB libre no se graba",
  "Notifications": "Avisos",
  "Recording could not start": "No se pudo empezar a grabar",
  "The game is still being tracked, but without video.":
    "La partida se sigue registrando, pero sin vídeo.",
  "Recording stopped on its own": "La grabación se paró sola",
  "The rest of the game has no video.": "El resto de la partida se queda sin vídeo.",
  "Running low on disk space": "Queda poco espacio en disco",
  "Not enough free space to record this game":
    "No hay espacio libre para grabar esta partida",
  "Free up space or lower the storage quota.":
    "Libera espacio o baja la cuota de almacenamiento.",
  "Replay clip saved": "Clip de repetición guardado",
  "Reveal": "Ver en la carpeta",
  "Could not save the replay clip": "No se pudo guardar el clip de repetición",

  // ---- hoy y onboarding (agente hoy)
  // Tira de estado de "Hoy"
  "{key} saves the last 30 s": "{key} guarda los últimos 30 s",
  "Checking key…": "Comprobando la clave…",
  "Riot key OK": "Clave de Riot correcta",
  "No Riot key": "Sin clave de Riot",
  "Riot key expired": "Clave de Riot caducada",
  "Riot key rejected": "Riot rechaza tu clave",
  "Updating library": "Actualizando la biblioteca",

  // Primer arranque sin partidas
  "Play a game — it records itself": "Juega una partida: se graba sola",
  "LeagueRecorder watches for the League client. When a game starts it begins recording, and when it ends it syncs with Riot and files the game here. There is nothing to press.":
    "LeagueRecorder vigila el cliente de League. Cuando empieza una partida se pone a grabar, y al terminar la sincroniza con Riot y la archiva aquí. No hay nada que pulsar.",
  "Add your Riot key": "Añade tu clave de Riot",
  "Fix your Riot key": "Arregla tu clave de Riot",
  "Import a VOD": "Importar un VOD",
  "Your Riot key is working: the scoreboard, your rank and your impact score will be there from the first game.":
    "Tu clave de Riot funciona: el marcador, tu rango y tu nota de impacto estarán desde la primera partida.",
  "Without a Riot key the app still records and tracks your games; the scoreboard, rank and impact score need one.":
    "Sin clave de Riot la app sigue grabando y registrando tus partidas; el marcador, el rango y la nota de impacto sí la necesitan.",

  // Última partida
  "Last game": "Última partida",
  "See all": "Ver todas",
  "of 10 by impact": "de 10 por impacto",
  "top {n}% in your role": "top {n}% en tu puesto",
  "impact not computed yet": "impacto sin calcular todavía",
  "Tracked without video — the recording could not start, so only the data of this game was kept.":
    "Registrada sin vídeo: la grabación no pudo arrancar, así que de esta partida solo quedaron los datos.",
  "Open this game": "Abrir esta partida",
  "Review this game": "Revisar esta partida",
  "won": "ganado",
  "lost": "perdido",
  "even": "igualado",

  // Punto ciego
  "Couldn't read your camera looks": "No se pudieron leer tus miradas",
  "No camera data yet": "Aún no hay datos de cámara",
  "No lane stands out yet": "Todavía no destaca ningún carril",
  "The look reports are on disk but could not be read this time. It retries on the next visit.":
    "Los informes de miradas están en disco pero esta vez no se pudieron leer. Se reintenta al volver a entrar.",
  "This comes from the minimap looks detected in your recorded games. It appears once a game has been analysed.":
    "Sale de las miradas al minimapa detectadas en tus partidas grabadas. Aparece en cuanto se analice una.",
  "Across {games} games with look data, no lane is clearly the worst yet ({n} games and a 1:30 gap are needed).":
    "En {games} partidas con datos de miradas, ningún carril destaca todavía como el peor (hacen falta {n} partidas y un hueco de 1:30).",

  // Presión
  "In your last {games} games you absorbed {windows} stretches with more enemies on you than allies.":
    "En tus últimas {games} partidas aguantaste {windows} tramos con más rivales encima que aliados.",
  "Meanwhile your team took {towers} towers and {gold}k gold elsewhere — {wpa}% of win probability you did not get credit for.":
    "Mientras tanto tu equipo se llevó {towers} torres y {gold}k de oro lejos de allí: un {wpa}% de probabilidad de victoria que no se te apuntó.",
  "Nothing measured yet": "Todavía no hay nada medido",
  "Pressure is read from the enemy positions of your synced games. It appears once a few games have synced with Riot.":
    "La presión se lee de las posiciones rivales de tus partidas sincronizadas. Aparece cuando unas cuantas se hayan sincronizado con Riot.",

  // Tendencia
  "Trend": "Tendencia",
  "last {n} games vs the {p} before": "últimas {n} partidas frente a las {p} anteriores",
  "your last {n} games": "tus últimas {n} partidas",
  "win rate": "victorias",
  "pts": "pts",
  "avg impact percentile": "percentil de impacto medio",
  "needs impact on more games": "hace falta impacto en más partidas",
  "From your recorded games only. Two windows of ten: it points at a direction, it doesn't grade you.":
    "Solo con tus partidas grabadas. Dos ventanas de diez: señala una dirección, no te pone nota.",

  // Por revisar
  "moments reviewed": "momentos revisados",
  "Nothing pending: you went through every recorded game.":
    "Nada pendiente: has repasado todas las partidas grabadas.",

  // ---- asistente de primer arranque
  "Set up LeagueRecorder": "Configurar LeagueRecorder",
  "Step {n} of {total}": "Paso {n} de {total}",
  "Go to step {n}": "Ir al paso {n}",
  "Language & account": "Idioma y cuenta",
  "How it records": "Cómo graba",
  "After the game": "Después de la partida",
  "Three things the app cannot guess. Everything else it works out on its own.":
    "Tres cosas que la app no puede adivinar. Todo lo demás lo resuelve sola.",
  "Interface language": "Idioma de la interfaz",
  "optional": "opcional",
  "Check key": "Comprobar la clave",
  "Paste a key first, or skip this: the app records without it.":
    "Pega antes una clave, o sáltate esto: la app graba igual sin ella.",
  "Without a key the app still records and tracks your games. With one it also brings the scoreboard, your impact score, your rank and the pressure you absorbed.":
    "Sin clave la app sigue grabando y registrando tus partidas. Con ella trae además el marcador, tu nota de impacto, tu rango y la presión que aguantaste.",
  "League is detected automatically; nothing to press.":
    "League se detecta solo; no hay nada que pulsar.",
  "Save folder": "Carpeta de guardado",
  "That is the whole setup. This is what happens next.":
    "Eso es toda la configuración. Esto es lo que pasa a partir de ahora.",
  "You play.": "Juegas.",
  "The recorder starts and stops with the game. You never press anything.":
    "La grabadora arranca y para con la partida. No pulsas nada nunca.",
  "It syncs about a minute after the game ends.":
    "Se sincroniza como un minuto después de que acabe la partida.",
  "Scoreboard, rank, impact score and the pressure you absorbed land on their own.":
    "El marcador, el rango, la nota de impacto y la presión que aguantaste llegan solos.",
  "Today tells you what to work on.": "Hoy te dice en qué trabajar.",
  "One weakness at a time, with the games where it happened.":
    "Una debilidad cada vez, con las partidas en las que pasó.",
  "Library keeps every game": "La biblioteca guarda todas las partidas",
  "with its video and its review queue.": "con su vídeo y su cola de revisión.",
  "{key} saves the last 30 seconds": "{key} guarda los últimos 30 segundos",
  "while a game is being recorded, without stopping it.":
    "mientras se está grabando una partida, sin pararla.",
  "You can change all of this later in Settings.":
    "Todo esto se puede cambiar luego en Ajustes.",

  // ---- patrones: ventana temporal y umbrales
  "All time": "Todo",
  "Last 30 days": "Últimos 30 días",
  "Last 10 games": "Últimas 10 partidas",
  "This patch": "Este parche",
  "Patch {v}": "Parche {v}",
  "No games in this window. Widen the range or clear the role filter.":
    "No hay partidas en esta ventana. Amplía el rango o quita el filtro de puesto.",
  "Needs {n} more games": "Faltan {n} partidas",
  "Needs 1 more game": "Falta 1 partida",
  "comparisons that need a sample": "comparaciones que necesitan muestra",
  "Measured from the enemy positions of your synced games. It appears once a few games have synced with Riot.":
    "Se mide con las posiciones rivales de tus partidas sincronizadas. Aparece cuando unas cuantas se hayan sincronizado con Riot.",
  "all time": "histórico",

  // ---- baremos, clips y copia de seguridad (agente integración)
  // Baremos de población: la sección "Frente a tu rango" del reproductor.
  "Versus your rank": "Frente a tu rango",
  "Players in {band} on {role}": "Jugadores de {band} en {role}",
  "All players on {role}": "Todos los jugadores de {role}",
  "Iron–Silver": "Hierro–Plata",
  "Gold–Emerald": "Oro–Esmeralda",
  "Diamond+": "Diamante+",
  "Sync with Riot to compare against your rank": "Sincroniza con Riot para compararte con tu rango",
  "No benchmarks for this game yet": "Aún no hay baremos de esta partida",
  "Couldn't load the benchmarks: {msg}": "No se han podido cargar los baremos: {msg}",
  "Strong: {strong} · Work on: {weak}": "Fuerte: {strong} · A mejorar: {weak}",
  "top {n}%": "entre el {n}% mejor",
  "bottom {n}%": "entre el {n}% peor",
  "median {v}": "mediana {v}",
  // Etiquetas de las métricas del baremo. Van por variable (`t(meta.label)`),
  // así que el detector de huecos no las ve: si se quitan, salen en inglés.
  "Gold / min": "Oro / min",
  "Damage share": "Reparto de daño",
  "Vision / min": "Visión / min",
  "Wards / min": "Centinelas / min",
  "Control wards": "Centinelas de control",
  "XP @15": "EXP @15",
  "CS @15": "CS @15",
  "Solo kills": "Asesinatos en solitario",
  "Turret damage / min": "Daño a torres / min",
  "Assists": "Asistencias",
  // Y sus nombres cortos, los del resumen de arriba.
  "kill participation": "participación",
  "damage": "daño",
  "damage share": "reparto de daño",
  "vision": "visión",
  "wards": "centinelas",
  "control wards": "centinelas de control",
  "solo kills": "asesinatos en solitario",
  "turret damage": "daño a torres",
  "assists": "asistencias",

  // ---- galerías: borrado y progreso real de subida
  "Delete clip": "Borrar recorte",
  "This clip is deleted for good. The game it came from is not touched.":
    "Este recorte se borra para siempre. La partida de la que salió no se toca.",
  "Couldn't delete the clip": "No se ha podido borrar el recorte",
  "{pct}% · {sent} of {total} MB": "{pct}% · {sent} de {total} MB",
  "Delete flagged error": "Borrar error marcado",
  "This clip and the notes on it are deleted for good.":
    "El recorte y las notas que tiene dentro se borran para siempre.",

  // ---- copia de seguridad (Ajustes)
  "Backup": "Copia de seguridad",
  "Notes, flags, stats and settings. Videos are not included.":
    "Notas, errores marcados, estadísticas y ajustes. Los vídeos no van dentro.",
  "Backup file": "Fichero de copia",
  "A single zip you can keep anywhere. Restoring it only fills in what is missing here.":
    "Un único zip que puedes guardar donde quieras. Al restaurarlo solo se rellena lo que aquí falte.",
  "Export backup…": "Exportar copia…",
  "Import backup…": "Importar copia…",
  "Restoring…": "Restaurando…",
  "Choose where to save the backup": "Elige dónde guardar la copia",
  "Pick a backup to restore": "Elige la copia que quieres restaurar",
  "Backup saved": "Copia guardada",
  "Couldn't export the backup: {msg}": "No se ha podido exportar la copia: {msg}",
  "Restore a backup": "Restaurar una copia",
  "Nothing here is overwritten: only what is missing gets filled in. Games whose video is gone are recreated without it.":
    "Aquí no se pisa nada: solo se rellena lo que falte. Las partidas cuyo vídeo ya no está se recrean sin él.",
  // Se dice "completadas: 1" y no "1 completadas" a propósito: con una sola
  // partida, la plantilla en plural chirría en los dos idiomas.
  "Backup restored. Games completed: {n} · recreated without video: {m} · skipped: {s}":
    "Copia restaurada. Partidas completadas: {n} · recreadas sin vídeo: {m} · descartadas: {s}",
  "Couldn't import the backup: {msg}": "No se ha podido importar la copia: {msg}",
  "Mirror folder": "Carpeta espejo",
  "Point this at a OneDrive or Google Drive folder and every note and stat is synced automatically.":
    "Apúntala a una carpeta de OneDrive o Google Drive y cada nota y cada estadística se sincronizan solas.",
  "Not set": "Sin configurar",
  "Turn the mirror off": "Apagar el espejo",
  "Clear": "Quitar",
  // Mantenimiento de la biblioteca al arrancar. Las fases llegan por variable.
  "Updating library: {phase} {done}/{total}": "Actualizando la biblioteca: {phase} {done}/{total}",
  "migration": "migración",
  "camera": "cámara",
  "impact": "impacto",

  // ---- volver a lanzar el asistente de primer arranque
  "First-run setup": "Asistente de primer arranque",
  "Run setup again": "Repetir la configuración",
  "Run setup": "Empezar",
  "The setup wizard opens over the app, with what you already configured inside. Nothing is deleted.":
    "El asistente se abre encima de la app, con lo que ya tengas configurado dentro. No se borra nada.",

  // ---- patrones: contra tu rango (agente patrones)
  // La tarjeta "Frente a tu rango" de Patrones: la media de percentiles de las
  // últimas veinte clasificatorias sincronizadas. Las etiquetas de las
  // métricas y los tramos ya están más arriba: las comparte con el reproductor.
  "players of your rank in your role": "jugadores de tu rango en tu puesto",
  "average percentile against players of your rank in your role":
    "percentil medio frente a los jugadores de tu rango en tu puesto",
  "Not enough synced ranked games": "Faltan clasificatorias sincronizadas",
  "Needs 1 more synced ranked game": "Falta 1 clasificatoria sincronizada",
  "Needs {n} more synced ranked games": "Faltan {n} clasificatorias sincronizadas",
  "no benchmarks came back": "no ha llegado ningún baremo",
  "mixed ranks": "rangos mezclados",
  "Mixed roles in this window, ordered for {role}":
    "Puestos mezclados en esta ventana; ordenado para {role}",
  "rank median": "mediana del rango",
  "Strongest: {a} and {b} · weakest: {c} and {d}":
    "Lo mejor: {a} y {b} · lo peor: {c} y {d}",
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

