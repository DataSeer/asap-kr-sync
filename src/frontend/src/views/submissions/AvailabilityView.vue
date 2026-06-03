<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSubmissionStore } from '@/stores/submission.store'
import { useKRTStore } from '@/stores/krt.store'
import { useNotificationStore } from '@/stores/notification.store'
import { setSubmissionTitle } from '@/router'
import SubmissionHeader from '@/components/submission/SubmissionHeader.vue'

const route = useRoute()
const router = useRouter()
const submissionStore = useSubmissionStore()
const krtStore = useKRTStore()
const notificationStore = useNotificationStore()

const submission = computed(() => submissionStore.currentSubmission)
const latestFiles = computed(() => submissionStore.latestFiles)
const krtRows = computed(() => krtStore.rows)
const asText = computed(() => submission.value?.dataAvailabilityStatement || '')
const extractedDAS = computed(() => submission.value?.extractedDataAvailabilityStatement || '')
const dasWasModified = computed(() => {
  return extractedDAS.value
    && extractedDAS.value !== 'Not found'
    && extractedDAS.value !== asText.value
})

// DAS editing
const isEditingDAS = ref(false)
const editedDAS = ref('')
const savingDAS = ref(false)

function startEditingDAS() {
  editedDAS.value = asText.value
  isEditingDAS.value = true
}

function cancelEditingDAS() {
  isEditingDAS.value = false
  editedDAS.value = ''
}

async function saveDAS() {
  savingDAS.value = true
  try {
    await submissionStore.updateSubmission(route.params.id, {
      dataAvailabilityStatement: editedDAS.value || null
    })
    isEditingDAS.value = false
    notificationStore.success('Availability Statement updated')
  } catch (error) {
    notificationStore.error('Failed to save Availability Statement')
  } finally {
    savingDAS.value = false
  }
}

// Step help items
const helpItems = computed(() => [
  {
    title: 'Review recommendations',
    children: [
      'Outside of this app, edit your manuscript to address each recommendation',
      'Confirm that each recommendation has been addressed or rejected'
    ],
    done: false
  },
  {
    title: 'Click "Continue" to generate a Key Resources Table Assist report',
    done: false
  }
])

onMounted(async () => {
  krtStore.clearKRT()
  await submissionStore.fetchSubmission(route.params.id)
  await krtStore.fetchKRT(route.params.id)
})

watch(submission, (sub) => {
  if (sub) {
    setSubmissionTitle(sub.manuscriptId || sub.title, 'Step 4: Edit manuscript')
  }
}, { immediate: true })

// Helper: check if a row's resource type matches a keyword (case-insensitive)
function rowMatchesType(row, keyword) {
  const rt = (row['RESOURCE TYPE'] || '').toLowerCase()
  return rt.includes(keyword.toLowerCase())
}

// Helper: check if a row is "new"
function isNewRow(row) {
  return (row['NEW/REUSE'] || '').toLowerCase().trim() === 'new'
}

// Resource type group detection helpers
const hasDatasetRows = computed(() => krtRows.value.some(r => rowMatchesType(r, 'dataset')))
const hasCodeRows = computed(() => krtRows.value.some(r => rowMatchesType(r, 'software') || rowMatchesType(r, 'code')))
const hasProtocolRows = computed(() => krtRows.value.some(r => rowMatchesType(r, 'protocol')))
const hasLabMaterialRows = computed(() => {
  const labKeywords = ['antibody', 'bacterial', 'biological', 'chemical', 'critical commercial', 'experimental model', 'oligonucleotide', 'recombinant', 'viral']
  return krtRows.value.some(r => labKeywords.some(kw => rowMatchesType(r, kw)))
})

const hasNewDataset = computed(() => krtRows.value.some(r => rowMatchesType(r, 'dataset') && isNewRow(r)))
const hasNewCode = computed(() => krtRows.value.some(r => (rowMatchesType(r, 'software') || rowMatchesType(r, 'code')) && isNewRow(r)))

