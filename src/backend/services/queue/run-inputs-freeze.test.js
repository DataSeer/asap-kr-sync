'use strict';

/**
 * What a run freezes about the call it made.
 *
 * The gap this closes: recording the call parameters used to mean hand-picking
 * them per module, and a hand-picked list drifts. Four of twelve modules never
 * recorded which model they called — found only by reading all twelve, not by
 * anything failing. `pdf_analysis` froze its prompt from the first day and
 * never said which model read it, so two runs that disagreed could not be told
 * apart from two models that disagreed.
 *
 * So the rule is inverted: capture whatever was handed to the client, and strip
 * what must not be kept. That cannot be forgotten in the same way — which is
 * the only property worth testing here, and it is structural, so the source is
 * read rather than each module exercised.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { sanitise, mergeFrozen, INLINE_LIMIT, OMITTED } = require('./run-inputs.service');

const SERVICES_DIR = path.join(__dirname, '..');

function serviceFiles(dir = SERVICES_DIR, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) serviceFiles(full, acc);
    else if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) acc.push(full);
  }
  return acc;
}

/** Every `saveRunInputs({...})` object literal in the services tree. */
function freezeSites() {
  const sites = [];
  for (const file of serviceFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    for (const match of src.matchAll(/saveRunInputs\(jobLogger, \{/g)) {
      let depth = 0;
      const start = match.index + match[0].length - 1;
      let end = start;
      for (let i = start; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
      }
      sites.push({ file: path.relative(SERVICES_DIR, file), body: src.slice(start, end + 1) });
    }
  }
  return sites;
}

test('every step that freezes its inputs also freezes what it asked for', () => {
  // The one that has to hold. A module recording documents and a prompt but not
  // its model produces a run that looks fully frozen and cannot be reproduced.
  const missing = freezeSites().filter((s) => !/\bcall:/.test(s.body)).map((s) => s.file);

  assert.deepEqual(missing, [],
    'these freeze their inputs without recording the call — add `call: <the config>`');
});

test('and there are twelve of them, so none has quietly stopped freezing', () => {
  // Guards against the rule above passing vacuously: delete the saveRunInputs
  // call and the module disappears from the check instead of failing it.
  const sites = freezeSites();
  assert.ok(sites.length >= 12,
    `expected a freeze site per pipeline step, found ${sites.length}`);
});

// ── the sanitiser ───────────────────────────────────────────────────────────

test('a secret is REMOVED, not replaced by a placeholder', () => {
  // The record is merged back when a run is restarted with its own parameters,
  // so a placeholder is not a redaction at that point — it is a poisoned value.
  // The merge would send the literal string as the API key and the call would
  // fail. Removed and named instead, so the merge falls through to the live one.
  const out = sanitise({
    model: 'gemini-2.5-flash',
    apiKey: 'AIzaSy-REAL-KEY',
    nested: { authToken: 'abc', password: 'p', url: 'https://x' }
  });

  assert.equal(out.model, 'gemini-2.5-flash', 'the parameters worth reading survive');
  assert.ok(!('apiKey' in out), 'gone from the body');
  assert.ok(!('authToken' in out.nested));
  assert.equal(out.nested.url, 'https://x', 'an endpoint is a parameter, not a secret');

  // Named, so absence is not ambiguous: "a secret was here" and "this
  // parameter did not exist in that version" must not read the same.
  assert.deepEqual(out[OMITTED]['apiKey'], { reason: 'secret' });
  assert.deepEqual(out[OMITTED]['nested.authToken'], { reason: 'secret' });
  assert.deepEqual(out[OMITTED]['nested.password'], { reason: 'secret' });

  // And no value of it survives anywhere in the serialised form.
  assert.ok(!JSON.stringify(out).includes('AIzaSy-REAL-KEY'));
});

test('a document is dereferenced, and keeps its digest', () => {
  // By SIZE, not by key name: you cannot enumerate the keys that might one day
  // hold a manuscript, and a rule keyed on names is one somebody has to
  // remember to extend.
  const manuscript = 'x'.repeat(INLINE_LIMIT + 1);
  const out = sanitise({ contents: manuscript, model: 'm' });

  assert.ok(!('contents' in out), 'merging it back would replace a manuscript with a stub');
  assert.equal(out[OMITTED].contents.reason, 'too large to inline');
  assert.equal(out[OMITTED].contents.bytes, INLINE_LIMIT + 1);
  // Kept, so a rebuild can still be checked against what the run used.
  assert.match(out[OMITTED].contents.sha256, /^[0-9a-f]{64}$/);
  assert.equal(out.model, 'm');
});

test('a buffer is never serialised as a byte array', () => {
  const out = sanitise({ pdf: Buffer.from('hello') });
  assert.ok(!('pdf' in out));
  assert.equal(out[OMITTED].pdf.reason, 'binary');
  assert.equal(out[OMITTED].pdf.bytes, 5);
});

test('a long array is counted, not copied', () => {
  const out = sanitise({ candidates: Array.from({ length: 117 }, (_, i) => ({ i })) });
  assert.deepEqual(out[OMITTED].candidates, { reason: 'long array', length: 117 });
});

test('a config module\'s methods are dropped without a note', () => {
  // `isConfigured` was never a value to restore, so it is not an omission worth
  // reporting either.
  const out = sanitise({ model: 'm', isConfigured: () => true, logStatus() {} });
  assert.deepEqual(Object.keys(out), ['model']);
});

// ── merging a run's parameters back ─────────────────────────────────────────

test('frozen wins, and the live secret fills the hole it left', () => {
  // The whole reason omitting beats redacting: the key was never in the record,
  // so the merge falls through to the one configured now.
  const frozen = sanitise({ apiKey: 'OLD-KEY', model: 'gemini-2.0-flash', timeout: 300000 });
  const live = { apiKey: 'CURRENT-KEY', model: 'gemini-2.5-flash', timeout: 120000 };

  const { params, restored } = mergeFrozen(live, frozen);

  assert.equal(params.apiKey, 'CURRENT-KEY', 'the call must be able to authenticate');
  assert.equal(params.model, 'gemini-2.0-flash', 'and run against what the run ran against');
  assert.equal(params.timeout, 300000);
  assert.deepEqual(restored.sort(), ['model', 'timeout']);
});

test('nested config merges rather than being replaced wholesale', () => {
  const frozen = sanitise({ modal: { url: 'https://old', apiKey: 'k', converter: 'docling' } });
  const live = { modal: { url: 'https://new', apiKey: 'k2', converter: 'marker', extra: 1 } };

  const { params } = mergeFrozen(live, frozen);

  assert.equal(params.modal.converter, 'docling');
  assert.equal(params.modal.apiKey, 'k2', 'the live credential, not the omitted one');
  assert.equal(params.modal.extra, 1, 'a parameter added since is left at its current value');
});

test('a parameter this version no longer has is reported, not sent', () => {
  // The client would reject it, or ignore it and leave the caller believing the
  // run was reproduced. Neither is acceptable silently.
  const { params, ignored } = mergeFrozen({ model: 'm' }, { model: 'old', topK: 40 });

  assert.ok(!('topK' in params));
  assert.deepEqual(ignored, ['topK']);
});

test('the omissions block is never merged as if it were a parameter', () => {
  const frozen = sanitise({ model: 'm', apiKey: 'x' });
  const { params } = mergeFrozen({ model: 'live', apiKey: 'live-key' }, frozen);

  assert.ok(!(OMITTED in params));
  assert.deepEqual(Object.keys(params).sort(), ['apiKey', 'model']);
});

test('a run that recorded nothing leaves the live config untouched', () => {
  // Old runs, made before any of this. The flag must say "this run recorded no
  // parameters" rather than quietly using today's and calling it frozen.
  const { params, restored } = mergeFrozen({ model: 'm', timeout: 1 }, undefined);

  assert.deepEqual(params, { model: 'm', timeout: 1 });
  assert.deepEqual(restored, []);
});

test('a cycle terminates instead of hanging the worker', () => {
  const a = { model: 'm' };
  a.self = a;
  assert.doesNotThrow(() => JSON.stringify(sanitise(a)));
});

test('nothing in a real config leaks a value from the environment', () => {
  // The strongest form of the secret rule: whatever the environment holds that
  // looks like a credential must not appear anywhere in the output, under any
  // key name the denylist happens not to match.
  const secrets = Object.entries(process.env)
    .filter(([k, v]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k) && v && v.length > 8)
    .map(([, v]) => v);

  const configs = fs.readdirSync(path.join(__dirname, '../../config'))
    .filter((f) => f.endsWith('-api.js'))
    .map((f) => require(path.join(__dirname, '../../config', f)));

  const dumped = JSON.stringify(configs.map((c) => sanitise(c)));
  const leaked = secrets.filter((s) => dumped.includes(s));

  assert.deepEqual(leaked, [], 'a credential reached a downloadable artefact');
});
