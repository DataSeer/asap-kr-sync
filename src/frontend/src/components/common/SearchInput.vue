<script setup>
/**
 * SearchInput — shared search box (magnifier icon + "Search…" placeholder).
 * Used both for client-side in-table filtering and server-side filter inputs.
 *
 * @example
 * <SearchInput v-model="search" />
 * <SearchInput v-model="search" full-width placeholder="Search users…" />
 */
defineProps({
  modelValue: {
    type: String,
    default: ''
  },
  placeholder: {
    type: String,
    default: 'Search…'
  },
  fullWidth: {
    type: Boolean,
    default: false
  }
})

defineEmits(['update:modelValue'])
</script>

<template>
  <div :class="['relative', fullWidth ? 'w-full' : 'w-64 max-w-full']">
    <span class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
      </svg>
    </span>
    <input
      :value="modelValue"
      type="text"
      :placeholder="placeholder"
      class="input w-full pl-9"
      @input="$emit('update:modelValue', $event.target.value)"
    />
    <button
      v-if="modelValue"
      type="button"
      class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
      title="Clear"
      @click="$emit('update:modelValue', '')"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </div>
</template>
