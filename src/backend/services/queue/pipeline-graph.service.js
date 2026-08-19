/**
 * The pipeline as data, for anything that needs to describe it.
 *
 * The dependency table lives in orchestrator.service.js and drives execution.
 * The frontend needs the same information to say what a job is waiting for and
 * to estimate remaining time — and had been carrying its own hand-written
 * copies, which had already drifted: one listed seven dependencies for
 * PDF_ANALYSIS, the other listed two, and the real table has seven. The "waiting
 * for" tooltip has been under-reporting as a result.
 *
 * So the graph is derived from the executing table, once, and served. There is
 * no second place to update.
 */

const { PIPELINE } = require('./orchestrator.service');

/**
 * Stage index for each job: the LONGEST path from a root.
 *
 * Derived rather than declared so it cannot go stale when a dependency is added
 * — and longest path, not shortest, because a job must sit after everything it
 * waits on. PDF_ANALYSIS depends on both a detector (stage 1) and grounding
 * (stage 2); shortest path would place it at 2, alongside a job it waits for.
 *
 * @param {Array<{jobType: string, dependsOn: string[]}>} pipeline
 * @returns {Map<string, number>}
 */
function computeStages(pipeline) {
  const deps = new Map(pipeline.map((p) => [p.jobType, p.dependsOn || []]));
  const stage = new Map();

  const depthOf = (jobType, seen = new Set()) => {
    if (stage.has(jobType)) return stage.get(jobType);
    // A cycle cannot happen in a valid pipeline, but a bad edit should not hang
    // the server — treat a revisit as a root and let the graph look wrong.
    if (seen.has(jobType)) return 0;
    seen.add(jobType);

    const parents = deps.get(jobType) || [];
    const depth = parents.length === 0
      ? 0
      : Math.max(...parents.map((p) => depthOf(p, seen))) + 1;
    stage.set(jobType, depth);
    return depth;
  };

  for (const { jobType } of pipeline) depthOf(jobType);
  return stage;
}

/**
 * The pipeline, described.
 *
 * @returns {{nodes: Array<object>, stageCount: number}}
 *   nodes: { jobType, dependsOn, gate, stage, autoAdvances }
 */
function buildPipelineGraph() {
  const stages = computeStages(PIPELINE);
  const nodes = PIPELINE.map((step) => ({
    jobType: step.jobType,
    dependsOn: [...(step.dependsOn || [])],
    // Named, not the function: a gate is a server-side condition and the client
    // only needs to know one applies and which.
    gate: step.gate || null,
    // Whether this step can park in `pending_input` awaiting a human decision.
    autoAdvances: typeof step.canAutoAdvance !== 'function',
    stage: stages.get(step.jobType) ?? 0
  })).sort((a, b) => a.stage - b.stage || a.jobType.localeCompare(b.jobType));

  return { nodes, stageCount: nodes.length ? Math.max(...nodes.map((n) => n.stage)) + 1 : 0 };
}

module.exports = { buildPipelineGraph, computeStages };
