/**
 * Shared helper: read the dataset rows from an author-provided Key Resources
 * Table file (the demo's base `<id>.xlsx` / `<id>.csv`, not the `-DS1.xlsx`
 * report). Used by the comparison runner as the preferred author-KRT seed
 * source — when no author KRT file exists, the caller falls back to the DS
 * report instead.
 *
 * A KRT has the standard columns: RESOURCE TYPE · RESOURCE NAME · SOURCE ·
 * IDENTIFIER · NEW/REUSE · ADDITIONAL INFORMATION. We keep only the rows the
 * curator typed as a dataset.
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { cellText, norm } = require('./report-datasets');

/** Author KRT file for a manuscript id (xlsx preferred, then csv). */
function findAuthorKrtFile(dir, doc) {
  for (const name of [`${doc}.xlsx`, `${doc}.csv`]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// A workbook may hold a template "KRT Example" sheet alongside the real KRT;
// pick the first KRT-shaped sheet that is not an example.
function pickKrtSheet(wb) {
  const hasKrtHeader = (ws) => {
    for (let r = 1; r <= Math.min(4, ws.rowCount); r++) {
      for (let c = 1; c <= ws.columnCount; c++) {
        if (norm(cellText(ws.getCell(r, c).value)) === 'resource name') return true;
      }
    }
    return false;
  };
  const candidates = wb.worksheets.filter(hasKrtHeader);
  return candidates.find((ws) => !norm(ws.name).includes('example')) || candidates[0] || null;
}

function findHeaderRow(ws) {
  for (let r = 1; r <= Math.min(6, ws.rowCount); r++) {
    const labels = [];
    for (let c = 1; c <= ws.columnCount; c++) labels[c] = norm(cellText(ws.getCell(r, c).value));
    if (labels.includes('resource name') && labels.includes('resource type')) return { row: r, labels };
  }
  return null;
}

function datasetRowsFromSheet(ws) {
  const hdr = findHeaderRow(ws);
  if (!hdr) return [];
  const col = (name) => hdr.labels.findIndex((v) => v === name);
  const idx = {
    type: col('resource type'),
    name: col('resource name'),
    source: col('source'),
    identifier: col('identifier'),
    newReuse: col('new/reuse'),
    addInfo: col('additional information')
  };
  const rows = [];
  for (let r = hdr.row + 1; r <= ws.rowCount; r++) {
    const get = (c) => (c > 0 ? cellText(ws.getCell(r, c).value).trim() : '');
    const name = get(idx.name);
    if (!name) continue;
    if (norm(get(idx.type)) !== 'dataset') continue; // keep only curator-typed datasets
    rows.push({
      resourceType: 'Dataset',
      resourceName: name,
      source: get(idx.source),
      identifier: get(idx.identifier),
      newReuse: get(idx.newReuse),
      additionalInformation: get(idx.addInfo)
    });
  }
  return rows;
}

/**
 * Load the author KRT's dataset rows for a manuscript.
 * @param {string} dir
 * @param {string} doc - manuscript id
 * @returns {Promise<object[]|null>} dataset rows (possibly empty) if an author
 *   KRT file exists, or null when there is no author KRT file at all.
 */
async function loadAuthorKrtDatasets(dir, doc) {
  const file = findAuthorKrtFile(dir, doc);
  if (!file) return null;
  const wb = new ExcelJS.Workbook();
  const isCsv = file.toLowerCase().endsWith('.csv');
  if (isCsv) {
    await wb.csv.readFile(file);
  } else {
    await wb.xlsx.readFile(file);
  }
  const ws = isCsv ? wb.worksheets[0] : pickKrtSheet(wb);
  if (!ws) return [];
  return datasetRowsFromSheet(ws);
}

module.exports = { loadAuthorKrtDatasets, findAuthorKrtFile };
