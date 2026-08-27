/**
 * Process Orchestrator
 *
 * Manages the execution order of the pipeline steps for a submission.
 * Defines a pipeline with dependencies — jobs only start when their
 * dependencies have reached a terminal state (complete or failed).
 */

const { Op } = require('sequelize');
const { sequelize, SubmissionJob, Submission } = require('../../models');
const { JOB_TYPES } = require('../../config/constants');
const { NotFoundError, ConflictError, ValidationError } = require('../../utils/errors');
const { NO_DAS_SENTINEL } = require('../das-suggestions/das-suggestions.service');
const jobQueue = require('./job-queue.service');
const logger = require('../../utils/logger');
const runHistory = require('./run-history.service');
const pipelineRuns = require('./pipeline-run.service');
const { CAUSES } = require('../../models/PipelineRun');

// Jobs younger than this are left alone by the reconciler — their dependencies
// may simply still be running, and we don't want to race a checkAndAdvance that
// just fired. A dropped advancement will still be older than this by the time
// the periodic sweep runs.
const RECONCILE_GRACE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Pipeline definition — single source of truth for process ordering.
 *
 * Each entry: { jobType, dependsOn: [...jobTypes], canAutoAdvance?, gate? }
 * Jobs with no dependencies start immediately.
 * Jobs with dependencies start when ALL dependencies reach a terminal state.
 *
 * canAutoAdvance(dependencyJobs): optional function.
 *   - Returns true → job is enqueued automatically.
 *   - Returns false → job is set to 'pending_input' (needs manual advance).
 *   - Omitted → always auto-advances.
 *
 * gate: optional name of a submission-state condition (see GATES). Unlike
 * canAutoAdvance (which parks the job as pending_input for a manual decision),
 * an unsatisfied gate keeps the job in `waiting`: it advances automatically
 * when the submission state changes (status-change handler and the periodic
 * reconciler both re-drive the pipeline).
 */

/**
 * Gates, by name. Each receives `(submission, jobsByType)` and returns whether
 * the gated step may start.
 *
 * A gate is not a failure: an unsatisfied one keeps the step in `waiting`, and
 * the reconciler re-checks it every sweep, so the step starts by itself the
 * moment the condition holds. That is the difference from `canAutoAdvance`,
 * which parks a step in `pending_input` awaiting a human decision.
 *
 * A step may list several (`gate: ['a', 'b']`); the first unsatisfied one is
 * what blocks it, and is what the jobs API reports.
 */
const GATES = {
  // Nothing that reads the author's KRT may start until the author has
  // finished curating it — i.e. the submission has moved past the KRT step
  // (draft/step_krt = still curating).
  //
  // This covers the five detection modules as well as grounding. Under the
  // default `seeded` pipeline the detectors are seeded WITH the author's rows,
  // so a detector that starts while the table is still being edited answers a
  // question about a KRT that no longer exists — and burns the LM call doing
  // it. PDF_ANALYSIS and SUGGESTION_GENERATION inherit the gate through their
  // dependencies.
  //
  // The gate is on submission STATE, not on the presence of a KRT: a
  // submission with no KRT at all passes it the moment the author moves on, so
  // the no-KRT mode is unaffected.
  krt_curated: (submission) => !['draft', 'step_krt'].includes(submission.status),

  // The Availability Statement check waits for the step it is about.
  //
  // Two conditions, one gate, because either alone would run it pointlessly:
  //
  //   - the submission has REACHED the Availability step. Before that the
  //     author is still editing the table the check reads, and the check's
  //     whole subject — their statement — is not in front of them yet.
  //   - there IS a statement to check. Extraction is fail-soft: it always
  //     persists something, writing NO_DAS_SENTINEL when it found nothing. The
  //     manual queue path already refused to run on that; now that the pipeline
  //     can start the job itself, the refusal has to live where the pipeline
  //     will see it, or every submission without a statement burns an LM call
  //     against an empty string.
  //
  // Reads the submission's CURRENT statement rather than the extraction result,
  // so an author who types one by hand releases the gate — the extraction
  // result still says "not found" and always will.
  availability_ready: (submission) => {
    if (!['step_as', 'step_report', 'completed'].includes(submission.status)) return false;
    const das = (submission.dataAvailabilityStatement || '').trim();
    return das.length > 0 && das !== NO_DAS_SENTINEL;
  }
};

/** A step's gates, however it declared them. */
const gatesOf = (step) => (Array.isArray(step.gate) ? step.gate : (step.gate ? [step.gate] : []));

/**
 * The first gate stopping this step, or null.
 *
 * @returns {string|null} gate name
 */
