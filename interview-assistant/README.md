# Interview Assistant

Apoyo en vivo para una entrevista técnica en inglés por teléfono: escucha al entrevistador, muestra lo que dice en inglés y en español, y sugiere puntos clave y una respuesta basada en tu perfil.
Permite subir contexto extra (PDF, DOCX, MP3, WAV, texto) para que las sugerencias sean más precisas.
Node.js puro, sin dependencias, con Clean Architecture.

## Cómo se usa en la entrevista
El móvil recibe la llamada **en altavoz** y la laptop (Chrome de escritorio) escucha por su micrófono. Un teléfono en llamada no deja usar el micrófono a una página web, por eso hace falta la laptop.

```bash
cd interview-assistant
cp .env.example .env      # pon tu GEMINI_API_KEY (Google AI Studio)
npm start                 # http://127.0.0.1:3100  → ábrelo en Chrome
```

En Windows basta con hacer **doble clic en `iniciar.cmd`**: arranca el servidor y abre Chrome en la página (avisa si falta el `.env`). Cierra su ventana para detener el servidor.

1. Antes: **Contexto → Perfil** (nombre, titular, habilidades, roles) y **Documentos** (oferta de trabajo, CV, notas, grabaciones). Quita lo que no quieras que influya con el interruptor de cada documento.
2. Pulsa **Iniciar** y acepta el micrófono (la primera vez baja el paquete de voz y el modelo de traducción).
3. Mientras el entrevistador habla ves el texto en inglés con su traducción; ~1,5 s después de que calla, puntos clave y una respuesta sugerida. Es una ayuda para pensar y decirlo con tus palabras, no un guion.
4. **Espacio** = «estoy hablando»: mientras lo tienes activo no se transcribe nada (tu voz también entra al micrófono). Espacio otra vez para seguir escuchando.
5. **Limpiar** vacía la transcripción antes de empezar de verdad.

Además:
- **Para ganar tiempo:** bajo las sugerencias hay 8 frases listas (pensar un segundo, pedir que repitan, aclarar la pregunta…) que funcionan aunque falle la red.
- Si el entrevistador solo dice «Okay.», «Great.» o «Mm-hmm», la sugerencia que estás leyendo no se reemplaza.
- **Historias (STAR):** en Contexto → Documentos → Pegar texto, el botón **Plantilla STAR** prepara un cuadro de Situación / Tarea / Acción / Resultado. Guarda tus mejores historias ahí y el coach elegirá la más relevante en preguntas de comportamiento.
- La barra superior muestra cuánto tardan la traducción y las sugerencias («Traducción 156 ms · Sugerencia 1,4 s»): útil para el ensayo.
- **Respuestas preparadas:** el banco trae un texto listo (inglés, español y puntos clave) para 31 preguntas típicas —háblame de ti, fortalezas, debilidades, por qué este puesto, conflictos, liderazgo, salario…—. Cuando el entrevistador pregunta algo parecido, aparece **al instante** con la etiqueta «Preparada» y sin llamar a la IA; el botón «Pedir a la IA» pide la versión de Gemini cuando la quieras. **Son plantillas sin revisar**: en Contexto → Preparadas léelas, edítalas con tus datos reales (sobre todo la debilidad, la empresa y el salario) o usa «Personalizar con IA» para reescribirlas con tu perfil y tus documentos. Las que edites tú nunca se tocan sin pedirte confirmación.

## Qué es local y qué va a Gemini
- **Local:** la voz (Web Speech en modo local, Chrome 139+), la traducción (Translator API de Chrome), el reconocimiento de la pregunta preparada y la lectura de DOCX y texto.
- **A Gemini:** las últimas frases del entrevistador, el resumen de tu perfil y el texto de los documentos activos (para generar la sugerencia); y los PDF y audios que subas (solo para extraer su texto).
- Del archivo original no se guarda nada: solo el texto extraído, tu perfil y tus respuestas preparadas (`data/prepared.json`), en `data/` (git lo ignora). No se guarda ninguna transcripción de la sesión.
- **Revisa los términos de tu plan de Gemini antes de subir grabaciones de reclutadores o datos sensibles:** en la capa gratuita, Google puede usar lo que le envías para mejorar sus productos.
- El servidor solo responde a la propia página en `localhost`: rechaza (403) peticiones con otro `Host` o `Origin`, para que ninguna otra web que visites pueda leer o escribir tus datos mientras esté corriendo.

## Formatos y límites
PDF, DOCX, MP3, WAV, TXT y MD, hasta **12 MB** por archivo (≈12 min de MP3, ≈6 de WAV 16 kHz mono). Hasta 20 documentos y 30 000 caracteres activos en el prompt.
Sin `GEMINI_API_KEY` el servidor funciona en modo reducido: DOCX y texto se cargan, pero PDF, audio y sugerencias devuelven 503.

## Pruebas
```bash
npm test                  # 346 pruebas; la de extremo a extremo usa Chrome (se omite si no hay)
npm run smoke:gemini      # prueba manual contra la API real de Gemini (usa tu clave)
```

## Especificaciones (en `../docs/superpowers/specs/`)
1. [Diseño general](../docs/superpowers/specs/2026-10-01-interview-assistant-design.md)
2. [Arquitectura (Clean Architecture)](../docs/superpowers/specs/2026-10-01-interview-assistant-architecture.md)
3. [Sesión en vivo](../docs/superpowers/specs/2026-10-01-interview-assistant-live-session.md)
4. [Ingesta de contexto](../docs/superpowers/specs/2026-10-01-interview-assistant-context-ingestion.md)
5. [Coach de sugerencias](../docs/superpowers/specs/2026-10-01-interview-assistant-suggestion-coach.md)
6. [API HTTP](../docs/superpowers/specs/2026-10-01-interview-assistant-http-api.md)
7. [Interfaz](../docs/superpowers/specs/2026-10-01-interview-assistant-ui.md)
8. [Estrategia de pruebas](../docs/superpowers/specs/2026-10-01-interview-assistant-testing-strategy.md)

## Planes (en `../docs/superpowers/plans/`)
- [Plan 1: servidor](../docs/superpowers/plans/2026-10-01-interview-assistant-server.md)
- [Plan 2: cliente](../docs/superpowers/plans/2026-10-01-interview-assistant-client.md)
