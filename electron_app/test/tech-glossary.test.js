const test = require('node:test');
const assert = require('node:assert/strict');
const { createTechGlossary, phoneticKey } = require('../local-ai/tech-glossary');
const { TECH_TERMS } = require('../local-ai/tech-terms');

// Palabras corrientes que conoce el traductor (en la app salen de su vocabulario y de una consulta de ida y vuelta)
const KNOWN = new Set(`el la los las un una de del al a en y o que con por para se lo le su es no sí si hace sobre todo
también llave pago pagos cada guardada restricción única usamos evitar duplicados segundo procesa revisando métricas vi
consumidores reiniciaban bucle lento postres postre hacía pasarse tiempo máximo disparaba rebalanceos constantes agregué
índice ajusté cero alertas número escribimos para cualquiera guardia supiera revisar primero pruebas reales café max
nos decimos así link grafo te mando correo comimos helado después tomé antes reunión abuela son mejores sprint termina
viernes todavía faltan tres historias ojo costos nube están disparando by the way she is on call this weekend take time out
stand up for minute we test containers in our teams are working outlook next year windows front door lock please close
siete años experiencia soy desarrollador what happens if two try process same key exact moment you stored an unique
constraint transaction alerts plus solid approach that's camello cruzó desierto real problem node nodo árbol peso cada
estaba silencio`.split(/\s+/).filter(Boolean).map((w) => w.normalize('NFD').replace(/\p{M}/gu, '')));

const glossary = (user) => createTechGlossary({
  user,
  isKnownWord: (w) => KNOWN.has(w),
  isWord: (w) => KNOWN.has(w.toLowerCase().normalize('NFD').replace(/\p{M}/gu, ''))
});

test('la clave fonética iguala cómo suena un término y cómo lo escribe el reconocedor', () => {
  assert.equal(phoneticKey('Kafka'), phoneticKey('cafca'));
  assert.equal(phoneticKey('query'), phoneticKey('queri'));
  assert.equal(phoneticKey('timeout'), phoneticKey('time out'));
  assert.equal(phoneticKey('rumbook'), phoneticKey('rumbuk'));
  assert.equal(phoneticKey('IDEM potency'), phoneticKey('idempotency'));
  assert.equal(phoneticKey('Type Script'), phoneticKey('TypeScript'));
});

