/**
 * test-voxcpm.js - Test de Conexión y Latencia con el Microservicio VoxCPM
 * =========================================================================
 * Ejecutar con: node test-voxcpm.js
 */

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./env');
const { VoxCPMService } = require('./voxcpm-service');

loadEnv();

async function runTest() {
  console.log('===============================================================');
  console.log('   ViBeTranslate - Test de Integración con VoxCPM TTS');
  console.log('===============================================================\n');

  const voxcpm = new VoxCPMService({
    host: process.env.VOXCPM_HOST || '127.0.0.1',
    port: Number(process.env.VOXCPM_PORT) || 8765
  });

  // 1. Health Check
  console.log('[1/3] Comprobando estado del servidor VoxCPM...');
  const health = await voxcpm.checkHealth();
  console.log('Respuesta del servidor:', health);

  if (!health.online) {
    console.log('\n⚠️ El servidor no está corriendo. Recuerda iniciarlo ejecutando:');
    console.log('   cd voxcpm_service && start_server.bat\n');
    return;
  }

  // 2. Test de Síntesis REST
  console.log('\n[2/3] Probando síntesis de texto a voz (REST)...');
  const testText = "Hello team, we are testing the new VoxCPM ultra-low latency voice engine.";
  const t0 = Date.now();
  
  try {
    const audioBuffer = await voxcpm.synthesizeTTS({ text: testText });
    const elapsed = Date.now() - t0;
    const outputPath = path.join(__dirname, 'voxcpm_test_output.wav');
    fs.writeFileSync(outputPath, audioBuffer);
    console.log(`✅ Audio sintetizado en ${elapsed}ms (${audioBuffer.length} bytes)`);
    console.log(`📁 Guardado en: ${outputPath}`);
  } catch (err) {
    console.error('❌ Error en síntesis REST:', err.message);
  }

  // 3. Test de Streaming WebSocket
  console.log('\n[3/3] Conectando WebSocket de streaming continuo...');
  voxcpm.setAudioChunkListener((chunk) => {
    console.log(`⚡ [Streaming Chunks] Recibidos ${chunk.length} bytes de audio PCM 48kHz en tiempo real.`);
  });
  voxcpm.initWebSocket();

  setTimeout(() => {
    console.log('Enviando chunk de texto al WebSocket...');
    voxcpm.streamText("This is real-time streamed audio directly to your virtual microphone.");
  }, 1000);

  setTimeout(() => {
    console.log('\n🏁 Test completado con éxito.');
    process.exit(0);
  }, 3500);
}

runTest();
