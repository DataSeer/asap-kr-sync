<script setup>
/**
 * Links back to the submission's own views.
 *
 * These pages are meant to be opened in a second tab beside the KRT editor, so
 * getting to the editor — or the PDF — has to be one click from here rather
 * than a trip back through the submission.
 */
import { RouterLink } from 'vue-router'

defineProps({
  submissionId: { type: String, required: true },
  /** Which link is the page you are already on, if any. */
  current: { type: String, default: '' }
})

const LINKS = [
  { key: 'pipeline', label: 'Pipeline', route: 'submission-pipeline' },
  { key: 'krt', label: 'KRT Editor', route: 'submission-krt' },
  { key: 'pdf', label: 'PDF & Analysis', route: 'submission-pdf' }
]
</script>

<template>
  <nav class="sl" aria-label="Submission views">
    <template v-for="l in LINKS" :key="l.key">
      <span v-if="l.key === current" class="sl-item sl-current">{{ l.label }}</span>
      <RouterLink
        v-else
        :to="{ name: l.route, params: { id: submissionId } }"
        class="sl-item"
      >{{ l.label }}</RouterLink>
    </template>
  </nav>
</template>

<style scoped>
.sl { display: flex; gap: 0.3rem; flex-wrap: wrap; }
.sl-item {
  padding: 0.15rem 0.5rem; border-radius: 0.3rem; border: 1px solid #e5e7eb;
  font-size: 0.72rem; color: #2563eb; background: #fff; text-decoration: none;
}
.sl-item:hover { border-color: #bfdbfe; background: #f8fafc; }
.sl-current { color: #6b7280; background: #f3f4f6; cursor: default; }
</style>
