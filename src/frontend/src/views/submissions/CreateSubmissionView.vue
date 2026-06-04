<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSubmissionStore } from '@/stores/submission.store'
import { useNotificationStore } from '@/stores/notification.store'
import { useAuthStore } from '@/stores/auth.store'
import submissionService from '@/services/submission.service'
import pdfService from '@/services/pdf.service'
import krtService from '@/services/krt.service'
import demosService from '@/services/demos.service'
import api from '@/services/api'


const router = useRouter()
const submissionStore = useSubmissionStore()
const notificationStore = useNotificationStore()
const authStore = useAuthStore()

// Use Demo Data is admin-only — it pre-fills metadata AND attaches the demo
// PDF/KRT files so the admin doesn't have to download-and-reupload.
const isAdmin = computed(() => authStore.effectiveRole === 'admin')

const title = ref('')
const notes = ref('')
const pdfFile = ref(null)
const krtFile = ref(null)
const supplementalFile = ref(null)
const loading = ref(false)
const showDemoSelector = ref(false)
const demoFilter = ref('')

// KRT format error — surfaced as a dedicated block above the submit button
// when the pre-flight validation fails. Holds `{ message, missingColumns }`.
const krtFormatError = ref(null)

// Highlight flags for the required inputs, set on a submit attempt that is
// missing a value and cleared as soon as the user provides one.
const titleInvalid = ref(false)
const pdfInvalid = ref(false)

// KRT template URL (Google Sheets) — fetched on mount and surfaced in the
// error block so the user has a one-click way to grab a correctly-formatted
// template when their upload is rejected.
const krtTemplateUrl = ref('')

// No-KRT confirmation modal — shown when the user clicks "Create" without
// attaching a KRT file. Gives them a chance to confirm it wasn't an
// oversight. If confirmed, the frontend submits a header-only empty CSV so
// step 2 has a working table.
const showNoKrtConfirm = ref(false)

const ACCEPTED_PDF = '.pdf,.docx'
const ACCEPTED_KRT = '.csv,.xlsx'
const ACCEPTED_SUPPLEMENTAL_TYPES = '.pdf,.doc,.docx'

// Header-only empty CSV sent when the user explicitly opts to create
// without a Key Resources Table. Backend treats this as a valid KRT (the
// header row is what makes it valid) and the table opens empty on step 2.
const EMPTY_KRT_CSV = 'RESOURCE TYPE,RESOURCE NAME,SOURCE,IDENTIFIER,NEW/REUSE,ADDITIONAL INFORMATION\n'

function handlePdfFile(event) {
  const file = event.target.files[0]
  if (!file) {
    pdfFile.value = null
    return
  }
  const ext = file.name.split('.').pop().toLowerCase()
  if (!['pdf', 'docx'].includes(ext)) {
    notificationStore.error('Invalid file type. PDF or DOCX only.')
    event.target.value = ''
    pdfFile.value = null
    return
  }
  pdfFile.value = file
  pdfInvalid.value = false
}

function clearPdfFile() {
  pdfFile.value = null
  const input = document.getElementById('pdfFile')
  if (input) input.value = ''
}

function handleKrtFile(event) {
  const file = event.target.files[0]
  if (!file) {
    krtFile.value = null
    return
  }
  const ext = file.name.split('.').pop().toLowerCase()
  if (!['csv', 'xlsx'].includes(ext)) {
    notificationStore.error('Invalid file type. CSV or XLSX only.')
    event.target.value = ''
    krtFile.value = null
    return
  }
  krtFile.value = file
  // Picking a new file clears any previous format error — pre-validation
  // runs again when the user clicks Create.
  krtFormatError.value = null
}

function clearKrtFile() {
  krtFile.value = null
  krtFormatError.value = null
  const input = document.getElementById('krtFile')
  if (input) input.value = ''
}

function handleSupplementalFile(event) {
  const file = event.target.files[0]
  if (!file) {
    supplementalFile.value = null
    return
  }
  const ext = file.name.split('.').pop().toLowerCase()
  if (!['pdf', 'doc', 'docx'].includes(ext)) {
    notificationStore.error('Invalid file type. PDF or Word only.')
    event.target.value = ''
    supplementalFile.value = null
    return
  }
  supplementalFile.value = file
}

