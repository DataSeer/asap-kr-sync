<script setup>
/**
 * FilesInfoModal - Modal showing all uploaded files with version history
 */
import { computed } from 'vue'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  files: {
    type: Array,
    default: () => []
  },
  submissionId: {
    type: String,
    required: true
  },
  hasKrt: {
    type: Boolean,
    default: false
  },
  currentRound: {
    type: Number,
    default: 1
  }
})

const emit = defineEmits(['close', 'download', 'download-krt-data'])

// Group files by type. Within each type, sort by (round desc, version desc)
// so newer rounds come first and within a round the latest upload comes first.
// `version` is per-(submission, type, round): each round restarts at 1.
const filesByType = computed(() => {
  const grouped = {}
  for (const file of props.files) {
    if (!grouped[file.type]) {
      grouped[file.type] = []
    }
    grouped[file.type].push(file)
  }
  for (const type in grouped) {
    grouped[type].sort((a, b) => {
      if (b.round !== a.round) return b.round - a.round
      return b.version - a.version
    })
  }
  return grouped
})

// KRT files grouped by round (descending). Each round bundles its
// "current/final KRT data" download (sourced from KRTData rows for that
// round) together with every original upload that landed during that round.
const krtRounds = computed(() => {
  const krtFiles = filesByType.value.krt || []
  const byRound = new Map()
  for (const file of krtFiles) {
    const round = file.round || 1
    if (!byRound.has(round)) byRound.set(round, [])
    byRound.get(round).push(file)
  }
  const rounds = [...byRound.keys()].sort((a, b) => b - a)
  return rounds.map(round => {
    const uploads = byRound.get(round).sort((a, b) => b.version - a.version)
    return {
      round,
      isCurrent: round === props.currentRound,
      uploads
    }
  })
})

// For a given type, what's the (round, version) tuple of the absolute
// "current" file — i.e. the row that the rest of the app treats as live?
// That's max(version) within currentRound. Used to flag the "Current" badge
// on PDF/other rows.
function isCurrentFile(file, typeFiles) {
  if ((file.round || 1) !== props.currentRound) return false
  const maxInCurrentRound = Math.max(
    ...typeFiles
      .filter(f => (f.round || 1) === props.currentRound)
      .map(f => f.version)
  )
  return file.version === maxInCurrentRound
}

const typeLabels = {
  krt: 'KRT Files',
  pdf: 'PDF Files',
  report: 'Reports'
}

const typeIcons = {
  krt: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  pdf: 'M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z',
  report: 'M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'
}

function formatDate(date) {
  return new Date(date).toLocaleString()
}

