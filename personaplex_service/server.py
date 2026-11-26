"""
=============================================================================
ViBeTranslate - NVIDIA PersonaPlex Full-Duplex Conversational Server
=============================================================================
Microservicio para `nvidia/personaplex-7b-v1` (Moshi + Helium + Mimi 24 kHz):
- Conversación speech-to-speech full-duplex en tiempo real (<200 ms)
- Prompt de rol fijado en memoria (`--pin-system-prompt` + `--prefill-system-prompt`)
- 18 voces oficiales (`NATF0-3`, `NATM0-3`, `VARF0-4`, `VARM0-4`) + voces `.wav`/`.pt`
- Compatible con el protocolo binario oficial de `NVIDIA/personaplex` (`0x00` handshake,
  `0x01` audio, `0x02` texto UTF-8) tanto en Opus (`audio_format=opus`) como en PCM16
  directo (`audio_format=pcm16`) para clientes Electron sin dependencias C++ en Windows.
- Liberación automática de caché VRAM al cerrar cada sesión y modo de simulación
  determinista cuando PyTorch/Moshi no está instalado localmente.
=============================================================================
"""

import os
import re
import json
import time
import asyncio
import logging
import tarfile
from pathlib import Path
from typing import Optional, List

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware

try:
    import torch
except ImportError:
    torch = None  # type: ignore

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [PersonaPlex-Service] %(message)s",
)
logger = logging.getLogger("PersonaPlex")

BASE_DIR = Path(__file__).resolve().parent
VOICES_DIR = BASE_DIR / "voices"
VOICES_DIR.mkdir(exist_ok=True)

HF_REPO = os.environ.get("PERSONAPLEX_HF_REPO", "nvidia/personaplex-7b-v1")
SAMPLE_RATE = 24000
FRAME_RATE = 12.5
FRAME_SAMPLES = int(SAMPLE_RATE / FRAME_RATE)  # 1920 muestras = 80 ms @ 24 kHz

MSG_HANDSHAKE = 0x00
MSG_AUDIO = 0x01
MSG_TEXT = 0x02
MSG_CONTROL = 0x03
MSG_METADATA = 0x04
MSG_ERROR = 0x05
MSG_PING = 0x06

OFFICIAL_VOICES = [
    {"id": "NATF0", "file": "NATF0.pt", "gender": "female", "group": "NAT"},
    {"id": "NATF1", "file": "NATF1.pt", "gender": "female", "group": "NAT"},
    {"id": "NATF2", "file": "NATF2.pt", "gender": "female", "group": "NAT"},
    {"id": "NATF3", "file": "NATF3.pt", "gender": "female", "group": "NAT"},
    {"id": "NATM0", "file": "NATM0.pt", "gender": "male", "group": "NAT"},
    {"id": "NATM1", "file": "NATM1.pt", "gender": "male", "group": "NAT"},
    {"id": "NATM2", "file": "NATM2.pt", "gender": "male", "group": "NAT"},
    {"id": "NATM3", "file": "NATM3.pt", "gender": "male", "group": "NAT"},
    {"id": "VARF0", "file": "VARF0.pt", "gender": "female", "group": "VAR"},
    {"id": "VARF1", "file": "VARF1.pt", "gender": "female", "group": "VAR"},
    {"id": "VARF2", "file": "VARF2.pt", "gender": "female", "group": "VAR"},
    {"id": "VARF3", "file": "VARF3.pt", "gender": "female", "group": "VAR"},
    {"id": "VARF4", "file": "VARF4.pt", "gender": "female", "group": "VAR"},
    {"id": "VARM0", "file": "VARM0.pt", "gender": "male", "group": "VAR"},
    {"id": "VARM1", "file": "VARM1.pt", "gender": "male", "group": "VAR"},
    {"id": "VARM2", "file": "VARM2.pt", "gender": "male", "group": "VAR"},
    {"id": "VARM3", "file": "VARM3.pt", "gender": "male", "group": "VAR"},
    {"id": "VARM4", "file": "VARM4.pt", "gender": "male", "group": "VAR"},
]


