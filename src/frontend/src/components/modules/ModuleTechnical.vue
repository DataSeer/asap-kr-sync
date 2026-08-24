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
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth.store'
import fileService from '@/services/file.service'
import jobService from '@/services/job.service'
import { describeJobStatus } from '@/utils/job-status'
import { formatDateTime } from '@/utils/format-date'
import { labelFor } from '@/components/modules/module-meta'

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

/**
 * Open on arrival.
 *
 * It used to start collapsed, which made the run's own record — who ran it,
 * what it read, what it spent — something you had to know was there. On a page
 * whose subject IS one run, that is the wrong default: the result is the claim
 * and this is the evidence for it, and evidence behind a disclosure gets read
 * by nobody.
 */
const open = ref(true)

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
// The watcher only fires on a CHANGE, and the panel now starts open — so
// without this the prompts of the first module you land on never load.
onMounted(() => { if (open.value) loadPrompts() })

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
/** `service.config.state`, in words rather than an enum. */
const MODULE_STATE = {
  on: 'on — calls its real service',
  demo: 'demo — canned data, no service call',
  off: 'off — the step is skipped'
}

/**
 * `service.outcome.source`, likewise.
 *
 * "internal" is not a lesser answer: a few steps do their work in the app —
 * KRT Grounding matches text deterministically — and a bare "internal" beside
 * another module's bare "external" reads as though one of them is misconfigured.
 */
const RAN_VIA = {
  external: 'an external service',
  internal: 'the app itself — no external service is called',
  demo: 'demo data, not a live service'
}

/** Just the file name; the full path is on the Prompt tab. */
const promptName = (p) => (typeof p === 'string' ? p.split('/').pop() : null)

