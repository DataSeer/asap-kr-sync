#!/usr/bin/env node
/**
 * Reviewer workbooks for the A/B/C prompt arms.
 *
 * One workbook per document with the three arms side by side, plus a summary.
 * Caveats sheet first, because the headline number in this experiment (arm B
 * confirming far more author rows) is largely misattribution, and a reader who
 * meets it cold will draw the wrong conclusion.
 *
 * Offline: no LM calls, no database.
 *
 * Usage: node scripts/build-ab-arms-xlsx.js
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const IN = path.join(ROOT, 'tmp/ab-arms');
const MD_DIR = path.join(ROOT, 'tmp/batch-check/markdown');
// NOT inside tmp/ab-arms: that directory is created by the container running as
// root, so the host user cannot write into it. A sibling keeps this runnable
// without sudo.
const OUT = path.join(ROOT, 'tmp/ab-arms-reports');

const { buildEvidenceIndex, findAllOccurrences } =
  require(path.join(ROOT, 'src/backend/services/pdf-analysis/evidence.service'));

const ARMS = ['A', 'B', 'C'];
// Labelled by DESIGN rather than by branch name: these workbooks are shared
// outside the repo, where "dev prompts" and "branch prompts" mean nothing.
const LABEL = {
  A: 'A — separated (no seed)',
  B: 'B — fused (full author KRT)',
  C: 'C — fused (verified-only seed)'
};
const TINT = { A: 'FFE3EEFB', B: 'FFF3F0FA', C: 'FFE7F6E7', no: 'FFFBE4E4' };
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
const HEADER_FONT = { color: { argb: 'FFFFFFFF' }, bold: true };

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : '');

function addSheet(wb, title, columns, rows, tintBy) {
  const ws = wb.addWorksheet(title.replace(/[:\\/?*[\]]/g, '-').slice(0, 31),
    { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns;
  ws.getRow(1).font = HEADER_FONT;
  ws.getRow(1).fill = HEADER_FILL;
  ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
  for (const r of rows) {
    const added = ws.addRow(r);
    const t = tintBy && tintBy(r);
    if (t && TINT[t]) added.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TINT[t] } };
    added.alignment = { vertical: 'top', wrapText: true };
  }
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

function supportedFactory(index) {
  return (name, identifier) => {
    if (identifier && String(identifier).trim()) {
      const id = String(identifier).replace(/^\s*(RRID|DOI|Cat|Catalog)[\s:#]*/i, '').trim();
      if (id.length >= 4 && findAllOccurrences(index, id, 1).length > 0) return true;
    }
    return Boolean(name && String(name).trim().length >= 4
      && findAllOccurrences(index, String(name), 1).length > 0);
  };
}

