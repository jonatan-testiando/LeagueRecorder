# LeagueRecorder: evaluación de producto y UX/UI

Fecha: 12 de septiembre de 2026. Revisión del código local, incluida la versión de trabajo sin confirmar. No se ha probado una partida real, la captura de audio/video, la precisión del analizador ni la disposición a donar de usuarios. El preview es una propuesta navegable con datos ficticios, no una reproducción exacta ni una implementación del producto.

## Dictamen

La aplicación tiene una propuesta valiosa: conservar lo que ocurrió en la partida, llevar al jugador al instante relevante y ayudarle a revisar sus hábitos. Su mayor oportunidad no es añadir más métricas: es hacer que una persona complete una revisión útil en pocos minutos y vuelva para comprobar su progreso. Esto podría motivar donaciones; el código por sí solo no permite afirmar que vaya a hacerlo.

Hay una base especialmente aprovechable: grabación automática, revisión por eventos, notas ancladas al video, clips compartibles, análisis de hábitos de cámara, patrones entre partidas y entrenamiento. Hoy ya propone un foco y muestra pendientes. Patrones ya compara puntos ciegos entre partidas. Sería incorrecto vender esas funciones como novedades pendientes.

## Prioridades para que merezca apoyo

| Prioridad | Mejora | Evidencia y oportunidad | Criterio de aceptación |
|---|---|---|---|
| P0 | Comprobar la grabación antes de depender de ella | Ajustes tiene diagnóstico de audio, disco y prueba manual; el onboarding configura pero no conduce a una prueba reproducible completa. | En una instalación limpia, grabar 10 segundos, reproducir imagen y sonido y mostrar dónde quedó el archivo. Un fallo debe tener una acción concreta. |
| P0 | Afinar las promesas de rendimiento y audio | Onboarding y Ajustes afirman que los FPS no se afectan. Ajustes describe una alternativa de micrófono si falta captura de audio del juego. | Sustituir absolutos por resultados de prueba; identificar claramente qué fuente de audio se grabará y permitir probarla. Medir consumo y cuadros perdidos en equipos representativos. |
| P0 | Una revisión corta que termine en una decisión | Ya existen cola de revisión, notas y foco en Hoy; falta hacer explícito un recorrido de inicio a cierre con un hábito elegido. | Desde Hoy, abrir tres momentos, anotar una conclusión y fijar un objetivo para la próxima sesión, sin buscar entre secciones. |
| P0 | Evidencia y límites coherentes | Presión y cruces ya aclaran que asociación no es causalidad; otras cifras deben mantener el mismo estándar. Las miradas se infieren de entradas/cámara, no de seguimiento ocular. | Toda inferencia relevante permite ver su muestra, origen, periodo, limitación y momento de video. No llamar «no miraste» a «no se detectó un cambio de cámara». |
| P1 | Vincular práctica con resultados en partidas | Entrenamiento tiene latencia e historial; Patrones tiene evolución de miradas. Falta una conexión explícita mediante un objetivo persistente. | Un ejercicio nace de un hallazgo, guarda una meta y luego compara ventanas equivalentes de partidas. Mostrar «sin datos suficientes» cuando corresponda; no atribuir causalidad al ejercicio. |
| P1 | Hacer comprensible la conservación de datos | Ya existen cuota, limpieza, favoritos protegidos, backup sin videos y carpeta espejo. | Mostrar qué se borrará, qué está protegido y qué recupera una copia. Verificar restauración; evaluar papelera temporal o ventana para deshacer según espacio disponible. |
| P1 | Simplificar compartir un aprendizaje | Clips ya sube videos y ofrece enlaces con distintas duraciones. | Antes de subir: proveedor, tamaño, vencimiento y visibilidad. Como extensión, exportar un clip con nota y contexto para un coach, con vista previa. |
| P2 | Donación contextual y transparente | No aparece una entrada de apoyo en la navegación principal revisada. | «Apoyar el proyecto» discreto; propósito concreto, aportación única o recurrente si el proveedor lo permite, changelog y agradecimiento. Nunca interrumpir grabación o revisión. |

