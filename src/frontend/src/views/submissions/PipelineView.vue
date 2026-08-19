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
      Each step reads what the steps before it produced. A step waits until everything it
      depends on has finished, so a stalled step is usually waiting rather than broken.
    </p>

    <div v-if="!stages.length" class="pv-empty">Loading the pipeline…</div>

    <div v-else class="pv-stages">
      <template v-for="(stage, si) in stages" :key="stage.index">
        <section class="pv-stage" :aria-label="stage.label">
          <h2 class="pv-stage-title">
            <span class="pv-stage-num">{{ si + 1 }}</span>{{ stage.label }}
          </h2>

          <component
            :is="HAS_PAGE.has(node.jobType) ? 'RouterLink' : 'div'"
            v-for="node in stage.nodes"
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
              <template v-if="node.dependsOn.length">
                <dt>in</dt>
                <dd>{{ node.dependsOn.map(labelFor).join(' · ') }}</dd>
              </template>
              <template v-else>
                <dt>in</dt>
                <dd class="pv-muted">the submission itself</dd>
              </template>
              <template v-if="outputOf(node.jobType)">
                <dt>out</dt>
                <dd>{{ outputOf(node.jobType) }}</dd>
              </template>
            </dl>

            <div class="pv-card-foot">
              <span v-if="conflictsFor(node.jobType) > 0" class="pv-conflicts">
                ⚠ {{ conflictsFor(node.jobType) }} conflict{{ conflictsFor(node.jobType) === 1 ? '' : 's' }}
              </span>
              <span v-if="node.gate" class="pv-gate" :title="'This step waits for a condition on the submission: ' + node.gate">
                gated
              </span>
              <span v-if="!node.autoAdvances" class="pv-gate" title="This step can pause and wait for you before it runs.">
                may pause
              </span>
              <span v-if="HAS_PAGE.has(node.jobType)" class="pv-open">open ↗</span>
            </div>
          </component>
        </section>

        <div v-if="si < stages.length - 1" class="pv-arrow" aria-hidden="true">→</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.pv { padding: 1.25rem 1.5rem 3rem; }
.pv-head { display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
.pv-back { font-size: 0.8rem; color: #2563eb; text-decoration: none; }
.pv-back:hover { text-decoration: underline; }
.pv-title { font-size: 1.25rem; font-weight: 600; color: #111827; margin: 0; }
.pv-intro { color: #6b7280; font-size: 0.85rem; margin: 0.5rem 0 1.5rem; max-width: 60rem; }
.pv-empty { color: #9ca3af; font-size: 0.9rem; }

.pv-stages { display: flex; gap: 0.5rem; align-items: flex-start; overflow-x: auto; padding-bottom: 0.5rem; }
.pv-stage { flex: 0 0 15.5rem; display: flex; flex-direction: column; gap: 0.5rem; }
.pv-stage-title {
  display: flex; align-items: center; gap: 0.4rem;
  font-size: 0.7rem; font-weight: 700; color: #6b7280;
  text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 0.15rem;
}
.pv-stage-num {
  display: inline-flex; align-items: center; justify-content: center;
  width: 1.1rem; height: 1.1rem; border-radius: 50%;
  background: #e5e7eb; color: #4b5563; font-size: 0.62rem;
}
.pv-arrow { flex: 0 0 auto; align-self: center; color: #d1d5db; font-size: 1.1rem; padding-top: 2rem; }

.pv-card {
  display: block; text-decoration: none; color: inherit;
  border: 1px solid #e5e7eb; border-radius: 0.5rem; background: #fff;
  padding: 0.6rem 0.7rem;
}
.pv-card-link { cursor: pointer; }
.pv-card-link:hover { border-color: #bfdbfe; background: #f8fafc; }
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

/* One column per stage is only readable while they fit. Below that the stages
   stack, which keeps the order and drops the arrows. */
@media (max-width: 900px) {
  .pv-stages { flex-direction: column; overflow-x: visible; }
  .pv-stage { flex: 1 1 auto; width: 100%; }
  .pv-arrow { display: none; }
}
</style>
