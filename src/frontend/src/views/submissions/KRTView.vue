<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSubmissionStore } from '@/stores/submission.store'
import { useKRTStore } from '@/stores/krt.store'
import { useNotificationStore } from '@/stores/notification.store'
import { setSubmissionTitle } from '@/router'
import api from '@/services/api'
import pdfService from '@/services/pdf.service'
import KRTEditor from '@/components/krt/KRTEditor.vue'
import SubmissionHeader from '@/components/submission/SubmissionHeader.vue'
import BackgroundProcesses from '@/components/submission/BackgroundProcesses.vue'

const route = useRoute()
const router = useRouter()
const submissionStore = useSubmissionStore()
const krtStore = useKRTStore()
const notificationStore = useNotificationStore()

const fileInput = ref(null)
const pdfFileInput = ref(null)
const krtEditorRef = ref(null)
const uploading = ref(false)
const uploadingPdf = ref(false)
const isDragging = ref(false)
const krtTemplateUrl = ref('')
const submission = computed(() => submissionStore.currentSubmission)
const latestFiles = computed(() => submissionStore.latestFiles)

// Shared BackgroundProcesses wrapper handles the job poller, service status
// fetch, and the inject contract — KRTView and PDFView use it identically.
const bgProcessesRef = ref(null)

const krtRows = computed(() => krtStore.rows)
const summary = computed(() => krtStore.summary)
const loading = computed(() => krtStore.loading)
const krtFile = computed(() => submissionStore.latestFiles?.krt)
const applyingFix = ref(false)
const resourceTypes = ref([])

// Manual batch fix modal state
const showBatchFixModal = ref(false)
const batchFixTarget = ref(null)
const batchFixSelectedValue = ref('')

// Quick fixes carousel navigation
const currentFixIndex = ref(0)

// Map column keys to field names for API calls
const columnKeyToField = {
  'RESOURCE TYPE': 'resource_type',
  'RESOURCE NAME': 'resource_name',
  'SOURCE': 'source',
  'IDENTIFIER': 'identifier',
  'NEW/REUSE': 'new_reuse',
  'ADDITIONAL INFORMATION': 'additional_information'
}

// Group fixable errors by their suggestion (for batch fixes)
const fixableErrors = computed(() => {
  const fixes = {}
  const validationErrors = krtStore.validationErrors

  for (const rowId of Object.keys(validationErrors)) {
    const errors = validationErrors[rowId] || []
    for (const error of errors) {
      // Only include errors/warnings with a suggestion that starts with 'Use "'
      if (error.suggestion && error.suggestion.startsWith('Use "')) {
        const match = error.suggestion.match(/Use "([^"]+)"/)
        if (match && match[1]) {
          const suggestedValue = match[1]
          const key = `${error.column}::${suggestedValue}`

          if (!fixes[key]) {
            fixes[key] = {
              column: error.column,
              columnField: columnKeyToField[error.column],
              suggestedValue,
              severity: error.severity,
              rows: []
            }
          }
          fixes[key].rows.push({
            rowId,
            currentValue: error.message.match(/"([^"]+)"/)
              ? error.message.match(/"([^"]+)"/)[1]
              : 'unknown'
          })
        }
      }
    }
  }

  // Convert to array and sort by number of affected rows (descending)
  return Object.values(fixes)
    .filter(fix => fix.rows.length > 0)
    .sort((a, b) => b.rows.length - a.rows.length)
})

// Group errors that need manual fixing (same invalid value across multiple rows)
const manualBatchFixes = computed(() => {
  const fixes = {}
  const validationErrors = krtStore.validationErrors

  for (const rowId of Object.keys(validationErrors)) {
    const errors = validationErrors[rowId] || []
    for (const error of errors) {
      // Only include RESOURCE TYPE errors without auto-suggestions
      // Note: backend returns 'type' not 'errorType'
      if (error.column === 'RESOURCE TYPE' &&
          error.severity === 'error' &&
          error.type === 'invalid_value' &&
          (!error.suggestion || !error.suggestion.startsWith('Use "'))) {

        // Extract the invalid value from the error message
        const match = error.message.match(/"([^"]+)"/)
        if (match && match[1]) {
          const invalidValue = match[1]
          const key = `${error.column}::${invalidValue}`

          if (!fixes[key]) {
            fixes[key] = {
              column: error.column,
              columnField: columnKeyToField[error.column],
              invalidValue,
              rows: []
            }
          }
          fixes[key].rows.push({
            rowId
          })
        }
      }
    }
  }

  // Convert to array, filter for multiple occurrences, and sort
  return Object.values(fixes)
    .filter(fix => fix.rows.length > 1) // Only show if 2+ rows have the same error
    .sort((a, b) => b.rows.length - a.rows.length)
})

