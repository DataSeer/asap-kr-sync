<script setup>
import { computed } from 'vue'

const props = defineProps({
  currentStep: {
    type: Number,
    required: true,
    default: 1
  },
  totalSteps: {
    type: Number,
    default: 5
  },
  isComplete: {
    type: Boolean,
    default: false
  }
})

const steps = computed(() => {
  return Array.from({ length: props.totalSteps }, (_, i) => ({
    number: i + 1,
    // If submission is complete, all steps are completed
    isCompleted: props.isComplete || i + 1 < props.currentStep,
    // If submission is complete, no step is "current" (all are done)
    isCurrent: !props.isComplete && i + 1 === props.currentStep
  }))
})

const stepLabels = ['Key Resources Table', 'Manuscript', 'Approve', 'Edit', 'Report']
</script>

<template>
  <div class="flex items-center">
    <template v-for="(step, index) in steps" :key="step.number">
      <div class="flex items-center">
        <div
          class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium"
          :class="{
            'bg-primary-600 text-white': step.isCurrent,
            'bg-green-500 text-white': step.isCompleted,
            'bg-gray-200 text-gray-500': !step.isCurrent && !step.isCompleted
          }"
        >
          <span v-if="step.isCompleted">
            <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
            </svg>
          </span>
          <span v-else>{{ step.number }}</span>
        </div>
        <span class="ml-1 text-xs text-gray-500 hidden sm:inline">{{ stepLabels[index] }}</span>
      </div>
      <div
        v-if="index < steps.length - 1"
        class="w-6 sm:w-8 h-0.5 mx-1"
        :class="step.isCompleted ? 'bg-green-500' : 'bg-gray-200'"
      />
    </template>
  </div>
</template>
