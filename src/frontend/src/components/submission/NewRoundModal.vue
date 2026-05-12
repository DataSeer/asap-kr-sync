<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  loading: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['close', 'submit'])

const hasNewKRT = ref(false)

// Reset when modal opens
watch(() => props.show, (val) => {
  if (val) {
    hasNewKRT.value = false
  }
})

function handleSubmit() {
  emit('submit', {
    hasNewKRT: hasNewKRT.value
  })
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="fixed inset-0 z-50 flex items-center justify-center">
      <!-- Backdrop -->
      <div class="fixed inset-0 bg-black/50" @click="emit('close')"></div>

      <!-- Modal -->
      <div class="relative bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div class="p-6">
          <h2 class="text-lg font-semibold text-gray-900 mb-4">Process New Version</h2>
          <p class="text-sm text-gray-600 mb-6">
            Start a new version for this article. A new PDF is required. The Data Availability Statement will be automatically re-extracted from the new PDF.
          </p>

          <form class="space-y-4" @submit.prevent="handleSubmit">
            <!-- New KRT toggle -->
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-2">
                Do you have a new KRT file?
              </label>
              <div class="flex items-center space-x-4">
                <label class="flex items-center cursor-pointer">
                  <input
                    v-model="hasNewKRT"
                    type="radio"
                    :value="false"
                    class="mr-2 text-primary-600 focus:ring-primary-500"
                  />
                  <span class="text-sm text-gray-700">No, keep current KRT</span>
                </label>
                <label class="flex items-center cursor-pointer">
                  <input
                    v-model="hasNewKRT"
                    type="radio"
                    :value="true"
                    class="mr-2 text-primary-600 focus:ring-primary-500"
                  />
                  <span class="text-sm text-gray-700">Yes, upload new KRT</span>
                </label>
              </div>
              <p class="mt-1 text-xs text-gray-500">
                {{ hasNewKRT
                  ? 'You will be redirected to the KRT upload step.'
                  : 'The current KRT data will be carried forward. You will be redirected to the PDF upload step.'
                }}
              </p>
            </div>

            <!-- Actions -->
            <div class="flex justify-end space-x-3 pt-4 border-t">
              <button
                type="button"
                class="btn-secondary"
                :disabled="loading"
                @click="emit('close')"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="btn-primary"
                :disabled="loading"
              >
                <span v-if="loading">Processing...</span>
                <span v-else>Start New Version</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  </Teleport>
</template>