// Combined list of all quick fixes (auto + manual)
const allQuickFixes = computed(() => {
  const auto = fixableErrors.value.map(fix => ({ ...fix, fixType: 'auto' }))
  const manual = manualBatchFixes.value.map(fix => ({ ...fix, fixType: 'manual' }))
  return [...auto, ...manual]
})

// Current fix being displayed
const currentFix = computed(() => allQuickFixes.value[currentFixIndex.value] || null)

// Total fixes count
const totalFixesCount = computed(() => allQuickFixes.value.length)

// Navigation functions for quick fixes carousel
function goToPrevFix() {
  if (currentFixIndex.value > 0) {
    currentFixIndex.value--
  }
}

function goToNextFix() {
  if (currentFixIndex.value < allQuickFixes.value.length - 1) {
    currentFixIndex.value++
  }
}

function goToFix(index) {
  if (index >= 0 && index < allQuickFixes.value.length) {
    currentFixIndex.value = index
  }
}

// Auto-advance to next fix (or stay if last one)
function advanceToNextFix() {
  // Wait for the DOM to update after fix is applied
  setTimeout(() => {
    // If we're beyond the list, go back to last valid index
    if (currentFixIndex.value >= allQuickFixes.value.length) {
      currentFixIndex.value = Math.max(0, allQuickFixes.value.length - 1)
    }
  }, 100)
}

// Scroll to a fix's first affected row in the KRT Editor
function scrollToFixRow(fix) {
  if (!fix?.rows?.length) return
  const firstRowId = fix.rows[0].rowId
  krtEditorRef.value?.scrollToRow(firstRowId)
}

// Step help items
const helpItems = computed(() => [
  {
    title: 'Review the Key Resources Table',
    children: ['Add resources, edit cells, or replace the Key Resources Table with a different file'],
    done: krtRows.value.length > 0
  },
  {
    title: 'Resolve validation errors',
    children: ['Address all red errors (required) and yellow warnings (recommended)'],
    done: summary.value.totalErrors === 0
  },
  {
    title: 'Click "Continue" to proceed to Step 3',
    done: false
  }
])

// Check if user can proceed to next step. Auto-init guarantees a KRT exists
// (even if empty), so we gate only on validation errors.
const hasKrt = computed(() => !!krtFile.value || krtRows.value.length > 0)
const canProceed = computed(() => hasKrt.value && summary.value.totalErrors === 0)
const proceedBlockedReason = computed(() => {
  if (!hasKrt.value) {
    return 'Upload or create a Key Resources Table before continuing'
  }
  if (summary.value.totalErrors > 0) {
    return `Fix ${summary.value.totalErrors} error${summary.value.totalErrors > 1 ? 's' : ''} before continuing`
  }
  return ''
})

/**
 * Wire job-completion side-effects into the shared BackgroundProcesses
 * wrapper. Mirrors PDFView::registerJobCallbacks — the user can sit on
 * Step 2 while the background pipeline runs, and suggestions should
 * populate automatically the moment pdf_analysis finishes. Without
 * this, the curator has to refresh the page to see anything
 * (the empty-state hint stays put even after "8/8 done").
 */
function registerJobCallbacks() {
  const bg = bgProcessesRef.value
  if (!bg) return

  bg.onJobComplete('pdf_analysis', async () => {
    await krtStore.fetchAiSuggestions(route.params.id)
    notificationStore.success('AI suggestions ready')
  })
  bg.onJobFailed('pdf_analysis', () => {
    notificationStore.error('Manuscript analysis failed — suggestions unavailable')
  })
  bg.onJobPendingInput('pdf_analysis', () => {
    notificationStore.info(
      'Availability Statement not found — please enter it manually, then start the analysis.',
      30000
    )
  })
  // DAS extraction updates submission.dataAvailabilityStatement; refresh
  // the cached submission so the header (and any "DAS detected" pill)
  // picks up the new text without requiring a navigation away and back.
  bg.onJobComplete('das_extraction', async () => {
    await submissionStore.fetchSubmission(route.params.id)
  })
}

