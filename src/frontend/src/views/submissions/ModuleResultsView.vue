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
import { describeJobStatus } from '@/utils/job-status'
import { formatDateTime } from '@/utils/format-date'
import jobService from '@/services/job.service'
import { useAuthStore } from '@/stores/auth.store'
import { useNotificationStore } from '@/stores/notification.store'
import { downstreamOf } from '@/utils/restart-plan'
import ModuleExplainer from '@/components/modules/ModuleExplainer.vue'
import GroundingTable from '@/components/modules/GroundingTable.vue'
import DetectionsTable from '@/components/modules/DetectionsTable.vue'
import AuthorsTable from '@/components/modules/AuthorsTable.vue'
import GeneratedKrtTable from '@/components/modules/GeneratedKrtTable.vue'
import SuggestionsTable from '@/components/modules/SuggestionsTable.vue'
import DasSuggestionsTable from '@/components/modules/DasSuggestionsTable.vue'
import MarkdownViewer from '@/components/modules/MarkdownViewer.vue'
import SubmissionFileLinks from '@/components/modules/SubmissionFileLinks.vue'
import ModuleTechnical from '@/components/modules/ModuleTechnical.vue'
import SearchInput from '@/components/common/SearchInput.vue'
import { explainerFor } from '@/components/modules/module-explainers'
import { labelFor, hasModulePage } from '@/components/modules/module-meta'
import { buildKrtRows } from '@/components/modules/generated-krt'
import {
  decisionLabel, decisionType, decisionMatchesSearch, buildDecisionRows, DECISION_ORDER
} from '@/components/modules/suggestion-decisions'
import {
  buildDasRows, countByStatus, dasMatchesSearch, STATUS_ORDER
} from '@/components/modules/das-suggestions'
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

const authStore = useAuthStore()
const notificationStore = useNotificationStore()

const { jobs, refresh: refreshJobs } = useJobPoller(submissionId)

/**
 * What state this module's run is in, in a sentence.
 *
 * Shown for EVERY status, not only the unhappy ones. The page is a table of
 * results, and a table cannot say whether it is the full output, an earlier
 * run's leftovers, or nothing at all because the step has not started — the
 * reader infers, and infers wrong. One line under the title removes the
 * guessing.
 */
const runStatus = computed(() => describeJobStatus(job.value))

/**
 * When what is on screen was produced.
 *
 * Shown on EVERY run, not only past ones. This page is a record of a run, while
 * the KRT editor a click away is live — so a page that silently shows the table
 * as it was three runs ago reads as a lost edit. Saying "as at" is what makes
 * the difference visible rather than surprising.
 */
const asAt = computed(() => {
  const when = job.value?.completedAt || job.value?.startedAt
  if (!when) return null
  const n = job.value?.runNumber
  const total = runCount.value
  const run = n ? (total > 1 ? `Run ${n} of ${total}` : `Run ${n}`) : 'This run'
  return `${run} · as at ${formatDateTime(when)}`
})


/**
 * Which run this page is showing.
 *
 * `null` means the latest, served straight from the poller — the normal case,
 * and it costs no extra request. Anything else is a past run fetched on demand.
 *
 * Everything on this page renders from `job.result.data.*`, so swapping what
 * `job` resolves to swaps the whole page: tables, counts, evidence, the status
 * line and the METADATA column all follow. That is why the endpoint returns a
 * run already shaped like a job — one rendering path, not two.
 */
const selectedRunNumber = ref(null)
const selectedRun = ref(null)
const runs = ref([])
const runsState = ref('idle')   // idle | loading | ready | error

const liveJob = computed(() => (jobs.value || {})[jobType.value] || null)
const job = computed(() => selectedRun.value || liveJob.value)

/** True while the page is showing something other than the current run. */
const viewingPastRun = computed(() => !!selectedRun.value && selectedRun.value.isLatest === false)

/**
 * Authors read the latest run and nothing else — the same audience rule the
 * run endpoints enforce. Hiding the control without the server gate would be
 * decoration; both exist.
 */
const canBrowseRuns = computed(() => authStore.canViewJobInternals)

/** How many runs this step has had, from whichever source is loaded. */
const runCount = computed(() => runs.value.length || liveJob.value?.runCount || 1)

async function loadRuns() {
  if (!canBrowseRuns.value) return
  runsState.value = 'loading'
  try {
    const data = await jobService.getRuns(submissionId.value, jobType.value)
    runs.value = data.runs || []
    runsState.value = 'ready'
  } catch {
    // Not fatal: the page still shows the current run, which is what it showed
    // before this control existed.
    runs.value = []
    runsState.value = 'error'
  }
}

