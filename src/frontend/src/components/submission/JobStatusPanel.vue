<script setup>
/**
 * JobStatusPanel - Slim bar showing the pipeline steps and their statuses
 *
 * Displays each job with a spinner/checkmark/X icon, label, and status.
 * Clicking a job opens a popup with details (richer for admin/ds_annotator).
 * Shows elapsed time, retry count, and timeout warnings.
 */
import { computed, inject, ref, onMounted, onUnmounted, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth.store'
import jobService from '@/services/job.service'
import configService from '@/services/config.service'
import fileService from '@/services/file.service'
import { useResourceTypesStore } from '@/stores/resourceTypes.store'
import { isCancelledJob } from '@/composables/useJobPoller'
import { isFutureStepJob, useIssueDecision } from '@/composables'
// One vocabulary for job state, shared with the module pages — these were
// about to be a second copy.
import { formatFailReason, partialDetail } from '@/utils/job-status'

const route = useRoute()
/** For links out of the panel; the id is always in the route on these views. */
const submissionId = computed(() => route.params.id)

const jobs = inject('submissionJobs', ref({}))
// A failed poll leaves `jobs` empty, and an empty map renders as twelve steps
// that have "Not started" — indistinguishable from a pipeline that genuinely
// has not run. Only shown while there is nothing to show: once a poll has
// succeeded, the panel keeps displaying the last known state rather than
// throwing it away over one transient failure.
const jobsFetchError = inject('jobsFetchError', ref(null))
const statusUnreadable = computed(() =>
  !!jobsFetchError.value && Object.keys(jobs.value || {}).length === 0)

/**
 * Is the analysis parked on the KRT step?
 *
 * Read from the job's own `waitingReason`, which the server sets by asking the
 * orchestrator whether that step's gate is blocked. Deriving it here from a
 * list of gated types plus the submission status would be a second copy of a
 * rule that lives in the pipeline table — and every copy of that table in this
 * app has drifted at least once.
 *
 * Without this the panel says "waiting" and gives no way to find out what for,
 * which reads as a stall. The pipeline is in fact waiting on the user.
 */
// There was a "waiting for your Key Resources Table to be validated — click
// Continue" banner here. It has no audience left: this panel renders on the PDF
// step only, and reaching that step is what validates the KRT. A user who walks
// back to the KRT step does not see the panel at all, so the one place the
// message could still have applied is a page that no longer shows it.
//
// The per-job reason for `krt_validation` is kept below — it DESCRIBES a state
// rather than instructing the user to do something they cannot do from here,
// and it stays correct if the state ever occurs.

/**
 * The pipeline is stopped because there is no manuscript text.
 *
 * Unlike the KRT gate this one does NOT clear by itself: conversion has already
 * finished, unsuccessfully. Everything downstream would run against an empty
 * document and report zero findings, which reads as "your manuscript mentions
 * none of this" — so the steps hold instead, and this says why.
 */
/**
 * Steps that need a decision, and the two answers.
 *
 * The Manuscript step used to stack a separate issue box directly above this
 * panel, so a failure was announced twice — once in prose at the top, once as a
 * red pill on the tile — with the buttons only on the copy the user was not
 * looking at. The tile is where the failure already shows, so the choice
 * belongs on the tile.
 */
const injectedIssues = inject('pipelineIssues', ref([]))
const submissionIdForDecision = inject('submissionIdForDecision', ref(null))
const { busy: decisionBusy, act: decide } = useIssueDecision(submissionIdForDecision)

/** Undecided issues, by step. */
const issueByType = computed(() => {
  const map = {}
  for (const i of injectedIssues.value || []) if (!i.decided) map[i.jobType] = i
  return map
})
const issueFor = (job) => issueByType.value[job.type] || null

/** What continuing costs, in this issue's own terms. */
function issueConsequence(issue) {
  if (issue.wouldSkip?.length) {
    return `${issue.wouldSkip.length} step(s) that need it will be skipped`
  }
  if (issue.holding?.length) {
    return `${issue.holding.length} step(s) will run with less to work from`
  }
  return 'nothing is waiting on it'
}

const refreshPipeline = inject('refreshPipeline', null)

async function onDecide(job, action) {
  await decide(job.type, action, () => refreshPipeline?.())
}

const BLOCKED_REASON = 'blocked_by_failure'

const blockedByIssue = computed(() =>
  jobList.value.some((j) => j.status === 'waiting' && j.waitingReason === BLOCKED_REASON))

/** The pipeline is standing still, and will not start again by itself. */
const paused = computed(() => blockedByIssue.value)

/** How many steps that has stopped — the scale of the problem, not just its name. */
const blockedCount = computed(() =>
  jobList.value.filter((j) => j.status === 'waiting' && j.waitingReason === BLOCKED_REASON).length)
// Cancel-processing action, provided by PipelinePanel (#15).
const cancelProcessingFn = inject('cancelProcessing', null)
const cancelling = ref(false)
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

// Collapse/expand state — persisted in localStorage
const isCollapsed = ref(localStorage.getItem('job-panel-collapsed') === 'true')

function toggleCollapsed() {
  isCollapsed.value = !isCollapsed.value
  localStorage.setItem('job-panel-collapsed', isCollapsed.value.toString())
}

async function handleCancelProcessing() {
  if (!cancelProcessingFn || cancelling.value) return
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    const ok = window.confirm(
      'Stop the pipeline for this document? ' +
      'Every step still to run is cancelled too, not just the one in progress, and each has to be started again. ' +
      'A request already sent to an outside service cannot be recalled — its answer is discarded, but it is still charged.'
    )
    if (!ok) return
  }
  cancelling.value = true
  try {
    await cancelProcessingFn()
  } finally {
    cancelling.value = false
  }
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
  const cancelled = list.filter(j => j.status === 'cancelled').length
  const pending = list.filter(j => j.status === 'pending_input').length
  const waiting = list.filter(j => j.status === 'waiting').length
  const total = list.length
  // "done" for the X/total badge counts every resolved job — complete, failed
  // or cancelled — so the badge reads full once nothing is left to run.
  const done = complete + failed + cancelled
  return { complete, running, failed, cancelled, pending, waiting, total, done }
})

