<script setup>
/**
 * PipelinePanel — the single shared pipeline panel rendered on
 * the Manuscript step (step 2). It owns:
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
 * The view renders `<PipelinePanel :submission-id="id" />` — any
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
import JobStatusPanel from './JobStatusPanel.vue'

const props = defineProps({
  submissionId: { type: String, required: true }
})


const notificationStore = useNotificationStore()

// ── Job poller — provided to JobStatusPanel via inject ───────────────
const {
  jobs,
  issues,
  fetchError,
  isAnyRunning,
  getJob,
  onJobComplete,
  onJobFailed,
  onJobPendingInput,
  refresh
} = useJobPoller(computed(() => props.submissionId))

provide('submissionJobs', jobs)
// The step tiles offer Retry / Continue on a step that needs a decision, so the
// panel no longer sits under a separate box repeating the same thing. The id is
// what the decision is made against, and the refresh is how the tile stops
// showing the issue once it has been answered.
provide('pipelineIssues', issues)
provide('submissionIdForDecision', computed(() => props.submissionId))
provide('refreshPipeline', refresh)
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
  <JobStatusPanel />
</template>