async function showRun(runNumber) {
  // Selecting the latest returns to the live job, so the page keeps polling and
  // keeps updating — a frozen copy of the current run would go stale on screen.
  if (!runNumber || runNumber === runCount.value) {
    selectedRunNumber.value = null
    selectedRun.value = null
    return
  }
  selectedRunNumber.value = runNumber
  try {
    const { run } = await jobService.getRun(submissionId.value, jobType.value, runNumber)
    selectedRun.value = run
  } catch {
    selectedRunNumber.value = null
    selectedRun.value = null
    notificationStore.error('That run could not be loaded')
  }
}
const explainer = computed(() => explainerFor(jobType.value))

// The step strip navigates between modules without remounting the parent, and
// "run 2" means something different for each step — so a change of step drops
// the selection and reloads the list rather than carrying a stale run across.
watch(jobType, () => {
  selectedRunNumber.value = null
  selectedRun.value = null
  runs.value = []
  loadRuns()
})

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

/**
 * The documents this page is about — the ones the RUN was contemporaneous with,
 * not the ones the submission holds today.
 *
 * A run records the KRT, PDF and markdown as they stood when it opened, by
 * reference. The download endpoint takes a file id and an older version is its
 * own row, so asking for the recorded id returns exactly that version even
 * after the author has replaced it.
 *
 * Falls back to the current files for a run that predates this record — a link
 * to today's PDF is better than none, and the "as at" line says which run the
 * page is showing.
 */
const runDocuments = computed(() => {
  const recorded = job.value?.documents
  return recorded && Object.keys(recorded).length ? recorded : latestFiles.value
})

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
  loadRuns()
  try {
    steps.value = (await configService.getPipeline()).nodes
  } catch {
    // The page still renders its own module; only the tab strip is lost.
  }
})


const label = computed(() => labelFor(jobType.value))

// ── Retry ───────────────────────────────────────────────────────────────────
// Not a restart. A restart re-runs this step AND everything built on it, and
// lives on the pipeline page where several steps can be chosen together. This is
// the narrower thing that comes up after an external service is fixed: the
// pipeline is stuck behind one failure, and what is wanted is to unblock it.
//
// Offered only while nothing downstream has run since. That is what makes
// running this step alone safe — nothing was built on its absence, so nothing is
// left stale afterwards. Once a later step HAS run, retrying alone would leave
// its result built on the failure, and the button says so rather than hiding.
const retrying = ref(false)

/** Every step that depends on this one, directly or through another. */
const downstreamTypes = computed(() => downstreamOf(steps.value, jobType.value))

const retryState = computed(() => {
  if (!authStore.canRestartJobs) return { show: false }
  const current = (jobs.value || {})[jobType.value]
  if (current?.status !== 'failed' || viewingPastRun.value) return { show: false }

  const ran = downstreamTypes.value.filter((t) => {
    const d = (jobs.value || {})[t]
    return d && d.status !== 'waiting'
  })

  return ran.length
    ? {
      show: true,
      enabled: false,
      reason: `${ran.map(labelFor).join(', ')} already ran after this failed, so their `
        + 'results are built on it. Restart this step from the pipeline page, which re-runs them too.'
    }
    : {
      show: true,
      enabled: true,
      reason: 'Run this step again. Nothing else changes — it reads the same documents '
        + 'this round has been using.'
    }
})

/**
 * The other answer: carry on without this step's data.
 *
 * Offered on the same failure as Retry, and only while something is actually
 * held behind it — a failure blocking nothing needs no decision, and a button
 * that records one anyway would put a skip-marker on the record for no reason.
 */
const continuing = ref(false)

const canContinue = computed(() => {
  if (!retryState.value.show) return false
  const current = (jobs.value || {})[jobType.value]
  if (current?.issueAcknowledgedAt) return false
  return downstreamTypes.value.some((t) => (jobs.value || {})[t]?.status === 'waiting')
})

async function continueWithout() {
  if (continuing.value) return
  continuing.value = true
  try {
    const result = await jobService.continueWithout(submissionId.value, jobType.value)
    notificationStore.info(result?.message || 'Continuing without this step')
    await refreshJobs()
  } catch (err) {
    notificationStore.error(err.response?.data?.error || 'Could not continue past this step')
  } finally {
    continuing.value = false
  }
}

