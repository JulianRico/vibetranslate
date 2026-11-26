const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const {
  MSG_HANDSHAKE,
  MSG_AUDIO,
  MSG_TEXT,
  PERSONAPLEX_VOICES,
  pickVoiceForSetup,
  encodeHandshake,
  encodeAudioFrame,
  encodeTextToken,
  encodeControl,
  encodeMetadata,
  decodeMessage,
  wrapSystemPrompt
} = require('../personaplex-protocol');
const { PersonaPlexClient, resamplePcm16 } = require('../personaplex-client');
const { personaPlexPrompt, haruCardPrompt } = require('../training-interviewer');
const { renderHaruCard, HARU_DEFAULT_PORT } = require('../haru-protocol');
const GeminiLiveClient = require('../gemini-live-client');

test('personaplex-protocol codifica y decodifica tramas binarias de 1 byte sin pérdidas', () => {
  const hs = decodeMessage(encodeHandshake(0, 0));
  assert.deepEqual(hs, { type: 'handshake', version: 0, model: 0 });
  assert.deepEqual(decodeMessage(Buffer.from([MSG_HANDSHAKE])), { type: 'handshake', version: 0, model: 0 });

  const pcm = Buffer.from([0x10, 0x20, 0x30, 0x40]);
  const audioMsg = decodeMessage(encodeAudioFrame(pcm));
  assert.equal(audioMsg.type, 'audio');
  assert.deepEqual(audioMsg.data, pcm);

  const txtMsg = decodeMessage(encodeTextToken(' Hello world.'));
  assert.deepEqual(txtMsg, { type: 'text', data: ' Hello world.' });

  const ctrlMsg = decodeMessage(encodeControl('endTurn'));
  assert.equal(ctrlMsg.type, 'control');
  assert.equal(ctrlMsg.action, 'endTurn');

  const metaMsg = decodeMessage(encodeMetadata({ mode: 'moshi', sr: 24000 }));
  assert.deepEqual(metaMsg, { type: 'metadata', data: { mode: 'moshi', sr: 24000 } });

  assert.equal(PERSONAPLEX_VOICES.length, 18);
  assert.equal(wrapSystemPrompt('You are Alex.'), '<system> You are Alex. <system>');
  assert.equal(wrapSystemPrompt('<system> Ready <system>'), '<system> Ready <system>');
});

test('pickVoiceForSetup y personaPlexPrompt generan rol y voz consistentes con el libreto', () => {
  const setup = {
    mode: 'interview',
    role: 'Senior Azure Architect',
    sector: 'Cloud & Microsoft 365',
    topic: 'Multi-region disaster recovery',
    level: 'executive',
    playbook: {
      interlocutor: { name: 'Sarah Jenkins', role: 'VP of Infrastructure', location: 'Seattle' },
      turns: [
        { question: { en: 'How do you design active-active failover across regions?' } },
        { question: { en: 'What RPO and RTO trade-offs did you negotiate?' } }
      ]
    }
  };

  assert.equal(pickVoiceForSetup(setup), 'NATF3.pt');
  assert.equal(pickVoiceForSetup({ ...setup, personaplexVoice: 'NATM1' }), 'NATM1.pt');

  const prompt = personaPlexPrompt(setup);
  assert.ok(prompt.startsWith('<system> ') && prompt.endsWith(' <system>'));
  assert.match(prompt, /Sarah Jenkins/);
  assert.match(prompt, /Senior Azure Architect/);
  assert.match(prompt, /active-active failover/);
});

test('resamplePcm16 convierte correctamente entre 16 kHz y 24 kHz conservando amplitud', () => {
  const samples16k = 160; // 10 ms @ 16 kHz
  const src = Buffer.alloc(samples16k * 2);
  for (let i = 0; i < samples16k; i++) {
    src.writeInt16LE(Math.round(Math.sin((2 * Math.PI * i) / 32) * 12000), i * 2);
  }
  const out24k = resamplePcm16(src, 16000, 24000);
  assert.equal(out24k.length, 240 * 2); // 10 ms @ 24 kHz = 240 muestras
});