const asLower = computed(() => asText.value.toLowerCase())

// Show all rules toggle
const showAllRules = ref(false)

// View mode: 'list' or 'carousel'
const viewMode = ref('list')

// Carousel navigation index
const currentSuggestionIndex = ref(0)

// All rules with their applicability
const allRules = computed(() => {
  const text = asLower.value
  const rules = []

  // Rule 1: No new dataset
  const rule1Applies = !hasNewDataset.value
  rules.push({
    severity: 'warning',
    title: 'No new dataset in the Key Resources Table',
    message: 'This Key Resources Table does not include any new data. If you did collect data, add a row for the data you collected. If you did not collect data, add the text below to your Data/Code Availability Statement.',
    recommendedText: 'No new primary data were collected in this study.',
    applies: rule1Applies,
    notApplicableReason: hasNewDataset.value ? 'Key Resources Table contains new dataset resources' : null
  })

  // Rule 2: No new code
  const rule2Applies = !hasNewCode.value
  rules.push({
    severity: 'warning',
    title: 'No new code in the Key Resources Table',
    message: 'This Key Resources Table does not include any new code. If you did generate code for this study, add a row outlining the code you generated. If you did not generate any code, add the text below to your Data/Code Availability Statement.',
    recommendedText: 'No code was generated for this study; all data cleaning, preprocessing, analysis, and visualization was performed using [insert program name(s)].',
    applies: rule2Applies,
    notApplicableReason: hasNewCode.value ? 'Key Resources Table contains new Software/code resources' : null
  })

  // Rule 3: Resource type mention checks
  const rule3aApplies = hasDatasetRows.value && !text.includes('data')
  rules.push({
    severity: 'info',
    title: 'Dataset resources not mentioned',
    message: 'Your Key Resources Table includes Dataset resources, but the Availability Statement does not mention them.',
    applies: rule3aApplies,
    notApplicableReason: !hasDatasetRows.value ? 'No dataset resources in the Key Resources Table' : text.includes('data') ? 'AS already mentions "data"' : null
  })

  const rule3bApplies = hasCodeRows.value && !text.includes('code') && !text.includes('software')
  rules.push({
    severity: 'info',
    title: 'Software/code resources not mentioned',
    message: 'Your Key Resources Table includes Software/code resources, but the Availability Statement does not mention them.',
    applies: rule3bApplies,
    notApplicableReason: !hasCodeRows.value ? 'No Software/code resources in the Key Resources Table' : (text.includes('code') || text.includes('software')) ? 'AS already mentions Software/code' : null
  })

  const rule3cApplies = hasProtocolRows.value && !text.includes('protocol')
  rules.push({
    severity: 'info',
    title: 'Protocol resources not mentioned',
    message: 'Your Key Resources Table includes Protocol resources, but the Availability Statement does not mention them.',
    applies: rule3cApplies,
    notApplicableReason: !hasProtocolRows.value ? 'No protocol resources in the Key Resources Table' : text.includes('protocol') ? 'AS already mentions "protocol"' : null
  })

  const rule3dApplies = hasLabMaterialRows.value && !text.includes('material') && !text.includes('reagent') && !text.includes('resource')
  rules.push({
    severity: 'info',
    title: 'Lab Material resources not mentioned',
    message: 'Your Key Resources Table includes Lab Material resources, but the Availability Statement does not mention them.',
    applies: rule3dApplies,
    notApplicableReason: !hasLabMaterialRows.value ? 'No lab material resources in the Key Resources Table' : (text.includes('material') || text.includes('reagent') || text.includes('resource')) ? 'AS already mentions materials/reagents' : null
  })

  // Rule 4: No new data explicit statement
  const rule4Applies = !hasNewDataset.value && !text.includes('no new data') && !text.includes('no new primary data')
  rules.push({
    severity: 'warning',
    title: 'Missing explicit no-data statement',
    message: 'The AS should explicitly state that no new data were generated.',
    recommendedText: 'No new primary data were collected in this study.',
    applies: rule4Applies,
    notApplicableReason: hasNewDataset.value ? 'KRT contains new dataset resources' : (text.includes('no new data') || text.includes('no new primary data')) ? 'AS already states no new data' : null
  })

  // Rule 5: No new code explicit statement
  const rule5Applies = !hasNewCode.value && !text.includes('no code') && !text.includes('no new code')
  rules.push({
    severity: 'warning',
    title: 'Missing explicit no-code statement',
    message: 'The AS should explicitly state that no new code was generated.',
    recommendedText: 'No code was generated for this study; all data cleaning, preprocessing, analysis, and visualization was performed using [insert program name(s)].',
    applies: rule5Applies,
    notApplicableReason: hasNewCode.value ? 'KRT contains new code/software resources' : (text.includes('no code') || text.includes('no new code')) ? 'AS already states no new code' : null
  })

  // Rule 6: Key Resources Table reference check
  const rule6Applies = !text.includes('key resource') && !text.includes('krt') && !text.includes('zenodo') && !text.includes('doi') && !text.includes('table number')
  rules.push({
    severity: 'warning',
    title: 'Missing Key Resources Table reference',
    message: 'The AS must indicate that the Key Resources Table lists all research outputs alongside their identifiers.',
    recommendedText: 'The data, code, protocols, and key lab materials used and generated in this study are listed in a Key Resources Table alongside their persistent identifiers at [enter the Zenodo DOI or Table number].',
    applies: rule6Applies,
    notApplicableReason: !rule6Applies ? 'AS references Key Resources Table, Zenodo, DOI, or table' : null
  })

  return rules
})

