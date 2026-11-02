# Motor local de transcripción, aislamiento del hablante y francés — Diseño

Fecha: 2026-10-10 · Aplicación: `electron_app/` (ViBeTranslate Pro Studio) · Rama: `integracion-IA-local-gemini-nano`

## 1. Objetivo

Que la traducción simultánea de `electron_app` responda antes, funcione sin red ni claves, ignore el ruido y las voces ajenas, y admita francés además de inglés y español.

Éxito significa:

- La transcripción y la traducción funcionan con la red desconectada.
- El tiempo desde que el usuario termina una frase hasta que aparece el subtítulo traducido baja de forma medible frente a la línea base (sección 3).
- Con ruido de fondo o una segunda persona hablando, solo se transcribe al usuario registrado.
- EN, ES y FR funcionan como idioma de origen y de destino.
- Hay pruebas automáticas con audios generados que verifican cada par de idiomas de punta a punta.

**Alcance actual (decisión del usuario, 2026-10-10):** solo EN→ES y ES→EN. El francés (fase 5 de la sección 9, y todo lo marcado FR en este documento) queda aplazado hasta que ese par esté terminado y probado; `languages.js` se diseña para admitirlo sin reescribir nada, pero no se descargan modelos, ni se añaden opciones de interfaz ni pruebas de francés por ahora.

Fuera de alcance: las claves escritas en `main.js` (se trata después, por decisión del usuario), la síntesis de voz local, la extensión de Chrome de la raíz del repositorio y el modo `gemini_live`.

## 2. Por qué no Gemini Nano

La petición original era integrar Gemini Nano como en `interview-assistant/`. Se probó y no es viable:

- `interview-assistant` transcribe con Web Speech en modo local y traduce con la Translator API de Chrome. Nano solo genera sugerencias y su código anota 6–19 s por respuesta.
- Electron 31.7.7 (Chromium 126, el que usa la app): `Translator`, `LanguageModel` y `SpeechRecognition.available` no existen.
- Electron 44.7.0 (Chromium 152): existen, pero `Translator.availability` y `create` no responden, `SpeechRecognition.available({processLocally:true})` devuelve `unavailable`, `install` devuelve `false` y `LanguageModel.prompt` contesta «On-device model is not available in Chromium, this API is just echoing back the input».

Los modelos los entrega Google Chrome con servicios propios que Electron no incluye. Se sustituye por modelos ONNX empaquetados con la app.

## 3. Mediciones que respaldan el diseño

Equipo: Intel i7-8550U, 8 hilos, 15 GB de RAM, sin GPU dedicada. Audios de 10–11 s generados con voces de Windows.

| Etapa | Nube (de `logs/desktop_app.log`) | Local medido |
|---|---|---|
| Transcripción EN | 370–890 ms por bloque | Moonshine base int8: 428 ms para 10,3 s, texto exacto |
| Transcripción ES | igual | Whisper base int8: 1789 ms para 11,6 s, texto exacto |
| Traducción | 100–1234 ms | Opus-MT q8: 175–702 ms por frase |
| Carga de modelo | — | 0,9–1,5 s cada uno, una vez por sesión |

Hallazgos:

- Los totales registrados van de 2 a 9 s aunque las etapas sumen 2–3 s. La diferencia viene de `startUnifiedAudioPipeline`: `isTranscribingBlock` sigue activo mientras se espera (`await`) la síntesis de voz, y el bloqueo de eco descarta el micrófono durante la reproducción. Lo que el usuario dice en ese intervalo se retrasa o se pierde.
- El modelo de streaming `zipformer-en-20M` (RTF 0,03) perdió el comienzo de la frase y entrega texto en mayúsculas sin puntuación. Se descarta.
- Opus-MT traduce peor que Google: «application» → «demande» (FR), «joining» → «unirnos» (ES). Queda como respaldo sin red.

## 4. Arquitectura

Todo el cómputo local corre en un **proceso utilitario** de Electron (`utilityProcess`), para no bloquear la interfaz ni el proceso principal. El renderer sigue capturando el micrófono y envía PCM de 16 kHz en tramas; recibe eventos de texto.

