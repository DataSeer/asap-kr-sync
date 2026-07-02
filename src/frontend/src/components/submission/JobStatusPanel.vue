<script setup>
/**
 * JobStatusPanel - Slim bar showing background job statuses
 *
 * Displays each job with a spinner/checkmark/X icon, label, and status.
 * Clicking a job opens a popup with details (richer for admin/ds_annotator).
 * Shows elapsed time, retry count, and timeout warnings.
 */
import { computed, inject, ref, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import Papa from 'papaparse'
import { useAuthStore } from '@/stores/auth.store'
import jobService from '@/services/job.service'
import fileService from '@/services/file.service'
import { useResourceTypesStore } from '@/stores/resourceTypes.store'

const emit = defineEmits(['edit-das'])
const route = useRoute()

const jobs = inject('submissionJobs', ref({}))
const restartJobFn = inject('restartJob', null)
// Reactive counter incremented by parent (PDFView) to force-expand the panel
// after meaningful events such as a fresh PDF upload.
const expandJobsSignal = inject('expandJobsSignal', ref(0))
const softwareMentions = inject('submissionSoftwareMentions', ref([]))
const submissionAuthors = inject('submissionAuthors', ref([]))
const submissionDatasets = inject('submissionDatasets', ref([]))
const submissionMaterials = inject('submissionMaterials', ref([]))
const submissionProtocols = inject('submissionProtocols', ref([]))
const serviceStatus = inject('serviceStatus', ref({}))
const authStore = useAuthStore()
const resourceTypesStore = useResourceTypesStore()

const restartingJobs = ref(new Set())

// Collapse/expand state — persisted in localStorage
const isCollapsed = ref(localStorage.getItem('job-panel-collapsed') === 'true')

function toggleCollapsed() {
  isCollapsed.value = !isCollapsed.value
  localStorage.setItem('job-panel-collapsed', isCollapsed.value.toString())
}

// Auto-expand when the parent signals an upload event. We don't persist this
// to localStorage — it's a one-shot reveal, the user can collapse again.
watch(expandJobsSignal, (val, prev) => {
  if (val !== prev && isCollapsed.value) {
    isCollapsed.value = false
    localStorage.setItem('job-panel-collapsed', 'false')
  }
})

// Computed summary for collapsed view
const jobSummary = computed(() => {
  const list = jobList.value
  const complete = list.filter(j => j.status === 'complete').length
  const running = list.filter(j => j.status === 'queued' || j.status === 'processing').length
  const failed = list.filter(j => j.status === 'failed').length
  const pending = list.filter(j => j.status === 'pending_input').length
  const waiting = list.filter(j => j.status === 'waiting').length
  const total = list.length
  return { complete, running, failed, pending, waiting, total }
})

// ── ETA computation ──────────────────────────────────────────────────
// Pipeline dependency map: each entry lists job types that must finish
// before this job can finish. Drives the cumulative remaining-time math
// so siblings run in parallel and downstream jobs stack on top of upstreams.
const ETA_DEPS = {
  pdf_analysis: ['das_extraction', 'software_detection', 'datasets_detection', 'materials_detection', 'protocols_detection', 'identifier_detection'],
  datasets_detection: ['markdown_convert'],
  protocols_detection: ['markdown_convert'],
  identifier_detection: ['markdown_convert']
}

const now = ref(Date.now())
let tickTimer = null

// Tick every second for live elapsed time
onMounted(() => {
  tickTimer = setInterval(() => { now.value = Date.now() }, 1000)
  // Resource-type order powers the modal tables' KRT-editor-style sorting
  // and the type filter; harmless if it fails (tables fall back to raw order).
  if (!resourceTypesStore.resourceTypeNames.length) {
    resourceTypesStore.fetchResourceTypeNames().catch(() => {})
  }
})
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
})

// Authors get a simplified modal: status, summary, results — no logs, no raw
// responses, no timestamps, no queue config, no restart button. PMs and staff
// see the full technical detail.
const canViewInternals = computed(() => authStore.canViewJobInternals)
const canRestartJobs = computed(() => authStore.canManageJobs)

// All known job types in display order
// Job types in display order (grouped logically). Modules whose
// `/api/config/services` entry reports `enabled: false` are hidden from the
// panel — that's how a module gets "permanently disabled" (e.g. setting
// MATERIALS_DETECTION_ENABLED=false in the env).
const ALL_JOB_TYPES = [
  // Row 1
  { type: 'das_extraction', label: 'DAS Extraction' },
  { type: 'software_detection', label: 'Software Detection' },
  { type: 'markdown_convert', label: 'Markdown Convert' },
  { type: 'orcid_extraction', label: 'ORCID Extraction' },
  // Row 2: markdown-dependent detectors + the consolidator
  { type: 'materials_detection', label: 'Materials Detection' },
  { type: 'datasets_detection', label: 'Datasets Detection' },
  { type: 'protocols_detection', label: 'Protocols Detection' },
  { type: 'identifier_detection', label: 'Identifiers Detection' },
  { type: 'pdf_analysis', label: 'PDF Analysis' },
  { type: 'suggestion_generation', label: 'AI Suggestions' }
]

// Unified modal state
const showModal = ref(false)
const modalContent = ref('')
const modalItems = ref(null)
const modalTableType = ref(null) // 'software' | 'resources' | 'authors' | null
const modalLogs = ref([])
const modalRawResponses = ref({})
const modalJobType = ref(null)
const modalExactMatchCount = ref(0)
// PDF Analysis: candidates the LM dropped (not kept in the Generated KRT).
const modalDropped = ref([])
// Modal table controls: text search + resource-type filter (mirrors the KRT
// editor so curators can find a line without scanning the whole table).
const modalSearch = ref('')
const modalTypeFilter = ref('all')

