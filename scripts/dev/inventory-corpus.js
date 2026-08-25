#!/usr/bin/env node
/**
 * Inventory every PDF + author-KRT pair we could evaluate against.
 *
 * The strategy comparison needs manuscripts whose author table we TRUST. Three
 * places hold candidates and none of them is clean on its own:
 *
 *   demo-files/            curated, but most PDFs there have only a `-DS1`
 *                          audit report beside them, which is NOT an author
 *                          KRT. Only a same-base-name .csv/.xlsx counts.
 *   instance-save-prod/    real ASAP submissions — the most trustworthy tables,
 *                          and the smallest set.
 *   instance-save-dev/     everything anyone ever tested with, including the
 *                          demo files re-uploaded many times over.
 *
 * So the point of this script is not to list files; it is to find the DISTINCT
 * manuscripts, tell real submissions from re-uploaded demos, and report each
 * table's shape so a corpus can be chosen on evidence rather than on filenames.
 *
 * Reads only. Parses every KRT through the app's own parser, so the row counts
 * are what the pipeline would actually ingest rather than a spreadsheet's idea
 * of how many rows it has.
 *
 * The manuscripts are unpublished. Output goes to a path under tmp/ and must
 * stay there — tmp/ is gitignored, and nothing here belongs in the repo.
 *
 *   node scripts/dev/inventory-corpus.js [--json tmp/corpus/inventory.json]
 *   node scripts/dev/inventory-corpus.js --select 12 --json tmp/corpus/corpus.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// PapaParse writes "Duplicate headers found and renamed." straight to the
// console for sheets with repeated column names. That is a fact about the
// author's spreadsheet, not something this inventory can act on, and it buries
// the report under dozens of lines.
const _warn = console.warn;
console.warn = (...args) => {
  if (String(args[0] || '').includes('Duplicate headers')) return;
  _warn(...args);
};

const ROOT = path.join(__dirname, '../..');
const parserService = require(path.join(ROOT, 'src/backend/services/krt/parser.service'));
const { normalizeResourceType } = require(path.join(ROOT, 'src/backend/services/krt/validator.service'));

/**
 * Canonical resource type -> detector family, exported from the resource_types
 * table (`node scripts/dev/inventory-corpus.js` reads it; regenerate with the
 * snippet in docs when the table changes).
 *
 * It matters because the thing being compared is three DETECTORS — datasets,
 * protocols and lab materials — so a corpus that is 90% software rows would
 * exercise almost none of what the experiment is about. Author type strings are
 * free text ("Chemicals", "other", "Mouse Strain"), so each is normalised the
 * way the app does before it is looked up.
 */
const FAMILY_MAP_PATH = path.join(ROOT, 'tmp/corpus/resource-type-families.json');

// Regenerate from the running app when the resource_types table changes:
//
//   mkdir -p tmp/corpus && docker compose exec -T app node -e "
//     const { sequelize } = require('/app/src/backend/models');
//     (async () => {
//       const [rows] = await sequelize.query(
//         'select name, type from resource_types where active = true');
//       console.log('JSON:' + JSON.stringify(
//         Object.fromEntries(rows.map(r => [r.name, r.type]))));
//       await sequelize.close();
//     })();" | grep '^JSON:' | cut -c6- > tmp/corpus/resource-type-families.json
//
// Without it every row classifies as 'other', no manuscript looks like it
// exercises the three detectors, and --select quietly returns nothing. So it
// fails here rather than producing an empty corpus and no reason for it.
if (!fs.existsSync(FAMILY_MAP_PATH)) {
  console.error('Missing ' + path.relative(ROOT, FAMILY_MAP_PATH));
  console.error('Regenerate it with the command in the comment above this check.');
  process.exit(1);
}
const FAMILY_MAP = JSON.parse(fs.readFileSync(FAMILY_MAP_PATH, 'utf-8'));

function familyOf(rawType) {
  const canonical = normalizeResourceType(rawType) || rawType;
  return FAMILY_MAP[canonical] || FAMILY_MAP[rawType] || 'other';
}

