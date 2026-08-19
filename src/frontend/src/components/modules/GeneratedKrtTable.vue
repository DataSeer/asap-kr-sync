<script setup>
/**
 * The Generated KRT — every detection, grouped into the row it became.
 *
 * The grouping is the point. A merged row shows one name, one identifier, one
 * source; this shows what each contributing module actually said, so a curator
 * can see WHY the merged row reads the way it does and spot the case where two
 * modules disagreed and the wrong one won.
 *
 * Below it, the candidates that did NOT make it in, with the reason each was
 * dropped — the half of consolidation that is otherwise invisible.
 */
import { computed, ref } from 'vue'
import Papa from 'papaparse'
import HighlightText from '@/components/submission/HighlightText.vue'
import SearchInput from '@/components/common/SearchInput.vue'
import { useColumnResize } from '@/composables/useColumnResize'
import { sourceLabel, sourceBadge, groupBadge, cleanReason } from '@/components/modules/generated-krt'
import { useResourceTypesStore } from '@/stores/resourceTypes.store'

const props = defineProps({
  /** Contributor rows, already filtered and carrying `displayParity`. */
  rows: { type: Array, default: () => [] },
  /** Every contributor row, unfiltered — what the exports write. */
  allRows: { type: Array, default: () => [] },
  /** The merged items themselves, for the JSON export. */
  items: { type: Array, default: () => [] },
  /** Candidates consolidation rejected, with a reason each. */
  dropped: { type: Array, default: () => [] },
  search: { type: String, default: '' }
})

/**
 * Column widths for the module PAGES, stored apart from the modal's.
 *
 * They looked like the same tables but are not: the modal's Generated KRT
 * calls its second column `detection` where this one calls it `detectedBy`,
 * and sharing a namespace meant one dragged width in the modal flipped this
 * table out of proportional layout while leaving that column at its default —
 * which is exactly the "weird widths" that were reported.
 */
const WIDTHS_KEY = 'moduleView.columnWidths'

const colResize = useColumnResize(WIDTHS_KEY)

/**
 * The category the merged row ended up in, so its rbadge can say which of the
 * disagreeing candidates won — in that category's own colour.
 */
const resourceTypesStore = useResourceTypesStore()
const typeBadge = (resourceType) => groupBadge(resourceTypesStore.getTabGroup(resourceType || ''))

// Defaults chosen to fit a 1440px screen without a horizontal scrollbar; every
// one of them is draggable, and the width a user sets is remembered.
const ALL_COLS = [
  { key: 'krtNum', label: 'KRT #', width: 80 },
  { key: 'detectedBy', label: 'Detected by', width: 100 },
  { key: 'reason', label: 'Reason', width: 200 },
  { key: 'resourceType', label: 'Resource Type', width: 110 },
  { key: 'resourceName', label: 'Detected Name', width: 190 },
  { key: 'source', label: 'Source', width: 130 },
  { key: 'identifier', label: 'Identifier', width: 140 },
  { key: 'newReuse', label: 'New/Reuse', width: 80 },
  { key: 'additionalInformation', label: 'Additional Information', width: 170 }
]

/**
 * The Generated KRT carries the author's rows through reconciliation, so this
 * column is populated whenever the submission has a KRT — and empty, and
 * hidden, when it does not.
 */
const showAdditionalInfo = computed(() => props.allRows.some(
  (r) => String(r?.additionalInformation || '').trim().length > 0
))

/**
 * The contributor rows only.
 *
 * A merged block carries a "kept" row that is the outcome rather than a
 * detection, so counting it would inflate "N detections" and add a sourceless
 * line to the export.
 */
const detectionRows = computed(() => props.allRows.filter((r) => !r.isResult))
const cols = computed(() => (showAdditionalInfo.value
  ? ALL_COLS
  : ALL_COLS.filter((c) => c.key !== 'additionalInformation')))