async function retry() {
  if (!retryState.value.enabled || retrying.value) return
  retrying.value = true
  try {
    const result = await jobService.retryJob(submissionId.value, jobType.value)
    notificationStore.info(result?.message || 'Running again')
    await refreshJobs()
  } catch (err) {
    notificationStore.error(err.response?.data?.error || 'Could not retry this step')
  } finally {
    retrying.value = false
  }
}

/**
 * What "no result" means for THIS module.
 *
 * The DAS check waits for the Availability step, so on a submission that has
 * not got there "has not produced a result yet" reads as a stall. Say what it
 * is waiting for instead.
 */
const emptyMessage = computed(() => (
  jobType.value === 'das_suggestions'
    ? 'This check runs when you reach the Availability Statement step — it reads the '
      + 'statement itself, so there is nothing for it to check before then.'
    : 'This module has not produced a result for this submission yet.'
))

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

// ── the Availability Statement check ───────────────────────────────────
const dasSuggestions = computed(() => job.value?.result?.data?.suggestions || [])
const dasCounts = computed(() => countByStatus(dasSuggestions.value))
/** Empty set = no filter, matching the AI Suggestions decision chips. */
const dasFilter = ref(new Set())
const dasStatusOptions = computed(() =>
  STATUS_ORDER
    .map((label) => ({ label, count: dasCounts.value[label] || 0 }))
    .filter((o) => o.count > 0)
)
function toggleDasStatus(label) {
  const next = new Set(dasFilter.value)
  if (next.has(label)) next.delete(label)
  else next.add(label)
  dasFilter.value = next
}
const visibleDasRows = computed(() => {
  const filtered = dasSuggestions.value.filter((s) => {
    if (dasFilter.value.size && !dasFilter.value.has(s?.applies ? 'Action needed' : 'Passed')) return false
    return dasMatchesSearch(s, search.value)
  })
  return buildDasRows(filtered)
})

// ── the ingest steps ───────────────────────────────────────────────────
/**
 * The authors come from the submission, not from the job result — the job
 * writes them to the submission and keeps only counts. The panel could inject
 * them from its parent view; a page opened cold has to ask for them itself,
 * which is the same lesson the resource types taught above.
 */
const authors = ref([])
const authorsLoading = ref(false)
const authorsError = ref('')
/**
 * Mount-time is enough here, and only because the route is keyed.
 *
 * The step strip navigates with RouterLink and every module page is this same
 * component, so Vue would reuse the instance and change only the param —
 * leaving whatever was loaded on mount belonging to the module opened first.
 * `meta.remountOnRouteChange` on this route makes a param change build a new
 * instance instead. Remove that and this silently stops running.
 */
onMounted(async () => {
  if (jobType.value !== 'orcid_extraction') return
  // The run's own list wins. `submissions.authors` holds only the newest run's
  // — the next run overwrites it — so reading it for a past run would show
  // whoever the LATEST run found under an older run's timestamp. Older runs
  // recorded no list, and fall back to the live one with the "as at" line
  // saying which run is on screen.
  const recorded = job.value?.result?.data?.items
  if (Array.isArray(recorded) && recorded.length) {
    authors.value = recorded
    authorsLoading.value = false
    return
  }
  authorsLoading.value = true
  try {
    authors.value = (await orcidService.getAuthors(submissionId.value))?.authors || []
  } catch (e) {
    // Swallowing this made a failed request look exactly like a manuscript with
    // no authors — an empty table either way, and no way to tell which.
    authorsError.value = e?.response?.status === 403
      ? 'You do not have access to this submission\'s authors.'
      : 'The author list could not be loaded. The run\'s own record is under Technical detail.'
  } finally {
    authorsLoading.value = false
  }
})

const visibleAuthors = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return authors.value
  // `fullName` is what the endpoint returns; searching `name` matched nothing
  // and made the table look empty for any non-blank query.
  return authors.value.filter((a) => [
    a.fullName, a.firstName, a.lastName, a.orcid, a.affiliation, a.source
  ].some((v) => String(v ?? '').toLowerCase().includes(q)))
})

/** The Data Availability Statement, verbatim. Empty string when none was found. */
const das = computed(() => job.value?.result?.data?.das || '')

/** All markdown conversion reports about itself; the text is an artefact. */
const markdownLength = computed(() => job.value?.result?.data?.markdownLength || 0)
const markdownFileId = computed(() => job.value?.result?.data?.fileId || null)
const markdownFileName = ref('converted manuscript')

