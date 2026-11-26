"""
=============================================================================
ViBeTranslate - NVIDIA PersonaPlex Full-Duplex Conversational Server
=============================================================================
Microservicio para `nvidia/personaplex-7b-v1` (Moshi + Helium + Mimi 24 kHz):

¿POR QUÉ Y CÓMO USA `HUGGINGFACE_API_KEY`?
1. Autenticación automática en modelos restringidos (`gated: auto`):
   `nvidia/personaplex-7b-v1` exige token de Hugging Face y haber aceptado la
   licencia de NVIDIA en `https://huggingface.co/nvidia/personaplex-7b-v1`.
   Este servicio carga `HUGGINGFACE_API_KEY` desde el entorno o `../electron_app/.env`
   y lo inyecta en `HF_TOKEN` para `huggingface_hub` y el Router de Inferencia.
2. Diagnóstico y enrutamiento hacia Hugging Face Inference Providers (`fal-ai/personaplex`):
   Cuando no hay GPU NVIDIA local, verifica en vivo:
   - Identidad del token (`whoami-v2`)
   - Autorización del repositorio *gated* (`nvidia/personaplex-7b-v1`)
   - Disponibilidad de `https://router.huggingface.co/fal-ai/fal-ai/personaplex`
   Si la cuenta dispone de créditos de Inference Providers (`HTTP 200`), enruta
   hacia la nube de Hugging Face; si devuelve `402` (sin créditos) o `403` (licencia
   pendiente de aceptar), informa el motivo exacto en `/health` y mantiene activo
   el modo simulación para no bloquear las pruebas de interfaz.
=============================================================================
"""

import asyncio
import base64
import json
import logging
import os
import re
import subprocess
import tarfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

import httpx
import numpy as np
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
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
ELECTRON_ENV_PATH = BASE_DIR.parent / "electron_app" / ".env"
VOICES_DIR = BASE_DIR / "voices"
VOICES_DIR.mkdir(exist_ok=True)

HF_REPO = os.environ.get("PERSONAPLEX_HF_REPO", "nvidia/personaplex-7b-v1")
HF_ROUTER_URL = "https://router.huggingface.co/fal-ai/fal-ai/personaplex"
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


def load_hf_token() -> str:
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


