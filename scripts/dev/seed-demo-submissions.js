#!/usr/bin/env node
/**
 * Create submissions on the LOCAL instance for a feature walkthrough.
 *
 * Four submissions, each chosen to make one of the recent changes visible on a
 * page rather than described in a slide:
 *
 *   1. complete   a clean run, all twelve steps — module pages, Technical
 *                 detail, the Pipeline page.
 *   2. rerun      the same, then one step re-run, so the Run selector has two
 *                 runs to choose between and a past one to mark read-only.
 *   3. failed     a manuscript whose conversion fails, so the pipeline pauses
 *                 and offers Retry / Continue without it.
 *   4. blind      created with the admin-only `blind-v1` arm, so the pipeline
 *                 selector has been used and the results differ visibly.
 *
 * WRITES DATA, and only ever to whatever API_BASE points at. It refuses to run
 * against anything but localhost — seeding a shared instance with demo rows is
 * the kind of mistake that is discovered weeks later by somebody else.
 *
 * Goes through the HTTP API rather than the models, deliberately: that is the
 * path a real submission takes, so it exercises the create guard, the KRT
 * parse, the pipelineId stamp and the pipeline start exactly as a person would.
 *
 *   node scripts/dev/seed-demo-submissions.js --dry-run
 *   node scripts/dev/seed-demo-submissions.js
 *   node scripts/dev/seed-demo-submissions.js --only complete
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const API_BASE = process.env.API_BASE || 'http://localhost:3030';
const DEMO_DIR = path.join(ROOT, 'src/frontend/public/demo-files');

// Local only. A shared instance is not somewhere demo rows belong, and the
// damage is quiet — nobody notices until they are auditing submission counts.
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(API_BASE)) {
  console.error(`Refusing to seed ${API_BASE} — this script writes, and is for a local instance only.`);
  process.exit(1);
}

const EMAIL = process.env.ASAP_EMAIL || 'admin@example.com';
const PASSWORD = process.env.ASAP_PASSWORD || 'password123';

/**
 * The four, and what each is for.
 *
 * Manuscripts are picked small on purpose: a 40-row table shows every feature a
 * 335-row one does, converts faster, and costs a fraction as much. The failure
 * case uses the one manuscript whose conversion has failed reproducibly for
 * weeks — a real failure beats a simulated one, and it costs nothing because it
 * never reaches a model.
 */
const PLAN = [
  {
    key: 'complete',
    manuscript: 'TV1-000430-007-org-G-2',
    title: 'DEMO — a clean run, all twelve steps',
    notes: 'Walkthrough: module pages, Technical detail, the Pipeline page.',
    pipelineId: null,
    shows: 'module pages · Technical detail · Pipeline'
  },
  {
    key: 'rerun',
    manuscript: 'JS2-020551-021-org-G-1',
    title: 'DEMO — a step re-run, so there are two runs to compare',
    notes: 'Walkthrough: the Run selector, and a past run marked read-only.',
    pipelineId: null,
    rerunStep: 'materials_detection',
    shows: 'Run selector · read-only past run'
  },
  {
    key: 'failed',
    manuscript: 'XC1-000312-009-org-D-4',
    title: 'DEMO — a failed step, and the choice it gives you',
    notes: 'Walkthrough: a paused pipeline, Retry, and Continue without it.',
    pipelineId: null,
    expectFailure: true,
    shows: 'paused pipeline · Retry / Continue without it'
  },
  {
    key: 'blind',
    manuscript: 'ML1-000592-006-org-G-1',
    title: 'DEMO — created with the KRT-blind detection arm',
    notes: 'Walkthrough: the admin-only pipeline selector, and how the results differ.',
    pipelineId: 'blind-v1',
    shows: 'detection pipeline selector · blind-v1 results'
  }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? null : process.argv[at + 1];
};

/**
 * Log in, and carry back what a state-changing request needs.
 *
 * Two things, not one. Auth is a cookie, and every write additionally needs the
 * CSRF double-submit: the `asap_kr_csrf` cookie's value echoed in an
 * `X-CSRF-Token` header. Login is exempt from that check — it is what issues the
 * cookie — so a script that kept only the cookies sails through login and gets a
 * 403 on its first real request. Which is exactly what happened.
 */
