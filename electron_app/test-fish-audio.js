const https = require('https');

const API_KEY = '00000000000000000000000000000000';

async function testFishAudio() {
  console.log('--- Probando Fish Audio API ---');

  // 1. Probar GET /model
  console.log('\n1. Consultando modelos disponibles / propios...');
  try {
    const res = await fetch('https://api.fish.audio/model?page_size=10&page_number=1', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`
      }
    });
    console.log('Status GET /model:', res.status);
    if (res.ok) {
      const data = await res.json();
      console.log('Total modelos devueltos:', data.total || (data.items ? data.items.length : 'N/A'));
      if (data.items && data.items.length > 0) {
        console.log('Primeros modelos:', data.items.slice(0, 3).map(m => ({ id: m._id, title: m.title, language: m.languages })));
      }
    } else {
      const err = await res.text();
      console.log('Error GET /model:', err);
    }
  } catch (e) {
    console.error('Excepción en GET /model:', e.message);
  }

  // 2. Probar POST /v1/tts
  console.log('\n2. Probando síntesis TTS en /v1/tts...');
  try {
    const ttsPayload = {
      text: 'Hello! I am speaking with the cloned voice model via Fish Audio integration.',
      reference_id: 'd8a1340984ee4b63ad1ffae27a6a4339',
      format: 'mp3',
      latency: 'balanced'
    };
    for (const modelName of ['s2.1-pro-free', 's2.1-pro', 's2-pro', 's1']) {
      console.log(`\nProbando modelo: ${modelName}...`);
      const ttsRes = await fetch('https://api.fish.audio/v1/tts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          'model': modelName
        },
        body: JSON.stringify(ttsPayload)
      });
      console.log(`Status (${modelName}):`, ttsRes.status, ttsRes.headers.get('content-type'));
      if (ttsRes.ok) {
        const arrayBuffer = await ttsRes.arrayBuffer();
        console.log(`✅ Audio TTS (${modelName}) recibido exitosamente! Tamaño:`, arrayBuffer.byteLength, 'bytes');
        break;
      } else {
        const err = await ttsRes.text();
        console.log(`Error (${modelName}):`, err);
      }
    }
  } catch (e) {
    console.error('Excepción en POST /v1/tts:', e.message);
  }

  // 3. Probar WebSocket Streaming
  console.log('\n3. Probando WebSocket Streaming en wss://api.fish.audio/v1/tts/live...');
  const WebSocket = require('ws');
  await new Promise((resolve) => {
    try {
      const ws = new WebSocket('wss://api.fish.audio/v1/tts/live', {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'model': 's2.1-pro-free'
        }
      });

      let receivedBytes = 0;

      ws.on('open', () => {
        console.log('✅ WebSocket Conectado!');
        // Enviar evento start
        const startMsg = {
          event: 'start',
          request: {
            text: '',
            format: 'mp3',
            latency: 'balanced'
          }
        };
        ws.send(JSON.stringify(startMsg));

        // Enviar evento text
        const textMsg = {
          event: 'text',
          text: 'This is a test of real-time streaming audio.'
        };
        ws.send(JSON.stringify(textMsg));

        // Enviar evento finish
        const finishMsg = {
          event: 'finish'
        };
        ws.send(JSON.stringify(finishMsg));
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary || Buffer.isBuffer(data)) {
          receivedBytes += data.length;
          console.log(`🎵 Chunk de audio recibido: ${data.length} bytes (Total: ${receivedBytes} bytes)`);
        } else {
          console.log('Mensaje de texto del servidor:', data.toString());
        }
      });

      ws.on('close', (code, reason) => {
        console.log(`🔌 WebSocket cerrado: code=${code}, reason=${reason.toString()}`);
        resolve();
      });

      ws.on('error', (err) => {
        console.error('❌ Error en WebSocket:', err.message);
        resolve();
      });

      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
        resolve();
      }, 6000);
    } catch (err) {
      console.error('Excepción WebSocket:', err.message);
      resolve();
    }
  });
}

testFishAudio();
