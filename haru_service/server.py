"""
=============================================================================
ViBeTranslate - Haru-4B Multilingual Full-Duplex Server (`haru_service`)
=============================================================================
Microservicio para `higurashi-ai/Haru-4B` (Apache 2.0, Qwen3.5-4B + VibeVoice + MeanFlow):

¿POR QUÉ Y CÓMO USA `HUGGINGFACE_API_KEY`?
1. Ejecución en GPU NVIDIA A10G real en la nube (`hf_zerogpu`) sin GPU local:
   Cuando el equipo del usuario no dispone de una GPU NVIDIA de ~12 GB ni un Mac
   con Apple Silicon (`haru_mlx`), este servicio lee automáticamente `HUGGINGFACE_API_KEY`
   (desde el entorno o `../electron_app/.env`), lo expone como `HF_TOKEN` y se
   conecta autenticado al Space oficial `hugging-apps/haru-4b` (respaldo:
   `akhaliq/haru-4b-studio`) sobre **NVIDIA ZeroGPU A10G** usando la cuota de la
   cuenta de Hugging Face del usuario.
2. Backends locales automáticos cuando hay hardware dedicado:
   Si detecta CUDA (`haru`) o Apple Silicon (`haru_mlx`), prioriza la inferencia
   local full-duplex a 7.5 Hz (`133.3 ms` = `3200` muestras @ `24 kHz`) usando el
   mismo `HF_TOKEN` para descargar los pesos de `higurashi-ai/Haru-4B`.
3. Recorte inteligente de silencios + WSOLA (`wsola_compress`):
   En ZeroGPU el modelo procesa toda la línea temporal del usuario más 5 s de margen;
   recortamos el silencio digital de cabeza/cola para entregar la voz real de Haru
   de inmediato sin esperas muertas, y mantenemos WSOLA para absorber ráfagas sin
   cambiar el tono vocal.
=============================================================================
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import re
import struct
import wave
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import httpx
import numpy as np
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [Haru-Service] %(message)s",
)
logger = logging.getLogger("HaruService")

BASE_DIR = Path(__file__).resolve().parent
ELECTRON_ENV_PATH = BASE_DIR.parent / "electron_app" / ".env"
VOICES_DIR = BASE_DIR / "voices"
VOICES_DIR.mkdir(exist_ok=True)

HF_REPO = os.environ.get("HARU_HF_REPO", "higurashi-ai/Haru-4B")
ZEROGPU_SPACES = [
    os.environ.get("HARU_SPACE_URL", "https://hugging-apps-haru-4b.hf.space").rstrip("/"),
    "https://akhaliq-haru-4b-studio.hf.space",
]

SAMPLE_RATE = 24000
FRAME_HZ = 7.5
FRAME_SAMPLES = 3200  # 133.33 ms @ 24 kHz

MSG_HANDSHAKE = 0x00
MSG_AUDIO = 0x01
MSG_TEXT = 0x02
MSG_CONTROL = 0x03
MSG_METADATA = 0x04
MSG_ERROR = 0x05
MSG_PING = 0x06


def load_hf_token() -> str:
    """Obtiene `HUGGINGFACE_API_KEY` o `HF_TOKEN` del entorno o de `../electron_app/.env`."""
    token = (os.environ.get("HUGGINGFACE_API_KEY") or os.environ.get("HF_TOKEN") or "").strip()
    if not token and ELECTRON_ENV_PATH.exists():
        try:
            for raw_line in ELECTRON_ENV_PATH.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k in ("HUGGINGFACE_API_KEY", "HF_TOKEN") and v and "dummy" not in v.lower():
                    token = v
                    break
        except Exception as exc:
            logger.warning("No se pudo leer .env para HF_TOKEN: %s", exc)

    if token:
        os.environ["HF_TOKEN"] = token
        os.environ["HUGGINGFACE_API_KEY"] = token
    return token


def pcm16_to_wav_bytes(pcm16_bytes: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm16_bytes)
    return buf.getvalue()


def decode_wav_to_pcm16_24k(wav_bytes: bytes, trim_silence: bool = True) -> bytes:
    """Decodifica cualquier WAV (PCM 16/32-bit o IEEE float, mono/estéreo) a PCM16 mono 24 kHz."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        src_rate = wf.getframerate()
        nframes = wf.getnframes()
        raw = wf.readframes(nframes)

    if sampwidth == 2:
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sampwidth == 4:
        # Detectar float32 IEEE (formato 3 en cabecera RIFF) vs int32 PCM
        fmt_tag = struct.unpack_from("<H", wav_bytes, 20)[0] if len(wav_bytes) >= 22 else 1
        if fmt_tag == 3:
            samples = np.frombuffer(raw, dtype=np.float32)
        else:
            samples = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        samples = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0

    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)

    if src_rate != SAMPLE_RATE and samples.size > 1:
        dst_len = max(1, int(round(samples.size * SAMPLE_RATE / src_rate)))
        x_old = np.linspace(0.0, 1.0, samples.size, endpoint=False)
        x_new = np.linspace(0.0, 1.0, dst_len, endpoint=False)
        samples = np.interp(x_new, x_old, samples).astype(np.float32)

    # En ZeroGPU la línea temporal incluye los segundos en que el usuario habló antes de que Haru tome turno:
    # recortamos el silencio digital inicial/final dejando 60 ms de aire natural para respuesta instantánea.
    if trim_silence and samples.size > int(0.25 * SAMPLE_RATE):
        active = np.flatnonzero(np.abs(samples) > 0.008)
        if active.size > 0:
            pad = int(0.06 * SAMPLE_RATE)
            start = max(0, int(active[0]) - pad)
            end = min(samples.size, int(active[-1]) + pad)
            samples = samples[start:end]

    pcm16 = np.clip(samples * 32767.0, -32768, 32767).astype(np.int16)
    return pcm16.tobytes()