/** The converted text itself, so the page can show it rather than describe it. */
const markdown = ref('')
const markdownLoading = ref(false)
const markdownError = ref('')
/**
 * The text THIS run produced, not the newest conversion.
 *
 * Re-read when the selected run changes: showing run 1's statistics above run
 * 3's text is the page contradicting itself on the one thing it exists to show.
 */
async function loadMarkdown() {
  if (jobType.value !== 'markdown_convert') return
  markdownLoading.value = true
  markdownError.value = ''
  try {
    const data = await markdownService.getContent(submissionId.value, markdownFileId.value)
    markdown.value = data?.content || ''
    if (data?.fileName) markdownFileName.value = data.fileName
  } catch (e) {
    markdownError.value = e?.response?.status === 404
      ? (markdownFileId.value
        // A run whose converted file has since been removed. Said plainly,
        // rather than quietly falling back to a different run's text.
        ? 'The text this run produced is no longer stored.'
        : 'No converted text is stored for this submission yet.')
      : 'The converted text could not be loaded.'
  } finally {
    markdownLoading.value = false
  }
}

// Mount-time for the same reason as the author list above: the route is keyed.
onMounted(loadMarkdown)
watch(markdownFileId, loadMarkdown)

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
      <!-- Which run is on screen. Only from the second run onward: a selector
           offering one option is furniture. Hidden from authors entirely — they
           read the latest run, which is also what the endpoint behind this
           enforces. -->
      <label v-if="canBrowseRuns && runs.length > 1" class="mrv-runs">
        <span class="mrv-runs-label">Run</span>
        <select
          class="mrv-runs-select"
          :value="selectedRunNumber ?? runCount"
          @change="showRun(Number($event.target.value))"
        >
          <option v-for="r in runs" :key="r.runNumber" :value="r.runNumber">
            {{ r.runNumber }} of {{ runCount }}{{ r.isLatest ? ' — latest' : '' }}
            · {{ formatDateTime(r.completedAt || r.startedAt) }}
          </option>
        </select>
      </label>

      <!-- Shown only on a failure, and enabled only while nothing downstream
           has run since. Disabled-with-a-reason rather than hidden: "why can I
           not retry this" is the question, and hiding the control answers it
           with silence. -->
      <button
        v-if="retryState.show"
        type="button"
        class="mrv-retry"
        :class="{ 'mrv-retry-off': !retryState.enabled }"
        :disabled="!retryState.enabled || retrying"
        v-tooltip="retryState.reason"
        @click="retry"
      >
        <svg class="mrv-retry-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        {{ retrying ? 'Starting…' : 'Retry' }}
      </button>
      <!-- The second answer. Beside Retry rather than hidden behind it: the
           choice is between two things, and a user who cannot fix the service
           needs to see that carrying on is allowed. -->
      <button
        v-if="canContinue"
        type="button"
        class="mrv-retry"
        :disabled="continuing"
        v-tooltip="'The steps waiting on this one will run without its data. Recorded, so the report can say it was skipped rather than empty.'"
        @click="continueWithout"
      >
        {{ continuing ? 'Continuing…' : 'Continue without it' }}
      </button>

      <!-- The two documents every result on this page is a claim about. -->
      <SubmissionFileLinks
        class="mrv-files-links"
        :submission-id="submissionId"
        :files="runDocuments"
      />
    </div>

    <!-- Selecting a past run must never look like restoring it. This sits above
         the status line, stays put while the run is open, and offers the way
         back — otherwise someone picks run 2, sees it render, and reasonably
         concludes the pipeline is now using it. -->
    <div v-if="viewingPastRun" class="mrv-past" role="status">
      <span class="mrv-past-badge">Past run</span>
      <span class="mrv-past-text">
        Viewing run {{ selectedRun.runNumber }} of {{ runCount }} — <strong>this is not the
        current result</strong>. It is kept exactly as this run produced it.
      </span>
      <button type="button" class="mrv-past-btn" @click="showRun(null)">Back to the latest run</button>
    </div>

    <!-- Directly under the title, before anything that could be mistaken for a
       result: what state this run is in. -->
    <div class="mrv-status" :class="`mrv-status-${runStatus.tone}`" role="status">
      <span class="mrv-status-label">{{ runStatus.label }}</span>
      <span class="mrv-status-text">
        {{ runStatus.title }}
        <span v-if="runStatus.detail" class="mrv-status-detail">{{ runStatus.detail }}</span>
        <!-- What is below is this run's record, not the submission as it stands
             now. The KRT editor next door is live; this is not. -->
        <span v-if="asAt" class="mrv-status-asat">{{ asAt }}</span>
      </span>
    </div>

    <!-- Every step, as links. RouterLink rather than a click handler so
       ctrl-click opens a second tab, which is the point of these pages. -->
    <nav v-if="steps.length" class="mrv-modules" aria-label="Pipeline steps">
      <template v-for="s in steps" :key="s.jobType">
        <RouterLink
          v-if="hasModulePage(s.jobType)"
          :to="{ name: 'submission-module', params: { id: submissionId, type: s.jobType } }"
          class="mrv-module"
          :class="{ 'mrv-module-active': s.jobType === jobType }"
        >
          {{ labelFor(s.jobType) }}
        </RouterLink>
        <span v-else class="mrv-module mrv-module-off" v-tooltip="'This step does not have a page yet — open it from the processes panel.'">
          {{ labelFor(s.jobType) }}
        </span>
      </template>
    </nav>

    <ModuleExplainer
      v-if="explainer"
      :title="explainer.title"
      :summary="explainer.summary"
      :points="explainer.points"
      :doc="explainer.doc"
    />

    <p v-if="!job" class="mrv-empty">{{ emptyMessage }}</p>

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
            v-tooltip="tabEnabled(t.key) ? undefined : 'This module produces no resources of this kind'"
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
      <ModuleTechnical
        :job="job" :submission-id="submissionId" :job-type="jobType"
        :jobs="jobs || {}" :files="runDocuments"
      />
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
          v-tooltip="decisionFilter.has(opt.label)
            ? 'Click to stop filtering on ' + opt.label
            : 'Click to show only ' + opt.label + ' decisions (combine by clicking several)'"
          @click="toggleDecision(opt.label)"
        >
          {{ opt.label }}
          <span class="mrv-chip-count">{{ opt.count }}</span>
        </button>
      </div>
      <SuggestionsTable :rows="visibleDecisionRows" :search="search" />
      <ModuleTechnical
        :job="job" :submission-id="submissionId" :job-type="jobType"
        :jobs="jobs || {}" :files="runDocuments"
      />
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
      <ModuleTechnical
        :job="job" :submission-id="submissionId" :job-type="jobType"
        :jobs="jobs || {}" :files="runDocuments"
      />
    </template>

    <template v-else-if="jobType === 'orcid_extraction'">
      <div class="mrv-toolbar">
        <span class="mrv-count">{{ authors.length }} author{{ authors.length === 1 ? '' : 's' }}</span>
        <SearchInput v-model="search" placeholder="Search authors…" class="mrv-search" />
      </div>
      <p v-if="authorsLoading" class="mrv-empty">Loading the author list…</p>
      <p v-else-if="authorsError" class="mrv-error">{{ authorsError }}</p>
      <div v-else class="mrv-table-frame">
        <AuthorsTable :authors="visibleAuthors" :search="search" />
      </div>
      <ModuleTechnical
        :job="job" :submission-id="submissionId" :job-type="jobType"
        :jobs="jobs || {}" :files="runDocuments"
      />
    </template>

    <template v-else-if="jobType === 'das_extraction'">
      <!-- Verbatim, in a monospaced block: this is a quotation from the paper,
           and it should not be mistaken for something the app wrote. -->
      <pre v-if="das" class="mrv-verbatim">{{ das }}</pre>
      <p v-else class="mrv-empty">
        No Data Availability Statement was located in the converted manuscript.
      </p>
      <ModuleTechnical
        :job="job" :submission-id="submissionId" :job-type="jobType"
        :jobs="jobs || {}" :files="runDocuments"
      />
    </template>

    <template v-else-if="jobType === 'das_suggestions'">
      <div class="mrv-toolbar">
        <div class="mrv-chips">
          <button
            v-for="opt in dasStatusOptions"
            :key="opt.label"
            type="button"
            class="mrv-chip"
            :class="{ 'mrv-chip-off': dasFilter.size && !dasFilter.has(opt.label) }"
            v-tooltip="dasFilter.has(opt.label)
              ? 'Click to stop filtering on ' + opt.label
              : 'Click to show only ' + opt.label + ' checks (combine by clicking several)'"
            @click="toggleDasStatus(opt.label)"
          >
            {{ opt.label }}
            <span class="mrv-chip-count">{{ opt.count }}</span>
          </button>
        </div>
        <SearchInput v-model="search" placeholder="Search checks…" class="mrv-search" />
        </div>
      <DasSuggestionsTable :rows="visibleDasRows" :search="search" />
      <ModuleTechnical
        :job="job" :submission-id="submissionId" :job-type="jobType"
        :jobs="jobs || {}" :files="runDocuments"
      />
    </template>

    <template v-else-if="jobType === 'markdown_convert'">
      <MarkdownViewer
        :content="markdown"
        :length="markdownLength"
        :loading="markdownLoading"
        :error="markdownError"
      />
      <ModuleTechnical
        :job="job" :submission-id="submissionId" :job-type="jobType"
        :jobs="jobs || {}" :files="runDocuments"
      >
        <template v-if="markdownFileId" #files>
          <ul class="mrv-filelist">
            <li>
              <button type="button" class="mrv-linkish" @click="downloadMarkdown">
                {{ markdownFileName }} ↗
              </button>
              <span class="mrv-filenote">The converted text every other module reads.</span>
            </li>
          </ul>
        </template>
      </ModuleTechnical>
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


