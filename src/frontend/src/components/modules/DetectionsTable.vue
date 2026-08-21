<script setup>
/**
 * The detections table — what a detector found in the manuscript.
 *
 * One table for five modules: software, datasets, materials, protocols and
 * identifiers all produce the same shape, differing only in which columns carry
 * anything. Extracted from JobStatusPanel so the page and the modal cannot
 * drift while both exist.
 *
 * Presentation only: the items arrive already merged, deduped and verified.
 */
import { computed, ref, watch } from 'vue'
import HighlightText from '@/components/submission/HighlightText.vue'
import EvidenceContext from '@/components/common/EvidenceContext.vue'
import { useColumnResize } from '@/composables/useColumnResize'

const props = defineProps({
  /** Detected items, already filtered by the caller. */
  items: { type: Array, default: () => [] },
  /** Search term to highlight. */
  search: { type: String, default: '' },
  /**
   * Which detector produced these. Only software unions two engines, so only
   * software shows the engine badges — the others would render an empty column
   * of nothing.
   */
  jobType: { type: String, default: '' }
})

/**
 * Does this item carry a sentence to show underneath it?
 *
 * Asked twice — once to decide whether the columns row is also the last row of
 * the block, once to render the sentence — so it is a function rather than the
 * same four-way condition written twice and drifting.
 */
const hasContext = (item) => !!(
  item.evidence?.quote || item.evidence?.context || item.detectorMeta?.context || item.context
)

/** Shared with the other tables so a dragged width is remembered everywhere. */
/** Shared with the other module tables, and separate from the modal's. */
const WIDTHS_KEY = 'moduleView.columnWidths'

const colResize = useColumnResize(WIDTHS_KEY)

const ALL_COLS = [
  { key: 'resourceType', label: 'Resource Type', width: 120 },
  { key: 'resourceName', label: 'Resource Name', width: 240 },
  { key: 'source', label: 'Source', width: 170 },
  { key: 'identifier', label: 'Identifier', width: 170 },
  { key: 'newReuse', label: 'New/Reuse', width: 90 },
  { key: 'evidence', label: 'Evidence', width: 170 },
  { key: 'additionalInformation', label: 'Additional Information', width: 220 }
]

/**
 * ADDITIONAL INFORMATION is an author field that no detector writes, so in a
 * detection table it is a permanently empty column. It appears only when
 * something is in it.
 */
const showAdditionalInfo = computed(() => props.items.some((it) => String(
  it?.additionalInformation || it?.additional_information || ''
).trim().length > 0))

const cols = computed(() => (showAdditionalInfo.value
  ? ALL_COLS
  : ALL_COLS.filter((c) => c.key !== 'additionalInformation')))

/**
 * Get the display name from a mention item (different field names across detection types)
 */
function getMentionName(item) {
  return item.canonical_name || item.name || item.resourceName || ''
}


/**
 * Which detection engine(s) produced an item.
 *
 * Software detection unions two engines, and after dedupe a resource found by
 * both collapses into ONE row whose contributors live in `mergedFrom`. Reading
 * only the top-level `origin` would therefore under-report agreement — which is
 * exactly the signal worth seeing.
 */
const ENGINE_LABELS = { softcite: 'Softcite', lm: 'LM' }
const ENGINE_TITLES = {
  softcite: 'Found by Softcite (name recognition over the PDF)',
  lm: 'Found by the LM pass (identifiers, repo links, custom code — over the markdown)'
}
function itemEngines(item) {
  if (props.jobType !== 'software_detection') return []
  const origins = new Set()
  const add = (origin) => {
    if (!origin) return
    if (String(origin).includes('softcite')) origins.add('softcite')
    if (String(origin).includes('software-lm')) origins.add('lm')
  }
  add(item.origin)
  for (const contributor of item.mergedFrom || []) add(contributor?.originalItem?.origin)
  return [...origins]
}


/**
 * Which merged rows are expanded. A resource found by two engines collapses to
 * one row; this opens it to show each contributor.
 */
const expandedMergedRows = ref(new Set())

