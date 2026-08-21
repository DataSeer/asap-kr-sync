<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSubmissionStore } from '@/stores/submission.store'
import { useKRTStore } from '@/stores/krt.store'
import { useNotificationStore } from '@/stores/notification.store'
import { setSubmissionTitle } from '@/router'
import SubmissionHeader from '@/components/submission/SubmissionHeader.vue'
import LoadError from '@/components/common/LoadError.vue'
import { describeLoadError } from '@/utils/load-error'
import dasSuggestionsService from '@/services/das-suggestions.service'

const route = useRoute()
const router = useRouter()
const submissionStore = useSubmissionStore()
const krtStore = useKRTStore()
const notificationStore = useNotificationStore()

const submission = computed(() => submissionStore.currentSubmission)
const latestFiles = computed(() => submissionStore.latestFiles)
const krtRows = computed(() => krtStore.rows)
const asText = computed(() => submission.value?.dataAvailabilityStatement || '')
const extractedDAS = computed(() => submission.value?.extractedDataAvailabilityStatement || '')
const dasWasModified = computed(() => {
  return extractedDAS.value
    && extractedDAS.value !== 'Not found'
    && extractedDAS.value !== asText.value
})

// ── Confirming the statement ──────────────────────────────────────────────
// The check reads a paragraph that was pulled out of the manuscript
// automatically, and extraction gets it wrong often enough to matter. A check
// of the wrong paragraph is worse than none, because the report presents it as
// the author's own statement.
//
// So the check waits for a person. Writing the statement by hand already says
// the same thing (the server records that as the confirmation), which is why
// this only appears for text nobody has touched.
const dasConfirmed = computed(() => !!submission.value?.dasConfirmedAt)
const needsConfirmation = computed(() =>
  !!asText.value && asText.value !== 'Not found' && !dasConfirmed.value
)
const confirmingDAS = ref(false)

async function confirmDAS() {
  confirmingDAS.value = true
  // Optimistic, and set BEFORE the await on purpose: confirming unlocks the
  // suggestions card, and the card would otherwise render its "the check
  // failed, here are the built-in rules" state for the round-trip — advice
  // about the statement, arriving before anything had checked it.
  //
  // The loader is the honest thing to show while we do not know yet.
  dasJobStatus.value = 'queued'
  try {
    // The server says whether a run actually started. It may not have: the
    // check can already have run on this statement, or be gated to a later
    // step. Promising a result that is not coming sends the user back to watch
    // a spinner that will never resolve.
    const { checking } = await submissionStore.confirmDas(route.params.id)
    notificationStore.success(
      checking ? 'Statement confirmed — checking it now' : 'Statement confirmed'
    )
    if (checking) {
      // Leave the optimistic `queued` in place; the poller corrects it.
      startPolling()
    } else {
      // Nothing was started, so the optimistic status is a lie — replace it
      // with whatever is actually there.
      await fetchDasSuggestions()
    }
  } catch (error) {
    dasJobStatus.value = 'none'
    notificationStore.error(
      error.response?.data?.error || 'Could not confirm the Availability Statement'
    )
  } finally {
    confirmingDAS.value = false
  }
}

// DAS editing
const isEditingDAS = ref(false)
const editedDAS = ref('')
const savingDAS = ref(false)

function startEditingDAS() {
  editedDAS.value = asText.value
  isEditingDAS.value = true
}

function cancelEditingDAS() {
  isEditingDAS.value = false
  editedDAS.value = ''
}

async function saveDAS() {
  savingDAS.value = true
  try {
    await submissionStore.updateSubmission(route.params.id, {
      dataAvailabilityStatement: editedDAS.value || null
    })
    isEditingDAS.value = false
    notificationStore.success('Availability Statement updated')
    // The DAS text changed → re-run the LM check against the new statement.
    await regenerateDasSuggestions()
  } catch (error) {
    notificationStore.error('Failed to save Availability Statement')
  } finally {
    savingDAS.value = false
  }
}

// ── LM DAS suggestions (background job) ───────────────────────────────
// The DAS is checked against the ASAP rulebook by a background Gemini job. We
// poll its status: while it runs we show a loader and block Continue; when it
// finishes we render its per-rule verdicts. If the LM is disabled or failed we
// fall back to the legacy in-browser rules (see `allRules` below).
// Statuses that mean "a run is happening, wait for it". `gated` is deliberately
// NOT one: the check has been accepted but is held behind its pipeline gate, so
// nothing is running and there is nothing to wait for. Treating that as running
// blocked Continue for ever — the fail-open that unblocks it lives in the
// poller, and the gated branch never started the poller.
const RUNNING_STATUSES = ['waiting', 'queued', 'processing']
// What is worth keeping an eye on. Wider than RUNNING_STATUSES: a gated step
// starts on its own once the statement is saved — which happens on this page —
// so it is watched without being waited for.
const POLLABLE_STATUSES = [...RUNNING_STATUSES, 'gated']
const dasJobStatus = ref('none')
const lmSuggestions = ref([])
// The booleans the LM was handed as KRT ground truth, and the run metadata
// (model, timing). Surfaced under "more details" so the user can see exactly
// what the check reasoned over.
const lmSignals = ref(null)
const lmMeta = ref(null)
let pollTimer = null

const isGeneratingSuggestions = computed(() => RUNNING_STATUSES.includes(dasJobStatus.value))
const usingLmSuggestions = computed(() => dasJobStatus.value === 'complete' && lmSuggestions.value.length > 0)

// The page falls back to the built-in browser rules whenever the LM check did
// not produce verdicts. That fallback is fine — but silent, it is a lie by
// omission: a weaker set of checks presented in the same green-and-amber cards
// as the model's, with no way to tell which one you are reading. Say so.
const lmCheckFailed = computed(() =>
  ['failed', 'cancelled'].includes(dasJobStatus.value) ||
  (dasJobStatus.value === 'complete' && lmSuggestions.value.length === 0)
)

