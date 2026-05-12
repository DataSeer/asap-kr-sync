#!/usr/bin/env node

/**
 * Generate Demo Descriptions
 *
 * For each demo manuscript that has a `*-demo.md` markdown but no `title` /
 * `description` set on its `*-demo.json`, extract a plausible title from the
 * markdown (heuristic — skips journal metadata, URLs, all-caps section
 * markers, etc.) and write it back. The `description` is derived from the
 * extracted title, truncated to ~80 chars at a word boundary.
 *
 * Usage:
 *   node scripts/generate-demo-descriptions.js [--force]
 *
 *   --force   overwrite existing title / description values
 */

const fs = require('fs');
const path = require('path');

const DEMO_DIR = path.join(__dirname, '../src/backend/data/demo-findings');
const FORCE = process.argv.includes('--force');

// ===================== HEURISTICS =====================

/**
 * Lines we never want to use as a title — journal/preprint metadata, URLs,
 * standalone section markers, etc.
 *
 * Patterns are case-insensitive, anchored to the START of the trimmed line
 * unless they contain `\b` (word boundary).
 */
const METADATA_PATTERNS = [
  /^contents\s+lists\b/i,
  /^available\s+at\b/i,
  /^published\s+in\b/i,
  /^published\s+by\b/i,
  /^©/,
  /^doi:/i,
  /^www\./i,
  /^https?:/i,
  /^biorxiv\b/i,
  /^medrxiv\b/i,
  /^npj\b/i,
  /^nature\b/i,
  /^elsevier\b/i,
  /^springer\b/i,
  /^research\s+article\b/i,
  /^research\s+paper\b/i,
  /^review\s+article\b/i,
  /^short\s+article\b/i,
  /^short\s+report\b/i,
  /^article\s*$/i,
  /^title\s*$/i,
  /^abstract\s*$/i,
  /^introduction\s*$/i,
  /^open\s+access\b/i,
  /^manuscript\s*$/i,
  /^template\s*$/i,
  /^biochemistry\s*$/i,
  /^volume\s+\d/i,
  /^issue\s+\d/i,
  /^author\b/i,
  /^preprint\b/i,
  /^this\s+version\s+posted\b/i,        // bioRxiv version stamp
  /^revised\s+manuscript\b/i,           // submission boilerplate
  /^click\s+here\b/i,                   // submission boilerplate
  /^please\s+use\s+this\s+pdf\b/i,      // proof-checking boilerplate
  /^made\s+to\s+the\s+layout\b/i,       // proof-checking continuation
  /online\s+proofing\s+interface/i,     // proof-checking continuation
  /^the\s+copyright\s+holder\b/i,       // bioRxiv copyright line
  /^cc[\-\s]?by\b/i,                    // standalone "CC-BY 4.0 International license"
  /made\s+available\s+under\s+a?\s*cc/i,// "made available under a CC-BY"
  /^perpetuity\b/i,                     // "perpetuity. It is made available..."
  /^correct\s+and\s+submit\b/i,         // proof continuation
  /^article\s+before\s+publication\b/i, // proof boilerplate
  /but\s+are\s+not\s+reflected\s+in\s+this\s+pdf/i, // proof boilerplate
  /^\(which\s+was\s+not\s+certified\b/i,// bioRxiv legalese
  /^[a-z][\w-]*\s+et\s+al\.?\s*$/i,     // standalone "Lubben et al."
  /journal\s+homepage/i,                // anywhere in the line
  /^homepage\b/i,
  /\.(docx?|pdf|tex)\s*$/i,             // filename leakage
  /\(\d{4}\)\s+\d+\s*[:;,]\s*\d/,       // "(2024) 13:13" journal volume tail
  /^[\d,\s]+$/,                         // pure numbers / page markers
  /^[\s\W]+$/                            // pure punctuation/whitespace
];

function isMetadata(line) {
  if (!line || line.length < 3) return true;
  return METADATA_PATTERNS.some(p => p.test(line));
}

/**
 * Whether a line looks like a plausible title fragment: mixed-case, decent
 * length, contains letters.
 */
function looksLikeTitle(line) {
  if (line.length < 25 || line.length > 250) return false;
  const hasLetter = /[A-Za-z]/.test(line);
  if (!hasLetter) return false;
  // Reject lines that are >80% uppercase (section headings, ALL-CAPS NOTICES)
  const letters = line.match(/[A-Za-z]/g) || [];
  const uppers = line.match(/[A-Z]/g) || [];
  if (letters.length > 0 && uppers.length / letters.length > 0.8) return false;
  return true;
}

/**
 * Extract a title from a markdown string.
 *
 * Strategy: scan first ~50 non-empty lines, drop metadata, then take the
 * first plausible line. If the next line continues without a period and
 * looks like part of the title, append it (titles often wrap mid-sentence).
 */
function stripTitlePrefix(s) {
  return s.replace(/^(running\s+)?title\s*[:\-–—]\s*/i, '').trim();
}

function extractTitle(markdown) {
  if (!markdown) return null;
  const lines = markdown.split('\n').map(l => stripTitlePrefix(l.trim())).filter(l => l.length > 0).slice(0, 50);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!isMetadata(line) && looksLikeTitle(line)) {
      // Try to grow the title by absorbing the next line if it looks like
      // a wrapped continuation. Refuse to absorb author lists (comma + digit
      // affiliation markers, "et al.") or section headings.
      let title = line;
      const endsClean = /[.?!:]$/.test(title);
      const next = lines[i + 1];
      if (!endsClean && next && !isMetadata(next) && looksLikeTitle(next)) {
        const looksLikeAuthors = /\b\w+\s+\w+\d+\s*[,.]/i.test(next)  // "Sampson2,"
          || /\bet\s+al\.?/i.test(next)
          || /^[A-Z][a-z]+\s+[A-Z]\.?\s/.test(next);                  // "Timothy R."
        const looksLikeSection = /^(abstract|introduction|background|results|methods|summary|keywords)\b/i.test(next);
        if (!looksLikeAuthors && !looksLikeSection) {
          title = `${title} ${next}`;
        }
      }
      // Normalize whitespace (collapse multiple spaces from PDF extraction)
      return title.replace(/\s+/g, ' ').trim();
    }
    i++;
  }
  return null;
}

