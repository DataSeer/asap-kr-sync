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
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useJobPoller } from '@/composables'
import ModuleExplainer from '@/components/modules/ModuleExplainer.vue'
import GroundingTable from '@/components/modules/GroundingTable.vue'
import DetectionsTable from '@/components/modules/DetectionsTable.vue'
import AuthorsTable from '@/components/modules/AuthorsTable.vue'
import GeneratedKrtTable from '@/components/modules/GeneratedKrtTable.vue'
import SuggestionsTable from '@/components/modules/SuggestionsTable.vue'
import MarkdownViewer from '@/components/modules/MarkdownViewer.vue'
import SubmissionFileLinks from '@/components/modules/SubmissionFileLinks.vue'
import ModuleTechnical from '@/components/modules/ModuleTechnical.vue'
import SearchInput from '@/components/common/SearchInput.vue'
import { explainerFor } from '@/components/modules/module-explainers'
import { labelFor } from '@/components/modules/module-meta'
import { buildKrtRows } from '@/components/modules/generated-krt'
import {
  decisionLabel, decisionType, decisionMatchesSearch, buildDecisionRows, DECISION_ORDER
} from '@/components/modules/suggestion-decisions'
import configService from '@/services/config.service'
import orcidService from '@/services/orcid.service'
import markdownService from '@/services/markdown.service'
import fileService from '@/services/file.service'
import { useResourceTypesStore } from '@/stores/resourceTypes.store'
import { useSubmissionStore } from '@/stores/submission.store'
import { setSubmissionTitle } from '@/router'

const route = useRoute()
const submissionId = computed(() => route.params.id)
const jobType = computed(() => route.params.type)
const resourceTypesStore = useResourceTypesStore()
const submissionStore = useSubmissionStore()

const { jobs } = useJobPoller(submissionId)


const job = computed(() => (jobs.value || {})[jobType.value] || null)
const explainer = computed(() => explainerFor(jobType.value))

/**
 * Every step, in pipeline order, so the tab strip shows the whole shape rather
 * than only the steps that happen to have a page today. Steps without one are
 * shown greyed instead of hidden: a reader should be able to see that Materials
 * Detection exists and simply is not viewable here yet.
 */
/**
 * The submission itself — for the two file links and for the tab title.
 *
 * Fetched here rather than inherited: these pages exist to be opened directly
 * in a second tab, so there is no parent view to have loaded it already.
 */
const submission = ref(null)
const latestFiles = ref({})

const steps = ref([])
onMounted(async () => {
  submissionStore.fetchSubmission(submissionId.value).then((sub) => {
    submission.value = sub
    latestFiles.value = submissionStore.latestFiles || {}
  }).catch(() => { /* the links are simply absent */ })

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
  'protocols_detection', 'identifier_detection',
  'markdown_convert', 'orcid_extraction', 'das_extraction',
  'pdf_analysis', 'suggestion_generation'
])

const label = computed(() => labelFor(jobType.value))

/**
 * The module leads the tab title. These pages are opened several at a time —
 * that is the point of them being pages — so a title that named only the
 * submission would give every tab the same label.
 */
watch([label, submission], () => {
  const name = submission.value?.title || submission.value?.manuscriptId
  setSubmissionTitle(name ? `${label.value} · ${name}` : label.value)
}, { immediate: true })

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

// ── the ingest steps ───────────────────────────────────────────────────
/**
 * The authors come from the submission, not from the job result — the job
 * writes them to the submission and keeps only counts. The panel could inject
 * them from its parent view; a page opened cold has to ask for them itself,
 * which is the same lesson the resource types taught above.
 */
const authors = ref([])
onMounted(async () => {
  if (jobType.value !== 'orcid_extraction') return
  try {
    authors.value = (await orcidService.getAuthors(submissionId.value))?.authors || []
  } catch {
    // Leaves the table empty rather than the page broken; Technical detail
    // still shows what the run itself produced.
  }
})

const visibleAuthors = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return authors.value
  return authors.value.filter((a) => [a.name, a.orcid, a.affiliation, a.source]
    .some((v) => String(v ?? '').toLowerCase().includes(q)))
})

/** The Data Availability Statement, verbatim. Empty string when none was found. */
const das = computed(() => job.value?.result?.data?.das || '')

/** All markdown conversion reports about itself; the text is an artefact. */
const markdownLength = computed(() => job.value?.result?.data?.markdownLength || 0)
const markdownFileId = computed(() => job.value?.result?.data?.fileId || null)

/** The converted text itself, so the page can show it rather than describe it. */
const markdown = ref('')
const markdownLoading = ref(false)
const markdownError = ref('')
onMounted(async () => {
  if (jobType.value !== 'markdown_convert') return
  markdownLoading.value = true
  try {
    markdown.value = (await markdownService.getContent(submissionId.value))?.content || ''
  } catch (e) {
    markdownError.value = e?.response?.status === 404
      ? 'No converted text is stored for this submission yet.'
      : 'The converted text could not be loaded.'
  } finally {
    markdownLoading.value = false
  }
})