// Collapse them when the visible set changes: an index that pointed at one row
// points at a different one after a filter.
watch(() => props.items, () => { expandedMergedRows.value = new Set() })

/**
 * Read the enrichment provenance off an item. After the four-step pipeline
 * refactor, this lives under `detectorMeta.enrichmentMeta`. Older persisted
 * items kept it at the top level — we accept either shape.
 */
function getEnrichmentMeta(item) {
  return item?.detectorMeta?.enrichmentMeta || item?.enrichmentMeta || null
}

/**
 * Whether a particular field on this mention was filled in from the enrichment
 * list rather than coming from the detector itself.
 */
function isFieldFromEnrichment(item, field) {
  const meta = getEnrichmentMeta(item)
  return Array.isArray(meta?.filledFields) && meta.filledFields.includes(field)
}

/**
 * Tooltip text for the "enriched" rbadge — explains which fields were filled.
 */
function enrichmentBadgeTitle(item) {
  const filled = getEnrichmentMeta(item)?.filledFields || []
  if (filled.length === 0) {
    return 'This resource is in the curated enrichment list (no missing fields to fill).'
  }
  return `Matched in the enrichment list — filled in: ${filled.join(', ')}`
}

/**
 * After the in-detector dedupe step (P3-P7), each item carries `mergedFrom`
 * — one entry per pre-dedup contribution. Items that didn't merge with
 * anything have mergedFrom.length === 1.
 */
function getMergedFromCount(item) {
  return Array.isArray(item?.mergedFrom) ? item.mergedFrom.length : 1
}

function toggleMergedRow(idx) {
  const next = new Set(expandedMergedRows.value)
  if (next.has(idx)) next.delete(idx)
  else next.add(idx)
  expandedMergedRows.value = next
}

/**
 * Best-effort one-line context for a pre-dedup contributor. Different
 * detectors expose different fields; pick the most informative one available.
 */
function getMergedFromContext(originalItem) {
  if (!originalItem) return '—'
  const meta = originalItem.detectorMeta || {}
  if (meta.context) return meta.context
  if (meta.text_excerpt) return meta.text_excerpt
  if (typeof meta.position === 'number') return `char offset ${meta.position}`
  return originalItem.additionalInformation || '—'
}

</script>