function blockingGate(step, submission, jobsByType) {
  for (const name of gatesOf(step)) {
    const fn = GATES[name];
    if (!fn) continue;
    if (submission && !fn(submission, jobsByType)) return name;
  }
  return null;
}
const PIPELINE = [
  // DAS extraction now reads the converted markdown (Gemini-based, replaces
  // the Modal Llama fine-tune that ate the PDF directly), so it depends on
  // MARKDOWN_CONVERT just like the other Gemini-based detectors.
  {
    jobType: JOB_TYPES.DAS_EXTRACTION,
    reads: ['markdown'],
    dependsOn: [JOB_TYPES.MARKDOWN_CONVERT],

    // Asking for extraction again is asking for a fresh reading of the
    // manuscript, so the working statement is cleared to make room for it.
    //
    // Without this the module would run and change nothing visible: the working
    // field is only filled while it is empty (see apply.service), so a
    // re-extraction on a submission that already has a statement — every new
    // round, every replaced PDF — would write to the extracted field alone and
    // look like it had done nothing.
    //
    // Only on a MANUAL restart. The pipeline running extraction as part of a
    // normal round must not wipe a statement somebody has already dealt with.
    //
    // Through the apply service rather than as three assignments, because this
    // DESTROYS data: a user who typed their own statement and then pressed
    // "re-run" loses it. Correct — they asked — but it is exactly the silent
    // pipeline write the apply split exists to end, so what was there is
    // recorded against whoever asked.
    async onManualRestart(submission, { userId, round } = {}) {
      await require('./apply.service').clearFromPipeline({
        submission,
        target: 'data_availability_statement',
        userId,
        round,
        description: 'Availability Statement cleared for a fresh extraction'
      });
    }
  },
  // Softcite reads the PDF and could start immediately, but the module's second
  // engine — the LM pass — reads the converted markdown, and without this
  // dependency it would race conversion and skip on nearly every run. Waiting
  // costs nothing end-to-end: no step consumes software output until
  // KRT_GROUNDING, which waits for the markdown-dependent detectors regardless.
  // Gated with the rest of detection so the whole detection stage starts at one
  // moment rather than trickling in around the KRT step.
  { jobType: JOB_TYPES.SOFTWARE_DETECTION,  dependsOn: [JOB_TYPES.MARKDOWN_CONVERT], gate: ['krt_curated'], reads: ['pdf', 'markdown', 'krt'] },
  { jobType: JOB_TYPES.ORCID_EXTRACTION,   dependsOn: [], reads: ['pdf'] },
  {
    jobType: JOB_TYPES.MARKDOWN_CONVERT,
    dependsOn: [],
    reads: ['pdf'],
    /**
     * Conversion can finish cleanly and produce nothing.
     *
     * This used to be the `markdown_ready` GATE, repeated on the seven steps
     * that read the manuscript. It belongs here: "did the conversion produce
     * usable text" is a fact about the conversion, not something each of its
     * readers should be trusted to remember to ask.
     *
     * Observed on a real run before the gate existed: 11/11 steps "complete",
     * 0 datasets, 0 materials, 0 protocols, and all 12 author rows reported as
     * not detected — every module had happily read an empty document and
     * reported that the manuscript mentions none of this.
     */
    produced: (job) => (job.result?.data?.markdownLength || 0) > 0
  },
  // Every text detector waits for BOTH the markdown and the curated KRT: the
  // seeded prompts carry the author's rows, so starting earlier would seed
  // from a table the author is still editing.
  { jobType: JOB_TYPES.DATASETS_DETECTION, dependsOn: [JOB_TYPES.MARKDOWN_CONVERT], gate: ['krt_curated'], reads: ['markdown', 'krt'] },
  { jobType: JOB_TYPES.MATERIALS_DETECTION, dependsOn: [JOB_TYPES.MARKDOWN_CONVERT], gate: ['krt_curated'], reads: ['markdown', 'krt'] },
  { jobType: JOB_TYPES.PROTOCOLS_DETECTION, dependsOn: [JOB_TYPES.MARKDOWN_CONVERT], gate: ['krt_curated'], reads: ['markdown', 'krt'] },
  // Identifier detection scans the post-conversion markdown against the
  // curated enrichment list. Cross-category — produces software/materials/
  // datasets/protocols items in one pass and lets pdf-analysis consolidate.
  { jobType: JOB_TYPES.IDENTIFIER_DETECTION, dependsOn: [JOB_TYPES.MARKDOWN_CONVERT], gate: ['krt_curated'], reads: ['markdown', 'krt'] },
  {
    // Grounding reconciles the author's KRT against the candidate pool: for
    // every author row it decides confirmed / incomplete / not_detected, and
    // never mutates the row itself. Gated on the author having finished the
    // KRT step; with no KRT at all it still runs and reports zero author rows,
    // so the pipeline shape is identical in both modes.
    jobType: JOB_TYPES.KRT_GROUNDING,
    reads: ['markdown', 'krt'],
    // It grounds whatever candidates exist, and searches the manuscript
    // directly for the author's rows besides — so a missing detector costs it
    // coverage, not the ability to run.
    optional: [
      JOB_TYPES.SOFTWARE_DETECTION, JOB_TYPES.DATASETS_DETECTION,
      JOB_TYPES.MATERIALS_DETECTION, JOB_TYPES.PROTOCOLS_DETECTION,
      JOB_TYPES.IDENTIFIER_DETECTION
    ],
    dependsOn: [
      // It reads the manuscript, so it depends on the conversion. It did not
      // say so before, because the `markdown_ready` GATE covered it — and when
      // that gate moved onto the conversion as `produced`, grounding was left
      // with no protection at all and started on a round whose text never
      // existed. Found by a live Continue; pinned now by "every step that reads
      // the manuscript depends on the conversion".
      //
      // No ordering change: it already sat behind the detectors, which sit
      // behind the conversion. The edge makes a requirement that was always
      // true visible to the rule that acts on it.
      JOB_TYPES.MARKDOWN_CONVERT,
      JOB_TYPES.SOFTWARE_DETECTION,
      JOB_TYPES.DATASETS_DETECTION,
      JOB_TYPES.MATERIALS_DETECTION,
      JOB_TYPES.PROTOCOLS_DETECTION,
      JOB_TYPES.IDENTIFIER_DETECTION
    ],
    gate: ['krt_curated']
  },
  {
    // PDF Analysis is the consolidator: it merges every detection's items
    // into the Generated KRT. So it depends on every detection that
    // contributes resources.
    //
    // It does NOT depend on DAS extraction. It used to, and parked in
    // `pending_input` unless a statement had been found — for a statement it
    // never reads: there is no reference to `dataAvailabilityStatement`, or to
    // the extraction result, anywhere in pdf-analysis.service. So a manuscript
    // with no Availability Statement blocked the Generated KRT behind a state
    // only a human could clear, and `pending_input` is the state nothing
    // revisits (see the retry tests below). The statement is confirmed by the
    // author on the Availability step, where the one module that reads it runs.
    //
    // It does NOT depend on KRT_GROUNDING. It used to, for two reasons that were
    // both real and neither of which was "it reads the outcomes" — it does not,
    // and `pdf-analysis.service` deliberately re-implements its own
    // is-this-represented test rather than trust grounding's `partial_name` tier.
    //
    // The two reasons were: SUGGESTION_GENERATION does read the outcomes and
    // reached this table only through PDF_ANALYSIS, so ordering here guaranteed
    // the verdicts existed by the time suggestions were built; and PDF_ANALYSIS
    // inherited the krt_curated gate through grounding rather than declaring it.
    //
    // Both are now stated where they belong: SUGGESTION_GENERATION depends on
    // KRT_GROUNDING directly, which is the honest edge since it is the consumer,
    // and the gate is declared here. Consolidation and grounding read the same
    // candidate pool and neither needs the other, so they now run in parallel —
    // two heavy steps that were serialised for a dependency neither had.
    jobType: JOB_TYPES.PDF_ANALYSIS,
    reads: ['krt'],
    // Declared, not inherited. It was reaching this through the grounding edge,
    // so removing that edge without this would have let consolidation start on a
    // KRT the author is still editing.
    gate: ['krt_curated'],
    // It consolidates what it is given, and seed retention carries every author
    // row through regardless — so with no detector output at all it still
    // produces the author's KRT rather than nothing.
    optional: [
      JOB_TYPES.SOFTWARE_DETECTION, JOB_TYPES.DATASETS_DETECTION,
      JOB_TYPES.MATERIALS_DETECTION, JOB_TYPES.PROTOCOLS_DETECTION,
      JOB_TYPES.IDENTIFIER_DETECTION
    ],
    dependsOn: [
      JOB_TYPES.SOFTWARE_DETECTION,
      JOB_TYPES.DATASETS_DETECTION,
      JOB_TYPES.MATERIALS_DETECTION,
      JOB_TYPES.PROTOCOLS_DETECTION,
      JOB_TYPES.IDENTIFIER_DETECTION
    ],
  },
  {
    // LM comparison of author KRT vs Generated KRT → suggestions. Runs after
    // PDF_ANALYSIS, which already gates on every KRT detector, so the Generated
    // KRT is complete by the time this starts (ORCID is author metadata, not a
    // KRT contributor, so it isn't a dependency). Also re-triggerable on demand.
    jobType: JOB_TYPES.SUGGESTION_GENERATION,
    // Reads only PDF Analysis's output — no document of its own.
    reads: [],
    // It reads the grounding outcomes too, via getGroundingResult, and now says
    // so. That dependency used to be borrowed from PDF_ANALYSIS, which meant the
    // graph recorded consolidation as needing grounding when it is this step
    // that does. Optional, because `groundingOutcomes` falls back to [] — a
    // failed grounding costs suggestions the empty-cell and conflict route, not
    // the ability to run.
    optional: [JOB_TYPES.KRT_GROUNDING],
    dependsOn: [JOB_TYPES.PDF_ANALYSIS, JOB_TYPES.KRT_GROUNDING]
  }
  ,
  {
    // The Availability Statement check. It needs the extracted statement, so it
    // depends on DAS_EXTRACTION — but it is ABOUT the Availability step, and
    // its gate holds it there rather than running it the moment extraction
    // finishes.
    //
    // It used to sit outside the pipeline entirely, precisely so it could not
    // wait: a `waiting` job counts as outstanding work, and it would have held
    // the KRT and PDF steps' "all processes finished" gate shut. That is now
    // handled where it belongs — a job blocked by a gate the submission has not
    // reached is not outstanding work for the step the user is on, and the API
    // says so via `waitingReason` so the client can tell the difference.
    //
    // `displayStage` is presentation only: its dependency is early (extraction,
    // stage 1) but its gate makes it the last thing that happens, and a reader
    // following the page top to bottom should find it where it actually runs.
    jobType: JOB_TYPES.DAS_SUGGESTIONS,
    reads: ['krt'],
    // It reads the submission's statement, which the author can type by hand —
    // extraction failing is why the manual path exists, not a reason to skip
    // the check.
    optional: [JOB_TYPES.DAS_EXTRACTION],
    dependsOn: [JOB_TYPES.DAS_EXTRACTION],
    gate: ['availability_ready'],
    /**
     * The author confirms the statement before this spends anything.
     *
     * This is the only module that reads the Availability Statement, and the
     * extractor's answer is a proposal: it can find the wrong paragraph, or
     * nothing at all. Running first and asking later spends a model call on
     * text nobody has looked at, and produces advice about the wrong statement.
     *
     * So the step parks in `pending_input` until the author confirms — which is
     * what the Availability page asks them to do — and `advanceJob` releases it.
     * `dasConfirmedAt` is set when they confirm and cleared when they edit, so
     * an edited statement is re-confirmed rather than silently re-used.
     */
    canAutoAdvance(dependencyJobs, submission) {
      return !!submission?.dasConfirmedAt;
    },
    displayStage: 4
  }
];

// Map jobType to the queue name used by pg-boss — shared, derived map so it
// can't drift from JOB_TYPES/QUEUES (a hand-written copy here went stale).
const { JOB_TYPE_TO_QUEUE } = jobQueue;

/**
 * Run all pipeline processes for a submission.
 * Creates SubmissionJob records for all pipeline steps, then enqueues
 * only the ones with no dependencies. The rest get status 'waiting'.
 *
 * @param {string} submissionId
 * @param {string} userId
 * @param {number} round
 * @param {object} [opts]
 * @param {string} [opts.cause] - why this run exists. Left out, it is
 *   `create_submission` for the round's first run and `restart` after that; a
 *   replaced manuscript passes `new_document`, which is the one distinction the
 *   caller knows and this function cannot infer.
 * @returns {Promise<object[]>} Created SubmissionJob records
 */
