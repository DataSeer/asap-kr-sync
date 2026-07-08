#!/usr/bin/env node
/**
 * Bulk-upload documents (PDF + author KRT) into the app via its HTTP API.
 *
 * For every `<id>.pdf` in the input directory that has a matching author KRT
 * (`<id>.xlsx` or `<id>.csv`), this logs in once with a local (DS) account and
 * then, per document:
 *   1. POST /api/submissions            — create the submission WITH the KRT
 *      (the KRT is mandatory at creation; the server validates its format and
 *       creates no submission if it is invalid, so there are no orphans)
 *   2. POST /api/submissions/:id/pdf/upload   — attach the PDF
 *   3. POST /api/submissions/:id/pdf/analyze   — (only with --analyze) queue
 *      the PDF-analysis pipeline so the user doesn't have to click it
 *
 * The API is cookie-based (no bearer tokens): login sets an httpOnly session
 * cookie plus a JS-readable CSRF cookie, and every state-changing request must
 * echo that CSRF value in the `X-CSRF-Token` header (double-submit). This
 * script keeps a small cookie jar and does exactly that.
 *
 * AUTH — credentials come from the environment only (never the CLI, so they
 * don't leak into shell history). Put them in the project .env or export them:
 *   ASAP_EMAIL=you@dataseer.ai
 *   ASAP_PASSWORD=•••••••
 * The account must be allowed to create submissions (author role). Auth0 SSO
 * accounts are NOT supported here — use a local/DS email+password account.
 *
 * Usage:
 *   ASAP_EMAIL=… ASAP_PASSWORD=… node scripts/upload-documents.js --dir DIR [options]
 * Options:
 *   --dir DIR         directory holding <id>.pdf + <id>.(xlsx|csv) pairs (required).
 *                     "<name>-DS<n>.xlsx" DataSeer report files are ignored (not KRTs).
 *   --url URL         API base URL, e.g. https://app.example.com (required; or set
 *                     $ASAP_BASE_URL). No default — the target is always explicit.
 *   --only a,b        only these document ids (basename without extension)
 *   --analyze         queue PDF analysis after upload (default: off — upload only)
 *   --skip-existing   skip a document whose manuscriptId already has a submission
 *   --concurrency N   upload N documents in parallel (default 1; keep low — the
 *                     API rate-limits uploads and LM calls per user)
 *   --dry-run         discover + pair + show the plan, make NO API calls
 *   --help
 *
 * A document id that looks like a manuscript id (e.g. DA1-000463-016-org-G-1)
 * is sent as `manuscriptId` too; otherwise only the title is set (= the id).
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log(fs.readFileSync(__filename, 'utf-8').match(/\/\*\*([\s\S]*?)\*\//)?.[1] || '');
  process.exit(0);
}
const getArg = (name, def) => { const i = argv.indexOf(name); return (i !== -1 && i + 1 < argv.length) ? argv[i + 1] : def; };
const has = (name) => argv.includes(name);

const DIR = getArg('--dir', '');
// Target API base URL — required, no default, so you never accidentally hit the
// wrong environment. Provide it via --url or the ASAP_BASE_URL env var.
const BASE_URL = (getArg('--url', process.env.ASAP_BASE_URL || '')).replace(/\/+$/, '');
const isValidBaseUrl = (u) => /^https?:\/\/.+/i.test(u);
const ONLY = (getArg('--only', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const ANALYZE = has('--analyze');
const SKIP_EXISTING = has('--skip-existing');
const DRY_RUN = has('--dry-run');
const CONCURRENCY = Math.max(1, parseInt(getArg('--concurrency', '1'), 10) || 1);

const EMAIL = process.env.ASAP_EMAIL;
const PASSWORD = process.env.ASAP_PASSWORD;
const MANUSCRIPT_ID_RE = /^[A-Z]{2}\d-\d{6}-\d{3}-org-[A-Z]-\d$/i;
const KRT_MIME = { '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv' };
// DataSeer report spreadsheets (e.g. "<name>-DS1.xlsx") are NOT author KRT
// files — ignore them so they're never picked up as a document's KRT.
const DS_REPORT_RE = /-DS\d+\.xlsx$/i;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Minimal cookie jar (name → value) + CSRF ────────────────────────────────
const jar = new Map();
function storeSetCookies(res) {
  const raw = res.headers?.['set-cookie'] || [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
const csrfToken = () => jar.get('asap_kr_csrf') || '';

/** Auth + CSRF headers for a state-changing request, merged with any extras. */
function authHeaders(extra = {}) {
  const h = { Cookie: cookieHeader(), ...extra };
  const csrf = csrfToken();
  if (csrf) h['X-CSRF-Token'] = csrf;
  return h;
}

