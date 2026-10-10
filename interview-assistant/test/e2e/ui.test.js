import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../server.js';
import { UpstreamError } from '../../src/domain/errors.js';
import { createFakeLlm } from '../support/fakes.js';
import { makeDocx, para } from '../support/make-docx.js';
import { launch, findChrome } from '../support/cdp.js';

const GOOD = {
  questionEs: '¿Cuéntame de ti?', intent: 'introducción',
  points: [{ en: 'Full Stack Lead', es: 'Líder Full Stack' }],
  answer: { en: 'I lead teams building .NET and React products.', es: 'Lidero equipos que construyen productos .NET y React.' },
};

async function waitUntil(predicate, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for: ${predicate}`);
}

// Replaces speech and translator before any page script runs; `window.__fake` lets the test play the interviewer.
const FAKES = `(() => {
  let onPartial = () => {}; let onFinal = () => {};
  window.__fake = { started: 0, stopped: 0, partial: (t) => onPartial(t), final: (t) => onFinal(t) };
  window.__IA_OVERRIDES__ = {
    speech: {
      ensureReady: async () => {}, start() { window.__fake.started++; }, stop() { window.__fake.stopped++; },
      onPartial(cb) { onPartial = cb; }, onFinal(cb) { onFinal = cb; }, onState(cb) { cb({ status: 'idle' }); },
    },
    translator: { ensureReady: async () => {}, translate: async (t) => 'ES:' + t, onState(cb) { cb({ status: 'idle' }); } },
  };
  window.confirm = () => true;
})();`;

test('e2e: live session, suggestions, pause, documents and profile in a real Chrome', { skip: !findChrome(), timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-e2e-ui-'));
  const llm = createFakeLlm({ json: GOOD, text: 'Oferta: buscamos un Full Stack Lead con Azure.' });
  const server = buildApp({ env: {}, llm, dataDir: path.join(dir, 'data') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const b = await launch({ scriptOnNewDocument: FAKES });
  const space = () => b.eval("document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true })) && true");
  try {
    // --- the page loads without errors and starts idle
    await b.goto(base);
    await b.waitFor("document.querySelector('#btn-start')");
    assert.equal(await b.text('#btn-start'), 'Iniciar');
    assert.match(await b.text('#status-speech'), /sin iniciar/);
    assert.equal(await b.eval("document.querySelector('#btn-speak').disabled"), true);
    await b.waitFor("document.querySelector('#suggestion .warn')"); // no profile/documents yet
    assert.match(await b.text('#suggestion .warn'), /perfil ni documentos/);

    // --- stalling phrases are always there as compact chips (translation on hover), and leave room for the suggestion
    assert.equal(await b.count('.stall-phrase'), 8);
    assert.match(await b.text('.stall-phrase'), /^Let me think about that for a second\.$/);
    assert.equal(await b.eval("document.querySelector('.stall-phrase').title"), 'Déjame pensarlo un segundo.');
    assert.ok(await b.eval("document.querySelector('#stall-phrases').getBoundingClientRect().height") < 180, 'the strip stays compact');

    // --- start: the interviewer speaks, English and Spanish appear, then a suggestion
    await b.click('#btn-start');
    await b.waitFor("document.querySelector('#btn-start').textContent === 'Detener'");
    assert.equal(await b.eval('window.__fake.started'), 1);
    assert.equal(await b.eval("document.querySelector('#btn-speak').disabled"), false);
    await b.eval("window.__fake.partial('Tell me abo')");
    assert.equal(await b.text('#partial'), 'Tell me abo');
    await b.eval("window.__fake.final('What was the hardest bug you fixed last year.')");
    await b.waitFor("document.querySelector('.line .es')?.textContent === 'ES:What was the hardest bug you fixed last year.'");
    assert.equal(await b.text('.line .en'), 'What was the hardest bug you fixed last year.');
    assert.equal(await b.eval("document.querySelector('#partial').hidden"), true);
    await b.waitFor("document.querySelector('#suggestion .answer .en')", 6000);
    assert.equal(await b.text('#suggestion .answer .en'), GOOD.answer.en);
    assert.equal(await b.text('#suggestion .answer .es'), GOOD.answer.es);
    assert.match(await b.text('#suggestion .question'), /Cuéntame de ti/);
    assert.equal(llm.calls.generateJson.length, 1);
    assert.match(llm.calls.generateJson[0].prompt, /What was the hardest bug you fixed last year\./);
    await b.waitFor("document.querySelector('#metrics')?.textContent.includes('Sugerencia')");
    assert.match(await b.text('#metrics'), /^Traducción \d+ ms · Sugerencia \d+(,\d)? (ms|s)$/);

    // --- Space = "I'm speaking": nothing is kept; Space again resumes
    await space();
    await b.waitFor("document.querySelector('#btn-speak').classList.contains('speaking')");
    await b.eval("window.__fake.final('this is my own voice')");
    assert.equal(await b.count('.line'), 1);
    await space();
    await b.waitFor("!document.querySelector('#btn-speak').classList.contains('speaking')");
    await b.eval("window.__fake.final('What was your last release like?')");
    assert.equal(await b.count('.line'), 2);

    // --- documents: paste text, upload a text file and a DOCX; a fake PDF is rejected
    await b.click('#btn-context');
    await b.waitFor("!document.querySelector('#drawer').hidden");
    await b.fill('#paste-name', 'Oferta Acme');
    await b.fill('#paste-text', 'Buscamos un Full Stack Lead con Azure y liderazgo.');
    await b.eval("document.querySelector('#doc-kind').value = 'job'");
    await b.click('#paste-add');
    await b.waitFor("document.querySelectorAll('#doc-list .doc').length === 1");
    assert.match(await b.text('#doc-list .doc-name'), /Oferta Acme/);
    assert.match(await b.text('#usage'), /Contexto activo: 50 \/ 30\.000 caracteres/);

    const notes = path.join(dir, 'Mis notas.txt');
    fs.writeFileSync(notes, 'Mencionar liderazgo de equipos y migración a Azure.');
    await b.setFiles('#file-input', [notes]);
    await b.waitFor("document.querySelectorAll('#doc-list .doc').length === 2");

    const cv = path.join(dir, 'CV Julian.docx');
    fs.writeFileSync(cv, makeDocx(`${para('Julian Quintero')}${para('Full Stack Lead — 14 años liderando equipos')}`));
    await b.setFiles('#file-input', [cv]);
    await b.waitFor("document.querySelectorAll('#doc-list .doc').length === 3");
    assert.match(await b.eval("document.querySelector('#doc-list').textContent"), /DOCX/);

    const fake = path.join(dir, 'virus.pdf');
    fs.writeFileSync(fake, Buffer.from('MZ\x90\x00 definitely not a pdf'));
    await b.setFiles('#file-input', [fake]);
    await b.waitFor("!document.querySelector('#context-error').hidden");
    assert.match(await b.text('#context-error'), /no corresponde a un \.pdf/);
    assert.equal(await b.count('#doc-list .doc'), 3);

    // --- deactivate one document, then delete another
    const before = await b.text('#usage');
    await b.eval("document.querySelectorAll('.doc-active')[0].click()");
    await b.waitFor(`document.querySelector('#usage').textContent !== ${JSON.stringify(before)}`);
    await b.eval("document.querySelectorAll('.doc-delete')[2].click()");
    await b.waitFor("document.querySelectorAll('#doc-list .doc').length === 2");

    // --- profile
    await b.click('#tab-profile');
    await b.fill('#pf-name', 'Julian');
    await b.fill('#pf-headline', 'Full Stack Lead');
    await b.fill('#pf-skills', '.NET\nAzure\nReact');
    await b.click('#pf-add-role');
    await b.fill('.r-role', 'Development Lead');
    await b.fill('.r-company', 'Acme');
    await b.fill('.r-highlights', 'Led a team of 6\nMigrated to Azure');
    await b.click('#profile-save');
    await b.waitFor("document.querySelector('#pf-message').textContent === 'Guardado ✓'");
    const saved = await (await fetch(`${base}/api/profile`)).json();
    assert.equal(saved.name, 'Julian');
    assert.deepEqual(saved.skills, ['.NET', 'Azure', 'React']);
    assert.deepEqual(saved.experience[0].highlights, ['Led a team of 6', 'Migrated to Azure']);
    await b.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) && true");
    assert.equal(await b.eval("document.querySelector('#drawer').hidden"), true);

    // --- the next suggestion uses the profile and the active documents
    await waitUntil(() => llm.calls.generateJson.length >= 2); // the "Why do you want this role?" turn has been answered
    const callsBefore = llm.calls.generateJson.length;
    await b.eval("window.__fake.final('How would you build a payment gateway?')");
    await waitUntil(() => llm.calls.generateJson.length > callsBefore);
    const system = llm.calls.generateJson.at(-1).system;
    assert.match(system, /helping Julian/);
    assert.match(system, /Skills: \.NET, Azure, React/);
    assert.match(system, /Mencionar liderazgo de equipos y migración a Azure/, 'the active notes are included');
    assert.doesNotMatch(system, /Buscamos un Full Stack Lead/, 'the deactivated document is left out');
    assert.doesNotMatch(system, /14 años liderando/, 'the deleted document is gone');
    assert.equal(await b.eval("document.querySelector('#suggestion .warn')?.textContent.includes('perfil ni documentos') ?? false"), false);

    // --- a Gemini failure is shown with a Retry button that works
    llm.calls.generateJson.length = 0;
    const failing = createFakeLlm({ json: new UpstreamError('Gemini HTTP 503: busy') });
    llm.generateJson = failing.generateJson;
    await b.eval("window.__fake.final('How would you debug a memory leak in production?')");
    await b.waitFor("document.querySelector('#suggestion .error-text')", 6000);
    assert.match(await b.text('#suggestion .error-text'), /Gemini HTTP 503: busy/);
    assert.match(await b.text('#status-suggestions'), /error/);
    llm.generateJson = async (args) => { llm.calls.generateJson.push(args); return GOOD; };
    await b.click('#btn-retry');
    await b.waitFor("document.querySelector('#suggestion .answer .en')", 6000);

    // --- text from the interviewer or from a document is never interpreted as HTML (the CSP also blocks inline handlers)
    await b.eval(`window.__fake.final('<img src=x onerror="window.__pwned=1">Do you know <b>React</b>?')`);
    await b.waitFor("document.querySelectorAll('.line').length === 5");
    assert.equal(await b.count('.line img, .line b'), 0);
    assert.match(await b.eval("document.querySelector('.line:last-of-type .en').textContent"), /^<img src=x onerror=.*Do you know <b>React<\/b>\?$/);
    await b.fill('#paste-name', 'Notas <b>sueltas</b>');
    await b.fill('#paste-text', '<script>window.__pwned=2</script> <b>notas</b>');
    await b.click('#paste-add');
    await b.waitFor("document.querySelectorAll('#doc-list .doc').length === 3");
    assert.equal(await b.count('#doc-list b, #doc-list script'), 0);
    assert.match(await b.text('#doc-list .doc:last-child pre'), /^<script>window\.__pwned=2<\/script> <b>notas<\/b>$/);
    assert.equal(await b.eval('window.__pwned === undefined'), true);

    // --- Space while typing in a text field must not toggle "I'm speaking"
    await b.eval("document.querySelector('#paste-text').dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true })) && true");
    assert.equal(await b.eval("document.querySelector('#btn-speak').classList.contains('speaking')"), false);

    // --- a control used with the mouse must not keep the keyboard: Space still means "I'm speaking"
    assert.equal(
      await b.eval("(() => { const e = document.querySelector('#btn-context'); e.focus(); e.click(); return document.activeElement === e; })()"),
      false, 'a button gives up focus after a click',
    );
    await b.eval("document.querySelector('#drawer-close').click()");
    assert.equal(
      await b.eval("(() => { const e = document.querySelector('#provider'); e.focus(); e.dispatchEvent(new Event('change', { bubbles: true })); return document.activeElement === e; })()"),
      false, 'a select gives up focus after a change',
    );
    await b.eval("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true })) && true");
    await b.waitFor("document.querySelector('#btn-speak').classList.contains('speaking')");
    await space();
    await b.waitFor("!document.querySelector('#btn-speak').classList.contains('speaking')");

    // --- keyboard users: Space on a focused button activates that button (and is not stolen by the shortcut)
    await b.eval("document.querySelector('#btn-context').focus()");
    await b.eval("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true })) && true");
    assert.equal(await b.eval("document.querySelector('#btn-speak').classList.contains('speaking')"), false);
    await b.eval("document.activeElement.blur()");

    // --- prepared answers: the starter bank, editing by hand, generating with the AI, and the instant match during the interview
    await b.click('#tab-prepared');
    await b.waitFor("document.querySelectorAll('#prepared-list .prepared-item').length === 31");
    assert.match(await b.text('#prepared-summary'), /^31 respuestas siguen siendo plantillas sin revisar/);
    await b.eval(`(() => {
      const d = document.querySelector('[data-id="strengths"]');
      d.open = true;
      d.querySelector('.pr-en').value = 'My own strengths answer.';
      d.querySelector('.pr-es').value = 'Mi propia respuesta de fortalezas.';
      d.querySelector('.pr-save').click();
    })()`);
    await b.waitFor(`document.querySelector('[data-id="strengths"] .pr-status')?.textContent === 'editada'`);
    const generatedBefore = llm.calls.generateJson.length;
    await b.eval(`document.querySelector('[data-id="why-this-job"] .pr-generate').click()`);
    await b.waitFor(`document.querySelector('[data-id="why-this-job"] .pr-status')?.textContent === 'generada'`);
    assert.equal(llm.calls.generateJson.length, generatedBefore + 1);

    const preparedCallsBefore = llm.calls.generateJson.length;
    await b.eval("window.__fake.final('What are your strengths?')");
    await b.waitFor("document.querySelector('#prepared-badge')", 6000);
    assert.equal(await b.text('#prepared-badge'), 'Preparada: What are your strengths?');
    assert.equal(await b.text('#suggestion .answer .en'), 'My own strengths answer.');
    assert.equal(llm.calls.generateJson.length, preparedCallsBefore, 'a prepared answer does not call Gemini');
    await b.eval("window.__fake.final('Why should we hire you?')");
    await b.waitFor("document.querySelector('#prepared-badge')?.textContent.includes('Why should we hire you?')", 6000);
    assert.match(await b.text('#prepared-badge'), /^Preparada · plantilla sin revisar: /);
    assert.equal(llm.calls.generateJson.length, preparedCallsBefore);
    await b.click('#btn-ask-ai');
    await b.waitFor("!document.querySelector('#prepared-badge')", 6000);
    assert.equal(llm.calls.generateJson.length, preparedCallsBefore + 1, '"Pedir a la IA" asks Gemini about the same turn');
    assert.match(llm.calls.generateJson.at(-1).prompt, /Why should we hire you?/);

    await b.click('#prepared-generate-all');
    await b.waitFor("document.querySelector('#prepared-summary').hidden", 20000);
    assert.equal(llm.calls.generateJson.length, preparedCallsBefore + 1 + 29, 'the 29 templates were regenerated; the edited and the generated ones were not');
    assert.equal(await b.count('.pr-edited'), 1);
    assert.equal(await b.eval("document.querySelector('[data-id=strengths] .pr-en').value"), 'My own strengths answer.', 'the answer edited by hand survives "Personalizar con IA"');

    // text typed in an open editor and not yet saved survives the list being rebuilt (a generation starting and ending, another question added)
    await b.eval(`(() => {
      const d = document.querySelector('[data-id="team-conflict"]');
      d.open = true;
      const en = d.querySelector('.pr-en');
      en.value = 'My unsaved draft about conflict.';
      en.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await b.eval(`document.querySelector('[data-id="tight-deadlines"] .pr-generate').click()`);
    await b.waitFor(`document.querySelector('[data-id="tight-deadlines"] .pr-generate')?.textContent === 'Generar con IA'`);
    await b.fill('#prepared-new-question', 'Tell me about Kubernetes');
    assert.equal(await b.eval("document.querySelector('#prepared-new-triggers').value"), 'kubernetes');
    await b.click('#prepared-add');
    await b.waitFor("document.querySelectorAll('#prepared-list .prepared-item').length === 32");
    await b.eval("[...document.querySelectorAll('#prepared-list .prepared-item')].find((d) => d.querySelector('.pr-title').textContent === 'Tell me about Kubernetes').querySelector('.pr-delete').click()");
    await b.waitFor("document.querySelectorAll('#prepared-list .prepared-item').length === 31");
    assert.equal(await b.eval("document.querySelector('[data-id=team-conflict] .pr-en').value"), 'My unsaved draft about conflict.', 'unsaved text survives the list being rebuilt');
    assert.equal(await b.eval("document.querySelector('[data-id=team-conflict]').open"), true);
    // markup in a question is shown as text, never executed
    await b.fill('#prepared-new-question', '<img src=x onerror="window.__pwned=3"> markup');
    await b.click('#prepared-add');
    await b.waitFor("document.querySelectorAll('#prepared-list .prepared-item').length === 32");
    assert.equal(await b.count('#prepared-list img'), 0);
    assert.equal(await b.eval('window.__pwned === undefined'), true);
    await b.eval("[...document.querySelectorAll('#prepared-list .prepared-item')].find((d) => d.querySelector('.pr-title').textContent.includes('markup')).querySelector('.pr-delete').click()");
    await b.waitFor("document.querySelectorAll('#prepared-list .prepared-item').length === 31");
    await b.click('#tab-docs');

    // --- STAR story template: one click prepares the text area and selects the "stories" kind
    await b.click('#paste-star');
    assert.match(await b.eval("document.querySelector('#paste-text').value"), /^Situación:/);
    assert.equal(await b.eval("document.querySelector('#doc-kind').value"), 'stories');
    await b.fill('#paste-name', 'Migración a Azure');
    await b.click('#paste-add');
    await b.waitFor("document.querySelectorAll('#doc-list .doc').length === 4");
    assert.equal(await b.eval("document.querySelector('#doc-list .doc:last-child select').value"), 'stories');

    // --- stop
    await b.click('#btn-start');
    await b.waitFor("document.querySelector('#btn-start').textContent === 'Iniciar'");
    assert.equal(await b.eval('window.__fake.stopped'), 1);

    // Chrome logs every failed request; the two this test provoked on purpose (rejected upload, Gemini failure) are expected.
    // Anything else (CSP violations, script errors, missing files) is a bug.
    const unexpected = b.errors.filter((e) => !/status of (415|502)/.test(e));
    assert.deepEqual(unexpected, [], `browser errors: ${unexpected.join(' | ')}`);
  } finally {
    await b.close();
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  }
});
