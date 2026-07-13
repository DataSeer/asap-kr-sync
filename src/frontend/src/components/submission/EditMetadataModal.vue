<script setup>
/**
 * EditMetadataModal - Reusable modal for editing submission metadata
 *
 * @component
 * @example
 * <EditMetadataModal
 *   :show="showModal"
 *   :submission="submission"
 *   @close="showModal = false"
 *   @saved="handleSaved"
 * />
 */
import { ref, computed, watch } from 'vue'
import { useSubmissionStore } from '@/stores/submission.store'
import { useNotificationStore } from '@/stores/notification.store'
import { useAuthStore } from '@/stores/auth.store'
import demosService from '@/services/demos.service'
import api from '@/services/api'

const props = defineProps({
  /** Whether the modal is visible */
  show: {
    type: Boolean,
    default: false
  },
  /** The submission object to edit */
  submission: {
    type: Object,
    default: null
  }
})

const emit = defineEmits(['close', 'saved'])

const submissionStore = useSubmissionStore()
const notificationStore = useNotificationStore()
const authStore = useAuthStore()

// Demo lookup is admin-only, mirroring the "Use Demo Data" button on Create.
const isAdmin = computed(() => authStore.isAdmin)

// Owner reassignment is staff-only (admin / ds_annotator): they curate a
// document, then hand it to the real user.
const canReassign = computed(() => authStore.isStaff)
const users = ref([])
const usersLoading = ref(false)
const selectedOwnerId = ref('')
const reassigning = ref(false)
const currentOwner = computed(() => props.submission?.user || null)

async function loadUsers() {
  if (users.value.length || usersLoading.value) return
  usersLoading.value = true
  try {
    const response = await api.get('/users', { params: { limit: 500 } })
    users.value = response.data.users || []
  } catch {
    users.value = []
    notificationStore.error('Failed to load the user list')
  } finally {
    usersLoading.value = false
  }
}

async function reassignOwner() {
  if (!props.submission?.id || !selectedOwnerId.value) return
  reassigning.value = true
  try {
    const updated = await submissionStore.reassignOwner(props.submission.id, selectedOwnerId.value)
    notificationStore.success(`Owner changed to ${updated.user?.email || 'the selected user'}`)
    emit('saved', updated)
    closeModal()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to reassign owner')
  } finally {
    reassigning.value = false
  }
}
const demos = ref([])
const demoLoading = ref(false)
const demoSearchOpen = ref(false)
const demoQuery = ref('')

const saving = ref(false)
// DAS value when the modal opened — used to report whether the user changed it.
const originalDas = ref('')
const editForm = ref({
  title: '',
  manuscriptId: '',
  dataAvailabilityStatement: '',
  notes: ''
})

// Populate form when submission changes or modal opens
watch(() => [props.show, props.submission], ([show, submission]) => {
  if (show && submission) {
    editForm.value = {
      title: submission.title || '',
      manuscriptId: submission.manuscriptId || '',
      dataAvailabilityStatement: submission.dataAvailabilityStatement || '',
      notes: submission.notes || ''
    }
    originalDas.value = submission.dataAvailabilityStatement || ''
    demoSearchOpen.value = false
    demoQuery.value = ''
    selectedOwnerId.value = submission.userId || ''
    if (canReassign.value) loadUsers()
  }
}, { immediate: true })

/** Original PDF filename for this submission (used to auto-detect a demo). */
function getPdfFileName() {
  const files = props.submission?.files
  if (!Array.isArray(files)) return null
  const pdf = files.find(f => f.type === 'pdf') || files.find(f => f.type === 'pdf_original')
  return pdf?.fileName || null
}

async function loadDemos() {
  if (demos.value.length || demoLoading.value) return
  demoLoading.value = true
  try {
    demos.value = await demosService.list()
  } catch {
    demos.value = []
    notificationStore.error('Failed to load the demo list')
  } finally {
    demoLoading.value = false
  }
}

/**
 * Admin helper: try to auto-fill the Manuscript ID by matching the submission's
 * uploaded PDF filename against the known demos. If no exact match is found,
 * open a searchable list (pre-filled with the PDF base name) to pick from.
 */
async function findDemoManuscriptId() {
  await loadDemos()
  const pdfName = getPdfFileName()
  const base = pdfName ? pdfName.replace(/\.[^.]+$/, '') : ''
  if (base) {
    const match = demos.value.find(d =>
      (d.id || '').toLowerCase() === base.toLowerCase() ||
      (d.pdf || '').toLowerCase() === (pdfName || '').toLowerCase()
    )
    if (match) {
      editForm.value.manuscriptId = match.id
      notificationStore.success(`Matched demo: ${match.id}`)
      demoSearchOpen.value = false
      return
    }
  }
  // No automatic match — let the admin search and pick.
  demoQuery.value = base
  demoSearchOpen.value = true
}

const filteredDemos = computed(() => {
  const list = demos.value.filter(d => d.pdf)
  const q = demoQuery.value.trim().toLowerCase()
  const matches = q
    ? list.filter(d =>
        (d.id || '').toLowerCase().includes(q) ||
        (d.title || d.description || '').toLowerCase().includes(q))
    : list
  return matches.slice(0, 50)
})

function selectDemo(d) {
  editForm.value.manuscriptId = d.id
  demoSearchOpen.value = false
  demoQuery.value = ''
}

function closeModal() {
  emit('close')
}

