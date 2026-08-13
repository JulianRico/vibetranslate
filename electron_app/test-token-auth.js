/**
 * test-token-auth.js - Script exhaustivo de prueba de token contra APIs de Google
 */

const https = require('https');
const WebSocket = require('ws');

const TOKEN = 'AIzaSyDummyKeyReplaceWithYourOwn00000000';

function makeRequest(url, headers = {}) {
  return new Promise((resolve) => {
    console.log(`\n==================================================`);
    console.log(`🔍 Probando: ${url}`);
    console.log(`📋 Headers: ${JSON.stringify(headers)}`);

    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`📊 Status Code: ${res.statusCode} ${res.statusMessage}`);
        try {
          const json = JSON.parse(data);
          console.log(`📦 Response Body:\n${JSON.stringify(json, null, 2)}`);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          console.log(`📦 Response Raw: ${data.substring(0, 300)}`);
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', (err) => {
      console.log(`🔴 Error en request: ${err.message}`);
      resolve({ error: err.message });
    });
  });
}

function testWebSocket(wsUrl, headers = {}) {
  return new Promise((resolve) => {
    console.log(`\n==================================================`);
    console.log(`🌐 Probando WebSocket: ${wsUrl}`);
    console.log(`📋 Headers: ${JSON.stringify(headers)}`);

    const ws = new WebSocket(wsUrl, { headers });

    const timeout = setTimeout(() => {
      console.log('⏱️ WebSocket timeout (5s)');
      ws.terminate();
      resolve({ status: 'timeout' });
    }, 5000);

    ws.on('open', () => {
      clearTimeout(timeout);
      console.log('🟢 ¡WebSocket CONECTADO EXITOSAMENTE!');
      ws.close();
      resolve({ status: 'open' });
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      console.log(`🔴 WebSocket Error: ${err.message}`);
      resolve({ status: 'error', error: err.message });
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      const reasonStr = reason ? reason.toString('utf-8') : '';
      console.log(`⚪ WebSocket Closed: Code ${code} - Razón: ${reasonStr}`);
      resolve({ status: 'closed', code, reason: reasonStr });
    });
  });
}

async function runAllTests() {
  console.log(`🚀 INICIANDO BATERÍA DE PRUEBAS PARA EL TOKEN: ${TOKEN.substring(0, 15)}...`);

  // 1. Verificar naturaleza del token con el endpoint oficial de tokeninfo de Google
  await makeRequest(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(TOKEN)}`);
  await makeRequest(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(TOKEN)}`);

  // 2. Probar Gemini API REST como API Key en URL
  await makeRequest(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(TOKEN)}`);

  // 3. Probar Gemini API REST con Bearer Token
  await makeRequest(`https://generativelanguage.googleapis.com/v1beta/models`, {
    'Authorization': `Bearer ${TOKEN}`
  });

  // 4. Probar Gemini API REST con access_token en query
  await makeRequest(`https://generativelanguage.googleapis.com/v1beta/models?access_token=${encodeURIComponent(TOKEN)}`);

  // 5. Probar WebSockets Gemini Live con query key
  await testWebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(TOKEN)}`);

  // 6. Probar WebSockets Gemini Live con access_token query
  await testWebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?access_token=${encodeURIComponent(TOKEN)}`);

  // 7. Probar WebSockets Gemini Live con Bearer Header
  await testWebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent`, {
    'Authorization': `Bearer ${TOKEN}`
  });

  console.log('\n🏁 TODAS LAS PRUEBAS COMPLETADAS.');
}

runAllTests();
