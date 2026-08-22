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

test('buildWorkbook: every sheet, in order, when suggestions are present', () => {
  const wb = new ExcelExporter().buildWorkbook(sampleData());
  assert.deepEqual(wb.worksheets.map(s => s.name),
    ['Summary', 'KRT', 'Change History', 'Pipeline', 'Suggestions']);
});

test('buildWorkbook: omits Suggestions sheet when none', () => {
  const wb = new ExcelExporter().buildWorkbook(sampleData({ suggestions: null }));
  assert.deepEqual(wb.worksheets.map(s => s.name), ['Summary', 'KRT', 'Change History', 'Pipeline']);
});

test('Pipeline: says what each step did, and who carried on past it', () => {
  // Every other sheet is the OUTPUT. A report built without software detection
  // looks exactly like one where software detection found nothing, and this is
  // the only place the difference is written down.
  const wb = new ExcelExporter().buildWorkbook(sampleData({
    pipeline: [
      { jobType: 'markdown_convert', outcome: 'Completed', runCount: 1, durationMs: 2400 },
      {
        jobType: 'software_detection',
        outcome: 'Failed',
        detail: 'Softcite timed out',
        decidedBy: 'Nicolas',
        decidedAt: '2026-08-22T12:00:00.000Z'
      },
      {
        jobType: 'datasets_detection',
        outcome: 'Skipped',
        detail: 'needed markdown_convert, which produced nothing'
      }
    ]
  }));
  const sheet = wb.getWorksheet('Pipeline');
  // getSheetValues() is 1-indexed and its [1] is the header row.
  const rows = sheet.getSheetValues().slice(2).map((r) => r.slice(1));

  assert.deepEqual(rows[0].slice(0, 2), ['Markdown Convert', 'Completed']);
  assert.equal(rows[1][1], 'Failed');
  assert.equal(rows[1][3], 'Nicolas', 'the decision is attributed');
  assert.equal(rows[2][1], 'Skipped');
  assert.match(rows[2][2], /produced nothing/);
});

test('Pipeline: acronyms are spelt the way the app spells them', () => {
  // Title-casing alone produced "Das Extraction", "Krt Grounding", "Pdf
  // Analysis" and "Orcid Extraction" — four of the twelve steps misspelt in a
  // document that goes to reviewers.
  const exporter = new ExcelExporter();

  assert.equal(exporter.humanJobType('das_extraction'), 'DAS Extraction');
  assert.equal(exporter.humanJobType('krt_grounding'), 'KRT Grounding');
  assert.equal(exporter.humanJobType('pdf_analysis'), 'PDF Analysis');
  assert.equal(exporter.humanJobType('orcid_extraction'), 'ORCID Extraction');
  assert.equal(exporter.humanJobType('software_detection'), 'Software Detection');
});

test('Pipeline: says so rather than showing a blank sheet', () => {
  const wb = new ExcelExporter().buildWorkbook(sampleData({ pipeline: [] }));

  assert.equal(wb.getWorksheet('Pipeline').getCell('A1').value, 'No pipeline record for this round');
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
  // Pipeline is always present, even with nothing to say — "no record" is
  // itself a fact about the round, and a missing sheet reads as an oversight.
  assert.deepEqual(wb.worksheets.map(s => s.name), ['Summary', 'KRT', 'Change History', 'Pipeline']);
});