/**
 * The converted text, as the stored file rather than the raw LM artefact — this
 * is the one every module actually read, and the one worth searching when a row
 * comes back "not found".
 */
async function downloadMarkdown() {
  if (!markdownFileId.value) return
  try {
    const data = await fileService.download(submissionId.value, markdownFileId.value)
    if (data.url) window.open(data.url, '_blank', 'noopener,noreferrer')
  } catch {
    // Nothing useful to say to the user here; the artefact links below still work.
  }
}

// ── AI Suggestions ─────────────────────────────────────────────────────
const isSuggestions = computed(() => jobType.value === 'suggestion_generation')

/**
 * The decision log, falling back to the suggestion list for older results that
 * predate it. Both shapes carry an action and a row, which is all this needs.
 */
const decisions = computed(() => {
  if (!isSuggestions.value) return []
  const d = job.value?.result?.data
  return d?.decisions?.length ? d.decisions : (d?.suggestions || [])
})

/**
 * Which decision kinds are shown. Empty = all of them; the chips are
 * multi-select, so a curator can look at adds and removes together without
 * the skips burying them.
 */
const decisionFilter = ref(new Set())
const toggleDecision = (label) => {
  const next = new Set(decisionFilter.value)
  if (next.has(label)) next.delete(label)
  else next.add(label)
  decisionFilter.value = next
}

/**
 * Chips for every decision kind PRESENT in the log, counted under the current
 * tab and search but not under the chips themselves — otherwise clicking one
 * would zero the others and there would be no way back.
 */
const decisionOptions = computed(() => {
  const q = search.value.trim().toLowerCase()
  const inTab = (d) => tab.value === 'all'
    || resourceTypesStore.getTabGroup(decisionType(d)) === tab.value
  const present = new Set()
  const counts = new Map()
  for (const d of decisions.value) {
    const label = decisionLabel(d)
    present.add(label)
    if (inTab(d) && decisionMatchesSearch(d, q)) counts.set(label, (counts.get(label) || 0) + 1)
  }
  const rank = (l) => { const i = DECISION_ORDER.indexOf(l); return i === -1 ? DECISION_ORDER.length : i }
  return [...present].sort((a, b) => rank(a) - rank(b))
    .map((label) => ({ label, count: counts.get(label) || 0 }))
})

const visibleDecisionRows = computed(() => {
  const q = search.value.trim().toLowerCase()
  let items = [...decisions.value].sort((a, b) => compareTypes(decisionType(a), decisionType(b)))
  if (tab.value !== 'all') {
    items = items.filter((d) => resourceTypesStore.getTabGroup(decisionType(d)) === tab.value)
  }
  if (decisionFilter.value.size) items = items.filter((d) => decisionFilter.value.has(decisionLabel(d)))
  if (q) items = items.filter((d) => decisionMatchesSearch(d, q))
  return buildDecisionRows(items)
})

// ── the Generated KRT ──────────────────────────────────────────────────
const isKrt = computed(() => jobType.value === 'pdf_analysis')
const krtItems = computed(() => (isKrt.value ? job.value?.result?.data?.items || [] : []))
const krtDropped = computed(() => job.value?.result?.data?.meta?.dropped || [])
const krtRows = computed(() => buildKrtRows(krtItems.value))

/** Resource type of each group, taken from its first row. */
const krtGroupType = computed(() => {
  const m = new Map()
  for (const r of krtRows.value) if (r.isGroupStart) m.set(r.groupIndex, r.resourceType || '')
  return m
})

const krtRowMatches = (r, q) => !q || [
  r.resourceType, r.resourceName, r.finalName, r.sourceUrl,
  r.identifier, r.newReuse, r.additionalInformation, r.reason
].some((v) => String(v ?? '').toLowerCase().includes(q))

/**
 * Filtering keeps or drops a WHOLE group.
 *
 * A merged row exists because several modules agreed; showing one of its lines
 * because a search term happens to appear in that module's version, and hiding
 * the others, would make a group of three look like a group of one.
 */
const keptGroups = computed(() => {
  const q = search.value.trim().toLowerCase()
  const keep = new Set()
  const matched = new Set(krtRows.value.filter((r) => krtRowMatches(r, q)).map((r) => r.groupIndex))
  for (const [gi, type] of krtGroupType.value) {
    if (!matched.has(gi)) continue
    if (tab.value !== 'all' && resourceTypesStore.getTabGroup(type) !== tab.value) continue
    keep.add(gi)
  }
  return keep
})