function clearSupplementalFile() {
  supplementalFile.value = null
  const input = document.getElementById('supplementalFile')
  if (input) input.value = ''
}

// Demo documents — discovered server-side from src/frontend/public/demo-files/.
// Includes every PDF demo whether or not it has a matching KRT file.
const demoDocuments = ref([])

onMounted(async () => {
  try {
    const list = await demosService.list()
    demoDocuments.value = list
      .filter(d => d.pdf)
      .map(d => ({
        manuscriptId: d.id,
        title: d.title || d.description || d.id,
        pdf: d.pdf,
        krt: d.krt || null
      }))
  } catch {
    demoDocuments.value = []
  }

  // KRT template URL — used by the format-error block to link users to a
  // properly-formatted template when their upload is rejected.
  try {
    const response = await api.get('/config/krt-template')
    krtTemplateUrl.value = response.data.url
  } catch {
    // Template URL is optional; the error block falls back to text-only.
  }
})

const filteredDemoDocuments = computed(() => {
  const q = demoFilter.value.trim().toLowerCase()
  if (!q) return demoDocuments.value
  return demoDocuments.value.filter(doc =>
    doc.manuscriptId.toLowerCase().includes(q) || doc.title.toLowerCase().includes(q)
  )
})

/**
 * Fetch a file from /demo-files/ and wrap as a real File object the upload
 * form can use. Guards against the SPA fallback returning index.html when
 * the demo file is missing on disk.
 */
async function fetchDemoFile(name, mimeType) {
  const response = await fetch(`/demo-files/${name}`)
  if (!response.ok) throw new Error(`Failed to fetch demo file: ${name}`)
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('text/html')) {
    throw new Error(`Demo file not found: ${name}`)
  }
  const blob = await response.blob()
  return new File([blob], name, { type: mimeType })
}

async function selectDemoDocument(doc) {
  showDemoSelector.value = false
  demoFilter.value = ''

  // Loading a demo fills the required fields — clear any stale highlight.
  titleInvalid.value = false
  pdfInvalid.value = false

  title.value = doc.title
  notes.value = `Demo submission - matches ${doc.manuscriptId} demo files`

  // Fetch PDF + KRT in parallel; report failures but don't abort the whole load
  const tasks = []
  if (doc.pdf) {
    tasks.push(
      fetchDemoFile(doc.pdf, 'application/pdf')
        .then(file => { pdfFile.value = file })
        .catch(err => notificationStore.error(`Demo PDF: ${err.message}`))
    )
  }
  if (doc.krt) {
    const ext = doc.krt.split('.').pop().toLowerCase()
    const mime = ext === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'text/csv'
    tasks.push(
      fetchDemoFile(doc.krt, mime)
        .then(file => { krtFile.value = file })
        .catch(err => notificationStore.error(`Demo Key Resources Table: ${err.message}`))
    )
  }
  await Promise.all(tasks)
  notificationStore.success(`Loaded demo data for ${doc.manuscriptId}`)
}

/**
 * Submit-button entry point. Splits the two gates:
 *   1. Manuscript PDF is HARD required — reject with a toast.
 *   2. KRT is SOFT required — if missing, open a confirmation modal so the
 *      user can confirm it wasn't an oversight. If they confirm, we send a
 *      header-only empty CSV (the backend still wants a KRT — this satisfies
 *      its format check while leaving the table empty for step 2).
 */
function handleSubmitClick() {
  // Highlight any missing required input (title + manuscript PDF).
  titleInvalid.value = !title.value.trim()
  pdfInvalid.value = !pdfFile.value
  if (titleInvalid.value || pdfInvalid.value) {
    notificationStore.error('Please fill in the required fields.')
    return
  }
  if (!krtFile.value) {
    showNoKrtConfirm.value = true
    return
  }
  proceedWithSubmit(krtFile.value)
}

function confirmNoKrtAndSubmit() {
  showNoKrtConfirm.value = false
  const emptyKrt = new File([EMPTY_KRT_CSV], 'empty-krt.csv', { type: 'text/csv' })
  proceedWithSubmit(emptyKrt)
}

