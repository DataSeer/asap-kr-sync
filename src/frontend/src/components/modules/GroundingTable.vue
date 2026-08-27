<script setup>
/**
 * The KRT Grounding results table.
 *
 * Extracted from JobStatusPanel so the modal and the module page render the
 * SAME table rather than two that drift apart — which is exactly what happened
 * to the verdict logic once before, when the count and the list were computed
 * in different places and disagreed on screen.
 *
 * Everything here is presentation. The verdicts arrive already decided; this
 * decides only how to say them.
 */
import { computed } from 'vue'
import { useColumnResize } from '@/composables/useColumnResize'
import HighlightText from '@/components/submission/HighlightText.vue'
import EvidenceContext from '@/components/common/EvidenceContext.vue'

const props = defineProps({
  /** Grounding outcomes, one per author KRT row. */
  outcomes: { type: Array, default: () => [] },
  /** meta.grounding from the run that produced them. */
  policy: { type: Object, default: null },
  /** Search term to highlight; filtering is the caller's job. */
  search: { type: String, default: '' }
})

/**
 * Default-deny. Every grounding run stamps its policy, so a missing one is a
 * defect — and the safe failure for a defect is to withhold candidate-derived
 * verdicts, not to show ones that may be contaminated by seeding.
 */
const showValues = computed(() => props.policy?.surfaceValues === true)

/**
 * Widths are the STARTING point only — each column can be dragged, and the
 * choice is remembered. "More information" gets the most room because it
 * carries a sentence per row; the rest are sized to their typical content.
 */
const ALL_COLS = [
  { key: 'resourceType', label: 'Resource Type', krt: true, width: 130 },
  { key: 'resourceName', label: 'Resource Name', krt: true, width: 230 },
  { key: 'source', label: 'Source', krt: true, width: 150 },
  { key: 'identifier', label: 'Identifier', krt: true, width: 190 },
  { key: 'newReuse', label: 'New/Reuse', krt: true, width: 90 },
  { key: 'found', label: 'Found', always: true, width: 120 },
  { key: 'matchedBy', label: 'Matched by', width: 110 },
  { key: 'fills', label: 'More information', always: true, width: 420 }
]

/** Shared with the modal's tables, so a width dragged in one is kept in both. */
/** Shared with the other module tables, and separate from the modal's. */
const WIDTHS_KEY = 'moduleView.columnWidths'

const colResize = useColumnResize(WIDTHS_KEY)
const cols = computed(() => (showValues.value ? ALL_COLS : ALL_COLS.filter((c) => c.always || c.krt)))

/** How the row was matched — deterministic key, or the targeted LM search. */
const MATCHED_BY_LABELS = { lm_second_look: 'LM search', partial_name: 'partial name' }

/**
 * Was the author's row found in the manuscript, and on what.
 *
 * Built from the direct search — the row's own name and identifier looked for
 * in the text — so it means the same thing in every pipeline, seeded or not.
 * The label names WHICH field matched, because "found" without saying what was
 * found is exactly what made a row read as contradicting itself.
 *
 * Colours follow one rule each: green asks nothing of the reader, blue is a
 * real signal that still wants a glance, orange is nothing found at all, red is
 * reserved for errors. Grey is unused — every row reaches one of the four.
 *
 * @param {object} o - a grounding outcome
 * @returns {{label: string, cls: string, title: string}}
 */
