#!/usr/bin/env node
/**
 * Gold linkage: every author KRT row -> every place it occurs in the manuscript.
 *
 * This is the measuring instrument, not a pipeline stage. Everything we have
 * measured so far scores the app against the author's own table, which is
 * neither complete nor certainly correct, so it cannot separate a find from
 * noise. This builds the reference that can.
 *
 * BUILT BLIND. It reads the author KRT and the markdown, and NOTHING the
 * pipeline produced. A gold set derived from pipeline output would inherit the
 * pipeline's blind spots and quietly certify its own answers.
 *
 * Two design points that matter downstream:
 *
 *   - A row links to a SET of chunks, not one. A resource mentioned five times
 *     has five valid locations, and a candidate matching any of them found it.
 *     This is also what makes the grouping case scorable: one KRT row covering
 *     several mentions becomes a set with partial credit, instead of a miss.
 *
 *   - Chunks collide. Measured on this corpus, only 43% of rows sit alone in
 *     their sentence and 13% in their paragraph — reagent lists put dozens of
 *     resources in one span. So every chunk carries how many OTHER rows share
 *     it; a citation into a 20-row chunk proves far less than one into a chunk
 *     of its own, and the scorer must weigh them differently.
 *
 * Human verdicts live in a separate CSV and are merged on top, so rebuilding
 * the candidates never destroys review work.
 *
 * Offline: no LM calls, no database.
 *
 * Usage: node scripts/build-krt-linkage.js [--only <name>]
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const B = path.join(ROOT, 'src/backend');
const DOCS = path.join(ROOT, 'src/frontend/public/demo-files');
const MD_DIR = path.join(ROOT, 'tmp/batch-check/markdown');
const OUT = path.join(ROOT, 'tmp/krt-linkage');
const VERDICTS = path.join(OUT, 'verdicts.csv');

const parserService = require(path.join(B, 'services/krt/parser.service'));
const { buildEvidenceIndex, findAllOccurrences, extractContext, isCitationSection } =
  require(path.join(B, 'services/pdf-analysis/evidence.service'));
const { isDistinctive } = require(path.join(B, 'services/krt-grounding/match-author-rows.service'));

const MIME = {
  '.csv': 'text/csv',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};
const MAX_CHUNKS = 8;
/** Below this the evidence index refuses to search at all. */
const MIN_NAME_CHARS = 4;
const only = (() => { const i = process.argv.indexOf('--only'); return i > -1 ? process.argv[i + 1] : null; })();

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
/** Stable across re-runs and re-sorts — row index is not. */
const rowKey = (doc, r) => `${doc}||${norm(r.resourceName)}||${norm(r.identifier)}`;

