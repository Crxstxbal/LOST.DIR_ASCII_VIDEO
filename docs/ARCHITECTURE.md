# LOST.DIR — ASCII CINEMA · Arquitectura

## Cómo correrlo
- `start.bat` (o `npm run dev`) → http://localhost:5178
- `npm test`: determinismo, pies sin deslizamiento, LUT de glifos, JSON de proyecto y rostro (inversa de la orientación, resolución adaptativa, parámetros).
- `npm run face-compare`: hoja comparativa del rostro anterior y el nuevo.
- `npm run perf -- [--profile performance|balanced|quality] [--frames 12] [--shot id]`: tiempos por fotograma y desglose por etapa (animación, cada capa del escenario, pases de raster, ASCII y post) de cada plano.
- `npm run walk-compare`: escena de diagnóstico de la caminata, con la anterior (v1) y la nueva (v2): esqueleto en 12 momentos del ciclo, curvas de cadera, tobillos y velocidad del cuerpo, y render ASCII real → `exports/walk-compare.png`.
- `npm run lod-sheet`: el protagonista en 5 encuadres (primerísimo primer plano → plano general extremo) con la rejilla global, más un recorte 1:1 de cada uno → `exports/lod-sheet.png`. Acepta `--cols 240` y `--nolod`.
- `npm run render -- --shot <id|índice> --t 1,2.5 [--seq 0:4 --fps 24] [--w 1920 --h 1080] [--cols 1.5] [--raw] --out carpeta`: render sin interfaz (Node, mismo motor). Por defecto usa el tamaño de exportación del proyecto. `--cols` multiplica la rejilla global (solo para probar densidades). `--raw` además guarda los rasters internos de color y densidad, para depurar.

## Flujo de un fotograma (`src/engine/render.ts → renderFrame`)
1. **Proyecto → plano → locación.** El plano (JSON) trae cámara, actor, viento, etalonaje con claves, ASCII y efectos. La locación (`data/locations/*.json`) trae una lista de capas `{generator, params}` y parámetros editables.
2. **Locomoción** (`animation/locomotion.ts`). Pista a 120 Hz con distancia, fase de marcha y eventos de apoyo de cada pie. Mientras un pie está en apoyo, su posición es constante en el mundo, así que no se desliza. Las acciones (`caminar`, `detenerse`, `mirar`) se colocan en el tiempo. Al detenerse, el personaje da un paso de cierre y queda en reposo, con respiración y desplazamiento de peso.
3. **Pose** (`computePose`). Pelvis con doble rebote y límite de alcance de las piernas, IK de dos huesos para las rodillas, inclinación del torso, cabeza estabilizada y algo bajada, brazos bajo la capa y parpadeo.
4. **Física secundaria** (`animation/characterSim.ts`). Capa como malla verlet de 7×14 (perfil) o 9×14 (frente/espalda), con colisión contra la silueta del cuerpo. Cabello con 23 mechones sobre un cráneo 3D proyectado. Paso fijo de 120 Hz desde un pre-roll de 1,5 s, con checkpoints cada 0,5 s: hacer scrub, reproducir o exportar dan el mismo resultado.
5. **Cámara** (`camera/Camera.ts`). Pinhole 2.5D con traslación, pitch real y desplazamiento de lente. Tipos: lateral, frontal, elevada, primer plano y general extremo. Tiene seguimiento con inercia, travelling, grúa y zoom animado. No hay rotaciones falsas: cada vista del personaje tiene un dibujo propio (perfil, frente, espalda y cabeza con rasgos proyectados por ángulo).
6. **Generadores** (`scene/generators/*`). Producen elementos con profundidad. El cielo y el suelo son shaders por píxel en perspectiva. Agujas, rocas y rosas son instancias deterministas por celda del mundo. Partículas y meteoros son analíticos, sin integración.
7. **Pases.** Los elementos se reparten por profundidad en tres pases:
   - **bg:** fondo desenfocado (solo en primer plano). Se dibuja a menor resolución de raster y se reescala sobre la rejilla global: desenfoca sin cambiar el tamaño de los caracteres;
   - **main:** el pase normal;
   - **fg:** primer término cercano, que ocluye.
