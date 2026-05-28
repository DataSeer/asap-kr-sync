<script setup>
import { ref, computed, onMounted, watch, provide, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSubmissionStore } from '@/stores/submission.store'
import { useKRTStore } from '@/stores/krt.store'
import { useNotificationStore } from '@/stores/notification.store'
import { setSubmissionTitle } from '@/router'
import pdfService from '@/services/pdf.service'
import softwareService from '@/services/software.service'
import orcidService from '@/services/orcid.service'
import datasetsService from '@/services/datasets.service'
import materialsService from '@/services/materials.service'
import protocolsService from '@/services/protocols.service'
import suggestionService from '@/services/suggestion.service'
import jobService from '@/services/job.service'
import KRTEditor from '@/components/krt/KRTEditor.vue'
import SubmissionHeader from '@/components/submission/SubmissionHeader.vue'
import BackgroundProcesses from '@/components/submission/BackgroundProcesses.vue'
import { useAuthStore } from '@/stores/auth.store'
import { useResourceTypesStore } from '@/stores/resourceTypes.store'

const route = useRoute()
const router = useRouter()
const submissionStore = useSubmissionStore()
const krtStore = useKRTStore()
const notificationStore = useNotificationStore()
const authStore = useAuthStore()
const resourceTypesStore = useResourceTypesStore()

// Used to gate the developer "re-validate" button on the KRT editor.
const isAdmin = computed(() => authStore.effectiveRole === 'admin')

const krtEditorRef = ref(null)
const submissionHeaderRef = ref(null)
const bgProcessesRef = ref(null)
function handleEditDas() {
  submissionHeaderRef.value?.openEditModal?.()
}
const replacingPdf = ref(false)
const showReplacePdfModal = ref(false)
const replacePdfInput = ref(null)
const analyzing = ref(false)
const analysisStatus = ref(null)
const findings = ref([])
const submission = computed(() => submissionStore.currentSubmission)

// Per-detector data feeds the JobStatusPanel "Show more" modal. These stay
// in the view because they're step-3-specific — KRTView doesn't fetch them.
// Vue's provide resolution walks the entire ancestry, so even though the
// BackgroundProcesses wrapper provides its own context below, JobStatusPanel
// (its descendant) can still see these provides.
const softwareMentionsItems = ref([])
provide('submissionSoftwareMentions', softwareMentionsItems)
const authorsItems = ref([])
provide('submissionAuthors', authorsItems)
const datasetItems = ref([])
provide('submissionDatasets', datasetItems)
const materialsItems = ref([])
provide('submissionMaterials', materialsItems)
const protocolsItems = ref([])
provide('submissionProtocols', protocolsItems)

// Shortcut accessors that delegate to the BackgroundProcesses ref once the
// child is mounted. Wrapping `jobs` as a computed so consumers (watch /
// other computed) react when the ref binds. defineExpose does NOT auto-
// unwrap refs, so we unwrap explicitly via `.jobs?.value`.
function refreshJobs() { return bgProcessesRef.value?.refresh?.() }
function revealJobsPanel() { bgProcessesRef.value?.reveal?.() }
function getJob(type) {
  // `getJob` reads from the live jobs ref inside the wrapper; calling it
  // through the exposed function keeps reactivity working across the boundary.
  return bgProcessesRef.value?.getJob?.(type) || null
}
// `defineExpose` auto-unwraps refs through the component proxy, so
// `bgProcessesRef.value.jobs` is already the underlying jobs map — adding
// `.value` reads from a plain object and yields `undefined`, freezing this
// computed to `{}` for the lifetime of the page. That breaks every downstream
// computed that relies on it (anyProcessFinished, allProcessesFinished),
// which in turn keeps the "Suggestions will be automatically populated"
// empty-state visible even after every job has hit 'complete'.
const jobs = computed(() => bgProcessesRef.value?.jobs || {})

// Derive analyzing state from job poller
const pdfAnalysisJob = computed(() => getJob('pdf_analysis'))
const pdfAnalysisPendingInput = computed(() => pdfAnalysisJob.value?.status === 'pending_input')
const advancingAnalysis = ref(false)

// True while PDF analysis hasn't finished. Includes 'waiting' because
// pdf_analysis often sits in that state while it queues on upstream
// detectors (datasets/materials/protocols/identifier). Used to render a
// loader inside the AI Suggestions section so the user can see suggestions
// aren't ready yet — without it, the section is hidden until the first
// process finishes and there's no signal that work is in flight.
const pdfAnalysisInFlight = computed(() => {
  const status = pdfAnalysisJob.value?.status
  return status === 'queued' || status === 'processing' || status === 'waiting'
})

watch(pdfAnalysisJob, (job) => {
  if (job) {
    analyzing.value = job.status === 'queued' || job.status === 'processing'
  }
})

/**
 * Manually advance PDF analysis from pending_input → queued.
 * Called after user has entered the DAS manually.
 */
async function handleAdvanceAnalysis() {
  advancingAnalysis.value = true
  try {
    await jobService.advanceJob(route.params.id, 'pdf_analysis')
    notificationStore.info('PDF analysis started')
    await refreshJobs()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to start analysis')
  } finally {
    advancingAnalysis.value = false
  }
}

// Wires job-completion side-effects (refreshing suggestions, surfacing
// notifications, etc.) into the shared BackgroundProcesses wrapper. Called
// from onMounted once bgProcessesRef is bound — the wrapper itself runs
// useJobPoller; we just register PDFView-specific reactions on top.
function registerJobCallbacks() {
  const bg = bgProcessesRef.value
  if (!bg) return

  bg.onJobComplete('pdf_analysis', async () => {
    analyzing.value = false
    analysisStatus.value = 'complete'
    await refreshSuggestions()
    notificationStore.success('Analysis complete')
  })
  bg.onJobFailed('pdf_analysis', () => {
    analyzing.value = false
    analysisStatus.value = 'failed'
    notificationStore.error('Analysis failed')
  })
  bg.onJobPendingInput('pdf_analysis', () => {
    notificationStore.info('Availability Statement not found — please enter it manually, then start the analysis.', 30000)
  })
  bg.onJobComplete('das_extraction', async () => {
    await submissionStore.fetchSubmission(route.params.id)
  })
  bg.onJobComplete('software_detection', async () => {
    await loadSoftwareMentions()
    await refreshSuggestions()
  })
  bg.onJobComplete('orcid_extraction', async () => {
    await loadAuthors()
  })
  bg.onJobComplete('datasets_detection', async () => {
    await loadDatasets()
    await refreshSuggestions()
  })
  bg.onJobComplete('markdown_convert', () => {
    // Markdown convert done — datasets detection will auto-start via pipeline.
  })
  bg.onJobComplete('materials_detection', async () => {
    await loadMaterials()
    await refreshSuggestions()
  })
  bg.onJobComplete('protocols_detection', async () => {
    await loadProtocols()
    await refreshSuggestions()
  })
  bg.onJobComplete('identifier_detection', async () => {
    // Identifier scan items feed pdf_analysis directly via merge-detections,
    // so there's no per-category panel to reload — refresh suggestions so
    // any new matches surface.
    await refreshSuggestions()
  })
}
const latestFiles = computed(() => submissionStore.latestFiles)
const pdfFile = computed(() => latestFiles.value?.pdf)
const krtFile = computed(() => latestFiles.value?.krt)

// True when every background process has reached a final state (complete or
// failed). Excludes pending_input and waiting — those are "blocked, not done",
// and the user should still see the prompt that lets them act on it.
const allProcessesFinished = computed(() => {
  const list = Object.values(jobs.value || {})
  if (list.length === 0) return false
  const inFlight = list.some(j =>
    j.status === 'waiting' || j.status === 'queued' ||
    j.status === 'processing' || j.status === 'pending_input'
  )
  if (inFlight) return false
  return list.every(j => j.status === 'complete' || j.status === 'failed')
})

// True as soon as at least one process has produced a final result. Used to
// reveal the empty-state hint early — the user shouldn't have to wait for the
// slowest job to learn that nothing has been suggested yet.
const anyProcessFinished = computed(() => {
  const list = Object.values(jobs.value || {})
  return list.some(j => j.status === 'complete' || j.status === 'failed')
})

