/**
 * haru-protocol.js - Tarjetas de Personaje Multilingües y Protocolo Haru-4B
 * =========================================================================
 * Integración inspirada en `higurashi-ai/Haru` (Apache 2.0, Qwen3.5-4B + VibeVoice + MeanFlow):
 *
 * ¿POR QUÉ INTEGRAMOS HARU-4B Y CUÁL ES SU ROL EXACTO EN VIBETRANSLATE?
 * 1. Eficiencia de hardware y soporte Mac:
 *    Haru-4B requiere ~12 GB de VRAM en NVIDIA (casi la mitad que un 7B) y cuenta con
 *    implementación nativa `haru_mlx` en Metal para Mac con Apple Silicon, operando a
 *    7.5 Hz (bloques de 133.3 ms = 3200 muestras a 24 kHz) con cabezal MeanFlow de 1 paso.
 * 2. Multilingüe nativo (9 idiomas, incluidos Español e Inglés) + Clonación Zero-Shot:
 *    Permite practicar llamadas fluidas con *backchanneling* natural (asentimientos,
 *    interrupciones suaves) tanto en inglés como en español y clonar cualquier voz de
 *    referencia de 3 s a 3 min sin entrenamiento previo.
 * 3. Por qué NO se usa para traducción literal ni para calificar la rúbrica final:
 *    Haru-4B es un *pretrained base model* (modelo base conversacional), no un asistente
 *    ajustado por instrucciones estrictas. Por eso en ViBeTranslate lo dedicamos a la
 *    conversación hablada natural (usando sus "Character Cards" oficiales), mientras que
 *    la traducción fiel y la evaluación estructurada turno por turno siguen a cargo de los
 *    modelos instruccionales en la nube o locales especializados.
 * 4. Por qué comparte codificador binario y usa el puerto 8999 por defecto:
 *    Al igual que PersonaPlex, el servidor WebSocket `/api/chat` de Haru deriva del formato
 *    binario de 1 byte de Moshi (`0x00` handshake, `0x01` audio, `0x02` texto UTF-8, `0x06` ping).
 *    Asignamos por defecto el puerto `8999` a `haru_service` para que pueda ejecutarse en
 *    paralelo con `personaplex_service` (`8998`) sin conflicto de puertos.
 */

const {
  MSG_HANDSHAKE,
  MSG_AUDIO,
  MSG_TEXT,
  MSG_PING,
  encodeHandshake,
  encodeAudioFrame,
  encodeTextToken,
  encodePing,
  decodeMessage
} = require('./personaplex-protocol');

const HARU_SAMPLE_RATE = 24000;
const HARU_FRAME_HZ = 7.5;
const HARU_FRAME_SAMPLES = 3200; // 24000 / 7.5 = 3200 muestras (133.33 ms por paso full-duplex)
const HARU_DEFAULT_PORT = 8999;

const CARD_FIELDS = [
  'persona',
  'name',
  'gender',
  'backchannel',
  'other_name',
  'relationship',
  'situation'
];

