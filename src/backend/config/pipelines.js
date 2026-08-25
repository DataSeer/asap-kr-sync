/**
 * Detection pipelines: named, switchable configurations of the same engine.
 *
 * A pipeline chooses a strategy per detector and sets the few downstream
 * policies that have to agree with that choice. They are grouped here rather
 * than spread across env vars because they are NOT independent — blind
 * detection without surfaced grounding would mean the author's KRT is never
 * reconciled at all, and a registry makes an incoherent combination something
 * you have to write on purpose.
 */

const PIPELINES = Object.freeze({
  /**
   * What ships today. The author's KRT is injected into the detection prompts,
   * so a detector reporting an author row proves only that it was handed one.
   */
  'seeded-v1': {
    id: 'seeded-v1',
    label: 'Author-seeded (current)',
    description: 'The author KRT seeds the detection prompts. Default for everyone.',
    isDefault: true,
    adminOnly: false,
    strategies: {
      materials: 'materials.seeded',
      protocols: 'protocols.seeded',
      datasets: 'datasets.seeded'
    },
    merge: {
      // Candidates whose quote AND resource are both absent from the manuscript
      // are dropped. `embellished` is kept: the quote is not verbatim but the
      // resource is genuinely there, and discarding those was pure recall loss.
      dropUnsupported: true
    },
    reconcile: {
      // Every author row still reaches the Generated KRT even when its
      // detection was dropped — it arrives with the author's own values rather
      // than a claim we could not verify. 'verified-only' and 'none' are the
      // future filters; nothing reads them yet.
      carryAuthorRows: 'all'
    },
    grounding: {
      // Presence is honest in both modes: it is a deterministic search of the
      // author's row against the manuscript and cannot be affected by seeding.
      surfacePresence: true,
      // Candidate matches are NOT honest here. The pool contains the model's
      // echo of the author's own rows, so a match means "it repeated what we
      // gave it", and the output cannot distinguish that from a real find.
      surfaceValues: false,
      // Grounding verifies the AUTHOR's rows against the manuscript, which is
      // independent of how detection was prompted — so it derives its
      // suggestions in both pipelines. True by default in both; kept as a
      // switch because ASAP may later want conflicts shown for a curator to
      // resolve by hand, with no suggestion raised on their behalf.
      //
      // It governs the EMPTY-CELL fills only. A conflict — the author has a
      // value and the manuscript disagrees — never becomes a suggestion either
      // way: it is surfaced as a conflict, and the author's value stands until
      // a curator decides.
      deriveSuggestions: true
    }
  },

  /**
   * Detection never sees the KRT; grounding reconciles it afterwards. Measured
   * at ~24% more discovery than seeded, on 21 of 22 document-runs.
   */
  'blind-v1': {
    id: 'blind-v1',
    label: 'KRT-blind discovery',
    description: 'Detection is KRT-blind; grounding reconciles the author KRT afterwards.',
    isDefault: false,
    adminOnly: true,
    strategies: {
      materials: 'materials.blind',
      protocols: 'protocols.blind',
      datasets: 'datasets.blind'
    },
    merge: { dropUnsupported: true },
    reconcile: { carryAuthorRows: 'all' },
    grounding: { surfacePresence: true, surfaceValues: true, deriveSuggestions: true }
  }
});

const DEFAULT_PIPELINE_ID = Object.values(PIPELINES).find((p) => p.isDefault).id;

/**
 * @param {string} [id]
 * @returns {object} the pipeline; the default when id is empty
 * @throws if the id is unknown — an unrecognised pipeline must never silently
 *   fall back, because the fallback would detect differently and say nothing.
 */
function getPipeline(id) {
  if (!id) return PIPELINES[DEFAULT_PIPELINE_ID];
  const found = PIPELINES[id];
  if (!found) {
    throw new Error(`Unknown pipeline "${id}". Known: ${Object.keys(PIPELINES).join(', ')}`);
  }
  return found;
}

module.exports = { PIPELINES, DEFAULT_PIPELINE_ID, getPipeline };
