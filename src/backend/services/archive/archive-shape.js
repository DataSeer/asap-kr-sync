/**
 * What a submission is made of, and in what order it can be written back.
 *
 * One list, used by the export, the import and the delete — so a table added to
 * the schema and forgotten here is caught by one test rather than by three
 * silent omissions. `archive.test.js` compares this against the database's own
 * foreign keys and fails when they disagree.
 *
 * ── Why the order matters three times ───────────────────────────────────────
 *
 * INSERT follows it: a row cannot reference one that is not there yet.
 * DELETE reverses it, with one asymmetry that is not merely conventional —
 * `pipeline_run_steps.step_execution_id` is `ON DELETE RESTRICT`, so membership
 * must go before the executions it points at or Postgres refuses. That refusal
 * is the constraint working, and it has already caught a real bug in the
 * failure seeder.
 * And the EXPORT reads in the same order, so a manifest lists tables the way
 * they will be restored.
 */

'use strict';

/**
 * Owned tables, parents first.
 *
 * `submissions` is not here: it is the root and is handled on its own, because
 * everything else is found through it.
 */
const TABLES = [
  // Documents and the author's table come first: most things point at them.
  { model: 'File', table: 'files', by: 'submissionId' },
  { model: 'KRTData', table: 'krt_data', by: 'submissionId', selfRef: 'originRowId' },

  // The scheduler's rows, then the run model on top of them.
  { model: 'SubmissionJob', table: 'submission_jobs', by: 'submissionId' },
  { model: 'PipelineRun', table: 'pipeline_runs', by: 'submissionId', selfRef: 'parentRunId' },
  { model: 'StepExecution', table: 'step_executions', by: 'submissionId' },
  // Reached through its run, not through the submission — it has no
  // submission_id of its own.
  { model: 'PipelineRunStep', table: 'pipeline_run_steps', by: 'pipelineRunId', via: 'PipelineRun' },

  // Everything that points at a file, a KRT row or an execution.
  { model: 'SubmissionInputFreeze', table: 'submission_input_freezes', by: 'submissionId' },
  { model: 'ValidationResult', table: 'validation_results', by: 'submissionId' },
  { model: 'ChangeLog', table: 'change_logs', by: 'submissionId' },
  { model: 'Report', table: 'reports', by: 'submissionId' },
  { model: 'RejectedResource', table: 'rejected_resources', by: 'submissionId' },
  { model: 'UserHiddenSubmission', table: 'user_hidden_submissions', by: 'submissionId' }
];

/**
 * The order rows are deleted in: children first.
 *
 * Not simply `TABLES.reverse()` — `pipeline_run_steps` must go before
 * `step_executions` regardless of where it sits in the insert order, because
 * the database refuses otherwise. Stated rather than derived, so the reason
 * survives someone reordering the list above.
 */
const DELETE_ORDER = [
  'pipeline_run_steps',   // RESTRICT on step_executions — must be first
  'user_hidden_submissions',
  'rejected_resources',
  'reports',
  'change_logs',
  'validation_results',
  'submission_input_freezes',
  'step_executions',
  'pipeline_runs',
  'submission_jobs',
  'krt_data',
  'files'
];

module.exports = { TABLES, DELETE_ORDER };
