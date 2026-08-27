/**
 * Author KRT seeds — shared helper for detectors that want to ground the LM in
 * the rows the author already curated (the "Section 0" pattern first built for
 * datasets detection). Protocols (C5) and Lab Materials (D) reuse it.
 *
 * The author's KRT rows for a given resource group are mapped to authoritative
 * seed records the detection prompt treats as the base of its output, so the LM
 * enriches/adds instead of re-deriving (less noise, better recall).
 *
 * Pure functions + one thin DB loader. No prompt text lives here.
 */

const ACCESSION_PREFIX_RE = /^(PRJ|GSE|PXD|SRR|SRP|SRX|EGA|EGAS|EGAD|PDB|EMD|phs|GCA|GCF|E-|SAM)/i;

/**
 * Split a free-text KRT identifier cell into accessions / DOIs / URLs. Never
 * invents identifiers — only classifies what is present.
 * @param {string} text
 * @returns {{ accessions: string[], dois: string[], urls: string[] }}
 */
function splitKrtIdentifiers(text) {
  const accessions = [];
  const dois = [];
  const urls = [];
  if (!text) return { accessions, dois, urls };

  for (const token of String(text).split(/[\s;,]+/)) {
    const t = token.trim().replace(/^[.,;]+|[.,;]+$/g, '');
    if (!t) continue;
    const low = t.toLowerCase();
    if (low.startsWith('http://') || low.startsWith('https://') || low.startsWith('www.')) {
      urls.push(t);
    } else if (low.startsWith('10.') || low.includes('doi.org') || low.startsWith('doi:')) {
      dois.push(t.replace(/^doi:/i, '').trim());
    } else if (ACCESSION_PREFIX_RE.test(t) && /\d/.test(t)) {
      // Require a digit so bare words like "PDB" or "EGA" are not treated as accessions.
      accessions.push(t);
    }
  }
  return { accessions, dois, urls };
}

/**
 * Map author KRT rows (already filtered to one resource group) into the
 * authoritative seed shape consumed by the detection prompts. Trusts the
 * curator's values; rows without a resource name are dropped.
 * @param {object[]} krtRows - { resourceName, source, identifier, newReuse, additionalInformation }
 * @returns {object[]}
 */
function buildAuthorSeeds(krtRows) {
  if (!Array.isArray(krtRows)) return [];
  return krtRows
    .map((row) => {
      const name = (row.resourceName || '').trim();
      if (!name) return null;
      const ids = splitKrtIdentifiers(row.identifier);
      // URLs sometimes live in the additional-information cell too.
      const extraUrls = splitKrtIdentifiers(row.additionalInformation).urls;
      const urls = [...new Set([...ids.urls, ...extraUrls])];
      const reuse = String(row.newReuse || '').toLowerCase().startsWith('reuse');
      return {
        name,
        role: reuse ? 'REUSED' : 'GENERATED',
        source: row.source || '',
        accessions: ids.accessions,
        dois: ids.dois,
        urls,
        additional_info: row.additionalInformation || ''
      };
    })
    .filter(Boolean);
}

/**
 * Load author KRT seeds for a submission/round, filtered to one resource group
 * (0=dataset, 1=software, 2=protocol, 3=lab_material). Returns [] when the
 * submission has no KRT, so detection runs article-only exactly as before.
 * Reads the round's FROZEN table, not the live one. Each detector seeds itself
 * when it runs, and the author can edit their table between two of them — the
 * editor is one click away and the workflow invites it. Before this, detections
 * from the same run could be seeded from two different tables, and the
 * consolidation that reconciled them read a third.
 *
 * @param {string} submissionId
 * @param {number} round
 * @param {number} groupNumber
 * @param {object} [options]
 * @param {string} [options.jobType] - the detector asking, recorded if it is
 *   the first read of the round
 * @returns {Promise<object[]>}
 */
async function loadAuthorSeeds(submissionId, round, groupNumber, { jobType = null } = {}) {
  const inputFreeze = require('../queue/input-freeze.service');
  const { getResourceTypeGroupOrder } = require('../../config/constants');
  const rows = await inputFreeze.resolveKrtRows(submissionId, round, { jobType });
  if (rows.length === 0) return [];
  const groupOrder = await getResourceTypeGroupOrder();
  const groupRows = rows.filter((row) => groupOrder[row.resourceType] === groupNumber);
  return buildAuthorSeeds(groupRows);
}

module.exports = {
  splitKrtIdentifiers,
  buildAuthorSeeds,
  loadAuthorSeeds
};