.mrv-runs {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  margin-left: 0.75rem;
}

.mrv-runs-label {
  font-size: 0.6875rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #6b7280;
}

.mrv-runs-select {
  font-size: 0.8125rem;
  padding: 0.125rem 0.375rem;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  background: #fff;
  color: #374151;
  max-width: 20rem;
}

/* Amber, and it stays on screen for as long as a past run is open. The colour
   the app already uses for "this needs your attention". */
.mrv-past {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  margin: 0 0 0.75rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid #fcd34d;
  border-radius: 0.5rem;
  background: #fffbeb;
  color: #92400e;
  font-size: 0.8125rem;
  line-height: 1.45;
}

.mrv-past-badge {
  flex: none;
  padding: 0.0625rem 0.5rem;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.7);
  font-size: 0.6875rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.mrv-past-text { flex: 1; }

.mrv-past-btn {
  flex: none;
  padding: 0.25rem 0.625rem;
  border: 1px solid #92400e;
  border-radius: 0.375rem;
  background: transparent;
  color: #92400e;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
}

.mrv-past-btn:hover { background: rgba(146, 64, 14, 0.08); }

.mrv-status {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  margin: 0 0 1rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid transparent;
  border-radius: 0.5rem;
  font-size: 0.8125rem;
  line-height: 1.45;
}