async function runAllProcesses(submissionId, userId, round, { cause } = {}) {
  const jobs = [];

  // The run comes first, before anything is enqueued: `openRun` resolves the
  // round's current run to file each execution under, so a step enqueued
  // beforehand would be recorded against the run this one replaces.
  await pipelineRuns.newRun({
    submissionId,
    round: round ?? 1,
    pipeline: PIPELINE,
    reRun: 'all',
    cause,
    userId
  });

  // Every step in the round is about to run, so every input is re-taken. This
  // is the call a PDF upload makes, and it is what lets a replaced manuscript
  // reach the pipeline: without it the round would keep reading the file it
  // froze the first time, for ever.
  await releaseInputFreezes(submissionId, round, PIPELINE.map((step) => step.jobType));

  // One row per (step, round), reused if it is already there.
  //
  // This used to INSERT a fresh set of twelve unconditionally, and it is called
  // on every PDF upload and by POST /processes/run. A second call in the same
  // round therefore produced a second full set, and `getForSubmission` keeps
  // only the newest row per type — so the whole previous set went invisible
  // while any worker still holding one carried on writing results nobody would
  // read. That is the same failure the per-step re-runs were fixed for, twelve
  // rows at a time. Five submissions in the dev database carry two
  // `pdf_analysis` rows from exactly this.
  const existing = await SubmissionJob.findAll({ where: { submissionId, round } });
  const byType = new Map();
  for (const row of existing) {
    // Newest wins, matching getForSubmission, so a submission that already has
    // duplicates converges on one row rather than adding to the pile.
    const seen = byType.get(row.jobType);
    if (!seen || row.createdAt > seen.createdAt) byType.set(row.jobType, row);
  }

  for (const step of PIPELINE) {
    const hasDependencies = step.dependsOn.length > 0;
    const initialStatus = hasDependencies ? 'waiting' : 'queued';

    let submissionJob = byType.get(step.jobType);
    if (submissionJob) {
      // A re-start of the whole pipeline: the row goes back to its initial
      // state carrying nothing from the run before it, exactly as requeueStep
      // does for a single step.
      submissionJob.status = initialStatus;
      submissionJob.pgBossJobId = null;
      submissionJob.result = null;
      submissionJob.errorMessage = null;
      submissionJob.startedAt = null;
      submissionJob.completedAt = null;
      // Whoever restarted the round owns it from here — but only if we know
      // who that is. Writing `undefined` would erase the previous trigger and
      // leave the round attributed to nobody.
      if (userId) submissionJob.triggeredByUserId = userId;
      await submissionJob.save();
    } else {
      submissionJob = await SubmissionJob.create({
        submissionId,
        jobType: step.jobType,
        status: initialStatus,
        round,
        triggeredByUserId: userId || null
      });
    }

    // Only enqueue jobs with no dependencies
    if (!hasDependencies) {
      const queueName = JOB_TYPE_TO_QUEUE[step.jobType];
      const jobData = buildJobData(step.jobType, submissionId, userId, submissionJob);

      const pgBossJobId = await jobQueue.addJob(queueName, jobData);
      submissionJob.pgBossJobId = pgBossJobId;
      await submissionJob.save();
      // A run begins here, at the enqueue — not when data appears. Starting the
      // round is a manual act; the steps this later releases are 'pipeline'.
      await runHistory.openRun(submissionJob, { userId, triggerKind: 'manual' });
    }

    jobs.push(submissionJob);
  }

  logger.info('Pipeline started', {
    submissionId,
    round,
    jobs: jobs.map(j => ({ type: j.jobType, status: j.status }))
  });

  return jobs;
}

/**
 * Check if any waiting jobs can now be advanced to queued.
 * Called by workers after a job completes or fails.
 *
 * @param {string} submissionId
 * @param {string} completedJobType - The job type that just finished
 * @param {number} round
 * @param {string} [userId] - Who asked, when anybody did. Absent for the ~20
 *   worker-driven advances: a finished worker knows the submission, not a
 *   person. Note that HAVING a userId is not sufficient to be credited for the
 *   step — the reconciler is handed the submission's owner and must not be —
 *   see the claim in tryAdvanceStep.
 */
async function checkAndAdvance(submissionId, completedJobType, round, userId) {
  // Find pipeline steps that depend on the completed job type
  const dependentSteps = PIPELINE.filter(
    step => step.dependsOn.includes(completedJobType)
  );

  // No early return when nothing depends on this step. That is exactly the LAST
  // step of a run — nothing follows it, so an early return here meant the run
  // that had just finished never settled, and sat at `running` until the
  // five-minute reconciler noticed. Seen on the first live run of this code.

  // Get all current jobs for this submission/round
  const allJobs = await SubmissionJob.getForSubmission(submissionId, round);
  const jobsByType = new Map(allJobs.map(j => [j.jobType, j]));

  // Submission state is needed to evaluate step gates
  const submission = await Submission.findByPk(submissionId, {
    // `availability_ready` reads the statement itself, not just the status.
    attributes: ['id', 'status', 'dataAvailabilityStatement', 'dasConfirmedAt']
  });

  for (const step of dependentSteps) {
    await tryAdvanceStep(step, jobsByType, submission, submissionId, round, userId, completedJobType);
  }

  await settleRun(submissionId, round, jobsByType);
}

/**
 * Move the run to the state its steps say it is in.
 *
 * Without this a finished run stays `running` for ever, which is the same
 * shape of lie the `superseded` state was added to avoid — a status that
 * describes an attempt that stopped happening some time ago.
 *
 * Three states, decided by the steps and nothing else:
 *
 *   paused    something is holding the pipeline and needs a person
 *   complete  every step has finished, one way or another
 *   running   still going
 *
 * `complete` does not mean "everything worked". A run whose steps failed, were
 * skipped or were carried past is still a completed ATTEMPT, and the outcome
 * lives on the executions where it can be read per step. A run-level "did it go
 * well" would be a second, coarser answer to a question already answered
 * better.
 *
 * Never throws. Getting the run's own status wrong is a cosmetic fault; failing
 * a step that succeeded because its bookkeeping threw is not.
 *
 * @param {string} submissionId
 * @param {number} round
 * @param {Map<string, object>} jobsByType
 */
async function settleRun(submissionId, round, jobsByType) {
  try {
    const run = await pipelineRuns.currentRun(submissionId, round ?? 1);
    if (!run || ['superseded', 'complete'].includes(run.status)) return;

    const jobs = PIPELINE.map((step) => jobsByType.get(step.jobType));
    // A step with no row at all has not run, so the round is not finished.
    const finished = jobs.every((job) => job && TERMINAL_STATUSES.includes(job.status));
    const held = jobs.some((job) => job && holdsPipeline(job));

    const status = held ? 'paused' : (finished ? 'complete' : 'running');
    if (status === run.status) return;

    await run.update({
      status,
      completedAt: status === 'complete' ? new Date() : null
    });
    logger.info('Pipeline run settled', {
      submissionId, round, runNumber: run.runNumber, status
    });
  } catch (error) {
    logger.error('Could not settle the pipeline run\'s status', {
      submissionId, round, error: error.message
    });
  }
}

/**
 * Attempt to advance a single waiting pipeline step. Shared by checkAndAdvance
 * (fired by a worker when its job finishes) and reconcileSubmission (the
 * periodic safety-net sweep). Idempotent: only acts on a `waiting` job whose
 * dependencies are all terminal, so calling it repeatedly is safe.
 *
 * @returns {Promise<boolean>} true if the job was enqueued
 */
