/**
 * Adding up what a document cost, without inventing any of it.
 *
 * Three things this has to get right, each of which fails silently if it does
 * not: models must stay apart (two models are two prices), a discarded response
 * must still count (it was paid for), and the run total must survive steps
 * finishing at the same instant (workers run at `concurrency: 2`).
 *
 * Run with: node --test src/backend/services/queue/run-usage.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const models = require('../../models');
const runHistory = require('./run-history.service');

/** A usage record in the shape utils/token-usage produces. */
function usage(model, prompt, output, extra = {}) {
  return {
    byModel: {
      [model]: {
        promptTokens: prompt, outputTokens: output, thoughtTokens: 0,
        cachedTokens: 0, totalTokens: prompt + output, calls: 1
      }
    },
    promptTokens: prompt, outputTokens: output, thoughtTokens: 0,
    cachedTokens: 0, totalTokens: prompt + output, calls: 1,
    measuredCalls: 1, unmeasured: [], notCounted: [],
    ...extra
  };
}

test('two models stay apart, because two models are two prices', () => {
  const sum = runHistory.sumUsage([
    usage('gemini-2.5-flash', 100, 10),
    usage('gemini-2.5-pro', 200, 20),
    usage('gemini-2.5-flash', 50, 5)
  ]);

  assert.deepEqual(Object.keys(sum.byModel).sort(), ['gemini-2.5-flash', 'gemini-2.5-pro']);
  assert.equal(sum.byModel['gemini-2.5-flash'].promptTokens, 150);
  assert.equal(sum.byModel['gemini-2.5-pro'].promptTokens, 200);
  assert.equal(sum.promptTokens, 350, 'the summary is the sum of the buckets');
  assert.equal(sum.calls, 3);
});

test('what could not be measured is carried up, not dropped on the way', () => {
  // The figure is only honest if its gaps travel with it. A run total that
  // silently lost the "1 call timed out" from one of its steps would look more
  // complete than it is.
  const sum = runHistory.sumUsage([
    usage('gemini-2.5-flash', 10, 5, { unmeasured: [{ reason: 'timeout', httpStatus: 408 }] }),
    usage('gemini-2.5-flash', 10, 5, { notCounted: ['langextract'] }),
    usage('gemini-2.5-flash', 10, 5, { notCounted: ['langextract'] })
  ]);

  assert.equal(sum.unmeasured.length, 1);
  assert.equal(sum.unmeasured[0].reason, 'timeout');
  assert.deepEqual(sum.notCounted, ['langextract'], 'named once, however many steps hit it');
  assert.equal(sum.totalTokens, 45, 'the unmeasured call still adds nothing');
});

test('a response thrown away after a cancel is still counted', () => {
  // It was paid for. That is the entire reason `discarded` exists.
  const step = runHistory.stepUsage(
    usage('gemini-2.5-flash', 100, 10),
    [{ at: 'x', tokens: usage('gemini-2.5-flash', 70, 7) }]
  );

  assert.equal(step.promptTokens, 170);
  assert.equal(step.calls, 2);
});

test('a step that called no model records nothing, rather than zero', () => {
  assert.equal(runHistory.stepUsage(null, null), null);
  assert.equal(runHistory.stepUsage(null, []), null);
  assert.equal(runHistory.stepUsage(null, [{ at: 'x', tokens: null }]), null);
});

test('a cancelled step with only a discarded answer still reports', () => {
  const step = runHistory.stepUsage(null, [{ at: 'x', tokens: usage('gemini-2.5-flash', 70, 7) }]);

  assert.equal(step.totalTokens, 77);
});

test('the run total is recomputed from its steps, not accumulated', async (t) => {
  // The property that makes concurrency safe: the same call twice leaves the
  // same number. An increment would have doubled it.
  const saved = [];
  const run = { id: 'run-1', usage: { stale: true }, update: async (f) => { saved.push(f.usage); return run; } };

  t.mock.method(models.PipelineRun, 'findByPk', async () => run);
  t.mock.method(models.StepExecution, 'findAll', async () => ([
    { usage: usage('gemini-2.5-flash', 100, 10) },
    { usage: usage('gemini-2.5-flash', 200, 20) },
    { usage: null }
  ]));
  t.mock.method(models.sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));

  await runHistory.recomputePipelineRunUsage('run-1');
  await runHistory.recomputePipelineRunUsage('run-1');

  assert.equal(saved.length, 2);
  assert.equal(saved[0].promptTokens, 300);
  assert.deepEqual(saved[0], saved[1], 'idempotent — losing the race writes the same total');
});

test('a run whose steps spent nothing stores null, not a row of zeroes', async (t) => {
  let written;
  const run = { id: 'run-2', update: async (f) => { written = f.usage; return run; } };

  t.mock.method(models.PipelineRun, 'findByPk', async () => run);
  t.mock.method(models.StepExecution, 'findAll', async () => ([{ usage: null }, { usage: null }]));
  t.mock.method(models.sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));

  await runHistory.recomputePipelineRunUsage('run-2');

  assert.equal(written, null);
});

test('a usage figure never takes the pipeline down with it', async (t) => {
  // `guarded` is the contract: what a run cost is worth less than the run.
  t.mock.method(models.PipelineRun, 'findByPk', async () => { throw new Error('db is on fire'); });
  t.mock.method(models.sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));

  await assert.doesNotReject(() => runHistory.recomputePipelineRunUsage('run-3'));
});

test('no pipeline run id is not an error, it is nothing to do', async () => {
  assert.equal(await runHistory.recomputePipelineRunUsage(null), null);
});