async function saveMetadata() {
  if (!props.submission?.id) return

  saving.value = true
  const newDas = editForm.value.dataAvailabilityStatement || ''
  const dasChanged = newDas !== (originalDas.value || '')
  try {
    await submissionStore.updateSubmission(props.submission.id, {
      title: editForm.value.title,
      manuscriptId: editForm.value.manuscriptId || null,
      dataAvailabilityStatement: editForm.value.dataAvailabilityStatement,
      notes: editForm.value.notes || null
    })
    notificationStore.success('Metadata updated successfully')
    // Second arg lets listeners (e.g. SubmissionHeader) decide whether to
    // advance pdf_analysis: only when the DAS was actually changed.
    emit('saved', props.submission, { dasChanged, das: newDas })
    closeModal()
  } catch (error) {
    // Show detailed validation errors if available
    const details = error.response?.data?.details
    if (details && details.length > 0) {
      const errorMessages = details.map(d => `${d.field}: ${d.message}`).join('\n')
      notificationStore.error(`Validation error:\n${errorMessages}`)
    } else {
      notificationStore.error(error.response?.data?.error || 'Failed to update metadata')
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="show"
      class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
      @click.self="closeModal"
    >
      <div class="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div class="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h3 class="text-lg font-medium">Edit Submission Metadata</h3>
          <button class="text-gray-400 hover:text-gray-600" @click="closeModal">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="px-6 py-4 overflow-y-auto flex-1 space-y-4">
          <!-- Title -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              Title <span class="text-red-500">*</span>
            </label>
            <input
              v-model="editForm.title"
              type="text"
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              placeholder="Submission title"
            />
          </div>

          <!-- Manuscript ID -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              Manuscript ID
            </label>
            <input
              v-model="editForm.manuscriptId"
              type="text"
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              placeholder="e.g., XX1-000000-001-org-X-1"
            />
            <p class="text-xs text-gray-500 mt-1">Format: XX#-######-###-org-X-# (project auto-extracted from first 2 letters)</p>

            <!-- Admin-only: auto-fill the Manuscript ID from a matching demo -->
            <div v-if="isAdmin" class="mt-2">
              <button
                type="button"
                class="inline-flex items-center text-xs font-medium text-primary-600 hover:text-primary-700 disabled:opacity-50"
                :disabled="demoLoading"
                @click="findDemoManuscriptId"
              >
                <svg class="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
                </svg>
                {{ demoLoading ? 'Searching demos…' : 'Find from demo' }}
              </button>

              <div v-if="demoSearchOpen" class="mt-2 border border-gray-200 rounded-md p-2 bg-gray-50">
                <input
                  v-model="demoQuery"
                  type="text"
                  placeholder="Search demo manuscript ID…"
                  class="w-full px-2 py-1 text-sm border border-gray-300 rounded mb-2 focus:outline-none focus:ring-1 focus:ring-primary-500"
                />
                <ul class="max-h-40 overflow-y-auto divide-y divide-gray-100 bg-white rounded border border-gray-100">
                  <li v-for="d in filteredDemos" :key="d.id">
                    <button
                      type="button"
                      class="w-full text-left px-2 py-1.5 text-xs hover:bg-primary-50"
                      @click="selectDemo(d)"
                    >
                      <span class="font-mono text-primary-700">{{ d.id }}</span>
                      <span v-if="d.title && d.title !== d.id" class="text-gray-500"> — {{ d.title }}</span>
                    </button>
                  </li>
                  <li v-if="filteredDemos.length === 0" class="px-2 py-1.5 text-xs text-gray-400">
                    No matching demos
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <!-- Data Availability Statement -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              Data Availability Statement
            </label>
            <textarea
              v-model="editForm.dataAvailabilityStatement"
              rows="4"
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-vertical"
              placeholder="Describe how and where the data will be made available..."
            ></textarea>
          </div>

          <!-- Notes -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              Notes
            </label>
            <textarea
              v-model="editForm.notes"
              rows="3"
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-vertical"
              placeholder="Optional notes about this submission..."
            ></textarea>
          </div>

          <!-- Owner reassignment (staff only) -->
          <div v-if="canReassign" class="pt-4 border-t border-gray-200">
            <label class="block text-sm font-medium text-gray-700 mb-1">
              Owner
            </label>
            <p class="text-xs text-gray-500 mb-2">
              Current owner:
              <span class="font-medium text-gray-700">
                {{ currentOwner ? (currentOwner.name || currentOwner.email) : 'Unknown' }}
              </span>.
              Reassign to hand this document to the correct user — they and their teammates will then see it.
            </p>
            <div class="flex items-center space-x-2">
              <select
                v-model="selectedOwnerId"
                :disabled="usersLoading || reassigning"
                class="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              >
                <option value="" disabled>{{ usersLoading ? 'Loading users…' : 'Select a user…' }}</option>
                <option v-for="u in users" :key="u.id" :value="u.id">
                  {{ u.name ? `${u.name} (${u.email})` : u.email }}<span v-if="u.role"> — {{ u.role }}</span>
                </option>
              </select>
              <button
                type="button"
                class="btn-secondary whitespace-nowrap"
                :disabled="reassigning || usersLoading || !selectedOwnerId || selectedOwnerId === submission.userId"
                @click="reassignOwner"
              >
                {{ reassigning ? 'Reassigning…' : 'Reassign' }}
              </button>
            </div>
          </div>
        </div>

        <div class="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end space-x-3">
          <button
            class="btn-secondary"
            :disabled="saving"
            @click="closeModal"
          >
            Cancel
          </button>
          <button
            class="btn-primary"
            :disabled="saving || !editForm.title"
            @click="saveMetadata"
          >
            <span v-if="saving">Saving...</span>
            <span v-else>Save Changes</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