async function tryAdvanceStep(step, jobsByType, submission, submissionId, round, userId, triggeredBy) {
  const job = jobsByType.get(step.jobType);
  // Only a job still 'waiting' can advance. A cancelled job is terminal (status
  // 'cancelled', not 'waiting'), so it is never started here — that is what stops
  // the pipeline after a cancel, without a separate run-level gate that would
  // also block a later restart. A restart replaces the row with a fresh
  // 'waiting'/'queued' one (getForSubmission returns the latest), which then
  // advances normally.
  if (!job || job.status !== 'waiting') return false;

  // Propagate cancellation: a step whose dependency was cancelled can never run
  // (a cancelled dep never becomes complete/failed). Mark it cancelled too,
  // rather than leaving it 'waiting' forever — a stuck 'waiting' job would keep
  // "all processes finished" false and block the Continue button downstream.
  const hasCancelledDep = step.dependsOn.some(
    depType => jobsByType.get(depType)?.status === 'cancelled'
  );
  if (hasCancelledDep) {
    await job.markCancelled();
    logger.info('Pipeline step cancelled: a dependency was cancelled', {
      submissionId, jobType: step.jobType, triggeredBy
    });
    return false;
  }

  // ── What this step's dependencies leave it able to do ───────────────────
  //
  // Three questions, in this order, because each only makes sense once the
  // previous one is settled.

  // 1. Has everything finished? A dependency still running has not "produced
  //    nothing" — it has produced nothing YET, and the two must not be confused.
  const allDependenciesDone = step.dependsOn.every(depType => {
    const depJob = jobsByType.get(depType);
    return depJob && TERMINAL_STATUSES.includes(depJob.status);
  });
  if (!allDependenciesDone) return false;

  // 2. Is anything waiting on a person? A dependency that did not finish
  //    cleanly — failed, unusable, or degraded in a way worth asking about —
  //    holds this step until somebody chooses retry or continue.
  const blockedBy = step.dependsOn.filter(depType => holdsPipeline(jobsByType.get(depType)));
  if (blockedBy.length) {
    logger.debug('Pipeline step held behind an unresolved issue', {
      submissionId, jobType: step.jobType, blockedBy, triggeredBy
    });
    return false;
  }

  // 3. Can it run at all? A decision has been made, but a dependency this step
  //    REQUIRES produced nothing — there is no manuscript text to read. Running
  //    it would fail, and so would everything after it: nine unexplained
  //    failures in place of the one real one. Skipping says what happened and,
  //    unlike waiting, lets the round finish.
  const missing = step.dependsOn.filter(
    depType => isRequired(step, depType) && !producedOutput(jobsByType.get(depType))
  );
  if (missing.length) {
    await job.markSkipped(missing);
    logger.info('Pipeline step skipped: something it requires produced nothing', {
      submissionId, jobType: step.jobType, missing, triggeredBy
    });
    return false;
  }

  // Submission-state gate: unsatisfied → stay `waiting` (NOT pending_input);
  // the status-change handler / reconciler re-drives once the state changes.
  // Debug level: the reconciler sweep re-checks gated jobs every interval and
  // an info log per sweep per job would be pure noise.
  const isManual = triggeredBy === 'manual';

  const blocked = blockingGate(step, submission, jobsByType);
  if (blocked) {
    logger.debug('Pipeline step gated, staying in waiting', {
      submissionId, jobType: step.jobType, gate: blocked,
      submissionStatus: submission.status, triggeredBy
    });
    return false;
  }

  // Check if this step has a conditional gate.
  //
  // `submission` is passed too: the DAS confirmation is a fact about the
  // submission, not about a dependency's result.
  //
  // Skipped for a manual run, and the name says why — it governs AUTO
  // advancing. The condition exists to stop the pipeline spending an LM call on
  // a statement nobody has agreed to; a person clicking the step by name has
  // agreed to it, by clicking. Applying it anyway would park a job somebody
  // just asked for in `pending_input`, which nothing revisits — the same dead
  // end that once stranded PDF Analysis behind a retrying extraction.
  if (!isManual && step.canAutoAdvance && !step.canAutoAdvance(jobsByType, submission)) {
    // Gate condition not met — park job as pending_input
    await job.markPendingInput({ reason: 'Auto-advance condition not met' });

    logger.info('Pipeline paused: job needs user input', {
      submissionId,
      jobType: step.jobType,
      triggeredBy
    });
    return false;
  }

  // All dependencies met and gate passed — enqueue this job.
  //
  // Claim the row FIRST, with the old status in the WHERE clause, so the
  // transition out of `waiting` happens exactly once. checkAndAdvance runs on
  // every worker completion, and a step like pdf_analysis sits behind eight
  // detections that finish within milliseconds of each other: two of them
  // completing together both read `waiting`, both found every dependency
  // terminal, and both enqueued the same row — two pg-boss jobs, two runs of
  // the same model call, both writing their result to one row.
  //
  // Postgres serialises the UPDATE, so exactly one caller sees a row count of
  // 1. The loser stops here.
  // The step is credited only to a person who ASKED for it — which is not the
  // same as "there is a userId in scope".
  //
  // `triggeredBy` is the provenance: 'manual' means requeueStep, i.e. somebody
  // clicked; 'reconciler' is the periodic sweep; anything else is the jobType
  // of the worker that just finished. Only the first is a decision.
  //
  // The reconciler is the trap. `reconcileStuckJobs` hands it the SUBMISSION'S
  // OWNER as `userId`, so gating on `userId` alone would credit the author for
  // a re-drive they never asked for — and, because the sweep runs on a timer,
  // would quietly overwrite the curator who did. A worker-driven advance
  // carries no user at all and keeps whatever is already there.
  const claim = { status: 'queued' };
  if (userId && isManual) claim.triggeredByUserId = userId;
  const [claimed] = await SubmissionJob.update(
    claim,
    { where: { id: job.id, status: 'waiting' } }
  );
  if (claimed === 0) {
    logger.debug('Pipeline step already claimed by a concurrent advance', {
      submissionId, jobType: step.jobType, triggeredBy
    });
    return false;
  }
  job.status = 'queued';
  if (userId && isManual) job.triggeredByUserId = userId;

  const queueName = JOB_TYPE_TO_QUEUE[step.jobType];
  const jobData = buildJobData(step.jobType, submissionId, userId, job);

  try {
    const pgBossJobId = await jobQueue.addJob(queueName, jobData);
    job.pgBossJobId = pgBossJobId;
    await job.save();
    // Opened only once the enqueue has actually succeeded: a run that was
    // never queued is not a run. `triggeredBy` carries the provenance —
    // 'manual' when a person asked for this step by name, the completed job
    // type when a worker released it, 'reconciler' for the sweep.
    await runHistory.openRun(job, {
      userId: isManual ? userId : null,
      triggerKind: isManual ? 'manual' : (triggeredBy === 'reconciler' ? 'reconciler' : 'pipeline')
    });
  } catch (err) {
    // Nothing is going to run this row: put the claim back rather than leave
    // it `queued` with no queue job behind it, which no reconciler heals — it
    // watches `processing` and `waiting`, not a `queued` row with a null
    // pgBossJobId.
    await SubmissionJob.update({ status: 'waiting' }, { where: { id: job.id, status: 'queued' } });
    job.status = 'waiting';
    throw err;
  }

  logger.info('Pipeline advanced: job enqueued', {
    submissionId,
    jobType: step.jobType,
    triggeredBy
  });
  return true;
}

/**
 * Re-drive every waiting step of one submission/round whose dependencies are
 * already terminal. Used by the reconciler to recover a pipeline whose
 * advancement was dropped (e.g. a transient DB/queue error inside
 * checkAndAdvance) and would otherwise hang in `waiting` forever.
 *
 * @returns {Promise<number>} number of jobs enqueued
 */
async function reconcileSubmission(submissionId, round, userId, submission = null) {
  const allJobs = await SubmissionJob.getForSubmission(submissionId, round);
  const jobsByType = new Map(allJobs.map(j => [j.jobType, j]));

  const sub = submission || await Submission.findByPk(submissionId, {
    // `availability_ready` reads the statement itself, not just the status.
    attributes: ['id', 'status', 'dataAvailabilityStatement', 'dasConfirmedAt']
  });

  // Repeated passes until nothing moves.
  //
  // One pass was enough while the only outcome was "enqueue it". Skipping
  // cascades — a step skipped because the conversion produced nothing makes
  // everything that required IT skippable too — and PIPELINE is not in
  // topological order, so a single pass would leave the tail of a cascade
  // waiting until the next sweep. Bounded by the pipeline's length, which is
  // the longest chain it could possibly have.
  let advanced = 0;
  for (let pass = 0; pass < PIPELINE.length; pass++) {
    const before = [...jobsByType.values()].map((j) => j.status).join(',');
    for (const step of PIPELINE) {
      const didAdvance = await tryAdvanceStep(
        step, jobsByType, sub, submissionId, round, userId, 'reconciler'
      );
      if (didAdvance) advanced++;
    }
    if ([...jobsByType.values()].map((j) => j.status).join(',') === before) break;
  }

  // The reconciler is the sweep that catches whatever the per-step advance
  // missed, so it is also where a run that finished while nobody was looking
  // gets its status.
  await settleRun(submissionId, round, jobsByType);
  return advanced;
}

/**
 * Safety-net sweep: find jobs stuck in `waiting` (older than the grace window)
 * and re-drive their submission's pipeline. checkAndAdvance is the primary
 * advancement path; this guarantees that even if an advancement was dropped,
 * a stuck submission self-heals within one sweep interval instead of hanging.
 *
 * @param {{ graceMs?: number }} [opts]
 * @returns {Promise<number>} total jobs re-driven across all submissions
 */
/**
 * Rows that say `processing` while their queue entry is gone.
 *
 * A worker records `processing` when it picks a job up, and something has to
 * record the end. Usually the handler does — it completes or it throws. But a
 * job that **expires** never reaches the handler at all: pg-boss times it out,
 * and after the final retry it stops redelivering. Nothing then updates our
 * row, which sits at `processing` for ever: a spinner that never resolves,
 * `isAnyRunning` permanently true, and the Continue gate held shut.
 *
 * The same happens whenever a worker dies mid-job — a deploy, a container
 * restart, a crash.
 *
 * pg-boss's own table is the authority on whether the work is still live, so
 * this asks it rather than guessing from elapsed time. A row is only failed
 * when its queue entry is in a terminal state (or has been archived away
 * entirely); anything still `active` or `created` is left alone, because it IS
 * running.
 *
 * @param {Date} cutoff only rows that started before this are considered
 * @returns {Promise<number>} how many were failed
 */
async function failStrandedProcessingJobs(cutoff) {
  const candidates = await SubmissionJob.findAll({
    where: { status: 'processing', startedAt: { [Op.lt]: cutoff } },
    // `status` is in the list because markFailed refuses to touch a cancelled
    // row — and a guard reading an attribute that was not selected compares
    // against `undefined` and never fires.
    attributes: ['id', 'submissionId', 'round', 'jobType', 'pgBossJobId', 'status']
  });
  if (candidates.length === 0) return 0;

  let failed = 0;
  for (const job of candidates) {
    // No queue id recorded: nothing can be running, so it cannot recover.
    let live = false;
    if (job.pgBossJobId) {
      const [rows] = await sequelize.query(
        'SELECT state FROM pgboss.job WHERE id = :id',
        { replacements: { id: job.pgBossJobId } }
      );
      // Absent means archived — pg-boss moves finished jobs out of `job`, so a
      // missing row is a finished one, not a running one.
      live = rows.length > 0 && ['created', 'active', 'retry'].includes(rows[0].state);
    }
    if (live) continue;

    await job.markFailed('The worker stopped without recording a result (the job expired or the process restarted).');
    failed++;
    logger.warn('Reconciler failed a stranded processing job', {
      submissionId: job.submissionId, jobType: job.jobType, round: job.round
    });
  }
  return failed;
}

