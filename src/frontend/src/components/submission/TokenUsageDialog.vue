<script setup>
/**
 * What the document spent, in full, in something you can select.
 *
 * The status bar carries one number and a tooltip. A tooltip is the wrong place
 * for this: it cannot be selected, cannot be copied, and disappears the moment
 * you move toward it — so the per-model split, the failed calls and the reasons
 * they failed were all technically "shown" and practically unreachable. Anyone
 * wanting to paste a figure into a message had to retype it.
 *
 * So: a real dialog, with real text. Everything here is selectable, and the
 * copy button produces a plain-text version for the cases where selecting a
 * table by hand is worse than useless.
 *
 * Tokens only. No price, no rate, no currency — what a token costs changes
 * without the run changing, and a number derived from a rate card is one this
 * app cannot stand behind.
 */
import { computed, ref } from 'vue'

const props = defineProps({
  /** Pipeline runs with `usage` and `steps[].usage`, newest first. */
  runs: { type: Array, default: () => [] },
  /** Whether the dialog is showing. */
  open: { type: Boolean, default: false }
})

defineEmits(['close'])

const copied = ref(false)

/**
 * A count, or an em dash when there is not one.
 *
 * Null and zero are different claims. A reconstructed run has no thinking or
 * cached breakdown — those fields were never read — and printing 0 there would
 * assert no thinking happened, when the old tally folded thinking INTO output
 * and we know some of it did.
 */
const n = (value) => (value === null || value === undefined ? '—' : value.toLocaleString())

/** Runs that recorded anything, oldest first — the order they happened in. */
const rows = computed(() =>
  props.runs
    .filter(run => run.usage)
    .slice()
    .sort((a, b) => (a.runNumber || 0) - (b.runNumber || 0))
    .map(run => ({
      runNumber: run.runNumber,
      date: String(run.createdAt || '').slice(0, 10),
      usage: run.usage,
      models: Object.entries(run.usage.byModel || {}).map(([model, b]) => ({ model, ...b })),
      // Carried-over steps are SHOWN, and marked. A run that re-executes one
      // module still lists the other eleven — it reused their results rather
      // than running them again — and dropping them would leave a reader
      // wondering why a twelve-step pipeline itemised into one line.
      //
      // They contribute nothing to this run's total, because nothing was
      // spent: the tokens were paid for by the run that actually executed
      // them, and are counted there. Showing their original figure here would
      // make the column disagree with the run total and double-count the
      // document. So the marker says "reused" and the number stays with the
      // run that earned it.
      //
      // A module that called no model has no usage and is left out rather than
      // listed as a zero — it did not spend nothing, it did not spend.
      steps: (run.steps || [])
        .filter(s => s.usage)
        .map(s => ({ jobType: s.jobType, usage: s.usage, reused: Boolean(s.carriedOver) }))
    }))
)

const totals = computed(() => {
  const out = { totalTokens: 0, promptTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedTokens: 0, calls: 0, runs: rows.value.length }
  for (const row of rows.value) {
    for (const key of ['totalTokens', 'promptTokens', 'outputTokens', 'thoughtTokens', 'cachedTokens', 'calls']) {
      // Unknown plus known is unknown. A reconstructed run has no thinking
      // figure, and adding it as zero would let the summary state a total
      // thinking number that is short by however much those runs thought.
      if (out[key] === null) continue
      const value = row.usage[key]
      if (value === null || value === undefined) out[key] = null
      else out[key] += value
    }
  }
  return out
})

/** Failed calls, grouped by why — the part that says how unknown the figure is. */
const unmeasured = computed(() => {
  const byReason = {}
  for (const row of rows.value) {
    for (const u of (row.usage.unmeasured || [])) {
      byReason[u.reason] = (byReason[u.reason] || 0) + 1
    }
  }
  return Object.entries(byReason).map(([reason, count]) => ({ reason, count }))
})

/**
 * Runs that spent something and recorded nothing.
 *
 * Dropping them from the table is right — there is nothing to put in a row —
 * but dropping them from the COUNT would let "across 1 run" describe a document
 * that was processed twice. The run happened; only the measurement is missing.
 */
