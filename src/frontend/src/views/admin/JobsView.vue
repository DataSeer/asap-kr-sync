<script setup>
/**
 * JobsView — operator view of the whole processing queue. Admin only.
 *
 * The pipeline is fail-soft: a job that cannot progress parks in `waiting`
 * rather than erroring. Right for one submission, wrong in aggregate — the
 * queue accumulates work that will never produce anything (submission deleted,
 * dependency permanently failed, superseded by a re-run) while still occupying
 * worker slots. This page names that backlog and lets an admin clear it.
 *
 * Deleting is irreversible, so every destructive action is confirmed, and a job
 * a worker currently holds is excluded from bulk actions entirely.
 */
import { ref, computed, onMounted } from 'vue'
import jobAdminService from '@/services/job-admin.service'
import { useNotificationStore } from '@/stores/notification.store'
import SearchInput from '@/components/common/SearchInput.vue'

const notificationStore = useNotificationStore()

const loading = ref(true)
const working = ref(false)
const jobs = ref([])
const stats = ref({ total: 0, stale: 0, running: 0, byStatus: {}, byStaleReason: {} })
const meta = ref({ jobTypes: [], statuses: [], staleReasons: {}, thresholds: {} })

const filters = ref({ status: '', jobType: '', staleReason: '' })
// Queue entries whose job row is already gone. These CANNOT appear in the table
// below — it reads submission_jobs, and the row is exactly what was deleted —
// so they get their own counter and action.
const orphanedQueueCount = ref(0)
const search = ref('')
const selected = ref(new Set())

// Confirmation state — every destructive path funnels through one modal.
const confirmState = ref(null)

const STALE_LABELS = {
  orphaned: 'Submission deleted',
  superseded: 'Superseded by a re-run',
  stuck_waiting: 'Stuck waiting',
  stale_active: 'Stalled'
}

const STATUS_CLASSES = {
  waiting: 'bg-gray-100 text-gray-700',
  pending_input: 'bg-amber-100 text-amber-800',
  queued: 'bg-blue-100 text-blue-800',
  processing: 'bg-indigo-100 text-indigo-800',
  complete: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  cancelled: 'bg-gray-200 text-gray-600'
}

const visibleJobs = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return jobs.value
  return jobs.value.filter(j =>
    (j.manuscriptId || '').toLowerCase().includes(q)
    || (j.submissionTitle || '').toLowerCase().includes(q)
    || (j.submissionId || '').toLowerCase().includes(q)
    || (j.jobType || '').toLowerCase().includes(q)
  )
})

/** Only deletable rows can be selected, so bulk actions can never hit a running job. */
const selectableJobs = computed(() => visibleJobs.value.filter(j => j.deletable))
const allSelected = computed(() =>
  selectableJobs.value.length > 0 && selectableJobs.value.every(j => selected.value.has(j.id))
)
const selectedCount = computed(() => selected.value.size)

/** Stale groups that currently have members, for the one-click cleanup buttons. */
const cleanupGroups = computed(() =>
  Object.entries(stats.value.byStaleReason || {})
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({ reason, count, label: STALE_LABELS[reason] || reason }))
)

onMounted(async () => {
  try {
    meta.value = await jobAdminService.getMeta()
  } catch {
    // Non-fatal: the filter dropdowns fall back to whatever the rows contain.
  }
  await refresh()
})

async function refreshOrphanedQueue() {
  try {
    const { total } = await jobAdminService.listOrphanedQueue()
    orphanedQueueCount.value = total || 0
  } catch {
    orphanedQueueCount.value = 0
  }
}

function askPurgeOrphanedQueue() {
  confirmState.value = {
    title: `Cancel ${orphanedQueueCount.value} orphaned queue entr${orphanedQueueCount.value === 1 ? 'y' : 'ies'}?`,
    body: 'These are queued jobs whose submission was deleted. They cannot run — each attempt fails with "Submission not found" — and no LM call is made. Cancelling stops the retries.',
    confirmLabel: 'Cancel them',
    run: async () => {
      const result = await jobAdminService.purgeOrphanedQueue()
      return { deleted: result.cancelled, skipped: [] }
    }
  }
}

