/**
 * Shared helper: read the dataset rows from a DataSeer report's "Datasets" tab.
 *
 * Used by both the comparison runner (as the author-KRT seed source for the v3
 * lane) and the workbook builder (as the reference "Datasets from Reports"
 * column). The tab has repeated action-required sections, each re-printing the
 * column header; we re-read the column map at each header and collect the
 * numbered data rows under it.
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    return String(
      v.text || v.result || v.hyperlink ||
      (Array.isArray(v.richText) ? v.richText.map((t) => t.text).join('') : '') || ''
    );
  }
  return String(v);
}

function norm(s) {
  return String(s || '').replace(/﻿/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Locate the DataSeer report file for a manuscript id. */
function findReportFile(reportsDir, doc) {
  for (const name of [`${doc}-DS1.xlsx`, `${doc}.xlsx`]) {
    const p = path.join(reportsDir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Extract dataset rows from a report's "Datasets" tab. Each row carries both a
 * KRT-shaped view (resourceName/source/identifier/newReuse/additionalInformation,
 * with URL + DOI/Identifier "warrant" columns merged into the identifier) and a
 * `raw` view of the verbatim tab columns.
 * @param {string} reportsDir
 * @param {string} doc - manuscript id
 * @returns {Promise<object[]>}
 */
async function loadReportDatasets(reportsDir, doc) {
  const file = findReportFile(reportsDir, doc);
  if (!file) return [];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet('Datasets');
  if (!ws) return [];

  const out = [];
  const seen = new Set();
  let map = null;
  for (let r = 1; r <= ws.rowCount; r++) {
    const get = (c) => (c > 0 ? cellText(ws.getCell(r, c).value).trim() : '');
    const labels = [];
    for (let c = 1; c <= ws.columnCount; c++) labels[c] = norm(ws.getCell(r, c).value && cellText(ws.getCell(r, c).value));

    if (labels.some((v) => v === 'dataset name')) {
      const find = (pred) => labels.findIndex(pred);
      map = {
        idx: find((v) => v === '#'),
        name: find((v) => v === 'dataset name'),
        reuse: find((v) => v === 're-use' || v === 'reuse'),
        qc: find((v) => v === 'qc'),
        rep: find((v) => v === 'rep'),
        issue: find((v) => v === 'issue'),
        sentence: find((v) => /sentence/.test(v)),
        url: find((v) => v === 'url'),
        doi: find((v) => /doi|identifier/.test(v)),
        notes: find((v) => v === 'notes'),
        assocFig: find((v) => /associated figure/.test(v)),
        readme: find((v) => v === 'readme'),
        datatype: find((v) => v === 'datatype')
      };
      continue;
    }
    if (!map) continue;

    const idxVal = get(map.idx);
    const name = get(map.name);
    if (!/^\d+$/.test(idxVal) || !name) continue;
    const k = norm(name);
    if (seen.has(k)) continue;
    seen.add(k);

    const url = get(map.url);
    const doi = get(map.doi);
    const notes = get(map.notes);
    const reUse = get(map.reuse);
    out.push({
      resourceType: 'Dataset',
      resourceName: name,
      source: '',
      identifier: [url, doi].filter(Boolean).join('; '), // warrant columns merged
      newReuse: /true|reuse|yes/i.test(reUse) ? 'reuse' : 'new',
      additionalInformation: notes,
      raw: {
        datasetName: name,
        reUse,
        qc: get(map.qc),
        rep: get(map.rep),
        issue: get(map.issue),
        sentence: get(map.sentence),
        url,
        doi,
        notes,
        associatedFigure: get(map.assocFig),
        readme: get(map.readme),
        datatype: get(map.datatype)
      }
    });
  }
  return out;
}

module.exports = { loadReportDatasets, findReportFile, cellText, norm };
