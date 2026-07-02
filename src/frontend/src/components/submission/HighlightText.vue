<script setup>
import { computed } from 'vue'

// Renders a cell value with occurrences of the active search term wrapped in
// <mark>. Unlike a v-html approach, the matched runs are produced as real DOM
// text nodes / elements, so LM-provided values can never inject markup — this
// is XSS-safe by construction (and passes vue/no-v-html).
const props = defineProps({
  // The value to display. Accepts strings, numbers, or nullish (renders '—').
  text: { type: [String, Number], default: '' },
  // Current search term; empty means no highlighting.
  query: { type: String, default: '' }
})

// Empty values render the em-dash placeholder the tables already use.
const display = computed(() => {
  const value = props.text
  return (value === null || value === undefined || value === '') ? '—' : String(value)
})

// Split the text into alternating non-match / match segments (case-insensitive)
// so each match can be a <mark> without touching innerHTML.
const segments = computed(() => {
  const text = display.value
  const needle = (props.query || '').trim().toLowerCase()
  if (!needle) return [{ text, match: false }]
  const haystack = text.toLowerCase()
  const parts = []
  let cursor = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    if (idx > cursor) parts.push({ text: text.slice(cursor, idx), match: false })
    parts.push({ text: text.slice(idx, idx + needle.length), match: true })
    cursor = idx + needle.length
    idx = haystack.indexOf(needle, cursor)
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false })
  return parts
})
</script>

<template>
  <span>
    <template v-for="(seg, i) in segments" :key="i">
      <mark v-if="seg.match" class="search-hl">{{ seg.text }}</mark>
      <span v-else>{{ seg.text }}</span>
    </template>
  </span>
</template>

<style scoped>
.search-hl {
  background: #fde68a;
  color: inherit;
  border-radius: 0.125rem;
  padding: 0 0.0625rem;
}
</style>
