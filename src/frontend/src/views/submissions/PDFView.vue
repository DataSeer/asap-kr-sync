<script setup>
import { ref, computed, onMounted, onUnmounted, watch, provide, nextTick } from 'vue'
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
import identifierDetectionService from '@/services/identifier-detection.service'
import markdownService from '@/services/markdown.service'
import suggestionService from '@/services/suggestion.service'
import jobService from '@/services/job.service'
import configService from '@/services/config.service'
import demosService from '@/services/demos.service'
import KRTEditor from '@/components/krt/KRTEditor.vue'
import SubmissionHeader from '@/components/submission/SubmissionHeader.vue'
import JobStatusPanel from '@/components/submission/JobStatusPanel.vue'
import { useAuthStore } from '@/stores/auth.store'
import { useResourceTypesStore } from '@/stores/resourceTypes.store'
import { useJobPoller } from '@/composables'

// Available demos — discovered server-side from src/frontend/public/demo-files/
// + matching demo-findings/*-demo.json. Populated on mount via /api/demos.
const allDemos = ref([])

const route = useRoute()
const router = useRouter()
const submissionStore = useSubmissionStore()
const krtStore = useKRTStore()
const notificationStore = useNotificationStore()
const authStore = useAuthStore()
const resourceTypesStore = useResourceTypesStore()

const isAdmin = computed(() => authStore.effectiveRole === 'admin')

const fileInput = ref(null)
const krtEditorRef = ref(null)
const submissionHeaderRef = ref(null)
function handleEditDas() {
  submissionHeaderRef.value?.openEditModal?.()
}
const uploading = ref(false)
const isDragging = ref(false)
const analyzing = ref(false)
const analysisStatus = ref(null)
const findings = ref([])
const showPDFDemoSelector = ref(false)
const loadingDemoPDF = ref(false)
const submission = computed(() => submissionStore.currentSubmission)

// Unified job poller — tracks all background jobs for this submission
const { jobs, isAnyRunning, getJob, onJobComplete, onJobFailed, onJobPendingInput, refresh: refreshJobs } = useJobPoller(
  computed(() => route.params.id)
)

// Provide jobs to SubmissionHeader's JobStatusPanel
provide('submissionJobs', jobs)

// Software mentions data for JobStatusPanel "Show more" modal
const softwareMentionsItems = ref([])
provide('submissionSoftwareMentions', softwareMentionsItems)

// Authors data for JobStatusPanel "Show more" modal
const authorsItems = ref([])
provide('submissionAuthors', authorsItems)

// Datasets data for JobStatusPanel "Show more" modal
const datasetItems = ref([])
provide('submissionDatasets', datasetItems)

// Materials data for JobStatusPanel "Show more" modal
const materialsItems = ref([])
provide('submissionMaterials', materialsItems)

// Protocols data for JobStatusPanel "Show more" modal
const protocolsItems = ref([])
provide('submissionProtocols', protocolsItems)

// Service status (enabled/disabled) for JobStatusPanel badges
const serviceStatus = ref({})
provide('serviceStatus', serviceStatus)

// Counter the JobStatusPanel watches to auto-expand when we trigger background
// processing (e.g. after a fresh PDF upload).
const expandJobsSignal = ref(0)
provide('expandJobsSignal', expandJobsSignal)
function revealJobsPanel() {
  expandJobsSignal.value++
}

// Provide restart handler for JobStatusPanel
provide('restartJob', async (jobType) => {
  const id = route.params.id
  switch (jobType) {
    case 'das_extraction':
      await pdfService.extractDAS(id)
      notificationStore.info('DAS extraction re-started')
      break
    case 'pdf_analysis':
      analyzing.value = true
      analysisStatus.value = null
      await pdfService.triggerAnalysis(id)
      notificationStore.info('PDF analysis re-started')
      break
    case 'software_detection':
      await softwareService.triggerDetection(id)
      notificationStore.info('Software detection re-started')
      break
    case 'orcid_extraction':
      await orcidService.triggerExtraction(id)
      notificationStore.info('ORCID extraction re-started')
      break
    case 'markdown_convert':
      await markdownService.triggerConvert(id)
      notificationStore.info('Markdown conversion re-started')
      break
    case 'datasets_detection':
      await datasetsService.triggerDetection(id)
      notificationStore.info('Datasets detection re-started')
      break
    case 'materials_detection':
      await materialsService.triggerDetection(id)
      notificationStore.info('Materials detection re-started')
      break
    case 'protocols_detection':
      await protocolsService.triggerDetection(id)
      notificationStore.info('Protocols detection re-started')
      break
    case 'identifier_detection':
      await identifierDetectionService.triggerDetection(id)
      notificationStore.info('Identifier detection re-started')
      break
    default:
      return
  }
  await refreshJobs()
})

