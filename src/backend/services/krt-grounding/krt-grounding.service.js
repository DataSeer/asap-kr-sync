/**
 * KRT Grounding — reconcile the author's Key Resources Table against what the
 * detectors actually found in the manuscript.
 *
 * This module answers the question the app exists to answer: **for every row
 * the author wrote, is it in the PDF, and does their row carry everything the
 * PDF says about it?** It runs after every detector and before consolidation.
 *
 * Two jobs used to be fused into one LM call. Detection was seeded with the
 * author's rows and told to "emit one row for every author-provided material,
 * never drop one" — so the model could echo a seed it had never located, and
 * the output looked identical either way. That made grounding unverifiable and
 * suppressed discovery at the same time. Here the two are separate: detection
 * is KRT-blind (see docs/pipeline-modules.md), and the author's
 * table arrives here as a QUERY, never as a seed.
 *
 * Per author row the outcome is one of:
 *   - `confirmed`     — matched a grounded candidate; the row is complete
 *   - `incomplete`    — matched, but the manuscript supplies a field the row leaves EMPTY
 *   - `not_detected`  — nothing in the manuscript matched it
 *
 * **The author's data is never modified.** `not_detected` is a tag, not a
 * deletion; `incomplete` proposes a fill for an empty cell and nothing else.
 * Acting on either stays a human decision, made downstream in the suggestions UI.
 *
 * Both usage modes run this identical path: with no author KRT there are simply
 * zero rows to reconcile and every candidate is reported as unmatched.
 *
 * Pipeline:
 *   1. load author KRT rows + the candidate pool from every detector
 *   2. matchAuthorRows(...)          → deterministic outcomes (identifier → alias → name)
 *   3. secondLook(...)               → one batched LM pass over the not_detected rows
 *   4. persist outcomes + S3 artifacts
 */

const { GoogleGenAI } = require('@google/genai');
// Sequelize models are lazy-loaded inside the worker functions below — see the
// matching comment in protocols.service.js for the rationale.
const fs = require('fs');
const path = require('path');
const inputFreeze = require('../queue/input-freeze.service');
const s3Service = require('../storage/s3.service');
const groundingConfig = require('../../config/krt-grounding-api');
const { FILE_TYPES, JOB_TYPES } = require('../../config/constants');
const { NotFoundError } = require('../../utils/errors');
const { matchAuthorRows } = require('./match-author-rows.service');
const { verifyRow } = require('./verify-against-manuscript');
const { getPipeline } = require('../../config/pipelines');
const { buildEvidenceIndex, locateQuote, collectMentions, extractContext,
  findAllOccurrences, findNormalisedOccurrences, identifierParts } = require('../pdf-analysis/evidence.service');
const { sanitizeJsonEscapes, extractJsonBlock, salvageTruncatedObjects } = require('../../utils/gemini-json');
const { generateContentWithRetry } = require('../../utils/gemini');
const logger = require('../../utils/logger');
const frozenParams = require('../../utils/frozen-params');
const { repoPath } = require('../detection/repo-path');
const runInputs = require('../queue/run-inputs.service');

const PROMPT_FILE = path.join(__dirname, '../../data/prompts/krt-grounding-second-look.txt');
let _promptCache = null;

/**
 * Detector jobs whose items form the candidate pool. Mirrors PDF Analysis's
 * CONTRIBUTOR_SOURCES — both consume the same detector output.
 */
const CONTRIBUTOR_SOURCES = [
  { source: 'software_detection', jobType: JOB_TYPES.SOFTWARE_DETECTION },
  { source: 'datasets_detection', jobType: JOB_TYPES.DATASETS_DETECTION },
  { source: 'materials_detection', jobType: JOB_TYPES.MATERIALS_DETECTION },
  { source: 'protocols_detection', jobType: JOB_TYPES.PROTOCOLS_DETECTION },
  { source: 'identifier_detection', jobType: JOB_TYPES.IDENTIFIER_DETECTION }
];

/** Author rows sent to the LM in one request. Keeps the response well inside the output cap. */
const SECOND_LOOK_BATCH_SIZE = 25;

