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

/**
 * The last row of a decision. The rows carry `isGroupStart` but not its
 * counterpart, and a block needs to know where it ends to close itself.
 */
const isGroupEnd = (i) => i === props.rows.length - 1
  || props.rows[i + 1]?.groupIndex !== props.rows[i].groupIndex

const isEmpty = computed(() => props.rows.length === 0)
</script>

<template>
  <div class="st">
    <div class="mtable-frame">
      <table v-if="!isEmpty" class="mtable mtable--fixed" :style="colResize.tableStyle('suggestions', COLS)">
        <thead>
          <tr>
            <th
              v-for="c in COLS"
              :key="c.key"
              :style="colResize.headStyle('suggestions', c.key, c.width)"
            >
              {{ c.label }}
              <span
                class="mtable-col-resize"
                v-tooltip="'Drag to resize'"
                @mousedown.stop.prevent="colResize.startResize('suggestions', c.key, c.width, $event)"
              ></span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(r, i) in rows"
            :key="i"
            class="mt-row"
            :class="{
              'mt-row-start': r.isGroupStart,
              'mt-row-end': isGroupEnd(i),
              'mt-row-alt': r.groupIndex % 2 === 1
            }"
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
                class="rbadge"
                :class="r.side === 'author' ? 'rbadge-own' : 'rbadge-derived'"
              >{{ fromLabel(r) }}</span>
            </td>
            <td
              v-for="c in ROW_COLUMNS"
              :key="c.key"
              class="st-xs"
              :class="{ 'st-name': c.key === 'resourceName' }"
            >
              <HighlightText
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
                  class="rbadge"
                  :class="sourceBadge(src)"
                  v-tooltip="sourceTitle(src)"
                >{{ sourceLabel(src) }}</span>
                <span v-if="!detectedBy(r.decision).length">—</span>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="mtable-empty">No rows match the current filters.</p>
    </div>
  </div>
</template>

<style scoped>
.st { min-width: 0; }
/* Borders, spacing and the row-block rules come from
   assets/styles/module-tables.css. */
.st-xs { font-size: 0.76rem; }
.st-name { font-weight: 500; }
.st-reason { font-size: 0.74rem; color: #6b7280; }
.st-decision {
  display: inline-block; padding: 0.05rem 0.4rem; border-radius: 0.25rem;
  font-size: 0.68rem; font-weight: 600; text-transform: uppercase;
}
.st-d-add { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
.st-d-update { background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; }
.st-d-remove { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
.st-d-skip { background: #f3f4f6; color: #6b7280; border: 1px solid #e5e7eb; }
.st-d-unreviewed { background: #fffbeb; color: #b45309; border: 1px solid #fde68a; }
/* Colours and spacing come from assets/styles/badges.css. */
/* The two sides of a change, marked rather than merged into a diff string:
   the author's value is what exists, the generated one is what is proposed. */
.st-diff-old :deep(*), .st-diff-old { color: #b91c1c; text-decoration: line-through; }
.st-diff-new :deep(*), .st-diff-new { color: #047857; font-weight: 600; }
</style>
