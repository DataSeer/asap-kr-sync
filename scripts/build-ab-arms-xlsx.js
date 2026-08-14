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
const MD_DIR = path.join(ROOT, 'tmp/batch-check/markdown');
// NOT inside tmp/ab-arms: those directories are created by the container running
// as root, so the host user cannot write into them. A sibling keeps this
// runnable without sudo.
const OUT_ROOT = path.join(ROOT, 'tmp/ab-arms-reports');

// Each run gets its own input directory and its own set of workbooks, so a
// reviewer can open one document for one run without the two being merged.
// run0 (a malformed materials prompt) is deliberately absent — it is archived
// but excluded from every figure.
const RUNS = {
  1: path.join(ROOT, 'tmp/ab-arms-run1'),
  2: path.join(ROOT, 'tmp/ab-arms')
};

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
    'Arm B confirms far more author rows than A (about 70% more in both runs). That looks decisive and is largely MISATTRIBUTION — see the anchoring column. Corrected for anchoring the real gap is ~7%, not 70%. Do not quote the confirmation counts without the anchored ones.'],
  ['Anchored confirmations',
    'Of the author rows an arm confirmed, how many have their OWN name or identifier in the manuscript. A: 83-85%. C: 86-87%. B: 56-58%. The unanchored ones rest on a quote that verified as real text but is not demonstrably about that resource — typically a neighbouring sentence about a different resource.'],
  ['Why "echo" reads 0 everywhere',
    'Echo counts author-row detections whose quote failed to verify. It is 0 in all three arms — neither design fabricates quotes. But a quote verifies if that SENTENCE exists, not if it is ABOUT that resource. Echo alone would have produced the wrong conclusion; the anchoring test is what exposed it.'],
  ['Discovery — the solid result',
    'Items found that are NOT author rows: what the author missed. Seeding cannot inflate it, so it compares cleanly. Seeding costs 35% of it, and arm A beat arm B on 21 of 22 document-runs across two independent runs (pooled sign test p ~ 1e-5). NOTE: the separated materials prompt covers 9 resource categories where the fused one covers 4, which inflates this. Counting only categories BOTH prompts cover: -24%, still 21 of 22. Quote -24%.'],
  ['Arm C — promising, not proven',
    'Arm C looks best on quality (highest precision at 78-80%, anchoring 86-87%, 165-196 discovery recovered over B). Pooled over both runs it beat arm B on discovery in 18 of 22 document-runs (p = 0.004) — but the runs disagree taken separately: 10 of 11 in run 1, only 8 of 11 in run 2. Promising, not proven.'],
  ['"Supported" is a floor, not correctness',
    'It asks whether the resource is MENTIONED — necessary, not sufficient. Descriptive names ("Proteomics data", "Human GRCh38 reference genome") score no in every arm even when the resource is discussed, so absolute rates understate all three equally while the comparison between them stays fair.'],
  ['What this does NOT settle',
    'Arm A also uses different prompts, so A-vs-B is prompts AND seeding together (see the note in "Discovery" about resource-category coverage). Only B-vs-C isolates seeding alone. Also: nothing here is measured against external ground truth — every figure is self-referential, measuring the app against the authors\' own tables, not against a curator\'s verdict on what the KRT should contain.'],
  ['Run-to-run variance',
    'Measured by running the whole experiment TWICE on identical prompts — see _RUN_VARIANCE.xlsx. Corpus totals are very stable: discovery moved -2% (A), 0% (B), -2% (C) between runs. Per-document spread: median 5% (A), 10% (B), 8% (C); worst case 32-41%. An earlier claim that the fused design was markedly more reproducible rested on n=2 and is NOT supported — if anything the separated arm is the more stable. A SINGLE-DOCUMENT difference below ~30% means nothing; corpus aggregates are what to rely on.'],
  ['Deviations recorded',
    'The fused prompts were given an evidence_quote field so the engine could verify them at all; without a claimed quote every item is unverifiable and the metric becomes meaningless (a planned change to those prompts regardless). Dataset seeds normally go in a structured payload field — here they are appended as a labelled block: same information, different placement. temperature 0 was applied throughout and does NOT remove the variance above.']
];

/** Build the workbooks for one run. */
async function buildRun(run) {
  const IN = RUNS[run];
  const OUT = path.join(OUT_ROOT, `run${run}`);
  if (!fs.existsSync(IN)) { console.error(`run ${run}: no results at ${path.relative(ROOT, IN)}`); return null; }
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
    wb.creator = `asap-kr-sync A/B/C prompt arms — run ${run}`;
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
  wb.creator = `asap-kr-sync A/B/C prompt arms — run ${run}`;
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

  console.log(`run ${run}: ${docs.length} per-document workbooks + _ARMS_SUMMARY.xlsx -> ${path.relative(ROOT, OUT)}/`);
  return summary;
}

/**
 * Cross-run comparison: the same document, the same arm, two independent runs.
 *
 * This is the only honest measure of run-to-run variance we have — the arms
 * cannot serve as each other's replicates because they differ by design. A
 * reader deciding whether a per-document difference means anything should
 * consult this sheet first.
 */
