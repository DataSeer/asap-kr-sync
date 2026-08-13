#!/usr/bin/env node
/**
 * One-off migration: rewrite non-canonical RESOURCE TYPE values in the demo KRT
 * files to the ASAP canonical vocabulary (services/krt/validator.service.js).
 *
 * WHY PATCH THE DATA RATHER THAN TEACH THE MATCHER SYNONYMS
 * ---------------------------------------------------------
 * `matchAuthorRows` rejects a candidate on resource-type mismatch BEFORE it ever
 * compares identifiers or names:
 *
 *     if (rowTypeKey && entry.typeKey && rowTypeKey !== entry.typeKey) continue;
 *
 * and `normalizeResourceTypeKey` canonicalises only the software family. So an
 * author row typed "Antibodies" could never match an "Antibody" candidate — not
 * even on an identical RRID. 20% of demo rows carried such a label.
 *
 * The app already refuses non-canonical types at curation time
 * (`validateResourceType`), so real submissions cannot carry them; only this
 * demo corpus, which predates that rule, does. Fixing the data keeps a single
 * vocabulary in the system instead of teaching the matcher to guess.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It never infers a type from the resource NAME. A label that maps to more than
 * one canonical type is left exactly as it is and reported, so measurement can
 * exclude those rows rather than silently score a guess.
 *
 * Parsing uses the SAME libraries as services/krt/parser.service.js (papaparse,
 * exceljs) so this sees the files exactly as the app does — a line-based CSV
 * pass gets multi-line quoted fields wrong and silently mangles them.
 *
 * Usage:
 *   node scripts/patch-krt-resource-types.js            # dry run, writes nothing
 *   node scripts/patch-krt-resource-types.js --apply    # writes, after backing up
 *
 * The corpus is NOT git-tracked (.gitignore), so tmp/krt-type-patch-backup/ is
 * the only way to undo an --apply.
 */

const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'src/frontend/public/demo-files');
// Backups live OUTSIDE the corpus: that directory is the single source of demo
// files, and dropping .bak siblings into it makes stray files look like corpus
// members. It is also not git-tracked, so these copies are the only way back.
const BACKUP_DIR = path.join(ROOT, 'tmp/krt-type-patch-backup');
const APPLY = process.argv.includes('--apply');

/** @param {string} file @returns {string} backup path, parent dir created */
function backupPath(file) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return path.join(BACKUP_DIR, path.basename(file) + '.bak');
}

/**
 * Label → canonical type, for labels that map to exactly one ASAP type.
 * This maps a LABEL to a LABEL. It makes no claim about whether a given row's
 * content suits the category — the author's classification stands.
 */
const MAPPING = {
  'chemical': 'Chemical, peptide, or recombinant protein',
  'chemicals': 'Chemical, peptide, or recombinant protein',
  'chemicals, peptides, and recombinant proteins': 'Chemical, peptide, or recombinant protein',
  'virus strain': 'Viral vector',
  'virus strains': 'Viral vector',
  'viral vectors': 'Viral vector',
  'antibodies': 'Antibody',
  'plasmids': 'Recombinant DNA',
  'critical commercial assays': 'Critical commercial assay',
  'datasets': 'Dataset',
  'deposited data': 'Dataset',
  'software': 'Software/code',
  'code/software': 'Software/code',
  'code': 'Software/code',
  'software and algorithms': 'Software/code',
  'oligonucleotides': 'Oligonucleotide',
  'biological samples': 'Biological sample',
  'protocols': 'Protocol',
  'experimental models: cell lines': 'Experimental model: Cell line',
  'experimental models: organisms/strains': 'Experimental model: Organism/strain',
  // Labels whose own wording names exactly one canonical type. "Chemical Kit"
  // is a commercial kit (all eight rows are 10X Genomics catalogue kits), which
  // ASAP files under Critical commercial assay rather than Chemical.
  'chemical kit': 'Critical commercial assay',
  'chemical kits': 'Critical commercial assay',
  'kit': 'Critical commercial assay',
  'protocol: published protocol': 'Protocol',
  'published protocol': 'Protocol',
  'cell line': 'Experimental model: Cell line',
  'cell lines': 'Experimental model: Cell line',
  'animal line': 'Experimental model: Organism/strain',
  'animal lines': 'Experimental model: Organism/strain'
};