const DROPPED_COLS = [
  { key: 'detectedBy', label: 'Detected by', width: 120 },
  { key: 'resourceType', label: 'Resource Type', width: 120 },
  { key: 'resourceName', label: 'Resource Name', width: 220 },
  { key: 'identifier', label: 'Identifier', width: 160 },
  { key: 'reason', label: 'Reason dropped', width: 260 }
]

/**
 * What a badge means, spelled out on hover: the label alone reads as a
 * category ("Materials") when it is actually a module that ran.
 */
const SOURCE_TITLES = {
  author_krt: 'Carried from your KRT — no detector found this in the manuscript'
}
const sourceTitle = (source) => SOURCE_TITLES[source]
  || `Found by the ${sourceLabel(source)} detection module`

/** How many KRT rows were built from more than one module. */
const mergedGroups = computed(() => props.allRows.filter(
  (r) => r.isResult
).length)

/**
 * The dropped list has its own search, not the page's.
 *
 * It answers a different question — "why is X not in my KRT?" — and is often
 * the longer of the two tables. Sharing the page's box would mean filtering the
 * KRT to nothing to look something up down here.
 */
const droppedSearch = ref('')
const visibleDropped = computed(() => {
  const q = droppedSearch.value.trim().toLowerCase()
  if (!q) return props.dropped
  return props.dropped.filter((d) => [
    d.resourceType, d.resourceName, d.identifier, cleanReason(d.reason),
    ...(d.sources || []).map(sourceLabel)
  ].some((v) => String(v ?? '').toLowerCase().includes(q)))
})

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function downloadCsv() {
  if (!detectionRows.value.length) return
  const csvData = detectionRows.value.map((r) => ({
    // Rows sharing "KRT Row" are the SAME final row — one line per module that
    // found it. "Final KRT Name" is what the row carries; "Detected Name" is
    // what that module produced.
    'KRT Row': r.groupNumber,
    'Detections in Row': r.groupSize,
    'Detection Source': r.source ? sourceLabel(r.source) : '',
    'Resource Type': r.resourceType,
    'Detected Name': r.resourceName,
    'Final KRT Name': r.finalName,
    Source: r.sourceUrl,
    Identifier: r.identifier,
    'New/Reuse': r.newReuse,
    'Additional Information': r.additionalInformation,
    'Dedup Key': r.dedupKey || ''
  }))
  // Neutralize spreadsheet formula triggers: these cells derive from LM
  // analysis of an author-uploaded manuscript, so a value like =HYPERLINK(...)
  // must not execute when a curator opens the export in Excel.
  const guarded = csvData.map((row) => Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
    ])
  ))
  // BOM prefix so Excel opens UTF-8 cleanly without mangling accented chars.
  const blob = new Blob(['﻿', Papa.unparse(guarded)], { type: 'text/csv;charset=utf-8;' })
  triggerBlobDownload(blob, 'pdf-analysis-generated-krt.csv')
}

function downloadJson() {
  if (!props.items.length) return
  const blob = new Blob([JSON.stringify(props.items, null, 2)], { type: 'application/json;charset=utf-8;' })
  triggerBlobDownload(blob, 'pdf-analysis-generated-krt.json')
}
</script>