/**
 * Truncate to N chars at a word boundary; appends "…" if cut.
 */
function truncate(str, max) {
  if (!str || str.length <= max) return str;
  const slice = str.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 30 ? slice.slice(0, lastSpace) : slice).replace(/[\s\W]+$/, '') + '…';
}

// ===================== MAIN =====================

function main() {
  if (!fs.existsSync(DEMO_DIR)) {
    console.error(`Demo directory not found: ${DEMO_DIR}`);
    process.exit(1);
  }

  const jsonFiles = fs.readdirSync(DEMO_DIR).filter(f => f.endsWith('-demo.json')).sort();

  let titleAdded = 0;
  let descAdded = 0;
  let titleSkipped = 0;
  let descSkipped = 0;
  let noMd = 0;
  let noTitleFound = 0;

  for (const jsonFile of jsonFiles) {
    const jsonPath = path.join(DEMO_DIR, jsonFile);
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const id = data.manuscriptId;
    if (!id) continue;

    const before = JSON.stringify(data);

    // ---- title ----
    const hasTitle = data.title && data.title.trim().length > 0;
    if (hasTitle && !FORCE) {
      titleSkipped++;
    } else {
      const mdPath = path.join(DEMO_DIR, jsonFile.replace('-demo.json', '-demo.md'));
      if (!fs.existsSync(mdPath)) {
        noMd++;
      } else {
        const md = fs.readFileSync(mdPath, 'utf-8');
        const extracted = extractTitle(md);
        if (extracted) {
          data.title = extracted;
          titleAdded++;
        } else {
          noTitleFound++;
        }
      }
    }

    // ---- description ----
    // Derive a short description from the (extracted or pre-existing) title.
    const hasDesc = data.description && data.description.trim().length > 0;
    if (hasDesc && !FORCE) {
      descSkipped++;
    } else if (data.title) {
      const shortened = truncate(data.title, 80);
      if (shortened && shortened !== data.description) {
        data.description = shortened;
        descAdded++;
      } else {
        descSkipped++;
      }
    }

    if (JSON.stringify(data) !== before) {
      fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
    }
  }

  console.log('=== Generate Demo Descriptions ===');
  console.log(`Files scanned:        ${jsonFiles.length}`);
  console.log(`Titles added/updated: ${titleAdded}`);
  console.log(`Titles skipped:       ${titleSkipped}`);
  console.log(`Descriptions added:   ${descAdded}`);
  console.log(`Descriptions skipped: ${descSkipped}`);
  console.log(`No matching .md:      ${noMd}`);
  console.log(`No title extracted:   ${noTitleFound}`);
  if (!FORCE) console.log('\n(Re-run with --force to overwrite existing values.)');
}

main();
