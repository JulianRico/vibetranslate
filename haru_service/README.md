# ViBeTranslate — Haru-4B Multilingual Full-Duplex Service (`haru_service`)

Microservicio opcional para conversar en **full-duplex continuo a `7.5 Hz` (`133.3 ms`)** usando [**`higurashi-ai/Haru-4B`**](https://github.com/higurashi-ai/haru) (licencia **Apache 2.0**).

## ¿Por qué existe junto a `personaplex_service`?

- **Menor huella de memoria y soporte Apple Silicon**: `Haru-4B` requiere **~12 GB de VRAM** en GPUs NVIDIA (con kernels Triton de `0.7 ms` por frame) y cuenta con backend nativo `haru_mlx` en Metal para Mac M-series.
- **9 idiomas nativos (incluidos Español e Inglés) + Clonación Zero-Shot**: Usa *Character Cards* multilingües y clips de referencia de `3 s` a `3 min`.
- **WSOLA (`wsola_compress`)**: Comprime el audio un `10 %–20 %` sin cambiar el tono cuando se acumula cola de red, evitando cortes bruscos.
- **Separación clara de responsabilidades**: Al ser un *pretrained base model* (no *instruct*), en ViBeTranslate se dedica a la fluidez oral y *roleplay* en vivo (puerto `8999`), mientras la traducción exacta y la evaluación final turno por turno permanecen en los modelos instruccionales.

## Inicio rápido

```powershell
cd haru_service
pip install -r requirements.txt
python server.py
```

El servicio escucha por defecto en `http://127.0.0.1:8999` (`/health`, `/api/config`, `ws://127.0.0.1:8999/api/chat`), pudiendo correr al mismo tiempo que `personaplex_service` (`8998`).
