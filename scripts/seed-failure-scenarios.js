#!/usr/bin/env node
/**
 * Submissions stuck in each of the ways a failure can stall the pipeline.
 *
 * A failure now HOLDS the steps that depend on it until somebody chooses Retry
 * or Continue. That is hard to exercise by hand: you would have to break a real
 * external service at the right moment, and the interesting states (two
 * failures, a decision already recorded, a failure that blocks nothing) are
 * combinations you cannot reach on demand at all.
 *
 * So this clones a FINISHED submission and rewrites the job statuses of the
 * copy. Cloning rather than generating, because a generated submission renders
 * empty pages: the point is to see the banner over real cards, with real
 * results underneath and a real Technical detail panel.
 *
 * ── What it touches ─────────────────────────────────────────────────────────
 *
 * INSERTS ONLY, into `submissions`, `files`, `krt_data`, `submission_jobs`,
 * `step_executions` and `submission_input_freezes`. The source submission
 * is read and never modified. Every row it creates is titled with the marker
 * below, so `--clean` can find and remove exactly them and nothing else.
 *
 * The copies point at the SOURCE's S3 objects — the same manuscript, the same
 * artefacts — because duplicating megabytes to test a banner would be silly.
 * Opening an artefact from a copy therefore serves the original's file, which
 * is correct for everything except a test of S3 isolation.
 *
 * Usage:
 *   node scripts/seed-failure-scenarios.js [--source <submissionId>] [--owner <email>]
 *   node scripts/seed-failure-scenarios.js --clean     # remove them again
 *   node scripts/seed-failure-scenarios.js --list
 */

'use strict';

const { randomUUID } = require('crypto');
const { Op } = require('sequelize');

const {
  Submission, File, KRTData, SubmissionJob, StepExecution, SubmissionInputFreeze,
  PipelineRun, PipelineRunStep,
  User, sequelize
} = require('../src/backend/models');
const { JOB_TYPES } = require('../src/backend/config/constants');

/** Every seeded submission is titled with this, and `--clean` deletes by it. */
const MARKER = '[FAILURE TEST]';

/**
 * The scenarios, each one a state the UI has to describe correctly.
 *
 * `failed` is the step that broke; `acknowledged` records a decision already
 * made about it. Everything downstream of a still-undecided failure is set to
 * `waiting`, which is what the orchestrator itself would do.
 */
const SCENARIOS = [
  {
    key: 'blocked-early',
    name: 'Conversion failed — the whole round is held',
    failed: [{ jobType: JOB_TYPES.MARKDOWN_CONVERT, error: 'Converter returned 503 Service Unavailable' }],
    note: 'The banner should name Markdown Convert and count 9 steps behind it. '
      + 'Its page should offer Retry (enabled) and Continue without it.'
  },
  {
    key: 'blocked-detector',
    name: 'One detector failed — the consolidator is held',
    failed: [{ jobType: JOB_TYPES.MATERIALS_DETECTION, error: 'Gemini 429: rate limit exceeded' }],
    note: 'Only KRT Grounding, PDF Analysis and AI Suggestions should be waiting; '
      + 'the other detectors keep their results.'
  },
  {
    key: 'blocked-twice',
    name: 'Two detectors failed — two decisions to make',
    failed: [
      { jobType: JOB_TYPES.SOFTWARE_DETECTION, error: 'Softcite timed out after 120s' },
      { jobType: JOB_TYPES.PROTOCOLS_DETECTION, error: 'Gemini 500: internal error' }
    ],
    note: 'The banner should list both. Continuing past one must leave the pipeline '
      + 'still paused by the other.'
  },
  {
    key: 'decision-recorded',
    name: 'A failure already waved through',
    failed: [{
      jobType: JOB_TYPES.DATASETS_DETECTION,
      error: 'Gemini 503: model overloaded',
      acknowledged: true
    }],
    note: 'No banner: the decision is made and the pipeline ran on without it. '
      + 'The step stays failed, and Continue is gone from its page.'
  },
  {
    key: 'failed-leaf',
    name: 'A failure that blocks nothing',
    failed: [{ jobType: JOB_TYPES.SUGGESTION_GENERATION, error: 'Gemini 503: model overloaded' }],
    note: 'Nothing depends on it, so there is no pause and no banner — but Retry '
      + 'is still offered, which is the case a fixed service most often leaves.'
  }
];

/** Steps that depend on `jobType`, directly or through another. */
function downstreamOf(pipeline, jobType) {
  const found = new Set();
  let frontier = new Set([jobType]);
  while (frontier.size) {
    const next = new Set();
    for (const step of pipeline) {
      if (step.dependsOn.some((d) => frontier.has(d)) && !found.has(step.jobType)) {
        found.add(step.jobType);
        next.add(step.jobType);
      }
    }
    frontier = next;
  }
  return found;
}

