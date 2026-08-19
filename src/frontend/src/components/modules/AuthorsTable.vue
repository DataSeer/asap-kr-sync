<script setup>
/**
 * The authors table — who wrote the manuscript, and their ORCIDs.
 *
 * Extracted from the modal unchanged; ORCID extraction produces a flat list
 * with no grouping, expansion or evidence, so there is nothing else to it.
 */
import HighlightText from '@/components/submission/HighlightText.vue'
import { useColumnResize } from '@/composables/useColumnResize'

defineProps({
  authors: { type: Array, default: () => [] },
  search: { type: String, default: '' }
})

/** Shared with the other module tables, and separate from the modal's. */
const WIDTHS_KEY = 'moduleView.columnWidths'

const colResize = useColumnResize(WIDTHS_KEY)

/**
 * Which pass supplied the ORCID.
 *
 * The same distinction the rest of the app draws: GROBID read it off the paper,
 * everything else looked it up somewhere the paper does not say. These used to
 * be blue and amber, which now mean Datasets and Lab materials.
 */
function sourceClass(source) {
  return source === 'grobid' ? 'badge-own' : 'badge-derived'
}

function formatOrcidSource(source) {
  const labels = {
    'grobid+openalex': 'GROBID + OpenAlex',
    openalex: 'OpenAlex',
    grobid: 'GROBID',
    orcid_api: 'ORCID API'
  }
  return labels[source] || source
}

const COLS = [
  { key: 'name', label: 'Name', width: 200 },
  { key: 'orcid', label: 'ORCID', width: 170 },
  { key: 'affiliation', label: 'Affiliation', width: 280 },
  { key: 'source', label: 'Source', width: 130 }
]
</script>

<template>
  <div class="at-wrapper">
    <table class="at-table at-table--resizable" :style="colResize.tableStyle('authors', COLS)">
      <thead>
        <tr>
          <th
            v-for="c in COLS"
            :key="c.key"
            :style="colResize.headStyle('authors', c.key, c.width)"
          >
            {{ c.label }}
            <span class="at-col-resize" title="Drag to resize" @mousedown.stop.prevent="colResize.startResize('authors', c.key, c.width, $event)"></span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(item, i) in authors" :key="i">
          <td><HighlightText :text="item.fullName || [item.firstName, item.lastName].filter(Boolean).join(' ')" :query="search" /></td>
          <td>
            <a v-if="item.orcid" :href="'https://orcid.org/' + item.orcid" target="_blank" rel="noopener" class="at-orcid"><HighlightText :text="item.orcid" :query="search" /></a>
            <span v-else>—</span>
          </td>
          <td><HighlightText :text="item.affiliation" :query="search" /></td>
          <td>
            <span v-if="item.source" class="badge" :class="sourceClass(item.source)">
              {{ formatOrcidSource(item.source) }}
            </span>
            <span v-else>—</span>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="!authors.length" class="at-empty">No authors found.</p>
  </div>
</template>

<style scoped>
.at-wrapper { min-width: 0; }
.at-table { width: 100%; font-size: 0.8rem; }
.at-table--resizable { table-layout: fixed; }
.at-table td { overflow-wrap: anywhere; word-break: break-word; }
.at-table th {
  position: sticky; top: 0; z-index: 1;
  background: #f9fafb; text-align: left; font-weight: 600; color: #6b7280;
  text-transform: uppercase; font-size: 0.68rem; letter-spacing: 0.03em;
  padding: 0.5rem 0.6rem; border-bottom: 1px solid #e5e7eb; white-space: nowrap;
  position: relative;
}
.at-table td { padding: 0.5rem 0.6rem; vertical-align: top; border-bottom: 1px solid #f3f4f6; }
.at-col-resize {
  position: absolute; top: 0; right: -3px; width: 7px; height: 100%;
  cursor: col-resize; user-select: none;
}
.at-col-resize:hover { background: #bfdbfe; }
.at-orcid { color: #2563eb; text-decoration: none; font-family: monospace; font-size: 0.75rem; }
.at-orcid:hover { text-decoration: underline; }
.at-empty { padding: 1.5rem; text-align: center; color: #9ca3af; font-size: 0.85rem; }
</style>