async function reconcileStuckJobs({ graceMs = RECONCILE_GRACE_MS } = {}) {
  const cutoff = new Date(Date.now() - graceMs);

  // Before looking for work to re-drive, heal rows that claim to be running and
  // are not. Otherwise their dependents wait on a job nothing will ever finish.
  const stranded = await failStrandedProcessingJobs(cutoff);

  // Distinct (submission, round) pairs that have at least one long-waiting job.
  const stuck = await SubmissionJob.findAll({
    where: { status: 'waiting', createdAt: { [Op.lt]: cutoff } },
    attributes: ['submissionId', 'round'],
    group: ['submissionId', 'round'],
    raw: true
  });

  // Healing a stranded row IS work — it unblocks everything downstream of it.
  // Returning 0 here reported "the reconciler found nothing" for a run that had
  // just failed five rows, which is the number that would be watched to decide
  // whether the reconciler is doing anything at all.
  if (stuck.length === 0) return stranded;

  let advancedTotal = 0;
  for (const { submissionId, round } of stuck) {
    const submission = await Submission.findByPk(submissionId, {
      attributes: ['id', 'userId', 'status']
    });
    if (!submission) continue;

    try {
      advancedTotal += await reconcileSubmission(submissionId, round, submission.userId, submission);
    } catch (err) {
      logger.error('Pipeline reconciler failed for submission', {
        submissionId, round, error: err.message
      });
    }
  }

  if (advancedTotal > 0 || stranded > 0) {
    logger.warn('Pipeline reconciler re-drove stuck jobs', {
      submissions: stuck.length,
      advanced: advancedTotal,
      stranded
    });
  }
  return advancedTotal + stranded;
}

/**
 * Manually advance a job from 'pending_input' to 'queued'.
 * Used when the user has provided the required input (e.g., manually entered DAS).
 *
 * @param {string} submissionId
 * @param {string} jobType - The job type to advance
 * @param {number} round
 * @param {string} userId
 * @returns {Promise<object>} The updated SubmissionJob
 */
async function advanceJob(submissionId, jobType, round, userId) {
  const job = await SubmissionJob.getLatest(submissionId, jobType, round);

  if (!job) {
    throw new NotFoundError(`${jobType} job`);
  }

  // Idempotent: if the job has already moved past pending_input, treat advance
  // as a no-op success — the desired outcome (job running or done) is already
  // achieved. This avoids 500s when the UI fires a redundant advance (e.g. the
  // shared Edit-Metadata modal closing on a submission whose analysis finished).
  if (['queued', 'processing', 'complete'].includes(job.status)) {
    logger.info('Advance is a no-op: job already advanced', {
      submissionId, jobType, round, status: job.status
    });
    return job;
  }

  if (job.status !== 'pending_input') {
    // 'waiting' (dependencies not finished) or 'failed' — cannot advance.
    throw new ConflictError(`Cannot advance ${jobType}: job is '${job.status}', not awaiting input`);
  }

  const queueName = JOB_TYPE_TO_QUEUE[jobType];
  if (!queueName) {
    throw new ValidationError(`Unknown job type: ${jobType}`);
  }

  const jobData = buildJobData(jobType, submissionId, userId, job);
  const pgBossJobId = await jobQueue.addJob(queueName, jobData);

  job.status = 'queued';
  job.pgBossJobId = pgBossJobId;
  // Typed the missing Availability Statement, pressed the button: this user
  // released the step, whoever started the round.
  if (userId) job.triggeredByUserId = userId;
  await job.save();
  await runHistory.openRun(job, { userId, triggerKind: 'manual' });

  logger.info('Pipeline advanced manually: job enqueued', {
    submissionId,
    jobType,
    round
  });

  return job;
}

/**
 * Build the job data payload for a specific job type.
 * @param {string} jobType
 * @param {string} submissionId
 * @param {string} userId
 * @param {object} submissionJob - The SubmissionJob record
 * @returns {object}
 */
function buildJobData(jobType, submissionId, userId, submissionJob) {
  const base = { submissionId, submissionJobId: submissionJob.id };

  switch (jobType) {
    // The only step whose PAYLOAD carries userId, and its handler still does
    // not read it. Attribution no longer depends on this: it lives on the row,
    // in `triggered_by_user_id`, written by the orchestrator. This is a
    // leftover the worker could stop being sent — kept only because removing a
    // payload field is a change to what the queue carries, and it earns
    // nothing.
    case JOB_TYPES.PDF_ANALYSIS:
      return { ...base, userId };
    case JOB_TYPES.DAS_EXTRACTION:
      return base;
    case JOB_TYPES.SOFTWARE_DETECTION:
      return base;
    case JOB_TYPES.ORCID_EXTRACTION:
      return base;
    case JOB_TYPES.MARKDOWN_CONVERT:
      return base;
    case JOB_TYPES.DATASETS_DETECTION:
      return base;
    case JOB_TYPES.MATERIALS_DETECTION:
      return base;
    case JOB_TYPES.PROTOCOLS_DETECTION:
      return base;
    case JOB_TYPES.IDENTIFIER_DETECTION:
      return base;
    default:
      return base;
  }
}

/**
 * Compute the set of job types that transitively depend on `rootJobType`.
 * If A depends on rootJobType, and B depends on A, both A and B are downstream.
 *
 * @param {string} rootJobType
 * @returns {Set<string>}
 */
/**
 * ── The four cases a finished step can be in ────────────────────────────────
 *
 *   1. no error, results          → clean, the pipeline carries on by itself
 *   2. no error, nothing found    → clean. A detector finding nothing IS an
 *                                   answer, and a common one
 *   3. partial error              → a person decides
 *   4. total error                → a person decides
 *
 * Cases 3 and 4 differ only in what is left behind, so they are one rule here:
 * a dependency holds its dependents unless it finished CLEANLY. That single
 * predicate also swallows what used to be a hole — a step that reached
 * `complete` while its outcome was `fail`, which slipped past a rule keyed on
 * status alone and let the consolidator build on nothing.
 */

/**
 * Engines whose failure is not worth stopping the round for.
 *
 * A module that runs two engines and loses one still has a real answer, and
 * whether that is worth a human's attention depends on WHICH engine. Softcite
 * dying leaves the LM pass, which read the manuscript; the LM dying leaves
 * name-matching with no reading behind it. The first happens often and is
 * tolerable, the second is worth a question.
 *
 * The engine is already in the record — a degrading module sets
 * `meta.degraded = { engine }` and the outcome carries `failReason:
 * '<engine>_failed'` — so this is a lookup, not an inference.
 *
 * Code rather than configuration on purpose: it is a judgement about which
 * engine matters, it belongs beside the module, and it should be reviewed when
 * it changes.
 */
const PARTIAL_AUTO_CONTINUE = {
  [JOB_TYPES.SOFTWARE_DETECTION]: ['softcite']
};

/**
 * Statuses a step will not move on from by itself.
 *
 * `skipped` belongs here for the same reason `cancelled` does: nothing is going
 * to run it, so anything waiting on it must stop waiting.
 */
const TERMINAL_STATUSES = ['complete', 'failed', 'cancelled', 'skipped'];

/** The outcome a run recorded about itself: 'done' | 'partial' | 'fail'. */
const outcomeOf = (job) => job?.result?.service?.outcome?.state || 'done';

/** Which engine degraded it, from `failReason: '<engine>_failed'`. */
function degradedEngine(job) {
  const reason = job?.result?.service?.outcome?.failReason || '';
  const match = /^(.+)_failed$/.exec(reason);
  return match ? match[1] : null;
}

/**
 * Did this step produce something the steps after it can use?
 *
 * Not the same question as "did it finish", and not the same as "did it find
 * anything" — a detector that found nothing produced a usable answer. This asks
 * whether there is OUTPUT. A step may override it (`produced` on the step) when
 * finishing cleanly is not enough; conversion is the case that matters, because
 * it can complete with zero characters.
 *
 * @param {object} job
 * @returns {boolean}
 */
function producedOutput(job) {
  if (!job) return false;
  if (['failed', 'cancelled', 'skipped'].includes(job.status)) return false;
  if (job.status !== 'complete') return false;
  if (outcomeOf(job) === 'fail') return false;

  const step = PIPELINE.find((s) => s.jobType === job.jobType);
  return step?.produced ? !!step.produced(job) : true;
}

/**
 * Does this step's outcome need a person to decide before the pipeline moves?
 *
 * @param {object} job
 * @returns {{needed: boolean, kind: string|null}}
 */
function issueOf(job) {
  if (!job) return { needed: false, kind: null };
  if (job.status === 'failed') return { needed: true, kind: 'failure' };
  if (job.status !== 'complete') return { needed: false, kind: null };

  const outcome = outcomeOf(job);
  if (outcome === 'fail') return { needed: true, kind: 'unusable' };
  if (outcome === 'partial') {
    const engine = degradedEngine(job);
    const auto = PARTIAL_AUTO_CONTINUE[job.jobType] || [];
    // An engine on the auto list is a known, tolerated degradation: the answer
    // is incomplete in a way somebody has already decided not to be asked about.
    if (engine && auto.includes(engine)) return { needed: false, kind: null };
    return { needed: true, kind: 'partial' };
  }
  // A step that produced nothing usable while reporting `done` — conversion with
  // zero characters. Nobody errored, but nothing downstream can be built on it.
  if (!producedOutput(job)) return { needed: true, kind: 'unusable' };
  return { needed: false, kind: null };
}

