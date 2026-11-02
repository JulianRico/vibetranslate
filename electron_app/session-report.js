/**
 * session-report.js - Informe de la sesión que se exporta: datos de la configuración, la conversación y el registro
 */

const MAX_LOG_LINES = 40;

function buildSessionReport({ now, engine, sourceLang, targetLang, hasVirtualCable, conversationSize, conversationText, logs = [] }) {
  return [
    'ViBeTranslate: informe de la sesión',
    '',
    `Fecha: ${now.toLocaleString()}`,
    `Motor: ${engine}`,
    `Idiomas: ${sourceLang} → ${targetLang}`,
    `Cable virtual: ${hasVirtualCable ? 'instalado' : 'no encontrado'}`,
    '',
    `--- Conversación (${conversationSize} frases) ---`,
    conversationSize > 0 ? conversationText : 'No se registró ninguna frase en esta sesión.',
    '',
    `--- Registro (últimos ${MAX_LOG_LINES} eventos) ---`,
    logs.length > 0 ? logs.slice(-MAX_LOG_LINES).join('\n') : 'Sin eventos.',
    ''
  ].join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildSessionReport };
}
