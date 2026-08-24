/**
 * One vocabulary for describing a job's state, shared by every surface.
 *
 * The processes panel, the pipeline page and each module page all answer the
 * same question — "what happened to this step?" — and answering it in three
 * places is how they drift. `describeLoadError` was four byte-identical copies
 * before it was pulled into one module; this is the same shape of problem,
 * caught earlier.
 */

/**
 * The run's outcome state, whichever shape the caller is holding.
 *
 * The jobs API returns `result.service.outcome.state`; JobStatusPanel flattens
 * that into `outcomeState` on its own view-model. Reading only the flattened
 * name is why the pipeline page rendered a failed step as a green "done" —
 * `outcomeState` is simply absent on an API job, so the check never fired.
 *
 * @param {object|null} job
 * @returns {'done'|'partial'|'fail'|null}
 */
export function outcomeStateOf(job) {
  return job?.result?.service?.outcome?.state ?? job?.outcomeState ?? null
}

/**
 * The workflow-level reason a run did not produce a normal result.
 *
 * @param {string|null} reason - `failReason` from the run's service snapshot
 * @returns {string}
 */
export function formatFailReason(reason) {
  const map = {
    external_failed_no_demo_data: 'External service failed and no demo data is available for this manuscript',
    external_failed_demo_disabled: 'External service failed; demo fallback is disabled',
    process_off_no_demo_data: 'Process is disabled; no demo data is available for this manuscript',
    // Partial outcomes. `<engine>_failed` is written by the backend from the
    // `meta.degraded.engine` a service declares, so a new engine gets a
    // readable line here rather than the generic fallback below.
    softcite_failed: 'Softcite was unavailable — these rows come from the LM pass alone'
  }
  return map[reason] || 'Process did not produce a result'
}

/**
 * The full explanation of a partly-complete run: what went missing, and what
 * that means for the rows on screen.
 *
 * A user meeting a short table needs both halves — without the first it is a
 * mystery, without the second it looks like a complete answer.
 *
 * @param {object} job - a job as the jobs API returns it
 * @returns {string|null} null unless the run was partial
 */
export function partialDetail(job) {
  const outcome = job?.result?.service?.outcome || job
  if (outcome?.outcomeState !== 'partial' && outcome?.state !== 'partial') return null
  const reason = outcome.outcomeFailReason ?? outcome.failReason
  const error = outcome.outcomeExternalError ?? outcome.externalError
  const headline = formatFailReason(reason)
  return error ? `${headline}.\n\nThe service reported: ${error}` : `${headline}.`
}

/** Why a `waiting` step is waiting, when the server could name a gate. */
const WAITING_REASONS = {
  krt_validation: 'It is held until the Key Resources Table has been validated. Finish the KRT step and this starts on its own.',
  markdown_missing: 'The manuscript has no converted text yet. This step is held rather than run against an empty document.',
  availability_step: 'It belongs to a later step of the submission, and starts when you reach it.',
  // The backend sends this when an unresolved issue upstream is holding the
  // step. Without it the default below applied, which told the user nothing
  // was needed from them while the pipeline waited on their decision.
  blocked_by_failure: 'An earlier step needs a decision before this one can run. Open the pipeline page to retry it or continue without it.'
};

/**
 * Every status, in one sentence plus a detail — so a module page can say what
 * state its run is in without the reader inferring it from an empty table.
 *
 * `tone` is the visual weight, not the status: 'good' | 'warn' | 'bad' |
 * 'busy' | 'idle'.
 *
 * @param {object|null} job - a job as the jobs API returns it, or null
 * @returns {{ tone: string, label: string, title: string, detail: string|null }}
 */
export function describeJobStatus(job) {
  if (!job || !job.status) {
    return {
      tone: 'idle',
      label: 'Not started',
      title: 'This step has not run yet.',
      detail: 'Nothing below is a result — there is no run to show.'
    }
  }

  const outcome = job.result?.service?.outcome || {}
  const cancelled = job.status === 'cancelled'
    || (job.status === 'failed' && /cancel/i.test(job.errorMessage || ''))

  if (cancelled) {
    // An external call already in flight cannot be stopped: it completes and is
    // billed. Saying so matters — a user who cancelled to avoid the spend
    // should learn it happened anyway, from the page rather than from an
    // invoice.
    const discarded = Array.isArray(job.discarded) ? job.discarded : []
    const spent = discarded.reduce((n, d) => n + (d.tokens?.totalTokens || 0), 0)
    const late = discarded.length
      ? ` One answer arrived after you stopped it and was thrown away${
        spent ? ` — ${spent.toLocaleString()} tokens, already spent` : ''}.`
      : ''

    return {
      tone: 'idle',
      label: 'Cancelled',
      title: job.cancelledBy?.name
        ? `This step was cancelled by ${job.cancelledBy.name}.`
        : 'This step was cancelled.',
      detail: 'Anything shown below is from an earlier run. Re-run the step to refresh it.' + late
    }
  }

  switch (job.status) {
    case 'waiting':
      return {
        tone: 'warn',
        label: 'Waiting',
        title: 'This step has not started yet.',
        detail: WAITING_REASONS[job.waitingReason]
          || 'It is waiting for the steps it depends on to finish. Nothing is needed from you.'
      }
    case 'queued':
      return {
        tone: 'busy',
        label: 'Queued',
        title: 'This step is queued and will start shortly.',
        detail: 'Results will appear here once it has run.'
      }
    case 'processing':
      return {
        tone: 'busy',
        label: 'Running',
        title: 'This step is running now.',
        detail: 'Anything shown below is from an earlier run until this one finishes.'
      }
    case 'pending_input':
      return {
        tone: 'warn',
        label: 'Needs input',
        title: 'This step is waiting for something from you.',
        detail: 'It is paused until the missing information is provided — see the banner on the submission.'
      }
    case 'failed':
      return {
        tone: 'bad',
        label: 'Failed',
        title: 'This step failed.',
        detail: job.errorMessage || 'No error was recorded. Re-run the step to try again.'
      }
    case 'complete':
      if (outcome.state === 'fail') {
        return {
          tone: 'bad',
          label: 'Failed',
          title: 'This step did not produce a result.',
          detail: [formatFailReason(outcome.failReason), outcome.externalError].filter(Boolean).join('. ')
        }
      }
      if (outcome.state === 'partial') {
        return {
          tone: 'warn',
          label: 'Partly complete',
          title: 'This step ran, but one of its engines failed.',
          detail: [
            `${formatFailReason(outcome.failReason)}.`,
            'The results below are real but incomplete — re-run the step once the service is back.',
            outcome.externalError ? `The service reported: ${outcome.externalError}` : null
          ].filter(Boolean).join(' ')
        }
      }
      if (outcome.source === null && outcome.state === 'done') {
        return {
          tone: 'idle',
          label: 'Disabled',
          title: 'This step is switched off.',
          detail: 'Nothing was attempted, so an empty result here is not a finding about your manuscript.'
        }
      }
      if (outcome.source === 'demo') {
        return {
          tone: 'warn',
          label: 'Demo data',
          title: 'These results are demo data, not a reading of your manuscript.',
          detail: 'The external service was unavailable, so stored sample data was used instead.'
        }
      }
      return {
        tone: 'good',
        label: 'Done',
        title: 'This step completed.',
        detail: 'The results below are its full output.'
      }
    default:
      return { tone: 'idle', label: job.status, title: `This step is ${job.status}.`, detail: null }
  }
}
