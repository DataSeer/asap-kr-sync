/**
 * Excel Report Exporter
 */

const ExcelJS = require('exceljs');
const ReportExporter = require('./ReportExporter');
const s3Service = require('../storage/s3.service');
const { generateS3Key } = require('../../utils/helpers');
const { FILE_TYPES } = require('../../config/constants');
const logger = require('../../utils/logger');

class ExcelExporter extends ReportExporter {
  /**
   * Generate Excel report
   * @param {object} data
   * @returns {Promise<object>}
   */
  async generate(data) {
    const { submission, krtRows, changes, suggestions } = data;

    try {
      const workbook = new ExcelJS.Workbook();

      // --- Summary sheet (Property/Value rows) ---
      const summaryData = this.createSummaryData(submission, {
        resourceCount: krtRows.length,
        changeCount: changes.length
      });
      this.addJsonSheet(workbook, 'Summary', summaryData);

      // --- KRT Data sheet ---
      const krtData = this.formatKRTData(krtRows);
      const krtSheet = this.addJsonSheet(workbook, 'KRT Data', krtData);
      this.applyColumnWidths(krtSheet, [15, 30, 20, 40, 10, 30]);

      // --- Change History sheet ---
      const changeData = this.formatChanges(changes);
      this.addJsonSheet(workbook, 'Change History', changeData);

      // --- Suggestions sheet (if any) ---
      if (suggestions && suggestions.length > 0) {
        const suggestionsData = this.formatSuggestions(suggestions);
        this.addJsonSheet(workbook, 'Suggestions', suggestionsData);
      }

      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

      // Upload to S3
      const s3Key = generateS3Key(submission.manuscriptId, submission.id, submission.currentRound || 1, FILE_TYPES.REPORT, 'report.xlsx', 1);
      await s3Service.uploadFile(
        s3Key,
        buffer,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      logger.info('Excel report created', { submissionId: submission.id, s3Key });

      // Return S3 key (not direct URL) - presigned URL generated on download
      return { s3Key };
    } catch (error) {
      logger.error('Failed to create Excel report', { error: error.message });
      throw error;
    }
  }

  /**
   * Add a sheet built from an array of plain objects. Mirrors xlsx's
   * `json_to_sheet`: the first object's keys form the header row, then each
   * object becomes a data row in the same column order.
   */
  addJsonSheet(workbook, sheetName, rows) {
    const sheet = workbook.addWorksheet(sheetName);
    if (!rows || rows.length === 0) return sheet;
    const keys = Object.keys(rows[0]);
    sheet.columns = keys.map(k => ({ header: k, key: k }));
    for (const row of rows) {
      sheet.addRow(row);
    }
    return sheet;
  }

  /**
   * Create summary data for export
   */
  createSummaryData(submission, stats) {
    const summary = this.formatSummary(submission, stats);
    if (submission.currentRound && submission.currentRound > 1) {
      summary['Round'] = submission.currentRound;
    }
    return Object.entries(summary).map(([key, value]) => ({
      'Property': key,
      'Value': value
    }));
  }

  /**
   * Format suggestions for export
   * @param {Array} suggestions - Suggestion model instances
   */
  formatSuggestions(suggestions) {
    return suggestions.map((suggestion, index) => ({
      '#': index + 1,
      'Source': suggestion.source,
      'Type': suggestion.type,
      'Title': suggestion.title,
      'Description': suggestion.description,
      'Status': suggestion.status,
      'Confidence': suggestion.confidence ? `${Math.round(suggestion.confidence * 100)}%` : ''
    }));
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
}

module.exports = ExcelExporter;
