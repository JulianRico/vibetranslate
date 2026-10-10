/** Phrases to buy time during the interview: always available, no AI, no network. */
export const STALL_PHRASES = Object.freeze([
  { en: "Let me think about that for a second.", es: 'Déjame pensarlo un segundo.' },
  { en: "That's a good question. Let me structure my answer.", es: 'Buena pregunta. Déjame estructurar mi respuesta.' },
  { en: 'Could you repeat the question, please?', es: '¿Podría repetir la pregunta, por favor?' },
  { en: 'Could you clarify what you mean by…?', es: '¿Podría aclarar a qué se refiere con…?' },
  { en: 'Let me give you a concrete example.', es: 'Déjame darte un ejemplo concreto.' },
  { en: "I'm sorry, the line isn't very clear. Could you say that again?", es: 'Disculpa, la línea no se escucha bien. ¿Podrías repetirlo?' },
  { en: "Let me make sure I understand: you're asking about…", es: 'Déjame asegurarme de que entiendo: me preguntas sobre…' },
  { en: 'Would you like me to go deeper into that?', es: '¿Quieres que profundice en eso?' },
].map((phrase) => Object.freeze(phrase)));