<template>
  <div class="gk">
    <div v-if="allRows.length" class="gk-header">
      <div class="gk-summary">
        <div>
          <strong>{{ items.length }}</strong> KRT row{{ items.length === 1 ? '' : 's' }}
          consolidated from <strong>{{ detectionRows.length }}</strong>
          detection{{ detectionRows.length === 1 ? '' : 's' }}<span v-if="mergedGroups > 0">
            — {{ mergedGroups }} merged from multiple modules</span>
        </div>
        <div class="gk-summary-hint">
          Rows sharing a <strong>KRT&nbsp;#</strong> are the <em>same</em> KRT row — one line per
          detection module that found it.
        </div>
      </div>
      <div class="gk-actions">
        <button type="button" class="gk-btn" @click="downloadCsv">Download CSV</button>
        <button type="button" class="gk-btn" @click="downloadJson">Download JSON</button>
      </div>
    </div>

    <div v-if="allRows.length" class="mtable-frame gk-frame-main">
      <table class="mtable mtable--fixed" :style="colResize.tableStyle('pdfAnalysis', cols)">
        <thead>
          <tr>
            <th
              v-for="c in cols"
              :key="c.key"
              :style="colResize.headStyle('pdfAnalysis', c.key, c.width)"
            >
              {{ c.label }}
              <span
                class="mtable-col-resize"
                title="Drag to resize"
                @mousedown.stop.prevent="colResize.startResize('pdfAnalysis', c.key, c.width, $event)"
              ></span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, i) in rows"
            :key="i"
            class="mt-row"
            :class="{
              'mt-row-start': row.isGroupStart,
              'mt-row-end': row.isGroupEnd,
              'mt-row-alt': row.displayParity === 1,
              'gk-result': row.isResult
            }"
          >
            <!-- The row number appears once per group so a merged group reads
                 as one block rather than as repeated identical lines. -->
            <td class="gk-krtnum-cell">
              <template v-if="row.isGroupStart">
                <div class="gk-krtnum">#{{ row.groupNumber }}</div>
                <div
                  v-if="row.groupSize > 1"
                  class="gk-merge-label"
                  :title="'Merged into one KRT row: ' + (row.finalName || '') + ' (dedup key: ' + (row.dedupKey || '?') + ')'"
                >
                  {{ row.groupSize }} detections → 1 row
                </div>
              </template>
            </td>
            <td>
              <!-- The kept row has no detector of its own: it IS the merge. -->
              <span
                v-if="row.isResult"
                class="rbadge"
                :class="typeBadge(row.resourceType)"
                :title="`The row that went into the Generated KRT, as ${row.resourceType || 'an untyped resource'}. `
                  + 'The lines below are the detections it was built from — where they disagree, this is what was kept.'"
              >merged</span>
              <span
                v-else-if="row.source"
                class="rbadge"
                :class="sourceBadge(row.source)"
                :title="sourceTitle(row.source)"
              >{{ sourceLabel(row.source) }}</span>
              <span v-else>—</span>
            </td>
            <td class="gk-reason"><HighlightText v-if="row.isGroupStart" :text="row.reason" :query="search" /></td>
            <td class="gk-xs"><HighlightText :text="row.resourceType" :query="search" /></td>
            <td class="gk-name"><HighlightText :text="row.resourceName" :query="search" /></td>
            <td class="gk-xs"><HighlightText :text="row.sourceUrl" :query="search" /></td>
            <td class="gk-xs"><HighlightText :text="row.identifier" :query="search" /></td>
            <td>
              <!-- Plain text: see assets/styles/badges.css — a badge here
                   competed with the category colour beside it. -->
              <span v-if="row.newReuse">{{ row.newReuse }}</span>
              <span v-else>—</span>
            </td>
            <td v-if="showAdditionalInfo" class="gk-xs gk-muted">
              <HighlightText :text="row.additionalInformation" :query="search" />
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!rows.length" class="mtable-empty">No rows match the current filters.</p>
    </div>
    <p v-else class="mtable-empty">
      No detections were consolidated yet. Run the upstream detections first.
    </p>

    <!-- Dropped candidates: detections consolidation did not keep. -->
    <section v-if="dropped.length" class="gk-dropped">
      <h3 class="gk-dropped-title">
        Dropped candidates
        <span class="gk-dropped-count">{{ dropped.length }}</span>
      </h3>
      <div class="gk-dropped-bar">
        <p class="gk-dropped-hint">
          These detections were not kept in the Generated KRT — with the reason for each.
        </p>
        <SearchInput v-model="droppedSearch" placeholder="Search dropped…" class="gk-dropped-search" />
      </div>
      <div class="mtable-frame gk-frame-dropped">
        <table class="mtable mtable--fixed" :style="colResize.tableStyle('dropped', DROPPED_COLS)">
          <thead>
            <tr>
              <th
                v-for="c in DROPPED_COLS"
                :key="c.key"
                :style="colResize.headStyle('dropped', c.key, c.width)"
              >
                {{ c.label }}
                <span
                  class="mtable-col-resize"
                  title="Drag to resize"
                  @mousedown.stop.prevent="colResize.startResize('dropped', c.key, c.width, $event)"
                ></span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(d, i) in visibleDropped"
              :key="i"
              class="mt-row mt-row-start mt-row-end"
              :class="{ 'mt-row-alt': i % 2 === 1 }"
            >
              <td>
                <span
                  v-for="s in (d.sources || [])"
                  :key="s"
                  class="rbadge"
                  :class="sourceBadge(s)"
                  :title="sourceTitle(s)"
                >{{ sourceLabel(s) }}</span>
                <span v-if="!d.sources || !d.sources.length">—</span>
              </td>
              <td class="gk-xs"><HighlightText :text="d.resourceType" :query="droppedSearch" /></td>
              <td class="gk-name"><HighlightText :text="d.resourceName" :query="droppedSearch" /></td>
              <td class="gk-xs"><HighlightText :text="d.identifier" :query="droppedSearch" /></td>
              <td class="gk-reason"><HighlightText :text="cleanReason(d.reason)" :query="droppedSearch" /></td>
            </tr>
          </tbody>
        </table>
        <p v-if="!visibleDropped.length" class="mtable-empty">No dropped candidate matches that.</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.gk { min-width: 0; }
