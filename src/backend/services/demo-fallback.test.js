/**
 * Tests for the demo-fallback workflow helper.
 * Run with: node --test src/backend/services/demo-fallback.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runWithDemoFallback, configState, isFinalAttempt } = require('./demo-fallback.service');

const ITEMS = [{ name: 'a' }, { name: 'b' }];
const DEMO = { items: ITEMS, meta: { demo: true } };
const EXTERNAL = { items: ITEMS, meta: { ms: 42 } };

const ext = (val) => () => Promise.resolve(val);
const extThrow = (msg) => () => Promise.reject(new Error(msg));
const demo = (val) => () => Promise.resolve(val);

// --- The 8 branches of the decision tree ---

test('config=on: external success → done/external', async () => {
  const r = await runWithDemoFallback({
    isExternalEnabled: true, demoEnabled: true,
    runExternal: ext(EXTERNAL), getDemoData: demo(DEMO),
    isFinalAttempt: true
  });
  assert.equal(r.status, 'done');
  assert.equal(r.source, 'external');
  assert.equal(r.failReason, null);
  assert.equal(r.externalError, null);
  assert.deepEqual(r.data.items, ITEMS);
});

test('config=on: external fails before final attempt → throws (pg-boss retries)', async () => {
  await assert.rejects(
    runWithDemoFallback({
      isExternalEnabled: true, demoEnabled: true,
      runExternal: extThrow('boom'), getDemoData: demo(DEMO),
      isFinalAttempt: false
    }),
    /boom/
  );
});

test('config=on+demo: external fails on final attempt, demo found → done/demo', async () => {
  const r = await runWithDemoFallback({
    isExternalEnabled: true, demoEnabled: true,
    runExternal: extThrow('upstream 503'), getDemoData: demo(DEMO),
    isFinalAttempt: true
  });
  assert.equal(r.status, 'done');
  assert.equal(r.source, 'demo');
  assert.equal(r.externalError, 'upstream 503');
  assert.deepEqual(r.data.items, ITEMS);
});

test('config=on+demo: external fails on final attempt, no demo for PDF → fail', async () => {
  const r = await runWithDemoFallback({
    isExternalEnabled: true, demoEnabled: true,
    runExternal: extThrow('upstream 503'), getDemoData: demo(null),
    isFinalAttempt: true
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.source, null);
  assert.equal(r.failReason, 'external_failed_no_demo_data');
  assert.equal(r.externalError, 'upstream 503');
});

test('config=on (no demo): external fails on final attempt → fail/external_failed_demo_disabled', async () => {
  const r = await runWithDemoFallback({
    isExternalEnabled: true, demoEnabled: false,
    runExternal: extThrow('boom'), getDemoData: demo(DEMO),
    isFinalAttempt: true
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.failReason, 'external_failed_demo_disabled');
  assert.equal(r.externalError, 'boom');
});

test('config=demo: demo data found → done/demo', async () => {
  const r = await runWithDemoFallback({
    isExternalEnabled: false, demoEnabled: true,
    runExternal: ext(EXTERNAL), getDemoData: demo(DEMO),
    isFinalAttempt: true
  });
  assert.equal(r.status, 'done');
  assert.equal(r.source, 'demo');
  assert.equal(r.externalError, null);
  assert.deepEqual(r.data.items, ITEMS);
});

test('config=demo: no demo for this PDF → fail/process_off_no_demo_data', async () => {
  const r = await runWithDemoFallback({
    isExternalEnabled: false, demoEnabled: true,
    runExternal: ext(EXTERNAL), getDemoData: demo(null),
    isFinalAttempt: true
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.failReason, 'process_off_no_demo_data');
});

test('config=off: → done/null (intentionally off, no data)', async () => {
  const r = await runWithDemoFallback({
    isExternalEnabled: false, demoEnabled: false,
    runExternal: ext(EXTERNAL), getDemoData: demo(DEMO),
    isFinalAttempt: true
  });
  assert.equal(r.status, 'done');
  assert.equal(r.source, null);
  assert.equal(r.failReason, null);
  assert.deepEqual(r.data.items, []);
});

// --- Edge cases ---

test('demo lookup throwing is treated as no-demo, not as helper failure', async () => {
  const r = await runWithDemoFallback({
    isExternalEnabled: false, demoEnabled: true,
    runExternal: ext(EXTERNAL),
    getDemoData: () => Promise.reject(new Error('demo file corrupted')),
    isFinalAttempt: true
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.failReason, 'process_off_no_demo_data');
});

test('external returns empty result is still done/external (not fail)', async () => {
  const r = await runWithDemoFallback({
    isExternalEnabled: true, demoEnabled: true,
    runExternal: ext({ items: [], meta: {} }), getDemoData: demo(DEMO),
    isFinalAttempt: true
  });
  assert.equal(r.status, 'done');
  assert.equal(r.source, 'external');
  assert.equal(r.data.items.length, 0);
});

test('configState: on/demo/off mapping', () => {
  assert.equal(configState({ isExternalEnabled: true,  demoEnabled: true  }), 'on');
  assert.equal(configState({ isExternalEnabled: true,  demoEnabled: false }), 'on');
  assert.equal(configState({ isExternalEnabled: false, demoEnabled: true  }), 'demo');
  assert.equal(configState({ isExternalEnabled: false, demoEnabled: false }), 'off');
});

test('isFinalAttempt: retrycount >= retryLimit', () => {
  assert.equal(isFinalAttempt({ retrycount: 0 }, 2), false);
  assert.equal(isFinalAttempt({ retrycount: 1 }, 2), false);
  assert.equal(isFinalAttempt({ retrycount: 2 }, 2), true);
  assert.equal(isFinalAttempt({ retrycount: 3 }, 2), true);
  // Defensive: missing fields shouldn't crash.
  assert.equal(isFinalAttempt(undefined, 2), false);
  assert.equal(isFinalAttempt({}, undefined), true); // 0 >= 0
});
