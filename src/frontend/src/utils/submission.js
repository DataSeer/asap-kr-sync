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

/**
 * Base name (no extension) for a downloaded KRT file.
 *
 * `KRT_<manuscript id>` when the submission has one — the id is what the
 * ASAP team files things under, and the report already carries it, so a
 * downloaded table named `krt_b2bea012-19f7-…` next to it was a puzzle (ASAP
 * feedback, 2026-09). Falls back to the title, then to the submission id.
 * Optional `round` adds `_v<round>` so two rounds of the same manuscript
 * do not collide in a Downloads folder.
 *
 * @param {object|null} submission - { manuscriptId?, title?, id? }
 * @param {{ round?: number|null }} [opts]
 * @returns {string}
 */
export function krtFileBaseName(submission, { round = null } = {}) {
  const pick = (value) => {
    const safe = String(value || '').trim().replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100)
    return safe || null
  }
  const manuscript = pick(submission?.manuscriptId)
  const title = pick(submission?.title)
  const base = manuscript ? `KRT_${manuscript}` : (title || `krt_${submission?.id || 'export'}`)
  return round ? `${base}_v${round}` : base
}
