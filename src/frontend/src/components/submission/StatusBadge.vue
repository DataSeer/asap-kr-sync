<script setup>
import { computed } from 'vue'

const props = defineProps({
  status: {
    type: String,
    required: true
  },
  round: {
    type: Number,
    default: null
  }
})

const statusConfig = {
  draft: { label: 'Draft', class: 'badge-gray' },
  step_krt: { label: 'KRT', class: 'badge-primary' },
  step_pdf: { label: 'PDF', class: 'badge-primary' },
  step_review: { label: 'Review', class: 'badge-primary' },
  step_as: { label: 'Availability', class: 'badge-primary' },
  step_report: { label: 'Report', class: 'badge-primary' },
  completed: { label: 'Completed', class: 'badge-success' }
}

const config = computed(() => statusConfig[props.status] || { label: props.status, class: 'badge-gray' })
</script>

<template>
  <span class="inline-flex items-center gap-1">
    <span :class="config.class">{{ config.label }}</span>
    <span v-if="round && round > 1" class="badge badge-secondary text-xs">R{{ round }}</span>
  </span>
</template>