// "Review suggestions" is satisfied when there are pending suggestions to
// handle and they've all been handled — OR when all processes have finished
// and there are no suggestions at all (nothing to review).
const reviewSuggestionsDone = computed(() => {
  if (findings.value.length > 0) {
    return pendingFindings.value.length === 0
  }
  return allProcessesFinished.value
})

// "Resolve validation errors" is satisfied when analysis is complete and there
// are no errors to fix. Also auto-satisfied when all processes finish with
// zero errors (covers the no-suggestions path where the user never touched
// anything in the KRT).
const validationDone = computed(() =>
  (analysisStatus.value === 'complete' || allProcessesFinished.value) &&
  krtStore.summary.totalErrors === 0
)

// Step help items
const helpItems = computed(() => [
  {
    title: 'Review suggestions',
    children: ['Approve or reject each suggestion (required) and make relevant edits'],
    done: reviewSuggestionsDone.value
  },
  {
    title: 'Resolve validation errors',
    children: ['Address all red errors (required) and yellow warnings (recommended)'],
    done: validationDone.value
  },
  {
    title: 'Click "Continue" to proceed to Step 4',
    done: false
  }
])

// Check if user can proceed to next step
const canGoNext = computed(() => {
  return !!pdfFile.value &&
    reviewSuggestionsDone.value &&
    validationDone.value
})

const nextBlockedReason = computed(() => {
  if (!pdfFile.value) {
    return 'Upload a PDF file first'
  }
  if (!allProcessesFinished.value && analysisStatus.value !== 'complete') {
    return 'Run analysis (or load demo) before continuing'
  }
  if (findings.value.length > 0 && pendingFindings.value.length > 0) {
    const n = pendingFindings.value.length
    return `Approve or reject ${n} remaining suggestion${n > 1 ? 's' : ''} before continuing`
  }
  if (krtStore.summary.totalErrors > 0) {
    const n = krtStore.summary.totalErrors
    return `Fix ${n} error${n > 1 ? 's' : ''} in the KRT before continuing`
  }
  return ''
})

// AI Suggestions carousel navigation
const currentSuggestionIndex = ref(0)

// Filter tabs for AI suggestions
const suggestionTabGroups = [
  { key: 'all', label: 'All' },
  { key: 'Datasets', label: 'Datasets' },
  { key: 'Software/code', label: 'Software/code' },
  { key: 'Protocols', label: 'Protocols' },
  { key: 'Lab Materials', label: 'Key Lab Materials' }
]
const activeSuggestionTab = ref('all')

// Rejection reason modal state
const showRejectModal = ref(false)
const rejectingFinding = ref(null)
const rejectionReason = ref('')

onMounted(async () => {
  // Reset state for the new submission
  replacingPdf.value = false
  analyzing.value = false
  analysisStatus.value = null
  findings.value = []

  // Clear previous KRT data before loading new submission
  krtStore.clearKRT()

  // The BackgroundProcesses child is mounted before the parent, so its ref
  // is bound by the time we get here — wire our job-completion callbacks
  // into the shared poller.
  registerJobCallbacks()

  // Load resource type categories (non-blocking) — service status is owned
  // by the BackgroundProcesses wrapper now.
  resourceTypesStore.fetchResourceTypeNames().catch(() => {})

  await submissionStore.fetchSubmission(route.params.id)
  await krtStore.fetchKRT(route.params.id)
  await checkAnalysisStatus()
  await loadSoftwareMentions()
  await loadAuthors()
  await loadDatasets()
  await loadMaterials()
  await loadProtocols()
})

// Update page title with submission ID
watch(submission, (sub) => {
  if (sub?.manuscriptId) {
    setSubmissionTitle(sub.manuscriptId || sub.title, 'Step 3: Manage suggestions')
  }
}, { immediate: true })

// Reset suggestion index when findings change significantly
watch(() => findings.value.length, () => {
  currentSuggestionIndex.value = 0
})

// Reset suggestion index when tab changes
watch(activeSuggestionTab, () => {
  currentSuggestionIndex.value = 0
})

async function refreshSuggestions() {
  try {
    const result = await suggestionService.getSuggestions(route.params.id)
    findings.value = result.suggestions || []
    krtStore.setAiSuggestions(findings.value)
  } catch {
    // Suggestions not available yet
  }
}

async function checkAnalysisStatus() {
  try {
    const status = await pdfService.getAnalysisStatus(route.params.id)
    analysisStatus.value = status.status

    // Always load suggestions from all sources
    await refreshSuggestions()
  } catch (error) {
    // No analysis yet - try to fetch any existing suggestions
    await refreshSuggestions()
  }
}

async function loadSoftwareMentions() {
  try {
    const data = await softwareService.getMentions(route.params.id)
    softwareMentionsItems.value = data?.items || []
  } catch {
    softwareMentionsItems.value = []
  }
}

async function loadAuthors() {
  try {
    const data = await orcidService.getAuthors(route.params.id)
    authorsItems.value = data?.authors || []
  } catch {
    authorsItems.value = []
  }
}

async function loadDatasets() {
  try {
    const data = await datasetsService.getMentions(route.params.id)
    datasetItems.value = data?.items || []
  } catch {
    datasetItems.value = []
  }
}

async function loadMaterials() {
  try {
    const data = await materialsService.getMentions(route.params.id)
    materialsItems.value = data?.items || []
  } catch {
    materialsItems.value = []
  }
}

async function loadProtocols() {
  try {
    const data = await protocolsService.getMentions(route.params.id)
    protocolsItems.value = data?.items || []
  } catch {
    protocolsItems.value = []
  }
}

// PDF replace flow — gated by the warning modal because re-uploading the
// PDF restarts every background process and invalidates existing suggestions.
function openReplacePdfDialog() {
  showReplacePdfModal.value = true
}

function closeReplacePdfModal() {
  showReplacePdfModal.value = false
}

function triggerReplacePdfPicker() {
  replacePdfInput.value?.click()
}

async function handleReplacePdfFile(event) {
  const file = event.target.files[0]
  if (!file) return
  closeReplacePdfModal()

  replacingPdf.value = true
  try {
    await pdfService.upload(route.params.id, file)
    notificationStore.success('PDF replaced — background processes are restarting')
    await submissionStore.fetchSubmission(route.params.id)
    // Backend auto-triggers DAS + PDF analysis pipeline on upload, which is
    // the same as restarting every process.
    findings.value = []
    analysisStatus.value = null
    await refreshJobs()
    revealJobsPanel()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to replace PDF')
  } finally {
    replacingPdf.value = false
    event.target.value = ''
  }
}

/**
 * Re-run all background processes via the orchestrator
 */
async function handleRerunAnalysis() {
  // Optimistically wipe the old AI suggestions the moment the user clicks
  // Re-run all. Without this, `findings.value` stays populated through the
  // `runAllProcesses` await and the next poller tick, so the user watches
  // stale suggestions sit on screen while the progress bar already starts
  // filling. The inner empty-state template (see below) treats `analyzing`
  // as an in-flight signal so we render the spinner instead of the
  // "Your KRT already contains everything we found" success copy during
  // the gap before the poller picks up the new 'waiting' job statuses.
  analyzing.value = true
  analysisStatus.value = null
  findings.value = []
  krtStore.clearAiSuggestions()
  try {
    await jobService.runAllProcesses(route.params.id)
    notificationStore.info('All processes re-started')
    await refreshJobs()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to restart processes')
    analyzing.value = false
  }
}

// Per-suggestion editable values keyed by suggestion id. For add_row
// suggestions this holds the full row shape (resourceType, resourceName,
// source, identifier, newReuse, additionalInformation) seeded from the AI's
// values. The user can edit any cell inline; on Approve we diff against the
// AI's values and send only the changed fields as `overrides`. For edit
// suggestions we hold the single modified target value as a string.
const suggestionOverrides = ref({})

// Helper that seeds the override entry for a single pending suggestion.
// The watcher that calls this lives AFTER currentSuggestion's declaration
// further down in the file — putting it here would hit a temporal dead
// zone on `currentSuggestion` at <script setup> load time.
function seedSuggestionOverride(suggestion) {
  if (!suggestion || suggestion.status !== 'pending') return
  if (suggestionOverrides.value[suggestion.id]) return
  if (suggestion.type === 'add_row' && suggestion.data) {
    suggestionOverrides.value[suggestion.id] = {
      resourceType:          suggestion.data.resourceType || '',
      resourceName:          suggestion.data.resourceName || '',
      source:                suggestion.data.source || '',
      identifier:            suggestion.data.identifier || '',
      newReuse:              suggestion.data.newReuse || '',
      additionalInformation: suggestion.data.additionalInformation || ''
    }
  } else if (suggestion.type === 'edit' && suggestion.data) {
    suggestionOverrides.value[suggestion.id] = suggestion.data.newValue || ''
  }
}

