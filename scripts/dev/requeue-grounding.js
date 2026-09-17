#!/usr/bin/env node
/**
 * Re-run KRT Grounding on submissions whose stored verdicts predate the fix.
 *
 * `e453ccf` changed what a grounding conflict is allowed to say: only values the
 * MANUSCRIPT actually prints may contradict the author, where before an
 * `identifier-scan` candidate could quote the curated enrichment list as though
 * the paper had said it. The code is fixed, but **stored results are not
 * rewritten** — a submission processed before the fix still shows the old
 * conflicts until its grounding step runs again.
 *
 *   node scripts/dev/requeue-grounding.js                  # dry run, writes nothing
 *   node scripts/dev/requeue-grounding.js --apply          # actually re-queue
 *   node scripts/dev/requeue-grounding.js --apply --all     # ignore the date filter
 *
 * ── What a re-run actually costs ─────────────────────────────────────────────
 *
 * Restarting a step takes its dependants with it, because a result built on a
 * replaced input is stale. `krt_grounding` has exactly one dependant —
 * `suggestion_generation` — and that one calls the LM. `pdf_analysis`
 * deliberately does NOT depend on grounding (see the orchestrator's PIPELINE
 * table), so it is not dragged in.
 *
 * So the price of the fix is one LM suggestion run per submission. The dry run
 * prints the count before anything is spent.
 *
 * Local only, by the same reasoning as the demo seeder: this re-queues real
 * pipeline work, and a shared instance is not the place to find that out.
 */

'use strict';

const API_BASE = process.env.API_BASE || 'http://localhost:3030';
const EMAIL = process.env.ASAP_EMAIL || 'admin@example.com';
const PASSWORD = process.env.ASAP_PASSWORD || 'password123';

if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(API_BASE)) {
  console.error(`Refusing to target ${API_BASE} — this script re-queues jobs, and is for a local instance only.`);
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');

/**
 * When the fix landed. A grounding result completed before this carries the old
 * conflict logic; one completed after does not.
 *
 * Taken from the commit rather than guessed:
 *   git show -s --format=%cI e453ccf
 */
const FIX_LANDED = new Date(process.env.FIX_LANDED || '2026-08-27T16:03:48Z');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Log in, carrying back both the cookie and the CSRF header.
 *
 * A write needs the `asap_kr_csrf` cookie echoed in `X-CSRF-Token`; login is
 * exempt from that check, so keeping only the cookies sails through login and
 * 403s on the first real request.
 */
async function login(attempt = 1) {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD })
  });
  // Two logins seconds apart race to write the same session row and 409.
  if (res.status === 409 && attempt < 4) { await sleep(1500 * attempt); return login(attempt + 1); }
  if (res.status === 429) throw new Error('Login rate-limited (429) — 10 attempts per 15 min per IP.');
  if (!res.ok) throw new Error(`Login failed (${res.status})`);

  const setCookies = res.headers.getSetCookie?.() || [];
  const cookies = setCookies.map((c) => c.split(';')[0]);
  const csrf = cookies.find((c) => c.startsWith('asap_kr_csrf='))?.split('=')[1];
  if (!csrf) throw new Error('Login issued no CSRF cookie — every write would 403');
  return { Cookie: cookies.join('; '), 'X-CSRF-Token': csrf };
}

async function get(auth, path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: auth });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

/** Every submission, paged — the list endpoint caps what one call returns. */
async function allSubmissions(auth) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const body = await get(auth, `/api/submissions?page=${page}&limit=50`);
    const batch = body.submissions || body.data || [];
    out.push(...batch);
    if (batch.length < 50) break;
  }
  return out;
}

const GROUNDING = 'krt_grounding';
const DEPENDANT = 'suggestion_generation';

