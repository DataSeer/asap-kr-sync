#!/usr/bin/env node
/**
 * KRT content quality check — offline diagnostic (+ optional auto-fix).
 *
 * Reuses the app's validation CORE (validator.service.validateRowValues — the
 * same per-field rules the app runs) and pulls the canonical RESOURCE TYPES
 * live from the app via its API (GET /api/config/resource-types), so the check
 * matches the actual deployment. Falls back to the validator's built-in default
 * type set when no --url/API is available.
 *
 * The point: validate/patch the KRT spreadsheets on disk BEFORE uploading, so
 * low-quality KRTs never flood the app UI. For each <id>.(xlsx|csv) KRT in --dir
 * (DataSeer "<name>-DS<n>.xlsx" reports are ignored), it validates every row and
 * reports how many rows are:
 *   • clean          — no blocking errors
 *   • auto-fixable   — every blocking error has a confident fix (e.g. a resource
 *                      type case/plural/synonym → the canonical spelling)
 *   • manual         — has a blocking error needing a human (missing name, etc.)
 * plus non-blocking warnings. With --fix it applies the auto-fixes and writes the
 * file back (a "<file>.bak" copy of the original is kept).
 *
 * Auth: RESOURCE TYPES are fetched with the app session — set ASAP_EMAIL /
 * ASAP_PASSWORD (env only) and --url. Without them the built-in default types
 * are used (a warning is printed).
 *
 * Usage:
 *   node scripts/check-krt.js --dir DIR [options]
 * Options:
 *   --dir DIR    directory of <id>.(xlsx|csv) KRT files (required)
 *   --url URL    app base URL to fetch resource types from (e.g. http://localhost:3030)
 *   --only a,b   only these file basenames (without extension)
 *   --fix        apply auto-fixes and write the files back (keeps a .bak)
 *   --json       emit the machine-readable report as JSON (no pretty output)
 *   --help
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const Papa = require('papaparse');
const axios = require('axios');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { validateRowValues, DEFAULT_RESOURCE_TYPES } = require('../src/backend/services/krt/validator.service');
const { VALIDATION_SEVERITY } = require('../src/backend/config/constants');

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log(fs.readFileSync(__filename, 'utf-8').match(/\/\*\*([\s\S]*?)\*\//)?.[1] || '');
  process.exit(0);
}
const getArg = (name, def) => { const i = argv.indexOf(name); return (i !== -1 && i + 1 < argv.length) ? argv[i + 1] : def; };
const has = (name) => argv.includes(name);

const DIR = getArg('--dir', '');
const BASE_URL = (getArg('--url', process.env.ASAP_BASE_URL || '')).replace(/\/+$/, '');
const ONLY = (getArg('--only', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const FIX = has('--fix');
const JSON_OUT = has('--json');
const EMAIL = process.env.ASAP_EMAIL;
const PASSWORD = process.env.ASAP_PASSWORD;

const DS_REPORT_RE = /-DS\d+\.xlsx$/i;
const KRT_HEADERS = ['RESOURCE TYPE', 'RESOURCE NAME', 'SOURCE', 'IDENTIFIER', 'NEW/REUSE', 'ADDITIONAL INFORMATION'];
// Error column → the KRT field the fix is applied to.
const COLUMN_TO_FIELD = {
  'RESOURCE TYPE': 'resourceType', 'RESOURCE NAME': 'resourceName', 'SOURCE': 'source',
  'IDENTIFIER': 'identifier', 'NEW/REUSE': 'newReuse', 'ADDITIONAL INFORMATION': 'additionalInformation'
};

// ── Fetch canonical resource types from the app (API), else fall back ────────
async function fetchResourceTypes() {
  if (!BASE_URL) {
    console.warn('  ! no --url given — using the built-in default resource types (may differ from your deployment)');
    return DEFAULT_RESOURCE_TYPES;
  }
  const jar = new Map();
  const store = (res) => (res.headers?.['set-cookie'] || []).forEach(l => { const p = l.split(';')[0]; const i = p.indexOf('='); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); });
  const cookie = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const http = axios.create({ baseURL: BASE_URL, validateStatus: () => true });

  if (EMAIL && PASSWORD) {
    const login = await http.post('/api/auth/login', { email: EMAIL, password: PASSWORD }, { headers: { 'Content-Type': 'application/json' } });
    store(login);
    if (login.status !== 200) throw new Error(`Login failed (HTTP ${login.status}) — cannot fetch resource types`);
  }
  const res = await http.get('/api/config/resource-types', { headers: { Cookie: cookie() } });
  if (res.status !== 200) throw new Error(`GET /api/config/resource-types failed (HTTP ${res.status})`);
  const types = res.data?.resourceTypes || res.data?.names || [];
  if (!Array.isArray(types) || !types.length) throw new Error('API returned no resource types');
  return types;
}

// ── KRT parsing (csv + xlsx), returning rows + a format-specific writer ──────
const normHeader = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toUpperCase();
const cellStr = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.text || v.result || v.hyperlink || (Array.isArray(v.richText) ? v.richText.map(t => t.text).join('') : '') || '');
  return String(v);
};
const mapRow = (get) => ({
  resourceType: get('RESOURCE TYPE'), resourceName: get('RESOURCE NAME'), source: get('SOURCE'),
  identifier: get('IDENTIFIER'), newReuse: get('NEW/REUSE'), additionalInformation: get('ADDITIONAL INFORMATION')
});

async function parseKrt(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.csv') return parseCsv(file);
  return parseXlsx(file);
}

function parseCsv(file) {
  const parsed = Papa.parse(fs.readFileSync(file, 'utf-8'), { skipEmptyLines: false });
  const grid = parsed.data.map(r => r.map(cellStr));
  const headerIdx = grid.findIndex(r => r.map(normHeader).filter(h => KRT_HEADERS.includes(h)).length >= 3);
  if (headerIdx === -1) return { rows: [], writer: null };
  const header = grid[headerIdx].map(normHeader);
  const col = (name) => header.indexOf(name);
  const rows = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const r = grid[i];
    const get = (name) => { const c = col(name); return c >= 0 && c < r.length ? String(r[c] || '').trim() : ''; };
    const values = mapRow(get);
    if (!values.resourceName && !values.resourceType && !values.identifier) continue; // blank row
    rows.push({ index: rows.length, gridRow: i, values });
  }
  const writer = (fixes) => {
    for (const f of fixes) {
      const c = col(f.column);
      if (c < 0) continue;
      const gr = rows[f.rowIndex].gridRow;
      while (grid[gr].length <= c) grid[gr].push('');
      grid[gr][c] = f.to;
    }
    fs.copyFileSync(file, file + '.bak');
    fs.writeFileSync(file, Papa.unparse(grid));
  };
  return { rows, writer };
}

async function parseXlsx(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  let ws = null, headerRowNum = -1, colByName = {};
  for (const sheet of wb.worksheets) {
    let found = -1;
    sheet.eachRow({ includeEmpty: false }, (row, rn) => {
      if (found !== -1) return;
      const vals = (row.values || []).slice(1).map(cellStr).map(normHeader);
      if (vals.filter(h => KRT_HEADERS.includes(h)).length >= 3) { found = rn; }
    });
    if (found !== -1) {
      ws = sheet; headerRowNum = found;
      (ws.getRow(found).values || []).slice(1).forEach((v, i) => { const h = normHeader(cellStr(v)); if (KRT_HEADERS.includes(h)) colByName[h] = i + 1; });
      break;
    }
  }
  if (!ws) return { rows: [], writer: null };
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn <= headerRowNum) return;
    const get = (name) => { const c = colByName[name]; return c ? cellStr(row.getCell(c).value).trim() : ''; };
    const values = mapRow(get);
    if (!values.resourceName && !values.resourceType && !values.identifier) return; // blank row
    rows.push({ index: rows.length, sheetRow: rn, values });
  });
  const writer = async (fixes) => {
    for (const f of fixes) {
      const c = colByName[f.column];
      if (!c) continue;
      ws.getRow(rows[f.rowIndex].sheetRow).getCell(c).value = f.to;
    }
    fs.copyFileSync(file, file + '.bak');
    await wb.xlsx.writeFile(file);
  };
  return { rows, writer };
}

// ── Classify a row's validation errors ──────────────────────────────────────
const isError = (e) => e.severity === VALIDATION_SEVERITY.ERROR;
const isAutoFixable = (e) => e.autoFixable === true && e.suggestedValue != null;

function classifyRow(values, resourceTypes) {
  const errs = validateRowValues(values, resourceTypes);
  const blocking = errs.filter(isError);
  const warnings = errs.filter(e => !isError(e));
  const fixes = blocking.filter(isAutoFixable).map(e => ({
    column: e.columnName, field: COLUMN_TO_FIELD[e.columnName],
    from: values[COLUMN_TO_FIELD[e.columnName]] || '', to: e.suggestedValue
  }));
  const manual = blocking.filter(e => !isAutoFixable(e));
  const status = blocking.length === 0 ? 'clean' : (manual.length === 0 ? 'auto-fixable' : 'manual');
  return { status, blocking, warnings, fixes, manual };
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  if (!DIR) { console.error('Missing --dir'); process.exit(1); }
  const root = path.resolve(DIR);
  if (!fs.existsSync(root)) { console.error(`Directory not found: ${root}`); process.exit(1); }

  let resourceTypes;
  try { resourceTypes = await fetchResourceTypes(); }
  catch (e) { console.error(`  ! ${e.message} — falling back to built-in default types`); resourceTypes = DEFAULT_RESOURCE_TYPES; }
  if (!JSON_OUT) console.log(`Using ${resourceTypes.length} resource types${BASE_URL ? ` from ${BASE_URL}` : ' (built-in default)'}\n`);

  const files = fs.readdirSync(root).filter(f => !DS_REPORT_RE.test(f) && /\.(xlsx|csv)$/i.test(f));
  const targets = files.filter(f => !ONLY.length || ONLY.includes(f.replace(/\.(xlsx|csv)$/i, '')));

  const report = { files: [], totals: { files: 0, rows: 0, clean: 0, autoFixable: 0, manual: 0, warnings: 0, fixesApplied: 0 } };

  for (const name of targets.sort()) {
    const file = path.join(root, name);
    const { rows, writer } = await parseKrt(file);
    if (!rows.length) { report.files.push({ file: name, error: 'no KRT rows / header not found' }); continue; }

    const perColumn = {};
    const fileFixes = [];
    let clean = 0, autoFixable = 0, manual = 0, warnings = 0;
    const manualIssues = [];

    for (const row of rows) {
      const c = classifyRow(row.values, resourceTypes);
      if (c.status === 'clean') clean++;
      else if (c.status === 'auto-fixable') autoFixable++;
      else manual++;
      warnings += c.warnings.length;
      for (const e of [...c.blocking, ...c.warnings]) perColumn[e.columnName] = (perColumn[e.columnName] || 0) + 1;
      c.fixes.forEach(f => fileFixes.push({ ...f, rowIndex: row.index, rowNum: (row.sheetRow || row.gridRow + 1) }));
      c.manual.forEach(m => manualIssues.push({ rowNum: (row.sheetRow || row.gridRow + 1), column: m.columnName, message: m.errorMessage, suggestion: m.suggestion || '' }));
    }

    let fixesApplied = 0;
    if (FIX && fileFixes.length && writer) { await writer(fileFixes); fixesApplied = fileFixes.length; }

    const fileRec = {
      file: name, rows: rows.length, clean, autoFixable, manual, warnings,
      perColumn, autoFixes: fileFixes, manualIssues, fixesApplied
    };
    report.files.push(fileRec);
    const t = report.totals;
    t.files++; t.rows += rows.length; t.clean += clean; t.autoFixable += autoFixable; t.manual += manual; t.warnings += warnings; t.fixesApplied += fixesApplied;

    if (!JSON_OUT) printFile(fileRec);
  }

  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); return; }
  printTotals(report.totals);
  // Non-zero exit if any row still needs manual attention (useful for CI/gating).
  if (report.totals.manual > 0) process.exitCode = 1;
})().catch(e => { console.error(e); process.exit(1); });

// ── Pretty output ────────────────────────────────────────────────────────────
function printFile(f) {
  if (f.error) { console.log(`✗ ${f.file}: ${f.error}`); return; }
  const flag = f.manual > 0 ? '⚠' : (f.autoFixable > 0 ? '~' : '✓');
  console.log(`${flag} ${f.file} — ${f.rows} rows: ${f.clean} clean, ${f.autoFixable} auto-fixable, ${f.manual} manual` +
    (f.warnings ? `, ${f.warnings} warning(s)` : '') + (f.fixesApplied ? ` — ${f.fixesApplied} fix(es) applied` : ''));
  if (f.autoFixes.length && !f.fixesApplied) {
    f.autoFixes.slice(0, 20).forEach(x => console.log(`    fix  row ${x.rowNum} ${x.column}: "${x.from}" → "${x.to}"`));
    if (f.autoFixes.length > 20) console.log(`    … +${f.autoFixes.length - 20} more auto-fixes`);
  }
  if (f.manualIssues.length) {
    f.manualIssues.slice(0, 20).forEach(x => console.log(`    ⚠   row ${x.rowNum} ${x.column}: ${x.message}${x.suggestion ? ` — ${x.suggestion}` : ''}`));
    if (f.manualIssues.length > 20) console.log(`    … +${f.manualIssues.length - 20} more manual issues`);
  }
}

function printTotals(t) {
  const pct = (n) => t.rows ? ` (${Math.round(100 * n / t.rows)}%)` : '';
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`TOTAL — ${t.files} file(s), ${t.rows} rows:`);
  console.log(`  clean:        ${t.clean}${pct(t.clean)}`);
  console.log(`  auto-fixable: ${t.autoFixable}${pct(t.autoFixable)}${FIX ? ` — ${t.fixesApplied} fix(es) applied` : '  (run with --fix to apply)'}`);
  console.log(`  manual:       ${t.manual}${pct(t.manual)}  ← need a human before upload`);
  if (t.warnings) console.log(`  warnings:     ${t.warnings} (non-blocking)`);
}
