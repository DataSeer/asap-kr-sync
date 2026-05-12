<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSubmissionStore } from '@/stores/submission.store'
import { useNotificationStore } from '@/stores/notification.store'
import { useAuthStore } from '@/stores/auth.store'
import submissionService from '@/services/submission.service'
import demosService from '@/services/demos.service'

const router = useRouter()
const submissionStore = useSubmissionStore()
const notificationStore = useNotificationStore()
const authStore = useAuthStore()

// Demo metadata loader is an admin-only convenience — non-admin users
// shouldn't see the "Use Demo Metadata" affordance.
const isAdmin = computed(() => authStore.effectiveRole === 'admin')

const title = ref('')
const manuscriptId = ref('')
const notes = ref('')
const supplementalFile = ref(null)
const loading = ref(false)
const showDemoSelector = ref(false)
const demoFilter = ref('')

const ACCEPTED_SUPPLEMENTAL_TYPES = '.pdf,.doc,.docx'

function handleSupplementalFile(event) {
  const file = event.target.files[0]
  if (!file) {
    supplementalFile.value = null
    return
  }
  const ext = file.name.split('.').pop().toLowerCase()
  if (!['pdf', 'doc', 'docx'].includes(ext)) {
    notificationStore.error('Invalid file type. Only PDF and Word documents are accepted.')
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
// Includes every PDF demo whether or not it has a matching KRT file. Each
// entry: { manuscriptId, title, krt } — `krt` carries the matching KRT
// filename (or null) so the dropdown can render a "KRT" pill.
const demoDocuments = ref([])

onMounted(async () => {
  try {
    const list = await demosService.list()
    demoDocuments.value = list
      .filter(d => d.pdf)
      .map(d => ({
        manuscriptId: d.id,
        title: d.title || d.description || d.id,
        krt: d.krt || null
      }))
  } catch {
    demoDocuments.value = []
  }
})

const filteredDemoDocuments = computed(() => {
  const q = demoFilter.value.trim().toLowerCase()
  if (!q) return demoDocuments.value
  return demoDocuments.value.filter(doc =>
    doc.manuscriptId.toLowerCase().includes(q) || doc.title.toLowerCase().includes(q)
  )
})

function selectDemoDocument(doc) {
  title.value = doc.title
  manuscriptId.value = doc.manuscriptId
  notes.value = `Demo submission - matches ${doc.manuscriptId} demo files`
  showDemoSelector.value = false
  demoFilter.value = ''
  notificationStore.success(`Loaded metadata for ${doc.manuscriptId}`)
}

async function handleSubmit() {
  loading.value = true

  try {
    const submission = await submissionStore.createSubmission({
      title: title.value,
      manuscriptId: manuscriptId.value || null,
      notes: notes.value
    })

    // Upload supplemental file if provided
    if (supplementalFile.value) {
      try {
        await submissionService.uploadSupplemental(submission.id, supplementalFile.value)
        notificationStore.success('Submission created with supplemental methods file')
      } catch (err) {
        // Submission was created but supplemental upload failed — warn but don't block
        notificationStore.warning(
          'Submission created, but supplemental file upload failed: ' +
          (err.response?.data?.error || err.message) +
          '. You can re-upload it later.'
        )
      }
    } else {
      notificationStore.success('Submission created successfully')
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
      <h1 class="text-2xl font-bold text-gray-900">Create New Submission</h1>
      <div v-if="isAdmin && demoDocuments.length > 0" class="relative">
        <button
          type="button"
          class="btn-secondary text-sm"
          title="Load demo metadata matching demo KRT, PDF, and analysis files"
          @click="showDemoSelector = !showDemoSelector"
        >
          Use Demo Metadata
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
                     KRT file, so the user knows they'll get a pre-filled table
                     when they pick this demo. -->
                <span
                  v-if="doc.krt"
                  class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium flex-shrink-0"
                  :title="'Includes a KRT file: ' + doc.krt"
                >KRT</span>
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

    <form class="card space-y-6" @submit.prevent="handleSubmit">
      <div>
        <label for="title" class="label">Title <span class="text-red-500">*</span></label>
        <input
          id="title"
          v-model="title"
          type="text"
          required
          class="input"
          placeholder="Enter manuscript title"
        />
      </div>

      <div>
        <label for="manuscriptId" class="label">Manuscript ID <span class="text-gray-400 text-sm font-normal">(optional)</span></label>
        <input
          id="manuscriptId"
          v-model="manuscriptId"
          type="text"
          class="input"
          placeholder="e.g., XX1-000000-001-org-X-1"
        />
        <p class="mt-1 text-sm text-gray-500">
          If ASAP staff have provided you with a Manuscript ID, please enter it here (e.g., XX1-000000-001-org-X-1). Otherwise leave this cell blank.
        </p>
      </div>

      <div>
        <label for="notes" class="label">Notes <span class="text-gray-400 text-sm font-normal">(optional)</span></label>
        <textarea
          id="notes"
          v-model="notes"
          rows="3"
          class="input"
          placeholder="Add any notes about this submission"
        ></textarea>
      </div>

      <div>
        <label for="supplementalFile" class="label">
          Upload Supplemental Methods File
          <span class="text-gray-400 text-sm font-normal">(if applicable)</span>
        </label>
        <p class="mb-2 text-sm text-gray-500">
          PDF or Word document only. This file will be appended to the main manuscript PDF during analysis.
        </p>
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
          <button
            type="button"
            class="text-gray-400 hover:text-red-500 transition-colors"
            title="Remove file"
            @click="clearSupplementalFile"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div class="flex items-center justify-end space-x-4 pt-4 border-t">
        <button
          type="button"
          class="btn-secondary"
          @click="handleCancel"
        >
          Cancel
        </button>
        <button
          type="submit"
          :disabled="loading"
          class="btn-primary"
        >
          <span v-if="loading">Creating...</span>
          <span v-else>Create & Continue to Step 1</span>
        </button>
      </div>
    </form>
  </div>
</template>
