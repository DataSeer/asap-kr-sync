<script setup>
/**
 * PipelineView — the whole processing pipeline for one submission, as a graph.
 *
 * Laid out as columns of stages rather than a free-form graph. The pipeline is
 * already layered and the server computes those layers, so a layout algorithm
 * could only lose structure we know. It also means positions are the same on
 * every load, the whole thing stacks to one column on a phone, and a screen
 * reader gets an ordered list of stages instead of a picture.
 *
 * Arrows are drawn between STAGES, not between every pair of steps. PDF
 * Analysis waits on seven steps and Grounding on five; drawing all of them is
 * spaghetti in any layout. Each card lists its own inputs by name instead —
 * complete, and readable.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useRoute } from 'vue-router'
import { useJobPoller } from '@/composables'
import { outcomeStateOf } from '@/utils/job-status'
import configService from '@/services/config.service'
import jobService from '@/services/job.service'
import { labelFor, purposeFor, stageLabel, hasModulePage } from '@/components/modules/module-meta'
import SubmissionFileLinks from '@/components/modules/SubmissionFileLinks.vue'
import LoadError from '@/components/common/LoadError.vue'
import { describeLoadError } from '@/utils/load-error'
import { useSubmissionStore } from '@/stores/submission.store'
import { setSubmissionTitle } from '@/router'
import { useAuthStore } from '@/stores/auth.store'
import { useNotificationStore } from '@/stores/notification.store'
import { restartPlan } from '@/utils/restart-plan'
import { canRestartType } from '@/utils/restart-actions'
import RestartFromHereDialog from '@/components/submission/RestartFromHereDialog.vue'

const route = useRoute()
const submissionId = computed(() => route.params.id)
const authStore = useAuthStore()
const notificationStore = useNotificationStore()
const { jobs, inputs } = useJobPoller(submissionId)



/**
 * The submission, for the two file links and the tab title. Fetched here for
 * the same reason the module pages fetch it: this page is meant to be opened
 * on its own.
 */
const submissionStore = useSubmissionStore()
const submission = ref(null)
const latestFiles = ref({})

watch(submission, () => {
  const name = submission.value?.title || submission.value?.manuscriptId
  setSubmissionTitle(name ? `Pipeline · ${name}` : 'Pipeline')
}, { immediate: true })

const graph = ref({ nodes: [], stageCount: 0 })
// The page's whole content is the graph. Without it `stages` is empty and the
// template falls to its placeholder — so a failed request left "Loading the
// pipeline…" on screen forever, with nothing loading and no way to retry.
const loadError = ref(null)

onMounted(loadGraph)

async function loadGraph() {
  loadError.value = null
  submissionStore.fetchSubmission(submissionId.value).then((sub) => {
    submission.value = sub
    latestFiles.value = submissionStore.latestFiles || {}
  }).catch(() => { /* the links are simply absent */ })

  try {
    graph.value = await configService.getPipeline()
  } catch (err) {
    loadError.value = describeLoadError(err)
  }
}

/** Steps grouped into the stages the server computed. */
const stages = computed(() => {
  const out = []
  for (let i = 0; i < graph.value.stageCount; i++) {
    out.push({ index: i, label: stageLabel(i), nodes: graph.value.nodes.filter((n) => n.stage === i) })
  }
  return out
})

/** Gate names, in the words a reader can act on. */
const GATE_LABELS = {
  krt_curated: 'the Key Resources Table to be validated',
  markdown_ready: 'the manuscript to be converted to text',
  availability_ready: 'the Availability Statement step, and a statement to check'
}
const gateLabel = (name) => GATE_LABELS[name] || name

const jobFor = (jobType) => (jobs.value || {})[jobType] || null

// ── Restart from here ───────────────────────────────────────────────────────
// This page is the map of the pipeline, so it is where someone looking at a
// step that failed — or that ran before they replaced the manuscript — decides
// to run it again. Sending them into the module page first to find the button
// made the map a read-only thing.
//
// The dialog is the same one the module page uses: it names the steps whose
// results a restart replaces, what it keeps, and which documents come along.
const pendingRestart = ref(null)
const restarting = ref(false)

const canRestart = computed(() => authStore.canRestartJobs)

function askToRestart(jobType) {
  if (!canRestartType(jobType)) return
  pendingRestart.value = restartPlan(graph.value.nodes, jobType, labelFor)
}

