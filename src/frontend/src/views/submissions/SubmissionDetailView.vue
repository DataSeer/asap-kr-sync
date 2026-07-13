<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSubmissionStore } from '@/stores/submission.store'
import { useNotificationStore } from '@/stores/notification.store'
import { setSubmissionTitle } from '@/router'
import StatusBadge from '@/components/submission/StatusBadge.vue'
import ProjectBadge from '@/components/submission/ProjectBadge.vue'
import StepIndicator from '@/components/submission/StepIndicator.vue'
import { statusToStep } from '@/utils/submission'

const route = useRoute()
const router = useRouter()
const submissionStore = useSubmissionStore()
const notificationStore = useNotificationStore()

const loading = ref(true)
const submission = computed(() => submissionStore.currentSubmission)
const isComplete = computed(() => submission.value?.status === 'completed')

// Map steps to route names
const stepRoutes = {
  1: 'submission-krt',
  2: 'submission-pdf',
  3: 'submission-review',
  4: 'submission-availability',
  5: 'submission-report'
}

onMounted(async () => {
  try {
    await submissionStore.fetchSubmission(route.params.id)
    // Auto-redirect to current step
    if (submission.value) {
      navigateToCurrentStep()
    }
  } catch (error) {
    notificationStore.error('Failed to load submission')
    router.push({ name: 'dashboard' })
  } finally {
    loading.value = false
  }
})

// Update page title with submission ID or title
watch(submission, (sub) => {
  if (sub) {
    setSubmissionTitle(sub.title || sub.manuscriptId)
  }
}, { immediate: true })

const currentStep = computed(() => statusToStep(submission.value?.status))

function navigateToCurrentStep() {
  router.replace({ name: stepRoutes[currentStep.value], params: { id: route.params.id } })
}

function navigateToStep(step) {
  // Only allow navigation to current or previous steps
  if (step > currentStep.value) return
  router.push({ name: stepRoutes[step], params: { id: route.params.id } })
}

function getStepStatus(step) {
  if (!submission.value) return 'pending'
  if (submission.value.status === 'completed') return 'completed'
  if (step < currentStep.value) return 'completed'
  if (step === currentStep.value) return 'current'
  return 'pending'
}
</script>

<template>
  <div v-if="loading" class="flex items-center justify-center py-12">
    <svg class="animate-spin h-8 w-8 text-primary-600" fill="none" viewBox="0 0 24 24">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
    </svg>
  </div>

  <div v-else-if="submission" class="space-y-6">
    <!-- Header -->
    <div class="card">
      <div class="flex items-start justify-between mb-4">
        <div>
          <h1 class="text-2xl font-bold text-gray-900">{{ submission.title }}</h1>
          <p v-if="submission.manuscriptId" class="text-gray-500">{{ submission.manuscriptId }}</p>
          <p v-else class="text-gray-400 italic">No manuscript ID set</p>
        </div>
        <div class="flex items-center space-x-2">
          <ProjectBadge v-if="submission.project" :project="submission.project" />
          <StatusBadge :status="submission.status" />
        </div>
      </div>

      <div class="py-4 border-t border-b">
        <StepIndicator :current-step="currentStep" :is-complete="isComplete" />
      </div>

      <!-- Continue button -->
      <div v-if="!isComplete" class="mt-4 flex justify-end">
        <button class="btn-primary" @click="navigateToCurrentStep">
          Continue to Step {{ currentStep }}
        </button>
      </div>

      <!-- Data Availability Statement -->
      <div v-if="submission.dataAvailabilityStatement" class="mt-4">
        <h3 class="text-sm font-medium text-gray-500">Data Availability Statement</h3>
        <p class="mt-1 text-gray-900 whitespace-pre-wrap">{{ submission.dataAvailabilityStatement }}</p>
      </div>

      <div v-if="submission.notes" class="mt-4">
        <h3 class="text-sm font-medium text-gray-500">Notes</h3>
        <p class="mt-1 text-gray-900">{{ submission.notes }}</p>
      </div>
    </div>

    <!-- Steps -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div
        v-for="step in 5"
        :key="step"
        class="card transition-shadow"
        :class="{
          'ring-2 ring-primary-500': getStepStatus(step) === 'current',
          'opacity-50 cursor-not-allowed': getStepStatus(step) === 'pending',
          'cursor-pointer hover:shadow-md': getStepStatus(step) !== 'pending'
        }"
        @click="navigateToStep(step)"
      >
        <div class="flex items-center justify-between">
          <div>
            <h3 class="font-medium text-gray-900">
              Step {{ step }}:
              {{ ['Upload Key Resources Table', 'Upload PDF & Analyze', 'Review Changes', 'Availability Statement', 'Generate Report'][step - 1] }}
            </h3>
            <p class="text-sm text-gray-500 mt-1">
              {{
                [
                  'Upload and validate your Key Resources Table',
                  'Upload manuscript PDF for AI analysis',
                  'Review and approve suggested changes',
                  'Review your Data/Code Availability Statement',
                  'Generate final report'
                ][step - 1]
              }}
            </p>
          </div>
          <div
            class="w-8 h-8 rounded-full flex items-center justify-center"
            :class="{
              'bg-green-100 text-green-600': getStepStatus(step) === 'completed',
              'bg-primary-100 text-primary-600': getStepStatus(step) === 'current',
              'bg-gray-100 text-gray-400': getStepStatus(step) === 'pending'
            }"
          >
            <svg v-if="getStepStatus(step) === 'completed'" class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
            </svg>
            <span v-else class="text-sm font-medium">{{ step }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