const SOURCES = [
  { name: 'demo', dir: path.join(ROOT, 'src/frontend/public/demo-files'), kind: 'flat' },
  { name: 'prod', dir: path.join(ROOT, 'tmp/instance-save-prod'), kind: 'archive' },
  { name: 'dev', dir: path.join(ROOT, 'tmp/instance-save-dev'), kind: 'archive' }
];

const KRT_EXT = /\.(xlsx|csv|xls|ods)$/i;

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mib = (bytes) => (bytes / 1024 / 1024);

/**
 * Pair `<id>.pdf` with `<id>.{xlsx,csv,...}` in a flat directory.
 *
 * `-DS1` is excluded deliberately: it is the audit report the pipeline
 * produces, not the author's table. Treating one as a KRT would score the
 * pipeline against its own output.
 */
function fromFlatDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const all = fs.readdirSync(dir);
  return all
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .sort()
    .map((pdf) => {
      const id = pdf.replace(/\.pdf$/i, '');
      const krt = all.find((f) => KRT_EXT.test(f) && f.replace(KRT_EXT, '') === id);
      return { manuscriptId: id, pdf: path.join(dir, pdf), krt: krt ? path.join(dir, krt) : null };
    });
}

/**
 * The highest-numbered round holding a PDF and the KRT that belongs to IT.
 *
 * A round can hold more than one manuscript: replacing the PDF mid-round leaves
 * both files behind, and only one of them has a KRT. Taking the first PDF found
 * and the first KRT found paired `HU1_000350_034`'s manuscript with
 * `JJ1_000520_004`'s table — two unrelated papers — and it scored 8% on the
 * presence check, which is how it was noticed. So the pairing is by NAME, and
 * an ambiguous round is reported rather than guessed at.
 *
 * @returns {{round, pdf, krt}|{ambiguous: true, round, pdfs, krts}|null}
 */
function latestUsableRound(submissionDir) {
  const rounds = fs.readdirSync(submissionDir)
    .filter((d) => /^round-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));

  for (const round of rounds) {
    const base = path.join(submissionDir, round);
    const pdfDir = path.join(base, 'pdf');
    const krtDir = path.join(base, 'krt');
    if (!fs.existsSync(pdfDir) || !fs.existsSync(krtDir)) continue;

    const pdfs = fs.readdirSync(pdfDir).filter((f) => f.toLowerCase().endsWith('.pdf'));
    const krts = fs.readdirSync(krtDir).filter((f) => KRT_EXT.test(f));
    if (!pdfs.length || !krts.length) continue;

    const roundNumber = Number(round.split('-')[1]);
    const stem = (f) => f.replace(/\.[^.]+$/, '').toLowerCase();

    // A KRT named after one of the PDFs settles it, however many are present.
    for (const krt of krts) {
      const match = pdfs.find((pdf) => stem(pdf) === stem(krt));
      if (match) {
        return { round: roundNumber, pdf: path.join(pdfDir, match), krt: path.join(krtDir, krt) };
      }
    }

    // No name match. One of each is still unambiguous — the archives predate
    // this convention and plenty of rounds simply hold one manuscript.
    if (pdfs.length === 1 && krts.length === 1) {
      return { round: roundNumber, pdf: path.join(pdfDir, pdfs[0]), krt: path.join(krtDir, krts[0]) };
    }

    return { ambiguous: true, round: roundNumber, pdfs, krts };
  }
  return null;
}

function fromArchiveDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const submissionId of fs.readdirSync(dir).sort()) {
    const submissionDir = path.join(dir, submissionId);
    if (!fs.statSync(submissionDir).isDirectory()) continue;
    const found = latestUsableRound(submissionDir);
    if (!found) continue;
    if (found.ambiguous) {
      out.push({
        submissionId, round: found.round, ambiguous: true,
        manuscriptId: `${found.pdfs.length} PDFs, ${found.krts.length} KRTs, no name match`,
        pdf: null, krt: null
      });
      continue;
    }
    out.push({
      submissionId,
      round: found.round,
      // The archives name their files after the manuscript, which is how a real
      // submission and a re-uploaded demo turn out to be the same document.
      manuscriptId: path.basename(found.pdf).replace(/\.pdf$/i, ''),
      pdf: found.pdf,
      krt: found.krt
    });
  }
  return out;
}

