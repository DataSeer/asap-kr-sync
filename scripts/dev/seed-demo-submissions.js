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
const { execFileSync } = require('child_process');

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
    key: 'partial',
    manuscript: 'JS2-020551-021-org-G-1',
    title: 'DEMO — a degraded step: Softcite failed, the LM pass carried it',
    notes: 'Walkthrough: a partial outcome — what still ran, and what did not.',
    pipelineId: null,
    breakStep: {
      jobType: 'software_detection',
      hosts: ['snapshot.dataseer.ai'],
      expect: 'partial'
    },
    shows: 'partial outcome · Softcite failed, LM carried the step'
  },
  {
    key: 'retry',
    manuscript: 'JH1-000478-028-org-G-1',
    title: 'DEMO — a failed detection step, and the choice it gives you',
    notes: 'Walkthrough: Retry the step, or Continue without it.',
    pipelineId: null,
    breakStep: {
      jobType: 'materials_detection',
      hosts: ['generativelanguage.googleapis.com'],
      expect: 'fail'
    },
    shows: 'failed detection step · Retry / Continue without it'
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
async function login(attempt = 1) {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD })
  });

  // 409 is a unique-constraint collision, not a bad password: two logins close
  // together race to write the same session row. This script renews its token
  // during long waits, so two renewals seconds apart are normal — and a
  // transient 409 read as "Login failed — is the instance running?", which sent
  // the last run looking at the wrong thing entirely.
  if (res.status === 409 && attempt < 4) {
    await sleep(1500 * attempt);
    return login(attempt + 1);
  }
  // 429 is the auth limiter: 10 attempts per 15 minutes per IP. Retrying inside
  // that window cannot succeed, so say what it is rather than blaming the
  // instance — and note that renewing on a TIMER is what exhausts it. Renewals
  // here are reactive, on an actual 401, which costs one or two per run.
  if (res.status === 429) {
    throw new Error('Login rate-limited (429) — 10 attempts per 15 min per IP. Wait for the window to clear.');
  }
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

/**
 * Renew the session in place.
 *
 * The token outlives a short script and not a long one. Seeding waits on real
 * pipelines — one manuscript's conversion took 28 minutes to fail — and the
 * session expired mid-run: the next submission's create returned 401, the run
 * before it had already had its re-run refused as "Invalid token", and both
 * cases were reported as ordinary refusals rather than as an expired login.
 *
 * Mutating the SAME object matters. Every caller passes `auth` by reference and
 * reads it at fetch time, so replacing its contents updates every holder;
 * returning a new object would leave the long-lived ones on the dead token.
 */
async function refresh(auth) {
  Object.assign(auth, await login());
  return auth;
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

async function jobs(auth, submissionId, renewed = false) {
  const res = await fetch(`${API_BASE}/api/submissions/${submissionId}/jobs`, {
    headers: auth
  });
  // The token expires during long waits — one manuscript's conversion took 28
  // minutes. Renew when the server says so, once, rather than on a timer: a
  // timer spends logins whether or not any were needed, and the auth limiter
  // allows ten per quarter hour.
  if (res.status === 401 && !renewed) {
    await refresh(auth);
    return jobs(auth, submissionId, true);
  }
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
async function rerun(auth, submissionId, jobType, renewed = false) {
  const res = await fetch(`${API_BASE}/api/submissions/${submissionId}/processes/restart`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobTypes: [jobType] })
  });
  if (res.status === 401 && !renewed) {
    await refresh(auth);
    return rerun(auth, submissionId, jobType, true);
  }
  if (res.ok) return { ok: true };
  const body = await res.json().catch(() => ({}));
  return { ok: false, why: body.error || `HTTP ${res.status}` };
}


// ─────────────────────────────────────────────────────────────────────────────
// Breaking a step on purpose
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Make one external service unreachable, so a step fails for a REAL reason.
 *
 * The alternative — writing `failed` onto a job row — produces a demo that
 * falls apart the moment anyone presses the button it exists to show: the logs
 * describe a run that never happened, and Retry re-runs a step that was never
 * broken. Blocking the host means the failure, the error message, the paused
 * dependants and the retry are all genuine.
 *
 * `/etc/hosts` rather than the env, for two reasons. The env lives in `.env`,
 * which this script has no business rewriting, and changing it needs a restart;
 * a hosts entry takes effect on the next DNS lookup and is gone the moment it
 * is removed. The entries are marked so the undo can find exactly its own work.
 *
 * NOTE: `sed -i` cannot do this. `/etc/hosts` is a bind mount, so the rename
 * sed does behind the scenes fails with EBUSY and the file is left blocked.
 */
const HOSTS_MARK = '# asap-demo-seed';

