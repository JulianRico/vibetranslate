# ViBeTranslate · Microservicio NVIDIA PersonaPlex (`personaplex_service/`)

Microservicio opcional que integra **[NVIDIA PersonaPlex (`nvidia/personaplex-7b-v1`)](https://github.com/NVIDIA/personaplex)** como interlocutor conversacional **full-duplex en inglés (`<200 ms`)** para el **Estudio de Práctica de Entrevistas y Reuniones Internacionales** de ViBeTranslate Pro Studio.

## Características
- **Full-Duplex real a `24 kHz` (`80 ms` por frame)**: escucha y habla simultáneamente, maneja pausas naturales, asentimientos (*backchannels*) e interrupciones (*barge-in*).
- **Prompt fijado en memoria (`--pin-system-prompt` + `--prefill-system-prompt`)**: conserva el rol del entrevistador/interlocutor y el guion del libreto IA durante toda la sesión sin degradarse.
- **18 voces oficiales incluidas**: `NATF0–3`, `NATM0–3`, `VARF0–4`, `VARM0–4` más soporte para voces personalizadas `.wav` en `voices/`.
- **Protocolo binario de 1 byte sin sobrecoste Base64**:
  - `0x00`: Handshake
  - `0x01`: Audio (`pcm16` directo a `24 kHz` para Electron sin librerías C++ extra, o `opus` compatible con `moshi.server`)
  - `0x02`: Tokens de texto UTF-8 generados al mismo tiempo que el audio
- **Modo simulación integrado**: si no hay GPU de `16 GB+ VRAM` o aún no se han descargado los pesos de Hugging Face, el servidor inicia en modo simulación determinista para desarrollo y pruebas de integración.

## Requisitos e instalación (GPU NVIDIA `16 GB+ VRAM` recomendada)

1. Acepta la licencia abierta del modelo en Hugging Face: https://huggingface.co/nvidia/personaplex-7b-v1 y define `HF_TOKEN`.
2. Instala las dependencias base y `moshi` desde `NVIDIA/personaplex`:

```bash
cd personaplex_service
pip install -r requirements.txt
git clone https://github.com/NVIDIA/personaplex.git
pip install ./personaplex/moshi
```

3. Inicia el servidor (`127.0.0.1:8998`):

```bash
# En GPU con >= 16 GB VRAM:
python server.py

# Con CPU Offload en GPUs con menos VRAM:
set PERSONAPLEX_CPU_OFFLOAD=1
python server.py
```

En **ViBeTranslate Pro Studio**, abre **Entrevista y reunión → Voz y control de turnos** y elige **Motor del interlocutor: `PersonaPlex Full-Duplex (<200 ms)`**.
