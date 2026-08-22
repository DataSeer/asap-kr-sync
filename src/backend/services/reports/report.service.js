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
/**
 * Every step of this round, in the order it runs, with what became of it.
 *
 * Reads the job rows rather than the run history: the question a report answers
 * is "what is this result built on", which is the CURRENT state of each step —
 * the history of how it got there belongs to the module pages.
 *
 * @param {string} submissionId
 * @param {number} round
 * @returns {Promise<object[]>}
 */
async function describePipelineForReport(submissionId, round) {
  const orchestrator = require('../queue/orchestrator.service');
  const { SubmissionJob, User } = require('../../models');

  const jobs = await SubmissionJob.getForSubmission(submissionId, round);
  const byType = new Map(jobs.map((j) => [j.jobType, j]));

  const deciderIds = [...new Set(jobs.map((j) => j.issueAcknowledgedByUserId).filter(Boolean))];
  const deciders = deciderIds.length
    ? await User.findAll({ where: { id: deciderIds }, attributes: ['id', 'name'], raw: true })
    : [];
  const nameById = new Map(deciders.map((u) => [u.id, u.name]));

  // PIPELINE order, so the sheet reads the way the manuscript flows.
  return orchestrator.PIPELINE.map((step) => {
    const job = byType.get(step.jobType);
    if (!job) return { jobType: step.jobType, outcome: 'Not run' };

    const outcomeState = job.result?.service?.outcome?.state || null;
    const skipped = job.result?.skipped || null;

    return {
      jobType: step.jobType,
      status: job.status,
      outcomeState,
      /** The one-line verdict a reader needs, in words rather than enum values. */
      outcome: describeOutcome(job, outcomeState, skipped),
      detail: skipped
        ? `needed ${skipped.missing.join(', ')}, which produced nothing`
        : (job.errorMessage || job.result?.service?.outcome?.externalError || null),
      /** Present only when somebody chose to carry on despite an issue. */
      decidedBy: job.issueAcknowledgedAt ? (nameById.get(job.issueAcknowledgedByUserId) || 'a user who has since been removed') : null,
      decidedAt: job.issueAcknowledgedAt || null,
      runCount: job.runCount || (job.status === 'complete' ? 1 : 0),
      durationMs: job.startedAt && job.completedAt
        ? new Date(job.completedAt) - new Date(job.startedAt)
        : null,
      totalTokens: job.result?.tokens?.totalTokens || null
    };
  });
}

/** The verdict, in words. */
function describeOutcome(job, outcomeState, skipped) {
  if (skipped) return 'Skipped';
  switch (job.status) {
    case 'complete':
      if (outcomeState === 'partial') return 'Completed, incomplete';
      if (outcomeState === 'fail') return 'Completed, produced nothing usable';
      return 'Completed';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    case 'skipped': return 'Skipped';
    case 'waiting': return 'Never ran — still waiting';
    case 'pending_input': return 'Never ran — waiting for you';
    default: return 'Still running';
  }
}

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

  // What the pipeline actually did, and what anyone decided about it.
  //
  // A report built without software detection looks exactly like one where
  // software detection found nothing. Every other sheet here shows the OUTPUT;
  // this one is the only place a reader can find out how it came to be — which
  // steps ran, which produced nothing, which were skipped and why, and who
  // chose to carry on.
  const pipeline = await describePipelineForReport(submissionId, round || submission.currentRound || 1);

  // Prepare data for export
  const exportData = {
    submission,
    krtRows: krtData.map(row => row.toKRTRow()),
    changes,
    suggestions: suggestions.length > 0 ? suggestions : null,
    pipeline
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
  // Exported for the same reason the KRT formatters are: the Pipeline sheet is
  // the only record of HOW a result was reached, and it should be checkable
  // without generating a report and writing to S3 to see it.
  describePipelineForReport,
  generateReport,
  getReports
};
