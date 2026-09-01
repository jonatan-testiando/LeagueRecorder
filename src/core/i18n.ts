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