/**
 * Authoritative identifier namespaces. An RRID prefix names a specific registry,
 * and that registry only ever lists one kind of thing — so the identifier
 * settles the type more reliably than the author's free-text label does.
 *
 * This is NOT inference from the resource name. It reads a controlled
 * identifier, the same evidence `matchAuthorRows` already treats as decisive.
 * It is checked BEFORE the label map, because where the two disagree the
 * registry wins: XC1 rows carry the type "Experimental Model: Murine (C57BL/6J)"
 * — the name has leaked into the type cell — while their RRID:IMSR_JAX is
 * unambiguous.
 */
const IDENTIFIER_NAMESPACE_RULES = [
  { test: /\bIMSR_JAX\s*[:_]/i, type: 'Experimental model: Organism/strain', why: 'RRID:IMSR_JAX — International Mouse Strain Resource' },
  { test: /\bMGI\s*[:_]/i,      type: 'Experimental model: Organism/strain', why: 'RRID:MGI — Mouse Genome Informatics' },
  { test: /\bCVCL[_:]/i,         type: 'Experimental model: Cell line',       why: 'RRID:CVCL — Cellosaurus cell-line registry' },
  { test: /\bhPSCreg\s*:/i,     type: 'Experimental model: Cell line',       why: 'hPSCreg — human pluripotent stem cell registry' },
  { test: /\bAddgene\s*[_:#]/i, type: 'Recombinant DNA',                     why: 'RRID:Addgene — plasmid repository' }
];

/**
 * Labels that genuinely span two canonical types. Left untouched on purpose:
 * picking one would be a guess, and a confidently wrong type blocks matching
 * just as effectively as a non-canonical one — only less visibly.
 */
const AMBIGUOUS = {
  'bacterial and virus strains': 'Bacterial strain OR Viral vector',
  'experimental model': 'Experimental model: Cell line OR Experimental model: Organism/strain',
  'experimental models': 'Experimental model: Cell line OR Experimental model: Organism/strain'
};

const CANONICAL = new Set([
  'Antibody', 'Bacterial strain', 'Viral vector', 'Biological sample',
  'Chemical, peptide, or recombinant protein', 'Critical commercial assay',
  'Experimental model: Cell line', 'Experimental model: Organism/strain',
  'Oligonucleotide', 'Recombinant DNA', 'Dataset', 'Software/code',
  'Protocol', 'Other'
].map((s) => s.toLowerCase()));

const stats = { rewritten: new Map(), leftAsIs: new Map(), files: [] };

/**
 * Classify one RESOURCE TYPE cell, using the row's IDENTIFIER as corroboration.
 * @param {*} raw - the type cell
 * @param {string} identifier - the row's IDENTIFIER cell
 * @returns {{action:string, target?:string, why?:string, via?:string}}
 */
function classify(raw, identifier) {
  const key = String(raw ?? '').trim().toLowerCase();
  if (!key) return { action: 'blank' };
  if (CANONICAL.has(key)) return { action: 'ok' };

  // Registry first: it outranks a label the author typed by hand.
  const id = String(identifier ?? '');
  for (const rule of IDENTIFIER_NAMESPACE_RULES) {
    if (rule.test.test(id)) return { action: 'map', target: rule.type, via: rule.why };
  }

  if (AMBIGUOUS[key]) return { action: 'ambiguous', why: AMBIGUOUS[key] };
  const target = MAPPING[key];
  if (target) return { action: 'map', target, via: 'label' };
  return { action: 'ambiguous', why: 'no mapping defined' };
}

function note(map, key, n = 1) { map.set(key, (map.get(key) || 0) + n); }

/** Two demo CSVs are not UTF-8; round-trip them in their own encoding. */
function decodeCsv(buf) {
  const utf8 = buf.toString('utf-8');
  return utf8.includes('�')
    ? { text: buf.toString('latin1'), encoding: 'latin1' }
    : { text: utf8, encoding: 'utf-8' };
}

function patchCsv(file) {
  const original = fs.readFileSync(file);
  const { text, encoding } = decodeCsv(original);
  // Papa handles quoted newlines; a line-based split does not.
  const parsed = Papa.parse(text, { skipEmptyLines: false });
  const rows = parsed.data;
  if (!rows.length) return { changed: 0, ambiguous: 0, encoding };

  const headerIdx = rows.findIndex((r) => r.some((c) => String(c).trim().toUpperCase() === 'RESOURCE TYPE'));
  if (headerIdx < 0) return { changed: 0, ambiguous: 0, encoding, noHeader: true };
  const typeIdx = rows[headerIdx].findIndex((c) => String(c).trim().toUpperCase() === 'RESOURCE TYPE');
  const idIdx = rows[headerIdx].findIndex((c) => String(c).trim().toUpperCase() === 'IDENTIFIER');

  let changed = 0; let ambiguous = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row) || typeIdx >= row.length) continue;
    const verdict = classify(row[typeIdx], idIdx >= 0 ? row[idIdx] : '');
    if (verdict.action === 'map') {
      note(stats.rewritten, `${String(row[typeIdx]).trim()} → ${verdict.target}   [${verdict.via}]`);
      row[typeIdx] = verdict.target;
      changed++;
    } else if (verdict.action === 'ambiguous') {
      note(stats.leftAsIs, `${String(row[typeIdx]).trim()}  (${verdict.why})`);
      ambiguous++;
    }
  }

  if (APPLY && changed > 0) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const out = Papa.unparse(rows, { newline: eol });
    fs.writeFileSync(backupPath(file), original);
    fs.writeFileSync(file, Buffer.from(out, encoding === 'utf-8' ? 'utf-8' : 'latin1'));
  }
  return { changed, ambiguous, encoding };
}