/**
 * Occurrences stored per author row for the presence check. Enough for a
 * curator to judge use-vs-citation without carrying a reagent list's worth of
 * hits for a common term.
 */
const PRESENCE_MENTIONS = 5;

/** Cap on separator-insensitive hits per field — enough to prove presence. */
const MAX_NORMALISED = 3;

function hasPrompt() {
  return fs.existsSync(PROMPT_FILE);
}

function getPrompt(override) {
  if (override != null && String(override).trim()) return String(override).trim();
  if (!_promptCache) {
    if (!hasPrompt()) {
      throw new Error(`Prompt file not found: ${PROMPT_FILE} — restore it from git to enable the grounding second look`);
    }
    _promptCache = fs.readFileSync(PROMPT_FILE, 'utf-8').trim();
  }
  // A restart asked to run with a past run's parameters uses THAT run's
  // template, not the file as it stands today. Resolved here, in every prompt
  // loader, because there is no shared one — and a loader that skipped this
  // would run the current prompt while the page said the run was reproduced.
  //
  // Returns `live` untouched outside a frozen restart, which is the normal path.
  return frozenParams.prompt(_promptCache);
}

/**
 * Re-run this step, in the pipeline.
 *
 * Through `requeueStep`: the round's own row is reused, and the step is only
 * enqueued when it is actually runnable — dependencies terminal, gates
 * satisfied. This used to INSERT a second row set straight to `queued`, which
 * is the shape of the bug that shipped a Generated KRT with zero detections:
 * `getForSubmission` keeps only the NEWEST row per type, so a rival row hides
 * the pipeline's own and the advancement that should follow lands on the wrong
 * one.
 *
 * @param {string} submissionId
 * @param {number} round
 * @param {string} [userId]
 * @returns {Promise<{job: object, alreadyInFlight: boolean}>}
 */
async function queueKrtGrounding(submissionId, round = 1, userId = null) {
  const orchestrator = require('../queue/orchestrator.service');
  const { SubmissionJob } = require('../../models');

  // Read BEFORE re-queueing. `requeueStep` leaves a re-run at `queued`, so the
  // row it returns cannot tell a caller whether it started this run or found
  // one already going.
  const before = await SubmissionJob.getLatest(submissionId, JOB_TYPES.KRT_GROUNDING, round);
  const alreadyInFlight = ['queued', 'processing'].includes(before?.status);

  await orchestrator.cascadeRestart(submissionId, JOB_TYPES.KRT_GROUNDING, round, userId);
  const job = await orchestrator.requeueStep(submissionId, JOB_TYPES.KRT_GROUNDING, round, userId);

  logger.info('KRT grounding re-queued', {
    submissionId, round, submissionJobId: job.id, status: job.status, alreadyInFlight
  });
  return { job, alreadyInFlight };
}

/**
 * Worker entry point. Same signature as every other module's processX.
 *
 * Deliberately NOT wrapped in runWithDemoFallback: grounding has no external
 * dependency of its own to fall back FROM. The deterministic matcher always
 * runs; only the optional LM second look can fail, and it degrades to "no
 * second look" rather than failing the job (a row stays `not_detected`, which
 * is a truthful answer, just a less informed one).
 *
 * @param {string} submissionId
 * @param {object} [jobLogger]
 * @returns {Promise<{ data: object, source: string, status: string }>}
 */
async function processKrtGrounding(submissionId, jobLogger = null) {
  const { Submission } = require('../../models');
  const submission = await Submission.findByPk(submissionId);
  if (!submission) throw new NotFoundError('Submission');

  const data = await groundSubmission(submission, jobLogger);
  await persistJobData(submissionId, JOB_TYPES.KRT_GROUNDING, submission.currentRound || 1, data);

  return { data, source: 'internal', status: 'done' };
}

/**
 * Presence for a set of author rows against a prepared evidence index.
 *
 * Pure and exported so the judgement can be tested without S3 or a database —
 * the loading wrapper below is the only part that needs either.
 *
 * @param {object} index - from buildEvidenceIndex
 * @param {object[]} authorRows
 * @returns {Map<string, {found: boolean, via: string|null, occurrences: number, mentions: object[]}>}
 */
