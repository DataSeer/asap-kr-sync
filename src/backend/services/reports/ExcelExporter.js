/**
 * Excel Report Exporter
 *
 * Sheet layout:
 *   1. Summary       — submission metadata, detected authors, DAS, and KRT statistics
 *   2. KRT           — the complete Key Resources Table
 *   3. Change History — audit trail of edits
 *   4. Suggestions   — outstanding AI suggestions (only when present)
 */

const ExcelJS = require('exceljs');
const ReportExporter = require('./ReportExporter');
const s3Service = require('../storage/s3.service');
const { generateS3Key } = require('../../utils/helpers');
const { FILE_TYPES } = require('../../config/constants');
const logger = require('../../utils/logger');

// Palette (ARGB)
const COLOR = {
  title: 'FF1F3864',       // dark navy
  section: 'FF2F5496',     // section-header blue
  headerText: 'FFFFFFFF',  // white
  band: 'FFF2F6FC',        // light row banding
  label: 'FFEAF0FA'        // property-label tint
};

const KRT_COLUMNS = [
  'RESOURCE TYPE', 'RESOURCE NAME', 'SOURCE', 'IDENTIFIER', 'NEW/REUSE', 'ADDITIONAL INFORMATION'
];

class ExcelExporter extends ReportExporter {
  /**
   * Generate the Excel report and upload it to S3.
   * @param {object} data - { submission, krtRows, changes, suggestions }
   * @returns {Promise<{s3Key: string}>}
   */
  async generate(data) {
    const { submission } = data;
    try {
      const workbook = this.buildWorkbook(data);
      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

      const s3Key = generateS3Key(
        submission.manuscriptId, submission.id, submission.currentRound || 1,
        FILE_TYPES.REPORT, 'report.xlsx', 1
      );
      await s3Service.uploadFile(
        s3Key, buffer,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      logger.info('Excel report created', { submissionId: submission.id, s3Key });
      return { s3Key };
    } catch (error) {
      logger.error('Failed to create Excel report', { error: error.message });
      throw error;
    }
  }

  /**
   * Build the workbook in memory (no I/O). Separated from generate() so it can
   * be unit-tested without S3.
   * @param {object} data - { submission, krtRows, changes, suggestions }
   * @returns {ExcelJS.Workbook}
   */
  buildWorkbook(data) {
    const { submission, krtRows = [], changes = [], suggestions } = data;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ASAP KR-Sync';
    workbook.created = submission.createdAt instanceof Date ? submission.createdAt : new Date(0);

    this.buildSummarySheet(workbook, submission, krtRows, changes, suggestions);
    this.buildKrtSheet(workbook, krtRows);
    this.buildChangeHistorySheet(workbook, changes);
    if (suggestions && suggestions.length > 0) {
      this.buildSuggestionsSheet(workbook, suggestions);
    }
    return workbook;
  }

  // ── Sheet 1: Summary ──────────────────────────────────────────────────

  buildSummarySheet(workbook, submission, krtRows, changes, suggestions) {
    const sheet = workbook.addWorksheet('Summary', {
      properties: { defaultColWidth: 18 }
    });
    sheet.columns = [{ width: 32 }, { width: 90 }];

    this.addTitleRow(sheet, 'ASAP KR-Sync — Submission Report');
    sheet.addRow([]);

    // -- Submission metadata --
    this.addSectionHeader(sheet, 'Submission');
    this.addKeyValueRows(sheet, [
      ['Manuscript ID', submission.manuscriptId || '—'],
      ['Title', submission.title || '—'],
      ['Team', submission.team || '—'],
      ['Status', submission.status || '—'],
      ['Submitted by', this.formatUser(submission.user)],
      ['Current round', submission.currentRound || 1],
      ['Created', this.formatDate(submission.createdAt)],
      ['Last updated', this.formatDate(submission.updatedAt)],
      ['Notes', submission.notes || '—']
    ]);
    sheet.addRow([]);

    // -- Detected authors --
    const authors = this.extractAuthors(submission);
    this.addSectionHeader(sheet, 'Detected authors');
    if (authors.length === 0) {
      this.addKeyValueRows(sheet, [['Authors', 'None detected']]);
    } else {
      const rows = [['Authors detected', String(authors.length)]];
      authors.forEach((a, i) => {
        const name = a.fullName || [a.firstName, a.lastName].filter(Boolean).join(' ') || 'Unknown';
        const orcid = a.orcid ? `ORCID: ${a.orcid}` : 'no ORCID';
        rows.push([`Author ${i + 1}`, `${name} — ${orcid}`]);
      });
      this.addKeyValueRows(sheet, rows);
    }
    sheet.addRow([]);

    // -- Data Availability Statement --
    this.addSectionHeader(sheet, 'Data Availability Statement');
    this.addKeyValueRows(sheet, [
      ['Provided (final)', submission.dataAvailabilityStatement || '—'],
      ['Extracted from manuscript (AI)', submission.extractedDataAvailabilityStatement || '—']
    ], { tallValue: true });
    sheet.addRow([]);

    // -- KRT statistics --
    const stats = this.computeKrtStats(krtRows);
    const openSuggestions = Array.isArray(suggestions) ? suggestions.length : 0;
    this.addSectionHeader(sheet, 'Key Resources Table — statistics');
    this.addKeyValueRows(sheet, [
      ['Total resources', stats.total],
      ['New', stats.newCount],
      ['Reuse', stats.reuseCount],
      ['New/Reuse unspecified', stats.total - stats.newCount - stats.reuseCount],
      ['With identifier', `${stats.withId} (${this.pct(stats.withId, stats.total)})`],
      ['Without identifier', `${stats.total - stats.withId} (${this.pct(stats.total - stats.withId, stats.total)})`],
      ['With source', `${stats.withSource} (${this.pct(stats.withSource, stats.total)})`],
      ['Changes logged', changes.length],
      ['Outstanding suggestions', openSuggestions]
    ]);
    sheet.addRow([]);

    // -- Resources by type --
    this.addSectionHeader(sheet, 'Resources by type');
    if (stats.byType.size === 0) {
      this.addKeyValueRows(sheet, [['—', 'No resources']]);
    } else {
      const rows = [...stats.byType.entries()].map(([type, count]) => [type, count]);
      this.addKeyValueRows(sheet, rows);
    }

    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    return sheet;
  }

  // ── Sheet 2: complete KRT ─────────────────────────────────────────────

  buildKrtSheet(workbook, krtRows) {
    const sheet = workbook.addWorksheet('KRT');
    sheet.columns = KRT_COLUMNS.map((header, i) => ({
      header,
      key: header,
      width: [22, 34, 26, 30, 12, 55][i]
    }));

    const rows = this.formatKRTData(krtRows);
    rows.forEach(r => sheet.addRow(r));

    this.styleHeaderRow(sheet);
    // Wrap + top-align every data cell; band alternate rows for readability.
    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      row.alignment = { wrapText: true, vertical: 'top' };
      if (r % 2 === 0) {
        row.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.band } };
        });
      }
    }
    sheet.autoFilter = { from: 'A1', to: `${this.colLetter(KRT_COLUMNS.length)}1` };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    return sheet;
  }

  // ── Sheet 3: Change History ───────────────────────────────────────────

  buildChangeHistorySheet(workbook, changes) {
    const sheet = workbook.addWorksheet('Change History');
    const data = this.formatChanges(changes);
    if (data.length === 0) {
      sheet.addRow(['No changes recorded']);
      return sheet;
    }
    const keys = Object.keys(data[0]);
    sheet.columns = keys.map(k => ({ header: k, key: k }));
    data.forEach(r => sheet.addRow(r));
    this.applyColumnWidths(sheet, [20, 18, 14, 14, 18, 28, 28, 36]);
    this.styleHeaderRow(sheet);
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    return sheet;
  }

  // ── Sheet 4: Suggestions ──────────────────────────────────────────────

  buildSuggestionsSheet(workbook, suggestions) {
    const sheet = workbook.addWorksheet('Suggestions');
    const data = this.formatSuggestions(suggestions);
    const keys = Object.keys(data[0]);
    sheet.columns = keys.map(k => ({ header: k, key: k }));
    data.forEach(r => sheet.addRow(r));
    this.applyColumnWidths(sheet, [6, 22, 18, 34, 50, 14]);
    this.styleHeaderRow(sheet);
    for (let r = 2; r <= sheet.rowCount; r++) {
      sheet.getRow(r).alignment = { wrapText: true, vertical: 'top' };
    }
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    return sheet;
  }

  /**
   * Format suggestions for export. (Drops the legacy Confidence column — the
   * diff-derived suggestions don't carry a confidence score.)
   */
  formatSuggestions(suggestions) {
    return suggestions.map((s, index) => ({
      '#': index + 1,
      'Source': s.source || '',
      'Type': s.type || '',
      'Title': s.title || '',
      'Description': s.description || '',
      'Status': s.status || ''
    }));
  }

  // ── Stats & helpers ───────────────────────────────────────────────────

  /**
   * Compute KRT statistics. byType preserves the order rows arrive in (the
   * caller pre-sorts by resource-type group), so the breakdown reads in the
   * same order as the KRT sheet.
   */
  computeKrtStats(krtRows) {
    const byType = new Map();
    let newCount = 0, reuseCount = 0, withId = 0, withSource = 0;
    for (const r of krtRows) {
      const type = (r['RESOURCE TYPE'] || 'Unspecified').trim() || 'Unspecified';
      byType.set(type, (byType.get(type) || 0) + 1);
      const nr = String(r['NEW/REUSE'] || '').toLowerCase().trim();
      if (nr === 'new') newCount++;
      else if (nr === 'reuse') reuseCount++;
      if (String(r['IDENTIFIER'] || '').trim()) withId++;
      if (String(r['SOURCE'] || '').trim()) withSource++;
    }
    return { total: krtRows.length, newCount, reuseCount, withId, withSource, byType };
  }

  extractAuthors(submission) {
    const a = submission.authors;
    if (!a) return [];
    if (Array.isArray(a)) return a;
    if (Array.isArray(a.items)) return a.items;
    return [];
  }

  formatUser(user) {
    if (!user) return 'Unknown';
    return user.email ? `${user.name || 'Unknown'} (${user.email})` : (user.name || 'Unknown');
  }

  formatDate(value) {
    if (!value) return '—';
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
  }

  pct(n, total) {
    if (!total) return '0%';
    return `${Math.round((n / total) * 100)}%`;
  }

  // ── Styling primitives ────────────────────────────────────────────────

  addTitleRow(sheet, text) {
    const row = sheet.addRow([text]);
    sheet.mergeCells(`A${row.number}:B${row.number}`);
    const cell = row.getCell(1);
    cell.font = { bold: true, size: 16, color: { argb: COLOR.headerText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.title } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    row.height = 26;
  }

  addSectionHeader(sheet, text) {
    const row = sheet.addRow([text]);
    sheet.mergeCells(`A${row.number}:B${row.number}`);
    const cell = row.getCell(1);
    cell.font = { bold: true, size: 12, color: { argb: COLOR.headerText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.section } };
    cell.alignment = { vertical: 'middle', indent: 1 };
    row.height = 20;
  }

  addKeyValueRows(sheet, pairs, { tallValue = false } = {}) {
    for (const [label, value] of pairs) {
      const row = sheet.addRow([label, value]);
      const labelCell = row.getCell(1);
      const valueCell = row.getCell(2);
      labelCell.font = { bold: true };
      labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.label } };
      labelCell.alignment = { vertical: 'top' };
      valueCell.alignment = { wrapText: true, vertical: 'top' };
      if (tallValue && typeof value === 'string' && value.length > 80) {
        row.height = Math.min(120, 15 * Math.ceil(value.length / 90));
      }
    }
  }

  styleHeaderRow(sheet) {
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: COLOR.headerText } };
    header.alignment = { vertical: 'middle', wrapText: true };
    header.height = 18;
    header.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.section } };
    });
  }

  /**
   * Apply column widths to a sheet (in characters, matching xlsx's `wch`).
   */
  applyColumnWidths(sheet, widths) {
    widths.forEach((w, idx) => {
      const col = sheet.getColumn(idx + 1);
      if (col) col.width = w;
    });
  }

  colLetter(n) {
    let s = '';
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }
}

module.exports = ExcelExporter;
