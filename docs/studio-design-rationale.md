# LeagueRecorder Studio — propuesta de rediseño

15 de septiembre de 2026. Propuesta para revisión postpartida personal y de equipo. No constituye validación con coaches de LEC ni certificación de calidad profesional. El prototipo utiliza equipos, datos, posiciones y anotaciones de ejemplo; no incorpora grabaciones reales, servicios de colaboración ni acceso a datos de esports.

## Qué fundamenta esta propuesta

Una tesis de TU/e de 2024 observó tres sesiones de un equipo y entrevistó a seis equipos europeos profesionales y semiprofesionales. Describe tareas diferentes para revisión de scrims, scouting y análisis del meta, así como práctica con objetivos y revisión posterior. Es evidencia cualitativa útil, de alcance limitado; no demuestra que este diseño sirva a toda la LEC. [Roelofs, *Fog of War*](https://pure.tue.nl/ws/portalfiles/portal/335720815/Master_Thesis_Joris_Roelofs.pdf).

Riot documentó acceso seguro a datos privados de scrims mediante su Team Data Portal. Eso respalda tratar la confidencialidad como parte de la experiencia de equipos; no significa que LeagueRecorder tenga acceso al portal o a sus datos. [LoL Esports, datos seguros en competición](https://lolesports.com/en-US/news/how-secure-data-is-leveling-up-lol-esports-professional-competition).

Las decisiones que siguen son propuestas de diseño derivadas del producto existente y de esas tareas; requieren evaluación con usuarios.

## Dos contextos, una herramienta

- **Personal:** entrar a la última partida, revisar un momento, anotar una conclusión, elegir un hábito y comprobarlo en posteriores partidas.
- **Equipo:** identificar bloque y partida, seleccionar fuentes, revisar una situación con su contexto, discutir una hipótesis, acordar una acción y preparar la siguiente sesión.

El selector de espacio cambia el contexto, no establece una jerarquía entre jugadores «normales» y profesionales. No ofrece capacidades ficticias en función del rango. Un jugador competitivo puede usar la revisión completa; un coach también puede elegir una vista simple.

## Decisiones centrales

1. **La mesa de revisión es el centro.** El área visual, el momento seleccionado y el inspector están juntos. La agenda queda debajo; los análisis agregados tienen otra pantalla. Se elimina la gran portada motivacional como centro del uso profesional.
2. **Una nota distingue observación, hipótesis y acción.** Tiene autor, responsable y tiempo. Así el análisis automático o la opinión del coach no se presentan como hechos incontrovertibles.
3. **Contexto antes que resultado.** El observador no representa la información disponible para cada jugador. POV y comunicaciones deben ser fuentes reales, opcionales y sincronizadas. En la demo su representación es conceptual.
4. **Comparación explícita.** El prototipo contrasta una situación con una referencia táctica hipotética, claramente rotulada. En producto, una comparación entre partidas necesita dos fuentes reales, ejes temporales independientes y un ancla común elegida por el revisor; no debe fingir sincronización.
5. **Preparación de la sesión.** Los momentos seleccionados forman una agenda. Las notas escritas aparecen en el cuaderno y en el informe local. No se confunde «marcar revisado» con «demostrar mejora».
6. **Conservación de contexto estadístico.** SoloQ, scrims y oficiales no se agregan indiscriminadamente. Cada comparación necesita periodo, muestra, parche, rol/lado y criterio de selección. Un criterio manual, como «MID disponible», muestra quién lo definió.
7. **Scouting con alcance honesto.** La pestaña Draft ilustra un registro manual de contexto. No promete acceso automático a bases profesionales, no recomienda picks y no transforma datos incompletos en una predicción confiable.
8. **Privacidad antes de compartir.** El flujo propone elegir material y destino. No hay enlace público como destino predeterminado para scrims. Un sistema real necesitará autorización, revocación, roles y registros de acceso; un icono de candado no los implementa.
9. **Degradados con función.** Marino para la base, violeta en evidencia y selección, oro para acción principal, jade/rosa con etiquetas para resultados. Los campos, tablas y texto se mantienen sobre superficies legibles. La preview permite ajustar densidad e intensidad del degradado.
10. **Sin donaciones en mitad del trabajo.** Apoyar vive al final de la navegación. La continuidad del proyecto puede motivar una aportación; la herramienta no debe interrumpir una revisión para solicitarla.

## Cobertura y cambios de arquitectura

| Aplicación actual | Propuesta |
|---|---|
| Hoy | Sesión: foco personal o agenda de equipo. |
| Biblioteca | Mantener filtros y partidas; añadir bloques y fuentes en el contexto de equipo. |
| Reproductor dentro de Biblioteca/Análisis | Revisión como espacio de trabajo, conservando video, notas, Partida, Impacto y Eventos/Análisis. |
| Clips | Conservar reproducción, favoritos y exportación; añadir agenda y preparación de material de equipo. |
| Errores | Cuaderno: conservar errores y categorías; incluir aciertos, hipótesis y decisiones sin sesgo exclusivamente negativo. |
| Patrones | Conservar análisis actuales; añadir comparaciones por contexto y evidencia rastreable. |
| Entrenamiento | Mantener ejercicios, conciencia, teclas y metrónomo; conectar objetivos y evaluación posterior. |
| Análisis | Análisis de video: importación y ficha de fuentes/sincronización. |
| Ajustes | Grabación, Almacenamiento, Cuenta y datos, Equipo y acceso, Avanzado. |
| Onboarding | Prueba explícita de captura, audio y reproducción antes de la primera partida. |

Los grupos de funciones de cada pantalla están documentados también dentro de la preview. No todos se implementan como controles funcionales en el prototipo: el objetivo es evaluar arquitectura, jerarquía y flujos, no simular un analizador completo.

## Qué se puede probar en la preview

- Cambiar entre espacio personal y equipo.
- Navegar por todas las pantallas.
- Elegir tres momentos y cambiar la representación de perspectiva.
- Mostrar un trazo táctico, comparar y activar presentación.
- Marcar momentos revisados y añadirlos a la agenda.
- Escribir notas con tipo y responsable; encontrarlas en el cuaderno.
- Preparar un informe a partir de la agenda y las notas.
- Buscar partidas y filtrar Scrim/SoloQ.
- Explorar etiquetas de patrones, plan, ejercicios y ajustes.
- Revisar un flujo de envío con destino local o público, sin transmisión real.

Las notas y decisiones duran mientras permanezca cargada la preview. Se separan entre espacio personal y equipo, y las notas conservan el minuto en que se empezó a anotarlas aunque se navegue a otro momento. No se escribe en las partidas ni se atribuye persistencia de producción. Elegir un POV ausente muestra la falta de fuente y una salida para vincularla, sin inventar lo que veía el jugador.

La comprobación en navegador cubrió las diez pantallas, anotación y recuperación en el cuaderno, separación de espacios, preparación del informe, comparación, presentación y POV ausente. No aparecieron errores de JavaScript en ese recorrido. Se inspeccionó la mesa de revisión a 1024 px y se comprobó ausencia de desbordamiento horizontal en las diez pantallas a 320 px. Esto verifica el prototipo, no la captura o el análisis de la aplicación nativa.

## Cómo decidir si el rediseño funciona

Pruebas exploratorias separadas con jugadores y coaches/analistas; incluir al menos un usuario que dirija revisiones de equipo. El número inicial no debe presentarse como representativo de toda una liga.

| Tarea | Señal observable | Meta provisional, a contrastar |
|---|---|---|
| Retomar una revisión | Tiempo desde abrir hasta el momento pendiente | Menos de 20 segundos sin ayuda. |
| Guardar una conclusión | Nota vinculada al momento correcto | Completar sin perder el contexto visual. |
| Preparar una sesión | Elegir tres momentos, responsable e informe | Menos de 3 minutos, sin abrir herramientas externas. |
| Evaluar evidencia | Distinguir observación, opinión y dato ausente | Ningún participante interpreta una hipótesis como detección comprobada. |
| Compartir un scrim | Identificar qué se incluye y quién lo verá | Ningún envío público accidental en la prueba. |
| Usar teclado y escalado | Completar selección, anotación y navegación | Sin controles inaccesibles al 150 % o con teclado. |
| Comparar partidas | Reconocer diferencias de muestra y contexto | No confundir un cambio correlacional con efecto causal del entrenamiento. |

Antes de afirmar que es apta para LEC: comprobar revisión con material real autorizado, latencia de búsqueda y salto de video, fiabilidad de sincronización, privacidad verificable, recuperación de notas y trabajo de una sesión completa. El prototipo visual por sí solo no acredita ninguno de esos requisitos.