async function login() {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD })
  });
  if (!res.ok) throw new Error(`Login failed (${res.status}) — is the instance running, and seeded?`);

  const setCookies = res.headers.getSetCookie?.() || [];
  const cookies = setCookies.map((c) => c.split(';')[0]).join('; ');
  if (!cookies) throw new Error('Login returned no cookies');

  const csrf = setCookies
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('asap_kr_csrf='))
    ?.split('=')[1];
  if (!csrf) throw new Error('Login issued no CSRF cookie — every write would 403');

  return { Cookie: cookies, 'X-CSRF-Token': csrf };
}

function demoFiles(manuscriptId) {
  const all = fs.readdirSync(DEMO_DIR);
  const pdf = all.find((f) => f === `${manuscriptId}.pdf`);
  const krt = all.find((f) => /\.(csv|xlsx)$/i.test(f) && f.replace(/\.[^.]+$/, '') === manuscriptId);
  return {
    pdf: pdf ? path.join(DEMO_DIR, pdf) : null,
    krt: krt ? path.join(DEMO_DIR, krt) : null
  };
}

async function createSubmission(auth, entry, files) {
  const form = new FormData();
  form.append('title', entry.title);
  form.append('notes', entry.notes);
  if (entry.pipelineId) form.append('pipelineId', entry.pipelineId);
  form.append('krt', new Blob([fs.readFileSync(files.krt)]), path.basename(files.krt));

  const res = await fetch(`${API_BASE}/api/submissions`, {
    method: 'POST', headers: auth, body: form
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`create failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
  return body.submission;
}

async function uploadPdf(auth, submissionId, pdfPath) {
  const form = new FormData();
  // The field is `file`, not `pdf` — `uploadPDF.single('file')` on the route.
  // Create uses `krt`; they do not match, and multer rejects a wrong field name
  // with a bare 400 that says nothing about which field it wanted.
  form.append('file', new Blob([fs.readFileSync(pdfPath)]), path.basename(pdfPath));

  const res = await fetch(`${API_BASE}/api/submissions/${submissionId}/pdf/upload`, {
    method: 'POST', headers: auth, body: form
  });
  if (!res.ok) throw new Error(`pdf upload failed (${res.status})`);
  return res.json();
}

/**
 * Leave the KRT step, which is what releases detection.
 *
 * Eight of the twelve steps are gated on `krt_curated`, and the gate lifts when
 * the submission's status moves off `step_krt` — the same thing a person does
 * by pressing Continue.
 */
async function advancePastKrt(auth, submissionId) {
  const res = await fetch(`${API_BASE}/api/submissions/${submissionId}`, {
    method: 'PATCH',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'step_pdf' })
  });
  if (!res.ok) throw new Error(`advance failed (${res.status})`);
}

async function jobs(auth, submissionId) {
  const res = await fetch(`${API_BASE}/api/submissions/${submissionId}/jobs`, {
    headers: auth
  });
  if (!res.ok) return [];
  return (await res.json()).jobs || [];
}

/**
 * Wait until nothing is still moving, or the budget runs out.
 *
 * A step gated to a LATER workflow step is not "still moving" — it is parked
 * until the submission gets there. `das_suggestions` is gated to step 4, so on a
 * submission sitting at step 2 it stays `waiting` indefinitely and a naive loop
 * spends its whole budget on a job that was never going to finish. That is what
 * happened: 11/12 complete, one waiting, fourteen minutes burned per submission.
 *
 * The API already says so — `waitingReason: 'availability_step'` — which is the
 * same signal the module pages use to avoid reporting a future step as this
 * stage's unfinished work.
 */
async function waitForPipeline(auth, submissionId, { minutes = 14 } = {}) {
  const deadline = Date.now() + minutes * 60_000;
  const moving = new Set(['queued', 'processing', 'retrying']);
  const parkedForLater = new Set(['availability_step']);

  const stillMoving = (j) => moving.has(j.status)
    || (j.status === 'waiting' && !parkedForLater.has(j.waitingReason));

  while (Date.now() < deadline) {
    const list = await jobs(auth, submissionId);
    const busy = list.filter(stillMoving);
    if (list.length && busy.length === 0) return list;

    const done = list.filter((j) => j.status === 'complete').length;
    process.stdout.write(`\r      ${done}/${list.length} complete, ${busy.length} still moving   `);
    await sleep(10_000);
  }
  process.stdout.write('\n');
  return jobs(auth, submissionId);
}

/**
 * Run a step a second time, so its page has two runs to choose between.
 *
 * `/jobs/:type/retry` is NOT this — it is the answer to a FAILURE, and it
 * refuses a step that finished cleanly ("This step finished cleanly — there is
 * nothing to retry"). Re-running a healthy step is a restart, which also takes
 * its dependants with it, which is the honest behaviour: a re-run detector
 * invalidates the consolidation built on top of it.
 */
async function rerun(auth, submissionId, jobType) {
  const res = await fetch(`${API_BASE}/api/submissions/${submissionId}/processes/restart`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobTypes: [jobType] })
  });
  if (res.ok) return { ok: true };
  const body = await res.json().catch(() => ({}));
  return { ok: false, why: body.error || `HTTP ${res.status}` };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const only = arg('--only');
  const queue = PLAN.filter((p) => !only || p.key === only);

  console.log(`instance   ${API_BASE}`);
  console.log(`user       ${EMAIL}`);
  console.log(`creating   ${queue.length} submission(s)\n`);

  for (const entry of queue) {
    const files = demoFiles(entry.manuscript);
    const ok = files.pdf && files.krt;
    console.log(`  ${entry.key.padEnd(9)} ${entry.manuscript.padEnd(26)} ${ok ? '' : 'MISSING FILES — will skip'}`);
    console.log(`  ${''.padEnd(9)} shows: ${entry.shows}`);
  }
  if (dryRun) { console.log('\n--dry-run: nothing created.'); return; }

  const auth = await login();
  const made = [];

  for (const entry of queue) {
    const files = demoFiles(entry.manuscript);
    if (!files.pdf || !files.krt) {
      console.log(`\n  SKIP ${entry.key} — no PDF/KRT pair for ${entry.manuscript}`);
      continue;
    }

    console.log(`\n  ${entry.key} — ${entry.manuscript}`);
    const submission = await createSubmission(auth, entry, files);
    console.log(`      created ${submission.id}${entry.pipelineId ? ` (${entry.pipelineId})` : ''}`);

    await uploadPdf(auth, submission.id, files.pdf);
    await advancePastKrt(auth, submission.id);
    console.log('      pipeline started');

    const finished = await waitForPipeline(auth, submission.id);
    const complete = finished.filter((j) => j.status === 'complete').length;
    /**
     * What "this pipeline needs a decision" actually looks like.
     *
     * Not just `failed`. A step can finish CLEANLY and produce nothing usable —
     * the conversion returns `status: complete` with `outcome.state: 'fail'`,
     * which is the `produced` gate holding its dependants back rather than
     * letting ten steps read an empty document. Looking only at the status
     * missed it and reported a textbook failure case as a clean run.
     */
    const needsDecision = (j) => ['failed', 'pending_input'].includes(j.status)
      || j.result?.service?.outcome?.state === 'fail'
      || j.waitingReason === 'blocked_by_failure';
    const stuck = finished.filter(needsDecision);
    process.stdout.write('\r');
    console.log(`      ${complete}/${finished.length} complete`
      + (stuck.length ? `, ${stuck.length} needing a decision (${stuck.map((j) => j.jobType).join(', ')})` : ''));

    if (entry.expectFailure && !stuck.length) {
      console.log('      NOTE: expected a failure here and got none — the walkthrough step 4 will not demo.');
    }
    if (entry.rerunStep) {
      const started = await rerun(auth, submission.id, entry.rerunStep);
      if (!started.ok) {
        // Say so, rather than claiming a second run that does not exist. The
        // first version printed "second run recorded" unconditionally, which is
        // how a refused restart read as a success.
        console.log(`      re-run of ${entry.rerunStep} REFUSED: ${started.why}`);
        console.log('      NOTE: the Run selector will have nothing to switch between.');
      } else {
        console.log(`      re-running ${entry.rerunStep} (and its dependants)`);
        await waitForPipeline(auth, submission.id, { minutes: 10 });
        process.stdout.write('\r');
        const runs = await jobs(auth, submission.id);
        const target = runs.find((j) => j.jobType === entry.rerunStep);
        console.log(`      ${entry.rerunStep} is now on run ${target?.runCount ?? '?'}`);
      }
    }

    made.push({ ...entry, id: submission.id });
  }

  console.log('\n── ready for the walkthrough ─────────────────────────────────────────');
  for (const m of made) {
    console.log(`  ${m.shows}`);
    console.log(`    ${API_BASE.replace('3030', '5199')}/submissions/${m.id}/pipeline\n`);
  }
  console.log('Local instance only. Nothing was created on dev.');
}

main().catch((err) => { console.error(`\n${err.message}`); process.exit(1); });
