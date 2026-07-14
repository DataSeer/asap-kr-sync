<script setup>
/**
 * KRTCellEditModal - Modal for editing a KRT cell value
 *
 * Displays validation issues and AI suggestions for the cell,
 * with options to accept/reject suggestions or manually edit.
 *
 * @component
 */
import { ref, computed, nextTick, watch } from 'vue'

const props = defineProps({
  /** Whether the modal is visible */
  show: {
    type: Boolean,
    default: false
  },
  /** The cell being edited { rowId, displayIndex, column, columnLabel, field } */
  cell: {
    type: Object,
    default: null
  },
  /** Current value being edited (v-model) */
  modelValue: {
    type: String,
    default: ''
  },
  /** Validation issues for this cell */
  issues: {
    type: Array,
    default: () => []
  },
  /** AI suggestion for this cell (if any) */
  suggestion: {
    type: Object,
    default: null
  },
  /** Available resource types for dropdown */
  resourceTypes: {
    type: Array,
    default: () => []
  }
})

const emit = defineEmits([
  'update:modelValue',
  'close',
  'save',
  'accept-suggestion',
  'reject-suggestion'
])

const localValue = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
})

const isEditingResourceType = computed(() => props.cell?.column === 'RESOURCE TYPE')
const isEditingNewReuse = computed(() => props.cell?.column === 'NEW/REUSE')
const isEditingIdentifier = computed(() => props.cell?.column === 'IDENTIFIER')

// The "Identifier not recognized by the app" remark: an advisory warning raised
// when the value doesn't match any format the app knows. The (?) explains what
// the app recognizes so the user can decide to keep the value as-is.
const hasUnrecognizedIdentifier = computed(() =>
  props.issues.some(i => i.type === 'invalid_format' && i.severity === 'warning')
)
const showIdHelp = ref(false)
// Identifier formats the app recognizes (kept in sync with the backend
// validator's IDENTIFIER_KIND_LABELS). Advisory copy only — not validation.
const RECOGNIZED_IDENTIFIERS = [
  'DOI (e.g. 10.1038/nmeth.2019)',
  'RRID (e.g. RRID:SCR_002285)',
  'SCR code',
  'URL',
  'Catalog number',
  'Accession IDs: GenBank, UniProt, PDB, EMDB, EMPIAR, BioStudies, Addgene, Cellosaurus',
  'PMID',
  'Oligonucleotide sequence'
]
async function setNoIdentifier() {
  emit('update:modelValue', 'No identifier exists')
  await nextTick()
  emit('save')
}

async function setIdentifierPending() {
  emit('update:modelValue', 'Identifier pending')
  await nextTick()
  emit('save')
}

function close() {
  emit('close')
}

function save() {
  emit('save')
}

const showRejectReason = ref(false)
const rejectReasonText = ref('')
const rejectReasonRef = ref(null)

// Auto-focus + select-all when the modal opens so the user can immediately
// type to overwrite the existing value. The browser's autofocus attribute
// only fires on initial page load, not when v-if re-mounts the element.
const textareaRef = ref(null)
const selectRef = ref(null)
watch(() => props.show, async (visible) => {
  if (!visible) {
    // Reset the inline-reject sub-form whenever the outer modal closes,
    // otherwise the previous reason text and the open reject sub-form
    // bleed into the next cell the user opens.
    showRejectReason.value = false
    rejectReasonText.value = ''
    showIdHelp.value = false
    return
  }
  await nextTick()
  if (textareaRef.value) {
    textareaRef.value.focus()
    textareaRef.value.select()
  } else if (selectRef.value) {
    selectRef.value.focus()
  }
}, { immediate: true })

function acceptSuggestion() {
  emit('accept-suggestion', props.suggestion)
}

async function startReject() {
  showRejectReason.value = true
  rejectReasonText.value = ''
  await nextTick()
  rejectReasonRef.value?.focus()
}

function cancelReject() {
  showRejectReason.value = false
  rejectReasonText.value = ''
}