def wrap_with_system_tags(text: str) -> str:
    cleaned = (text or "").strip()
    if not cleaned:
        return "<system> You enjoy having a good conversation. <system>"
    if cleaned.startswith("<system>") and cleaned.endswith("<system>"):
        return cleaned
    return f"<system> {cleaned} <system>"


def extract_agenda_questions(system_prompt: str) -> List[str]:
    matches = re.findall(r"\d+\)\s*([^0-9]+?)(?=\s+\d+\)|<\s*system\s*>|$)", system_prompt)
    cleaned = [m.strip() for m in matches if len(m.strip()) > 6]
    if cleaned:
        return cleaned
    return [
        "Thanks for joining today. Could you briefly walk me through your background and recent projects?",
        "How did you handle your toughest technical trade-off or production challenge in that project?",
        "Great context, thank you for sharing that today.",
    ]


class PersonaPlexRuntime:
    def __init__(self):
        self.mode = "uninitialized"
        self.device = "cuda" if (torch and torch.cuda.is_available()) else "cpu"
        self.cpu_offload = os.environ.get("PERSONAPLEX_CPU_OFFLOAD", "0") == "1"
        self.max_pinned_frames = int(os.environ.get("PERSONAPLEX_MAX_PINNED_FRAMES", "512"))
        self.mimi = None
        self.other_mimi = None
        self.lm_gen = None
        self.text_tokenizer = None
        self.voices_dir: Optional[Path] = None
        self.lock = asyncio.Lock()

    def load(self):
        logger.info(f"Inicializando PersonaPlex ({HF_REPO}) en {self.device.upper()}...")
        try:
            from huggingface_hub import hf_hub_download
            from moshi.models import loaders, LMGen
            import sentencepiece

            voices_tgz = Path(hf_hub_download(HF_REPO, "voices.tgz"))
            extracted = voices_tgz.parent / "voices"
            if not extracted.exists():
                with tarfile.open(voices_tgz, "r:gz") as tar:
                    tar.extractall(path=voices_tgz.parent)
            self.voices_dir = extracted

            mimi_weight = hf_hub_download(HF_REPO, loaders.MIMI_NAME)
            tokenizer_path = hf_hub_download(HF_REPO, loaders.TEXT_TOKENIZER_NAME)
            moshi_weight = hf_hub_download(HF_REPO, loaders.MOSHI_NAME)

            self.mimi = loaders.get_mimi(mimi_weight, self.device)
            self.other_mimi = loaders.get_mimi(mimi_weight, self.device)
            self.text_tokenizer = sentencepiece.SentencePieceProcessor(tokenizer_path)  # type: ignore

            lm = loaders.get_moshi_lm(
                moshi_weight,
                device=self.device,
                cpu_offload=self.cpu_offload,
            )
            self.lm_gen = LMGen(
                lm,
                audio_silence_frame_cnt=int(0.5 * self.mimi.frame_rate),
                sample_rate=self.mimi.sample_rate,
                device=self.device,
                frame_rate=self.mimi.frame_rate,
                save_voice_prompt_embeddings=True,
                prefill_system_prompt=True,
                pin_system_prompt=True,
                max_pinned_frames=self.max_pinned_frames,
            )
            self.mimi.streaming_forever(1)
            self.other_mimi.streaming_forever(1)
            self.lm_gen.streaming_forever(1)
            self.mode = "moshi"
            logger.info("PersonaPlex 7B cargado en modo full-duplex real.")
        except Exception as exc:
            self.mode = "simulation"
            logger.warning(
                f"Moshi/PersonaPlex 7B no disponible localmente ({exc}). "
                "Ejecutando en modo simulación full-duplex para desarrollo/pruebas."
            )

    def cleanup_vram(self):
        if torch and torch.cuda.is_available():
            torch.cuda.empty_cache()

    def health(self) -> dict:
        gpu_name = None
        vram_gb = None
        if torch and torch.cuda.is_available():
            gpu_name = torch.cuda.get_device_name(0)
            props = torch.cuda.get_device_properties(0)
            vram_gb = round(props.total_memory / (1024 ** 3), 1)
        return {
            "status": "ok",
            "service": "personaplex",
            "mode": self.mode,
            "model": HF_REPO,
            "device": self.device,
            "cpu_offload": self.cpu_offload,
            "gpu_name": gpu_name,
            "vram_gb": vram_gb,
            "sample_rate": SAMPLE_RATE,
            "pin_system_prompt": True,
            "max_pinned_frames": self.max_pinned_frames,
            "audio_formats": ["pcm16", "opus"],
            "voices": OFFICIAL_VOICES,
        }