```
Renderer (index.js)                    Proceso utilitario (local-ai/worker.js)
  micrófono 16 kHz ── tramas PCM ──▶  filtro de ruido → detección de voz → verificación de hablante
                                             │ segmento de voz aceptado
                                             ▼
                                       transcripción (Moonshine | Whisper)
  subtítulo, traducción ◀── texto ───       │
        │                                    ▼
        └─ TRANSLATE_TEXT (main.js): Google → Opus-MT local → Groq → MyMemory
```

### Unidades

Carpeta nueva `electron_app/local-ai/`. Cada unidad tiene una sola responsabilidad y se prueba sola.

| Archivo | Hace | Depende de |
|---|---|---|
| `languages.js` | Registro único de idiomas (EN, ES, FR): código, nombre, modelo de transcripción, pares de traducción, voz. Sustituye las comparaciones `=== 'es' ? 'en' : 'es'` repartidas por `main.js` e `index.js`. | nada |
| `model-store.js` | Ubica, descarga con progreso y verifica (tamaño y SHA-256) los modelos en `userData/models/`. | `https`, `fs` |
| `segmenter.js` | Recibe tramas, aplica filtro de ruido y detección de voz Silero, emite segmentos de voz. Corta por pausa (≥ 350 ms) o a los 6 s. | `sherpa-onnx-node` |
| `speaker-gate.js` | Registra la voz del usuario y decide si un segmento es suyo comparando huellas de voz. Sin registro, deja pasar todo. | `sherpa-onnx-node` |
| `transcriber.js` | Transcribe un segmento con el modelo del idioma. Carga perezosa, un modelo en memoria por idioma activo. | `sherpa-onnx-node`, `languages.js` |
| `local-translator.js` | Traduce texto con Opus-MT para un par. Pares sin modelo directo se rechazan con error claro. | `@huggingface/transformers` |
| `worker.js` | Punto de entrada del proceso utilitario: une las unidades y habla por mensajes. | las anteriores |
| `client.js` | Lado principal: lanza el proceso, lo reinicia si muere, expone promesas y eventos. | `electron` |

### Modelos

| Uso | Modelo | Tamaño aprox. |
|---|---|---|
| Detección de voz | Silero VAD | 0,6 MB |
| Filtro de ruido | GTCRN (sherpa `OnlineSpeechDenoiser`) | < 1 MB |
| Huella de voz | 3D-Speaker ERes2Net base (sherpa `SpeakerEmbeddingExtractor`) | ~ 40 MB |
| Transcripción EN | Moonshine base int8 | ~ 250 MB |
| Transcripción ES y FR | Whisper base int8 multilingüe | ~ 160 MB |
| Traducción | Opus-MT q8, seis pares (en↔es, en↔fr, es↔fr) | ~ 110 MB cada uno |

Los modelos no van dentro del instalador. Se descargan la primera vez que se elige el motor local, solo los del par de idiomas activo, con barra de progreso. Los binarios nativos (`sherpa-onnx-node`, `onnxruntime-node`) sí se empaquetan y se declaran en `asarUnpack`.

### Contrato de mensajes (renderer ↔ principal ↔ utilitario)

| Canal IPC | Dirección | Carga |
|---|---|---|
| `LOCAL_AI_PREPARE` | renderer → principal | `{ sourceLang, targetLang }` → `{ ready, missing[] }` |
| `LOCAL_AI_PROGRESS` | principal → renderer | `{ model, loaded, total }` |
| `LOCAL_AI_START` / `LOCAL_AI_STOP` | renderer → principal | `{ sourceLang, speakerGate: boolean }` |
| `LOCAL_AI_AUDIO` | renderer → principal | `Float32Array` de 16 kHz (tramas de 100 ms) |
| `LOCAL_AI_SEGMENT` | principal → renderer | `{ text, lang, durationMs, sttMs, speakerScore, accepted }` |
| `LOCAL_AI_VAD` | principal → renderer | `{ speaking, noise }` para el indicador |
| `LOCAL_AI_ENROLL` | renderer → principal | `{ samples }` → `{ ok, seconds }` |
| `LOCAL_AI_ERROR` | principal → renderer | `{ stage, message, fatal }` |

## 5. Cambios en el código existente