const config = computed(() => {
  const m = meta.value
  const state = result.value.service?.config?.state
  const via = result.value.service?.outcome?.source
  // Every module reports its state and where the answer came from. The four
  // rows after that are reported by some and not others, which is why this
  // panel used to show a single line for PDF Analysis and half a dozen for a
  // detector — the table only ever asked for fields those detectors happen to
  // emit. Anything a module does report about how it was configured belongs
  // here, so the shape of the panel stops depending on which module you opened.
  const rows = [
    ['Module', MODULE_STATE[state] || state],
    ['Pipeline', m.pipeline],
    ['Strategy', m.strategy],
    ['Model', m.model],
    ['Mode', m.mode],
    ['Prompt', promptName(m.promptFile)],
    ['LM pass', m.usedLM === true ? 'used' : m.usedLM === false ? 'not used — rule-based merge'
      : m.lmEnabled === true ? 'enabled' : m.lmEnabled === false ? 'disabled' : null],
    ['Ran via', RAN_VIA[via] || via]
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

/**
 * What each number means, in words.
 *
 * The list used to be whatever numeric keys the module happened to record,
 * camelCase turned into Title Case: "Total 9, Unique 2" over a run that checked
 * nine rules and found two to act on. Nobody could tell what was being counted,
 * and a number nobody understands is not evidence — it is decoration that looks
 * like evidence.
 *
 * So every key gets a name and a sentence. `total` and `unique` mean genuinely
 * different things per module — raw mentions vs deduplicated for a detector,
 * rules checked vs rules that apply for the Availability check — so those are
 * overridden per module rather than given one vague description that fits none
 * of them.
 *
 * A key with no entry still shows, title-cased and without an explanation: a
 * missing sentence is a gap to fill, not a reason to hide a number the run
 * recorded.
 */
const STAT_META = {
  total: { label: 'Found', explain: 'Every mention the module picked up, including the same thing named more than once.' },
  unique: { label: 'Distinct', explain: 'What is left after the same thing mentioned several times is counted once.' },
  enriched: { label: 'Enriched', explain: 'How many were matched to a known catalogue entry, adding an identifier or a canonical name.' },
  highRelevance: { label: 'High confidence', explain: 'How many the module judged clearly relevant, rather than a possible mention.' },
  resources: { label: 'Rows produced', explain: 'Rows in the Generated Key Resources Table this run built.' },
  contributors: { label: 'Contributing modules', explain: 'How many detection modules fed rows into that table.' },
  multiSource: { label: 'Corroborated rows', explain: 'Rows more than one module found independently — usually the most reliable ones.' },
  authors: { label: 'Authors', explain: 'Authors read from the manuscript.' },
  orcids: { label: 'With an ORCID', explain: 'How many of those authors had an ORCID identifier that could be resolved.' },
  // Grounding: the whole first, then how it divides.
  authorRows: { label: 'Your KRT rows', explain: 'Rows in your Key Resources Table that this run checked against the manuscript. Everything below is a share of this.' },
  confirmed: { label: 'Confirmed', explain: 'Your rows the module found in the manuscript, matching what you wrote.' },
  incomplete: { label: 'Incomplete', explain: 'Your rows found in the manuscript but missing something the checklist expects, such as an identifier.' },
  notDetected: { label: 'Not found', explain: 'Your rows the module could not find in the manuscript. Not necessarily wrong — it may simply not be described there.' },
  conflicts: { label: 'Conflicts', explain: 'Rows where what you wrote and what the manuscript says disagree — these need your decision.' },
  present: { label: 'Present in the text', explain: 'Your rows located by searching the manuscript directly, rather than by matching a detector\'s finding. A second, independent measure of the same table.' },
  absent: { label: 'Absent from the text', explain: 'Your rows that direct search of the manuscript did not locate.' },
  unmatchedCandidates: { label: 'Found but not in your table', explain: 'Resources the detectors found in the manuscript that no row of yours accounts for. Not a share of your rows — these are additions to consider.' }
}

/** Where a key means something different from module to module. */
const STAT_OVERRIDES = {
  das_suggestions: {
    total: { label: 'Checks run', explain: 'How many of the ASAP availability rules were evaluated against your statement.' },
    unique: { label: 'Need action', explain: 'How many of those rules your statement does not yet satisfy.' }
  },
  identifier_detection: {
    total: { label: 'Identifiers found', explain: 'Every identifier matched in the manuscript — RRIDs, DOIs, accession numbers — including repeats.' },
    unique: { label: 'Distinct identifiers', explain: 'What is left after the same identifier appearing several times is counted once.' }
  }
}

const statMeta = (key) => STAT_OVERRIDES[props.jobType]?.[key] || STAT_META[key] || null

/**
 * Reading order, which is not the order the modules happen to record them in.
 *
 * A breakdown before its denominator reads as a list of unrelated numbers:
 * grounding recorded "Absent 51, Present 60, Confirmed 94 … Your KRT rows 111",
 * so the total everything is a share OF came fifth. The order below is the
 * order of `STAT_META` — the whole first, then how it divides — and anything
 * not named there keeps its position at the end rather than being dropped.
 */
const STAT_ORDER = Object.keys(STAT_META)
const statRank = (key) => {
  const i = STAT_ORDER.indexOf(key)
  return i === -1 ? STAT_ORDER.length : i
}

const stats = computed(() => {
  const blanked = degraded.value ? (DEGRADED_ENGINE_COUNTS[degraded.value.engine] || []) : []
  return Object.entries(counts.value)
    .filter(([, v]) => typeof v === 'number')
    .sort(([a], [b]) => statRank(a) - statRank(b))
    .map(([k, v]) => {
      const known = statMeta(k)
      return {
        label: known?.label || k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
        value: blanked.includes(k) ? '—' : v,
        explain: blanked.includes(k)
          ? 'This engine failed on this run, so its share of the count is not known.'
          : (known?.explain || null)
      }
    })
})

/**
 * Durations, named so they cannot be read as counts: they share a list with
 * "Total 67" now, and two rows labelled "Total" say nothing.
 */
const timings = computed(() => [
  {
    label: 'Duration',
    // The module's own measure first, then the run record's. Not every module
    // times itself — DAS extraction records none — and "how long did this take"
    // should not depend on which module you happen to be looking at when the
    // run row has known it all along.
    value: ms(result.value.timing?.totalMs ?? meta.value.totalMs ?? props.job?.elapsedMs),
    explain: 'How long this run took from start to finish, including time spent waiting on an external service.'
  },
  {
    label: 'Model call',
    value: ms(meta.value.geminiMs ?? result.value.timing?.apiMs),
    explain: 'How much of that was the language model or detection API answering. The rest is reading the document, matching and storing results.'
  }
].filter((row) => row.value))

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

/**
 * What a stored prompt actually is.
 *
 * The TEXT below is this run's copy, frozen when the run started. The PATH is
 * where that file lives in the repository — today. Printing them together as
 * "src/backend/data/prompts/das-suggestions.txt · 3874 bytes" read as though the
 * panel were showing you the file, so a prompt edited since the run looked like
 * the prompt this run used. Prompts are edited exactly as often as results are
 * re-read, which is what makes the confusion worth a sentence.
 *
 * @param {object} p - the prompt or attachment record
 * @returns {string}
 */
function promptProvenance(p) {
  const when = props.job?.startedAt ? ` on ${formatDateTime(props.job.startedAt)}` : ''
  const size = p.bytes ? ` · ${p.bytes} bytes` : ''
  return `Copy of ${p.file} as it was${when}${size}. The file may have changed since.`
}

/**
 * What the run spent at the model.
 *
 * Absent when no model was called — a row of zeroes on Markdown Convert would
 * be noise on every page it appears — and absent on runs that predate the
 * tally, which is honest: they were not measured.
 *
 * Tokens rather than money on purpose. The provider does not return a price,
 * and one derived here from a rate card would be a number the app cannot stand
 * behind: rates change, tiers differ, and nobody would know when it went stale.
 */
const tokens = computed(() => {
  const t = result.value.tokens
  if (!t?.totalTokens) return []
  const detail = `${t.promptTokens.toLocaleString()} sent, ${t.outputTokens.toLocaleString()} returned`
    + `, over ${t.calls} call${t.calls === 1 ? '' : 's'}`
  return [{
    label: 'Tokens used',
    value: t.totalTokens.toLocaleString(),
    explain: `What this run cost the language model, in tokens: ${detail}. `
      + 'Retries are included — a call that was made and thrown away was still paid for.'
  }]
})

/**
 * Counts, durations and spend in one list — all three answer "what did this run
 * do", and a column of its own for two timings was a column too many.
 */
const statRows = computed(() => [...stats.value, ...timings.value, ...tokens.value])

/**
 * How many tries this run took, and what went wrong on the way.
 *
 * `retryCount + 1` was all there was: it counts pg-boss re-deliveries and
 * nothing else, and the error text was overwritten each time — so "the first
 * two attempts returned 529, then it succeeded" was unanswerable, which is the
 * difference between an upstream that is flaky and one that is broken.
 *
 * Two layers retry and they are counted separately, because adding them
 * together produces a number that means nothing: a delivery contains calls.
 * When the external service was retried, THAT is the interesting count; when it
 * was not, the deliveries are.
 *
 * Nothing is shown for a run that worked first time — a row saying "1" on every
 * module is noise on every page.
 *
 * @param {object} job
 * @returns {string|null}
 */
function describeAttempts(job) {
  const attempts = Array.isArray(job.attempts) ? job.attempts : []
  if (!attempts.length) {
    return job.retryCount > 0 ? String(job.retryCount + 1) : null
  }

  const calls = attempts.filter((a) => a.layer === 'client')
  const deliveries = attempts.filter((a) => a.layer === 'queue')
  const tries = calls.length || deliveries.length
  const failed = attempts.filter((a) => !a.ok)
  if (tries <= 1 && !failed.length) return null

  // Distinct statuses rather than one per failure: three 503s are one fact.
  const statuses = [...new Set(failed.map((a) => a.httpStatus).filter(Boolean))]
  if (!failed.length) return String(tries)
  return `${tries} — ${failed.length} failed`
    + (statuses.length ? ` (${statuses.join(', ')})` : '')
}

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
  const attemptsRow = describeAttempts(job)
  if (attemptsRow) rows.push(['Attempts', attemptsRow])
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
/**
 * What this run was given — and nothing else.
 *
 * Every entry is either a FROZEN file (the S3 object this run read, opened in a
 * new tab) or a description of something whose exact bytes are in the run's
 * `inputs` artefact below. Nothing here links to a step page.
 *
 * It used to. A step page shows the CURRENT state of that step, so "Your
 * Availability Statement ↗" took you to whatever the statement says today —
 * beside a result computed from what it said during the run. The panel exists
 * to say what a run actually did, and half its links quietly said something
 * else.
 *
 * `props.files` is the run's own document record (`job.documents`), not the
 * submission's current files, so an older version is its own row and asking for
 * that id returns exactly the file this run read.
 */
const inputs = computed(() => {
  const out = []
  const doc = (name) => props.files?.[name] || null

  for (const kind of (READS[props.jobType] || [])) {
    if (kind === 'pdf') {
      const pdf = doc('pdf')
      out.push({
        label: 'The manuscript PDF',
        fileId: pdf?.id || null,
        note: pdf?.version ? `version ${pdf.version}, frozen for this run` : 'not recorded for this run'
      })
    } else if (kind === 'markdown') {
      const md = doc('markdown')
      const len = jobOf('markdown_convert')?.result?.data?.markdownLength
      out.push({
        label: 'The converted manuscript text',
        fileId: md?.id || null,
        note: md?.version
          ? `version ${md.version}, frozen for this run${len ? ` · ${len.toLocaleString()} characters` : ''}`
          : 'not recorded for this run'
      })
    } else if (kind === 'krt' || kind === 'seeds') {
      const krt = doc('krt')
      const seedsEmpty = kind === 'seeds' && meta.value.seedCount === 0
      out.push({
        label: kind === 'seeds' ? 'Your KRT rows, as prompt seeds' : 'Your Key Resources Table',
        fileId: krt?.id || null,
        note: seedsEmpty
          ? 'no rows to seed with — the discovery prompt was used instead'
          : (krt?.version ? `version ${krt.version}, frozen for this run` : 'not recorded for this run')
      })
    } else if (kind === 'candidates') {
      // Another step's findings, as this run received them. There is no file to
      // open: the copy this run was handed is in the `inputs` artefact below,
      // and today's version of that step is a different thing.
      for (const t of CANDIDATE_SOURCES) {
        const j = jobOf(t)
        if (!j) continue
        out.push({
          label: `${labelFor(t)} findings`,
          // To the module that produced them, where its own frozen record is —
          // its run, its inputs, its artefacts. Not a claim that this is the
          // copy this run read, which is why the note still says what it does:
          // the exact bytes are in the `inputs` artefact below.
          route: { name: 'submission-module', params: { id: props.submissionId, type: t } },
          note: `${j.result?.data?.items?.length ?? 0} items, as handed to this run`
        })
      }
    } else if (kind === 'das') {
      const j = jobOf('das_extraction')
      out.push({
        label: 'Your Availability Statement',
        note: j?.result?.status?.detected === false
          ? 'not found in the manuscript — the text as it stood for this run'
          : 'the text as it stood for this run'
      })
    } else if (kind === 'generatedKrt') {
      const j = jobOf('pdf_analysis')
      out.push({
        label: 'The Generated KRT',
        note: `${j?.result?.data?.items?.length ?? 0} rows, as handed to this run`
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

/**
 * Open a stored prompt in a new tab.
 *
 * The text is this run's frozen copy and lives in the run record, not in S3 —
 * so there is no URL to link to and the tab is served a blob built from it. The
 * alternative was linking to the file in the repository, which is the one thing
 * this must not do: that file is today's, and the whole point of the copy is
 * that the two can differ.
 *
 * The object URL is released on a timer rather than immediately: revoking it in
 * the same tick can beat the new tab to it, and the reader gets a blank page.
 */
function openPromptFile(p) {
  if (!p?.text) return
  const url = URL.createObjectURL(new Blob([p.text], { type: 'text/plain;charset=utf-8' }))
  window.open(url, '_blank', 'noopener,noreferrer')
  setTimeout(() => URL.revokeObjectURL(url), 60000)
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
      <div v-if="statRows.length" class="mt-block mt-narrow">
        <h3>Statistics</h3>
        <!-- Durations sit with the counts: both are "what this run did", and a
             column of its own for two numbers was a column too many. -->
        <!-- Every label carries its explanation. The app's own tooltip, never
             the browser's: a `title` attribute waits a second, cannot be
             styled, and does not appear on touch at all. -->
        <dl>
          <template v-for="row in statRows" :key="row.label">
            <dt
              :class="{ 'mt-stat-explained': row.explain }"
              v-tooltip="row.explain || undefined"
            >{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
          </template>
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
            <!-- The producing module's own page, which opens on its technical
                 record. A step page for a DOCUMENT would show today's version
                 beside this run's result, which is why those are gone; a link
                 to the module that produced a finding is navigation between
                 records, and the note beside it still says the exact bytes are
                 in the `inputs` artefact. -->
            <RouterLink
              v-else-if="i.route"
              :to="i.route"
              v-tooltip="'Opens that module\'s own record — its run, inputs and outputs'"
            >{{ i.label }} ↗</RouterLink>
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
        <!-- Opened in a tab of its own rather than expanded here. A prompt is
             a page of text; read inside a panel inside a page it is a keyhole,
             and it pushed everything below it far off screen.
             Files the prompt cannot work without get their own line for the
             same reason: LangExtract's few-shot examples are handed to the
             extractor separately and never enter the prompt text, so the
             template alone would show only part of what the run was given. -->
        <ul v-if="prompts.length" class="mt-files">
          <template v-for="p in prompts" :key="p.file">
            <li>
              <button
                v-if="p.text"
                type="button"
                class="mt-linkish"
                v-tooltip="'Opens this run\'s copy in a new tab'"
                @click="openPromptFile(p)"
              >
                {{ p.name }} ↗
              </button>
              <span v-else>{{ p.name }}</span>
              <span class="mt-files-note">{{ p.label }}</span>
              <p class="mt-prompt-path">
                {{ p.text ? promptProvenance(p) : 'This run did not store the prompt text.' }}
              </p>
            </li>
            <li v-for="a in p.attachments || []" :key="a.file">
              <button
                v-if="a.text"
                type="button"
                class="mt-linkish"
                v-tooltip="'Opens this run\'s copy in a new tab'"
                @click="openPromptFile(a)"
              >
                {{ (a.file || '').split('/').pop() }} ↗
              </button>
              <span class="mt-files-note">handed to the model alongside the prompt</span>
              <p class="mt-prompt-path">{{ promptProvenance(a) }}</p>
            </li>
          </template>
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
          Everything here is what this run was given, not what the submission holds today.
          Each file opens the exact version this run read; anything without a link had its
          exact bytes recorded in the <code>inputs</code> file above.
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
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 1.5rem 2rem;
  align-items: start;
}
.mt-block { min-width: 0; }
/* THE ROW MUST ADD UP: every block sits on ONE row, and the spans total the
   track count.

     Metadata 1 + Configuration 1 + Statistics 1 + inputs 2 + outputs 2 = 7

   It stopped adding up when Metadata was added as a fourth short list and the
   spans were left alone — 1+1+1+2+2 = 7 in a six-track grid, so Module outputs
   could not fit in the one track that remained and wrapped to a row of its own,
   leaving the row above ragged and half empty. The grid grew a track rather
   than the blocks losing one: the five headings are five columns, and they
   should read as five columns.

   `module-technical-grid.test.js` re-does this arithmetic, because the next
   block anyone adds will break it the same way and it is invisible until
   someone opens the section on a wide screen.

   Metadata, Configuration and Statistics: short label/value lists. */
.mt-narrow { grid-column: span 1; }
/* Module inputs and outputs: lines of links with an explanatory note under
   them, so they need more room than a label/value list. */
.mt-wide { grid-column: span 2; }

/* Below the seven-column width each track would be narrower than a file name,
   so drop to two: the short lists side by side, each wide block on its own
   row. */
@media (max-width: 1099px) {
  .mt-body { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mt-wide { grid-column: span 2; }
}

@media (max-width: 640px) {
  .mt-body { grid-template-columns: minmax(0, 1fr); }
  .mt-narrow, .mt-wide { grid-column: span 1; }
}
/* A label with something to say, marked so the reader knows to hover. */
.mt-stat-explained {
  text-decoration: underline dotted #d1d5db;
  text-underline-offset: 0.2em;
  cursor: help;
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