/**
 * Compute the overrides payload for backend approval. Returns the diff
 * between the user's edits and the AI's original values, or null if nothing
 * was changed. Backend's approveSuggestion falls back to AI values for any
 * field not present in `overrides`, so we send only what the user touched.
 */
function getApprovalOverrides(finding) {
  if (finding.type !== 'add_row') return null
  const local = suggestionOverrides.value[finding.id]
  if (!local || typeof local !== 'object') return null
  const original = finding.data || {}
  const diff = {}
  for (const key of Object.keys(local)) {
    const userVal = (local[key] ?? '').toString()
    const aiVal = (original[key] ?? '').toString()
    if (userVal !== aiVal) diff[key] = userVal
  }
  return Object.keys(diff).length > 0 ? diff : null
}

/**
 * For edit suggestions, return the user's modified value (if any) — the
 * approve endpoint accepts a single `modifiedValue` rather than the full
 * overrides object for edits.
 */
function getEditModifiedValue(finding) {
  if (finding.type !== 'edit') return null
  const local = suggestionOverrides.value[finding.id]
  if (typeof local !== 'string') return null
  const aiVal = (finding.data?.newValue ?? '').toString()
  return local !== aiVal ? local : null
}

async function handleApprove(finding) {
  try {
    const overrides = getApprovalOverrides(finding)
    const modifiedValue = getEditModifiedValue(finding)
    await suggestionService.approveSuggestion(route.params.id, finding.id, modifiedValue, overrides)
    finding.status = 'approved'
    // Update store status
    krtStore.updateSuggestionStatus(finding.id, 'approved')
    // Re-validate KRT to update validation errors after the change
    await krtStore.validate(route.params.id)
    const userEdited = !!(overrides || modifiedValue)
    notificationStore.success(userEdited ? 'Change approved with your edits' : 'Change approved')
    advanceToNextSuggestion()
  } catch (error) {
    notificationStore.error('Failed to approve change')
  }
}

function openRejectModal(finding) {
  rejectingFinding.value = finding
  rejectionReason.value = ''
  showRejectModal.value = true
}

function cancelReject() {
  showRejectModal.value = false
  rejectingFinding.value = null
}

async function confirmReject() {
  if (!rejectingFinding.value) return
  const finding = rejectingFinding.value
  const reason = rejectionReason.value.trim()
  showRejectModal.value = false
  rejectingFinding.value = null
  await handleReject(finding, reason)
}

// Belt-and-suspenders: any time the modal hides (cancel / confirm / overlay
// click / programmatic dismissal), wipe the textarea state. Previously each
// dismissal path reset the text individually, which let a value sometimes
// leak to the next suggestion when a path was missed. Centralising the
// reset on the close event guarantees we never carry state across openings.
watch(showRejectModal, (visible) => {
  if (!visible) {
    rejectionReason.value = ''
    rejectingFinding.value = null
  }
})

async function handleReject(finding, reason = '') {
  try {
    await suggestionService.rejectSuggestion(route.params.id, finding.id, reason)
    finding.status = 'rejected'
    // Update store status
    krtStore.updateSuggestionStatus(finding.id, 'rejected')
    notificationStore.info('Change rejected')
    advanceToNextSuggestion()
  } catch (error) {
    notificationStore.error('Failed to reject change')
  }
}

async function handleNext() {
  if (krtStore.summary.totalErrors > 0) {
    notificationStore.warning('Please fix all KRT errors before proceeding')
    return
  }
  try {
    // Re-validate KRT to get fresh error count
    await krtStore.validate(route.params.id)

    if (krtStore.summary.totalErrors > 0) {
      notificationStore.warning('Validation found errors. Please fix them before proceeding.')
      return
    }

    // Update status to step_review
    await submissionStore.updateSubmission(route.params.id, { status: 'step_review' })
    router.push({ name: 'submission-review', params: { id: route.params.id } })
  } catch (error) {
    notificationStore.error('Failed to continue')
  }
}

async function handleBack() {
  try {
    // Update status to step_krt
    await submissionStore.updateSubmission(route.params.id, { status: 'step_krt' })
    router.push({ name: 'submission-krt', params: { id: route.params.id } })
  } catch (error) {
    notificationStore.error('Failed to go back')
  }
}

async function handleValidate() {
  try {
    await krtStore.validate(route.params.id)
    const errors = krtStore.summary.totalErrors
    const warnings = krtStore.summary.totalWarnings

    if (errors === 0 && warnings === 0) {
      notificationStore.success('KRT is valid!')
    } else if (errors === 0 && warnings > 0) {
      notificationStore.success(`KRT is valid with ${warnings} warning${warnings > 1 ? 's' : ''}.`)
    } else {
      const parts = []
      if (errors > 0) parts.push(`${errors} error${errors > 1 ? 's' : ''}`)
      if (warnings > 0) parts.push(`${warnings} warning${warnings > 1 ? 's' : ''}`)
      notificationStore.error(`Found ${parts.join(' and ')}. Fix errors before proceeding.`)
    }
  } catch (error) {
    notificationStore.error('Validation failed')
  }
}

const pendingFindings = computed(() => findings.value.filter(f => f.status === 'pending'))

// Get original-case resource type name from a finding (for store lookup).
// KRT rows from the backend use uppercase keys ('RESOURCE TYPE'); accept both
// shapes so edit suggestions can locate their resource type for tab grouping.
function rowResourceType(row) {
  return row?.['RESOURCE TYPE'] || row?.resourceType || ''
}
function rowResourceName(row) {
  return row?.['RESOURCE NAME'] || row?.resourceName || ''
}
function getOriginalResourceType(finding) {
  if (finding.data?.resourceType) return finding.data.resourceType
  if (finding.data?.rowId) {
    const row = krtStore.rows.find(r => r.id === finding.data.rowId)
    const rt = rowResourceType(row)
    if (rt) return rt
  }
  if (finding.data?.rowNumber && krtStore.rows.length > 0) {
    const row = krtStore.rows[finding.data.rowNumber - 1]
    const rt = rowResourceType(row)
    if (rt) return rt
  }
  if (finding.data?.resourceName) {
    const nameLC = finding.data.resourceName.toLowerCase()
    const row = krtStore.rows.find(r => rowResourceName(r).toLowerCase() === nameLC)
    const rt = rowResourceType(row)
    if (rt) return rt
  }
  return ''
}

// Check if a finding matches the current filter tab (uses DB resource type categories)
function findingMatchesTab(finding, tabKey) {
  if (tabKey === 'all') return true
  const resourceType = getOriginalResourceType(finding)
  if (!resourceType) return false
  return resourceTypesStore.getTabGroup(resourceType) === tabKey
}

// Get count for each suggestion tab
function getSuggestionTabCount(tabKey) {
  if (tabKey === 'all') return findings.value.length
  return findings.value.filter(f => findingMatchesTab(f, tabKey)).length
}

// Get pending count for each tab
function getSuggestionTabPendingCount(tabKey) {
  if (tabKey === 'all') return pendingFindings.value.length
  return findings.value.filter(f => f.status === 'pending' && findingMatchesTab(f, tabKey)).length
}

/**
 * Sort key for a finding that mirrors the KRT Editor's row layout:
 *   1. resource-type group order (resourceTypesStore.getGroupSortOrder)
 *   2. resource name A-Z (case-insensitive)
 * Add-row suggestions sort as if they were inserted in their would-be
 * position. Edit/delete suggestions inherit their target row's resource
 * type + name. This means the AI suggestion panel's next/prev navigation
 * walks suggestions in the same visual order as the KRT table.
 */
function getFindingSortKey(finding) {
  let resourceType = ''
  let resourceName = ''
  if (finding.type === 'add_row') {
    resourceType = finding.data?.resourceType || ''
    resourceName = finding.data?.resourceName || ''
  } else {
    const row = getKrtRowForFinding(finding)
    resourceType = rowResourceType(row)
    resourceName = rowResourceName(row)
  }
  return {
    groupOrder: resourceTypesStore.getGroupSortOrder(resourceType),
    typeOrder: resourceTypesStore.getTypeSortOrder(resourceType),
    name: (resourceName || '').toLowerCase()
  }
}