/** The KRT editor's ordering: tab group first, then the type's own order. */
const compareTypes = (a, b) => {
  const ga = resourceTypesStore.getGroupSortOrder(a)
  const gb = resourceTypesStore.getGroupSortOrder(b)
  if (ga !== gb) return ga - gb
  return resourceTypesStore.getTypeSortOrder(a) - resourceTypesStore.getTypeSortOrder(b)
}

const visibleKrtRows = computed(() => {
  const keep = keptGroups.value
  const type = krtGroupType.value
  const rows = krtRows.value
    .filter((r) => keep.has(r.groupIndex))
    .sort((a, b) => (a.groupIndex === b.groupIndex
      ? 0
      : (compareTypes(type.get(a.groupIndex), type.get(b.groupIndex)) || (a.groupIndex - b.groupIndex))))
  // Parity is assigned after sorting so the shading alternates by group as
  // displayed, not by the order the groups were built in.
  let parity = -1
  let last = null
  return rows.map((r) => {
    if (r.groupIndex !== last) { parity++; last = r.groupIndex }
    return { ...r, displayParity: parity % 2 }
  })
})


/**
 * The tab strip is always present; tabs with nothing in them are disabled.
 *
 * Most modules produce one kind of resource, so hiding the strip there moved
 * the search box to a different place on every module. Keeping the strip and
 * greying the empty tabs holds the layout still AND says what the module does
 * — that Materials Detection finds materials and nothing else is information,
 * not clutter.
 */
const tabEnabled = (key) => key === 'all' || (tabCounts.value[key] || 0) > 0
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
    if (tab.value !== 'all'
        && resourceTypesStore.getTabGroup(o.resourceType || '') !== tab.value) return false
    return matches(o, q)
  })
})