// Filtered suggestions (only applicable ones, or all if showAllRules is true)
// Always sort: applicable first, then N/A
const asSuggestions = computed(() => {
  let rules = showAllRules.value ? allRules.value : allRules.value.filter(r => r.applies)
  // Sort: applicable rules first, then N/A
  return [...rules].sort((a, b) => {
    if (a.applies && !b.applies) return -1
    if (!a.applies && b.applies) return 1
    return 0
  })
})

// Current suggestion in carousel mode
const currentSuggestion = computed(() => asSuggestions.value[currentSuggestionIndex.value] || null)

// Carousel navigation
function goToPrevSuggestion() {
  if (currentSuggestionIndex.value > 0) {
    currentSuggestionIndex.value--
  }
}

function goToNextSuggestion() {
  if (currentSuggestionIndex.value < asSuggestions.value.length - 1) {
    currentSuggestionIndex.value++
  }
}

function goToSuggestion(index) {
  if (index >= 0 && index < asSuggestions.value.length) {
    currentSuggestionIndex.value = index
  }
}

// Reset index when suggestions change
watch(asSuggestions, () => {
  if (currentSuggestionIndex.value >= asSuggestions.value.length) {
    currentSuggestionIndex.value = Math.max(0, asSuggestions.value.length - 1)
  }
})

function copyText(text) {
  navigator.clipboard.writeText(text)
  notificationStore.success('Copied to clipboard')
}

async function handleNext() {
  try {
    await submissionStore.updateSubmission(route.params.id, { status: 'step_report' })
    router.push({ name: 'submission-report', params: { id: route.params.id } })
  } catch (error) {
    notificationStore.error('Failed to continue')
  }
}

async function handleBack() {
  try {
    await submissionStore.updateSubmission(route.params.id, { status: 'step_review' })
    router.push({ name: 'submission-review', params: { id: route.params.id } })
  } catch (error) {
    notificationStore.error('Failed to go back')
  }
}
</script>

