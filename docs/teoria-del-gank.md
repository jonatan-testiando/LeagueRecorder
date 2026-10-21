# La teoría del gank, medida (2026-10-20)

La teoría es la del usuario (tres imágenes del 2026-10-20). Cada línea se parte por dónde está la oleada, de una torre exterior a la otra: **3 | 2 | 1 | 2 | 3**.

- **1**, el centro (en top y bot, la esquina): gankeable.
- **2**: última oportunidad de gankear.
- **3**, pegado a cada torre: ingankeable.
- **Mejor lado** en top y bot: tu 2, en su borde con el 1.

El mapa se divide en regiones como en el grabador de minimapa de referencia, `showcase 1 Minimap recorder.mov` en Descargas: Q1 oeste, Q2 sur, Q3 este, Q4 norte, mid y río superior/inferior. Es análisis post-partida: nada de overlays.

Código:

- `src-tauri/src/zonas.rs`: geometría, contexto de cada gank y los dos tests de medida.
- `gank.rs`: guarda a qué rival se fue a buscar.
- `oleadas.rs`: cada `GankCheck` lleva zona, mejor lado, entrada, zona del rival, niveles, R y vida.

## Geometría (medida, no supuesta)

| Qué | Valor | De dónde sale |
|---|---|---|
| Cortes 3/2/1 | 0,23 · 0,33 · 0,67 · 0,77 del tramo entre torres exteriores | Imagen de mid, vista cenital (las torres a la misma escala en x e y, 0,337 px/u). El color dominante cambia en 0,22 · 0,32 · 0,66 · 0,76; se hace simétrico. Bot está en perspectiva y a ojo da 0,18 · 0,33 · 0,62 · 0,80. |
| Anchura de cada zona | bot: 3 = 1.157 u, 2 = 503 u, 1 = 1.711 u; mid: 865, 376 y 1.279 u | Del eje de `gank.rs`. |
| Banda de mid | 650 u a cada lado | La tierra clara del minimapa de referencia cae a la mitad pasadas ~600 u. |
| Río | 1.100 u a cada lado de la diagonal | El agua se acaba entre 1.000 y 1.100 u. Las etiquetas del vídeo encajan: «Río superior» a 852 u y «Q2 - Sur» a 1.945. |
| Inicio del gank | Cuando pisas la línea, según tu rastro del vídeo | El kill llega 1 / 10 / 22 s después (p10/p50/p90). Sin rastro, kill − 10 s. |

## Qué variables son medibles de verdad

| Variable | ¿Medible? | Cobertura en tus 78 ganks | Notas |
|---|---|---|---|
| Zona de la oleada al empezar | Sí, con vídeo | 54 / 78 | Fotogramas clave cada ~4 s; una oleada anda ~325 u/s. **La zona 2 (380-500 u) es más estrecha que la resolución de la lectura**, así que el 2 es la zona más ruidosa. |
| Zona del rival al empezar | Sí, con la API, si un fotograma cae a ≤ 20 s | 46 / 78 (y 49 % en el corpus) | Coincide con la de la oleada en 11 de 28 casos. Cuando no, el rival suele estar más cerca de su torre que el choque (10 de 17). |
| Lado de entrada | Sí, con tu rastro del vídeo | 46 / 78 | Región justo antes de pisar la línea. |
| Diferencia de nivel | Sí, exacta | 78 / 78 | `LEVEL_UP` en milisegundos. |
| R aprendida (tuya y suya) | Sí, exacta | 78 / 78 | `SKILL_LEVEL_UP` con `skillSlot` 4. Ojo: ahí van de 1 a 4; en el desglose de daño, de 0 a 3. |
| Vida del rival | Sólo si un fotograma de minuto cae a ≤ 15 s | 36 / 78 (43 % en el corpus) | Las barras del vídeo sólo se leen en ventanas de golpes, no en ganks. |
| Flash del rival | **No** | — | Match-V5 sólo da `summoner1Casts`/`summoner2Casts` como total de la partida. La timeline no tiene lanzamientos. Flash no hace daño, así que nunca sale en `victimDamage*`. La Live Client API da los hechizos de cada jugador, pero no sus enfriamientos. |
| Enfriamientos del rival | **No** | — | Lo único que deja rastro es su R cuando hace daño en una muerte (22 % de los ganks del corpus). Y no se comporta como un enfriamiento: ver abajo. |
| Tu Flash | Sí, pero sólo en partidas nuevas | 0 / 78 | Las teclas D/F se graban desde v1.2.35 y ninguna de las 26 las tiene. |

## Lo que dicen los datos

Columna: kill / (kill + tu muerte) entre los ganks con desenlace, con su intervalo al 95 %. Los «sin resultado» del minuto son muestra, no censo (`gank.rs`), así que no entran en el porcentaje.

### Corpus: 12.974 partidas, 94.679 ganks de jungla, sólo la API

**Zona del rival al empezar (top y bot):**

| 3 tuya | 2 tuya | 1 | 2 suya | 3 suya |
|---|---|---|---|---|
| 70 % [69-72] | 76 % [74-77] | **78 % [78-79]** | 74 % [72-75] | 69 % [68-71] |