function foundVerdict(o) {
  // Every run records presence, so a row without it is a defect rather than an
  // old result. Say nothing rather than guess a verdict from the other fields.
  if (!o?.presence) return { label: '—', cls: 'grounding-unknown', title: 'Presence was not recorded for this row.' }

  const p = o.presence
  const conflicts = o.conflicts?.length || 0
  const occurrences = p.occurrences || 0

  // A disagreement outranks how the row was located: the row IS there, and the
  // mismatch is the thing worth reading.
  //
  // RED, not blue. This is not "have a look when you get a chance" — one of the
  // two sources is wrong. Either the manuscript prints an identifier that
  // contradicts the KRT, or the KRT contradicts the paper, and both are errors
  // a reader has to resolve rather than note. It is the only verdict here that
  // reports a defect rather than a degree of confidence.
  // AMBER, not red. It used to be red and called "Incoherence", on the premise
  // that one of the two sources must be wrong. That premise was false twice over:
  // the value it compared against came from the curated enrichment list rather
  // than the manuscript, so the "disagreement" was often with something the paper
  // never said — and even a real difference is not proof the author is wrong,
  // since the paper can be the thing that is out of date.
  if (conflicts > 0) {
    return {
      label: 'Possible mismatch', cls: 'grounding-warn',
      title: `The manuscript names ${conflicts === 1 ? 'a different value' : `${conflicts} different values`} of the same kind beside this resource. Your row is unchanged — compare them under More information and decide which is right.`
    }
  }

  // Matched only once punctuation was normalised: the paper writes it with
  // different spacing or hyphens. Still an exact match, so still green — the
  // reader is simply told, because that difference is worth knowing.
  const via = p.normalised ? ' The manuscript writes it with different spacing or hyphenation.' : ''

  // An IDENTIFIER cell can hold several — a catalogue number AND an RRID — and
  // the manuscript can corroborate one without the other. Saying "identifier
  // found" over a cell where one of two was never located is true and useless:
  // the uncorroborated one is the actionable half, so it is named.
  //
  // "as written" is doing real work. The search is for the author's exact
  // string, and the same accession can appear in another notation — a paper
  // printing `RRID:Addgene_242904` does not contain the string
  // `Addgene #242904`, though it plainly cites the resource. So this reports a
  // MISMATCH between the two spellings, which is true either way, rather than
  // claiming the manuscript never mentions it. Normalising accessions across
  // notations (as the deterministic matcher already does) would remove those
  // false gaps and is deliberately left for later.
  const missing = p.identifiersNotFound || []
  const partOfIds = missing.length > 0 && p.viaIdentifier
    ? ` Not found as written: ${missing.join(', ')}.`
    : ''

  if (p.viaName && p.viaIdentifier) {
    return {
      label: partOfIds ? 'Yes - partial ids' : 'Yes',
      cls: partOfIds ? 'grounding-check' : 'grounding-ok',
      title: `Name and identifier both found in the manuscript (${occurrences} occurrence(s)).${via}${partOfIds}`
    }
  }
  if (p.viaIdentifier) {
    return {
      label: partOfIds ? 'Yes - partial ids' : 'Yes - id',
      cls: partOfIds ? 'grounding-check' : 'grounding-ok',
      title: `The identifier was found in the manuscript; the name as written was not.${via}${partOfIds}`
    }
  }
  if (p.viaName) {
    return { label: 'Yes - name', cls: 'grounding-ok', title: `The name was found in the manuscript; the identifier was not.${via}` }
  }

  // Nothing matched outright. A weaker signal from the matcher still means we
  // saw something, and belongs in blue rather than orange.
  if (o.matchedBy === 'partial_name' || o.matchedBy === 'alias') {
    return { label: 'Partial match - name', cls: 'grounding-check', title: 'Part of the name matches a resource in the manuscript. Not enough to call them the same item — worth a look.' }
  }
  if (o.matchedBy === 'identifier') {
    return { label: 'Partial match - id', cls: 'grounding-check', title: 'An identifier matched a detected resource, but was not found in the manuscript text itself.' }
  }
  if (o.matchedBy === 'lm_second_look') {
    return { label: 'Partial match - name', cls: 'grounding-check', title: 'Only the targeted LM search placed this row. A direct search found neither its name nor its identifier — worth checking.' }
  }

  return { label: 'No', cls: 'grounding-absent', title: 'Neither the name nor the identifier occurs in the manuscript. Your row is kept as-is.' }
}

function groundingMatchedBy(o) {
  if (!o?.matchedBy) return '—'
  return MATCHED_BY_LABELS[o.matchedBy] || o.matchedBy
}

/**
 * Split two values into common prefix / difference / common suffix.
 *
 * Conflicts are usually near-misses — one digit in an RRID, a suffix on a
 * catalogue number — and read as a wall of identical characters with the part
 * that matters buried inside. Highlighting only what differs turns
 * "RRID:AB_2687579 vs RRID:AB_2687580" into a single visible character.
 *
 * @returns {{a: {pre,mid,post}, b: {pre,mid,post}}}
 */
function valueDiff(left, right) {
  const a = String(left ?? '')
  const b = String(right ?? '')
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let post = 0
  while (post < a.length - pre && post < b.length - pre
         && a[a.length - 1 - post] === b[b.length - 1 - post]) post++
  const cut = (v) => ({ pre: v.slice(0, pre), mid: v.slice(pre, v.length - post), post: v.slice(v.length - post) })
  return { a: cut(a), b: cut(b) }
}