// Accepted, but held behind its gate — it needs a saved statement to read.
const lmCheckGated = computed(() => dasJobStatus.value === 'gated')

async function fetchDasSuggestions() {
  try {
    const data = await dasSuggestionsService.get(route.params.id)
    // A gated step is accepted but not running — see the note on
    // RUNNING_STATUSES. Collapsed into one status the rest of the view reads.
    dasJobStatus.value = data.gated ? 'gated' : (data.status || 'none')
    lmSuggestions.value = Array.isArray(data.suggestions) ? data.suggestions : []
    lmSignals.value = data.signals || null
    lmMeta.value = data.meta || null
  } catch (error) {
    // Treat a fetch error as terminal so the user isn't stuck — fall back.
    dasJobStatus.value = 'failed'
    lmSuggestions.value = []
    lmSignals.value = null
    lmMeta.value = null
  }
}

// Per-suggestion "more details" disclosure (shows the LM's reasoning). Keyed by
// ruleId (LM) or title (legacy fallback) so it survives sort/filter reordering.
const expandedDetails = ref(new Set())
function detailKey(s) {
  return s.ruleId || s.title
}
function toggleDetails(s) {
  const key = detailKey(s)
  const next = new Set(expandedDetails.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedDetails.value = next
}
function isDetailsOpen(s) {
  return expandedDetails.value.has(detailKey(s))
}

// KRT summary the LM treated as ground truth, mapped to human labels. Only
// meaningful when the LM produced the suggestions (not the legacy fallback).
const SIGNAL_LABELS = {
  has_new_dataset: 'New dataset in the KRT',
  has_new_code: 'New code/software in the KRT',
  has_dataset_resources: 'Any dataset resources',
  has_code_resources: 'Any software/code resources',
  has_protocol_resources: 'Any protocol resources',
  has_lab_material_resources: 'Any lab-material resources'
}
const showSignals = ref(false)
const signalRows = computed(() => {
  if (!usingLmSuggestions.value || !lmSignals.value) return []
  return Object.entries(SIGNAL_LABELS)
    .filter(([key]) => key in lmSignals.value)
    .map(([key, label]) => ({ key, label, value: !!lmSignals.value[key] }))
})

// Safety cap: don't poll (and don't block Continue) forever if the job stalls.
const MAX_POLL_MS = 3 * 60 * 1000
let pollStartedAt = 0

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function startPolling() {
  stopPolling()
  pollStartedAt = Date.now()
  pollTimer = setInterval(async () => {
    if (Date.now() - pollStartedAt > MAX_POLL_MS) {
      // Gave the job long enough — stop waiting, unblock Continue, fall back.
      stopPolling()
      if (RUNNING_STATUSES.includes(dasJobStatus.value)) dasJobStatus.value = 'failed'
      return
    }
    await fetchDasSuggestions()
    if (!POLLABLE_STATUSES.includes(dasJobStatus.value)) stopPolling()
  }, 3000)
}

async function regenerateDasSuggestions() {
  // Same reason as confirmDAS: the loader goes up on the request, not on the
  // reply. Editing the statement also confirms it server-side, so without this
  // the card unlocks mid-round-trip and shows the built-in rules for a beat
  // before the model's arrive.
  const previousStatus = dasJobStatus.value
  dasJobStatus.value = 'queued'
  try {
    const result = await dasSuggestionsService.regenerate(route.params.id)

    // Three answers, not two. The check is a pipeline step gated to this step,
    // so it can be accepted-but-waiting — and polling for a job that is not
    // going to start would leave a loader spinning for ever.
    if (result?.queued === false) {
      dasJobStatus.value = result.pending ? 'gated' : 'none'
      // Poll anyway when it is gated: the gate opens on the statement being
      // saved, and this is the page that saves it. The poller's own time cap
      // stops it if that never happens.
      if (result.pending) startPolling()
      return
    }

    dasJobStatus.value = 'queued'
    lmSuggestions.value = []
    startPolling()
  } catch (error) {
    // Could not re-queue. Put the status back rather than leave the optimistic
    // `queued` behind — a loader over a request that failed never resolves, and
    // it also blocks Continue.
    dasJobStatus.value = previousStatus === 'queued' ? 'failed' : previousStatus
  }
}

// Step help items
const helpItems = computed(() => [
  {
    title: 'Check your Availability Statement is the right one',
    children: [
      'We read it out of your manuscript automatically — it can pick the wrong passage, or miss it',
      'Edit it here if it is wrong, then confirm it',
      'No recommendations appear until you do: they would be about the wrong statement'
    ],
    done: dasConfirmed.value
  },
  {
    title: 'Review recommendations',
    children: [
      'Outside of this app, edit your manuscript to address each recommendation',
      'Confirm that each recommendation has been addressed or rejected'
    ],
    done: false
  },
  {
    title: 'Click "Continue" to generate a Key Resources Table Assist report',
    done: false
  }
])


// A failed load must not render as an answer. Without this, a 403 or a 500 on
// the submission fetch aborted the rest of the mount chain and the view fell
// through to its usual content — which reads as a statement about the
// manuscript rather than as a page that never received it.
const loadError = ref(null)

onMounted(loadPage)

async function loadPage() {
  loadError.value = null
  krtStore.clearKRT()
  try {
    await submissionStore.fetchSubmission(route.params.id)
  } catch (err) {
    // The built-in rules are computed from the KRT and the statement. With
    // neither loaded they would report a clean statement over nothing at all.
    loadError.value = describeLoadError(err)
    return
  }
  // The KRT and the suggestions are the rest of the answer, and they fail the
  // same way. Left outside this guard, a rejected fetchKRT threw out of the
  // mounted hook: the DAS check never ran, polling never started, and the page
  // showed a clean statement over data it had not loaded.
  try {
    await krtStore.fetchKRT(route.params.id)
    await fetchDasSuggestions()
  } catch (err) {
    loadError.value = describeLoadError(err)
    return
  }

  if (dasJobStatus.value === 'none' && dasConfirmed.value) {
    // First arrival with a statement the author has already vouched for → run
    // the check now.
    //
    // Only when confirmed. This used to fire on every first arrival, and it
    // goes through the MANUAL path — which deliberately skips the auto-advance
    // condition, because a person clicking a step by name has decided to run
    // it. Merely opening a page is not that decision, and the effect was that
    // the confirmation gate never applied to the one route every author takes:
    // the check spent an LM call on a paragraph nobody had read, which is the
    // exact thing it exists to prevent.
    await regenerateDasSuggestions()
  } else if (POLLABLE_STATUSES.includes(dasJobStatus.value)) {
    startPolling()
  }
}

onUnmounted(stopPolling)

watch(submission, (sub) => {
  if (sub) {
    setSubmissionTitle(sub.title || sub.manuscriptId, 'Step 4: Edit manuscript')
  }
}, { immediate: true })

// Helper: check if a row's resource type matches a keyword (case-insensitive)
function rowMatchesType(row, keyword) {
  const rt = (row['RESOURCE TYPE'] || '').toLowerCase()
  return rt.includes(keyword.toLowerCase())
}

// Helper: check if a row is "new"
function isNewRow(row) {
  return (row['NEW/REUSE'] || '').toLowerCase().trim() === 'new'
}

// Resource type group detection helpers
const hasDatasetRows = computed(() => krtRows.value.some(r => rowMatchesType(r, 'dataset')))
const hasCodeRows = computed(() => krtRows.value.some(r => rowMatchesType(r, 'software') || rowMatchesType(r, 'code')))
const hasProtocolRows = computed(() => krtRows.value.some(r => rowMatchesType(r, 'protocol')))
const hasLabMaterialRows = computed(() => {
  const labKeywords = ['antibody', 'bacterial', 'biological', 'chemical', 'critical commercial', 'experimental model', 'oligonucleotide', 'recombinant', 'viral']
  return krtRows.value.some(r => labKeywords.some(kw => rowMatchesType(r, kw)))
})

const hasNewDataset = computed(() => krtRows.value.some(r => rowMatchesType(r, 'dataset') && isNewRow(r)))
const hasNewCode = computed(() => krtRows.value.some(r => (rowMatchesType(r, 'software') || rowMatchesType(r, 'code')) && isNewRow(r)))

const asLower = computed(() => asText.value.toLowerCase())

// Show all rules toggle
const showAllRules = ref(false)

// View mode: 'list' or 'carousel'
const viewMode = ref('list')

// Carousel navigation index
const currentSuggestionIndex = ref(0)

// All rules with their applicability
const allRules = computed(() => {
  const text = asLower.value
  const rules = []

  // Rule 1: No new dataset
  const rule1Applies = !hasNewDataset.value
  rules.push({
    severity: 'warning',
    title: 'No new dataset in the Key Resources Table',
    message: 'This Key Resources Table does not include any new data. If you did collect data, add a row for the data you collected. If you did not collect data, add the text below to your Data/Code Availability Statement.',
    recommendedText: 'No new primary data were collected in this study.',
    applies: rule1Applies,
    notApplicableReason: hasNewDataset.value ? 'Key Resources Table contains new dataset resources' : null
  })

  // Rule 2: No new code
  const rule2Applies = !hasNewCode.value
  rules.push({
    severity: 'warning',
    title: 'No new code in the Key Resources Table',
    message: 'This Key Resources Table does not include any new code. If you did generate code for this study, add a row outlining the code you generated. If you did not generate any code, add the text below to your Data/Code Availability Statement.',
    recommendedText: 'No code was generated for this study; all data cleaning, preprocessing, analysis, and visualization was performed using [insert program name(s)].',
    applies: rule2Applies,
    notApplicableReason: hasNewCode.value ? 'Key Resources Table contains new Software/code resources' : null
  })

  // Rule 3: Resource type mention checks
  const rule3aApplies = hasDatasetRows.value && !text.includes('data')
  rules.push({
    severity: 'info',
    title: 'Dataset resources not mentioned',
    message: 'Your Key Resources Table includes Dataset resources, but the Availability Statement does not mention them.',
    applies: rule3aApplies,
    notApplicableReason: !hasDatasetRows.value ? 'No dataset resources in the Key Resources Table' : text.includes('data') ? 'AS already mentions "data"' : null
  })

  const rule3bApplies = hasCodeRows.value && !text.includes('code') && !text.includes('software')
  rules.push({
    severity: 'info',
    title: 'Software/code resources not mentioned',
    message: 'Your Key Resources Table includes Software/code resources, but the Availability Statement does not mention them.',
    applies: rule3bApplies,
    notApplicableReason: !hasCodeRows.value ? 'No Software/code resources in the Key Resources Table' : (text.includes('code') || text.includes('software')) ? 'AS already mentions Software/code' : null
  })

  const rule3cApplies = hasProtocolRows.value && !text.includes('protocol')
  rules.push({
    severity: 'info',
    title: 'Protocol resources not mentioned',
    message: 'Your Key Resources Table includes Protocol resources, but the Availability Statement does not mention them.',
    applies: rule3cApplies,
    notApplicableReason: !hasProtocolRows.value ? 'No protocol resources in the Key Resources Table' : text.includes('protocol') ? 'AS already mentions "protocol"' : null
  })

  const rule3dApplies = hasLabMaterialRows.value && !text.includes('material') && !text.includes('reagent') && !text.includes('resource')
  rules.push({
    severity: 'info',
    title: 'Lab Material resources not mentioned',
    message: 'Your Key Resources Table includes Lab Material resources, but the Availability Statement does not mention them.',
    applies: rule3dApplies,
    notApplicableReason: !hasLabMaterialRows.value ? 'No lab material resources in the Key Resources Table' : (text.includes('material') || text.includes('reagent') || text.includes('resource')) ? 'AS already mentions materials/reagents' : null
  })

  // Rule 4: No new data explicit statement
  const rule4Applies = !hasNewDataset.value && !text.includes('no new data') && !text.includes('no new primary data')
  rules.push({
    severity: 'warning',
    title: 'Missing explicit no-data statement',
    message: 'The AS should explicitly state that no new data were generated.',
    recommendedText: 'No new primary data were collected in this study.',
    applies: rule4Applies,
    notApplicableReason: hasNewDataset.value ? 'KRT contains new dataset resources' : (text.includes('no new data') || text.includes('no new primary data')) ? 'AS already states no new data' : null
  })

  // Rule 5: No new code explicit statement
  const rule5Applies = !hasNewCode.value && !text.includes('no code') && !text.includes('no new code')
  rules.push({
    severity: 'warning',
    title: 'Missing explicit no-code statement',
    message: 'The AS should explicitly state that no new code was generated.',
    recommendedText: 'No code was generated for this study; all data cleaning, preprocessing, analysis, and visualization was performed using [insert program name(s)].',
    applies: rule5Applies,
    notApplicableReason: hasNewCode.value ? 'KRT contains new code/software resources' : (text.includes('no code') || text.includes('no new code')) ? 'AS already states no new code' : null
  })

  // Rule 6: Key Resources Table reference check
  const rule6Applies = !text.includes('key resource') && !text.includes('krt') && !text.includes('zenodo') && !text.includes('doi') && !text.includes('table number')
  rules.push({
    severity: 'warning',
    title: 'Missing Key Resources Table reference',
    message: 'The AS must indicate that the Key Resources Table lists all research outputs alongside their identifiers.',
    recommendedText: 'The data, code, protocols, and key lab materials used and generated in this study are listed in a Key Resources Table alongside their persistent identifiers at [enter the Zenodo DOI or Table number].',
    applies: rule6Applies,
    notApplicableReason: !rule6Applies ? 'AS references Key Resources Table, Zenodo, DOI, or table' : null
  })

  return rules
})

// The built-in browser rules are a FAILURE fallback, not a default.
//
// They used to fill in whenever the LM check was not `complete` — which
// includes "has not run yet". So the moment the statement was confirmed the
// page showed a full set of built-in recommendations for a beat, then swapped
// them for the model's when the first poll landed. Two different sets of advice
// about the same statement, seconds apart, with nothing to say which was which.
//
// Now: the model's verdicts when it produced them, the built-in rules only when
// the check actually failed, and nothing while it is still working — the loader
// says so instead.
const usingBuiltinRules = computed(() => lmCheckFailed.value)

// Whether the page has an ANSWER to show, from either engine. Distinct from
// "the list is empty": before the check answers there are no suggestions
// because nothing has been checked, and that must never render as a pass.
const hasCheckAnswer = computed(() => usingLmSuggestions.value || usingBuiltinRules.value)

const baseSuggestions = computed(() => {
  if (!dasConfirmed.value) return []
  if (usingLmSuggestions.value) return lmSuggestions.value
  if (usingBuiltinRules.value) return allRules.value
  return []
})

// Filtered suggestions (only applicable ones, or all if showAllRules is true)
// Always sort: applicable first, then N/A
const asSuggestions = computed(() => {
  let rules = showAllRules.value ? baseSuggestions.value : baseSuggestions.value.filter(r => r.applies)
  // Sort: applicable rules first, then N/A
  return [...rules].sort((a, b) => {
    if (a.applies && !b.applies) return -1
    if (!a.applies && b.applies) return 1
    return 0
  })
})

// Continue waits for the confirmation, then for the check.
//
// Without the first, an author can leave this step having never confirmed, the
// check never runs, and the report carries no availability review at all — a
// silence they had no way to notice.
//
// Gated on `needsConfirmation`, not on `dasConfirmed`: a submission with no
// statement has nothing to confirm and nothing to check, so blocking there
// would be a dead end with no way out of it.
const canGoNext = computed(() => !isGeneratingSuggestions.value && !needsConfirmation.value)
const nextBlockedReason = computed(() => {
  if (needsConfirmation.value) {
    return 'Confirm your Availability Statement first — it has not been checked yet.'
  }
  if (isGeneratingSuggestions.value) return 'Generating availability suggestions… please wait.'
  return ''
})

// Current suggestion in carousel mode
const currentSuggestion = computed(() => asSuggestions.value[currentSuggestionIndex.value] || null)

// Carousel navigation
function goToPrevSuggestion() {
  if (currentSuggestionIndex.value > 0) {
    currentSuggestionIndex.value--
  }
}

function goToNextSuggestion() {
  if (currentSuggestionIndex.value < asSuggestions.value.length - 1) {
    currentSuggestionIndex.value++
  }
}

function goToSuggestion(index) {
  if (index >= 0 && index < asSuggestions.value.length) {
    currentSuggestionIndex.value = index
  }
}

// Reset index when suggestions change
watch(asSuggestions, () => {
  if (currentSuggestionIndex.value >= asSuggestions.value.length) {
    currentSuggestionIndex.value = Math.max(0, asSuggestions.value.length - 1)
  }
})

function copyText(text) {
  navigator.clipboard.writeText(text)
  notificationStore.success('Copied to clipboard')
}

async function handleNext() {
  try {
    await submissionStore.updateSubmission(route.params.id, { status: 'step_report' })
    router.push({ name: 'submission-report', params: { id: route.params.id } })
  } catch (error) {
    notificationStore.error('Failed to continue')
  }
}

async function handleBack() {
  try {
    await submissionStore.updateSubmission(route.params.id, { status: 'step_review' })
    router.push({ name: 'submission-review', params: { id: route.params.id } })
  } catch (error) {
    notificationStore.error('Failed to go back')
  }
}
</script>

<template>
  <div class="space-y-6">
    <SubmissionHeader
      :submission="submission"
      :latest-files="latestFiles"
      step-title="Step 4: Edit manuscript"
      step-description="Review your Data/Code Availability Statement"
      :help-items="helpItems"
      :show-navigation="true"
      :can-go-back="true"
      :can-go-next="canGoNext"
      :next-blocked-reason="nextBlockedReason"
      @go-back="handleBack"
      @go-next="handleNext"
    />

    <LoadError
      v-if="loadError"
      title="This submission could not be loaded"
      :message="loadError.message"
      :retryable="loadError.retryable"
      @retry="loadPage"
    />

    <!-- Original extracted DAS (shown when user has modified it) -->
    <div v-if="!loadError && dasWasModified" class="card extracted-das-card">
      <div class="text-xs font-semibold uppercase text-gray-500 mb-1">Original extracted text</div>
      <div class="extracted-das-text">{{ extractedDAS }}</div>
    </div>

    <!-- Confirmation — the check will not run until somebody vouches for the
         text it is about to read. -->
    <div v-if="!loadError && needsConfirmation" class="das-confirm-card">
      <div class="das-confirm-body">
        <p class="das-confirm-title">Is this your Availability Statement?</p>
        <p class="das-confirm-sub">
          We pulled this text out of your manuscript automatically. We will check it against the
          ASAP requirements once you confirm it is the right passage — or edit it below if it is not.
        </p>
      </div>
      <button
        type="button"
        class="das-confirm-btn"
        :disabled="confirmingDAS"
        @click="confirmDAS"
      >
        {{ confirmingDAS ? 'Confirming…' : 'Yes, check it' }}
      </button>
    </div>

    <!-- AS Text Display -->
    <div v-if="!loadError" class="card">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-lg font-medium">Data/Code Availability Statement</h2>
        <button
          v-if="!isEditingDAS"
          class="das-edit-btn"
          @click="startEditingDAS"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          Edit
        </button>
      </div>

      <!-- Edit mode -->
      <div v-if="isEditingDAS">
        <textarea
          v-model="editedDAS"
          class="das-textarea"
          rows="6"
          placeholder="Enter the Data/Code Availability Statement..."
        />
        <div class="das-edit-actions">
          <button class="das-cancel-btn" :disabled="savingDAS" @click="cancelEditingDAS">Cancel</button>
          <button class="das-save-btn" :disabled="savingDAS" @click="saveDAS">
            {{ savingDAS ? 'Saving...' : 'Save' }}
          </button>
        </div>
      </div>

      <!-- Display mode -->
      <template v-else>
        <div v-if="asText" class="as-text-display">
          {{ asText }}
        </div>
        <div v-else class="text-center py-8 text-gray-500">
          <p class="text-sm">No availability statement provided for this submission.</p>
        </div>
      </template>
    </div>

    <!-- Suggestions -->
    <div v-if="!loadError" class="card">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-lg font-medium">
          Suggestions
          <span v-if="dasConfirmed && !isGeneratingSuggestions" class="text-sm font-normal text-gray-500 ml-2">
            {{ asSuggestions.filter(s => s.applies).length }} applicable
            <span v-if="showAllRules"> / {{ baseSuggestions.length }} total</span>
          </span>
        </h2>
        <div v-show="dasConfirmed && !isGeneratingSuggestions" class="flex items-center gap-4">
          <!-- View mode switch -->
          <div class="view-mode-switch">
            <button
              :class="['view-mode-btn', viewMode === 'list' ? 'view-mode-active' : '']"
              v-tooltip="'List view'"
              @click="viewMode = 'list'"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
              </svg>
              <span>Expanded</span>
            </button>
            <button
              :class="['view-mode-btn', viewMode === 'carousel' ? 'view-mode-active' : '']"
              v-tooltip="'Single view'"
              @click="viewMode = 'carousel'"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <span>Focus</span>
            </button>
          </div>
          <!-- Show all checks toggle -->
          <label class="flex items-center cursor-pointer text-sm text-gray-600">
            <input
              v-model="showAllRules"
              type="checkbox"
              class="mr-2 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
            See all checks
          </label>
        </div>
      </div>

      <!-- Locked until the statement has a person behind it.
           The checks are advice about a specific paragraph. Showing them over a
           paragraph the author has never agreed is theirs makes the advice look
           like it is about their statement when it may be about the wrong one —
           and the reader cannot tell the difference. -->
      <div v-if="!dasConfirmed" class="das-locked">
        <svg class="das-locked-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
        <template v-if="needsConfirmation">
          <p class="das-locked-title">Confirm your statement to see the checks</p>
          <p class="das-locked-sub">
            We read the statement above out of your manuscript. Once you confirm it is the right
            passage, we check it against the ASAP requirements and the recommendations appear here.
          </p>
          <button type="button" class="das-locked-btn" :disabled="confirmingDAS" @click="confirmDAS">
            {{ confirmingDAS ? 'Confirming…' : 'Yes, check it' }}
          </button>
        </template>
        <template v-else>
          <p class="das-locked-title">Add your Availability Statement to see the checks</p>
          <p class="das-locked-sub">
            We could not find one in your manuscript. Enter it above and we will check it against
            the ASAP requirements.
          </p>
        </template>
      </div>

      <!-- What the LM check saw: the KRT summary handed to it as ground truth.
           This is the "more details" for the whole run — it explains why a rule
           fired (e.g. "New code in the KRT: No" → the no-new-code checks apply). -->
      <div v-if="dasConfirmed && !isGeneratingSuggestions && signalRows.length" class="signals-panel">
        <button type="button" class="signals-toggle" @click="showSignals = !showSignals">
          <svg class="w-3.5 h-3.5 transition-transform" :class="{ 'rotate-90': showSignals }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
          What the check saw in your Key Resources Table
        </button>
        <div v-if="showSignals" class="signals-body">
          <div class="signals-grid">
            <div v-for="row in signalRows" :key="row.key" class="signal-item">
              <span :class="['signal-flag', row.value ? 'signal-yes' : 'signal-no']">{{ row.value ? 'Yes' : 'No' }}</span>
              <span class="signal-label">{{ row.label }}</span>
            </div>
          </div>
          <p class="signals-hint">
            These booleans are computed from the finalized Key Resources Table and handed to the language model as
            ground truth. A checklist item fires from these — e.g. if there is no row that is both Software/code and
            marked “new”, the no-new-code checks apply regardless of the statement wording.
            <span v-if="lmMeta?.model"> Checked by {{ lmMeta.model }}.</span>
          </p>
        </div>
      </div>

      <!-- Accepted but waiting on a statement to read -->
      <div v-if="dasConfirmed && lmCheckGated" class="das-fallback-notice">
        <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div>
          <p class="das-fallback-title">The AI check is waiting for your statement</p>
          <p class="das-fallback-sub">
            Save an Availability Statement above and it runs on its own. The checks below are the built-in ones
            in the meantime — you are not blocked from continuing.
          </p>
        </div>
      </div>

      <!-- The AI check did not produce verdicts — say which rules are on screen -->
      <div v-if="dasConfirmed && lmCheckFailed && !isGeneratingSuggestions" class="das-fallback-notice">
        <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        </svg>
        <div>
          <p class="das-fallback-title">The AI check did not run — these are the built-in checks</p>
          <p class="das-fallback-sub">
            They are simpler than the model's and will not catch everything it would.
            <button type="button" class="das-fallback-retry" @click="regenerateDasSuggestions">Try the AI check again</button>
          </p>
        </div>
      </div>

      <!-- Loader while the LM check runs -->
      <div v-if="isGeneratingSuggestions" class="das-loader">
        <svg class="animate-spin h-6 w-6 text-primary-600" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <div>
          <p class="das-loader-title">Analyzing the Availability Statement…</p>
          <p class="das-loader-sub">Checking it against the ASAP rulebook. Please wait — this only takes a few seconds.</p>
        </div>
      </div>

      <!-- List View -->
      <div v-else-if="asSuggestions.length > 0 && viewMode === 'list'" class="suggestions-list">
        <div
          v-for="(suggestion, index) in asSuggestions"
          :key="index"
          :class="['suggestion-card', suggestion.applies ? `suggestion-${suggestion.severity}` : 'suggestion-not-applicable']"
        >
          <div class="suggestion-header">
            <span :class="['severity-badge', suggestion.applies ? `badge-${suggestion.severity}` : 'badge-not-applicable']">
              {{ suggestion.applies ? suggestion.severity : 'N/A' }}
            </span>
            <span class="suggestion-title" :class="{ 'text-gray-400': !suggestion.applies }">{{ suggestion.title }}</span>
          </div>
          <p class="suggestion-message" :class="{ 'text-gray-400': !suggestion.applies }">{{ suggestion.message }}</p>
          <!-- Not applicable reason (legacy fallback only — LM results show it under "More details") -->
          <div v-if="!suggestion.applies && suggestion.notApplicableReason && !suggestion.reason" class="not-applicable-reason">
            <svg class="w-4 h-4 text-green-500 mr-1.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
            <span>{{ suggestion.notApplicableReason }}</span>
          </div>
          <div v-if="suggestion.applies && suggestion.recommendedText" class="recommended-text">
            <div class="recommended-label">Recommended text:</div>
            <div class="recommended-content">
              <span class="recommended-value">{{ suggestion.recommendedText }}</span>
              <button
                class="copy-btn"
                v-tooltip="'Copy to clipboard'"
                @click="copyText(suggestion.recommendedText)"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            </div>
          </div>
          <!-- LM reasoning for this verdict (applicable or not) -->
          <div v-if="suggestion.reason" class="details-section">
            <button type="button" class="details-toggle" @click="toggleDetails(suggestion)">
              {{ isDetailsOpen(suggestion) ? 'Hide details' : 'More details' }}
            </button>
            <div v-if="isDetailsOpen(suggestion)" class="details-body" :class="{ 'details-passed': !suggestion.applies }">
              <div class="details-label">{{ suggestion.applies ? 'Why the check flagged this' : 'Why this check does not apply' }}</div>
              <p class="details-reason">{{ suggestion.reason }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Carousel View -->
      <div v-else-if="asSuggestions.length > 0 && viewMode === 'carousel'" class="carousel-view">
        <div
          v-if="currentSuggestion"
          :class="['suggestion-card', currentSuggestion.applies ? `suggestion-${currentSuggestion.severity}` : 'suggestion-not-applicable']"
        >
          <div class="suggestion-header">
            <span :class="['severity-badge', currentSuggestion.applies ? `badge-${currentSuggestion.severity}` : 'badge-not-applicable']">
              {{ currentSuggestion.applies ? currentSuggestion.severity : 'N/A' }}
            </span>
            <span class="suggestion-title" :class="{ 'text-gray-400': !currentSuggestion.applies }">{{ currentSuggestion.title }}</span>
          </div>
          <p class="suggestion-message" :class="{ 'text-gray-400': !currentSuggestion.applies }">{{ currentSuggestion.message }}</p>
          <!-- Not applicable reason (legacy fallback only — LM results show it under "More details") -->
          <div v-if="!currentSuggestion.applies && currentSuggestion.notApplicableReason && !currentSuggestion.reason" class="not-applicable-reason">
            <svg class="w-4 h-4 text-green-500 mr-1.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
            <span>{{ currentSuggestion.notApplicableReason }}</span>
          </div>
          <div v-if="currentSuggestion.applies && currentSuggestion.recommendedText" class="recommended-text">
            <div class="recommended-label">Recommended text:</div>
            <div class="recommended-content">
              <span class="recommended-value">{{ currentSuggestion.recommendedText }}</span>
              <button
                class="copy-btn"
                v-tooltip="'Copy to clipboard'"
                @click="copyText(currentSuggestion.recommendedText)"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            </div>
          </div>
          <!-- LM reasoning for this verdict (applicable or not) -->
          <div v-if="currentSuggestion.reason" class="details-section">
            <button type="button" class="details-toggle" @click="toggleDetails(currentSuggestion)">
              {{ isDetailsOpen(currentSuggestion) ? 'Hide details' : 'More details' }}
            </button>
            <div v-if="isDetailsOpen(currentSuggestion)" class="details-body" :class="{ 'details-passed': !currentSuggestion.applies }">
              <div class="details-label">{{ currentSuggestion.applies ? 'Why the check flagged this' : 'Why this check does not apply' }}</div>
              <p class="details-reason">{{ currentSuggestion.reason }}</p>
            </div>
          </div>
        </div>

        <!-- Carousel navigation -->
        <div v-if="asSuggestions.length > 1" class="carousel-nav">
          <button
            :disabled="currentSuggestionIndex === 0"
            class="carousel-arrow"
            :class="currentSuggestionIndex === 0 ? 'carousel-arrow-disabled' : ''"
            @click="goToPrevSuggestion"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </button>

          <div class="carousel-dots">
            <button
              v-for="(suggestion, index) in asSuggestions"
              :key="index"
              class="carousel-dot"
              :class="{
                'carousel-dot-active': index === currentSuggestionIndex,
                'carousel-dot-applicable': index !== currentSuggestionIndex && suggestion.applies,
                'carousel-dot-na': index !== currentSuggestionIndex && !suggestion.applies
              }"
              v-tooltip="`${suggestion.title} (${suggestion.applies ? suggestion.severity : 'N/A'})`"
              @click="goToSuggestion(index)"
            />
          </div>

          <button
            :disabled="currentSuggestionIndex === asSuggestions.length - 1"
            class="carousel-arrow"
            :class="currentSuggestionIndex === asSuggestions.length - 1 ? 'carousel-arrow-disabled' : ''"
            @click="goToNextSuggestion"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>

      <!-- No applicable suggestions -->
      <!-- `v-else-if`, not `v-else`. The chain's tail is an ALL-CLEAR, and an
           empty list is not the same as a clean one: with nothing checked there
           are no suggestions BECAUSE nothing has been checked, and a green tick
           there tells the author their statement passed a check that never ran.
           So it renders only when an engine actually answered. -->
      <div v-else-if="dasConfirmed && hasCheckAnswer" class="flex items-center py-4 text-green-700">
        <svg class="w-6 h-6 text-green-500 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p>No issues found with the Availability Statement.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.extracted-das-card {
  background: #f9fafb;
  border: 1px dashed #d1d5db;
}