<template>
  <div class="space-y-6">
    <SubmissionHeader
      :submission="submission"
      :latest-files="latestFiles"
      step-title="Step 4: Edit manuscript"
      step-description="Review your Data/Code Availability Statement"
      :help-items="helpItems"
      :show-navigation="true"
      :can-go-back="true"
      :can-go-next="true"
      @go-back="handleBack"
      @go-next="handleNext"
    />

    <!-- Original extracted DAS (shown when user has modified it) -->
    <div v-if="dasWasModified" class="card extracted-das-card">
      <div class="text-xs font-semibold uppercase text-gray-500 mb-1">Original extracted text</div>
      <div class="extracted-das-text">{{ extractedDAS }}</div>
    </div>

    <!-- AS Text Display -->
    <div class="card">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-lg font-medium">Data/Code Availability Statement</h2>
        <button
          v-if="!isEditingDAS"
          class="das-edit-btn"
          @click="startEditingDAS"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          Edit
        </button>
      </div>

      <!-- Edit mode -->
      <div v-if="isEditingDAS">
        <textarea
          v-model="editedDAS"
          class="das-textarea"
          rows="6"
          placeholder="Enter the Data/Code Availability Statement..."
        />
        <div class="das-edit-actions">
          <button class="das-cancel-btn" :disabled="savingDAS" @click="cancelEditingDAS">Cancel</button>
          <button class="das-save-btn" :disabled="savingDAS" @click="saveDAS">
            {{ savingDAS ? 'Saving...' : 'Save' }}
          </button>
        </div>
      </div>

      <!-- Display mode -->
      <template v-else>
        <div v-if="asText" class="as-text-display">
          {{ asText }}
        </div>
        <div v-else class="text-center py-8 text-gray-500">
          <p class="text-sm">No availability statement provided for this submission.</p>
        </div>
      </template>
    </div>

    <!-- Suggestions -->
    <div class="card">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-lg font-medium">
          Suggestions
          <span class="text-sm font-normal text-gray-500 ml-2">
            {{ asSuggestions.filter(s => s.applies).length }} applicable
            <span v-if="showAllRules"> / {{ allRules.length }} total</span>
          </span>
        </h2>
        <div class="flex items-center gap-4">
          <!-- View mode switch -->
          <div class="view-mode-switch">
            <button
              :class="['view-mode-btn', viewMode === 'list' ? 'view-mode-active' : '']"
              title="List view"
              @click="viewMode = 'list'"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
              </svg>
              <span>Expanded</span>
            </button>
            <button
              :class="['view-mode-btn', viewMode === 'carousel' ? 'view-mode-active' : '']"
              title="Single view"
              @click="viewMode = 'carousel'"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <span>Focus</span>
            </button>
          </div>
          <!-- Show all checks toggle -->
          <label class="flex items-center cursor-pointer text-sm text-gray-600">
            <input
              v-model="showAllRules"
              type="checkbox"
              class="mr-2 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
            See all checks
          </label>
        </div>
      </div>

      <!-- List View -->
      <div v-if="asSuggestions.length > 0 && viewMode === 'list'" class="suggestions-list">
        <div
          v-for="(suggestion, index) in asSuggestions"
          :key="index"
          :class="['suggestion-card', suggestion.applies ? `suggestion-${suggestion.severity}` : 'suggestion-not-applicable']"
        >
          <div class="suggestion-header">
            <span :class="['severity-badge', suggestion.applies ? `badge-${suggestion.severity}` : 'badge-not-applicable']">
              {{ suggestion.applies ? suggestion.severity : 'N/A' }}
            </span>
            <span class="suggestion-title" :class="{ 'text-gray-400': !suggestion.applies }">{{ suggestion.title }}</span>
          </div>
          <p class="suggestion-message" :class="{ 'text-gray-400': !suggestion.applies }">{{ suggestion.message }}</p>
          <!-- Not applicable reason -->
          <div v-if="!suggestion.applies && suggestion.notApplicableReason" class="not-applicable-reason">
            <svg class="w-4 h-4 text-green-500 mr-1.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
            <span>{{ suggestion.notApplicableReason }}</span>
          </div>
          <div v-if="suggestion.applies && suggestion.recommendedText" class="recommended-text">
            <div class="recommended-label">Recommended text:</div>
            <div class="recommended-content">
              <span class="recommended-value">{{ suggestion.recommendedText }}</span>
              <button
                class="copy-btn"
                title="Copy to clipboard"
                @click="copyText(suggestion.recommendedText)"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Carousel View -->
      <div v-else-if="asSuggestions.length > 0 && viewMode === 'carousel'" class="carousel-view">
        <div
          v-if="currentSuggestion"
          :class="['suggestion-card', currentSuggestion.applies ? `suggestion-${currentSuggestion.severity}` : 'suggestion-not-applicable']"
        >
          <div class="suggestion-header">
            <span :class="['severity-badge', currentSuggestion.applies ? `badge-${currentSuggestion.severity}` : 'badge-not-applicable']">
              {{ currentSuggestion.applies ? currentSuggestion.severity : 'N/A' }}
            </span>
            <span class="suggestion-title" :class="{ 'text-gray-400': !currentSuggestion.applies }">{{ currentSuggestion.title }}</span>
          </div>
          <p class="suggestion-message" :class="{ 'text-gray-400': !currentSuggestion.applies }">{{ currentSuggestion.message }}</p>
          <!-- Not applicable reason -->
          <div v-if="!currentSuggestion.applies && currentSuggestion.notApplicableReason" class="not-applicable-reason">
            <svg class="w-4 h-4 text-green-500 mr-1.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
            <span>{{ currentSuggestion.notApplicableReason }}</span>
          </div>
          <div v-if="currentSuggestion.applies && currentSuggestion.recommendedText" class="recommended-text">
            <div class="recommended-label">Recommended text:</div>
            <div class="recommended-content">
              <span class="recommended-value">{{ currentSuggestion.recommendedText }}</span>
              <button
                class="copy-btn"
                title="Copy to clipboard"
                @click="copyText(currentSuggestion.recommendedText)"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        <!-- Carousel navigation -->
        <div v-if="asSuggestions.length > 1" class="carousel-nav">
          <button
            :disabled="currentSuggestionIndex === 0"
            class="carousel-arrow"
            :class="currentSuggestionIndex === 0 ? 'carousel-arrow-disabled' : ''"
            @click="goToPrevSuggestion"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </button>

          <div class="carousel-dots">
            <button
              v-for="(suggestion, index) in asSuggestions"
              :key="index"
              class="carousel-dot"
              :class="{
                'carousel-dot-active': index === currentSuggestionIndex,
                'carousel-dot-applicable': index !== currentSuggestionIndex && suggestion.applies,
                'carousel-dot-na': index !== currentSuggestionIndex && !suggestion.applies
              }"
              :title="`${suggestion.title} (${suggestion.applies ? suggestion.severity : 'N/A'})`"
              @click="goToSuggestion(index)"
            />
          </div>

          <button
            :disabled="currentSuggestionIndex === asSuggestions.length - 1"
            class="carousel-arrow"
            :class="currentSuggestionIndex === asSuggestions.length - 1 ? 'carousel-arrow-disabled' : ''"
            @click="goToNextSuggestion"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>

      <!-- No applicable suggestions -->
      <div v-else class="flex items-center py-4 text-green-700">
        <svg class="w-6 h-6 text-green-500 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p>No issues found with the Availability Statement.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.extracted-das-card {
  background: #f9fafb;
  border: 1px dashed #d1d5db;
}

