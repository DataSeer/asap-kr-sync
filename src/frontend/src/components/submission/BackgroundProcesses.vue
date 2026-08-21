<script setup>
/**
 * BackgroundProcesses — the single shared "background jobs" panel reused on
 * both step 2 (KRTView) and step 3 (PDFView). It owns:
 *
 *   1. The job poller (useJobPoller) and exposes its callbacks + jobs ref
 *      via inject('submissionJobs') AND via defineExpose for parents that
 *      need imperative access (e.g. PDFView's PDF-replace flow).
 *   2. Fetching /api/config/services and providing the result so the panel
 *      can hide fully-disabled modules.
 *   3. The reveal signal that auto-expands the panel after a fresh PDF
 *      upload.
 *   4. The restart-job dispatcher (PMs / staff click a job to re-run it).
 *
 * Both views render `<BackgroundProcesses :submission-id="id" />` — any
 * future change to the panel UI or polling logic only needs to be made
 * here. Per-view extras (software-mentions modal, authors, etc.) are still
 * provided by the parent view above this component since Vue's provide
 * resolution walks up the entire component tree.
 */
import { ref, computed, provide, onMounted } from 'vue'
import { useJobPoller } from '@/composables'
import { useNotificationStore } from '@/stores/notification.store'
import configService from '@/services/config.service'
import jobService from '@/services/job.service'
import pdfService from '@/services/pdf.service'
import softwareService from '@/services/software.service'
import orcidService from '@/services/orcid.service'
import datasetsService from '@/services/datasets.service'
import materialsService from '@/services/materials.service'
import protocolsService from '@/services/protocols.service'
import identifierDetectionService from '@/services/identifier-detection.service'
import krtGroundingService from '@/services/krt-grounding.service'
import markdownService from '@/services/markdown.service'
import suggestionService from '@/services/suggestion.service'
import JobStatusPanel from './JobStatusPanel.vue'

const props = defineProps({
  submissionId: { type: String, required: true }
})

const emit = defineEmits(['edit-das'])

const notificationStore = useNotificationStore()

// ── Job poller — provided to JobStatusPanel via inject ───────────────
const {
  jobs,
  fetchError,
  isAnyRunning,
  getJob,
  onJobComplete,
  onJobFailed,
  onJobPendingInput,
  refresh
} = useJobPoller(computed(() => props.submissionId))

provide('submissionJobs', jobs)
// So the panel can say "could not be read" instead of listing every step as
// "Not started" — which is what an unreachable server looked like.
provide('jobsFetchError', fetchError)

// ── Cancel-processing action (#15) — provided to JobStatusPanel's button ──
async function cancelProcessing() {
  try {
    const res = await jobService.cancelProcessing(props.submissionId)
    if (res.cancelled > 0) {
      notificationStore.info(res.message || 'Processing cancelled')
    } else {
      notificationStore.info('No running processes to cancel')
    }
    await refresh()
  } catch (err) {
    notificationStore.error(err.response?.data?.error || 'Failed to cancel processing')
  }
}
provide('cancelProcessing', cancelProcessing)

// ── Service status (which modules are enabled/disabled) ──────────────
const serviceStatus = ref({})
provide('serviceStatus', serviceStatus)

onMounted(() => {
  configService.getServiceStatus()
    .then(data => { serviceStatus.value = data.services || {} })
    .catch(() => {})
})

// ── Reveal signal — flipped by parent after fresh PDF upload to force
//    the panel open even if the user had previously collapsed it. ────
const expandJobsSignal = ref(0)
provide('expandJobsSignal', expandJobsSignal)
function reveal() {
  expandJobsSignal.value++
}

// ── Restart-job dispatcher ───────────────────────────────────────────
// Wired into JobStatusPanel via inject('restartJob').
//
// The server decides what actually happened: a re-run asked for while the step
// is already in flight is deliberately a no-op, and it answers "… is already
// running" rather than "… queued". This used to announce its own cheerful
// "re-started" either way, so a user who clicked twice was told a second run
// had started and then waited for a result that was never coming. Show what
// the server said; fall back to our own wording only if it said nothing.
const RESTART_ACTIONS = {
  das_extraction: [(id) => pdfService.extractDAS(id), 'DAS extraction'],
  pdf_analysis: [(id) => pdfService.triggerAnalysis(id), 'PDF analysis'],
  software_detection: [(id) => softwareService.triggerDetection(id), 'Software detection'],
  orcid_extraction: [(id) => orcidService.triggerExtraction(id), 'ORCID extraction'],
  markdown_convert: [(id) => markdownService.triggerConvert(id), 'Markdown conversion'],
  datasets_detection: [(id) => datasetsService.triggerDetection(id), 'Datasets detection'],
  materials_detection: [(id) => materialsService.triggerDetection(id), 'Materials detection'],
  protocols_detection: [(id) => protocolsService.triggerDetection(id), 'Protocols detection'],
  identifier_detection: [(id) => identifierDetectionService.triggerDetection(id), 'Identifier detection'],
  krt_grounding: [(id) => krtGroundingService.triggerGrounding(id), 'KRT grounding'],
  suggestion_generation: [(id) => suggestionService.regenerate(id), 'AI suggestion generation']
}

provide('restartJob', async (jobType) => {
  const action = RESTART_ACTIONS[jobType]
  if (!action) return
  const [trigger, label] = action
  try {
    const result = await trigger(props.submissionId)
    notificationStore.info(result?.message || `${label} re-started`)
    await refresh()
  } catch (err) {
    notificationStore.error(err.response?.data?.error || `Failed to restart ${jobType}`)
  }
})

// Imperative access for parents — refresh after upload, reveal, register
// callbacks for in-flight transitions.
defineExpose({
  jobs,
  isAnyRunning,
  getJob,
  refresh,
  reveal,
  onJobComplete,
  onJobFailed,
  onJobPendingInput
})
</script>

<template>
  <JobStatusPanel @edit-das="emit('edit-das')" />
</template>
