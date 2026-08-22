<script setup>
/**
 * Everything about this round that needs a person, wherever they happen to be.
 *
 * The same list on five surfaces: the PDF step, the Availability step, the
 * pipeline, a module's own page, and read-only anywhere else. One component,
 * because the alternative is five renderings of the same rules that drift — the
 * pipeline page once asked for a field the API never sent and drew failed steps
 * as green ticks for weeks.
 *
 * It renders; it does not decide. The server computes the list, what each issue
 * is holding, and what carrying on would cost, so nothing here can disagree
 * with what the pipeline will actually do.
 *
 * ── The four cases ──────────────────────────────────────────────────────────
 *
 *   no error, results         → not an issue, never appears here
 *   no error, nothing found   → not an issue either. A detector finding nothing
 *                               IS an answer, and a common one
 *   partial error             → appears; the run is real but incomplete
 *   total error               → appears; there is nothing to build on
 */
import { computed, ref } from 'vue'
import { labelFor } from '@/components/modules/module-meta'
import jobService from '@/services/job.service'
import { useNotificationStore } from '@/stores/notification.store'

const props = defineProps({
  submissionId: { type: String, required: true },
  /** From `useJobPoller().issues` — the server's list, rendered as given. */
  issues: { type: Array, default: () => [] },
  /**
   * Whether this surface may DECIDE.
   *
   * The PDF, Availability, pipeline and module pages can; everywhere else shows
   * the same thing and offers no buttons. A page that reports a problem it
   * cannot help with is still worth having — it is how someone finds out.
   */
  actionable: { type: Boolean, default: false },
  /** Step pages get the short form; the pipeline page gets the full one. */
  compact: { type: Boolean, default: false }
})

const emit = defineEmits(['resolved'])

const notificationStore = useNotificationStore()
const busy = ref(null)

/** Undecided issues are what a user still has to act on. */
const open = computed(() => props.issues.filter((i) => !i.decided))

/** Decided ones stay visible on the full view: they explain the result. */
const settled = computed(() => props.issues.filter((i) => i.decided))

const KIND_TITLE = {
  failure: 'failed',
  unusable: 'produced nothing usable',
  partial: 'ran with a problem'
}

const titleFor = (issue) => `${labelFor(issue.jobType)} ${KIND_TITLE[issue.kind] || 'needs a decision'}`

/**
 * What carrying on would cost, in the words of this particular issue.
 *
 * Three genuinely different situations, and a user cannot choose sensibly
 * without being told which one they are in.
 */
function consequenceOf(issue) {
  if (issue.wouldSkip.length) {
    return `${issue.wouldSkip.map(labelFor).join(', ')} cannot run without it and will be skipped.`
  }
  if (issue.holding.length) {
    return `${issue.holding.length} later ${issue.holding.length === 1 ? 'step' : 'steps'} `
      + 'will run with less to work from.'
  }
  return 'Nothing is waiting on it.'
}

async function act(issue, action) {
  if (busy.value) return
  busy.value = `${issue.jobType}:${action}`
  try {
    const result = action === 'retry'
      ? await jobService.retryJob(props.submissionId, issue.jobType)
      : await jobService.continueWithout(props.submissionId, issue.jobType)
    notificationStore.info(result?.message || 'Done')
    emit('resolved', { jobType: issue.jobType, action })
  } catch (err) {
    notificationStore.error(err.response?.data?.error || 'That did not work')
  } finally {
    busy.value = null
  }
}

/**
 * Carry on past everything at once.
 *
 * Three degraded detectors is three questions blocking the same steps, asked in
 * the situation where the user is already annoyed. One press, still recorded
 * against each step individually so the record stays precise about what was
 * decided and when.
 */
