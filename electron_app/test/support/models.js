const path = require('node:path');
const { createModelStore } = require('../../local-ai/model-store');

const modelsDir = process.env.VIBE_MODELS_DIR || path.join(__dirname, '..', '..', '.models');
const store = createModelStore({ dir: modelsDir });
const modelsReady = store.status().ready;
const skipReason = modelsReady ? false : `faltan los modelos en ${modelsDir}: ejecuta "npm run models"`;

module.exports = { modelsDir, store, modelsReady, skipReason };