async function clean() {
  const doomed = await Submission.findAll({
    where: sequelize.where(sequelize.col('title'), 'LIKE', `${MARKER}%`),
    attributes: ['id', 'title']
  });
  if (!doomed.length) {
    console.log('Nothing to clean — no submission is titled with the marker.');
    return;
  }
  const ids = doomed.map((s) => s.id);
  // Children first: the schema cascades from `submissions`, but being explicit
  // means a partial failure leaves nothing dangling and the counts are visible.
  await sequelize.transaction(async (t) => {
    // Membership BEFORE executions: `pipeline_run_steps.step_execution_id` is
    // ON DELETE RESTRICT, so the database refuses to let a run be hollowed out
    // — which is the point of the constraint, and the reason for this order.
    const runIds = (await PipelineRun.findAll({
      where: { submissionId: ids }, attributes: ['id'], transaction: t
    })).map((r) => r.id);
    if (runIds.length) {
      await PipelineRunStep.destroy({ where: { pipelineRunId: runIds }, transaction: t });
    }
    await StepExecution.destroy({ where: { submissionId: ids }, transaction: t });
    await PipelineRun.destroy({ where: { submissionId: ids }, transaction: t });
    await SubmissionInputFreeze.destroy({ where: { submissionId: ids }, transaction: t });
    await SubmissionJob.destroy({ where: { submissionId: ids }, transaction: t });
    await KRTData.destroy({ where: { submissionId: ids }, transaction: t });
    await File.destroy({ where: { submissionId: ids }, transaction: t });
    await Submission.destroy({ where: { id: ids }, transaction: t });
  });
  for (const s of doomed) console.log(`  removed  ${s.title}`);
  console.log(`\n${doomed.length} seeded submission(s) removed.`);
}

async function list() {
  const seeded = await Submission.findAll({
    where: sequelize.where(sequelize.col('title'), 'LIKE', `${MARKER}%`),
    attributes: ['id', 'title', 'status'],
    order: [['createdAt', 'ASC']]
  });
  if (!seeded.length) return console.log('None.');
  for (const s of seeded) console.log(`  ${s.id}  ${s.title}`);
}

/**
 * Clone one submission and break it according to a scenario.
 *
 * @param {object} source - the finished submission being copied
 * @param {object} scenario
 * @param {string} ownerId
 * @param {Array} pipeline
 */
async function buildScenario(source, scenario, ownerId, pipeline) {
  const newId = randomUUID();
  const fileIdMap = new Map();

  await sequelize.transaction(async (t) => {
    // `{ ...x }`, not `x`. Sequelize's `get({ plain: true })` hands back the
    // instance's own `dataValues` when the model has no custom getters, so
    // `delete plain.id` deletes the SOURCE's id — and every query below it then
    // asks for `submission_id = undefined`. Copied here, and at every other
    // `.get()` in this file, for the same reason.
    const plain = { ...source.get({ plain: true }) };
    delete plain.id;
    await Submission.create({
      ...plain,
      id: newId,
      userId: ownerId,
      title: `${MARKER} ${scenario.name}`,
      // A distinct manuscript id keeps the dashboard readable and avoids
      // pretending two submissions are the same paper.
      manuscriptId: null,
      createdAt: new Date(),
      updatedAt: new Date()
    }, { transaction: t });

    // Files by reference: the copies point at the source's S3 objects.
    for (const file of await File.findAll({ where: { submissionId: source.id }, transaction: t })) {
      const copyId = randomUUID();
      fileIdMap.set(file.id, copyId);
      const row = { ...file.get({ plain: true }) };
      delete row.id;
      await File.create({ ...row, id: copyId, submissionId: newId }, { transaction: t });
    }

    for (const krt of await KRTData.findAll({ where: { submissionId: source.id }, transaction: t })) {
      const row = { ...krt.get({ plain: true }) };
      delete row.id;
      await KRTData.create({ ...row, submissionId: newId }, { transaction: t });
    }

    for (const freeze of await SubmissionInputFreeze.findAll({
      where: { submissionId: source.id }, transaction: t
    })) {
      const row = { ...freeze.get({ plain: true }) };
      delete row.id;
      await SubmissionInputFreeze.create({
        ...row,
        submissionId: newId,
        fileId: fileIdMap.get(row.fileId) || null
      }, { transaction: t });
    }

    // One pipeline run for the whole clone. Built by hand rather than through
    // `newRun`, because the scenario is a run that ALREADY happened and ended
    // in this state — asking the real service for it would open a fresh run
    // with nothing in it and then need every field overwritten anyway.
    const pipelineRun = await PipelineRun.create({
      submissionId: newId,
      round: source.currentRound || 1,
      runNumber: 1,
      cause: 'create_submission',
      causedByUserId: ownerId,
      // `paused` is the truthful status for every one of these: a step failed
      // and the steps behind it are waiting for somebody to decide.
      status: scenario.failed.length ? 'paused' : 'complete',
      appVersion: 'seed'
    }, { transaction: t });

    // The jobs, rewritten to the scenario.
    const broken = new Map(scenario.failed.map((f) => [f.jobType, f]));
    const held = new Set();
    for (const f of scenario.failed) {
      if (f.acknowledged) continue;   // a decided failure holds nothing
      for (const t2 of downstreamOf(pipeline, f.jobType)) held.add(t2);
    }

    for (const job of await SubmissionJob.findAll({ where: { submissionId: source.id }, transaction: t })) {
      const row = { ...job.get({ plain: true }) };
      delete row.id;
      const newJobId = randomUUID();
      const failure = broken.get(row.jobType);

      if (failure) {
        Object.assign(row, {
          status: 'failed',
          errorMessage: failure.error,
          result: null,
          // Both timestamps, or the copy inherits the source's `startedAt` and
          // reports a duration measured in days.
          startedAt: new Date(Date.now() - 4000),
          completedAt: new Date(),
          // `issue_`, not `failure_`: a PARTIAL holds the pipeline too, so the
          // columns stopped being about failures. Sequelize drops attributes a
          // model does not declare, so the old names here meant every
          // "acknowledged" scenario seeded as undecided and looked identical to
          // the one beside it.
          issueAcknowledgedAt: failure.acknowledged ? new Date() : null,
          issueAcknowledgedByUserId: failure.acknowledged ? ownerId : null
        });
      } else if (held.has(row.jobType)) {
        // Exactly what the orchestrator leaves behind: waiting, with nothing
        // from a run that has not happened.
        Object.assign(row, {
          status: 'waiting',
          errorMessage: null,
          result: null,
          startedAt: null,
          completedAt: null,
          pgBossJobId: null
        });
      }

      await SubmissionJob.create({ ...row, id: newJobId, submissionId: newId }, { transaction: t });

      // Every step gets a membership row, including the ones that never ran —
      // a run that lists only what finished cannot be read while it is paused,
      // which is the state every one of these scenarios is in.
      let executionId = null;

      // History, so the run selector and METADATA column have something real.
      // Only for steps that still hold a result — a held step has no run.
      if (!failure && !held.has(row.jobType)) {
        for (const run of await StepExecution.findAll({
          where: { submissionJobId: job.id }, transaction: t
        })) {
          const runRow = { ...run.get({ plain: true }) };
          delete runRow.id;
          const copy = await StepExecution.create({
            ...runRow,
            submissionJobId: newJobId,
            submissionId: newId,
            pipelineRunId: pipelineRun.id
          }, { transaction: t });
          executionId = copy.id;
        }
      }

      await PipelineRunStep.create({
        pipelineRunId: pipelineRun.id,
        jobType: row.jobType,
        stepExecutionId: executionId,
        carriedOver: false
      }, { transaction: t });
    }
  });

  return newId;
}