- **`index.html` / `index.js`**: opción `local` en `#stt-engine` («Motor local (sin conexión, privado)»); opción francés en `#source-lang` y `#target-lang`; interruptor «Solo mi voz» y botón «Registrar mi voz» en la tarjeta de sensibilidad del micrófono; panel de descarga de modelos.
- **Canalización en `index.js`**: la traducción y la voz dejan de ejecutarse dentro de `onaudioprocess`. Cada texto reconocido entra en una **cola de salida** que traduce, muestra el subtítulo y sintetiza en orden. Así `isTranscribingBlock` solo cubre la transcripción y el micrófono sigue escuchando mientras suena la voz. El bloqueo de eco se mantiene para el altavoz local y se desactiva cuando la salida va solo al cable virtual. Aplica a todos los motores por bloques, no solo al local.
- **`main.js` `TRANSLATE_TEXT`**: usa `languages.js` para resolver origen y destino con tres idiomas; inserta Opus-MT como segundo nivel. Si no hay red (fallo de Google en < 3,5 s o `navigator.onLine` falso enviado por el renderer), va directo al local.
- **`gemini-live-client.js`, `audio-utils.js`**: sin cambios funcionales. A `isWhisperHallucination` se le añaden los patrones franceses equivalentes («merci», «sous-titres réalisés par…»).
- **`package.json`**: Electron 31 se mantiene (la actualización no aporta nada a este trabajo). Dependencias nuevas: `sherpa-onnx-node`, `@huggingface/transformers`. `asarUnpack` para los binarios nativos; `npm test` con el ejecutor de Node.

## 6. Aislamiento del hablante

Tres capas, de barata a cara:

1. **Filtro de ruido** (GTCRN) sobre cada trama, antes de la detección de voz.
2. **Detección de voz neuronal** (Silero) en lugar del umbral de volumen actual. El selector de sensibilidad existente pasa a controlar el umbral de probabilidad de Silero.
3. **Verificación de hablante**: el usuario graba 10 s; se guarda su huella en `userData/voiceprint.json`. Cada segmento de ≥ 1 s se compara por similitud de coseno; por debajo del umbral se descarta y se registra como «voz ajena filtrada». Los segmentos de menos de 1 s heredan la decisión del segmento anterior si llegó hace menos de 2 s; si no, pasan.

El umbral inicial se fija con las pruebas de la sección 8 y se expone como ajuste avanzado. Esto no separa dos voces que hablan a la vez: descarta segmentos dominados por otra voz. Se dice así en la interfaz.

## 7. Errores

| Situación | Comportamiento |
|---|---|
| Falta un modelo | El motor local no arranca; se ofrece descargar. No hay cambio silencioso a la nube. |
| Descarga interrumpida o suma incorrecta | Se borra el parcial y se reintenta al pulsar; mensaje con el modelo afectado. |
| El proceso utilitario muere | `client.js` lo reinicia una vez y recarga modelos; si muere otra vez en 30 s, detiene la canalización y muestra el error. |
| Transcripción vacía o alucinación | Se descarta con el filtro existente. |
| Par de traducción local inexistente | Error claro; se usan los niveles de nube si hay red. |
| Sin huella registrada y «Solo mi voz» activo | El interruptor se desactiva y se pide registrar la voz. |
| Equipo lento (transcripción > duración del audio) | Aviso en el registro y sugerencia de pasar a un motor en la nube. |

## 8. Pruebas

Ejecutor: `node --test`, como en `interview-assistant`. Los audios se generan con un guion (`test/fixtures/generate-audio.js`): voces de Windows para EN y ES, y `OfflineTts` de sherpa con voces Piper para FR y para una segunda voz en cada idioma. Los modelos se descargan una vez a una caché local; las pruebas que los necesitan se omiten con mensaje si no están.

