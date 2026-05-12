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
import { ref, watch } from 'vue'
import { useSubmissionStore } from '@/stores/submission.store'
import { useNotificationStore } from '@/stores/notification.store'

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

const saving = ref(false)
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
  }
}, { immediate: true })

function closeModal() {
  emit('close')
}

async function saveMetadata() {
  if (!props.submission?.id) return

  saving.value = true
  try {
    await submissionStore.updateSubmission(props.submission.id, {
      title: editForm.value.title,
      manuscriptId: editForm.value.manuscriptId || null,
      dataAvailabilityStatement: editForm.value.dataAvailabilityStatement,
      notes: editForm.value.notes || null
    })
    notificationStore.success('Metadata updated successfully')
    emit('saved', props.submission)
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
            <p class="text-xs text-gray-500 mt-1">Format: XX#-######-###-org-X-# (team auto-extracted from first 2 letters)</p>
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
