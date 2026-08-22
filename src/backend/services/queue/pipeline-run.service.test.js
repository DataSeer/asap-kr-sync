'use strict';

/**
 * A pipeline run is one coherent attempt, and these are the properties that
 * make it coherent. Each of them, if lost, produces a run that still LOOKS
 * complete — which is why they are asserted rather than assumed.
 *
 *   1. **Downstream re-runs with its dependency.** A carried-over result built
 *      without what is being re-run is stale the moment that step succeeds, and
 *      the run would present a mixed answer as a coherent one.
 *   2. **A step the parent never executed is not "carried over".** There is
 *      nothing to carry, and nothing else will enqueue it, so marking it
 *      carried-over leaves a hole shaped like a decision.
 *   3. **Every step gets a membership row immediately**, including the ones
 *      that have not started. A run listing only what has finished cannot be
 *      read while it is running.
 *   4. **The replaced parent becomes `superseded`**, not left `running` for
 *      ever describing an attempt that stopped.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const models = require('../../models');
const pipelineRuns = require('./pipeline-run.service');

/** a → b → c, plus an unrelated d. Enough to tell expansion from copying. */
const PIPELINE = [
  { jobType: 'a', dependsOn: [] },
  { jobType: 'b', dependsOn: ['a'] },
  { jobType: 'c', dependsOn: ['b'], optional: ['b'] },
  { jobType: 'd', dependsOn: [] }
];

/**
 * Stand in for the DB. Records what was written; hands back what was asked.
 *
 * @param {object} t - the test context, for mock lifetime
 * @param {object} [opts]
 * @param {object|null} [opts.parent] - the run already there, if any
 * @param {object} [opts.inherited] - jobType → executionId the parent holds
 */
function fakeDb(t, { parent = null, inherited = {} } = {}) {
  const state = { opened: null, members: [], parentUpdates: [] };

  t.mock.method(models.sequelize, 'transaction', async (fn) => fn('TX'));

  t.mock.method(models.PipelineRun, 'current', async () => (parent
    ? {
      ...parent,
      update: async (values) => { state.parentUpdates.push(values); }
    }
    : null));

  t.mock.method(models.PipelineRunStep, 'findAll', async () => Object.entries(inherited)
    .map(([jobType, stepExecutionId]) => ({ jobType, stepExecutionId })));

  t.mock.method(models.PipelineRun, 'open', async (attrs) => {
    state.opened = attrs;
    return { id: 'run-new', runNumber: (parent?.runNumber ?? 0) + 1, ...attrs };
  });

  t.mock.method(models.PipelineRunStep, 'bulkCreate', async (rows) => {
    state.members = rows;
    return rows;
  });

  return state;
}

const member = (state, jobType) => state.members.find((m) => m.jobType === jobType);

test('the first run of a round executes everything and carries nothing', async (t) => {
  const state = fakeDb(t);

  const result = await pipelineRuns.newRun({
    submissionId: 'sub-1', pipeline: PIPELINE, reRun: 'all', cause: 'create_submission'
  });

  assert.deepEqual(result.reRun, ['a', 'b', 'c', 'd']);
  assert.deepEqual(result.carriedOver, []);
  assert.equal(result.parent, null);
  assert.equal(state.opened.parentRunId, null);

  // Property 3: a row per step from the start, execution not yet known.
  assert.equal(state.members.length, 4);
  assert.ok(state.members.every((m) => m.stepExecutionId === null && !m.carriedOver));
});

test('restarting a step drags its downstream with it, and only that', async (t) => {
  const state = fakeDb(t, {
    parent: { id: 'run-1', runNumber: 1, status: 'complete' },
    inherited: { a: 'exec-a', b: 'exec-b', c: 'exec-c', d: 'exec-d' }
  });

  const result = await pipelineRuns.newRun({
    submissionId: 'sub-1', pipeline: PIPELINE, reRun: ['b'], cause: 'restart', userId: 'user-1'
  });

  // Property 1. `c` depends on `b`, so re-running b without c would leave a
  // result computed from data that no longer exists.
  assert.deepEqual(result.reRun, ['b', 'c']);
  assert.deepEqual(result.carriedOver, ['a', 'd']);

  assert.equal(member(state, 'a').stepExecutionId, 'exec-a');
  assert.equal(member(state, 'a').carriedOver, true);
  assert.equal(member(state, 'b').stepExecutionId, null);
  assert.equal(member(state, 'b').carriedOver, false);
  assert.equal(member(state, 'c').stepExecutionId, null);
  assert.equal(member(state, 'd').stepExecutionId, 'exec-d');

  assert.equal(state.opened.parentRunId, 'run-1');
  assert.equal(state.opened.cause, 'restart');
  assert.equal(state.opened.causedByUserId, 'user-1');
});

