<script setup>
/**
 * What candidate curation corrected, and why.
 *
 * A detector proposes a row; a handful of certain rules retype or remove it
 * before anything is merged (see `pdf-analysis/curate-candidates.service.js`).
 * Those corrections are the reason a resource the manuscript clearly mentions
 * can be absent from the suggestions — or present under a type the detector
 * did not choose. Without this panel that is invisible, and the honest answer
 * to "why isn't X here?" lives only in a job's JSON.
 *
 * Collapsed by default: it explains an absence, so it should not compete with
 * the results themselves. The count stays visible so a run with an unusual
 * number of corrections is noticeable at a glance.
 */
import { computed, ref } from 'vue'

const props = defineProps({
  /** Curation actions: { rule, outcome, from, to, resourceName, identifier, detail, origin, jobType } */
  actions: { type: Array, default: () => [] },
  /** Heading; the module pages and Step 2 want different framing. Not named
   *  `title` on purpose: a native title attribute is banned app-wide, and a
   *  prop of that name is one rename away from becoming one. */
  heading: { type: String, default: 'Corrected before merging' },
  /** Shown when there is nothing to report; empty string hides the panel. */
  emptyLabel: { type: String, default: '' }
})

const open = ref(false)

/** Plain-language explanation per rule — the "why", not the rule name. */
const RULE_TEXT = {
  'protocol-venue-identifier': 'Its identifier is a published protocol (protocols.io, JoVE, Nature Protocols…), so the row is a Protocol rather than what the detector guessed.',
  'platform-not-a-resource': 'The row named a hosting platform rather than a resource on it — a mention of the website, not something the study used.',
  'kit-is-not-software': 'An assay kit or reagent pack was proposed as software.',
  'instrument-is-not-software': 'An instrument (or the software bundled with it) was proposed as a shared research tool.',
  'lab-made-solution': 'A buffer or solution mixed at the bench, with no supplier and no catalog number — there is nothing to cite, and the row could not pass validation.'
}

const RULE_LABEL = {
  'protocol-venue-identifier': 'Published protocol',
  'platform-not-a-resource': 'Hosting platform',
  'kit-is-not-software': 'Assay kit',
  'instrument-is-not-software': 'Instrument',
  'lab-made-solution': 'Bench-made solution'
}

const groups = computed(() => {
  const by = new Map()
  for (const a of props.actions) {
    if (!by.has(a.rule)) by.set(a.rule, [])
    by.get(a.rule).push(a)
  }
  return [...by.entries()]
    .map(([rule, items]) => ({
      rule,
      label: RULE_LABEL[rule] || rule,
      why: RULE_TEXT[rule] || '',
      items
    }))
    .sort((a, b) => b.items.length - a.items.length)
})

/**
 * Which detector made each correction — worth a column on the Generated KRT
 * page, where they come from five modules, and pure repetition on a single
 * detector's own page, where every row would say the same word.
 */
const showOrigin = computed(() => {
  const origins = new Set(props.actions.map(a => a.jobType || a.origin || ''))
  return origins.size > 1
})

const droppedCount = computed(() => props.actions.filter(a => a.outcome === 'dropped').length)
const retypedCount = computed(() => props.actions.filter(a => a.outcome === 'retyped').length)

const summary = computed(() => {
  const parts = []
  if (retypedCount.value) parts.push(`${retypedCount.value} retyped`)
  if (droppedCount.value) parts.push(`${droppedCount.value} removed`)
  return parts.join(' · ')
})
</script>

<template>
  <section v-if="actions.length || emptyLabel" class="curation">
    <button v-if="actions.length" type="button" class="curation-toggle" @click="open = !open">
      <span class="curation-caret" :class="{ 'curation-caret-open': open }">▸</span>
      {{ heading }}
      <span class="curation-count">{{ actions.length }}</span>
      <span class="curation-summary">{{ summary }}</span>
    </button>
    <p v-else class="curation-empty">{{ emptyLabel }}</p>

    <div v-if="open" class="curation-body">
      <p class="curation-intro">
        These are corrections the app is certain of, applied to the detectors' candidates before anything is
        merged. Nothing in your own Key Resources Table is affected — only what would have been proposed to you.
      </p>
      <div v-for="g in groups" :key="g.rule" class="curation-group">
        <p class="curation-group-head">
          {{ g.label }}
          <span class="curation-group-count">{{ g.items.length }}</span>
        </p>
        <p v-if="g.why" class="curation-group-why">{{ g.why }}</p>
        <ul class="curation-list">
          <li v-for="(a, i) in g.items" :key="i" class="curation-item">
            <span class="curation-outcome" :class="`curation-outcome-${a.outcome}`">
              {{ a.outcome === 'dropped' ? 'Removed' : 'Retyped' }}
            </span>
            <span class="curation-name">{{ a.resourceName || '(unnamed)' }}</span>
            <span v-if="a.outcome === 'retyped'" class="curation-change">{{ a.from }} → {{ a.to }}</span>
            <span v-else-if="a.from" class="curation-change">was {{ a.from }}</span>
            <span v-if="a.identifier" class="curation-id" v-tooltip="a.identifier">{{ a.identifier }}</span>
            <span v-if="showOrigin && (a.jobType || a.origin)" class="curation-origin">{{ a.jobType || a.origin }}</span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.curation {
  margin-bottom: 1rem;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  background: #f9fafb;
}
.curation-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.625rem 0.875rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #374151;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
}
.curation-caret {
  display: inline-block;
  transition: transform 0.15s ease;
  color: #9ca3af;
}
.curation-caret-open { transform: rotate(90deg); }
.curation-count {
  padding: 0.0625rem 0.4rem;
  font-size: 0.7rem;
  font-weight: 600;
  color: #92400e;
  background: #fef3c7;
  border-radius: 9999px;
}
.curation-summary { font-size: 0.75rem; color: #6b7280; font-weight: 400; }
.curation-empty {
  margin: 0;
  padding: 0.625rem 0.875rem;
  font-size: 0.75rem;
  color: #6b7280;
}
.curation-body {
  padding: 0 0.875rem 0.875rem;
  border-top: 1px solid #e5e7eb;
}
.curation-intro {
  margin: 0.625rem 0 0.75rem;
  font-size: 0.75rem;
  color: #4b5563;
  line-height: 1.5;
}
.curation-group { margin-top: 0.75rem; }
.curation-group-head {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin: 0;
  font-size: 0.75rem;
  font-weight: 600;
  color: #111827;
}
.curation-group-count {
  font-size: 0.7rem;
  font-weight: 500;
  color: #6b7280;
}
.curation-group-why {
  margin: 0.125rem 0 0.375rem;
  font-size: 0.72rem;
  color: #6b7280;
  line-height: 1.45;
}
.curation-list { margin: 0; padding: 0; list-style: none; }
.curation-item {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.25rem 0;
  border-top: 1px solid #f3f4f6;
  font-size: 0.75rem;
}
.curation-outcome {
  flex-shrink: 0;
  padding: 0.0625rem 0.375rem;
  font-size: 0.65rem;
  font-weight: 600;
  border-radius: 0.25rem;
}
.curation-outcome-dropped { color: #6b7280; background: #f3f4f6; }
.curation-outcome-retyped { color: #92400e; background: #fef3c7; }
.curation-name { color: #111827; font-weight: 500; }
.curation-change { color: #6b7280; }
.curation-id {
  max-width: 22rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #9ca3af;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.7rem;
}
.curation-origin {
  margin-left: auto;
  color: #9ca3af;
  font-size: 0.7rem;
}
</style>
