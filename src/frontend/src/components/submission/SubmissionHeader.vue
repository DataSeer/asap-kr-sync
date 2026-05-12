<script setup>
/**
 * SubmissionHeader - Header component for submission workflow pages
 *
 * Displays submission info, step indicator, and provides edit functionality
 *
 * @component
 */
import { ref, computed, nextTick, onMounted, inject } from 'vue'
import StatusBadge from './StatusBadge.vue'
import StepIndicator from './StepIndicator.vue'
import EditMetadataModal from './EditMetadataModal.vue'
import FilesInfoModal from './FilesInfoModal.vue'
import StepHelpPanel from './StepHelpPanel.vue'
import fileService from '@/services/file.service'
import krtService from '@/services/krt.service'
import { useNotificationStore } from '@/stores/notification.store'
import { statusToStep } from '@/utils/submission'

const props = defineProps({
  /** The submission object */
  submission: {
    type: Object,
    default: null
  },
  /** Latest files object { krt: File, pdf: File } */
  latestFiles: {
    type: Object,
    default: () => ({})
  },
  /** Title for the current step */
  stepTitle: {
    type: String,
    required: true
  },
  /** Optional description for the current step */
  stepDescription: {
    type: String,
    default: ''
  },
  /** Show navigation arrows in the status bar */
  showNavigation: {
    type: Boolean,
    default: false
  },
  /** Whether user can go back */
  canGoBack: {
    type: Boolean,
    default: true
  },
  /** Whether user can go to next step */
  canGoNext: {
    type: Boolean,
    default: true
  },
  /** Tooltip message when next is blocked */
  nextBlockedReason: {
    type: String,
    default: ''
  },
  /** Help items for the current step checklist */
  helpItems: {
    type: Array,
    default: () => []
  }
})

const emit = defineEmits(['go-back', 'go-next'])

const notificationStore = useNotificationStore()

// Show blocked reason tooltip on click for disabled Continue button
const showBlockedTooltip = ref(false)
let blockedTooltipTimeout = null

const helpHighlight = ref(false)
const helpPanelRef = ref(null)

function handleDisabledNextClick() {
  if (!props.canGoNext && props.nextBlockedReason) {
    showBlockedTooltip.value = true
    clearTimeout(blockedTooltipTimeout)
    blockedTooltipTimeout = setTimeout(() => {
      showBlockedTooltip.value = false
    }, 3000)

    // Open the instructions panel if not already open, highlight it, and
    // scroll to it. The user might be deep into the page (e.g. at the
    // bottom of the AI suggestions list) when they click the disabled
    // Continue — opening + flashing the panel without scrolling is
    // useless because they can't see it. nextTick lets the v-if mount
    // the panel before we ask the browser to scroll to it.
    if (props.helpItems.length > 0) {
      showHelp.value = true
      helpHighlight.value = true
      setTimeout(() => {
        helpHighlight.value = false
      }, 1500)
      nextTick(() => {
        const el = helpPanelRef.value?.$el || helpPanelRef.value
        el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      })
    }
  }
}
const currentStep = computed(() => statusToStep(props.submission?.status))
const isComplete = computed(() => props.submission?.status === 'completed')

// Step labels for navigation
const stepLabels = ['KRT', 'Manuscript', 'Approve', 'Edit', 'Report']

// Truncate title if longer than 100 characters
const truncatedTitle = computed(() => {
  const title = props.submission?.title || ''
  if (title.length > 100) {
    return title.substring(0, 100) + '...'
  }
  return title
})
const isTitleTruncated = computed(() => (props.submission?.title?.length || 0) > 100)

// Help panel state — always expanded by default for all users so the
// step instructions are visible without an extra click. Users can still
// collapse it manually; the closed state is not persisted.
const showHelp = ref(true)

onMounted(() => {
  if (props.helpItems.length > 0) {
    showHelp.value = true
  }
})

// Edit modal state
const showEditModal = ref(false)
const showFilesModal = ref(false)

function openEditModal() {
  showEditModal.value = true
}

function openFilesModal() {
  showFilesModal.value = true
}

// Exposed so parent views (e.g. PDFView) can trigger the metadata/DAS editor
// from outside this component — for example when the JobStatusPanel emits
// `edit-das` from its modal.
defineExpose({ openEditModal })