def wsola_compress(
    x: np.ndarray,
    rate: float,
    window: int = 240,
    tolerance: int = 60,
) -> np.ndarray:
    """Acorta audio int16 en la fracción ``rate`` (0..0.25) sin alterar su tono (WSOLA)."""
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


def parse_card_for_space(card_text: str) -> Tuple[str, str]:
    """Extrae código de idioma ('en'/'es'/...) y resumen de persona/situación para el Space Haru-4B."""
    text = (card_text or "").strip()
    is_es = "[Tu perfil]" in text or "Eres la persona descrita" in text
    lang = "es" if is_es else "en"

    # Extraer bloques relevantes de la Character Card para el override `persona` del Space
    persona_parts = []
    for header in ("[Your Persona]", "[Situation]", "[Tu perfil]", "[Situación]"):
        idx = text.find(header)
        if idx >= 0:
            after = text[idx + len(header) :].strip()
            line = after.splitlines()[0].strip() if after else ""
            if line:
                persona_parts.append(line)

    summary = " ".join(persona_parts).strip() or text.replace("\n", " ")[:360]
    return lang, summary


def synthesize_natural_tone(text: str, sr: int = SAMPLE_RATE) -> bytes:
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
    lang, summary = parse_card_for_space(card_text)
    if lang == "es":
        return [
            f"¡Hola! Qué gusto escucharte. {summary[:120]} ¿Cómo ves el panorama actual?",
            "Ajá, entiendo perfectamente ese punto. ¿Cuál fue el reto técnico más difícil que tuviste que destrabar ahí?",
            "Claro, tiene todo el sentido. ¡Muchas gracias por compartirlo con tanta claridad!",
        ]
    return [
        f"Hey, great to have you on the call! {summary[:120]} How would you frame the main challenge?",
        "Right, I see what you mean. How did you balance speed versus reliability when making that call?",
        "That makes a lot of sense—thanks for walking me through your thinking today.",
    ]


