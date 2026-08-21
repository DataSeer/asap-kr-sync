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
import { computed, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth.store'
import fileService from '@/services/file.service'
import jobService from '@/services/job.service'
import { describeJobStatus } from '@/utils/job-status'
import { formatDateTime } from '@/utils/format-date'
import { labelFor } from '@/components/modules/module-meta'
import { RouterLink } from 'vue-router'

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
  jobType: { type: String, required: true },
  /** Every job for this submission, keyed by type — an input often IS another step's output. */
  jobs: { type: Object, default: () => ({}) },
  /** `{ krt, pdf }` as the submission endpoint returns them. */
  files: { type: Object, default: () => ({}) }
})

const authStore = useAuthStore()
/**
 * Raw artefacts are staff-only server-side (canViewJobInternals). Listing
 * links an author cannot follow would only produce 403s, so the section is
 * hidden rather than shown broken.
 */
const canViewInternals = computed(() => authStore.canViewJobInternals)

const open = ref(false)

/**
 * What the prompt DOES, per module. The file name alone does not say whether it
 * detects, consolidates or compares, and "Detection prompt" on the
 * consolidation step would be wrong.
 */
const PROMPT_LABELS = {
  das_extraction: 'Statement extraction prompt',
  krt_grounding: 'Second-look prompt',
  pdf_analysis: 'Consolidation prompt',
  suggestion_generation: 'Comparison prompt',
  signalsPrompt: 'Signal extraction prompt'
}

/**
 * The prompts this run used — the run's OWN copies.
 *
 * There used to be a GitHub link here, built from the recorded path and the
 * branch the deployment tracks. It was quietly wrong: the running app is not
 * always at the head of its branch, and prompt files get edited, renamed and
 * deleted, so a reader could be shown a prompt that was not the one that ran
 * with nothing to indicate the difference. A run freezes its prompt; this shows
 * that copy and nothing else.
 *
 * Fetched on first open rather than with the job: the jobs payload is polled
 * every few seconds and a template per module would be tens of kilobytes on
 * every poll, for something read only when this panel is expanded.
 */
const prompts = ref([])
const promptsState = ref('idle') // idle | loading | ready | error

// Switching run must re-read the prompt, not keep the previous one on screen.
watch(() => props.job?.runNumber, () => {
  promptsState.value = 'idle'
  prompts.value = []
  if (open.value) loadPrompts()
})
const openPrompt = ref(null)

async function loadPrompts() {
  if (promptsState.value !== 'idle') return
  promptsState.value = 'loading'
  try {
    // The prompt must be the one THIS run used. Asking without the run number
    // answers for the latest, which put run 3's prompt beside run 1's results.
    const data = await jobService.getJobPrompts(
      props.submissionId, props.jobType, props.job?.round,
      props.job?.isLatest === false ? props.job?.runNumber : null
    )
    prompts.value = (data.prompts || []).map((p) => ({
      ...p,
      label: PROMPT_LABELS[p.key] || PROMPT_LABELS[props.jobType] || 'Detection prompt',
      name: (p.file || '').split('/').pop()
    }))
    promptsState.value = 'ready'
  } catch {
    promptsState.value = 'error'
  }
}

// Only when the panel is actually opened.
watch(open, (isOpen) => { if (isOpen) loadPrompts() })

const result = computed(() => props.job?.result || {})
/**
 * What the run recorded about itself.
 *
 * One path, because every module stores it in one place: `result.data.meta`.
 * The DAS check briefly did not, and this reader grew a fallback to cope —
 * which would have let the next module drift too. The module was fixed instead.
 */
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

/**
 * The run produced a real result with one of its engines missing.
 *
 * Stated at the TOP of the panel rather than as another row in Statistics: the
 * counts below are correct but are a floor, not a total, and a reader who
 * meets the number first has already drawn the wrong conclusion.
 */
const degraded = computed(() => {
  const outcome = props.job?.result?.service?.outcome
  if (!outcome || outcome.state !== 'partial') return null
  return {
    engine: String(outcome.failReason || '').replace(/_failed$/, '') || 'one engine',
    error: outcome.externalError || null
  }
})