/** The stored grounding step, and whether its verdicts predate the fix. */
function groundingState(jobs) {
  const job = (jobs || []).find((j) => j.jobType === GROUNDING);
  if (!job) return { present: false };

  // `completedAt` is when these verdicts were produced. Fall back to updatedAt
  // for a row that finished before that column existed.
  const at = job.completedAt || job.updatedAt || null;
  const when = at ? new Date(at) : null;
  return {
    present: true,
    status: job.status,
    outcome: job.result?.service?.outcome?.state || null,
    at: when,
    stale: !when || when < FIX_LANDED,
    // `counts.conflicts` is the step's own tally. Summing `data.outcomes`
    // instead looked equivalent and was not: one submission's grounding result
    // carries no `data.outcomes` at all, and the sum silently reported 0
    // conflicts for it — a wrong number that looks like a clean result.
    conflicts: job.result?.counts?.conflicts
      ?? (job.result?.data?.outcomes || []).reduce((n, x) => n + (x.conflicts?.length || 0), 0)
  };
}

async function restart(auth, id) {
  const res = await fetch(`${API_BASE}/api/submissions/${id}/processes/restart`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobTypes: [GROUNDING] })
  });
  if (res.ok) return { ok: true };
  const body = await res.json().catch(() => ({}));
  return { ok: false, why: body.error || `HTTP ${res.status}` };
}

async function main() {
  console.log(`\n  instance   ${API_BASE}`);
  console.log(`  mode       ${APPLY ? 'APPLY — will re-queue' : 'DRY RUN — writes nothing'}`);
  console.log(`  filter     ${ALL ? 'every submission' : `grounding completed before ${FIX_LANDED.toISOString().slice(0, 10)}`}\n`);

  const auth = await login();
  const submissions = await allSubmissions(auth);
  console.log(`  ${submissions.length} submission(s) on this instance\n`);

  const rows = [];
  for (const s of submissions) {
    const { jobs } = await get(auth, `/api/submissions/${s.id}/jobs`);
    rows.push({ s, g: groundingState(jobs) });
  }

  const noGrounding = rows.filter((r) => !r.g.present);
  const notRun = rows.filter((r) => r.g.present && r.g.status !== 'complete');
  const done = rows.filter((r) => r.g.present && r.g.status === 'complete');
  const target = (ALL ? done : done.filter((r) => r.g.stale));

  console.log('  ── grounding step, by state');
  console.log(`     complete                  ${done.length}`);
  console.log(`       of those, predate fix   ${done.filter((r) => r.g.stale).length}`);
  console.log(`     not complete (skipped)    ${notRun.length}`);
  console.log(`     no grounding step at all  ${noGrounding.length}`);

  if (done.length) {
    console.log('\n  ── the complete ones');
    for (const { s, g } of done) {
      const when = g.at ? g.at.toISOString().slice(0, 16).replace('T', ' ') : 'unknown';
      console.log(`     ${String(s.id).slice(0, 8)}  ${when}  ${g.stale ? 'STALE ' : 'fresh '}`
        + `conflicts=${String(g.conflicts).padStart(2)}  ${String(s.title || '').slice(0, 42)}`);
    }
  }

  console.log(`\n  ── what a re-run would do: ${target.length} submission(s)`);
  if (!target.length) {
    console.log('     nothing to re-queue.');
    return;
  }
  console.log(`     re-runs ${GROUNDING} (deterministic matcher + optional LM second look)`);
  console.log(`     and drags ${DEPENDANT} with it — ${target.length} LM suggestion run(s).`);
  console.log('     Author-visible verdicts change; the author\'s own KRT rows are not touched.');

  if (!APPLY) {
    console.log('\n     DRY RUN — nothing was queued. Re-run with --apply to do it.\n');
    return;
  }

  console.log('');
  for (const { s } of target) {
    const r = await restart(auth, s.id);
    console.log(`     ${String(s.id).slice(0, 8)}  ${r.ok ? 're-queued' : `REFUSED: ${r.why}`}`);
  }
  console.log('\n  Re-queued. Watch the pipeline pages for the new verdicts.\n');
}

main().catch((err) => { console.error(`\n  ${err.message}\n`); process.exit(1); });
