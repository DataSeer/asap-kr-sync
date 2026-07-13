<script setup>
/**
 * SubmissionCard - Card component displaying submission summary with actions
 *
 * @component
 */
import { ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth.store'
import StatusBadge from './StatusBadge.vue'
import ProjectBadge from './ProjectBadge.vue'
import StepIndicator from './StepIndicator.vue'
import EditMetadataModal from './EditMetadataModal.vue'
import { statusToStep } from '@/utils/submission'

const props = defineProps({
  /** The submission object to display */
  submission: {
    type: Object,
    required: true
  },
  /** Whether to show action buttons */
  showActions: {
    type: Boolean,
    default: true
  },
  /** Whether this card is in the hidden submissions section */
  isHidden: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['click', 'hide', 'unhide', 'delete', 'updated'])

const authStore = useAuthStore()

const canDelete = computed(() => authStore.canDeleteSubmission)
const canEdit = computed(() => authStore.canEditSubmission(props.submission))
const isComplete = computed(() => props.submission.status === 'completed')

const formattedDate = computed(() => {
  const date = new Date(props.submission.createdAt)
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
})

// Edit modal state
const showEditModal = ref(false)

function handleHide(event) {
  event.stopPropagation()
  emit('hide', props.submission)
}

function handleUnhide(event) {
  event.stopPropagation()
  emit('unhide', props.submission)
}

function handleDelete(event) {
  event.stopPropagation()
  emit('delete', props.submission)
}

function handleEdit(event) {
  event.stopPropagation()
  showEditModal.value = true
}

function handleMetadataSaved() {
  emit('updated', props.submission)
}
</script>

<template>
  <div
    class="card cursor-pointer hover:shadow-md transition-shadow relative"
    @click="emit('click')"
  >
    <!-- Badges in top right corner: Version on top, Team below -->
    <div class="absolute top-3 right-3 flex flex-col items-end gap-1">
      <!-- Version badge (always shown) -->
      <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-blue-100 text-blue-700 border border-blue-300">
        v{{ submission.currentRound || 1 }}
      </span>
      <!-- Team badge -->
      <ProjectBadge v-if="submission.project" :project="submission.project" />
    </div>

    <div class="flex items-start justify-between mb-4">
      <div class="flex-1 min-w-0 pr-16">
        <h3 class="text-lg font-medium text-gray-900 truncate">
          {{ submission.title }}
        </h3>
        <p v-if="submission.manuscriptId" class="text-sm text-gray-500 truncate h-5">
          {{ submission.manuscriptId }}
        </p>
        <span v-else class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-500 h-5">
          Missing Manuscript ID
        </span>
      </div>
    </div>

    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <StatusBadge :status="submission.status" />
        <span class="text-xs text-gray-400">{{ formattedDate }}</span>
      </div>

      <StepIndicator :current-step="statusToStep(submission.status)" :is-complete="isComplete" />

      <div class="flex items-center justify-between">
        <div class="text-sm text-gray-500 h-5">
          {{ submission.user ? `By ${submission.user.name}` : '' }}
        </div>

        <!-- Action buttons -->
        <div v-if="showActions" class="flex items-center space-x-2">
          <!-- Edit button (own submission for authors, team for PMs, all for staff) -->
          <button
            v-if="canEdit"
            class="p-1 text-gray-400 hover:text-primary-600 transition-colors"
            title="Edit metadata"
            @click="handleEdit"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </button>

          <!-- Hide/Unhide button -->
          <button
            v-if="isHidden"
            class="p-1 text-gray-400 hover:text-primary-600 transition-colors"
            title="Unhide submission"
            @click="handleUnhide"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </button>
          <button
            v-else
            class="p-1 text-gray-400 hover:text-gray-600 transition-colors"
            title="Hide submission"
            @click="handleHide"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
            </svg>
          </button>

          <!-- Delete button (admin/ds_annotator only) -->
          <button
            v-if="canDelete"
            class="p-1 text-gray-400 hover:text-red-600 transition-colors"
            title="Delete submission"
            @click="handleDelete"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Edit Metadata Modal -->
    <EditMetadataModal
      :show="showEditModal"
      :submission="submission"
      @close="showEditModal = false"
      @saved="handleMetadataSaved"
    />
  </div>
</template>