8. **Raster → ASCII** (`raster/Painter.ts`, `ascii/*`).
   - **Rasters:** cada pase se dibuja en dos rasters, color y *densidad de tinta*. Así una capa negra sigue siendo textura y no un hueco.
   - **Elección de glifo:** se muestrea a 2×3 por celda, una muestra por zona de forma; el antialiasing del canvas ya integra la cobertura de cada píxel. Antes eran 4×6: el resultado es prácticamente idéntico y hay 4 veces menos píxeles que rasterizar, leer y recorrer. En celdas planas se usa una rampa continua con dither. En celdas con bordes, una LUT de forma de 15 625 entradas medida contra la fuente real.
   - **Pistas de glifo:** fijan caracteres icónicos, como `@` en las rosas y `|`/`/` en los tallos.
   - **Escritura:** los glifos se escriben como máscaras de píxeles; no se usa `fillText` en tiempo de fotograma.
9. **Etalonaje** (`grading/ColorGrade.ts`). Exposición, remapeo a la paleta de 5 colores, intensidad roja, contraste, brillo, saturación y split-toning, todo animable con fotogramas clave. Después vienen el postproceso (grano, viñeta, scanlines y glitch, deterministas por fotograma) y los fundidos.

## Rostro del protagonista (v2, `character/face.ts`)
- **Referencia principal:** la ilustración a carboncillo (`References/01_CHARACTER/8f74c….jpg`). El model sheet sirve para la consistencia.
- **Volumen:** el rostro es una superficie 3D implícita en el espacio de la cabeza. Tablas de sección: ancho, frente y nuca por altura. Encima hay relieve gaussiano para puente nasal, punta, alas, cuencas, arco superciliar, pómulos, mejilla hundida, labios y mentón.
- **Render:** cada zona de forma lanza un rayo contra esa superficie; la normal sale del gradiente y la luz llega desde un lado, con terminador suave, penumbra, oclusión en cuencas, sombra del flequillo y rim rojo en el borde oscuro. Ojos (rendijas con párpado pesado), cejas, fosas nasales y boca son cambios de tono sobre la superficie, no contornos negros. Como es 3D, frontal, ¾, perfil y planos medios salen del mismo modelo.
- **Cabello:** masa con silueta irregular. Cada mechón simulado se dibuja como varios mechones de distinta densidad (oscuro, medio, brillo). El flequillo se apoya sobre la frente y se balancea con la física del pelo. Hay pelos sueltos en la silueta.
- **Cuello alto de la capa** alrededor de la mandíbula; el cuello queda corto y en sombra.
- **Detalle según tamaño:** lo decide el LOD adaptativo (ver abajo), siempre dentro de la rejilla global.
- **Aspecto global del personaje** (no por plano). Rostro, cabello, cuello y caminata pertenecen al personaje y se aplican en todos los planos, en dos capas:
  1. **Aspecto base:** `look` en `data/characters/protagonist.json`. Contiene los valores ajustados por el usuario: ancho 1,07, mandíbula 1,04, párpados 0,42, ojos 1,29, cuencas 0,1, boca 1,2, penumbra 0,77, suavidad 0,33, flequillo 1,05, volumen 0,8 y cuello 0,41.
  2. **Ajustes del proyecto:** `project.characters.<id>.face/gait`.

  Se editan en Personaje → Rostro y cabello / Caminata. "Restablecer" vuelve al aspecto base. El estilo `v1` (rostro anterior) sigue disponible para comparar. Cada plano solo guarda posición, dirección, velocidad y acciones. Los archivos anteriores (versión 2 o menor), con `face` o `gait` por plano, se migran al cargar: el primer plano que los tenga define el aspecto global.
- **Comparación:** `npm run face-compare` → `exports/face-compare.png`: referencia, anterior y nuevo en frontal, ¾, perfil, plano medio y lateral. `--face '{"eyeOpen":0.4}'` prueba otros valores.

## Resolución ASCII global y LOD adaptativo
**La resolución pertenece al proyecto, el zoom a la cámara y el detalle al objeto.**
- **`project.output`** (`schema.ts → AsciiOutput`):
  - resolución global: 160×50, 240×74, 360×111 o 480×149;
  - paleta de glifos, densidad, contraste, nitidez, brillo de glifos, dithering y resplandor;
  - LOD automático, vista previa y exportación.

  Todos los planos y cámaras usan la misma rejilla, así que el tamaño visual de cada carácter es constante. Se edita en el panel **ASCII Output** (columna izquierda).