async function proceedWithSubmit(krtFileToSend) {
  loading.value = true
  krtFormatError.value = null

  // The KRT file is sent as part of the submission-create request. The
  // server validates the file's format before any DB writes — if it's not
  // a properly-formatted Key Resources Table the call rejects with 400 and
  // no submission row is created. We surface that as the format-error block.
  let submission
  try {
    // Manuscript ID is collected later (via Edit Metadata) — users typically
    // don't have one at create time. The submission's `manuscriptId` defaults
    // to null and can be set before final submission.
    submission = await submissionStore.createSubmission(
      {
        title: title.value,
        manuscriptId: null,
        notes: notes.value
      },
      krtFileToSend
    )
  } catch (err) {
    loading.value = false
    const body = err.response?.data
    // The server returns the format-error shape ({ valid: false, error,
    // missingColumns }) when the KRT failed validation. Everything else
    // is shown as a generic toast.
    if (body && body.valid === false) {
      krtFormatError.value = {
        message: body.error || 'Key Resources Table format is not valid.',
        missingColumns: Array.isArray(body.missingColumns) ? body.missingColumns : []
      }
    } else {
      notificationStore.error(body?.error || 'Failed to create submission')
    }
    return
  }

  try {
    // Submission + KRT are persisted by the create endpoint. Upload the
    // remaining files (PDF, supplemental) in parallel. The PDF upload
    // triggers the background pipeline on the backend.
    const uploads = []

    uploads.push(
      pdfService.upload(submission.id, pdfFile.value)
        .catch(err => ({ kind: 'pdf', error: err }))
    )
    if (supplementalFile.value) {
      uploads.push(
        submissionService.uploadSupplemental(submission.id, supplementalFile.value)
          .catch(err => ({ kind: 'supplemental', error: err }))
      )
    }

    const results = await Promise.all(uploads)
    const failures = results.filter(r => r && r.error)

    if (failures.length === 0) {
      notificationStore.success('Submission created — background processes started')
    } else {
      // Submission is created; surface the file failures so the user can
      // retry the individual upload from step 2/3.
      for (const f of failures) {
        const label = {
          pdf: 'PDF',
          krt: 'Key Resources Table',
          supplemental: 'supplemental methods file'
        }[f.kind] || 'file'
        notificationStore.warning(
          `Submission created, but ${label} upload failed: ${f.error.response?.data?.error || f.error.message}`
        )
      }
    }

    router.push({ name: 'submission-krt', params: { id: submission.id } })
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to create submission')
  } finally {
    loading.value = false
  }
}

function handleCancel() {
  router.push({ name: 'dashboard' })
}
</script>