// ── Choosing several ────────────────────────────────────────────────────────
// Restarting the five detectors one at a time is not the same as restarting
// them together, and it costs more: the first to finish releases grounding,
// which then runs and is thrown away by the next reset. Selecting them makes it
// one restart — the shared work runs once, after all of them.
//
// The other half of the point is what is NOT selected. "Restart from here" on
// their shared consumer would re-run every detector; picking two keeps the
// other three's results.
const selected = ref(new Set())

const selectedCount = computed(() => selected.value.size)

function toggleSelected(jobType) {
  // Replaced rather than mutated: a Set mutated in place is the same object, and
  // computeds reading it would not re-evaluate.
  const next = new Set(selected.value)
  if (next.has(jobType)) next.delete(jobType)
  else next.add(jobType)
  selected.value = next
}

const clearSelection = () => { selected.value = new Set() }

function askToRestartSelected() {
  if (!selected.value.size) return
  pendingRestart.value = restartPlan(graph.value.nodes, [...selected.value], labelFor)
}

async function confirmRestart() {
  const jobTypes = pendingRestart.value?.jobTypes || []
  if (!jobTypes.length) return
  restarting.value = true
  try {
    // One request for the whole selection, even when it is one step. The server
    // resets every selected step's downstream BEFORE enqueueing any of them —
    // which a loop of single restarts cannot do, because the first step can
    // finish and release the shared work before the second request arrives.
    const result = await jobService.restartProcesses(submissionId.value, jobTypes)
    // What the SERVER said: a restart asked for while a step is already running
    // is deliberately a no-op, and it says so rather than claiming a new run.
    notificationStore.info(result?.message || 'Re-started')
    pendingRestart.value = null
    clearSelection()
  } catch (err) {
    notificationStore.error(err.response?.data?.error || 'Could not restart those steps')
  } finally {
    restarting.value = false
  }
}

// ── What this round was processed from ──────────────────────────────────────
// Every step in a round reads one PDF, one converted manuscript and one KRT:
// the first step to need each freezes it, and the rest are handed the same one.
// That is what stops a file replaced mid-run from splitting a round in two.
//
// The consequence has to be said out loud, though. When the live document has
// moved on, the results on this page describe the older one — and without a
// note, an author reads an analysis of a manuscript they have already replaced
// as though it were about the current version.
const INPUT_LABELS = {
  pdf: 'manuscript PDF',
  markdown: 'converted manuscript',
  krt: 'Key Resources Table'
}
const staleInputs = computed(() => (inputs.value || []).filter((i) => i.stale))

function inputDetail(input) {
  const label = INPUT_LABELS[input.inputKind] || input.inputKind
  const detail = input.inputKind === 'krt'
    ? `${input.rowCount} rows when this ran, ${input.liveRowCount} now`
    : `version ${input.version} when this ran, version ${input.liveVersion} now`
  return `the ${label} has changed (${detail})`
}

// Assembled here rather than in the template: `v-for` with punctuation between
// the items leaves the whitespace of the source in the rendered sentence, and
// it showed as "112 now) ." on the page.
const staleSentence = computed(() =>
  `${staleInputs.value.map(inputDetail).join('; ')}.`
)

/**
 * The configuration this step RAN under — `off`, `demo`, or on.
 *
 * From the run's own frozen snapshot, never the live service status. A module
 * disabled during the run and switched on afterwards must still read as off
 * here, or the page claims it looked at the manuscript when it never ran.
 *
 * Returns null for a normal run: "on" is the unremarkable case and a badge on
 * every card would say nothing.
 */
function configOf(jobType) {
  const state = jobFor(jobType)?.result?.service?.config?.state
  if (state === 'off') return { text: 'was off', cls: 'pv-cfg-off' }
  if (state === 'demo') return { text: 'demo data', cls: 'pv-cfg-demo' }
  return null
}

