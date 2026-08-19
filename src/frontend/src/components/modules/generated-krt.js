/**
 * The Generated KRT, flattened for display.
 *
 * PDF Analysis merges every detection into one row per resource, keeping a
 * `detectedBy[]` entry for each module that contributed. Showing only the merged
 * row hides the disagreement — two modules can name the same resource
 * differently, and which name won is exactly what a curator wants to see. So
 * each merged item becomes a GROUP of rows, one per contributor, carrying its
 * own module's values.
 *
 * Kept out of the component because the page needs the same grouping to count
 * rows per tab, and two copies of this would drift.
 */

/**
 * Which module a contributing detection came from, in the words on screen.
 *
 * `author_krt` is not a detector: it marks a row carried over from the author's
 * own table because nothing re-found it in the PDF. That is the most important
 * badge on the table — it says "we did not confirm this" — so it must not fall
 * through to the raw key.
 */
export const SOURCE_LABELS = {
  software_detection: 'Software',
  datasets_detection: 'Datasets',
  materials_detection: 'Materials',
  protocols_detection: 'Protocols',
  identifier_detection: 'ID',
  author_krt: 'Author KRT',
  // Steps rather than detectors, but they appear as sources on a suggestion —
  // without a label they printed as the raw job type.
  krt_grounding: 'Grounding',
  pdf_analysis: 'Consolidation'
}

export const sourceLabel = (source) => SOURCE_LABELS[source] || source

/**
 * The badge class for a contributing source.
 *
 * A detector takes the colour of what it finds, so a "Materials" badge matches
 * a Lab Materials row wherever both appear. Identifier detection spans every
 * category and the author's own table is not a finding at all, so neither
 * borrows a category colour.
 */
const SOURCE_BADGES = {
  software_detection: 'badge-software',
  datasets_detection: 'badge-datasets',
  materials_detection: 'badge-materials',
  protocols_detection: 'badge-protocols',
  identifier_detection: 'badge-neutral',
  krt_grounding: 'badge-neutral',
  pdf_analysis: 'badge-neutral',
  author_krt: 'badge-own'
}

export const sourceBadge = (source) => SOURCE_BADGES[source] || 'badge-neutral'

/**
 * Display-side scrub of internal references that leak into LM reasons —
 * candidate "ref" numbers and raw KRT row UUIDs. Applied at render time so
 * already-saved results read cleanly too.
 */
export function cleanReason(reason) {
  if (!reason) return ''
  return String(reason)
    .replace(/\(?\s*\brefs?\b\s*#?\s*\d+(\s*(?:,|and|&|\/)\s*#?\s*\d+)*\s*\)?/gi, '')
    .replace(/\(\s*(?:row\s+)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*\)/gi, '')
    .replace(/\brow\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'the matching author row')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/^[\s,;:–-]+|[\s,;:–-]+$/g, '')
    .trim()
}

/**
 * Flatten merged KRT items into contributor rows.
 *
 * Rows for one group are emitted consecutively and carry `isGroupStart` /
 * `isGroupEnd`, so the table can draw the group as one block without needing
 * to look ahead.
 *
 * @param {Array} items merged items from `pdf_analysis`
 * @returns {Array} one row per contributing detection (or one row for a merged
 *   item that records no contributor at all)
 */
export function buildKrtRows(items) {
  const rows = []
  let groupIndex = 0
  for (const merged of items || []) {
    const contributors = merged.detectedBy || []
    const isDuplicate = contributors.length > 1
    const groupSize = Math.max(contributors.length, 1)
    const base = {
      reason: cleanReason(merged.reason),
      dedupKey: merged.dedupKey,
      groupIndex,
      groupNumber: groupIndex + 1,
      finalName: merged.resourceName || '',
      groupSize
    }
    if (contributors.length === 0) {
      rows.push({
        ...base,
        source: null,
        resourceType: merged.resourceType || '',
        resourceName: merged.resourceName || '',
        identifier: merged.identifier || '',
        sourceUrl: merged.sourceUrl || '',
        newReuse: (merged.newReuse || '').toLowerCase(),
        additionalInformation: merged.additionalInformation || '',
        isDuplicate: false,
        groupSize: 1,
        isGroupStart: true,
        isGroupEnd: true
      })
      groupIndex++
      continue
    }
    contributors.forEach((c, j) => {
      // Each module writes its own field names; the merged item is the
      // fallback, so a module that contributed nothing to a field still shows
      // the value the row ended up with rather than a blank.
      const orig = c.originalItem || {}
      const d = orig.data || orig
      rows.push({
        ...base,
        source: c.source,
        resourceType: d.resourceType || d.resource_type || merged.resourceType || '',
        resourceName: d.canonical_name || d.resourceName || d.resource_name || d.name || merged.resourceName || '',
        identifier: d.identifier || d.RRID || d.suggestedRRID || merged.identifier || '',
        sourceUrl: d.source || d.url || d.suggestedURL || merged.sourceUrl || '',
        newReuse: String(d.newReuse || d.new_reuse || merged.newReuse || '').toLowerCase(),
        additionalInformation: d.additionalInformation || d.additional_information || merged.additionalInformation || '',
        isDuplicate,
        isGroupStart: j === 0,
        isGroupEnd: j === contributors.length - 1
      })
    })
    groupIndex++
  }
  return rows
}
