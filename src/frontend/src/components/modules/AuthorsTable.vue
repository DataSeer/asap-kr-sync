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

const colResize = useColumnResize('jobModal.columnWidths')

/** Which pass supplied the ORCID — colour-coded so a weaker source is visible. */
function sourceClass(source) {
  if (source === 'grobid+openalex' || source === 'openalex') return 'at-src-enriched'
  if (source === 'grobid') return 'at-src-grobid'
  if (source === 'orcid_api') return 'at-src-api'
  return 'at-src-plain'
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
            <span v-if="item.source" class="at-badge" :class="sourceClass(item.source)">
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
.at-badge {
  display: inline-block; padding: 0.0625rem 0.375rem;
  border-radius: 9999px; font-size: 0.6875rem; font-weight: 500;
}
.at-src-enriched { background: #dbeafe; color: #1d4ed8; }
.at-src-grobid { background: #fef3c7; color: #92400e; }
.at-src-api { background: #e0e7ff; color: #3730a3; }
.at-src-plain { background: #f3f4f6; color: #6b7280; }
.at-orcid { color: #2563eb; text-decoration: none; font-family: monospace; font-size: 0.75rem; }
.at-orcid:hover { text-decoration: underline; }
.at-empty { padding: 1.5rem; text-align: center; color: #9ca3af; font-size: 0.85rem; }
</style>