// Filter and sort findings to match the KRT Editor table's row order.
const sortedFindings = computed(() => {
  const filtered = findings.value.filter(f => findingMatchesTab(f, activeSuggestionTab.value))
  return [...filtered].sort((a, b) => {
    const ka = getFindingSortKey(a)
    const kb = getFindingSortKey(b)
    if (ka.groupOrder !== kb.groupOrder) return ka.groupOrder - kb.groupOrder
    if (ka.typeOrder !== kb.typeOrder) return ka.typeOrder - kb.typeOrder
    const byName = ka.name.localeCompare(kb.name)
    if (byName !== 0) return byName
    // Same row / same target: keep edits stable, prefer pending so action
    // items surface first when multiple suggestions hit the same target.
    if (a.status === 'pending' && b.status !== 'pending') return -1
    if (a.status !== 'pending' && b.status === 'pending') return 1
    return 0
  })
})

// Current suggestion being displayed (from sorted list)
const currentSuggestion = computed(() => sortedFindings.value[currentSuggestionIndex.value] || null)

// Seed an override entry whenever the user lands on a new pending suggestion.
// Defined here (after `currentSuggestion`) to avoid a temporal dead zone —
// the watcher's source function runs at setup time and would otherwise
// reference an uninitialized binding.
watch(currentSuggestion, seedSuggestionOverride, { immediate: true })

// Total suggestions count
const totalSuggestionsCount = computed(() => sortedFindings.value.length)

// Navigation functions for suggestions carousel
function goToPrevSuggestion() {
  if (currentSuggestionIndex.value > 0) {
    currentSuggestionIndex.value--
  }
}

function goToNextSuggestion() {
  if (currentSuggestionIndex.value < sortedFindings.value.length - 1) {
    currentSuggestionIndex.value++
  }
}

function goToSuggestion(index) {
  if (index >= 0 && index < sortedFindings.value.length) {
    currentSuggestionIndex.value = index
  }
}

/**
 * Called when the user clicks a suggestion row in the KRTEditor table.
 * Switches the suggestion-filter tab if needed (so the suggestion is in the
 * sorted/filtered list), sets the current index, and scrolls the page up to
 * the AI suggestions section.
 */
async function selectSuggestionById(suggestionId) {
  const finding = findings.value.find(f => f.id === suggestionId)
  if (!finding) return
  if (!findingMatchesTab(finding, activeSuggestionTab.value)) {
    activeSuggestionTab.value = 'all'
  }
  // Wait one tick so sortedFindings reflects the (possibly new) tab.
  await nextTick()
  const idx = sortedFindings.value.findIndex(f => f.id === suggestionId)
  if (idx !== -1) currentSuggestionIndex.value = idx
  scrollToSuggestions()
}

// Auto-advance to next pending suggestion after action
function advanceToNextSuggestion() {
  setTimeout(() => {
    // Find next pending suggestion
    const nextPendingIndex = sortedFindings.value.findIndex(
      (f, i) => i > currentSuggestionIndex.value && f.status === 'pending'
    )
    if (nextPendingIndex !== -1) {
      currentSuggestionIndex.value = nextPendingIndex
    } else {
      // No more pending after current, try from beginning
      const firstPendingIndex = sortedFindings.value.findIndex(f => f.status === 'pending')
      if (firstPendingIndex !== -1) {
        currentSuggestionIndex.value = firstPendingIndex
      }
      // If no pending left, stay on current
    }
  }, 100)
}

// Column display mapping for KRT rows (using uppercase keys to match KRT store)
const krtColumns = [
  { key: 'RESOURCE TYPE', label: 'Type' },
  { key: 'RESOURCE NAME', label: 'Name' },
  { key: 'SOURCE', label: 'Source' },
  { key: 'IDENTIFIER', label: 'Identifier' },
  { key: 'NEW/REUSE', label: 'New/Reuse' },
  { key: 'ADDITIONAL INFORMATION', label: 'Additional Info' }
]

// Lowercase field → uppercase KRT column key. Inverse of the partial map
// `columnToKrtKey` below; explicit for clarity in the cellState helper.
const FIELD_TO_KRT_COLUMN = {
  resourceType:          'RESOURCE TYPE',
  resourceName:          'RESOURCE NAME',
  source:                'SOURCE',
  identifier:            'IDENTIFIER',
  newReuse:              'NEW/REUSE',
  additionalInformation: 'ADDITIONAL INFORMATION'
}

// Map column name from finding data to KRT uppercase key
const columnToKrtKey = {
  'resource_type': 'RESOURCE TYPE',
  'resourceType': 'RESOURCE TYPE',
  'RESOURCE TYPE': 'RESOURCE TYPE',
  'resource_name': 'RESOURCE NAME',
  'resourceName': 'RESOURCE NAME',
  'RESOURCE NAME': 'RESOURCE NAME',
  'source': 'SOURCE',
  'SOURCE': 'SOURCE',
  'identifier': 'IDENTIFIER',
  'IDENTIFIER': 'IDENTIFIER',
  'new_reuse': 'NEW/REUSE',
  'newReuse': 'NEW/REUSE',
  'NEW/REUSE': 'NEW/REUSE',
  'additional_information': 'ADDITIONAL INFORMATION',
  'additionalInformation': 'ADDITIONAL INFORMATION',
  'ADDITIONAL INFORMATION': 'ADDITIONAL INFORMATION'
}

// Helper to get KRT row for a finding - matches by rowId, oldValue, newValue, or resourceName
function getKrtRowForFinding(finding) {
  if (!finding.data) return null

  // Try to match by rowId first (most reliable)
  if (finding.data.rowId) {
    const found = krtStore.rows.find(row => row.id === finding.data.rowId)
    if (found) return found
  }

  // Get the column key in KRT format
  const col = finding.data.column
  const krtColumnKey = columnToKrtKey[col] || col

  // Try to find the row where the oldValue matches
  if (finding.data.oldValue !== undefined) {
    const found = krtStore.rows.find(row => {
      const cellValue = row[krtColumnKey] || ''
      const oldValue = finding.data.oldValue || ''
      return cellValue.trim() === oldValue.trim()
    })
    if (found) return found
  }

  // Try to find the row where the newValue matches (after approval)
  if (finding.data.newValue !== undefined) {
    const found = krtStore.rows.find(row => {
      const cellValue = row[krtColumnKey] || ''
      const newValue = finding.data.newValue || ''
      return cellValue.trim() === newValue.trim()
    })
    if (found) return found
  }

  // If resourceName is provided in finding data, match by that
  if (finding.data.resourceName) {
    const found = krtStore.rows.find(row => {
      const rowName = row['RESOURCE NAME'] || ''
      return rowName.toLowerCase().includes(finding.data.resourceName.toLowerCase())
    })
    if (found) return found
  }

  return null
}

// Map column name from finding data to KRT key (for highlighting)
function getColumnKey(columnName) {
  return columnToKrtKey[columnName] || columnName
}

/**
 * Compute the render state for one cell of a suggestion row. Centralizes the
 * decision tree so the template doesn't have to branch through all the cases.
 *
 * For add_row: cells pre-fill from finding.data (editable for pending).
 * For edit: target cell shows old strikethrough + new value (editable for
 *           pending); non-target cells show the user's current KRT row value
 *           as read-only context.
 * For delete_row: all cells show the current KRT row value, struck through.
 *
 * Returns:
 *   { mode, value, oldValue?, editable, isTarget? }
 *   mode ∈ 'add' | 'edit_target' | 'edit_context' | 'delete' | 'plain'
 */