function confirmReject() {
  emit('reject-suggestion', props.suggestion, rejectReasonText.value.trim())
  showRejectReason.value = false
  rejectReasonText.value = ''
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="modal-overlay" @click.self="close">
      <div class="modal-content">
        <div class="modal-header">
          <h3>Edit Cell</h3>
          <button class="modal-close" @click="close">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="modal-body">
          <div class="modal-info">
            <span class="modal-label">Row {{ cell?.displayIndex }}</span>
            <span class="modal-column">{{ cell?.columnLabel }}</span>
          </div>

          <!-- Show AI Suggestion if any -->
          <div v-if="suggestion" class="modal-suggestion">
            <div class="suggestion-header">
              <svg class="suggestion-icon" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd" />
              </svg>
              <span class="suggestion-title">{{ suggestion.title }}</span>
              <span class="suggestion-confidence">{{ Math.round(suggestion.confidence * 100) }}%</span>
            </div>
            <p v-if="suggestion.description" class="suggestion-description">
              {{ suggestion.description }}
            </p>
            <div class="suggestion-comparison">
              <div class="comparison-item">
                <span class="comparison-label">Current:</span>
                <span class="comparison-value current">{{ suggestion.data?.oldValue || '(empty)' }}</span>
              </div>
              <div class="comparison-arrow">→</div>
              <div class="comparison-item">
                <span class="comparison-label">Suggested:</span>
                <span class="comparison-value suggested">{{ suggestion.data?.newValue || '(empty)' }}</span>
              </div>
            </div>
            <div v-if="!showRejectReason" class="suggestion-actions">
              <button class="btn-accept" @click="acceptSuggestion">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="16" height="16">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                </svg>
                Accept
              </button>
              <button class="btn-reject" @click="startReject">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="16" height="16">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
                Reject
              </button>
            </div>
            <!-- Rejection reason input: replaces the Accept/Reject row while the
                 user is composing a reason. Cancel restores the original row. -->
            <div v-else class="reject-reason">
              <p class="reject-reason-label">Why are you rejecting this? (optional)</p>
              <textarea
                ref="rejectReasonRef"
                v-model="rejectReasonText"
                class="reject-reason-textarea"
                rows="2"
                placeholder="Enter reason..."
                @keydown.enter.ctrl="confirmReject"
              ></textarea>
              <div class="reject-reason-actions">
                <button class="btn-reject-cancel" @click="cancelReject">Cancel</button>
                <button class="btn-reject-confirm" @click="confirmReject">Reject</button>
              </div>
            </div>
          </div>

          <!-- Show issues if any (above instructions) -->
          <div v-if="issues.length > 0" :class="['modal-issues', issues.some(i => i.severity === 'error') ? 'modal-issues-error' : 'modal-issues-warning']">
            <div v-for="(issue, idx) in issues" :key="idx" class="modal-issue">
              <span :class="['issue-dot', issue.severity === 'error' ? 'dot-error' : 'dot-warning']"></span>
              <span :class="['issue-message', issue.severity === 'error' ? 'issue-message-error' : 'issue-message-warning']">{{ issue.message }}</span>
              <!-- (?) explaining what the app recognizes, next to the "not recognized" remark -->
              <button
                v-if="issue.type === 'invalid_format' && issue.severity === 'warning'"
                type="button"
                class="id-help-toggle"
                :aria-expanded="showIdHelp"
                title="Which identifiers does the app recognize?"
                @click="showIdHelp = !showIdHelp"
              >?</button>
            </div>
            <!-- Warnings are advisory: reassure the user they can move on. -->
            <p v-if="!issues.some(i => i.severity === 'error')" class="modal-issues-note">
              Optional — you can leave this as-is and continue.
            </p>
            <!-- Recognized-identifier reference (revealed by the (?) above) -->
            <div v-if="hasUnrecognizedIdentifier && showIdHelp" class="id-help-panel">
              <p class="id-help-intro">
                The app couldn't match this value to an identifier format it recognizes, so it flags it as a remark —
                if your identifier is valid, you can keep it as-is. These flags also help us extend what the app
                recognizes over time.
              </p>
              <p class="id-help-heading">Recognized formats</p>
              <ul class="id-help-list">
                <li v-for="fmt in RECOGNIZED_IDENTIFIERS" :key="fmt">{{ fmt }}</li>
              </ul>
              <p class="id-help-escape">
                No identifier to provide? Use <strong>No identifier exists</strong> or <strong>Identifier pending</strong>.
              </p>
            </div>
          </div>

          <!-- Identifier instructions with inline quick-fix links (only when the
               field is empty — no need to re-explain the format for an existing value) -->
          <div v-if="isEditingIdentifier && !String(localValue || '').trim()" class="identifier-instructions">
            <svg class="identifier-instructions-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p class="identifier-instructions-text">
              Provide a DOI, RRID, accession number, catalog number, or other persistent identifier. Otherwise, enter <button class="inline-quick-fix" @click="setNoIdentifier">No identifier exists</button> or <button class="inline-quick-fix" @click="setIdentifierPending">Identifier pending</button>.
            </p>
          </div>

          <!-- Select for RESOURCE TYPE -->
          <select
            v-if="isEditingResourceType"
            ref="selectRef"
            v-model="localValue"
            class="modal-select"
          >
            <option value="">Select type...</option>
            <option v-for="type in resourceTypes" :key="type" :value="type">{{ type }}</option>
          </select>

          <!-- Select for NEW/REUSE -->
          <select
            v-else-if="isEditingNewReuse"
            ref="selectRef"
            v-model="localValue"
            class="modal-select"
          >
            <option value="">Select...</option>
            <option value="new">new</option>
            <option value="reuse">reuse</option>
          </select>

          <!-- Textarea for other columns -->
          <textarea
            v-if="!isEditingResourceType && !isEditingNewReuse"
            ref="textareaRef"
            v-model="localValue"
            class="modal-textarea"
            rows="6"
            placeholder="Enter value..."
          ></textarea>
        </div>

        <div class="modal-footer">
          <button class="btn-secondary" @click="close">Cancel</button>
          <button class="btn-primary" @click="save">Save</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.modal-content {
  background: #fff;
  border-radius: 0.5rem;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  width: 100%;
  max-width: 600px;
  max-height: 90vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid #e5e7eb;
}

.modal-header h3 {
  font-size: 1.125rem;
  font-weight: 600;
  color: #111827;
  margin: 0;
}

.modal-close {
  padding: 0.25rem;
  color: #6b7280;
  border-radius: 0.25rem;
}

.modal-close:hover {
  background: #f3f4f6;
  color: #111827;
}

.modal-close svg {
  width: 1.25rem;
  height: 1.25rem;
}

.modal-body {
  padding: 1.5rem;
  overflow-y: auto;
}

.modal-info {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.modal-label {
  font-size: 0.75rem;
  font-weight: 500;
  color: #6b7280;
  background: #f3f4f6;
  padding: 0.25rem 0.5rem;
  border-radius: 0.25rem;
}

.modal-column {
  font-size: 0.875rem;
  font-weight: 600;
  color: #111827;
}

.modal-issues {
  border-radius: 0.375rem;
  padding: 0.75rem;
  margin-bottom: 1rem;
}

.modal-issues-error {
  background: #fef2f2;
  border: 1px solid #fca5a5;
}

/* Warnings are non-blocking remarks — a neutral gray "note" look (not amber
   "caution") so users understand they can safely ignore them. */
.modal-issues-warning {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
}

.modal-issues-note {
  font-size: 0.75rem;
  color: #6b7280;
  margin-top: 0.5rem;
  padding-left: 1rem;
}

/* (?) help toggle next to the "not recognized" remark */
.id-help-toggle {
  flex-shrink: 0;
  width: 1.125rem;
  height: 1.125rem;
  margin-left: 0.375rem;
  padding: 0;
  font-size: 0.7rem;
  font-weight: 700;
  line-height: 1;
  color: #6b7280;
  background: #e5e7eb;
  border: none;
  border-radius: 9999px;
  cursor: pointer;
}

.id-help-toggle:hover {
  background: #d1d5db;
  color: #374151;
}

.id-help-panel {
  margin-top: 0.625rem;
  padding: 0.625rem 0.75rem;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 0.375rem;
}

.id-help-intro {
  font-size: 0.75rem;
  color: #4b5563;
  line-height: 1.5;
}

.id-help-heading {
  margin-top: 0.5rem;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  color: #6b7280;
}

.id-help-list {
  margin: 0.25rem 0 0;
  padding-left: 1.1rem;
  list-style: disc;
  font-size: 0.75rem;
  color: #374151;
  line-height: 1.5;
}

.id-help-escape {
  margin-top: 0.5rem;
  font-size: 0.75rem;
  color: #4b5563;
}

.modal-issue {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}

.modal-issue + .modal-issue {
  margin-top: 0.5rem;
}

.issue-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  margin-top: 0.375rem;
  flex-shrink: 0;
}

.dot-error {
  background: #f87171;
}

.dot-warning {
  background: #9ca3af;
}

.issue-message {
  font-size: 0.875rem;
  display: block;
}

.issue-message-error {
  color: #991b1b;
}

.issue-message-warning {
  color: #4b5563;
}

.issue-suggestion {
  font-size: 0.75rem;
  color: #b45309;
  display: block;
  margin-top: 0.25rem;
}

.modal-textarea {
  width: 100%;
  padding: 0.75rem;
  font-size: 0.875rem;
  font-family: inherit;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  resize: vertical;
  min-height: 100px;
}

.modal-textarea:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.modal-select {
  width: 100%;
  padding: 0.75rem;
  font-size: 0.875rem;
  font-family: inherit;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  background-color: #fff;
  cursor: pointer;
}

.modal-select:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  padding: 1rem 1.5rem;
  border-top: 1px solid #e5e7eb;
  background: #f9fafb;
}

