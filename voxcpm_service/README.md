# 🎙️ ViBeTranslate - VoxCPM Ultra-Low Latency Microservice

Este microservicio integra **[OpenBMB/VoxCPM](https://github.com/OpenBMB/VoxCPM)** para proporcionar síntesis de voz (*Text-to-Speech*) y clonación de voz (*Zero-Shot Voice Cloning*) en tiempo real para **ViBeTranslate**.

---

## ⚡ Características Principales

* **Latencia Ultrabaja**: Primer paquete de audio generado en **< 100 ms** mediante WebSocket Streaming.
* **Sin Tokens Discretos (*Tokenizer-Free*)**: Audio generado en espacio continuo sin artefactos robóticos.
* **Calidad de Estudio**: Salida nativa a **48 kHz PCM / WAV**.
* **Clonación Zero-Shot**: Clona tu timbre y tono de voz con solo 3 a 10 segundos de audio.
* **100% Privado y Sin Costo de API**: Corre localmente en tu GPU (NVIDIA CUDA) o en un servidor dedicado.

---

## 🚀 Inicio Rápido en Windows

### 1. Iniciar con un clic:
Haz doble clic en el archivo:
```bash
start_server.bat
```

O manualmente en la terminal:
```bash
cd voxcpm_service
pip install -r requirements.txt
python server.py
```

El servidor quedará disponible en:
* **HTTP API**: `http://127.0.0.1:8765`
* **WebSocket Streaming**: `ws://127.0.0.1:8765/v1/tts/live`
* **Health Check**: `http://127.0.0.1:8765/health`

---

## 🧪 Probar la Integración

En la carpeta `electron_app/`, ejecuta:
```bash
cd electron_app
node test-voxcpm.js
```

---

## 🔌 Endpoints de la API

### 1. `GET /health`
Verifica el estado del servidor, detección de GPU (CUDA) y perfiles de voz cargados.

### 2. `POST /v1/voice/clone`
Registra un audio de referencia para clonar una voz.
```json
{
  "voice_id": "julian_voice",
  "audio_base64": "<base64_audio_data>"
}
```

### 3. `POST /v1/tts/synthesize`
Síntesis directa (REST) que devuelve un archivo `.wav` descargable.
```json
{
  "text": "Hello, this is a test.",
  "voice_id": "julian_voice",
  "language": "en"
}
```

### 4. `WebSocket /v1/tts/live`
Conexión bidireccional continua para recibir chunks de audio PCM 48kHz en tiempo real a medida que el LLM genera texto.