// Derive analyzing state from job poller
const pdfAnalysisJob = computed(() => getJob('pdf_analysis'))
const pdfAnalysisPendingInput = computed(() => pdfAnalysisJob.value?.status === 'pending_input')
const advancingAnalysis = ref(false)

// True while PDF analysis is queued or actively processing. Used to render a
// loader inside the AI Suggestions section so the user can see suggestions
// aren't ready yet — without it, the section is hidden until the first
// process finishes and there's no signal that work is in flight.
const pdfAnalysisRunning = computed(() => {
  const status = pdfAnalysisJob.value?.status
  return status === 'queued' || status === 'processing'
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

// Register job completion callbacks
onJobComplete('pdf_analysis', async () => {
  analyzing.value = false
  analysisStatus.value = 'complete'
  // Refresh all suggestions (PDF analysis + other sources)
  await refreshSuggestions()
  notificationStore.success('Analysis complete')
})

onJobFailed('pdf_analysis', () => {
  analyzing.value = false
  analysisStatus.value = 'failed'
  notificationStore.error('Analysis failed')
})

onJobPendingInput('pdf_analysis', () => {
  notificationStore.info('Availability Statement not found — please enter it manually, then start the analysis.', 30000)
})

onJobComplete('das_extraction', async () => {
  await submissionStore.fetchSubmission(route.params.id)
})

onJobComplete('software_detection', async () => {
  await loadSoftwareMentions()
  // Software detection generates suggestions — refresh them
  await refreshSuggestions()
})

onJobComplete('orcid_extraction', async () => {
  await loadAuthors()
})

onJobComplete('datasets_detection', async () => {
  await loadDatasets()
  // Datasets detection now generates suggestions — refresh them
  await refreshSuggestions()
})

onJobComplete('markdown_convert', () => {
  // Markdown convert done — datasets detection will auto-start via pipeline
})

onJobComplete('materials_detection', async () => {
  await loadMaterials()
  await refreshSuggestions()
})

onJobComplete('protocols_detection', async () => {
  await loadProtocols()
  await refreshSuggestions()
})

onJobComplete('identifier_detection', async () => {
  // Identifier scan items feed pdf_analysis directly via merge-detections,
  // so there's no dedicated per-category panel to reload — refresh the
  // suggestions stream so any new matches the user can act on appear.
  await refreshSuggestions()
})
const latestFiles = computed(() => submissionStore.latestFiles)
const pdfFile = computed(() => latestFiles.value?.pdf)
const krtFile = computed(() => latestFiles.value?.krt)

// True when every background process has reached a final state (complete or
// failed). Excludes pending_input — that's "waiting for user", not done, and
// the user should still see the prompt that lets them act on it.
const allProcessesFinished = computed(() => {
  if (isAnyRunning.value) return false
  const list = Object.values(jobs.value || {})
  if (list.length === 0) return false
  if (list.some(j => j.status === 'pending_input' || j.status === 'waiting')) return false
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
    title: 'Upload your manuscript',
    done: !!pdfFile.value
  },
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
    title: 'Click "Continue" to proceed to Step 3',
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
  { key: 'Code/Software', label: 'Code/Software' },
  { key: 'Protocols', label: 'Protocols' },
  { key: 'Lab Materials', label: 'Key Lab Materials' }
]
const activeSuggestionTab = ref('all')

// Expanded suggestion detail
const expandedSuggestionId = ref(null)

function toggleSuggestionDetail(id) {
  expandedSuggestionId.value = expandedSuggestionId.value === id ? null : id
}

// Rejection reason modal state
const showRejectModal = ref(false)
const rejectingFinding = ref(null)
const rejectionReason = ref('')

// Check if a demo matches the current submission's manuscriptId
function isDemoMatching(demoId) {
  const manuscriptId = submission.value?.manuscriptId?.toUpperCase()
  return manuscriptId && demoId.toUpperCase() === manuscriptId
}

// Computed list that puts matching demo first based on submission's manuscriptId
const demoPDFFiles = computed(() => {
  const base = allDemos.value.filter(d => d.pdf)
  const manuscriptId = submission.value?.manuscriptId?.toUpperCase()
  if (!manuscriptId) return base

  const matchingIndex = base.findIndex(d => d.id.toUpperCase() === manuscriptId)
  if (matchingIndex === -1) return base

  const sorted = [...base]
  const [matching] = sorted.splice(matchingIndex, 1)
  return [matching, ...sorted]
})

// Close dropdowns when clicking outside
function handleClickOutside(event) {
  const target = event.target
  if (!target.closest('.demo-pdf-dropdown') && !target.closest('.demo-pdf-button')) {
    showPDFDemoSelector.value = false
  }
}

onMounted(async () => {
  // Add click outside listener
  document.addEventListener('click', handleClickOutside)

  // Reset all local state for new submission
  uploading.value = false
  analyzing.value = false
  analysisStatus.value = null
  findings.value = []
  showPDFDemoSelector.value = false

  // Clear previous KRT data before loading new submission
  krtStore.clearKRT()

  // Load service status and resource type categories (non-blocking)
  configService.getServiceStatus()
    .then(data => { serviceStatus.value = data.services || {} })
    .catch(() => {})
  resourceTypesStore.fetchResourceTypeNames().catch(() => {})

  // Discover demos available on the server (non-blocking)
  demosService.list()
    .then(list => { allDemos.value = list })
    .catch(() => { allDemos.value = [] })

  await submissionStore.fetchSubmission(route.params.id)
  await krtStore.fetchKRT(route.params.id)
  await checkAnalysisStatus()
  await loadSoftwareMentions()
  await loadAuthors()
  await loadDatasets()
  await loadMaterials()
  await loadProtocols()
})

onUnmounted(() => {
  // Remove click outside listener
  document.removeEventListener('click', handleClickOutside)
})

// Update page title with submission ID
watch(submission, (sub) => {
  if (sub?.manuscriptId) {
    setSubmissionTitle(sub.manuscriptId || sub.title, 'Step 2: Parse manuscript')
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

function triggerFileUpload() {
  fileInput.value.click()
}

function togglePDFDemoSelector() {
  showPDFDemoSelector.value = !showPDFDemoSelector.value
}

async function loadDemoPDF(demo) {
  loadingDemoPDF.value = true
  showPDFDemoSelector.value = false

  try {
    // Fetch the demo PDF from public folder
    const response = await fetch(`/demo-files/${demo.pdf}`)
    if (!response.ok) {
      throw new Error('Failed to fetch demo PDF')
    }

    // Guard against an HTML response (e.g. SPA fallback when the file is missing)
    // being uploaded as a "PDF".
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('text/html')) {
      throw new Error(`Demo PDF not found: ${demo.pdf}`)
    }

    const blob = await response.blob()

    // Create a File object from the blob
    const file = new File([blob], demo.pdf, { type: 'application/pdf' })

    // Upload using the existing service
    await pdfService.upload(route.params.id, file)
    notificationStore.success(`Demo PDF "${demo.name}" loaded — analysis starting automatically`)
    await submissionStore.fetchSubmission(route.params.id)
    // Backend auto-triggers DAS extraction + PDF analysis on upload
    await refreshJobs()
    revealJobsPanel()
  } catch (error) {
    notificationStore.error(error.message || 'Failed to load demo PDF')
  } finally {
    loadingDemoPDF.value = false
  }
}

async function handleFileUpload(event) {
  const file = event.target.files[0]
  if (!file) return

  uploading.value = true
  try {
    await pdfService.upload(route.params.id, file)
    notificationStore.success('PDF uploaded — analysis starting automatically')
    await submissionStore.fetchSubmission(route.params.id)
    // Backend auto-triggers DAS extraction + PDF analysis on upload
    // Job poller will pick up the new jobs
    await refreshJobs()
    revealJobsPanel()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to upload PDF')
  } finally {
    uploading.value = false
    event.target.value = ''
  }
}

// Drag-and-drop handlers for PDF upload
function handleDragEnter(event) {
  event.preventDefault()
  isDragging.value = true
}

function handleDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) {
    isDragging.value = false
  }
}

async function handleDrop(event) {
  event.preventDefault()
  isDragging.value = false

  const file = event.dataTransfer?.files?.[0]
  if (!file) return

  // Validate file extension
  const validExtensions = ['.pdf', '.docx']
  const ext = '.' + file.name.split('.').pop().toLowerCase()
  if (!validExtensions.includes(ext)) {
    notificationStore.error(`Invalid file type. Accepted: ${validExtensions.join(', ')}`)
    return
  }

  uploading.value = true
  try {
    await pdfService.upload(route.params.id, file)
    notificationStore.success('PDF uploaded — analysis starting automatically')
    await submissionStore.fetchSubmission(route.params.id)
    await refreshJobs()
    revealJobsPanel()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to upload PDF')
  } finally {
    uploading.value = false
  }
}

/**
 * Re-run all background processes via the orchestrator
 */
async function handleRerunAnalysis() {
  analyzing.value = true
  analysisStatus.value = null
  try {
    await jobService.runAllProcesses(route.params.id)
    notificationStore.info('All processes re-started')
    await refreshJobs()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to restart processes')
    analyzing.value = false
  }
}

async function handleApprove(finding) {
  try {
    await suggestionService.approveSuggestion(route.params.id, finding.id)
    finding.status = 'approved'
    // Update store status
    krtStore.updateSuggestionStatus(finding.id, 'approved')
    // Re-validate KRT to update validation errors after the change
    await krtStore.validate(route.params.id)
    notificationStore.success('Change approved')
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
  rejectionReason.value = ''
}

async function confirmReject() {
  if (!rejectingFinding.value) return
  const finding = rejectingFinding.value
  const reason = rejectionReason.value.trim()
  showRejectModal.value = false
  rejectingFinding.value = null
  rejectionReason.value = ''
  await handleReject(finding, reason)
}

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
      step-title="Step 2: Parse manuscript"
      step-description="Upload manuscript PDF and review AI suggestions"
      :help-items="helpItems"
      :show-navigation="true"
      :can-go-back="true"
      :can-go-next="canGoNext"
      :next-blocked-reason="nextBlockedReason"
      @go-back="handleBack"
      @go-next="handleNext"
    >
      <template #actions>
        <input
          ref="fileInput"
          type="file"
          accept=".pdf,.docx"
          class="hidden"
          @change="handleFileUpload"
        />
        <!-- Demo PDF dropdown — admin-only (used to seed test submissions
             with a known PDF + matching KRT); hidden for end users so the
             real upload flow is the only visible path. -->
        <div v-if="isAdmin && demoPDFFiles.length > 0" class="relative demo-pdf-dropdown">
          <button
            :disabled="loadingDemoPDF"
            class="btn-secondary text-sm inline-flex items-center demo-pdf-button"
            @click="togglePDFDemoSelector"
          >
            <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            <span v-if="loadingDemoPDF">Loading...</span>
            <span v-else>Demo</span>
            <svg class="w-3 h-3 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <!-- Dropdown menu -->
          <div
            v-if="showPDFDemoSelector"
            class="absolute right-0 mt-2 w-96 bg-white rounded-lg shadow-lg border border-gray-200 z-50"
          >
            <div class="p-2">
              <p class="text-xs text-gray-500 px-3 py-2 border-b border-gray-100">
                Select a demo PDF to try the app
              </p>
              <div class="max-h-64 overflow-y-auto">
                <button
                  v-for="demo in demoPDFFiles"
                  :key="demo.id"
                  class="w-full text-left px-3 py-2 hover:bg-gray-50 rounded-md transition-colors"
                  :class="{ 'bg-primary-50 border-l-2 border-primary-500': isDemoMatching(demo.id) }"
                  @click="loadDemoPDF(demo)"
                >
                  <div class="flex items-center justify-between">
                    <div class="font-mono text-sm font-medium" :class="isDemoMatching(demo.id) ? 'text-primary-700' : 'text-gray-900'">{{ demo.name }}</div>
                    <div class="flex items-center gap-1.5">
                      <!-- "KRT" pill — present when this demo ships with a matching KRT file
                           (xlsx/csv); lets the user know they'll get a pre-filled table too -->
                      <span
                        v-if="demo.krt"
                        class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium"
                        :title="'Includes a KRT file: ' + demo.krt"
                      >KRT</span>
                      <span v-if="isDemoMatching(demo.id)" class="text-xs bg-primary-100 text-primary-700 px-2 py-0.5 rounded-full font-medium">Matches</span>
                    </div>
                  </div>
                  <div class="text-xs text-gray-500">{{ demo.description }}</div>
                </button>
              </div>
            </div>
          </div>
        </div>
        <!-- Replace PDF button (only shown when PDF already uploaded) -->
        <button
          v-if="pdfFile"
          :disabled="uploading"
          class="btn-primary text-sm inline-flex items-center"
          @click="triggerFileUpload"
        >
          <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          <span v-if="uploading">Uploading...</span>
          <span v-else>Replace PDF</span>
        </button>
      </template>
    </SubmissionHeader>

    <!-- Empty state: Upload zone when no PDF uploaded -->
    <div
      v-if="!pdfFile"
      class="card text-center py-12 cursor-pointer transition-colors border-2 border-dashed"
      :class="isDragging ? 'border-primary-500 bg-primary-50' : 'hover:border-primary-300 hover:bg-primary-50/30'"
      @click="triggerFileUpload"
      @dragenter="handleDragEnter"
      @dragleave="handleDragLeave"
      @dragover.prevent
      @drop="handleDrop"
    >
      <svg class="mx-auto h-12 w-12" :class="isDragging ? 'text-primary-500' : 'text-gray-400'" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
      </svg>
      <h3 class="mt-2 text-sm font-medium text-gray-900">
        {{ isDragging ? 'Drop file here' : 'Upload PDF' }}
      </h3>
      <p class="mt-1 text-sm text-gray-500">
        {{ isDragging ? 'Release to upload your document' : 'Drag & drop or click to upload a PDF or DOCX file' }}
      </p>
    </div>

    <template v-if="pdfFile">
      <!-- Background processes panel — only shown on this step. Sits above
         AI suggestions so the user sees pipeline progress in context. -->
      <JobStatusPanel @edit-das="handleEditDas" />

      <!-- AI Suggestions Section - Carousel Navigation -->
      <div v-if="findings.length > 0 || anyProcessFinished || pdfAnalysisRunning" id="ai-suggestions-section" class="card">
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
        <div v-if="findings.length === 0 && pdfAnalysisRunning" class="text-center py-6 px-4">
          <svg class="mx-auto w-8 h-8 text-primary-500 mb-2 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p class="text-sm font-medium text-gray-800">Analyzing the manuscript…</p>
          <p class="text-xs text-gray-500 mt-1">PDF analysis is running. Suggestions will appear here as they're generated.</p>
        </div>

        <!-- No suggestions yet (at least one process completed; KRT may already cover everything) -->
        <div v-else-if="findings.length === 0" class="text-center py-6 px-4">
          <svg class="mx-auto w-8 h-8 text-green-500 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <template v-if="allProcessesFinished">
            <p class="text-sm font-medium text-gray-800">Your KRT seems to already contain everything we found.</p>
            <p class="text-xs text-gray-500 mt-1">No suggestions to review. You can open the background processes panel above to check what was detected.</p>
          </template>
          <template v-else>
            <p class="text-sm font-medium text-gray-800">No suggestions yet — your KRT looks complete so far.</p>
            <p class="text-xs text-gray-500 mt-1">Some background processes are still running. New suggestions may appear as they finish.</p>
          </template>
        </div>

        <!-- No suggestions in this filter (but other tabs have some) -->
        <div v-else-if="sortedFindings.length === 0" class="text-center py-4 text-sm text-gray-500">
          No suggestions in this category
        </div>

        <!-- Single item display -->
        <div v-else-if="currentSuggestion" class="relative">
          <div
            class="flex items-center justify-between p-3 rounded-lg"
            :class="{
              'bg-blue-50 border border-blue-200': currentSuggestion.status === 'pending',
              'bg-green-50 border border-green-200': currentSuggestion.status === 'approved',
              'bg-gray-50 border border-gray-200': currentSuggestion.status === 'rejected'
            }"
          >
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span
                  class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
                  :class="currentSuggestion.type === 'add_row' ? 'bg-blue-100 text-blue-800' : currentSuggestion.type === 'delete_row' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'"
                >
                  {{ currentSuggestion.type === 'add_row' ? 'Add' : currentSuggestion.type === 'delete_row' ? 'Delete' : 'Edit' }}
                </span>
                <span
                  v-if="currentSuggestion.source"
                  class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium"
                  :class="currentSuggestion.source === 'software_detection' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'"
                >
                  {{ currentSuggestion.source === 'software_detection' ? 'Software' : currentSuggestion.source === 'pdf_analysis' ? 'PDF' : currentSuggestion.source }}
                </span>
                <span class="text-sm font-medium text-gray-900 truncate">{{ currentSuggestion.title }}</span>
                <span v-if="currentSuggestion.confidence" class="text-xs text-gray-400">
                  {{ Math.round(currentSuggestion.confidence * 100) }}%
                </span>
              </div>
              <p class="text-sm text-gray-600 mt-1">
                <template v-if="currentSuggestion.type === 'edit' && currentSuggestion.data">
                  {{ currentSuggestion.data.column }}: "<span class="text-red-600 line-through">{{ currentSuggestion.data.oldValue || '(empty)' }}</span>" → "<span class="text-green-600">{{ currentSuggestion.data.newValue }}</span>"
                </template>
                <template v-else-if="currentSuggestion.type === 'add_row' && currentSuggestion.data">
                  {{ currentSuggestion.data.resourceType }}: {{ currentSuggestion.data.resourceName }}
                </template>
                <template v-else>
                  {{ currentSuggestion.description }}
                </template>
              </p>
              <!-- More details toggle -->
              <button
                v-if="currentSuggestion.description || currentSuggestion.detail"
                class="text-xs text-primary-600 hover:text-primary-800 mt-1"
                @click="toggleSuggestionDetail(currentSuggestion.id)"
              >
                {{ expandedSuggestionId === currentSuggestion.id ? 'Less details' : 'More details' }}
              </button>
              <div
                v-if="expandedSuggestionId === currentSuggestion.id"
                class="mt-2 p-2 bg-white rounded border border-gray-200 text-xs text-gray-600 space-y-1"
              >
                <p v-if="currentSuggestion.description">{{ currentSuggestion.description }}</p>
                <p v-if="currentSuggestion.detail" class="italic text-gray-500">"{{ currentSuggestion.detail }}"</p>
                <p v-if="currentSuggestion.data?.identifier" class="text-gray-400">Identifier: {{ currentSuggestion.data.identifier }}</p>
                <p v-if="currentSuggestion.data?.source" class="text-gray-400">URL: {{ currentSuggestion.data.source }}</p>
              </div>
            </div>
            <div class="flex items-center space-x-2 ml-4">
              <!-- View in KRT button -->
              <button
                class="p-1.5 text-gray-500 hover:text-primary-600 hover:bg-gray-100 rounded-md transition-colors"
                title="View in KRT Editor"
                @click="scrollToFindingRow(currentSuggestion)"
              >
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              </button>
              <template v-if="currentSuggestion.status === 'pending'">
                <button
                  class="px-3 py-1.5 text-sm font-medium rounded-md bg-green-600 text-white hover:bg-green-700"
                  @click="handleApprove(currentSuggestion)"
                >
                  Approve
                </button>
                <button
                  class="px-3 py-1.5 text-sm font-medium rounded-md bg-gray-200 text-gray-700 hover:bg-gray-300"
                  @click="openRejectModal(currentSuggestion)"
                >
                  Reject
                </button>
              </template>
              <span
                v-else
                class="text-sm font-medium px-3 py-1 rounded-md"
                :class="currentSuggestion.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'"
              >
                {{ currentSuggestion.status }}
              </span>
            </div>
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
        <h3 class="text-sm font-medium text-gray-700 mb-3">Key Resource Table</h3>
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
</style>

