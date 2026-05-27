<script setup>
import { ref, onMounted, computed } from 'vue'
import { useAppConfigStore } from '@/stores/appConfig.store'
import { useNotificationStore } from '@/stores/notification.store'

const appConfigStore = useAppConfigStore()
const notificationStore = useNotificationStore()

const loading = ref(true)
const saving = ref(false)

/** KRT column definitions with their configurable rule options */
const columnDefinitions = [
  {
    key: 'RESOURCE TYPE',
    icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
    description: 'Categorizes the resource (e.g. Dataset, Antibody, Software/code).',
    rules: ['required', 'allowNA']
  },
  {
    key: 'RESOURCE NAME',
    icon: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z',
    description: 'The name of the resource being listed.',
    rules: ['required', 'allowNA', 'maxLength']
  },
  {
    key: 'SOURCE',
    icon: 'M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9',
    description: 'Where the resource can be obtained (e.g. Zenodo, GitHub, ATCC).',
    rules: ['required']
  },
  {
    key: 'IDENTIFIER',
    icon: 'M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0',
    description: 'Unique identifier such as DOI, RRID, URL, or catalog number.',
    rules: ['required', 'allowNA']
  },
  {
    key: 'NEW/REUSE',
    icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
    description: 'Whether the resource is new to this publication or reused.',
    rules: ['required', 'allowNA', 'allowedValues']
  },
  {
    key: 'ADDITIONAL INFORMATION',
    icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    description: 'Any supplementary details about the resource.',
    rules: ['maxLength']
  }
]

/** Default rule values per column */
const defaultRules = {
  'RESOURCE TYPE': { required: true, allowNA: false, severity: 'error' },
  'RESOURCE NAME': { required: true, allowNA: false, maxLength: 500, severity: 'error' },
  'SOURCE': { required: true, severity: 'error' },
  'IDENTIFIER': { required: true, allowNA: false, severity: 'error' },
  'NEW/REUSE': { required: true, allowNA: false, allowedValues: ['new', 'reuse'], severity: 'error' },
  'ADDITIONAL INFORMATION': { maxLength: 0, severity: 'warning' }
}

/** Current rules state, loaded from DB or defaults */
const rules = ref({})

/** Track which cards are expanded */
const expandedCards = ref({})

onMounted(async () => {
  await loadRules()
  // Expand all cards by default
  for (const col of columnDefinitions) {
    expandedCards.value[col.key] = true
  }
})

async function loadRules() {
  loading.value = true
  try {
    await appConfigStore.fetchConfigs({ limit: 100 })
    const validationConfig = appConfigStore.configs.find(c => c.key === 'validation_rules')
    const stored = validationConfig?.value || {}

    // Merge stored rules with defaults
    const merged = {}
    for (const col of columnDefinitions) {
      merged[col.key] = { ...defaultRules[col.key], ...(stored[col.key] || {}) }
    }
    rules.value = merged
  } catch (error) {
    notificationStore.error('Failed to load validation rules')
  } finally {
    loading.value = false
  }
}

async function saveRules() {
  saving.value = true
  try {
    await appConfigStore.saveConfig({
      key: 'validation_rules',
      value: rules.value,
      description: 'KRT column validation rules',
      category: 'krt'
    })
    notificationStore.success('Validation rules saved')
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to save validation rules')
  } finally {
    saving.value = false
  }
}

async function resetToDefaults() {
  if (!confirm('Reset all validation rules to their defaults?')) return
  rules.value = JSON.parse(JSON.stringify(defaultRules))
  await saveRules()
}

function toggleCard(key) {
  expandedCards.value[key] = !expandedCards.value[key]
}

function addAllowedValue(columnKey) {
  const val = prompt('Enter new allowed value:')
  if (val && val.trim()) {
    const trimmed = val.trim().toLowerCase()
    if (!rules.value[columnKey].allowedValues.includes(trimmed)) {
      rules.value[columnKey].allowedValues.push(trimmed)
    }
  }
}