/** Undecided issues are what hold the pipeline; a decided one does not. */
/**
 * Does this step hold what comes after it?
 *
 * `job.decision` is attached by `getForSubmission` from the execution the
 * round's current run holds for this step. A step re-executed since the
 * decision was made has a new execution and therefore no decision, which is the
 * whole reason the field moved off the job row.
 */
const holdsPipeline = (job) => issueOf(job).needed && !job?.decision?.at;

/** Is this dependency one the step cannot run without? */
function isRequired(step, depType) {
  return !(step.optional || []).includes(depType);
}

function computeDownstreamSet(rootJobType) {
  const downstream = new Set();
  let frontier = new Set([rootJobType]);
  while (frontier.size > 0) {
    const next = new Set();
    for (const step of PIPELINE) {
      if (step.dependsOn.some(dep => frontier.has(dep)) && !downstream.has(step.jobType)) {
        downstream.add(step.jobType);
        next.add(step.jobType);
      }
    }
    frontier = next;
  }
  return downstream;
}

/**
 * Cascade-restart: when a process is being re-run, every downstream process
 * that depends on it (transitively) needs to be reset to `waiting` so it gets
 * re-queued by checkAndAdvance once this restart completes. Without this, the
 * downstream processes would still hold stale results from the previous run.
 *
 * Resets the LATEST SubmissionJob of each downstream type (in this round) to
 * `waiting` if it's currently in a terminal state (`complete` or `failed`).
 * Jobs that are already `queued` or `processing` are left alone (will pick up
 * fresh inputs when they run).
 *
 * @param {string} submissionId
 * @param {string} restartedJobType - The jobType being re-run.
 * @param {number} round
 * @param {string} [userId] - Who caused the cascade. Credited on every row it
 *   resets: asking for one step to re-run is asking for everything downstream
 *   of it to re-run too, and that is real work — and real spend — that this
 *   person set going. Omitted for an internal caller, in which case each row
 *   keeps the credit it already had.
 * @returns {Promise<string[]>} List of jobTypes that were reset.
 */
/**
 * Every step that reads each input, keyed by input kind.
 *
 * Derived from the `reads` declarations rather than listed somewhere: a step
 * added without updating a hand-written list would silently make the re-freeze
 * rule wrong, and the symptom — one module reading a different document from
 * its siblings — is exactly the failure the freeze exists to prevent.
 *
 * @returns {Map<string, string[]>}
 */
function readersByInput() {
  const readers = new Map();
  for (const step of PIPELINE) {
    for (const inputKind of step.reads || []) {
      if (!readers.has(inputKind)) readers.set(inputKind, []);
      readers.get(inputKind).push(step.jobType);
    }
  }
  return readers;
}

/**
 * Release the round's input freezes that this restart is entitled to re-take.
 *
 * An input is re-frozen only when EVERY step that reads it is being re-run.
 * Restarting Markdown Convert cascades through every markdown reader, so the
 * markdown freeze goes and the next run picks up the current file. Restarting
 * one detector does not: its siblings keep results built from the frozen
 * markdown, and handing the restarted one a different document would split the
 * round — the failure the freeze exists to prevent.
 *
 * Never throws. A freeze left in place is the conservative outcome (the restart
 * re-reads what the round was already using), and it is not worth failing a run
 * the user asked for.
 *
 * @param {string} submissionId
 * @param {number} round
 * @param {string[]} restartingJobTypes - the restarted step plus its cascade
 */
async function releaseInputFreezes(submissionId, round, restartingJobTypes) {
  try {
    const inputFreeze = require('./input-freeze.service');
    await inputFreeze.releaseForRestart(submissionId, round, restartingJobTypes, readersByInput());
  } catch (err) {
    logger.error('Could not release input freezes for a restart', {
      submissionId, round, restartingJobTypes, error: err.message
    });
  }
}

async function cascadeRestart(submissionId, restartedJobType, round, userId) {
  const downstream = computeDownstreamSet(restartedJobType);
  if (downstream.size === 0) return [];

  // Atomic + serialized: SELECT ... FOR UPDATE on each downstream job row
  // serializes against any concurrent checkAndAdvance reading the same rows,
  // and wrapping the loop in one transaction makes the multi-row reset
  // observable as a single state change.
  return sequelize.transaction(async (t) => {
    const reset = [];
    for (const jobType of downstream) {
      const where = { submissionId, jobType };
      if (round !== undefined) where.round = round;
      const job = await SubmissionJob.findOne({
        where,
        order: [['createdAt', 'DESC']],
        transaction: t,
        lock: t.LOCK.UPDATE
      });
      if (!job) continue;
      // Leave in-flight jobs alone. Everything else downstream is reset,
      // CANCELLED INCLUDED.
      //
      // Cancelled used to be skipped too, for fear of stranding a step waiting
      // on a dependency that was still cancelled. That fear is handled
      // elsewhere now — `tryAdvanceStep` cancels a step whose dependency is
      // cancelled rather than leaving it waiting — and skipping had a worse
      // cost: after a cancel, restarting the step left its cancelled dependents
      // stuck for ever. Seen live: cancel, restart software detection, and
      // grounding, PDF analysis and suggestions sat `cancelled` while the step
      // they were waiting for ran to completion.
      //
      // The user asking for a step to run again is asking for what depends on
      // it to run again, whatever stopped them last time.
      if (job.status === 'queued' || job.status === 'processing') continue;
      job.status = 'waiting';
      job.pgBossJobId = null;
      // Same rule as requeueStep, and it was missing here: a job queued to run
      // again carries nothing from the run before it. Without this, a step that
      // had FAILED was reset to `waiting` still holding its error, and the panel
      // showed that failure against a job that was about to re-run — the exact
      // complaint requeueStep was fixed for, one function along. Seen live: a
      // Gemini 503 on suggestion_generation stayed on screen after a grounding
      // re-run had already reset it.
      job.result = null;
      job.errorMessage = null;
      // Nothing to clear about the decision: it lives on the execution, and
      // this step is about to get a new one that was never decided about.
      if (userId) job.triggeredByUserId = userId;
      await job.save({ transaction: t });
      reset.push(jobType);
    }

    if (reset.length > 0) {
      logger.info('Cascade restart: downstream jobs reset to waiting', {
        submissionId, restartedJobType, round, resetJobTypes: reset
      });
    }
    return reset;
  });
}

/**
 * Re-run one pipeline step, respecting the pipeline.
 *
 * Reuses the round's existing row for that step instead of inserting a rival
 * one, and only enqueues when the step is actually runnable — dependencies
 * terminal and gates satisfied. Otherwise it is left `waiting` for
 * checkAndAdvance/reconcile to pick up, which is what every other step does.
 *
 * This exists because "trigger analysis" used to INSERT a second
 * SubmissionJob row for a type the pipeline had already created, and
 * getForSubmission keeps only the newest row per type. Observed on a real run:
 * uploading a PDF seeds pdf_analysis as `waiting` (it depends on every
 * detector); POST /pdf/analyze then created a second, `queued` row that ran
 * within a second — before any detector had produced anything. When the
 * detectors finished, checkAndAdvance looked up pdf_analysis, found that newer
 * row `complete`, and advanced nothing. The pipeline reported 11/11 complete
 * and the Generated KRT contained 98 author rows and ZERO detections, while
 * datasets detection alone had found 96 items. A wrong answer presented as a
 * finished one.
 *
 * @param {string} submissionId
 * @param {string} jobType
 * @param {number} round
 * @param {string} userId
 * @returns {Promise<object>} the step's SubmissionJob row
 */
/** Why a retry was refused, in words the UI can show as-is. */
const RETRY_REFUSALS = {
  never_run: 'This step has not run yet, so there is nothing to retry.',
  no_issue: 'This step finished cleanly — there is nothing to retry.',
  downstream_already_ran:
    'Later steps have already run since this one failed, so retrying it alone '
    + 'would leave their results built on the failure. Restart it from the '
    + 'pipeline page instead, which re-runs them too.'
};

/**
 * Carry on despite a step's issue.
 *
 * The second of the two answers an issue asks for — the other being Retry. It
 * does NOT re-run anything and does not pretend the step succeeded: the row
 * keeps the status it had, and what is recorded is that a person decided the
 * rest of the pipeline should proceed anyway.
 *
 * Covers all three kinds. A FAILURE left nothing behind; an UNUSABLE run
 * finished while producing nothing a later step can read; a PARTIAL produced a
 * real answer with one of its engines dead. The decision is the same shape in
 * each case, and so is the record of it — what differs is what happens next,
 * which the dependency rules work out on their own: with data, the steps below
 * run; without data they are skipped.
 *
 * Recorded with who and when because the consequence outlives the decision. A
 * report built without software detection looks exactly like a report where
 * software detection found nothing, and the difference is only knowable if
 * somebody wrote it down.
 *
 * @param {string} submissionId
 * @param {string} jobType - the failed step
 * @param {number} round
 * @param {string} [userId] - who decided
 * @returns {Promise<object>} the job row
 */