async function continueAll() {
  if (busy.value) return
  busy.value = 'all'
  const failures = []
  try {
    for (const issue of open.value) {
      try {
        await jobService.continueWithout(props.submissionId, issue.jobType)
      } catch {
        failures.push(labelFor(issue.jobType))
      }
    }
    if (failures.length) notificationStore.error(`Could not continue past ${failures.join(', ')}`)
    else notificationStore.info('Continuing')
    emit('resolved', { action: 'continue-all' })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div v-if="open.length || (!compact && settled.length)" class="pi">
    <div v-if="open.length" class="pi-block" role="alert">
      <div class="pi-head">
        <svg class="pi-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
        <p class="pi-title">
          <template v-if="open.some((i) => i.blocking)">
            The pipeline is paused
          </template>
          <template v-else>Something needs your attention</template>
          <template v-if="open.length > 1"> — {{ open.length }} things</template>
        </p>
        <button
          v-if="actionable && open.length > 1"
          type="button"
          class="pi-all"
          :disabled="!!busy"
          @click="continueAll"
        >
          {{ busy === 'all' ? 'Continuing…' : 'Continue past all' }}
        </button>
      </div>

      <ul class="pi-list">
        <li v-for="issue in open" :key="issue.jobType" class="pi-item">
          <div class="pi-item-text">
            <p class="pi-item-title">{{ titleFor(issue) }}</p>
            <p v-if="issue.detail" class="pi-item-detail">{{ issue.detail }}</p>
            <p class="pi-item-consequence">{{ consequenceOf(issue) }}</p>
          </div>
          <div v-if="actionable" class="pi-actions">
            <button
              type="button"
              class="pi-retry"
              :disabled="!!busy"
              @click="act(issue, 'retry')"
            >
              {{ busy === `${issue.jobType}:retry` ? 'Starting…' : 'Retry' }}
            </button>
            <button
              type="button"
              class="pi-continue"
              :disabled="!!busy"
              @click="act(issue, 'continue')"
            >
              {{ busy === `${issue.jobType}:continue` ? 'Continuing…' : 'Continue' }}
            </button>
          </div>
        </li>
      </ul>
    </div>

    <!-- Decisions already made. Kept in view on the full form because they
         explain the result underneath: a report built without software
         detection looks exactly like one where software detection found
         nothing, and this is the only thing that tells them apart. -->
    <p v-if="!compact && settled.length" class="pi-settled">
      <template v-for="(issue, i) in settled" :key="issue.jobType">
        <template v-if="i">; </template>
        carried on without <strong>{{ labelFor(issue.jobType) }}</strong>
        <template v-if="issue.decided.byName"> ({{ issue.decided.byName }})</template>
      </template>
    </p>
  </div>
</template>

<style scoped>
.pi-block {
  border: 1px solid #fca5a5;
  border-left: 4px solid #dc2626;
  border-radius: 0.5rem;
  background: #fef2f2;
  padding: 0.75rem 0.9rem;
  margin-bottom: 1rem;
}
.pi-head { display: flex; align-items: center; gap: 0.6rem; }
.pi-icon { width: 1.15rem; height: 1.15rem; flex-shrink: 0; color: #b91c1c; }
.pi-title { flex: 1; min-width: 0; font-weight: 600; color: #7f1d1d; font-size: 0.92rem; }
.pi-all {
  padding: 0.25rem 0.7rem; border-radius: 0.3rem;
  border: 1px solid #fca5a5; background: #fff; color: #b91c1c;
  font-size: 0.78rem; font-weight: 600; white-space: nowrap;
}
.pi-all:hover:not(:disabled) { background: #fee2e2; }

.pi-list { margin: 0.5rem 0 0; padding: 0; list-style: none; }
.pi-item {
  display: flex; align-items: flex-start; gap: 0.75rem;
  padding: 0.4rem 0; border-top: 1px solid #fecaca;
}
.pi-item:first-child { border-top: 0; }
.pi-item-text { flex: 1; min-width: 0; }
.pi-item-title { font-size: 0.86rem; font-weight: 600; color: #991b1b; }
.pi-item-detail {
  font-size: 0.78rem; color: #b91c1c; font-family: ui-monospace, monospace;
  overflow-wrap: anywhere;
}
.pi-item-consequence { font-size: 0.78rem; color: #b91c1c; }

.pi-actions { display: flex; gap: 0.35rem; flex-shrink: 0; }
.pi-retry, .pi-continue {
  padding: 0.25rem 0.65rem; border-radius: 0.3rem;
  font-size: 0.78rem; font-weight: 600; white-space: nowrap;
}
.pi-retry { background: #b91c1c; color: #fff; }
.pi-retry:hover:not(:disabled) { background: #991b1b; }
.pi-continue { border: 1px solid #fca5a5; background: #fff; color: #b91c1c; }
.pi-continue:hover:not(:disabled) { background: #fee2e2; }
.pi-retry:disabled, .pi-continue:disabled, .pi-all:disabled { opacity: 0.6; cursor: not-allowed; }

.pi-settled {
  margin-bottom: 1rem;
  padding: 0.5rem 0.7rem;
  border-radius: 0.375rem;
  background: #f3f4f6;
  font-size: 0.8rem;
  color: #4b5563;
}
</style>
