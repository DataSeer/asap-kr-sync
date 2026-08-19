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
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useRoute } from 'vue-router'
import { useJobPoller } from '@/composables'
import configService from '@/services/config.service'
import { labelFor, purposeFor, stageLabel } from '@/components/modules/module-meta'

const route = useRoute()
const submissionId = computed(() => route.params.id)
const { jobs } = useJobPoller(submissionId)

const graph = ref({ nodes: [], stageCount: 0 })
onMounted(async () => {
  try {
    graph.value = await configService.getPipeline()
  } catch {
    // The page degrades to empty rather than erroring; the processes panel on
    // the submission still works.
  }
})

/** Steps grouped into the stages the server computed. */
const stages = computed(() => {
  const out = []
  for (let i = 0; i < graph.value.stageCount; i++) {
    out.push({ index: i, label: stageLabel(i), nodes: graph.value.nodes.filter((n) => n.stage === i) })
  }
  return out
})

const jobFor = (jobType) => (jobs.value || {})[jobType] || null

/** Status as one word plus a colour, from the job if it has run. */
function statusOf(jobType) {
  const job = jobFor(jobType)
  if (!job || !job.status) return { text: 'not started', cls: 'st-idle' }
  if (job.status === 'complete' && job.outcomeState === 'fail') return { text: 'failed', cls: 'st-fail' }
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
    case 'pdf_analysis': return `${c.total || c.unique || 0} rows in the Generated KRT`
    case 'suggestion_generation': return `${c.total || c.unique || 0} suggestions`
    case 'markdown_convert': return r.data?.markdownLength ? `${Math.round(r.data.markdownLength / 1024)} KB of text` : null
    case 'orcid_extraction': return `${c.authors || 0} authors, ${c.orcids || 0} ORCIDs`
    case 'das_extraction': return r.status?.detected ? 'statement found' : 'not found'
    default: {
      const n = c.unique ?? c.total
      return typeof n === 'number' ? `${n} found` : null
    }
  }
}

const conflictsFor = (jobType) => (jobType === 'krt_grounding' ? (jobFor(jobType)?.result?.counts?.conflicts || 0) : 0)

/** Only krt_grounding has a page so far; a link to an empty one is worse than none. */
const HAS_PAGE = new Set(['krt_grounding'])

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
    const key = consumers.join('|')
    if (!by.has(key)) by.set(key, { key, consumers, nodes: [] })
    by.get(key).nodes.push(n)
  }
  // Biggest cluster first, so the parallel block reads before the one-offs.
  return [...by.values()].sort((a, b) => b.nodes.length - a.nodes.length)
}

/** Where the pipeline currently is, in one line. */
const state = computed(() => {
  const nodes = graph.value.nodes
  const tally = { done: 0, running: 0, waiting: 0, failed: 0, pending: 0, idle: 0 }
  for (const n of nodes) {
    const cls = statusOf(n.jobType).cls
    if (cls === 'st-done') tally.done++
    else if (cls === 'st-run') tally.running++
    else if (cls === 'st-fail') tally.failed++
    else if (cls === 'st-pending') tally.pending++
    else if (cls === 'st-wait') tally.waiting++
    else tally.idle++
  }
  return { ...tally, total: nodes.length }
})

/** The first stage that has not finished — where the work actually is now. */
const activeStage = computed(() => {
  for (const stage of stages.value) {
    if (stage.nodes.some((n) => statusOf(n.jobType).cls !== 'st-done')) return stage.index
  }
  return -1
})
</script>

<template>
  <div class="pv">
    <div class="pv-head">
      <RouterLink :to="{ name: 'submission-pdf', params: { id: submissionId } }" class="pv-back">
        ← Back to the submission
      </RouterLink>
      <h1 class="pv-title">Processing pipeline</h1>
    </div>

    <p class="pv-intro">
      The manuscript flows down this page. Each step waits until everything above it that
      it depends on has finished, so a step sitting idle is usually waiting rather than broken.
      Steps shown side by side run at the same time.
    </p>

    <!-- Where the pipeline is right now, before any of the detail. -->
    <div v-if="graph.nodes.length" class="pv-state">
      <span class="pv-state-item"><b>{{ state.done }}</b> of {{ state.total }} done</span>
      <span v-if="state.running" class="pv-state-item st-run">{{ state.running }} running</span>
      <span v-if="state.pending" class="pv-state-item st-pending">{{ state.pending }} needs input</span>
      <span v-if="state.waiting" class="pv-state-item st-wait">{{ state.waiting }} waiting</span>
      <span v-if="state.failed" class="pv-state-item st-fail">{{ state.failed }} failed</span>
    </div>

    <div v-if="!stages.length" class="pv-empty">Loading the pipeline…</div>

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
                :is="HAS_PAGE.has(node.jobType) ? 'RouterLink' : 'div'"
                v-for="node in group.nodes"
                :key="node.jobType"
                :to="HAS_PAGE.has(node.jobType)
                  ? { name: 'submission-module', params: { id: submissionId, type: node.jobType } }
                  : undefined"
                class="pv-card"
                :class="{ 'pv-card-link': HAS_PAGE.has(node.jobType) }"
              >
                <div class="pv-card-head">
                  <span class="pv-card-name">{{ labelFor(node.jobType) }}</span>
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
                  <span v-if="node.gate" class="pv-gate" :title="'Waits for a condition on the submission: ' + node.gate">gated</span>
                  <span v-if="!node.autoAdvances" class="pv-gate" title="Can pause and wait for you before it runs.">may pause</span>
                  <span v-if="HAS_PAGE.has(node.jobType)" class="pv-open">open ↗</span>
                </div>
              </component>
            </div>
          </div>
        </div>

        <div v-if="si < stages.length - 1" class="pv-down" aria-hidden="true">↓</div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.pv { padding: 1.25rem 1.5rem 3rem; }
.pv-head { display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
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
.pv-gate {
  padding: 0 0.3rem; border-radius: 0.25rem; font-size: 0.66rem;
  background: #f3f4f6; color: #6b7280; border: 1px solid #e5e7eb;
}

.pv-status { font-size: 0.66rem; font-weight: 600; padding: 0 0.3rem; border-radius: 0.25rem; white-space: nowrap; }
.st-done { background: #ecfdf5; color: #047857; }
.st-run { background: #eff6ff; color: #1d4ed8; }
.st-wait { background: #f3f4f6; color: #6b7280; }
.st-pending { background: #fffbeb; color: #b45309; }
.st-fail { background: #fef2f2; color: #b91c1c; }
.st-idle { background: #f9fafb; color: #9ca3af; }

@media (max-width: 700px) {
  .pv-group, .pv-group-boxed { flex: 1 1 100%; }
  .pv-card { flex: 1 1 100%; }
}
</style>