runtime = PersonaPlexRuntime()
app = FastAPI(title="ViBeTranslate PersonaPlex Service", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def on_startup():
    runtime.load()


@app.get("/health")
async def get_health():
    return runtime.health()


@app.get("/voices")
async def get_voices():
    custom = [
        {"id": p.stem, "file": p.name, "gender": "custom", "group": "CUSTOM"}
        for p in VOICES_DIR.glob("*.wav")
    ]
    return {"voices": OFFICIAL_VOICES + custom}


async def stream_simulated_utterance(ws: WebSocket, sentence: str):
    words = sentence.strip().split(" ")
    for i, word in enumerate(words):
        prefix = " " if i > 0 else ""
        await ws.send_bytes(bytes([MSG_TEXT]) + f"{prefix}{word}".encode("utf-8"))
        # 80 ms de tono suave a 24 kHz para validar pipeline de audio full-duplex
        t = np.linspace(0, 0.08, FRAME_SAMPLES, endpoint=False)
        env = np.hanning(FRAME_SAMPLES) * 0.08
        pcm = (np.sin(2 * np.pi * 210.0 * t) * env * 32767).astype(np.int16)
        await ws.send_bytes(bytes([MSG_AUDIO]) + pcm.tobytes())
        await asyncio.sleep(0.05)


@app.websocket("/api/chat")
async def websocket_chat(
    ws: WebSocket,
    voice_prompt: str = Query("NATF2.pt"),
    text_prompt: str = Query(""),
    audio_format: str = Query("pcm16"),
    seed: Optional[int] = Query(None),
):
    await ws.accept()
    wrapped_prompt = wrap_with_system_tags(text_prompt)
    logger.info(f"Sesión iniciada: voice={voice_prompt}, fmt={audio_format}, mode={runtime.mode}")

    async with runtime.lock:
        try:
            if runtime.mode == "moshi" and runtime.mimi and runtime.lm_gen and runtime.text_tokenizer:
                await _run_moshi_session(ws, voice_prompt, wrapped_prompt, audio_format)
            else:
                await _run_simulation_session(ws, wrapped_prompt)
        except WebSocketDisconnect:
            logger.info("Cliente desconectado de PersonaPlex.")
        except Exception as exc:
            logger.error(f"Error en sesión PersonaPlex: {exc}")
            try:
                await ws.send_bytes(bytes([MSG_ERROR]) + str(exc).encode("utf-8"))
            except Exception:
                pass
        finally:
            runtime.cleanup_vram()


async def _run_simulation_session(ws: WebSocket, wrapped_prompt: str):
    questions = extract_agenda_questions(wrapped_prompt)
    turn_idx = 0
    await ws.send_bytes(bytes([MSG_HANDSHAKE, 0, 0]))
    await ws.send_bytes(
        bytes([MSG_METADATA]) + json.dumps({"mode": "simulation", "sample_rate": SAMPLE_RATE}).encode("utf-8")
    )

    # Saludo / primera pregunta inmediata
    await stream_simulated_utterance(ws, questions[turn_idx])
    turn_idx += 1

    voiced_frames = 0
    silence_frames = 0
    while True:
        msg = await ws.receive()
        if msg.get("type") == "websocket.disconnect":
            break
        raw = msg.get("bytes")
        if not raw:
            continue
        kind = raw[0]
        body = raw[1:]
        if kind == MSG_PING:
            await ws.send_bytes(bytes([MSG_PING]))
        elif kind == MSG_CONTROL and len(body) >= 1 and body[0] == 1:  # endTurn explícito
            if turn_idx < len(questions):
                await stream_simulated_utterance(ws, questions[turn_idx])
                turn_idx += 1
        elif kind == MSG_AUDIO and len(body) >= 4:
            samples = np.frombuffer(body[: len(body) - (len(body) % 2)], dtype=np.int16).astype(np.float32) / 32768.0
            rms = float(np.sqrt(np.mean(samples * samples))) if len(samples) > 0 else 0.0
            if rms > 0.012:
                voiced_frames += 1
                silence_frames = 0
            elif voiced_frames >= 6:
                silence_frames += 1
                if silence_frames >= 10 and turn_idx < len(questions):
                    voiced_frames = 0
                    silence_frames = 0
                    await stream_simulated_utterance(ws, questions[turn_idx])
                    turn_idx += 1


async def _run_moshi_session(ws: WebSocket, voice_prompt: str, wrapped_prompt: str, audio_format: str):
    assert runtime.mimi is not None
    assert runtime.other_mimi is not None
    assert runtime.lm_gen is not None
    assert runtime.text_tokenizer is not None

    use_opus = audio_format.lower() == "opus"
    opus_reader = None
    opus_writer = None
    if use_opus:
        import sphn
        opus_reader = sphn.OpusStreamReader(SAMPLE_RATE)
        opus_writer = sphn.OpusStreamWriter(SAMPLE_RATE)

    vp_dir = runtime.voices_dir or VOICES_DIR
    vp_path = vp_dir / voice_prompt
    if vp_path.exists():
        if str(vp_path).endswith(".pt"):
            runtime.lm_gen.load_voice_prompt_embeddings(str(vp_path))
        else:
            runtime.lm_gen.load_voice_prompt(str(vp_path))

    runtime.lm_gen.text_prompt_tokens = runtime.text_tokenizer.encode(wrapped_prompt)
    runtime.mimi.reset_streaming()
    runtime.other_mimi.reset_streaming()
    runtime.lm_gen.reset_streaming()
    await runtime.lm_gen.step_system_prompts_async(runtime.mimi)
    runtime.mimi.reset_streaming()

    await ws.send_bytes(bytes([MSG_HANDSHAKE, 0, 0]))

    pcm_buffer = np.zeros(0, dtype=np.float32)
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
        if kind != MSG_AUDIO or len(payload) == 0:
            continue

        if use_opus and opus_reader is not None:
            opus_reader.append_bytes(payload)
            incoming = opus_reader.read_pcm()
        else:
            even = payload[: len(payload) - (len(payload) % 2)]
            incoming = np.frombuffer(even, dtype=np.int16).astype(np.float32) / 32768.0

        if incoming.shape[-1] == 0:
            continue
        pcm_buffer = np.concatenate((pcm_buffer, incoming))

        while pcm_buffer.shape[-1] >= FRAME_SAMPLES:
            chunk = pcm_buffer[:FRAME_SAMPLES]
            pcm_buffer = pcm_buffer[FRAME_SAMPLES:]
            tensor = torch.from_numpy(chunk).to(device=runtime.device)[None, None]
            codes = runtime.mimi.encode(tensor)
            _ = runtime.other_mimi.encode(tensor)

            for c in range(codes.shape[-1]):
                tokens = runtime.lm_gen.step(codes[:, :, c : c + 1])
                if tokens is None:
                    continue
                main_pcm = runtime.mimi.decode(tokens[:, 1:9]).cpu()[0, 0].numpy()
                _ = runtime.other_mimi.decode(tokens[:, 1:9])

                if use_opus and opus_writer is not None:
                    opus_writer.append_pcm(main_pcm)
                    encoded = opus_writer.read_bytes()
                    if len(encoded) > 0:
                        await ws.send_bytes(bytes([MSG_AUDIO]) + encoded)
                else:
                    pcm16 = np.clip(main_pcm * 32767.0, -32768, 32767).astype(np.int16).tobytes()
                    await ws.send_bytes(bytes([MSG_AUDIO]) + pcm16)

                text_token = int(tokens[0, 0, 0].item())
                if text_token not in (0, 3):
                    piece = runtime.text_tokenizer.id_to_piece(text_token).replace("▁", " ")
                    await ws.send_bytes(bytes([MSG_TEXT]) + piece.encode("utf-8"))


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PERSONAPLEX_PORT", "8998"))
    host = os.environ.get("PERSONAPLEX_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port)