.extracted-das-text {
  font-size: 0.8125rem;
  line-height: 1.6;
  color: #6b7280;
  font-style: italic;
  white-space: pre-wrap;
  word-break: break-word;
}

.as-text-display {
  padding: 1rem;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  font-size: 0.875rem;
  line-height: 1.6;
  color: #374151;
  white-space: pre-wrap;
  word-break: break-word;
}

.das-edit-btn {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #6b7280;
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: all 0.15s;
}

.das-edit-btn:hover {
  color: #2563eb;
  border-color: #2563eb;
  background: #eff6ff;
}

.das-textarea {
  width: 100%;
  padding: 0.75rem;
  font-size: 0.875rem;
  line-height: 1.6;
  color: #374151;
  background: #fff;
  border: 1px solid #2563eb;
  border-radius: 0.5rem;
  resize: vertical;
  outline: none;
  font-family: inherit;
}

.das-textarea:focus {
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

.das-edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.das-cancel-btn {
  padding: 0.375rem 1rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #6b7280;
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: all 0.15s;
}

.das-cancel-btn:hover {
  background: #f3f4f6;
}

.das-save-btn {
  padding: 0.375rem 1rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #fff;
  background: #2563eb;
  border: 1px solid #2563eb;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: all 0.15s;
}

.das-save-btn:hover {
  background: #1d4ed8;
}

.das-save-btn:disabled,
.das-cancel-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.suggestions-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.suggestion-card {
  padding: 1rem;
  border-radius: 0.5rem;
  border: 1px solid;
}

.suggestion-warning {
  background: #fffbeb;
  border-color: #fde68a;
}

.suggestion-info {
  background: #eff6ff;
  border-color: #bfdbfe;
}

.suggestion-not-applicable {
  background: #f9fafb;
  border-color: #e5e7eb;
}

.badge-not-applicable {
  background: #e5e7eb;
  color: #6b7280;
}

.not-applicable-reason {
  display: flex;
  align-items: flex-start;
  margin-top: 0.5rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
  color: #059669;
  background: #ecfdf5;
  border-radius: 0.375rem;
}

.suggestion-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.severity-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
}