<template>
  <div class="max-w-2xl mx-auto">
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-900">New Submission</h1>
      <div v-if="isAdmin && demoDocuments.length > 0" class="relative">
        <button
          type="button"
          class="btn-secondary text-sm"
          title="Load demo metadata and files (PDF, Key Resources Table if available) in one click"
          @click="showDemoSelector = !showDemoSelector"
        >
          Use Demo Data
          <svg class="w-4 h-4 ml-1 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        <!-- Demo document selector dropdown -->
        <div
          v-if="showDemoSelector"
          class="absolute right-0 mt-2 w-96 bg-white rounded-lg shadow-lg border border-gray-200 z-10 max-h-96 flex flex-col"
        >
          <div class="p-2 border-b border-gray-100 bg-gray-50">
            <input
              v-model="demoFilter"
              type="text"
              class="w-full px-3 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
              placeholder="Filter by manuscript ID or title..."
              @click.stop
            />
          </div>
          <div class="py-1 overflow-y-auto">
            <button
              v-for="doc in filteredDemoDocuments"
              :key="doc.manuscriptId"
              type="button"
              class="w-full px-4 py-3 text-left hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
              @click="selectDemoDocument(doc)"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="font-mono text-sm text-primary-600 font-medium truncate">{{ doc.manuscriptId }}</div>
                <!-- "KRT" pill — flags demo entries that ship with a matching
                     KRT file, so the admin knows the form will be pre-filled. -->
                <span
                  v-if="doc.krt"
                  class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium flex-shrink-0"
                  :title="'Includes a Key Resources Table file: ' + doc.krt"
                >Key Resources Table</span>
              </div>
              <div class="text-sm text-gray-700 mt-1 line-clamp-2">{{ doc.title }}</div>
            </button>
            <div v-if="filteredDemoDocuments.length === 0" class="px-4 py-3 text-sm text-gray-500 text-center">
              No matching documents
            </div>
          </div>
        </div>
        <!-- Click outside to close -->
        <div
          v-if="showDemoSelector"
          class="fixed inset-0 z-0"
          @click="showDemoSelector = false; demoFilter = ''"
        ></div>
      </div>
    </div>

    <form class="card space-y-6" @submit.prevent="handleSubmitClick">
      <!-- 1. Title (required) -->
      <div>
        <label for="title" class="label">Title <span class="text-red-500">*</span></label>
        <input
          id="title"
          v-model="title"
          type="text"
          required
          :class="['input', titleInvalid ? 'ring-2 ring-red-400 border-red-400' : '']"
          placeholder="Enter manuscript title"
          @input="titleInvalid = false"
        />
        <p v-if="titleInvalid" class="mt-1 text-xs text-red-600">A title is required.</p>
      </div>

      <!-- 2. Upload Key Resources Table (required) -->
      <div>
        <label for="krtFile" class="label">
          Upload Key Resources Table <span class="text-red-500">*</span>
        </label>
        <p class="mb-2 text-sm text-gray-500">CSV or XLSX.</p>
        <div v-if="!krtFile" class="flex items-center">
          <input
            id="krtFile"
            type="file"
            :accept="ACCEPTED_KRT"
            class="input file:mr-4 file:py-1 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-primary-50 file:text-primary-700 hover:file:bg-primary-100"
            @change="handleKrtFile"
          />
        </div>
        <div v-else class="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
          <svg class="w-5 h-5 text-gray-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <span class="text-sm text-gray-700 truncate flex-1">{{ krtFile.name }}</span>
          <span class="text-xs text-gray-400">{{ (krtFile.size / 1024).toFixed(1) }} KB</span>
          <button type="button" class="text-gray-400 hover:text-red-500 transition-colors" title="Remove file" @click="clearKrtFile">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <!-- 3. Upload manuscript (required) -->
      <div>
        <label for="pdfFile" class="label">
          Upload Manuscript <span class="text-red-500">*</span>
        </label>
        <p class="mb-2 text-sm text-gray-500">PDF or DOCX. Background processes start automatically after upload.</p>
        <div v-if="!pdfFile">
          <div class="flex items-center">
            <input
              id="pdfFile"
              type="file"
              :accept="ACCEPTED_PDF"
              :class="['input file:mr-4 file:py-1 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-primary-50 file:text-primary-700 hover:file:bg-primary-100', pdfInvalid ? 'ring-2 ring-red-400 border-red-400' : '']"
              @change="handlePdfFile"
            />
          </div>
          <p v-if="pdfInvalid" class="mt-1 text-xs text-red-600">A manuscript PDF is required.</p>
        </div>
        <div v-else class="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
          <svg class="w-5 h-5 text-gray-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <span class="text-sm text-gray-700 truncate flex-1">{{ pdfFile.name }}</span>
          <span class="text-xs text-gray-400">{{ (pdfFile.size / 1024 / 1024).toFixed(1) }} MB</span>
          <button type="button" class="text-gray-400 hover:text-red-500 transition-colors" title="Remove file" @click="clearPdfFile">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <!-- 4. Supplemental Methods File (if applicable) -->
      <div>
        <label for="supplementalFile" class="label">
          Supplemental Methods File <span class="text-gray-400 text-sm font-normal">(if applicable)</span>
        </label>
        <p class="mb-2 text-sm text-gray-500">PDF or Word document only. This file will be appended to the main manuscript PDF during analysis.</p>
        <div v-if="!supplementalFile" class="flex items-center">
          <input
            id="supplementalFile"
            type="file"
            :accept="ACCEPTED_SUPPLEMENTAL_TYPES"
            class="input file:mr-4 file:py-1 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-primary-50 file:text-primary-700 hover:file:bg-primary-100"
            @change="handleSupplementalFile"
          />
        </div>
        <div v-else class="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
          <svg class="w-5 h-5 text-gray-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <span class="text-sm text-gray-700 truncate flex-1">{{ supplementalFile.name }}</span>
          <span class="text-xs text-gray-400">{{ (supplementalFile.size / 1024 / 1024).toFixed(1) }} MB</span>
          <button type="button" class="text-gray-400 hover:text-red-500 transition-colors" title="Remove file" @click="clearSupplementalFile">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <!-- 5. Notes (optional) -->
      <div>
        <label for="notes" class="label">Notes <span class="text-gray-400 text-sm font-normal">(optional)</span></label>
        <textarea
          id="notes"
          v-model="notes"
          rows="2"
          class="input"
          placeholder="Add any notes about this submission"
        ></textarea>
      </div>

      <!-- KRT format error — surfaced when the server rejects the file
           during submission create. The submission is NOT created until
           the user fixes the file. Linked to the KRT template so the user
           has a one-click path to a correctly-shaped file. -->
      <div v-if="krtFormatError" class="krt-format-error" role="alert">
        <div class="krt-format-error-icon">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        </div>
        <div class="krt-format-error-body">
          <p class="krt-format-error-message">
            Ensure the first row of the Key Resources Table includes the correct values:
            <a
              v-if="krtTemplateUrl"
              :href="krtTemplateUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="krt-format-error-link"
            >open the template</a>.
          </p>
        </div>
      </div>

      <div class="flex items-center justify-end space-x-4 pt-4 border-t">
        <button type="button" class="btn-secondary" @click="handleCancel">Cancel</button>
        <!-- Always clickable (except while loading) so the click handler can
             highlight missing required inputs (title + PDF). A missing KRT opens
             a confirmation modal instead of blocking. -->
        <button type="submit" :disabled="loading" class="btn-primary">
          <span v-if="loading">Creating...</span>
          <span v-else>Create & Continue to Step 2</span>
        </button>
      </div>
    </form>

    <!-- No-KRT confirmation modal. The user can still proceed, but we want
         them to confirm it wasn't an oversight first. On confirm, the
         frontend submits an empty-but-valid header-only CSV. -->
    <Teleport to="body">
      <div v-if="showNoKrtConfirm" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="showNoKrtConfirm = false">
        <div class="bg-white rounded-lg shadow-xl w-full max-w-md p-5">
          <h3 class="text-base font-semibold text-gray-900 mb-2">Continue without a Key Resources Table?</h3>
          <p class="text-sm text-gray-600 mb-3">
            You haven't attached a Key Resources Table. You can still create the submission and add one later, but most workflows expect it.
          </p>
          <p v-if="krtTemplateUrl" class="text-sm text-gray-600 mb-4">
            If you don't have one yet, you can
            <a :href="krtTemplateUrl" target="_blank" rel="noopener noreferrer" class="font-medium text-primary-600 underline hover:text-primary-700">open the template</a>
            and come back.
          </p>
          <div class="flex justify-end gap-2">
            <button class="px-3 py-1.5 text-sm font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200" @click="showNoKrtConfirm = false">
              Go back and attach one
            </button>
            <button class="px-3 py-1.5 text-sm font-medium rounded-md bg-primary-600 text-white hover:bg-primary-700" @click="confirmNoKrtAndSubmit">
              Continue without it
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.krt-format-error {
  display: flex;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 0.5rem;
  margin-bottom: 1rem;
}
.krt-format-error-icon {
  color: #dc2626;
  flex-shrink: 0;
  padding-top: 0.125rem;
}
.krt-format-error-body { flex: 1; min-width: 0; }
.krt-format-error-message {
  font-size: 0.875rem;
  color: #7f1d1d;
  margin: 0;
}
.krt-format-error-link {
  font-weight: 600;
  color: #dc2626;
  text-decoration: underline;
}
.krt-format-error-link:hover { color: #991b1b; }
</style>