async function refresh() {
  loading.value = true
  try {
    const params = {}
    if (filters.value.status) params.status = filters.value.status
    if (filters.value.jobType) params.jobType = filters.value.jobType
    if (filters.value.staleReason) params.staleReason = filters.value.staleReason

    await refreshOrphanedQueue()
    const result = await jobAdminService.list(params)
    jobs.value = result.jobs || []
    stats.value = result.stats || stats.value
    // Drop selections for rows that are no longer listed.
    const live = new Set(jobs.value.map(j => j.id))
    selected.value = new Set([...selected.value].filter(id => live.has(id)))
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to load jobs')
  } finally {
    loading.value = false
  }
}

function toggleAll() {
  if (allSelected.value) {
    selected.value = new Set()
  } else {
    selected.value = new Set(selectableJobs.value.map(j => j.id))
  }
}

function toggleOne(job) {
  if (!job.deletable) return
  const next = new Set(selected.value)
  if (next.has(job.id)) next.delete(job.id)
  else next.add(job.id)
  selected.value = next
}

function askDeleteOne(job) {
  confirmState.value = {
    title: 'Delete this job?',
    body: `${job.jobType} for ${job.manuscriptId || job.submissionId}. Its queued work is cancelled too. This cannot be undone.`,
    confirmLabel: 'Delete job',
    run: () => jobAdminService.deleteJob(job.id)
  }
}

function askDeleteSelected() {
  const ids = [...selected.value]
  confirmState.value = {
    title: `Delete ${ids.length} job${ids.length === 1 ? '' : 's'}?`,
    body: 'Their queued work is cancelled too. This cannot be undone.',
    confirmLabel: `Delete ${ids.length}`,
    run: () => jobAdminService.bulkDelete(ids)
  }
}

function askCleanup(group) {
  confirmState.value = {
    title: `Delete ${group.count} "${group.label}" job${group.count === 1 ? '' : 's'}?`,
    body: `${meta.value.staleReasons?.[group.reason] || ''} Jobs that started running in the meantime are skipped. This cannot be undone.`,
    confirmLabel: `Delete ${group.count}`,
    run: () => jobAdminService.cleanupStale(group.reason)
  }
}

function askCancel(job) {
  confirmState.value = {
    title: 'Cancel this job?',
    body: `${job.jobType} for ${job.manuscriptId || job.submissionId}. The record is kept; the job stops and downstream steps stop waiting on it.`,
    confirmLabel: 'Cancel job',
    run: () => jobAdminService.cancelJob(job.id)
  }
}

async function runConfirmed() {
  if (!confirmState.value) return
  working.value = true
  try {
    const result = await confirmState.value.run()
    const deleted = result?.deleted
    if (typeof deleted === 'number') {
      const skipped = result.skipped?.length || 0
      notificationStore.success(
        `Deleted ${deleted} job${deleted === 1 ? '' : 's'}${skipped ? ` — ${skipped} skipped` : ''}`
      )
      if (skipped) {
        // Say WHY, rather than silently doing less than asked.
        notificationStore.info(result.skipped.map(s => s.reason).join(' '))
      }
    } else {
      notificationStore.success('Job cancelled')
    }
    selected.value = new Set()
    confirmState.value = null
    await refresh()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Action failed')
  } finally {
    working.value = false
  }
}