No priorizaría un chat de IA genérico, más pronósticos, rankings sociales ni una gran capa de gamificación antes de verificar fiabilidad y uso recurrente. Su coste y complejidad pueden crecer sin resolver el problema central.

## Qué ofrecer a quien dona

Propondría apoyar el mantenimiento y la continuidad de una herramienta útil: compatibilidad con nuevos parches, correcciones, mejor revisión y documentación. Mantendría accesibles la grabación, los datos propios y el aprendizaje. Los agradecimientos opcionales y temas visuales pueden acompañar el apoyo, pero no sustituir el valor central.

Pediría apoyo después de un resultado voluntariamente reconocido por el usuario, por ejemplo al completar una revisión, con opción permanente de ocultar la invitación. Una entrada fija y discreta es suficiente al principio. No mostraría recaudación, testimonios, donantes o costes que no se puedan justificar. El precio o la conversión no se pueden estimar objetivamente con este repositorio.

## UX/UI: conservar identidad, mejorar jerarquía

1. **Mantener los degradados con significado.** El sistema actual usa marino, oro para marca/acción, jade para victoria e interacción y violeta para hallazgos; Biblioteca también distingue resultados con degradados. Conservarlos, con bases suficientemente opacas para leer. Reservar el brillo más intenso para el foco y las piezas de contenido, sin colorear cada control.
2. **Agrupar sin esconder.** Mantener las ocho entradas actuales: Hoy, Biblioteca, Clips, Errores, Patrones, Análisis, Entrenamiento y Ajustes. Agrupar visualmente colección y mejora. Aclarar «Análisis» como «Análisis de video» para distinguir la importación del análisis de una partida grabada. Evaluar con usuarios si «Errores» o «Aprendizajes» expresa mejor el cuaderno; no cambiarlo solo por suavizar el nombre.
3. **Una acción principal por pantalla.** Hoy: continuar revisión. Biblioteca: abrir una partida. Análisis: importar. Entrenamiento: comenzar el ejercicio adecuado. Las acciones destructivas van en un menú secundario con alcance claro.
4. **Ordenar el reproductor por profundidad.** Conservar Revisión, Partida e Impacto. El video y el momento seleccionado son protagonistas; estadísticas, comparativas, cámara y cálculos complejos se abren por demanda. Mostrar origen y disponibilidad, no cifras de cero cuando faltan datos.
5. **Dividir Ajustes en categorías.** La pantalla actual reúne video, atajos, almacenamiento, backups, cuenta, herramientas y opciones de desarrollo en una lista. Separar Grabación, Almacenamiento, Cuenta, Avanzado y Diagnóstico. Mantener ayudas en el punto donde se necesitan.
6. **Estado de captura visible desde cualquier sección.** La app ya tiene alertas globales; añadir un estado persistente compacto con acceso al diagnóstico. Distinguir Esperando partida, Grabando, Finalizando y Error. No saturar el contenido con indicadores repetidos.
7. **Revisar accesibilidad sobre la interfaz real.** Teclado, nombres de botones, foco, escalado al 125–150 %, contraste sobre cada extremo del degradado, objetivos táctiles y reducción de movimiento. El color debe ir acompañado de texto. No afirmo incumplimientos sin mediciones.
8. **Estados vacíos y fallos con salida.** Ya hay varios buenos estados vacíos, reintentos y recuperación del reproductor sin video. Completar su coherencia: diferenciar no instalado, no disponible para este archivo, pendiente de procesar y fallo recuperable.

## Inventario que debe cubrir el preview

