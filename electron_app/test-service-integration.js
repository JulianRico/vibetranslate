const { FishAudioService } = require('./fish-audio-service');

async function testService() {
  console.log('=== Probando FishAudioService ===\n');

  const service = new FishAudioService({
    apiKey: process.env.FISH_API_KEY || '',
    model: 's2.1-pro-free'
  });

  // 1. Probar testConnection
  console.log('1. Validando conexión...');
  const conn = await service.testConnection();
  console.log('Resultado conexión:', conn);

  // 2. Probar listVoiceModels
  console.log('\n2. Obteniendo lista de modelos...');
  const models = await service.listVoiceModels({ pageSize: 5 });
  console.log(`Total modelos encontrados: ${models.total || models.items?.length || 0}`);
  if (models.items && models.items.length > 0) {
    console.log('Ejemplo de modelo:', {
      id: models.items[0]._id,
      title: models.items[0].title,
      languages: models.items[0].languages
    });
  }

  // 3. Probar synthesizeTTS
  console.log('\n3. Sintetizando texto de prueba...');
  const synth = await service.synthesizeTTS({
    text: 'Hello, this is ViBeTranslate simultaneous audio translation with Fish Audio.',
    model: 's2.1-pro-free',
    latency: 'balanced',
    format: 'mp3'
  });
  console.log('Resultado síntesis:', {
    success: synth.success,
    bytes: synth.audioBuffer.byteLength,
    model: synth.model,
    elapsedMs: synth.elapsedMs
  });

  console.log('\n=== Todas las pruebas de FishAudioService pasaron exitosamente! ===');
}

testService().catch(err => {
  console.error('Error en prueba:', err);
  process.exit(1);
});