test('el diccionario no repite términos y todos tienen al menos una forma o se reconocen por su nombre', () => {
  const names = TECH_TERMS.map((t) => t.term);
  assert.equal(new Set(names).size, names.length, `repetidos: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
  assert.ok(TECH_TERMS.length >= 250, `${TECH_TERMS.length} términos`);
  for (const t of TECH_TERMS) assert.ok(t.forms.length > 0 || !t.common, t.term);
});

test('corrige lo que Canary escribió en la entrevista de prueba (español)', () => {
  const g = glossary();
  const cases = [
    ['Soy Andrés Desarrollador Baken con siete años de experiencia.', 'Soy Andrés Desarrollador backend con siete años de experiencia.'],
    ['sobre todo en No. J. S. y Type Script, y también con Postre S. Q. L.', 'sobre todo en Node.js y TypeScript, y también con PostgreSQL.'],
    ['usamos ident potencia. Cada pago llevaba una llave única guardada en postre sql con restricción única.', 'usamos idempotencia. Cada pago llevaba una llave única guardada en PostgreSQL con restricción única.'],
    ['la llave de hiden potencia', 'la llave de idempotencia'],
    ['sí hace Royvak, el segundo sí procesa el pago.', 'sí hace rollback, el segundo sí procesa el pago.'],
    ['Revisando Métricas y Lobs Vi que los consumidores se reiniciaban en bucle.', 'Revisando Métricas y logs Vi que los consumidores se reiniciaban en bucle.'],
    ['un cuirilento a postres los hacía pasarse del tiempo máximo', 'un query lento a postres los hacía pasarse del tiempo máximo'],
    ['agregué un índice, ajusté el taimaud, y', 'agregué un índice, ajusté el timeout, y'],
    ['Primero montamos alertas en gafanas sobre el número de rebalanceos.', 'Primero montamos alertas en Grafana sobre el número de rebalanceos.'],
    ['y escribimos un rumbook para que cualquiera de guardia supiera', 'y escribimos un runbook para que cualquiera de guardia supiera'],
    ['cafca, no café', 'Kafka, no café'],
    ['migrar todo a micro servicios de una vez', 'migrar todo a microservicios de una vez']
  ];
  for (const [heard, expected] of cases) assert.equal(g.correct(heard, 'es').text, expected, heard);
});

test('corrige lo que Canary escribió en la entrevista de prueba (inglés)', () => {
  const g = glossary();
  assert.equal(g.correct('So you stored an IDEM potency key with a unique constraint.', 'en').text, 'So you stored an idempotency key with a unique constraint.');
  assert.equal(g.correct('What happens in postgrow SQL if two consumers try', 'en').text, 'What happens in PostgreSQL if two consumers try');
  assert.equal(g.correct("That's a solid approach, alerts plus a run book,", 'en').text, "That's a solid approach, alerts plus a runbook,");
});

test('las palabras corrientes nunca se cambian: solo quedan como pista para la nube', () => {
  const g = glossary();
  for (const [text, lang] of [
    ['De postre comimos helado y después un café.', 'es'],
    ['Me tomé un café con Max antes de la reunión.', 'es'],
    ['Te mando el link por correo.', 'es'],
    ['El grafo de dependencias tiene ciclos.', 'es'],
    ['Es un problema real, cada nodo del árbol tiene su peso.', 'es'],
    ['El sprint termina el viernes y todavía faltan tres historias.', 'es'],
    ['Ojo con los costos de la nube, se están disparando.', 'es'],
    ['Perdón, estaba en silencio.', 'es'],
    ['By the way, she is on call this weekend.', 'en'],
    ['Let us take a time out and stand up for a minute.', 'en'],
    ['Our teams are working on the outlook for next year.', 'en'],
    ['Please close the windows and lock the front door.', 'en'],
    ['How did the client react?', 'en'],
    ['We test containers in our pipeline.', 'en']
  ]) {
    assert.equal(g.correct(text, lang).text, text, text);
  }
  const { hints } = g.correct('Para las pruebas usamos Postgres con postres y café reales. Sin Max en esa parte.', 'es');
  assert.deepEqual(hints.map((h) => [h.heard, h.term]), [['postres', 'PostgreSQL'], ['café', 'Kafka'], ['Max', 'mocks']]);
});

test('la grafía de los nombres propios se normaliza, la de las palabras comunes no', () => {
  const g = glossary();
  assert.equal(g.correct('lo subimos a sharepoint y a github', 'es').text, 'lo subimos a SharePoint y a GitHub');
  assert.equal(g.correct('usamos testcontainers', 'es').text, 'usamos Testcontainers');
  assert.equal(g.correct('We test containers in our pipeline.', 'en').text, 'We test containers in our pipeline.', 'en dos palabras corrientes, no');
});

test('el glosario del usuario manda: nombres propios y siglas de su equipo', () => {
  const g = glossary({ andrews: 'Andrés', andreas: 'Andrés', 'el proyecto fénix': 'el proyecto Phoenix' });
  assert.equal(g.correct('sorry, Andreas, thanks Andrews', 'en').text, 'sorry, Andrés, thanks Andrés');
  assert.equal(g.correct('hablemos de el proyecto fénix', 'es').text, 'hablemos de el proyecto Phoenix');
});

test('una palabra pegada se separa solo si la parte técnica es una forma registrada', () => {
  const g = glossary();
  assert.equal(g.correct('un cuirilento a postres', 'es').text, 'un query lento a postres');
  assert.equal(g.correct('en posgrecia', 'es').text, 'en posgrecia', 'sin forma exacta no se arriesga');
});

test('protege los términos que la traducción automática estropea y restaura el artículo', () => {
  const g = glossary();
  const p = g.protect('We need a feature flag before the deploy, instead of mocks.', 'en');
  assert.equal(p.count, 3);
  assert.equal(p.text, 'We need a X1Z before the X2Z, instead of X3Z.');
  // lo que devolvería el traductor: artículos al azar para los marcadores
  assert.equal(p.restore('Necesitamos una X1Z antes de la X2Z, en lugar de X3Z.', 'es'), 'Necesitamos un feature flag antes del deploy, en lugar de mocks.');
  const q = g.protect('Escribimos un runbook y los logs.', 'es');
  assert.equal(q.restore('We wrote an X1Z and the X2Z.', 'en'), 'We wrote a runbook and the logs.');
  assert.equal(q.restore('We wrote an X1Z.', 'en'), null, 'si el traductor pierde un marcador se traduce sin proteger');
});

test('los nombres propios y los términos comunes no se protegen: el traductor ya los respeta', () => {
  const g = glossary();
  const p = g.protect('Usamos SharePoint, Kafka y Teams.', 'es');
  assert.equal(p.count, 0);
  assert.equal(p.text, 'Usamos SharePoint, Kafka y Teams.');
});

test('concuerda los artículos del español con el género y el número del término', () => {
  const g = glossary();
  const p = g.protect('the query and the logs and a pull request', 'en');
  assert.equal(p.restore('el X1Z y la X2Z y una X3Z', 'es'), 'la query y los logs y un pull request');
});

test('sin lista de palabras (proceso principal) solo vale lo escrito igual que una forma: «a bit» no es Vite', () => {
  const exact = createTechGlossary({ fuzzy: false });
  assert.equal(exact.correct('the end of that came through a bit garbled', 'en').text, 'the end of that came through a bit garbled');
  assert.equal(exact.correct('She is on call this weekend.', 'en').text, 'She is on call this weekend.');
  assert.equal(exact.correct('vamos a subirlo a cherpoint con doker', 'es').text, 'vamos a subirlo a SharePoint con Docker');
  assert.equal(exact.correct('lo subimos a sharepoint', 'es').text, 'lo subimos a SharePoint');
});