function cellState(suggestion, fieldKey) {
  if (!suggestion) return { mode: 'plain', value: '', editable: false }
  const status = suggestion.status
  const type = suggestion.type
  const data = suggestion.data || {}

  if (type === 'add_row') {
    return {
      mode: 'add',
      value: data[fieldKey] ?? '',
      editable: status === 'pending'
    }
  }

  if (type === 'edit') {
    const targetKrtCol = columnToKrtKey[data.column]
    const fieldKrtCol = FIELD_TO_KRT_COLUMN[fieldKey]
    const krtRow = getKrtRowForFinding(suggestion)
    const currentValue = krtRow ? (krtRow[fieldKrtCol] ?? '') : ''
    if (targetKrtCol && targetKrtCol === fieldKrtCol) {
      return {
        mode: 'edit_target',
        value: data.newValue ?? '',
        oldValue: data.oldValue ?? currentValue ?? '',
        editable: status === 'pending',
        isTarget: true
      }
    }
    return { mode: 'edit_context', value: currentValue, editable: false }
  }

  if (type === 'delete_row') {
    const fieldKrtCol = FIELD_TO_KRT_COLUMN[fieldKey]
    const krtRow = getKrtRowForFinding(suggestion)
    return {
      mode: 'delete',
      value: krtRow ? (krtRow[fieldKrtCol] ?? '') : (data[fieldKey] ?? ''),
      editable: false
    }
  }

  return { mode: 'plain', value: data[fieldKey] ?? '', editable: false }
}

// Handle suggestion accepted from KRT Editor
function handleSuggestionAccepted(suggestion) {
  const finding = findings.value.find(f => f.id === suggestion.id)
  if (finding) {
    finding.status = 'approved'
  }
}

// Handle suggestion rejected from KRT Editor
function handleSuggestionRejected(suggestion) {
  const finding = findings.value.find(f => f.id === suggestion.id)
  if (finding) {
    finding.status = 'rejected'
  }
}

