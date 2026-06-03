<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSubmissionStore } from '@/stores/submission.store'
import { useNotificationStore } from '@/stores/notification.store'
import { setSubmissionTitle } from '@/router'
import reportService from '@/services/report.service'
import pdfService from '@/services/pdf.service'
import SubmissionHeader from '@/components/submission/SubmissionHeader.vue'
import NewRoundModal from '@/components/submission/NewRoundModal.vue'

const route = useRoute()
const router = useRouter()
const submissionStore = useSubmissionStore()
const notificationStore = useNotificationStore()

const generating = ref(false)
const reports = ref([])
const showNewRoundModal = ref(false)
const newRoundLoading = ref(false)
const submission = computed(() => submissionStore.currentSubmission)
const latestFiles = computed(() => submissionStore.latestFiles)

// Step help items
const helpItems = computed(() => [
  {
    title: 'Download report',
    children: ['To expedite ASAP compliance review, reports can be attached to compliance review submissions'],
    done: reports.value.length > 0
  },
  {
    title: '[Optional] Validate updated manuscript',
    children: ['Click "Process updated manuscript" to run KRT Assist on your updated manuscript'],
    done: false
  }
])

// Reports grouped by round
const currentRoundReports = computed(() => {
  const round = submission.value?.currentRound || 1
  return reports.value.filter(r => r.round === round)
})

const previousRoundsGrouped = computed(() => {
  const round = submission.value?.currentRound || 1
  const previous = reports.value.filter(r => r.round < round)
  // Group by round, sorted descending
  const grouped = {}
  for (const report of previous) {
    const r = report.round || 1
    if (!grouped[r]) grouped[r] = []
    grouped[r].push(report)
  }
  return Object.entries(grouped)
    .sort(([a], [b]) => Number(b) - Number(a))
    .map(([roundNum, roundReports]) => ({ round: Number(roundNum), reports: roundReports }))
})

onMounted(async () => {
  // Reset local state for new submission
  generating.value = false
  reports.value = []

  await submissionStore.fetchSubmission(route.params.id)
  await fetchReports()
})

// Update page title with submission ID or title
watch(submission, (sub) => {
  if (sub) {
    setSubmissionTitle(sub.manuscriptId || sub.title, 'Step 5: Report')
  }
}, { immediate: true })

async function fetchReports() {
  try {
    const result = await reportService.list(route.params.id)
    reports.value = result.reports
  } catch (error) {
    // No reports yet
  }
}

async function handleGenerateReport(type) {
  generating.value = true
  try {
    await reportService.generate(route.params.id, type)
    notificationStore.success('Report generated successfully')
    await fetchReports()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to generate report')
  } finally {
    generating.value = false
  }
}

async function handleFinish() {
  try {
    // Update status to completed
    await submissionStore.updateSubmission(route.params.id, { status: 'completed' })
    notificationStore.success('Submission completed successfully')
    router.push({ name: 'dashboard' })
  } catch (error) {
    notificationStore.error('Failed to complete submission')
  }
}

async function handleBack() {
  try {
    await submissionStore.updateSubmission(route.params.id, { status: 'step_as' })
    router.push({ name: 'submission-availability', params: { id: route.params.id } })
  } catch (error) {
    notificationStore.error('Failed to go back')
  }
}

async function handleNewRound(data) {
  newRoundLoading.value = true
  try {
    // 1. Bump the submission to a new round on the backend. The modal sent
    //    `hasNewKRT` (keep-or-replace KRT) along with the PDF file; we only
    //    forward the flag here — the PDF is uploaded in step 2 below so the
    //    file goes against the *new* currentRound.
    const updated = await submissionStore.processNewVersion(route.params.id, {
      hasNewKRT: data.hasNewKRT
    })

    // 2. Upload the new PDF to the round the backend just created. uploadPDF
    //    triggers the full analysis pipeline (markdown → DAS → suggestions),
    //    so by the time the user lands on Step 2 the background jobs are
    //    already running.
    if (data.pdfFile) {
      await pdfService.upload(route.params.id, data.pdfFile)
    }

    showNewRoundModal.value = false
    notificationStore.success(`Version ${updated.currentRound} started`)

    // Always go to Step 2 (KRT). The KRT is either carried forward (when the
    // user picked "keep current KRT") or blank for upload (when they picked
    // "upload new KRT"). The KRT view handles both cases.
    router.push({ name: 'submission-krt', params: { id: route.params.id } })
  } catch (error) {
    notificationStore.error(error.response?.data?.error || error.message || 'Failed to start new round')
  } finally {
    newRoundLoading.value = false
  }
}

function formatDate(date) {
  return new Date(date).toLocaleString()
}

async function handleDownload(report) {
  try {
    const result = await reportService.download(route.params.id, report.id)
    // Open the presigned URL in a new tab
    window.open(result.url, '_blank')
  } catch (error) {
    notificationStore.error('Failed to download report')
  }
}
</script>

