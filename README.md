# ViBeTranslate Pro Studio

**Real-time simultaneous voice translation & AI interview/meeting practice studio for international teams.**

[![Electron](https://img.shields.io/badge/Electron-44.7-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.12-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-0f6cbd.svg)](electron_app/package.json)
[![Build](https://github.com/JulianRico/vibetranslate/actions/workflows/build.yml/badge.svg)](https://github.com/JulianRico/vibetranslate/actions/workflows/build.yml)

**English** · **[Español](README.es.md)** · **[Contributing Guide](CONTRIBUTING.md)**

---

## Overview

**ViBeTranslate Pro Studio** is a desktop application built with Electron designed to remove language barriers for professionals collaborating in international teams across **Google Meet**, **Microsoft Teams**, and **Zoom**.

It combines two complementary workflows in a single studio:

1. **Live Simultaneous Translation (`ES ↔ EN`)**: Speak naturally in your native language while the meeting hears your translated voice (including your own cloned voice via Fish Audio) through a virtual microphone (`VB-CABLE`), and follow what teammates say via floating live subtitles, speaker identification, and optional voice-over with automatic Windows audio ducking.
2. **AI Interview & International Meeting Practice Studio**: Prepare before real calls with an AI-generated, editable bilingual playbook tailored to your **sector**, **topic**, and **role** — complete with planned questions, *how to answer* strategies (STAR/BLUF), model answers, power phrases, live coach hints, and turn-by-turn evaluation.

---

## Key Features

### Live Meeting Translation
- **Offline Local AI Engine (Privacy-First, Zero API Keys Required)**:
  - Runs in an isolated Electron `utilityProcess` using **Silero VAD**, **NVIDIA NeMo Canary-180M** (`sherpa-onnx-node`), **NeMo TitaNet** speaker embeddings, and **Firefox Translations / Bergamot** (WASM).
  - Acoustic echo detection, intelligent sentence joining across micro-pauses, and a built-in **300+ term technical glossary** (Microsoft 365, SharePoint, Power Platform, Azure, .NET, Cloud & Web Engineering) plus custom user vocabulary.
- **Cloud Hybrid & Voice Engines**:
  - **Groq Cloud**: Ultra-fast `whisper-large-v3-turbo` STT + idiomatic `openai/gpt-oss-120b` / `20b` translation hedged in parallel with Google Translate for low latency and natural meeting idioms.
  - **Fish Audio AI**: Real-time TTS with custom **Voice Cloning Studio** (record 15–45s directly in-app) and local response caching.
  - **Google Gemini**: `gemini-3.5-flash-lite` STT and `gemini-2.5-flash-native-audio-latest` **Gemini Live** bidirectional audio-to-audio WebSocket streaming.
  - **VoxCPM** *(optional)*: Local GPU TTS microservice (`voxcpm_service/`).
- **Meeting UX & Diagnostics**:
  - Always-on-top **Floating Subtitles Overlay** (`Ctrl+Shift+T`) with speaker labels and history.
  - **Windows Audio Ducking** (`audio-ducker.ps1`): lowers other apps' volume while translations play aloud and restores automatically on exit.
  - **Mini-Player (PiP)** mode, **Hardware Validator**, and **Test-Session Trace Lab** with per-utterance WAV capture and Markdown latency reports.

### AI Interview & International Meeting Practice
- **Two Modes**: *Job Interview* (hiring manager, technical, behavioral STAR) and *International Team Meeting* (daily stand-ups, sprint demos, war rooms, client discovery, scope/timeline negotiation).
- **10 Industry Sectors + Custom Sector**: Pre-loaded scenarios across Technology, Microsoft 365/Azure, Data & AI, Product/UX, Finance/Fintech, Consulting/B2B Sales, Marketing/Growth, Healthcare/Biotech, Operations/Supply Chain, or any custom industry.
- **Editable AI Playbook**: Generates interlocutor persona, bilingual scenario brief, cross-cultural communication tips, editable turn-by-turn script, *what is being evaluated*, *how to answer*, bilingual model answers, natural English power phrases, evaluation criteria, and a sector glossary that can be merged into ViBeTranslate's speech recognizer in one click.
- **Live Simulation & Turn-by-Turn Evaluation**: Voice-first simulation (plus optional text reply fallback), toggleable live coach hints, automatic Groq → Gemini failover, turn-by-turn scores with natural international English rewrites of your answers, translation-error separation, and exportable reports.

---

## Architecture & Repository Structure

```text
vibetranslate/
├── electron_app/            # Main Electron desktop app (core product & test suite)
│   ├── main.js              # Electron main process, IPC channels, cloud/local orchestration
│   ├── index.html / .js     # Main studio window, audio pipelines, Practice Studio UI
│   ├── overlay.html / .js   # Transparent floating subtitles window
│   ├── env.js               # Zero-dependency .env loader & settings fallback
│   ├── cloud-translator.js  # Hedged Groq LLM + Google Translate engine
│   ├── fish-audio-service.js# Fish Audio TTS, voice cloning & caching client
│   ├── gemini-live-client.js# Gemini Live BidiGenerateContent WebSocket client
│   ├── training-catalog.js  # Sectors, topics & editable playbook operations
│   ├── training-interviewer.js # AI playbook generator, live counterpart & evaluator
│   ├── training-session.js  # Answer collector, TTS chunking & report formatters
│   ├── local-ai/            # Offline ONNX VAD/STT/diarization + Bergamot WASM MT
│   └── test/                # 293 unit/integration tests + real Electron E2E suite
├── website/                 # Astro + Tailwind landing page
├── interview-assistant/     # Companion web-based interview assistant
├── license-server/          # Node.js license validation microservice
├── voxcpm_service/          # Optional Python local TTS microservice
└── .github/workflows/       # Multi-platform Windows & macOS CI builds
```

---

## Quick Start

### Prerequisites
- **Node.js** `>= 22.12.0` (required by Electron 44)
- **Windows 10/11** (full support including audio ducking) or **macOS**
- **Optional (for sending translated voice to Meet/Teams/Zoom)**: [VB-CABLE Virtual Audio Device](https://vb-audio.com/Cable/) (select `CABLE Output` as your microphone inside your meeting app)

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/JulianRico/vibetranslate.git
cd vibetranslate/electron_app

# 2. Install dependencies
npm install

# 3. Create your local environment file from the template
cp .env.example .env
# On Windows PowerShell:
# Copy-Item .env.example .env

# 4. (Optional) Pre-download local offline AI models (~250 MB)
npm run models

# 5. Launch ViBeTranslate Pro Studio
npm start
```

> [!TIP]
> You can run ViBeTranslate **completely offline with zero API keys** by selecting **Local** as the recognition engine in **Settings**. Cloud keys are optional and unlock Groq Whisper/LLM translation, Fish Audio voice cloning, Gemini Live, and the AI Interview & Meeting Practice Studio.

---

## Environment Variables

Configure your keys in `electron_app/.env` (see [electron_app/.env.example](electron_app/.env.example)):

| Variable | Required | Description |
| :--- | :---: | :--- |
| `GEMINI_API_KEY` | Optional | Google AI Studio key for Gemini 3.5 Transcribe, Gemini Live, and practice fallback |
| `GROQ_API_KEY` | Optional | Groq Cloud key for Whisper Large v3 Turbo, idiomatic LLM translation, and AI Practice Studio |
| `FISH_API_KEY` | Optional | Fish Audio API key for neural TTS and custom voice cloning |
| `FISH_VOICE_MODEL_ID` | Optional | Your Fish Audio cloned voice ID (use `default` for standard voice) |
| `FISH_MODEL` | Optional | Fish Audio synthesis tier (`s2.1-pro-free`, `s2.1-pro`, `s2-pro`) |
| `VOXCPM_HOST` / `VOXCPM_PORT` | Optional | Local VoxCPM TTS microservice host/port (`127.0.0.1` / `8765`) |
| `VIBE_MODELS_DIR` | Dev/Test | Override directory for local ONNX/Bergamot models |
| `VIBE_SESSIONS_DIR` | Dev/Test | Override directory for trace lab recorded sessions |

> [!CAUTION]
> **Never commit `.env` or hardcode API keys.** `.env` is ignored by Git, excluded from `electron-builder` installers (`package.json`), and enforced by automated secret-leak tests in `electron_app/test/env.test.js`.

---

## Development, Testing & Building

All commands run from `electron_app/`:

```bash
# Development mode with auto-reload
npm run dev

# Run the full unit & integration test suite (293 tests)
npm test

# Run real Electron end-to-end tests (requires `npm run models`)
npm run test:e2e

# Include live speaker loopback E2E tests (Windows, plays audio)
VIBE_E2E_SPEAKERS=1 npm run test:e2e

# Build desktop installers
npm run build:win   # Windows NSIS Setup + Portable .exe
npm run build:mac   # macOS DMG + ZIP (x64 & arm64)
```

---

## Contributing

Contributions from developers, designers, linguists, and QA engineers are warmly welcome! Please read **[CONTRIBUTING.md](CONTRIBUTING.md)** for setup details, coding guidelines, and PR checklists.

### Areas Where You Can Help
- **Cross-platform audio**: macOS (`BlackHole` / `CoreAudio`) and Linux (`PipeWire`) equivalents for Windows audio ducking (`audio-ducker.ps1`).
- **Additional language pairs**: Expanding local Bergamot/Canary models and prompts beyond `ES ↔ EN` (e.g., Portuguese, French, German).
- **International Practice Studio**: New industry sectors, localized role-play scenarios, speech pacing/filler-word analytics, and pronunciation coaching.
- **UI & Accessibility**: Keyboard shortcuts, high-contrast polish, localization of the interface to English and Portuguese.
- **Testing & Performance**: Lowering end-to-end latency, expanding E2E coverage, and migrating `ScriptProcessorNode` to `AudioWorkletNode`.

---

## License

Released under the **MIT License**. See [electron_app/package.json](electron_app/package.json).