/** Status as one word plus a colour, from the job if it has run. */
function statusOf(jobType) {
  const job = jobFor(jobType)
  if (!job || !job.status) return { text: 'not started', cls: 'st-idle' }
  // Read through outcomeStateOf: this page holds RAW API jobs, which carry
  // `result.service.outcome.state` and no flattened `outcomeState`. Reading the
  // flattened name here meant the check below never fired at all, and a step
  // whose service had failed rendered as a green "done".
  const outcome = outcomeStateOf(job)
  if (job.status === 'complete' && outcome === 'fail') return { text: 'failed', cls: 'st-fail' }
  // A completed step whose engine failed. Amber, like the processes panel —
  // this page and that one must not describe the same row differently.
  if (job.status === 'complete' && outcome === 'partial') return { text: 'partial', cls: 'st-partial' }
  const map = {
    complete: { text: 'done', cls: 'st-done' },
    processing: { text: 'running', cls: 'st-run' },
    queued: { text: 'queued', cls: 'st-wait' },
    waiting: { text: 'waiting', cls: 'st-wait' },
    pending_input: { text: 'needs input', cls: 'st-pending' },
    failed: { text: 'failed', cls: 'st-fail' },
    cancelled: { text: 'cancelled', cls: 'st-idle' }
  }
  return map[job.status] || { text: job.status, cls: 'st-idle' }
}

/**
 * What the step produced, in the terms that step deals in.
 *
 * Deliberately short — the card says whether there is anything to look at, and
 * the module's own page says what it is.
 */
function outputOf(jobType) {
  const r = jobFor(jobType)?.result
  if (!r) return null
  const c = r.counts || {}
  switch (jobType) {
    case 'krt_grounding': {
      const rows = c.authorRows || 0
      if (!rows) return 'no author KRT'
      const parts = [`${c.present || 0}/${rows} rows found in the text`]
      if (c.conflicts > 0) parts.push(`${c.conflicts} conflict${c.conflicts === 1 ? '' : 's'}`)
      return parts.join(' · ')
    }
    // The consolidator records `resources` (plus multiSource/contributors);
    // reading total/unique gave every submission "0 rows in the Generated KRT"
    // while its own page showed hundreds. total/unique are kept as a fallback
    // for older results.
    case 'pdf_analysis': return `${c.resources ?? c.total ?? c.unique ?? 0} rows in the Generated KRT`
    case 'suggestion_generation': return `${c.total || c.unique || 0} suggestions`
    case 'markdown_convert': return r.data?.markdownLength ? `${Math.round(r.data.markdownLength / 1024)} KB of text` : null
    case 'orcid_extraction': return `${c.authors || 0} authors, ${c.orcids || 0} ORCIDs`
    case 'das_extraction': return r.status?.detected ? 'statement found' : 'not found'
    case 'das_suggestions': {
      const applicable = c.unique || 0
      const total = c.total || 0
      if (!total) return 'no checks recorded'
      return applicable
        ? `${applicable} of ${total} checks need action`
        : `all ${total} checks passed`
    }
    default: {
      const n = c.unique ?? c.total
      return typeof n === 'number' ? `${n} found` : null
    }
  }
}

const conflictsFor = (jobType) => (jobType === 'krt_grounding' ? (jobFor(jobType)?.result?.counts?.conflicts || 0) : 0)


/** Which steps consume each step's output — the reverse of dependsOn. */
const consumersOf = computed(() => {
  const map = {}
  for (const n of graph.value.nodes) {
    for (const dep of n.dependsOn) (map[dep] = map[dep] || []).push(n.jobType)
  }
  return map
})

/**
 * Within a stage, steps that feed exactly the same downstream steps are one
 * group.
 *
 * That is what "does the same job" means structurally, and it needs no list to
 * maintain: the five detectors all feed Grounding and PDF Analysis, so they
 * cluster, while DAS Extraction sits in the same stage but feeds only PDF
 * Analysis and stays separate. Add a sixth detector to the orchestrator and it
 * joins the cluster on its own.
 */
function groupsForStage(nodes) {
  const by = new Map()
  for (const n of nodes) {
    const consumers = [...(consumersOf.value[n.jobType] || [])].sort()
    // A gated step gets its own group even when it shares a stage and an
    // (empty) consumer list with an ungated one: the caption says "N steps, in
    // parallel", and these do not run together — one waits for a stage the
    // other has already passed.
    const key = n.gates?.length ? `gated:${n.jobType}` : consumers.join('|')
    if (!by.has(key)) by.set(key, { key, consumers, nodes: [] })
    by.get(key).nodes.push(n)
  }
  // Biggest cluster first, so the parallel block reads before the one-offs.
  return [...by.values()].sort((a, b) => b.nodes.length - a.nodes.length)
}