function removeAllowedValue(columnKey, index) {
  rules.value[columnKey].allowedValues.splice(index, 1)
}

const hasChanges = computed(() => {
  // Simple deep comparison with stored config
  const stored = appConfigStore.configs.find(c => c.key === 'validation_rules')
  if (!stored) return true
  return JSON.stringify(rules.value) !== JSON.stringify(stored.value)
})

/** Rule labels for display */
const ruleLabels = {
  required: 'Required',
  allowNA: 'Allow N/A values',
  maxLength: 'Max length',
  allowedValues: 'Allowed values',
  severity: 'Severity'
}
</script>

<template>
  <div class="validation-rules-page">
    <!-- Header -->
    <div class="page-header">
      <div>
        <h1 class="page-title">Validation Rules</h1>
        <p class="page-description">
          Configure how each KRT column header is validated when a submission is processed.
        </p>
      </div>
      <div class="header-actions">
        <button class="btn-secondary" :disabled="saving" @click="resetToDefaults">
          Reset to Defaults
        </button>
        <button class="btn-primary" :disabled="saving || !hasChanges" @click="saveRules">
          {{ saving ? 'Saving...' : 'Save Changes' }}
        </button>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="loading-container">
      <svg class="animate-spin h-8 w-8 text-primary-600" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
    </div>

    <!-- Column Cards -->
    <div v-else class="columns-grid">
      <div
        v-for="col in columnDefinitions"
        :key="col.key"
        class="column-card"
      >
        <!-- Card Header -->
        <button class="column-card-header" @click="toggleCard(col.key)">
          <div class="column-card-title-row">
            <svg class="column-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="col.icon" />
            </svg>
            <h3 class="column-name">{{ col.key }}</h3>
          </div>
          <svg
            class="chevron-icon"
            :class="{ rotated: expandedCards[col.key] }"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        <p class="column-description">{{ col.description }}</p>

        <!-- Card Body -->
        <div v-show="expandedCards[col.key]" class="column-card-body">
          <!-- Required toggle -->
          <div v-if="col.rules.includes('required')" class="rule-row">
            <div class="rule-info">
              <span class="rule-label">{{ ruleLabels.required }}</span>
              <span class="rule-hint">Row fails validation if this column is empty.</span>
            </div>
            <label class="toggle">
              <input v-model="rules[col.key].required" type="checkbox" />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <!-- Allow N/A toggle -->
          <div v-if="col.rules.includes('allowNA')" class="rule-row">
            <div class="rule-info">
              <span class="rule-label">{{ ruleLabels.allowNA }}</span>
              <span class="rule-hint">Accept "N/A", "n/a", "not applicable", etc.</span>
            </div>
            <label class="toggle">
              <input v-model="rules[col.key].allowNA" type="checkbox" />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <!-- Max length -->
          <div v-if="col.rules.includes('maxLength')" class="rule-row">
            <div class="rule-info">
              <span class="rule-label">{{ ruleLabels.maxLength }}</span>
              <span class="rule-hint">Maximum character count (0 = unlimited).</span>
            </div>
            <input
              v-model.number="rules[col.key].maxLength"
              type="number"
              min="0"
              class="rule-input-number"
            />
          </div>

          <!-- Allowed values -->
          <div v-if="col.rules.includes('allowedValues')" class="rule-row rule-row-block">
            <div class="rule-info">
              <span class="rule-label">{{ ruleLabels.allowedValues }}</span>
              <span class="rule-hint">Only these values are accepted (case-insensitive).</span>
            </div>
            <div class="allowed-values">
              <span
                v-for="(val, idx) in rules[col.key].allowedValues"
                :key="idx"
                class="value-tag"
              >
                {{ val }}
                <button class="value-tag-remove" @click="removeAllowedValue(col.key, idx)">&times;</button>
              </span>
              <button class="value-tag add-tag" @click="addAllowedValue(col.key)">+ Add</button>
            </div>
          </div>

          <!-- Severity -->
          <div class="rule-row">
            <div class="rule-info">
              <span class="rule-label">{{ ruleLabels.severity }}</span>
              <span class="rule-hint">How violations are reported.</span>
            </div>
            <select v-model="rules[col.key].severity" class="rule-select">
              <option value="error">Error (blocks submission)</option>
              <option value="warning">Warning (allows submission)</option>
              <option value="info">Info (informational only)</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.validation-rules-page {
  max-width: 56rem;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 1.5rem;
  gap: 1rem;
}