.extracted-das-text {
  font-size: 0.8125rem;
  line-height: 1.6;
  color: #6b7280;
  font-style: italic;
  white-space: pre-wrap;
  word-break: break-word;
}

.as-text-display {
  padding: 1rem;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  font-size: 0.875rem;
  line-height: 1.6;
  color: #374151;
  white-space: pre-wrap;
  word-break: break-word;
}

.das-edit-btn {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #6b7280;
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: all 0.15s;
}

.das-edit-btn:hover {
  color: #2563eb;
  border-color: #2563eb;
  background: #eff6ff;
}

.das-textarea {
  width: 100%;
  padding: 0.75rem;
  font-size: 0.875rem;
  line-height: 1.6;
  color: #374151;
  background: #fff;
  border: 1px solid #2563eb;
  border-radius: 0.5rem;
  resize: vertical;
  outline: none;
  font-family: inherit;
}

.das-textarea:focus {
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

.das-edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.das-cancel-btn {
  padding: 0.375rem 1rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #6b7280;
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: all 0.15s;
}

.das-cancel-btn:hover {
  background: #f3f4f6;
}

.das-save-btn {
  padding: 0.375rem 1rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #fff;
  background: #2563eb;
  border: 1px solid #2563eb;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: all 0.15s;
}

.das-save-btn:hover {
  background: #1d4ed8;
}

.das-save-btn:disabled,
.das-cancel-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.suggestions-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.suggestion-card {
  padding: 1rem;
  border-radius: 0.5rem;
  border: 1px solid;
}

.suggestion-warning {
  background: #fffbeb;
  border-color: #fde68a;
}

.suggestion-info {
  background: #eff6ff;
  border-color: #bfdbfe;
}

.suggestion-not-applicable {
  background: #f9fafb;
  border-color: #e5e7eb;
}

.badge-not-applicable {
  background: #e5e7eb;
  color: #6b7280;
}

.not-applicable-reason {
  display: flex;
  align-items: flex-start;
  margin-top: 0.5rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
  color: #059669;
  background: #ecfdf5;
  border-radius: 0.375rem;
}

.suggestion-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.severity-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
}