async function acknowledgeIssue(submissionId, jobType, round, userId) {
  const step = PIPELINE.find((s) => s.jobType === jobType);
  if (!step) throw new ValidationError(`Unknown pipeline step: ${jobType}`);

  const job = await SubmissionJob.getLatest(submissionId, jobType, round);
  if (!job) throw new NotFoundError('Job');
  if (!issueOf(job).needed) {
    throw new ValidationError('This step finished cleanly — there is nothing to decide about.');
  }

  // Onto the EXECUTION the current run holds for this step, not onto the job
  // row. That is what makes the decision travel with the result it is about:
  // re-execute the step and the new execution was never decided about; carry it
  // over and the decision comes with it.
  const entry = await pipelineRuns.currentStepInRun(submissionId, round ?? 1, jobType);
  if (!entry?.execution) {
    throw new ValidationError('There is no run of this step to decide about yet.');
  }
  if (entry.execution.decision?.at) return job;   // already decided; not an error

  // NOT wrapped in the history layer's swallow-everything guard. Background
  // history writes must never break a run; a decision is not a background
  // write — the orchestrator is about to act on it, and a failure that is
  // logged and ignored would release the pipeline on a decision nobody made.
  await entry.execution.update({
    decision: { at: new Date().toISOString(), byUserId: userId || null, choice: 'continue' }
  });
  job.decision = entry.execution.decision;

  logger.info('Issue acknowledged — the pipeline proceeds', {
    submissionId, jobType, round, userId, execution: entry.execution.id
  });

  // Release whatever was held behind it — or skip it, if this step was the
  // required input it never got. Non-fatal: the decision is recorded either
  // way, and the reconciler re-drives waiting jobs within a sweep.
  try {
    await reconcileSubmission(submissionId, round, userId);
  } catch (err) {
    logger.error('Could not re-drive the pipeline after acknowledging an issue', {
      submissionId, jobType, error: err.message
    });
  }
  return job;
}

/**
 * Is this failure safe to retry on its own?
 *
 * The condition is not "did it fail" but "has anything consumed the failure
 * yet". A step that failed while everything downstream is still `waiting` can be
 * run again alone: nothing was built on its absence, so nothing is left stale
 * afterwards. That is the case a blocked pipeline is in — `markdown_convert`
 * fails and every detector sits behind the `markdown_ready` gate, waiting for
 * text that never arrived.
 *
 * Once a downstream step HAS run, retrying alone would leave its results built
 * on the failure while this step's are not. That needs a restart, which resets
 * them too — a different, more expensive thing, and the caller is told to use it.
 *
 * A step with no downstream is trivially safe: there is nothing to leave stale.
 *
 * @param {string} jobType
 * @param {Map<string, object>} jobsByType
 * @returns {{retryable: boolean, reason: string|null}}
 */
function describeRetry(jobType, jobsByType) {
  const job = jobsByType.get(jobType);
  if (!job) return { retryable: false, reason: 'never_run' };
  // Any issue, not only a failure. A partial is a run worth doing again — the
  // module produced a real answer with one of its engines dead — and now that
  // issues pause, nothing downstream has consumed it yet, so retrying one is
  // exactly as cheap and as safe as retrying a failure.
  if (!issueOf(job).needed) return { retryable: false, reason: 'no_issue' };

  const consumed = [...computeDownstreamSet(jobType)].filter((t) => {
    const d = jobsByType.get(t);
    // `waiting` is the only state that means "has not run since". `cancelled`
    // counts as run-and-stopped: un-cancelling it is a restart's job, not a
    // retry's, or the retry would leave a cancelled step behind a running one.
    return d && d.status !== 'waiting';
  });

  if (consumed.length) return { retryable: false, reason: 'downstream_already_ran' };
  return { retryable: true, reason: null };
}

/**
 * Run a failed step again, and change nothing else.
 *
 * The narrow sibling of `restartSteps`, for the case that comes up after an
 * external service has been fixed: the pipeline is stuck behind one failure, and
 * what is wanted is to unblock it, not to re-run the round.
 *
 * Three things it deliberately does NOT do:
 *
 *   - **release the input freezes.** The round is mid-flight and the steps that
 *     did run read the frozen documents. A retry that took fresh ones would
 *     split the round — the failure this whole freeze mechanism exists to
 *     prevent, arriving through the repair path.
 *   - **cascade.** There is nothing downstream to reset; that is the
 *     precondition, checked rather than assumed.
 *   - **run `onManualRestart`.** Asking for a fresh reading is what a restart
 *     means. A retry of DAS extraction must not clear a statement the author
 *     typed while the service was down.
 *
 * @param {string} submissionId
 * @param {string} jobType
 * @param {number} round
 * @param {string} [userId] - credited with the run
 * @returns {Promise<object>} the job row
 */
async function retryStep(submissionId, jobType, round, userId) {
  const step = PIPELINE.find((s) => s.jobType === jobType);
  if (!step) throw new ValidationError(`Unknown pipeline step: ${jobType}`);

  const allJobs = await SubmissionJob.getForSubmission(submissionId, round);
  const jobsByType = new Map(allJobs.map((j) => [j.jobType, j]));
  const { retryable, reason } = describeRetry(jobType, jobsByType);

  if (!retryable) {
    throw new ValidationError(RETRY_REFUSALS[reason] || 'This step cannot be retried.');
  }

  // A retry is a new attempt at the round, not a second life for the old one.
  // Everything that finished cleanly is carried over by link; only this step
  // executes again. The decision that was made about the failed execution stays
  // on THAT execution, which is what stops a stale acknowledgement waving the
  // next failure through.
  await pipelineRuns.newRun({
    submissionId,
    round: round ?? 1,
    pipeline: PIPELINE,
    reRun: [jobType],
    cause: CAUSES.RETRY,
    userId
  });

  const job = jobsByType.get(jobType);
  job.status = 'waiting';
  job.pgBossJobId = null;
  job.result = null;
  job.errorMessage = null;
  // The attempts belong to the run that failed. Left in place, the panel would
  // show a fresh run already on its third try.
  job.retryCount = 0;
  // The decision needs no clearing. It was recorded against the execution that
  // failed, and the retry above opened a run that re-executes this step — so
  // the execution the round now holds for it is a new one, about which nothing
  // has been decided. This is the case three call sites had to remember, and
  // the one that re-runs everything did not.
  if (userId) job.triggeredByUserId = userId;
  await job.save();

  const submission = await Submission.findByPk(submissionId, {
    attributes: ['id', 'status', 'dataAvailabilityStatement', 'dasConfirmedAt']
  });
  await tryAdvanceStep(step, jobsByType, submission, submissionId, round, userId, 'manual');

  logger.info('Retried a blocked step', { submissionId, jobType, round, status: job.status, userId });
  return job;
}

/**
 * Restart several steps as ONE restart.
 *
 * Not a loop over `requeueStep`, and the difference is not cosmetic. Restarting
 * the software detector resets everything downstream of it — grounding, the
 * consolidator, the suggestions — and then software runs. If it finishes before
 * the SECOND restart is issued, grounding finds every dependency terminal
 * (materials is still `complete` from the previous round) and starts. The
 * second restart then resets it again, so grounding runs twice and both runs
 * are paid for. The second answer is the right one, which makes the first
 * invisible rather than harmless.
 *
 * So the order is: reset every selected step's downstream FIRST, then enqueue.
 * Between the two loops nothing is running that could release a downstream
 * step, because every one of them is `waiting` on a selected step that has not
 * started.
 *
 * Freezes are released once, over the union — a larger set than any single step
 * would compute, and the reason `requeueStep` is told to skip its own release.
 * Five detectors restarting together may re-read the markdown; one of them
 * alone must not.
 *
 * @param {string} submissionId
 * @param {string[]} jobTypes - the steps to run again
 * @param {number} round
 * @param {string} [userId] - credited with every run this starts
 * @param {object} [opts]
 * @param {string} [opts.paramsSource] - 'live' (default) uses today's prompts
 *   and config; 'frozen' uses the parameters each step's previous execution
 *   recorded, so a disagreement cannot be blamed on a prompt edited since.
 * @returns {Promise<{restarted: string[], reset: string[]}>}
 */
async function restartSteps(submissionId, jobTypes, round, userId, { paramsSource = 'live' } = {}) {
  const selected = [...new Set(jobTypes)];
  const unknown = selected.filter((t) => !PIPELINE.some((s) => s.jobType === t));
  if (unknown.length) throw new ValidationError(`Unknown pipeline step(s): ${unknown.join(', ')}`);
  if (!selected.length) throw new ValidationError('No steps to restart');

  // The union of everything the selection carries with it, minus the selection
  // itself — those are enqueued explicitly and must not be treated as debris.
  const downstream = new Set();
  for (const jobType of selected) {
    for (const dep of computeDownstreamSet(jobType)) downstream.add(dep);
  }
  for (const jobType of selected) downstream.delete(jobType);

  await releaseInputFreezes(submissionId, round, [...selected, ...downstream]);

  // ONE run for the whole batch. Opening one per step would number the same
  // restart three times and leave two of those runs superseded before anything
  // in them executed — the batch is a single attempt, and the model should say
  // so. `newRun` expands the selection downstream itself, so the set it records
  // is the same union computed above.
  await pipelineRuns.newRun({
    submissionId,
    round: round ?? 1,
    pipeline: PIPELINE,
    reRun: selected,
    cause: CAUSES.RESTART,
    userId,
    paramsSource
  });

  // Reset first, every one of them, before anything is enqueued.
  for (const jobType of selected) {
    await cascadeRestart(submissionId, jobType, round, userId);
  }

  const restarted = [];
  for (const jobType of selected) {
    await requeueStep(submissionId, jobType, round, userId, {
      releaseFreezes: false,
      newPipelineRun: false
    });
    restarted.push(jobType);
  }

  logger.info('Batch restart', {
    submissionId, round, restarted, reset: [...downstream], userId
  });
  return { restarted, reset: [...downstream] };
}

