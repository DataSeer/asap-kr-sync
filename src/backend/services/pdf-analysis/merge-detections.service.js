/**
 * Merge detection results from multiple sources into a deduplicated
 * "Generated KRT" — one entry per logical resource.
 *
 * Match rule (per the project's spec):
 *   - same resourceType (case-insensitive, trimmed)
 *   - same newReuse (case-insensitive); if different → NOT a duplicate
 *   - identifiersMatch OR namesMatch → duplicate
 *
 * When duplicates merge:
 *   - additional_information is concatenated, line-deduplicated
 *   - detected_by gets a new entry per contributor
 *   - confidence becomes the max across contributors
 *   - resource_name / source_url / identifier are taken from the highest-
 *     confidence contributor (deterministic tiebreak: first seen)
 *
 * Pure function — no DB, no async, no I/O.
 */

const { pickBestEvidence } = require('./evidence.service');
const {
  extractIdentifierTokens,
  computeDedupKey,
  inferSourceFromIdentifier,
  isProtocolVenueSource,
  normalizeName,
  normalizeRawValue,
  normalizeResourceTypeKey
} = require('./identifier-normalize.service');

/**
 * Cross-source field-ownership precedence.
 *
 * When two contributors collide on the same logical resource (i.e. shouldMerge
 * returns true), the higher-precedence source provides the representative
 * display fields (resourceName, identifier, sourceUrl). Within the same
 * precedence class, confidence still decides — preserving the existing
 * Software-vs-Datasets tiebreak behavior.
 *
 * Today the only meaningful asymmetry is: the targeted NER detectors
 * (Software / Datasets / Protocols / Materials) emit higher-quality canonical
 * names + URLs than the broad-coverage identifier scan, so they should win
 * the representative-fields race regardless of the confidence Score the
 * scanner assigned. The identifier-scan row is still recorded in detectedBy
 * for provenance.
 *
 * Sources not listed default to DEFAULT_PRECEDENCE (0), same class as
 * identifier-scan. Adding a new detector is a one-line change here.
 */
const SOURCE_PRECEDENCE = {
  software_detection:   1,
  datasets_detection:   1,
  protocols_detection:  1,
  materials_detection:  1,
  identifier_detection: 0
};
const DEFAULT_PRECEDENCE = 0;

/**
 * True iff `candidate` should provide the merged group's representative
 * fields, displacing whatever `primary` currently shows. Used in place of a
 * raw confidence comparison so detector precedence beats confidence.
 *
 * The confidence side of the comparison uses `primary.ownerConfidence` —
 * the confidence of the contributor that *currently owns the display fields*
 * — rather than `primary.confidence`, which we keep as the max across all
 * contributors. Without this split, a high-confidence low-precedence
 * contributor (e.g. ID at 0.95) could falsely block a same-precedence
 * candidate from displacing the current owner (e.g. Datasets at 0.8
 * displacing Software at 0.6 even though the row's max conf is 0.95).
 */
function outranks(candidate, primary) {
  const cp = SOURCE_PRECEDENCE[candidate.source] ?? DEFAULT_PRECEDENCE;
  const pp = SOURCE_PRECEDENCE[primary.source]   ?? DEFAULT_PRECEDENCE;
  if (cp !== pp) return cp > pp;
  const ownerConf = primary.ownerConfidence ?? primary.confidence ?? 0;
  return candidate.confidence > ownerConf;
}

/**
 * Normalize a detection item into a uniform shape we can merge.
 * Detection sources emit slightly different field names (see normalizeToStandardFormat
 * in suggestion.service.js for the historical mapping). We accept both shapes here.
 */
function toResource(item, source) {
  // Items can come in two shapes: the "data" sub-object (detection output),
  // or a flat normalized form (the suggestion-style shape). Handle both.
  const d = item.data || item;
  const resourceType = String(d.resourceType ?? d.resource_type ?? '').trim();
  const resourceName = String(d.resourceName ?? d.resource_name ?? d.canonical_name ?? d.name ?? '').trim();
  const newReuse = String(d.newReuse ?? d.new_reuse ?? '').toLowerCase().trim();
  const sourceUrl = String(d.source ?? d.url ?? d.suggestedURL ?? '').trim();
  const identifier = String(d.identifier ?? d.RRID ?? d.suggestedRRID ?? '').trim();
  const additionalInformation = String(d.additionalInformation ?? d.additional_information ?? '').trim();
  const confidence = typeof item.confidence === 'number' ? item.confidence
                    : typeof d.confidence === 'number' ? d.confidence
                    : 0;
  return {
    resourceType,
    resourceName,
    newReuse,
    sourceUrl,
    identifier,
    additionalInformation,
    confidence,
    // Carried explicitly. The intake below filters on
    // evidence.verification.status, and enumerating the fields here without
    // this one meant that check read `undefined` on every item and could never
    // fire — the filter was dead code from the day it was written. Same class
    // as the four other rebuild-by-enumeration sites: a field is lost because
    // a rebuild lists what to keep and someone forgets one.
    evidence: d.evidence ?? item.evidence ?? null,
    source,
    originalItem: item
  };
}

