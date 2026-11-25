const WebSocket = require('ws');
const { loadEnv } = require('./env');

loadEnv();
const API_KEY = (process.env.GEMINI_API_KEY || '').trim();
if (!API_KEY) {
  console.error('❌ Falta GEMINI_API_KEY en el archivo .env');
  process.exit(1);
}

async function testNativeAudio(modelName, modalities) {
  return new Promise((resolve) => {
    console.log(`\n======================================================`);
    console.log(`🧪 Probando ${modelName} con modalidades: ${JSON.stringify(modalities)}`);

    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(API_KEY)}`;
    const ws = new WebSocket(wsUrl);

    let setupComplete = false;

    const timeout = setTimeout(() => {
      console.log('⏱️ Timeout (5s)');
      ws.terminate();
      resolve(false);
    }, 5000);

    ws.on('open', () => {
      console.log('🟢 1. WebSocket Conectado. Enviando Setup Handshake...');
      const setupMsg = {
        setup: {
          model: modelName,
          generationConfig: {
            responseModalities: modalities,
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: "Puck"
                }
              }
            }
          },
          systemInstruction: {
            parts: [
              {
                text: "You are a real-time translator from Spanish to English."
              }
            ]
          }
        }
      };

      ws.send(JSON.stringify(setupMsg));
    });

    ws.on('message', (data) => {
      const text = data.toString('utf-8');
      console.log(`📩 Respuesta del Servidor: ${text}`);
      try {
        const json = JSON.parse(text);
        if (json.setupComplete) {
          console.log('🎉🎉🎉 ¡¡¡HANDSHAKE COMPLETADO CON ÉXITO ABSOLUTO!!! 🎉🎉🎉');
          setupComplete = true;
          clearTimeout(timeout);
          ws.close();
          resolve(true);
        }
      } catch (e) {}
    });

    ws.on('error', (err) => {
      console.log(`🔴 Error: ${err.message}`);
    });

    ws.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString('utf-8') : '';
      console.log(`⚪ WebSocket Cerrado (${code}: ${reasonStr})`);
      if (!setupComplete) {
        clearTimeout(timeout);
        resolve(false);
      }
    });
  });
}

async function run() {
  const models = [
    'models/gemini-2.5-flash-native-audio-latest',
    'models/gemini-2.5-flash-native-audio-preview-12-2025',
    'models/gemini-2.5-flash-native-audio-preview-09-2025'
  ];

  for (const m of models) {
    const ok = await testNativeAudio(m, ["AUDIO"]);
    if (ok) {
      console.log(`\n🏆🏆🏆 ¡MODELO TOTALMENTE VERIFICADO Y OPERATIVO: ${m}! 🏆🏆🏆`);
      break;
    }
  }
}

run();
