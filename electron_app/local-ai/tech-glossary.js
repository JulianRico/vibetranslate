/**
 * tech-glossary.js - Términos técnicos: corrige los que el reconocedor de voz escribió mal, los protege en la
 * traducción local y prepara pistas para la traducción de la nube. No depende de Electron.
 *
 * El reconocedor escribe un término inglés dicho en español como lo oye («taimaud», «cuirilento», «Postre S. Q. L.»).
 * Se compara por sonido (una clave fonética) contra las formas de tech-terms.js. Las palabras de verdad nunca se
 * reemplazan («postres», «café», «link»): solo se avisan a la nube, que decide por el contexto. Quién es palabra de
 * verdad lo dice `isWord` (en el motor: el vocabulario del traductor y, en caso de duda, el propio traductor).
 */

const { TECH_TERMS } = require('./tech-terms');

const MAX_WINDOW = 6; // palabras: «a ese pe dot net core»
const MAX_FUZZY_WINDOW = 3;
const MIN_KEY = 3;

/** Clave fonética: cómo suena, escrita de una sola manera («Kafka», «cafca» → «kafka»; «query», «cueri» → «kueri»). */
function phoneticKey(text) {
  let s = String(text).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  s = s.replace(/[^a-z0-9]/g, '');
  s = s
    .replace(/ph/g, 'f').replace(/th/g, 't').replace(/sh/g, 'ch').replace(/ck/g, 'k')
    .replace(/qu/g, 'k').replace(/gu(?=[ei])/g, 'g').replace(/ll/g, 'y').replace(/rr/g, 'r')
    .replace(/ee/g, 'i').replace(/oo/g, 'u')
    .replace(/c(?=[eiy])/g, 's').replace(/c(?!h)/g, 'k').replace(/z/g, 's').replace(/x/g, 'ks')
    .replace(/v/g, 'b').replace(/w/g, 'u').replace(/q/g, 'k').replace(/j/g, 'y')
    .replace(/ch/g, '§').replace(/h/g, '').replace(/§/g, 'ch')
    .replace(/y(?=[^aeiou]|$)/g, 'i')
    .replace(/(.)\1+/g, '$1');
  if (s.length > 3) s = s.replace(/e$/, '');
  return s;
}

/** Distancia de edición, cortando en cuanto supera `max`. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

/** Errores admitidos según la longitud: una clave corta tiene que coincidir entera. */
const tolerance = (len) => (len >= 10 ? 2 : len >= 5 ? 1 : 0);