/**
 * Everything the run counted, as recorded.
 *
 * A zero produced by an engine that never answered is shown as "—", not 0.
 * With Softcite dead, `counts.total` (its raw mention count) is 0 — and "Total
 * 0 / Unique 18" reads as "it looked and found none", which is the opposite of
 * what happened. Only the counts the failed engine owns are blanked; the ones
 * the surviving engine produced are real and stay.
 */
const DEGRADED_ENGINE_COUNTS = { softcite: ['total'] }

const stats = computed(() => {
  const blanked = degraded.value ? (DEGRADED_ENGINE_COUNTS[degraded.value.engine] || []) : []
  return Object.entries(counts.value)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => [
      k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
      blanked.includes(k) ? '—' : v
    ])
})

/**
 * Durations, named so they cannot be read as counts: they share a list with
 * "Total 67" now, and two rows labelled "Total" say nothing.
 */
const timings = computed(() => [
  ['Total time', ms(result.value.timing?.totalMs ?? meta.value.totalMs)],
  ['Model call time', ms(meta.value.geminiMs)]
].filter(([, v]) => v))

/**
 * Who ran this, when, and under what configuration.
 *
 * First column, before the counts: a reader who meets the numbers first has
 * already assumed they are the current, complete answer. This says which run
 * produced them and whether the module was even switched on.
 *
 * Everything here is the RUN's own record — the frozen config, not the current
 * one. A module disabled during this run and enabled since must still read as
 * disabled here, or the record claims it looked at the manuscript when it never
 * ran.
 */
const CONFIG_STATE_LABEL = { on: 'on', demo: 'demo data', off: 'off' }
const TRIGGER_LABEL = {
  manual: 'manual re-run',
  pipeline: 'started by the pipeline',
  reconciler: 'recovered by the reconciler'
}

/**
 * A PAST run whose artefacts were not kept apart from later runs.
 *
 * Only past runs: the latest run wrote last, so whatever is in the shared
 * folder is genuinely its own.
 */
const artefactsNotOwn = computed(() =>
  props.job?.isLatest === false && props.job?.artefactsAreOwn === false)

const metadata = computed(() => {
  const job = props.job || {}
  const svc = job.result?.service || {}
  const by = job.triggeredBy
  const rows = []

  if (job.runNumber) {
    const round = job.round ?? 1
    rows.push(['Run', job.runCount > 1
      ? `${job.runNumber} of ${job.runCount} (round ${round})`
      : `${job.runNumber} (round ${round})`])
  }
  rows.push(['Status', describeJobStatus(job).label])
  if (by) {
    rows.push(['Requested by', by.name || 'a user who has since been removed'])
  } else if (job.status) {
    // Not "unknown" — nobody asked, the pipeline advanced it.
    rows.push(['Requested by', 'the pipeline'])
  }
  if (job.triggerKind && TRIGGER_LABEL[job.triggerKind]) {
    rows.push(['How', TRIGGER_LABEL[job.triggerKind]])
  }
  if (job.startedAt) rows.push(['Started', formatDateTime(job.startedAt)])
  if (job.completedAt) rows.push(['Finished', formatDateTime(job.completedAt)])
  if (job.retryCount > 0) rows.push(['Attempts', String(job.retryCount + 1)])
  if (svc.config?.state) {
    rows.push(['Configuration', CONFIG_STATE_LABEL[svc.config.state] || svc.config.state])
  }
  return rows
})

// ── what went in ───────────────────────────────────────────────────────
/**
 * What each module reads.
 *
 * Written down here because no run records it: a module's inputs are implied by
 * its code, and a reader looking at a surprising result has no way to see which
 * document was actually read. Every entry below resolves to something that
 * still exists — an S3 file, the author's table, or another step's stored
 * result — so these are links, not descriptions.
 */
