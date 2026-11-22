# MicroLab 1.5.17: qué hace y qué nos llevamos a Wardline

Análisis del 2026-11-20 con REA 6.10.1 sobre la instalación de
`%LOCALAPPDATA%\Programs\microlab` (versión 1.5.17, la misma que el instalador de
Descargas, así que no hizo falta abrirlo). Todo es análisis estático: no se
ejecutó la app ni se contactó con sus servidores.

Informes detallados, con fórmulas, constantes, archivo:línea y evidence_id de REA:

- [Clics y patrones](analisis-microlab-2026-11/clics-y-patrones.md)
- [Clears de jungla](analisis-microlab-2026-11/clears-de-jungla.md)
- [Análisis de IA](analisis-microlab-2026-11/analisis-ia.md)

Los bundles de evidencia de REA que citan se quedaron en el scratchpad de la
sesión, que es temporal; los evidence_id sirven de referencia, no para reabrirlos.

## Cómo se analizó

- **App**: Electron 33 con el código JS **sin minificar** (`app.asar`, 3.325
  archivos). REA lo inventarió y lo extrajo con `integrity_policy =
  record-and-continue`: el `.node` nativo está firmado después de empaquetar y no
  casa con el hash declarado, lo normal según REA.
- **Ghidra no hizo falta.** La ruta de REA para Electron es el análisis estático de
  JS, que no necesita motor nativo. El único binario propio,
  `microlab-recorder.win32-x64-msvc.node` (Rust + napi-rs, 862 KB), se inspeccionó
  con las herramientas PE de REA:
  - exporta un solo símbolo, el registro de napi;
  - sus importaciones son WGC/D3D11, Media Foundation (`MFCreateSinkWriterFromURL`),
    audio por proceso (`ActivateAudioInterfaceAsync`), `GetAsyncKeyState` y
    ventanas;
  - el loader JS expone 17 funciones, todas de grabación, foco o rectángulo de la
    ventana, codificadores y estado de botones.

  Es un grabador y nada más: no lleva modelo ni análisis. Si algún día quieres su
  pseudocódigo, REA pide Ghidra 12.2 o posterior y JDK 21, que no hay en esta
  máquina y REA no instala.

## Respuesta corta a «qué IA hace»

**En la 1.5.17, ninguna activa.**

- **El coach de IA está apagado de fábrica.** `js/core/app-features.js` fija
  `aiCoach: false` con el comentario «held back for 1.5.3», y la página del
  asistente ni siquiera viene en el paquete.
- **Cómo sería ese coach.** Un agente de Claude (Anthropic) detrás de su Worker
  `clips.microlab.gg/api/assistant`:
  - el servidor guarda el modelo, el *system prompt* y la clave;
  - el bucle de herramientas corre en la app: 23 herramientas que leen tu base
    local, la API del juego y match-v5;
  - al modelo solo le llega texto, nunca vídeo ni imágenes;
  - lo paga MicroLab con la suscripción Pro.
- **El resto del «análisis» son reglas escritas a mano:**
  - muertes clasificadas y con coste en oro;
  - actividad y sequías;
  - clips automáticos;
  - una puntuación de impacto;
  - un HMM clásico para estimar dónde estaba tu campeón;
  - `expert-knowledge.json`, con 21 consejos firmados para 7 campeones.
- **«Entrenar modelos de IA» es la sincronización en la nube.** Viene **activada
  por defecto** (`cloud-sync.js:27`, «opt-out model»). Si has iniciado sesión,
  sube cada partida a `…execute-api.us-east-1.amazonaws.com/dev/upload-game`:
  - la trayectoria completa del cursor, los clics y las teclas;
  - las estadísticas;
  - tu Riot ID, región y rango.

  El ajuste dice «anonymous», pero lleva tu Riot ID. **Si mantienes MicroLab
  instalado, apaga Settings → Cloud Sync.**

Conclusión: para igualar a MicroLab no hay que entrenar nada ni pagar nada. Lo único
de pago que tienen, el LLM, está apagado.

## Las dos funciones, frente a lo que ya tiene Wardline

### 1. Patrones de clics (Inputs + Expanded View)

**Qué hace MicroLab**, todo local y determinista. Capta con `uiohook-napi` el
movimiento por eventos (descarta muestras a menos de 8 ms y de 1 px), los clics al
pulsar y las teclas con su duración.

- **Seis tarjetas**, cada una con un delta contra la partida anterior:
  - **APM**: (clics + teclas) / minutos.
  - **Traveled**: recorrido del cursor pasado a metros.
  - **Efficiency**: Σ recta / Σ recorrido real entre clics consecutivos.
  - **Spread**: distancia media entre clics.
  - **Tempo**: (N−1)/duración en Hz, con un botón que lo hace sonar como
    metrónomo a 660 Hz.
  - **Idle**: ventanas de 1 s o más con menos de 5 px de desplazamiento,
    descontando el tiempo muerto.
- **Vista previa** con trazo o *heatmap*:
  - celdas de 2 px y gaussiana separable con σ = 1,2;
  - normalización al percentil 99,9 y curva logarítmica con k = 20;
  - una caja arrastrable que cuenta «visitas»: estancias de al menos 1 s,
    separadas por 4 s sin entrar.