async function requeueStep(submissionId, jobType, round, userId, {
  releaseFreezes = true,
  newPipelineRun = true
} = {}) {
  const step = PIPELINE.find((s) => s.jobType === jobType);
  if (!step) throw new ValidationError(`Unknown pipeline step: ${jobType}`);

  let job = await SubmissionJob.getLatest(submissionId, jobType, round);
  if (!job) {
    job = await SubmissionJob.create({
      submissionId, jobType, status: 'waiting', round, triggeredByUserId: userId || null
    });
  } else if (['queued', 'processing'].includes(job.status)) {
    // Already on its way — re-queueing would duplicate the work it is doing.
    // Deliberately BEFORE the run is opened: a run that re-executes nothing is
    // an attempt that never happened, and it would supersede the live one.
    return job;
  } else {
    job.status = 'waiting';
    job.pgBossJobId = null;
    job.result = null;
    // No decision to clear — see retryStep. A re-executed step has a new
    // execution, and a decision belongs to the execution it was about.
    // `errorMessage`, not `error` — the model has no `error` field, so this
    // set a plain JS property Sequelize ignores and the previous run's
    // failure text stayed on the row. The panel then showed a stale error
    // on a job that had just been queued to run again.
    job.errorMessage = null;
    // This is the manual re-run path — the caller asked for this step by name,
    // so they are the trigger even if the round was started by someone else.
    if (userId) job.triggeredByUserId = userId;
    await job.save();
  }

  // A new run, but only when this step has ALREADY executed in the current one.
  //
  // Otherwise this is the run REACHING the step, not a new attempt at the
  // round. The case that showed it: `das_suggestions` is gated behind the
  // Availability step and never starts on its own, so confirming the statement
  // comes through here — and opened run 2, superseding run 1, purely to run a
  // step run 1 had never got to. The history then said the user restarted the
  // pipeline when they had pressed "confirm", and eleven finished steps were
  // relabelled as carried over.
  //
  // Skipped entirely when a BATCH restart is driving: it opened one run for the
  // whole selection, and a second here would supersede it before the first step
  // ran.
  if (newPipelineRun) {
    const inRun = await pipelineRuns.currentStepInRun(submissionId, round ?? 1, jobType);
    // No run at all is a submission that predates the model, or one whose run
    // creation failed. Opening one is the recoverable answer; leaving the step
    // unreachable from any run is not.
    if (!inRun || inRun.execution) {
      await pipelineRuns.newRun({
        submissionId,
        round: round ?? 1,
        pipeline: PIPELINE,
        reRun: [jobType],
        cause: CAUSES.RESTART,
        userId
      });
    }
  }

  const allJobs = await SubmissionJob.getForSubmission(submissionId, round);
  const jobsByType = new Map(allJobs.map((j) => [j.jobType, j]));
  jobsByType.set(jobType, job);
  const submission = await Submission.findByPk(submissionId, {
    attributes: ['id', 'status', 'dataAvailabilityStatement', 'dasConfirmedAt']
  });

  // Release the freezes this restart is entitled to re-take, BEFORE the step is
  // advanced — a step that starts first would re-freeze what it just read.
  //
  // The set is the step plus everything downstream of it, which is what a
  // restart re-runs. One residual race stays, and predates this: a downstream
  // step already `processing` is deliberately left alone by cascadeRestart, so
  // it finishes against the input the round was using while the restart takes a
  // newer one. Its own run record still says which document it read.
  //
  // Skipped when a BATCH restart is driving: it has already released over the
  // union of every selected step, which is a larger set than any one of them
  // would compute. Releasing per step would under-release — five detectors
  // restarting together may re-read the markdown, while one of them alone must
  // not.
  if (releaseFreezes) {
    await releaseInputFreezes(submissionId, round, [jobType, ...computeDownstreamSet(jobType)]);
  }

  // A step may need to clear what its previous run produced before running
  // again — otherwise "re-run this module" is a button that appears to do
  // nothing. Non-fatal: the run is what the user asked for, and a failure to
  // reset is better reported than turned into a refusal to run at all.
  //
  // The hook PERSISTS its own reset. It used to mutate and leave the saving
  // here, which stopped working the moment a reset also had to be recorded —
  // the record and the write have to land together or the log describes
  // something that did not happen.
  if (submission && step.onManualRestart) {
    try {
      // `round` explicitly: the submission is loaded with a narrow attribute
      // list that does not include currentRound, so a hook reaching for it
      // would find undefined and the log row would refuse to write.
      await step.onManualRestart(submission, { userId, round });
    } catch (resetErr) {
      logger.error('Manual restart could not reset the step\'s previous output', {
        submissionId, jobType, error: resetErr.message
      });
    }
  }

  await tryAdvanceStep(step, jobsByType, submission, submissionId, round, userId, 'manual');
  return job;
}

/**
 * Whether a job type is currently blocked by its submission-state gate.
 * Used by the jobs API to explain WHY a job is `waiting` (the frontend shows
 * "waiting for KRT validation" instead of a generic dependency message).
 * @param {string} jobType
 * @param {object} submission - needs `status`
 * @returns {boolean}
 */
/**
 * Everything about this round that needs a person, in one list.
 *
 * Computed here, once, rather than on each page. Five surfaces show these now —
 * the PDF step, the Availability step, the pipeline, a module's page, and a
 * read-only badge everywhere else — and the last time a rule like this lived on
 * the client, the pipeline page asked for a field the API never sent and
 * rendered failed steps as green ticks for weeks.
 *
 * @param {Map<string, object>} jobsByType
 * @returns {object[]}
 */
function describeIssues(jobsByType) {
  const issues = [];

  for (const step of PIPELINE) {
    const job = jobsByType.get(step.jobType);
    const { needed, kind } = issueOf(job);
    if (!needed) continue;

    // What this step's absence costs. A dependant that REQUIRES it cannot run
    // at all and will be skipped; one that merely reads it runs with less.
    const downstream = [...computeDownstreamSet(step.jobType)];
    const wouldSkip = producedOutput(job)
      ? []
      : downstream.filter((t) => {
        const dependant = PIPELINE.find((x) => x.jobType === t);
        return dependant?.dependsOn.includes(step.jobType) && isRequired(dependant, step.jobType);
      });

    issues.push({
      jobType: step.jobType,
      kind,
      /** Undecided issues hold the pipeline; a decided one is history. */
      decided: job.decision?.at
        ? { at: job.decision.at, byUserId: job.decision.byUserId || null }
        : null,
      blocking: !job.decision?.at && downstream.some(
        (t) => jobsByType.get(t)?.status === 'waiting'
      ),
      /** Everything stuck behind it right now. */
      holding: downstream.filter((t) => jobsByType.get(t)?.status === 'waiting'),
      /**
       * What "continue" would cost. Empty means the steps below can still run,
       * just with less to work from; a non-empty list means they cannot run at
       * all and continuing skips them.
       */
      wouldSkip,
      /** Whether anything downstream can still be produced from what it left. */
      producedOutput: producedOutput(job),
      detail: job.errorMessage || job.result?.service?.outcome?.externalError || null,
      failReason: job.result?.service?.outcome?.failReason || null,
      engine: degradedEngine(job)
    });
  }

  return issues;
}

/**
 * Which of this step's dependencies raised an issue nobody has decided about.
 *
 * The client needs the names, not just the fact: "waiting" tells a user
 * nothing, "waiting because Datasets Detection failed" tells them where to go.
 *
 * @param {string} jobType
 * @param {Map<string, object>} jobsByType
 * @returns {string[]}
 */
function blockingIssues(jobType, jobsByType) {
  const step = PIPELINE.find(s => s.jobType === jobType);
  if (!step) return [];
  return step.dependsOn.filter(depType => holdsPipeline(jobsByType.get(depType)));
}

function isGateBlocked(jobType, submission, jobsByType) {
  const step = PIPELINE.find(s => s.jobType === jobType);
  if (!step) return null;
  return blockingGate(step, submission, jobsByType);
}

module.exports = {
  PIPELINE,
  runAllProcesses,
  requeueStep,
  restartSteps,
  retryStep,
  acknowledgeIssue,
  describeRetry,
  failStrandedProcessingJobs,
  checkAndAdvance,
  reconcileSubmission,
  reconcileStuckJobs,
  advanceJob,
  settleRun,
  cascadeRestart,
  computeDownstreamSet,
  isGateBlocked,
  blockingIssues,
  describeIssues,
  producedOutput,
  issueOf,
  holdsPipeline
};