const READS = {
  markdown_convert: ['pdf'],
  orcid_extraction: ['pdf'],
  das_extraction: ['markdown'],
  software_detection: ['pdf', 'markdown'],
  datasets_detection: ['markdown', 'seeds'],
  materials_detection: ['markdown', 'seeds'],
  protocols_detection: ['markdown', 'seeds'],
  identifier_detection: ['markdown'],
  krt_grounding: ['markdown', 'krt', 'candidates'],
  pdf_analysis: ['candidates'],
  suggestion_generation: ['krt', 'generatedKrt'],
  // The statement is not a file — it is a field on the submission, written by
  // DAS extraction and then editable by the author on the very step that runs
  // this check. It is listed anyway, pointing at the step that produced it,
  // because leaving it out would say this module reads only the KRT.
  das_suggestions: ['das', 'krt']
}

/** The detectors whose items make up the candidate pool. */
const CANDIDATE_SOURCES = [
  'software_detection', 'datasets_detection', 'materials_detection',
  'protocols_detection', 'identifier_detection'
]

const jobOf = (type) => props.jobs?.[type] || null

/**
 * The counts a run recorded about its OWN input — how many seeds it was given,
 * how many candidates it merged. Read from meta rather than recomputed, so this
 * says what that run saw and not what the submission looks like today.
 */
const INPUT_COUNTS = [
  ['dasLength', 'Characters of Availability Statement'],
  ['krtRowCount', 'KRT rows summarised for the check'],
  ['seedCount', 'Author rows used as seeds'],
  ['authorCount', 'Author KRT rows read'],
  ['candidateCount', 'Candidates considered'],
  ['contributorCount', 'Detections merged'],
  ['generatedCount', 'Generated KRT rows read'],
  ['groundedRowCount', 'Grounding verdicts read'],
  ['markdownLength', 'Characters of converted text']
]

const inputCounts = computed(() => INPUT_COUNTS
  .filter(([k]) => typeof meta.value[k] === 'number')
  .map(([k, label]) => [label, meta.value[k].toLocaleString()]))

/**
 * The documents this run read, as links.
 *
 * A `null` href means the thing exists but this page cannot link to it — said
 * plainly rather than omitted, because "no link" and "no input" are very
 * different facts.
 */
const inputs = computed(() => {
  const out = []
  for (const kind of (READS[props.jobType] || [])) {
    if (kind === 'pdf' && props.files?.pdf) {
      out.push({ label: 'The manuscript PDF', fileId: props.files.pdf.id, note: 'as uploaded' })
    } else if (kind === 'markdown') {
      const md = jobOf('markdown_convert')
      const len = md?.result?.data?.markdownLength
      out.push({
        label: 'The converted manuscript text',
        fileId: md?.result?.data?.fileId || null,
        route: { name: 'submission-module', params: { id: props.submissionId, type: 'markdown_convert' } },
        note: len ? `${len.toLocaleString()} characters` : 'not converted'
      })
    } else if (kind === 'krt' || kind === 'seeds') {
      out.push({
        label: kind === 'seeds' ? 'Your KRT rows, as prompt seeds' : 'Your Key Resources Table',
        fileId: props.files?.krt?.id || null,
        note: kind === 'seeds' && meta.value.seedCount === 0
          ? 'no rows to seed with — the discovery prompt was used instead'
          : 'the file you uploaded'
      })
    } else if (kind === 'candidates') {
      for (const t of CANDIDATE_SOURCES) {
        const j = jobOf(t)
        if (!j) continue
        out.push({
          label: labelFor(t),
          route: { name: 'submission-module', params: { id: props.submissionId, type: t } },
          note: `${j.result?.data?.items?.length ?? 0} items`
        })
      }
    } else if (kind === 'das') {
      const j = jobOf('das_extraction')
      const detected = j?.result?.status?.detected
      out.push({
        label: 'Your Availability Statement',
        route: { name: 'submission-module', params: { id: props.submissionId, type: 'das_extraction' } },
        note: detected === false
          ? 'not found in the manuscript — whatever you entered by hand'
          : 'as extracted, plus any edit you made on the Availability step'
      })
    } else if (kind === 'generatedKrt') {
      const j = jobOf('pdf_analysis')
      out.push({
        label: 'The Generated KRT',
        route: { name: 'submission-module', params: { id: props.submissionId, type: 'pdf_analysis' } },
        note: `${j?.result?.data?.items?.length ?? 0} rows`
      })
    }
  }
  return out
})

