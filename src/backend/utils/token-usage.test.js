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
    tokenUsage.add(usage(1000, 250));
    return tokenUsage.current();
  });

  assert.deepEqual(seen, { promptTokens: 1000, outputTokens: 250, totalTokens: 1250, calls: 1 });
});

test('several calls in one run add up', async () => {
  // Most modules call the model more than once — a signal pass, then the
  // extraction. The figure is the RUN's, not the call's.
  const seen = await tokenUsage.run(async () => {
    tokenUsage.add(usage(1000, 250));
    tokenUsage.add(usage(400, 100));
    return tokenUsage.current();
  });

  assert.deepEqual(seen, { promptTokens: 1400, outputTokens: 350, totalTokens: 1750, calls: 2 });
});

test('a thinking model\'s hidden tokens are counted as output', async () => {
  // `thoughtsTokenCount` is already inside `totalTokenCount`, so adding it to
  // the total would double-count — but leaving it out of `output` would make
  // prompt + output disagree with the total for no visible reason.
  const seen = await tokenUsage.run(async () => {
    tokenUsage.add({
      promptTokenCount: 1000, candidatesTokenCount: 200,
      thoughtsTokenCount: 800, totalTokenCount: 2000
    });
    return tokenUsage.current();
  });

  assert.equal(seen.outputTokens, 1000, '200 answered + 800 thought');
  assert.equal(seen.totalTokens, 2000, 'the provider\'s own total, not a recomputed one');
});

test('a provider that omits the total has one computed', async () => {
  const seen = await tokenUsage.run(async () => {
    tokenUsage.add({ promptTokenCount: 30, candidatesTokenCount: 12 });
    return tokenUsage.current();
  });

  assert.equal(seen.totalTokens, 42);
});

test('a call with no usage block still counts as a call', async () => {
  // A response without usage is not a free call — it is a call whose cost the
  // provider did not report, and hiding that would overstate how complete the
  // figure is.
  const seen = await tokenUsage.run(async () => {
    tokenUsage.add(usage(10, 5));
    tokenUsage.add(undefined);
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
      tokenUsage.add(usage(100, 10));
      await new Promise((r) => setTimeout(r, 10));
      tokenUsage.add(usage(100, 10));
      return tokenUsage.current();
    }),
    tokenUsage.run(async () => {
      await new Promise((r) => setTimeout(r, 5));
      tokenUsage.add(usage(7, 3));
      return tokenUsage.current();
    })
  ]);

  assert.deepEqual(a, { promptTokens: 200, outputTokens: 20, totalTokens: 220, calls: 2 });
  assert.deepEqual(b, { promptTokens: 7, outputTokens: 3, totalTokens: 10, calls: 1 });
});

test('a call outside any run is dropped, not thrown', async () => {
  // A script or a test calling the model is not a run and has nothing to
  // charge. Throwing here would turn "we could not count it" into "the job
  // failed", which is a far worse trade.
  assert.doesNotThrow(() => tokenUsage.add(usage(10, 10)));
  assert.equal(tokenUsage.current(), null);
});

test('the tally handed out is a copy', async () => {
  // It ends up on a job result. A caller mutating it must not change what a
  // later read of the same run reports.
  const seen = await tokenUsage.run(async () => {
    tokenUsage.add(usage(10, 5));
    const first = tokenUsage.current();
    first.totalTokens = 999999;
    return tokenUsage.current();
  });

  assert.equal(seen.totalTokens, 15);
});