function presenceForRows(index, authorRows) {
  const out = new Map();
  for (const row of authorRows || []) {
    const mentions = collectMentions(index, { resourceName: row.resourceName, identifier: row.identifier }, null);

    // ── Every identifier in the cell, judged on its own ──────────────────────
    //
    // An IDENTIFIER cell routinely holds several: a catalogue number AND an
    // RRID, an RRID AND a DOI. They are separate claims about where the
    // resource can be found, and the manuscript can support one without
    // supporting the other — a paper that cites `RRID:AB_2201407` usually never
    // prints the vendor's catalogue number.
    //
    // Collapsing them into one boolean answered a question nobody asked ("is
    // ANY of this in the paper?") and hid the actionable half: which of the
    // author's identifiers the manuscript does not corroborate. So each part
    // carries its own verdict, and the roll-up is derived from them.
    //
    // `value` is the author's own text for that part ("Cat#657012"), `needle`
    // what was actually searched for ("657012"). A verdict a curator cannot
    // match to the cell in front of them is not a verdict.
    const identifiers = identifierParts(row.identifier).map(({ raw, needle }) => {
      const exact = findAllOccurrences(index, needle, MAX_NORMALISED);
      if (exact.length) {
        return { value: raw, needle, found: true, normalised: false, occurrences: exact.length };
      }
      // Separators ignored — the conversion breaks identifiers around
      // punctuation ("N0502-At488-L" → "N0502 -At488 -L"). Still an exact match
      // of a normalised form, not a similarity score, so it cannot drift.
      const loose = findNormalisedOccurrences(index, needle, MAX_NORMALISED);
      return {
        value: raw, needle,
        found: loose.length > 0, normalised: loose.length > 0, occurrences: loose.length
      };
    });

    // Reported separately, not collapsed into one "via". The editor
    // distinguishes "name AND identifier both found" from either alone, and a
    // single winner-takes-all field cannot express that.
    const viaIdentifier = identifiers.some((i) => i.found);
    let viaName = mentions.some((m) => m.via === 'name');

    // Mentions for whichever identifier only the normalised pass could find —
    // the exact ones are already in `mentions` via collectMentions.
    let normalised = identifiers.some((i) => i.found && i.normalised);
    for (const id of identifiers.filter((i) => i.found && i.normalised)) {
      mentions.push(...findNormalisedOccurrences(index, id.needle, MAX_NORMALISED)
        .map((h) => ({ ...h, via: 'identifier' })));
    }

    if (!viaName) {
      const hits = findNormalisedOccurrences(index, row.resourceName, MAX_NORMALISED);
      if (hits.length) {
        viaName = true;
        normalised = true;
        mentions.push(...hits.map((h) => ({ ...h, via: 'name' })));
      }
    }

    const found = mentions.length > 0;
    out.set(row.id, {
      found,
      viaIdentifier,
      viaName,
      // One entry per identifier in the cell, in the order the author wrote
      // them. Empty when the cell is empty — which is not the same as "none
      // were found", and the reader must be able to tell those apart.
      identifiers,
      // The actionable subset, named so a caller does not have to filter: the
      // author's identifiers the manuscript does not corroborate.
      identifiersNotFound: identifiers.filter((i) => !i.found).map((i) => i.value),
      // At least one field matched only after punctuation was normalised. The
      // match is exact, so this stays a green verdict — but the reader is told,
      // because "the paper writes it differently" is worth knowing.
      normalised,
      // Kept for older callers; the strongest single signal.
      via: viaIdentifier ? 'identifier' : (viaName ? 'name' : null),
      occurrences: mentions.length,
      // With the surrounding paragraph, so the editor can show WHERE without a
      // second pass over the manuscript. collectMentions returns positions
      // only; a position a curator cannot read is not evidence of anything.
      mentions: mentions.slice(0, PRESENCE_MENTIONS).map((m) => ({
        ...m,
        ...(extractContext(index.text, m.offset, (row.resourceName || '').length) || {})
      }))
    });
  }
  return out;
}

