/**
 * Every module writes the same envelope; only the payload differs.
 *
 * Code that reads results does not know which module it has. The Technical
 * detail panel, the pipeline cards and the jobs API all walk every job type
 * through the same accessors — so a module missing one of the shared keys is not
 * a tidiness problem, it is the one module whose panel renders empty while every
 * other looks fine. That has happened twice: the DAS check stored its meta
 * beside `data` for a commit, and `markdown_convert` had no `data.meta` at all
 * because its worker hand-picked three fields out of a meta the service had been
 * producing the whole time.
 *
 * Neither threw. Neither failed a test. Both were found by looking at a page.
 *
 * So this reads the workers' `markComplete` calls and checks the shape at the
 * seam where it is decided. A behavioural test would need every module stubbed
 * end to end; this catches the mistake actually made — someone assembling a
 * result by hand and leaving a key out.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'workers.js'), 'utf8');

/**
 * Each `markComplete({...})` call in workers.js, with the module it belongs to.
 *
 * Paren-counted rather than regex-terminated: these objects nest several levels
 * and a non-greedy match to the first `})` stops in the middle of the first
 * nested object, which reads as a missing key and fails for the wrong reason.
 */
function markCompleteCalls(source) {
  const out = [];
  const marker = 'markComplete({';
  let at = source.indexOf(marker);

  while (at !== -1) {
    let depth = 0;
    let i = source.indexOf('{', at);
    const start = i;
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = source.slice(start, i + 1);

    // The nearest buildServiceSnapshot('x', ...) inside names the module.
    const named = body.match(/buildServiceSnapshot\('([a-z_]+)'/);
    out.push({ module: named ? named[1] : null, body });
    at = source.indexOf(marker, i);
  }
  return out;
}

const CALLS = markCompleteCalls(SOURCE).filter((c) => c.module);

test('the scan finds the workers it is meant to police', () => {
  // A guard that matches nothing passes forever. There are twelve pipeline
  // modules; report generation and a couple of others complete elsewhere, so
  // this asserts a floor rather than an exact count.
  assert.ok(CALLS.length >= 8,
    `expected most modules to complete through workers.js, found ${CALLS.length}`);
  const modules = new Set(CALLS.map((c) => c.module));
  for (const expected of ['markdown_convert', 'das_extraction', 'materials_detection']) {
    assert.ok(modules.has(expected), `${expected} not found — did the worker move?`);
  }
});

test('every module records a service snapshot and a status', () => {
  // How a result says whether it worked, and what produced it. Without them a
  // job cannot be told apart from one that never ran.
  for (const { module, body } of CALLS) {
    assert.match(body, /service:/, `${module}: no service snapshot`);
    assert.match(body, /status:/, `${module}: no status`);
  }
});

test('every module records what the run did — counts and timing', () => {
  // markdown_convert and das_extraction each lacked `counts`, and
  // das_extraction lacked `timing`. A module with neither reads as "not
  // measured" rather than "measured zero", and those are different answers.
  for (const { module, body } of CALLS) {
    assert.match(body, /counts:/, `${module}: no counts — measured zero and not measured must differ`);
    assert.match(body, /timing:/, `${module}: no timing`);
  }
});

test('every module carries data.meta, which is where a run describes itself', () => {
  // The contract's first rule. `markdown_convert` broke it for months while its
  // service produced a perfectly good meta the worker discarded.
  //
  // Some modules persist their own result instead — pdf_analysis writes it
  // through persistJobData before the worker completes the job, so its
  // markComplete carries no `data` at all. That is the documented second path,
  // not an omission, so a call with no data block is skipped here rather than
  // failed. The next test is what stops that becoming a loophole.
  for (const { module, body } of CALLS) {
    const data = body.match(/data:\s*\{[\s\S]*/);
    if (!data) continue;
    assert.match(data[0], /meta/,
      `${module}: data has no meta — everything that reads results expects one`);
  }
});

test('a module with no data block persists its own result', () => {
  // The loophole the skip above would otherwise open: omit `data` and the meta
  // check no longer applies. So a worker that writes no data must be one whose
  // service already did, and that is checkable.
  // Derived, not hand-listed: a hand-written list is one somebody has to
  // remember to extend, and this one was already wrong — it omitted
  // software_detection, which calls persistJobData at line 122 of its service.
  const SERVICES = path.join(__dirname, '..');
  const persistsOwn = (module) => {
    const guesses = fs.readdirSync(SERVICES, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(SERVICES, d.name));
    for (const dir of guesses) {
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.service.js'))) {
        const src = fs.readFileSync(path.join(dir, file), 'utf8');
        // Two idioms in the tree: `persistJobData(...)` (a local helper several
        // services define) and `job.persistData(...)` straight on the model.
        // Matching only the first missed suggestion_generation.
        const persists = src.includes('persistJobData') || src.includes('.persistData(');
        if (persists && src.includes(module.toUpperCase())) return true;
      }
    }
    return false;
  };

  for (const { module, body } of CALLS) {
    if (/data:\s*\{/.test(body)) continue;
    assert.ok(persistsOwn(module),
      `${module} writes no data and no service persists its own — its result would have none`);
  }
});

test('markdown_convert carries the meta its service produces, not a hand-picked subset', () => {
  // The specific regression: three fields copied out and the rest dropped. The
  // service records convertMs, rawMarkdownLength and filterStats too, and those
  // are exactly what someone debugging a bad conversion wants.
  const md = CALLS.find((c) => c.module === 'markdown_convert');

  assert.ok(md, 'markdown_convert worker not found');
  assert.match(md.body, /meta: result\.data\?\.meta/,
    'the whole meta must be carried through, not rebuilt field by field');
});