/**
 * Parse a KRT the way the pipeline does, and describe what is in it.
 *
 * `parseFile` returns an array of OBJECTS keyed by column name, with the header
 * row already consumed — so `rows.length` is the count of author rows, and the
 * columns are read by name rather than by position.
 */
async function describeKrt(file) {
  try {
    const buffer = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    const mime = ext === '.csv'
      ? 'text/csv'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    const rows = await parserService.parseFile(buffer, mime, path.basename(file));
    const columnCheck = parserService.validateColumns(rows);
    if (!columnCheck.valid) {
      return { ok: false, reason: `missing columns: ${columnCheck.missingColumns.join(', ')}` };
    }

    const value = (row, name) => String(row?.[name] ?? '').trim();
    // Exported sheets carry trailing blanks; a row with nothing in it is not a
    // row the pipeline would ever be scored against.
    const body = rows.filter((r) => Object.values(r || {}).some((c) => String(c ?? '').trim()));
    if (body.length === 0) return { ok: false, reason: 'no data rows' };

    const types = {};
    const families = { dataset: 0, protocol: 0, lab_material: 0, software: 0, other: 0 };
    let withIdentifier = 0;
    let withName = 0;
    for (const row of body) {
      const type = value(row, 'RESOURCE TYPE') || '(blank)';
      types[type] = (types[type] || 0) + 1;
      families[familyOf(type)] += 1;
      if (value(row, 'IDENTIFIER')) withIdentifier += 1;
      if (value(row, 'RESOURCE NAME')) withName += 1;
    }

    return { ok: true, rows: body.length, withIdentifier, withName, types, families };
  } catch (err) {
    return { ok: false, reason: err.message.slice(0, 120) };
  }
}

/**
 * Manuscripts we will not evaluate against, and why.
 *
 * Keeping them in the inventory and excluding them HERE is deliberate: a corpus
 * that silently omits documents is one nobody can audit.
 */
const EXCLUDED = {
  'XC1-000312-009-org-D-4':
    'Modal/Docling returns `socket hang up` on this PDF reproducibly, across three '
    + 'separate sessions, while every other manuscript converts through the same '
    + 'endpoint. It would fail both arms and measure nothing.'
};

/**
 * Choose a corpus that can actually answer the question.
 *
 * Balance beats size here. The comparison is between two ways of prompting
 * three detectors, so every manuscript must exercise all three; and because the
 * seeded arm is influenced by how an author writes their table, drawing several
 * manuscripts from one lab would measure that lab's house style as much as the
 * strategy. So: one per lab first, widest size spread, most trustworthy source
 * as the tie-break.
 */
function selectCorpus(usable, size, presenceByShaOrNull, minPresence) {
  const eligible = usable.filter((d) => {
    if (EXCLUDED[d.manuscriptId]) return false;
    const f = d.krtInfo.families;
    if (!(f.dataset > 0 && f.protocol > 0 && f.lab_material > 0)) return false;

    // A pair whose author rows cannot be found in its own manuscript is not a
    // broken pair — some authors label rows descriptively ("Phenotypic data
    // TPD") where the paper names the cohort — but it is a poor one to measure
    // with: neither strategy can match those rows, so the run costs the same
    // and tells us much less. Unscored pairs are excluded too; "we never
    // checked" is not evidence of being fine.
    if (presenceByShaOrNull) {
      const pct = presenceByShaOrNull.get(d.pdfSha);
      if (pct === undefined || pct < minPresence) return false;
      d.presencePct = pct;
    }
    return true;
  });

  const rank = { prod: 0, demo: 1, dev: 2 };
  const byLab = new Map();
  for (const d of eligible) {
    const lab = d.manuscriptId.slice(0, 3).toUpperCase();
    if (!byLab.has(lab)) byLab.set(lab, []);
    byLab.get(lab).push(d);
  }
  // Within a lab, the most trustworthy copy of the biggest table.
  for (const list of byLab.values()) {
    list.sort((a, b) => (rank[a.source] - rank[b.source]) || (b.krtInfo.rows - a.krtInfo.rows));
  }

  // One per lab, then spread the picks across the size range rather than taking
  // the biggest — a corpus of only large tables says nothing about small ones,
  // and the ablation is most informative where there is least to remove.
  const oneEach = [...byLab.values()].map((l) => l[0]).sort((a, b) => b.krtInfo.rows - a.krtInfo.rows);
  if (size >= oneEach.length) return oneEach;

  const picked = [];
  const step = (oneEach.length - 1) / (size - 1);
  for (let i = 0; i < size; i += 1) picked.push(oneEach[Math.round(i * step)]);
  return [...new Set(picked)];
}