/**
 * Does each author row occur in the manuscript AT ALL, judged directly?
 *
 * Grounding otherwise answers a proxy question — "did a detector find something
 * matching this row?" — and reports `not_detected` whenever the detectors
 * missed it, even for a resource the manuscript plainly discusses. Measured on
 * the demo corpus, a direct search locates 92% of author rows where matching
 * through candidates locates 55-60%.
 *
 * This is also the only half of grounding that stays honest under a seeded
 * pipeline. Candidate matching there is contaminated: the pool contains the
 * model's echo of the author's own rows, so a match can mean "it repeated what
 * we handed it". A deterministic search of the row against the manuscript
 * cannot be affected by what the prompts were given, so it is surfaced in every
 * pipeline while candidate-derived values are not.
 *
 * The disagreement between the two is the useful part: a row present in the
 * text with no candidate matched is a DETECTION miss, and nothing in the
 * product could say that before.
 *
 * @param {string} submissionId
 * @param {number} round
 * @param {object[]} authorRows
 * @param {object} [jobLogger]
 * @returns {Promise<{available: boolean, byRowId: Map, stats: object}>}
 */
async function checkPresence(submissionId, round, authorRows, jobLogger) {
  const byRowId = new Map();
  const markdownText = await loadMarkdown(submissionId, round);
  if (!markdownText) {
    jobLogger?.log('presence_skipped', 'No markdown — presence cannot be judged', {});
    return { available: false, byRowId, index: null, stats: { checked: 0, present: 0, absent: 0 } };
  }

  // The index is returned as well as used: verifying a conflict needs the
  // manuscript text, and building it twice for the same round would be waste.
  const index = buildEvidenceIndex(markdownText);
  const found = presenceForRows(index, authorRows);
  for (const [rowId, value] of found) byRowId.set(rowId, value);

  const present = [...byRowId.values()].filter((p) => p.found).length;
  const stats = { checked: authorRows.length, present, absent: authorRows.length - present };
  jobLogger?.log('presence_checked', 'Searched the manuscript for each author row directly', stats);
  return { available: true, byRowId, index, stats };
}

/**
 * Run grounding for one submission/round.
 * @param {object} submission
 * @param {object} [jobLogger]
 * @returns {Promise<object>} { outcomes, unmatchedCandidateRefs, candidates, meta }
 */