/**
 * True iff a candidate should merge into an already-accepted primary.
 *
 * The primary keeps a UNION of every identifier-token and every normalized
 * name it has ever absorbed (its "aliases"). The candidate matches if its
 * identifier-tokens intersect with primary._idTokens, or its normalized name
 * is in primary._names. This is what makes 3-way chains work:
 *
 *   A (name='Tool', id='id-1')  ──┐
 *   B (name='TOOL', id='id-2')  ──┤  merge by name → primary tracks both ids
 *   C (name='Other', id='id-2') ──┘  match by id-2 in primary._idTokens
 */
function shouldMerge(primary, candidate) {
  if (normalizeResourceTypeKey(primary.resourceType) !== normalizeResourceTypeKey(candidate.resourceType)) return false;

  // A NAMELESS row carries no independent identity — it is only ever "whatever
  // resource this identifier points at". So when either side has no name, skip
  // the new/reuse gate and let the identifier decide.
  //
  // This exists for identifier-only detectors that genuinely cannot know
  // new/reuse — chiefly the published-protocol venue scan, where the DOI proves
  // WHERE a protocol was published but not who authored it. Without this, such
  // a row fails the strict newReuse equality below and surfaces as a second,
  // blank-named "add" suggestion beside the real one.
  //
  // Two NAMED rows still never merge across different new/reuse values (that
  // invariant is covered by its own test). And relaxing the gate here can only
  // ever yield an IDENTIFIER-based merge: the name-set branch at the bottom
  // requires a name on both sides, which is false by construction.
  const eitherNameless = !normalizeName(candidate.resourceName) || primary._names.size === 0;
  if (!eitherNameless && primary.newReuse !== candidate.newReuse) return false;

  // Nameless rows additionally match against EVERY identifier in the primary's
  // field, not just the first one extractIdentifierTokens indexed. Author and
  // detector rows routinely carry a semicolon-joined DOI list ("Protein
  // expression and purification" in the ASAP demo corpus carries twelve
  // protocols.io DOIs); without this, an identifier-only row for the 2nd..12th
  // DOI cannot see that it already belongs to that row and surfaces as a blank
  // duplicate suggestion.
  //
  // Restricted to the nameless case ON PURPOSE. Applying it to named rows would
  // over-merge genuinely distinct resources that happen to cite a DOI in
  // common — in the same manuscript "Flow cytometry" and "Rapalog-induced
  // chemical dimerization" share one protocols.io DOI and must stay two rows.
  if (eitherNameless) {
    const candIdParts = String(candidate.identifier ?? '').split(/[;,\s]+/);
    for (const part of candIdParts) {
      const partNorm = normalizeRawValue(part);
      if (partNorm && primary._idParts.has(partNorm)) return true;
    }
  }
  // Identifier-token intersection
  const candTokens = extractIdentifierTokens(candidate.identifier);
  for (const tok of candTokens) {
    if (primary._idTokens.has(tok)) return true;
  }
  // Opaque-id match for cases where one side is structured and the other isn't
  const candIdNorm = normalizeRawValue(candidate.identifier);
  if (candIdNorm && primary._idValues.has(candIdNorm)) return true;
  // Name-set match
  const candName = normalizeName(candidate.resourceName);
  if (candName && primary._names.has(candName)) return true;
  return false;
}

/**
 * Initialize the alias-tracking sets on a freshly accepted primary.
 */
function seedAliases(primary) {
  primary._idTokens = new Set();
  primary._idValues = new Set(); // opaque normalized identifier values
  // EVERY identifier in the field, not just the first. extractIdentifierTokens
  // returns only the first match per type, so a semicolon-joined field like
  // "doi.org/A ; doi.org/B ; doi.org/C" indexes A and hides B and C. Consulted
  // ONLY by the nameless rule in shouldMerge — see the comment there for why it
  // must not widen matching for named rows.
  primary._idParts = new Set();
  primary._names = new Set();
  absorbAliases(primary, primary);
}

/**
 * Fold `other`'s identifier and name aliases into primary's tracking sets.
 */
function absorbAliases(primary, other) {
  for (const tok of extractIdentifierTokens(other.identifier)) primary._idTokens.add(tok);
  const idNorm = normalizeRawValue(other.identifier);
  if (idNorm) primary._idValues.add(idNorm);
  for (const part of String(other.identifier ?? '').split(/[;,\s]+/)) {
    const partNorm = normalizeRawValue(part);
    if (partNorm) primary._idParts.add(partNorm);
  }
  const name = normalizeName(other.resourceName);
  if (name) primary._names.add(name);
}

