/**
 * spm-lexicon.js - Palabras corrientes de inglés y español, sacadas del vocabulario del modelo de traducción
 *
 * El vocabulario SentencePiece de Firefox Translations (vocab.esen.spm, compartido por los dos sentidos) guarda como
 * pieza entera cada palabra frecuente de ambos idiomas. Sirve para distinguir una palabra de verdad («postres»,
 * «café») de una deformación del reconocedor («taimaud», «cafca»), sin descargar ninguna lista más.
 */

const fs = require('fs');

/** Lee un entero varint de protobuf; devuelve [valor, siguiente posición]. */
function varint(buf, pos) {
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = buf[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return [value, pos];
    shift += 7;
  }
}

/** Piezas del modelo: campo 1 (repetido) de ModelProto; dentro, el campo 1 es el texto de la pieza. */
function readPieces(buf) {
  const pieces = [];
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = varint(buf, pos);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 2) {
      let len;
      [len, pos] = varint(buf, pos);
      if (field === 1) {
        const end = pos + len;
        let p = pos;
        while (p < end) {
          let innerTag;
          [innerTag, p] = varint(buf, p);
          const innerWire = innerTag & 7;
          if (innerWire === 2) {
            let innerLen;
            [innerLen, p] = varint(buf, p);
            if (Math.floor(innerTag / 8) === 1) pieces.push(buf.toString('utf8', p, p + innerLen));
            p += innerLen;
          } else if (innerWire === 0) {
            [, p] = varint(buf, p);
          } else if (innerWire === 5) {
            p += 4;
          } else if (innerWire === 1) {
            p += 8;
          } else {
            break;
          }
        }
      }
      pos += len;
    } else if (wire === 0) {
      [, pos] = varint(buf, pos);
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
    } else {
      throw new Error(`Vocabulario no válido: tipo de campo ${wire}`);
    }
  }
  return pieces;
}

/** Palabras completas del vocabulario (en minúsculas), o null si el archivo no existe. */
function loadLexicon(file) {
  if (!file || !fs.existsSync(file)) return null;
  const words = new Set();
  for (const piece of readPieces(fs.readFileSync(file))) {
    if (!piece.startsWith('▁')) continue; // solo las piezas que empiezan palabra
    const word = piece.slice(1).toLowerCase();
    if (word.length >= 2 && /^[\p{L}']+$/u.test(word)) {
      words.add(word);
      words.add(word.normalize('NFD').replace(/\p{M}/gu, '')); // también sin tildes: «estan» = «están»
    }
  }
  return words;
}

module.exports = { loadLexicon, readPieces };