async function groundSubmission(submission, jobLogger) {
  const submissionId = submission.id;
  const round = submission.currentRound || 1;
  const startTime = Date.now();
  const pipeline = getPipeline(submission.pipelineId);

  // ── Step 1: inputs
  const authorRows = await loadAuthorKrtRows(submissionId, round);
  const { candidates, contributions } = await loadCandidatePool(submissionId, round);

  jobLogger?.log('inputs_loaded', 'Loaded author KRT rows and the candidate pool', {
    authorRowCount: authorRows.length,
    candidateCount: candidates.length,
    contributors: contributions.map((c) => `${c.source}:${c.items.length}`)
  });
  // This module already froze its inputs; what it lacked was their identity —
  // which run produced each candidate, and which prompt the second look used.
  await runInputs.saveRunInputs(jobLogger, {
    frozen: { authorRows, candidates },
    upstream: runInputs.upstreamRefs(contributions),
    prompt: runInputs.promptRef(repoPath(PROMPT_FILE)),
    meta: {
      model: groundingConfig.model,
      authorRowCount: authorRows.length,
      candidateCount: candidates.length,
      // The second look sends one prompt PER BATCH of not-yet-located rows, so
      // there is no single assembled prompt to digest. The batch size is what a
      // rebuilder needs to reproduce the same split from the frozen rows.
      secondLookBatchSize: SECOND_LOOK_BATCH_SIZE
    },
    // Everything asked of the external service, sanitised: secrets
    // redacted, anything large replaced by its digest. Recorded whole rather
    // than hand-picked — a hand-picked list is one somebody has to remember
    // to extend, which is how four modules came to record no model at all.
    call: groundingConfig
  });

  // ── Step 2: presence — the manuscript searched directly, independent of what
  // any detector found, and independent of what the prompts were seeded with.
  const presence = await checkPresence(submissionId, round, authorRows, jobLogger);

  // ── Step 3: deterministic matching against the candidate pool
  const matched = matchAuthorRows(authorRows, candidates);
  jobLogger?.log('deterministic_match', 'Matched author rows against candidates', matched.stats);

  // Both readings travel on the outcome. `presence` says whether the resource
  // is in the paper; the outcome says what detection made of it.
  for (const outcome of matched.outcomes) {
    outcome.presence = presence.byRowId.get(outcome.krtRowId) || null;

    /**
     * A conflict may only cite the manuscript for what the manuscript says.
     *
     * The matcher raised one by comparing the author's cell against a
     * CANDIDATE's field and labelling the result `manuscriptValue`. For an
     * identifier-scan candidate that field comes from the curated enrichment
     * list, so curators were shown "the manuscript says" followed by values the
     * paper never contained — and told their correct rows disagreed with it.
     *
     * Re-derived here from the text itself. Everything the matcher proposed is
     * discarded; what survives is what the manuscript supports.
     */
    if (presence.index && outcome.presence) {
      const verified = verifyRow({
        identifiers: outcome.presence.identifiers || [],
        index: presence.index,
        mentions: outcome.presence.mentions || []
      });

      outcome.identifierVerdicts = verified.identifiers;
      // Only a value of the same kind, actually in the text, beside this
      // resource. Anything else is not evidence the author is wrong.
      outcome.conflicts = verified.mismatches.map((m) => ({
        field: 'identifier',
        authorValue: m.value,
        manuscriptValue: m.competing,
        kind: m.kind,
        source: 'manuscript'
      }));
      // Present in the KRT, absent from the paper, nothing contradicting it.
      // NOT an error — a KRT may carry more than the manuscript prints — so it
      // travels separately from `conflicts` and is shown as a note.
      outcome.unverifiedIdentifiers = verified.unverified.map((u) => u.value);

      /**
       * The same rule for the empty-cell fills.
       *
       * `foundValues` came from the same candidate field as the conflicts did,
       * so a blank IDENTIFIER could be offered a homepage URL the enrichment
       * list knows and the paper never printed — proposed to the curator, and
       * accepted, it writes into their table something no source supports.
       *
       * A fill is kept only if the manuscript actually contains it. `source` is
       * exempt: it is the repository or supplier, inferred from where a thing
       * lives rather than asserted by the text, so requiring it to appear
       * verbatim would reject every legitimate fill.
       */
      const flat = presence.index.flat || '';
      const inText = (value) => {
        const needle = String(value).replace(/[\s\\]/g, '').toLowerCase();
        return needle.length > 2 && flat.includes(needle);
      };
      for (const [field, value] of Object.entries(outcome.foundValues || {})) {
        if (field === 'source') continue;
        const parts = String(value).split(';').map((v) => v.trim()).filter(Boolean);
        const supported = parts.filter(inText);
        if (supported.length) outcome.foundValues[field] = supported.join(' ; ');
        else {
          delete outcome.foundValues[field];
          outcome.missingFields = (outcome.missingFields || []).filter((f) => f !== field);
        }
      }
    } else {
      // No manuscript to check against: assert nothing rather than fall back to
      // the candidate comparison this replaced.
      outcome.conflicts = [];
      outcome.identifierVerdicts = [];
      outcome.unverifiedIdentifiers = [];
    }
  }

  // Present in the text, yet no candidate matched it: a detection miss, which
  // is a different failure from "the resource is not in this paper" and was
  // indistinguishable from it until now.
  const missedByDetection = matched.outcomes.filter(
    (o) => o.outcome === 'not_detected' && o.presence?.found
  ).length;
  if (missedByDetection > 0) {
    jobLogger?.log('detection_gap', 'Rows the manuscript contains that no detector found', {
      count: missedByDetection
    });
  }

  // ── Step 4: LM second look over the rows nothing matched
  const notDetected = matched.outcomes.filter((o) => o.outcome === 'not_detected');
  let secondLookStats = { attempted: 0, recovered: 0, skipped: true, reason: 'no_rows' };

  if (notDetected.length > 0) {
    if (!groundingConfig.isConfigured() || !hasPrompt()) {
      secondLookStats = { attempted: 0, recovered: 0, skipped: true, reason: 'not_configured' };
      jobLogger?.log('second_look_skipped', 'Second look not configured — rows stay not_detected', {
        notDetectedCount: notDetected.length
      });
    } else {
      secondLookStats = await runSecondLook({
        submissionId, round, notDetected, jobLogger
      });
    }
  }

  const stats = recount(matched.outcomes, candidates.length, matched.unmatchedCandidateRefs.length);

  jobLogger?.log('grounding_done', 'Grounding complete', { ...stats, ...secondLookStats });

  const data = {
    outcomes: matched.outcomes,
    unmatchedCandidateRefs: matched.unmatchedCandidateRefs,
    candidates,
    meta: {
      ...stats,
      secondLook: secondLookStats,
      // The prompt is the second look's; a run that skipped it used none.
      promptFile: secondLookStats.skipped ? null : repoPath(PROMPT_FILE),
      presence: { ...presence.stats, available: presence.available, missedByDetection },
      // Which halves of this result may be shown. Stamped on the run rather
      // than looked up at render time, so a result always says how it should be
      // read even after the submission's pipeline changes.
      pipeline: pipeline.id,
      grounding: pipeline.grounding,
      hasAuthorKrt: authorRows.length > 0,
      mode: authorRows.length > 0 ? 'with_krt' : 'no_krt',
      totalMs: Date.now() - startTime,
          // Named only on a run that called it, like the promptFile above: a
          // run with no rows to place skips the second look, and a model
          // beside "the LM second look did not run" reads as a contradiction.
          model: secondLookStats.skipped ? null : groundingConfig.model
    }
  };

  await jobLogger?.saveRawResponse('grounding-outcomes', {
    meta: data.meta, outcomes: data.outcomes, unmatchedCandidateRefs: data.unmatchedCandidateRefs
  });

  return data;
}

