'use strict';

/**
 * Say what re-queueing a step actually did.
 *
 * `requeueStep` only enqueues a step that is runnable right now. If a
 * dependency has not finished, or a submission-state gate is shut, or the step
 * needs input, the row is left `waiting`/`pending_input` and nothing is
 * enqueued — which is correct, and was reported to the user as "queued"
 * regardless. The user then watched a step that was never going to start and
 * had no way to tell that from one that had.
 *
 * The status is the source of truth: it is what the row ended up as after the
 * orchestrator decided.
 *
 * @param {string} label - the step in the user's words, e.g. 'Materials detection'
 * @param {object} job - the SubmissionJob row requeueStep returned
 * @param {boolean} [alreadyInFlight] - the caller found it already running
 * @returns {string} one sentence, safe to show as-is
 */
function describeQueueOutcome(label, job, alreadyInFlight = false) {
  if (alreadyInFlight) return `${label} is already running`;

  switch (job?.status) {
    case 'processing':
    case 'queued':
      return job.status === 'processing'
        ? `${label} is already running`
        : `${label} queued`;
    case 'waiting':
      return `${label} will start once the steps it depends on have finished`;
    case 'pending_input':
      return `${label} needs input before it can run`;
    case 'cancelled':
      return `${label} cannot run: a step it depends on was cancelled`;
    default:
      // A status the pipeline does not produce here (or no row at all). Say the
      // neutral true thing rather than inventing a state.
      return `${label} requested`;
  }
}

module.exports = { describeQueueOutcome };
