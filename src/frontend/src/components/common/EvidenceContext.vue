<script setup>
/**
 * EvidenceContext — shows WHERE in the manuscript a detected item came from.
 *
 * The backend stores one paragraph per item plus offsets into it, which gives
 * two views from a single payload:
 *   - collapsed → the sentence containing the match
 *   - expanded  → the whole paragraph
 * and in both, the matched span is highlighted.
 *
 * That split is the point: a curator judging a suggestion usually needs one
 * sentence, occasionally the paragraph around it, and never wants a wall of
 * text by default.
 *
 * Degrades gracefully. Older results (and Softcite items, whose sentence comes
 * from the PDF rather than the markdown) have a quote but no context offsets —
 * those render the quote alone with nothing to expand.
 */
import { ref, computed } from 'vue'

const props = defineProps({
  /** The `evidence` block from a suggestion or KRT entry. */
  evidence: {
    type: Object,
    default: null
  },
  /** Show the section path above the text. */
  showSection: {
    type: Boolean,
    default: true
  }
})

const expanded = ref(false)

const hasContext = computed(() => {
  const e = props.evidence
  return !!(e && typeof e.context === 'string' && e.context.length > 0)
})

/** Something to show at all — context, or at least the raw quote. */
const hasAnything = computed(() => hasContext.value || !!props.evidence?.quote)

/**
 * The three slices to render: text before the highlight, the highlight, and
 * text after. Computed for whichever view is active.
 */
const parts = computed(() => {
  const e = props.evidence
  if (!hasContext.value) {
    return { before: '', match: e?.quote || '', after: '' }
  }

  const { context, quoteStart, quoteEnd, sentenceStart, sentenceEnd } = e
  const viewStart = expanded.value ? 0 : (sentenceStart ?? 0)
  const viewEnd = expanded.value ? context.length : (sentenceEnd ?? context.length)
  const view = context.slice(viewStart, viewEnd)

  // Highlight offsets are relative to the full context; rebase onto the view,
  // and clamp so a quote spanning past the sentence still renders sensibly.
  const hlStart = Math.max(0, Math.min(view.length, (quoteStart ?? 0) - viewStart))
  const hlEnd = Math.max(hlStart, Math.min(view.length, (quoteEnd ?? 0) - viewStart))

  return {
    before: view.slice(0, hlStart),
    match: view.slice(hlStart, hlEnd),
    after: view.slice(hlEnd)
  }
})

/** Only offer expansion when the paragraph actually says more than the sentence. */
const canExpand = computed(() => {
  const e = props.evidence
  if (!hasContext.value) return false
  const sentenceLength = (e.sentenceEnd ?? e.context.length) - (e.sentenceStart ?? 0)
  return sentenceLength < e.context.length
})
</script>

<template>
  <div v-if="hasAnything" class="evidence-context">
    <div v-if="showSection && evidence?.section" class="evidence-section" v-tooltip="evidence.section">
      {{ evidence.section }}
    </div>

    <p class="evidence-text" :class="{ 'evidence-text--expanded': expanded }">
      <span>{{ parts.before }}</span><mark v-if="parts.match" class="evidence-match">{{ parts.match }}</mark><span>{{ parts.after }}</span>
    </p>

    <div v-if="canExpand || evidence?.truncated" class="evidence-actions">
      <button
        v-if="canExpand"
        type="button"
        class="evidence-toggle"
        @click.stop="expanded = !expanded"
      >
        {{ expanded ? 'Show less' : 'Show full paragraph' }}
      </button>
      <span v-if="expanded && evidence?.truncated" class="evidence-truncated" v-tooltip="'The paragraph was longer than the stored limit'">
        paragraph shortened
      </span>
    </div>
  </div>
</template>

<style scoped>
.evidence-context {
  border-left: 2px solid #e5e7eb;
  padding-left: 0.6rem;
  margin-top: 0.35rem;
}

.evidence-section {
  font-size: 0.68rem;
  font-weight: 600;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  margin-bottom: 0.15rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.evidence-text {
  font-size: 0.78rem;
  line-height: 1.45;
  color: #4b5563;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Collapsed: the sentence is short by construction, but a converted table row
   can still be one long "sentence" — cap it so a row never blows up the layout. */
.evidence-text:not(.evidence-text--expanded) {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.evidence-text--expanded {
  max-height: 16rem;
  overflow-y: auto;
}

.evidence-match {
  background: #fef08a;
  color: inherit;
  padding: 0 0.1rem;
  border-radius: 0.15rem;
}

.evidence-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.2rem;
}

.evidence-toggle {
  font-size: 0.7rem;
  font-weight: 600;
  color: #4f46e5;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
}

.evidence-toggle:hover {
  text-decoration: underline;
}

.evidence-truncated {
  font-size: 0.68rem;
  color: #9ca3af;
  font-style: italic;
}
</style>
