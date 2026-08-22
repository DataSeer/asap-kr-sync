/**
 * Tests for the shared Gemini generation defaults.
 *
 * The point of applying these centrally is that a call site cannot opt out by
 * forgetting — which is exactly how every call ended up at the API's default
 * temperature of 1.0. These pin that behaviour.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { withDefaultGenerationConfig, DEFAULT_GENERATION_CONFIG } = require('./gemini');

test('a call with no config at all gets temperature 0', () => {
  const out = withDefaultGenerationConfig({ model: 'gemini-2.5-flash', contents: [] });
  assert.equal(out.config.temperature, 0);
  assert.equal(out.model, 'gemini-2.5-flash');
});

test('an existing config is preserved and temperature added', () => {
  const out = withDefaultGenerationConfig({
    model: 'm',
    config: { responseMimeType: 'application/json', maxOutputTokens: 32768, thinkingConfig: { thinkingBudget: 0 } }
  });
  assert.equal(out.config.temperature, 0);
  assert.equal(out.config.responseMimeType, 'application/json');
  assert.equal(out.config.maxOutputTokens, 32768);
  assert.deepEqual(out.config.thinkingConfig, { thinkingBudget: 0 }, 'thinking stays a per-call decision');
});

test('an explicit caller temperature always wins', () => {
  const out = withDefaultGenerationConfig({ model: 'm', config: { temperature: 0.7 } });
  assert.equal(out.config.temperature, 0.7);
});

test('an explicit temperature of 0 is not confused with "unset"', () => {
  const out = withDefaultGenerationConfig({ model: 'm', config: { temperature: 0 } });
  assert.equal(out.config.temperature, 0);
});

test('the original params object is not mutated', () => {
  const params = { model: 'm', config: { maxOutputTokens: 100 } };
  withDefaultGenerationConfig(params);
  assert.equal(params.config.temperature, undefined);
});

test('tolerates junk input', () => {
  assert.equal(withDefaultGenerationConfig({}).config.temperature, 0);
  assert.equal(withDefaultGenerationConfig({ config: null }).config.temperature, 0);
});

test('defaults deliberately do not include thinkingConfig', () => {
  assert.equal('thinkingConfig' in DEFAULT_GENERATION_CONFIG, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Every try is recorded
//
// The wrapper retries transient failures and empty bodies, and until now the
// only trace of that was a log line. "The first two attempts returned 529, then
// it succeeded" is the difference between an upstream that is flaky and one
// that is broken, and it is the question somebody staring at a slow run is
// actually asking.
// ─────────────────────────────────────────────────────────────────────────────

const { generateContentWithRetry } = require('./gemini');
const attemptLog = require('./attempt-log');

/** No backoff: these tests are about what is recorded, not about waiting. */
const NO_WAIT = { maxRetries: 3, delay: 0, multiplier: 1, maxDelay: 0, jitter: 0 };

const fakeAi = (responses) => {
  let call = 0;
  return {
    models: {
      async generateContent() {
        const next = responses[call];
        call += 1;
        if (next instanceof Error) throw next;
        return next;
      }
    }
  };
};

const overloaded = () => Object.assign(new Error('503 UNAVAILABLE: model is overloaded'), { status: 503 });

test('two transient failures then a success read back as three tries', async () => {
  const attempts = await attemptLog.run(async () => {
    await generateContentWithRetry(
      fakeAi([overloaded(), overloaded(), { text: 'ok' }]),
      { model: 'm', contents: [] },
      { label: 'Datasets', retry: NO_WAIT }
    );
    return attemptLog.drain();
  });

  assert.deepEqual(attempts.map((a) => [a.ok, a.httpStatus]), [
    [false, 503], [false, 503], [true, 200]
  ]);
  assert.ok(attempts.every((a) => a.engine === 'Datasets'), 'and each says which service');
});

test('a 200 that cannot be parsed is a failed try, not a silent one', async () => {
  // It produced nothing, it was paid for, and it caused a retry. Recording it
  // as a success would make a run that retried four times look clean.
  const attempts = await attemptLog.run(async () => {
    await generateContentWithRetry(
      fakeAi([{ text: '' }, { text: 'real' }]),
      { model: 'm', contents: [] },
      { label: 'Materials', validate: (r) => !!r.text, retry: NO_WAIT }
    );
    return attemptLog.drain();
  });

  assert.deepEqual(attempts.map((a) => a.ok), [false, true]);
  assert.match(attempts[0].error, /empty or unparseable/);
  assert.equal(attempts[0].httpStatus, 200);
});

test('a failure that is never retried is still recorded', async () => {
  // Recorded before the decision to give up. The run's record is about what
  // happened, not about what the retry policy thought of it — an auth error
  // that fails once is exactly what somebody debugging needs to see.
  const attempts = await attemptLog.run(async () => {
    await assert.rejects(() => generateContentWithRetry(
      fakeAi([Object.assign(new Error('401 UNAUTHENTICATED'), { status: 401 })]),
      { model: 'm', contents: [] },
      { label: 'Protocols', retry: NO_WAIT }
    ));
    return attemptLog.drain();
  });

  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].ok, false);
  assert.equal(attempts[0].httpStatus, 401);
});