// Plantillas oficiales de `haru/assets/card_templates.json` para que el modelo base
// reconozca exactamente los encabezados con los que fue preentrenado en cada idioma.
const HARU_CARD_TEMPLATES = {
  en: {
    lead: 'You are the person described below, talking with the other person by voice.',
    headers: {
      persona: '[Your Persona]',
      name: '[Your Name]',
      gender: '[Your Gender]',
      backchannel: '[Your Backchannels]',
      other_name: "[The Other Person's Name]",
      relationship: '[Relationship]',
      situation: '[Situation]'
    },
    gender: { female: 'female', male: 'male' },
    backchannel: { low: 'sparse', mid: 'moderate', high: 'frequent' }
  },
  es: {
    lead: 'Eres la persona descrita a continuación y conversas de viva voz con la otra persona.',
    headers: {
      persona: '[Tu perfil]',
      name: '[Tu nombre]',
      gender: '[Tu género]',
      backchannel: '[Tus respuestas breves]',
      other_name: '[Nombre de la otra persona]',
      relationship: '[Relación]',
      situation: '[Situación]'
    },
    gender: { female: 'mujer', male: 'hombre' },
    backchannel: { low: 'pocas', mid: 'moderadas', high: 'muchas' }
  },
  pt: {
    lead: 'Você é a pessoa descrita abaixo e conversa por voz com a outra pessoa.',
    headers: {
      persona: '[Seu perfil]',
      name: '[Seu nome]',
      gender: '[Seu gênero]',
      backchannel: '[Suas respostas curtas]',
      other_name: '[Nome da outra pessoa]',
      relationship: '[Relação]',
      situation: '[Situação]'
    },
    gender: { female: 'mulher', male: 'homem' },
    backchannel: { low: 'poucas', mid: 'moderadas', high: 'muitas' }
  },
  fr: {
    lead: "Vous êtes la personne décrite ci-dessous et vous parlez de vive voix avec l'autre personne.",
    headers: {
      persona: '[Votre profil]',
      name: '[Votre nom]',
      gender: '[Votre genre]',
      backchannel: "[Vos réactions d'écoute]",
      other_name: "[Nom de l'autre personne]",
      relationship: '[Relation]',
      situation: '[Situation]'
    },
    gender: { female: 'femme', male: 'homme' },
    backchannel: { low: 'peu', mid: 'modérées', high: 'fréquentes' }
  },
  de: {
    lead: 'Du bist die unten beschriebene Person und sprichst mit der anderen Person.',
    headers: {
      persona: '[Deine Persona]',
      name: '[Dein Name]',
      gender: '[Dein Geschlecht]',
      backchannel: '[Deine kurzen Rückmeldungen]',
      other_name: '[Name der anderen Person]',
      relationship: '[Beziehung]',
      situation: '[Situation]'
    },
    gender: { female: 'weiblich', male: 'männlich' },
    backchannel: { low: 'wenige', mid: 'mittel', high: 'häufig' }
  }
};

const HARU_LANGUAGES = [
  { code: 'en', label: 'English (Llamada internacional)' },
  { code: 'es', label: 'Español (Práctica fluida / bilingüe)' },
  { code: 'pt', label: 'Português' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' }
];

function inferGenderFromName(name = '') {
  const first = String(name || '').trim().split(/\s+/)[0].toLowerCase();
  const femaleHints = new Set([
    'sarah', 'emily', 'claire', 'hannah', 'elena', 'maria', 'maría', 'laura',
    'ana', 'sofia', 'sofía', 'rachel', 'jessica', 'haru', 'priya', 'maya', 'chloe'
  ]);
  if (femaleHints.has(first)) return 'female';
  if (first.endsWith('a') && first !== 'luca' && first !== 'joshua') return 'female';
  return 'male';
}

/**
 * Renderiza una Character Card idéntica a `haru.prompt.render_card` en Python.
 *
 * ¿Por qué usamos este formato exacto y no texto libre?:
 * Haru-4B fue entrenado con encabezados fijos (`[Your Persona]`, `[Situation]`, etc.)
 * envueltos en `<|im_start|>system\n...\n<|im_end|>`. Respetar la estructura exacta
 * estabiliza el timbre, la frecuencia de asentimientos (`backchannel`) y el rol.
 */
function renderHaruCard(card = {}, lang = 'en') {
  const cleanLang = String(lang || 'en').slice(0, 2).toLowerCase();
  const template = HARU_CARD_TEMPLATES[cleanLang] || HARU_CARD_TEMPLATES.en;
  const lines = [template.lead];

  for (const key of CARD_FIELDS) {
    let value = String(card[key] || '').trim();
    if (key === 'gender' || key === 'backchannel') {
      value = template[key][value] || '';
    }
    if (value) {
      lines.push(template.headers[key], value);
    }
  }

  return lines.join('\n');
}

module.exports = {
  HARU_SAMPLE_RATE,
  HARU_FRAME_HZ,
  HARU_FRAME_SAMPLES,
  HARU_DEFAULT_PORT,
  CARD_FIELDS,
  HARU_CARD_TEMPLATES,
  HARU_LANGUAGES,
  inferGenderFromName,
  renderHaruCard,
  MSG_HANDSHAKE,
  MSG_AUDIO,
  MSG_TEXT,
  MSG_PING,
  encodeHandshake,
  encodeAudioFrame,
  encodeTextToken,
  encodePing,
  decodeMessage
};
