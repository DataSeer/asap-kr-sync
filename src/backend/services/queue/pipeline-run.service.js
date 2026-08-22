/**
 * Creating a pipeline run — the one operation the pipeline actually has.
 *
 * Starting a submission, retrying a failed step, restarting a selection of
 * modules, uploading a replacement PDF and replaying an old run are the same
 * act with two parameters changed: which steps re-execute, and which inputs are
 * inherited. Retry and restart were separate mechanisms with separate bugs;
 * here they differ only by `cause` and by the set handed to `reRun`.
 *
 *   | operation           | reRun          | inputs             |
 *   |---------------------|----------------|--------------------|
 *   | create submission   | everything     | current            |
 *   | retry one step      | [step]         | inherit            |
 *   | restart from here   | [step]         | inherit or chosen  |
 *   | restart a selection | the picked set | inherit or chosen  |
 *   | new document        | everything     | current            |
 *   | replay              | everything     | inherit, with the parent's config |
 *
 * ── Deliberately independent of this application ────────────────────────────
 *
 * Nothing here imports the pipeline. The step list is a parameter, described by
 * `{ jobType, dependsOn, optional }`, so this file is liftable into another
 * project unchanged — which is the point: the model is the reusable part, the
 * twelve steps are not.
 */

const logger = require('../../utils/logger');

/**
 * Everything downstream of a set of steps, transitively.
 *
 * @param {object[]} pipeline - `{ jobType, dependsOn }`
 * @param {Iterable<string>} roots
 * @returns {Set<string>} does NOT include the roots themselves
 */
function downstreamOf(pipeline, roots) {
  const downstream = new Set();
  let frontier = new Set(roots);
  while (frontier.size) {
    const next = new Set();
    for (const step of pipeline) {
      if (downstream.has(step.jobType)) continue;
      if (!step.dependsOn?.some((dep) => frontier.has(dep))) continue;
      downstream.add(step.jobType);
      next.add(step.jobType);
    }
    frontier = next;
  }
  for (const root of roots) downstream.delete(root);
  return downstream;
}

/**
 * The version of the code that produced a run. Provenance only.
 *
 * Never read to decide whether a run can be understood — that is
 * `pipelineVersion`'s job, and conflating the two turns every deploy into a
 * history wipe.
 */
function appVersion() {
  const pkg = require('../../../../package.json');
  const sha = process.env.GIT_SHA || process.env.SOURCE_COMMIT;
  return sha ? `${pkg.version}+${sha.slice(0, 12)}` : pkg.version;
}

/**
 * The pipeline as it stands right now.
 *
 * Recorded on the run because a step's own config is written when the module
 * FINISHES — so a step that never ran has none, and on a blocked round exactly
 * one step in twelve carries a config record. Without this, "was software
 * detection switched off during run 2" is unanswerable precisely when somebody
 * needs to ask it, and "identifier detection is absent from this run" cannot be
 * told apart from "identifier detection did not exist yet".
 *
 * `required` is stored even though it is derivable from `dependsOn` minus
 * `optional`: storing it means a later change to that derivation rule cannot
 * silently rewrite what old runs meant.
 *
 * Never throws. A run whose shape could not be captured is worth far more than
 * no run, and the failure is visible in the log and as a null column.
 *
 * @param {object[]} pipeline
 * @returns {object}
 */
function captureShape(pipeline) {
  let configOf = () => null;
  try {
    // Lazily, and from inside the function: workers.js loads the orchestrator,
    // which loads this file. At call time the cycle is resolved.
    const { SERVICE_CFG, buildServiceSnapshot } = require('./workers');
    configOf = (jobType) => (SERVICE_CFG[jobType]
      ? buildServiceSnapshot(jobType, null).config
      : null);
  } catch (error) {
    logger.warn('Pipeline run: could not read module configuration for the shape', {
      error: error.message
    });
  }

  return {
    capturedAt: new Date().toISOString(),
    steps: pipeline.map((step) => {
      const optional = step.optional || [];
      let config = null;
      try {
        config = configOf(step.jobType);
      } catch (error) {
        logger.warn('Pipeline run: could not read one module\'s configuration', {
          jobType: step.jobType, error: error.message
        });
      }
      return {
        jobType: step.jobType,
        dependsOn: step.dependsOn || [],
        optional,
        required: (step.dependsOn || []).filter((dep) => !optional.includes(dep)),
        config
      };
    })
  };
}