/** Where the pipeline currently is, in one line. */
const state = computed(() => {
  // Every step counts here: this page describes the whole run, and a step that
  // has not run yet is exactly what a reader wants to see. (The KRT and PDF
  // steps' own "all finished" gates are the ones that must ignore a step parked
  // behind a later stage — see isFutureStepJob.)
  const nodes = graph.value.nodes
  const tally = { done: 0, running: 0, waiting: 0, failed: 0, pending: 0, partial: 0, idle: 0 }
  for (const n of nodes) {
    const cls = statusOf(n.jobType).cls
    if (cls === 'st-done') tally.done++
    else if (cls === 'st-run') tally.running++
    else if (cls === 'st-fail') tally.failed++
    else if (cls === 'st-pending') tally.pending++
    else if (cls === 'st-partial') tally.partial++
    else if (cls === 'st-wait') tally.waiting++
    else tally.idle++
  }
  return { ...tally, total: nodes.length }
})

/** The first stage that has not finished — where the work actually is now. */
const activeStage = computed(() => {
  for (const stage of stages.value) {
    // 'partial' counts as finished here: the step has run and will not run
    // again on its own, so treating it as outstanding would peg "where the work
    // is now" to a stage nothing is working on.
    const unfinished = (n) => !['st-done', 'st-partial'].includes(statusOf(n.jobType).cls)
    if (stage.nodes.some(unfinished)) return stage.index
  }
  return -1
})
</script>