onMounted(async () => {
  // Reset local state for new submission
  uploading.value = false
  applyingFix.value = false
  showBatchFixModal.value = false
  batchFixTarget.value = null
  batchFixSelectedValue.value = ''

  // Clear previous KRT data before loading new submission
  krtStore.clearKRT()

  // BackgroundProcesses child mounts before the parent, so its ref is
  // bound by the time we get here — wire our callbacks into the shared
  // poller now so we don't miss any job-completion events that fire
  // before the initial fetch settles.
  registerJobCallbacks()

  await submissionStore.fetchSubmission(route.params.id)
  if (submission.value && submission.value.status !== 'draft') {
    await krtStore.fetchKRT(route.params.id)
    // Also fetch AI suggestions if analysis was completed
    await krtStore.fetchAiSuggestions(route.params.id)
  }
  // Fetch KRT template URL
  try {
    const response = await api.get('/config/krt-template')
    krtTemplateUrl.value = response.data.url
  } catch (e) {
    // Template URL is optional, ignore errors
  }
  // Fetch resource types for batch fix dropdown
  try {
    const response = await api.get('/config/resource-types')
    resourceTypes.value = response.data.resourceTypes || []
  } catch (e) {
    // Resource types are optional, ignore errors
  }
})

// Update page title with the submission title (manuscriptId is optional, so
// gate on either identifier — otherwise submissions without a manuscript id
// keep the router's generic "Step X" title).
watch(submission, (sub) => {
  if (sub?.title || sub?.manuscriptId) {
    setSubmissionTitle(sub.title || sub.manuscriptId, 'Step 2: Fix the Key Resources Table')
  }
}, { immediate: true })

// Reset fix index when quick fixes change significantly
watch(() => allQuickFixes.value.length, (newLen) => {
  if (currentFixIndex.value >= newLen) {
    currentFixIndex.value = Math.max(0, newLen - 1)
  }
})

function triggerFileUpload() {
  fileInput.value.click()
}

async function handleFileUpload(event) {
  const file = event.target.files[0]
  if (!file) return

  uploading.value = true
  try {
    await krtStore.uploadKRT(route.params.id, file)
    await submissionStore.fetchSubmission(route.params.id)
    notificationStore.success('Key Resources Table uploaded successfully')
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to upload Key Resources Table')
  } finally {
    uploading.value = false
    event.target.value = ''
  }
}

function triggerPdfUpload() {
  pdfFileInput.value?.click()
}

/**
 * Replace-PDF fallback on Step 2.
 *
 * Primary path for a new round is the modal on Step 6, which already
 * collects the PDF before bumping the submission to a new round. This
 * fallback covers the cases the modal can't: an old client that didn't
 * upload a PDF, or a user who wants to swap the PDF mid-round after
 * spotting an issue. Backend `pdfService.upload` cascades the analysis
 * pipeline so the background processes re-run automatically.
 */
async function handlePdfUpload(event) {
  const file = event.target.files[0]
  if (!file) return

  uploadingPdf.value = true
  try {
    await pdfService.upload(route.params.id, file)
    // Refresh the background processes panel so the new job set is visible.
    bgProcessesRef.value?.refresh?.()
    notificationStore.success('PDF replaced — analysis restarted')
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to replace PDF')
  } finally {
    uploadingPdf.value = false
    event.target.value = ''
  }
}