- **Expanded View**:
  - Secuencia de 15 clics elegida con clic derecho, coloreada por eficiencia
    (verde desde 0,9, amarillo desde 0,7, naranja desde 0,5).
  - Ranking de ventanas de 10 clics sin solapar.
  - Ritmo por botón, izquierdo = ataque y derecho = movimiento: frecuencia,
    intervalo, desviación, CV y consistencia = 100·e^(−CV/50). Metrónomo audible
    a 880 y 440 Hz.
  - Saltos a kills, muertes y asistencias con ±10 s.

**Qué ya tiene Wardline.**

- `ultimate.rs` graba:
  - el movimiento a unos 30 Hz (cada 33 ms);
  - los clics izquierdo y derecho;
  - las teclas Q-F con la posición del cursor;
  - el contador de APM.
- `hands.rs` saca la geometría de los clics de giro.
- `camera_input.rs` saca los clics de minimapa.
- La estela vive en `estela.bin`.

Es decir, **los datos ya están grabados en todas tus partidas** y todo se puede
calcular hacia atrás.

**Qué falta.** Las tarjetas de Traveled, Efficiency, Spread, Tempo e Idle; el
*heatmap* con caja; el selector de secuencias; el ranking de ventanas; y el ritmo
audible después de la partida.

**Qué podemos hacer mejor que ellos.** Sus fallos, documentados en el informe:

- Su Idle y su «solo vivo» se rompen tras la primera muerte porque nunca les
  llega el `respawn`. Nosotros tenemos los intervalos de muerte del timeline.
- Mezclan píxeles físicos con DIP.
- Fijan el minimapa a 1080p sin `MinimapScale`.
- El delta contra «la partida anterior» es ruido. Mejor contra tu mediana de las
  últimas 10, como ya hacen los baremos.

**Ojo:** a 30 Hz, el recorrido de un trazo curvo sale algo más corto, y por tanto
la Efficiency algo más alta. Si se quiere su precisión, hay que grabar por evento
con su regla de 8 ms y 1 px. Eso solo vale para partidas nuevas y engorda la
estela.

**Hecho (2026-11-22, sin commit): bloque «Tus clics»** en la hoja de estadísticas
de cada partida. Cálculo en `src-tauri/src/clics.rs` (`get_click_patterns`),
pantalla en `ClicksSection.tsx`.

- **Seis cifras:** APM, recorrido por minuto vivo, eficiencia (con la dispersión
  de subtítulo), paneos por el borde, clics por segundo y ratón quieto. Cada una
  lleva una flecha frente a tu mediana de las 10 partidas anteriores.
- **Mapa de calor** del cursor (por tiempo) o de los clics, con el minimapa y el
  centro dibujados. Se puede arrastrar una caja y cuenta las visitas, con la
  regla de MicroLab de 4 s y 1 s; cada visita lleva al vídeo.
- **Tramos de 10 clics:** primero los más torcidos y después los más rectos. Al
  elegir uno se dibuja su camino; con ▶ se ve en el vídeo.
- **Ritmo por botón** con regularidad 100·e^(−CV/50) y metrónomo, que solo
  suena en la hoja.

Diferencias con MicroLab, todas a propósito:

- Solo cuenta el tiempo vivo de la partida. Las muertes salen de la timeline,
  con su temporizador.
- Cifras por minuto vivo y distancias a escala de 1080p.
- El ratón quieto se mide como racha anclada, no por ventanas. Así una pausa que
  empieza moviéndose no se pierde.
- Los pares de clics con un viaje al borde en medio no cuentan para la
  eficiencia: son paneos de cámara, y se cuentan aparte.

Medido en la partida del 21-11 (Gwen): sin quitar los paneos, la eficiencia daba
72 %; quitándolos, 80 %, con 115 paneos (4,9 por minuto). Los peores tramos eran
todos viajes del cursor a una esquina y vuelta.

**Hecho después (2026-11-22, sin commit): pantalla propia «Tus clics»** en el
raíl, a petición del usuario. Lleva tres cosas:

- Tus seis cifras, en mediana de tus 10 últimas partidas y con una minigráfica.
- La comparación con **DOPA Tools** (maurogarih.com/herramientas/dopa), en su
  opción «Evaluar ángulo 45°». Allí una orden vale si su rumbo, del campeón al
  clic, cae a ±18° o menos de una diagonal (`isAngleOptimal`, `ne = 18`); el
  «modo purista» pide además un anillo de 400 px.
- Una lista partida a partida; cada fila abre la partida en el bloque «Tus
  clics».

**La comparación se mide desde tu campeón, no desde el centro de la pantalla.**
En la partida del 22-10, que tenía las barras leídas, tu campeón estaba de
mediana a 0,115 del alto del centro. Desde el centro, el rumbo erraba una
mediana de 20° y el veredicto clic a clic solo coincidía en el 61 %. Por eso
solo cuentan los clics derechos dentro de las ventanas de `barras.json` (peleas
y habilidades), y la pantalla ofrece «Leer el vídeo» en las partidas que no las
tienen.