// Display-side scrub of internal references that leak into LM reasons —
// candidate "ref" numbers (PDF Analysis) and raw KRT row UUIDs (AI Suggestions).
// Applied at render time so already-saved results read cleanly too.
function cleanReason(reason) {
  if (!reason) return ''
  return String(reason)
    // internal candidate refs ("refs 0 and 4")
    .replace(/\(?\s*\brefs?\b\s*#?\s*\d+(\s*(?:,|and|&|\/)\s*#?\s*\d+)*\s*\)?/gi, '')
    // raw KRT row UUIDs: "(row a3d12…)" → drop; "row a3d12…" → friendly text; bare → drop
    .replace(/\(\s*(?:row\s+)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*\)/gi, '')
    .replace(/\brow\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'the matching author row')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/^[\s,;:–-]+|[\s,;:–-]+$/g, '')
    .trim()
}

/**
 * Get service status info for a job type
 */
function getServiceInfo(type) {
  const svc = serviceStatus.value?.[type]
  if (!svc) return null
  return svc
}

const jobList = computed(() => {
  const map = jobs.value || {}
  return ALL_JOB_TYPES.map(({ type, label }) => {
    const job = map[type]
    const svcInfo = getServiceInfo(type)
    const svc = job?.result?.service || null
    return {
      type,
      label,
      status: job?.status || null,
      waitingReason: job?.waitingReason || null,
      result: job?.result || null,
      errorMessage: job?.errorMessage || null,
      retryCount: job?.retryCount || 0,
      startedAt: job?.startedAt || null,
      completedAt: job?.completedAt || null,
      createdAt: job?.createdAt || null,
      elapsedMs: job?.elapsedMs || null,
      config: job?.config || null,
      logs: job?.logs || [],
      files: job?.files || {},
      // Live config (used for the config pill before any job has run)
      liveConfigState: svcInfo?.state || null,    // 'on' | 'demo' | 'off' | null
      liveEnabled: svcInfo?.enabled ?? null,
      liveDemoEnabled: svcInfo?.hasDemoData ?? false,
      // Persisted execution snapshot (config + outcome)
      configState: svc?.config?.state ?? null,     // 'on' | 'demo' | 'off' | null
      outcomeState: svc?.outcome?.state ?? null,   // 'done' | 'fail' | null
      outcomeSource: svc?.outcome?.source ?? null, // 'external' | 'demo' | null
      outcomeFailReason: svc?.outcome?.failReason ?? null,
      outcomeExternalError: svc?.outcome?.externalError ?? null,
      serviceSubServices: svcInfo?.subServices || null
    }
  })
  // Hide modules that are fully off — both the external service AND demo
  // data are disabled (env: <MODULE>_ENABLED=false AND <MODULE>_DEMO_DATA_ENABLED=false).
  // We honor either the live flags from /api/config/services or the persisted
  // execution snapshot, so the module disappears immediately on initial render
  // without flash-then-hide once /api/config/services lands.
  .filter(j => {
    const liveOff = j.liveEnabled === false && j.liveDemoEnabled === false
    const persistedOff = j.configState === 'off'
    return !(liveOff || persistedOff)
  })
})

// ── ETA bar computation ──────────────────────────────────────────────
//
// Shows a TYPICAL → MAX range ("30s to 3 min remaining"). Typical comes
// from the backend's per-job `typicalSeconds` (median runtime); max comes
// from `expireInSeconds` (per-attempt timeout cap). The progress bar fills
// based on typical so it moves at a meaningful pace; if typical is exhausted
// the bar pins and the label switches to "still working — up to X remaining".
function jobRemainingMs(job, which) {
  if (!job) return 0
  if (job.status === 'pending_input') return 0
  if (job.status === 'complete' || job.status === 'failed') return 0

  const budgetSec = which === 'typical' ? job.typicalSeconds : job.expireInSeconds
  if (!budgetSec) return 0
  const budgetMs = budgetSec * 1000

  if (job.status === 'waiting' || job.status === 'queued') return budgetMs

  const start = job.startedAt ? new Date(job.startedAt).getTime() : null
  if (!start) return budgetMs
  const elapsed = now.value - start
  return Math.max(0, budgetMs - elapsed)
}

function effectiveRemainingMs(type, jobMap, which, seen = new Set()) {
  if (seen.has(type)) return 0
  seen.add(type)
  const own = jobRemainingMs(jobMap[type], which)
  const deps = ETA_DEPS[type] || []
  let upstream = 0
  for (const dep of deps) {
    const depRemaining = effectiveRemainingMs(dep, jobMap, which, seen)
    if (depRemaining > upstream) upstream = depRemaining
  }
  return upstream + own
}

function pipelineRemainingMs(jobMap, which) {
  // pdf_analysis is the terminal job — its effective-remaining already
  // includes every upstream dep chain. Fall back to max across all jobs
  // when pdf_analysis hasn't been scheduled yet.
  const anchored = effectiveRemainingMs('pdf_analysis', jobMap, which)
  if (anchored > 0) return anchored
  let max = 0
  for (const type of Object.keys(jobMap)) {
    const r = effectiveRemainingMs(type, jobMap, which)
    if (r > max) max = r
  }
  return max
}

const etaJobMap = computed(() => {
  // Use the raw jobs map (not the post-filter jobList) so the ETA still
  // covers disabled modules' upstream blocking. Same data shape.
  return jobs.value || {}
})
const remainingTypicalMs = computed(() => pipelineRemainingMs(etaJobMap.value, 'typical'))
const remainingMaxMs = computed(() => pipelineRemainingMs(etaJobMap.value, 'max'))

const anyInFlight = computed(() => {
  const list = Object.values(etaJobMap.value)
  return list.some(j =>
    j.status === 'waiting' || j.status === 'queued' || j.status === 'processing'
  )
})

const anyPendingInput = computed(() => {
  const list = Object.values(etaJobMap.value)
  return list.some(j => j.status === 'pending_input')
})

// True when there are tracked jobs AND every one of them has reached a
// terminal state. Used to render the bar fully filled (in a success color)
// so the panel always communicates *something* even when collapsed and
// idle — rather than going visually empty after the pipeline finishes.
const allDone = computed(() => {
  const list = Object.values(etaJobMap.value).filter(j => !!j?.status)
  if (list.length === 0) return false
  return list.every(j => j.status === 'complete' || j.status === 'failed')
})

// Render the bar whenever there's anything to report — in-flight, waiting
// for input, OR all done. Empty (no jobs at all) hides the bar entirely.
const etaVisible = computed(() => {
  if (anyInFlight.value || anyPendingInput.value) return true
  if (allDone.value) return true
  return false
})

function formatEtaDuration(ms) {
  if (ms <= 0) return '0s'
  const totalSec = Math.ceil(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.ceil(totalSec / 60)
  return min === 1 ? '1 min' : `${min} min`
}

const etaLabel = computed(() => {
  if (anyPendingInput.value && !anyInFlight.value) return 'Waiting for input'
  if (allDone.value) return 'All processes complete'
  if (!anyInFlight.value) return 'Finishing up…'

  const typical = remainingTypicalMs.value
  const max = remainingMaxMs.value

  if (typical <= 0 && max > 0) return `still working — up to ${formatEtaDuration(max)} remaining`
  if (typical <= 0 && max <= 0) return 'Finishing up…'

  return `${formatEtaDuration(typical)} to ${formatEtaDuration(max)} remaining`
})

/**
 * Progress fraction across the whole pipeline, weighted by each job's
 * typical duration. Computed from the persisted job states (and elapsed
 * time for running jobs), NOT from a session-local peak — so a fresh page
 * load already reflects whatever's done. Falls back to 0 when no typicals
 * are known yet.
 *
 * numerator   = completed/failed jobs' full typical + processing jobs'
 *               elapsed portion of their typical
 * denominator = sum of every visible job's typical
 */
function jobTypicalMs(job) {
  return (job?.typicalSeconds || 0) * 1000
}
function jobIsDone(job) {
  return job?.status === 'complete' || job?.status === 'failed'
}
const etaProgress = computed(() => {
  const map = etaJobMap.value
  let total = 0
  let done = 0
  for (const job of Object.values(map)) {
    const budget = jobTypicalMs(job)
    if (budget === 0) continue
    total += budget
    if (jobIsDone(job)) {
      done += budget
    } else if (job?.status === 'processing') {
      // Count the elapsed slice of an in-flight job so the bar grows smoothly
      // while a single long-running job is the only thing left.
      done += Math.max(0, budget - jobRemainingMs(job, 'typical'))
    }
  }
  if (total === 0) return 0
  return Math.max(0, Math.min(1, done / total))
})

/**
 * The On / Demo / Off pill on line 1.
 *
 * After a job has run we trust the persisted snapshot (`config.state`) — it
 * reflects how the env was configured at execution time. Before the first run
 * we fall back to the live `/api/config/services` value.
 */
function getConfigPill(job) {
  return job.configState || job.liveConfigState || null
}

// Unified modal state
const activeJob = ref(null)

/**
 * Compute live elapsed time for a job
 */
function getElapsed(job) {
  if (job.status === 'processing' || job.status === 'queued') {
    const start = job.startedAt || job.createdAt
    if (!start) return null
    return now.value - new Date(start).getTime()
  }
  // For complete/failed, use server-computed elapsed
  return job.elapsedMs
}

/**
 * Format milliseconds to human-readable duration
 */
function formatDuration(ms) {
  if (!ms || ms < 0) return null
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}m ${sec}s`
}

/**
 * Check if job is taking too long (past 50% of per-attempt expiry)
 */
function isSlowJob(job) {
  if (job.status !== 'processing' && job.status !== 'queued') return false
  const elapsed = getElapsed(job)
  const expiry = job.config?.expireInSeconds
  if (!elapsed || !expiry) return false
  return elapsed > expiry * 500 // 50% of per-attempt expiry (expiry is seconds, elapsed is ms)
}

/**
 * CSS class for the line-2 outcome badge.
 *
 * In-progress statuses keep their existing colors (running, waiting, etc.).
 * Completed jobs read from `outcomeState` ('done' or 'fail').
 * markFailed jobs (true unexpected errors, distinct from a workflow Fail
 * outcome) keep the red 'failed' styling.
 */
function getResultBadgeClass(job) {
  const slow = isSlowJob(job)

  if (job.status === 'waiting') return { 'job-status-waiting': true, 'job-status-slow': slow }
  if (job.status === 'pending_input') return { 'job-status-pending-input': true }
  if (job.status === 'queued' || job.status === 'processing') return { 'job-status-running': true, 'job-status-slow': slow }
  if (job.status === 'failed') return { 'job-status-failed': true }

  if (job.status === 'complete') {
    if (job.outcomeState === 'done') return { 'job-status-complete': true }
    if (job.outcomeState === 'fail') return { 'job-status-failed': true }
    // No outcome on a completed row should not happen post-migration, but
    // fall through to neutral if it does.
    return { 'job-status-idle': true }
  }

  // Not started yet — neutral
  return { 'job-status-idle': true }
}

/**
 * Text for the line-2 outcome badge. Two terminal labels — Done or Fail —
 * plus the existing in-progress labels. Configuration ('On'/'Demo'/'Off') is
 * shown by the line-1 pill, never here.
 */
function getResultBadgeText(job) {
  if (!job.status) return 'Not started'
  if (job.status === 'pending_input') return 'Needs input'
  if (job.status === 'waiting') return 'Waiting'
  if (job.status === 'queued') return 'Queued'
  // Show 'Processing' as the badge label while running — the elapsed time
  // already appears as the grey sub-label next to it (getResultSummary).
  if (job.status === 'processing') return 'Processing'
  if (job.status === 'failed') return 'Failed'

  if (job.status === 'complete') {
    if (job.outcomeState === 'done') return 'Done'
    if (job.outcomeState === 'fail') return 'Fail'
    return 'Done'
  }

  return 'Failed'
}

/**
 * CSS class for the line-1 config pill. Reuses the modal palette so the pill
 * looks identical in panel and modal.
 */
function getConfigPillClass(job) {
  const state = getConfigPill(job)
  if (state === 'on') return 'job-service-badge job-service-on'
  if (state === 'demo') return 'job-service-badge job-service-demo'
  return 'job-service-badge job-service-disabled'
}

function getConfigPillText(job) {
  const state = getConfigPill(job)
  return (state || 'off').toUpperCase()
}

/**
 * Get a short result summary string for the job result line.
 * @param {object} job
 * @returns {string|null}
 */
function getResultSummary(job) {
  if (!job.status) return null
  if (job.status === 'queued') return null
  if (job.status === 'processing') return formatDuration(getElapsed(job)) || null
  if (job.status === 'waiting') return null
  if (job.status === 'pending_input') return null
  if (job.status === 'failed') return job.errorMessage ? job.errorMessage.substring(0, 60) : null

  // Completed — build summary from result data
  if (job.status !== 'complete') return null
  const r = job.result
  if (!r) return null

  // Workflow-level Fail: show the reason rather than data counts.
  if (job.outcomeState === 'fail') return formatFailReason(job.outcomeFailReason)

  // Off + Done: process is intentionally disabled and nothing was attempted.
  // Showing a "0 mentions" data summary here would imply the process ran and
  // found nothing, which is misleading.
  if (job.outcomeState === 'done' && job.outcomeSource === null) return 'Process is disabled'

  const dataSummary = getDataSummary(job, r)

  // For demo-source rows, prepend a "via demo" hint so the user sees how the
  // data was produced without opening the modal. External Fail-after-retries
  // is captured by outcomeExternalError.
  const sourceHint = job.outcomeSource === 'demo'
    ? (job.outcomeExternalError ? 'via demo (external failed)' : 'via demo')
    : null
  if (sourceHint && dataSummary) return `${sourceHint} — ${dataSummary}`
  return dataSummary
}

// Short detection-module labels for the AI Suggestions summary "Modules" column.
const SOURCE_SHORT = {
  software_detection: 'SW',
  datasets_detection: 'DS',
  materials_detection: 'MAT',
  protocols_detection: 'PROT',
  identifier_detection: 'ID',
  pdf_analysis: 'PDF'
}
// Label a row in the AI Suggestions summary — handles both decision objects
// ({action}) and raw suggestion objects ({type}).
function suggestionDecisionLabel(item) {
  const a = item.action || item.type
  const map = { add: 'Add', skip: 'Skip', update: 'Update', remove: 'Remove', add_row: 'Add', edit: 'Update', delete_row: 'Remove' }
  return map[a] || a || '—'
}

// The KRT columns shown for each AI-suggestion decision (the concerned row).
const SUGGESTION_ROW_COLUMNS = [
  { key: 'resourceType', label: 'Resource Type' },
  { key: 'resourceName', label: 'Resource Name' },
  { key: 'source', label: 'Source' },
  { key: 'identifier', label: 'Identifier' },
  { key: 'newReuse', label: 'New/Reuse' }
]
// Value for one column of a decision's row. Prefers the structured `row`
// (new shape); falls back to the resource name / raw suggestion data for
// older results so the table still renders.
function suggestionCellValue(item, key) {
  if (item.row && item.row[key] != null && item.row[key] !== '') return item.row[key]
  if (key === 'resourceName') return item.resourceName || item.title || item.data?.resourceName || ''
  if (item.data && item.data[key] != null) return item.data[key]
  return ''
}

// Expand each AI-suggestion decision into the KRT row(s) to display:
//  - the matched Author KRT row (skip / update / remove) is always shown,
//  - the Generated row is also shown for add / update (with the diff),
// so a curator sees the concerned author entry — and, for changes, both sides.
const suggestionDisplayRows = computed(() => {
  if (modalTableType.value !== 'suggestions') return []
  // KRT-editor ordering + type filter + search operate on whole decisions
  // (each decision expands to 1-2 display rows below).
  let items = [...(modalItems.value || [])]
  items.sort((a, b) => compareTypes(suggestionDecisionType(a), suggestionDecisionType(b)))
  if (modalTypeFilter.value !== 'all') {
    items = items.filter(d => suggestionDecisionType(d) === modalTypeFilter.value)
  }
  const q = modalSearch.value.trim().toLowerCase()
  if (q) {
    items = items.filter(d => {
      const fields = [d.action || d.type, d.reason || d.description, d.resourceName]
      for (const cells of [d.authorRow, d.generatedRow, d.row]) {
        if (cells) fields.push(...Object.values(cells))
      }
      return rowMatchesSearch(fields, q)
    })
  }
  const out = []
  items.forEach((d, gi) => {
    const action = d.action || d.type
    const isUpdate = action === 'update' || action === 'edit'
    const isAdd = action === 'add' || action === 'add_row'
    const entities = []
    if (d.authorRow) entities.push({ role: 'Author', side: 'author', cells: d.authorRow })
    if (d.generatedRow && (isAdd || isUpdate)) entities.push({ role: 'Generated', side: 'generated', cells: d.generatedRow })
    // skip/old data with no author match → show whatever single row we have
    if (entities.length === 0 && d.generatedRow) entities.push({ role: 'Generated', side: 'generated', cells: d.generatedRow })
    if (entities.length === 0) {
      const cells = d.row || { resourceName: d.resourceName || d.title || (d.data && d.data.resourceName) || '' }
      entities.push({ role: '', side: 'author', cells })
    }
    entities.forEach((e, ei) => {
      out.push({
        decision: d, role: e.role, side: e.side, cells: e.cells, changes: d.changes || null,
        groupIndex: gi, isGroupStart: ei === 0
      })
    })
  })
  return out
})

/**
 * Per-job-type data count summary. Pure function of the persisted result;
 * has no notion of source/outcome (those are layered on by getResultSummary).
 */
function getDataSummary(job, r) {
  switch (job.type) {
    case 'das_extraction': {
      if (!r.status?.detected) return 'DAS not found'
      const len = r.data?.das?.length || 0
      return `DAS extracted (${len} chars)`
    }
    case 'pdf_analysis': {
      // The worker stores the merged resource count under `counts.resources`
      // (see services/queue/workers.js — `m.resourceCount` from mergeDetections).
      // `counts.findings` was the legacy key and is no longer populated.
      const count = r.counts?.resources ?? r.counts?.findings ?? 0
      if (count === 1) return '1 Entry found'
      return `${count} Entries found`
    }
    case 'software_detection': {
      const unique = r.counts?.unique || 0
      const enriched = r.counts?.enriched || 0
      if (unique === 0) return 'No mentions'
      return `${unique} unique mention${unique > 1 ? 's' : ''}${enriched > 0 ? `, ${enriched} enriched` : ''}`
    }
    case 'orcid_extraction': {
      const authors = r.counts?.authors || 0
      const orcids = r.counts?.orcids || 0
      if (authors === 0) return 'No authors found'
      return `${authors} author${authors > 1 ? 's' : ''}, ${orcids} ORCID${orcids > 1 ? 's' : ''}`
    }
    case 'markdown_convert': {
      if (!r.status?.detected) return 'Not converted'
      const len = r.data?.markdownLength || 0
      const provider = r.data?.provider
      return `Converted${len > 0 ? ` (${len.toLocaleString()} chars)` : ''}${provider ? ` via ${provider}` : ''}`
    }
    case 'datasets_detection': {
      const total = r.counts?.unique || r.counts?.total || 0
      const high = r.counts?.highRelevance || 0
      if (total === 0) return 'No datasets'
      return `${total} dataset${total > 1 ? 's' : ''}${high > 0 ? `, ${high} high relevance` : ''}`
    }
    case 'materials_detection': {
      const total = r.counts?.unique || r.counts?.total || 0
      const high = r.counts?.highRelevance || 0
      if (total === 0) return 'No materials'
      return `${total} material${total > 1 ? 's' : ''}${high > 0 ? `, ${high} high relevance` : ''}`
    }
    case 'protocols_detection': {
      const total = r.counts?.unique || r.counts?.total || 0
      const high = r.counts?.highRelevance || 0
      if (total === 0) return 'No protocols'
      return `${total} protocol${total > 1 ? 's' : ''}${high > 0 ? `, ${high} high relevance` : ''}`
    }
    case 'identifier_detection': {
      const total = r.counts?.unique || r.counts?.total || 0
      const high = r.counts?.highRelevance || 0
      if (total === 0) return 'No identifiers'
      return `${total} match${total > 1 ? 'es' : ''}${high > 0 ? `, ${high} high relevance` : ''}`
    }
    case 'suggestion_generation': {
      const total = r.counts?.unique || r.counts?.total || 0
      if (total === 0) return 'No suggestions'
      return `${total} suggestion${total > 1 ? 's' : ''}`
    }
    default:
      return null
  }
}

/**
 * Human-readable text for the helper's failReason codes. Mirrors the four
 * fail paths defined in demo-fallback.service.js.
 */
function formatFailReason(reason) {
  const map = {
    external_failed_no_demo_data: 'External service failed and no demo data is available for this manuscript',
    external_failed_demo_disabled: 'External service failed; demo fallback is disabled',
    process_off_no_demo_data: 'Process is disabled; no demo data is available for this manuscript'
  }
  return map[reason] || 'Process did not produce a result'
}

/**
 * Tooltip for the line-1 config pill. Explains what On/Demo/Off mean for this
 * specific job type so the user understands the badge without opening docs.
 */
function getLiveConfigTitle(job) {
  const state = getConfigPill(job)
  if (state === 'on') {
    return job.liveDemoEnabled
      ? `${job.label}: external service is enabled (demo data is the fallback)`
      : `${job.label}: external service is enabled`
  }
  if (state === 'demo') return `${job.label}: external service is disabled \u2014 demo data is the only source`
  return `${job.label}: external service and demo data are both disabled`
}

/**
 * Get the result tooltip text for line 2.
 */
function getResultTitle(job) {
  const summary = getResultSummary(job)
  const base = `Results of ${job.label}`
  if (!job.status) return base
  const badge = getResultBadgeText(job)
  return summary ? `${base}: ${badge} \u2014 ${summary}` : `${base}: ${badge}`
}

/**
 * Build a human-readable detail string for the popup.
 */
/**
 * Find which jobs this job is waiting for (from pipeline dependencies)
 */
function getWaitingFor(job) {
  const deps = {
    das_extraction: ['markdown_convert'],
    pdf_analysis: ['das_extraction'],
    datasets_detection: ['markdown_convert'],
    materials_detection: ['markdown_convert'],
    protocols_detection: ['markdown_convert'],
    identifier_detection: ['markdown_convert'],
    suggestion_generation: ['pdf_analysis']
  }
  return deps[job.type] || []
}

function getJobDetail(job) {
  if (!job.status) return 'Not started yet'
  if (job.status === 'pending_input') {
    if (job.type === 'pdf_analysis') {
      return 'Waiting for Availability Statement — please enter it manually, then start the analysis.'
    }
    return 'Waiting for user input before proceeding.'
  }
  if (job.status === 'waiting') {
    if (job.waitingReason === 'krt_validation') {
      return 'Waiting for the Key Resources Table to be validated — complete the KRT step to start this analysis.'
    }
    const deps = getWaitingFor(job)
    if (deps.length) {
      const labels = deps.map(d => {
        const found = ALL_JOB_TYPES.find(j => j.type === d)
        return found ? found.label : d
      })
      return `Waiting for ${labels.join(', ')}...`
    }
    return 'Waiting for dependencies...'
  }
  if (job.status === 'queued') return 'Waiting in queue...'
  if (job.status === 'processing') return 'Processing...'

  if (job.status === 'failed') {
    return job.errorMessage || 'Unknown error'
  }

  // Complete — return result description without "Done —" prefix
  if (job.type === 'das_extraction') {
    if (!job.result) return null
    return job.result.status?.detected
      ? 'Availability Statement found'
      : 'Availability Statement not found'
  }

  if (job.type === 'pdf_analysis') {
    if (!job.result) return null
    const count = job.result.counts?.findings
    if (count !== undefined) {
      return `${count} suggestion${count !== 1 ? 's' : ''} found`
    }
    return null
  }

  if (job.type === 'software_detection') {
    if (!job.result) return null
    const uniqueCount = job.result.counts?.unique
    if (uniqueCount !== undefined) {
      return `${uniqueCount} software mention${uniqueCount !== 1 ? 's' : ''} found`
    }
    return null
  }

  if (job.type === 'datasets_detection' || job.type === 'materials_detection' || job.type === 'protocols_detection' || job.type === 'identifier_detection') {
    if (!job.result) return null
    const totalCount = job.result.counts?.total
    const suggestionsCount = job.result.counts?.suggestions
    const label = job.type === 'datasets_detection' ? 'dataset'
      : job.type === 'materials_detection' ? 'material'
      : job.type === 'protocols_detection' ? 'protocol'
      : 'identifier match'
    if (totalCount !== undefined) {
      const parts = [`${totalCount} ${label}${totalCount !== 1 ? 's' : ''} detected`]
      if (suggestionsCount) parts.push(`${suggestionsCount} suggestion${suggestionsCount !== 1 ? 's' : ''}`)
      return parts.join(', ')
    }
    return null
  }

  if (job.type === 'orcid_extraction') {
    if (!job.result) return null
    const orcidCount = job.result.counts?.orcids
    const authorCount = job.result.counts?.authors
    if (orcidCount !== undefined && authorCount !== undefined) {
      return `${orcidCount}/${authorCount} ORCIDs found`
    }
    return null
  }

  if (job.type === 'markdown_convert') {
    if (!job.result) return null
    if (job.result.status?.detected) {
      const len = job.result.data?.markdownLength || 0
      const display = len > 1000 ? `${Math.round(len / 1000)}K` : len
      return `Converted (${display} chars)`
    }
    return 'Conversion skipped'
  }

  return null
}

/**
 * Open the unified job detail modal
 */
function openJobModal(job) {
  activeJob.value = job
  modalJobType.value = job.type
  modalLogs.value = job.logs || []
  modalRawResponses.value = job.files || {}
  modalExactMatchCount.value = job.result?.counts?.exactMatch || 0
  modalDropped.value = job.type === 'pdf_analysis' ? (job.result?.data?.meta?.dropped || []) : []

  // Populate result data based on job type
  if (job.type === 'das_extraction') {
    modalContent.value = job.result?.data?.das || ''
    modalItems.value = null
    modalTableType.value = null
  } else if (job.type === 'software_detection') {
    modalContent.value = ''
    modalTableType.value = 'software'
    const items = softwareMentions.value?.length ? softwareMentions.value : (job.result?.data?.items || [])
    modalItems.value = items.length ? items : null
  } else if (job.type === 'datasets_detection') {
    modalContent.value = ''
    modalTableType.value = 'resources'
    const items = submissionDatasets.value?.length ? submissionDatasets.value : (job.result?.data?.items || [])
    modalItems.value = items.length ? items : null
  } else if (job.type === 'materials_detection') {
    modalContent.value = ''
    modalTableType.value = 'resources'
    const items = submissionMaterials.value?.length ? submissionMaterials.value : (job.result?.data?.items || [])
    modalItems.value = items.length ? items : null
  } else if (job.type === 'protocols_detection') {
    modalContent.value = ''
    modalTableType.value = 'resources'
    const items = submissionProtocols.value?.length ? submissionProtocols.value : (job.result?.data?.items || [])
    modalItems.value = items.length ? items : null
  } else if (job.type === 'identifier_detection') {
    // Identifier-scan emits KRT-shaped items the same way the other
    // detectors do, so the generic 'resources' table renders them.
    modalContent.value = ''
    modalTableType.value = 'resources'
    const items = job.result?.data?.items || []
    modalItems.value = items.length ? items : null
  } else if (job.type === 'orcid_extraction') {
    modalContent.value = ''
    modalTableType.value = 'authors'
    modalItems.value = submissionAuthors.value?.length ? submissionAuthors.value : null
  } else if (job.type === 'pdf_analysis') {
    // Generated KRT consolidated from every detection. Each merged item
    // carries detectedBy[] (one entry per source that contributed) so the
    // modal can flatten back to the pre-merge view + flag duplicates.
    modalContent.value = ''
    modalTableType.value = 'pdf_analysis_krt'
    const items = job.result?.data?.items || []
    modalItems.value = items.length ? items : null
  } else if (job.type === 'suggestion_generation') {
    // The LM comparison's full decision log (add/update/remove/skip) + reasons.
    // Falls back to the suggestion list for older results without decisions.
    modalContent.value = ''
    modalTableType.value = 'suggestions'
    const items = job.result?.data?.decisions?.length
      ? job.result.data.decisions
      : (job.result?.data?.suggestions || [])
    modalItems.value = items.length ? items : null
  } else {
    modalItems.value = null
    modalTableType.value = null
    modalContent.value = ''
  }

  // Fresh filters per modal open
  modalSearch.value = ''
  modalTypeFilter.value = 'all'

  showModal.value = true
}

function closeModal() {
  showModal.value = false
  activeJob.value = null
  modalContent.value = ''
  modalItems.value = null
  modalTableType.value = null
  modalLogs.value = []
  modalRawResponses.value = {}
  modalJobType.value = null
  modalExactMatchCount.value = 0
  modalSearch.value = ''
  modalTypeFilter.value = 'all'
}

// ── PDF Analysis modal: pre-merge KRT view ─────────────────────────
//
// modalItems for pdf_analysis is the merged Generated KRT — each entry has
// detectedBy[{source, originalItem, confidence}, ...]. The modal shows the
// PRE-merge view: one row per detection contribution. Rows whose merged
// parent had >1 contributor are tagged "duplicate" so the user can see
// which detections collided.
const PDF_ANALYSIS_SOURCE_LABELS = {
  software_detection:   'Software',
  datasets_detection:   'Datasets',
  materials_detection:  'Materials',
  protocols_detection:  'Protocols',
  identifier_detection: 'ID'
}

function pdfAnalysisSourceLabel(source) {
  return PDF_ANALYSIS_SOURCE_LABELS[source] || source
}

// ── Modal table search / type filter / KRT-editor ordering ─────────

/**
 * Compare two resource-type names in the KRT editor's display order:
 * tab-group order first, then per-type sort_order from the DB. Ties return 0
 * so stable sorts preserve the rows' original relative order (same rule the
 * editor applies).
 */
function compareTypes(a, b) {
  const ga = resourceTypesStore.getGroupSortOrder(a)
  const gb = resourceTypesStore.getGroupSortOrder(b)
  if (ga !== gb) return ga - gb
  return resourceTypesStore.getTypeSortOrder(a) - resourceTypesStore.getTypeSortOrder(b)
}

function rowMatchesSearch(fields, query) {
  return fields.some(f => (f || '').toString().toLowerCase().includes(query))
}

/** Resource type a suggestion decision belongs to (author row wins). */
function suggestionDecisionType(d) {
  return (d.authorRow && d.authorRow.resourceType)
    || (d.generatedRow && d.generatedRow.resourceType)
    || ''
}

// Distinct resource types present in the open table, in KRT-editor order —
// the options of the type-filter select.
const modalTypeOptions = computed(() => {
  let types = []
  if (modalTableType.value === 'resources' || modalTableType.value === 'software') {
    types = (modalItems.value || []).map(it => it.resourceType || it.resource_type || (modalTableType.value === 'software' ? 'Software/code' : ''))
  } else if (modalTableType.value === 'pdf_analysis_krt') {
    types = (modalItems.value || []).map(it => it.resourceType || '')
  } else if (modalTableType.value === 'suggestions') {
    types = (modalItems.value || []).map(suggestionDecisionType)
  }
  return [...new Set(types.filter(Boolean))].sort(compareTypes)
})

// Mentions (software/datasets/materials/protocols), sorted in the KRT
// editor's order, then type-filtered and searched across visible columns.
const displayedModalItems = computed(() => {
  if (modalTableType.value !== 'resources' && modalTableType.value !== 'software') {
    return modalItems.value || []
  }
  const typeOf = (it) => it.resourceType || it.resource_type || (modalTableType.value === 'software' ? 'Software/code' : '')
  let items = [...(modalItems.value || [])].sort((a, b) => compareTypes(typeOf(a), typeOf(b)))
  if (modalTypeFilter.value !== 'all') {
    items = items.filter(it => typeOf(it) === modalTypeFilter.value)
  }
  const q = modalSearch.value.trim().toLowerCase()
  if (q) {
    items = items.filter(it => rowMatchesSearch([
      typeOf(it), getMentionName(it),
      it.source || it.suggestedURL || it.url,
      it.identifier || it.RRID || it.suggestedRRID,
      it.newReuse,
      it.additionalInformation || it.additional_information
    ], q))
  }
  return items
})

// Authors table: search only (no resource types here).
const displayedAuthorItems = computed(() => {
  if (modalTableType.value !== 'authors') return modalItems.value || []
  const q = modalSearch.value.trim().toLowerCase()
  if (!q) return modalItems.value || []
  return (modalItems.value || []).filter(it => rowMatchesSearch([
    it.fullName, it.firstName, it.lastName, it.orcid, it.affiliation, it.source
  ], q))
})

const pdfAnalysisRows = computed(() => {
  if (modalTableType.value !== 'pdf_analysis_krt') return []
  const items = modalItems.value || []
  const rows = []
  // Stable group ordering: each merged item becomes one group; rows for the
  // same group are emitted consecutively so the template can mark group
  // boundaries with `isGroupStart` and the CSS can shade alternating groups.
  let groupIndex = 0
  for (const merged of items) {
    const contributors = merged.detectedBy || []
    const isDuplicate = contributors.length > 1
    const groupSize = Math.max(contributors.length, 1)
    // Single-contributor merged items still show one row (no "duplicate"
    // badge). Multi-contributor items emit one row per contributor — each
    // row pulls display fields from its own originalItem so the user sees
    // exactly what each detection produced (source-specific shapes vary).
    if (contributors.length === 0) {
      rows.push({
        source: null,
        resourceType: merged.resourceType || '',
        resourceName: merged.resourceName || '',
        identifier: merged.identifier || '',
        sourceUrl: merged.sourceUrl || '',
        newReuse: (merged.newReuse || '').toLowerCase(),
        additionalInformation: merged.additionalInformation || '',
        reason: cleanReason(merged.reason),
        isDuplicate: false,
        dedupKey: merged.dedupKey,
        groupIndex,
        groupNumber: groupIndex + 1,
        finalName: merged.resourceName || '',
        groupSize: 1,
        isGroupStart: true,
        isGroupEnd: true
      })
      groupIndex++
      continue
    }
    contributors.forEach((c, j) => {
      const orig = c.originalItem || {}
      const d = orig.data || orig
      rows.push({
        source: c.source,
        resourceType: d.resourceType || d.resource_type || merged.resourceType || '',
        resourceName: d.canonical_name || d.resourceName || d.resource_name || d.name || merged.resourceName || '',
        identifier: d.identifier || d.RRID || d.suggestedRRID || merged.identifier || '',
        sourceUrl: d.source || d.url || d.suggestedURL || merged.sourceUrl || '',
        newReuse: String(d.newReuse || d.new_reuse || merged.newReuse || '').toLowerCase(),
        additionalInformation: d.additionalInformation || d.additional_information || merged.additionalInformation || '',
        reason: cleanReason(merged.reason),
        isDuplicate,
        dedupKey: merged.dedupKey,
        groupIndex,
        groupNumber: groupIndex + 1,
        finalName: merged.resourceName || '',
        groupSize,
        isGroupStart: j === 0,
        isGroupEnd:   j === contributors.length - 1
      })
    })
    groupIndex++
  }
  return rows
})

// How many KRT rows were merged from more than one detection module.
const pdfAnalysisMergedGroups = computed(() =>
  pdfAnalysisRows.value.filter(r => r.isGroupStart && r.groupSize > 1).length
)

/**
 * Trigger a browser download of a Blob with the given filename.
 * Used by both CSV and JSON export from the PDF Analysis modal.
 */
function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function downloadPdfAnalysisCsv() {
  const rows = pdfAnalysisRows.value
  if (!rows.length) return
  const csvData = rows.map(r => ({
    // Rows that share "KRT Row" are the SAME final Generated KRT row — one line
    // per detection module that found it. "Final KRT Name" is the canonical
    // name that row carries; "Detected Name" is what each module produced.
    'KRT Row': r.groupNumber,
    'Detections in Row': r.groupSize,
    'Detection Source': r.source ? pdfAnalysisSourceLabel(r.source) : '',
    'Resource Type': r.resourceType,
    'Detected Name': r.resourceName,
    'Final KRT Name': r.finalName,
    'Source': r.sourceUrl,
    'Identifier': r.identifier,
    'New/Reuse': r.newReuse,
    'Additional Information': r.additionalInformation,
    'Dedup Key': r.dedupKey || ''
  }))
  // Neutralize spreadsheet formula triggers: these cells derive from LM
  // analysis of an author-uploaded manuscript, so a value like =HYPERLINK(...)
  // must not execute when a curator opens the export in Excel.
  const guarded = csvData.map(row => Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
    ])
  ))
  const csv = Papa.unparse(guarded)
  // BOM prefix so Excel opens UTF-8 cleanly without mangling accented chars.
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' })
  triggerBlobDownload(blob, 'pdf-analysis-generated-krt.csv')
}

function downloadPdfAnalysisJson() {
  const items = modalItems.value
  if (!items?.length) return
  const json = JSON.stringify(items, null, 2)
  const blob = new Blob([json], { type: 'application/json;charset=utf-8;' })
  triggerBlobDownload(blob, 'pdf-analysis-generated-krt.json')
}

function canRestart(job) {
  // Restart is meaningless when the process is fully off (config 'off') —
  // there's no source of data to retry against.
  if (getConfigPill(job) === 'off') return false
  return !restartingJobs.value.has(job.type) &&
    (!job.status || job.status === 'complete' || job.status === 'failed' || job.status === 'pending_input')
}

async function handleRestart(type) {
  if (!restartJobFn || restartingJobs.value.has(type)) return
  // Close the modal immediately so the user sees the panel update without
  // having to dismiss it manually. The restart call still runs in the
  // background and the panel polls for the new status.
  closeModal()
  restartingJobs.value.add(type)
  try {
    await restartJobFn(type)
  } finally {
    restartingJobs.value.delete(type)
  }
}

function getOrcidSourceClass(source) {
  if (source === 'grobid+openalex' || source === 'openalex') return 'source-enriched'
  if (source === 'grobid') return 'source-grobid'
  if (source === 'orcid_api') return 'source-orcid-api'
  return 'source-softcite'
}

function formatOrcidSource(source) {
  const labels = {
    'grobid+openalex': 'GROBID + OpenAlex',
    'openalex': 'OpenAlex',
    'grobid': 'GROBID',
    'orcid_api': 'ORCID API'
  }
  return labels[source] || source
}

/**
 * Get the display name from a mention item (different field names across detection types)
 */
function getMentionName(item) {
  return item.canonical_name || item.name || item.resourceName || ''
}

/**
 * Read the enrichment provenance off an item. After the four-step pipeline
 * refactor, this lives under `detectorMeta.enrichmentMeta`. Older persisted
 * items kept it at the top level — we accept either shape.
 */
function getEnrichmentMeta(item) {
  return item?.detectorMeta?.enrichmentMeta || item?.enrichmentMeta || null
}

/**
 * Whether a particular field on this mention was filled in from the enrichment
 * list rather than coming from the detector itself.
 */
function isFieldFromEnrichment(item, field) {
  const meta = getEnrichmentMeta(item)
  return Array.isArray(meta?.filledFields) && meta.filledFields.includes(field)
}

/**
 * Tooltip text for the "enriched" badge — explains which fields were filled.
 */
function enrichmentBadgeTitle(item) {
  const filled = getEnrichmentMeta(item)?.filledFields || []
  if (filled.length === 0) {
    return 'This resource is in the curated enrichment list (no missing fields to fill).'
  }
  return `Matched in the enrichment list — filled in: ${filled.join(', ')}`
}

const enrichedItemsCount = computed(() => {
  if (!modalItems.value) return 0
  return modalItems.value.filter(i => getEnrichmentMeta(i)?.matched).length
})

/**
 * After the in-detector dedupe step (P3-P7), each item carries `mergedFrom`
 * — one entry per pre-dedup contribution. Items that didn't merge with
 * anything have mergedFrom.length === 1.
 */
function getMergedFromCount(item) {
  return Array.isArray(item?.mergedFrom) ? item.mergedFrom.length : 1
}

/** Indices of rows whose mergedFrom drill-down is currently expanded. */
// Generated-KRT view with the modal controls applied at GROUP level (a
// group = one final KRT row; its contributor lines travel with it): groups
// are kept whole by search/type-filter and ordered by resource type in the
// KRT editor's order. displayParity re-alternates shading on the visible set.
const displayedPdfAnalysisRows = computed(() => {
  const all = pdfAnalysisRows.value
  const groupType = new Map()
  for (const r of all) {
    if (r.isGroupStart) groupType.set(r.groupIndex, r.resourceType || '')
  }
  let keep = new Set(groupType.keys())
  if (modalTypeFilter.value !== 'all') {
    keep = new Set([...keep].filter(gi => groupType.get(gi) === modalTypeFilter.value))
  }
  const q = modalSearch.value.trim().toLowerCase()
  if (q) {
    const matching = new Set(all.filter(r => rowMatchesSearch([
      r.resourceType, r.resourceName, r.finalName, r.sourceUrl, r.identifier,
      r.newReuse, r.additionalInformation, r.reason
    ], q)).map(r => r.groupIndex))
    keep = new Set([...keep].filter(gi => matching.has(gi)))
  }
  const rows = all
    .filter(r => keep.has(r.groupIndex))
    .sort((a, b) => a.groupIndex === b.groupIndex
      ? 0
      : (compareTypes(groupType.get(a.groupIndex), groupType.get(b.groupIndex)) || (a.groupIndex - b.groupIndex)))
  let parity = -1
  let lastGroup = null
  return rows.map(r => {
    if (r.groupIndex !== lastGroup) { parity++; lastGroup = r.groupIndex }
    return { ...r, displayParity: parity % 2 }
  })
})

const expandedMergedRows = ref(new Set())

// Row indexes shift when the search/type filter changes — drop any open
// merged-row expansions so they don't reattach to the wrong line.
watch([modalSearch, modalTypeFilter], () => { expandedMergedRows.value = new Set() })

function toggleMergedRow(idx) {
  const next = new Set(expandedMergedRows.value)
  if (next.has(idx)) next.delete(idx)
  else next.add(idx)
  expandedMergedRows.value = next
}

/**
 * Reset the expanded set whenever the modal items change so the open-state
 * doesn't leak across detector views.
 */
watch(() => modalItems.value, () => {
  expandedMergedRows.value = new Set()
})

/**
 * Best-effort one-line context for a pre-dedup contributor. Different
 * detectors expose different fields; pick the most informative one available.
 */
function getMergedFromContext(originalItem) {
  if (!originalItem) return '—'
  const meta = originalItem.detectorMeta || {}
  if (meta.context) return meta.context
  if (meta.text_excerpt) return meta.text_excerpt
  if (typeof meta.position === 'number') return `char offset ${meta.position}`
  return originalItem.additionalInformation || '—'
}

/**
 * Modal status pill label. Mirrors getResultBadgeText but kept as its own
 * function in case the modal wants different copy in the future.
 */
function getStatusLabel(job) {
  if (!job.status) return 'Not started'
  if (job.status === 'complete') {
    if (job.outcomeState === 'fail') return 'Fail'
    return 'Done'
  }
  const labels = {
    waiting: 'Waiting',
    pending_input: 'Needs input',
    queued: 'Queued',
    processing: 'Processing',
    failed: 'Failed'
  }
  return labels[job.status] || job.status
}

function getStatusBadgeClass(job) {
  if (!job.status) return 'job-status-idle'
  if (job.status === 'complete') {
    return job.outcomeState === 'fail' ? 'job-status-failed' : 'job-status-complete'
  }
  const classes = {
    waiting: 'job-status-waiting',
    pending_input: 'job-status-pending-input',
    queued: 'job-status-running',
    processing: 'job-status-running',
    failed: 'job-status-failed'
  }
  return classes[job.status] || 'job-status-idle'
}

function formatTime(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * Format logs as plain text for the textarea display
 */
function formatLogsAsText(logs) {
  if (!logs || logs.length === 0) return ''
  return logs.map(entry => {
    const time = new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const dataStr = entry.data
      ? ' | ' + Object.entries(entry.data).map(([k, v]) => {
          if (typeof v === 'number' && k.toLowerCase().includes('ms')) return `${k}=${(v / 1000).toFixed(1)}s`
          return `${k}=${v}`
        }).join(', ')
      : ''
    return `[${time}] ${entry.step}: ${entry.message}${dataStr}`
  }).join('\n')
}

/**
 * Get the file extension from an S3 key (e.g., ".json", ".md").
 * Falls back to ".json" if no extension is found.
 */
function getFileExtension(s3Key) {
  if (typeof s3Key !== 'string') return '.json'
  const lastDot = s3Key.lastIndexOf('.')
  if (lastDot === -1) return '.json'
  return s3Key.substring(lastDot)
}

/**
 * Download a raw response file via presigned URL
 */
async function downloadRawResponse(jobType, responseName) {
  try {
    const submissionId = route.params.id
    const data = await jobService.getJobResponseUrl(submissionId, jobType, responseName)
    if (data.url) {
      window.open(data.url, '_blank', 'noopener,noreferrer')
    }
  } catch {
    // Silently fail — the button just won't work
  }
}

/**
 * Download the converted markdown file via presigned URL
 */
async function downloadMarkdownFile(fileId) {
  try {
    const submissionId = route.params.id
    const data = await fileService.download(submissionId, fileId)
    if (data.url) {
      window.open(data.url, '_blank', 'noopener,noreferrer')
    }
  } catch {
    // Silently fail
  }
}

</script>

<template>
  <div class="job-status-wrapper job-status-card">
    <!-- ETA header — always visible. The status summary pills (running /
         waiting / failed / done) sit on the right of the title row no matter
         what, so the user always sees pipeline progress even when the
         pipeline is fully idle. The ETA "X to Y min remaining" text +
         progress bar only render while jobs are actually in-flight. -->
    <div class="job-status-eta">
      <div class="job-status-eta-row">
        <svg class="job-status-eta-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span class="job-status-eta-label">Background processes</span>
        <span v-if="etaVisible" class="job-status-eta-remaining">{{ etaLabel }}</span>
        <div class="job-header-badges">
          <span v-if="jobSummary.running > 0" class="job-summary-badge job-status-running">
            {{ jobSummary.running }} running
          </span>
          <span v-if="jobSummary.waiting > 0" class="job-summary-badge job-status-waiting">
            {{ jobSummary.waiting }} waiting
          </span>
          <span v-if="jobSummary.pending > 0" class="job-summary-badge job-status-pending-input">
            {{ jobSummary.pending }} needs input
          </span>
          <span v-if="jobSummary.failed > 0" class="job-summary-badge job-status-failed">
            {{ jobSummary.failed }} failed
          </span>
          <span class="job-summary-badge job-status-complete">
            {{ jobSummary.complete }}/{{ jobSummary.total }} done
          </span>
        </div>
      </div>
      <div v-if="etaVisible" class="job-status-eta-track">
        <div
          class="job-status-eta-fill"
          :class="{ 'job-status-eta-fill-done': allDone }"
          :style="{ width: `${etaProgress * 100}%` }"
        ></div>
      </div>
      <p v-if="anyInFlight" class="job-status-eta-hint">
        You can keep editing the Key Resources Table while these finish — suggestions will appear once they're done.
      </p>
      <div class="job-status-eta-footer">
        <button type="button" class="job-status-eta-toggle" @click="toggleCollapsed">
          <svg
            class="job-status-eta-chevron"
            :class="{ 'chevron-collapsed': isCollapsed }"
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
          {{ isCollapsed ? 'More details' : 'Hide details' }}
        </button>
      </div>
    </div>

    <!-- Expandable grid -->
    <div v-show="!isCollapsed" class="job-status-panel">
      <div
        v-for="job in jobList"
        :key="job.type"
        class="job-status-item"
        @click.stop="openJobModal(job)"
      >
        <!-- Line 1: Configuration pill (On / Demo / Off) -->
        <div class="job-config-line" :title="getLiveConfigTitle(job)">
          <span :class="getConfigPillClass(job)">{{ getConfigPillText(job) }}</span>
          <span class="job-label">{{ job.label }}</span>
        </div>
        <!-- Line 2: Job result -->
        <div class="job-result-line" :title="getResultTitle(job)">
          <!-- User input icon for pending_input -->
          <svg
            v-if="job.status === 'pending_input'"
            class="job-icon text-orange-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
          <!-- Clock icon for waiting -->
          <svg
            v-else-if="job.status === 'waiting'"
            class="job-icon text-amber-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <!-- Spinner for queued/processing -->
          <svg
            v-else-if="job.status === 'queued' || job.status === 'processing'"
            class="job-icon job-icon-spin text-blue-500"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <!-- Checkmark for complete + outcome=done -->
          <svg
            v-else-if="job.status === 'complete' && job.outcomeState !== 'fail'"
            class="job-icon text-green-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
          </svg>
          <!-- X for status=failed OR complete + outcome=fail -->
          <svg
            v-else-if="job.status === 'failed' || (job.status === 'complete' && job.outcomeState === 'fail')"
            class="job-icon text-red-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12" />
          </svg>
          <!-- Dash for not started -->
          <svg
            v-else
            :class="['job-icon', getConfigPill(job) === 'off' ? 'text-gray-600' : 'text-gray-400']"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 12h14" />
          </svg>
          <span
            class="job-status-badge"
            :class="getResultBadgeClass(job)"
          >
            {{ getResultBadgeText(job) }}
          </span>
          <span v-if="getResultSummary(job)" class="job-result-summary">{{ getResultSummary(job) }}</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Unified job detail modal -->
  <Teleport to="body">
    <Transition name="modal-fade">
      <div v-if="showModal && activeJob" class="job-modal-overlay" @click.self="closeModal">
        <div class="job-modal">
          <!-- Header -->
          <div class="job-modal-header">
            <div class="job-modal-header-left">
              <h3>{{ activeJob.label }}</h3>
              <div class="job-modal-header-badges">
                <!-- Config pill — On / Demo / Off (always shown) -->
                <span :class="getConfigPillClass(activeJob)">{{ getConfigPillText(activeJob) }}</span>
                <!-- Status pill — in-progress label, or Done/Fail outcome -->
                <span
                  v-if="activeJob.status"
                  class="job-status-badge"
                  :class="getStatusBadgeClass(activeJob)"
                >{{ getStatusLabel(activeJob) }}</span>
              </div>
            </div>
            <button class="job-modal-close" @click="closeModal">&times;</button>
          </div>

          <div class="job-modal-body">
            <!-- Notice bar — explains how results were produced (or why they're missing) -->
            <div v-if="activeJob.outcomeSource === 'demo' && activeJob.outcomeExternalError" class="job-modal-notice job-modal-notice-demo">
              External service failed; falling back to demo data.
              <span class="job-modal-notice-detail">{{ activeJob.outcomeExternalError }}</span>
            </div>
            <div v-else-if="activeJob.outcomeSource === 'demo'" class="job-modal-notice job-modal-notice-demo">
              Results are from demo data.
            </div>
            <div v-else-if="activeJob.outcomeState === 'fail'" class="job-modal-notice job-modal-notice-off">
              {{ formatFailReason(activeJob.outcomeFailReason) }}
              <span v-if="activeJob.outcomeExternalError" class="job-modal-notice-detail">{{ activeJob.outcomeExternalError }}</span>
            </div>

            <!-- ORCID sub-services -->
            <div v-if="activeJob.type === 'orcid_extraction' && activeJob.serviceSubServices && canViewInternals" class="job-modal-sub-services">
              <span v-for="(svc, name) in activeJob.serviceSubServices" :key="name" class="job-sub-service" :class="svc.enabled ? 'sub-on' : 'sub-off'">
                {{ name === 'grobid' ? 'GROBID' : name === 'openalex' ? 'OpenAlex' : 'ORCID API' }}: {{ svc.enabled ? 'on' : 'off' }}
              </span>
            </div>

            <!-- Status section -->
            <div class="job-modal-section">
              <h4 class="job-modal-section-title">Status</h4>
              <div class="job-modal-status-content">
                <p v-if="getJobDetail(activeJob)" class="job-modal-detail" :class="{ 'job-modal-error': activeJob.status === 'failed' }">{{ getJobDetail(activeJob) }}</p>

                <p v-if="isSlowJob(activeJob)" class="job-modal-warning">
                  Taking longer than expected. This attempt will time out after {{ Math.round((activeJob.config?.expireInSeconds || 0) / 60) }}min{{ activeJob.config?.retryLimit > 0 ? ` (${activeJob.config.retryLimit} retries remaining)` : '' }}.
                </p>

                <div class="job-modal-timing">
                  <span v-if="getElapsed(activeJob)" class="job-modal-elapsed">
                    <template v-if="activeJob.status === 'processing' || activeJob.status === 'queued'">Elapsed: {{ formatDuration(getElapsed(activeJob)) }}</template>
                    <template v-else>Duration: {{ formatDuration(getElapsed(activeJob)) }}</template>
                  </span>
                  <span v-if="activeJob.retryCount > 0 || (activeJob.config && activeJob.status === 'failed')" class="job-modal-retry">
                    Attempt {{ activeJob.retryCount + 1 }}/{{ (activeJob.config?.retryLimit || 2) + 1 }}
                  </span>
                </div>

                <!-- Timestamps (hidden from authors) -->
                <div v-if="canViewInternals && (activeJob.startedAt || activeJob.completedAt)" class="job-modal-times">
                  <span v-if="activeJob.createdAt">Queued: {{ formatTime(activeJob.createdAt) }}</span>
                  <span v-if="activeJob.startedAt">Started: {{ formatTime(activeJob.startedAt) }}</span>
                  <span v-if="activeJob.completedAt">Completed: {{ formatTime(activeJob.completedAt) }}</span>
                </div>
                <div v-if="canViewInternals && activeJob.config" class="job-modal-config">
                  Per attempt: {{ Math.round(activeJob.config.expireInSeconds / 60) }}min | Max total: {{ Math.round(activeJob.config.maxTotalSeconds / 60) }}min ({{ activeJob.config.retryLimit + 1 }} attempts)
                </div>
              </div>
            </div>

            <!-- Results section -->
            <div v-if="modalContent || (modalItems && modalItems.length) || modalTableType === 'pdf_analysis_krt'" class="job-modal-section">
              <h4 class="job-modal-section-title">Results</h4>
              <!-- Search + resource-type filter (mirrors the KRT editor's
                   controls) for every table view -->
              <div v-if="modalTableType && modalItems && modalItems.length" class="job-modal-table-controls">
                <input
                  v-model="modalSearch"
                  type="text"
                  class="job-modal-search"
                  placeholder="Search rows…"
                >
                <select
                  v-if="modalTableType !== 'authors' && modalTypeOptions.length > 1"
                  v-model="modalTypeFilter"
                  class="job-modal-type-filter"
                >
                  <option value="all">All resource types</option>
                  <option v-for="t in modalTypeOptions" :key="t" :value="t">{{ t }}</option>
                </select>
              </div>
              <!-- Plain text content (DAS, markdown info) -->
              <p v-if="modalContent && !modalItems" class="job-modal-text">{{ modalContent }}</p>
              <!-- Mentions table (software, datasets, materials, protocols) -->
              <div v-if="modalItems && modalItems.length && (modalTableType === 'software' || modalTableType === 'resources')" class="job-modal-table-wrapper">
                <table class="job-modal-table">
                  <thead>
                    <tr>
                      <th>Resource Type</th>
                      <th>Resource Name</th>
                      <th>Source</th>
                      <th>Identifier</th>
                      <th>New/Reuse</th>
                      <th>Additional Information</th>
                    </tr>
                  </thead>
                  <tbody>
                    <template v-for="(item, i) in displayedModalItems" :key="i">
                      <tr>
                        <td class="text-xs">{{ item.resourceType || item.resource_type || 'Software/code' }}</td>
                        <td class="font-medium">
                          {{ getMentionName(item) }}
                          <span
                            v-if="getEnrichmentMeta(item)?.matched"
                            class="enrichment-badge"
                            :title="enrichmentBadgeTitle(item)"
                          >
                            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
                            </svg>
                            enriched
                          </span>
                          <button
                            v-if="getMergedFromCount(item) > 1"
                            type="button"
                            class="merged-from-badge"
                            :title="`Merged from ${getMergedFromCount(item)} pre-dedup mentions — click to expand`"
                            @click="toggleMergedRow(i)"
                          >
                            merged ×{{ getMergedFromCount(item) }}
                            <span class="merged-from-chevron" :class="{ open: expandedMergedRows.has(i) }">▾</span>
                          </button>
                        </td>
                        <td class="text-xs" :class="{ 'cell-from-enrichment': isFieldFromEnrichment(item, 'source') }" :title="isFieldFromEnrichment(item, 'source') ? 'Filled in from the enrichment list' : null">{{ item.source || item.suggestedURL || item.url || '—' }}</td>
                        <td class="text-xs" :class="{ 'cell-from-enrichment': isFieldFromEnrichment(item, 'identifier') }" :title="isFieldFromEnrichment(item, 'identifier') ? 'Filled in from the enrichment list' : null">{{ item.identifier || item.RRID || item.suggestedRRID || '—' }}</td>
                        <td :class="{ 'cell-from-enrichment': isFieldFromEnrichment(item, 'newReuse') }" :title="isFieldFromEnrichment(item, 'newReuse') ? 'Filled in from the enrichment list' : null">
                          <span v-if="item.newReuse" class="job-modal-source-badge" :class="item.newReuse === 'new' ? 'source-enriched' : 'source-softcite'">
                            {{ item.newReuse }}
                          </span>
                          <span v-else>—</span>
                        </td>
                        <td class="text-xs text-gray-500">{{ item.additionalInformation || item.additional_information || '—' }}</td>
                      </tr>
                      <tr v-if="item.detectorMeta?.context || item.context" class="context-row">
                        <td colspan="6" class="context-cell">{{ item.detectorMeta?.context || item.context }}</td>
                      </tr>
                      <tr v-if="expandedMergedRows.has(i) && getMergedFromCount(item) > 1" class="merged-from-row">
                        <td colspan="6">
                          <div class="merged-from-title">Merged from {{ getMergedFromCount(item) }} pre-dedup mentions:</div>
                          <table class="merged-from-table">
                            <thead>
                              <tr>
                                <th>Resource Name</th>
                                <th>Confidence</th>
                                <th>Identifier</th>
                                <th>Context / Position</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr v-for="(contrib, j) in item.mergedFrom" :key="j">
                                <td>{{ contrib.originalItem?.resourceName || contrib.originalItem?.name || '—' }}</td>
                                <td>{{ typeof contrib.confidence === 'number' ? contrib.confidence.toFixed(2) : '—' }}</td>
                                <td class="text-xs">{{ contrib.originalItem?.identifier || '—' }}</td>
                                <td class="text-xs text-gray-500">{{ getMergedFromContext(contrib.originalItem) }}</td>
                              </tr>
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    </template>
                  </tbody>
                </table>
                <div v-if="!displayedModalItems.length" class="job-modal-filter-empty">No rows match the current filters.</div>
              </div>
              <!-- Enrichment summary note. The "already in KRT" judgment now
                   lives solely in the AI Suggestions section, which is fed by
                   pdf_analysis's diff against the user's KRT. -->
              <div v-if="modalItems && modalItems.length && (modalTableType === 'resources' || modalTableType === 'software') && enrichedItemsCount > 0" class="mt-3 px-3 py-2 bg-gray-50 border border-gray-200 rounded text-sm text-gray-600">
                {{ enrichedItemsCount }} of {{ modalItems.length }} matched in the enrichment list (fields with a dotted underline were filled from the list)
              </div>
              <!-- PDF Analysis: Generated KRT pre-merge view -->
              <div v-if="modalTableType === 'pdf_analysis_krt'" class="pdf-analysis-modal-section">
                <div v-if="pdfAnalysisRows.length" class="pdf-analysis-summary">
                  <div>
                    <strong>{{ modalItems?.length || 0 }}</strong> KRT row{{ (modalItems?.length || 0) !== 1 ? 's' : '' }}
                    consolidated from <strong>{{ pdfAnalysisRows.length }}</strong> detection{{ pdfAnalysisRows.length !== 1 ? 's' : '' }}
                    <span v-if="pdfAnalysisMergedGroups > 0">— {{ pdfAnalysisMergedGroups }} merged from multiple modules</span>
                  </div>
                  <div class="pdf-analysis-summary-hint">
                    Rows sharing a <strong>KRT&nbsp;#</strong> are the <em>same</em> KRT row — one line per detection module that found it.
                  </div>
                </div>
                <div v-if="pdfAnalysisRows.length" class="pdf-analysis-actions">
                  <button class="btn-secondary text-xs inline-flex items-center" @click="downloadPdfAnalysisCsv">
                    <svg class="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                    </svg>
                    Download CSV
                  </button>
                  <button class="btn-secondary text-xs inline-flex items-center" @click="downloadPdfAnalysisJson">
                    <svg class="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                    </svg>
                    Download JSON
                  </button>
                </div>
                <div v-if="pdfAnalysisRows.length" class="job-modal-table-wrapper">
                  <table class="job-modal-table">
                    <thead>
                      <tr>
                        <th>KRT #</th>
                        <th>Detection</th>
                        <th>Resource Type</th>
                        <th>Detected Name</th>
                        <th>Source</th>
                        <th>Identifier</th>
                        <th>New/Reuse</th>
                        <th>Additional Information</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="(row, i) in displayedPdfAnalysisRows"
                        :key="i"
                        :class="[
                          'pdf-analysis-row',
                          row.displayParity === 0 ? 'pdf-analysis-group-even' : 'pdf-analysis-group-odd',
                          { 'pdf-analysis-row-duplicate': row.isDuplicate,
                            'pdf-analysis-group-start': row.isGroupStart,
                            'pdf-analysis-group-end': row.isGroupEnd,
                            'pdf-analysis-group-merged': row.groupSize > 1 }
                        ]"
                      >
                        <!-- KRT row number — shown once per group so a merged
                             group reads as one block; merge label clarifies it. -->
                        <td class="pdf-analysis-krtnum-cell">
                          <template v-if="row.isGroupStart">
                            <div class="pdf-analysis-krtnum">#{{ row.groupNumber }}</div>
                            <div
                              v-if="row.groupSize > 1"
                              class="pdf-analysis-merge-label"
                              :title="'Merged into one KRT row: ' + (row.finalName || '') + ' (dedup key: ' + (row.dedupKey || '?') + ')'"
                            >
                              {{ row.groupSize }} detections → 1 row
                            </div>
                          </template>
                        </td>
                        <td>
                          <span v-if="row.source" class="job-modal-source-badge source-enriched">
                            {{ pdfAnalysisSourceLabel(row.source) }}
                          </span>
                          <span v-else>—</span>
                        </td>
                        <td class="text-xs">{{ row.resourceType || '—' }}</td>
                        <td class="font-medium">{{ row.resourceName || '—' }}</td>
                        <td class="text-xs">{{ row.sourceUrl || '—' }}</td>
                        <td class="text-xs">{{ row.identifier || '—' }}</td>
                        <td>
                          <span v-if="row.newReuse" class="job-modal-source-badge" :class="row.newReuse === 'new' ? 'source-enriched' : 'source-softcite'">
                            {{ row.newReuse }}
                          </span>
                          <span v-else>—</span>
                        </td>
                        <td class="text-xs text-gray-500">{{ row.additionalInformation || '—' }}</td>
                        <!-- LM consolidation reason — shown once per merged group -->
                        <td class="text-xs text-gray-500 pdf-analysis-reason-cell">{{ row.isGroupStart ? (row.reason || '—') : '' }}</td>
                      </tr>
                    </tbody>
                  </table>
                  <div v-if="!displayedPdfAnalysisRows.length" class="job-modal-filter-empty">No rows match the current filters.</div>
                </div>
                <div v-else class="pdf-analysis-empty">
                  No detections were consolidated yet. Run the upstream detections first.
                </div>

                <!-- Dropped candidates: detections the LM did not keep in the Generated KRT -->
                <div v-if="modalDropped.length" class="pdf-analysis-dropped">
                  <h4 class="job-modal-section-title">
                    Dropped candidates
                    <span class="pdf-analysis-dropped-count">{{ modalDropped.length }}</span>
                  </h4>
                  <p class="pdf-analysis-dropped-hint">These detections were not kept in the Generated KRT — with the reason for each.</p>
                  <div class="job-modal-table-wrapper">
                    <table class="job-modal-table">
                      <thead>
                        <tr>
                          <th>Detected by</th>
                          <th>Resource Type</th>
                          <th>Resource Name</th>
                          <th>Identifier</th>
                          <th>Reason dropped</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="(d, i) in modalDropped" :key="i" class="pdf-analysis-dropped-row">
                          <td>
                            <span v-for="s in (d.sources || [])" :key="s" class="job-modal-source-badge source-enriched mr-1">{{ pdfAnalysisSourceLabel(s) }}</span>
                            <span v-if="!d.sources || !d.sources.length">—</span>
                          </td>
                          <td class="text-xs">{{ d.resourceType || '—' }}</td>
                          <td class="font-medium pdf-analysis-dropped-name">{{ d.resourceName || '—' }}</td>
                          <td class="text-xs">{{ d.identifier || '—' }}</td>
                          <td class="text-xs text-gray-500 pdf-analysis-reason-cell">{{ cleanReason(d.reason) || '—' }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              <!-- Authors table -->
              <div v-if="modalItems && modalItems.length && modalTableType === 'authors'" class="job-modal-table-wrapper">
                <table class="job-modal-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>ORCID</th>
                      <th>Affiliation</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(item, i) in displayedAuthorItems" :key="i">
                      <td>{{ item.fullName || [item.firstName, item.lastName].filter(Boolean).join(' ') }}</td>
                      <td>
                        <a v-if="item.orcid" :href="'https://orcid.org/' + item.orcid" target="_blank" rel="noopener" class="orcid-link">
                          {{ item.orcid }}
                        </a>
                        <span v-else>—</span>
                      </td>
                      <td>{{ item.affiliation || '—' }}</td>
                      <td>
                        <span v-if="item.source" class="job-modal-source-badge" :class="getOrcidSourceClass(item.source)">
                          {{ formatOrcidSource(item.source) }}
                        </span>
                        <span v-else>—</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div v-if="!displayedAuthorItems.length" class="job-modal-filter-empty">No rows match the current filters.</div>
              </div>

              <!-- AI Suggestions: every choice the module made, shown as the
                   concerned KRT row (with a red/green diff for updates) + the
                   decision and reason. -->
              <div v-if="modalTableType === 'suggestions' && modalItems && modalItems.length" class="job-modal-table-wrapper">
                <table v-if="suggestionDisplayRows.length" class="job-modal-table">
                  <thead>
                    <tr>
                      <th>Decision</th>
                      <th class="suggestion-reason-col">Reason</th>
                      <th>Item</th>
                      <th
                        v-for="c in SUGGESTION_ROW_COLUMNS"
                        :key="c.key"
                        :class="{ 'suggestion-name-col': c.key === 'resourceName' }"
                      >
                        {{ c.label }}
                      </th>
                      <th>Modules</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="(r, i) in suggestionDisplayRows"
                      :key="i"
                      :class="[ r.groupIndex % 2 === 0 ? 'sugg-group-even' : 'sugg-group-odd', { 'sugg-group-start': r.isGroupStart } ]"
                    >
                      <!-- Decision / Reason / Modules: shown once per decision group -->
                      <td>
                        <span v-if="r.isGroupStart" class="suggestion-decision-badge" :class="'sdb-' + suggestionDecisionLabel(r.decision).toLowerCase()">{{ suggestionDecisionLabel(r.decision) }}</span>
                      </td>
                      <td class="text-xs text-gray-500 suggestion-reason-cell">{{ r.isGroupStart ? (cleanReason(r.decision.reason || r.decision.description) || '—') : '' }}</td>
                      <td class="text-xs">
                        <span v-if="r.role" class="sugg-role" :class="'sugg-role-' + r.side">{{ r.role }}</span>
                      </td>
                      <td
                        v-for="c in SUGGESTION_ROW_COLUMNS"
                        :key="c.key"
                        class="text-xs"
                        :class="{ 'suggestion-name-cell': c.key === 'resourceName' }"
                      >
                        <span :class="(r.changes && r.changes[c.key]) ? (r.side === 'author' ? 'diff-old' : 'diff-new') : ''">{{ (r.cells && r.cells[c.key]) || '—' }}</span>
                      </td>
                      <td class="text-xs">{{ r.isGroupStart ? ((r.decision.sources && r.decision.sources.length) ? r.decision.sources.map(s => SOURCE_SHORT[s] || s).join(', ') : '—') : '' }}</td>
                    </tr>
                  </tbody>
                </table>
                <div v-if="!suggestionDisplayRows.length" class="job-modal-filter-empty">No rows match the current filters.</div>
              </div>
            </div>

            <!-- Logs section (hidden from authors) -->
            <div v-if="canViewInternals && modalLogs.length > 0" class="job-modal-section">
              <h4 class="job-modal-section-title">Process Logs</h4>
              <textarea
                readonly
                :value="formatLogsAsText(modalLogs)"
                class="w-full text-xs font-mono bg-gray-50 text-gray-600 border border-gray-200 rounded p-2 resize-none"
                :rows="Math.min(modalLogs.length + 1, 12)"
              ></textarea>
            </div>

            <!-- Raw responses section (hidden from authors) -->
            <div v-if="Object.keys(modalRawResponses).length > 0 && canViewInternals" class="job-modal-section">
              <h4 class="job-modal-section-title">Raw Responses</h4>
              <div class="flex flex-wrap gap-2">
                <button
                  v-for="(s3Key, name) in modalRawResponses"
                  :key="name"
                  class="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded text-xs text-gray-700 transition-colors cursor-pointer border border-gray-200"
                  @click="downloadRawResponse(modalJobType, name)"
                >
                  <svg class="w-3.5 h-3.5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  {{ name }}{{ getFileExtension(s3Key) }}
                </button>
              </div>
            </div>

            <!-- Action buttons -->
            <div class="job-modal-actions">
              <button
                v-if="activeJob.type === 'das_extraction' && activeJob.status === 'complete'"
                class="job-action-btn"
                @click="emit('edit-das'); closeModal()"
              >
                Edit Availability Statement
              </button>
              <button
                v-if="activeJob.type === 'markdown_convert' && activeJob.status === 'complete' && activeJob.result?.data?.fileId"
                class="job-action-btn"
                @click="downloadMarkdownFile(activeJob.result.data.fileId)"
              >
                <svg class="w-4 h-4 inline-block mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download Markdown
              </button>
              <button
                v-if="restartJobFn && canRestartJobs && canRestart(activeJob)"
                class="job-restart-btn"
                :disabled="restartingJobs.has(activeJob.type)"
                @click="handleRestart(activeJob.type)"
              >
                <svg
                  v-if="activeJob.status === 'pending_input'"
                  class="job-restart-icon"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
                <svg
                  v-else
                  class="job-restart-icon"
                  :class="{ 'job-icon-spin': restartingJobs.has(activeJob.type) }"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {{ restartingJobs.has(activeJob.type) ? 'Starting...' : (activeJob.status === 'pending_input' ? 'Start' : 'Restart') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.job-status-wrapper {
  margin-top: 0.5rem;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 0.375rem;
  position: relative;
  z-index: 30;
}

.job-status-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.375rem 0.75rem;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}

.job-status-header:hover {
  background: #f3f4f6;
}

.job-status-header-left {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

/* ── Unified ETA + status card (replaces the old separate JobsEtaBar) ── */
.job-status-card {
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 0.5rem;
  padding: 0.625rem 0.875rem;
  margin-top: 0;
}
.job-status-card.job-status-wrapper {
  /* override the legacy "marginTop: 0.5rem" + plain border styling that
     applied when the panel was its own card */
  background: #eff6ff;
  border-color: #bfdbfe;
}
.job-status-eta {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.job-status-eta-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
}
.job-status-eta-icon {
  width: 1rem;
  height: 1rem;
  color: #2563eb;
  flex-shrink: 0;
}
.job-status-eta-label {
  font-weight: 600;
  color: #1e40af;
}
.job-status-eta-remaining {
  color: #2563eb;
  font-variant-numeric: tabular-nums;
}
/* Summary badges always render in the top header row; push them to the
   right edge so they sit next to the chevron column visually. */
.job-status-eta-row > .job-header-badges {
  margin-left: auto;
}
.job-status-eta-track {
  height: 4px;
  background: #dbeafe;
  border-radius: 9999px;
  overflow: hidden;
}
.job-status-eta-fill {
  height: 100%;
  background: #2563eb;
  border-radius: 9999px;
  transition: width 0.6s ease-out, background 0.3s ease-out;
}
/* All-done variant — green so the user gets a positive visual confirmation
   that the pipeline finished, even when the panel is collapsed. */
.job-status-eta-fill-done {
  background: #16a34a;
}
.job-status-eta-hint {
  font-size: 0.75rem;
  color: #475569;
  margin: 0;
}
.job-status-eta-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.job-status-eta-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  background: transparent;
  border: 0;
  padding: 0.25rem 0;
  font-size: 0.75rem;
  font-weight: 500;
  color: #2563eb;
  cursor: pointer;
}
.job-status-eta-toggle:hover {
  color: #1d4ed8;
  text-decoration: underline;
}
.job-status-eta-chevron {
  width: 0.875rem;
  height: 0.875rem;
  transition: transform 0.2s ease;
  flex-shrink: 0;
}

.job-header-chevron {
  width: 0.875rem;
  height: 0.875rem;
  color: #6b7280;
  transition: transform 0.2s ease;
  flex-shrink: 0;
}

.chevron-collapsed {
  transform: rotate(-90deg);
}

.job-header-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: #374151;
  text-transform: uppercase;
  letter-spacing: 0.025em;
}

.job-header-badges {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.job-summary-badge {
  padding: 0.0625rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-weight: 500;
  white-space: nowrap;
}

.job-status-panel {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.25rem 0.75rem;
  margin-top: 0.5rem;
  padding: 0.5rem 0.75rem 0.625rem;
  background: #fff;
  border: 1px solid #dbeafe;
  border-radius: 0.375rem;
  font-size: 0.75rem;
  overflow: visible;
}

.job-status-item {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  cursor: pointer;
  position: relative;
  padding: 0.25rem 0.375rem;
  border-radius: 0.25rem;
  transition: background 0.15s ease;
}

.job-status-item:hover {
  background: #f3f4f6;
}

.job-config-line {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.job-result-line {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding-left: 1rem;
}

.job-result-summary {
  color: #9ca3af;
  font-size: 0.6875rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 12rem;
}

.job-icon {
  width: 0.875rem;
  height: 0.875rem;
  flex-shrink: 0;
}

.job-icon-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.job-label {
  color: #374151;
  font-weight: 500;
}

.job-status-badge {
  padding: 0.0625rem 0.375rem;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-weight: 500;
}

.job-status-running {
  background: #dbeafe;
  color: #1d4ed8;
}

.job-status-complete {
  background: #d1fae5;
  color: #047857;
}

.job-status-failed {
  background: #fee2e2;
  color: #b91c1c;
}

.job-status-idle {
  background: #f3f4f6;
  color: #6b7280;
}

.job-status-waiting {
  background: #fef3c7;
  color: #92400e;
}

.job-status-pending-input {
  background: #ffedd5;
  color: #c2410c;
}

.job-status-slow {
  background: #fef3c7;
  color: #92400e;
}

/* Service status badges (inline, next to job label) */
.job-service-badge {
  padding: 0 0.3125rem;
  border-radius: 0.1875rem;
  font-size: 0.5625rem;
  font-weight: 600;
  letter-spacing: 0.025em;
  text-transform: uppercase;
  line-height: 1.25rem;
  flex-shrink: 0;
}

.job-service-disabled {
  background: #f3f4f6;
  color: #9ca3af;
}

.job-service-on {
  background: #d1fae5;
  color: #047857;
}

.job-service-demo {
  background: #e0e7ff;
  color: #3730a3;
}

/* Sub-service badges */
.job-sub-service {
  font-size: 0.6875rem;
  font-weight: 500;
  padding: 0.0625rem 0.375rem;
  border-radius: 0.1875rem;
}

.sub-on {
  background: #d1fae5;
  color: #047857;
}

.sub-off {
  background: #f3f4f6;
  color: #9ca3af;
}

/* Restart button */
.job-restart-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  white-space: nowrap;
  background: #f3f4f6;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #374151;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.job-restart-btn:hover:not(:disabled) {
  background: #e5e7eb;
  border-color: #9ca3af;
}

.job-restart-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.job-restart-icon {
  width: 0.875rem;
  height: 0.875rem;
  flex-shrink: 0;
}

/* Action button (Edit DAS, etc.) */
.job-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  white-space: nowrap;
  background: #dbeafe;
  border: 1px solid #93c5fd;
  border-radius: 0.375rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #1d4ed8;
  cursor: pointer;
  transition: background 0.15s ease;
}

.job-action-btn:hover {
  background: #bfdbfe;
}

/* Modal */
.job-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.job-modal {
  background: #fff;
  border-radius: 0.5rem;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
  /* Detection-result tables can be wide (8+ columns). Give the modal room
     to breathe — 90% of the viewport, capped at 1600px on ultra-wide
     screens so columns don't get unreadably stretched. */
  width: 90vw;
  max-width: 1600px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}

.job-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid #e5e7eb;
}

.job-modal-header-left {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.job-modal-header-badges {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.job-modal-header h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: #111827;
}

.job-modal-close {
  background: none;
  border: none;
  font-size: 1.25rem;
  color: #9ca3af;
  cursor: pointer;
  padding: 0 0.25rem;
  line-height: 1;
}

.job-modal-close:hover {
  color: #374151;
}

.job-modal-body {
  padding: 1rem;
  overflow-y: auto;
  flex: 1;
}

.job-modal-text {
  color: #374151;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

.job-modal-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}

.job-modal-table th,
.job-modal-table td {
  padding: 0.375rem 0.5rem;
  text-align: left;
  border-bottom: 1px solid #f3f4f6;
}

.job-modal-table th {
  font-weight: 600;
  color: #6b7280;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.025em;
  background: #f9fafb;
  position: sticky;
  top: 0;
}

.job-modal-table td {
  color: #374151;
}

.job-modal-source-badge {
  display: inline-block;
  padding: 0.0625rem 0.375rem;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-weight: 500;
}

.context-row td {
  border-bottom: 2px solid #e5e7eb;
}

.context-cell {
  font-size: 0.75rem;
  color: #6b7280;
  font-style: italic;
  line-height: 1.4;
  padding-top: 0 !important;
  padding-bottom: 0.5rem !important;
  white-space: normal;
  word-break: break-word;
}

.job-modal-table-wrapper {
  max-height: 400px;
  overflow-y: auto;
  border: 1px solid #e5e7eb;
  border-radius: 0.375rem;
}

/* Sticky header inside the scrolling wrapper — the body scrolls, the column
   labels stay visible. */
.job-modal-table-wrapper .job-modal-table thead th {
  position: sticky;
  top: 0;
  background: #f9fafb;
  z-index: 1;
}

/* Modal table controls (search + resource-type filter) */
.job-modal-table-controls {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.job-modal-search {
  flex: 1;
  min-width: 0;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  padding: 0.375rem 0.625rem;
  font-size: 0.8125rem;
}

.job-modal-type-filter {
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  padding: 0.375rem 0.625rem;
  font-size: 0.8125rem;
  background: white;
  max-width: 14rem;
}

.job-modal-filter-empty {
  padding: 1rem;
  text-align: center;
  color: #6b7280;
  font-size: 0.8125rem;
}

/* ── PDF Analysis modal: Generated KRT pre-merge view ────────────── */

.pdf-analysis-modal-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.pdf-analysis-summary {
  font-size: 0.8125rem;
  color: #4b5563;
  padding: 0.5rem 0.75rem;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 0.375rem;
}
.pdf-analysis-summary-hint {
  margin-top: 0.25rem;
  font-size: 0.75rem;
  color: #6b7280;
}

/* AI Suggestions modal: decision badges + update diff (old → new). */
.suggestion-decision-badge {
  display: inline-block;
  padding: 0.0625rem 0.375rem;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-weight: 600;
  background: #f3f4f6;
  color: #4b5563;
}
.sdb-add    { background: #dcfce7; color: #166534; }
.sdb-update { background: #dbeafe; color: #1e40af; }
.sdb-remove { background: #fee2e2; color: #b91c1c; }
.sdb-skip   { background: #f3f4f6; color: #6b7280; }
/* Diff cells: author side = old (red), generated side = new (green). */
.diff-old { color: #b91c1c; background: #fef2f2; padding: 0 0.2rem; border-radius: 3px; font-weight: 600; }
.diff-new { color: #166534; background: #f0fdf4; padding: 0 0.2rem; border-radius: 3px; font-weight: 600; }

/* Each decision is a group of 1-2 rows (Author / Generated). */
.sugg-group-even td { background: #ffffff; }
.sugg-group-odd td  { background: #fafafa; }
.sugg-group-start td { border-top: 2px solid #e5e7eb; }
.sugg-role {
  display: inline-block;
  font-size: 0.6875rem;
  font-weight: 600;
  padding: 0.0625rem 0.375rem;
  border-radius: 4px;
  white-space: nowrap;
}
.sugg-role-author    { background: #eef2ff; color: #3730a3; }
.sugg-role-generated { background: #ecfeff; color: #155e75; }

/* AI Suggestions column sizing: roomy Reason, compact Resource Name. */
.suggestion-reason-col, .suggestion-reason-cell {
  min-width: 320px;
  max-width: 460px;
  white-space: normal;
  line-height: 1.35;
}
.suggestion-name-col, .suggestion-name-cell {
  max-width: 150px;
  white-space: normal;
  word-break: break-word;
}

/* "KRT #" column — group identity, shown once per merged group. */
.pdf-analysis-krtnum-cell {
  white-space: nowrap;
  vertical-align: top;
}
.pdf-analysis-krtnum {
  font-weight: 700;
  color: #4b5563;
}
.pdf-analysis-merge-label {
  margin-top: 0.125rem;
  font-size: 0.6875rem;
  font-weight: 600;
  color: #2563eb;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 9999px;
  padding: 0.0625rem 0.375rem;
  display: inline-block;
  cursor: help;
}

.pdf-analysis-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

/* Each merged item is a "group". Rows belonging to the same group share a
   background tint; consecutive groups alternate light/lighter so the eye can
   track group boundaries even on a long, scrollable table. */
.pdf-analysis-group-even td {
  background: #ffffff;
}

.pdf-analysis-group-odd td {
  background: #f9fafb; /* gray-50 */
}

/* A solid divider between groups makes the boundary unambiguous. The first
   row of each group gets a top border; the last row gets a small bottom gap. */
.pdf-analysis-group-start td {
  border-top: 2px solid #d1d5db; /* gray-300 */
}

/* Multi-contributor groups (the duplicates) take precedence: warmer
   background + a left-border accent so they're easy to spot. */
.pdf-analysis-group-merged td {
  background: #fef3c7 !important; /* soft amber */
}

.pdf-analysis-group-merged.pdf-analysis-group-start td:first-child {
  border-left: 3px solid #f59e0b; /* amber-500 accent */
}

.pdf-analysis-group-merged:not(.pdf-analysis-group-start) td:first-child {
  border-left: 3px solid #f59e0b;
}

/* Inline "×N" pill next to the resource name on the group's first row —
   gives a quick count without forcing the reader to look at the last column. */
.pdf-analysis-group-count {
  display: inline-block;
  margin-left: 0.375rem;
  padding: 0 0.375rem;
  background: #f59e0b;
  color: #fff;
  border-radius: 9999px;
  font-size: 0.625rem;
  font-weight: 700;
  vertical-align: middle;
}

/* Legacy per-row duplicate marker kept for compatibility with any consumer
   that still uses it (e.g. printed views). New code should rely on the
   group-* classes above. */
.pdf-analysis-row-duplicate td {
  background: #fef3c7;
}

.pdf-analysis-duplicate-badge {
  display: inline-block;
  padding: 0.0625rem 0.5rem;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: #92400e;
  background: #fde68a;
  border: 1px solid #f59e0b;
  border-radius: 9999px;
  cursor: help;
}

.pdf-analysis-empty {
  padding: 1rem;
  text-align: center;
  font-size: 0.8125rem;
  color: #6b7280;
  background: #f9fafb;
  border: 1px dashed #d1d5db;
  border-radius: 0.375rem;
}

/* Reason cells wrap and get room so sentence-length reasons stay readable. */
.pdf-analysis-reason-cell {
  white-space: normal;
  min-width: 220px;
  max-width: 360px;
  line-height: 1.35;
}

/* Dropped candidates section */
.pdf-analysis-dropped {
  margin-top: 1rem;
}
.pdf-analysis-dropped-count {
  display: inline-block;
  margin-left: 0.375rem;
  padding: 0.0625rem 0.375rem;
  border-radius: 9999px;
  background: #fee2e2;
  color: #b91c1c;
  font-size: 0.6875rem;
  font-weight: 600;
}
.pdf-analysis-dropped-hint {
  font-size: 0.75rem;
  color: #6b7280;
  margin: 0.25rem 0 0.5rem;
}
.pdf-analysis-dropped-row td {
  background: #fef2f2;
}
.pdf-analysis-dropped-name {
  text-decoration: line-through;
  text-decoration-color: #fca5a5;
  color: #6b7280;
}

/* Inline badge marking a row as matched in the enrichment list */
.enrichment-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.1875rem;
  margin-left: 0.375rem;
  padding: 0.0625rem 0.375rem;
  background: #ede9fe;
  color: #6d28d9;
  border: 1px solid #c4b5fd;
  border-radius: 9999px;
  font-size: 0.625rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  white-space: nowrap;
  vertical-align: middle;
}

.enrichment-badge svg {
  width: 0.625rem;
  height: 0.625rem;
}

/* "merged ×N" pill — shown when an item has > 1 entry in mergedFrom.
   Clickable: toggles the drill-down row below. */
.merged-from-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.1875rem;
  margin-left: 0.375rem;
  padding: 0.0625rem 0.375rem 0.0625rem 0.5rem;
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #fcd34d;
  border-radius: 9999px;
  font-size: 0.625rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  white-space: nowrap;
  vertical-align: middle;
  cursor: pointer;
}

.merged-from-badge:hover {
  background: #fde68a;
}

.merged-from-chevron {
  display: inline-block;
  transition: transform 0.15s ease;
}

.merged-from-chevron.open {
  transform: rotate(180deg);
}

.merged-from-row td {
  background: #fffbeb;
  padding: 0.5rem 0.75rem;
  border-top: 1px solid #fde68a;
}

.merged-from-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: #92400e;
  margin-bottom: 0.375rem;
}

.merged-from-table {
  width: 100%;
  font-size: 0.75rem;
  border-collapse: collapse;
}

.merged-from-table th,
.merged-from-table td {
  padding: 0.25rem 0.5rem;
  text-align: left;
  border-bottom: 1px solid #fde68a;
}

.merged-from-table th {
  font-weight: 600;
  color: #78350f;
  background: #fef3c7;
}

/* A cell whose value was filled in from the enrichment list (not the detector) */
.cell-from-enrichment {
  text-decoration: underline dotted #8b5cf6;
  text-underline-offset: 2px;
}

.krt-badge {
  display: inline-block;
  padding: 0.0625rem 0.375rem;
  border-radius: 9999px;
  font-size: 0.625rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

.krt-badge-exists {
  background: #d1fae5;
  color: #047857;
  margin-left: 0.375rem;
}

.source-enriched {
  background: #dbeafe;
  color: #1d4ed8;
}

.source-softcite {
  background: #f3f4f6;
  color: #6b7280;
}

.source-grobid {
  background: #fef3c7;
  color: #92400e;
}

.source-orcid-api {
  background: #e0e7ff;
  color: #3730a3;
}

.orcid-link {
  color: #2563eb;
  text-decoration: none;
  font-family: monospace;
  font-size: 0.75rem;
}

.orcid-link:hover {
  text-decoration: underline;
}

/* Modal sections */
.job-modal-section {
  margin-top: 1rem;
}

.job-modal-section-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 0 0 0.5rem 0;
  padding-bottom: 0.25rem;
  border-bottom: 1px solid #f3f4f6;
}

.job-modal-notice {
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
  border-radius: 0.375rem;
  margin-bottom: 0.5rem;
}

.job-modal-notice-demo {
  background: #eef2ff;
  color: #3730a3;
}

.job-modal-notice-off {
  background: #f9fafb;
  color: #6b7280;
}

.job-modal-notice-detail {
  display: block;
  margin-top: 0.25rem;
  font-size: 0.75rem;
  font-family: ui-monospace, monospace;
  opacity: 0.75;
  word-break: break-word;
}

.job-modal-sub-services {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}

.job-modal-status-content {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.job-modal-detail {
  color: #374151;
  line-height: 1.5;
  word-break: break-word;
  white-space: pre-wrap;
  margin: 0;
}

.job-modal-error {
  color: #b91c1c;
}

.job-modal-warning {
  padding: 0.375rem 0.625rem;
  background: #fef3c7;
  color: #92400e;
  border-radius: 0.25rem;
  font-size: 0.8125rem;
  margin: 0;
}

.job-modal-timing {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.8125rem;
  color: #6b7280;
}

.job-modal-elapsed {
  font-weight: 500;
  color: #374151;
}

.job-modal-retry {
  color: #92400e;
  font-weight: 500;
}

.job-modal-times {
  display: flex;
  gap: 1rem;
  font-size: 0.75rem;
  color: #6b7280;
  padding: 0.375rem 0.5rem;
  background: #f9fafb;
  border-radius: 0.25rem;
}

.job-modal-config {
  color: #9ca3af;
  font-size: 0.75rem;
}

.job-modal-actions {
  margin-top: 1rem;
  padding-top: 0.75rem;
  border-top: 1px solid #e5e7eb;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  justify-content: flex-end;
}

.text-center {
  text-align: center;
}

/* Modal transition */
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.2s ease;
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

</style>
