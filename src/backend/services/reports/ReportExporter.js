/**
 * Abstract Report Exporter Base Class
 */

class ReportExporter {
  constructor() {
    if (new.target === ReportExporter) {
      throw new Error('ReportExporter is an abstract class');
    }
  }

  /**
   * Generate report
   * @param {object} data - Export data
   * @returns {Promise<object>} { url, fileId?, ... }
   */
  async generate(data) {
    throw new Error('generate() must be implemented by subclass');
  }

  /**
   * Format KRT data for export
   * @param {Array} krtRows
   * @returns {Array}
   */
  formatKRTData(krtRows) {
    return krtRows.map(row => ({
      'RESOURCE TYPE': row['RESOURCE TYPE'] || '',
      'RESOURCE NAME': row['RESOURCE NAME'] || '',
      'SOURCE': row['SOURCE'] || '',
      'IDENTIFIER': row['IDENTIFIER'] || '',
      'NEW/REUSE': row['NEW/REUSE'] || '',
      'ADDITIONAL INFORMATION': row['ADDITIONAL INFORMATION'] || ''
    }));
  }

  /**
   * Format change history for export
   * @param {Array} changes
   * @returns {Array}
   */
  formatChanges(changes) {
    return changes.map(change => ({
      'Date': change.createdAt.toISOString(),
      'User': change.user?.name || 'Unknown',
      'Action': change.action,
      'Step': change.step || '',
      'Column': change.columnName || '',
      'Old Value': change.oldValue || '',
      'New Value': change.newValue || '',
      'Description': change.description || ''
    }));
  }

  /**
   * Format submission summary
   * @param {object} submission
   * @param {object} stats
   * @returns {object}
   */
  formatSummary(submission, stats) {
    return {
      'Manuscript ID': submission.manuscriptId,
      'Title': submission.title,
      'Team': submission.team,
      'Status': submission.status,
      'Author': submission.user?.name || 'Unknown',
      'Created': submission.createdAt.toISOString(),
      'Total Resources': stats.resourceCount,
      'Total Changes': stats.changeCount,
      'Errors Fixed': stats.errorsFixed || 0
    };
  }
}

module.exports = ReportExporter;