async function main() {
  // This writes submissions. It exists to make a UI state reachable, and there
  // is no UI state worth reaching in production.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed test submissions in production.');
  }

  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
  };

  if (args.includes('--clean')) return clean();
  if (args.includes('--list')) return list();

  const ownerEmail = flag('--owner') || 'annotator@example.com';
  const owner = await User.findOne({ where: { email: ownerEmail } });
  if (!owner) throw new Error(`No user with email ${ownerEmail}`);

  const sourceId = flag('--source');
  const source = sourceId
    ? await Submission.findByPk(sourceId)
    // Any finished round will do; the newest is the most likely to have every
    // column this branch added.
    //
    // Never one of ours. The seeds ARE the newest submissions the moment they
    // exist, so without this the second run clones the first's broken states
    // and every scenario inherits failures it did not ask for — which is
    // exactly what happened the first time.
    : await Submission.findOne({
      where: {
        status: ['step_as', 'step_report', 'completed'],
        title: { [Op.notLike]: `${MARKER}%` }
      },
      order: [['updatedAt', 'DESC']]
    });
  if (!source) throw new Error('No finished submission to clone. Run one through the pipeline first.');

  const orchestrator = require('../src/backend/services/queue/orchestrator.service');
  const pipeline = orchestrator.PIPELINE;

  console.log(`Cloning ${source.manuscriptId || source.id} for ${owner.email}\n`);

  // Anything already wrong with the source is inherited by every copy, and a
  // tester counting badges deserves to know which ones are not the scenario.
  // A module can COMPLETE with a failed outcome — Softcite down, demo data off
  // — and the card says "failed" for that too, correctly.
  const inherited = (await SubmissionJob.findAll({ where: { submissionId: source.id } }))
    .filter((j) => j.status !== 'complete' || (j.result?.service?.outcome?.state || 'done') !== 'done')
    .map((j) => `${j.jobType} (${j.status}${j.result?.service?.outcome?.state === 'fail' ? ', failed outcome' : ''})`);
  if (inherited.length) {
    console.log('  Inherited from the source, in EVERY scenario below:');
    for (const line of inherited) console.log(`    ${line}`);
    console.log('');
  }
  for (const scenario of SCENARIOS) {
    const id = await buildScenario(source, scenario, owner.id, pipeline);
    console.log(`  ${scenario.name}`);
    console.log(`    /submissions/${id}/pipeline`);
    console.log(`    ${scenario.note}\n`);
  }
  console.log(`${SCENARIOS.length} submissions created. Remove them with --clean.`);
}

main()
  .then(() => sequelize.close())
  .catch(async (err) => {
    console.error(err.stack || err.message);
    await sequelize.close();
    process.exit(1);
  });