/** Row counts per tab, tracking the search but not the tab itself. */
const tabCounts = computed(() => {
  const c = { all: 0 }
  const q = search.value.trim().toLowerCase()
  // The Generated KRT counts GROUPS — one per KRT row — not the contributor
  // lines below them, so the tab count matches the row numbers on screen.
  if (isSuggestions.value) {
    for (const d of decisions.value) {
      if (!decisionMatchesSearch(d, q)) continue
      if (decisionFilter.value.size && !decisionFilter.value.has(decisionLabel(d))) continue
      const g = resourceTypesStore.getTabGroup(decisionType(d))
      c[g] = (c[g] || 0) + 1
      c.all++
    }
    return c
  }
  if (isKrt.value) {
    for (const r of krtRows.value) {
      if (!r.isGroupStart) continue
      if (!krtRows.value.some((x) => x.groupIndex === r.groupIndex && krtRowMatches(x, q))) continue
      const g = resourceTypesStore.getTabGroup(r.resourceType || '')
      c[g] = (c[g] || 0) + 1
      c.all++
    }
    return c
  }
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
      <!-- The two documents every result on this page is a claim about. -->
      <SubmissionFileLinks
        class="mrv-files-links"
        :submission-id="submissionId"
        :files="latestFiles"
      />
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
            :class="{ 'mrv-tab-active': tab === t.key, 'mrv-tab-empty': !tabEnabled(t.key) }"
            :disabled="!tabEnabled(t.key)"
            :title="tabEnabled(t.key) ? undefined : 'This module produces no resources of this kind'"
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

    <template v-else-if="isSuggestions">
      <div class="mrv-toolbar">
        <div class="mrv-tabs">
          <button
            v-for="t in TABS"
            :key="t.key"
            type="button"
            class="mrv-tab"
            :class="{ 'mrv-tab-active': tab === t.key, 'mrv-tab-empty': !tabEnabled(t.key) }"
            :disabled="!tabEnabled(t.key)"
            @click="tab = t.key"
          >
            {{ t.label }}
            <span class="mrv-tab-count">{{ tabCounts[t.key] || 0 }}</span>
          </button>
        </div>
        <SearchInput v-model="search" placeholder="Search decisions…" class="mrv-search" />
      </div>
      <!-- Decision chips, multi-select. No chip active = everything shown. -->
      <div v-if="decisionOptions.length > 1" class="mrv-chips">
        <button
          v-for="opt in decisionOptions"
          :key="opt.label"
          type="button"
          class="mrv-chip"
          :class="['mrv-chip-' + opt.label.toLowerCase(),
                   { 'mrv-chip-off': decisionFilter.size && !decisionFilter.has(opt.label) }]"
          :title="decisionFilter.has(opt.label)
            ? 'Click to stop filtering on ' + opt.label
            : 'Click to show only ' + opt.label + ' decisions (combine by clicking several)'"
          @click="toggleDecision(opt.label)"
        >
          {{ opt.label }}
          <span class="mrv-chip-count">{{ opt.count }}</span>
        </button>
      </div>
      <SuggestionsTable :rows="visibleDecisionRows" :search="search" />
      <ModuleTechnical :job="job" :submission-id="submissionId" :job-type="jobType" />
    </template>

    <template v-else-if="isKrt">
      <div class="mrv-toolbar">
        <div class="mrv-tabs">
          <button
            v-for="t in TABS"
            :key="t.key"
            type="button"
            class="mrv-tab"
            :class="{ 'mrv-tab-active': tab === t.key, 'mrv-tab-empty': !tabEnabled(t.key) }"
            :disabled="!tabEnabled(t.key)"
            @click="tab = t.key"
          >
            {{ t.label }}
            <span class="mrv-tab-count">{{ tabCounts[t.key] || 0 }}</span>
          </button>
        </div>
        <SearchInput v-model="search" placeholder="Search rows…" class="mrv-search" />
      </div>
      <GeneratedKrtTable
        :rows="visibleKrtRows"
        :all-rows="krtRows"
        :items="krtItems"
        :dropped="krtDropped"
        :search="search"
      />
      <ModuleTechnical :job="job" :submission-id="submissionId" :job-type="jobType" />
    </template>

    <template v-else-if="jobType === 'orcid_extraction'">
      <div class="mrv-toolbar">
        <span class="mrv-count">{{ authors.length }} author{{ authors.length === 1 ? '' : 's' }}</span>
        <SearchInput v-model="search" placeholder="Search authors…" class="mrv-search" />
      </div>
      <div class="mrv-table-frame">
        <AuthorsTable :authors="visibleAuthors" :search="search" />
      </div>
      <ModuleTechnical :job="job" :submission-id="submissionId" :job-type="jobType" />
    </template>

    <template v-else-if="jobType === 'das_extraction'">
      <!-- Verbatim, in a monospaced block: this is a quotation from the paper,
           and it should not be mistaken for something the app wrote. -->
      <pre v-if="das" class="mrv-verbatim">{{ das }}</pre>
      <p v-else class="mrv-empty">
        No Data Availability Statement was located in the converted manuscript.
      </p>
      <ModuleTechnical :job="job" :submission-id="submissionId" :job-type="jobType" />
    </template>

    <template v-else-if="jobType === 'markdown_convert'">
      <MarkdownViewer
        :content="markdown"
        :length="markdownLength"
        :loading="markdownLoading"
        :error="markdownError"
      />
      <p v-if="markdownFileId" class="mrv-actions">
        <button type="button" class="mrv-btn" @click="downloadMarkdown">Download the converted text</button>
      </p>
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
.mrv-modules { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-bottom: 0.75rem; }
/* Pushed right, on the same line as the title. */
.mrv-files-links { margin-left: auto; }
.mrv-actions { margin: 0.6rem 0 0; }
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
  max-height: min(60vh, 40rem);
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
.mrv-tab-empty { color: #d1d5db; background: #fafafa; cursor: default; }
.mrv-tab-empty:hover { border-color: #e5e7eb; }
.mrv-tab-count { color: #9ca3af; font-size: 0.72rem; }
.mrv-tab-conflicts {
  padding: 0 0.3rem; border-radius: 0.25rem; font-size: 0.68rem; font-weight: 600;
  background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca;
}
.mrv-empty { color: #6b7280; font-size: 0.9rem; padding: 1.5rem 0; }
.mrv-count { font-size: 0.78rem; color: #6b7280; }
.mrv-btn {
  height: 1.85rem; padding: 0 0.65rem; border-radius: 0.375rem;
  border: 1px solid #e5e7eb; background: #fff; font-size: 0.78rem;
  color: #374151; cursor: pointer;
}
.mrv-btn:hover { border-color: #bfdbfe; color: #1d4ed8; }
.mrv-chips { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-bottom: 0.6rem; }
.mrv-chip {
  display: inline-flex; align-items: center; gap: 0.3rem;
  padding: 0.15rem 0.5rem; border-radius: 0.375rem;
  font-size: 0.72rem; font-weight: 600; text-transform: uppercase; cursor: pointer;
}
.mrv-chip-count { font-weight: 500; opacity: 0.7; }
.mrv-chip-off { opacity: 0.35; }
.mrv-chip-add { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
.mrv-chip-update { background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; }
.mrv-chip-remove { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
.mrv-chip-skip { background: #f3f4f6; color: #6b7280; border: 1px solid #e5e7eb; }
.mrv-chip-unreviewed { background: #fffbeb; color: #b45309; border: 1px solid #fde68a; }
.mrv-note { font-size: 0.85rem; color: #374151; line-height: 1.5; margin: 0 0 1rem; max-width: 46rem; }
.mrv-verbatim {
  margin: 0 0 1rem; padding: 0.9rem 1rem;
  border: 1px solid #e5e7eb; border-radius: 0.5rem; background: #fff;
  font-size: 0.82rem; line-height: 1.55; color: #111827;
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: min(60vh, 40rem); overflow: auto;
}
</style>
