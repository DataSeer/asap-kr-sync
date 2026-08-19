<script setup>
/**
 * The AI Suggestions decision log — every add / update / remove / skip the
 * comparison produced, with the rows it concerns.
 *
 * A decision is only readable next to its subject, so each one expands to the
 * author's row and, when something would change, the generated row underneath
 * it with the differing fields marked. Two lines, one decision.
 *
 * This is the log, not the review queue — nothing here applies a change.
 */
import { computed } from 'vue'
import HighlightText from '@/components/submission/HighlightText.vue'
import { useColumnResize } from '@/composables/useColumnResize'
import { cleanReason, sourceLabel, sourceBadge } from '@/components/modules/generated-krt'

const props = defineProps({
  /** Display rows, already filtered and grouped by the caller. */
  rows: { type: Array, default: () => [] },
  search: { type: String, default: '' }
})

/** Shared with the other module tables, and separate from the modal's. */
const WIDTHS_KEY = 'moduleView.columnWidths'

const colResize = useColumnResize(WIDTHS_KEY)

/** The KRT columns shown for each decision (the concerned row). */
const ROW_COLUMNS = [
  { key: 'resourceType', label: 'Resource Type' },
  { key: 'resourceName', label: 'Resource Name' },
  { key: 'source', label: 'Source' },
  { key: 'identifier', label: 'Identifier' },
  { key: 'newReuse', label: 'New/Reuse' }
]

// Sized to fit a 1440px screen; each column is draggable from its right edge.
const COLS = [
  { key: 'decision', label: 'Decision', width: 90 },
  { key: 'reason', label: 'Reason', width: 210 },
  // "From" rather than "Item": the cell says which side of the comparison this
  // line is, and both answers are a source, not a kind of thing.
  { key: 'from', label: 'From', width: 80 },
  ...ROW_COLUMNS.map((c) => ({
    key: c.key,
    label: c.label,
    width: c.key === 'resourceName' ? 190 : (c.key === 'newReuse' ? 80 : 135)
  })),
  { key: 'detectedBy', label: 'Detected by', width: 130 }
]

/**
 * Which modules backed a decision, in the same words and the same badges the
 * Generated KRT uses. They were "SW, DS, MAT" here and "Software, Datasets,
 * Materials" there — the same fact, written two ways, on two pages a curator
 * reads side by side.
 */
const detectedBy = (d) => (d.sources || [])

/** Grounding and consolidation are steps, not detectors; say so on hover. */
const SOURCE_TITLES = {
  krt_grounding: 'KRT Grounding — reconciled this row against the manuscript',
  pdf_analysis: 'PDF Analysis — consolidated this row into the Generated KRT'
}
const sourceTitle = (source) => SOURCE_TITLES[source]
  || `Found by the ${sourceLabel(source)} detection module`

/**
 * Which side this line came from. "Generated" named the table it sits in; what
 * a reader wants to know is who proposed it — them, or the model.
 */
const fromLabel = (row) => (row.side === 'author' ? 'Author' : 'LM')

const isEmpty = computed(() => props.rows.length === 0)
</script>

