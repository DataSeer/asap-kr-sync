<script setup>
/**
 * The converted manuscript, readable on the page.
 *
 * Two views because they answer different questions. "Rendered" is for reading
 * — is this section actually here, did the tables survive. "Raw" is for
 * debugging a detection: it shows the escapes, the broken words and the stray
 * characters that the rendered view smooths over, and those are exactly what
 * makes a name fail to match.
 *
 * The HTML comes from renderMarkdown, which escapes its input before doing
 * anything else, so `v-html` here can only emit tags that renderer wrote.
 * Nothing from the manuscript reaches the DOM as markup.
 */
import { computed, ref } from 'vue'
import { renderMarkdown } from '@/components/modules/markdown-render'

const props = defineProps({
  content: { type: String, default: '' },
  /** How many characters the RUN recorded, which may differ from what loaded. */
  length: { type: Number, default: 0 },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' }
})

/**
 * Raw by default. Rendered is the nicer read, but the reason to open this page
 * at all is usually "why did the pipeline not find X" — and that answer lives
 * in the escapes and broken words only the raw view keeps.
 */
const view = ref('raw')

const html = computed(() => (view.value === 'rendered' ? renderMarkdown(props.content) : ''))

const search = ref('')
/**
 * Raw view only: the rendered view is for reading, and highlighting inside
 * generated HTML would mean rewriting it, which is how injection gets in.
 */
const rawLines = computed(() => {
  const q = search.value.trim().toLowerCase()
  const lines = props.content.split('\n')
  if (!q) return lines.map((text, i) => ({ n: i + 1, text }))
  return lines
    .map((text, i) => ({ n: i + 1, text }))
    .filter((l) => l.text.toLowerCase().includes(q))
})
</script>

<template>
  <div class="mv">
    <div class="mv-bar">
      <div class="mv-views">
        <button
          type="button"
          class="mv-view"
          :class="{ 'mv-view-active': view === 'raw' }"
          @click="view = 'raw'"
        >Raw</button>
        <button
          type="button"
          class="mv-view"
          :class="{ 'mv-view-active': view === 'rendered' }"
          @click="view = 'rendered'"
        >Rendered</button>
      </div>
      <input
        v-if="view === 'raw'"
        v-model="search"
        type="text"
        class="mv-search"
        placeholder="Find a line…"
      >
      <span class="mv-count">
        {{ (content.length || length).toLocaleString() }} characters
        <template v-if="view === 'raw' && search.trim()">
          · {{ rawLines.length }} matching line{{ rawLines.length === 1 ? '' : 's' }}
        </template>
      </span>
    </div>

    <p v-if="loading" class="mv-note">Loading the converted text…</p>
    <p v-else-if="error" class="mv-note mv-error">{{ error }}</p>
    <p v-else-if="!content" class="mv-note">No converted text is stored for this submission.</p>

    <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapes its
         input before any rule runs; the only tags here are ones it emitted. -->
    <div v-else-if="view === 'rendered'" class="mv-frame mv-rendered" v-html="html"></div>

    <div v-else class="mv-frame mv-raw">
      <div v-for="l in rawLines" :key="l.n" class="mv-line">
        <span class="mv-lineno">{{ l.n }}</span><span class="mv-linetext">{{ l.text }}</span>
      </div>
      <p v-if="!rawLines.length" class="mv-note">No line contains that.</p>
    </div>
  </div>
</template>

<style scoped>
.mv { min-width: 0; }
.mv-bar { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 0.6rem; }
.mv-views { display: flex; gap: 0.35rem; }
.mv-view {
  height: 1.85rem; padding: 0 0.65rem; border-radius: 0.375rem;
  border: 1px solid #e5e7eb; background: #fff; font-size: 0.78rem;
  color: #374151; cursor: pointer;
}
.mv-view-active { background: #eff6ff; border-color: #bfdbfe; color: #1d4ed8; font-weight: 600; }
.mv-search {
  height: 1.85rem; padding: 0 0.6rem; border-radius: 0.375rem;
  border: 1px solid #e5e7eb; font-size: 0.78rem; min-width: 14rem;
}
.mv-count { font-size: 0.75rem; color: #6b7280; margin-left: auto; }
.mv-note { font-size: 0.85rem; color: #6b7280; padding: 1rem 0; }
.mv-error { color: #b91c1c; }
/* Deliberately short: the manuscript is reference material, and a frame tall
   enough to read a paper in pushes Technical detail off the screen. It scrolls
   inside itself, and the whole file is one download away. */
.mv-frame {
  max-height: min(38vh, 24rem); overflow: auto;
  border: 1px solid #e5e7eb; border-radius: 0.5rem; background: #fff;
  padding: 1rem 1.25rem;
}
/* A reading column: full-width prose at 1440px is unreadable. */
.mv-rendered { font-size: 0.85rem; line-height: 1.6; color: #1f2937; }
.mv-rendered :deep(h1),
.mv-rendered :deep(h2),
.mv-rendered :deep(h3),
.mv-rendered :deep(h4) { font-weight: 600; color: #111827; margin: 1.2rem 0 0.4rem; line-height: 1.3; }
.mv-rendered :deep(h1) { font-size: 1.15rem; }
.mv-rendered :deep(h2) { font-size: 1rem; }
.mv-rendered :deep(h3) { font-size: 0.92rem; }
.mv-rendered :deep(h4) { font-size: 0.86rem; }
.mv-rendered :deep(p) { margin: 0 0 0.7rem; max-width: 52rem; }
.mv-rendered :deep(ul),
.mv-rendered :deep(ol) { margin: 0 0 0.7rem 1.2rem; max-width: 52rem; }
.mv-rendered :deep(li) { margin-bottom: 0.15rem; }
.mv-rendered :deep(blockquote) {
  margin: 0 0 0.7rem; padding-left: 0.75rem;
  border-left: 3px solid #e5e7eb; color: #6b7280;
}
.mv-rendered :deep(hr) { border: 0; border-top: 1px solid #e5e7eb; margin: 1rem 0; }
.mv-rendered :deep(code) {
  font-family: ui-monospace, monospace; font-size: 0.78rem;
  background: #f3f4f6; padding: 0 0.2rem; border-radius: 0.2rem;
}
.mv-rendered :deep(pre) {
  background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 0.375rem;
  padding: 0.6rem 0.8rem; overflow-x: auto; margin: 0 0 0.7rem;
}
.mv-rendered :deep(pre code) { background: none; padding: 0; }
/* Converted tables run wide; they scroll inside themselves rather than
   stretching the page. */
.mv-rendered :deep(table) {
  display: block; overflow-x: auto; max-width: 100%;
  border-collapse: collapse; font-size: 0.78rem; margin: 0 0 0.9rem;
}
.mv-rendered :deep(th),
.mv-rendered :deep(td) {
  border: 1px solid #e5e7eb; padding: 0.3rem 0.5rem;
  text-align: left; vertical-align: top;
}
.mv-rendered :deep(th) { background: #f9fafb; font-weight: 600; }
.mv-rendered :deep(img) { max-width: 100%; height: auto; }
.mv-rendered :deep(a) { color: #2563eb; }
.mv-raw { font-family: ui-monospace, monospace; font-size: 0.75rem; line-height: 1.5; }
.mv-line { display: flex; gap: 0.75rem; }
.mv-lineno {
  flex: 0 0 3.5rem; text-align: right; color: #d1d5db;
  user-select: none; padding-right: 0.25rem; border-right: 1px solid #f3f4f6;
}
.mv-linetext { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
</style>
