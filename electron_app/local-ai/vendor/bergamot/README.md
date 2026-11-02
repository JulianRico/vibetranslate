# Bergamot translator (WASM)

Motor de traducción de Marian NMT compilado a WebAssembly. Es el mismo que usan Firefox Translations
y el módulo `runonweb/translate` de [runonweb.ai](https://github.com/midudev/runonweb.ai).

- Archivos: `bergamot-translator-worker.js` y `bergamot-translator-worker.wasm`, sin modificar.
- Origen: paquete npm `@mkljczk/bergamot-translator@0.4.16` (carpeta `worker/`).
- Código fuente: https://codeberg.org/mkljczk/bergamot-translator (bifurcación de https://github.com/browsermt/bergamot-translator).
- Licencia: Mozilla Public License 2.0 (https://mozilla.org/MPL/2.0/).

Se copian aquí en vez de instalar el paquete porque este depende de `@oneidentity/zstd-js` (65 MB) y
`@types/node`, que la aplicación no usa.

SHA-256:

```
bc2fc98d859845162817f9526c39eb1ca4805f7149dfebc0fbcda4d2af68e13c  bergamot-translator-worker.js
735d4d95ede043c48f146b9a89336077f18885ad30b7e9a6a86c51a73ca02e7b  bergamot-translator-worker.wasm
```

Los modelos (Firefox Translations, MPL-2.0) no van aquí: `local-ai/model-store.js` los descarga de
Mozilla y verifica su suma la primera vez que se usa el motor local.
