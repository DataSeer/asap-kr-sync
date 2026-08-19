/**
 * The pipeline graph is derived from the table that actually executes, so the
 * risk it guards against is drift: a dependency added to the orchestrator and
 * forgotten everywhere else. These assert the derivation, not a snapshot.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildPipelineGraph, computeStages } = require('./pipeline-graph.service');
const { PIPELINE } = require('./orchestrator.service');

test('every executing step appears in the graph, with its real dependencies', () => {
  const { nodes } = buildPipelineGraph();
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
    if (n.dependsOn.length === 0) assert.equal(n.stage, 0, `${n.jobType} has no dependencies`);
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
