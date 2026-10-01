/**
 * Counting what a run spent.
 *
 * The tally is ambient — a store the queue opens per job, which every model
 * call underneath adds to — precisely so that adding a tenth LM service does
 * not mean remembering to thread a number back out of it. That convenience is
 * only safe if the store really is per-job, so the isolation is what gets
 * tested hardest here: two runs overlapping in time must never see each other's
 * numbers, and that failure would only ever show under load.
 *
 * Run with: node --test src/backend/utils/token-usage.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const tokenUsage = require('./token-usage');

const MODEL = 'gemini-2.5-flash';

/** A Gemini usage block. */
const usage = (prompt, output, extra = {}) => ({
  promptTokenCount: prompt,
  candidatesTokenCount: output,
  totalTokenCount: prompt + output,
  ...extra
});

test('a run with no model call reports nothing', async () => {
  // Not zeroes: "no model was called" and "the model returned nothing" are
  // different, and a row of zeroes on Markdown Convert would be noise on every
  // page it appears.
  const seen = await tokenUsage.run(async () => tokenUsage.current());

  assert.equal(seen, null);
});

test('one call is counted', async () => {
  const seen = await tokenUsage.run(async () => {
    tokenUsage.add(usage(1000, 250), MODEL);
    return tokenUsage.current();
  });

  assert.equal(seen.promptTokens, 1000);
  assert.equal(seen.outputTokens, 250);
  assert.equal(seen.totalTokens, 1250);
  assert.equal(seen.calls, 1);
  assert.deepEqual(seen.byModel[MODEL], {
    promptTokens: 1000, outputTokens: 250, thoughtTokens: 0,
    cachedTokens: 0, totalTokens: 1250, calls: 1
  });
});

test('several calls in one run add up', async () => {
  // Most modules call the model more than once — a signal pass, then the
  // extraction. The figure is the RUN's, not the call's.
  const seen = await tokenUsage.run(async () => {
    tokenUsage.add(usage(1000, 250), MODEL);
    tokenUsage.add(usage(400, 100), MODEL);
    return tokenUsage.current();
  });

  assert.equal(seen.promptTokens, 1400);
  assert.equal(seen.outputTokens, 350);
  assert.equal(seen.totalTokens, 1750);
  assert.equal(seen.calls, 2);
});

test('a thinking model\'s hidden tokens are counted as output', async () => {
  // `thoughtsTokenCount` is already inside `totalTokenCount`, so adding it to
  // the total would double-count — but leaving it out of `output` would make
  // prompt + output disagree with the total for no visible reason.
  const seen = await tokenUsage.run(async () => {
    tokenUsage.add({
      promptTokenCount: 1000, candidatesTokenCount: 200,
      thoughtsTokenCount: 800, totalTokenCount: 2000
    }, MODEL);
    return tokenUsage.current();
  });

  assert.equal(seen.outputTokens, 1000, '200 answered + 800 thought');
  assert.equal(seen.totalTokens, 2000, 'the provider\'s own total, not a recomputed one');
});

test('a provider that omits the total has one computed', async () => {
  const seen = await tokenUsage.run(async () => {
    tokenUsage.add({ promptTokenCount: 30, candidatesTokenCount: 12 }, MODEL);
    return tokenUsage.current();
  });

  assert.equal(seen.totalTokens, 42);
});

test('a call with no usage block still counts as a call', async () => {
  // A response without usage is not a free call — it is a call whose cost the
  // provider did not report, and hiding that would overstate how complete the
  // figure is.
  const seen = await tokenUsage.run(async () => {
    tokenUsage.add(usage(10, 5), MODEL);
    tokenUsage.add(undefined, MODEL);
    return tokenUsage.current();
  });

  assert.equal(seen.calls, 1, 'nothing to add, so nothing is added');
  assert.equal(seen.totalTokens, 15);
});

