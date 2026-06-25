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
import pdfService from '@/services/pdf.service'
import softwareService from '@/services/software.service'
import orcidService from '@/services/orcid.service'
import datasetsService from '@/services/datasets.service'
import materialsService from '@/services/materials.service'
import protocolsService from '@/services/protocols.service'
import identifierDetectionService from '@/services/identifier-detection.service'
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
  isAnyRunning,
  getJob,
  onJobComplete,
  onJobFailed,
  onJobPendingInput,
  refresh
} = useJobPoller(computed(() => props.submissionId))

provide('submissionJobs', jobs)

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
// Wired into JobStatusPanel via inject('restartJob'). Maps job types to
// the right "trigger" service call and refreshes the poller afterwards.
provide('restartJob', async (jobType) => {
  const id = props.submissionId
  try {
    switch (jobType) {
      case 'das_extraction':
        await pdfService.extractDAS(id)
        notificationStore.info('DAS extraction re-started')
        break
      case 'pdf_analysis':
        await pdfService.triggerAnalysis(id)
        notificationStore.info('PDF analysis re-started')
        break
      case 'software_detection':
        await softwareService.triggerDetection(id)
        notificationStore.info('Software detection re-started')
        break
      case 'orcid_extraction':
        await orcidService.triggerExtraction(id)
        notificationStore.info('ORCID extraction re-started')
        break
      case 'markdown_convert':
        await markdownService.triggerConvert(id)
        notificationStore.info('Markdown conversion re-started')
        break
      case 'datasets_detection':
        await datasetsService.triggerDetection(id)
        notificationStore.info('Datasets detection re-started')
        break
      case 'materials_detection':
        await materialsService.triggerDetection(id)
        notificationStore.info('Materials detection re-started')
        break
      case 'protocols_detection':
        await protocolsService.triggerDetection(id)
        notificationStore.info('Protocols detection re-started')
        break
      case 'identifier_detection':
        await identifierDetectionService.triggerDetection(id)
        notificationStore.info('Identifier detection re-started')
        break
      case 'suggestion_generation':
        await suggestionService.regenerate(id)
        notificationStore.info('AI suggestion generation re-started')
        break
      default:
        return
    }
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