class HaruZeroGPUClient:
    """Cliente asíncrono autenticado contra `hugging-apps/haru-4b` (GPU NVIDIA A10G ZeroGPU)."""

    def __init__(self, hf_token: str) -> None:
        self.hf_token = hf_token
        self.active_space: str = ZEROGPU_SPACES[0]

    @property
    def headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.hf_token}"} if self.hf_token else {}

    async def converse(
        self,
        user_pcm16_24k: bytes,
        language: str = "en",
        persona: str = "",
        speak_first: bool = False,
        reference_wav_path: Optional[Path] = None,
    ) -> Tuple[bytes, str, str]:
        """Envía un turno de audio a Haru-4B en ZeroGPU A10G y devuelve `(pcm16_24k, transcript, space_url)`."""
        # Garantizar al menos 0.5 s de audio válido para que `load_audio` del Space nunca falle
        min_bytes = int(0.5 * SAMPLE_RATE) * 2
        if len(user_pcm16_24k) < min_bytes:
            user_pcm16_24k = user_pcm16_24k + b"\x00" * (min_bytes - len(user_pcm16_24k))

        wav_payload = pcm16_to_wav_bytes(user_pcm16_24k, SAMPLE_RATE)
        last_err: Optional[Exception] = None

        for space_url in [ZEROGPU_SPACES[0], ZEROGPU_SPACES[0]]:
            try:
                # Forzar IPv4 (`local_address="0.0.0.0"`) y reintentos de transporte para evitar
                # fallos intermitentes de resolución DNS IPv6 en Windows hacia `*.hf.space`.
                transport = httpx.AsyncHTTPTransport(local_address="0.0.0.0", retries=2)
                async with httpx.AsyncClient(transport=transport, timeout=75.0, follow_redirects=True) as client:
                    # 1. Subir audio del turno del usuario
                    up_res = await client.post(
                        f"{space_url}/gradio_api/upload",
                        headers=self.headers,
                        files={"files": ("user_turn.wav", wav_payload, "audio/wav")},
                    )
                    up_res.raise_for_status()
                    uploaded_files = up_res.json()
                    user_file_obj = {"path": uploaded_files[0], "meta": {"_type": "gradio.FileData"}}

                    # 2. Subir audio de referencia para clonación Zero-Shot si se configuró
                    ref_file_obj = None
                    if reference_wav_path and reference_wav_path.exists():
                        ref_bytes = reference_wav_path.read_bytes()
                        ref_up = await client.post(
                            f"{space_url}/gradio_api/upload",
                            headers=self.headers,
                            files={"files": (reference_wav_path.name, ref_bytes, "audio/wav")},
                        )
                        if ref_up.status_code == 200:
                            ref_file_obj = {"path": ref_up.json()[0], "meta": {"_type": "gradio.FileData"}}

                    # 3. Encolar inferencia en GPU A10G ZeroGPU
                    call_payload = {
                        "data": [
                            user_file_obj,
                            ref_file_obj,
                            language if language in ("en", "es", "pt", "fr", "de", "ja", "zh", "ko", "ru") else "en",
                            persona or "",
                            1.5,
                            0.75,
                            25,
                            -1,
                            bool(speak_first),
                        ]
                    }
                    call_res = await client.post(
                        f"{space_url}/gradio_api/call/converse",
                        headers={**self.headers, "Content-Type": "application/json"},
                        json=call_payload,
                    )
                    call_res.raise_for_status()
                    event_id = call_res.json()["event_id"]

                    # 4. Leer flujo SSE hasta `event: complete`
                    current_event = ""
                    result_data = None
                    async with client.stream(
                        "GET",
                        f"{space_url}/gradio_api/call/converse/{event_id}",
                        headers=self.headers,
                    ) as stream:
                        async for line in stream.aiter_lines():
                            if line.startswith("event:"):
                                current_event = line[6:].strip()
                            elif line.startswith("data:"):
                                raw_data = line[5:].strip()
                                if current_event == "complete":
                                    result_data = json.loads(raw_data)
                                    break
                                if current_event == "error":
                                    raise RuntimeError(f"ZeroGPU error: {raw_data}")

                    if not result_data or len(result_data) < 2:
                        raise RuntimeError("Respuesta incompleta desde ZeroGPU Haru-4B")

                    audio_meta, transcript = result_data[0], str(result_data[1] or "").strip()
                    audio_url = audio_meta.get("url") or f"{space_url}/gradio_api/file={audio_meta['path']}"
                    wav_res = await client.get(audio_url, headers=self.headers)
                    wav_res.raise_for_status()

                    pcm16_out = decode_wav_to_pcm16_24k(wav_res.content, trim_silence=True)
                    self.active_space = space_url
                    return pcm16_out, transcript, space_url
            except Exception as exc:
                last_err = exc
                logger.warning("Aviso en Space %s: %s", space_url, exc)

        raise RuntimeError(f"No se pudo completar turno en ZeroGPU Haru-4B: {last_err}")