.badge-warning {
  background: #fef3c7;
  color: #92400e;
}

.badge-info {
  background: #dbeafe;
  color: #1e40af;
}

.suggestion-title {
  font-weight: 600;
  font-size: 0.875rem;
  color: #111827;
}

.suggestion-message {
  font-size: 0.8125rem;
  color: #4b5563;
  line-height: 1.5;
}

.recommended-text {
  margin-top: 0.75rem;
  padding: 0.75rem;
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid #e5e7eb;
  border-radius: 0.375rem;
}

.recommended-label {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  color: #6b7280;
  margin-bottom: 0.375rem;
}

.recommended-content {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}

.recommended-value {
  flex: 1;
  font-size: 0.8125rem;
  color: #1f2937;
  font-style: italic;
  line-height: 1.5;
}

.copy-btn {
  flex-shrink: 0;
  padding: 0.375rem;
  color: #6b7280;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  background: #fff;
  cursor: pointer;
  transition: all 0.15s;
}

.copy-btn:hover {
  color: #2563eb;
  border-color: #2563eb;
  background: #eff6ff;
}

/* View mode switch */
.view-mode-switch {
  display: flex;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  overflow: hidden;
}

.view-mode-btn {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #6b7280;
  background: #fff;
  border: none;
  cursor: pointer;
  transition: all 0.15s;
}