test('an optional dependency is still a dependency for re-run purposes', async (t) => {
  fakeDb(t, {
    parent: { id: 'run-1', runNumber: 1, status: 'complete' },
    inherited: { a: 'exec-a', b: 'exec-b', c: 'exec-c', d: 'exec-d' }
  });

  // `c` declares `b` optional — it can RUN without it. That says nothing about
  // whether a result it already produced from b's output is still valid.
  const result = await pipelineRuns.newRun({
    submissionId: 'sub-1', pipeline: PIPELINE, reRun: ['b'], cause: 'retry'
  });

  assert.ok(result.reRun.includes('c'), 'an optional dependant is still downstream');
});

test('a step the parent never executed is executed, not carried over', async (t) => {
  const state = fakeDb(t, {
    parent: { id: 'run-1', runNumber: 1, status: 'paused' },
    // `d` never ran: the parent was superseded while it was still waiting.
    inherited: { a: 'exec-a', b: 'exec-b', c: 'exec-c' }
  });

  const result = await pipelineRuns.newRun({
    submissionId: 'sub-1', pipeline: PIPELINE, reRun: [], cause: 'retry'
  });

  // Property 2.
  assert.deepEqual(result.reRun, ['d']);
  assert.deepEqual(result.carriedOver, ['a', 'b', 'c']);
  assert.equal(member(state, 'd').carriedOver, false);
  assert.equal(member(state, 'd').stepExecutionId, null);
});

test('the replaced parent is superseded only while it was still going', async (t) => {
  const running = fakeDb(t, {
    parent: { id: 'run-1', runNumber: 1, status: 'running' },
    inherited: { a: 'exec-a', b: 'exec-b', c: 'exec-c', d: 'exec-d' }
  });
  await pipelineRuns.newRun({
    submissionId: 'sub-1', pipeline: PIPELINE, reRun: ['a'], cause: 'restart'
  });
  // Property 4.
  assert.deepEqual(running.parentUpdates, [{ status: 'superseded' }]);

  t.mock.restoreAll();

  const finished = fakeDb(t, {
    parent: { id: 'run-1', runNumber: 1, status: 'complete' },
    inherited: { a: 'exec-a', b: 'exec-b', c: 'exec-c', d: 'exec-d' }
  });
  await pipelineRuns.newRun({
    submissionId: 'sub-1', pipeline: PIPELINE, reRun: ['a'], cause: 'restart'
  });
  assert.deepEqual(finished.parentUpdates, [], 'a finished run keeps its status');
});

test('an unknown step is refused rather than silently dropped', async (t) => {
  fakeDb(t);
  await assert.rejects(
    () => pipelineRuns.newRun({
      submissionId: 'sub-1', pipeline: PIPELINE, reRun: ['nope'], cause: 'restart'
    }),
    /unknown step\(s\) nope/
  );
});

test('everything happens in one transaction', async (t) => {
  const state = fakeDb(t);
  await pipelineRuns.newRun({
    submissionId: 'sub-1', pipeline: PIPELINE, reRun: 'all', cause: 'create_submission'
  });
  // A run whose membership rows are missing reads as an attempt containing no
  // steps — indistinguishable, on every screen, from an empty pipeline.
  assert.equal(models.sequelize.transaction.mock.callCount(), 1);
  assert.equal(state.members.length, 4);
});

test('the shape records what each step depended on, and what it required', async (t) => {
  const state = fakeDb(t);
  await pipelineRuns.newRun({
    submissionId: 'sub-1', pipeline: PIPELINE, reRun: 'all', cause: 'create_submission'
  });

  const shape = state.opened.shape;
  assert.ok(shape.capturedAt);
  const c = shape.steps.find((s) => s.jobType === 'c');
  assert.deepEqual(c.dependsOn, ['b']);
  assert.deepEqual(c.optional, ['b']);
  // Stored, not derived at read time: a later change to the derivation rule
  // must not rewrite what an old run meant.
  assert.deepEqual(c.required, []);
  const b = shape.steps.find((s) => s.jobType === 'b');
  assert.deepEqual(b.required, ['a']);
});

test('downstreamOf never returns its own roots', () => {
  assert.deepEqual([...pipelineRuns.downstreamOf(PIPELINE, ['a'])], ['b', 'c']);
  assert.deepEqual([...pipelineRuns.downstreamOf(PIPELINE, ['c'])], []);
  // A step reachable from two roots appears once.
  assert.deepEqual([...pipelineRuns.downstreamOf(PIPELINE, ['a', 'b'])], ['c']);
});

test('a cycle in the pipeline terminates rather than hanging', () => {
  const cyclic = [
    { jobType: 'x', dependsOn: ['y'] },
    { jobType: 'y', dependsOn: ['x'] }
  ];
  assert.deepEqual([...pipelineRuns.downstreamOf(cyclic, ['x'])], ['y']);
});