/**
 * Combine a curated protocol VENUE with whatever SOURCE a detector proposed:
 * the venue leads, the detector's wording is demoted into parentheses.
 *
 *   ('protocols.io',    'Meyer et al., 2024') → 'protocols.io (Meyer et al., 2024)'
 *   ('JoVE', 'Journal of Visualized Experiments')
 *                                            → 'JoVE (Journal of Visualized Experiments)'
 *   ('protocols.io',    '')                  → 'protocols.io'
 *   ('protocols.io',    'protocols.io')      → 'protocols.io'        (no echo)
 *   ('protocols.io',    'protocols.io (X)')  → 'protocols.io (X)'    (idempotent)
 *
 * Idempotency is required, not cosmetic: consolidation re-runs whenever the
 * user regenerates suggestions, and a naive implementation would nest the
 * parentheses one level deeper on every pass.
 *
 * @param {string} venue    canonical venue name from the catalog
 * @param {string} existing SOURCE proposed by a detector
 * @returns {string}
 */
function applyVenueSource(venue, existing) {
  const detector = String(existing ?? '').trim();
  if (!detector) return venue;

  const lcVenue = venue.toLowerCase();
  const lcDetector = detector.toLowerCase();

  // Detector already named the venue — nothing to demote.
  if (lcDetector === lcVenue) return venue;
  // Already in "Venue (…)" form from an earlier pass — leave it exactly as is.
  if (lcDetector.startsWith(`${lcVenue} (`) && detector.endsWith(')')) return detector;

  return `${venue} (${detector})`;
}

/**
 * Concatenate two additional_information fields, deduplicating by trimmed line.
 * Keeps the first occurrence's line wording when duplicate-detected.
 */