<template>
  <div class="pv">
    <div class="pv-head">
      <!-- To the submission, not to a step. `submission-detail` redirects to
           whichever step the submission is actually on, so this stays right as
           the author moves through them — pinning it to the PDF step sent
           someone on the Availability step backwards. -->
      <RouterLink :to="{ name: 'submission-detail', params: { id: submissionId } }" class="pv-back">
        ← Back to the submission
      </RouterLink>
      <h1 class="pv-title">Processing pipeline</h1>
      <SubmissionFileLinks
        class="pv-files-links"
        :submission-id="submissionId"
        :files="latestFiles"
      />
    </div>

    <p class="pv-intro">
      The manuscript flows down this page. Each step waits until everything above it that
      it depends on has finished, so a step sitting idle is usually waiting rather than broken.
      Steps shown side by side run at the same time.
    </p>

    <!-- Said before any result is shown, because it changes what they mean. -->
    <div v-if="staleInputs.length" class="pv-stale" role="status">
      <svg class="pv-stale-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <div class="pv-stale-body">
        <p class="pv-stale-title">This analysis used an earlier version of your data</p>
        <p class="pv-stale-sub">
          {{ staleSentence }} Restart a step to run it against what is there now.
        </p>
      </div>
    </div>

    <!-- What the selection will do, while it is being built. Sticky, because
         the steps being picked are spread down a long page and a count you have
         to scroll to find is a count you stop trusting. -->
    <div v-if="selectedCount" class="pv-selbar" role="status">
      <span class="pv-selbar-count">
        <strong>{{ selectedCount }}</strong>
        {{ selectedCount === 1 ? 'step selected' : 'steps selected' }}
      </span>
      <span class="pv-selbar-hint">their shared later steps run once, after all of them</span>
      <button type="button" class="pv-selbar-clear" @click="clearSelection">Clear</button>
      <button type="button" class="pv-selbar-go" @click="askToRestartSelected">
        ⟳ Restart {{ selectedCount === 1 ? 'it' : 'them' }}
      </button>
    </div>

    <!-- Where the pipeline is right now, before any of the detail. -->
    <div v-if="graph.nodes.length" class="pv-state">
      <span class="pv-state-item"><b>{{ state.done }}</b> of {{ state.total }} done</span>
      <span v-if="state.running" class="pv-state-item st-run">{{ state.running }} running</span>
      <span v-if="state.pending" class="pv-state-item st-pending">{{ state.pending }} needs input</span>
      <span v-if="state.waiting" class="pv-state-item st-wait">{{ state.waiting }} waiting</span>
      <span v-if="state.partial" class="pv-state-item st-partial">{{ state.partial }} partly complete</span>
      <span v-if="state.failed" class="pv-state-item st-fail">{{ state.failed }} failed</span>
    </div>

    <LoadError
      v-if="loadError"
      title="The pipeline could not be loaded"
      :message="loadError.message"
      :retryable="loadError.retryable"
      @retry="loadGraph"
    />

    <div v-else-if="!stages.length" class="pv-empty">Loading the pipeline…</div>

    <ol v-else class="pv-flow">
      <li
        v-for="(stage, si) in stages"
        :key="stage.index"
        class="pv-band"
        :class="{ 'pv-band-active': stage.index === activeStage }"
      >
        <div class="pv-band-label">
          <span class="pv-stage-num">{{ si + 1 }}</span>
          <span>{{ stage.label }}</span>
          <span v-if="stage.index === activeStage" class="pv-here">← here now</span>
        </div>

        <div class="pv-groups">
          <div
            v-for="group in groupsForStage(stage.nodes)"
            :key="group.key"
            class="pv-group"
            :class="{ 'pv-group-boxed': group.nodes.length > 1 }"
          >
            <!-- Only a real cluster gets a caption; a lone step does not need
                 telling that it runs by itself. -->
            <p v-if="group.nodes.length > 1" class="pv-group-caption">
              {{ group.nodes.length }} steps, in parallel
              <span v-if="group.consumers.length">→ {{ group.consumers.map(labelFor).join(', ') }}</span>
            </p>

            <div class="pv-cards">
              <component
                :is="hasModulePage(node.jobType) ? 'RouterLink' : 'div'"
                v-for="node in group.nodes"
                :key="node.jobType"
                :to="hasModulePage(node.jobType)
                  ? { name: 'submission-module', params: { id: submissionId, type: node.jobType } }
                  : undefined"
                class="pv-card"
                :class="{ 'pv-card-link': hasModulePage(node.jobType) }"
              >
                <div class="pv-card-head">
                  <span class="pv-card-name">{{ labelFor(node.jobType) }}</span>
                  <!-- Without this, a step that was switched off during the run
                       is indistinguishable from one that ran and found nothing. -->
                  <span
                    v-if="configOf(node.jobType)"
                    class="pv-cfg"
                    :class="configOf(node.jobType).cls"
                    v-tooltip="'The configuration this step ran under, as recorded by the run itself — not the current setting.'"
                  >{{ configOf(node.jobType).text }}</span>
                  <span class="pv-status" :class="statusOf(node.jobType).cls">{{ statusOf(node.jobType).text }}</span>
                </div>

                <p class="pv-purpose">{{ purposeFor(node.jobType) }}</p>

                <dl class="pv-io">
                  <dt>in</dt>
                  <dd v-if="node.dependsOn.length">{{ node.dependsOn.map(labelFor).join(' · ') }}</dd>
                  <dd v-else class="pv-muted">the submission itself</dd>
                  <template v-if="outputOf(node.jobType)">
                    <dt>out</dt>
                    <dd>{{ outputOf(node.jobType) }}</dd>
                  </template>
                </dl>

                <div class="pv-card-foot">
                  <span v-if="conflictsFor(node.jobType) > 0" class="pv-conflicts">
                    ⚠ {{ conflictsFor(node.jobType) }} conflict{{ conflictsFor(node.jobType) === 1 ? '' : 's' }}
                  </span>
                  <span
                    v-if="node.gates?.length"
                    class="pv-gate"
                    v-tooltip="'Waits for: ' + node.gates.map(gateLabel).join(', ')"
                  >gated</span>
                  <span v-if="!node.autoAdvances" class="pv-gate" v-tooltip="'Can pause and wait for you before it runs.'">may pause</span>
                  <span v-if="hasModulePage(node.jobType)" class="pv-open">open ↗</span>
                  <!-- Inside a card that is itself a link, so the click must be
                       stopped AND prevented: without both, restarting a step
                       also navigates away from the page you wanted to watch it
                       from. -->
                  <button
                    v-if="canRestart && canRestartType(node.jobType)"
                    type="button"
                    class="pv-restart"
                    v-tooltip="'Run this step again — and everything that depends on it'"
                    @click.stop.prevent="askToRestart(node.jobType)"
                  >
                    ⟳ Restart from here
                  </button>
                  <!-- Ticking is not restarting: it builds a selection that one
                       button then restarts together. Same click-swallowing as
                       the button — the card is a link. -->
                  <label
                    v-if="canRestart && canRestartType(node.jobType)"
                    class="pv-pick"
                    v-tooltip="'Include this step in a restart of several'"
                    @click.stop.prevent="toggleSelected(node.jobType)"
                  >
                    <input type="checkbox" :checked="selected.has(node.jobType)" tabindex="-1" />
                    <span>pick</span>
                  </label>
                </div>
              </component>
            </div>
          </div>
        </div>

        <div v-if="si < stages.length - 1" class="pv-down" aria-hidden="true">↓</div>
      </li>
    </ol>
  </div>

    <RestartFromHereDialog
      :plan="pendingRestart"
      :busy="restarting"
      @confirm="confirmRestart"
      @cancel="pendingRestart = null"
    />