class HaruRuntime:
    def __init__(self) -> None:
        self.mode: str = "simulation"  # "haru_pytorch" | "haru_mlx" | "hf_zerogpu" | "simulation"
        self.device: str = "cpu"
        self.gpu_name: Optional[str] = None
        self.hf_token: str = ""
        self.hf_user: Optional[str] = None
        self.zerogpu: Optional[HaruZeroGPUClient] = None
        self.model = None
        self.load_error: Optional[str] = None
        self._lock = asyncio.Lock()

    def initialize(self) -> None:
        self.hf_token = load_hf_token()
        if self.hf_token:
            try:
                r = httpx.get(
                    "https://huggingface.co/api/whoami-v2",
                    headers={"Authorization": f"Bearer {self.hf_token}"},
                    timeout=6.0,
                )
                if r.status_code == 200:
                    self.hf_user = r.json().get("name")
                    logger.info("Autenticado en Hugging Face como '%s'.", self.hf_user)
            except Exception as exc:
                logger.warning("No se pudo verificar whoami en Hugging Face: %s", exc)

        if os.environ.get("HARU_FORCE_SIMULATION", "0") == "1":
            logger.info("HARU_FORCE_SIMULATION=1 activo: iniciando en modo simulación.")
            return

        # 1. Intentar PyTorch (`haru`) con CUDA (~12 GB VRAM)
        try:
            import torch
            from haru import HaruModel  # type: ignore

            if torch.cuda.is_available():
                self.device = "cuda"
                self.gpu_name = torch.cuda.get_device_name(0)
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
            return
        except Exception as exc:
            if not self.load_error:
                self.load_error = str(exc)

        # 3. Conectar a GPU NVIDIA A10G real en Hugging Face ZeroGPU usando HUGGINGFACE_API_KEY
        if self.hf_token:
            self.zerogpu = HaruZeroGPUClient(self.hf_token)
            self.mode = "hf_zerogpu"
            self.device = "hf-zero-a10g"
            self.gpu_name = "NVIDIA A10G (Hugging Face ZeroGPU)"
            logger.info(
                "Haru-4B conectado a GPU NVIDIA A10G remota (%s) con HUGGINGFACE_API_KEY.",
                self.zerogpu.active_space,
            )
            return

        logger.warning(
            "Sin GPU local ni HUGGINGFACE_API_KEY (%s). Ejecutando en modo simulación full-duplex (7.5 Hz + WSOLA).",
            self.load_error,
        )
        self.mode = "simulation"


runtime = HaruRuntime()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    runtime.initialize()
    yield