| Nivel | Qué verifica |
|---|---|
| Unidad | `languages.js` (resolución de pares, modo automático con tres idiomas), `model-store.js` (suma, reanudación, parcial corrupto), cola de salida (orden, no bloquea la entrada), `speaker-gate.js` con huellas simuladas, `client.js` (reinicio). |
| Transcripción | 5 frases por idioma (EN, ES, FR). Tasa de error de palabras ≤ 10 % sobre texto normalizado. |
| Traducción | Los seis pares, 5 frases cada uno. Se comprueba que las palabras clave esperadas aparecen en la salida, no la frase exacta. |
| Ruido | Cada frase mezclada con ruido rosa y de cafetería a 10 dB y 5 dB de relación señal/ruido. Tasa de error ≤ 20 % a 10 dB; en silencio con ruido solo, cero segmentos emitidos. |
| Hablante | Audio alternando la voz registrada y una segunda voz. ≥ 90 % de segmentos propios aceptados y ≥ 90 % de ajenos rechazados. |
| Punta a punta | Se lanza la app Electron real con un micrófono simulado (`--use-file-for-fake-audio-capture`) y se lee el subtítulo final para EN→ES, ES→EN, EN→FR y FR→ES, con red y con la traducción en nube desactivada. |
| Latencia | Guion que mide fin de voz → subtítulo traducido para el motor local y lo compara con la línea base de la sección 3. Informa cifras; no falla por umbral. |

Si un criterio numérico no se alcanza, se informa el valor obtenido y se ajusta el modelo o el umbral antes de dar la fase por cerrada; no se relaja el criterio en silencio.

## 9. Orden de entrega

1. `languages.js` y cola de salida (mejora inmediata para los motores actuales).
2. `model-store.js`, proceso utilitario, segmentador y transcripción local EN y ES.
3. Traducción local como respaldo.
4. Filtro de ruido y verificación de hablante con registro de voz.
5. *(Aplazada)* Francés: interfaz, transcripción, pares de traducción, voz.
6. Pruebas de punta a punta, medición de latencia y empaquetado (`asarUnpack`, verificación de `npm run build:win`).

Cada fase termina con sus pruebas en verde.

## 10. Riesgos

- **Peso**: `onnxruntime-node` ocupa 288 MB sin comprimir por plataforma. Si el instalador crece demasiado, la traducción local pasa a sherpa/CTranslate2 o se ofrece como descarga opcional.
- **Voz de salida en francés**: Fish Audio y Google TTS admiten francés; se verifica en la fase 5. La voz clonada puede sonar con acento.
- **macOS**: los binarios nativos existen para x64 y arm64, pero aquí solo se puede probar Windows. La compilación para Mac queda sin verificar.
- **Verificación de hablante con frases cortas**: las huellas son poco fiables por debajo de 1 s; por eso la regla de herencia de la sección 6.

## 11. Revisión tras pruebas (2026-10-10)

Las pruebas hechas antes de planificar cambian varias decisiones de las secciones 4 a 8. Donde esta sección contradice a las anteriores, manda esta.

| Decisión original | Resultado medido | Decisión nueva |
|---|---|---|
| Moonshine (EN) + Whisper base (ES) | Whisper base falla en frases cortas en español («Puede enverme el informe») y tarda 536 ms en 3 s de audio. Moonshine v2 da error de ejecución en `sherpa-onnx-node` 1.13.8. | **Un solo modelo: NeMo Canary 180M flash int8** (207 MB, EN/ES/FR/DE). Frase de 3 s en ~400 ms, texto exacto con puntuación en EN y ES, estable con ruido a 5 dB. |
| Opus-MT con `@huggingface/transformers` | Añade 288 MB de `onnxruntime-node` y seis modelos de ~110 MB. | **Canary traduce directamente del audio** (EN↔ES en ~410–500 ms por frase). Cambiar de dirección cuesta 0,1 ms (`setConfig`). No se añade `@huggingface/transformers`. Calidad parecida a Opus-MT: sirve como respaldo sin red («application» → «solicitud»). |
| Filtro de ruido GTCRN antes de transcribir | No mejora la transcripción y a veces la empeora («before Friday» → «for four Friday»); cuesta un 13 % del tiempo real. | **Se elimina.** La robustez al ruido la dan Silero y el propio modelo. Verificado: 5 s de solo ruido → cero segmentos. |
| Verificación de hablante con huella de voz | Con `wespeaker CAM++` las puntuaciones agrupan por sesión de grabación, no por persona (misma persona 0,28; personas distintas 0,90). Por debajo de 2 s no distingue. | **Aplazada** a una investigación propia con grabaciones reales del usuario. «Aislar al hablante» queda, por ahora, en: detección de voz neuronal + duración mínima de 400 ms + bloqueo de eco existente. No filtra a otra persona que hable cerca. |
| Traducción local sobre texto | — | La traducción local necesita el audio: el proceso utilitario conserva los últimos 8 segmentos y traduce el que se le pida por identificador. |
| Sin detección de voz, el modelo no inventa texto | Sobre ruido puro Canary devuelve «Que no sé»; sobre 200 ms devuelve «sí». | La detección de voz es obligatoria delante del modelo y se descartan segmentos de menos de 400 ms. |
| `sherpa-onnx-node` dentro de Electron | Electron rechaza los búferes externos («External buffers are not allowed»). | Toda llamada que devuelva muestras pasa `false` en `enableExternalBuffer`. Verificado en el Node de Electron 31. |