function blockHosts(hosts) {
  // One append per host. Joining them with a newline inside a single quoted
  // argument does NOT work: the escape survives into the shell as the two
  // characters backslash-n, and the second host lands on the first one's line.
  const cmd = hosts
    .map((h) => `printf '%s\\n' ${JSON.stringify(`127.0.0.1 ${h} ${HOSTS_MARK}`)} >> /etc/hosts`)
    .join(' && ');
  execFileSync('docker', ['compose', 'exec', '-T', 'app', 'sh', '-c', cmd], { cwd: ROOT, stdio: 'pipe' });
}

function unblockHosts() {
  // Rewrite in place — see the note above about EBUSY.
  execFileSync('docker', ['compose', 'exec', '-T', 'app', 'sh', '-c',
    `grep -v '${HOSTS_MARK}' /etc/hosts > /tmp/h.$$ && cat /tmp/h.$$ > /etc/hosts && rm -f /tmp/h.$$`],
  { cwd: ROOT, stdio: 'pipe' });
}

/** What is still blocked, if anything — so a crash cannot leave the box broken. */
function blockedHosts() {
  const out = execFileSync('docker', ['compose', 'exec', '-T', 'app', 'sh', '-c',
    `grep '${HOSTS_MARK}' /etc/hosts || true`], { cwd: ROOT, stdio: 'pipe' }).toString();
  return out.split('\n').filter(Boolean);
}

/**
 * Re-run one step with its service unreachable, then put the service back.
 *
 * Restarting a single step is what gives a clean demo: the rest of the pipeline
 * keeps its good results, and exactly one module shows the state being
 * demonstrated. Blocking for the whole original run would have failed every
 * step that shares the service.
 *
 * The service is restored before anyone sees the page, so Retry SUCCEEDS — the
 * point of the demo is the choice the interface offers, not a dead end.
 */
async function breakStep(auth, submissionId, spec) {
  blockHosts(spec.hosts);
  try {
    const started = await rerun(auth, submissionId, spec.jobType);
    if (!started.ok) return { ok: false, why: started.why };
    await waitForPipeline(auth, submissionId, { minutes: 10 });
  } finally {
    unblockHosts();
  }
  process.stdout.write('\r');

  const list = await jobs(auth, submissionId);
  const target = list.find((j) => j.jobType === spec.jobType);
  return {
    ok: true,
    status: target?.status,
    outcome: target?.result?.service?.outcome?.state,
    failReason: target?.result?.service?.outcome?.failReason
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const only = arg('--only');
  const attach = arg('--attach');
  // Comma-separated, because the cases worth seeding together are rarely one.
  const wanted = only ? only.split(',').map((k) => k.trim()).filter(Boolean) : null;
  const queue = PLAN.filter((p) => !wanted || wanted.includes(p.key));
  const unknown = (wanted || []).filter((k) => !PLAN.some((p) => p.key === k));
  if (unknown.length) throw new Error(`unknown --only key(s): ${unknown.join(', ')}`);
  // Attaching applies ONE entry's break to ONE existing submission; with a
  // wider queue it would silently point every case at the same submission.
  if (attach && queue.length !== 1) {
    throw new Error('--attach needs exactly one --only key');
  }

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

    // --attach re-uses a submission a previous run created but could not finish
    // breaking, rather than leaving a healthy duplicate behind.
    const submission = attach
      ? { id: attach }
      : await createSubmission(auth, entry, files);
    if (attach) console.log(`      attached to ${attach} (not created)`);
    console.log(`      created ${submission.id}${entry.pipelineId ? ` (${entry.pipelineId})` : ''}`);

    if (!attach) {
      await uploadPdf(auth, submission.id, files.pdf);
      await advancePastKrt(auth, submission.id);
      console.log('      pipeline started');
    }

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

    if (entry.breakStep) {
      const { jobType, hosts, expect } = entry.breakStep;
      console.log(`      breaking ${jobType} — ${hosts.join(', ')} unreachable`);
      const broke = await breakStep(auth, submission.id, entry.breakStep);

      if (!broke.ok) {
        console.log(`      re-run REFUSED: ${broke.why} — this case will not demo.`);
      } else {
        const got = broke.outcome || broke.status;
        console.log(`      ${jobType} is now ${broke.status}`
          + (broke.outcome ? ` / outcome ${broke.outcome}` : '')
          + (broke.failReason ? ` (${broke.failReason})` : ''));
        // Say so rather than let a case that did not break read as one that did.
        const wanted = expect === 'partial' ? 'partial' : 'fail';
        if (got !== wanted) {
          console.log(`      NOTE: expected ${wanted}, got ${got} — check this page before demoing it.`);
        }
      }
      console.log(`      services restored${blockedHosts().length ? ' — WARNING: /etc/hosts still has entries' : ''}`);
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