/**
 * What the manuscript supplies that the author's row leaves empty.
 *
 * Left behind when this table was extracted from the processes panel, which
 * still has it. The template called it regardless, so the whole table threw as
 * soon as a pipeline surfaced candidate values — invisible under the default
 * pipeline, which withholds them, and fatal under the blind one, which does not.
 */
function groundingFills(o) {
  return Object.keys(o?.foundValues || {}).map((k) => `${k}: ${o.foundValues[k]}`)
}

function groundingConflicts(o) {
  return (o?.conflicts || []).map(c => ({
    field: c.field,
    author: String(c.authorValue ?? ''),
    manuscript: String(c.manuscriptValue ?? ''),
    diff: valueDiff(c.authorValue, c.manuscriptValue)
  }))
}


/**
 * The context paragraph to show beneath a row.
 *
 * Prefers the candidate-derived evidence when the pipeline allows it, and falls
 * back to the first presence mention — which is available in every pipeline,
 * because it comes from searching the manuscript rather than from a detector.
 */
function groundingContext(o) {
  if (showValues.value && (o?.evidence?.quote || o?.evidence?.context)) return o.evidence
  const mention = o?.presence?.mentions?.[0]
  return mention?.context ? mention : null
}

defineExpose({ foundVerdict })
</script>

<template>
  <div class="gt-wrapper">
    <table class="mtable mtable--fixed" :style="colResize.tableStyle('grounding', cols)">
      <thead>
        <tr>
          <th v-for="c in cols" :key="c.key" :style="colResize.headStyle('grounding', c.key, c.width)">
            {{ c.label }}
            <span
              class="mtable-col-resize"
              v-tooltip="'Drag to resize'"
              @mousedown.stop.prevent="colResize.startResize('grounding', c.key, c.width, $event)"
            ></span>
          </th>
        </tr>
      </thead>
      <tbody>
        <template v-for="(o, i) in outcomes" :key="i">
          <!-- An item and its context line are ONE block; the rules that draw
               it live in assets/styles/module-tables.css, shared with every
               other module table. -->
          <tr class="mt-row mt-row-start" :class="{ 'mt-row-end': !groundingContext(o), 'mt-row-alt': i % 2 === 1 }">
            <td class="gt-xs"><HighlightText :text="o.resourceType || ''" :query="search" /></td>
            <td class="gt-name"><HighlightText :text="o.resourceName || ''" :query="search" /></td>
            <td class="gt-xs"><HighlightText :text="o.source || ''" :query="search" /></td>
            <td class="gt-xs"><HighlightText :text="o.identifier || ''" :query="search" /></td>
            <td class="gt-xs">
              <span v-if="o.newReuse">{{ o.newReuse }}</span>
              <span v-else>—</span>
            </td>
            <td class="gt-xs">
              <span class="grounding-badge" :class="foundVerdict(o).cls">{{ foundVerdict(o).label }}</span>
            </td>
            <td v-if="showValues" class="gt-xs">{{ groundingMatchedBy(o) }}</td>
            <td class="gt-xs">
              <!-- The verdict's reasoning, printed rather than hidden behind a
                   hover: a hover cannot be skimmed down a column, and does not
                   exist at all on a touch screen. -->
              <div class="grounding-why">{{ foundVerdict(o).title }}</div>
              <template v-if="showValues">
                <div
                  v-for="(f, fi) in groundingFills(o)" :key="'f' + fi" class="grounding-fill"
                  v-tooltip="'Your row leaves this empty; the manuscript supplies it.'"
                >
                  {{ f }}
                </div>
              </template>
              <!-- Conflicts travel in every pipeline: a value contradicting the
                   manuscript is a defect either way. -->
              <!--
              Not in the paper, and nothing contradicting it. A KRT is allowed to
              carry more than the manuscript prints — most good ones do — so this
              is a note about what was checked, not a finding. Grey, no icon, no
              call to action.
            -->
            <div v-if="(o.unverifiedIdentifiers || []).length" class="grounding-unverified">
              <span class="unverified-label">Not mentioned in the manuscript</span>
              <span class="unverified-note">
                kept as you wrote {{ (o.unverifiedIdentifiers || []).length === 1 ? 'it' : 'them' }} — nothing in the paper contradicts
                {{ (o.unverifiedIdentifiers || []).length === 1 ? 'it' : 'them' }}
              </span>
              <ul class="unverified-list">
                <li v-for="(u, ui) in o.unverifiedIdentifiers" :key="'u' + ui">{{ u }}</li>
              </ul>
            </div>
            <div v-for="(c, ci) in groundingConflicts(o)" :key="'c' + ci" class="grounding-conflict">
                <div class="conflict-field">⚠ {{ c.field }}</div>
                <div class="conflict-line">
                  <span class="conflict-side">your row</span>
                  <span class="conflict-value conflict-value-author"><span>{{ c.diff.a.pre }}</span><mark v-if="c.diff.a.mid">{{ c.diff.a.mid }}</mark><span>{{ c.diff.a.post }}</span></span>
                </div>
                <div class="conflict-line">
                  <span class="conflict-side">manuscript</span>
                  <span class="conflict-value conflict-value-paper"><span>{{ c.diff.b.pre }}</span><mark v-if="c.diff.b.mid">{{ c.diff.b.mid }}</mark><span>{{ c.diff.b.post }}</span></span>
                </div>
              </div>
            </td>
          </tr>
          <tr v-if="groundingContext(o)" class="mt-row mt-row-span mt-row-end" :class="{ 'mt-row-alt': i % 2 === 1 }">
            <td :colspan="cols.length">
              <EvidenceContext :evidence="groundingContext(o)" :show-section="true" />
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    <p v-if="!outcomes.length" class="gt-empty">No rows match the current filters.</p>
  </div>