app = FastAPI(title="ViBeTranslate Haru-4B Full-Duplex Service", version="1.1.0", lifespan=lifespan)
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
        "hf_authenticated": bool(runtime.hf_user or runtime.hf_token),
        "hf_user": runtime.hf_user,
        "space_url": runtime.zerogpu.active_space if runtime.zerogpu else None,
        "sample_rate": SAMPLE_RATE,
        "frame_hz": FRAME_HZ,
        "frame_samples": FRAME_SAMPLES,
        "wsola_enabled": True,
        "reference_clips": ref_clips,
    }


@app.post("/test-hf")
async def test_hf_inference(
    language: str = Query(default="es"),
    persona: str = Query(default="Elena es líder técnica de nube en Madrid, cercana y clara."),
):
    """Ejecuta una prueba real de voz contra Haru-4B en la GPU A10G de Hugging Face."""
    if not runtime.zerogpu:
        return {"ok": False, "error": "HUGGINGFACE_API_KEY no configurada"}
    t0 = asyncio.get_event_loop().time()
    silence_half_sec = b"\x00" * (int(0.6 * SAMPLE_RATE) * 2)
    pcm16, transcript, space_url = await runtime.zerogpu.converse(
        silence_half_sec,
        language=language,
        persona=persona,
        speak_first=True,
    )
    elapsed_ms = round((asyncio.get_event_loop().time() - t0) * 1000)
    duration_sec = round(len(pcm16) / 2 / SAMPLE_RATE, 2)
    return {
        "ok": True,
        "mode": runtime.mode,
        "hf_user": runtime.hf_user,
        "space_url": space_url,
        "language": language,
        "transcript": transcript,
        "audio_bytes": len(pcm16),
        "audio_duration_sec": duration_sec,
        "elapsed_ms": elapsed_ms,
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
            if runtime.mode == "hf_zerogpu" and runtime.zerogpu is not None:
                await _run_zerogpu_session(ws, text_prompt, voice_prompt)
            else:
                await _run_simulation_duplex(ws, text_prompt)
        except WebSocketDisconnect:
            logger.info("Cliente desconectado de /api/chat (Haru)")
        except Exception as exc:
            logger.error("Error en sesión Haru: %s", exc)
            try:
                await ws.send_bytes(bytes([MSG_ERROR]) + str(exc).encode("utf-8"))
            except Exception:
                pass


async def _stream_pcm_and_text(ws: WebSocket, sentence: str, pcm_bytes: bytes) -> None:
    """Envía audio PCM 24 kHz y tokens de texto intercalados (como el reloj 7.5 Hz real),
    cerrando la oración al final para que el cliente reciba todo el audio junto con el subtítulo."""
    clean_text = sentence.strip()
    if clean_text and not clean_text.endswith((".", "!", "?")):
        clean_text += "."
    words = clean_text.split(" ") if clean_text else []

    frame_bytes = FRAME_SAMPLES * 2  # 133.3 ms @ 24 kHz int16 = 6400 bytes
    audio_chunks = [pcm_bytes[i : i + frame_bytes] for i in range(0, len(pcm_bytes), frame_bytes)] if pcm_bytes else []

    total_steps = max(len(words), len(audio_chunks), 1)
    word_idx = 0
    for step in range(total_steps):
        if step < len(audio_chunks):
            await ws.send_bytes(bytes([MSG_AUDIO]) + audio_chunks[step])
        # Repartir las palabras proporcionalmente a lo largo de los frames de audio
        target_word = int(((step + 1) * len(words)) / total_steps)
        while word_idx < target_word:
            piece = words[word_idx] if word_idx == 0 else f" {words[word_idx]}"
            await ws.send_bytes(bytes([MSG_TEXT]) + piece.encode("utf-8"))
            word_idx += 1
        await asyncio.sleep(0.012)


async def _run_zerogpu_session(ws: WebSocket, card_prompt: str, voice_prompt: str) -> None:
    assert runtime.zerogpu is not None
    lang, persona_summary = parse_card_for_space(card_prompt)
    ref_path = (VOICES_DIR / voice_prompt) if (voice_prompt and voice_prompt != "auto") else None
    if ref_path and not ref_path.exists():
        candidate = Path(voice_prompt)
        ref_path = candidate if candidate.exists() else None

    await ws.send_bytes(bytes([MSG_HANDSHAKE]))
    await ws.send_bytes(
        bytes([MSG_METADATA])
        + json.dumps(
            {
                "engine": "haru-4b",
                "mode": "hf_zerogpu",
                "gpu": runtime.gpu_name,
                "hf_user": runtime.hf_user,
                "language": lang,
                "sampleRate": SAMPLE_RATE,
            }
        ).encode("utf-8")
    )

    # Saludo inicial real generado por Haru-4B en GPU A10G (`speak_first=True`)
    try:
        opening_pcm, opening_txt, _ = await runtime.zerogpu.converse(
            b"\x00" * (int(0.6 * SAMPLE_RATE) * 2),
            language=lang,
            persona=persona_summary,
            speak_first=True,
            reference_wav_path=ref_path,
        )
        await _stream_pcm_and_text(ws, opening_txt, opening_pcm)
    except Exception as exc:
        logger.warning("Fallback en apertura ZeroGPU (%s); enviando saludo local.", exc)
        fallback = extract_simulation_prompts(card_prompt)[0]
        await _stream_pcm_and_text(ws, fallback, synthesize_natural_tone(fallback, SAMPLE_RATE))

    user_audio_buf = bytearray()
    voiced_frames = 0
    silent_frames = 0

    async def respond_to_buffer() -> None:
        nonlocal user_audio_buf, voiced_frames, silent_frames
        captured = bytes(user_audio_buf)
        user_audio_buf = bytearray()
        voiced_frames = 0
        silent_frames = 0
        if len(captured) < int(0.25 * SAMPLE_RATE) * 2:
            captured = captured + b"\x00" * (int(0.6 * SAMPLE_RATE) * 2)
        try:
            reply_pcm, reply_txt, _ = await runtime.zerogpu.converse(
                captured,
                language=lang,
                persona=persona_summary,
                speak_first=False,
                reference_wav_path=ref_path,
            )
            await _stream_pcm_and_text(ws, reply_txt, reply_pcm)
        except Exception as exc:
            logger.warning("Aviso en turno ZeroGPU (%s); usando respaldo local.", exc)
            fallback = extract_simulation_prompts(card_prompt)[1]
            await _stream_pcm_and_text(ws, fallback, synthesize_natural_tone(fallback, SAMPLE_RATE))

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
            await respond_to_buffer()
            continue

        if kind == MSG_AUDIO and len(payload) >= 2:
            even = payload[: len(payload) - (len(payload) % 2)]
            user_audio_buf.extend(even)
            # Limitar búfer de turno a 28 s @ 24 kHz
            max_buf = 28 * SAMPLE_RATE * 2
            if len(user_audio_buf) > max_buf:
                user_audio_buf = user_audio_buf[-max_buf:]

            samples = np.frombuffer(even, dtype=np.int16).astype(np.float32) / 32768.0
            rms = float(np.sqrt(np.mean(samples * samples))) if samples.size else 0.0
            if rms > 0.015:
                voiced_frames += 1
                silent_frames = 0
            elif voiced_frames >= 6:
                silent_frames += 1
                if silent_frames >= 10:
                    await respond_to_buffer()


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
        await _stream_pcm_and_text(ws, turns[0], synthesize_natural_tone(turns[0], SAMPLE_RATE))
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
                await _stream_pcm_and_text(ws, turns[turn_idx], synthesize_natural_tone(turns[turn_idx], SAMPLE_RATE))
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
                    await _stream_pcm_and_text(ws, turns[turn_idx], synthesize_natural_tone(turns[turn_idx], SAMPLE_RATE))
                    turn_idx += 1
                    voiced_frames = 0
                    silent_frames = 0


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("HARU_PORT", "8999"))
    host = os.environ.get("HARU_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port)
