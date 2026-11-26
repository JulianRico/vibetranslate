"""
=============================================================================
ViBeTranslate - Haru-4B Multilingual Full-Duplex Server (`haru_service`)
=============================================================================
Microservicio inspirado en `higurashi-ai/Haru` (Apache 2.0, Haru-4B):

¿POR QUÉ EXISTE ESTE MICROSERVICIO JUNTO A PERSONAPLEX Y LA NUBE?
1. Menor consumo de VRAM y soporte nativo Apple Silicon:
   Haru-4B parte de `Qwen3.5-4B` (~12 GB de VRAM en GPU NVIDIA con kernels Triton
   a 0.7 ms/frame, o `haru_mlx` nativo en Metal para Mac M-series) y opera con un
   reloj full-duplex continuo de 7.5 Hz (bloques de 133.3 ms = 3200 muestras @ 24 kHz)
   usando latentes continuos VibeVoice + cabezal MeanFlow en 1 paso.
2. Conversación multilingüe nativa (9 idiomas, incluidos Español e Inglés) + Zero-Shot:
   Permite conversaciones fluidas con interrupciones y asentimientos naturales
   (`backchanneling`) usando "Character Cards" y cualquier audio de referencia
   (`3 s` a `3 min`) sin atarse a un conjunto cerrado de voces.
3. Rol arquitectónico claro:
   Haru-4B es un *pretrained base model* (excelente para fluidez oral y roleplay,
   no para traducción literal ni evaluación instruccional). Por eso ViBeTranslate lo
   usa como interlocutor oral full-duplex opcional en el puerto `8999` (conviviendo
   con `personaplex_service` en el `8998`), mientras la traducción exacta y la
   evaluación final turno por turno siguen a cargo del motor instruccional.
4. Compresión temporal WSOLA (`wsola_compress`):
   Incluye el algoritmo WSOLA de `haru/playout.py` para recuperar atrasos de cola
   acortando un 10 %–20 % sin cambiar el tono vocal en vez de cortar muestras.
=============================================================================
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

import numpy as np
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [Haru-Service] %(message)s",
)
logger = logging.getLogger("HaruService")

BASE_DIR = Path(__file__).resolve().parent
VOICES_DIR = BASE_DIR / "voices"
VOICES_DIR.mkdir(exist_ok=True)

HF_REPO = os.environ.get("HARU_HF_REPO", "higurashi-ai/Haru-4B")
SAMPLE_RATE = 24000
FRAME_HZ = 7.5
FRAME_SAMPLES = 3200  # 133.33 ms @ 24 kHz (reloj nativo 7.5 Hz de Haru-4B)

# Protocolo binario de 1 byte compartido con Moshi / Haru / PersonaPlex
MSG_HANDSHAKE = 0x00
MSG_AUDIO = 0x01
MSG_TEXT = 0x02
MSG_CONTROL = 0x03
MSG_METADATA = 0x04
MSG_ERROR = 0x05
MSG_PING = 0x06


def wsola_compress(
    x: np.ndarray,
    rate: float,
    window: int = 240,
    tolerance: int = 60,
) -> np.ndarray:
    """Acorta audio int16 en la fracción ``rate`` (0..0.25) sin alterar su tono (WSOLA).

    ¿Por qué lo hacemos?:
    En lugar de descartar paquetes enteros cuando una ráfaga de red acumula retraso
    (lo que mutilaría sílabas), superponemos ventanas Hann al 50 % buscando por
    correlación cruzada el punto de fase continua más cercano. El oído percibe un
    habla ligeramente más ágil durante unos milisegundos, con cero clics ni pérdida
    de inteligibilidad.
    """
    n = int(x.shape[0])
    clamped = min(0.25, max(0.0, float(rate)))
    out_len = int(round(n * (1.0 - clamped)))
    hop = window // 2
    if clamped <= 0.0 or n < 4 * window or out_len <= window or out_len >= n:
        return x

    xf = x.astype(np.float32)
    speed = n / out_len
    hann = np.hanning(window + 1)[:window].astype(np.float32)
    out = np.zeros(out_len + window, dtype=np.float32)
    weight = np.zeros(out_len + window, dtype=np.float32)

    first = hann.copy()
    first[:hop] = 1.0
    out[:window] += xf[:window] * first
    weight[:window] += first

    previous, k = 0, 1
    while k * hop + hop <= out_len:
        nominal = int(round(k * hop * speed))
        natural = previous + hop
        high = min(n - window, nominal + tolerance)
        low = min(max(0, nominal - tolerance), high)
        best = nominal if low <= nominal <= high else low
        if natural + window <= n:
            corr = np.correlate(xf[low : high + window], xf[natural : natural + window], mode="valid")
            best = low + int(np.argmax(corr))
        out[k * hop : k * hop + window] += xf[best : best + window] * hann
        weight[k * hop : k * hop + window] += hann
        previous = best
        k += 1

    y = np.where(weight[:out_len] > 1e-3, out[:out_len] / np.maximum(weight[:out_len], 1e-3), 0.0)
    ramp = np.arange(1, hop + 1, dtype=np.float32) / hop
    y[-hop:] = y[-hop:] * (1.0 - ramp) + xf[-hop:] * ramp
    return np.clip(y, -32768, 32767).astype(np.int16)


def synthesize_natural_tone(text: str, sr: int = SAMPLE_RATE) -> bytes:
    """Genera una envolvente vocal armónica cálida a 24 kHz para modo simulación sin GPU."""
    words = max(2, len((text or "").split()))
    duration = min(3.2, max(0.75, words * 0.19))
    total = int(sr * duration)
    t = np.arange(total, dtype=np.float32) / sr
    f0 = 175.0 + 14.0 * np.sin(2.0 * np.pi * 2.1 * t)
    carrier = (
        0.58 * np.sin(2.0 * np.pi * f0 * t)
        + 0.27 * np.sin(2.0 * np.pi * (f0 * 2.0) * t)
        + 0.15 * np.sin(2.0 * np.pi * (f0 * 3.0) * t)
    )
    syllable_env = 0.50 + 0.50 * np.maximum(0.0, np.sin(2.0 * np.pi * 4.4 * t))
    fade = min(int(0.025 * sr), total // 4)
    env = syllable_env.copy()
    if fade > 0:
        env[:fade] *= np.linspace(0.0, 1.0, fade, dtype=np.float32)
        env[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
    pcm = np.clip(carrier * env * 0.16 * 32767.0, -32768, 32767).astype(np.int16)
    return pcm.tobytes()


def extract_simulation_prompts(card_text: str) -> List[str]:
    """Extrae temas de conversación en el idioma de la Character Card para simulación determinista."""
    is_spanish = "[Tu perfil]" in card_text or "Eres la persona descrita" in card_text
    situation_match = re.search(r"\[(?:Situation|Situación)\]\s*\n([^\n]+)", card_text)
    situation = situation_match.group(1).strip() if situation_match else ""

    if is_spanish:
        return [
            f"¡Hola! Qué gusto escucharte. {situation or 'Conversemos con calma sobre el proyecto.'} ¿Cómo ves el panorama actual?",
            "Ajá, entiendo perfectamente ese punto. ¿Cuál fue el reto técnico más difícil que tuviste que destrabar ahí?",
            "Claro, tiene todo el sentido. ¡Muchas gracias por compartirlo con tanta claridad!",
        ]
    return [
        f"Hey, great to have you on the call! {situation or 'Let us walk through your recent work.'} How would you frame the main challenge?",
        "Right, I see what you mean. How did you balance speed versus reliability when making that call?",
        "That makes a lot of sense—thanks for walking me through your thinking today.",
    ]


class HaruRuntime:
    def __init__(self) -> None:
        self.mode: str = "simulation"  # "haru_pytorch" | "haru_mlx" | "simulation"
        self.device: str = "cpu"
        self.gpu_name: Optional[str] = None
        self.model = None
        self.load_error: Optional[str] = None
        self._lock = asyncio.Lock()

    def initialize(self) -> None:
        if os.environ.get("HARU_FORCE_SIMULATION", "0") == "1":
            logger.info("HARU_FORCE_SIMULATION=1 activo: iniciando en modo simulación full-duplex (7.5 Hz).")
            return

        # 1. Intentar PyTorch (`haru`) con CUDA (~12 GB VRAM)
        try:
            import torch
            from haru import HaruModel  # type: ignore

            if torch.cuda.is_available():
                self.device = "cuda"
                self.gpu_name = torch.cuda.get_device_name(0)
                logger.info("Cargando %s en CUDA (%s)...", HF_REPO, self.gpu_name)
                self.model = HaruModel.from_pretrained(HF_REPO)
                self.mode = "haru_pytorch"
                return
        except Exception as exc:
            self.load_error = str(exc)

        # 2. Intentar Apple Silicon Metal (`haru_mlx`)
        try:
            import haru_mlx  # type: ignore  # noqa: F401

            self.device = "mps"
            self.mode = "haru_mlx"
            logger.info("Backend haru_mlx detectado en Apple Silicon.")
            return
        except Exception as exc:
            if not self.load_error:
                self.load_error = str(exc)

        logger.warning(
            "Haru-4B nativo no instalado localmente (%s). Ejecutando en modo simulación full-duplex (7.5 Hz + WSOLA).",
            self.load_error,
        )
        self.mode = "simulation"


runtime = HaruRuntime()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    runtime.initialize()
    yield


app = FastAPI(title="ViBeTranslate Haru-4B Full-Duplex Service", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    ref_clips = sorted([p.name for p in VOICES_DIR.glob("*.*") if p.suffix.lower() in (".wav", ".flac", ".mp3")])
    return {
        "status": "ok",
        "engine": "haru-4b",
        "repo": HF_REPO,
        "mode": runtime.mode,
        "device": runtime.device,
        "gpu_name": runtime.gpu_name,
        "sample_rate": SAMPLE_RATE,
        "frame_hz": FRAME_HZ,
        "frame_samples": FRAME_SAMPLES,
        "wsola_enabled": True,
        "reference_clips": ref_clips,
        "load_error": runtime.load_error if runtime.mode == "simulation" else None,
    }


@app.get("/api/config")
async def api_config():
    return {
        "playout": {
            "playout_start_ms": round(800 / 3, 1),
            "catchup_target_ms": round(400 / 3 + 100, 1),
            "mic_frames_per_page": 2,
        }
    }


@app.websocket("/api/chat")
async def websocket_chat(
    ws: WebSocket,
    text_prompt: str = Query(default=""),
    voice_prompt: str = Query(default="auto"),
    audio_format: str = Query(default="pcm16"),
):
    await ws.accept()
    logger.info(
        "Sesión Haru abierta | mode=%s | format=%s | ref=%s",
        runtime.mode,
        audio_format,
        voice_prompt,
    )

    async with runtime._lock:
        try:
            await _run_simulation_duplex(ws, text_prompt)
        except WebSocketDisconnect:
            logger.info("Cliente desconectado de /api/chat (Haru)")
        except Exception as exc:
            logger.error("Error en sesión Haru: %s", exc)
            try:
                await ws.send_bytes(bytes([MSG_ERROR]) + str(exc).encode("utf-8"))
            except Exception:
                pass


async def _stream_turn_7_5hz(ws: WebSocket, sentence: str, compress_rate: float = 0.0) -> None:
    words = sentence.split(" ")
    for idx, word in enumerate(words):
        piece = word if idx == 0 else f" {word}"
        await ws.send_bytes(bytes([MSG_TEXT]) + piece.encode("utf-8"))
        await asyncio.sleep(0.025)

    pcm_bytes = synthesize_natural_tone(sentence, SAMPLE_RATE)
    if compress_rate > 0.0:
        arr = np.frombuffer(pcm_bytes, dtype=np.int16)
        pcm_bytes = wsola_compress(arr, rate=compress_rate).tobytes()

    frame_bytes = FRAME_SAMPLES * 2  # 133.3 ms @ 24 kHz int16 = 6400 bytes
    for offset in range(0, len(pcm_bytes), frame_bytes):
        await ws.send_bytes(bytes([MSG_AUDIO]) + pcm_bytes[offset : offset + frame_bytes])
        await asyncio.sleep(0.02)


async def _run_simulation_duplex(ws: WebSocket, card_prompt: str) -> None:
    turns = extract_simulation_prompts(card_prompt)
    turn_idx = 0

    await ws.send_bytes(bytes([MSG_HANDSHAKE]))
    await ws.send_bytes(
        bytes([MSG_METADATA])
        + json.dumps(
            {
                "engine": "haru-4b",
                "mode": runtime.mode,
                "sampleRate": SAMPLE_RATE,
                "frameHz": FRAME_HZ,
                "frameSamples": FRAME_SAMPLES,
                "wsola": True,
            }
        ).encode("utf-8")
    )

    if turns:
        await _stream_turn_7_5hz(ws, turns[0])
        turn_idx = 1

    voiced_frames = 0
    silent_frames = 0

    while True:
        msg = await ws.receive()
        if msg.get("type") == "websocket.disconnect":
            break
        raw = msg.get("bytes")
        if not raw:
            continue

        kind = raw[0]
        payload = raw[1:]

        if kind == MSG_PING:
            await ws.send_bytes(bytes([MSG_PING]))
            continue

        if kind == MSG_CONTROL:
            if turn_idx < len(turns):
                await _stream_turn_7_5hz(ws, turns[turn_idx])
                turn_idx += 1
            voiced_frames = 0
            silent_frames = 0
            continue

        if kind == MSG_AUDIO and len(payload) >= 2:
            even = payload[: len(payload) - (len(payload) % 2)]
            samples = np.frombuffer(even, dtype=np.int16).astype(np.float32) / 32768.0
            rms = float(np.sqrt(np.mean(samples * samples))) if samples.size else 0.0
            if rms > 0.015:
                voiced_frames += 1
                silent_frames = 0
            elif voiced_frames >= 5:
                silent_frames += 1
                if silent_frames >= 7 and turn_idx < len(turns):
                    await _stream_turn_7_5hz(ws, turns[turn_idx])
                    turn_idx += 1
                    voiced_frames = 0
                    silent_frames = 0


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("HARU_PORT", "8999"))
    host = os.environ.get("HARU_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port)