<template>
  <div class="space-y-6">
    <SubmissionHeader
      :submission="submission"
      :latest-files="latestFiles"
      step-title="KRT Assist review is complete"
      step-description="Download your report and optionally validate an updated manuscript"
      :help-items="helpItems"
      :show-navigation="true"
      :can-go-back="true"
      :can-go-next="false"
      next-blocked-reason="This is the last step"
      @go-back="handleBack"
      @go-next="() => {}"
    >
      <template #actions>
        <button
          v-if="['step_report', 'completed'].includes(submission?.status)"
          class="btn-primary text-sm"
          @click="showNewRoundModal = true"
        >
          Process New Version
        </button>
      </template>
    </SubmissionHeader>

    <!-- Success message -->
    <div class="card bg-green-50 border-green-200">
      <div class="flex items-center">
        <svg class="w-8 h-8 text-green-500 mr-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div>
          <h2 class="text-lg font-medium text-green-800">Submission Complete!</h2>
          <p class="text-green-600">Your KRT has been validated and is ready for report generation.</p>
        </div>
      </div>
    </div>

    <!-- Generate options -->
    <div class="card">
      <h2 class="text-lg font-medium mb-4">Generate Report</h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <!-- Google Sheets - temporarily disabled -->
        <div
          class="p-4 border-2 border-dashed rounded-lg opacity-50 cursor-not-allowed bg-gray-50"
        >
          <div class="flex items-center">
            <svg class="w-8 h-8 text-gray-400 mr-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-1.99 6H13V7h4.01v2zm0 4H13v-2h4.01v2zm-6.01 0H7v-2h4v2zm0-4H7V7h4v2zm0 8H7v-2h4v2zm6.01 0H13v-2h4.01v2z" />
            </svg>
            <div class="text-left">
              <h3 class="font-medium text-gray-500">Google Sheets</h3>
              <p class="text-sm text-gray-400">Coming soon</p>
            </div>
          </div>
        </div>

        <button
          :disabled="generating"
          class="p-4 border-2 border-dashed rounded-lg hover:border-primary-500 hover:bg-primary-50 transition-colors"
          @click="handleGenerateReport('excel')"
        >
          <div class="flex items-center">
            <svg class="w-8 h-8 text-green-700 mr-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm4 18H6V4h7v5h5v11z" />
              <path d="M8 12l2 3-2 3h1.5l1.25-2 1.25 2H14l-2-3 2-3h-1.5l-1.25 2-1.25-2H8z" />
            </svg>
            <div class="text-left">
              <h3 class="font-medium">Excel</h3>
              <p class="text-sm text-gray-500">Download as XLSX file</p>
            </div>
          </div>
        </button>
      </div>
    </div>

    <!-- Current round reports -->
    <div v-if="currentRoundReports.length > 0" class="card">
      <h2 class="text-lg font-medium mb-4">
        Generated Reports
        <span v-if="submission?.currentRound > 1" class="text-sm font-normal text-gray-500">(V{{ submission.currentRound }})</span>
      </h2>
      <div class="space-y-3">
        <div
          v-for="report in currentRoundReports"
          :key="report.id"
          class="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
        >
          <div class="flex items-center">
            <span class="badge badge-primary mr-3">{{ report.type }}</span>
            <span class="text-sm text-gray-500">{{ formatDate(report.createdAt) }}</span>
          </div>
          <button
            class="btn-secondary text-sm"
            @click="handleDownload(report)"
          >
            Download
          </button>
        </div>
      </div>
    </div>

    <!-- Previous round reports -->
    <div v-if="previousRoundsGrouped.length > 0" class="card">
      <h2 class="text-lg font-medium mb-4">Previous Versions</h2>
      <div class="space-y-2">
        <details
          v-for="group in previousRoundsGrouped"
          :key="group.round"
          class="border rounded-lg"
        >
          <summary class="px-4 py-3 cursor-pointer text-sm font-medium text-gray-700 hover:bg-gray-50">
            V{{ group.round }} ({{ group.reports.length }} report{{ group.reports.length !== 1 ? 's' : '' }})
          </summary>
          <div class="px-4 pb-3 space-y-2">
            <div
              v-for="report in group.reports"
              :key="report.id"
              class="flex items-center justify-between p-2 bg-gray-50 rounded"
            >
              <div class="flex items-center">
                <span class="badge badge-secondary mr-3">{{ report.type }}</span>
                <span class="text-sm text-gray-500">{{ formatDate(report.createdAt) }}</span>
              </div>
              <button
                class="btn-secondary text-xs"
                @click="handleDownload(report)"
              >
                Download
              </button>
            </div>
          </div>
        </details>
      </div>
    </div>

    <!-- New Round Modal -->
    <NewRoundModal
      :show="showNewRoundModal"
      :loading="newRoundLoading"
      @close="showNewRoundModal = false"
      @submit="handleNewRound"
    />
  </div>
</template>