// One shared client; we manage cookies ourselves and never throw on non-2xx
// (we inspect status to give clean per-document errors and honour 429s).
const http = axios.create({
  baseURL: BASE_URL,
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
  validateStatus: () => true
});

/** POST that retries on 429 (respecting Retry-After) and transient 5xx. */
async function postWithRetry(url, data, headers, { label }) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await http.post(url, data, { headers });
    storeSetCookies(res);
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt === 4) return res;
    const retryAfter = Number(res.headers?.['retry-after']);
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
    console.log(`    ${label}: HTTP ${res.status}, retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt}/3)`);
    await sleep(waitMs);
  }
}

const errText = (res) => {
  const d = res?.data;
  if (!d) return `HTTP ${res?.status}`;
  return `HTTP ${res.status}: ${d.error || d.message || (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 300)}`;
};

// ── API steps ───────────────────────────────────────────────────────────────
async function login() {
  const res = await http.post('/api/auth/login', { email: EMAIL, password: PASSWORD },
    { headers: { 'Content-Type': 'application/json' } });
  storeSetCookies(res);
  if (res.status !== 200) throw new Error(`Login failed — ${errText(res)}`);
  if (!jar.get('asap_kr_session')) throw new Error('Login succeeded but no session cookie was set');
  if (!csrfToken()) throw new Error('Login succeeded but no CSRF cookie was set');
  return res.data?.user || null;
}

/** Fetch existing manuscriptIds (best-effort, paginated) for --skip-existing. */
async function fetchExistingManuscriptIds() {
  const ids = new Set();
  let page = 1;
  const limit = 100;
  for (; page <= 50; page++) { // hard cap: 5000 submissions
    const res = await http.get(`/api/submissions?page=${page}&limit=${limit}`, { headers: { Cookie: cookieHeader() } });
    storeSetCookies(res);
    if (res.status !== 200) throw new Error(`Could not list submissions — ${errText(res)}`);
    const rows = res.data?.submissions || res.data?.data || res.data?.items || [];
    for (const s of rows) if (s.manuscriptId) ids.add(String(s.manuscriptId).toUpperCase());
    const total = res.data?.meta?.total ?? res.data?.total;
    if (!rows.length || (Number.isFinite(total) && page * limit >= total)) break;
  }
  return ids;
}

async function createSubmission(doc) {
  const form = new FormData();
  form.append('title', doc.title);
  if (doc.manuscriptId) form.append('manuscriptId', doc.manuscriptId);
  form.append('krt', fs.createReadStream(doc.krtPath), {
    filename: path.basename(doc.krtPath),
    contentType: KRT_MIME[doc.krtExt] || 'application/octet-stream'
  });
  const res = await postWithRetry('/api/submissions', form, authHeaders(form.getHeaders()), { label: 'create' });
  if (res.status !== 201) throw new Error(`Create submission failed — ${errText(res)}`);
  const id = res.data?.submission?.id;
  if (!id) throw new Error('Create submission returned no id');
  return id;
}

async function uploadPdf(submissionId, doc) {
  const form = new FormData();
  form.append('file', fs.createReadStream(doc.pdfPath), {
    filename: path.basename(doc.pdfPath), contentType: 'application/pdf'
  });
  const res = await postWithRetry(`/api/submissions/${submissionId}/pdf/upload`, form, authHeaders(form.getHeaders()), { label: 'pdf' });
  if (res.status < 200 || res.status >= 300) throw new Error(`PDF upload failed — ${errText(res)}`);
}

async function triggerAnalysis(submissionId) {
  const res = await postWithRetry(`/api/submissions/${submissionId}/pdf/analyze`, {}, authHeaders({ 'Content-Type': 'application/json' }), { label: 'analyze' });
  if (res.status < 200 || res.status >= 300) throw new Error(`Analyze failed — ${errText(res)}`);
}