.gk-header {
  display: flex; align-items: flex-start; gap: 1rem; flex-wrap: wrap;
  margin-bottom: 0.6rem;
}
.gk-summary { font-size: 0.8rem; color: #374151; flex: 1 1 20rem; }
.gk-summary-hint { font-size: 0.72rem; color: #6b7280; margin-top: 0.15rem; }
.gk-actions { display: flex; gap: 0.4rem; margin-left: auto; }
.gk-btn {
  height: 1.85rem; padding: 0 0.65rem; border-radius: 0.375rem;
  border: 1px solid #e5e7eb; background: #fff; font-size: 0.78rem;
  color: #374151; cursor: pointer;
}
.gk-btn:hover { border-color: #bfdbfe; color: #1d4ed8; }
/* max-height, not height: with three rows a fixed-height frame is mostly empty
   box, and with three hundred it still has to stop somewhere. */
/* Table borders, spacing and the row-block rules come from
   assets/styles/module-tables.css. */
.gk-frame-main { max-height: min(60vh, 40rem); }
.gk-frame-dropped { max-height: min(40vh, 24rem); }
.gk-xs { font-size: 0.76rem; }
.gk-muted { color: #6b7280; }
.gk-name { font-weight: 500; }
.gk-reason { font-size: 0.74rem; color: #6b7280; }
.gk-krtnum { font-weight: 600; color: #374151; font-size: 0.76rem; }
.gk-merge-label { font-size: 0.66rem; color: #1d4ed8; margin-top: 0.1rem; }
/* The kept row is the answer; the detections under it are the working. */
.gk-result > td { font-weight: 600; color: #111827; }
.gk-result > td.gk-reason { font-weight: 400; }
.gk-dropped { margin-top: 1.25rem; }
.gk-dropped-title {
  display: flex; align-items: center; gap: 0.4rem;
  font-size: 0.85rem; font-weight: 600; color: #111827; margin: 0 0 0.2rem;
}
.gk-dropped-count {
  padding: 0 0.35rem; border-radius: 0.25rem; font-size: 0.7rem;
  background: #f3f4f6; color: #6b7280; border: 1px solid #e5e7eb;
}
.gk-dropped-bar {
  display: flex; align-items: center; gap: 0.75rem;
  flex-wrap: wrap; margin-bottom: 0.5rem;
}
.gk-dropped-hint { font-size: 0.75rem; color: #6b7280; margin: 0; flex: 1 1 20rem; }
.gk-dropped-search { margin-left: auto; flex: 0 1 18rem; min-width: 11rem; }
.gk-dropped-search :deep(input) {
  height: 1.85rem; font-size: 0.78rem; padding-top: 0; padding-bottom: 0;
}
</style>
