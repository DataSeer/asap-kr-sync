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
import { computed, onMounted, ref } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useJobPoller } from '@/composables'
import ModuleExplainer from '@/components/modules/ModuleExplainer.vue'
import GroundingTable from '@/components/modules/GroundingTable.vue'
import DetectionsTable from '@/components/modules/DetectionsTable.vue'
import ModuleTechnical from '@/components/modules/ModuleTechnical.vue'
import SearchInput from '@/components/common/SearchInput.vue'
import { explainerFor } from '@/components/modules/module-explainers'
import { labelFor } from '@/components/modules/module-meta'
import configService from '@/services/config.service'
import { useResourceTypesStore } from '@/stores/resourceTypes.store'

const route = useRoute()
const submissionId = computed(() => route.params.id)
const jobType = computed(() => route.params.type)
const resourceTypesStore = useResourceTypesStore()

const { jobs } = useJobPoller(submissionId)


const job = computed(() => (jobs.value || {})[jobType.value] || null)
const explainer = computed(() => explainerFor(jobType.value))

/**
 * Every step, in pipeline order, so the tab strip shows the whole shape rather
 * than only the steps that happen to have a page today. Steps without one are
 * shown greyed instead of hidden: a reader should be able to see that Materials
 * Detection exists and simply is not viewable here yet.
 */
const steps = ref([])
onMounted(async () => {
  // Resource-type categories drive the tab groups, and getTabGroup falls back to
  // "Lab Materials" for a type it does not know — so without this every row
  // lands in one tab. The panel loads them because its parent view does; a page
  // opened directly, which is the whole point of these being pages, does not.
  resourceTypesStore.fetchResourceTypeNames().catch(() => {})
  try {
    steps.value = (await configService.getPipeline()).nodes
  } catch {
    // The page still renders its own module; only the tab strip is lost.
  }
})

/** Modules with a page. A tab that goes nowhere is worse than a greyed one. */
const HAS_PAGE = new Set([
  'krt_grounding',
  'software_detection', 'datasets_detection', 'materials_detection',
  'protocols_detection', 'identifier_detection'
])

const label = computed(() => labelFor(jobType.value))

/** Detection modules: five detectors, one result shape. */
const DETECTION_TYPES = new Set([
  'software_detection', 'datasets_detection', 'materials_detection',
  'protocols_detection', 'identifier_detection'
])
const isDetection = computed(() => DETECTION_TYPES.has(jobType.value))
const detections = computed(() => job.value?.result?.data?.items || [])

// ── grounding data ─────────────────────────────────────────────────────
const outcomes = computed(() => job.value?.result?.data?.outcomes || [])
const policy = computed(() => job.value?.result?.data?.meta?.grounding || null)

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

/** Whichever list this module produced — the toolbar treats both the same. */
const rows = computed(() => (isDetection.value ? detections.value : outcomes.value))

const visible = computed(() => {
  const q = search.value.trim().toLowerCase()
  return rows.value.filter((o) => {
    if (tab.value !== 'all' && resourceTypesStore.getTabGroup(o.resourceType || '') !== tab.value) return false
    return matches(o, q)
  })
})