/**
 * The author's KRT rows for this submission/round, in a shape the matcher can
 * consume. Returns [] when the submission has no KRT (Mode B) — the rest of the
 * pipeline is identical.
 * @param {string} submissionId
 * @param {number} round
 * @returns {Promise<object[]>}
 */
async function loadAuthorKrtRows(submissionId, round) {
  // The round's frozen table. Grounding judges the detectors' findings against
  // the author's rows, and those detectors were seeded from this same snapshot
  // — reading the live table here would grade one table's detections against
  // another.
  const inputFreeze = require('../queue/input-freeze.service');
  const rows = await inputFreeze.resolveKrtRows(submissionId, round, {
    jobType: JOB_TYPES.KRT_GROUNDING
  });
  return rows.map((row) => ({
    id: row.id,
    resourceType: row.resourceType || '',
    resourceName: row.resourceName || '',
    identifier: row.identifier || '',
    source: row.source || '',
    newReuse: row.newReuse || '',
    additionalInformation: row.additionalInformation || ''
  }));
}

/**
 * Every detector's items, flattened into one pool. The pool INDEX is the `ref`
 * the outcomes refer to, so the order here is part of the contract — callers
 * persist the pool alongside the outcomes.
 * @param {string} submissionId
 * @param {number} round
 * @returns {Promise<{ candidates: object[], contributions: object[] }>}
 */
async function loadCandidatePool(submissionId, round) {
  const { SubmissionJob } = require('../../models');
  const contributions = [];

  for (const { source, jobType } of CONTRIBUTOR_SOURCES) {
    const job = await SubmissionJob.getLatest(submissionId, jobType, round);
    const items = job?.result?.data?.items || [];
    if (items.length > 0) contributions.push({ source, items });
  }

  const candidates = contributions.flatMap(({ source, items }) =>
    items.map((item) => ({ ...item, detectedBy: source }))
  );

  return { candidates, contributions };
}

/**
 * Ask the LM to find the author rows the deterministic matcher missed.
 *
 * This is the *right* use of the author's table: as a search query. The model
 * gets the manuscript and a list of rows, and must return an exact quote for
 * each one it can locate. Every returned quote is re-verified against the
 * markdown here — a row is only upgraded out of `not_detected` when its quote
 * is genuinely present, so a confident-sounding hallucination changes nothing.
 *
 * Mutates the outcome objects in `notDetected` in place on success.
 *
 * @returns {Promise<object>} stats
 */