</template>

<style scoped>
/* No scrolling of its own: the caller provides the scroll frame, and a nested
   scroll container would take the sticky header with it. */
/* NOT min-width: max-content. That sizes the wrapper to the widest the content
   could ever be — with a paragraph in a cell, thousands of pixels — so the
   table overflowed its frame and every column but the first was pushed out of
   view. The table sets its own width (100% until a column is dragged); the
   wrapper only needs to let the frame scroll when it exceeds that. */
.gt-wrapper { min-width: 0; }
/* Borders, spacing, the sticky header and the row-block rules come from
   assets/styles/module-tables.css, shared with every other module table. */
/* Breathing room between items, on whichever row ends one. */

.gt-xs { font-size: 0.75rem; color: #374151; }
.gt-name { font-weight: 500; }
.gt-empty { padding: 1.5rem; text-align: center; color: #9ca3af; font-size: 0.85rem; }

.grounding-badge {
  display: inline-block; padding: 0.05rem 0.4rem; border-radius: 0.25rem;
  font-size: 0.68rem; font-weight: 600; white-space: nowrap;
}
/* One rule each: green asks nothing of the reader, blue is a real signal that
   still wants a glance, orange is nothing found, amber is worth comparing.
   There is no red here any more — this module reports what the manuscript does
   and does not say, and neither of those is the author making a mistake. */
.grounding-ok { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
.grounding-check { background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; }
.grounding-absent { background: #fff7ed; color: #c2410c; border: 1px solid #fed7aa; }
.grounding-warn { background: #fffbeb; color: #92400e; border: 1px solid #fde68a; }
.grounding-unknown { background: #f9fafb; color: #6b7280; border: 1px solid #e5e7eb; }

/* Deliberately quiet: no warning colour, no icon. It reports that something was
   not checkable, which is not the same as something being wrong. */
.grounding-unverified {
  margin-top: 0.4rem; padding: 0.45rem 0.6rem; border-radius: 0.25rem;
  background: #f9fafb; border: 1px solid #e5e7eb; font-size: 0.78rem; color: #4b5563;
}
.unverified-label { font-weight: 600; color: #374151; }
.unverified-note { color: #6b7280; }
.unverified-list { margin: 0.3rem 0 0; padding-left: 1.1rem; font-family: ui-monospace, monospace; font-size: 0.74rem; }

.grounding-why { color: #4b5563; line-height: 1.35; max-width: 34rem; }
.grounding-fill { color: #047857; margin-top: 0.2rem; }
.grounding-conflict { margin-top: 0.4rem; }
.conflict-field {
  font-weight: 600; color: #b91c1c; text-transform: uppercase;
  font-size: 0.68rem; letter-spacing: 0.02em;
}
.conflict-line { display: flex; gap: 0.5rem; align-items: baseline; }
.conflict-side { flex: 0 0 5.5rem; color: #9ca3af; font-size: 0.68rem; }
/* Monospace so the two values line up character for character — the whole
   point when one digit differs. */
.conflict-value {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.72rem; word-break: break-all;
}
.conflict-value-author { color: #111827; }
.conflict-value-paper { color: #1d4ed8; }
.conflict-value mark {
  background: #fde68a; color: inherit; padding: 0 1px;
  border-radius: 2px; font-weight: 700;
}
</style>