// Scroll to AI Suggestions section
function scrollToSuggestions() {
  const element = document.getElementById('ai-suggestions-section')
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

// Scroll the page to bring the KRT Editor into view, then scroll within it
function scrollPageToKrtEditor() {
  const krtSection = document.querySelector('.krt-editor')
  if (krtSection) {
    krtSection.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

// Scroll to a finding's row in the KRT Editor, centering on the relevant cell
function scrollToFindingRow(finding) {
  if (!finding) return

  // First, scroll the page down to bring the KRT Editor into view
  scrollPageToKrtEditor()

  // Then, after a short delay for the page scroll to settle, scroll within the editor
  setTimeout(() => {
    if (finding.type === 'add_row') {
      krtEditorRef.value?.scrollToSuggestionRow(finding.id)
      return
    }

    const row = getKrtRowForFinding(finding)
    if (row?.id) {
      const columnKey = finding.data?.column ? (columnToKrtKey[finding.data.column] || null) : null
      krtEditorRef.value?.scrollToRow(row.id, columnKey)
    }
  }, 400)
}
</script>

<template>
  <div class="space-y-6">
    <SubmissionHeader
      ref="submissionHeaderRef"
      :submission="submission"
      :latest-files="latestFiles"
      step-title="Step 3: Manage suggestions"
      step-description="Review AI suggestions against your KRT and approve or reject changes"
      :help-items="helpItems"
      :show-navigation="true"
      :can-go-back="true"
      :can-go-next="canGoNext"
      :next-blocked-reason="nextBlockedReason"
      @go-back="handleBack"
      @go-next="handleNext"
    >
      <template #actions>
        <!-- Hidden file picker for the Replace PDF flow. Opened from the
             confirmation modal so users can't bypass the restart warning. -->
        <input
          ref="replacePdfInput"
          type="file"
          accept=".pdf,.docx"
          class="hidden"
          @change="handleReplacePdfFile"
        />
        <button
          :disabled="replacingPdf"
          class="btn-secondary text-sm inline-flex items-center"
          @click="openReplacePdfDialog"
        >
          <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          <span v-if="replacingPdf">Replacing...</span>
          <span v-else>Replace PDF</span>
        </button>
      </template>
    </SubmissionHeader>

    <!-- Fallback: if the PDF upload failed during step 1, surface a recovery
         path. Step 1 enforces PDF-required at the form level, but a failed
         upload after submission creation could land the user here without
         one. We send them back to step 2 to retry. -->
    <div v-if="!pdfFile" class="card text-center py-8">
      <p class="text-sm text-gray-700 mb-2">
        No PDF file is associated with this submission. The original upload may have failed.
      </p>
      <button class="btn-secondary mt-2" @click="handleBack">Go back to Step 2</button>
    </div>

    <template v-else>
      <!-- Background processes panel — embeds the wait-time ETA in its
           header and exposes a "More details" toggle for the per-job grid. -->
      <BackgroundProcesses
        ref="bgProcessesRef"
        :submission-id="route.params.id"
        @edit-das="handleEditDas"
      />

      <!-- AI Suggestions Section - Carousel Navigation -->
      <div v-if="findings.length > 0 || anyProcessFinished || pdfAnalysisInFlight" id="ai-suggestions-section" class="card">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-medium text-gray-700">AI Suggestions</h3>
          <div class="flex items-center space-x-2">
            <!-- Re-run Analysis button (shown after complete/failed) -->
            <button
              v-if="analysisStatus === 'complete' || analysisStatus === 'failed'"
              :disabled="analyzing"
              class="btn-secondary text-xs inline-flex items-center"
              :class="{ 'opacity-50 cursor-not-allowed': analyzing }"
              title="Re-run all background processes (PDF analysis, DAS extraction, software detection)"
              @click="handleRerunAnalysis"
            >
              <svg class="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Re-run all
            </button>
            <span class="suggestion-stats-badge">
              <span class="stats-processed">{{ findings.filter(f => f.status !== 'pending').length }}</span>
              <span class="stats-separator">/</span>
              <span class="stats-total">{{ findings.length }}</span>
            </span>
          </div>
        </div>

        <!-- Filter tabs -->
        <div class="suggestion-tabs mb-3">
          <button
            v-for="tab in suggestionTabGroups"
            :key="tab.key"
            class="suggestion-tab"
            :class="{ 'suggestion-tab-active': activeSuggestionTab === tab.key }"
            @click="activeSuggestionTab = tab.key"
          >
            {{ tab.label }}
            <span class="suggestion-tab-stats">
              <span class="tab-stats-pending">{{ getSuggestionTabPendingCount(tab.key) }}</span>
              <span class="tab-stats-sep">/</span>
              <span class="tab-stats-total">{{ getSuggestionTabCount(tab.key) }}</span>
            </span>
          </button>
        </div>

        <!-- Analysis still running, no suggestions yet — show a loader so the
             user knows the section will populate. Distinct from the "nothing
             found" copy below, which only kicks in once a process actually
             completes. -->
        <div v-if="findings.length === 0 && pdfAnalysisInFlight" class="text-center py-6 px-4">
          <svg class="mx-auto w-8 h-8 text-primary-500 mb-2 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p class="text-sm font-medium text-gray-800">Analyzing the manuscript…</p>
          <p class="text-xs text-gray-500 mt-1">PDF analysis is running. Suggestions will appear here as they're generated.</p>
        </div>

        <!-- No suggestions yet (at least one process completed; KRT may already cover everything) -->
        <div v-else-if="findings.length === 0" class="text-center py-6 px-4">
          <!-- `analyzing` flips to true the moment Re-run all is clicked
               (before the poller picks up the new 'waiting' statuses), so
               we hold off on the "all done" copy and keep showing the
               spinner during that gap. -->
          <template v-if="allProcessesFinished && !analyzing">
            <svg class="mx-auto w-8 h-8 text-green-500 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p class="text-sm font-medium text-gray-800">Your KRT seems to already contain everything we found.</p>
            <p class="text-xs text-gray-500 mt-1">No suggestions to review. You can open the background processes panel above to check what was detected.</p>
          </template>
          <template v-else>
            <svg class="mx-auto w-8 h-8 text-primary-500 mb-2 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <p class="text-sm font-medium text-gray-800">Analyzing the manuscript…</p>
            <p class="text-xs text-gray-500 mt-1">Background processes are still running. New suggestions will appear here as they finish.</p>
          </template>
        </div>

        <!-- No suggestions in this filter (but other tabs have some) -->
        <div v-else-if="sortedFindings.length === 0" class="text-center py-4 text-sm text-gray-500">
          No suggestions in this category
        </div>

        <!-- Single item display -->
        <div v-else-if="currentSuggestion" class="suggestion-card" :class="`suggestion-card-${currentSuggestion.status}`">
          <!-- Caption strip: type/source/title/confidence sit above the row
               so the data cells stay clean and parseable, mirroring a KRT
               table row visually. -->
          <div class="suggestion-caption">
            <span
              class="suggestion-type-badge"
              :class="`suggestion-type-${currentSuggestion.type}`"
            >
              {{ currentSuggestion.type === 'add_row' ? 'Add' : currentSuggestion.type === 'delete_row' ? 'Delete' : 'Edit' }}
            </span>
            <span
              v-if="currentSuggestion.source"
              class="suggestion-source-badge"
              :class="currentSuggestion.source === 'software_detection' ? 'suggestion-source-software' : 'suggestion-source-pdf'"
            >
              {{ currentSuggestion.source === 'software_detection' ? 'Software' : currentSuggestion.source === 'pdf_analysis' ? 'PDF' : currentSuggestion.source }}
            </span>
            <span class="suggestion-title-text">{{ currentSuggestion.title }}</span>
            <span v-if="currentSuggestion.confidence" class="suggestion-confidence">
              {{ Math.round(currentSuggestion.confidence * 100) }}%
            </span>
            <span v-if="currentSuggestion.status !== 'pending'" class="suggestion-status-pill" :class="`suggestion-status-${currentSuggestion.status}`">
              {{ currentSuggestion.status }}
            </span>
          </div>

          <!-- KRT-style row: 5 cells on the top line (Type / Name / Source /
               Identifier / New-Reuse) plus a full-width Additional Information
               row underneath. Each cell decides its own rendering via
               cellState(): add_row → editable input; edit target → old
               strikethrough stacked above an editable input; edit context →
               KRT row's current value (read-only); delete → strikethrough. -->
          <div class="suggestion-row-scroll">
            <div class="suggestion-row" :class="{ 'suggestion-row-delete': currentSuggestion.type === 'delete_row' }">
              <!-- RESOURCE TYPE -->
              <div class="suggestion-cell suggestion-cell-type" :class="{ 'suggestion-cell-target': cellState(currentSuggestion, 'resourceType').isTarget }">
                <span class="suggestion-cell-label">Type</span>
                <select
                  v-if="cellState(currentSuggestion, 'resourceType').editable && cellState(currentSuggestion, 'resourceType').mode === 'add'"
                  v-model="suggestionOverrides[currentSuggestion.id].resourceType"
                  class="suggestion-input"
                  title="Resource Type"
                >
                  <option v-for="name in resourceTypesStore.resourceTypeNames" :key="name" :value="name">{{ name }}</option>
                </select>
                <div v-else-if="cellState(currentSuggestion, 'resourceType').mode === 'edit_target' && cellState(currentSuggestion, 'resourceType').editable" class="suggestion-cell-stack">
                  <span class="suggestion-diff-old" :title="cellState(currentSuggestion, 'resourceType').oldValue || ''">{{ cellState(currentSuggestion, 'resourceType').oldValue || '(empty)' }}</span>
                  <select v-model="suggestionOverrides[currentSuggestion.id]" class="suggestion-input">
                    <option v-for="name in resourceTypesStore.resourceTypeNames" :key="name" :value="name">{{ name }}</option>
                  </select>
                </div>
                <span v-else class="suggestion-cell-text" :title="cellState(currentSuggestion, 'resourceType').value || ''">
                  {{ cellState(currentSuggestion, 'resourceType').value || '—' }}
                </span>
              </div>

              <!-- RESOURCE NAME -->
              <div class="suggestion-cell" :class="{ 'suggestion-cell-target': cellState(currentSuggestion, 'resourceName').isTarget }">
                <span class="suggestion-cell-label">Name</span>
                <input
                  v-if="cellState(currentSuggestion, 'resourceName').editable && cellState(currentSuggestion, 'resourceName').mode === 'add'"
                  v-model="suggestionOverrides[currentSuggestion.id].resourceName"
                  type="text"
                  class="suggestion-input"
                  title="Resource Name"
                />
                <div v-else-if="cellState(currentSuggestion, 'resourceName').mode === 'edit_target' && cellState(currentSuggestion, 'resourceName').editable" class="suggestion-cell-stack">
                  <span class="suggestion-diff-old" :title="cellState(currentSuggestion, 'resourceName').oldValue || ''">{{ cellState(currentSuggestion, 'resourceName').oldValue || '(empty)' }}</span>
                  <input v-model="suggestionOverrides[currentSuggestion.id]" type="text" class="suggestion-input" />
                </div>
                <span v-else class="suggestion-cell-text" :title="cellState(currentSuggestion, 'resourceName').value || ''">
                  {{ cellState(currentSuggestion, 'resourceName').value || '—' }}
                </span>
              </div>

              <!-- SOURCE -->
              <div class="suggestion-cell" :class="{ 'suggestion-cell-target': cellState(currentSuggestion, 'source').isTarget }">
                <span class="suggestion-cell-label">Source</span>
                <input
                  v-if="cellState(currentSuggestion, 'source').editable && cellState(currentSuggestion, 'source').mode === 'add'"
                  v-model="suggestionOverrides[currentSuggestion.id].source"
                  type="text"
                  class="suggestion-input"
                  title="Source"
                />
                <div v-else-if="cellState(currentSuggestion, 'source').mode === 'edit_target' && cellState(currentSuggestion, 'source').editable" class="suggestion-cell-stack">
                  <span class="suggestion-diff-old" :title="cellState(currentSuggestion, 'source').oldValue || ''">{{ cellState(currentSuggestion, 'source').oldValue || '(empty)' }}</span>
                  <input v-model="suggestionOverrides[currentSuggestion.id]" type="text" class="suggestion-input" />
                </div>
                <span v-else class="suggestion-cell-text" :title="cellState(currentSuggestion, 'source').value || ''">
                  {{ cellState(currentSuggestion, 'source').value || '—' }}
                </span>
              </div>

              <!-- IDENTIFIER -->
              <div class="suggestion-cell" :class="{ 'suggestion-cell-target': cellState(currentSuggestion, 'identifier').isTarget }">
                <span class="suggestion-cell-label">Identifier</span>
                <input
                  v-if="cellState(currentSuggestion, 'identifier').editable && cellState(currentSuggestion, 'identifier').mode === 'add'"
                  v-model="suggestionOverrides[currentSuggestion.id].identifier"
                  type="text"
                  class="suggestion-input"
                  title="Identifier"
                />
                <div v-else-if="cellState(currentSuggestion, 'identifier').mode === 'edit_target' && cellState(currentSuggestion, 'identifier').editable" class="suggestion-cell-stack">
                  <span class="suggestion-diff-old" :title="cellState(currentSuggestion, 'identifier').oldValue || ''">{{ cellState(currentSuggestion, 'identifier').oldValue || '(empty)' }}</span>
                  <input v-model="suggestionOverrides[currentSuggestion.id]" type="text" class="suggestion-input" />
                </div>
                <span v-else class="suggestion-cell-text" :title="cellState(currentSuggestion, 'identifier').value || ''">
                  {{ cellState(currentSuggestion, 'identifier').value || '—' }}
                </span>
              </div>

              <!-- NEW/REUSE -->
              <div class="suggestion-cell suggestion-cell-reuse" :class="{ 'suggestion-cell-target': cellState(currentSuggestion, 'newReuse').isTarget }">
                <span class="suggestion-cell-label">New/Reuse</span>
                <select
                  v-if="cellState(currentSuggestion, 'newReuse').editable && cellState(currentSuggestion, 'newReuse').mode === 'add'"
                  v-model="suggestionOverrides[currentSuggestion.id].newReuse"
                  class="suggestion-input"
                  title="New/Reuse"
                >
                  <option value="">—</option>
                  <option value="new">new</option>
                  <option value="reuse">reuse</option>
                </select>
                <div v-else-if="cellState(currentSuggestion, 'newReuse').mode === 'edit_target' && cellState(currentSuggestion, 'newReuse').editable" class="suggestion-cell-stack">
                  <span class="suggestion-diff-old">{{ cellState(currentSuggestion, 'newReuse').oldValue || '(empty)' }}</span>
                  <select v-model="suggestionOverrides[currentSuggestion.id]" class="suggestion-input">
                    <option value="">—</option>
                    <option value="new">new</option>
                    <option value="reuse">reuse</option>
                  </select>
                </div>
                <span v-else class="suggestion-cell-text">
                  {{ cellState(currentSuggestion, 'newReuse').value || '—' }}
                </span>
              </div>

              <!-- ADDITIONAL INFORMATION — full-width row below the others. -->
              <div class="suggestion-cell suggestion-cell-additional" :class="{ 'suggestion-cell-target': cellState(currentSuggestion, 'additionalInformation').isTarget }">
                <span class="suggestion-cell-label">Additional Information</span>
                <input
                  v-if="cellState(currentSuggestion, 'additionalInformation').editable && cellState(currentSuggestion, 'additionalInformation').mode === 'add'"
                  v-model="suggestionOverrides[currentSuggestion.id].additionalInformation"
                  type="text"
                  class="suggestion-input"
                  title="Additional Information"
                />
                <div v-else-if="cellState(currentSuggestion, 'additionalInformation').mode === 'edit_target' && cellState(currentSuggestion, 'additionalInformation').editable" class="suggestion-cell-stack">
                  <span class="suggestion-diff-old" :title="cellState(currentSuggestion, 'additionalInformation').oldValue || ''">{{ cellState(currentSuggestion, 'additionalInformation').oldValue || '(empty)' }}</span>
                  <input v-model="suggestionOverrides[currentSuggestion.id]" type="text" class="suggestion-input" />
                </div>
                <span v-else class="suggestion-cell-text suggestion-cell-text-wrap" :title="cellState(currentSuggestion, 'additionalInformation').value || ''">
                  {{ cellState(currentSuggestion, 'additionalInformation').value || '—' }}
                </span>
              </div>
            </div>
          </div>

          <!-- Manuscript excerpt — always shown so the user can verify the
               suggestion against the paper without an extra click. -->
          <div v-if="currentSuggestion.evidence || currentSuggestion.description || currentSuggestion.detail" class="suggestion-evidence">
            <p v-if="currentSuggestion.evidence" class="suggestion-evidence-line">
              <span class="suggestion-evidence-label">Found in manuscript:</span>
              <span class="italic">"{{ currentSuggestion.evidence }}"</span>
            </p>
            <p v-else-if="currentSuggestion.detail" class="suggestion-evidence-line italic">"{{ currentSuggestion.detail }}"</p>
            <p v-if="currentSuggestion.description && !currentSuggestion.evidence" class="suggestion-evidence-desc">{{ currentSuggestion.description }}</p>
          </div>

          <!-- Action row -->
          <div class="suggestion-actions">
            <button
              class="suggestion-view-btn"
              title="View in KRT Editor"
              @click="scrollToFindingRow(currentSuggestion)"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              View in KRT
            </button>
            <div class="flex-1"></div>
            <template v-if="currentSuggestion.status === 'pending'">
              <button class="suggestion-approve-btn" @click="handleApprove(currentSuggestion)">
                Approve
              </button>
              <button class="suggestion-reject-btn" @click="openRejectModal(currentSuggestion)">
                Reject
              </button>
            </template>
          </div>
        </div>

        <!-- Navigation: Arrows + Dots -->
        <div v-if="totalSuggestionsCount > 1" class="flex items-center justify-center mt-3 space-x-3">
          <!-- Previous arrow -->
          <button
            :disabled="currentSuggestionIndex === 0"
            class="p-1 rounded-full transition-colors"
            :class="currentSuggestionIndex === 0 ? 'text-gray-300 cursor-not-allowed' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'"
            @click="goToPrevSuggestion"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </button>

          <!-- Dot indicators -->
          <div class="flex items-center space-x-1.5">
            <button
              v-for="(finding, index) in sortedFindings"
              :key="finding.id"
              class="w-2 h-2 rounded-full transition-colors"
              :class="{
                'bg-primary-600': index === currentSuggestionIndex,
                'bg-green-400': index !== currentSuggestionIndex && finding.status === 'approved',
                'bg-gray-300': index !== currentSuggestionIndex && finding.status === 'rejected',
                'bg-blue-300 hover:bg-blue-400': index !== currentSuggestionIndex && finding.status === 'pending'
              }"
              :title="`Suggestion ${index + 1}: ${finding.status}`"
              @click="goToSuggestion(index)"
            />
          </div>

          <!-- Next arrow -->
          <button
            :disabled="currentSuggestionIndex === totalSuggestionsCount - 1"
            class="p-1 rounded-full transition-colors"
            :class="currentSuggestionIndex === totalSuggestionsCount - 1 ? 'text-gray-300 cursor-not-allowed' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'"
            @click="goToNextSuggestion"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>

      <!-- PDF Analysis needs user input (DAS not found) -->
      <div v-else-if="pdfAnalysisPendingInput" class="card">
        <div class="flex items-start gap-3 py-2">
          <svg class="w-5 h-5 text-orange-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <div class="flex-1">
            <p class="text-sm font-medium text-gray-900">Availability Statement not found</p>
            <p class="text-sm text-gray-600 mt-1">
              The automatic extraction could not find an Availability Statement in your manuscript.
              Please enter it manually in Step 3 (Availability Statement), then come back and start the analysis.
            </p>
            <button
              class="btn-primary mt-3"
              :disabled="advancingAnalysis"
              @click="handleAdvanceAnalysis"
            >
              <svg v-if="advancingAnalysis" class="animate-spin -ml-1 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {{ advancingAnalysis ? 'Starting...' : 'Start PDF Analysis' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Waiting for suggestions (when no findings yet) -->
      <div v-else class="card">
        <div class="flex items-center gap-3 py-2">
          <svg class="w-5 h-5 text-primary-400 shrink-0 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
          <div>
            <p class="text-sm text-gray-700">Suggestions will be automatically populated once the analysis of your manuscript is complete.</p>
            <p class="text-xs text-gray-400 mt-1">You can track progress in the job status panel above.</p>
          </div>
        </div>
      </div>

      <!-- KRT Editor Section -->
      <div class="card">
        <h3 class="text-sm font-medium text-gray-700 mb-3">Key Resources Table</h3>
        <KRTEditor
          ref="krtEditorRef"
          v-model="activeSuggestionTab"
          :submission-id="route.params.id"
          :show-revalidate="isAdmin"
          :krt-file-url="krtFile?.s3Url"
          :active-suggestion-id="currentSuggestion?.id || null"
          @revalidate="handleValidate"
          @suggestion-accepted="handleSuggestionAccepted"
          @suggestion-rejected="handleSuggestionRejected"
          @scroll-to-suggestions="scrollToSuggestions"
          @select-suggestion="selectSuggestionById"
        />
      </div>
    </template>

    <!-- Replace PDF warning modal — gates the file picker because replacing
         the PDF restarts every background process and discards in-flight
         suggestions. -->
    <Teleport to="body">
      <div v-if="showReplacePdfModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="closeReplacePdfModal">
        <div class="bg-white rounded-lg shadow-xl w-full max-w-md p-5">
          <h3 class="text-sm font-semibold text-gray-900 mb-2">Replace the PDF?</h3>
          <p class="text-sm text-gray-600 mb-3">
            Uploading a new PDF will restart every background process — DAS extraction, Markdown conversion, software / datasets / materials / protocols / identifier detection, ORCID extraction, and PDF analysis.
          </p>
          <p class="text-sm text-gray-600 mb-4">
            Existing AI suggestions will be regenerated against the new manuscript. Any unsaved review work on the current suggestions will be lost.
          </p>
          <div class="flex justify-end gap-2">
            <button class="px-3 py-1.5 text-sm font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200" @click="closeReplacePdfModal">
              Cancel
            </button>
            <button class="px-3 py-1.5 text-sm font-medium rounded-md bg-red-600 text-white hover:bg-red-700" @click="triggerReplacePdfPicker">
              Pick a new PDF
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Rejection Reason Modal -->
    <Teleport to="body">
      <div v-if="showRejectModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="cancelReject">
        <div class="bg-white rounded-lg shadow-xl w-full max-w-md p-5">
          <h3 class="text-sm font-semibold text-gray-900 mb-2">Reject Suggestion</h3>
          <p class="text-sm text-gray-500 mb-3">Why are you rejecting this suggestion? (optional)</p>
          <textarea
            v-model="rejectionReason"
            class="w-full border border-gray-300 rounded-md p-2 text-sm resize-none focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            rows="3"
            placeholder="Enter reason..."
            @keydown.enter.ctrl="confirmReject"
          ></textarea>
          <div class="flex justify-end gap-2 mt-3">
            <button class="px-3 py-1.5 text-sm font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200" @click="cancelReject">
              Cancel
            </button>
            <button class="px-3 py-1.5 text-sm font-medium rounded-md bg-red-600 text-white hover:bg-red-700" @click="confirmReject">
              Reject
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* The sticky sub-header (.submission-sticky-bar, z:40) overlays the top of
   the scroll viewport — without scroll-margin-top, scrollIntoView({block:'start'})
   would put the AI Suggestions header directly under the sticky bar where
   the user can't see it. 6rem matches the sticky bar height plus a small
   breathing margin (same value used by the Instructions panel). */
#ai-suggestions-section {
  scroll-margin-top: 6rem;
}

/* Suggestion filter tabs */
.suggestion-tabs {
  display: flex;
  gap: 0.375rem;
  flex-wrap: wrap;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid #e5e7eb;
}

.suggestion-tab {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #6b7280;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: all 0.15s;
}

.suggestion-tab:hover {
  color: #374151;
  background: #f3f4f6;
}

.suggestion-tab.suggestion-tab-active {
  color: #2563eb;
  background: #eff6ff;
  border-color: #bfdbfe;
}

.suggestion-tab-stats {
  display: inline-flex;
  align-items: center;
  padding: 0.125rem 0.375rem;
  font-size: 0.6875rem;
  font-weight: 600;
  background: #e5e7eb;
  border-radius: 9999px;
}

.suggestion-tab-active .suggestion-tab-stats {
  background: #dbeafe;
}

.tab-stats-pending {
  color: #2563eb;
}

.suggestion-tab-active .tab-stats-pending {
  color: #1e40af;
}

.tab-stats-sep {
  color: #9ca3af;
  margin: 0 0.0625rem;
}

.tab-stats-total {
  color: #6b7280;
}

.suggestion-tab-active .tab-stats-total {
  color: #3b82f6;
}

/* Statistics badge */
.suggestion-stats-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.25rem 0.625rem;
  font-size: 0.8125rem;
  font-weight: 600;
  background: #f3f4f6;
  border: 1px solid #e5e7eb;
  border-radius: 9999px;
}