async function runSecondLook({ submissionId, round, notDetected, jobLogger }) {
  const markdownText = await loadMarkdown(submissionId, round);
  if (!markdownText) {
    return { attempted: 0, recovered: 0, skipped: true, reason: 'no_markdown' };
  }

  const index = buildEvidenceIndex(markdownText);
  const started = Date.now();
  let recovered = 0;
  let rejected = 0;

  for (let i = 0; i < notDetected.length; i += SECOND_LOOK_BATCH_SIZE) {
    const batch = notDetected.slice(i, i + SECOND_LOOK_BATCH_SIZE);
    let found;
    try {
      found = await askSecondLook(batch, markdownText);
    } catch (error) {
      // A failed second look must not fail the job: the deterministic verdict
      // (not_detected) is already correct, just less informed.
      logger.warn('KRT grounding second look failed for a batch', { submissionId, error: error.message });
      jobLogger?.log('second_look_error', 'Second look batch failed — rows stay not_detected', {
        batchStart: i, error: error.message
      });
      continue;
    }

    for (const hit of found) {
      const outcome = batch[hit.index];
      if (!outcome) continue;

      const located = locateQuote(index, hit.quote);
      if (!located) {
        rejected++;
        continue; // unverifiable quote — the row stays not_detected
      }

      outcome.outcome = 'confirmed';
      outcome.matchedBy = 'lm_second_look';
      outcome.evidence = {
        quote: String(hit.quote).trim(),
        offset: located.offset,
        section: located.section,
        match: located.match
      };
      outcome.reason = 'Not matched by any detector, but located in the manuscript by a targeted search.';
      recovered++;
    }
  }

  await jobLogger?.saveRawResponse('second-look', {
    attempted: notDetected.length, recovered, rejectedUnverifiableQuotes: rejected
  });

  return {
    attempted: notDetected.length,
    recovered,
    rejectedUnverifiableQuotes: rejected,
    skipped: false,
    durationMs: Date.now() - started
  };
}

/**
 * One batched LM call: "find these rows in this manuscript".
 * @param {object[]} batch - outcomes with outcome === 'not_detected'
 * @param {string} markdownText
 * @returns {Promise<{index:number, quote:string}[]>}
 */
async function askSecondLook(batch, markdownText) {
  const ai = new GoogleGenAI({ apiKey: groundingConfig.apiKey });
  const rows = batch.map((outcome, index) => ({
    index,
    resource_type: outcome.resourceType,
    resource_name: outcome.resourceName
  }));

  const prompt = `${getPrompt()}\n\nROWS TO FIND:\n${JSON.stringify(rows, null, 0)}\n\n---\n\nARTICLE MARKDOWN:\n\n${markdownText}`;

  const response = await generateContentWithRetry(ai, {
    model: groundingConfig.model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseMimeType: 'application/json',
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 0 }
    }
  }, { label: 'krt-grounding-second-look' });

  if (response.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
    logger.warn('Gemini response truncated (krt grounding second look)');
  }

  return parseSecondLookResponse(response.text);
}

/**
 * Parse the second-look response into verified-shape hits. Anything malformed
 * is dropped rather than guessed at.
 * @param {string} text
 * @returns {{index:number, quote:string}[]}
 */
function parseSecondLookResponse(text) {
  if (!text) return [];
  const block = extractJsonBlock(text);
  try {
    const parsed = JSON.parse(sanitizeJsonEscapes(block));
    const found = Array.isArray(parsed) ? parsed : parsed.found;
    if (!Array.isArray(found)) return [];
    return usableHits(found);
  } catch (error) {
    // A truncated batch used to be discarded whole. Every other LM module
    // salvages — and this is the module where throwing entries away directly
    // produces a wrong answer: a row the model DID locate stays `not_detected`,
    // which the interface reports as "the manuscript does not mention this".
    //
    // Observed on a 335-row table: 107 rows went to the second look, two
    // batches hit the token cap, and both were dropped entire — one had cut
    // mid-quote on entry 5, so four complete locations went with it.
    //
    // Salvage reads `found` BY NAME. The entry cut in half is discarded by
    // JSON.parse inside the salvage, and every quote that survives is still
    // re-verified against the manuscript afterwards, so a partial response
    // cannot lower the bar for what counts as located.
    const salvaged = usableHits(salvageTruncatedObjects(block, 'found'));
    if (salvaged.length > 0) {
      logger.warn('KRT grounding second-look response was truncated — salvaged the completed locations', {
        error: error.message, salvaged: salvaged.length
      });
      return salvaged;
    }
    logger.error('Failed to parse KRT grounding second-look response', {
      error: error.message, preview: String(text).slice(0, 200)
    });
    return [];
  }
}