<template>
  <div class="dt-wrapper">
    <!-- The empty state used to sit INSIDE a `v-if="items.length"` root, so it
         could never render: a search matching nothing left an empty bordered box
         with no text at all, while the grounding table beside it said "No rows
         match the current filters." -->
    <p v-if="!items.length" class="mtable-empty">No rows match the current filters.</p>
    <table v-else class="mtable mtable--fixed" :style="colResize.tableStyle('mentions', cols)">
      <thead>
        <tr>
          <th
            v-for="c in cols"
            :key="c.key"
            :style="colResize.headStyle('mentions', c.key, c.width)"
          >
            {{ c.label }}
            <span class="mtable-col-resize" v-tooltip="'Drag to resize'" @mousedown.stop.prevent="colResize.startResize('mentions', c.key, c.width, $event)"></span>
          </th>
        </tr>
      </thead>
      <tbody>
        <template v-for="(item, i) in items" :key="i">
          <tr class="mt-row mt-row-start" :class="{ 'mt-row-alt': i % 2 === 1, 'mt-row-end': !hasContext(item) }">
            <td class="text-xs"><HighlightText :text="item.resourceType || item.resource_type || 'Software/code'" :query="search" /></td>
            <td class="font-medium">
              <HighlightText :text="getMentionName(item)" :query="search" />
              <!-- Under a seeded pipeline the prompt was handed the
                               author's rows and told to emit every one, so a row
                               here may be one the model copied back rather than
                               found. The evidence column says which. Absent
                               entirely when nothing was seeded. -->
              <span
                v-if="item.detectorMeta?.fromAuthorKrt"
                class="rbadge rbadge-own"
                v-tooltip="item.evidence?.verification?.status === 'verified'
                  ? 'In the author KRT, and the model located it in the manuscript.'
                  : 'In the author KRT. The model returned it, but did not locate it in the manuscript.'"
              >KRT</span>
              <!-- Which engine found this. Software runs Softcite
                               (names in prose) and an optional LM pass
                               (identifiers, repo links, custom code) unioned;
                               without this the two were indistinguishable. -->
              <span
                v-for="engine in itemEngines(item)"
                :key="engine"
                class="rbadge"
                :class="engine === 'lm' ? 'rbadge-derived' : 'rbadge-own'"
                v-tooltip="ENGINE_TITLES[engine]"
              >{{ ENGINE_LABELS[engine] }}</span>
              <span
                v-if="getEnrichmentMeta(item)?.matched"
                class="rbadge rbadge-neutral dt-badge-icon"
                v-tooltip="enrichmentBadgeTitle(item)"
              >
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
                </svg>
                enriched
              </span>
              <button
                v-if="getMergedFromCount(item) > 1"
                type="button"
                class="rbadge rbadge-neutral dt-badge-button"
                v-tooltip="`Merged from ${getMergedFromCount(item)} pre-dedup mentions — click to expand`"
                @click="toggleMergedRow(i)"
              >
                merged ×{{ getMergedFromCount(item) }}
                <span class="merged-from-chevron" :class="{ open: expandedMergedRows.has(i) }">▾</span>
              </button>
            </td>
            <td class="text-xs" :class="{ 'cell-from-enrichment': isFieldFromEnrichment(item, 'source') }" v-tooltip="isFieldFromEnrichment(item, 'source') ? 'Filled in from the enrichment list' : null"><HighlightText :text="item.source || item.suggestedURL || item.url" :query="search" /></td>
            <td class="text-xs" :class="{ 'cell-from-enrichment': isFieldFromEnrichment(item, 'identifier') }" v-tooltip="isFieldFromEnrichment(item, 'identifier') ? 'Filled in from the enrichment list' : null"><HighlightText :text="item.identifier || item.RRID || item.suggestedRRID" :query="search" /></td>
            <td :class="{ 'cell-from-enrichment': isFieldFromEnrichment(item, 'newReuse') }" v-tooltip="isFieldFromEnrichment(item, 'newReuse') ? 'Filled in from the enrichment list' : null">
              <span v-if="item.newReuse">{{ item.newReuse }}</span>
              <span v-else>—</span>
            </td>
            <!-- Evidence: WHERE in the manuscript this came from.
                             The section path is the compact form; the full
                             passage is on the context line below. -->
            <td class="text-xs">
              <!-- A sentence rather than a bare path: the column held things
                   like "Methods > Immunostaining" with no indication of what
                   that was, or where it came from. -->
              <span v-if="item.evidence?.section" class="evidence-section-cell" v-tooltip="item.evidence.section">
                Found in the <strong>{{ item.evidence.section }}</strong> section of the manuscript
              </span>
              <!-- Context counts as located too: an "embellished" row has no
                   quote of its own but does have the paragraph the resource
                   appears in, and printing a bare dash next to the caveat rbadge
                   said nothing. -->
              <span v-else-if="item.evidence?.quote || item.evidence?.context" class="text-gray-400">
                Found in the manuscript — the section it sits in could not be determined
              </span>
              <span v-else class="text-gray-300">—</span>
              <span
                v-if="item.evidence?.match === 'partial'"
                class="rbadge rbadge-warning"
                v-tooltip="'Only the leading part of the quote was located in the manuscript'"
              >partial</span>
              <!-- The model's quote is not in the manuscript, but
                               the resource is. The paragraph below shows where
                               it appears; the sentence the model wrote is not
                               highlighted because it was never found. -->
              <span
                v-else-if="item.evidence?.verification?.status === 'embellished'"
                class="rbadge rbadge-warning"
                v-tooltip="'The resource is in the manuscript, but the sentence the model quoted is not verbatim. The paragraph below is where the resource actually appears.'"
              >not verbatim</span>
            </td>
            <td v-if="showAdditionalInfo" class="text-xs text-gray-500"><HighlightText :text="item.additionalInformation || item.additional_information" :query="search" /></td>
          </tr>
          <!-- Context line: full-width, one per item. Collapsed to
                           the sentence, expandable to the paragraph. Falls back
                           to the detector's raw context string for results
                           produced before evidence grounding existed. -->
          <!-- `quote` alone is the wrong gate. An EMBELLISHED item —
                           the model's quote did not verify, but the resource IS
                           in the manuscript — deliberately carries an empty
                           quote so an unverified claim never occupies the
                           located-text field. It still has the paragraph where
                           the resource appears, and that is worth more to a
                           curator than a blank row. -->
          <tr v-if="hasContext(item)" class="mt-row mt-row-span mt-row-end" :class="{ 'mt-row-alt': i % 2 === 1 }">
            <td :colspan="cols.length">
              <EvidenceContext v-if="item.evidence?.quote || item.evidence?.context" :evidence="item.evidence" :show-section="false" />
              <template v-else>{{ item.detectorMeta?.context || item.context }}</template>
            </td>
          </tr>
          <tr
            v-if="expandedMergedRows.has(i) && getMergedFromCount(item) > 1"
            class="mt-row mt-row-span mt-row-end merged-from-row"
            :class="{ 'mt-row-alt': i % 2 === 1 }"
          >
            <td :colspan="cols.length">
              <div class="merged-from-title">Merged from {{ getMergedFromCount(item) }} pre-dedup mentions:</div>
              <table class="merged-from-table">
                <thead>
                  <tr>
                    <th>Resource Name</th>
                    <th>Confidence</th>
                    <th>Identifier</th>
                    <th>Context / Position</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(contrib, j) in item.mergedFrom" :key="j">
                    <td>{{ contrib.originalItem?.resourceName || contrib.originalItem?.name || '—' }}</td>
                    <td>{{ typeof contrib.confidence === 'number' ? contrib.confidence.toFixed(2) : '—' }}</td>
                    <td class="text-xs">{{ contrib.originalItem?.identifier || '—' }}</td>
                    <td class="text-xs text-gray-500">{{ getMergedFromContext(contrib.originalItem) }}</td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
  <!-- Enrichment summary note. The "already in KRT" judgment now
                   lives solely in the AI Suggestions section, which is fed by
                   pdf_analysis's diff against the user's KRT. -->
