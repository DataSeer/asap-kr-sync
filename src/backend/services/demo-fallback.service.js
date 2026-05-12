/**
 * Demo-fallback workflow helper.
 *
 * Encodes the four configuration scenarios x two outcome states for every
 * background process (DAS, software, datasets, protocols, materials,
 * markdown, pdf_analysis, orcid). Centralized here so the contract is
 * defined once instead of being re-implemented in each service.
 *
 * The configuration of a process is one of three states:
 *   - 'on'    : ENABLED=true                    (demo flag is a fallback only)
 *   - 'demo'  : ENABLED=false, DEMO=true        (demo data is the primary source)
 *   - 'off'   : ENABLED=false, DEMO=false       (process produces no data)
 *
 * The outcome of a run is one of two states:
 *   - 'done'  : external returned (even empty), OR demo filled in,
 *               OR the process is intentionally Off (nothing was attempted)
 *   - 'fail'  : external errored after all retries AND no demo was found,
 *               OR config is Demo but no demo data exists for this manuscript
 *
 * The "Off + Done" case carries source=null to distinguish it from external
 * and demo — the UI uses that to show "Process is disabled" instead of a
 * misleading data count.
 *
 * Demo fallback only fires when the external attempt is on its FINAL retry —
 * transient failures retry the real service first.
 */

/**
 * Run a process with the standard external→demo fallback workflow.
 *
 * @param {object} params
 * @param {boolean} params.isExternalEnabled
 *   Whether the external service is configured to run (config.isConfigured()).
 * @param {boolean} params.demoEnabled
 *   Whether demo data fallback is allowed for this job type.
 * @param {() => Promise<{items: Array, meta?: object}>} params.runExternal
 *   Calls the external API. Throws on transient and final failures.
 * @param {() => Promise<{items: Array, meta?: object}|null>} params.getDemoData
 *   Looks up demo data for the current submission. Returns null if none.
 * @param {boolean} params.isFinalAttempt
 *   True iff pg-boss has exhausted retries. Demo fallback only runs when true;
 *   on earlier attempts a transient external error is re-thrown to let pg-boss
 *   retry the real service.
 * @param {{log: Function}} [params.jobLogger]
 *   Optional structured logger.
 *
 * @returns {Promise<{
 *   data: { items: Array, meta: object },
 *   source: 'external'|'demo'|null,
 *   status: 'done'|'fail',
 *   failReason: string|null,
 *   externalError: string|null
 * }>}
 *
 * @throws Re-throws the original external error when isFinalAttempt is false
 *   (so pg-boss can retry). When isFinalAttempt is true the helper always
 *   resolves — Fail is a normal outcome, not an exception.
 */
async function runWithDemoFallback({
  isExternalEnabled,
  demoEnabled,
  runExternal,
  getDemoData,
  isFinalAttempt,
  jobLogger
}) {
  if (isExternalEnabled) {
    try {
      jobLogger?.log('external_start', 'Calling external service');
      const result = await runExternal();
      jobLogger?.log('external_done', 'External service returned', {
        itemCount: result?.items?.length ?? 0
      });
      return done('external', result);
    } catch (err) {
      if (!isFinalAttempt) {
        // Let pg-boss retry the real service.
        jobLogger?.log('external_error_retrying', `External failed, retrying: ${err.message}`);
        throw err;
      }
      jobLogger?.log('external_error_final', `External failed on final attempt: ${err.message}`);

      if (demoEnabled) {
        const demo = await tryDemo(getDemoData, jobLogger);
        if (demo) {
          return done('demo', demo, { externalError: err.message });
        }
        return fail('external_failed_no_demo_data', { externalError: err.message });
      }
      return fail('external_failed_demo_disabled', { externalError: err.message });
    }
  }

  // External disabled. If demo is enabled, that's the only data source — try
  // it. If demo is also disabled, the process is intentionally Off; we
  // resolve to Done/null so the UI shows a neutral terminal state instead of
  // surfacing a Fail for an admin-chosen configuration.
  jobLogger?.log('external_disabled', 'External service is not configured');
  if (demoEnabled) {
    const demo = await tryDemo(getDemoData, jobLogger);
    if (demo) return done('demo', demo);
    return fail('process_off_no_demo_data');
  }
  jobLogger?.log('process_off', 'Process disabled, nothing to do');
  return done(null, { items: [], meta: {} });
}

/**
 * Look up demo data, swallowing errors (a broken demo lookup must never crash
 * the workflow — fall through to Fail).
 */
async function tryDemo(getDemoData, jobLogger) {
  try {
    jobLogger?.log('demo_lookup', 'Looking up demo data');
    const demo = await getDemoData();
    if (demo && (demo.items?.length || demo.items === undefined)) {
      jobLogger?.log('demo_found', 'Demo data found', { itemCount: demo.items?.length ?? 0 });
      return demo;
    }
    jobLogger?.log('demo_not_found', 'No demo data for this submission');
    return null;
  } catch (err) {
    jobLogger?.log('demo_lookup_error', `Demo lookup threw: ${err.message}`);
    return null;
  }
}

function done(source, raw, extras = {}) {
  return {
    data: { items: raw?.items ?? [], meta: raw?.meta ?? {} },
    source,
    status: 'done',
    failReason: null,
    externalError: extras.externalError ?? null
  };
}

function fail(reason, extras = {}) {
  return {
    data: { items: [], meta: {} },
    source: null,
    status: 'fail',
    failReason: reason,
    externalError: extras.externalError ?? null
  };
}

/**
 * Derive the configuration state ('on'|'demo'|'off') from the two flags.
 * Used by both the worker (to persist) and the route layer (live status).
 */
function configState({ isExternalEnabled, demoEnabled }) {
  if (isExternalEnabled) return 'on';
  if (demoEnabled) return 'demo';
  return 'off';
}

/**
 * Whether a pg-boss job is on its final attempt. Demo fallback only fires
 * when this returns true.
 */
function isFinalAttempt(pgBossJob, retryLimit) {
  const retrycount = pgBossJob?.retrycount ?? 0;
  return retrycount >= (retryLimit ?? 0);
}

module.exports = {
  runWithDemoFallback,
  configState,
  isFinalAttempt
};