- **Por plano:** solo `shot.asciiOverride`, una modificación avanzada y explícita (FX → Avanzado) de glifos, densidad, contraste, nitidez, brillo, dithering y resplandor. Nunca la resolución.
- **Proyectos antiguos (versión 1):** al cargarlos, el ASCII del primer plano pasa a ser la salida global. Lo que difiera en otros planos (salvo la resolución) queda como override. Se guardan como versión 2.
- **Zoom:** el zoom y la distancia de la cámara cambian la proyección del mundo. Cada fotograma se reconstruye; nunca se amplía un ASCII ya renderizado.
- **Todos los pases en la misma rejilla:** los pases de fondo y primer término desenfocados se pintan a menor resolución y se reescalan (`resampleInto`).
- **LOD** (`character/lod.ts`):
  - **Medida:** el tamaño *proyectado* del rostro en filas de la rejilla, no la distancia. Se suaviza en el tiempo (media logarítmica de t, t−0,15, t−0,3 y t−0,45 s) con funciones puras: actúa como histéresis ante zooms bruscos y sigue siendo determinista al hacer scrub.
  - **Niveles** (como etiqueta en la barra de estado y en las pruebas): plano general extremo (< 2,5 filas), general (2,5–10), medio (10–35), primer plano (35–80) y primerísimo primer plano (≥ 80).
  - **Rasgos:** cada rasgo entra con una curva suave según su tamaño, sin saltos:
    - relieve facial (desde ~1,2 filas);
    - ojos, boca y cejas (3,5–8);
    - flequillo;
    - número de mechones (1–4);
    - pelo fino;
    - pliegues y bajo deshilachado de la capa;
    - refuerzo de silueta en figuras diminutas (cuerpo más denso y contorno completo en color de borde);
    - extras de primerísimo primer plano (línea de pestañas, brillo del labio, pelos sueltos).
  - **Sin LOD automático:** detalle completo a cualquier tamaño.
- **Vista previa:** perfiles PERFORMANCE (rejilla al 50 %), BALANCED (75 %) y QUALITY (rejilla del proyecto), solo en la vista previa. Los nombres antiguos se migran al cargar.
- **Exportación:** captura PNG y CLI a 1920×1080, 2880×1620 o 3840×2160, con la misma rejilla y glifos más nítidos.
- **Caché:** `Painter.shade(…, cacheKey)` reutiliza bandas estáticas. El suelo del páramo depende solo de la vista y los parámetros, así que con la cámara quieta no se recalcula (plano frontal: de 224 a 148 ms por fotograma en vista previa). Las máscaras de glifos, la LUT de forma y los rasters ya estaban cacheados.
- **Determinismo:** un fotograma no depende de lo que se renderizó antes. Se corrigió una fuga en `shade()`: el reescalado suavizado leía una fila con restos de la llamada anterior. Hay una prueba de regresión.

## Rendimiento (Fase 1)
Medido con `npm run perf` (Node) y en Edge (pool de workers), con el proyecto de ejemplo.

**Diagnóstico inicial (perfil QUALITY, media de los planos: 265 ms/fotograma).** No era la resolución en sí:
- **Rasterizado del pase principal:** 161 ms. Lo forman las rosas (36), el personaje (36; 193 en primer plano, por el shader del rostro), el cielo (32), el suelo (29) y la niebla (20).
- **Conversión ASCII:** 72 ms. De eso, 43 ms son la lectura de los rasters, donde además se paga el dibujo diferido de los trazados.
- **Animación:** 1,2 ms. **Partículas:** 0,5 ms.

**Optimizaciones aplicadas:**
- **Muestreo de raster:** 2×3 por celda en lugar de 4×6.
- **Cielo y niebla:** se evalúan a media resolución, y el suelo al 75 %. Antes y después se comparan en recortes 1:1 sin diferencia apreciable.
- **Suelo estático:** con la cámara quieta se reutiliza la banda ya calculada (`shade(…, cacheKey)`).
- **Shader del rostro:**
  - tablas precalculadas en lugar de splines por consulta;
  - gaussianas que solo se evalúan cerca de su rasgo;
  - normales con 3 evaluaciones en lugar de 6;
  - prueba analítica rayo-elipsoide antes de recorrer.

  Primer plano: el personaje pasa de 193 a 88 ms.
