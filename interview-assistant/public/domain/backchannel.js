// Words an interviewer says just to show they are listening. A turn made only of these is not a question.
const LISTENING_WORDS = new Set([
  'okay', 'ok', 'right', 'great', 'sure', 'yeah', 'yes', 'yep', 'uh', 'huh', 'mm', 'hmm', 'mhm', 'um', 'ah', 'oh', 'wow',
  'i', 'see', 'got', 'it', 'thanks', 'thank', 'you', 'cheers', 'alright', 'all', 'well',
  'interesting', 'good', 'perfect', 'nice', 'cool', 'awesome', 'wonderful', 'excellent', 'understood', 'fine', 'absolutely', 'exactly', 'indeed',
]);

/** True when the text is only listening noises ("Okay.", "Mm-hmm", "I see.", "Alright, great."). "Okay, why?" is not. */
export function isBackchannel(text) {
  const words = String(text ?? '').toLowerCase().match(/\p{L}+/gu) ?? [];
  return words.length > 0 && words.every((w) => LISTENING_WORDS.has(w));
}
