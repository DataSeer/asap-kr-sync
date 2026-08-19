<script setup>
/**
 * The technical half of a module's result — on screen, but out of the way.
 *
 * Split into two tiers on purpose. "Which prompt produced this?" is a
 * five-second question, and answering it by downloading a JSON is worse than
 * not answering it — so configuration, counts and timings are readable here,
 * collapsed. Only the bulk goes to a file.
 *
 * Everything is read from the stored result. Nothing is recomputed, so what is
 * shown is what the run actually recorded.
 */
import { computed, ref } from 'vue'
import { useAuthStore } from '@/stores/auth.store'

const props = defineProps({
  job: { type: Object, required: true },
  submissionId: { type: String, required: true },
  /**
   * Passed in rather than read off the job.
   *
   * The poller keys its map by jobType and the objects carry `jobType`, not
   * `type` — the panel adds `type` when it builds its own list. Reading
   * `job.type` here produced download URLs with "undefined" in the path. The
   * caller always knows which module it is showing, so it says so.
   */
  jobType: { type: String, required: true }
})

const authStore = useAuthStore()
/**
 * Raw artefacts are staff-only server-side (canViewJobInternals). Listing
 * links an author cannot follow would only produce 403s, so the section is
 * hidden rather than shown broken.
 */
const canViewInternals = computed(() => authStore.canViewJobInternals)

const open = ref(false)

const result = computed(() => props.job?.result || {})
const meta = computed(() => result.value.data?.meta || {})
const counts = computed(() => result.value.counts || {})

const ms = (v) => (typeof v === 'number' ? (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`) : null)

/**
 * How this run was configured. Named in the terms the app uses elsewhere, so a
 * value here can be searched for in the code or the docs.
 */
const config = computed(() => {
  const m = meta.value
  const rows = [
    ['Pipeline', m.pipeline],
    ['Strategy', m.strategy],
    ['Model', m.model],
    ['Mode', m.mode],
    ['Ran via', result.value.service?.outcome?.source]
  ]
  if (m.grounding) {
    rows.push(['Shows candidate verdicts', m.grounding.surfaceValues ? 'yes' : 'no — the prompts were seeded'])
    rows.push(['Shows presence', m.grounding.surfacePresence ? 'yes' : 'no'])
  }
  if (m.secondLook) {
    rows.push(['LM second look', m.secondLook.skipped
      ? `skipped (${m.secondLook.reason})`
      : `${m.secondLook.recovered} of ${m.secondLook.attempted} rows recovered`])
  }
  return rows.filter(([, v]) => v !== undefined && v !== null && v !== '')
})

/** Everything the run counted, as recorded. */
const stats = computed(() => Object.entries(counts.value)
  .filter(([, v]) => typeof v === 'number')
  .map(([k, v]) => [k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()), v]))

const timings = computed(() => [
  ['Total', ms(result.value.timing?.totalMs ?? meta.value.totalMs)],
  ['Model call', ms(meta.value.geminiMs)]
].filter(([, v]) => v))

/**
 * Saved artefacts. `files` is written by the job logger as it runs, so this
 * lists what THIS run actually saved rather than what the module usually saves.
 *
 * It is stored as an OBJECT keyed by name — not an array — so the keys are the
 * names the download endpoint expects.
 */
const artefacts = computed(() => {
  const files = result.value.files
  if (!files || typeof files !== 'object') return []
  return Array.isArray(files) ? files.filter((f) => typeof f === 'string') : Object.keys(files)
})

const responseUrl = (name) =>
  `/api/submissions/${props.submissionId}/jobs/${props.jobType}/responses/${encodeURIComponent(name)}`
</script>

<template>
  <section class="mt-panel">
    <button type="button" class="mt-toggle" @click="open = !open">
      <span class="mt-caret" :class="{ 'mt-caret-open': open }">▸</span>
      Technical detail
    </button>

    <div v-if="open" class="mt-body">
      <div v-if="config.length" class="mt-block">
        <h3>How this run was configured</h3>
        <dl><template v-for="([k, v]) in config" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template></dl>
      </div>

      <div v-if="stats.length" class="mt-block">
        <h3>What it counted</h3>
        <dl><template v-for="([k, v]) in stats" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template></dl>
      </div>

      <div v-if="timings.length" class="mt-block">
        <h3>Timing</h3>
        <dl><template v-for="([k, v]) in timings" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template></dl>
      </div>

      <div v-if="canViewInternals && artefacts.length" class="mt-block">
        <h3>Saved by this run</h3>
        <!-- Real links: ctrl-click opens one in a tab like anything else, and
             the browser handles the download rather than a click handler. -->
        <ul class="mt-files">
          <li v-for="name in artefacts" :key="name">
            <a :href="responseUrl(name)" target="_blank" rel="noopener">{{ name }} ↗</a>
          </li>
        </ul>
        <p class="mt-note">
          These are what the module sent to, or received from, the external service — the
          unedited record of this run.
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.mt-panel { border: 1px solid #e5e7eb; border-radius: 0.5rem; background: #fff; margin-top: 1.5rem; }
.mt-toggle {
  display: flex; align-items: center; gap: 0.5rem; width: 100%;
  padding: 0.55rem 0.9rem; font-size: 0.8rem; font-weight: 600; color: #4b5563;
  background: none; border: 0; cursor: pointer; text-align: left;
}
.mt-caret { color: #9ca3af; transition: transform 0.12s ease; }
.mt-caret-open { transform: rotate(90deg); }
.mt-body { padding: 0 0.9rem 0.9rem 2rem; display: flex; flex-wrap: wrap; gap: 1.75rem; }
.mt-block { min-width: 15rem; }
.mt-block h3 {
  font-size: 0.68rem; font-weight: 700; color: #9ca3af;
  text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 0.4rem;
}
.mt-block dl { display: grid; grid-template-columns: auto auto; gap: 0.2rem 0.9rem; margin: 0; font-size: 0.75rem; }
.mt-block dt { color: #6b7280; }
.mt-block dd { margin: 0; color: #111827; font-variant-numeric: tabular-nums; }
.mt-files { list-style: none; margin: 0; padding: 0; font-size: 0.75rem; }
.mt-files a { color: #2563eb; text-decoration: none; }
.mt-files a:hover { text-decoration: underline; }
.mt-note { font-size: 0.7rem; color: #9ca3af; margin: 0.4rem 0 0; max-width: 22rem; line-height: 1.4; }
</style>