.mrv-status-label {
  flex: none;
  padding: 0.0625rem 0.5rem;
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  background: rgba(255, 255, 255, 0.65);
}

.mrv-status-detail { display: block; opacity: 0.9; }

.mrv-status-asat {
  display: block;
  margin-top: 0.25rem;
  font-size: 0.75rem;
  opacity: 0.75;
}

/* The palette the processes panel and the pipeline page use — one status must
   not be green in one place and grey in another. */
.mrv-status-good { background: #ecfdf5; border-color: #a7f3d0; color: #047857; }
.mrv-status-warn { background: #fffbeb; border-color: #fcd34d; color: #92400e; }
.mrv-status-bad  { background: #fef2f2; border-color: #fecaca; color: #b91c1c; }
.mrv-status-busy { background: #eff6ff; border-color: #bfdbfe; color: #1d4ed8; }
.mrv-status-idle { background: #f9fafb; border-color: #e5e7eb; color: #4b5563; }

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
.mrv-filelist { margin: 0; padding: 0; list-style: none; font-size: 0.8rem; }
.mrv-linkish {
  background: none; border: 0; padding: 0;
  color: #2563eb; font-size: 0.8rem; cursor: pointer;
}
.mrv-linkish:hover { text-decoration: underline; }
.mrv-filenote { color: #6b7280; font-size: 0.75rem; margin-left: 0.5rem; }
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
.mrv-error {
  color: #b91c1c; font-size: 0.85rem; padding: 0.6rem 0.75rem; margin: 0 0 1rem;
  background: #fef2f2; border: 1px solid #fecaca; border-radius: 0.375rem;
}
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

/* Retry, beside the title — the one action this page offers. */
.mrv-retry {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.35rem 0.7rem;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  background: #fff;
  color: #374151;
  font-size: 0.8rem;
  font-weight: 500;
}
.mrv-retry:hover:not(:disabled) { background: #f9fafb; border-color: #9ca3af; }
.mrv-retry-icon { width: 0.9rem; height: 0.9rem; }
.mrv-retry-off, .mrv-retry:disabled { opacity: 0.55; cursor: not-allowed; }
</style>