function formatAge(iso) {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ${min % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="flex items-center justify-between mb-2 flex-shrink-0">
      <h1 class="text-2xl font-bold text-gray-900">Processing Jobs</h1>
      <button class="btn-secondary" :disabled="loading" @click="refresh">
        {{ loading ? 'Refreshing…' : 'Refresh' }}
      </button>
    </div>
    <p class="text-sm text-gray-500 mb-4 flex-shrink-0">
      Every background job across all submissions. A job is flagged when it can no longer produce anything —
      its submission was deleted, a newer run replaced it, or it has been waiting far longer than its step
      should take. Deleting a job also cancels its queued work. A job a worker is running right now is
      protected from bulk actions.
    </p>

    <!-- Counters -->
    <div class="flex flex-wrap items-center gap-3 mb-4 flex-shrink-0">
      <div class="card !py-2 !px-4">
        <span class="text-xs text-gray-500 uppercase">Total</span>
        <span class="ml-2 font-semibold text-gray-900">{{ stats.total }}</span>
      </div>
      <div class="card !py-2 !px-4" :class="{ 'ring-1 ring-amber-300': stats.stale > 0 }">
        <span class="text-xs text-gray-500 uppercase">Not viable</span>
        <span class="ml-2 font-semibold" :class="stats.stale > 0 ? 'text-amber-700' : 'text-gray-900'">{{ stats.stale }}</span>
      </div>
      <div class="card !py-2 !px-4">
        <span class="text-xs text-gray-500 uppercase">Running</span>
        <span class="ml-2 font-semibold text-indigo-700">{{ stats.running }}</span>
      </div>

      <div v-if="orphanedQueueCount > 0" class="card !py-2 !px-4 ring-1 ring-red-300">
        <span class="text-xs text-gray-500 uppercase">Orphaned queue</span>
        <span class="ml-2 font-semibold text-red-700">{{ orphanedQueueCount }}</span>
        <button class="btn-secondary !py-0.5 !px-2 !text-xs ml-3" :disabled="working" @click="askPurgeOrphanedQueue">
          Cancel them
        </button>
      </div>

      <div v-if="cleanupGroups.length" class="flex flex-wrap items-center gap-2 ml-auto">
        <span class="text-xs text-gray-500 uppercase">Clean up</span>
        <button
          v-for="group in cleanupGroups"
          :key="group.reason"
          class="btn-secondary !py-1 !px-3 !text-xs"
          :disabled="working"
          v-tooltip="meta.staleReasons?.[group.reason]"
          @click="askCleanup(group)"
        >{{ group.label }} ({{ group.count }})</button>
      </div>
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap items-center gap-3 mb-4 flex-shrink-0">
      <select v-model="filters.status" class="input !py-1.5 !text-sm !w-auto" @change="refresh">
        <option value="">All statuses</option>
        <option v-for="s in meta.statuses" :key="s" :value="s">{{ s }}</option>
      </select>
      <select v-model="filters.jobType" class="input !py-1.5 !text-sm !w-auto" @change="refresh">
        <option value="">All modules</option>
        <option v-for="t in meta.jobTypes" :key="t" :value="t">{{ t }}</option>
      </select>
      <select v-model="filters.staleReason" class="input !py-1.5 !text-sm !w-auto" @change="refresh">
        <option value="">Viable and not viable</option>
        <option value="any">Not viable (any reason)</option>
        <option v-for="(desc, reason) in meta.staleReasons" :key="reason" :value="reason">
          {{ STALE_LABELS[reason] || reason }}
        </option>
      </select>
      <SearchInput v-model="search" placeholder="Search manuscript, module…" />

      <button
        v-if="selectedCount > 0"
        class="btn-danger !py-1.5 !px-3 !text-sm ml-auto"
        :disabled="working"
        @click="askDeleteSelected"
      >Delete {{ selectedCount }} selected</button>
    </div>

    <div v-if="loading" class="flex-1 flex items-center justify-center py-12">
      <svg class="animate-spin h-8 w-8 text-primary-600" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
    </div>

    <div v-else-if="visibleJobs.length === 0" class="flex-1 flex items-center justify-center py-12 text-gray-500">
      No jobs match these filters.
    </div>

    <div v-else class="card !p-0 flex-1 min-h-0 overflow-y-auto">
      <table class="min-w-full divide-y divide-gray-200">
        <thead class="bg-gray-50 sticky top-0 z-10">
          <tr>
            <th class="px-4 py-3 w-10">
              <input
                type="checkbox"
                :checked="allSelected"
                :disabled="selectableJobs.length === 0"
                @change="toggleAll"
              />
            </th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Submission</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Module</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Round</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Age</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Verdict</th>
            <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
          </tr>
        </thead>
        <tbody class="bg-white divide-y divide-gray-200">
          <tr
            v-for="job in visibleJobs"
            :key="job.id"
            :class="{ 'bg-amber-50': job.staleReason, 'bg-indigo-50': job.status === 'processing' }"
          >
            <td class="px-4 py-3">
              <input
                type="checkbox"
                :checked="selected.has(job.id)"
                :disabled="!job.deletable"
                v-tooltip="job.deletable ? '' : 'A worker is running this job'"
                @change="toggleOne(job)"
              />
            </td>
            <td class="px-4 py-3 text-sm">
              <div class="font-medium text-gray-900">{{ job.manuscriptId || '—' }}</div>
              <div class="text-xs text-gray-500 truncate max-w-xs" v-tooltip="job.submissionTitle || job.submissionId">
                {{ job.submissionExists ? (job.submissionTitle || job.submissionId) : 'Submission deleted' }}
              </div>
            </td>
            <td class="px-4 py-3 text-sm text-gray-700 font-mono text-xs">{{ job.jobType }}</td>
            <td class="px-4 py-3">
              <span class="px-2 py-0.5 rounded text-xs font-medium" :class="STATUS_CLASSES[job.status] || 'bg-gray-100 text-gray-700'">
                {{ job.status }}
              </span>
              <span v-if="job.retryCount > 0" class="ml-1 text-xs text-gray-500">retry {{ job.retryCount }}</span>
            </td>
            <td class="px-4 py-3 text-sm text-gray-700">{{ job.round }}</td>
            <td class="px-4 py-3 text-sm text-gray-700">{{ formatAge(job.updatedAt || job.createdAt) }}</td>
            <td class="px-4 py-3 text-sm">
              <span
                v-if="job.staleReason"
                class="px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800 cursor-help"
                v-tooltip="job.staleDescription"
              >{{ STALE_LABELS[job.staleReason] || job.staleReason }}</span>
              <span v-else class="text-xs text-gray-400">—</span>
              <div v-if="job.errorMessage" class="text-xs text-red-600 truncate max-w-xs mt-1" v-tooltip="job.errorMessage">
                {{ job.errorMessage }}
              </div>
            </td>
            <td class="px-4 py-3 text-right whitespace-nowrap">
              <button
                v-if="!['complete', 'failed', 'cancelled'].includes(job.status)"
                class="text-sm text-gray-600 hover:text-gray-900 mr-3"
                :disabled="working"
                @click="askCancel(job)"
              >Cancel</button>
              <button
                class="text-sm text-red-600 hover:text-red-800 disabled:text-gray-300"
                :disabled="working || !job.deletable"
                v-tooltip="job.deletable ? 'Delete this job' : 'A worker is running this job'"
                @click="askDeleteOne(job)"
              >Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Confirmation -->
    <div v-if="confirmState" class="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50" @click.self="confirmState = null">
      <div class="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
        <h2 class="text-lg font-semibold text-gray-900 mb-2">{{ confirmState.title }}</h2>
        <p class="text-sm text-gray-600 mb-6">{{ confirmState.body }}</p>
        <div class="flex justify-end gap-3">
          <button class="btn-secondary" :disabled="working" @click="confirmState = null">Keep it</button>
          <button class="btn-danger" :disabled="working" @click="runConfirmed">
            {{ working ? 'Working…' : confirmState.confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