</template>

<style scoped>
.pv { padding: 1.25rem 1.5rem 3rem; }
.pv-files-links { margin-left: auto; }
.pv-files { margin-bottom: 0.5rem; }
.pv-head { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
.pv-back { font-size: 0.8rem; color: #2563eb; text-decoration: none; }
.pv-back:hover { text-decoration: underline; }
.pv-title { font-size: 1.25rem; font-weight: 600; color: #111827; margin: 0; }
.pv-intro { color: #6b7280; font-size: 0.85rem; margin: 0.5rem 0 1rem; max-width: 60rem; }
.pv-empty { color: #9ca3af; font-size: 0.9rem; }

.pv-state { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 1.5rem; }
.pv-state-item {
  font-size: 0.72rem; padding: 0.15rem 0.5rem; border-radius: 0.3rem;
  background: #f3f4f6; color: #4b5563;
}

/* Top to bottom: the manuscript flows down the page, and an ordered list is
   what this actually is — which a screen reader then reads correctly. */
.pv-flow { list-style: none; margin: 0; padding: 0; max-width: 74rem; display: flex; flex-direction: column; gap: 0.35rem; }
/* The band is the GROUND, the cards sit on it. White cards on a white band
   left the borders with nothing to separate — everything read as one block. */
.pv-band { position: relative; padding: 0.75rem 0.9rem; border-radius: 0.5rem; background: #f4f5f7; }
.pv-band + .pv-band { margin-top: 0; }
.pv-band-active { background: #eaf2fd; }
.pv-band-label {
  display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.6rem;
  font-size: 0.7rem; font-weight: 700; color: #6b7280;
  text-transform: uppercase; letter-spacing: 0.05em;
}
.pv-stage-num {
  display: inline-flex; align-items: center; justify-content: center;
  width: 1.15rem; height: 1.15rem; border-radius: 50%;
  background: #e5e7eb; color: #4b5563; font-size: 0.62rem;
}
.pv-here { color: #1d4ed8; text-transform: none; letter-spacing: 0; font-weight: 600; }
.pv-down { text-align: center; color: #d1d5db; font-size: 1.2rem; line-height: 1; margin: 0.35rem 0 0; }

.pv-groups { display: flex; flex-wrap: wrap; gap: 0.85rem; align-items: flex-start; }
.pv-group { flex: 1 1 16rem; }
/* A cluster is boxed so "these run together" is visible before reading names. */
.pv-group-boxed {
  flex: 2 1 34rem; border: 1px dashed #c3c7ce; border-radius: 0.5rem;
  padding: 0.5rem 0.55rem 0.6rem; background: #fbfbfc;
}
.pv-group-caption { font-size: 0.68rem; color: #9ca3af; margin: 0 0 0.45rem; }
.pv-cards { display: flex; flex-wrap: wrap; gap: 0.6rem; }

.pv-card {
  display: block; text-decoration: none; color: inherit; flex: 1 1 15rem;
  border: 1px solid #d1d5db; border-radius: 0.5rem; background: #fff;
  padding: 0.6rem 0.7rem;
  /* A hairline shadow does more than a darker border here: it separates two
     adjacent cards even where their edges touch. */
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
}
.pv-card-link { cursor: pointer; }
.pv-card-link:hover { border-color: #60a5fa; box-shadow: 0 2px 6px rgba(37, 99, 235, 0.12); }
.pv-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
.pv-card-name { font-size: 0.82rem; font-weight: 600; color: #111827; }
.pv-purpose { font-size: 0.72rem; color: #6b7280; line-height: 1.35; margin: 0.3rem 0 0.45rem; }

.pv-io { display: grid; grid-template-columns: 1.6rem 1fr; gap: 0.1rem 0.4rem; margin: 0; font-size: 0.7rem; }
.pv-io dt { color: #9ca3af; font-weight: 600; }
.pv-io dd { margin: 0; color: #4b5563; line-height: 1.3; }
.pv-muted { color: #9ca3af; }

.pv-card-foot { display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; margin-top: 0.5rem; }
.pv-open { margin-left: auto; font-size: 0.68rem; color: #2563eb; }
.pv-conflicts {
  padding: 0 0.3rem; border-radius: 0.25rem; font-size: 0.66rem; font-weight: 600;
  background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca;
}
.pv-manual {
  padding: 0.05rem 0.4rem;
  border-radius: 0.25rem;
  font-size: 0.68rem;
  font-weight: 600;
  background: #eef2ff;
  color: #4338ca;
  border: 1px solid #c7d2fe;
  cursor: help;
}
.pv-gate {
  padding: 0 0.3rem; border-radius: 0.25rem; font-size: 0.66rem;
  background: #f3f4f6; color: #6b7280; border: 1px solid #e5e7eb;
}

.pv-status { font-size: 0.66rem; font-weight: 600; padding: 0 0.3rem; border-radius: 0.25rem; white-space: nowrap; }
/* The same palette the processes panel uses. A step that reads "waiting" in
   gold there and grey here is the same fact told twice in two colours. */
.st-done { background: #d1fae5; color: #047857; }
.st-run { background: #dbeafe; color: #1d4ed8; }
.st-wait { background: #fef3c7; color: #92400e; }
.st-pending { background: #ffedd5; color: #c2410c; }
.pv-cfg {
  padding: 0.0625rem 0.375rem;
  border-radius: 999px;
  font-size: 0.625rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.pv-cfg-off { background: #f3f4f6; color: #4b5563; }
.pv-cfg-demo { background: #ede9fe; color: #6d28d9; }

.st-partial { background: #fef3c7; color: #92400e; }
.st-fail { background: #fee2e2; color: #b91c1c; }
.st-idle { background: #f3f4f6; color: #6b7280; }

@media (max-width: 700px) {
  .pv-group, .pv-group-boxed { flex: 1 1 100%; }
  .pv-card { flex: 1 1 100%; }
}

/* Said plainly rather than styled as an error: nothing has gone wrong, the
   results simply describe a document that is no longer the current one. */
.pv-stale {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  margin: 0 0 1rem;
  padding: 0.75rem 0.9rem;
  border: 1px solid #fcd34d;
  border-left: 4px solid #f59e0b;
  border-radius: 0.5rem;
  background: #fffbeb;
}
.pv-stale-icon { width: 1.1rem; height: 1.1rem; flex-shrink: 0; margin-top: 0.1rem; color: #b45309; }
.pv-stale-body { min-width: 0; }
.pv-stale-title { font-weight: 600; color: #78350f; font-size: 0.9rem; }
.pv-stale-sub { margin-top: 0.15rem; font-size: 0.82rem; color: #92400e; }

/* Restart, on the card it restarts. Quiet until hovered — the page is a map
   first, and an action on every tile competes with reading it. */
.pv-restart {
  margin-left: auto;
  padding: 0.1rem 0.4rem;
  border: 1px solid #e5e7eb;
  border-radius: 0.25rem;
  background: #fff;
  color: #6b7280;
  font-size: 0.62rem;
  font-weight: 600;
  white-space: nowrap;
}
.pv-restart:hover { border-color: #93c5fd; color: #1d4ed8; background: #eff6ff; }

/* Pick + selection bar */
.pv-pick {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  padding: 0.1rem 0.35rem;
  border: 1px solid #e5e7eb;
  border-radius: 0.25rem;
  background: #fff;
  color: #6b7280;
  font-size: 0.62rem;
  font-weight: 600;
  cursor: pointer;
}
.pv-pick:hover { border-color: #93c5fd; color: #1d4ed8; }
.pv-pick input { width: 0.7rem; height: 0.7rem; pointer-events: none; }

.pv-selbar {
  position: sticky;
  top: 0.5rem;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid #bfdbfe;
  border-radius: 0.5rem;
  background: #eff6ff;
  box-shadow: 0 1px 3px rgba(37, 99, 235, 0.1);
}
.pv-selbar-count { font-size: 0.85rem; color: #1e3a8a; }
.pv-selbar-hint { flex: 1; min-width: 0; font-size: 0.78rem; color: #3b82f6; }
.pv-selbar-clear {
  padding: 0.25rem 0.6rem; border-radius: 0.3rem;
  border: 1px solid #bfdbfe; background: #fff; color: #1d4ed8;
  font-size: 0.78rem; font-weight: 500;
}
.pv-selbar-go {
  padding: 0.25rem 0.7rem; border-radius: 0.3rem;
  background: #2563eb; color: #fff; font-size: 0.78rem; font-weight: 600;
}
.pv-selbar-go:hover { background: #1d4ed8; }
</style>