.view-mode-btn:not(:last-child) {
  border-right: 1px solid #d1d5db;
}

.view-mode-btn:hover {
  background: #f3f4f6;
  color: #374151;
}

.view-mode-btn.view-mode-active {
  background: #eff6ff;
  color: #2563eb;
}

/* Carousel view */
.carousel-view {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.carousel-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
}

.carousel-arrow {
  padding: 0.375rem;
  color: #6b7280;
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: all 0.15s;
}

.carousel-arrow:hover:not(.carousel-arrow-disabled) {
  color: #2563eb;
  border-color: #2563eb;
  background: #eff6ff;
}

.carousel-arrow-disabled {
  color: #d1d5db;
  cursor: not-allowed;
}

.carousel-dots {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.carousel-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  transition: all 0.15s;
}

.carousel-dot-active {
  background: #2563eb;
  transform: scale(1.25);
}

.carousel-dot-applicable {
  background: #fbbf24;
}

.carousel-dot-applicable:hover {
  background: #f59e0b;
}

.carousel-dot-na {
  background: #d1d5db;
}

.carousel-dot-na:hover {
  background: #9ca3af;
}

/* Per-suggestion "more details" (LM reasoning) */
.details-section {
  margin-top: 0.625rem;
}

.details-toggle {
  display: inline-flex;
  align-items: center;
  padding: 0;
  font-size: 0.75rem;
  font-weight: 600;
  color: #2563eb;
  background: none;
  border: none;
  cursor: pointer;
}

