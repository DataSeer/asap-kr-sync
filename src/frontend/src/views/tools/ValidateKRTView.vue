<script setup>
import { ref, computed, provide, onMounted } from 'vue'
import { useNotificationStore } from '@/stores/notification.store'
import krtService from '@/services/krt.service'
import { createLocalKrt } from '@/stores/localKrt'
import KRTEditor from '@/components/krt/KRTEditor.vue'

/**
 * Standalone KRT validation page.
 *
 * Upload a Key Resources Table, check/fix it in the same editor used in the
 * submission flow, and download the corrected file. Nothing is persisted — the
 * server only parses/validates/exports statelessly (no submission, no DB, no
 * S3). Backed by an in-memory store provided to KRTEditor via `provide`.
 */

const notificationStore = useNotificationStore()

// In-memory store shared with the embedded KRTEditor.
const localStore = createLocalKrt()
provide('krtStore', localStore)

const fileInput = ref(null)
const uploading = ref(false)
const isDragging = ref(false)
const hasFile = ref(false)
const currentFileName = ref('')

const summary = computed(() => localStore.summary)

onMounted(() => {
  document.title = 'Validate a KRT | KRT Assist'
})

function triggerFileUpload() {
  fileInput.value?.click()
}

async function loadFile(file) {
  const ext = '.' + file.name.split('.').pop().toLowerCase()
  if (!['.csv', '.xlsx'].includes(ext)) {
    notificationStore.error('Invalid file type. Accepted: .csv, .xlsx')
    return
  }

  uploading.value = true
  try {
    const res = await krtService.parseFile(file)
    localStore.loadFromParse(res)
    localStore.downloadBaseName = file.name.replace(/\.[^.]+$/, '') + '-validated'
    currentFileName.value = file.name
    hasFile.value = true

    const { totalErrors, totalWarnings } = localStore.summary
    if (totalErrors === 0 && totalWarnings === 0) {
      notificationStore.success('Key Resources Table is valid — no issues found.')
    } else {
      const parts = []
      if (totalErrors > 0) parts.push(`${totalErrors} error${totalErrors > 1 ? 's' : ''}`)
      if (totalWarnings > 0) parts.push(`${totalWarnings} warning${totalWarnings > 1 ? 's' : ''}`)
      notificationStore.info(`Loaded — found ${parts.join(' and ')}.`)
    }
  } catch (error) {
    const data = error.response?.data
    notificationStore.error(data?.error || 'Failed to read the file. Make sure it is a valid KRT (CSV/XLSX).')
  } finally {
    uploading.value = false
  }
}

async function handleFileUpload(event) {
  const file = event.target.files[0]
  if (!file) return
  await loadFile(file)
  event.target.value = ''
}

async function handleRevalidate() {
  try {
    await localStore.validate()
    const { totalErrors, totalWarnings } = localStore.summary
    if (totalErrors === 0 && totalWarnings === 0) {
      notificationStore.success('Key Resources Table is valid — no issues found.')
    } else if (totalErrors === 0) {
      notificationStore.success(`Valid with ${totalWarnings} warning${totalWarnings > 1 ? 's' : ''}.`)
    } else {
      notificationStore.error(`Found ${totalErrors} error${totalErrors > 1 ? 's' : ''} to fix.`)
    }
  } catch (error) {
    notificationStore.error('Validation failed')
  }
}

// Drag-and-drop
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
  if (file) await loadFile(file)
}
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="card">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="text-xl font-semibold text-gray-900">Validate a Key Resources Table</h1>
          <p class="mt-1 text-sm text-gray-600 max-w-2xl">
            Upload a KRT to check its formatting, fix any errors or warnings inline, and download the
            corrected file. Nothing is saved — this is a private sanity check that never creates a submission.
          </p>
        </div>
        <input
          ref="fileInput"
          type="file"
          accept=".csv,.xlsx"
          class="hidden"
          @change="handleFileUpload"
        />
        <button
          :disabled="uploading"
          class="btn-primary text-sm inline-flex items-center whitespace-nowrap"
          @click="triggerFileUpload"
        >
          <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          <span v-if="uploading">Reading…</span>
          <span v-else>{{ hasFile ? 'Upload a different KRT' : 'Upload a KRT' }}</span>
        </button>
      </div>
      <p v-if="hasFile" class="mt-3 text-xs text-gray-500">
        Loaded: <span class="font-medium text-gray-700">{{ currentFileName }}</span>
        · {{ summary.totalErrors }} error{{ summary.totalErrors === 1 ? '' : 's' }},
        {{ summary.totalWarnings }} warning{{ summary.totalWarnings === 1 ? '' : 's' }}
      </p>
    </div>

    <!-- Empty state: prominent drop zone before any file is loaded -->
    <div
      v-if="!hasFile"
      class="card border-2 border-dashed"
      :class="isDragging ? 'border-primary-500 bg-primary-50/60' : 'border-gray-300'"
      @dragenter="handleDragEnter"
      @dragleave="handleDragLeave"
      @dragover.prevent
      @drop="handleDrop"
    >
      <div class="text-center py-12">
        <svg class="mx-auto h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
        </svg>
        <p class="mt-3 text-sm font-medium text-gray-700">Drop a KRT file here, or click “Upload a KRT”.</p>
        <p class="mt-1 text-xs text-gray-500">Accepted formats: CSV, XLSX</p>
      </div>
    </div>

    <!-- Editor: same component as the submission flow, backed by the local store -->
    <div
      v-else
      class="card relative"
      @dragenter="handleDragEnter"
      @dragleave="handleDragLeave"
      @dragover.prevent
      @drop="handleDrop"
    >
      <div
        v-if="isDragging"
        class="absolute inset-0 bg-primary-50/90 border-2 border-dashed border-primary-500 rounded-lg z-10 flex items-center justify-center"
      >
        <div class="text-center">
          <svg class="mx-auto h-10 w-10 text-primary-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          <p class="mt-2 text-sm font-medium text-primary-700">Drop to load a different KRT</p>
        </div>
      </div>
      <h3 class="text-sm font-medium text-gray-700 mb-3">Key Resources Table</h3>
      <KRTEditor
        submission-id="local"
        :show-revalidate="true"
        :show-suggestions="false"
        @revalidate="handleRevalidate"
      />
    </div>
  </div>
</template>