async function patchXlsx(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  let changed = 0; let ambiguous = 0;

  for (const ws of wb.worksheets) {
    let typeCol = -1; let idCol = -1; let headerRow = -1;
    ws.eachRow((row, rowNumber) => {
      if (typeCol !== -1) return;
      row.eachCell((cell, colNumber) => {
        const label = String(cell.value ?? '').trim().toUpperCase();
        if (label === 'RESOURCE TYPE') { typeCol = colNumber; headerRow = rowNumber; }
        if (label === 'IDENTIFIER') idCol = colNumber;
      });
    });
    if (typeCol === -1) continue;

    ws.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRow) return;
      const cell = row.getCell(typeCol);
      const idVal = idCol > 0 ? row.getCell(idCol).value : '';
      const verdict = classify(cell.value, typeof idVal === 'object' && idVal ? (idVal.text || idVal.hyperlink || '') : idVal);
      if (verdict.action === 'map') {
        note(stats.rewritten, `${String(cell.value).trim()} → ${verdict.target}   [${verdict.via}]`);
        cell.value = verdict.target;
        changed++;
      } else if (verdict.action === 'ambiguous') {
        note(stats.leftAsIs, `${String(cell.value).trim()}  (${verdict.why})`);
        ambiguous++;
      }
    });
  }

  if (APPLY && changed > 0) {
    fs.copyFileSync(file, backupPath(file));
    await wb.xlsx.writeFile(file);
  }
  return { changed, ambiguous, encoding: 'xlsx' };
}

(async () => {
  console.log(APPLY ? `=== APPLYING (originals backed up to ${path.relative(ROOT, BACKUP_DIR)}/) ===\n` : '=== DRY RUN — nothing is written ===\n');
  console.log(`corpus: ${path.relative(ROOT, DIR)}\n`);

  const names = fs.readdirSync(DIR)
    .filter((f) => (f.endsWith('.csv') || f.endsWith('.xlsx')) && !f.endsWith('-DS1.xlsx'))
    .sort();

  let totalChanged = 0; let totalAmbiguous = 0;
  for (const name of names) {
    const file = path.join(DIR, name);
    const r = name.endsWith('.csv') ? patchCsv(file) : await patchXlsx(file);
    totalChanged += r.changed; totalAmbiguous += r.ambiguous;
    if (r.changed || r.ambiguous) {
      console.log(`  ${name.padEnd(38)} [${r.encoding}]  rewrite ${String(r.changed).padStart(4)}   leave ${String(r.ambiguous).padStart(4)}`);
    } else if (r.noHeader) {
      console.log(`  ${name.padEnd(38)} [${r.encoding}]  no RESOURCE TYPE column — skipped`);
    }
  }

  console.log(`\n── rewritten: ${totalChanged} ──`);
  for (const [k, v] of [...stats.rewritten].sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(4)}  ${k}`);
  console.log(`\n── left as-is: ${totalAmbiguous} ──`);
  for (const [k, v] of [...stats.leftAsIs].sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(4)}  ${k}`);
  if (!APPLY) console.log(`\nRe-run with --apply to write. Originals are backed up to ${path.relative(ROOT, BACKUP_DIR)}/.`);
})();