/** Row counts per tab, tracking the search but not the tab itself. */
const tabCounts = computed(() => {
  const c = { all: 0 }
  const q = search.value.trim().toLowerCase()
  for (const o of rows.value) {
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
  for (const o of rows.value) {
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
    <!-- The source material first: these results are read against it. -->
    <!-- The submission's own header: title, manuscript id, and links to the
         KRT and PDF files. Reused rather than rebuilt, so these pages carry the
         same identity and the same file links as every step view. -->

    <div class="mrv-head">
      <RouterLink :to="{ name: 'submission-pipeline', params: { id: submissionId } }" class="mrv-back">
        ← Pipeline
      </RouterLink>
      <h1 class="mrv-title">{{ label }}</h1>
      <!-- Beside the title, not off in a corner: it is a fact about THIS
           module's result, not a property of the page. -->
      <span v-if="tabConflicts.all > 0" class="mrv-conflicts">
        ⚠ {{ tabConflicts.all }} conflict{{ tabConflicts.all === 1 ? '' : 's' }}
      </span>
    </div>

    <!-- Every step, as links. RouterLink rather than a click handler so
         ctrl-click opens a second tab, which is the point of these pages. -->
    <nav v-if="steps.length" class="mrv-modules" aria-label="Pipeline steps">
      <template v-for="s in steps" :key="s.jobType">
        <RouterLink
          v-if="HAS_PAGE.has(s.jobType)"
          :to="{ name: 'submission-module', params: { id: submissionId, type: s.jobType } }"
          class="mrv-module"
          :class="{ 'mrv-module-active': s.jobType === jobType }"
        >
          {{ labelFor(s.jobType) }}
        </RouterLink>
        <span v-else class="mrv-module mrv-module-off" title="This step does not have a page yet — open it from the processes panel.">
          {{ labelFor(s.jobType) }}
        </span>
      </template>
    </nav>

    <ModuleExplainer
      v-if="explainer"
      :title="explainer.title"
      :summary="explainer.summary"
      :points="explainer.points"
    />

    <p v-if="!job" class="mrv-empty">This module has not produced a result for this submission yet.</p>

    <template v-else-if="jobType === 'krt_grounding' || isDetection">
      <!-- Filters and search on one line: they do the same job, and splitting
           them over two rows pushed the table itself below the fold. -->
      <div class="mrv-toolbar">
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
        <SearchInput v-model="search" placeholder="Search rows…" class="mrv-search" />
      </div>
      <!-- Fixed height with the header pinned: these tables run to hundreds of
           rows, and a page that grows with them loses the column names exactly
           when they are needed. -->
      <div class="mrv-table-frame">
        <GroundingTable v-if="jobType === 'krt_grounding'" :outcomes="visible" :policy="policy" :search="search" />
        <DetectionsTable v-else :items="visible" :search="search" :job-type="jobType" />
      </div>
      <ModuleTechnical :job="job" :submission-id="submissionId" :job-type="jobType" />
    </template>

    <p v-else class="mrv-empty">
      A dedicated view for this module is not built yet — open it from the processes panel for now.
    </p>
  </div>
</template>

<style scoped>
.mrv { padding: 1.25rem 1.5rem 3rem; max-width: 100%; }
.mrv-files { margin-bottom: 0.5rem; }
.mrv-head { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
.mrv-back { font-size: 0.8rem; color: #2563eb; text-decoration: none; }
.mrv-back:hover { text-decoration: underline; }
.mrv-title { font-size: 1.25rem; font-weight: 600; color: #111827; margin: 0; }
.mrv-conflicts {
  padding: 0.1rem 0.45rem; border-radius: 0.25rem; font-size: 0.72rem; font-weight: 600;
  background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca;
}
.mrv-modules { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-bottom: 1rem; }
.mrv-module {
  padding: 0.2rem 0.5rem; border-radius: 0.3rem; border: 1px solid #e5e7eb;
  font-size: 0.72rem; color: #374151; background: #fff; text-decoration: none;
}
.mrv-module:hover { border-color: #bfdbfe; }
.mrv-module-active { background: #eff6ff; border-color: #bfdbfe; color: #1d4ed8; font-weight: 600; }
.mrv-module-off { color: #d1d5db; background: #fafafa; cursor: default; }
.mrv-toolbar {
  display: flex; align-items: center; gap: 0.75rem;
  flex-wrap: wrap; margin-bottom: 0.6rem;
}
.mrv-toolbar .mrv-tabs { margin-bottom: 0; flex: 1 1 auto; }
/* Right-aligned, and the same height as a tab so the row reads as one strip. */
.mrv-search { margin-left: auto; flex: 0 1 22rem; min-width: 12rem; }
.mrv-search :deep(input) {
  height: 1.85rem;
  font-size: 0.78rem;
  padding-top: 0;
  padding-bottom: 0;
}
.mrv-table-frame {
  height: min(60vh, 40rem);
  overflow: auto;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  background: #fff;
}
.mrv-tabs { display: flex; gap: 0.35rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
.mrv-tab {
  display: inline-flex; align-items: center; gap: 0.35rem;
  height: 1.85rem; padding: 0 0.65rem;
  border-radius: 0.375rem; border: 1px solid #e5e7eb;
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