async function main() {
  const jsonAt = process.argv.includes('--json')
    ? process.argv[process.argv.indexOf('--json') + 1]
    : null;

  const candidates = [];
  for (const source of SOURCES) {
    const found = source.kind === 'flat' ? fromFlatDir(source.dir) : fromArchiveDir(source.dir);
    for (const entry of found) candidates.push({ source: source.name, ...entry });
  }

  // Describe each one, then group by the PDF's content. The same manuscript
  // reaches us as a demo file, a dev upload of that demo file, and sometimes a
  // real prod submission — one document, three rows, and counting it three
  // times would silently triple-weight it in the corpus.
  const ambiguous = candidates.filter((c) => c.ambiguous);
  const described = [];
  for (const c of candidates.filter((c) => !c.ambiguous)) {
    const pdfBytes = fs.statSync(c.pdf).size;
    described.push({
      ...c,
      pdfSha: sha256(c.pdf),
      pdfMiB: Number(mib(pdfBytes).toFixed(2)),
      krtInfo: c.krt ? await describeKrt(c.krt) : { ok: false, reason: 'no author KRT' }
    });
  }

  const byPdf = new Map();
  for (const d of described) {
    if (!byPdf.has(d.pdfSha)) byPdf.set(d.pdfSha, []);
    byPdf.get(d.pdfSha).push(d);
  }

  // Prefer the copy with a usable KRT; among those, prefer prod, then demo.
  const rank = { prod: 0, demo: 1, dev: 2 };
  const distinct = [...byPdf.values()].map((group) => {
    const sorted = [...group].sort((a, b) =>
      (b.krtInfo.ok - a.krtInfo.ok) || (rank[a.source] - rank[b.source]));
    return { ...sorted[0], seenIn: [...new Set(group.map((g) => g.source))].sort(), copies: group.length };
  });

  const usable = distinct.filter((d) => d.krtInfo.ok).sort((a, b) => b.krtInfo.rows - a.krtInfo.rows);
  const unusable = distinct.filter((d) => !d.krtInfo.ok);

  console.log(`\ncandidates found       ${described.length}`);
  console.log(`distinct manuscripts   ${distinct.length}   (by PDF content)`);
  console.log(`  with a usable KRT    ${usable.length}`);
  console.log(`  without              ${unusable.length}`);

  console.log('\n── usable pairs, largest table first ──────────────────────────────────');
  console.log('rows  ident   data  prot   mat   sw  source  manuscript');
  for (const d of usable) {
    const f = d.krtInfo.families;
    console.log(
      String(d.krtInfo.rows).padStart(4),
      String(d.krtInfo.withIdentifier).padStart(6),
      String(f.dataset).padStart(6),
      String(f.protocol).padStart(5),
      String(f.lab_material).padStart(5),
      String(f.software).padStart(4),
      ' ' + d.source.padEnd(6),
      d.manuscriptId.slice(0, 40)
    );
  }

  const totals = usable.reduce((acc, d) => {
    for (const [k, v] of Object.entries(d.krtInfo.families)) acc[k] = (acc[k] || 0) + v;
    return acc;
  }, {});
  console.log('\nauthor rows by detector family:',
    Object.entries(totals).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log('manuscripts exercising all three compared detectors:',
    usable.filter((d) => d.krtInfo.families.dataset > 0
      && d.krtInfo.families.protocol > 0
      && d.krtInfo.families.lab_material > 0).length);

  const reasons = {};
  for (const d of unusable) {
    const r = d.krtInfo.reason || 'unknown';
    reasons[r] = (reasons[r] || 0) + 1;
  }
  if (ambiguous.length) {
    console.log(`\n── ${ambiguous.length} rounds hold several manuscripts and no KRT names one ─────`);
    for (const a of ambiguous) console.log('  ', a.submissionId, 'round', a.round, '—', a.manuscriptId);
  }

  console.log('\n── why the rest are unusable ─────────────────────────────────────────');
  for (const [reason, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(String(n).padStart(4), reason);
  }

  const totalRows = usable.reduce((n, d) => n + d.krtInfo.rows, 0);
  const totalIdent = usable.reduce((n, d) => n + d.krtInfo.withIdentifier, 0);
  console.log(`\nusable corpus: ${usable.length} manuscripts, ${totalRows} author rows, ${totalIdent} carrying an identifier`);

  // Presence scores, when they have been computed. Keyed by PDF hash so the
  // corpus and the check agree on what "the same manuscript" means.
  const presencePath = path.join(ROOT, 'tmp/corpus/presence.json');
  let presenceBySha = null;
  if (fs.existsSync(presencePath)) {
    presenceBySha = new Map(
      JSON.parse(fs.readFileSync(presencePath, 'utf-8')).scored.map((s) => [s.pdfSha, s.presence.pct])
    );
  }
  const minPresenceAt = process.argv.indexOf('--min-presence');
  const MIN_PRESENCE = minPresenceAt !== -1 ? Number(process.argv[minPresenceAt + 1]) : 60;

  const selectAt = process.argv.indexOf('--select');
  let corpus = null;
  if (selectAt !== -1) {
    if (!presenceBySha) {
      console.log('\nNo tmp/corpus/presence.json — selecting without the presence filter.');
      console.log('Run scripts/dev/check-corpus-presence.js first to screen out pairs whose');
      console.log('author rows cannot be found in their own manuscript.');
    }
    corpus = selectCorpus(usable, Number(process.argv[selectAt + 1]) || 12, presenceBySha, MIN_PRESENCE);
    console.log('\n── proposed corpus ───────────────────────────────────────────────────');
    console.log('rows  ident  pres   data  prot   mat   sw  source  manuscript');
    for (const d of corpus) {
      const f = d.krtInfo.families;
      console.log(
        String(d.krtInfo.rows).padStart(4), String(d.krtInfo.withIdentifier).padStart(6),
        String(d.presencePct === undefined ? '?' : d.presencePct + '%').padStart(5),
        String(f.dataset).padStart(6), String(f.protocol).padStart(5),
        String(f.lab_material).padStart(5), String(f.software).padStart(4),
        ' ' + d.source.padEnd(6), d.manuscriptId.slice(0, 40)
      );
    }
    const rows = corpus.reduce((n, d) => n + d.krtInfo.rows, 0);
    const labs = new Set(corpus.map((d) => d.manuscriptId.slice(0, 3).toUpperCase()));
    console.log(`\n${corpus.length} manuscripts, ${labs.size} labs, ${rows} author rows`);
    console.log('every one exercises datasets, protocols AND lab materials');
    for (const [id, why] of Object.entries(EXCLUDED)) console.log(`\nexcluded ${id}:\n  ${why}`);
  }

  if (jsonAt) {
    // Paths are written REPO-RELATIVE. The archives live under tmp/, which is
    // mounted into the `app-tools` container at a different absolute path, and
    // an inventory only readable on the host cannot drive a conversion that has
    // to run where the credentials are.
    const relative = (entry) => (!entry ? entry : {
      ...entry,
      pdf: entry.pdf ? path.relative(ROOT, entry.pdf) : entry.pdf,
      krt: entry.krt ? path.relative(ROOT, entry.krt) : entry.krt
    });
    corpus = corpus && corpus.map(relative);
    const usableOut = usable.map(relative);
    const unusableOut = unusable.map(relative);

    fs.mkdirSync(path.dirname(jsonAt), { recursive: true });
    fs.writeFileSync(jsonAt, JSON.stringify(
      corpus ? { corpus, usable: usableOut, unusable: unusableOut } : { usable: usableOut, unusable: unusableOut },
      null, 2));
    console.log(`\nwritten to ${jsonAt}`);
    console.log('These manuscripts are unpublished — keep this under tmp/, never commit it.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