const CAVEATS = [
  ['The question',
    'Is it better to generate the KRT and check the author\'s KRT as ONE fused process (the current design, which seeds the author\'s rows into the detection prompts) or as TWO separate ones?'],
  ['What this compares',
    'Three arms of the SAME pipeline over the same 11 manuscripts. The engine is identical in every arm — same evidence verification, merge, consolidation, matcher, token budgets and parsing. Only the detection prompts and the seeding change, which is what makes the differences attributable.'],
  ['The arms',
    'A = separated design, the model never sees the author KRT. B = fused design seeded with the FULL author KRT (1048 rows). C = fused design seeded only with author rows whose name or identifier actually occurs in the manuscript (573 rows).'],
  ['READ THIS BEFORE THE NUMBERS',
    'Arm B confirms far more author rows than A (793 vs 472). That looks decisive and is largely MISATTRIBUTION — see the anchoring column. Corrected for anchoring the real gap is ~7%, not 68%. Do not quote the confirmation counts without the anchored ones.'],
  ['Anchored confirmations',
    'Of the author rows an arm confirmed, how many have their OWN name or identifier in the manuscript. A and C: 85%. B: 59%. The unanchored ones rest on a quote that verified as real text but is not demonstrably about that resource — typically a neighbouring sentence about a different resource.'],
  ['Why "echo" reads 0 everywhere',
    'Echo counts author-row detections whose quote failed to verify. It is 0 in all three arms — neither design fabricates quotes. But a quote verifies if that SENTENCE exists, not if it is ABOUT that resource. Echo alone would have produced the wrong conclusion; the anchoring test is what exposed it.'],
  ['Discovery — the solid result',
    'Items found that are NOT author rows: what the author missed. Seeding cannot inflate it, so it compares cleanly. Seeding costs 39% of it (1570 -> 963), and arm A beat arm B on ALL 11 of 11 manuscripts — a paired sign test gives p ~ 0.001. This conclusion does not depend on repeat runs.'],
  ['Arm C is NOT yet proven',
    'Arm C looks best on quality (highest precision at 80%, anchoring restored to 85%, 140 discovery recovered over B). But it beat arm B on discovery in only 9 of 11 manuscripts (p = 0.065). Promising lead, not a settled result — confirming it needs repeat runs that have not been done.'],
  ['"Supported" is a floor, not correctness',
    'It asks whether the resource is MENTIONED — necessary, not sufficient. Descriptive names ("Proteomics data", "Human GRCh38 reference genome") score no in every arm even when the resource is discussed, so absolute rates understate all three equally while the comparison between them stays fair.'],
  ['What this does NOT settle',
    'Arm A also uses different prompts, so A-vs-B is prompts AND seeding together. Only B-vs-C isolates seeding alone — and that is the comparison that did not reach significance. Also: nothing here is measured against external ground truth; every figure is self-referential.'],
  ['Run-to-run variance',
    'Re-running arm A on one document gave 117 then 95 detections (~22%); arm B gave 80 then 81 (~1%). So the fused design is genuinely more reproducible. But that is n=2 on ONE document, on raw detection count (the noisiest metric). Arms were interleaved per document to control for drift. Per-document differences under roughly a quarter are not distinguishable from noise.'],
  ['Deviations recorded',
    'The fused prompts were given an evidence_quote field so the engine could verify them at all; without a claimed quote every item is unverifiable and the metric becomes meaningless (a planned change to those prompts regardless). Dataset seeds normally go in a structured payload field — here they are appended as a labelled block: same information, different placement. temperature 0 was applied throughout and does NOT remove the variance above.']
];