/** Every identifier in the cell, not just the first: rows carry ";"-joined lists. */
function identifiers(raw) {
  return String(raw || '')
    .split(/[;,]/)
    .map((s) => s.replace(/^\s*(RRID|DOI|Cat|Catalog)[\s:#]*/i, '').trim())
    .filter((s) => s.length >= 4);
}

/**
 * A separator-insensitive view of the document, with a map back to real
 * offsets. Authors write "Image J" where the paper writes "ImageJ", and
 * "DMEM/F12 - HEPES" where the paper writes "DMEM/F12-HEPES". Those are the
 * same string once spaces, hyphens, dots and underscores stop counting, and
 * treating them as different costs 28 rows on this corpus.
 */
function buildFlatIndex(md) {
  const chars = [];
  const map = [];
  const lower = md.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i];
    if (/[\s.\-_]/.test(c)) continue;
    chars.push(c);
    map.push(i);
  }
  return { flat: chars.join(''), map };
}

const flatten = (s) => String(s ?? '').toLowerCase().replace(/[\s.\-_]/g, '');

/**
 * Whole-word search for names too short for the normal path.
 *
 * Three separate length guards (this file's own >=4, MIN_MENTION_CHARS in the
 * evidence index, and isDistinctive's single-token rule) each independently
 * reject a 3-character name, so rows like the R package "zoo" came back as
 * "nothing found" while the manuscript says "zoo (1.8.14)" in plain sight.
 *
 * Substring matching is not the answer — it would take "zoo" from "zoom-ins" in
 * the same document. Word boundaries are, and they must be manual: \b treats a
 * hyphen as a boundary, so \bzoo\b still matches inside "zoo-like".
 *
 * Stops at 2 characters. A one-character name ("R", the language) hits 78 times
 * in a single paper and no boundary rule rescues that.
 */
function findShortWord(md, name, cap) {
  const n = String(name || '').trim();
  if (n.length < 2 || n.length >= MIN_NAME_CHARS) return [];
  const re = new RegExp(`(?<![A-Za-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'gi');
  const out = [];
  for (const m of md.matchAll(re)) {
    out.push({ offset: m.index });
    if (out.length >= cap) break;
  }
  return out;
}

/** Every separator-insensitive occurrence, as real offsets. */
function findFlat(flatIndex, needle, cap) {
  const n = flatten(needle);
  if (n.length < 5) return [];
  const out = [];
  let at = flatIndex.flat.indexOf(n);
  while (at !== -1 && out.length < cap) {
    out.push({ offset: flatIndex.map[at] });
    at = flatIndex.flat.indexOf(n, at + n.length);
  }
  return out;
}

/**
 * Authors write "X (e.g. Y)" or "X (DMEM)", where the parenthetical is the name
 * the PAPER uses. But they equally write "Cas9 CUT&RUN (crosslinked)" and
 * "Cell culture (hiPSCs)", where it is a QUALIFIER — and accepting those as
 * names produced visibly wrong links ("crosslinked" matched an unrelated
 * sentence about handling samples).
 *
 * So the parenthetical counts as an alias only when it is marked as one, or
 * when it is an acronym of the head. Everything else falls through to human
 * review, which is the right destination for an ambiguous name.
 *
 * @param {string} name
 * @returns {string[]} search terms, head first
 */
function nameParts(name) {
  const m = String(name).match(/^(.*?)\s*\((.+)\)\s*$/);
  if (!m) return [];
  const head = m[1].trim();
  let tail = m[2].trim();
  const marked = /^(e\.?\s?g\.?|also|aka|referred to as)\b[\s.:]*/i.test(tail);
  tail = tail.replace(/^(e\.?\s?g\.?|also|aka|referred to as)\b[\s.:]*/i, '').trim();

  const initials = head.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toLowerCase()).join('');
  const flatTail = tail.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  const isAcronym = flatTail.length >= 2 && flatTail.length <= 8
    && initials.includes(flatTail[0]) && flatTail.split('').every((c) => initials.includes(c));

  const out = [];
  if (head.length >= 4 && isDistinctive(head.toLowerCase().split(/[^a-z0-9+._-]+/i).filter(Boolean))) out.push(head);
  if ((marked || isAcronym) && tail.length >= 4) out.push(tail);
  return out;
}

/**
 * Contiguous whole-token runs of a name, longest first, filtered by the SAME
 * distinctiveness rule the matcher uses so this cannot propose a candidate the
 * matcher would refuse.
 */
function tokenRuns(name) {
  const toks = norm(name).split(/[^a-z0-9+._-]+/).filter(Boolean);
  const runs = [];
  for (let len = toks.length; len >= 1; len--) {
    for (let i = 0; i + len <= toks.length; i++) {
      const run = toks.slice(i, i + len);
      if (isDistinctive(run)) runs.push(run.join(' '));
    }
  }
  return [...new Set(runs)];
}

/**
 * The identifier family a value belongs to, for asking whether the manuscript
 * prints that KIND of identifier at all.
 */
function idNamespace(identifier) {
  const v = String(identifier || '');
  const m = v.match(/RRID:\s*([A-Za-z]+)_/i);
  if (m) return `RRID:${m[1].toUpperCase()}`;
  if (/10\.\d{4}/.test(v)) return 'DOI';
  if (/^https?:/i.test(v.trim())) return 'URL';
  return null;
}

/** Which identifier families this manuscript actually prints. */
function namespacesInText(md) {
  const out = new Set();
  for (const m of md.matchAll(/RRID:\s*([A-Za-z]+)_/gi)) out.add(`RRID:${m[1].toUpperCase()}`);
  if (/10\.\d{4}\//.test(md)) out.add('DOI');
  // URL is deliberately absent: essentially every manuscript contains some
  // link, so "the paper prints URLs" discriminates nothing and would flag 67
  // rows where 23 are real.
  return out;
}

/** The sentence containing an offset, plus its absolute start (the chunk key). */
function chunkAt(md, offset, needleLength) {
  const ctx = extractContext(md, offset, needleLength);
  if (!ctx) return null;
  const base = offset - ctx.quoteStart;
  const sentence = ctx.context.slice(ctx.sentenceStart, ctx.sentenceEnd).trim();
  return { start: base + ctx.sentenceStart, sentence };
}

function loadVerdicts() {
  if (!fs.existsSync(VERDICTS)) return new Map();
  const out = new Map();
  const lines = fs.readFileSync(VERDICTS, 'utf-8').split(/\r?\n/).slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = line.match(/("([^"]|"")*"|[^,]*)/g).filter((_, i) => i % 2 === 0)
      .map((c) => c.replace(/^"|"$/g, '').replace(/""/g, '"'));
    if (cells[0]) out.set(cells[0], { verdict: cells[1] || '', alias: cells[2] || '', notes: cells[3] || '' });
  }
  return out;
}

async function loadAuthorKrt(p) {
  const parsed = await parserService.parseFile(
    fs.readFileSync(p), MIME[path.extname(p).toLowerCase()], path.basename(p));
  const rows = Array.isArray(parsed) ? parsed : (parsed?.rows || parsed?.data || []);
  return rows.map((r) => ({
    resourceType: r['RESOURCE TYPE'] || '', resourceName: r['RESOURCE NAME'] || '',
    identifier: r['IDENTIFIER'] || '', source: r['SOURCE'] || '',
    newReuse: r['NEW/REUSE'] || '', additionalInformation: r['ADDITIONAL INFORMATION'] || ''
  })).filter((r) => r.resourceName);
}

/** One document: link every row, then annotate each chunk with its collisions. */
function linkDocument(name, authorRows, md) {
  const index = buildEvidenceIndex(md);
  const flatIndex = buildFlatIndex(md);
  const paperNamespaces = namespacesInText(md);
  const linked = [];

  for (const row of authorRows) {
    const nameStr = String(row.resourceName || '').trim();
    const ids = identifiers(row.identifier);
    const hits = new Map();   // absolute sentence start -> chunk

    const sectionOf = (off) => {
      let best = '';
      for (const h of (index.headings || [])) { if (h.offset <= off) best = h.title || h.text || best; else break; }
      return best;
    };
    const add = (occ, via, needle) => {
      for (const o of occ) {
        const c = chunkAt(md, o.offset, needle.length);
        if (!c) continue;
        const prev = hits.get(c.start);
        if (prev) { if (!prev.via.includes(via)) prev.via.push(via); continue; }
        hits.set(c.start, {
          start: c.start, sentence: c.sentence, section: o.section || sectionOf(o.offset),
          citation: isCitationSection(o.section), via: [via], needle
        });
      }
    };

    let idHit = false;
    for (const id of ids) {
      const occ = findAllOccurrences(index, id, MAX_CHUNKS);
      if (occ.length) { idHit = true; add(occ, 'identifier', id); }
    }
    const nameOcc = nameStr.length >= MIN_NAME_CHARS ? findAllOccurrences(index, nameStr, MAX_CHUNKS) : [];
    let nameHit = nameOcc.length > 0;
    if (nameHit) add(nameOcc, 'name', nameStr);

    // Same name, different separators — resolved automatically but recorded as
    // its own `via` so a reviewer can see why it linked and check it.
    let normalisedBy = '';
    if (!nameHit) {
      const flat = findFlat(flatIndex, nameStr, MAX_CHUNKS);
      if (flat.length) {
        nameHit = true;
        normalisedBy = 'separators';
        add(flat.map((o) => ({ ...o, section: '' })), 'name-nospace', nameStr);
      }
    }
    // "X (e.g. Y)": either half is a legitimate name for the same resource.
    if (!nameHit) {
      for (const part of nameParts(nameStr)) {
        const occ = findAllOccurrences(index, part, MAX_CHUNKS);
        if (!occ.length) continue;
        nameHit = true;
        normalisedBy = normalisedBy || 'parenthetical';
        add(occ, 'name-part', part);
      }
    }

    // Only when nothing settled it: propose partial evidence for a human.
    const proposals = [];
    if (!idHit && !nameHit) {
      // Deliberately a proposal, not a link: "PBS" occurs 12 times in one paper
      // and only a human can say which occurrence is the reagent row.
      const shortOcc = findShortWord(md, nameStr, 3);
      if (shortOcc.length) {
        add(shortOcc.map((o) => ({ ...o, section: '' })), 'name-short', nameStr);
        proposals.push(`${nameStr} (whole word)`);
      }
      for (const run of tokenRuns(nameStr)) {
        const occ = findAllOccurrences(index, run, 3);
        if (!occ.length) continue;
        add(occ, 'token', run);
        proposals.push(run);
        if (proposals.length >= 3) break;
      }
    }

    let bucket;
    if (nameHit && idHit) bucket = 'exact';
    else if (idHit) bucket = 'alias-by-id';
    else if (nameHit) bucket = 'name-only';
    else if (proposals.length) bucket = 'tokens-only';
    else bucket = 'not-found';

    linked.push({
      key: rowKey(name, row), document: name, ...row,
      bucket,
      normalisedBy,
      hasIdentifier: ids.length > 0,
      // An author identifier missing from the text is USUALLY nothing: most
      // papers never print RRIDs. It is only notable when the paper prints that
      // KIND of identifier for other resources and the resource itself is
      // clearly present — then its identifier is conspicuously absent. That
      // distinction takes the list from 652 rows to 23.
      identifierNotable: ids.length > 0 && !idHit && nameHit
        && paperNamespaces.has(idNamespace(row.identifier)),
      identifierInText: idHit,
      nameInText: nameHit,
      matchedTokens: proposals,
      chunks: [...hits.values()].sort((a, b) => a.start - b.start)
    });
  }

  // How many OTHER rows land in the same sentence. A citation into a crowded
  // chunk identifies almost nothing.
  const perChunk = new Map();
  for (const r of linked) for (const c of r.chunks) {
    if (!perChunk.has(c.start)) perChunk.set(c.start, new Set());
    perChunk.get(c.start).add(r.key);
  }
  for (const r of linked) for (const c of r.chunks) c.rowsSharing = perChunk.get(c.start).size;

  return linked;
}

const BUCKET_LABEL = {
  exact: '1 · name AND identifier in text',
  'alias-by-id': '2a · identifier in text, name differs',
  'name-only': '1b · name in text, identifier not',
  'tokens-only': '2b · only partial name matched',
  'not-found': '3 · nothing found'
};
const PROPOSED = {
  exact: 'LINKED',
  'alias-by-id': 'LINKED',
  'name-only': 'LINKED',
  'tokens-only': '',
  'not-found': ''
};
const NEEDS_REVIEW = new Set(['tokens-only', 'not-found']);


const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
const HEADER_FONT = { color: { argb: 'FFFFFFFF' }, bold: true };
const TINT = { review: 'FFFFF3D6', error: 'FFFBE4E4', ok: 'FFE7F6E7' };

function sheet(wb, title, columns, rows, tint) {
  const ws = wb.addWorksheet(title.replace(/[:\\/?*[\]]/g, '-').slice(0, 31),
    { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns;
  ws.getRow(1).font = HEADER_FONT;
  ws.getRow(1).fill = HEADER_FILL;
  ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
  for (const r of rows) {
    const added = ws.addRow(r);
    const t = tint && tint(r);
    if (t) added.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: t } };
    added.alignment = { vertical: 'top', wrapText: true };
  }
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

/** Flatten a row's chunks into review columns: sentence, section, crowding. */
function chunkCols(r) {
  const out = {};
  r.chunks.slice(0, 3).forEach((c, i) => {
    out[`s${i + 1}`] = c.sentence;
    out[`w${i + 1}`] = `${c.section}${c.citation ? ' [CITATION]' : ''} · shared with ${c.rowsSharing - 1}`;
  });
  return out;
}

async function writeReview(all, verdicts) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'asap-kr-sync KRT gold linkage';

  sheet(wb, 'READ ME', [
    { header: 'Topic', key: 't', width: 32 }, { header: 'What you need to know', key: 'd', width: 112 }
  ], [
    { t: 'What this is', d: 'Every author KRT row linked to every place it occurs in the manuscript, computed from the KRT and the markdown ONLY. It never reads pipeline output — a gold set built from the pipeline would certify the pipeline\'s own blind spots.' },
    { t: 'Why we need it', d: 'Every measure so far scores the app against the author\'s own table, which is neither complete nor certainly correct. It cannot tell a real find from noise. This is the reference that can.' },
    { t: 'What to do', d: 'Fill the VERDICT column on the "Needs review" sheet. The other sheets are for spot-checking. Suggested: do a stratified 100 rows first and stop — that is enough to say whether the automatic bucketing is trustworthy before spending hours on the rest.' },
    { t: 'VERDICT values', d: 'LINKED = the row IS this passage. NOT-IN-PAPER = the resource genuinely is not discussed. GROUPED = one KRT row covering several separate mentions. AUTHOR-ERROR = the KRT itself looks wrong (bad identifier, wrong name). UNSURE = leave for discussion.' },
    { t: 'ALIAS FOUND column', d: 'When the paper names the resource differently, put the paper\'s wording here. These pairs feed the matcher\'s alias tier directly — it was worth 97 extra matches when it was last fixed, and this is real author-vs-paper phrasing.' },
    { t: '"shared with N"', d: 'How many OTHER author rows land in the same sentence. Reagent lists put dozens of resources in one span: only 43% of rows sit alone in their sentence, 13% in their paragraph. A passage shared with 20 rows barely identifies anything, so treat a lone chunk as much stronger evidence.' },
    { t: '[CITATION]', d: 'The passage is in a reference list or bibliography. A mention there is someone else citing the resource, not this paper using it.' },
    { t: 'Your work is safe', d: 'Verdicts are stored in verdicts.csv keyed on document + name + identifier, and merged back on every rebuild. Regenerating the candidates never overwrites them, and re-sorting cannot misalign them.' },
    { t: '"Identifier not in text"', d: 'An author identifier missing from the manuscript is USUALLY nothing — most papers never print RRIDs, which is why that sheet has 652 rows. Only the ones marked Notable are worth your time (23 of them): the paper prints that KIND of identifier for other resources, and this resource is clearly present, so its identifier is conspicuously absent.' },
    { t: 'Grouping (case C)', d: 'Not excluded from the measurement — that would inflate every number and hide how common it is. It is scored on chunk-set coverage instead: if the pipeline emits 5 individual rows covering all 5 gold passages, that counts as found, no grouping policy required.' }
  ]);

  const needs = all.filter((r) => NEEDS_REVIEW.has(r.bucket))
    .sort((a, b) => (a.bucket === b.bucket
      ? (b.chunks.length - a.chunks.length) || a.document.localeCompare(b.document)
      : (a.bucket === 'tokens-only' ? -1 : 1)));

  sheet(wb, 'Needs review', [
    { header: 'Document', key: 'document', width: 26 },
    { header: 'Case', key: 'bucket', width: 26 },
    { header: 'RESOURCE TYPE', key: 'resourceType', width: 22 },
    { header: 'RESOURCE NAME', key: 'resourceName', width: 34 },
    { header: 'IDENTIFIER', key: 'identifier', width: 22 },
    { header: 'SOURCE', key: 'source', width: 18 },
    { header: 'Matched on', key: 'matched', width: 20 },
    { header: 'Candidate passage 1', key: 's1', width: 60 },
    { header: 'Where 1', key: 'w1', width: 28 },
    { header: 'Candidate passage 2', key: 's2', width: 60 },
    { header: 'Where 2', key: 'w2', width: 28 },
    { header: 'Candidate passage 3', key: 's3', width: 60 },
    { header: 'Where 3', key: 'w3', width: 28 },
    { header: 'VERDICT', key: 'verdict', width: 16 },
    { header: 'ALIAS FOUND', key: 'alias', width: 30 },
    { header: 'NOTES', key: 'notes', width: 34 }
  ], needs.map((r) => ({
    ...r, bucket: BUCKET_LABEL[r.bucket],
    matched: r.matchedTokens.join(' | '),
    verdict: r.verdict || '', alias: r.alias || '', notes: r.notes || '',
    ...chunkCols(r)
  })), () => TINT.review);

  // An identifier absent from the text is usually normal — papers rarely print
  // RRIDs. Sorted so the conspicuous ones (paper prints that identifier family
  // for other resources, and this resource IS present) come first.
  const missingId = all.filter((r) => r.hasIdentifier && !r.identifierInText && r.bucket !== 'not-found')
    .sort((a, b) => (b.identifierNotable ? 1 : 0) - (a.identifierNotable ? 1 : 0));
  sheet(wb, 'Identifier not in text', [
    { header: 'Notable?', key: 'notable', width: 11 },
    { header: 'Document', key: 'document', width: 26 },
    { header: 'RESOURCE TYPE', key: 'resourceType', width: 22 },
    { header: 'RESOURCE NAME', key: 'resourceName', width: 34 },
    { header: 'IDENTIFIER (not in text)', key: 'identifier', width: 26 },
    { header: 'SOURCE', key: 'source', width: 18 },
    { header: 'Resource found at', key: 'w1', width: 28 },
    { header: 'Passage', key: 's1', width: 70 },
    { header: 'VERDICT', key: 'verdict', width: 16 },
    { header: 'NOTES', key: 'notes', width: 34 }
  ], missingId.map((r) => ({
    ...r, notable: r.identifierNotable ? 'YES' : '',
    verdict: r.verdict || '', notes: r.notes || '', ...chunkCols(r)
  })), (r) => (r.notable === 'YES' ? TINT.error : undefined));

  const auto = all.filter((r) => !NEEDS_REVIEW.has(r.bucket));
  sheet(wb, 'Auto-decided (spot check)', [
    { header: 'Document', key: 'document', width: 26 },
    { header: 'Case', key: 'bucket', width: 26 },
    { header: 'RESOURCE NAME', key: 'resourceName', width: 34 },
    { header: 'IDENTIFIER', key: 'identifier', width: 22 },
    { header: 'Occurrences', key: 'n', width: 12 },
    { header: 'Passage', key: 's1', width: 70 },
    { header: 'Where', key: 'w1', width: 28 },
    { header: 'Proposed', key: 'proposed', width: 12 },
    { header: 'VERDICT', key: 'verdict', width: 16 }
  ], auto.map((r) => ({
    ...r, bucket: BUCKET_LABEL[r.bucket], n: r.chunks.length,
    proposed: PROPOSED[r.bucket], verdict: r.verdict || '', ...chunkCols(r)
  })), () => TINT.ok);

  await wb.xlsx.writeFile(path.join(OUT, '_REVIEW.xlsx'));

  // Seed verdicts.csv so the first review has somewhere to go.
  if (!fs.existsSync(VERDICTS)) {
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    fs.writeFileSync(VERDICTS, 'key,verdict,alias,notes\n'
      + needs.map((r) => [r.key, '', '', ''].map(esc).join(',')).join('\n') + '\n');
  }
}

module.exports = { linkDocument, rowKey, identifiers, tokenRuns, chunkAt, nameParts };

if (require.main === module) {
  (async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const verdicts = loadVerdicts();
    const all = [];

    const names = fs.readdirSync(MD_DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
    for (const name of names) {
      if (only && name !== only) continue;
      const krt = ['.csv', '.xlsx'].map((e) => path.join(DOCS, `${name}${e}`)).find((f) => fs.existsSync(f));
      if (!krt) continue;
      const md = fs.readFileSync(path.join(MD_DIR, `${name}.md`), 'utf-8');
      const rows = await loadAuthorKrt(krt);
      const linked = linkDocument(name, rows, md);
      for (const r of linked) Object.assign(r, verdicts.get(r.key) || {});
      fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(linked, null, 1));
      all.push(...linked);
      const rev = linked.filter((r) => NEEDS_REVIEW.has(r.bucket)).length;
      process.stdout.write(`  ${name.slice(0, 28).padEnd(30)} ${String(linked.length).padStart(4)} rows · ${String(rev).padStart(3)} to review\n`);
    }

    if (!all.length) { console.error('No documents with both a KRT and cached markdown.'); process.exit(1); }
    await writeReview(all, verdicts);

    const counts = {};
    for (const r of all) counts[r.bucket] = (counts[r.bucket] || 0) + 1;
    const review = all.filter((r) => NEEDS_REVIEW.has(r.bucket)).length;
    console.log(`\n${all.length} author rows across ${new Set(all.map((r) => r.document)).size} documents`);
    for (const b of Object.keys(BUCKET_LABEL)) {
      console.log(`  ${BUCKET_LABEL[b].padEnd(38)} ${String(counts[b] || 0).padStart(5)}`);
    }
    console.log(`\n  auto-decidable ${all.length - review} · needs review ${review}`);
    console.log(`  -> ${path.relative(ROOT, OUT)}/  (per-document JSON + _REVIEW.xlsx)`);
    if (verdicts.size) console.log(`  merged ${verdicts.size} existing verdicts from verdicts.csv`);
  })();
}