async function handleFileDownload(file) {
  try {
    // If file has a presigned URL, use it directly
    if (file.s3Url) {
      window.open(file.s3Url, '_blank')
      return
    }
    // Otherwise, fetch a new presigned URL
    const result = await fileService.download(props.submission.id, file.id)
    window.open(result.url, '_blank')
  } catch (error) {
    notificationStore.error('Failed to download file')
  }
}

function downloadLatestFile(type) {
  const file = props.latestFiles[type]
  if (file) {
    handleFileDownload(file)
  }
}

async function downloadCurrentKRT(round) {
  try {
    const blob = await krtService.download(props.submission.id, 'csv', round)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const suffix = round ? `_v${round}` : ''
    a.download = `krt_${props.submission.id}${suffix}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch (error) {
    notificationStore.error('Failed to download KRT data')
  }
}
</script>

<template>
  <!--
    The outer div uses `display: contents` so the SubmissionHeader's children
    behave, layout-wise, as direct children of the view's `<div class="space-y-6">`
    wrapper. That makes the sticky bar's containing block be the entire page
    (= `.space-y-6`), so it stays pinned all the way through scrolling instead
    of un-pinning at the end of the header's own height.
    DOM structure is unchanged (no multi-root, no parent class collisions).
  -->
  <div style="display: contents;">
    <!-- ─── STICKY BAR — only the article metadata + nav controls ─── -->
    <div class="submission-sticky-bar" :class="{ 'has-submission': !!submission }">
      <!-- Status bar with submission info -->
      <div v-if="submission" class="flex items-center justify-between">
        <div class="flex items-center space-x-4">
          <div>
            <div class="flex items-center">
              <h2 class="text-sm font-medium text-gray-500" :title="isTitleTruncated ? submission.title : undefined">{{ truncatedTitle }}</h2>
              <button
                class="ml-2 text-gray-400 hover:text-gray-600 transition-colors"
                title="Edit metadata"
                @click="openEditModal"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </button>
            </div>
            <div class="flex items-center mt-0.5">
              <!-- Manuscript ID or placeholder -->
              <p v-if="submission.manuscriptId" class="text-xs text-gray-400">{{ submission.manuscriptId }}</p>
              <button
                v-else
                class="text-xs text-gray-400 italic hover:text-primary-600 hover:underline transition-colors"
                title="Click to add manuscript ID"
                @click="openEditModal"
              >
                Manuscript ID not specified
              </button>

              <!-- File icons -->
              <span class="mx-2 text-gray-300">|</span>

              <!-- KRT icon -->
              <button
                v-if="latestFiles?.krt"
                class="inline-flex items-center text-xs text-green-600 hover:text-green-700 transition-colors"
                title="Download current KRT data (CSV)"
                @click="downloadCurrentKRT()"
              >
                <svg class="w-3.5 h-3.5 mr-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                KRT<span class="text-green-400 ml-0.5">(v{{ submission?.currentRound || 1 }}.{{ latestFiles?.krt?.version || 1 }})</span>
              </button>
              <span v-else class="inline-flex items-center text-xs text-gray-300 cursor-not-allowed" title="No KRT file uploaded">
                <svg class="w-3.5 h-3.5 mr-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                KRT
              </span>

              <span class="mx-1.5 text-gray-300">·</span>

              <!-- PDF icon -->
              <button
                v-if="latestFiles?.pdf"
                class="inline-flex items-center text-xs text-red-600 hover:text-red-700 transition-colors"
                title="Download PDF file"
                @click="downloadLatestFile('pdf')"
              >
                <svg class="w-3.5 h-3.5 mr-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
                PDF<span class="text-red-400 ml-0.5">(v{{ submission?.currentRound || 1 }}.{{ latestFiles?.pdf?.version || 1 }})</span>
              </button>
              <span v-else class="inline-flex items-center text-xs text-gray-300 cursor-not-allowed" title="No PDF file uploaded">
                <svg class="w-3.5 h-3.5 mr-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
                PDF
              </span>

              <!-- More info button -->
              <button
                class="ml-1.5 inline-flex items-center justify-center w-4 h-4 text-xs text-gray-400 hover:text-primary-600 border border-gray-300 hover:border-primary-400 rounded-full transition-colors"
                title="View all files"
                @click="openFilesModal"
              >
                ?
              </button>
            </div>
          </div>
        </div>
        <div class="flex items-center space-x-4">
          <!-- Step Navigator -->
          <div class="flex flex-col items-center">
            <!-- Version label on top -->
            <div v-if="showNavigation && submission?.currentRound > 1" class="text-xs text-gray-500 mb-1">
              Version {{ submission.currentRound }}
            </div>
            <!-- Line 1: < Go back [Step Badge] Go next step > -->
            <div v-if="showNavigation" class="flex items-center justify-center mb-1.5">
              <button
                :disabled="!canGoBack"
                class="nav-btn"
                :class="canGoBack ? 'nav-btn-back-enabled' : 'nav-btn-disabled'"
                @click="emit('go-back')"
              >
                <svg class="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 19l-7-7 7-7" />
                </svg>
                <span>Go back</span>
              </button>
              <span class="badge badge-primary mx-3">
                Step {{ currentStep }}: {{ stepLabels[currentStep - 1] }}
              </span>
              <div class="nav-tooltip-wrapper">
                <button
                  class="nav-btn"
                  :class="canGoNext ? 'nav-btn-next-enabled' : 'nav-btn-disabled'"
                  @click="canGoNext ? emit('go-next') : handleDisabledNextClick()"
                >
                  <span>Continue</span>
                  <svg class="w-3.5 h-3.5 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
                <div v-if="!canGoNext && nextBlockedReason" class="nav-tooltip" :class="{ 'nav-tooltip-visible': showBlockedTooltip }">
                  {{ nextBlockedReason }}
                </div>
              </div>
            </div>
            <!-- Line 2: Step indicator circles -->
            <StepIndicator :current-step="currentStep" :is-complete="isComplete" />
          </div>
          <StatusBadge v-if="!showNavigation" :status="submission.status" />
        </div>
      </div>
    </div><!-- /.submission-sticky-bar -->

    <!-- ─── REST — page title, description, help panel (NOT sticky) ─── -->
    <div class="submission-header-rest" style="overflow: visible;">
      <!-- Page title and actions -->
      <div class="flex items-center justify-between">
        <div class="flex items-center">
          <h1 class="text-2xl font-bold text-gray-900">{{ stepTitle }}</h1>
          <button
            v-if="helpItems.length > 0"
            class="help-toggle-btn"
            :class="{ 'help-toggle-active': showHelp }"
            title="Show step guide"
            @click="showHelp = !showHelp"
          >
            <span>Instructions</span>
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
        </div>
        <div class="flex items-center space-x-3">
          <slot name="actions"></slot>
        </div>
      </div>
      <p v-if="stepDescription" class="text-gray-500 mt-2">{{ stepDescription }}</p>

      <!-- Step Help Panel -->
      <Transition name="help-slide">
        <StepHelpPanel
          v-if="showHelp && helpItems.length > 0"
          ref="helpPanelRef"
          :items="helpItems"
          :class="{ 'help-highlight-flash': helpHighlight }"
          class="help-panel-scroll-target"
          @close="showHelp = false"
        />
      </Transition>
    </div><!-- /.submission-header-rest -->

    <!-- Edit Metadata Modal -->
    <EditMetadataModal
      :show="showEditModal"
      :submission="submission"
      @close="showEditModal = false"
    />

    <!-- Files Info Modal -->
    <FilesInfoModal
      :show="showFilesModal"
      :files="submission?.files || []"
      :submission-id="submission?.id"
      :has-krt="!!latestFiles?.krt"
      :current-round="submission?.currentRound || 1"
      @close="showFilesModal = false"
      @download="handleFileDownload"
      @download-krt-data="downloadCurrentKRT"
    />
  </div>
</template>

<style scoped>
/* Sticky sub-header — keeps article metadata + Go back/Continue + step
   indicator pinned at the top of the main scroll pane.
   The component's outer wrapper has `display: contents`, so this element's
   containing block is the view's `.space-y-6` div (which contains the entire
   page) — that's what lets sticky stay pinned through the whole scroll
   instead of un-sticking when the header's height is exceeded.
   z-index 40 sits above JobStatusPanel (z:30); the sidebar toggle (z:50) and
   modals (z:1000+, teleported to body) stay above it. */
.submission-sticky-bar {
  position: sticky;
  top: 0;
  z-index: 40;
  background: #f9fafb; /* matches main's bg-gray-50 so content scrolls cleanly underneath */
  /* AppLayout drops <main>'s pt-6 on submission routes, so the bar's top edge
     naturally lands on <main>'s padding-box top = AppHeader's bottom — no
     negative margin tricks required. The padding here provides breathing room
     above and below the metadata content (kept slim — extra spacing to the
     page title that follows lives on .submission-header-rest, not here, so
     the sticky bar itself stays compact). */
  padding-top: 0.75rem;
  padding-bottom: 0.75rem;
  /* Subtle bottom shadow that reads as a divider when content scrolls under */
  box-shadow: 0 6px 8px -8px rgba(0, 0, 0, 0.15);
}

/* Push the page title block away from the sticky bar without growing the bar
   itself. padding-top (not margin-top) so it isn't overridden by Tailwind's
   `.space-y-6 > * + *` rule on the view wrapper. */
.submission-header-rest {
  padding-top: 1.5rem;
}

/* Navigation buttons */
.nav-btn {
  display: flex;
  align-items: center;
  padding: 0.5rem 1rem;
  font-size: 0.8125rem;
  font-weight: 500;
  border-radius: 0.375rem;
  transition: all 0.15s ease;
}

.nav-btn-back-enabled {
  color: #2563eb;
  background: #dbeafe;
  cursor: pointer;
}

.nav-btn-back-enabled:hover {
  color: #1d4ed8;
  background: #bfdbfe;
}

.nav-btn-next-enabled {
  color: #059669;
  background: #d1fae5;
  cursor: pointer;
}

.nav-btn-next-enabled:hover {
  color: #047857;
  background: #a7f3d0;
}

.nav-btn-disabled {
  color: #9ca3af;
  background: #f3f4f6;
  cursor: not-allowed;
}

/* Navigation tooltip wrapper */
.nav-tooltip-wrapper {
  position: relative;
}

.nav-tooltip {
  display: none;
  position: absolute;
  top: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  padding: 0.5rem 0.75rem;
  background: #1f2937;
  color: #fff;
  font-size: 0.75rem;
  font-weight: 400;
  line-height: 1.4;
  border-radius: 0.375rem;
  white-space: nowrap;
  z-index: 50;
  pointer-events: none;
}

.nav-tooltip::before {
  content: '';
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent;
  border-bottom-color: #1f2937;
}

.nav-tooltip-wrapper:hover .nav-tooltip,
.nav-tooltip-visible {
  display: block;
}

/* Help toggle button */
.help-toggle-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  margin-left: 0.75rem;
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  font-weight: 600;
  color: #3b82f6;
  background: #dbeafe;
  border: 1px solid #93c5fd;
  border-radius: 9999px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.help-toggle-btn:hover {
  background: #bfdbfe;
  color: #1d4ed8;
}

.help-toggle-btn.help-toggle-active {
  background: #3b82f6;
  color: #fff;
  border-color: #2563eb;
}

/* Help panel slide transition */
.help-slide-enter-active,
.help-slide-leave-active {
  transition: all 0.2s ease;
  overflow: hidden;
}

.help-slide-enter-from,
.help-slide-leave-to {
  opacity: 0;
  max-height: 0;
  margin-top: 0;
}

.help-slide-enter-to,
.help-slide-leave-from {
  opacity: 1;
  max-height: 500px;
}

/* Offset scrollIntoView calls so the sticky sub-header (z:40, ~80px tall)
   doesn't cover the panel when the user is bounced back to the
   Instructions section by clicking a disabled Continue button. The exact
   offset matches the .submission-sticky-bar's rendered height with a bit
   of breathing room. */
.help-panel-scroll-target {
  scroll-margin-top: 6rem;
}

/* Highlight flash animation for instructions panel */
.help-highlight-flash {
  animation: helpFlash 1.5s ease;
}

@keyframes helpFlash {
  0%, 100% { box-shadow: none; }
  15%, 45%, 75% { box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.5); }
  30%, 60% { box-shadow: none; }
}
</style>