En mid, la misma forma: 56 % · 70 % · 70 % · 69 % · 63 %. Sale igual en lado azul y en lado rojo.

- **La forma de la teoría se cumple:** el 1 es lo mejor y los 3 lo peor. En top y bot son 8-9 puntos de diferencia; en mid, 7-14.
- **El «mejor lado» no gana al 1.** Queda segundo (76 % frente a 78 %, p < 0,001). Frente al 2 suyo gana por 2 puntos, pero eso no es concluyente (p = 0,09).

**Lo que más separa es el nivel:**

| Tu nivel − el del rival | −2 o menos | −1 | igual | +1 | +2 o más |
|---|---|---|---|---|---|
| kill/(kill+muerte) | 60 % | 70 % | 73 % | 80 % | 85 % |

Tu compañero de línea contra el rival va de 59 % a 78 %.

**Vida del rival:** < 50 % da 79 %; 50-80 %, 73 %; ≥ 80 %, 65 %.

**R:** con «sólo la suya» sale 64 % y con «sólo la tuya», 81 %. Está mezclado con el nivel, porque la R llega a nivel 6.

**«Su R usada en una muerte hace < 60 s»** da 66 %, frente a 71 % sin verla. No indica que la tenga en enfriamiento: indica que acaba de haber una pelea allí. **No sirve como sustituto de los enfriamientos.**

### Tus 26 partidas: 78 ganks, con vídeo

**Zona de la oleada al empezar:** 1: 22 kills / 6 muertes · 3 suya: 7/1 · 3 tuya: 2/2 · 2 tuya: 3/0 · 2 suya: ningún gank.

- **Ganqueas con la oleada en el 1 más de lo que está ahí:** 63 % de los ganks, frente al 49 % de los fotogramas clave de los primeros 15 min. En tu 3, 11 % frente a 22 %.
- Los resultados por zona no se distinguen con esta muestra (p = 1,0 entre el 1 y los 3).
- **El mejor lado (tu 2 en top y bot):** 4 ganks, con 2 kills y 2 sin resultado. No hay muestra para juzgarlo.

**Entrada:** por tu jungla o la suya, 15 kills y 0 muertes. **Por el río, 12 kills y 5 muertes** (p = 0,046). De esas 5 muertes, 3 son entrando a mid por el río de arriba.

**Nivel:** por debajo del rival, 8/6; igual o por encima, 39/7 (p = 0,058). Es la misma dirección que el corpus.

## Lo que se arregló por el camino en `oleadas.rs`

Afecta a todo lo que usa las oleadas: invasiones, ganks y objetivos.

1. **Iconos fijos colados como súbditos.**
   - Los iconos de torres e inhibidores rivales caen a 300-800 u de su estructura, fuera del radio de 420. Con una ventana de ±30 fotogramas clave, el 84 % de lo «rival» a < 900 u de una estructura no se mueve.
   - Ahora se quita lo que está fijo. De lo aliado eso quita el 0,0 % cerca de las estructuras y el 0,6 % lejos.
2. **La regla de «oleada recién salida» no se aplicaba si se veía algo suyo lejos.**
   - Es decir, casi siempre: el icono fijo contaba como «algo suyo». La mitad de las lecturas de top y bot caían detrás de tu torre exterior, junto al inhibidor.
   - Además el corte estaba en 0,3 del eje, antes de tu torre exterior (0,33-0,36). Pasado el corte había 186 lecturas por franja frente a 13 antes: un escalón, no una distribución.
   - Ahora el corte es tu torre exterior, y la distribución es continua a través de ella.
3. Efecto en ganks: la oleada en «3 tuya» pasa de 20 a 6. Los casos mirados en el vídeo eran oleadas nuevas andando detrás de tu torre, con el choque en otra parte.

## Propuesta

1. **Enseñar en la revisión** la zona de la oleada, la entrada y la diferencia de nivel de cada gank: los datos ya llegan en `GankCheck`. La teoría como etiqueta («oleada en el 1») y el nivel como contexto («llegabas un nivel por debajo»).
2. **Lo accionable para ti ahora:**
   - **entrar por la jungla y no por el río**: es la señal más fuerte de tus partidas, aunque con muestra corta;
   - **no ganquear por debajo de nivel**: la más fuerte del corpus.
3. **La zona del rival desde el vídeo.** Los iconos rivales del minimapa en el instante en que entras darían la zona del rival en el segundo exacto, y no a ±20 s. Es el siguiente paso si se quiere afinar el 2.
4. **No prometer enfriamientos ni Flash del rival:** no están en ningún dato.

## Cómo repetirlo

```
LR_REAL=1 cargo test --lib zonas::tests::teoria_del_gank_en_mis_partidas -- --nocapture
CORPUS_DIR=D:/lol-corpus cargo test --release --lib zonas::tests::teoria_del_gank_en_el_corpus -- --nocapture
```

En un worktree, con `TAURI_CONFIG='{"bundle":{"resources":[]}}'` (ver la memoria `compilar-en-worktree`). El del corpus tarda 30-50 s.
