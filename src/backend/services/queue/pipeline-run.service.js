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
 * @param {string} [params.cause] - one of PipelineRun.CAUSES. Defaulted from
 *   whether the round has a run already: the first is `create_submission`, a
 *   later one `restart`. A caller that knows better — a replaced manuscript is
 *   `new_document`, not a restart — says so.
 * @param {string} [params.userId] - null when nobody asked
 * @param {string} [params.paramsSource] - 'live' (default) | 'frozen'. Frozen
 *   runs each re-executed step with the parameters its parent's execution
 *   recorded, so a disagreement cannot be blamed on a prompt edited since.
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
  paramsSource = 'live',
  transaction
}) {
  const { PipelineRun, PipelineRunStep, sequelize } = require('../../models');

  const { CAUSES } = require('../../models/PipelineRun');

  if (!pipeline?.length) throw new Error('newRun needs a pipeline');
  if (cause && !Object.values(CAUSES).includes(cause)) {
    // Checked here because PipelineRun.open inserts through raw SQL — the
    // model's own validator never sees it, and a typo would become a cause
    // nothing filters on and nobody notices.
    throw new Error(`newRun: unknown cause ${cause}`);
  }

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
      cause: cause || (parent ? CAUSES.RESTART : CAUSES.CREATE_SUBMISSION),
      causedByUserId: userId || null,
      parentRunId: parent?.id || null,
      shape: captureShape(pipeline),
      appVersion: appVersion(),
      paramsSource
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
      cause: created.cause,
      paramsSource: created.paramsSource,
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
 * Called when a step starts, and the point at which the run's placeholder stops
 * being a placeholder. Two anomalies are reported rather than absorbed, because
 * both leave a run that still reads as complete:
 *
 *   - **no membership row.** The run never declared this step, so the execution
 *     exists reachable from nothing.
 *   - **a row that already points somewhere.** A step executes at most once per
 *     run — a retry opens a NEW run — so a second execution here means an
 *     enqueue happened twice, and the first execution is about to become
 *     invisible while still costing whatever it cost. The link is replaced,
 *     since the later execution is the one the run actually used, but not
 *     quietly: the s3 prefix is keyed on the run number, so the two share it.
 *
 * @param {string} pipelineRunId
 * @param {string} jobType
 * @param {string} stepExecutionId
 * @param {object} [options] - `transaction`
 * @returns {Promise<number>} rows updated
 */
async function attachExecution(pipelineRunId, jobType, stepExecutionId, options = {}) {
  const { PipelineRunStep } = require('../../models');

  const existing = await PipelineRunStep.findOne({
    where: { pipelineRunId, jobType },
    transaction: options.transaction
  });

  if (!existing) {
    logger.error('Pipeline run: an execution has no place in its run', {
      pipelineRunId, jobType, stepExecutionId
    });
    return 0;
  }
  if (existing.stepExecutionId && existing.stepExecutionId !== stepExecutionId) {
    logger.error('Pipeline run: a step executed twice in one run', {
      pipelineRunId, jobType, replaced: existing.stepExecutionId, with: stepExecutionId
    });
  }

  return PipelineRunStep.attach(pipelineRunId, jobType, stepExecutionId, options);
}

/**
 * Columns too heavy to send in a list.
 *
 * The payloads are megabytes and a list shows none of them; a run selector that
 * downloaded every past result to draw ten rows would be unusable on exactly
 * the submissions worth looking at.
 *
 * `attempts` is deliberately NOT here. It is bounded — a few hundred bytes on a
 * healthy run — and the list is where "this one struggled" needs to be visible,
 * so excluding it made every row report zero tries while the detail view
 * reported three.
 */
const HEAVY = ['result', 'logs', 'inputs'];

/**
 * Columns the LIST needs even though they are JSONB.
 *
 * `attempts` and `discarded` are both bounded and both answer "did this one go
 * badly", which is exactly what a run picker has to show. Excluding them made
 * every row report zero tries while the detail view reported three.
 */

/**
 * Turn a membership row into what a caller needs to know about that step in
 * that run.
 *
 * `carriedOver` and `producedByRun` are the pair that keeps a run honest. An
 * execution can appear in several runs — that is the point of linking rather
 * than copying — and a page that showed run 3's number over run 1's result
 * without saying so is the "why does this still say 14 items when I just
 * re-ran it" question, back again in a new place.
 *
 * @param {object} member - PipelineRunStep with `pipelineRun` and `execution`
 * @returns {object}
 */
function describeMembership(member) {
  const run = member.pipelineRun;
  const execution = member.execution;
  return {
    runNumber: run.runNumber,
    cause: run.cause,
    runStatus: run.status,
    startedRunAt: run.createdAt,
    jobType: member.jobType,
    carriedOver: member.carriedOver,
    // Which run actually did the work. Equal to runNumber unless carried over,
    // and null when nothing has done the work yet — a step the run has not
    // reached has no producer, and naming itself would read as "run 2 produced
    // this" beside an empty result.
    producedByRun: execution ? (execution.pipelineRun?.runNumber ?? run.runNumber) : null,
    execution: execution || null
  };
}

/**
 * Every pipeline run of a round that contains one step, newest first.
 *
 * Replaces "every run of this step". The difference is not cosmetic: a step
 * that was carried over did not run again, and under the old per-step numbering
 * it simply did not appear — so a user comparing run 2 with run 3 saw the step
 * vanish rather than being told it was unchanged.
 *
 * @param {string} submissionId
 * @param {number} round
 * @param {string} jobType
 * @param {object} [options]
 * @param {boolean} [options.metadataOnly] - drop the megabyte columns
 * @returns {Promise<object[]>}
 */
async function runsForStep(submissionId, round, jobType, { metadataOnly = false } = {}) {
  const { PipelineRun, PipelineRunStep, StepExecution } = require('../../models');

  const members = await PipelineRunStep.findAll({
    where: { jobType },
    include: [
      {
        model: PipelineRun,
        as: 'pipelineRun',
        where: { submissionId, round },
        required: true
      },
      {
        model: StepExecution,
        as: 'execution',
        required: false,
        ...(metadataOnly ? { attributes: { exclude: HEAVY } } : {}),
        // The run that CREATED it, so a carried-over step can name where its
        // result came from.
        include: [{ model: PipelineRun, as: 'pipelineRun', attributes: ['runNumber'] }]
      }
    ],
    order: [[{ model: PipelineRun, as: 'pipelineRun' }, 'run_number', 'DESC']]
  });

  return members.map(describeMembership);
}

/**
 * One step, as it stands in one run.
 *
 * @param {string} submissionId
 * @param {number} round
 * @param {string} jobType
 * @param {number} runNumber
 * @returns {Promise<object|null>}
 */
async function stepInRun(submissionId, round, jobType, runNumber) {
  const { PipelineRun, PipelineRunStep, StepExecution } = require('../../models');

  const member = await PipelineRunStep.findOne({
    where: { jobType },
    include: [
      {
        model: PipelineRun,
        as: 'pipelineRun',
        where: { submissionId, round, runNumber },
        required: true
      },
      {
        model: StepExecution,
        as: 'execution',
        required: false,
        include: [{ model: PipelineRun, as: 'pipelineRun', attributes: ['runNumber'] }]
      }
    ]
  });

  return member ? describeMembership(member) : null;
}

/**
 * The parameters a step should run with, when its run says `frozen`.
 *
 * Read from the PARENT run's execution — the one being replaced. The record is
 * on S3 in the run's frozen inputs, so this is one fetch per step and only on a
 * frozen restart.
 *
 * Never throws. A frozen restart that cannot find its parent's record runs
 * live, and says so: the alternative is failing a run the user asked for over
 * an artefact that may simply predate the feature.
 *
 * @param {string} submissionId
 * @param {number} round
 * @param {string} jobType
 * @returns {Promise<{call: object|null, promptText: string|null, assembledSha256: string|null, fromRun: number}|null>}
 */
async function frozenParamsFor(submissionId, round, jobType) {
  const logger = require('../../utils/logger');
  try {
    const run = await currentRun(submissionId, round);
    if (!run?.parentRunId) return null;

    const { PipelineRun } = require('../../models');
    const parent = await PipelineRun.findByPk(run.parentRunId);
    if (!parent) return null;

    const entry = await stepInRun(submissionId, round, jobType, parent.runNumber);
    const key = entry?.execution?.result?.files?.inputs;
    if (!key) return null;

    const s3 = require('../storage/s3.service');
    const inputs = JSON.parse((await s3.downloadFile(key)).toString('utf-8'));
    return {
      call: inputs.call || null,
      promptText: inputs.prompt?.templateText || null,
      assembledSha256: inputs.prompt?.assembledSha256 || null,
      fromRun: parent.runNumber
    };
  } catch (error) {
    logger.warn('Frozen restart: could not read the parent run\'s parameters', {
      submissionId, round, jobType, error: error.message
    });
    return null;
  }
}

/**
 * One step, as it stands in the run the round is currently in.
 *
 * The common case, spelled once: "which execution does this step have right
 * now" is what the decision path asks, and writing it out at the call site
 * meant an awaited expression nested inside another one.
 *
 * @param {string} submissionId
 * @param {number} round
 * @param {string} jobType
 * @returns {Promise<object|null>}
 */
async function currentStepInRun(submissionId, round, jobType) {
  const run = await currentRun(submissionId, round);
  if (!run) return null;
  return stepInRun(submissionId, round, jobType, run.runNumber);
}

/**
 * Every run of a round, with what each one contains — the submission-wide view.
 *
 * This is what "show me run 1" means once a run is the unit: one number across
 * every module, rather than a different number per module that happens to be
 * displayed in the same place.
 *
 * @param {string} submissionId
 * @param {number} round
 * @returns {Promise<object[]>} newest first
 */
async function runsForSubmission(submissionId, round) {
  const { PipelineRun, PipelineRunStep, StepExecution, User } = require('../../models');

  const runs = await PipelineRun.findAll({
    where: { submissionId, round },
    order: [['runNumber', 'DESC']],
    include: [
      { model: User, as: 'causedBy', attributes: ['id', 'name', 'email'], required: false },
      {
        model: PipelineRunStep,
        as: 'steps',
        required: false,
        include: [{
          model: StepExecution,
          as: 'execution',
          required: false,
          attributes: { exclude: HEAVY }
        }]
      }
    ]
  });

  return runs.map((run) => ({
    runNumber: run.runNumber,
    cause: run.cause,
    status: run.status,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    pipelineVersion: run.pipelineVersion,
    appVersion: run.appVersion,
    // Named, or falling back to the email — but never left blank. "A run
    // nobody caused" and "a run whose user has no display name" are different
    // things, and only the first should read as null.
    causedBy: run.causedBy
      ? { id: run.causedBy.id, name: run.causedBy.name || run.causedBy.email }
      : null,
    steps: (run.steps || []).map((member) => ({
      jobType: member.jobType,
      carriedOver: member.carriedOver,
      status: member.execution?.status || 'not_started',
      outcomeState: member.execution?.outcomeState || null,
      counts: member.execution?.counts || null,
      durationMs: member.execution?.durationMs || null
    }))
  }));
}

module.exports = {
  newRun,
  currentRun,
  attachExecution,
  downstreamOf,
  captureShape,
  appVersion,
  runsForStep,
  stepInRun,
  frozenParamsFor,
  currentStepInRun,
  runsForSubmission
};