/**
 * Open a new pipeline run.
 *
 * ── Why downstream expansion is not negotiable ──────────────────────────────
 *
 * A result carried over from the parent was built WITHOUT whatever is being
 * re-run. Grounding computed before software detection is re-run is stale the
 * moment software succeeds, and carrying it over would present a mixed answer
 * as a coherent one — the exact failure this model exists to prevent. So the
 * caller's `reRun` set is only a seed.
 *
 * ── Why a step with no parent execution joins the re-run set ────────────────
 *
 * A step the parent never got to — still waiting when the run was superseded —
 * has nothing to carry. Marking it carried-over would hand the new run a hole
 * that looks like a decision, and it would never execute, because nothing else
 * is going to enqueue it.
 *
 * @param {object} params
 * @param {string} params.submissionId
 * @param {number} [params.round]
 * @param {object[]} params.pipeline - `{ jobType, dependsOn, optional }`
 * @param {string[]|'all'} params.reRun - the seed set, expanded downstream
 * @param {string} params.cause - one of PipelineRun.CAUSES
 * @param {string} [params.userId] - null when nobody asked
 * @param {object} [params.transaction]
 * @returns {Promise<{run: object, reRun: string[], carriedOver: string[], parent: object|null}>}
 */
async function newRun({
  submissionId,
  round = 1,
  pipeline,
  reRun,
  cause,
  userId = null,
  transaction
}) {
  const { PipelineRun, PipelineRunStep, sequelize } = require('../../models');

  if (!pipeline?.length) throw new Error('newRun needs a pipeline');
  if (!cause) throw new Error('newRun needs a cause');

  const allTypes = pipeline.map((step) => step.jobType);
  const unknown = (reRun === 'all' ? [] : reRun).filter((t) => !allTypes.includes(t));
  if (unknown.length) throw new Error(`newRun: unknown step(s) ${unknown.join(', ')}`);

  const run = async (t) => {
    const parent = await PipelineRun.current(submissionId, round, { transaction: t });

    // What the parent can actually hand over. A run with no parent hands over
    // nothing, so everything executes — which is what starting a submission is.
    const inherited = new Map();
    if (parent) {
      for (const member of await PipelineRunStep.findAll({
        where: { pipelineRunId: parent.id },
        transaction: t
      })) {
        if (member.stepExecutionId) inherited.set(member.jobType, member.stepExecutionId);
      }
    }

    const seed = reRun === 'all' ? new Set(allTypes) : new Set(reRun);
    for (const step of downstreamOf(pipeline, seed)) seed.add(step);
    // Anything the parent cannot hand over has to be executed by this run.
    for (const jobType of allTypes) if (!inherited.has(jobType)) seed.add(jobType);

    const toExecute = allTypes.filter((jobType) => seed.has(jobType));
    const carriedOver = allTypes.filter((jobType) => !seed.has(jobType));

    const created = await PipelineRun.open({
      submissionId,
      round,
      cause,
      causedByUserId: userId || null,
      parentRunId: parent?.id || null,
      shape: captureShape(pipeline),
      appVersion: appVersion()
    }, { transaction: t });

    // One membership row per step, from the start. A run that lists only what
    // has finished cannot be read while it is running.
    await PipelineRunStep.bulkCreate(allTypes.map((jobType) => ({
      pipelineRunId: created.id,
      jobType,
      stepExecutionId: carriedOver.includes(jobType) ? inherited.get(jobType) : null,
      carriedOver: carriedOver.includes(jobType)
    })), { transaction: t });

    // A run replaced before it finished is neither complete nor abandoned.
    if (parent && ['running', 'paused'].includes(parent.status)) {
      await parent.update({ status: 'superseded' }, { transaction: t });
    }

    logger.info('Pipeline run opened', {
      submissionId,
      round,
      runNumber: created.runNumber,
      cause,
      parentRun: parent?.runNumber ?? null,
      executing: toExecute.length,
      carriedOver: carriedOver.length
    });

    return { run: created, reRun: toExecute, carriedOver, parent: parent || null };
  };

  // One transaction, always: a run whose membership rows are missing describes
  // an attempt that contains no steps, and every screen built on this model
  // would read it as an empty pipeline rather than as a broken record.
  return transaction ? run(transaction) : sequelize.transaction(run);
}

/**
 * The run a submission is currently living in, for a round.
 *
 * @param {string} submissionId
 * @param {number} round
 * @returns {Promise<object|null>}
 */
async function currentRun(submissionId, round) {
  const { PipelineRun } = require('../../models');
  return PipelineRun.current(submissionId, round);
}

/**
 * Attach an execution to its place in the run.
 *
 * Called when a step starts. Zero rows updated means the run never declared
 * this step — a real fault, logged rather than swallowed, because the
 * execution then exists without being reachable from any run.
 *
 * @param {string} pipelineRunId
 * @param {string} jobType
 * @param {string} stepExecutionId
 * @param {object} [options] - `transaction`
 */
async function attachExecution(pipelineRunId, jobType, stepExecutionId, options = {}) {
  const { PipelineRunStep } = require('../../models');
  const updated = await PipelineRunStep.attach(pipelineRunId, jobType, stepExecutionId, options);
  if (!updated) {
    logger.error('Pipeline run: an execution has no place in its run', {
      pipelineRunId, jobType, stepExecutionId
    });
  }
  return updated;
}

module.exports = {
  newRun,
  currentRun,
  attachExecution,
  downstreamOf,
  captureShape,
  appVersion
};