/**
 * The entries that carry both halves of a location: which row, and the quote.
 * @param {object[]} hits
 * @returns {{index: number, quote: string}[]}
 */
function usableHits(hits) {
  return (hits || [])
    .filter((hit) => hit && Number.isInteger(hit.index) && typeof hit.quote === 'string' && hit.quote.trim())
    .map((hit) => ({ index: hit.index, quote: hit.quote }));
}

/**
 * @param {string} submissionId
 * @param {number} round
 * @returns {Promise<string|null>}
 */
async function loadMarkdown(submissionId, round) {
  const { File } = require('../../models');
  // The document this ROUND is reading, not whatever is newest right now.
  // The first step to ask freezes it; every later reader in the round is
  // handed the same one, so a file replaced mid-run cannot split the round.
  const mdFile = await inputFreeze.resolveFile(
    submissionId, round, inputFreeze.INPUT_KINDS.MARKDOWN, { jobType: JOB_TYPES.KRT_GROUNDING }
  );
  if (!mdFile) return null;
  const buffer = await s3Service.downloadFile(mdFile.s3Key);
  return buffer.toString('utf-8');
}

/** Recompute the outcome tallies after the second look has upgraded rows. */
function recount(outcomes, candidateCount, unmatchedCount) {
  const stats = {
    authorRows: outcomes.length,
    confirmed: 0,
    incomplete: 0,
    partial: 0,
    notDetected: 0,
    candidates: candidateCount,
    unmatchedCandidates: unmatchedCount,
    // Rows whose values disagree with the manuscript. Counted per ROW, not per
    // differing value, because that is what the reader acts on: one row to go
    // and check. Surfaced on the module card — a contradiction between the KRT
    // and the paper means one of the two is wrong, and that should not need
    // opening a modal to discover.
    conflicts: 0
  };
  // Explicit per outcome: a catch-all `else` here would quietly report every
  // partial-name match as "not detected" in the job stats and the UI summary.
  for (const outcome of outcomes) {
    if (outcome.outcome === 'confirmed') stats.confirmed++;
    else if (outcome.outcome === 'incomplete') stats.incomplete++;
    else if (outcome.outcome === 'partial') stats.partial++;
    else stats.notDetected++;
    if (outcome.conflicts && outcome.conflicts.length > 0) stats.conflicts++;
  }
  return stats;
}

async function persistJobData(submissionId, jobType, round, data) {
  const { SubmissionJob } = require('../../models');
  const job = await SubmissionJob.getLatest(submissionId, jobType, round);
  if (job) {
    await job.persistData(data);
  }
}

/**
 * Read the persisted grounding result for a submission/round.
 * @param {string} submissionId
 * @param {number} [round]
 * @returns {Promise<object|null>}
 */
async function getGroundingResult(submissionId, round) {
  const { Submission, SubmissionJob } = require('../../models');
  if (!round) {
    const submission = await Submission.findByPk(submissionId, { attributes: ['id', 'currentRound'] });
    if (!submission) throw new NotFoundError('Submission');
    round = submission.currentRound || 1;
  }
  const job = await SubmissionJob.getLatest(submissionId, JOB_TYPES.KRT_GROUNDING, round);
  return job?.result?.data || null;
}

module.exports = {
  presenceForRows,
  CONTRIBUTOR_SOURCES,
  SECOND_LOOK_BATCH_SIZE,
  queueKrtGrounding,
  processKrtGrounding,
  groundSubmission,
  getGroundingResult,
  // exported for tests
  parseSecondLookResponse,
  recount
};