const unrecordedRuns = computed(() => props.runs.filter(run => !run.usage).length)

/** Whether any run reused an earlier result, which the marker needs explaining for. */
const hasReused = computed(() => rows.value.some(row => row.steps.some(s => s.reused)))

/** Runs whose figures were rebuilt from the tally that predated the columns. */
const backfilledRuns = computed(() => props.runs.filter(run => run.usage?.backfilled).length)

const notCounted = computed(() => {
  const all = new Set()
  for (const row of rows.value) for (const s of (row.usage.notCounted || [])) all.add(s)
  return [...all]
})

/** Plain language for each failure, since the codes are ours and not obvious. */
const REASON_TEXT = {
  timeout: 'timed out — the prompt was sent and the answer never arrived, so this one may well have been charged',
  server_error: 'the provider returned an error — the work did not complete, so it is generally not charged',
  rate_limited: 'rate-limited — rejected before the model ran, so it is not charged',
  no_response: 'never reached the provider — nothing ran and nothing was charged',
  rejected: 'rejected by the provider',
  unknown: 'failed for a reason we could not classify'
}

/** The same figures as text, for pasting somewhere this dialog is not. */
const asText = computed(() => {
  const lines = ['Token usage (estimate)', '']
  lines.push(`Total: ${n(totals.value.totalTokens)} tokens over ${n(totals.value.calls)} model call(s), across ${totals.value.runs} run(s)`)
  lines.push(`  sent ${n(totals.value.promptTokens)} · returned ${n(totals.value.outputTokens)}`
    + (totals.value.thoughtTokens ? ` (of which ${n(totals.value.thoughtTokens)} thinking)` : '')
    + (totals.value.cachedTokens ? ` · ${n(totals.value.cachedTokens)} cached` : ''))
  lines.push('')

  for (const row of rows.value) {
    lines.push(`Run ${row.runNumber} — ${row.date} — ${n(row.usage.totalTokens)} tokens`)
    for (const m of row.models) {
      lines.push(`  ${m.model}: ${n(m.totalTokens)} total · sent ${n(m.promptTokens)} · returned ${n(m.outputTokens)} · ${n(m.calls)} call(s)`)
    }
    for (const s of row.steps) {
      lines.push(s.reused
        ? `    ${s.jobType}: reused from an earlier run, nothing spent here`
        : `    ${s.jobType}: ${n(s.usage.totalTokens)} tokens, ${n(s.usage.calls)} call(s)`)
    }
    lines.push('')
  }

  if (backfilledRuns.value) {
    lines.push(`${backfilledRuns.value} run(s) were reconstructed from the old tally — totals exact,`
      + ' thinking and cached breakdowns unmeasured.')
  }
  if (unrecordedRuns.value) {
    lines.push(`Not included: ${unrecordedRuns.value} earlier run(s) that recorded no usage.`)
  }
  if (notCounted.value.length) {
    lines.push(`Not included: the ${notCounted.value.join(', ')} pass — it reports no usage of its own.`)
  }
  for (const u of unmeasured.value) {
    lines.push(`Not measured: ${u.count} call(s) ${REASON_TEXT[u.reason] || u.reason}`)
  }
  lines.push('')
  lines.push('These are the figures the provider reported back to the app.')
  lines.push('The provider console is the authority on what was actually billed.')
  return lines.join('\n')
})