function mergeAdditionalInfo(a, b) {
  const seen = new Set();
  const lines = [];
  for (const raw of [a, b]) {
    if (!raw) continue;
    for (const line of String(raw).split(/\r?\n|;\s*/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(trimmed);
    }
  }
  return lines.join('; ');
}

/**
 * The public entry point. Consumes:
 *   contributions: Array<{ source: string, items: Array }>
 *
 * Each `items` array is whatever the detection's processX returned in
 * result.data.items. We accept both flat normalized items and {data: {...}}
 * suggestion-shaped items via `toResource`.
 *
 * Returns: Array<GeneratedResource>
 *   {
 *     dedupKey: string,
 *     resourceType, resourceName, sourceUrl, identifier,
 *     newReuse, additionalInformation,
 *     detectedBy: [{source, confidence, originalItem}],
 *     confidence: number,
 *   }
 */
function mergeDetections(contributions) {
  // Flatten + normalize every item into one stream.
  const all = [];
  for (const { source, items } of contributions || []) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const r = toResource(item, source);
      // Drop entries without enough info to dedup or display.
      if (!r.resourceType || (!r.identifier && !r.resourceName)) continue;
      // Detectors no longer discard an unverifiable claim — they tag it, so the
      // claim survives for evaluation. The filtering happens HERE instead:
      // `unsupported` means neither the quote nor the resource is in the text,
      // which is not something to show a curator. `embellished` IS shown: the
      // quote is not verbatim but the resource is genuinely present.
      if (r.evidence && r.evidence.verification
          && r.evidence.verification.status === 'unsupported') continue;
      r.detectedBy = []; // populated as we merge
      all.push(r);
    }
  }

  // Greedy merge: walk in order, fold each into an existing accepted resource
  // if shouldMerge() matches; otherwise accept it as a new resource.
  // Multi-step (transitive) merges work because each primary tracks the UNION
  // of every identifier-token and name it has absorbed (see shouldMerge).
  const accepted = []; // primaries, each with detectedBy[] + alias-tracking sets

  for (const candidate of all) {
    let merged = false;
    for (const primary of accepted) {
      if (shouldMerge(primary, candidate)) {
        // If the candidate outranks the primary, promote its display fields
        // (resourceName, identifier, sourceUrl) — but the primary continues
        // to track all aliases and contributors from both. `outranks` is
        // precedence-then-confidence, so e.g. a Software contribution beats
        // an identifier-scan contribution regardless of confidence.
        if (outranks(candidate, primary)) {
          if (candidate.resourceName) primary.resourceName = candidate.resourceName;
          if (candidate.identifier)   primary.identifier   = candidate.identifier;
          if (candidate.sourceUrl)    primary.sourceUrl    = candidate.sourceUrl;
          // Update the ownership pointer + ownerConfidence so subsequent
          // candidates compare against the NEW owner, not the historical max.
          primary.source = candidate.source;
          primary.ownerConfidence = candidate.confidence;
          // Keep the merged row's display confidence as the max across all
          // contributors (existing semantics, used downstream for sorting).
          if (candidate.confidence > primary.confidence) primary.confidence = candidate.confidence;
        } else {
          // Fill in any blanks the primary has from the candidate's data
          if (!primary.identifier  && candidate.identifier)  primary.identifier  = candidate.identifier;
          if (!primary.sourceUrl   && candidate.sourceUrl)   primary.sourceUrl   = candidate.sourceUrl;
          if (!primary.resourceName && candidate.resourceName) primary.resourceName = candidate.resourceName;
          // `confidence` on the merged row tracks the max across contributors
          // even when this candidate didn't win the field race.
          if (candidate.confidence > primary.confidence) primary.confidence = candidate.confidence;
        }
        // Blank-fill new/reuse. Under the strict gate above this is a no-op
        // (rows only merged when the values were already equal); it matters
        // only for the nameless path, where an identifier-only primary must
        // pick up the new/reuse its named contributor knows. Never overwrites.
        if (!primary.newReuse && candidate.newReuse) primary.newReuse = candidate.newReuse;
        primary.additionalInformation = mergeAdditionalInfo(
          primary.additionalInformation, candidate.additionalInformation
        );
        primary.detectedBy.push({
          source: candidate.source,
          confidence: candidate.confidence,
          originalItem: candidate.originalItem
        });
        absorbAliases(primary, candidate);
        merged = true;
        break;
      }
    }
    if (!merged) {
      candidate.detectedBy = [{
        source: candidate.source,
        confidence: candidate.confidence,
        originalItem: candidate.originalItem
      }];
      // The candidate is also the initial field-owner of its own group.
      candidate.ownerConfidence = candidate.confidence;
      seedAliases(candidate);
      accepted.push(candidate);
    }
  }

  // Auto-detect SOURCE from the identifier (allowlist-only; ambiguous
  // identifiers return null and leave it blank). Two regimes:
  //
  //   * No contributor supplied a source  → fill it, whatever the source kind.
  //   * A contributor DID supply a source → normally left alone, EXCEPT when
  //     the identifier resolves to a published-protocol VENUE. There the
  //     curated catalog outranks the detector: a venue DOI is proof of where
  //     the protocol was published, whereas the LM tends to write a citation
  //     ("Meyer et al., 2024") or "This paper" into SOURCE. The venue becomes
  //     the SOURCE and the detector's wording is demoted into parentheses
  //     rather than discarded, so the curator keeps the context.
  //
  // Restricted to protocol venues on purpose: for data/code repositories a
  // detector-supplied source is usually at least as good as the inferred one,
  // and overriding it would be a much wider behavioural change.
  //
  // The diff engine separately refuses to overwrite a user-filled SOURCE cell,
  // so this never fights a curator's own edit.
  for (const r of accepted) {
    const inferred = inferSourceFromIdentifier(r.identifier);
    if (!inferred) continue;
    if (!r.sourceUrl) {
      r.sourceUrl = inferred;
    } else if (isProtocolVenueSource(inferred)) {
      r.sourceUrl = applyVenueSource(inferred, r.sourceUrl);
    }
  }

  // Stamp the dedup_key on each (computed from final identifying fields).
  for (const r of accepted) {
    r.dedupKey = computeDedupKey({
      resourceType: r.resourceType,
      resourceName: r.resourceName,
      newReuse: r.newReuse,
      identifier: r.identifier
    });
  }

  // Strip transient bookkeeping (`source`, `originalItem`, alias-tracking sets)
  // from the top-level shape — those belong inside detectedBy[] or are private.
  return accepted.map(r => ({
    dedupKey: r.dedupKey,
    resourceType: r.resourceType,
    resourceName: r.resourceName,
    sourceUrl: r.sourceUrl,
    identifier: r.identifier,
    newReuse: r.newReuse,
    additionalInformation: r.additionalInformation,
    confidence: r.confidence,
    // The strongest manuscript evidence any contributor carried, lifted to the
    // top level. It is reachable via detectedBy[].originalItem.evidence, but
    // every consumer that wants to SHOW where a candidate came from would
    // otherwise have to re-derive "best" for itself.
    evidence: pickBestEvidence((r.detectedBy || []).map(c => c?.originalItem?.evidence)),
    detectedBy: r.detectedBy
  }));
}


module.exports = {
  mergeDetections,
  // Exposed for tests
  toResource,
  shouldMerge,
  mergeAdditionalInfo,
  applyVenueSource,
  normalizeResourceTypeKey,
  outranks,
  SOURCE_PRECEDENCE
};