test('two runs at the same time do not see each other', async () => {
  // The reason this is an AsyncLocalStorage and not a module-level counter.
  // Workers run side by side; a shared counter would have charged one
  // submission for another's tokens, under load, invisibly.
  const [a, b] = await Promise.all([
    tokenUsage.run(async () => {
      tokenUsage.add(usage(100, 10), MODEL);
      await new Promise((r) => setTimeout(r, 10));
      tokenUsage.add(usage(100, 10), MODEL);
      return tokenUsage.current();
    }),
    tokenUsage.run(async () => {
      await new Promise((r) => setTimeout(r, 5));
      tokenUsage.add(usage(7, 3), MODEL);
      return tokenUsage.current();
    })
  ]);

  assert.equal(a.totalTokens, 220);
  assert.equal(a.calls, 2);
  assert.equal(b.totalTokens, 10);
  assert.equal(b.calls, 1);
});

test('a call outside any run is dropped, not thrown', async () => {
  // A script or a test calling the model is not a run and has nothing to
  // charge. Throwing here would turn "we could not count it" into "the job
  // failed", which is a far worse trade.
  assert.doesNotThrow(() => tokenUsage.add(usage(10, 10), MODEL));
  assert.doesNotThrow(() => tokenUsage.addUnmeasured({ reason: 'timeout' }));
  assert.doesNotThrow(() => tokenUsage.addNotCounted('langextract'));
  assert.equal(tokenUsage.current(), null);
});

test('the tally handed out is a copy', async () => {
  // It ends up on a job result. A caller mutating it must not change what a
  // later read of the same run reports.
  const seen = await tokenUsage.run(async () => {
    tokenUsage.add(usage(10, 5), MODEL);
    const first = tokenUsage.current();
    first.totalTokens = 999999;
    first.byModel[MODEL].promptTokens = 999999;
    first.unmeasured.push({ reason: 'invented' });
    return tokenUsage.current();
  });

  assert.equal(seen.totalTokens, 15);
});

test('an unnamed model is bucketed visibly rather than silently merged', async () => {
  // Every call in this codebase passes a model. If one ever stops, the figure
  // must not quietly join another model's bucket and be priced as it.
  const seen = await tokenUsage.run(async () => {
    tokenUsage.add(usage(10, 5));
    return tokenUsage.current();
  });

  assert.deepEqual(Object.keys(seen.byModel), [tokenUsage.UNKNOWN_MODEL]);
});

test('an unmeasured call is listed, and adds nothing to the totals', async () => {
  // The whole point of the estimate framing: a call whose cost we could not
  // read is named, not absorbed and not dropped.
  const seen = await tokenUsage.run(async () => {
    tokenUsage.add(usage(10, 5), MODEL);
    tokenUsage.addUnmeasured({ reason: 'timeout', httpStatus: 408, promptChars: 900, model: MODEL });
    return tokenUsage.current();
  });

  assert.equal(seen.totalTokens, 15);
  assert.equal(seen.measuredCalls, 1);
  assert.equal(seen.unmeasured.length, 1);
  assert.equal(seen.unmeasured[0].reason, 'timeout');
});

test('a run that only failed still reports, instead of looking free', async () => {
  const seen = await tokenUsage.run(async () => {
    tokenUsage.addUnmeasured({ reason: 'server_error', httpStatus: 503 });
    return tokenUsage.current();
  });

  assert.ok(seen, 'not null — this run spent something unknowable');
  assert.equal(seen.measuredCalls, 0);
  assert.equal(seen.totalTokens, 0);
});

test('a named uncounted source survives to the record, once', async () => {
  const seen = await tokenUsage.run(async () => {
    tokenUsage.addNotCounted('langextract');
    tokenUsage.addNotCounted('langextract');
    tokenUsage.add(usage(10, 5), MODEL);
    return tokenUsage.current();
  });

  assert.deepEqual(seen.notCounted, ['langextract']);
});
