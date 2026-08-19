/**
 * Resolve which detection strategy a submission's run should use.
 *
 * One place decides, so a detector never has to know that pipelines exist —
 * it asks for its input and is told either "skip, because…" or "here is the
 * prompt and the seeds".
 */

const fs = require('fs');
const { getPipeline } = require('../../config/pipelines');
const { getStrategy } = require('./registry');

/**
 * @typedef {object} ResolvedDetection
 * @property {boolean} run
 * @property {string} [reason]     why not, when run is false
 * @property {object} pipeline
 * @property {object} strategy
 * @property {object} [input]      { prompt, seeds, signalsPrompt?, meta } when run
 */

/**
 * @param {string} detector - 'materials' | 'protocols' | 'datasets'
 * @param {{submission: object, markdownText: string, jobLogger?: object}} ctx
 * @returns {Promise<ResolvedDetection>}
 */
async function resolveDetection(detector, { submission, markdownText, jobLogger }) {
  // `pipelineId` is undefined until a submission is stamped with one, which
  // resolves to the default — so this works before the column exists and keeps
  // working after.
  const pipeline = getPipeline(submission.pipelineId);
  const strategyId = pipeline.strategies[detector];
  if (!strategyId) {
    throw new Error(`Pipeline "${pipeline.id}" defines no strategy for detector "${detector}"`);
  }
  const strategy = getStrategy(strategyId);

  const strategyCtx = {
    submissionId: submission.id,
    round: submission.currentRound || 1,
    markdownText,
    pipeline,
    options: (pipeline.strategyOptions && pipeline.strategyOptions[detector]) || {},
    logger: jobLogger
  };

  const gate = await strategy.shouldRun(strategyCtx);
  if (!gate.run) {
    jobLogger?.log('strategy_skip', `${strategyId} declined to run`, { reason: gate.reason });
    return { run: false, reason: gate.reason, pipeline, strategy };
  }

  const input = await strategy.buildInput(strategyCtx);
  jobLogger?.log('strategy_input', `Built model input via ${strategyId}`, {
    pipeline: pipeline.id, seedCount: input.meta?.seedCount ?? 0
  });
  return { run: true, pipeline, strategy, input };
}

/**
 * Are the prompt files the run would actually read present on disk?
 *
 * A detector's "is this module available" check has to ask the strategy the
 * submission's own pipeline selects. Datasets hard-coded the BLIND
 * consolidation prompt for this, while the default pipeline is seeded — so a
 * missing blind file silently downgraded a perfectly runnable seeded detection
 * to demo data, and a missing SEEDED file was reported as available and threw
 * mid-run instead.
 *
 * @param {string} detector - 'materials' | 'protocols' | 'datasets'
 * @param {object} submission - needs `pipelineId` (undefined = the default)
 * @returns {boolean}
 */
function detectionPromptsExist(detector, submission) {
  const pipeline = getPipeline(submission?.pipelineId);
  const strategyId = pipeline.strategies[detector];
  if (!strategyId) return false;
  const files = getStrategy(strategyId).promptFiles || [];
  return files.every((file) => fs.existsSync(file));
}

module.exports = { resolveDetection, detectionPromptsExist };