- **Rosas con detalle relativo a la celda:** los pétalos y tallos solo se dibujan donde la rosa ocupa celdas suficientes para mostrarlos. En el pase desenfocado (`Painter.soft`) se dibujan solo las manchas.
- **Vista previa fuera de React** (`ui/previewEngine.ts`):
  - pool de hasta 6 workers que, durante la reproducción, renderizan fotogramas distintos en paralelo;
  - reloj propio con descarte de fotogramas tardíos;
  - React solo recibe el tiempo a ~12 Hz.
- **Métricas reales en la barra:** ms de render por worker, FPS mostrados, descartados, coste de pintar, coste de React y un desglose por etapa opcional.

**Resultados:**
| Perfil (vista previa) | ms/fotograma por worker (Node, media) | Reproducción en Edge, proyecto a 30 fps, 6 workers |
|---|---|---|
| PERFORMANCE (rejilla al 50 %) | 43 | 30 fps, 0 descartados |
| BALANCED (75 %) | 75 | 30 fps, 0 descartados |
| QUALITY (rejilla del proyecto) | 112 | 30 fps (2 descartados al arrancar el primer plano) |

**Límites:**
- La reproducción va a los fps del proyecto (24 o 30); 60 fps no aplica a la reproducción.
- La respuesta al hacer scrub (un fotograma) sigue siendo de 45–180 ms según el perfil.
- **WebGL2:** no se migró. Las mediciones muestran que el coste está en los shaders de escena y en el rasterizado de trazados de los generadores, no en la composición. Pasar solo la composición a GPU ahorraría ~20–30 ms; el resto exigiría portar todos los generadores.
- **Actualización por regiones:** no se implementó, porque casi todo el cuadro cambia en cada fotograma (cámara, viento, partículas).

## Caminata v2 (Fase 2, `animation/locomotion.ts`)
- **Ciclo:** 12 poses clave por ciclo, interpoladas con curvas monótonas (sin sobreoscilación):
  - **cuerpo:** contacto, bajada, paso, subida y punto alto, por cada pie;
  - **pie en el aire:** despegue, retroceso (el pie sube por detrás), paso con la rodilla alta, extensión y contacto de talón.
- **Peso:**
  - el cuerpo frena tras cada contacto y acelera en el paso (±6 %), con la velocidad media intacta;
  - se inclina hacia delante al acelerar y hacia atrás al frenar;
  - rodillas algo flexionadas al caminar;
  - transferencia del peso sobre el pie de apoyo en la vista frontal.
- **Tronco y cabeza:** los hombros contrarrotan y llevan consigo el yugo de la capa; los brazos, bajo la capa, se balancean al contrario de las piernas, con el antebrazo retrasado; la cabeza se estabiliza (mantiene el ángulo y amortigua el 30 % del rebote).
- **Física secundaria:** la capa y el pelo responden a todo esto. El parámetro "movimiento secundario" ajusta la amortiguación de la capa y la rigidez de los mechones.
- **Pies sin deslizar:** los apoyos siguen bloqueados en el mundo. El límite de alcance de la pierna que va a apoyar entra de forma gradual, y el rebote se desvanece al detenerse. Así desaparecen el tirón de la cadera en cada contacto y el salto al frenar, que también estaban en la v1.
- **Determinismo:** la pista se calcula a 120 Hz y la pose se evalúa para cualquier t, independientemente de los fps de render.
- **Parámetros globales del personaje** (`project.characters.<id>.gait` sobre `look.gait` del personaje): estilo (v1/v2), longitud de paso, subida y bajada, balanceo y movimiento secundario. La velocidad está en el actor.
- **Pruebas:** sin saltos de cadera, sin pies bajo el suelo, sin deslizamiento a varias velocidades y velocidad media respetada.

## Deshacer / rehacer y paneles (Fase 3)
- **Historial** (`ui/history.ts`):
  - **Instantáneas:** cada entrada guarda las referencias antes/después del proyecto inmutable, así que cubre cualquier edición. La descripción ("Mover cámara (distancia)", "Crear plano", "Rostro (eyeOpen)"…) sale de comparar las dos instantáneas.
  - **Agrupación:** un arrastre de slider o de la línea de tiempo es una sola entrada (por gesto de puntero), y escribir en un mismo campo se agrupa durante 1,2 s.
  - **Comportamiento:** una edición nueva invalida la rama de rehacer, y el límite es configurable (se guarda en `localStorage`). Nuevo, Cargar e Importar empiezan un historial limpio.
  - **Fuera del historial:** reproducción, tiempo, métricas y scroll no tocan el proyecto, así que nunca se graban.
