<script setup>
/**
 * What a page shows when it could not load.
 *
 * The alternative is what these views used to do: let the fetch reject, abort
 * the rest of the mount chain, and render the empty state as though it were the
 * answer — "No PDF file is associated with this submission", "No changes have
 * been made to this KRT", a green "Submission Complete!". A 403 or a 500 then
 * reads as a fact about the manuscript rather than a failure to fetch it, and
 * the user has no reason to retry.
 */

defineProps({
  /** What could not be loaded, in the user's terms. */
  title: { type: String, default: 'This page could not be loaded' },
  /** The server's message, when there is a usable one. */
  message: { type: String, default: '' },
  /** Hide the retry button for errors retrying cannot fix (e.g. 403). */
  retryable: { type: Boolean, default: true }
})

defineEmits(['retry'])
</script>

<template>
  <div class="load-error">
    <svg class="w-6 h-6 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
    </svg>
    <div class="flex-1">
      <p class="load-error-title">{{ title }}</p>
      <p v-if="message" class="load-error-message">{{ message }}</p>
      <p class="load-error-note">
        Nothing below is a reading of your submission — the page never received it.
      </p>
      <button v-if="retryable" type="button" class="btn-secondary mt-3" @click="$emit('retry')">
        Try again
      </button>
    </div>
  </div>
</template>

<style scoped>
.load-error {
  @apply flex items-start gap-3 p-4 mb-4 rounded-lg border border-red-200 bg-red-50 text-red-800;
}
.load-error-title {
  @apply text-sm font-semibold;
}
.load-error-message {
  @apply text-sm mt-0.5;
}
.load-error-note {
  @apply text-xs mt-1 text-red-700;
}
</style>