Memoria del proceso con el modelo cargado: ~420 MB. Descarga inicial: 208 MB (Canary 207 MB + Silero 0,6 MB), desde archivos sueltos (sin descomprimir nada).

Canales IPC definitivos: `LOCAL_AI_STATUS`, `LOCAL_AI_PREPARE`, `LOCAL_AI_AUDIO`, `LOCAL_AI_TRANSLATE`, `LOCAL_AI_STOP` (renderer → principal) y un único `LOCAL_AI_EVENT` (principal → renderer) con `type`: `progress`, `segment`, `vad`, `error`. Desaparecen `LOCAL_AI_ENROLL` y `speaker-gate.js`, `local-translator.js`.

El motor local exige idioma de origen fijo (no «Auto»). Las pruebas de ruido usan solo ruido rosa generado; no hay grabación de cafetería.

## 12. Revisión de la traducción (2026-11-02)

Medido con 61 frases reales de las sesiones de prueba (transcritas por Canary) y 60 frases típicas de reunión, con traducciones de referencia escritas a mano. Métrica chrF (más es mejor) y latencia desde este equipo.

| Sistema | EN→ES real | EN→ES reunión | ES→EN real | ES→EN reunión | Latencia (mediana) |
|---|---|---|---|---|---|
| Canary desde el audio (lo que usaba el modo local) | 69,9 | — | 56,7 | — | 560 ms |
| Bergamot + Firefox Translations (motor de runonweb.ai) | 75,8 | 69,8 | 64,1 | 72,9 | 45 ms |
| Google (dict-chrome-ex) | 74,9 | 69,6 | 74,4 | 82,1 | 500 ms |
| Groq gpt-oss-20b con el prompt anterior (nivel 2 de la nube) | 66,6 | 69,9 | 70,7 | 75,6 | 730 ms |
| Groq gpt-oss-120b, `reasoning_effort: low`, prompt de reunión | 78,1 | 74,5 | 72,5 | 81,5 | 500 ms |
| Lo que se envía: LLM y Google en paralelo, con validación | 78,7 | 72,7 | 66,8 | 81,5 | 500 ms |

Decisiones:

- **Traducción local = Canary transcribe + Bergamot traduce el texto.** Mejor que la traducción directa de Canary, una sola pasada del modelo de voz por frase y 30-50 ms por frase. Modelos `en-es`/`es-en` base-memory de Mozilla (31 MB cada uno, MPL-2.0), descargados de Mozilla con suma verificada; el WASM (`@mkljczk/bergamot-translator` 0.4.16) va copiado en `local-ai/vendor/bergamot`. La traducción directa de Canary solo queda como detector de ruido para frases del micrófono de hasta 3 palabras (sobre ruido devuelve «1.1.1.1…»).
- **Los trozos de una frase se unen** (`sentence-joiner.js`) y la línea del subtítulo se reescribe con la frase entera. Tras un punto, la minúscula inicial solo une con ≤ 800 ms de pausa medida.
- **En modo nube, el subtítulo local sale al instante y la nube lo mejora en la misma línea** (`cloud-translator.js`: gpt-oss-120b → gpt-oss-20b y Google a la vez; gana el LLM si su respuesta pasa la validación y llega hasta 1 s después de Google). La voz espera a la nube como mucho 1,5 s.
- **Glosario:** `'real' → 'React'`, `'node'/'nodo' → 'Node.js'`, `'jason' → 'JSON'` y similares corrompían frases normales («a real AI lab» → «a React AI lab», «cada nodo» → «cada Node.js.js»). Se eliminaron y el reemplazo es de una sola pasada.
- **runonweb.ai:** su traducción es la que se adopta (Bergamot). Su STT (Whisper tiny.en, solo inglés) es peor que Canary. Su TTS (Kokoro, Supertonic 2, KittenTTS vía transformers.js/WASM) no se adopta por ahora: las voces españolas de Kokoro son de grado D, Supertonic 2 tiene licencia OpenRAIL-M con restricciones de uso, y añadiría transformers.js a la app; si hace falta voz sin red, sherpa-onnx (ya incluido) puede ejecutar voces locales de forma nativa.

