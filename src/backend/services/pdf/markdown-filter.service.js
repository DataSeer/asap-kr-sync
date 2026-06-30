/**
 * Markdown Filter
 *
 * A cue-aware, KEEP-BIASED reducer for converted markdown. It drops blocks that
 * are numeric data matrices (p-value / fold-change / metabolomics tables, etc.)
 * carrying no resource signal, while preserving prose and resource tables
 * (lists of datasets, materials, software). Used by the Markdown Convert step to
 * shrink pathologically large markdown — embedded supplementary data tables can
 * make a single document 5-15x larger than normal and break langextract — before
 * the text detectors (datasets / protocols / identifier / materials) read it.
 * Software still reads the PDF directly and is unaffected.
 *
 * Design — only drop content that is POSITIVELY a numeric data matrix:
 *   a block is dropped only if it is (1) numeric/symbol-dominated AND (2) carries
 *   no resource cue (identifier / repository / vendor / version / URL) AND (3) is
 *   not headed like a resource table. Any doubt → keep. So the worst case is
 *   keeping some numeric junk, never dropping a resource (no detection-recall loss).
 */

const markdownConfig = require('../../config/pdf-markdown-api');
const logger = require('../../utils/logger');

// Resource cues: a block containing ANY of these is kept regardless of how
// numeric it looks (identifiers, repositories, vendors, versions, URLs).
const RESOURCE_CUE = new RegExp([
  'RRID:', '10\\.[0-9]{4,9}/',                                    // RRID, DOI
  'GSE[0-9]+', 'GSM[0-9]+', 'SR[RXPS][0-9]+', 'PRJ[A-Z]+[0-9]+',  // GEO / SRA / BioProject
  'PXD[0-9]+', 'E-MTAB', 'SAMN[0-9]+', 'phs[0-9]+', 'EGA[A-Z][0-9]+', 'CVCL_', 'IPR[0-9]+', 'CHEMBL', // proteomics / dbGaP / EGA / cell / domain
  'Addgene', 'ATCC', 'Cat(alog)?\\.?\\s*(#|no\\.?|number)',       // catalog numbers
  'zenodo', 'figshare', 'github\\.com', 'protocols\\.io', 'dryad', 'bioR[xX]iv', 'medR[xX]iv', '/doi/', // repositories
  'Sigma', 'Abcam', 'Thermo', 'Invitrogen', 'Millipore', 'Jackson', 'Qiagen', 'Roche', 'BioLegend',
  'Santa Cruz', 'Cell Signaling', 'Bio-?Rad', 'Promega', 'Illumina',  // common vendors
  'https?://', 'www\\.',                                          // URLs
  'version\\s', '\\bv[0-9]+\\.[0-9]'                              // version strings
].join('|'), 'i');

// Resource-table header keywords: a table/block headed by these is a KRT-style
// resource table and is always kept.
const RESOURCE_HEADER = /\b(reagent|antibod|resource|source|identifier|catalog|rrid|repositor|accession|dataset|software|tool|version|vendor|supplier|strain|cell ?line|plasmid|organism|oligo|primer|construct|addgene|deposit|availab)\b/i;

/** Share of characters that are letters (≈0 for numeric matrices, ≈0.6-0.8 for prose). */
function languageRatio(text) {
  const n = text.length;
  if (!n) return 1;
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  return letters / n;
}

/** Keep-biased decision for a block of text (a line or a whole markdown table). */
function keepText(text, langRatio) {
  if (RESOURCE_CUE.test(text)) return true;                       // any resource cue → keep
  const firstNonEmpty = text.split('\n').find(l => l.trim()) || '';
  if (RESOURCE_HEADER.test(firstNonEmpty)) return true;           // resource-table header → keep
  return languageRatio(text) >= langRatio;                        // enough natural language → keep
}

/**
 * Pure filter: drop numeric data-matrix blocks, keep prose + resource tables.
 * Markdown tables (contiguous `|`-rows) are judged as a unit so a resource table
 * is never split; everything else is judged per line so a numeric value inside a
 * sentence (whole line is prose) is never removed.
 * @param {string} markdown
 * @param {{ langRatio?: number }} [opts]
 * @returns {{ markdown: string, stats: object }}
 */
function filterMarkdown(markdown, { langRatio = 0.30 } = {}) {
  const lines = String(markdown).split('\n');
  const out = [];
  const stats = { linesIn: lines.length, linesDropped: 0, tablesDropped: 0, charsBefore: String(markdown).length, charsDropped: 0 };

  let i = 0;
  while (i < lines.length) {
    // A contiguous markdown table → judged as one unit.
    if (/^\s*\|/.test(lines[i])) {
      let j = i;
      while (j < lines.length && /^\s*\|/.test(lines[j])) j++;
      const table = lines.slice(i, j);
      const text = table.join('\n');
      if (keepText(text, langRatio)) {
        out.push(...table);
      } else {
        stats.tablesDropped++;
        stats.linesDropped += table.length;
        stats.charsDropped += text.length;
      }
      i = j;
      continue;
    }
    // A single non-table line.
    const line = lines[i];
    if (line.trim() === '' || keepText(line, langRatio)) {
      out.push(line);
    } else {
      stats.linesDropped++;
      stats.charsDropped += line.length;
    }
    i++;
  }

  const result = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  stats.charsAfter = result.length;
  return { markdown: result, stats };
}

/**
 * Apply the filter subject to config gating: only when enabled AND the markdown
 * exceeds the configured size threshold. Returns the original markdown untouched
 * when not triggered.
 * @param {string} markdown
 * @returns {{ markdown: string, applied: boolean, stats: object|null }}
 */
function applyFilter(markdown) {
  const cfg = markdownConfig.filter || {};
  if (!cfg.enabled) return { markdown, applied: false, stats: null };
  if (!markdown || markdown.length < (cfg.minChars || 0)) return { markdown, applied: false, stats: null };

  const { markdown: filtered, stats } = filterMarkdown(markdown, { langRatio: cfg.langRatio });
  logger.info('Markdown filtered (dropped numeric data blocks)', {
    charsBefore: stats.charsBefore, charsAfter: stats.charsAfter,
    charsDropped: stats.charsDropped, linesDropped: stats.linesDropped, tablesDropped: stats.tablesDropped
  });
  return { markdown: filtered, applied: true, stats };
}

module.exports = { filterMarkdown, applyFilter, keepText, languageRatio };
