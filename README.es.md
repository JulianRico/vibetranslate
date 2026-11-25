# ViBeTranslate Pro Studio

**Traducción simultánea de voz en tiempo real y estudio de práctica con IA para entrevistas y reuniones en equipos internacionales.**

[![Electron](https://img.shields.io/badge/Electron-44.7-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.12-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Licencia: MIT](https://img.shields.io/badge/Licencia-MIT-0f6cbd.svg)](electron_app/package.json)
[![Build](https://github.com/jaquintero/translate/actions/workflows/build.yml/badge.svg)](https://github.com/jaquintero/translate/actions/workflows/build.yml)

**[English](README.md)** · **Español** · **[Guía de Contribución](CONTRIBUTING.md)**

---

## Descripción general

**ViBeTranslate Pro Studio** es una aplicación de escritorio construida con Electron diseñada para eliminar la barrera del idioma en equipos internacionales que trabajan en **Google Meet**, **Microsoft Teams** y **Zoom**.

Reúne dos flujos complementarios en un solo espacio:

1. **Traducción simultánea en vivo (`ES ↔ EN`)**: Hablas con naturalidad en tu idioma mientras la reunión te escucha en el idioma destino (incluso con tu propia voz clonada en Fish Audio) a través de un micrófono virtual (`VB-CABLE`), y sigues lo que dicen los demás con subtítulos flotantes, identificación de hablantes y lectura en voz alta con atenuación automática del audio de la llamada.
2. **Estudio de Práctica de Entrevistas y Reuniones Internacionales con IA**: Prepárate antes de tus llamadas reales creando con IA un **libreto bilingüe editable** adaptado a tu **sector**, **tema** y **rol** — incluyendo qué preguntarán, *cómo responder* (STAR/BLUF), respuestas modelo, frases clave en inglés, apuntador opcional en vivo y evaluación turno por turno.

---

## Funcionalidades principales

### Traducción en vivo para reuniones
- **Motor local sin conexión (privado y sin claves API)**:
  - Corre en un `utilityProcess` aislado con **Silero VAD**, **NVIDIA NeMo Canary-180M** (`sherpa-onnx-node`), huellas de voz **NeMo TitaNet** y traducción local **Firefox Translations / Bergamot** (WASM).
  - Detección acústica de eco, unión inteligente de frases entre pausas cortas y un **diccionario técnico integrado de más de 300 términos** (Microsoft 365, SharePoint, Power Platform, Azure, .NET, Cloud y desarrollo web) más vocabulario propio del usuario.
- **Motores híbridos en la nube y síntesis de voz**:
  - **Groq Cloud**: Transcripción ultrarrápida con `whisper-large-v3-turbo` y traducción idiomática con `openai/gpt-oss-120b` / `20b` en paralelo con Google Translate para máxima naturalidad y baja latencia.
  - **Fish Audio AI**: Síntesis TTS en tiempo real con **Estudio de Clonación de Voz** integrado (graba 15–45 s desde la app) y caché local.
  - **Google Gemini**: `gemini-3.5-flash-lite` para transcripción y **Gemini Live** (`gemini-2.5-flash-native-audio-latest`) para traducción directa de voz a voz vía WebSocket.
  - **VoxCPM** *(opcional)*: Microservicio local de TTS con GPU (`voxcpm_service/`).
- **Experiencia de reunión y diagnóstico**:
  - **Subtítulos flotantes siempre visibles** (`Ctrl+Shift+T`) con identificación por persona e historial.
  - **Atenuación automática en Windows (Audio Ducking)** (`audio-ducker.ps1`): baja el volumen de los demás programas mientras suena la traducción y lo restaura automáticamente al cerrar.
  - **Mini-ventana flotante (PiP)**, **Validador de hardware** y **Laboratorio de pruebas** con grabación WAV por frase e informes de latencia en Markdown.

### Práctica de Entrevistas y Reuniones Internacionales con IA
- **Dos modos**: *Entrevista de trabajo* (hiring manager, técnica, conductual STAR) y *Reunión internacional* (daily stand-up, sprint demo, incidente en producción, descubrimiento con clientes, negociación de alcance y plazos).
- **10 sectores industriales + sector personalizado**: Tecnología y Software, Microsoft 365/SharePoint/Azure, Datos e IA, Producto/UX, Finanzas/Fintech, Consultoría/Ventas B2B, Marketing/Growth, Salud/Biotech, Operaciones/Supply Chain o cualquier sector propio.
- **Libreto editable generado con IA**: Crea perfil del interlocutor, contexto bilingüe, **clave intercultural**, guion editable turno por turno, qué evalúa la IA, *cómo responder*, respuesta modelo bilingüe, frases clave en inglés, criterios de evaluación y glosario del sector (inyectable en un clic al reconocedor de voz).
- **Simulación en vivo y evaluación integral**: Práctica por voz (con respaldo opcional por texto), apuntador desplegable durante la llamada, respaldo automático Groq → Gemini, evaluación global y **turno por turno** con reescritura de tus respuestas en inglés internacional natural, separación de errores de traducción y exportación de informes.

---

## Arquitectura y estructura del repositorio

```text
translate/
├── electron_app/            # App principal de escritorio Electron (núcleo y pruebas)
│   ├── main.js              # Proceso principal, IPC y orquestación nube/local
│   ├── index.html / .js     # Ventana principal, pipelines de audio y Estudio de Práctica
│   ├── overlay.html / .js   # Ventana transparente de subtítulos flotantes
│   ├── env.js               # Cargador de .env sin dependencias y respaldo de ajustes
│   ├── cloud-translator.js  # Traducción en paralelo Groq LLM + Google Translate
│   ├── fish-audio-service.js# Cliente Fish Audio TTS, clonación de voz y caché
│   ├── gemini-live-client.js# Cliente WebSocket Gemini Live (BidiGenerateContent)
│   ├── training-catalog.js  # Catálogo de sectores, temas y edición del libreto
│   ├── training-interviewer.js # Generador de libretos IA, interlocutor y evaluador
│   ├── training-session.js  # Recolector de respuestas, troceado TTS e informes
│   ├── local-ai/            # Motor offline ONNX (VAD/STT/hablantes) + Bergamot WASM
│   └── test/                # 293 pruebas unitarias/integración + pruebas E2E en Electron
├── website/                 # Sitio web informativo (Astro + Tailwind)
├── interview-assistant/     # Asistente web complementario para entrevistas
├── license-server/          # Microservicio Node.js de licencias
├── voxcpm_service/          # Microservicio Python opcional de TTS local
└── .github/workflows/       # Compilación CI multiplataforma (Windows y macOS)
```

---

## Inicio rápido

### Requisitos previos
- **Node.js** `>= 22.12.0` (requerido por Electron 44)
- **Windows 10/11** (soporte completo incluyendo atenuación de audio) o **macOS**
- **Opcional (para enviar tu voz traducida a Meet/Teams/Zoom)**: [VB-CABLE Virtual Audio Device](https://vb-audio.com/Cable/) (elige `CABLE Output` como micrófono en tu aplicación de videollamada)

### Instalación

```bash
# 1. Clonar el repositorio
git clone https://github.com/jaquintero/translate.git
cd translate/electron_app

# 2. Instalar dependencias
npm install

# 3. Crear tu archivo .env local a partir de la plantilla
cp .env.example .env
# En Windows PowerShell:
# Copy-Item .env.example .env

# 4. (Opcional) Descargar los modelos locales offline (~250 MB)
npm run models

# 5. Iniciar ViBeTranslate Pro Studio
npm start
```

> [!TIP]
> Puedes usar ViBeTranslate **100 % sin conexión y sin claves API** eligiendo **Local** como motor en **Ajustes**. Las claves en la nube son opcionales y habilitan Groq Whisper/LLM, clonación de voz con Fish Audio, Gemini Live y el Estudio de Práctica con IA.

---

## Variables de entorno

Configura tus claves en `electron_app/.env` usando [electron_app/.env.example](electron_app/.env.example) como referencia:

| Variable | Obligatoria | Descripción |
| :--- | :---: | :--- |
| `GEMINI_API_KEY` | Opcional | Clave de Google AI Studio para Gemini 3.5 Transcribe, Gemini Live y respaldo de práctica |
| `GROQ_API_KEY` | Opcional | Clave de Groq Cloud para Whisper Large v3 Turbo, traducción LLM idiomática y Estudio de Práctica |
| `FISH_API_KEY` | Opcional | Clave de Fish Audio para síntesis neuronal TTS y clonación de voz |
| `FISH_VOICE_MODEL_ID` | Opcional | ID de tu modelo de voz clonada en Fish Audio (usa `default` para la voz estándar) |
| `FISH_MODEL` | Opcional | Modelo de síntesis de Fish Audio (`s2.1-pro-free`, `s2.1-pro`, `s2-pro`) |
| `VOXCPM_HOST` / `VOXCPM_PORT` | Opcional | Host y puerto del microservicio local VoxCPM (`127.0.0.1` / `8765`) |
| `VIBE_MODELS_DIR` | Dev/Test | Ruta alternativa para modelos locales ONNX/Bergamot |
| `VIBE_SESSIONS_DIR` | Dev/Test | Ruta alternativa para sesiones del laboratorio de pruebas |

> [!CAUTION]
> **Nunca subas `.env` ni escribas claves reales en el código.** `.env` está ignorado en Git, excluido de los instaladores de `electron-builder` (`package.json`) y protegido por pruebas automáticas en `electron_app/test/env.test.js`.

---

## Desarrollo, pruebas y compilación

Todos los comandos se ejecutan dentro de `electron_app/`:

```bash
# Modo desarrollo con recarga automática
npm run dev

# Ejecutar la suite completa de pruebas unitarias e integración (293 pruebas)
npm test

# Ejecutar pruebas E2E reales en Electron (requiere `npm run models`)
npm run test:e2e

# Incluir pruebas E2E con altavoces reales (Windows, reproduce audio)
$env:VIBE_E2E_SPEAKERS="1"; npm run test:e2e

# Compilar instaladores de escritorio
npm run build:win   # Instalador Windows NSIS + Portable .exe
npm run build:mac   # Paquetes macOS DMG + ZIP (x64 y arm64)
```

---

## Cómo contribuir

¡Las contribuciones de desarrolladores, diseñadores, lingüistas y testers son bienvenidas! Consulta **[CONTRIBUTING.md](CONTRIBUTING.md)** para ver el flujo de trabajo, reglas de seguridad y checklist de Pull Requests.

### Áreas donde puedes aportar
- **Audio multiplataforma**: soporte nativo en macOS (`BlackHole` / `CoreAudio`) y Linux (`PipeWire`) equivalente al *audio ducking* de Windows (`audio-ducker.ps1`).
- **Nuevos pares de idiomas**: ampliar modelos locales Bergamot/Canary y prompts más allá de `ES ↔ EN` (por ejemplo, portugués, francés o alemán).
- **Estudio de Práctica Internacional**: nuevos sectores, escenarios de negociación multicultural, métricas de ritmo de habla/muletillas y entrenamiento de pronunciación.
- **Interfaz y accesibilidad**: atajos de teclado, contraste visual y localización de la UI a inglés y portugués.
- **Pruebas y rendimiento**: reducción de latencia extremo a extremo, más cobertura E2E y migración de `ScriptProcessorNode` a `AudioWorkletNode`.

---

## Licencia

Distribuido bajo licencia **MIT**. Consulta [electron_app/package.json](electron_app/package.json).