.stats-processed {
  color: #059669;
}

.stats-separator {
  color: #9ca3af;
  margin: 0 0.125rem;
}

.stats-total {
  color: #6b7280;
}

/* ── KRT-style suggestion card ───────────────────────────────────────── */
.suggestion-card {
  padding: 0.625rem 0.75rem;
  border-radius: 0.5rem;
  border: 1px solid;
}
.suggestion-card-pending  { background: #eff6ff; border-color: #bfdbfe; }
.suggestion-card-approved { background: #f0fdf4; border-color: #bbf7d0; }
.suggestion-card-rejected { background: #f9fafb; border-color: #e5e7eb; }

/* Caption — sits above the row, holds badges + title + confidence. */
.suggestion-caption {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  margin-bottom: 0.375rem;
  flex-wrap: wrap;
}
.suggestion-type-badge {
  font-weight: 600;
  padding: 0.0625rem 0.5rem;
  border-radius: 0.25rem;
}
.suggestion-type-add_row    { background: #dbeafe; color: #1e40af; }
.suggestion-type-edit       { background: #fef3c7; color: #92400e; }
.suggestion-type-delete_row { background: #fee2e2; color: #991b1b; }
.suggestion-source-badge {
  font-weight: 500;
  padding: 0.0625rem 0.4rem;
  border-radius: 0.25rem;
  text-transform: uppercase;
  font-size: 0.6875rem;
  letter-spacing: 0.025em;
}
.suggestion-source-software { background: #ede9fe; color: #6d28d9; }
.suggestion-source-pdf      { background: #f3f4f6; color: #4b5563; }
.suggestion-title-text {
  font-weight: 500;
  color: #111827;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 28rem;
}
.suggestion-confidence {
  color: #9ca3af;
  font-variant-numeric: tabular-nums;
}
.suggestion-status-pill {
  margin-left: auto;
  font-weight: 500;
  padding: 0.0625rem 0.5rem;
  border-radius: 9999px;
}
.suggestion-status-approved { background: #dcfce7; color: #166534; }
.suggestion-status-rejected { background: #e5e7eb; color: #4b5563; }

/* Row — mimics a KRT table row, but split into two visual rows so the
   Additional Information column can wrap freely below the others without
   squeezing the top cells. Top line: Type / Name / Source / Identifier /
   New-Reuse. Bottom line: Additional Information (full-width). */
.suggestion-row-scroll {
  overflow-x: auto;
}
.suggestion-row {
  display: grid;
  grid-template-columns:
    minmax(8rem,  0.8fr)  /* RESOURCE TYPE — dropdown-sized */
    minmax(10rem, 1.6fr)  /* RESOURCE NAME */
    minmax(10rem, 1.6fr)  /* SOURCE */
    minmax(9rem,  1.3fr)  /* IDENTIFIER */
    minmax(5rem,  0.4fr); /* NEW/REUSE */
  gap: 0.25rem;
  align-items: stretch;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 0.375rem;
  min-width: min-content;
}
.suggestion-cell-additional {
  /* Span the entire row width on the second grid line. */
  grid-column: 1 / -1;
  border-top: 1px solid #f3f4f6;
}
.suggestion-row-delete .suggestion-cell-text {
  color: #b91c1c;
  text-decoration: line-through;
}
.suggestion-cell {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.125rem;
  padding: 0.375rem 0.5rem;
  min-width: 0;  /* allow truncation inside grid track */
  border-right: 1px solid #f3f4f6;
}
.suggestion-cell:last-child { border-right: 0; }
.suggestion-cell-additional { border-right: 0; }
.suggestion-cell-label {
  font-size: 0.625rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.025em;
  color: #9ca3af;
  line-height: 1;
}
.suggestion-cell-text {
  font-size: 0.8125rem;
  color: #374151;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 100%;
}
/* Additional Information cell allows wrapping so long context fits without
   forcing a horizontal scroll. */
.suggestion-cell-text-wrap {
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
}
/* Stacked edit target — strikethrough old above the editable new value.
   Gives the input the full cell width so the user can actually see what
   they're typing. */
.suggestion-cell-stack {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  width: 100%;
}
.suggestion-input {
  width: 100%;
  border: 1px solid transparent;
  background: transparent;
  padding: 0.1875rem 0.375rem;
  font-size: 0.8125rem;
  color: #111827;
  border-radius: 0.25rem;
  transition: border-color 0.15s, background 0.15s;
}
.suggestion-input:hover {
  border-color: #d1d5db;
  background: #f9fafb;
}
.suggestion-input:focus {
  outline: none;
  border-color: #3b82f6;
  background: #fff;
  box-shadow: 0 0 0 1px #3b82f6;
}

/* Edit-target cell — tinted amber so the user can spot which cell the
   suggestion is modifying. The diff old/new live stacked inside via
   .suggestion-cell-stack. */
.suggestion-cell-target {
  background: #fffbeb;
  outline: 1px solid #fde68a;
  outline-offset: -1px;
}
.suggestion-diff-old {
  color: #b91c1c;
  text-decoration: line-through;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.75rem;
}

/* Actions row */
.suggestion-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.suggestion-view-btn {
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
.suggestion-view-btn:hover {
  color: #1d4ed8;
  text-decoration: underline;
}
.suggestion-approve-btn {
  padding: 0.375rem 0.875rem;
  font-size: 0.8125rem;
  font-weight: 500;
  background: #16a34a;
  color: #fff;
  border: 0;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: background 0.15s;
}
.suggestion-approve-btn:hover { background: #15803d; }
.suggestion-reject-btn {
  padding: 0.375rem 0.875rem;
  font-size: 0.8125rem;
  font-weight: 500;
  background: #e5e7eb;
  color: #374151;
  border: 0;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: background 0.15s;
}
.suggestion-reject-btn:hover { background: #d1d5db; }

/* Evidence panel — always rendered below the row (no toggle) so the user
   sees the manuscript snippet that justified the suggestion without an
   extra click. */
.suggestion-evidence {
  margin-top: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 0.375rem;
  font-size: 0.75rem;
  color: #4b5563;
}
.suggestion-evidence-line {
  margin: 0;
  color: #374151;
}
.suggestion-evidence-label {
  font-weight: 600;
  color: #6b7280;
  margin-right: 0.25rem;
}
.suggestion-evidence-desc {
  margin: 0.25rem 0 0;
  color: #4b5563;
}
</style>