| Pantalla actual | Funciones presentes en el código |
|---|---|
| Hoy | Foco por ventana de muertes; evidencia por partida; sincronización; punto ciego de cámara; presión y episodios; tendencia de victorias/impacto; pendientes de revisión; acceso a entrenamiento. |
| Biblioteca | Búsqueda por campeón/cola/fecha; derrotas y pendientes; rol; orden temporal o rendimiento; fichas con resultado, estadísticas y rival; abrir y eliminar una o varias partidas. |
| Reproductor | Reproducción, velocidad, volumen, pantalla completa, navegación por eventos, rastro del ratón y sincronización; crear clip/error; Revisión con cola y notas; Partida con estadísticas, comparativas por rango, oro/XP, marcador, tendencias, ganks, picos, mapa de muertes, conciencia de mapa, hechizos recibidos y mano; Impacto con contribución, coste de muerte, cámara por carril, análisis del minimapa y episodios de presión. Algunas vistas dependen del rol o datos disponibles. |
| Clips | Reproducir, favoritos, ordenar por fecha/tamaño, abrir partida de origen y carpeta, borrar, subir/compartir, duración del enlace, copiar/abrir enlace y volver a subir. |
| Errores | Filtrar categorías, abrir y borrar errores guardados; cuaderno con notas por tiempo, categoría, edición, eliminación y controles de reproducción. |
| Patrones | Periodo/rol; muertes por mapa y minuto; rango por partida, presión, pronóstico, progresión de LP, campeones, rivales, puntos ciegos, categorías propias y cruces. |
| Análisis | Importar MP4/MKV/AVI; procesamiento con progreso y cancelación; información de hardware; abrir resultados, carpeta y eliminar análisis sin borrar el video original. |
| Entrenamiento | Ejercicios de reflejos y recuerdo; conciencia situacional; configuración de teclas por aliado y recentrado; metrónomo/overlay y vista previa; historial de latencia. |
| Ajustes | Video: calidad/FPS/resolución; atajo de últimos 30 s; carpeta, cuota y limpieza por edad; backup/restauración y carpeta espejo; repetir onboarding; idioma, clave y región; escala del minimapa, proxy y generador de dataset; actualizaciones; prueba manual y dispositivos de audio. |
| Onboarding y globales | Idioma/cuenta, grabación y explicación posterior; barra de ventana, avisos de grabación, banner de clave, progreso de actualizaciones e instalación. |

## Validación antes de invertir en más funciones

Haría una primera prueba con 5–8 jugadores de diferentes equipos y hábitos, como estudio exploratorio, no como muestra estadísticamente representativa. Tareas: primera grabación con sonido, encontrar una muerte, guardar una lección, compartir un clip, recuperar notas y entender un hallazgo. Después, un seguimiento de dos semanas para observar si vuelven a revisar.

Mediría: grabaciones reproducibles / intentos; sesiones con audio correcto; tiempo hasta primera lección; revisiones terminadas / iniciadas; usuarios que vuelven a revisar otra semana; fallos de exportación y restauración. Recoger métricas solo con consentimiento, o llevar un registro manual durante la prueba. La valoración de utilidad y la intención de donar se preguntan después de usar la herramienta, sin confundir intención con aportaciones reales.

## Referencias locales

- `src/App.tsx`: navegación y estado de paneles.
- `src/index.css`: paleta, superficies y degradados activos. `src/App.css` no es la hoja importada por `src/main.tsx`.
- `src/features/home/components/HomePanel.tsx`: foco, pendientes, tendencias y presión.
- `src/features/player/components/VideoPlayer.tsx`, `ReviewQueue.tsx`, `ErrorPlayer.tsx`: reproductor y revisión.
- `src/features/gallery/components/`: biblioteca, clips y errores.
- `src/features/patterns/components/PatternsPanel.tsx`: análisis entre partidas.
- `src/features/training/components/`: ejercicios, configuración y overlay.
- `src/features/settings/components/SettingsPanel.tsx`, `src/features/onboarding/components/OnboardingWizard.tsx`: configuración y promesas visibles.
- `src/features/vod/components/VodGallery.tsx`: videos importados.

El documento anterior `docs/redesign-preview.html` utiliza otra paleta. Esta propuesta parte del sistema activo y de la preferencia expresa por los degradados.
