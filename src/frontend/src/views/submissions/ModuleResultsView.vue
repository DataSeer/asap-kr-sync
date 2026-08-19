<script setup>
/**
 * ModuleResultsView — one background module's results, on its own page.
 *
 * A modal could not do this job. Resolving a conflict means reading the
 * grounding verdict and the KRT row side by side, which needs two tabs; and a
 * result worth discussing needs a URL to send someone. Both are impossible
 * inside a modal, however wide it gets.
 *
 * It also gives the explanations room. Every complaint about a confusing result
 * so far has been a missing explanation rather than a wrong number, and there
 * was nowhere in a modal to put one without crowding the table.
 */
import { computed, ref } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useJobPoller } from '@/composables'
import ModuleExplainer from '@/components/modules/ModuleExplainer.vue'
import GroundingTable from '@/components/modules/GroundingTable.vue'
import SearchInput from '@/components/common/SearchInput.vue'
import { explainerFor } from '@/components/modules/module-explainers'
import { useResourceTypesStore } from '@/stores/resourceTypes.store'

const route = useRoute()
const submissionId = computed(() => route.params.id)
const jobType = computed(() => route.params.type)
const resourceTypesStore = useResourceTypesStore()

const { jobs } = useJobPoller(submissionId)
const job = computed(() => (jobs.value || {})[jobType.value] || null)
const explainer = computed(() => explainerFor(jobType.value))

const MODULE_LABELS = {
  das_extraction: 'DAS Extraction',
  software_detection: 'Software Detection',
  markdown_convert: 'Markdown Convert',
  orcid_extraction: 'ORCID Extraction',
  materials_detection: 'Materials Detection',
  datasets_detection: 'Datasets Detection',
  protocols_detection: 'Protocols Detection',
  identifier_detection: 'Identifiers Detection',
  krt_grounding: 'KRT Grounding',
  pdf_analysis: 'PDF Analysis',
  suggestion_generation: 'AI Suggestions'
}
const label = computed(() => MODULE_LABELS[jobType.value] || jobType.value)

// ── grounding data ─────────────────────────────────────────────────────
const outcomes = computed(() => job.value?.result?.data?.outcomes || [])
const policy = computed(() => job.value?.result?.meta?.grounding || null)

const search = ref('')
const tab = ref('all')
const TABS = [
  { key: 'all', label: 'All' },
  { key: 'Datasets', label: 'Datasets' },
  { key: 'Software/code', label: 'Software/code' },
  { key: 'Protocols', label: 'Protocols' },
  { key: 'Lab Materials', label: 'Key Lab Materials' }
]

const matches = (o, q) => !q || [o.resourceType, o.resourceName, o.source, o.identifier, o.newReuse]
  .some((v) => String(v ?? '').toLowerCase().includes(q))

const visible = computed(() => {
  const q = search.value.trim().toLowerCase()
  return outcomes.value.filter((o) => {
    if (tab.value !== 'all' && resourceTypesStore.getTabGroup(o.resourceType || '') !== tab.value) return false
    return matches(o, q)
  })
})

/** Row counts per tab, tracking the search but not the tab itself. */
const tabCounts = computed(() => {
  const c = { all: 0 }
  const q = search.value.trim().toLowerCase()
  for (const o of outcomes.value) {
    if (!matches(o, q)) continue
    const g = resourceTypesStore.getTabGroup(o.resourceType || '')
    c[g] = (c[g] || 0) + 1
    c.all++
  }
  return c
})

/** Conflicts per tab — where the defects are, not just how many rows. */
const tabConflicts = computed(() => {
  const c = { all: 0 }
  for (const o of outcomes.value) {
    if (!(o.conflicts?.length > 0)) continue
    const g = resourceTypesStore.getTabGroup(o.resourceType || '')
    c[g] = (c[g] || 0) + 1
    c.all++
  }
  return c
})
</script>

<template>
  <div class="mrv">
    <div class="mrv-head">
      <RouterLink :to="{ name: 'submission-pdf', params: { id: submissionId } }" class="mrv-back">
        ← Back to the submission
      </RouterLink>
      <h1 class="mrv-title">{{ label }}</h1>
      <span v-if="tabConflicts.all > 0" class="mrv-conflicts">
        ⚠ {{ tabConflicts.all }} conflict{{ tabConflicts.all === 1 ? '' : 's' }}
      </span>
    </div>

    <ModuleExplainer
      v-if="explainer"
      :title="explainer.title"
      :summary="explainer.summary"
      :points="explainer.points"
    />

    <p v-if="!job" class="mrv-empty">This module has not produced a result for this submission yet.</p>

    <template v-else-if="jobType === 'krt_grounding'">
      <div class="mrv-controls">
        <SearchInput v-model="search" placeholder="Search rows…" class="mrv-search" />
      </div>
      <div class="mrv-tabs">
        <button
          v-for="t in TABS"
          :key="t.key"
          type="button"
          class="mrv-tab"
          :class="{ 'mrv-tab-active': tab === t.key }"
          @click="tab = t.key"
        >
          {{ t.label }}
          <span class="mrv-tab-count">{{ tabCounts[t.key] || 0 }}</span>
          <span v-if="tabConflicts[t.key] > 0" class="mrv-tab-conflicts">⚠ {{ tabConflicts[t.key] }}</span>
        </button>
      </div>
      <GroundingTable :outcomes="visible" :policy="policy" :search="search" />
    </template>

    <p v-else class="mrv-empty">
      A dedicated view for this module is not built yet — open it from the processes panel for now.
    </p>
  </div>
</template>

<style scoped>
.mrv { padding: 1.25rem 1.5rem 3rem; max-width: 100%; }
.mrv-head { display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
.mrv-back { font-size: 0.8rem; color: #2563eb; text-decoration: none; }
.mrv-back:hover { text-decoration: underline; }
.mrv-title { font-size: 1.25rem; font-weight: 600; color: #111827; margin: 0; }
.mrv-conflicts {
  padding: 0.1rem 0.45rem; border-radius: 0.25rem; font-size: 0.72rem; font-weight: 600;
  background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca;
}
.mrv-controls { margin-bottom: 0.75rem; max-width: 32rem; }
.mrv-tabs { display: flex; gap: 0.35rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
.mrv-tab {
  display: inline-flex; align-items: center; gap: 0.35rem;
  padding: 0.3rem 0.65rem; border-radius: 0.375rem; border: 1px solid #e5e7eb;
  background: #fff; font-size: 0.78rem; color: #374151; cursor: pointer;
}
.mrv-tab-active { background: #eff6ff; border-color: #bfdbfe; color: #1d4ed8; font-weight: 600; }
.mrv-tab-count { color: #9ca3af; font-size: 0.72rem; }
.mrv-tab-conflicts {
  padding: 0 0.3rem; border-radius: 0.25rem; font-size: 0.68rem; font-weight: 600;
  background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca;
}
.mrv-empty { color: #6b7280; font-size: 0.9rem; padding: 1.5rem 0; }
</style>