/**
 * Artefacts whose content IS an input rather than a result. Only grounding
 * stores one today; the rest of this section links to where the input lives
 * instead, because nothing else is saved a second time.
 */
// `inputs` is the frozen audit record every module writes; `grounding-inputs`
// is the older name grounding used for the same thing. Both belong under Module
// inputs — listed as outputs they read as something the run produced.
const INPUT_ARTEFACTS = new Set(['inputs', 'grounding-inputs'])

/** Every artefact name this run saved, before the input/result split. */
const savedNames = computed(() => {
  const files = result.value.files
  if (!files || typeof files !== 'object') return []
  return Array.isArray(files) ? files.filter((f) => typeof f === 'string') : Object.keys(files)
})

const inputArtefacts = computed(() => savedNames.value.filter((n) => INPUT_ARTEFACTS.has(n)))

/**
 * Saved artefacts. `files` is written by the job logger as it runs, so this
 * lists what THIS run actually saved rather than what the module usually saves.
 *
 * It is stored as an OBJECT keyed by name — not an array — so the keys are the
 * names the download endpoint expects.
 */
const artefacts = computed(() => savedNames.value.filter((n) => !INPUT_ARTEFACTS.has(n)))

/**
 * A link straight to the artefact.
 *
 * `?redirect=1` because without it the endpoint answers with JSON describing
 * where the file is, and the reader lands on that JSON instead of the file.
 */
/**
 * Open a stored file. The presigned URL is minted on click, not on render: one
 * minted at page load would have expired by the time a reader working through
 * a long table reaches it.
 */
async function openFile(fileId) {
  if (!fileId) return
  try {
    const data = await fileService.download(props.submissionId, fileId)
    if (data.url) window.open(data.url, '_blank', 'noopener,noreferrer')
  } catch {
    // The module page below offers the same file with full error handling.
  }
}

const responseUrl = (name) =>
  `/api/submissions/${props.submissionId}/jobs/${props.jobType}`
  + `/responses/${encodeURIComponent(name)}?redirect=1`
</script>