</template>

<style scoped>
/* NOT min-width: max-content. That sizes the wrapper to the widest the content
   could ever be — with a paragraph in a cell, thousands of pixels — so the
   table overflowed its frame and every column but the first was pushed out of
   view. The table sets its own width (100% until a column is dragged); the
   wrapper only needs to let the frame scroll when it exceeds that. */
.dt-wrapper { min-width: 0; }
/* Borders, spacing and the row-block rules come from
   assets/styles/module-tables.css. */
.dt-badge-icon { display: inline-flex; align-items: center; gap: 0.2rem; }
.dt-badge-button { cursor: pointer; font-family: inherit; }
/* The sentence wraps rather than truncating — it is a statement about where a
   row came from, and half of it says nothing. (Its only styling used to live in
   JobStatusPanel's SCOPED block, so on a module page it had none.) */
/* Two more classes styled only in JobStatusPanel's SCOPED block, so on a module
   page the enrichment marker was invisible and the chevron never turned. Same
   bug as .evidence-section-cell below — missed twice. */
.cell-from-enrichment {
  background: #f0fdf4;
  box-shadow: inset 2px 0 0 #86efac;
}
.merged-from-chevron {
  display: inline-block;
  margin-left: 0.15rem;
  transition: transform 0.12s ease;
}
.merged-from-chevron.open { transform: rotate(180deg); }

.evidence-section-cell { line-height: 1.4; }
.evidence-section-cell strong { font-weight: 600; color: #374151; }

/* The evidence caveats keep their lower-case wording — "not verbatim" reads as
   a phrase, not a label — while taking the shared warning colour. */
.rbadge-warning { text-transform: none; }
</style>