function formatSize(bytes) {
  if (!bytes) return '-'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function handleDownload(file) {
  emit('download', file)
}

function downloadKrtData(round) {
  emit('download-krt-data', round)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="fixed inset-0 z-50 overflow-y-auto">
      <!-- Backdrop -->
      <div class="fixed inset-0 bg-black bg-opacity-50" @click="emit('close')"></div>

      <!-- Modal -->
      <div class="flex min-h-full items-center justify-center p-4">
        <div class="relative bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] overflow-hidden">
          <!-- Header -->
          <div class="flex items-center justify-between p-4 border-b">
            <h3 class="text-lg font-semibold text-gray-900">Uploaded Files</h3>
            <button
              class="text-gray-400 hover:text-gray-600"
              @click="emit('close')"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- Content -->
          <div class="p-4 overflow-y-auto max-h-[60vh]">
            <div v-if="files.length === 0" class="text-center text-gray-500 py-8">
              No files uploaded yet
            </div>

            <div v-else class="space-y-6">
              <!-- KRT section grouped by round -->
              <div v-if="krtRounds.length > 0">
                <h4 class="font-medium text-gray-700 mb-3 flex items-center">
                  <svg class="w-5 h-5 mr-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="typeIcons.krt" />
                  </svg>
                  KRT Files
                </h4>

                <div class="space-y-4">
                  <div v-for="r in krtRounds" :key="r.round">
                    <!-- Round header -->
                    <div class="flex items-center mb-1.5">
                      <span class="text-xs font-semibold text-gray-500 uppercase tracking-wide">Round {{ r.round }}</span>
                      <span v-if="r.isCurrent" class="ml-2 px-1.5 py-0.5 text-xs bg-green-100 text-green-700 rounded">Current</span>
                    </div>

                    <div class="space-y-2 ml-3 border-l-2 border-gray-100 pl-3">
                      <!-- Edited / Final KRT Data (from KRTData rows for this round) -->
                      <div class="flex items-center justify-between p-3 bg-blue-50 rounded-lg border border-blue-100">
                        <div class="flex-1 min-w-0">
                          <div class="flex items-center">
                            <span class="font-medium text-gray-900">{{ r.isCurrent ? 'Current KRT Data' : 'Final KRT Data' }}</span>
                            <span class="ml-2 px-2 py-0.5 text-xs rounded" :class="r.isCurrent ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'">
                              {{ r.isCurrent ? 'Edited' : 'Final' }}
                            </span>
                          </div>
                          <div class="text-sm text-gray-500 mt-1">
                            {{ r.isCurrent ? 'Latest data with all edits applied for this round' : 'Data as finalized for this round' }}
                          </div>
                        </div>
                        <button
                          class="ml-4 btn-secondary text-sm flex items-center"
                          @click="downloadKrtData(r.round)"
                        >
                          <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                          Download CSV
                        </button>
                      </div>

                      <!-- Original uploads for this round (latest first) -->
                      <div
                        v-for="upload in r.uploads"
                        :key="upload.id"
                        class="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                      >
                        <div class="flex-1 min-w-0">
                          <div class="flex items-center">
                            <span class="font-medium text-gray-900 truncate">{{ upload.fileName }}</span>
                            <span class="ml-2 px-2 py-0.5 text-xs bg-gray-200 text-gray-600 rounded">
                              v{{ upload.round }}.{{ upload.version }}
                            </span>
                            <span class="ml-2 px-2 py-0.5 text-xs bg-amber-100 text-amber-700 rounded">
                              Original
                            </span>
                          </div>
                          <div class="text-sm text-gray-500 mt-1">
                            {{ formatDate(upload.createdAt) }}
                            <span v-if="upload.size" class="ml-2">{{ formatSize(upload.size) }}</span>
                          </div>
                        </div>
                        <button
                          class="ml-4 btn-secondary text-sm flex items-center"
                          @click="handleDownload(upload)"
                        >
                          <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                          Download
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Other file types (PDF, Reports) -->
              <div v-for="(typeFiles, type) in filesByType" :key="type">
                <template v-if="type !== 'krt'">
                  <h4 class="font-medium text-gray-700 mb-3 flex items-center">
                    <svg class="w-5 h-5 mr-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="typeIcons[type] || typeIcons.krt" />
                    </svg>
                    {{ typeLabels[type] || type.toUpperCase() }}
                  </h4>

                  <div class="space-y-2">
                    <div
                      v-for="file in typeFiles"
                      :key="file.id"
                      class="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                    >
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center">
                          <span class="font-medium text-gray-900 truncate">{{ file.fileName }}</span>
                          <span class="ml-2 px-2 py-0.5 text-xs bg-gray-200 text-gray-600 rounded">
                            v{{ file.round }}.{{ file.version }}
                          </span>
                          <span v-if="isCurrentFile(file, typeFiles)" class="ml-2 px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded">
                            Current
                          </span>
                        </div>
                        <div class="text-sm text-gray-500 mt-1">
                          {{ formatDate(file.createdAt) }}
                          <span v-if="file.size" class="ml-2">{{ formatSize(file.size) }}</span>
                        </div>
                      </div>
                      <button
                        class="ml-4 btn-secondary text-sm flex items-center"
                        @click="handleDownload(file)"
                      >
                        <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                        Download
                      </button>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </div>

          <!-- Footer -->
          <div class="flex justify-end p-4 border-t bg-gray-50">
            <button class="btn-secondary" @click="emit('close')">
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
