/**
 * Report Service
 * Coordinates report generation
 */

const { Report, Submission, KRTData, ChangeLog } = require('../../models');
const suggestionService = require('../suggestion/suggestion.service');
const ExcelExporter = require('./ExcelExporter');
const { REPORT_TYPES, getResourceTypeGroupOrder } = require('../../config/constants');
const { ValidationError } = require('../../utils/errors');
const logger = require('../../utils/logger');

/**
 * Generate report for submission
 * @param {string} submissionId
 * @param {string} type - Report type (excel, pdf)
 * @param {string} userId
 * @returns {Promise<object>} Report record
 */
async function generateReport(submissionId, type, userId, round) {
  // Get submission data
  const submission = await Submission.findByPk(submissionId, {
    include: ['user']
  });

  // Get KRT data (filtered by round)
  const krtWhere = { submissionId };
  if (round !== undefined) krtWhere.round = round;
  const krtData = await KRTData.findAll({
    where: krtWhere,
    order: [['createdAt', 'ASC']]
  });

  // Get change history (filtered by round)
  const changeWhere = { submissionId };
  if (round !== undefined) changeWhere.round = round;
  const changes = await ChangeLog.findAll({
    where: changeWhere,
    order: [['createdAt', 'ASC']],
    include: ['user']
  });

  // Get suggestions — derived live from the Generated KRT diff.
  const { suggestions } = await suggestionService.getAllSuggestions(submissionId, round);

  // Sort KRT data by resource type group order, then by resource name A-Z
  const groupOrder = await getResourceTypeGroupOrder();
  krtData.sort((a, b) => {
    const groupA = groupOrder[a.resourceType] ?? 99;
    const groupB = groupOrder[b.resourceType] ?? 99;
    if (groupA !== groupB) return groupA - groupB;
    return (a.resourceName || '').localeCompare(b.resourceName || '');
  });

  // Prepare data for export
  const exportData = {
    submission,
    krtRows: krtData.map(row => row.toKRTRow()),
    changes,
    suggestions: suggestions.length > 0 ? suggestions : null
  };

  let result;

  switch (type) {
    case REPORT_TYPES.EXCEL:
      result = await generateExcelReport(exportData);
      break;
    default:
      throw new ValidationError(`Unsupported report type: ${type}`);
  }

  // Save report record
  // Store S3 key in fileUrl (presigned URL generated on download)
  const report = await Report.create({
    submissionId,
    type,
    fileUrl: result.s3Key || result.url,
    round: round || 1,
    metadata: {
      generatedBy: userId,
      rowCount: krtData.length,
      changeCount: changes.length
    }
  });

  logger.info('Report generated', {
    submissionId,
    reportId: report.id,
    type
  });

  return report;
}

/**
 * Generate Excel report
 */
async function generateExcelReport(data) {
  const exporter = new ExcelExporter();
  return exporter.generate(data);
}

/**
 * Get all reports for submission
 * @param {string} submissionId
 * @returns {Promise<Array>}
 */
async function getReports(submissionId) {
  return Report.findAll({
    where: { submissionId },
    order: [['createdAt', 'DESC']]
  });
}

module.exports = {
  generateReport,
  getReports
};
