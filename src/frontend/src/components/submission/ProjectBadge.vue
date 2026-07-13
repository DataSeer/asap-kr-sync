<script setup>
defineProps({
  project: {
    type: String,
    required: true
  }
})
</script>

<template>
  <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-primary-100 text-primary-800">
    {{ project }}
  </span>
</template>