Límites de la clave gratuita de Groq (medidos en las cabeceras): 1000 peticiones/día y 8000 tokens/min por modelo. Al agotarse, el traductor pasa al otro modelo y luego a Google sin intervención.

## 13. Diccionario técnico y primera palabra (2026-11-02)

Medido repitiendo los 18 audios de la entrevista simulada (entrevistadora en inglés, candidato en español; voces de Windows) por el flujo completo, y juzgando cada traducción con Qwen 3.8 27B (1 a 5) frente a lo que se dijo de verdad.

| | Antes | Ahora |
|---|---|---|
| Error de transcripción, candidato ES / entrevistadora EN | 11 % / 7 % | 5 % / 3 % |
| Términos técnicos que llegan en la traducción entregada, ES→EN / EN→ES | 42 % / 44 % | 79 % / 78 % |
| Juez, fidelidad de la traducción entregada, ES→EN / EN→ES | 3,33 / 4,44 | 4,11 / 4,56 |
| Juez, fluidez de la traducción entregada, ES→EN / EN→ES | 3,67 / 4,89 | 4,67 / 4,89 |

- **Primera palabra:** «Hi,», «Sí,», «Perdón,» seguidas de pausa no llegaban a los 400 ms de voz del detector y se perdían (9 de 18 turnos). Un segundo Silero sensible a 100 ms marca esas ráfagas y se anteponen a la frase (`segmenter.js`).
- **Diccionario:** `local-ai/tech-terms.js`, unos 315 términos de Microsoft 365, SharePoint/SPFx/PnP, Power Platform, Azure, .NET, Windows y desarrollo general, con cómo los escribe el reconocedor al oírlos en español («taimaut», «cherpoint», «Postre S. Q. L.»).
- **Corrección** (`tech-glossary.js`): por clave fonética, exacta o aproximada. Una palabra de verdad nunca se reemplaza: lo decide el vocabulario del traductor (`spm-lexicon.js`, 21 000 palabras) y, si hay duda, el traductor con una ida y vuelta («postres» → «desserts» → «postres»; «rumbook» → «heading» → «rumbo» no vuelve). En 206 frases sin jerga (las sesiones grabadas y las de reunión) solo cambió una, y bien («open AI anthropic» → «OpenAI Anthropic»).
- **Protección en Bergamot:** la jerga que se dice en inglés viaja como marcador (X1Z) y se restaura concordando el artículo («la deploy» → «el deploy»). Sin protección Bergamot conservaba 7 de 14 términos de prueba; con ella, 14.
- **Nube:** el texto llega corregido y el LLM recibe las palabras corrientes que podían ser un término («café» → ¿Kafka?) como pistas. La indicación de términos escritos de oído solo se da para español hablado: en inglés hacía ver «Vite» en «a bit garbled».
- **Glosario antiguo:** las versiones anteriores guardaban una copia del glosario de fábrica en `settings.json` (con «real» → «React»); al cargar se descarta lo que coincide con esa copia. El vocabulario propio (nombres, siglas) se escribe en la interfaz: «cómo se oye = cómo se escribe».

Lo que no arregla: palabras fundidas por el reconocedor («el lag volvió» → «lambolvió») y siglas deletreadas como «AWS» cuando el reconocedor pierde la primera letra.