(async () => {
  if (!fs.existsSync(IN)) { console.error('No arm results found.'); process.exit(1); }
  const byDoc = new Map();
  for (const f of fs.readdirSync(IN).filter((x) => x.endsWith('.json'))) {
    const a = JSON.parse(fs.readFileSync(path.join(IN, f), 'utf-8'));
    if (!byDoc.has(a.name)) byDoc.set(a.name, {});
    byDoc.get(a.name)[a.arm] = a;
  }
  const docs = [...byDoc.entries()].filter(([, arms]) => ARMS.every((x) => arms[x])).sort();
  fs.mkdirSync(OUT, { recursive: true });

  const summary = [];
  const allRows = [];

  for (const [name, arms] of docs) {
    const md = path.join(MD_DIR, `${name}.md`);
    if (!fs.existsSync(md)) continue;
    const supported = supportedFactory(buildEvidenceIndex(fs.readFileSync(md, 'utf-8')));
    const authorRows = arms.A.authorRows || [];
    const authorNames = new Set(authorRows.map((r) => norm(r.resourceName)));
    const byName = new Map(authorRows.map((r) => [norm(r.resourceName), r]));

    const wb = new ExcelJS.Workbook();
    wb.creator = 'asap-kr-sync A/B/C prompt arms';
    addSheet(wb, 'READ ME — caveats',
      [{ header: 'Topic', key: 't', width: 34 }, { header: 'What you need to know', key: 'd', width: 108 }],
      CAVEATS.map(([t, d]) => ({ t, d })));

    const per = [];
    const detRows = [];
    const genRows = [];
    for (const x of ARMS) {
      const a = arms[x];
      const det = Object.values(a.detections || {}).flat();
      const detOk = det.filter((it) => supported(it.resourceName, it.identifier)).length;
      const adds = (a.generatedKrt || []).filter((g) => !authorNames.has(norm(g.resourceName)));
      const addsOk = adds.filter((g) => supported(g.resourceName, g.identifier)).length;
      const conf = (a.outcomes || []).filter((o) => o.outcome === 'confirmed' || o.outcome === 'incomplete');
      const confRows = conf.map((o) => byName.get(norm(o.resourceName))).filter(Boolean);
      const anchored = confRows.filter((r) => supported(r.resourceName, r.identifier)).length;

      per.push({
        arm: LABEL[x], seed: a.seedRows, detections: det.length, detSupported: detOk,
        detSupportedPct: pct(detOk, det.length), discovery: a.measures.discovery,
        echo: `${a.measures.echo}/${a.measures.echoable}`,
        confirmed: confRows.length, anchored, anchoredPct: pct(anchored, confRows.length),
        generated: (a.generatedKrt || []).length, added: adds.length,
        addedSupported: addsOk, addedSupportedPct: pct(addsOk, adds.length)
      });

      for (const [mod, items] of Object.entries(a.detections || {})) {
        for (const it of items || []) {
          detRows.push({
            arm: x, module: mod, resourceType: it.resourceType || '', resourceName: it.resourceName || '',
            identifier: it.identifier || '', isAuthorRow: authorNames.has(norm(it.resourceName)) ? 'yes' : '',
            inManuscript: supported(it.resourceName, it.identifier) ? 'yes' : 'no',
            evidenceStatus: it.evidence?.verification?.status || '',
            quote: it.evidence?.quote || ''
          });
        }
      }
      for (const g of a.generatedKrt || []) {
        genRows.push({
          arm: x, resourceType: g.resourceType || '', resourceName: g.resourceName || '',
          source: g.sourceUrl || '', identifier: g.identifier || '',
          beyondAuthorKrt: authorNames.has(norm(g.resourceName)) ? '' : 'yes',
          inManuscript: supported(g.resourceName, g.identifier) ? 'yes' : 'no',
          quote: g.evidence?.quote || ''
        });
      }
    }

    addSheet(wb, 'Arms side by side', [
      { header: 'Arm', key: 'arm', width: 36 }, { header: 'Seed rows', key: 'seed', width: 10 },
      { header: 'Detections', key: 'detections', width: 11 }, { header: 'Supported', key: 'detSupported', width: 10 },
      { header: 'Supported %', key: 'detSupportedPct', width: 12 },
      { header: 'Discovery (non-author)', key: 'discovery', width: 20 },
      { header: 'Echo', key: 'echo', width: 10 },
      { header: 'Confirmed rows', key: 'confirmed', width: 14 },
      { header: 'Anchored', key: 'anchored', width: 10 }, { header: 'Anchored %', key: 'anchoredPct', width: 12 },
      { header: 'Generated KRT', key: 'generated', width: 14 }, { header: 'Rows added', key: 'added', width: 11 },
      { header: 'Added supported', key: 'addedSupported', width: 15 }, { header: 'Added %', key: 'addedSupportedPct', width: 10 }
    ], per);

    addSheet(wb, 'Detections (all arms)', [
      { header: 'Arm', key: 'arm', width: 6 }, { header: 'Module', key: 'module', width: 14 },
      { header: 'RESOURCE TYPE', key: 'resourceType', width: 24 }, { header: 'RESOURCE NAME', key: 'resourceName', width: 38 },
      { header: 'IDENTIFIER', key: 'identifier', width: 26 }, { header: 'Is an author row', key: 'isAuthorRow', width: 15 },
      { header: 'In manuscript?', key: 'inManuscript', width: 14 }, { header: 'Evidence status', key: 'evidenceStatus', width: 15 },
      { header: 'Evidence quote', key: 'quote', width: 60 }
    ], detRows, (r) => (r.inManuscript === 'no' ? 'no' : r.arm));

    addSheet(wb, 'Generated KRT (all arms)', [
      { header: 'Arm', key: 'arm', width: 6 }, { header: 'RESOURCE TYPE', key: 'resourceType', width: 24 },
      { header: 'RESOURCE NAME', key: 'resourceName', width: 38 }, { header: 'SOURCE', key: 'source', width: 22 },
      { header: 'IDENTIFIER', key: 'identifier', width: 26 }, { header: 'Beyond author KRT', key: 'beyondAuthorKrt', width: 17 },
      { header: 'In manuscript?', key: 'inManuscript', width: 14 }, { header: 'Evidence quote', key: 'quote', width: 60 }
    ], genRows, (r) => (r.inManuscript === 'no' ? 'no' : r.arm));

    addSheet(wb, 'Author KRT', [
      { header: 'RESOURCE TYPE', key: 'resourceType', width: 26 }, { header: 'RESOURCE NAME', key: 'resourceName', width: 40 },
      { header: 'IDENTIFIER', key: 'identifier', width: 28 }, { header: 'SOURCE', key: 'source', width: 24 },
      { header: 'In manuscript?', key: 'inManuscript', width: 14 }
    ], authorRows.map((r) => ({ ...r, inManuscript: supported(r.resourceName, r.identifier) ? 'yes' : 'no' })),
    (r) => (r.inManuscript === 'no' ? 'no' : undefined));

    await wb.xlsx.writeFile(path.join(OUT, `${name}.xlsx`));
    for (const p of per) summary.push({ document: name, ...p });
    allRows.push(...detRows.map((r) => ({ document: name, ...r })));
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'asap-kr-sync A/B/C prompt arms';
  addSheet(wb, 'READ ME — caveats',
    [{ header: 'Topic', key: 't', width: 34 }, { header: 'What you need to know', key: 'd', width: 108 }],
    CAVEATS.map(([t, d]) => ({ t, d })));
  addSheet(wb, 'Summary', [
    { header: 'Document', key: 'document', width: 28 }, { header: 'Arm', key: 'arm', width: 34 },
    { header: 'Seed rows', key: 'seed', width: 10 }, { header: 'Detections', key: 'detections', width: 11 },
    { header: 'Supported %', key: 'detSupportedPct', width: 12 },
    { header: 'Discovery', key: 'discovery', width: 11 }, { header: 'Echo', key: 'echo', width: 10 },
    { header: 'Confirmed', key: 'confirmed', width: 11 }, { header: 'Anchored', key: 'anchored', width: 10 },
    { header: 'Anchored %', key: 'anchoredPct', width: 12 },
    { header: 'Generated', key: 'generated', width: 11 }, { header: 'Rows added', key: 'added', width: 11 },
    { header: 'Added supported %', key: 'addedSupportedPct', width: 17 }
  ], summary, (r) => r.arm.charAt(0));
  addSheet(wb, 'All detections', [
    { header: 'Document', key: 'document', width: 26 }, { header: 'Arm', key: 'arm', width: 6 },
    { header: 'Module', key: 'module', width: 14 }, { header: 'RESOURCE NAME', key: 'resourceName', width: 38 },
    { header: 'IDENTIFIER', key: 'identifier', width: 26 }, { header: 'Is an author row', key: 'isAuthorRow', width: 15 },
    { header: 'In manuscript?', key: 'inManuscript', width: 14 }, { header: 'Evidence status', key: 'evidenceStatus', width: 15 }
  ], allRows, (r) => (r.inManuscript === 'no' ? 'no' : r.arm));
  await wb.xlsx.writeFile(path.join(OUT, '_ARMS_SUMMARY.xlsx'));

  console.log(`written to ${path.relative(ROOT, OUT)}/`);
  console.log(`  ${docs.length} per-document workbooks + _ARMS_SUMMARY.xlsx`);
  console.log(`  detection rows across all arms: ${allRows.length}`);
})();
