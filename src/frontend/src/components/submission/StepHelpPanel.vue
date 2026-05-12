<script setup>
/**
 * StepHelpPanel - Collapsible inline help checklist for submission workflow steps
 *
 * Renders a numbered checklist of help items with live done/not-done status.
 * A step can only be checked if all previous steps are checked (sequential).
 *
 * @component
 */
import { computed } from 'vue'

const props = defineProps({
  /** Array of help items: [{ title: string, description: string, done: boolean }] */
  items: {
    type: Array,
    required: true
  }
})

const emit = defineEmits(['close'])

/** Compute effective done state: a step is only done if itself AND all previous steps are done */
const effectiveItems = computed(() => {
  let allPreviousDone = true
  return props.items.map(item => {
    const effectiveDone = allPreviousDone && item.done
    if (!effectiveDone) allPreviousDone = false
    return { ...item, done: effectiveDone }
  })
})
</script>

<template>
  <div class="help-panel">
    <div class="help-panel-inner">
      <button class="help-close-btn" title="Close help" @click="emit('close')">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
      <ol class="help-list">
        <li
          v-for="(item, index) in effectiveItems"
          :key="index"
          class="help-item"
          :class="{ 'help-item-done': item.done }"
        >
          <span class="help-number" :class="item.done ? 'help-number-done' : 'help-number-pending'">
            <svg v-if="item.done" class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
            </svg>
            <span v-else class="help-bullet"></span>
          </span>
          <div class="help-content">
            <span class="help-title" :class="{ 'help-title-done': item.done }">{{ item.title }}</span>
            <span v-if="item.description" class="help-description">{{ item.description }}</span>
            <ul v-if="item.children && item.children.length" class="help-children">
              <li v-for="(child, ci) in item.children" :key="ci" class="help-child">
                <span class="help-child-bullet"></span>
                <span class="help-child-text" :class="{ 'help-title-done': item.done }">{{ child }}</span>
              </li>
            </ul>
          </div>
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.help-panel {
  margin-top: 0.75rem;
  border-left: 3px solid #93c5fd;
  background: #eff6ff;
  border-radius: 0 0.5rem 0.5rem 0;
  overflow: hidden;
}

.help-panel-inner {
  position: relative;
  padding: 0.75rem 2rem 0.75rem 1rem;
}

.help-close-btn {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  color: #6b7280;
  background: none;
  border: none;
  border-radius: 0.25rem;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}

.help-close-btn:hover {
  color: #374151;
  background: rgba(0, 0, 0, 0.05);
}

.help-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.help-item {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
}

.help-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.375rem;
  height: 1.375rem;
  border-radius: 50%;
  font-size: 0.7rem;
  font-weight: 600;
  flex-shrink: 0;
  margin-top: 0.0625rem;
}

.help-number-pending {
  background: #dbeafe;
  color: #1e40af;
}

.help-bullet {
  display: block;
  width: 0.375rem;
  height: 0.375rem;
  border-radius: 50%;
  background: #1e40af;
}

.help-number-done {
  background: #d1fae5;
  color: #059669;
}

.help-content {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}

.help-title {
  font-size: 0.8125rem;
  font-weight: 500;
  color: #1e3a5f;
}

.help-title-done {
  color: #6b7280;
  text-decoration: line-through;
}

.help-description {
  font-size: 0.75rem;
  color: #6b7280;
  line-height: 1.4;
}

.help-item-done .help-description {
  color: #9ca3af;
}

.help-children {
  list-style: none;
  margin: 0.25rem 0 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.help-child {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}

.help-child-bullet {
  display: block;
  width: 0.3rem;
  height: 0.3rem;
  border-radius: 50%;
  background: #93a3b8;
  flex-shrink: 0;
  margin-top: 0.35rem;
}

.help-child-text {
  font-size: 0.75rem;
  color: #6b7280;
  line-height: 1.4;
}
</style>