const normal = (s) => String(s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]/g, '');
// Igual que normal() pero conservando la separación entre palabras: «type script» no está ya bien escrito
const spelled = (s) => String(s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim();
/** ¿Solo cambia la flexión? («microservicio» / «microservicios», «debugged» / «debugger») */
function inflection(a, b) {
  const x = normal(a);
  const y = normal(b);
  const base = (w) => w.replace(/(ings?|ers?|ed|es|s)$/, '').replace(/[ao]$/, '').replace(/(.)\1$/, '$1');
  return x !== y && base(x) === base(y);
}

const TOKEN = /[\p{L}\p{N}]+(?:['’.\-+][\p{L}\p{N}]+)*[#+]*/gu;

// Una corrección aproximada de varias palabras no puede empezar ni acabar en una de estas («El sprint» no es «esprint»)
const ACCENTED = /[áéíóúü]/i;
const GLUE_PREFIXES = new Set(['en', 'el', 'la', 'de', 'al', 'y', 'a', 'in', 'on', 'the']);
const STOPWORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al', 'a', 'en', 'y', 'o', 'u', 'e', 'que', 'con',
  'por', 'para', 'se', 'lo', 'le', 'su', 'mi', 'tu', 'es', 'the', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'and',
  'or', 'is', 'it', 'we', 'you', 'i', 'he', 'she', 'they', 'my', 'your', 'our', 'that', 'this'
]);

function tokenize(text) {
  return [...String(text).matchAll(TOKEN)].map((m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
}

// Artículos del español por categoría, para concordar con el término restaurado («la deploy» → «el deploy»)
const ARTICLES = {
  def: { ms: 'el', fs: 'la', mp: 'los', fp: 'las' },
  ind: { ms: 'un', fs: 'una', mp: 'unos', fp: 'unas' },
  este: { ms: 'este', fs: 'esta', mp: 'estos', fp: 'estas' },
  ese: { ms: 'ese', fs: 'esa', mp: 'esos', fp: 'esas' }
};
const ARTICLE_OF = {};
for (const [kind, forms] of Object.entries(ARTICLES)) for (const form of Object.values(forms)) ARTICLE_OF[form] = kind;

/**
 * @param {object} options
 * @param {(word: string, lang: string) => boolean} [options.isWord] ¿Es una palabra de verdad? Puede ser lenta
 *   (consulta al traductor): solo se llama cuando hay una corrección candidata.
 * @param {(word: string) => boolean} [options.isKnownWord] Comprobación rápida (lista de palabras), para lo demás.
 * @param {boolean} [options.fuzzy] false: solo formas exactas (sin lista de palabras no se puede arriesgar más).
 */
function createTechGlossary({ terms = TECH_TERMS, user = {}, isWord = () => false, isKnownWord = () => false, fuzzy = true } = {}) {
  const entries = [];
  const exact = new Map(); // clave → formas
  const byFirst = new Map(); // primera letra → formas, para la búsqueda aproximada

  function addForm(entry, source, { fuzzy = true } = {}) {
    const key = phoneticKey(source);
    if (key.length < MIN_KEY) return;
    const words = tokenize(source).length;
    const form = { key, entry, words, fuzzy: fuzzy && !entry.user, accented: ACCENTED.test(source), letters: normal(source) };
    if (!exact.has(key)) exact.set(key, []);
    exact.get(key).push(form);
    if (form.fuzzy) {
      if (!byFirst.has(key[0])) byFirst.set(key[0], []);
      byFirst.get(key[0]).push(form);
    }
  }

  for (const t of terms) {
    const entry = {
      term: t.term,
      es: t.es || null,
      keep: t.keep !== false,
      common: !!t.common,
      gender: t.g === 'f' ? 'f' : 'm',
      plural: /^[a-z][a-z\s-]*s$/.test(t.term) && !/ss$/.test(t.term),
      maybe: new Set((t.maybe || []).map(normal))
    };
    entries.push(entry);
    // Un término que también es palabra corriente («Teams», «Windows») no se reconoce suelto: solo sus formas largas
    if (!entry.common || tokenize(t.term).length > 1) addForm(entry, t.term);
    if (t.es) addForm(entry, t.es);
    for (const f of t.forms) addForm(entry, f);
  }
  // Glosario del usuario: «cómo se oye» → «cómo se escribe», sin búsqueda aproximada (nombres, siglas propias)
  for (const [heard, correct] of Object.entries(user || {})) {
    if (!heard || !String(heard).trim() || !correct) continue;
    const entry = { term: String(correct), es: null, keep: true, common: false, gender: 'm', plural: false, maybe: new Set(), user: true };
    entries.push(entry);
    addForm(entry, heard);
  }
  const maybeWords = new Map(); // palabra corriente → término que podría ser
  for (const e of entries) for (const w of e.maybe) maybeWords.set(w, e);

  const targetOf = (entry, lang) => (lang === 'es' && entry.es ? entry.es : entry.term);

  /** Candidatos de corrección y pistas de una frase. */
  function scan(text, lang) {
    const tokens = tokenize(text);
    const candidates = [];
    const hints = [];
    const wordCache = new Map();
    const word = (w) => {
      const n = normal(w);
      if (!wordCache.has(n)) wordCache.set(n, maybeWords.has(n) || isKnownWord(n) || !!isWord(w, lang));
      return wordCache.get(n);
    };

    for (let i = 0; i < tokens.length; i++) {
      for (let n = 1; n <= MAX_WINDOW && i + n <= tokens.length; n++) {
        const span = text.slice(tokens[i].start, tokens[i + n - 1].end);
        const key = phoneticKey(span);
        if (key.length < MIN_KEY) continue;
        const found = [];
        for (const form of exact.get(key) || []) {
          // Sin lista de palabras no se sabe si «bit» es palabra o Vite («vite» suena «bit»): solo lo escrito igual
          if (!fuzzy && normal(span) !== form.letters && normal(span) !== normal(targetOf(form.entry, lang))) continue;
          found.push({ form, d: 0 });
        }
        if (fuzzy && n <= MAX_FUZZY_WINDOW && key.length >= 5) {
          const max = tolerance(key.length);
          for (const form of byFirst.get(key[0]) || []) {
            if (form.key === key || Math.abs(form.key.length - key.length) > max) continue;
            const d = editDistance(key, form.key, Math.min(max, tolerance(form.key.length)));
            if (d <= Math.min(max, tolerance(form.key.length))) found.push({ form, d });
          }
        }
        const window = tokens.slice(i, i + n);
        for (const { form, d } of found) {
          const target = targetOf(form.entry, lang);
          if (normal(span) === normal(target)) {
            if (spelled(span) === spelled(target)) {
              // Ya está bien escrito; solo se arregla la grafía de nombres propios («sharepoint» → «SharePoint»)
              // o la que pidió el usuario («pit» → «PIT»)
              const properName = !form.entry.common && normal(target).length >= 4 && /[A-Z0-9.#]/.test(target);
              if (span !== target && (properName || form.entry.user)) {
                candidates.push({ i, n, entry: form.entry, target, d: 0, user: !!form.entry.user, span });
              }
              continue;
            }
            // Mismas letras, otra separación («Type Script», «IDEM potency»): se corrige como una forma exacta
          }
          if (d > 0 && inflection(span, target)) continue;
          if (d > 0 && n > 1) {
            if (STOPWORDS.has(normal(window[0].text)) || STOPWORDS.has(normal(window[n - 1].text))) continue;
            if (window.some((t) => exact.has(phoneticKey(t.text)) && (exact.get(phoneticKey(t.text)) || []).some((f) => f.words === 1 && normal(t.text) === normal(f.entry.term)))) continue;
          }
          // Una tilde que la forma registrada no lleva es señal de palabra española («pitón» no es «piton» = Python)
          const realWords = window.map((t) => word(t.text) || (ACCENTED.test(t.text) && !form.accented && !form.entry.user));
          if (n === 1 && realWords[0]) {
            // Una palabra de verdad no se cambia; si es una forma registrada del término, la nube decidirá
            if (d === 0 && key.length >= 5) hints.push({ heard: span, term: target });
            continue;
          }
          if (realWords.every(Boolean)) {
            // Todo palabras de verdad («by the», «is on»): solo vale una forma registrada con esas mismas palabras
            if (d > 0 || form.words !== n) continue;
          }
          candidates.push({ i, n, entry: form.entry, target, d, user: !!form.entry.user, span });
        }
      }
      // Palabras corrientes que se confunden con un término («café» por Kafka): solo pista
      const lone = normal(tokens[i].text);
      if (maybeWords.has(lone)) hints.push({ heard: tokens[i].text, term: targetOf(maybeWords.get(lone), lang) });

      // Término pegado a una palabra («cuirilento» = query + lento; «engrafanas» = en + Grafana)
      const t = tokens[i];
      if (fuzzy && t.text.length >= 7 && !isKnownWord(normal(t.text))) {
        const split = splitGlued(t.text, lang);
        if (split && !word(t.text)) candidates.push({ i, n: 1, entry: split.entry, target: split.text, d: 1, user: false, span: t.text, glued: true });
      }
    }
    return { tokens, candidates, hints };
  }

  /** Separa un término pegado a una palabra corriente; la parte técnica tiene que ser una forma registrada exacta. */
  function splitGlued(token, lang) {
    for (let cut = 2; cut <= token.length - 2; cut++) {
      const head = token.slice(0, cut);
      const tail = token.slice(cut);
      for (const [termPart, wordPart, termFirst] of [[head, tail, true], [tail, head, false]]) {
        if (termPart.length < 4 || !isKnownWord(normal(wordPart))) continue;
        if (wordPart.length < 4 && !(termFirst === false && GLUE_PREFIXES.has(normal(wordPart)))) continue;
        const key = phoneticKey(termPart);
        const form = key.length >= 4 ? (exact.get(key) || []).find((f) => f.words === 1) : null;
        if (form) {
          const target = targetOf(form.entry, lang);
          return { entry: form.entry, text: termFirst ? `${target} ${wordPart}` : `${wordPart} ${target}` };
        }
      }
    }
    return null;
  }

  return {
    /**
     * Corrige los términos mal escritos de una frase.
     * @returns {{ text: string, fixes: Array<{from: string, to: string}>, hints: Array<{heard: string, term: string}> }}
     */
    correct(text, lang) {
      const { tokens, candidates, hints } = scan(text, lang);
      // Primero el glosario del usuario, luego lo exacto, lo que cubre más palabras y lo más parecido
      candidates.sort((a, b) => (b.user - a.user) || (a.d - b.d) || (b.n - a.n) || (b.target.length - a.target.length));
      const taken = new Array(tokens.length).fill(false);
      const chosen = [];
      for (const c of candidates) {
        if (taken.slice(c.i, c.i + c.n).some(Boolean)) continue;
        for (let k = c.i; k < c.i + c.n; k++) taken[k] = true;
        chosen.push(c);
      }
      chosen.sort((a, b) => a.i - b.i);
      let out = '';
      let at = 0;
      const fixes = [];
      for (const c of chosen) {
        const start = tokens[c.i].start;
        let end = tokens[c.i + c.n - 1].end;
        // Letras deletreadas («No. J. S. y…»): el punto de la última letra es de la abreviatura, no fin de frase
        if (c.n > 1 && tokens[c.i + c.n - 1].text.length === 1 && /^\.\s+\p{Ll}/u.test(text.slice(end))) end += 1;
        let replacement = c.target;
        // Al comienzo de frase se mantiene la mayúscula («Lobs…» → «Logs…»)
        const before = text.slice(0, start).trim();
        if ((before === '' || /[.!?¿¡]$/.test(before)) && /^\p{Lu}/u.test(c.span) && /^\p{Ll}/u.test(replacement)) {
          replacement = replacement[0].toUpperCase() + replacement.slice(1);
        }
        out += text.slice(at, start) + replacement;
        at = end;
        fixes.push({ from: text.slice(start, end), to: replacement });
      }
      out += text.slice(at);
      const fixedTerms = new Set(fixes.map((f) => normal(f.to)));
      const unique = [];
      const seen = new Set();
      for (const h of hints) {
        const k = normal(h.heard); // una pista por palabra oída
        if (seen.has(k) || fixedTerms.has(normal(h.heard))) continue;
        seen.add(k);
        unique.push(h);
      }
      return { text: out, fixes, hints: unique };
    },

    /** Solo las pistas para la nube (palabras corrientes que podrían ser un término). */
    hints(text, lang) {
      return this.correct(text, lang).hints;
    },

    /**
     * Sustituye por marcadores los términos que la traducción automática estropea («mocks» → «burlas»).
     * @returns {{ text: string, restore: (translated: string, targetLang: string) => string|null }}
     *   `restore` devuelve null si el traductor perdió algún marcador: entonces hay que traducir sin proteger.
     */
    protect(text) {
      const protectedTerms = [];
      const tokens = tokenize(text);
      let out = '';
      let at = 0;
      for (let i = 0; i < tokens.length; i++) {
        let match = null;
        for (let n = Math.min(MAX_WINDOW, tokens.length - i); n >= 1 && !match; n--) {
          const span = text.slice(tokens[i].start, tokens[i + n - 1].end);
          const forms = exact.get(phoneticKey(span)) || [];
          const form = forms.find((f) => f.entry.keep && !f.entry.common && normal(span) === normal(f.entry.term) &&
            (/^[a-z]/.test(f.entry.term) || tokenize(f.entry.term).length > 1));
          if (form) match = { n, entry: form.entry };
        }
        if (!match) continue;
        const marker = `X${protectedTerms.length + 1}Z`;
        out += text.slice(at, tokens[i].start) + marker;
        at = tokens[i + match.n - 1].end;
        protectedTerms.push({ marker, entry: match.entry });
        i += match.n - 1;
      }
      out += text.slice(at);
      return {
        text: out,
        count: protectedTerms.length,
        restore(translated, targetLang) {
          let result = translated;
          for (const { marker, entry } of protectedTerms) {
            const parts = result.split(marker);
            if (parts.length !== 2) return null; // perdido o duplicado
            result = parts[0] + entry.term + parts[1];
            result = agree(result, parts[0].length, entry, targetLang);
          }
          return /X\d+Z/.test(result) ? null : result;
        }
      };
    }
  };
}

/** Concuerda el artículo anterior al término restaurado en `position` («la deploy» → «el deploy», «an runbook» → «a runbook»). */
function agree(text, position, entry, lang) {
  const before = text.slice(0, position);
  const after = text.slice(position);
  if (lang === 'en') {
    return before.replace(/\b([Aa])n?\s+$/, (m, a) => `${a}${/^[aeio]/i.test(entry.term) ? 'n' : ''} `) + after;
  }
  if (lang !== 'es') return text;
  const want = `${entry.gender}${entry.plural ? 'p' : 's'}`;
  const fixed = before.replace(/(^|[\s¿¡(«"])(de|a)?(\s+)?(el|la|los|las|un|una|unos|unas|este|esta|estos|estas|ese|esa|esos|esas|del|al)\s+$/i, (m, lead, prep, gap, art) => {
    let preposition = prep ? prep.toLowerCase() : null;
    let article = art.toLowerCase();
    if (article === 'del') { preposition = 'de'; article = 'el'; }
    if (article === 'al') { preposition = 'a'; article = 'el'; }
    const kind = ARTICLE_OF[article];
    let word = ARTICLES[kind][want];
    if (preposition && word === 'el') word = preposition === 'de' ? 'del' : 'al';
    else if (preposition) word = `${preposition} ${word}`;
    const original = (prep ? prep : '') + (gap || '') + art;
    if (/^\p{Lu}/u.test(original)) word = word[0].toUpperCase() + word.slice(1);
    return `${lead}${word} `;
  });
  return fixed + after;
}

/**
 * ¿Es palabra de verdad? Con el traductor local: si la traduce a otra cosa y al volver sale la misma palabra
 * («postres» → «desserts» → «postres»). Una deformación se copia («taimaud») o se inventa algo que no vuelve
 * («rumbook» → «heading» → «rumbo»).
 */
function translatorWordCheck(translator) {
  const cache = new Map();
  return (word, lang) => {
    const w = String(word).toLowerCase();
    const cacheKey = `${lang}:${w}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    let real = false;
    try {
      const other = lang === 'es' ? 'en' : 'es';
      const [there] = translator.translateMany([w], lang, other);
      if (editDistance(phoneticKey(there), phoneticKey(w), 2) > 2) {
        const [back] = translator.translateMany([there], other, lang);
        real = normal(back) === normal(w);
      }
    } catch {
      real = true; // sin traductor no se arriesga a cambiar nada
    }
    if (cache.size > 2000) cache.clear();
    cache.set(cacheKey, real);
    return real;
  };
}

module.exports = { createTechGlossary, translatorWordCheck, phoneticKey, editDistance, tokenize };
