<script setup>
/**
 * The Availability Statement check, rule by rule.
 *
 * The rulebook is fixed and lives on the server; the model only decides whether
 * each rule applies to this submission and says why. So this shows every rule,
 * not only the ones that fired — a curator has to be able to tell "checked, and
 * your statement is fine" from "never checked".
 *
 * A rule that applies expands to a second, full-width line carrying the
 * explanation and, where the rulebook offers one, the sentence they can paste
 * into their statement.
 */
import { computed } from 'vue'
import HighlightText from '@/components/submission/HighlightText.vue'
import { useColumnResize } from '@/composables/useColumnResize'

const props = defineProps({
  /** Display rows from `buildDasRows`, already filtered by the caller. */
  rows: { type: Array, default: () => [] },
  search: { type: String, default: '' }
})

/** Shared with the other module tables, so a width dragged once is kept. */
const colResize = useColumnResize('moduleView.columnWidths')

const COLS = [
  { key: 'status', label: 'Status', width: 130 },
  { key: 'check', label: 'Check', width: 320 },
  { key: 'reason', label: 'Why', width: 520 }
]

const isEmpty = computed(() => props.rows.length === 0)

/** A detail line spans the whole table; it belongs to the row above it. */
const spanCount = COLS.length
</script>

<template>
  <div class="dst">
    <div class="mtable-frame">
      <table v-if="!isEmpty" class="mtable mtable--fixed" :style="colResize.tableStyle('das', COLS)">
        <thead>
          <tr>
            <th
              v-for="c in COLS"
              :key="c.key"
              :style="colResize.headStyle('das', c.key, c.width)"
            >
              {{ c.label }}
              <span
                class="mtable-col-resize"
                title="Drag to resize"
                @mousedown.stop.prevent="colResize.startResize('das', c.key, c.width, $event)"
              ></span>
            </th>
          </tr>
        </thead>
        <tbody>
          <template v-for="r in rows" :key="r.key">
            <tr
              v-if="!r.isDetail"
              class="mt-row"
              :class="{
                'mt-row-start': r.isGroupStart,
                'mt-row-end': r.isGroupEnd,
                'mt-row-alt': r.groupIndex % 2 === 1
              }"
            >
              <td>
                <span class="rbadge" :class="r.badge">{{ r.status }}</span>
              </td>
              <td class="dst-title">
                <HighlightText :text="r.title" :term="search" />
              </td>
              <td>
                <HighlightText :text="r.reason" :term="search" />
              </td>
            </tr>

            <tr
              v-else
              class="mt-row mt-row-span"
              :class="{ 'mt-row-end': r.isGroupEnd, 'mt-row-alt': r.groupIndex % 2 === 1 }"
            >
              <td :colspan="spanCount">
                <p v-if="r.detail" class="dst-detail">
                  <HighlightText :text="r.detail" :term="search" />
                </p>
                <!-- Verbatim, in a monospaced block: this is text to paste into
                     the statement, not prose about it. -->
                <template v-if="r.recommended">
                  <span class="dst-reclabel">Suggested wording</span>
                  <pre class="dst-recommended">{{ r.recommended }}</pre>
                </template>
              </td>
            </tr>
          </template>
        </tbody>
      </table>

      <p v-if="isEmpty" class="mtable-empty">
        No checks to show — this module has not produced a result yet.
      </p>
    </div>
  </div>
</template>

<style scoped>
.dst-title { font-weight: 600; color: #111827; }
.dst-detail { margin: 0 0 0.4rem; color: #374151; line-height: 1.5; }
.dst-reclabel {
  display: block;
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #6b7280;
  margin-bottom: 0.2rem;
}
.dst-recommended {
  margin: 0;
  padding: 0.5rem 0.6rem;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 0.35rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  line-height: 1.5;
  color: #1f2937;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
