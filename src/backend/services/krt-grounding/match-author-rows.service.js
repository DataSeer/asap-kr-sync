/**
 * Match the author's KRT rows against the candidate pool — the deterministic
 * half of grounding.
 *
 * This is the module that answers the app's primary question: *for each row the
 * author wrote, did we find it in the manuscript, and does their row carry
 * everything the manuscript says about it?*
 *
 * Two rules govern everything here:
 *
 *   1. **The author's data is right.** Nothing in this file mutates an author
 *      row. An outcome is a verdict *about* a row, carried beside it. Even
 *      `not_detected` is a tag, never a deletion or a correction.
 *
 *   2. **Never invent a fill.** `missingFields`/`foundValues` only ever propose
 *      a value that a candidate actually carried. An author field that is
 *      already non-empty is never proposed for change, whatever we found.
 *
 * Matching runs an explicit key hierarchy, strongest evidence first, because
 * the identifying field differs per resource type: an accession identifies a
 * dataset, an RRID identifies an antibody, a protocols.io DOI identifies a
 * protocol, and a name identifies a piece of software once its version is
 * stripped. A match on a stronger key is never overridden by a weaker one.
 */

const {
  identifiersMatch,
  extractIdentifierTokens,
  namesMatch,
  normalizeName,
  stripSoftwareVersion,
  normalizeResourceTypeKey
} = require('../pdf-analysis/identifier-normalize.service');

/** Match strength, strongest first. Used to rank and to report `matchedBy`. */
const MATCH_STRENGTH = ['identifier', 'alias', 'name', 'partial_name'];

/**
 * Tokens of a resource name. Dots, hyphens, slashes and underscores are
 * SEPARATORS here, not characters — authors write a construct as
 * "AAV5.CaMKII.GCaMP6f.WPRE.SV40" and the paper names the component "GCaMP6f".
 * @param {string} name
 * @returns {string[]}
 */