.details-toggle:hover {
  text-decoration: underline;
}

.details-body {
  margin-top: 0.5rem;
  padding: 0.625rem 0.75rem;
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid #e5e7eb;
  border-radius: 0.375rem;
}

/* Passed (not-applicable) verdicts get a green accent */
.details-body.details-passed {
  background: #ecfdf5;
  border-color: #a7f3d0;
}

.details-body.details-passed .details-label {
  color: #059669;
}

.details-body.details-passed .details-reason {
  color: #065f46;
}

.details-label {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  color: #6b7280;
  margin-bottom: 0.25rem;
}

.details-reason {
  font-size: 0.8125rem;
  color: #374151;
  line-height: 1.5;
}

/* Section-level KRT signals panel */
.signals-panel {
  margin-bottom: 0.875rem;
  padding: 0.625rem 0.75rem;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
}

.signals-toggle {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.8125rem;
  font-weight: 600;
  color: #374151;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}

.signals-body {
  margin-top: 0.625rem;
}

.signals-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0.375rem 1rem;
}

.signal-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
  color: #374151;
}

.signal-flag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2.25rem;
  padding: 0.0625rem 0.375rem;
  border-radius: 9999px;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
}

.signal-yes {
  background: #dcfce7;
  color: #166534;
}

.signal-no {
  background: #fee2e2;
  color: #991b1b;
}