// ── Pipeline shape ───────────────────────────────────────────────────
/**
 * Dependencies, from the server's own pipeline table.
 *
 * This used to be two hand-written maps in this file — one for the ETA maths,
 * one for the "waiting for" tooltip — and they had drifted: the first gave
 * PDF Analysis seven dependencies, the second gave it two, and the table that
 * actually runs gives it seven. The tooltip had been under-reporting for as
 * long as they disagreed.
 *
 * Empty until the fetch lands, which degrades to "no dependencies": an ETA
 * without stacking, and a tooltip that names nothing. Both recover on the next
 * poll tick.
 */
const pipelineDeps = ref({})

onMounted(async () => {
  try {
    const { nodes } = await configService.getPipeline()
    pipelineDeps.value = Object.fromEntries(nodes.map((n) => [n.jobType, n.dependsOn]))
  } catch {
    // Non-fatal: the panel still lists jobs and their statuses.
  }
})

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

const canRestartJobs = computed(() => authStore.canRestartJobs)

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
  // Row 3: reconciliation + consolidation
  { type: 'krt_grounding', label: 'KRT Grounding' },
  { type: 'pdf_analysis', label: 'PDF Analysis' },
  { type: 'suggestion_generation', label: 'AI Suggestions' }
]

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
      // { id, name } for a run a user asked for; null when the orchestrator
      // advanced the step itself. This view-model is built field by field, so
      // anything not named here never reaches the modal.
      triggeredBy: job?.triggeredBy || null,
      runNumber: job?.runNumber ?? null,
      // How many times this STEP executed, which the run number no longer says.
      executionCount: job?.executionCount ?? null,
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
      outcomeState: svc?.outcome?.state ?? null,   // 'done' | 'partial' | 'fail' | null
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
  if (job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled') return 0

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
  const deps = pipelineDeps.value[type] || []
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
  // The raw jobs map (not the post-filter jobList) so the ETA still covers
  // disabled modules' upstream blocking — minus anything parked behind a step
  // the submission has not reached.
  //
  // Without that subtraction the panel contradicted itself: the DAS check waits
  // for the Availability step, so on the PDF step it sits `waiting` for ever.
  // The tiles said "11/11 done" while this map — which the tiles do not draw —
  // still held a twelfth job, so the header offered "15s to 3 min remaining"
  // for work that was finished, kept the "you can keep editing" hint up, and
  // left Cancel processing on screen.
  //
  // Every ETA computed below reads this one map, so excluding it here is the
  // whole fix.
  const map = jobs.value || {}
  return Object.fromEntries(
    Object.entries(map).filter(([, job]) => !isFutureStepJob(job))
  )
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
  return list.every(j => j.status === 'complete' || j.status === 'failed' || j.status === 'cancelled')
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
  if (allDone.value) return 'Pipeline complete'
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
  return job?.status === 'complete' || job?.status === 'failed' || job?.status === 'cancelled'
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
/**
 * What the "run N" badge means, said precisely.
 *
 * N is the PIPELINE run — one attempt at the whole round, the same number on
 * every tile. How many times THIS step executed is a different number, because
 * a run can carry a step over rather than re-running it, and the tile is
 * exactly where somebody would otherwise read the first as the second.
 *
 * @param {object} job
 * @returns {string}
 */
function runBadgeTooltip(job) {
  const ran = job.executionCount;
  const base = `Run ${job.runNumber} of this round — one attempt at the whole pipeline.`;
  if (!ran) return `${base} This step has not run in it yet.`;
  if (ran === 1) return `${base} This step ran once; later runs kept that result.`;
  return `${base} This step has run ${ran} times; what is shown is the latest.`;
}

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
 * Completed jobs read from `outcomeState` ('done', 'partial' or 'fail').
 * markFailed jobs (true unexpected errors, distinct from a workflow Fail
 * outcome) keep the red 'failed' styling.
 */
function getResultBadgeClass(job) {
  const slow = isSlowJob(job)

  // A user-cancelled job is stored as 'failed' + sentinel — show it neutral,
  // not as an error (#15).
  if (isCancelledJob(job)) return { 'job-status-cancelled': true }
  if (job.status === 'waiting') return { 'job-status-waiting': true, 'job-status-slow': slow }
  if (job.status === 'pending_input') return { 'job-status-pending-input': true }
  if (job.status === 'queued' || job.status === 'processing') return { 'job-status-running': true, 'job-status-slow': slow }
  if (job.status === 'failed') return { 'job-status-failed': true }

  if (job.status === 'complete') {
    if (job.outcomeState === 'done') return { 'job-status-complete': true }
    if (job.outcomeState === 'fail') return { 'job-status-failed': true }
    // Amber, not green: the step produced a real result but one of the engines
    // behind it failed, so the table is genuine AND short. Green here is the
    // "nine green ticks over a statement nobody read" mistake in miniature.
    if (job.outcomeState === 'partial') return { 'job-status-partial': true }
    // No outcome on a completed row should not happen post-migration, but
    // fall through to neutral if it does.
    return { 'job-status-idle': true }
  }

  // Not started yet — neutral
  return { 'job-status-idle': true }
}

/**
 * Text for the line-2 outcome badge. Three terminal labels — Done, Partial or
 * Fail — plus the existing in-progress labels. Configuration ('On'/'Demo'/'Off')
 * is shown by the line-1 pill, never here.
 */
function getResultBadgeText(job) {
  if (!job.status) return 'Not started'
  if (isCancelledJob(job)) return 'Cancelled'
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
    if (job.outcomeState === 'partial') return 'Partial'
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

  // Partial: the counts ARE real, so they still lead — but they are a floor,
  // not a total, and the summary has to say which engine went missing or the
  // number reads as the whole answer.
  if (job.outcomeState === 'partial') {
    return `${getDataSummary(job, r)} — ${formatFailReason(job.outcomeFailReason)}`
  }

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

// Shared by every detection module's modal (software / datasets / materials /
// protocols / identifier) so a user finds the same information in the same
// place whichever module they open. Each item renders as TWO rows: these
// columns, then a full-width context line underneath.

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
      const meta = job.result?.data?.meta || {}
      // Two engines are unioned here, so say what each contributed — otherwise
      // "5 unique mentions" hides whether the LM pass ran at all.
      let engines = ''
      if (meta.softciteFailed) {
        // NOT "Softcite 0" — that reads as "Softcite looked and found none",
        // which is the opposite of what happened.
        engines = ' · LM pass only (Softcite failed)'
      } else if (meta.lmEnabled === false) {
        engines = ' · Softcite only (LM pass off)'
      } else if (meta.lmSkippedReason) {
        engines = ` · Softcite only (LM ${meta.lmSkippedReason.replace(/_/g, ' ')})`
      } else if (typeof meta.lmCount === 'number') {
        engines = ` · Softcite ${meta.softciteCount ?? '?'} + LM ${meta.lmCount} before merge`
      }
      if (unique === 0) return `No mentions${engines}`
      return `${unique} unique mention${unique > 1 ? 's' : ''}${enriched > 0 ? `, ${enriched} enriched` : ''}${engines}`
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
    case 'krt_grounding': {
      const rows = r.counts?.authorRows || 0
      const unmatched = r.counts?.unmatchedCandidates || 0
      // No author KRT is a valid mode, not an empty result: say what the step
      // did do, which is find candidates nobody has claimed yet.
      if (rows === 0) return `No author KRT — ${unmatched} candidate${unmatched === 1 ? '' : 's'} found`
      // "Found" is counted from the DIRECT search of the manuscript, the same
      // measure the editor badges each row with — not from candidate matching,
      // which asks a different question and answers it differently.
      const partial = r.counts?.partial || 0
      const found = r.counts?.present || 0
      const missing = r.counts?.absent || 0
      const parts = [`${found}/${rows} KRT row${rows === 1 ? '' : 's'} found in the manuscript`]
      if (partial > 0) parts.push(`${partial} partial match${partial === 1 ? '' : 'es'}`)
      if (missing > 0) parts.push(`${missing} not in the text`)
      if (unmatched > 0) parts.push(`${unmatched} unmatched candidate${unmatched === 1 ? '' : 's'}`)
      return parts.join(', ')
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
/**
 * Rows whose values contradict the manuscript.
 *
 * Shown on the card rather than only inside the modal: a conflict means the KRT
 * and the paper disagree, so one of the two is wrong. That is a defect to
 * resolve, not a detail to browse for, and it should not need opening a table
 * to discover.
 *
 * @param {object} job
 * @returns {number} 0 when there are none, or the job is not grounding
 */
function conflictCount(job) {
  if (job.type !== 'krt_grounding' || job.status !== 'complete') return 0
  return job.result?.counts?.conflicts || 0
}

function getResultTitle(job) {
  const summary = getResultSummary(job)
  const base = `Results of ${job.label}`
  if (!job.status) return base
  const badge = getResultBadgeText(job)
  return summary ? `${base}: ${badge} \u2014 ${summary}` : `${base}: ${badge}`
}

/**
 * Under a seeded pipeline the candidate pool contains the model's echo of the
 * author's own rows, so "Found" can mean "the model repeated the row we handed
 * it" and the output cannot tell that from a real find. Those columns are
 * withheld rather than shown with a caveat nobody reads.
 *
 * Presence is unaffected — it searches the manuscript directly and never
 * consults the candidate pool — so it is shown in every pipeline.
 */

/** Columns for the grounding table — same two-row shape as the detectors. */

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

</script>

<template>
  <!-- The whole card carries the state: blue while work is happening, amber
       when the pipeline is paused on the user, red when it cannot continue. -->
  <div
    class="job-status-wrapper job-status-card"
    :class="{ 'job-status-card-blocked': blockedByIssue }"
  >
    <p v-if="statusUnreadable" class="job-status-unreadable" role="status">
      The status of these steps could not be read — the page did not reach the
      server. This is not a report that nothing has run.
    </p>

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
        <!-- The title IS the link to the pipeline overview. RouterLink, so
             ctrl-click opens it beside the submission — which is how you read a
             result against the KRT. -->
        <RouterLink
          :to="{ name: 'submission-pipeline', params: { id: submissionId } }"
          class="job-status-eta-label job-status-eta-label-link"
          v-tooltip="'See the whole pipeline: every step, what it waits for, and what it produced'"
          @click.stop
        >
          Pipeline ↗
        </RouterLink>
        <!-- The remaining time's slot says why there is no remaining time.
             Nothing is going to finish while the pipeline is paused, so an
             estimate there would be a lie — and this is the line the user
             already reads for "what is happening now". The estimate comes back
             by itself on the next step. -->
        <span v-if="blockedByIssue" class="job-status-eta-state job-status-eta-state-blocked">
          <strong>Analysis is paused: an earlier step needs a decision.</strong>
          {{ blockedCount }} step{{ blockedCount === 1 ? '' : 's' }}
          {{ blockedCount === 1 ? 'is' : 'are' }} held behind it. The step that stopped says what went
          wrong below;
          <template v-if="canRestartJobs">retry it, or continue without it.</template>
          <template v-else>ask a curator to retry it or continue without it.</template>
        </span>
        <span v-else-if="etaVisible" class="job-status-eta-remaining">{{ etaLabel }}</span>
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
          <span v-if="jobSummary.cancelled > 0" class="job-summary-badge job-status-cancelled">
            {{ jobSummary.cancelled }} cancelled
          </span>
          <!-- Eleven, not twelve, and deliberately so: this panel is shown on the
               KRT and Manuscript steps, and the Availability Statement check
               belongs to the Availability step. Counting a step the user has
               not reached would leave the badge permanently short of its own
               total. The tooltip says which step the twelfth is on, so the
               difference from the pipeline page reads as a scope rather than a
               missing step. -->
          <span
            v-tooltip="'These are the ' + jobSummary.total + ' steps that read the manuscript and your Key Resources Table, which you handle on steps 1 and 2. The pipeline has one more — the Availability Statement check — and it runs on step 4, once you confirm your statement.'"
            class="job-summary-badge job-status-complete"
          >
            {{ jobSummary.done }}/{{ jobSummary.total }} done
          </span>
        </div>
      </div>
      <div v-if="etaVisible && !paused" class="job-status-eta-track">
        <div
          class="job-status-eta-fill"
          :class="{ 'job-status-eta-fill-done': allDone }"
          :style="{ width: `${etaProgress * 100}%` }"
        ></div>
      </div>
      <p v-if="anyInFlight && !paused" class="job-status-eta-hint">
        You can keep editing the Key Resources Table, but these steps read the version frozen when the round started — your edits reach the analysis on the next run, not this one.
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
        <!-- Cancel switch (#15): abort a wrong document instead of waiting for
             the whole pipeline to finish. Only while something is in flight. -->
        <button
          v-if="anyInFlight && cancelProcessingFn"
          type="button"
          class="job-status-cancel-btn"
          :disabled="cancelling"
          v-tooltip="'Stop every pipeline step still to run for this document'"
          @click="handleCancelProcessing"
        >
          {{ cancelling ? 'Cancelling…' : 'Cancel processing' }}
        </button>
      </div>
    </div>

    <!-- Expandable grid -->
    <div v-show="!isCollapsed" class="job-status-panel">
      <!-- Every tile is a LINK to that module's page — whole tile, so ctrl-click
           and middle-click open it in a tab like anything else.
           
           There used to be a second destination: a modal, for any job that was
           not `complete`. So the same click showed one thing for a finished
           module and another for a failed one, and the modal was the older,
           thinner view — no run history, no frozen inputs, no restart that says
           what it takes with it. A module is worth the same page whatever state
           it is in; "it failed" is exactly when you want the record. -->
      <RouterLink
        v-for="job in jobList"
        :key="job.type"
        :to="{ name: 'submission-module', params: { id: submissionId, type: job.type } }"
        class="job-status-item job-status-item-link"
        :class="{ 'job-status-item-needs-decision': issueFor(job) }"
      >
        <!-- Line 1: Configuration pill (On / Demo / Off) -->
        <div class="job-config-line" v-tooltip="getLiveConfigTitle(job)">
          <span :class="getConfigPillClass(job)">{{ getConfigPillText(job) }}</span>
          <span class="job-label">{{ job.label }}</span>
        </div>
        <!-- Line 2: Job result -->
        <div class="job-result-line" v-tooltip="getResultTitle(job)">
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
          <!-- The Partial badge carries its own explanation: the badge says
               something went wrong, and hovering says what. Anywhere else the
               user would have to guess why the table is short. -->
          <span
            class="job-status-badge"
            :class="getResultBadgeClass(job)"
            v-tooltip="partialDetail(job)"
          >
            {{ getResultBadgeText(job) }}
          </span>
          <!-- Only from run 2 onward: "run 1" on a healthy pipeline is noise on
               every tile. The number appears exactly when it starts carrying
               information.

               It is the PIPELINE run's number, the same across every tile — so
               the tooltip has to say how many times THIS step ran separately,
               because a run can carry a step over rather than re-executing it,
               and the two numbers then differ. Saying "run 3" while meaning
               "this ran three times" was true under the old per-step numbering
               and is not any more. -->
          <span
            v-if="job.runNumber > 1"
            class="job-run-badge"
            v-tooltip="runBadgeTooltip(job)"
          >run {{ job.runNumber }}</span>
          <span v-if="getResultSummary(job)" class="job-result-summary">{{ getResultSummary(job) }}</span>

          <!-- A KRT/manuscript disagreement is a defect, not a statistic, so it
               gets its own badge in the error colour rather than a clause at
               the end of a grey summary line. -->
          <span
            v-if="conflictCount(job) > 0"
            class="job-summary-badge job-conflict-badge"
            v-tooltip="conflictCount(job) + ' KRT row(s) hold a value the manuscript contradicts. One of the two is wrong — open the module to see which values differ.'"
          >{{ conflictCount(job) }} conflict{{ conflictCount(job) === 1 ? '' : 's' }}</span>
        </div>

        <!-- The decision, on the step it is about. The buttons stop the click
             from opening the module page underneath them. -->
        <div v-if="issueFor(job)" class="job-decision-line">
          <span class="job-decision-consequence">
            Continue and {{ issueConsequence(issueFor(job)) }}.
          </span>
          <span v-if="canRestartJobs" class="job-decision-actions">
            <button
              type="button"
              class="job-decision-btn job-decision-retry"
              :disabled="!!decisionBusy"
              @click.prevent.stop="onDecide(job, 'retry')"
            >{{ decisionBusy === job.type + ':retry' ? 'Retrying…' : 'Retry' }}</button>
            <button
              type="button"
              class="job-decision-btn job-decision-continue"
              :disabled="!!decisionBusy"
              @click.prevent.stop="onDecide(job, 'continue')"
            >{{ decisionBusy === job.type + ':continue' ? 'Continuing…' : 'Continue without it' }}</button>
          </span>
        </div>
      </RouterLink>
    </div>
  </div>

</template>

<style scoped>
/* The step that stopped the pipeline, marked where the failure already shows. */
.job-status-item-needs-decision {
  background: #fef2f2;
  box-shadow: inset 0 0 0 1px #fecaca;
  border-radius: 0.375rem;
}
.job-decision-line {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 0.25rem;
  padding-left: 1.5rem;
}
.job-decision-consequence {
  font-size: 0.6875rem;
  color: #991b1b;
}
.job-decision-actions { display: flex; gap: 0.25rem; }
.job-decision-btn {
  padding: 0.0625rem 0.5rem;
  border-radius: 0.25rem;
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.35;
  cursor: pointer;
}
.job-decision-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.job-decision-retry { background: #b91c1c; color: #fff; }
.job-decision-retry:hover:not(:disabled) { background: #991b1b; }
.job-decision-continue { background: #fff; color: #7f1d1d; border: 1px solid #fca5a5; }
.job-decision-continue:hover:not(:disabled) { background: #fef2f2; }

.job-run-badge {
  flex: none;
  padding: 0.0625rem 0.375rem;
  border-radius: 999px;
  background: #eef2ff;
  color: #4338ca;
  font-size: 0.6875rem;
  font-weight: 600;
}.job-status-unreadable {
  margin: 0 0 0.75rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid #fcd34d;
  border-radius: 0.375rem;
  background: #fffbeb;
  color: #92400e;
  font-size: 0.8125rem;
  line-height: 1.4;
}

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
/* Blocked, read at a glance from across the page. (There was an amber "paused
   on the user" treatment beside this one; it went with the KRT-gate banner —
   nothing pauses this panel on the user any more.) */
.job-status-card-blocked,
.job-status-card-blocked.job-status-wrapper {
  background: #fef2f2;
  border-color: #fecaca;
}
.job-status-card-blocked .job-status-eta-label { color: #b91c1c; }
.job-status-card-blocked .job-status-eta-icon { color: #dc2626; }
/* Takes the room the estimate had, and wraps into it rather than pushing the
   status badges off the row. */
.job-status-eta-state {
  flex: 1 1 16rem;
  min-width: 0;
  font-size: 0.75rem;
  line-height: 1.4;
}
.job-status-eta-state-blocked { color: #b91c1c; }
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
/* The title carries the link now, so it must not look like body text. */
.job-status-eta-label-link {
  text-decoration: none;
}
.job-status-eta-label-link:hover {
  text-decoration: underline;
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
.job-status-cancel-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  background: transparent;
  border: 1px solid #fecaca;
  border-radius: 0.375rem;
  padding: 0.2rem 0.6rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: #b91c1c;
  cursor: pointer;
}
.job-status-cancel-btn:hover:not(:disabled) {
  background: #fef2f2;
  border-color: #f87171;
}
.job-status-cancel-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
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

/* Amber — the run produced real rows but an engine behind it failed. Deliberately
   not green (a short table would look complete) and not red (the rows it did
   find are good). Same amber the app uses for "needs your attention". */
.job-status-partial {
  background: #fef3c7;
  color: #92400e;
}

.job-status-idle {
  background: #f3f4f6;
  color: #6b7280;
}

/* User-cancelled job (#15) — neutral slate, distinct from a red failure. */
.job-status-cancelled {
  background: #e5e7eb;
  color: #4b5563;
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
}/* An EvidenceContext inside the context line brings its own typography and
   highlight; the cell's italic + muted colour would fight it. Reset there. */
.context-cell :deep(.evidence-context) {
  font-style: normal;
  border-left-color: #d1d5db;
}

.sdb-add    { background: #dcfce7; color: #166534; }
.sdb-update { background: #dbeafe; color: #1e40af; }
.sdb-remove { background: #fee2e2; color: #b91c1c; }
.sdb-skip   { background: #f3f4f6; color: #6b7280; }
.sdb-unreviewed { background: #fef3c7; color: #92400e; }

.sugg-role-author    { background: #eef2ff; color: #3730a3; }
.sugg-role-generated { background: #ecfeff; color: #155e75; }

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

.merged-from-chevron.open {
  transform: rotate(180deg);
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
}.text-center {
  text-align: center;
}.grounding-confirmed { background: #dcfce7; color: #15803d; }
.grounding-incomplete { background: #fef3c7; color: #b45309; }
.grounding-not-detected { background: #fee2e2; color: #b91c1c; }

.job-status-item-link { text-decoration: none; color: inherit; display: block; }
.job-conflict-badge {
  background: #fef2f2;
  color: #b91c1c;
  border: 1px solid #fecaca;
}
/* Outcome verdict: located, but only by a partial name match. Blue reads as
   "found, low confidence" rather than the grey of a degraded quote. */
.grounding-partial-match { background: #dbeafe; color: #1d4ed8; }.engine-softcite { background: #e0e7ff; color: #3730a3; }
.engine-lm { background: #ede9fe; color: #6d28d9; }

.grounding-fill-empty { color: #9ca3af; font-style: italic; cursor: help; }
</style>