async function buildVariance(s1, s2) {
  const key = (r) => `${r.document}||${r.arm}`;
  const m1 = new Map(s1.map((r) => [key(r), r]));
  const rows = [];
  for (const r2 of s2) {
    const r1 = m1.get(key(r2));
    if (!r1) continue;
    const d = (a, b) => (a > 0 ? Math.round(((b - a) / a) * 100) : '');
    rows.push({
      document: r2.document, arm: r2.arm,
      disc1: r1.discovery, disc2: r2.discovery, discD: d(r1.discovery, r2.discovery),
      det1: r1.detections, det2: r2.detections, detD: d(r1.detections, r2.detections),
      conf1: r1.confirmed, conf2: r2.confirmed, confD: d(r1.confirmed, r2.confirmed),
      anch1: r1.anchoredPct, anch2: r2.anchoredPct
    });
  }

  const totals = [];
  for (const armLabel of [...new Set(rows.map((r) => r.arm))]) {
    const rs = rows.filter((r) => r.arm === armLabel);
    const sum = (f) => rs.reduce((n, r) => n + (Number(f(r)) || 0), 0);
    const spreads = rs.map((r) => Math.abs(Number(r.discD) || 0)).sort((a, b) => a - b);
    totals.push({
      arm: armLabel,
      disc1: sum((r) => r.disc1), disc2: sum((r) => r.disc2),
      discD: sum((r) => r.disc1) > 0 ? Math.round(((sum((r) => r.disc2) - sum((r) => r.disc1)) / sum((r) => r.disc1)) * 100) : '',
      det1: sum((r) => r.det1), det2: sum((r) => r.det2),
      detD: sum((r) => r.det1) > 0 ? Math.round(((sum((r) => r.det2) - sum((r) => r.det1)) / sum((r) => r.det1)) * 100) : '',
      medSpread: spreads[Math.floor(spreads.length / 2)],
      worstSpread: spreads[spreads.length - 1]
    });
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'asap-kr-sync A/B/C prompt arms — run variance';
  addSheet(wb, 'READ ME', [
    { header: 'Topic', key: 't', width: 30 }, { header: 'What you need to know', key: 'd', width: 110 }
  ], [
    { t: 'What this is', d: 'The same 11 manuscripts, the same three arms, run twice end to end on identical prompts. Differences here are pure run-to-run noise — nothing changed between the runs.' },
    { t: 'Why it matters', d: 'It sets the bar a per-document difference has to clear before it means anything. Corpus totals are stable; single-document deltas are not.' },
    { t: 'How to use it', d: 'Before quoting a per-document difference between arms, check the same-arm spread here. If the arm-to-arm difference is inside the run-to-run spread, it is noise.' },
    { t: 'Excluded', d: 'An earlier run used a materials prompt with a malformed output example. It is archived but excluded from every figure, so both runs compared here used identical prompts.' }
  ]);
  addSheet(wb, 'Totals by arm', [
    { header: 'Arm', key: 'arm', width: 34 },
    { header: 'Discovery run 1', key: 'disc1', width: 15 }, { header: 'Discovery run 2', key: 'disc2', width: 15 },
    { header: 'Discovery Δ%', key: 'discD', width: 13 },
    { header: 'Detections run 1', key: 'det1', width: 16 }, { header: 'Detections run 2', key: 'det2', width: 16 },
    { header: 'Detections Δ%', key: 'detD', width: 14 },
    { header: 'Median per-doc spread %', key: 'medSpread', width: 22 },
    { header: 'Worst per-doc spread %', key: 'worstSpread', width: 21 }
  ], totals, (r) => r.arm.charAt(0));
  addSheet(wb, 'Per document', [
    { header: 'Document', key: 'document', width: 28 }, { header: 'Arm', key: 'arm', width: 32 },
    { header: 'Disc run 1', key: 'disc1', width: 11 }, { header: 'Disc run 2', key: 'disc2', width: 11 },
    { header: 'Disc Δ%', key: 'discD', width: 9 },
    { header: 'Det run 1', key: 'det1', width: 10 }, { header: 'Det run 2', key: 'det2', width: 10 },
    { header: 'Det Δ%', key: 'detD', width: 9 },
    { header: 'Confirmed run 1', key: 'conf1', width: 15 }, { header: 'Confirmed run 2', key: 'conf2', width: 15 },
    { header: 'Confirmed Δ%', key: 'confD', width: 13 },
    { header: 'Anchored % run 1', key: 'anch1', width: 16 }, { header: 'Anchored % run 2', key: 'anch2', width: 16 }
  ], rows, (r) => r.arm.charAt(0));
  await wb.xlsx.writeFile(path.join(OUT_ROOT, '_RUN_VARIANCE.xlsx'));
  console.log(`variance: ${rows.length} document/arm pairs -> tmp/ab-arms-reports/_RUN_VARIANCE.xlsx`);
}

(async () => {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const s1 = await buildRun(1);
  const s2 = await buildRun(2);
  if (s1 && s2) await buildVariance(s1, s2);
  else console.log('variance: skipped (needs both runs)');
})();