.badge-warning {
  background: #fef3c7;
  color: #92400e;
}

.badge-info {
  background: #dbeafe;
  color: #1e40af;
}

.suggestion-title {
  font-weight: 600;
  font-size: 0.875rem;
  color: #111827;
}

.suggestion-message {
  font-size: 0.8125rem;
  color: #4b5563;
  line-height: 1.5;
}

.recommended-text {
  margin-top: 0.75rem;
  padding: 0.75rem;
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid #e5e7eb;
  border-radius: 0.375rem;
}

.recommended-label {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  color: #6b7280;
  margin-bottom: 0.375rem;
}

.recommended-content {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}

.recommended-value {
  flex: 1;
  font-size: 0.8125rem;
  color: #1f2937;
  font-style: italic;
  line-height: 1.5;
}

.copy-btn {
  flex-shrink: 0;
  padding: 0.375rem;
  color: #6b7280;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  background: #fff;
  cursor: pointer;
  transition: all 0.15s;
}

.copy-btn:hover {
  color: #2563eb;
  border-color: #2563eb;
  background: #eff6ff;
}

/* View mode switch */
.view-mode-switch {
  display: flex;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  overflow: hidden;
}

.view-mode-btn {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #6b7280;
  background: #fff;
  border: none;
  cursor: pointer;
  transition: all 0.15s;
}

.view-mode-btn:not(:last-child) {
  border-right: 1px solid #d1d5db;
}

.view-mode-btn:hover {
  background: #f3f4f6;
  color: #374151;
}

.view-mode-btn.view-mode-active {
  background: #eff6ff;
  color: #2563eb;
}

/* Carousel view */
.carousel-view {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.carousel-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
}

.carousel-arrow {
  padding: 0.375rem;
  color: #6b7280;
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: all 0.15s;
}

.carousel-arrow:hover:not(.carousel-arrow-disabled) {
  color: #2563eb;
  border-color: #2563eb;
  background: #eff6ff;
}

.carousel-arrow-disabled {
  color: #d1d5db;
  cursor: not-allowed;
}

.carousel-dots {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.carousel-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  transition: all 0.15s;
}

.carousel-dot-active {
  background: #2563eb;
  transform: scale(1.25);
}

.carousel-dot-applicable {
  background: #fbbf24;
}

.carousel-dot-applicable:hover {
  background: #f59e0b;
}

.carousel-dot-na {
  background: #d1d5db;
}

.carousel-dot-na:hover {
  background: #9ca3af;
}
</style>