En esa partida salió:

- En diagonal: 38,6 % de 1.555 órdenes. Al azar daría un 40 %.
- Al cambiar de rumbo (60° o más): 45,4 % de 271.
- Purista: 35,7 %.

### 2. Clears de jungla

**Qué hace MicroLab.**

- Un **catálogo de 360 clears récord**, `creator-reported`, sacados de una hoja de
  Google comunitaria: 132 campeones, del parche 25.14 al 26.22, 36 creadores, con
  vídeo de YouTube y segundo de inicio.
- Elige el más rápido para tu campeón en tu parche o uno anterior.
- Lo enseña en champ select, en la cabecera de la partida y en una pestaña.
- **No mide tu propio clear**: no hay código para tu tiempo, tu orden ni tus
  smites.

**Qué ya tiene Wardline, y va por delante.** `jungle_route.rs` (v1.2.31)
reconstruye tu primer clear al segundo: campamentos, orden, tiempo (mediana
2:55) y concordancia con `jungleMinionsKilled`.

**Qué falta.** Juntar ambas cosas en una ficha del tipo «Tu primer clear 2:56 con
X → récord 2:41 (creador, parche): +15 s», con:

- las dos rutas lado a lado (los nombres del catálogo, como `Raptors`, `Krugs`,
  `Red`… y `Recall`, se mapean a nuestros 14 campamentos);
- el vídeo en el segundo exacto;
- y, como extra que MicroLab no puede ofrecer, **tu mejor clear con ese campeón
  frente a este**, campamento a campamento, porque nosotros sí tenemos los
  tiempos parciales.

**Origen de los datos.** Mejor importar directamente la hoja pública que cita el
propio JSON (`sourceUrl`) que copiar su CDN.

**Pendiente de verificar.** La IFrame API de YouTube necesita un origen http. Ellos
sirven la página desde `127.0.0.1`; habría que comprobar si nuestro
`http://stream.localhost` sirve como origen.

## Opciones de IA: gratis o con créditos

Lo determinista ya lo tenemos y es más rico que lo suyo: coach por categorías,
muertes con precio, WPA, ganks, presión, ruta de jungla… Lo único nuevo sería
**la capa que lo cuenta en lenguaje natural**. De más barato a más caro:

1. **Gratis, ya: «Copiar para Claude».** Un botón que arma un markdown con la
   evidencia de la partida (cifras, muertes con su coste, ruta, ids) y lo pegas
   en tu suscripción de Claude. Coste extra: cero.
2. **Gratis, mejor: un servidor MCP local de Wardline**, con herramientas de
   solo lectura parecidas a sus 23: resumen de la partida, muertes, ruta, clics,
   comparar con baremos… Así Claude Code o Claude Desktop consultan tus partidas
   directamente («analiza mi última partida»). Corre con tu suscripción.
3. **Con créditos: chat dentro de la app** con tu propia clave de la API de
   Anthropic.

   Precios oficiales por millón de tokens, entrada / salida:

   | Modelo | Entrada | Salida | Lectura de caché |
   |---|---|---|---|
   | Haiku 5.5 | $0,10 | $0,50 | — |
   | Sonnet 5.5 | $2 | $10 | $0,10 |
   | Opus 5.5 | $4 | $20 | $0,20 |

   Haiku sube a $0,50 / $2,50 por encima de 100 K tokens de entrada. La API de
   lotes cuesta la mitad, y sirve para revisiones después de la partida, que no
   corren prisa.

   Estimación (**no medida**), con unos 30 K tokens de entrada y 2 K de salida por
   pregunta (seis rondas de herramientas) y una revisión al doble:

   | Modelo | Por pregunta | 5 revisiones al día, al mes |
   |---|---|---|
   | Haiku 5.5 | ~$0,004 | ~$1 |
   | Sonnet 5.5 | ~$0,09 | ~$25, o ~$13 por lotes |
   | Opus 5.5 | ~$0,16 | ~$50, o ~$25 por lotes |

   La caché de prompts lo baja más.
4. **Modelo local** (p. ej. con Ollama en la RTX 5070 Ti, 16 GB): gratis y
   privado. Para redactar a partir de evidencia ya estructurada puede bastar; para
   un bucle de herramientas de varios pasos rinde claramente peor. No medido aquí.
5. **Entrenar algo propio**: no hace falta para nada de lo anterior. Donde sí
   tiene sentido entrenar es en visión, y eso ya lo hacemos gratis en local (YOLO
   del analizador de VODs).

## Orden propuesto

1. **Patrones de mano**: tarjetas, *heatmap* con caja, secuencias y ritmo audible.
   Los datos ya están grabados, sirve para todas tus partidas y el riesgo es bajo.
2. **Clears récord**: importar la hoja, ficha de «tu clear frente al récord» con
   el vídeo, y tu mejor clear por campeón.
3. **IA gratis**: «Copiar para Claude» primero; el servidor MCP local si te
   convence.

Nada de esto va encima del juego (seguimos sin overlays informativos en
partida): el metrónomo audible es para después de la partida.
