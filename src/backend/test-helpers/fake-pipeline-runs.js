/**
 * Stub the pipeline-run layer, for tests about the SCHEDULER.
 *
 * Every entry point — start, restart, retry, a replaced PDF — opens a pipeline
 * run before it enqueues anything, and every enqueue files its execution under
 * that run. Both touch the database. A test about "does re-running a step reuse
 * the round's job row" has no opinion about either and should not need one, so
 * this replaces the whole layer with something that records the calls.
 *
 * Stubbed at the SERVICE and not at the models: the orchestrator holds a module
 * reference and calls `pipelineRuns.newRun(...)`, so replacing the method is
 * enough, and a test that stubbed `PipelineRun.open` instead would still run
 * the real transaction, the real parent lookup and the real shape capture — all
 * of which reach for a connection.
 *
 * What it deliberately does NOT do is pretend to be correct. `newRun` here
 * carries none of the real rules — no downstream expansion, no supersede — so a
 * test that wants those must use the real service against real fakes. This is
 * for the tests that need the layer to be out of the way.
 *
 * @example
 *   const runs = fakePipelineRuns(t);
 *   await orchestrator.retryStep('sub-1', 'software_detection', 1, 'user-1');
 *   assert.equal(runs.created.length, 1);
 *   assert.equal(runs.created[0].cause, 'retry');
 */

/**
 * @param {object} t - the node:test context, so mocks are restored with it
 * @param {object} [opts]
 * @param {object|null} [opts.current] - what `currentRun` hands back
 * @returns {{created: object[], attached: object[], current: object, executions: object}}
 */
function fakePipelineRuns(t, { current } = {}) {
  const pipelineRuns = require('../services/queue/pipeline-run.service');

  const state = {
    created: [],
    attached: [],
    /**
     * jobType → the execution the current run holds for it.
     *
     * Materialised on demand rather than declared up front: a decision is
     * written to whichever step the test happens to act on, and requiring every
     * test to list its twelve steps first would be twelve lines of nothing.
     */
    executions: {},
    current: current === undefined
      ? { id: 'pipeline-run-1', runNumber: 1, status: 'running' }
      : current
  };

  const executionFor = (jobType) => {
    if (!state.executions[jobType]) {
      state.executions[jobType] = {
        id: `exec-${jobType}`,
        decision: null,
        async update(fields) { Object.assign(this, fields); return this; }
      };
    }
    return state.executions[jobType];
  };

  /**
   * Seed a decision already recorded against a step's execution.
   *
   * The execution is the source of truth for "has this been decided about", so
   * a test about deciding twice has to put the first decision where the code
   * will look for it — not on the job row, which is only a hydrated copy.
   */
  state.decide = (jobType, decision) => {
    executionFor(jobType).decision = decision;
    return state;
  };

  const entryFor = (jobType) => ({
    runNumber: state.current?.runNumber ?? 1,
    cause: 'create_submission',
    carriedOver: false,
    producedByRun: state.current?.runNumber ?? 1,
    jobType,
    execution: state.current ? executionFor(jobType) : null
  });

  t.mock.method(pipelineRuns, 'stepInRun', async (_sub, _round, jobType) => entryFor(jobType));
  t.mock.method(pipelineRuns, 'currentStepInRun', async (_sub, _round, jobType) => (
    state.current ? entryFor(jobType) : null
  ));

  t.mock.method(pipelineRuns, 'newRun', async (params) => {
    state.created.push(params);
    const run = {
      id: `pipeline-run-${state.created.length}`,
      runNumber: state.created.length,
      status: 'running'
    };
    state.current = run;
    return { run, reRun: [], carriedOver: [], parent: null };
  });

  t.mock.method(pipelineRuns, 'currentRun', async () => state.current);

  t.mock.method(pipelineRuns, 'attachExecution', async (pipelineRunId, jobType, stepExecutionId) => {
    state.attached.push({ pipelineRunId, jobType, stepExecutionId });
    return 1;
  });

  return state;
}

module.exports = { fakePipelineRuns };
