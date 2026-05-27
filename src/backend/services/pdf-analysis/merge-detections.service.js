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

const {
  extractIdentifierTokens,
  computeDedupKey,
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
  if (primary.newReuse !== candidate.newReuse) return false;
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
  const name = normalizeName(other.resourceName);
  if (name) primary._names.add(name);
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
    detectedBy: r.detectedBy
  }));
}

module.exports = {
  mergeDetections,
  // Exposed for tests
  toResource,
  shouldMerge,
  mergeAdditionalInfo,
  normalizeResourceTypeKey,
  outranks,
  SOURCE_PRECEDENCE
};