async function handleValidate() {
  try {
    await krtStore.validate(route.params.id)
    const errors = summary.value.totalErrors
    const warnings = summary.value.totalWarnings

    if (errors === 0 && warnings === 0) {
      notificationStore.success('Key Resources Table is valid! You can proceed to Step 3.')
    } else if (errors === 0 && warnings > 0) {
      notificationStore.success(`Key Resources Table is valid with ${warnings} warning${warnings > 1 ? 's' : ''}. You can proceed to Step 3.`)
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

async function handleNext() {
  if (summary.value.totalErrors > 0) {
    notificationStore.warning('Please fix all errors before proceeding')
    return
  }
  try {
    // Run validation to refresh error count
    await krtStore.validate(route.params.id)

    // Check again after validation
    if (summary.value.totalErrors > 0) {
      notificationStore.warning('Validation found errors. Please fix them before proceeding.')
      return
    }

    // Update status to step_pdf
    await submissionStore.updateSubmission(route.params.id, { status: 'step_pdf' })
    router.push({ name: 'submission-pdf', params: { id: route.params.id } })
  } catch (error) {
    notificationStore.error('Failed to continue')
  }
}

async function applyBatchFix(fix) {
  applyingFix.value = true
  try {
    const updates = fix.rows.map(row => ({
      rowId: row.rowId,
      column: fix.columnField,
      value: fix.suggestedValue
    }))

    await krtStore.batchUpdateCells(route.params.id, updates)
    notificationStore.success(`Fixed ${fix.rows.length} row${fix.rows.length > 1 ? 's' : ''}`)
    advanceToNextFix()
  } catch (error) {
    notificationStore.error('Failed to apply batch fix')
  } finally {
    applyingFix.value = false
  }
}

function openBatchFixModal(fix) {
  batchFixTarget.value = fix
  batchFixSelectedValue.value = ''
  showBatchFixModal.value = true
}

function closeBatchFixModal() {
  showBatchFixModal.value = false
  batchFixTarget.value = null
  batchFixSelectedValue.value = ''
}

async function applyManualBatchFix() {
  if (!batchFixTarget.value || !batchFixSelectedValue.value) return

  applyingFix.value = true
  try {
    const updates = batchFixTarget.value.rows.map(row => ({
      rowId: row.rowId,
      column: batchFixTarget.value.columnField,
      value: batchFixSelectedValue.value
    }))

    await krtStore.batchUpdateCells(route.params.id, updates)
    notificationStore.success(`Fixed ${batchFixTarget.value.rows.length} row${batchFixTarget.value.rows.length > 1 ? 's' : ''}`)
    closeBatchFixModal()
    advanceToNextFix()
  } catch (error) {
    notificationStore.error('Failed to apply batch fix')
  } finally {
    applyingFix.value = false
  }
}

// Drag-and-drop handlers for KRT upload
function handleDragEnter(event) {
  event.preventDefault()
  isDragging.value = true
}

function handleDragLeave(event) {
  // Only hide overlay if leaving the drop zone entirely
  if (!event.currentTarget.contains(event.relatedTarget)) {
    isDragging.value = false
  }
}

function handleDragOver(event) {
  event.preventDefault()
}

async function handleDrop(event) {
  event.preventDefault()
  isDragging.value = false

  const file = event.dataTransfer?.files?.[0]
  if (!file) return

  // Validate file extension
  const validExtensions = ['.csv', '.xlsx']
  const ext = '.' + file.name.split('.').pop().toLowerCase()
  if (!validExtensions.includes(ext)) {
    notificationStore.error(`Invalid file type. Accepted: ${validExtensions.join(', ')}`)
    return
  }

  uploading.value = true
  try {
    await krtStore.uploadKRT(route.params.id, file)
    await submissionStore.fetchSubmission(route.params.id)
    notificationStore.success('Key Resources Table uploaded successfully')
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to upload Key Resources Table')
  } finally {
    uploading.value = false
  }
}

// Find and scroll to first error
function scrollToFirstError() {
  const validationErrors = krtStore.validationErrors
  // Find the first row (by order in the store) that has errors
  for (const row of krtStore.rows) {
    const errors = validationErrors[row.id] || []
    if (errors.some(e => e.severity === 'error')) {
      krtEditorRef.value?.scrollToRow(row.id)
      return
    }
  }
}

// Find and scroll to first warning
function scrollToFirstWarning() {
  const validationErrors = krtStore.validationErrors
  for (const row of krtStore.rows) {
    const errors = validationErrors[row.id] || []
    if (errors.some(e => e.severity === 'warning')) {
      krtEditorRef.value?.scrollToRow(row.id)
      return
    }
  }
}
</script>

<template>
  <div class="space-y-6">
    <SubmissionHeader
      :submission="submission"
      :latest-files="latestFiles"
      step-title="Step 2: Fix the Key Resources Table"
      step-description="Review and fix your Key Resources Table while background processes run"
      :help-items="helpItems"
      :show-navigation="true"
      :can-go-back="false"
      :can-go-next="canProceed"
      :next-blocked-reason="proceedBlockedReason"
      @go-back="() => {}"
      @go-next="handleNext"
    >
      <template #actions>
        <input
          ref="fileInput"
          type="file"
          accept=".csv,.xlsx"
          class="hidden"
          @change="handleFileUpload"
        />
        <input
          ref="pdfFileInput"
          type="file"
          accept=".pdf,.docx,application/pdf"
          class="hidden"
          @change="handlePdfUpload"
        />
        <!-- KRT Template button -->
        <a
          v-if="krtTemplateUrl"
          :href="krtTemplateUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="btn-secondary text-sm inline-flex items-center"
          title="Open Key Resources Table Template in Google Sheets"
        >
          <svg class="w-4 h-4 mr-1" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-1.99 6H13V7h4.01v2zm0 4H13v-2h4.01v2zm0 4H13v-2h4.01v2zM7 7h4v2H7V7zm0 4h4v2H7v-2zm0 4h4v2H7v-2z" />
          </svg>
          Template
        </a>
        <!-- Replace PDF — fallback for the new-round modal. Uploading triggers
             a fresh analysis pipeline; suggestions from the previous PDF are
             superseded. -->
        <button
          :disabled="uploadingPdf"
          class="btn-secondary text-sm inline-flex items-center"
          title="Upload a new manuscript PDF; the analysis pipeline restarts automatically"
          @click="triggerPdfUpload"
        >
          <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          <span v-if="uploadingPdf">Uploading PDF…</span>
          <span v-else>Replace PDF</span>
        </button>
        <!-- Replace KRT button. Always rendered now that every submission lands
             on this step with an auto-initialized KRT in place. -->
        <button
          :disabled="uploading"
          class="btn-primary text-sm inline-flex items-center"
          @click="triggerFileUpload"
        >
          <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          <span v-if="uploading">Uploading...</span>
          <span v-else>Replace Key Resources Table</span>
        </button>
      </template>
    </SubmissionHeader>

    <!-- Background processes panel — embeds the wait-time ETA in its header
         and exposes a "More details" toggle that reveals the per-job grid.
         Same component used on step 3 so the UX is consistent. -->
    <BackgroundProcesses
      ref="bgProcessesRef"
      :submission-id="route.params.id"
    />

    <!-- Quick Fixes Section - Carousel Navigation -->
    <div v-if="allQuickFixes.length > 0 || krtStore.validating" class="card">
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-sm font-medium text-gray-700">Quick Fixes</h3>
        <span class="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700">
          {{ totalFixesCount }} remaining
        </span>
      </div>

      <!-- Single item display -->
      <div v-if="currentFix" class="relative">
        <!-- Auto-fixable error -->
        <div
          v-if="currentFix.fixType === 'auto'"
          class="flex items-center justify-between p-3 rounded-lg"
          :class="currentFix.severity === 'error' ? 'bg-red-50 border border-red-200' : 'bg-yellow-50 border border-yellow-200'"
        >
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span
                class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
                :class="currentFix.severity === 'error' ? 'bg-red-100 text-red-800' : 'bg-yellow-100 text-yellow-800'"
              >
                {{ currentFix.severity }}
              </span>
              <span class="text-sm font-medium text-gray-900">{{ currentFix.column }}</span>
              <span class="text-xs text-gray-400">{{ currentFix.rows.length }} row{{ currentFix.rows.length > 1 ? 's' : '' }}</span>
            </div>
            <p class="text-sm text-gray-600 mt-1 truncate">
              "<span class="font-medium text-red-600 line-through">{{ currentFix.rows[0].currentValue }}</span>"
              <span class="mx-1">→</span>
              "<span class="font-medium text-green-600">{{ currentFix.suggestedValue }}</span>"
            </p>
          </div>
          <div class="flex items-center space-x-2 ml-4">
            <!-- View in KRT button -->
            <button
              class="p-1.5 text-gray-500 hover:text-primary-600 hover:bg-gray-100 rounded-md transition-colors"
              title="View in KRT Editor"
              @click="scrollToFixRow(currentFix)"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </button>
            <button
              :disabled="applyingFix"
              class="px-3 py-1.5 text-sm font-medium rounded-md transition-colors"
              :class="currentFix.severity === 'error'
                ? 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-50'
                : 'bg-yellow-600 text-white hover:bg-yellow-700 disabled:opacity-50'"
              @click="applyBatchFix(currentFix)"
            >
              <span v-if="applyingFix">Fixing...</span>
              <span v-else>Fix All</span>
            </button>
          </div>
        </div>

        <!-- Manual batch fix -->
        <div
          v-else
          class="flex items-center justify-between p-3 rounded-lg bg-red-50 border border-red-200"
        >
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
                error
              </span>
              <span class="text-sm font-medium text-gray-900">{{ currentFix.column }}</span>
              <span class="text-xs text-gray-400">{{ currentFix.rows.length }} row{{ currentFix.rows.length > 1 ? 's' : '' }}</span>
            </div>
            <p class="text-sm text-gray-600 mt-1 truncate">
              "<span class="font-medium text-red-700">{{ currentFix.invalidValue }}</span>" is invalid
            </p>
          </div>
          <div class="flex items-center space-x-2 ml-4">
            <!-- View in KRT button -->
            <button
              class="p-1.5 text-gray-500 hover:text-primary-600 hover:bg-gray-100 rounded-md transition-colors"
              title="View in KRT Editor"
              @click="scrollToFixRow(currentFix)"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </button>
            <button
              :disabled="applyingFix"
              class="px-3 py-1.5 text-sm font-medium rounded-md transition-colors bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              @click="openBatchFixModal(currentFix)"
            >
              Choose Value
            </button>
          </div>
        </div>
      </div>

      <!-- Navigation: Arrows + Dots -->
      <div v-if="totalFixesCount > 1" class="flex items-center justify-center mt-3 space-x-3">
        <!-- Previous arrow -->
        <button
          :disabled="currentFixIndex === 0"
          class="p-1 rounded-full transition-colors"
          :class="currentFixIndex === 0 ? 'text-gray-300 cursor-not-allowed' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'"
          @click="goToPrevFix"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <!-- Dot indicators -->
        <div class="flex items-center space-x-1.5">
          <button
            v-for="(fix, index) in allQuickFixes"
            :key="index"
            class="w-2 h-2 rounded-full transition-colors"
            :class="index === currentFixIndex ? 'bg-primary-600' : 'bg-gray-300 hover:bg-gray-400'"
            :title="`Fix ${index + 1}`"
            @click="goToFix(index)"
          />
        </div>

        <!-- Next arrow -->
        <button
          :disabled="currentFixIndex === totalFixesCount - 1"
          class="p-1 rounded-full transition-colors"
          :class="currentFixIndex === totalFixesCount - 1 ? 'text-gray-300 cursor-not-allowed' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'"
          @click="goToNextFix"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Batch Fix Modal -->
    <div v-if="showBatchFixModal" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div class="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
        <div class="px-6 py-4 border-b border-gray-200">
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-medium text-gray-900">Fix Multiple Rows</h3>
            <button class="text-gray-400 hover:text-gray-500" @click="closeBatchFixModal">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        <div class="px-6 py-4">
          <p class="text-sm text-gray-600 mb-4">
            Select the correct value for "<span class="font-medium text-red-700">{{ batchFixTarget?.invalidValue }}</span>"
            to apply to {{ batchFixTarget?.rows.length }} row{{ batchFixTarget?.rows.length > 1 ? 's' : '' }}:
          </p>
          <p class="text-xs text-gray-500 mb-2">
            {{ batchFixTarget?.rows.length }} row{{ batchFixTarget?.rows.length > 1 ? 's' : '' }} affected
          </p>
          <select
            v-model="batchFixSelectedValue"
            class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="">Select correct value...</option>
            <option v-for="type in resourceTypes" :key="type" :value="type">{{ type }}</option>
          </select>
        </div>
        <div class="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end space-x-3 rounded-b-lg">
          <button
            class="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            @click="closeBatchFixModal"
          >
            Cancel
          </button>
          <button
            :disabled="!batchFixSelectedValue || applyingFix"
            class="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            @click="applyManualBatchFix"
          >
            <span v-if="applyingFix">Applying...</span>
            <span v-else>Apply to all affected rows</span>
          </button>
        </div>
      </div>
    </div>

    <!-- KRT Editor Section -->
    <div
      class="card relative"
      @dragenter="handleDragEnter"
      @dragleave="handleDragLeave"
      @dragover.prevent
      @drop="handleDrop"
    >
      <!-- Drag overlay -->
      <div
        v-if="isDragging"
        class="absolute inset-0 bg-primary-50/90 border-2 border-dashed border-primary-500 rounded-lg z-10 flex items-center justify-center"
      >
        <div class="text-center">
          <svg class="mx-auto h-10 w-10 text-primary-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          <p class="mt-2 text-sm font-medium text-primary-700">Drop to replace Key Resources Table file</p>
        </div>
      </div>
      <h3 class="text-sm font-medium text-gray-700 mb-3">Key Resources Table</h3>
      <KRTEditor
        ref="krtEditorRef"
        :submission-id="route.params.id"
        :show-revalidate="true"
        :show-suggestions="false"
        :krt-file-url="krtFile?.s3Url"
        @revalidate="handleValidate"
      />
    </div>
  </div>
</template>
