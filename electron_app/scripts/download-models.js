/**
 * download-models.js - Descarga los modelos del motor local a electron_app/.models (para pruebas)
 */

const path = require('path');
const { createModelStore } = require('../local-ai/model-store');

const dir = process.env.VIBE_MODELS_DIR || path.join(__dirname, '..', '.models');
const store = createModelStore({ dir });

(async () => {
  const before = store.status();
  if (before.ready) {
    console.log(`Modelos listos en ${dir}`);
    return;
  }
  console.log(`Descargando ${(before.missingBytes / 1e6).toFixed(0)} MB a ${dir}...`);
  let lastPct = -1;
  await store.ensure((p) => {
    const pct = Math.floor((p.overallLoaded / p.overallTotal) * 100);
    if (pct !== lastPct && pct % 5 === 0) {
      lastPct = pct;
      console.log(`  ${pct}% (${p.file})`);
    }
  });
  console.log('Modelos descargados y verificados.');
})().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