<template>
  <section class="mt-panel">
    <button type="button" class="mt-toggle" @click="open = !open">
      <span class="mt-caret" :class="{ 'mt-caret-open': open }">▸</span>
      Technical detail
    </button>

    <div v-if="open" class="mt-body">
      <div v-if="degraded" class="mt-degraded">
        <strong>Partly complete.</strong>
        The <code>{{ degraded.engine }}</code> engine failed on this run, so the counts below
        come from the remaining one. They are real, but this manuscript was not fully read —
        re-run the step once the service is back.
        <span v-if="degraded.error" class="mt-degraded-error">{{ degraded.error }}</span>
      </div>
      <div v-if="metadata.length" class="mt-block mt-narrow">
        <h3>Metadata</h3>
        <dl><template v-for="([k, v]) in metadata" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template></dl>
      </div>
      <div v-if="config.length" class="mt-block mt-narrow">
        <h3>Configuration</h3>
        <dl><template v-for="([k, v]) in config" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template></dl>
      </div>
      <div v-if="stats.length || timings.length" class="mt-block mt-narrow">
        <h3>Statistics</h3>
        <!-- Durations sit with the counts: both are "what this run did", and a
             column of its own for two numbers was a column too many. -->
        <dl>
          <template v-for="([k, v]) in stats" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template>
          <template v-for="([k, v]) in timings" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template>
        </dl>
      </div>
      <div
        v-if="inputs.length || inputCounts.length || inputArtefacts.length || prompts.length"
        class="mt-block mt-wide"
      >
        <h3>Module inputs</h3>
        <ul v-if="inputs.length" class="mt-files">
          <li v-for="(i, n) in inputs" :key="n">
            <button v-if="i.fileId" type="button" class="mt-linkish" @click="openFile(i.fileId)">
              {{ i.label }} ↗
            </button>
            <RouterLink v-else-if="i.route" :to="i.route">{{ i.label }} ↗</RouterLink>
            <span v-else>{{ i.label }}</span>
            <span v-if="i.note" class="mt-files-note">{{ i.note }}</span>
          </li>
        </ul>
        <!-- The prompt is an input too, and the copy shown is the one this run
             froze — not the file as it stands today, and not a link to a branch
             the deployment may not be running. -->
        <p v-if="promptsState === 'loading'" class="mt-files-note">Loading the prompts this run used…</p>
        <p v-else-if="promptsState === 'error'" class="mt-files-note">
          The prompts this run used could not be read.
        </p>
        <p v-else-if="promptsState === 'ready' && !prompts.length" class="mt-files-note">
          This run recorded no prompt.
        </p>
        <ul v-if="prompts.length" class="mt-files">
          <li v-for="p in prompts" :key="p.file">
            <button
              type="button"
              class="mt-linkish"
              v-tooltip="p.file"
              @click="openPrompt = openPrompt === p.file ? null : p.file"
            >
              {{ p.name }} {{ openPrompt === p.file ? '▾' : '▸' }}
            </button>
            <span class="mt-files-note">{{ p.label }}</span>
            <div v-if="openPrompt === p.file" class="mt-prompt">
              <p class="mt-prompt-path">{{ p.file }}<span v-if="p.bytes"> · {{ p.bytes }} bytes</span></p>
              <pre v-if="p.text" class="mt-prompt-text">{{ p.text }}</pre>
              <p v-else class="mt-files-note">This run did not store the prompt text.</p>
              <!-- Files the prompt cannot work without. LangExtract's few-shot
                   examples are handed to the extractor separately and never
                   enter the prompt text, so the template alone would show only
                   part of what the run was given. -->
              <div v-for="a in p.attachments || []" :key="a.file" class="mt-prompt-attachment">
                <p class="mt-prompt-path">{{ a.file }}<span v-if="a.bytes"> · {{ a.bytes }} bytes</span></p>
                <pre v-if="a.text" class="mt-prompt-text">{{ a.text }}</pre>
              </div>
            </div>
          </li>
        </ul>
        <ul v-if="inputArtefacts.length" class="mt-files">
          <li v-for="name in inputArtefacts" :key="name">
            <a :href="responseUrl(name)" target="_blank" rel="noopener">{{ name }} ↗</a>
            <span class="mt-files-note">the exact input this run was given, frozen</span>
          </li>
        </ul>
        <dl v-if="inputCounts.length">
          <template v-for="([k, v]) in inputCounts" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template>
        </dl>
        <p class="mt-note">
          Every module freezes what it was given, and that record is the
          <code>inputs</code> file above. The documents beside it are shown as they are stored
          <em>now</em>, so an edit made after the run appears there even though the run never saw it —
          when the two disagree, the frozen record is what happened.
        </p>
      </div>
      <div v-if="(canViewInternals && artefacts.length) || $slots.files" class="mt-block mt-wide">
        <h3>Module outputs</h3>
        <p v-if="artefactsNotOwn" class="mt-note mt-note-warn">
          This run's stored files were not kept separately from later runs of the same
          step, so they are not shown — they would be a later run's evidence wearing this
          run's timestamp. Runs from here on keep their own.
        </p>
        <!-- What the module produced and stored. A slot rather than a prop:
             only the caller knows what its module kept and how to hand it over. -->
        <slot name="files" />
        <!-- Real links: ctrl-click opens one in a tab like anything else, and
             the browser handles the download rather than a click handler. -->
        <ul v-if="canViewInternals && artefacts.length && !artefactsNotOwn" class="mt-files">
          <li v-for="name in artefacts" :key="name">
            <a :href="responseUrl(name)" target="_blank" rel="noopener">{{ name }} ↗</a>
          </li>
        </ul>
        <p v-if="canViewInternals && artefacts.length && !artefactsNotOwn" class="mt-note">
          These are what the module sent to, or received from, the external service — the
          unedited record of this run.
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.mt-note-warn {
  color: #92400e;
  background: #fffbeb;
  border: 1px solid #fcd34d;
  border-radius: 0.375rem;
  padding: 0.5rem 0.625rem;
}

.mt-degraded {
  margin-bottom: 0.875rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid #fcd34d;
  border-radius: 0.375rem;
  background: #fffbeb;
  color: #92400e;
  font-size: 0.8125rem;
  line-height: 1.45;
  grid-column: 1 / -1;
}