<template>
  <div class="st">
    <div class="st-frame">
      <table v-if="!isEmpty" class="st-table st-table--resizable" :style="colResize.tableStyle('suggestions', COLS)">
        <thead>
          <tr>
            <th
              v-for="c in COLS"
              :key="c.key"
              :style="colResize.headStyle('suggestions', c.key, c.width)"
            >
              {{ c.label }}
              <span
                class="st-col-resize"
                title="Drag to resize"
                @mousedown.stop.prevent="colResize.startResize('suggestions', c.key, c.width, $event)"
              ></span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(r, i) in rows"
            :key="i"
            :class="[r.groupIndex % 2 === 0 ? 'st-group-even' : 'st-group-odd', { 'st-group-start': r.isGroupStart }]"
          >
            <!-- Decision, reason and modules belong to the decision, not to
                 either row, so they are printed once at the top of the group. -->
            <td>
              <span v-if="r.isGroupStart" class="st-decision" :class="'st-d-' + r.decisionLabel.toLowerCase()">
                {{ r.decisionLabel }}
              </span>
            </td>
            <td class="st-reason">
              <HighlightText
                v-if="r.isGroupStart"
                :text="cleanReason(r.decision.reason || r.decision.description)"
                :query="search"
              />
            </td>
            <td class="st-xs">
              <span
                v-if="r.role"
                class="badge"
                :class="r.side === 'author' ? 'badge-own' : 'badge-derived'"
              >{{ fromLabel(r) }}</span>
            </td>
            <td
              v-for="c in ROW_COLUMNS"
              :key="c.key"
              class="st-xs"
              :class="{ 'st-name': c.key === 'resourceName' }"
            >
              <!-- NEW/REUSE is a value with two states everywhere else in the
                   app, so it carries the same two colours here. A changed one
                   still takes the diff styling, which is why the badge is inside
                   the same branch rather than replacing it. -->
              <span
                v-if="c.key === 'newReuse' && r.cells && r.cells[c.key]"
                class="badge"
                :class="[
                  String(r.cells[c.key]).toLowerCase() === 'new' ? 'badge-new' : 'badge-reuse',
                  (r.changes && r.changes[c.key]) ? (r.side === 'author' ? 'st-diff-old' : 'st-diff-new') : ''
                ]"
              >{{ r.cells[c.key] }}</span>
              <HighlightText
                v-else
                :class="(r.changes && r.changes[c.key]) ? (r.side === 'author' ? 'st-diff-old' : 'st-diff-new') : ''"
                :text="r.cells && r.cells[c.key]"
                :query="search"
              />
            </td>
            <td class="st-xs">
              <template v-if="r.isGroupStart">
                <span
                  v-for="src in detectedBy(r.decision)"
                  :key="src"
                  class="badge st-badge-gap"
                  :class="sourceBadge(src)"
                  :title="sourceTitle(src)"
                >{{ sourceLabel(src) }}</span>
                <span v-if="!detectedBy(r.decision).length">—</span>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="st-empty">No rows match the current filters.</p>
    </div>
  </div>
</template>

<style scoped>
.st { min-width: 0; }
.st-frame {
  max-height: min(60vh, 40rem); overflow: auto;
  border: 1px solid #e5e7eb; border-radius: 0.5rem; background: #fff;
}
.st-table { width: 100%; font-size: 0.8rem; }
.st-table--resizable { table-layout: fixed; }
.st-table th {
  position: sticky; top: 0; z-index: 1;
  background: #f9fafb; text-align: left; font-weight: 600; color: #6b7280;
  text-transform: uppercase; font-size: 0.68rem; letter-spacing: 0.03em;
  padding: 0.5rem 0.6rem; border-bottom: 1px solid #e5e7eb; white-space: nowrap;
}
.st-table td {
  padding: 0.45rem 0.6rem; vertical-align: top;
  overflow-wrap: anywhere; word-break: break-word;
}
.st-col-resize {
  position: absolute; top: 0; right: -3px; width: 7px; height: 100%;
  cursor: col-resize; user-select: none;
}
.st-col-resize:hover { background: #bfdbfe; }
.st-xs { font-size: 0.76rem; }
.st-name { font-weight: 500; }
.st-reason { font-size: 0.74rem; color: #6b7280; }
/* Shading by decision, so the author/generated pair reads as one unit. */
.st-group-even td { background: #fff; }
.st-group-odd td { background: #fafafa; }
.st-group-start td { border-top: 1px solid #e5e7eb; }
.st-decision {
  display: inline-block; padding: 0.05rem 0.4rem; border-radius: 0.25rem;
  font-size: 0.68rem; font-weight: 600; text-transform: uppercase;
}
.st-d-add { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
.st-d-update { background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; }
.st-d-remove { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
.st-d-skip { background: #f3f4f6; color: #6b7280; border: 1px solid #e5e7eb; }
.st-d-unreviewed { background: #fffbeb; color: #b45309; border: 1px solid #fde68a; }
/* Colours come from assets/styles/badges.css. */
.st-badge-gap { margin-right: 0.25rem; }
/* The two sides of a change, marked rather than merged into a diff string:
   the author's value is what exists, the generated one is what is proposed. */
.st-diff-old :deep(*), .st-diff-old { color: #b91c1c; text-decoration: line-through; }
.st-diff-new :deep(*), .st-diff-new { color: #047857; font-weight: 600; }
.st-empty { padding: 1.5rem; text-align: center; color: #9ca3af; font-size: 0.85rem; }
</style>