/* AI Suggestion Styles */
.modal-suggestion {
  background: #eff6ff;
  border: 1px solid #3b82f6;
  border-radius: 0.5rem;
  padding: 1rem;
  margin-bottom: 1rem;
}

.suggestion-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.suggestion-icon {
  width: 1.25rem;
  height: 1.25rem;
  color: #2563eb;
}

.suggestion-title {
  font-weight: 600;
  color: #1e40af;
  flex: 1;
}

.suggestion-confidence {
  font-size: 0.75rem;
  color: #6b7280;
  background: #e5e7eb;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
}

.suggestion-description {
  font-size: 0.875rem;
  color: #3b82f6;
  margin: 0 0 0.75rem 0;
}

.suggestion-comparison {
  display: flex;
  align-items: stretch;
  gap: 0.5rem;
  background: #fff;
  border-radius: 0.375rem;
  padding: 0.75rem;
  margin-bottom: 0.75rem;
}

.comparison-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.comparison-label {
  font-size: 0.75rem;
  font-weight: 500;
  color: #6b7280;
}

.comparison-value {
  font-size: 0.875rem;
  padding: 0.5rem;
  border-radius: 0.25rem;
  word-break: break-word;
}

.comparison-value.current {
  background: #fee2e2;
  color: #991b1b;
  text-decoration: line-through;
}