- **Atajos:** Ctrl+Z, Ctrl+Y y Ctrl+Shift+Z. No se interceptan dentro de campos de texto, que conservan su historial nativo. Los botones de la barra superior muestran "Deshacer: …" y "Rehacer: …".
- **Rueda del ratón** (`ui/panelWheel.ts` y CSS):
  - cada panel lateral tiene scroll independiente, sin arrastrar la página (`overscroll-behavior: contain`), y barras discretas;
  - sobre un slider o un campo numérico, la rueda desplaza el panel y nunca cambia el valor; Alt+rueda sí lo cambia, como interacción explícita;
  - las pestañas quedan fijas arriba al hacer scroll, y cada pestaña recuerda su posición.

## Problema conocido del motor (sin corregir)
`Painter` escala los trazados con un único factor `k = w / vw`, pero el raster tiene `rows·6` de alto, y como las celdas no son cuadradas ese alto no es `vh·k`. Resultado: todo lo dibujado con trazados (personaje, agujas, rocas, rosas) queda **~21 % más abajo y más alto** que lo dibujado con `shade()` (cielo, suelo). Los encuadres actuales se ajustaron sobre este comportamiento. El rostro v2 lo compensa (`ry` en `shadeFace`) para quedar pegado al pelo. Corregirlo de raíz (`setTransform(kx, 0, 0, ky, …)`) obliga a reencuadrar todos los planos.

## Datos frente a código
- `data/characters/protagonist.json`: proporciones, colores, capa, cabello y parámetros de marcha.
- `data/locations/*.json`: capas, parámetros con rangos para la UI, luz y color de niebla.
- `projects/*.json`: proyectos del usuario (`format: lostdir-ascii-cinema`).
- Generadores nuevos: `registerGenerator(nombre, fn)` en `scene/registry.ts`. Locaciones nuevas: un JSON más su `registerLocation`.

## Editor (`src/ui`)
- **Render en un Web Worker** (`renderWorker.ts`) con OffscreenCanvas. Usa el mismo motor que la CLI.
- **API local** (`src/server/vitePluginApi.ts`):
  - `GET/PUT /api/projects/:name` para cargar y guardar proyectos;
  - `POST /api/capture` para guardar PNG en `exports/`.

## Pendiente (no implementado)
| Fase | Qué falta |
|---|---|
| I | Audio WAV/MP3, forma de onda y marcadores musicales |
| J | Entidades y apariciones (la mujer) |
| K | DEAD FOREST, FALLING SKY (los meteoros ya existen como efecto), CASTLE, RUINS, RED VOID |
| L | Árbol de El Tabo |
| M | Exportación MP4 H.264 + AAC con FFmpeg |
| G | Plano B cenital del campo de rosas, que necesita una vista cenital del personaje |

## CINEMATIC ASCII HYBRID — Fase 01: prototipo RED FIELD (rama `hybrid-red-field`)
**Referencias** (`References/06_VISUAL_REFERENCES`, 5 MP4 analizados con fotogramas extraídos por FFmpeg):
- Tres son de un MMORPG ASCII (hierba hecha con glifos de trazo colocados por brizna, sombras proyectadas, apertura de la hierba al paso, cámara picada, fondo muy oscuro).
- Uno es un montaje sobre el mismo juego (glosario de glifos, nubes, reflejos).
- Uno es un mundo 3D low-res (terreno ondulado, billboards, niebla).

Se adaptó la técnica, no los escenarios.

**Motor HYBRID** (`src/engine/hybrid/`, sin dependencias nuevas, 3D por software, determinista):
- **Cámara 3D** (`camera3d.ts`): con yaw = 0 proyecta igual que el `View` del LEGACY (hay prueba de paridad). Añade `aim` y el tipo `overhead`.
- **G-buffer y rasterizado** (`gbuffer.ts`, `rasterizer.ts`): G-buffer a resolución de zona de glifo (albedo, normal, profundidad, tipo, tinta) y rasterizador con z-buffer y corrección de perspectiva.
- **Terreno** (`terrain.ts`): campo de alturas con malla muestreada en pantalla (LOD automático por distancia) y colinas lejanas.
- **Vegetación** (`vegetation.ts`):
  - rosas instanciadas por hash del mundo (altura, orientación, escala, color, fase), en tres bandas de distancia;
  - viento compartido;
  - reacción local al paso, analítica sobre la trayectoria del actor (`bendAt`);
  - maleza seca y pétalos.