.page-title {
  font-size: 1.5rem;
  font-weight: 700;
  color: #111827;
}

.page-description {
  font-size: 0.875rem;
  color: #6b7280;
  margin-top: 0.25rem;
}

.header-actions {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
}

.loading-container {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3rem 0;
}

/* Column cards grid */
.columns-grid {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.column-card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  overflow: hidden;
}

.column-card-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.875rem 1rem 0;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
}

.column-card-title-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.column-icon {
  width: 1.25rem;
  height: 1.25rem;
  color: #6366f1;
  flex-shrink: 0;
}

.column-name {
  font-size: 0.9375rem;
  font-weight: 600;
  color: #111827;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.column-description {
  font-size: 0.8125rem;
  color: #6b7280;
  padding: 0.25rem 1rem 0.75rem 2.75rem;
}

.chevron-icon {
  width: 1.25rem;
  height: 1.25rem;
  color: #9ca3af;
  transition: transform 0.2s ease;
  flex-shrink: 0;
}

.chevron-icon.rotated {
  transform: rotate(180deg);
}

/* Card body */
.column-card-body {
  border-top: 1px solid #f3f4f6;
  padding: 0.5rem 0;
}

.rule-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.625rem 1rem;
  gap: 1rem;
}

.rule-row-block {
  flex-direction: column;
  align-items: flex-start;
}

.rule-info {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}

.rule-label {
  font-size: 0.8125rem;
  font-weight: 500;
  color: #374151;
}

.rule-hint {
  font-size: 0.75rem;
  color: #9ca3af;
}

/* Toggle switch */
.toggle {
  position: relative;
  display: inline-block;
  width: 2.5rem;
  height: 1.375rem;
  flex-shrink: 0;
}

.toggle input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: #d1d5db;
  border-radius: 999px;
  transition: background-color 0.2s;
}

.toggle-slider::before {
  content: '';
  position: absolute;
  height: 1rem;
  width: 1rem;
  left: 0.1875rem;
  bottom: 0.1875rem;
  background-color: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
}

.toggle input:checked + .toggle-slider {
  background-color: #6366f1;
}

.toggle input:checked + .toggle-slider::before {
  transform: translateX(1.125rem);
}

/* Number input */
.rule-input-number {
  width: 6rem;
  padding: 0.375rem 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  font-size: 0.8125rem;
  color: #374151;
  text-align: right;
  flex-shrink: 0;
}

.rule-input-number:focus {
  outline: none;
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}

/* Select */
.rule-select {
  padding: 0.375rem 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  font-size: 0.8125rem;
  color: #374151;
  background: #fff;
  flex-shrink: 0;
}

.rule-select:focus {
  outline: none;
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}

/* Allowed values tags */
.allowed-values {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  margin-top: 0.375rem;
}

.value-tag {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  background: #eef2ff;
  color: #4338ca;
  border-radius: 0.25rem;
  font-size: 0.8125rem;
  font-weight: 500;
}

.value-tag-remove {
  background: none;
  border: none;
  cursor: pointer;
  color: #6366f1;
  font-size: 1rem;
  line-height: 1;
  padding: 0 0.125rem;
}

.value-tag-remove:hover {
  color: #dc2626;
}

.add-tag {
  background: #f9fafb;
  color: #6b7280;
  border: 1px dashed #d1d5db;
  cursor: pointer;
  font-weight: 400;
}

.add-tag:hover {
  background: #f3f4f6;
  color: #374151;
}
</style>
