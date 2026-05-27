<script setup>
import { ref, watch, computed } from 'vue'

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
const pdfFile = ref(null)
const pdfError = ref('')

// Reset when modal opens so reopening always starts clean.
watch(() => props.show, (val) => {
  if (val) {
    hasNewKRT.value = false
    pdfFile.value = null
    pdfError.value = ''
  }
})

const canSubmit = computed(() => !!pdfFile.value && !props.loading)

function onPdfChange(event) {
  const f = event.target.files?.[0] || null
  pdfError.value = ''
  if (!f) { pdfFile.value = null; return }
  // Light client-side guard. Backend re-validates on upload (PDF / DOCX magic bytes).
  const ok = /\.(pdf|docx)$/i.test(f.name)
  if (!ok) {
    pdfError.value = 'Please select a PDF or DOCX file.'
    pdfFile.value = null
    return
  }
  pdfFile.value = f
}

function handleSubmit() {
  if (!pdfFile.value) {
    pdfError.value = 'A new PDF is required to start a new version.'
    return
  }
  emit('submit', {
    hasNewKRT: hasNewKRT.value,
    pdfFile: pdfFile.value
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
            Start a new version for this article. A new PDF is required; the Data Availability Statement will be re-extracted from it automatically.
          </p>

          <form class="space-y-5" @submit.prevent="handleSubmit">
            <!-- New PDF (required) -->
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-2">
                New PDF <span class="text-red-500">*</span>
              </label>
              <input
                type="file"
                accept=".pdf,.docx,application/pdf"
                class="block w-full text-sm text-gray-700 file:mr-3 file:py-2 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-primary-50 file:text-primary-700 hover:file:bg-primary-100"
                @change="onPdfChange"
              />
              <p v-if="pdfFile" class="mt-1 text-xs text-gray-600">
                Selected: <span class="font-medium">{{ pdfFile.name }}</span>
              </p>
              <p v-if="pdfError" class="mt-1 text-xs text-red-600">{{ pdfError }}</p>
              <p v-else class="mt-1 text-xs text-gray-500">
                The new PDF is uploaded immediately and analyzed in the background while you review.
              </p>
            </div>

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
                  ? 'You will land on Step 2 with a blank KRT to upload.'
                  : 'The current KRT is carried forward; you will land on Step 2 to review it.'
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
                :disabled="!canSubmit"
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