.signals-hint {
  margin-top: 0.625rem;
  font-size: 0.75rem;
  color: #6b7280;
  line-height: 1.5;
}

.das-fallback-notice {
  @apply flex items-start gap-3 p-4 mb-4 rounded-lg border border-amber-200 bg-amber-50 text-amber-800;
}
.das-fallback-title {
  @apply text-sm font-semibold;
}
.das-fallback-sub {
  @apply text-sm mt-0.5;
}
.das-fallback-retry {
  @apply underline font-medium hover:text-amber-900;
}

.das-loader {
  display: flex;
  align-items: center;
  gap: 0.875rem;
  padding: 1.25rem;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
}

.das-loader-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: #111827;
}

.das-loader-sub {
  font-size: 0.8125rem;
  color: #6b7280;
  margin-top: 0.125rem;
}

/* Confirmation prompt — deliberately the loudest thing on the page while it is
   showing: nothing downstream happens until it is answered. */
.das-confirm-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem 1.25rem;
  margin-bottom: 1rem;
  border: 1px solid #fcd34d;
  border-left: 4px solid #f59e0b;
  border-radius: 0.5rem;
  background: #fffbeb;
}
.das-confirm-body { flex: 1; min-width: 0; }
.das-confirm-title { font-weight: 600; color: #78350f; }
.das-confirm-sub { margin-top: 0.25rem; font-size: 0.875rem; color: #92400e; }
.das-confirm-btn {
  flex-shrink: 0;
  padding: 0.5rem 1rem;
  border-radius: 0.375rem;
  background: #b45309;
  color: #fff;
  font-size: 0.875rem;
  font-weight: 600;
  transition: background 0.15s;
}
.das-confirm-btn:hover:not(:disabled) { background: #92400e; }
.das-confirm-btn:disabled { opacity: 0.6; cursor: not-allowed; }

@media (max-width: 640px) {
  .das-confirm-card { flex-direction: column; align-items: stretch; }
  .das-confirm-btn { width: 100%; }
}

/* Suggestions, locked until the statement has a person behind it. */
.das-locked {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 0.4rem;
  padding: 2rem 1rem;
}
.das-locked-icon { width: 1.75rem; height: 1.75rem; color: #9ca3af; }
.das-locked-title { font-weight: 600; color: #374151; }
.das-locked-sub { max-width: 34rem; font-size: 0.875rem; color: #6b7280; }
.das-locked-btn {
  margin-top: 0.5rem;
  padding: 0.5rem 1rem;
  border-radius: 0.375rem;
  background: #b45309;
  color: #fff;
  font-size: 0.875rem;
  font-weight: 600;
}
.das-locked-btn:hover:not(:disabled) { background: #92400e; }
.das-locked-btn:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
