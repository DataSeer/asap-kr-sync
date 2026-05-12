<script setup>
import { computed } from 'vue'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  submission: {
    type: Object,
    default: null
  },
  loading: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['close', 'confirm'])

const title = computed(() => {
  if (!props.submission) return ''
  const t = props.submission.title || 'Untitled'
  return t.length > 50 ? t.substring(0, 50) + '...' : t
})
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="fixed inset-0 z-50 flex items-center justify-center">
      <!-- Backdrop -->
      <div class="fixed inset-0 bg-black/50" @click="!loading && emit('close')"></div>

      <!-- Modal -->
      <div class="relative bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
        <div class="p-6">
          <!-- Warning icon -->
          <div class="flex items-center justify-center w-12 h-12 mx-auto mb-4 rounded-full bg-red-100">
            <svg class="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>

          <!-- Title -->
          <h3 class="text-lg font-semibold text-gray-900 text-center mb-2">
            Delete Submission
          </h3>

          <!-- Message -->
          <p class="text-sm text-gray-600 text-center mb-2">
            Are you sure you want to permanently delete this submission?
          </p>
          <p class="text-sm font-medium text-gray-900 text-center mb-4 px-4 py-2 bg-gray-50 rounded">
            "{{ title }}"
          </p>
          <p class="text-xs text-red-600 text-center">
            This action cannot be undone. All associated files and data will be permanently removed.
          </p>

          <!-- Actions -->
          <div class="flex justify-end space-x-3 mt-6">
            <button
              type="button"
              class="btn-secondary"
              :disabled="loading"
              @click="emit('close')"
            >
              Cancel
            </button>
            <button
              type="button"
              class="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="loading"
              @click="emit('confirm')"
            >
              <span v-if="loading">Deleting...</span>
              <span v-else>Delete</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