function nameTokens(name) {
  return normalizeName(name).split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Tokens too generic to justify a match on their own. Without this, a detector
 * that emitted the bare phrase "cell line" would partial-match every cell line
 * in the table.
 */
const GENERIC_TOKENS = new Set([
  'cell', 'line', 'lines', 'anti', 'buffer', 'kit', 'mouse', 'human', 'rat',
  'rabbit', 'goat', 'donkey', 'chicken', 'igg', 'protein', 'gene', 'plasmid',
  'virus', 'strain', 'medium', 'media', 'assay', 'antibody', 'primary',
  'secondary', 'conjugate', 'the', 'and', 'of'
]);

/**
 * Is this token run specific enough to carry a partial match by itself?
 * One short token ("GFP", "TH", "IgG") is not — those appear inside far too
 * many unrelated names.
 * @param {string[]} tokens
 * @returns {boolean}
 */
function isDistinctive(tokens) {
  if (!tokens.some((t) => !GENERIC_TOKENS.has(t))) return false;
  if (tokens.length >= 2) return true;
  return tokens.length === 1 && tokens[0].length >= 5;
}

/**
 * Does `needle` appear as a CONTIGUOUS run of whole tokens inside `haystack`?
 * Contiguity matters: it keeps "Alexa Fluor 568" from matching "Alexa 568
 * phalloidin" on scattered tokens.
 * @param {string[]} needle
 * @param {string[]} haystack
 * @returns {boolean}
 */
function isTokenRunInside(needle, haystack) {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * Is this resource type one where a trailing number is version noise rather
 * than part of the identity?
 *
 * `stripSoftwareVersion` removes any trailing 1-4 digit number ("Prism 9"),
 * which is correct for software and destructive everywhere else: "Alexa Fluor
 * 568" and "Alexa Fluor 488" both collapse to "alexa fluor", and the matcher
 * then confirms an author's 568 antibody against a detected 488 one and offers
 * to fill in the wrong RRID. Its own docstring already says software-only; this
 * is the gate that enforces it, mirroring `diff-suggestions.service.js`.
 *
 * @param {string} typeKey - normalized resource-type key
 * @returns {boolean}
 */
function isVersionedType(typeKey) {
  return typeKey === 'software/code';
}

/**
 * Author fields grounding may PROPOSE a value for, when the author left the cell
 * empty. Proposing is not an accusation — the curator sees an empty cell and a
 * candidate for it.
 *
 * `newReuse` is deliberately absent. NO detector reads new-versus-reuse from the
 * manuscript; every one hard-codes a default (lm-resource, software, datasets).
 * So a "found value" for it was never a finding — it was our own default handed
 * back, and filling an empty cell from it invented data.
 */
const FILLABLE_FIELDS = ['source', 'identifier'];

/**
 * Author fields grounding may declare an INCOHERENCE on — a disagreement
 * between the author's cell and the manuscript.
 *
 * Narrower than FILLABLE_FIELDS on purpose. This module checks the KRT against
 * the PDF, so it may only contradict the author about things that are genuinely
 * read from the PDF and genuinely comparable:
 *
 *   - identifier — extracted verbatim from the text; comparable.
 *   - resourceName — how a row is matched in the first place, so a mismatch
 *     shows up as "not detected" rather than as a conflict.
 *
 * `source` is excluded even though detectors do populate it: for a dataset it
 * is the repository ("Zenodo"), for a material the supplier ("Sigma"). Those
 * are inferred from where a thing lives, not asserted by the manuscript about
 * the author's row, so a difference is not evidence the author is wrong. It
 * remains fillable — offering a repository for an empty cell is useful; telling
 * a curator their supplier contradicts the paper is not.
 */
const COMPARABLE_FIELDS = ['identifier'];

/**
 * Reconcile author KRT rows against detection candidates.
 *
 * @param {object[]} authorRows - KRTData rows ({ id, resourceType, resourceName, identifier, source, newReuse, additionalInformation })
 * @param {object[]} candidates - KrtEntry[] from the merged candidate pool
 * @returns {{ outcomes: object[], unmatchedCandidateRefs: number[], stats: object }}
 */
function matchAuthorRows(authorRows, candidates, inManuscript) {
  const rows = Array.isArray(authorRows) ? authorRows : [];
  const pool = (Array.isArray(candidates) ? candidates : []).map((candidate, ref) => {
    const typeKey = normalizeResourceTypeKey(candidate?.resourceType || '');
    return { ref, candidate, typeKey, names: candidateNames(candidate, typeKey) };
  });

  const claimedRefs = new Set();
  const outcomes = [];

  for (const row of rows) {
    const outcome = matchOneRow(row, pool, inManuscript);
    outcome.matchedRefs.forEach((ref) => claimedRefs.add(ref));
    outcomes.push(outcome);
  }

  const unmatchedCandidateRefs = pool
    .filter((entry) => !claimedRefs.has(entry.ref))
    .map((entry) => entry.ref);

  return {
    outcomes,
    unmatchedCandidateRefs,
    stats: summarise(outcomes, pool.length, unmatchedCandidateRefs.length)
  };
}

/**
 * Reconcile a single author row against the pool.
 * @param {object} row
 * @param {object[]} pool - pre-indexed candidates
 * @returns {object} outcome
 */
function matchOneRow(row, pool, inManuscript) {
  const rowIdentifier = String(row?.identifier || '').trim();
  const rowTypeKey = normalizeResourceTypeKey(row?.resourceType || '');
  const rowName = row?.resourceName || '';

  let best = null;
  const matched = [];

  for (const entry of pool) {
    // Resource type must agree. Types are compared on the normalized key so
    // "Code/Software" and "Software/code" are the same thing; a candidate with
    // no type at all (identifier-only rows) is allowed to match anything,
    // because an identifier sweep genuinely cannot know the type.
    if (rowTypeKey && entry.typeKey && rowTypeKey !== entry.typeKey) continue;

    const how = matchStrength(rowIdentifier, rowName, rowTypeKey, entry);
    if (!how) continue;

    matched.push({ ref: entry.ref, how });
    if (!best || MATCH_STRENGTH.indexOf(how) < MATCH_STRENGTH.indexOf(best.how)) {
      best = { how, entry };
    }
  }

  const matchedRefs = matched.map((m) => m.ref);

  if (!best) {
    return {
      krtRowId: row?.id ?? null,
      resourceType: row?.resourceType || '',
      resourceName: rowName,
      // The author's own cells travel with the verdict. Showing a bare name
      // makes a verdict unreadable: a row can read "not in manuscript" while
      // its identifier is the thing that WAS found, and with only the name on
      // screen the two look like a contradiction rather than a distinction.
      identifier: row?.identifier || '',
      source: row?.source || '',
      newReuse: row?.newReuse || '',
      additionalInformation: row?.additionalInformation || '',
      outcome: 'not_detected',
      matchedBy: null,
      matchedRefs: [],
      evidence: null,
      missingFields: [],
      foundValues: {},
      conflicts: [],
      reason: 'No detection candidate matched this row by identifier, alias, or name.'
    };
  }

  const matchedEntries = matchedRefs.map((ref) => pool.find((e) => e.ref === ref));

  // Fills may come from ANY matched candidate, not just the strongest one: the
  // identifier sweep often knows the source for a row the LM detector named.
  //
  // Partial-name matches are excluded from that, though. A partial match says
  // the resource is discussed in the manuscript; it does NOT say the candidate
  // and the row are the same product. "GCaMP6f" partially matches the row
  // "AAV5.CaMKII.GCaMP6f.WPRE.SV40", but the bare protein's identifier is not
  // the packaged virus's identifier, and proposing it would put a wrong value
  // into the author's table wearing grounding provenance.
  const fillEntries = matched
    .filter((m) => m.how !== 'partial_name')
    .map((m) => pool.find((e) => e.ref === m.ref));
  const { missingFields, foundValues, conflicts } = compareWithCandidates(row, fillEntries, inManuscript);

  let outcome;
  if (best.how === 'partial_name') {
    // Located, but on the weakest key and with nothing verified about the
    // fields — a distinct verdict rather than a confident `confirmed`.
    outcome = 'partial';
  } else if (missingFields.length > 0 || conflicts.length > 0) {
    // `incomplete` covers BOTH a fillable empty cell and a disagreement —
    // either way the row needs a human look.
    outcome = 'incomplete';
  } else {
    outcome = 'confirmed';
  }

  return {
    krtRowId: row?.id ?? null,
    resourceType: row?.resourceType || '',
    resourceName: rowName,
    identifier: row?.identifier || '',
    source: row?.source || '',
    newReuse: row?.newReuse || '',
    additionalInformation: row?.additionalInformation || '',
    outcome,
    matchedBy: best.how,
    matchedRefs,
    // Evidence DOES come from the partial match — showing the curator where in
    // the text it appears is the entire value of the weak tier.
    evidence: bestEvidence(matchedEntries),
    missingFields,
    foundValues,
    conflicts,
    reason: describeOutcome(best.how, missingFields, conflicts, best.entry)
  };
}

/**
 * How strongly does one candidate match one author row? Returns the strongest
 * applicable key, or null when nothing matches.
 * @returns {'identifier'|'alias'|'name'|null}
 */
function matchStrength(rowIdentifier, rowName, rowTypeKey, entry) {
  // 1. Identifier — the only key that is decisive on its own. identifiersMatch
  //    compares TYPED tokens, so a catalog number can never collide with a DOI,
  //    and it already returns false when either side is blank.
  if (rowIdentifier && String(entry.candidate?.identifier || '').trim()
      && identifiersMatch(rowIdentifier, entry.candidate.identifier)) {
    return 'identifier';
  }

  if (!rowName) return null;

  // 2. Alias — the detector's recorded name variants. This is what recovers
  //    "Cell Profiler" vs "CellProfiler" and "TH" vs "tyrosine hydroxylase".
  //
  //    Version-stripped forms only participate for software (see
  //    isVersionedType); for an antibody or a strain the trailing number IS the
  //    identity, so stripping it would match two different reagents.
  const versioned = isVersionedType(rowTypeKey);
  const normalizedRow = normalizeName(rowName);
  const strippedRow = versioned ? normalizeName(stripSoftwareVersion(rowName)) : '';
  for (const alias of entry.names.aliases) {
    if (!alias) continue;
    if (alias === normalizedRow) return 'alias';
    if (strippedRow && alias === strippedRow) return 'alias';
  }

  // 3. Name — the canonical name, version-insensitively for software only.
  if (namesMatch(rowName, entry.candidate.resourceName)) return 'name';
  if (strippedRow && strippedRow === entry.names.stripped) return 'name';

  // 4. Partial name — the shorter name occurs as a whole-token run inside the
  //    longer one. This is the tier that recovers the author's full construct
  //    against the paper's component name ("AAV5.CaMKII.GCaMP6f.WPRE.SV40" vs
  //    "GCaMP6f"), which strict equality misses entirely.
  //
  //    It is deliberately the WEAKEST tier and never contributes a fill: the
  //    full construct and its component are related, not interchangeable, so
  //    the component's identifier must not be proposed for the construct's row.
  //    It answers "is this in the manuscript?", not "what is its identifier?".
  const rowTokens = nameTokens(rowName);
  const candidateTokens = nameTokens(entry.candidate.resourceName || '');
  if (rowTokens.length && candidateTokens.length) {
    const [shorter, longer] = candidateTokens.length <= rowTokens.length
      ? [candidateTokens, rowTokens]
      : [rowTokens, candidateTokens];
    if (isDistinctive(shorter) && isTokenRunInside(shorter, longer)) return 'partial_name';
  }

  return null;
}

/**
 * Collect a candidate's canonical + alias forms, pre-normalized so matching is
 * a set lookup rather than repeated normalisation per author row.
 * @param {object} candidate
 * @returns {{ canonical: string, stripped: string, aliases: string[] }}
 */
function candidateNames(candidate, typeKey) {
  const name = candidate?.resourceName || '';
  // Aliases can be at THREE depths by the time a candidate reaches grounding,
  // and reading only the first found none at all: `mergeDetections` rebuilds a
  // candidate without `detectorMeta`, so by here the detector's aliases live
  // inside detectedBy[].originalItem. Measured on the demo corpus, 0 of 444
  // candidates had top-level aliases while 83 had them nested — the alias tier
  // never fired once across 574 author rows, for want of this lookup.
  const contributors = [
    ...(candidate?.mergedFrom || []),
    ...(candidate?.detectedBy || [])
  ];
  const rawAliases = [
    ...(candidate?.detectorMeta?.aliases || []),
    ...contributors.flatMap((c) => c?.originalItem?.detectorMeta?.aliases || []),
    // A merged candidate carries the names of everything folded into it; those
    // are alias evidence too.
    ...contributors.map((c) => c?.originalItem?.resourceName)
  ];

  // Same gate as the row side: a version-stripped form of a non-software name
  // is not a synonym, it is a different reagent. Untyped candidates (the
  // identifier sweep, which cannot know the type) are excluded too — they carry
  // an identifier, so they match on the decisive tier rather than needing this.
  const versioned = isVersionedType(typeKey);

  const aliases = new Set();
  for (const alias of rawAliases) {
    const normalized = normalizeName(alias || '');
    if (normalized) aliases.add(normalized);
    if (!versioned) continue;
    const stripped = normalizeName(stripSoftwareVersion(alias || ''));
    if (stripped) aliases.add(stripped);
  }

  return {
    canonical: normalizeName(name),
    stripped: versioned ? normalizeName(stripSoftwareVersion(name)) : '',
    aliases: [...aliases]
  };
}

/**
 * What the MANUSCRIPT says for a field — never what a curated list knows.
 *
 * ── The bug this exists to close ─────────────────────────────────────────────
 *
 * The comparison used to take `supplier.candidate[field]` whole and label it
 * `manuscriptValue`. For an `identifier-scan` candidate that field is filled
 * from the enrichment list: the scanner finds one RRID in the text, looks it
 * up, and attaches every identifier and homepage URL the list holds. All of it
 * was then quoted at the curator as what the paper says.
 *
 * Measured on the reported submission, the comparison raised four conflicts:
 *
 *     Time Series analyzer  vs  RRID:SCR_014269 ; http://ric.uthscsa.edu/...
 *     Analysis Scripts      vs  RRID:SCR_000325 ; http://www.wavemetrics...
 *     IGOR Pro v6.3.7.2     vs  RRID:SCR_000325 ; http://www.wavemetrics...
 *     Sprague-Dawley rats   vs  strain code: 001, RRID: RGD_734476
 *
 * Three of the four cited URLs the manuscript never contained; the fourth was a
 * real disagreement the author needed to see. Restricting each candidate value
 * to the parts the text actually prints leaves exactly that one.
 *
 * ── Why only the comparison is filtered ──────────────────────────────────────
 *
 * The fill half above is deliberately left alone. A tool's homepage from the
 * enrichment list is a GOOD suggestion for an empty cell — it is only unsafe as
 * evidence about the paper. Filling and contradicting need different warrants,
 * and conflating them is what produced the bug.
 *
 * @param {object[]} entries      matched pool entries
 * @param {string} field
 * @param {function} inManuscript value => is it in the manuscript text?
 * @returns {{value: string, origin: string|null}|null}
 */
function manuscriptClaim(entries, field, inManuscript) {
  // No predicate means no manuscript to check against — so nothing may be
  // asserted about one. Deliberately not a permissive default: that default is
  // the old behaviour, and the old behaviour is the bug.
  if (typeof inManuscript !== 'function') return null;

  const supported = entries
    .map((entry) => {
      const parts = String(entry?.candidate?.[field] || '')
        .split(/[;,]/).map((v) => v.trim()).filter(Boolean)
        .filter((v) => inManuscript(v));
      return parts.length
        ? { value: parts.join(', '), origin: entry.candidate.origin || null, confidence: entry.candidate.confidence || 0 }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence);

  return supported[0] || null;
}

/**
 * Compare an author row against what the manuscript supplies.
 *
 * Two different findings come out of this, and only one of them is an edit:
 *
 *   - **fills** — the author's cell is EMPTY and a matched candidate has a value.
 *     Proposed as an update.
 *   - **conflicts** — the author's cell is FILLED and a matched candidate says
 *     something materially different. Reported, never proposed: the author's
 *     value stands, and a curator decides.
 *
 * Fills are rarer than they look. SOURCE and IDENTIFIER are validation *errors*
 * when empty, so any KRT that reached this module has them filled on every row
 * — which is why conflicts, not fills, are what this comparison is really for.
 *
 * A real example from the demo corpus: the KRT says
 * `strain code: 400, RRID: RGD_734476` while the paper says
 * `strain code: 001, RRID: RGD_734476`. The RRIDs agree (that is why the row
 * matched); the catalogue numbers do not. That is worth a curator's attention
 * and is invisible to an empty-cell check.
 *
 * @param {object} row
 * @param {object[]} entries - matched pool entries
 * @returns {{ missingFields: string[], foundValues: object, conflicts: object[] }}
 */
function compareWithCandidates(row, entries, inManuscript) {
  const missingFields = [];
  const foundValues = {};
  const conflicts = [];

  for (const field of FILLABLE_FIELDS) {
    const authorValue = String(row?.[field] || '').trim();

    // Prefer the highest-confidence candidate that actually carries the field.
    const supplier = [...entries]
      .filter((entry) => String(entry?.candidate?.[field] || '').trim())
      .sort((a, b) => (b.candidate.confidence || 0) - (a.candidate.confidence || 0))[0];
    if (!supplier) continue;

    const foundValue = String(supplier.candidate[field]).trim();

    if (!authorValue) {
      missingFields.push(field);
      foundValues[field] = foundValue;
      continue;
    }

    // Only fields we can genuinely compare may contradict the author.
    if (!COMPARABLE_FIELDS.includes(field)) continue;

    // And only what the MANUSCRIPT actually prints may do the contradicting.
    const claim = manuscriptClaim(entries, field, inManuscript);
    if (!claim) continue;

    if (valuesConflict(field, authorValue, claim.value)) {
      conflicts.push({ field, authorValue, manuscriptValue: claim.value, source: claim.origin });
    }
  }

  return { missingFields, foundValues, conflicts };
}

/**
 * Do two values for the same field genuinely disagree?
 *
 * Deliberately conservative — a false conflict is worse than a missed one,
 * because it sends a curator to check something that is fine. Differences of
 * formatting, case, punctuation, or completeness are NOT conflicts:
 *
 *   "RRID: AB_2201407"        vs "RRID:AB_2201407"        → same
 *   "Millipore"               vs "MilliporeSigma"         → one contains the other
 *   "Cat #: 657012, RRID: X"  vs "RRID: X"                → one contains the other
 *   "strain code: 400"        vs "strain code: 001"       → CONFLICT
 *
 * For identifiers we compare typed tokens, so a shared RRID with differing
 * catalogue numbers still surfaces — that is exactly the case worth catching.
 *
 * @param {string} field
 * @param {string} authorValue
 * @param {string} manuscriptValue
 * @returns {boolean}
 */
function valuesConflict(field, authorValue, manuscriptValue) {
  const a = normalizeForCompare(authorValue);
  const b = normalizeForCompare(manuscriptValue);
  if (!a || !b || a === b) return false;

  // One being a fuller form of the other is completeness, not disagreement.
  if (a.includes(b) || b.includes(a)) return false;

  if (field === 'identifier') {
    // Typed tokens: if ANY token matches, the two refer to the same resource.
    // A conflict is then a DIFFERING token of the same type — e.g. two catalog
    // numbers — not merely the presence of extra tokens on one side.
    const ta = [...extractIdentifierTokens(authorValue)];
    const tb = [...extractIdentifierTokens(manuscriptValue)];
    if (ta.length === 0 || tb.length === 0) return false;

    const typeOf = (t) => t.slice(0, t.indexOf(':'));
    const byType = (tokens) => tokens.reduce((acc, t) => {
      (acc[typeOf(t)] = acc[typeOf(t)] || []).push(t);
      return acc;
    }, {});
    const ga = byType(ta);
    const gb = byType(tb);

    const typedConflict = Object.keys(ga).some((type) => {
      if (!gb[type]) return false; // type only on one side — not a disagreement
      return !ga[type].some((t) => gb[type].includes(t));
    });
    if (typedConflict) return true;

    // The tokeniser only recognises known identifier shapes, so a difference
    // can hide in the REMAINDER — "strain code: 400" vs "strain code: 001"
    // around an RRID both sides agree on. Strip the recognised tokens and
    // compare what is left.
    // Words that carry no identifying information: URL scheme parts, the
    // registry prefixes the tokeniser already consumed, and citation filler.
    // Without stripping these, "https://doi.org/10.1038/x." vs "10.1038/x ;
    // Walf and Frye, 2007" left residuals "https doi org" and "walf and frye
    // 2007" — neither empty, neither containing the other, so an identifier the
    // tokeniser had just matched was reported as a CONFLICT. 13 of the 45
    // conflicts in the demo corpus were this.
    const BOILERPLATE = /\b(https?|www|dx|doi|org|rrid|cat|catalog|catalogue|no|num|number|id|urls?)\b/g;
    const residual = (raw, tokens) => {
      let text = normalizeForCompare(raw);
      for (const token of tokens) {
        text = text.split(normalizeForCompare(token.slice(token.indexOf(':') + 1))).join(' ');
      }
      return text.replace(BOILERPLATE, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    };
    const ra = residual(authorValue, ta);
    const rb = residual(manuscriptValue, tb);
    // An empty residual on either side means one value is simply less complete.
    if (!ra || !rb) return false;
    return !(ra.includes(rb) || rb.includes(ra));
  }

  // Only COMPARABLE_FIELDS ever reach here — `newReuse` had a branch of its own
  // ("a closed vocabulary, so any difference is real"), left behind when it was
  // dropped from comparison. It was unreachable, but it read as a live rule and
  // a test asserted it, so anyone adding a field to COMPARABLE_FIELDS would have
  // found a landmine that looked deliberate. The rule now lives in one place:
  // the COMPARABLE_FIELDS list.
  //
  // Anything still here differs beyond formatting and completeness, both
  // already checked above.
  return true;
}

/** Casefold, strip punctuation and collapse whitespace for comparison. */
function normalizeForCompare(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s_\-–—:;,.#]+/g, ' ')
    .trim();
}

/**
 * One sentence explaining a row's verdict, for the curator.
 * @param {string} how - which key matched
 * @param {string[]} missingFields
 * @param {object[]} conflicts
 * @returns {string}
 */
function describeOutcome(how, missingFields, conflicts, bestEntry) {
  if (how === 'partial_name') {
    const candidateName = bestEntry?.candidate?.resourceName || 'a detected resource';
    return `Partially matched: the manuscript discusses "${candidateName}", whose name appears`
      + ' inside this row\'s. Related, but not confirmed to be the same item — no field values'
      + ' were taken from it.';
  }
  const parts = [`Found in the manuscript (matched by ${how})`];
  if (missingFields.length > 0) {
    parts.push(`the manuscript also supplies ${missingFields.join(', ')}, which this row leaves empty`);
  }
  for (const c of conflicts) {
    parts.push(`the manuscript gives ${c.field} "${c.manuscriptValue}" where this row has "${c.authorValue}"`);
  }
  return parts.join('; ') + '.';
}

/**
 * Pick the evidence to show a curator: the strongest grounding among the
 * matched candidates ('exact' beats 'partial' beats none).
 * @param {object[]} entries
 * @returns {object|null}
 */
function bestEvidence(entries) {
  const grade = (evidence) => (evidence?.match === 'exact' ? 2 : evidence?.match === 'partial' ? 1 : 0);
  const best = [...entries]
    .map((entry) => entry?.candidate?.evidence)
    .filter((evidence) => evidence && grade(evidence) > 0)
    .sort((a, b) => grade(b) - grade(a))[0];
  return best || null;
}

/**
 * @param {object[]} outcomes
 * @param {number} candidateCount
 * @param {number} unmatchedCount
 * @returns {object}
 */
function summarise(outcomes, candidateCount, unmatchedCount) {
  const stats = {
    authorRows: outcomes.length,
    confirmed: 0,
    incomplete: 0,
    partial: 0,
    notDetected: 0,
    candidates: candidateCount,
    unmatchedCandidates: unmatchedCount
  };
  // Counted explicitly rather than via a catch-all `else`: an unrecognised
  // outcome silently inflating notDetected is exactly the kind of quiet
  // miscount that made the corpus numbers hard to trust.
  for (const outcome of outcomes) {
    if (outcome.outcome === 'confirmed') stats.confirmed++;
    else if (outcome.outcome === 'incomplete') stats.incomplete++;
    else if (outcome.outcome === 'partial') stats.partial++;
    else stats.notDetected++;
  }
  return stats;
}

module.exports = {
  MATCH_STRENGTH,
  FILLABLE_FIELDS,
  // Exported for the gold-linkage tooling, which must bucket author rows by the
  // SAME distinctiveness rule the matcher applies. Duplicating the list there
  // would let the two drift apart silently.
  GENERIC_TOKENS,
  isDistinctive,
  matchAuthorRows,
  matchOneRow,
  matchStrength,
  candidateNames,
  compareWithCandidates,
  valuesConflict
};