- **Glifos libres** (`glyphStrokes.ts`): solo vegetación y partículas, al tamaño de celda de la rejilla y anclados al mundo. Tallos `| / \`, rosas `@` con anillo `( ) o ~`, hojas y briznas `' , \``.
- **Luz** (`lighting.ts`): diferida (lambert + ambiente + borde de luz), sombra proyectada del protagonista, niebla por profundidad y altura, y cielo con nubes.
- **Composición** (`renderHybrid.ts`):
  - el personaje es el mismo `CharacterRenderer` (rostro, aspecto global, caminata y LOD), compuesto por profundidad;
  - la conversión es el mismo `composeAscii` del LEGACY;
  - después vienen bloom moderado (`post.ts`) y el post habitual.
- **Selección del motor:** `renderFrame` delega al HYBRID si el plano tiene `renderer: 'hybrid'` o si se fuerza con `opts.renderer`.

**Compatibilidad:**
- `tests/golden/legacy-hashes.json` y `tests/legacy-golden.test.ts` demuestran que el LEGACY renderiza bit a bit igual que antes.
- Todos los campos nuevos son opcionales (`shot.renderer`, `camera.aim`, tipo `overhead`, `output.hybrid`). El formato pasa a la versión 4 y los proyectos v1–v3 cargan igual.
- `rose_field` no se modificó. `red_field` es una locación nueva que incluye las capas LEGACY para poder compararse.

**Plantilla:** Nuevo… ▸ "RED FIELD — prueba híbrida" (`project/templates.ts`). Tiene 5 tomas: general extremo, travelling lateral, detalle de vegetación al paso, primer plano del rostro y cenital ascendente.

**UI:**
- **Selector en el transporte:** SEGÚN PLANO / LEGACY / HYBRID / COMPARAR. COMPARAR muestra dos visores con métricas propias (ms, fps, conversión, objetos visibles, glifos libres) y tiene "Captura comparativa".
- **Panel ASCII Output → Efectos híbridos:** glifos libres, bloom, niebla, sombras y ambiente.
- **Plano → Renderizador:** elige el motor de cada plano.

**Exportación MP4** (CLI): `npm run render -- --template redfield [--shot id] --mp4 exports/x.mp4`. Envía fotogramas RGBA por stdin al FFmpeg del sistema (`FFMPEG_PATH` o el PATH) y produce H.264 yuv420p a los fps del proyecto. Comprobado con ffprobe: 216 fotogramas, 9,000 s, 24 fps. Todavía no tiene audio ni botón en la UI.

**Rendimiento medido** (Node, `npm run perf -- --template redfield --renderer …`, ms por fotograma):
| | LEGACY QUALITY | HYBRID QUALITY | LEGACY PERFORMANCE | HYBRID PERFORMANCE |
|---|---|---|---|---|
| 01 general extremo | 175 | 110 | 67 | 52 |
| 02 travelling | 195 | 105 | 81 | 49 |
| 03 vegetación | 179 | 117 | 70 | 49 |
| 04 rostro | 173 | 177 | 56 | 67 |
| 05 cenital | 199 | 102 | 53 | 46 |

Desglose del HYBRID en QUALITY: post y bloom 27, personaje 26, luz y niebla 24, conversión 21, vegetación 8, terreno 8, glifos libres 3. En Edge, con el pool de workers, las 5 tomas se reproducen a 24 fps (BALANCED).

**Límites:**
- **Encuadre:** el personaje se dibuja con su sistema 2D de vistas (perfil, frente, espalda), sin ángulos intermedios. En LEGACY queda unos píxeles más abajo que en HYBRID por el desplazamiento conocido del `Painter`. El HYBRID lo compensa.
- **Cámara:** el cenital del LEGACY es una aproximación (cámara muy elevada), no un cenital real.
- **Escena:** sin agua ni reflejos, y la vegetación cercana del cenital es escasa.