async function copy() {
  try {
    await navigator.clipboard.writeText(asText.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // Clipboard refused (insecure context, permission). The text is on screen
    // and selectable, which is the point of the dialog — say so rather than
    // fail silently.
    copied.value = false
  }
}
</script>

<template>
  <Transition name="fade">
    <div v-if="open" class="tu-overlay" @click.self="$emit('close')">
      <div
        class="tu-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tu-title"
        @keydown.esc="$emit('close')"
      >
        <div class="tu-head">
          <h3 id="tu-title" class="tu-title">Token usage (estimate)</h3>
          <button type="button" class="tu-close" aria-label="Close" @click="$emit('close')">×</button>
        </div>

        <p class="tu-summary">
          <b>{{ n(totals.totalTokens) }}</b> tokens over {{ n(totals.calls) }} model call{{ totals.calls === 1 ? '' : 's' }},
          across {{ totals.runs }} run{{ totals.runs === 1 ? '' : 's' }}.
          <span class="tu-muted">
            Sent {{ n(totals.promptTokens) }} · returned {{ n(totals.outputTokens) }}<template v-if="totals.thoughtTokens">
              (of which {{ n(totals.thoughtTokens) }} thinking)</template><template v-if="totals.cachedTokens">
              · {{ n(totals.cachedTokens) }} cached</template>.
          </span>
        </p>

        <p v-if="!rows.length" class="tu-empty">
          Nothing was recorded for this document. Runs from before token usage was captured show no figure,
          rather than a zero — they did not cost nothing, we simply did not count.
        </p>

        <div v-for="row in rows" :key="row.runNumber" class="tu-run">
          <p class="tu-run-head">
            Run {{ row.runNumber }}
            <span class="tu-muted">{{ row.date }}</span>
            <span class="tu-run-total">{{ n(row.usage.totalTokens) }} tokens</span>
          </p>

          <table class="tu-table">
            <thead>
              <tr>
                <th>Model</th><th>Sent</th><th>Returned</th><th>Thinking</th><th>Cached</th><th>Calls</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in row.models" :key="m.model">
                <td class="tu-name">{{ m.model }}</td>
                <td>{{ n(m.promptTokens) }}</td>
                <td>{{ n(m.outputTokens) }}</td>
                <td>{{ n(m.thoughtTokens) }}</td>
                <td>{{ n(m.cachedTokens) }}</td>
                <td>{{ n(m.calls) }}</td>
              </tr>
            </tbody>
          </table>

          <table v-if="row.steps.length" class="tu-table tu-steps">
            <thead><tr><th>Module</th><th>Tokens</th><th>Calls</th></tr></thead>
            <tbody>
              <tr v-for="s in row.steps" :key="s.jobType" :class="{ 'tu-reused': s.reused }">
                <td class="tu-name">
                  {{ s.jobType }}
                  <span v-if="s.reused" class="tu-reused-tag">reused</span>
                </td>
                <td>{{ s.reused ? '—' : n(s.usage.totalTokens) }}</td>
                <td>{{ s.reused ? '—' : n(s.usage.calls) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p v-if="hasReused" class="tu-reused-note">
          <b>reused</b> marks a module this run did not execute — it carried the earlier run's result
          forward. Nothing was spent on it here; its tokens are counted against the run that ran it.
        </p>

        <div v-if="notCounted.length || unmeasured.length || unrecordedRuns || backfilledRuns" class="tu-gaps">
          <p class="tu-gaps-head">What this figure leaves out</p>
          <p v-if="backfilledRuns" class="tu-gap">
            <b>{{ backfilledRuns }} run{{ backfilledRuns === 1 ? '' : 's' }}</b> ran before this was
            recorded and {{ backfilledRuns === 1 ? 'was' : 'were' }} reconstructed from what the old
            tally kept. Totals and call counts are exact; the thinking and cached breakdowns show
            <b>—</b> because they were never measured, not because they were zero.
          </p>
          <p v-if="unrecordedRuns" class="tu-gap">
            <b>{{ unrecordedRuns }} earlier run{{ unrecordedRuns === 1 ? '' : 's' }}</b> of this document
            recorded no usage — they ran before it was captured. They are not in the total above.
          </p>
          <p v-if="notCounted.length" class="tu-gap">
            The <b>{{ notCounted.join(', ') }}</b> pass is not included — it reports no usage of its own.
          </p>
          <p v-for="u in unmeasured" :key="u.reason" class="tu-gap">
            <b>{{ u.count }} call{{ u.count === 1 ? '' : 's' }}</b> {{ REASON_TEXT[u.reason] || u.reason }}.
          </p>
        </div>

        <p class="tu-foot">
          These are the figures the provider reported back to the app. The provider console is the
          authority on what was actually billed.
        </p>

        <div class="tu-actions">
          <button type="button" class="tu-copy" @click="copy">
            {{ copied ? 'Copied' : 'Copy as text' }}
          </button>
          <button type="button" class="tu-done" @click="$emit('close')">Close</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.tu-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(17, 24, 39, 0.45);
}
.tu-dialog {
  width: 100%;
  max-width: 44rem;
  max-height: 90vh;
  overflow-y: auto;
  padding: 1.25rem;
  border-radius: 0.75rem;
  background: #fff;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.2);
  /* The whole point of the dialog: this text can be selected. */
  user-select: text;
}
.tu-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
.tu-title { font-size: 1.05rem; font-weight: 600; color: #111827; margin: 0 0 0.6rem; }
.tu-close {
  border: none; background: none; cursor: pointer;
  font-size: 1.4rem; line-height: 1; color: #9ca3af; padding: 0 0.25rem;
}
.tu-close:hover { color: #4b5563; }
.tu-summary { font-size: 0.875rem; color: #374151; margin: 0 0 1rem; line-height: 1.5; }
.tu-muted { color: #6b7280; }
.tu-empty { font-size: 0.8125rem; color: #6b7280; line-height: 1.5; margin: 0 0 1rem; }

.tu-run { margin-bottom: 1.1rem; }
.tu-run-head {
  display: flex; align-items: baseline; gap: 0.5rem;
  margin: 0 0 0.35rem; font-size: 0.8125rem; font-weight: 600; color: #111827;
}
.tu-run-total { margin-left: auto; font-weight: 500; color: #4b5563; }

.tu-table { width: 100%; border-collapse: collapse; font-size: 0.75rem; }
.tu-table th {
  text-align: right; font-weight: 500; color: #6b7280;
  padding: 0.25rem 0.4rem; border-bottom: 1px solid #e5e7eb;
}
.tu-table th:first-child, .tu-table td:first-child { text-align: left; }
.tu-table td { text-align: right; padding: 0.25rem 0.4rem; border-bottom: 1px solid #f3f4f6; color: #374151; }
.tu-name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #111827; }
.tu-steps { margin-top: 0.4rem; }
/* Quieter than a run that actually spent something — it is context for the
   pipeline, not a figure in the total. */
.tu-reused td { color: #9ca3af; }
.tu-reused-tag {
  margin-left: 0.4rem; padding: 0.0625rem 0.3rem;
  font-family: system-ui, sans-serif; font-size: 0.6rem;
  color: #6b7280; background: #f3f4f6; border-radius: 0.25rem;
}
.tu-reused-note {
  margin: 0 0 0.9rem; font-size: 0.72rem; color: #6b7280; line-height: 1.45;
}
.tu-steps th, .tu-steps td { color: #6b7280; }

.tu-gaps { margin: 1rem 0; padding: 0.7rem 0.85rem; background: #fffbeb; border: 1px solid #fde68a; border-radius: 0.5rem; }
.tu-gaps-head { margin: 0 0 0.35rem; font-size: 0.78rem; font-weight: 600; color: #92400e; }
.tu-gap { margin: 0 0 0.25rem; font-size: 0.78rem; color: #78350f; line-height: 1.45; }

.tu-foot { font-size: 0.75rem; color: #6b7280; line-height: 1.45; margin: 0 0 1rem; }

.tu-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
.tu-copy, .tu-done {
  padding: 0.4rem 0.8rem; font-size: 0.8125rem; border-radius: 0.375rem; cursor: pointer;
}
.tu-copy { border: 1px solid #d1d5db; background: #fff; color: #374151; }
.tu-copy:hover { background: #f9fafb; }
.tu-done { border: 1px solid transparent; background: #2563eb; color: #fff; }
.tu-done:hover { background: #1d4ed8; }

.fade-enter-active, .fade-leave-active { transition: opacity 0.15s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