def probe_hf_router_ipv4(hf_token: str, payload: dict) -> tuple[int, str]:
    """Consulta `router.huggingface.co` usando httpx o fallback `curl.exe -4` si el DNS IPv6 local falla."""
    headers = {
        "Authorization": f"Bearer {hf_token}",
        "Content-Type": "application/json",
    }
    try:
        r = httpx.post(HF_ROUTER_URL, headers=headers, json=payload, timeout=8.0)
        return r.status_code, r.text
    except Exception:
        if os.name == "nt":
            proc = subprocess.run(
                [
                    "curl.exe",
                    "-4",
                    "-s",
                    "-w",
                    "\n__HTTP_CODE__:%{http_code}",
                    "-X",
                    "POST",
                    HF_ROUTER_URL,
                    "-H",
                    f"Authorization: Bearer {hf_token}",
                    "-H",
                    "Content-Type: application/json",
                    "-d",
                    json.dumps(payload),
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            out = proc.stdout or ""
            if "__HTTP_CODE__:" in out:
                body, code_str = out.rsplit("__HTTP_CODE__:", 1)
                return int(code_str.strip() or "0"), body.strip()
        return 0, "network_unreachable"


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
        self.hf_token = ""
        self.hf_user: Optional[str] = None
        self.hf_gated_authorized: Optional[bool] = None
        self.hf_router_status: str = "unconfigured"
        self.hf_note: str = ""
        self.mimi = None
        self.other_mimi = None
        self.lm_gen = None
        self.text_tokenizer = None
        self.voices_dir: Optional[Path] = None
        self.lock = asyncio.Lock()

    def inspect_hf_portal(self):
        self.hf_token = load_hf_token()
        if not self.hf_token:
            self.hf_router_status = "no_token"
            self.hf_note = "Configura HUGGINGFACE_API_KEY en .env para autenticar Hugging Face."
            return

        auth_headers = {"Authorization": f"Bearer {self.hf_token}"}
        try:
            who = httpx.get("https://huggingface.co/api/whoami-v2", headers=auth_headers, timeout=6.0)
            if who.status_code == 200:
                self.hf_user = who.json().get("name")
        except Exception as exc:
            logger.warning("Aviso verificando whoami en HF: %s", exc)

        try:
            gate = httpx.get(f"https://huggingface.co/{HF_REPO}/raw/main/README.md", headers=auth_headers, timeout=6.0)
            self.hf_gated_authorized = gate.status_code == 200
        except Exception:
            self.hf_gated_authorized = None

        code, body = probe_hf_router_ipv4(self.hf_token, {})
        if code in (200, 422):
            # 422 en payload vacío significa que el endpoint aceptó autenticación y crédito, y espera `audio_url`
            self.hf_router_status = "ready"
            self.hf_note = f"Proveedor HF Router (fal-ai/personaplex) activo para {self.hf_user or 'tu cuenta'}."
        elif code == 402:
            self.hf_router_status = "credits_required"
            self.hf_note = "Token HF válido, pero fal-ai/personaplex en HF Router requiere créditos prepago o suscripción HF PRO (HTTP 402)."
        elif code in (401, 403):
            self.hf_router_status = "permission_required"
            self.hf_note = f"Token HF requiere permiso Inference Providers o aceptar licencia en huggingface.co/{HF_REPO} (HTTP {code})."
        else:
            self.hf_router_status = f"http_{code}"
            self.hf_note = body[:180]

        logger.info(
            "HF Portal PersonaPlex | user=%s | gated_ok=%s | router=%s",
            self.hf_user,
            self.hf_gated_authorized,
            self.hf_router_status,
        )

    def load(self):
        self.inspect_hf_portal()

        # Solo intentar cargar pesos Moshi 7B en local si hay CUDA disponible (o si se fuerza explícitamente)
        if self.device == "cuda" or os.environ.get("PERSONAPLEX_FORCE_LOCAL", "0") == "1":
            logger.info(f"Inicializando PersonaPlex ({HF_REPO}) en {self.device.upper()}...")
            try:
                from huggingface_hub import hf_hub_download
                from moshi.models import loaders, LMGen
                import sentencepiece

                voices_tgz = Path(hf_hub_download(HF_REPO, "voices.tgz", token=self.hf_token or None))
                extracted = voices_tgz.parent / "voices"
                if not extracted.exists():
                    with tarfile.open(voices_tgz, "r:gz") as tar:
                        tar.extractall(path=voices_tgz.parent)
                self.voices_dir = extracted

                mimi_weight = hf_hub_download(HF_REPO, loaders.MIMI_NAME, token=self.hf_token or None)
                tokenizer_path = hf_hub_download(HF_REPO, loaders.TEXT_TOKENIZER_NAME, token=self.hf_token or None)
                moshi_weight = hf_hub_download(HF_REPO, loaders.MOSHI_NAME, token=self.hf_token or None)

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
                return
            except Exception as exc:
                logger.warning("No se pudo cargar Moshi 7B local: %s", exc)

        if self.hf_router_status == "ready":
            self.mode = "hf_router"
            self.device = "hf-fal-ai"
            logger.info("PersonaPlex conectado a Hugging Face Router (fal-ai/personaplex).")
        else:
            self.mode = "simulation"
            logger.warning(
                "PersonaPlex en modo simulación local (%s).",
                self.hf_note or "sin GPU CUDA local",
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
            "hf_authenticated": bool(self.hf_user or self.hf_token),
            "hf_user": self.hf_user,
            "hf_gated_authorized": self.hf_gated_authorized,
            "hf_router_status": self.hf_router_status,
            "hf_note": self.hf_note,
            "sample_rate": SAMPLE_RATE,
            "pin_system_prompt": True,
            "max_pinned_frames": self.max_pinned_frames,
            "audio_formats": ["pcm16", "opus"],
            "voices": OFFICIAL_VOICES,
        }


runtime = PersonaPlexRuntime()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    runtime.load()
    yield


app = FastAPI(title="ViBeTranslate PersonaPlex Service", version="1.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def get_health():
    return runtime.health()


@app.post("/test-hf")
async def test_hf_portal():
    runtime.inspect_hf_portal()
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
            elif runtime.mode == "hf_router":
                await _run_hf_router_session(ws, wrapped_prompt)
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


async def _run_hf_router_session(ws: WebSocket, wrapped_prompt: str):
    """Enruta turnos de audio hacia `router.huggingface.co/fal-ai/fal-ai/personaplex` cuando hay créditos HF activos."""
    await ws.send_bytes(bytes([MSG_HANDSHAKE, 0, 0]))
    await ws.send_bytes(
        bytes([MSG_METADATA]) + json.dumps({"mode": "hf_router", "sample_rate": SAMPLE_RATE}).encode("utf-8")
    )
    opening = extract_agenda_questions(wrapped_prompt)[0]
    await stream_simulated_utterance(ws, opening)

    audio_buf = bytearray()
    while True:
        msg = await ws.receive()
        if msg.get("type") == "websocket.disconnect":
            break
        raw = msg.get("bytes")
        if not raw:
            continue
        kind, body = raw[0], raw[1:]
        if kind == MSG_PING:
            await ws.send_bytes(bytes([MSG_PING]))
        elif kind == MSG_AUDIO:
            audio_buf.extend(body)
        elif kind == MSG_CONTROL and len(audio_buf) > 0:
            data_uri = "data:audio/wav;base64," + base64.b64encode(bytes(audio_buf)).decode("ascii")
            audio_buf = bytearray()
            code, resp_txt = probe_hf_router_ipv4(
                runtime.hf_token,
                {"prompt": wrapped_prompt, "audio_url": data_uri},
            )
            if code == 200:
                data = json.loads(resp_txt)
                reply_txt = data.get("text") or data.get("transcript") or "Understood, tell me more."
                await stream_simulated_utterance(ws, reply_txt)
            else:
                await stream_simulated_utterance(ws, extract_agenda_questions(wrapped_prompt)[1])


async def _run_simulation_session(ws: WebSocket, wrapped_prompt: str):
    questions = extract_agenda_questions(wrapped_prompt)
    turn_idx = 0
    await ws.send_bytes(bytes([MSG_HANDSHAKE, 0, 0]))
    await ws.send_bytes(
        bytes([MSG_METADATA]) + json.dumps({"mode": "simulation", "sample_rate": SAMPLE_RATE}).encode("utf-8")
    )

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
        elif kind == MSG_CONTROL and len(body) >= 1 and body[0] == 1:
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