// ── Discovery ────────────────────────────────────────────────────────────────
function discover() {
  if (!DIR) { console.error('Missing --dir'); process.exit(1); }
  const root = path.resolve(DIR);
  if (!fs.existsSync(root)) { console.error(`Directory not found: ${root}`); process.exit(1); }
  // Drop DataSeer report spreadsheets up front so a "<id>-DS1.xlsx" can never be
  // mistaken for the author KRT.
  const files = fs.readdirSync(root).filter(f => !DS_REPORT_RE.test(f));
  const docs = [];
  const skipped = [];
  for (const pdf of files.filter(f => f.toLowerCase().endsWith('.pdf'))) {
    const id = pdf.replace(/\.pdf$/i, '');
    if (ONLY.length && !ONLY.includes(id)) continue;
    const krtName = ['.xlsx', '.csv'].map(ext => `${id}${ext}`).find(n => files.includes(n));
    if (!krtName) { skipped.push(`${id} (no matching .xlsx/.csv KRT)`); continue; }
    docs.push({
      id, title: id,
      manuscriptId: MANUSCRIPT_ID_RE.test(id) ? id.toUpperCase() : null,
      pdfPath: path.join(root, pdf),
      krtPath: path.join(root, krtName),
      krtExt: path.extname(krtName).toLowerCase()
    });
  }
  return { docs, skipped };
}

// Run `worker` over `items` with at most `size` in flight; preserves order.
async function runPool(items, size, worker) {
  const results = new Array(items.length);
  let idx = 0;
  const lane = async () => { while (idx < items.length) { const i = idx++; results[i] = await worker(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(size, Math.max(1, items.length)) }, lane));
  return results;
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const { docs, skipped } = discover();
  skipped.forEach(s => console.log(`  - skip: ${s}`));
  if (!docs.length) { console.log('No PDF+KRT pairs to upload.'); return; }

  console.log(`Found ${docs.length} document(s) with a PDF + KRT in ${path.resolve(DIR)}`);
  if (DRY_RUN) {
    console.log('\n[DRY RUN] Plan (no API calls):');
    docs.forEach(d => console.log(`  • ${d.id}  →  create (manuscriptId=${d.manuscriptId || '—'}) + pdf${ANALYZE ? ' + analyze' : ''}`));
    console.log(`\nTarget API: ${BASE_URL || '(not set — pass --url or ASAP_BASE_URL for the real run)'}`);
    return;
  }

  if (!BASE_URL) {
    console.error('Missing target API URL: pass --url https://… (or set ASAP_BASE_URL).');
    process.exit(1);
  }
  if (!isValidBaseUrl(BASE_URL)) {
    console.error(`Invalid --url "${BASE_URL}": must start with http:// or https://`);
    process.exit(1);
  }
  if (!EMAIL || !PASSWORD) {
    console.error('Missing credentials: set ASAP_EMAIL and ASAP_PASSWORD (in .env or the environment).');
    process.exit(1);
  }

  console.log(`Logging in to ${BASE_URL} as ${EMAIL} …`);
  const user = await login().catch(e => { console.error(`  ! ${e.message}`); process.exit(1); });
  console.log(`  logged in${user?.role ? ` (role: ${user.role})` : ''}`);

  let existing = null;
  if (SKIP_EXISTING) {
    existing = await fetchExistingManuscriptIds().catch(e => { console.log(`  ! --skip-existing disabled: ${e.message}`); return null; });
    if (existing) console.log(`  ${existing.size} existing submission(s) with a manuscriptId (for skip check)`);
  }

  const results = await runPool(docs, CONCURRENCY, async (doc) => {
    if (existing && doc.manuscriptId && existing.has(doc.manuscriptId)) {
      console.log(`  = ${doc.id}: already exists (manuscriptId ${doc.manuscriptId}) — skipping`);
      return { id: doc.id, status: 'skipped' };
    }
    try {
      const submissionId = await createSubmission(doc);
      await uploadPdf(submissionId, doc);
      if (ANALYZE) await triggerAnalysis(submissionId);
      console.log(`  ✓ ${doc.id}: created ${submissionId}, PDF uploaded${ANALYZE ? ', analysis queued' : ''}`);
      return { id: doc.id, status: 'ok', submissionId };
    } catch (e) {
      console.log(`  ✗ ${doc.id}: ${e.message}`);
      return { id: doc.id, status: 'failed', error: e.message };
    }
  });

  const ok = results.filter(r => r.status === 'ok');
  const skip = results.filter(r => r.status === 'skipped');
  const failed = results.filter(r => r.status === 'failed');
  console.log(`\nDone — ${ok.length} uploaded${ANALYZE ? ' + queued' : ''}, ${skip.length} skipped, ${failed.length} failed (of ${docs.length}).`);
  if (failed.length) { console.log('Failed:'); failed.forEach(f => console.log(`  - ${f.id}: ${f.error}`)); process.exitCode = 1; }
})().catch(e => { console.error(e); process.exit(1); });
