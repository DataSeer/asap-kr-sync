/**
 * The pipeline graph is derived from the table that actually executes, so the
 * risk it guards against is drift: a dependency added to the orchestrator and
 * forgotten everywhere else. These assert the derivation, not a snapshot.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildPipelineGraph, computeStages } = require('./pipeline-graph.service');
const { PIPELINE } = require('./orchestrator.service');

/** The graph also describes standalone jobs; these assertions are about the
 *  half derived from the executing table. */
const scheduledNodes = () => buildPipelineGraph().nodes.filter((n) => !n.standalone);

test('every executing step appears in the graph, with its real dependencies', () => {
  const nodes = scheduledNodes();
  assert.equal(nodes.length, PIPELINE.length, 'no step is dropped');
  for (const step of PIPELINE) {
    const node = nodes.find((n) => n.jobType === step.jobType);
    assert.ok(node, `${step.jobType} missing from the graph`);
    assert.deepEqual(node.dependsOn, step.dependsOn || [],
      `${step.jobType}: the graph must report what the orchestrator actually waits for`);
  }
});

test('a step always sits in a later stage than everything it waits for', () => {
  // This is the property that makes the graph drawable as columns. Shortest-path
  // depth would break it: PDF Analysis waits on both a detector and grounding,
  // and would land alongside the very step it waits for.
  const { nodes } = buildPipelineGraph();
  const stageOf = new Map(nodes.map((n) => [n.jobType, n.stage]));
  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      assert.ok(stageOf.get(dep) < n.stage,
        `${n.jobType} (stage ${n.stage}) must come after ${dep} (stage ${stageOf.get(dep)})`);
    }
  }
});

test('roots are stage 0, and stageCount covers every stage', () => {
  const { nodes, stageCount } = buildPipelineGraph();
  for (const n of nodes) {
    // Only SCHEDULED roots are stage 0. A standalone job also has no
    // dependencies, but it is placed by meaning rather than by depth — nothing
    // schedules it, so "how deep is it in the graph" has no answer.
    if (!n.standalone && n.dependsOn.length === 0) {
      assert.equal(n.stage, 0, `${n.jobType} has no dependencies`);
    }
    assert.ok(n.stage < stageCount);
  }
  assert.ok(nodes.some((n) => n.stage === stageCount - 1), 'the last stage is not empty');
});

test('gates are reported by name, and pausing steps are flagged', () => {
  const { nodes } = buildPipelineGraph();
  const grounding = nodes.find((n) => n.jobType === 'krt_grounding');
  assert.deepEqual(grounding.gates.sort(), ['krt_curated', 'markdown_ready'],
    'the client needs to know which gates apply');
  const detector = nodes.find((n) => n.jobType === 'materials_detection');
  assert.ok(detector.gates.includes('krt_curated'),
    'the seeded detectors wait for the KRT to be validated');
  assert.ok(detector.gates.includes('markdown_ready'),
    'nothing that reads the manuscript runs without converted text');
  const convert = nodes.find((n) => n.jobType === 'markdown_convert');
  assert.deepEqual(convert.gates, [], 'the step that PRODUCES the text cannot wait for it');
  const analysis = nodes.find((n) => n.jobType === 'pdf_analysis');
  assert.equal(analysis.autoAdvances, false, 'it can park in pending_input awaiting a DAS');
  // A function must never be serialised to the client.
  for (const n of nodes) for (const g of n.gates) assert.equal(typeof g, 'string');
});

test('computeStages does not hang on a cycle', () => {
  // Cannot happen in a valid pipeline, but a bad edit must not take the server
  // down — the graph may look wrong, and that is the correct trade.
  const stages = computeStages([
    { jobType: 'a', dependsOn: ['b'] },
    { jobType: 'b', dependsOn: ['a'] }
  ]);
  assert.equal(stages.size, 2);
});

// ── standalone jobs ─────────────────────────────────────────────────────────
// The DAS check is not in the executing table and must never get there — the
// graph only DESCRIBES it, so a curator can see it and open its page.

test('the DAS check appears in the graph, marked as standalone', () => {
  const { nodes } = buildPipelineGraph();
  const das = nodes.find((n) => n.jobType === 'das_suggestions');

  assert.ok(das, 'the module a user can open must be described somewhere');
  assert.equal(das.standalone, true);
  assert.equal(das.startedFrom, 'availability', 'the card has to say where to start it');
});

test('it is NOT in the executing pipeline', () => {
  // The load-bearing one. In PIPELINE it would be scheduled, sit in `waiting`,
  // and hold the KRT/PDF steps' "all processes finished" gate shut.
  const { PIPELINE } = require('./orchestrator.service');
  assert.equal(PIPELINE.some((s) => s.jobType === 'das_suggestions'), false);
});

test('it sits in the last stage, and does not create one of its own', () => {
  const { nodes, stageCount } = buildPipelineGraph();
  const das = nodes.find((n) => n.jobType === 'das_suggestions');

  assert.equal(das.stage, stageCount - 1, 'it belongs beside the other Suggest-stage work');
  // stageCount is computed from the scheduled steps only: a standalone job must
  // not stretch the diagram by inventing a stage nothing else occupies.
  const scheduledMax = Math.max(...nodes.filter((n) => !n.standalone).map((n) => n.stage));
  assert.equal(stageCount, scheduledMax + 1);
});

test('nothing depends on it, and it depends on nothing', () => {
  // It is unscheduled in both directions: no step waits for it, and it waits
  // for no step — otherwise the "waiting for" text would describe an edge the
  // orchestrator does not have.
  const { nodes } = buildPipelineGraph();
  const das = nodes.find((n) => n.jobType === 'das_suggestions');

  assert.deepEqual(das.dependsOn, []);
  assert.deepEqual(das.gates, []);
  for (const n of nodes) {
    assert.ok(!n.dependsOn.includes('das_suggestions'),
      `${n.jobType} must not depend on a job nothing schedules`);
  }
});

test('every scheduled step is still marked as such', () => {
  const { nodes } = buildPipelineGraph();
  const scheduled = nodes.filter((n) => !n.standalone).map((n) => n.jobType);
  const { PIPELINE } = require('./orchestrator.service');

  assert.deepEqual(scheduled.sort(), PIPELINE.map((s) => s.jobType).sort(),
    'the graph\'s scheduled half must be exactly the executing table');
});