.mt-degraded code {
  background: rgba(146, 64, 14, 0.1);
  padding: 0 0.25rem;
  border-radius: 0.1875rem;
}

.mt-degraded-error {
  display: block;
  margin-top: 0.25rem;
  font-family: ui-monospace, monospace;
  font-size: 0.75rem;
  opacity: 0.85;
}

.mt-panel { border: 1px solid #e5e7eb; border-radius: 0.5rem; background: #fff; margin-top: 1.5rem; }
.mt-toggle {
  display: flex; align-items: center; gap: 0.5rem; width: 100%;
  padding: 0.55rem 0.9rem; font-size: 0.8rem; font-weight: 600; color: #4b5563;
  background: none; border: 0; cursor: pointer; text-align: left;
}
.mt-caret { color: #9ca3af; transition: transform 0.12s ease; }
.mt-caret-open { transform: rotate(90deg); }
/* Six columns, split 1 : 1 : 2 : 2.
   Configuration and Statistics are short label/value lists; inputs and outputs
   are lines of links with explanatory notes, and they were the two wrapping
   awkwardly while the first two sat half empty. The spans are declared per
   block rather than by position, because any block can be absent — a module
   with no prompt or no stored artefacts simply omits one. */
.mt-body {
  padding: 0 0.9rem 0.9rem 2rem;
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 1.5rem 2rem;
  align-items: start;
}
.mt-block { min-width: 0; }
/* Configuration and Statistics: short label/value lists. */
.mt-narrow { grid-column: span 1; }
/* Module inputs and outputs: lines of links with an explanatory note under
   them, which is what was wrapping while the two lists sat half empty. */
.mt-wide { grid-column: span 2; }

/* Below the six-column width each track would be narrower than a file name, so
   drop to two: the short lists side by side, each wide block on its own row. */
@media (max-width: 1099px) {
  .mt-body { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mt-wide { grid-column: span 2; }
}

@media (max-width: 640px) {
  .mt-body { grid-template-columns: minmax(0, 1fr); }
  .mt-narrow, .mt-wide { grid-column: span 1; }
}
.mt-block h3 {
  font-size: 0.68rem; font-weight: 700; color: #9ca3af;
  text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 0.4rem;
}
.mt-block dl {
  display: grid; grid-template-columns: minmax(0, auto) minmax(0, auto);
  /* Hug the content: stretched to the column width, a label and its value ended
     up at opposite ends of the block and stopped reading as a pair. */
  justify-content: start;
  gap: 0.2rem 0.9rem; margin: 0; font-size: 0.75rem;
}
.mt-block dt { color: #6b7280; }
.mt-block dd { margin: 0; color: #111827; font-variant-numeric: tabular-nums; }
.mt-files { list-style: none; margin: 0; padding: 0; font-size: 0.75rem; }
.mt-files li { overflow-wrap: anywhere; margin-bottom: 0.15rem; }
.mt-files a { color: #2563eb; text-decoration: none; }
.mt-files a:hover { text-decoration: underline; }
.mt-linkish {
  background: none; border: 0; padding: 0;
  color: #2563eb; font-size: inherit; cursor: pointer;
}
.mt-linkish:hover { text-decoration: underline; }
.mt-files-note { color: #9ca3af; margin-left: 0.4rem; font-size: 0.7rem; }

/* The run's own copy of a prompt, read in place. Scrolls inside its own box:
   a 6 KB template must not push the rest of the panel off screen. */
.mt-prompt { margin: 0.4rem 0 0.6rem; }
.mt-prompt-path { color: #9ca3af; font-size: 0.7rem; margin-bottom: 0.2rem; word-break: break-all; }
.mt-prompt-text {
  max-height: 22rem;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.7rem;
  line-height: 1.45;
  padding: 0.6rem;
  border-radius: 0.35rem;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  color: #374151;
}
.mt-prompt-attachment { margin-top: 0.5rem; }
.mt-note { font-size: 0.7rem; color: #9ca3af; margin: 0.4rem 0 0; line-height: 1.4; }
</style>
