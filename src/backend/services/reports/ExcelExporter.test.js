/**
 * Tests for ExcelExporter.buildWorkbook (pure, no S3).
 * Run with: node --test src/backend/services/reports/ExcelExporter.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ExcelExporter = require('./ExcelExporter');

function sampleData(overrides = {}) {
  return {
    submission: {
      id: 'sub-1',
      manuscriptId: 'WH1-000282-012-org-t-2',
      title: 'My Manuscript',
      team: 'WH',
      status: 'step_report',
      currentRound: 2,
      notes: 'some notes',
      createdAt: new Date('2026-01-01T10:00:00Z'),
      updatedAt: new Date('2026-02-01T12:30:00Z'),
      dataAvailabilityStatement: 'Data are available in the repository.',
      extractedDataAvailabilityStatement: 'Extracted statement text.',
      authors: { items: [
        { fullName: 'Jane Doe', orcid: '0000-0001-2345-6789' },
        { firstName: 'John', lastName: 'Smith', orcid: null }
      ], meta: {} },
      user: { name: 'Curator', email: 'c@example.com' }
    },
    krtRows: [
      { 'RESOURCE TYPE': 'Software/code', 'RESOURCE NAME': 'ImageJ', 'SOURCE': 'GitHub', 'IDENTIFIER': 'RRID:SCR_003070', 'NEW/REUSE': 'reuse', 'ADDITIONAL INFORMATION': 'note' },
      { 'RESOURCE TYPE': 'Dataset', 'RESOURCE NAME': 'My data', 'SOURCE': '', 'IDENTIFIER': '', 'NEW/REUSE': 'new', 'ADDITIONAL INFORMATION': '' }
    ],
    changes: [
      { createdAt: new Date('2026-01-02T09:00:00Z'), user: { name: 'Curator' }, action: 'edit', step: 'step_krt', columnName: 'SOURCE', oldValue: '', newValue: 'GitHub', description: 'set source' }
    ],
    suggestions: [
      { source: 'pdf_analysis', type: 'add_row', title: 'Add X', description: 'desc', status: 'pending' }
    ],
    ...overrides
  };
}

function findValue(sheet, label) {
  for (let r = 1; r <= sheet.rowCount; r++) {
    if (sheet.getRow(r).getCell(1).value === label) {
      return sheet.getRow(r).getCell(2).value;
    }
  }
  return undefined;
}

test('buildWorkbook: 4 sheets in order when suggestions present', () => {
  const wb = new ExcelExporter().buildWorkbook(sampleData());
  assert.deepEqual(wb.worksheets.map(s => s.name), ['Summary', 'KRT', 'Change History', 'Suggestions']);
});

test('buildWorkbook: omits Suggestions sheet when none', () => {
  const wb = new ExcelExporter().buildWorkbook(sampleData({ suggestions: null }));
  assert.deepEqual(wb.worksheets.map(s => s.name), ['Summary', 'KRT', 'Change History']);
});

test('Summary: submission metadata + KRT stats', () => {
  const wb = new ExcelExporter().buildWorkbook(sampleData());
  const summary = wb.getWorksheet('Summary');
  assert.equal(findValue(summary, 'Manuscript ID'), 'WH1-000282-012-org-t-2');
  assert.equal(findValue(summary, 'Submitted by'), 'Curator (c@example.com)');
  assert.equal(findValue(summary, 'Total resources'), 2);
  assert.equal(findValue(summary, 'New'), 1);
  assert.equal(findValue(summary, 'Reuse'), 1);
  // DAS surfaced
  assert.equal(findValue(summary, 'Provided (final)'), 'Data are available in the repository.');
  // by-type breakdown
  assert.equal(findValue(summary, 'Software/code'), 1);
  assert.equal(findValue(summary, 'Dataset'), 1);
});

test('Summary: authors listed with ORCID', () => {
  const wb = new ExcelExporter().buildWorkbook(sampleData());
  const summary = wb.getWorksheet('Summary');
  assert.equal(findValue(summary, 'Authors detected'), '2');
  assert.equal(findValue(summary, 'Author 1'), 'Jane Doe — ORCID: 0000-0001-2345-6789');
  assert.equal(findValue(summary, 'Author 2'), 'John Smith — no ORCID');
});

test('KRT sheet: header + one row per resource', () => {
  const wb = new ExcelExporter().buildWorkbook(sampleData());
  const krt = wb.getWorksheet('KRT');
  const header = krt.getRow(1).values.slice(1); // ExcelJS values are 1-indexed
  assert.deepEqual(header, ['RESOURCE TYPE', 'RESOURCE NAME', 'SOURCE', 'IDENTIFIER', 'NEW/REUSE', 'ADDITIONAL INFORMATION']);
  assert.equal(krt.rowCount, 3); // header + 2 rows
  assert.equal(krt.getRow(2).getCell(1).value, 'Software/code');
});

test('computeKrtStats: counts new/reuse/identifier/source', () => {
  const stats = new ExcelExporter().computeKrtStats(sampleData().krtRows);
  assert.equal(stats.total, 2);
  assert.equal(stats.newCount, 1);
  assert.equal(stats.reuseCount, 1);
  assert.equal(stats.withId, 1);
  assert.equal(stats.withSource, 1);
  assert.deepEqual([...stats.byType.entries()], [['Software/code', 1], ['Dataset', 1]]);
});

test('buildWorkbook: handles empty KRT / no authors / no DAS gracefully', () => {
  const wb = new ExcelExporter().buildWorkbook(sampleData({
    krtRows: [],
    changes: [],
    suggestions: null,
    submission: { ...sampleData().submission, authors: null, dataAvailabilityStatement: '', extractedDataAvailabilityStatement: '' }
  }));
  const summary = wb.getWorksheet('Summary');
  assert.equal(findValue(summary, 'Total resources'), 0);
  assert.equal(findValue(summary, 'Authors'), 'None detected');
  assert.equal(findValue(summary, 'Provided (final)'), '—');
  assert.deepEqual(wb.worksheets.map(s => s.name), ['Summary', 'KRT', 'Change History']);
});