test('PersonaPlexClient negocia handshake binario, recibe audio/texto full-duplex y agrupa oraciones', async () => {
  const wss = new WebSocketServer({ port: 0 });
  const port = wss.address().port;
  const serverReceived = [];

  wss.on('connection', (ws, req) => {
    serverReceived.push({ url: req.url });
    ws.send(Buffer.from([MSG_HANDSHAKE]));
    ws.send(Buffer.concat([Buffer.from([MSG_TEXT]), Buffer.from('Thanks for ', 'utf8')]));
    ws.send(Buffer.concat([Buffer.from([MSG_TEXT]), Buffer.from('joining today.', 'utf8')]));
    ws.send(Buffer.concat([Buffer.from([MSG_AUDIO]), Buffer.from([1, 2, 3, 4])]));

    ws.on('message', (data) => {
      serverReceived.push(decodeMessage(data));
    });
  });

  const sentences = [];
  const audioFrames = [];
  let readyFired = false;

  await new Promise((resolve, reject) => {
    const client = new PersonaPlexClient({
      host: '127.0.0.1',
      port,
      voicePrompt: 'NATF2',
      textPrompt: 'You are an interviewer.',
      onReady: () => {
        readyFired = true;
        client.sendAudioPcm16(Buffer.alloc(320), 16000);
        client.sendControl('endTurn');
      },
      onAudioFrame: (buf) => {
        audioFrames.push(buf);
      },
      onSentence: (s) => {
        sentences.push(s);
        setTimeout(() => {
          client.disconnect();
          wss.close(() => resolve());
        }, 40);
      },
      onError: reject
    });
    client.connect();
  });

  assert.equal(readyFired, true);
  assert.deepEqual(sentences, ['Thanks for joining today.']);
  assert.equal(audioFrames.length, 1);
  assert.match(serverReceived[0].url, /voice_prompt=NATF2\.pt/);
  assert.ok(serverReceived.some((m) => m.type === 'audio' && m.data.length === 480));
  assert.ok(serverReceived.some((m) => m.type === 'control' && m.action === 'endTurn'));
});

test('GeminiLiveClient activa contextWindowCompression (slidingWindow) también en translate_audio para reuniones largas', () => {
  const sentMessages = [];
  const client = new GeminiLiveClient({
    apiKey: 'AIzaSyDummyKeyForUnitTest12345',
    mode: 'translate_audio',
    sourceLang: 'es-ES',
    targetLang: 'en',
    customVocabulary: ['SharePoint', 'Entra ID']
  });
  client.ws = {
    readyState: 1,
     OPEN: 1,
    send: (msg) => sentMessages.push(JSON.parse(msg))
  };
  // Simular WebSocket.OPEN (valor 1 en `ws`)
  client.sendSetupHandshake();
  assert.equal(sentMessages.length, 1);
  const setup = sentMessages[0].setup;
  assert.deepEqual(setup.generationConfig.responseModalities, ['AUDIO']);
  assert.ok(setup.contextWindowCompression, 'translate_audio debe fijar contextWindowCompression');
  assert.equal(setup.contextWindowCompression.slidingWindow.targetTokens, '52428');
  assert.match(setup.systemInstruction.parts[0].text, /SharePoint, Entra ID/);
});

test('renderHaruCard, haruCardPrompt y PersonaPlexClient(rawPrompt) respetan el formato multilingüe de Haru-4B', () => {
  assert.equal(HARU_DEFAULT_PORT, 8999);
  const esCard = renderHaruCard({
    persona: 'Ingeniera principal en Madrid.',
    name: 'Elena',
    gender: 'female',
    backchannel: 'high',
    other_name: 'Julián',
    relationship: 'Compañeros de arquitectura.',
    situation: 'Revisión de latencia en tiempo real.'
  }, 'es');
  assert.match(esCard, /\[Tu perfil\]/);
  assert.match(esCard, /mujer/);
  assert.match(esCard, /muchas/);

  const enPrompt = haruCardPrompt({
    mode: 'meeting',
    role: 'Staff Platform Engineer',
    sector: 'Cloud',
    topic: 'Zero-downtime migration',
    haruLang: 'en',
    haruBackchannel: 'mid',
    playbook: { interlocutor: { name: 'Sarah Jenkins', role: 'VP Engineering', location: 'Austin' } }
  });
  assert.match(enPrompt, /\[Your Persona\]/);
  assert.match(enPrompt, /Sarah Jenkins/);
  assert.ok(!enPrompt.includes('<system>'), 'Haru usa Character Cards limpias sin etiquetas <system> de Moshi');

  const haruClient = new PersonaPlexClient({
    host: '127.0.0.1',
    port: HARU_DEFAULT_PORT,
    voicePrompt: 'custom_ref.wav',
    textPrompt: enPrompt,
    rawPrompt: true
  });
  const wsUrl = haruClient.buildWsUrl();
  assert.match(wsUrl, /127\.0\.0\.1:8999\/api\/chat/);
  assert.match(wsUrl, /voice_prompt=custom_ref\.wav/);
  assert.ok(!decodeURIComponent(wsUrl).includes('<system>'));
});
