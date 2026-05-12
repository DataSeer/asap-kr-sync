/**
 * Submission utilities
 */

const STATUS_TO_STEP = {
  draft: 1,
  step_krt: 1,
  step_pdf: 2,
  step_review: 3,
  step_as: 4,
  step_report: 5,
  completed: 5
}

/**
 * Derive the step number from a submission status
 * @param {string} status - Submission status
 * @returns {number} Step number (1-5)
 */
export function statusToStep(status) {
  return STATUS_TO_STEP[status] || 1
}