.comparison-value.suggested {
  background: #dcfce7;
  color: #166534;
  font-weight: 500;
}

.comparison-arrow {
  display: flex;
  align-items: center;
  color: #9ca3af;
  font-size: 1.25rem;
  padding: 0 0.25rem;
}

.suggestion-actions {
  display: flex;
  gap: 0.5rem;
}

.btn-accept {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  padding: 0.5rem 1rem;
  background: #10b981;
  color: #fff;
  font-size: 0.875rem;
  font-weight: 500;
  border-radius: 0.375rem;
  transition: background 0.15s;
}

.btn-accept:hover {
  background: #059669;
}

.btn-reject {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  padding: 0.5rem 1rem;
  background: #ef4444;
  color: #fff;
  font-size: 0.875rem;
  font-weight: 500;
  border-radius: 0.375rem;
  transition: background 0.15s;
}

.btn-reject:hover {
  background: #dc2626;
}

/* Identifier instructions */
.identifier-instructions {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 1rem;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 0.375rem;
  margin-bottom: 1rem;
}

.identifier-instructions-icon {
  width: 1.5rem;
  height: 1.5rem;
  color: #3b82f6;
  flex-shrink: 0;
  margin-top: 0.125rem;
}

.identifier-instructions-text {
  font-size: 0.875rem;
  color: #1e40af;
  margin: 0;
  line-height: 1.6;
}

/* Inline clickable quick-fix links within instruction text */
.inline-quick-fix {
  display: inline;
  padding: 0.125rem 0.375rem;
  background: #dbeafe;
  color: #1d4ed8;
  font-size: inherit;
  font-weight: 600;
  font-family: inherit;
  border: 1px solid #93c5fd;
  border-radius: 0.25rem;
  cursor: pointer;
  transition: all 0.15s;
}

.inline-quick-fix:hover {
  background: #3b82f6;
  color: #fff;
  border-color: #2563eb;
}

/* Rejection reason styles */
.reject-reason {
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid #e5e7eb;
}

.reject-reason-label {
  font-size: 0.8125rem;
  color: #6b7280;
  margin: 0 0 0.5rem 0;
}

.reject-reason-textarea {
  width: 100%;
  padding: 0.5rem;
  font-size: 0.8125rem;
  font-family: inherit;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  resize: none;
}

.reject-reason-textarea:focus {
  outline: none;
  border-color: #ef4444;
  box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.1);
}

.reject-reason-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.btn-reject-cancel {
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  color: #6b7280;
  background: #f3f4f6;
  border-radius: 0.375rem;
}

.btn-reject-cancel:hover {
  background: #e5e7eb;
}

.btn-reject-confirm {
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  color: #fff;
  background: #ef4444;
  border-radius: 0.375rem;
}

.btn-reject-confirm:hover {
  background: #dc2626;
}
</style>
