/**
 * Software Detection Service
 *
 * Detects software/code mentions using TWO engines, unioned:
 *
 *   - Softcite — a purpose-built NER service reading the PDF. Recognises tool
 *     NAMES written in prose. Good precision.
 *   - An LM pass (software-lm.service.js) reading the converted markdown.
 *     Covers what a name recogniser structurally cannot: `RRID:SCR_…` tokens,
 *     GitHub/PyPI/CRAN links, packages named in a parenthetical, and custom
 *     code promised in a data-availability statement. Measured against the DS
 *     reports, 253 of 291 missed software rows carried such an identifier.
 *
 * Either engine may fail without taking the module with it:
 *   - LM disabled, markdown not converted, or an LM error → Softcite-only.
 *   - Softcite errors after its retries                   → LM-only.
 * Both directions record why, and the run reports itself `partial` rather than
 * `done` so a thinner table is never mistaken for a complete one.
 *
 * BOTH failing is still a failure. If Softcite is down and the LM pass produced
 * nothing — because it is disabled, or has no markdown, or errored too — the
 * Softcite error is re-thrown. An empty result reported as success is the one
 * outcome worse than an error: it reads as "this manuscript mentions no
 * software".
 *
 * Pipeline:
 *   1. detectSoftware(pdfBuffer, fileName) → raw Softcite mentions
 *   1b. runLmPass(...)                     → grounded LM KrtEntry[] (or none)
 *   2. buildKrtItemsSoftware + policy      → canonical KrtEntry[] (both sources)
 *   3. dedupeKrtItems(items, 'software')   → one entry per logical resource
 *
 * Note: the curated enrichment list is no longer applied here — only the
 * Identifier Detection module consults the enrichment lists now.
 */

// Sequelize models are lazy-loaded inside the worker functions below — see
// the matching comment in protocols.service.js for the rationale.
const s3Service = require('../storage/s3.service');
const softciteClient = require('./softcite-client.service');
const { dedupeKrtItems } = require('../pdf-analysis/dedupe-krt-items.service');
const softciteConfig = require('../../config/softcite-api');
const { FILE_TYPES, JOB_TYPES } = require('../../config/constants');
const { NotFoundError } = require('../../utils/errors');
const demoDataService = require('../demo-data.service');
const { runWithDemoFallback } = require('../demo-fallback.service');
const softwareLm = require('./software-lm.service');
const { repoPath } = require('../detection/repo-path');
const runInputs = require('../queue/run-inputs.service');
const { buildEvidenceIndex, attachEvidence } = require('../pdf-analysis/evidence.service');
const logger = require('../../utils/logger');

/** Default when Softcite doesn't return a confidence value. */
const DEFAULT_CONFIDENCE = 0.7;

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
async function queueSoftwareDetection(submissionId, round = 1, userId = null) {
  const orchestrator = require('../queue/orchestrator.service');
  const { SubmissionJob } = require('../../models');

  // Read BEFORE re-queueing. `requeueStep` leaves a re-run at `queued`, so the
  // row it returns cannot tell a caller whether it started this run or found
  // one already going.
  const before = await SubmissionJob.getLatest(submissionId, JOB_TYPES.SOFTWARE_DETECTION, round);
  const alreadyInFlight = ['queued', 'processing'].includes(before?.status);

  await orchestrator.cascadeRestart(submissionId, JOB_TYPES.SOFTWARE_DETECTION, round, userId);
  const job = await orchestrator.requeueStep(submissionId, JOB_TYPES.SOFTWARE_DETECTION, round, userId);

  logger.info('Software detection re-queued', {
    submissionId, round, submissionJobId: job.id, status: job.status, alreadyInFlight
  });
  return { job, alreadyInFlight };
}

/**
 * Process software detection — runs the external/demo workflow and persists
 * data on the SubmissionJob so downstream suggestion generation can read it.
 */
async function processSoftwareDetection(submissionId, jobLogger = null, { isFinalAttempt = true } = {}) {
  const { Submission } = require('../../models');
  const submission = await Submission.findByPk(submissionId);
  if (!submission) throw new NotFoundError('Submission');

  const result = await runWithDemoFallback({
    isExternalEnabled: softciteConfig.isConfigured(),
    demoEnabled: process.env.SOFTWARE_DETECTION_DEMO_DATA_ENABLED !== 'false',
    runExternal: () => detectSoftwareForSubmission(submission, jobLogger),
    getDemoData: async () => {
      const demo = demoDataService.getDemoSoftwareMentions(submission.manuscriptId);
      if (!demo || !demo.items?.length) return null;
      // Demo items use the legacy pre-refactor shape (resource_type, name,
      // context, etc.). Run them through the canonical builder + dedupe so
      // the output matches the External path.
      const krt = applySoftwarePolicy(buildKrtItemsSoftware(demo.items));
      const items = dedupeKrtItems(krt, 'software-demo');
      await jobLogger?.saveRawResponse('demo-software', items);
      return {
        items,
        meta: { totalCount: items.length, uniqueCount: items.length }
      };
    },
    isFinalAttempt,
    jobLogger
  });

  await persistJobData(submissionId, JOB_TYPES.SOFTWARE_DETECTION, submission.currentRound || 1, result);
  return result;
}

/**
 * Worker entry point: Softcite + dedupe.
 */
async function detectSoftwareForSubmission(submission, jobLogger) {
  const { File } = require('../../models');
  const submissionId = submission.id;
  const round = submission.currentRound || 1;
  const startTime = Date.now();

  const pdfFile = await File.findOne({
    where: { submissionId, type: FILE_TYPES.PDF, round },
    order: [['version', 'DESC']]
  });
  if (!pdfFile) throw new Error('No PDF file found for software detection');

  jobLogger?.log('download_pdf', 'Downloading PDF from S3', { fileName: pdfFile.fileName });
  const pdfBuffer = await s3Service.downloadFile(pdfFile.s3Key);

  // ── Step 1: detect (Softcite)
  //
  // Fail-soft, mirroring the LM pass below. The client has already exhausted
  // its own retries by the time an error surfaces here, so there is nothing
  // left to wait for — the choice is between the LM pass's answer and no
  // answer at all. Seen live: a "Softcite error: Service error" on
  // TV1-000430-007 produced zero software rows for a manuscript the LM pass
  // would have found 21 identifiers in.
  let rawMentions = [];
  let softciteMs = 0;
  let softciteError = null;
  try {
    jobLogger?.log('softcite_start', 'Sending PDF to Softcite API');
    const softcite = await detectSoftware(pdfBuffer, pdfFile.fileName);
    rawMentions = softcite.resources;
    softciteMs = softcite.softciteMs;
    jobLogger?.log('softcite_done', 'Softcite detection complete', {
      rawMentionCount: rawMentions.length, durationMs: softciteMs
    });
    await jobLogger?.saveRawResponse('softcite-response', rawMentions);
  } catch (err) {
    softciteError = err;
    jobLogger?.log('softcite_failed', `Softcite failed — continuing on the LM pass alone: ${err.message}`);
  }

  // ── Step 1b: detect (LM pass over the markdown, unioned with Softcite)
  //
  // Softcite reads NAMES in prose; it cannot see an `RRID:SCR_…`, a GitHub URL
  // or "custom scripts available at …". Those were 253 of 291 measured misses.
  // The LM pass covers them. It is additive: on failure, or when the markdown
  // is not ready, Softcite's result stands on its own.
  const lm = await runLmPass(submissionId, round, jobLogger);

  // Nothing read the manuscript. Re-throwing hands this back to
  // runWithDemoFallback, which records a real failure — the alternative is an
  // empty table presented as an answer.
  if (softciteError && !lm.items.length) {
    jobLogger?.log('softcite_failed_no_lm',
      'Softcite failed and the LM pass produced nothing — no engine read this manuscript');
    throw softciteError;
  }

  // ── Step 2: buildKrtItems + policy (B1 default reuse, B3 drop instrument
  //    software, B4 language → "<Lang> code" NEW). The policy is applied to
  //    BOTH sources so the LM cannot smuggle in instrument software.
  const krtItems = applySoftwarePolicy([
    ...buildKrtItemsSoftware(rawMentions),
    ...lm.items
  ]);

  // ── Step 3: dedupe — this is where a tool found by both engines collapses
  //    into one row carrying both provenances.
  const items = dedupeKrtItems(krtItems, 'software');

  return {
    items,
    meta: {
      rawMentionCount: rawMentions.length,
      uniqueCount: items.length,
      // Counted from the items' own provenance, not as a subtraction: the old
      // `krtItems.length - lm.items.length` compared a POST-policy total with a
      // PRE-policy one (instrument software is dropped from both engines), so
      // it went NEGATIVE whenever the policy dropped an LM row — 0 Softcite
      // mentions and 3 dropped LM rows reported "-3 from Softcite".
      softciteCount: countFromSoftcite(items),
      lmCount: lm.items.length,
      // Read by demo-fallback's `done()`, which turns it into outcome
      // 'partial'. Shaped as { engine, error } so any module that unions two
      // engines reports a degradation the same way.
      degraded: softciteError
        ? { engine: 'softcite', error: softciteError.message }
        : undefined,
      softciteFailed: !!softciteError,
      softciteError: softciteError ? softciteError.message : null,
      lmEnabled: lm.enabled,
      lmSkippedReason: lm.skippedReason,
      // Only when the pass ran: a prompt link on a run that never called the
      // model would claim something that did not happen.
      promptFile: lm.enabled ? repoPath(softwareLm.PROMPT_FILE) : null,
      lmMs: lm.durationMs,
      evidenceStats: lm.evidenceStats,
      softciteMs,
      totalMs: Date.now() - startTime
    }
  };
}

/**
 * How many final rows Softcite contributed to.
 *
 * A row found by both engines counts for both — this is "how many rows did
 * Softcite have a hand in", not a partition. Dedupe keeps every pre-merge
 * contributor on `mergedFrom`, so the origin survives the collapse; reading
 * only the top-level `origin` would undercount a row the LM happened to win.
 *
 * @param {object[]} items final, post-policy items
 * @returns {number}
 */
function countFromSoftcite(items) {
  const fromSoftcite = (origin) => String(origin || '').includes('softcite');
  return items.filter((item) => fromSoftcite(item.origin)
    || (item.mergedFrom || []).some((c) => fromSoftcite(c?.originalItem?.origin))).length;
}

/**
 * Run the LM software pass, grounded against the manuscript markdown.
 *
 * Deliberately fail-soft: this pass is additive to Softcite, so anything that
 * goes wrong (module disabled, markdown not converted yet, LM error) degrades
 * to "Softcite only" rather than failing software detection altogether.
 *
 * @param {string} submissionId
 * @param {number} round
 * @param {object} [jobLogger]
 * @returns {Promise<{items: object[], enabled: boolean, skippedReason: string|null, durationMs: number, evidenceStats: object|null}>}
 */
async function runLmPass(submissionId, round, jobLogger) {
  const none = (skippedReason) => ({
    items: [], enabled: softwareLm.isEnabled(), skippedReason, durationMs: 0, evidenceStats: null
  });

  if (!softwareLm.isEnabled()) return none('not_configured');

  const { File } = require('../../models');
  const mdFile = await File.findOne({
    where: { submissionId, type: FILE_TYPES.MARKDOWN, round },
    order: [['version', 'DESC']]
  });
  if (!mdFile) {
    jobLogger?.log('software_lm_skipped', 'No markdown yet — Softcite-only for this run');
    return none('no_markdown');
  }

  const started = Date.now();
  try {
    const markdownText = (await s3Service.downloadFile(mdFile.s3Key)).toString('utf-8');

    jobLogger?.log('software_lm_start', 'Calling Gemini for the software LM pass', {
      markdownLength: markdownText.length
    });
    const { resources, rawResponse, promptDigest } = await softwareLm.detectSoftwareLM(markdownText);
    await jobLogger?.saveRawResponse('gemini-software', rawResponse || resources);

    const built = softwareLm.buildKrtItemsSoftwareLM(resources);
    const { items, stats } = attachEvidence(built, buildEvidenceIndex(markdownText), {
      label: 'software-lm'
    });
    await jobLogger?.saveRawResponse('software-lm-evidence', { stats, items });
    // Two engines, two inputs: Softcite reads the PDF, this pass reads the
    // converted text. Both are recorded because a disagreement between them is
    // exactly what an audit would ask about.
    await runInputs.saveRunInputs(jobLogger, {
      documents: { markdown: runInputs.fileRef(mdFile, markdownText) },
      prompt: runInputs.promptRef(repoPath(softwareLm.PROMPT_FILE), promptDigest),
      meta: { model: require('../../config/software-detection-lm-api').model, engine: 'software-lm' }
    });

    jobLogger?.log('software_lm_done', 'Software LM pass complete', {
      returned: resources.length, grounded: items.length, ...stats, durationMs: Date.now() - started
    });

    return { items, enabled: true, skippedReason: null, durationMs: Date.now() - started, evidenceStats: stats };
  } catch (error) {
    // Additive pass — never sink the module with it.
    logger.warn('Software LM pass failed; continuing with Softcite only', {
      submissionId, error: error.message
    });
    jobLogger?.log('software_lm_error', `LM pass failed, continuing with Softcite only: ${error.message}`);
    return { items: [], enabled: true, skippedReason: 'error', durationMs: Date.now() - started, evidenceStats: null };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline steps (pure-ish, exported)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Step 1: Softcite call. Returns the raw mentions as Softcite emitted them.
 * No DB, no S3 (caller passes the PDF buffer).
 * @param {Buffer} pdfBuffer
 * @param {string} fileName
 * @returns {Promise<{ resources: object[], softciteMs: number }>}
 */
async function detectSoftware(pdfBuffer, fileName) {
  const { mentions, durationMs } = await softciteClient.detectSoftware(pdfBuffer, fileName);
  return { resources: mentions, softciteMs: durationMs };
}

/**
 * Step 2: raw Softcite mentions (or legacy demo items) → canonical KrtEntry[].
 *
 * resourceName uses the normalized form when Softcite provides one (it's the
 * cleaned tool name that enrichment matches against). Detector-specific
 * Softcite fields — context (the in-paper sentence), version, creator, the
 * non-normalized name — live on detectorMeta.
 *
 * Pure function.
 *
 * @param {object[]} rawItems
 * @returns {object[]} KrtEntry[]
 */
function buildKrtItemsSoftware(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems.map(m => {
    // Softcite shape uses `name`/`normalizedName`/`url`. Legacy demo data uses
    // the post-build shape with `resource_type`/`resourceType`. Be permissive
    // on input so both paths produce the same canonical output.
    const resourceName = m.normalizedName || m.resourceName || m.name || '';
    const resourceType = m.resource_type || m.resourceType || 'Software/code';
    const source = m.source || m.url || '';
    return {
      resourceType,
      resourceName,
      identifier: m.identifier || '',
      source,
      newReuse: m.newReuse || m.new_reuse || '',
      origin: 'softcite',
      confidence: typeof m.confidence === 'number' ? m.confidence : DEFAULT_CONFIDENCE,
      // Per ASAP request, do NOT push Softcite's context blurb into user-
      // facing ADDITIONAL INFORMATION. The blurb is preserved on
      // detectorMeta.context for the internal Softcite Detection panel.
      additionalInformation: '',
      // Softcite reads the PDF, not the converted markdown, so its sentence is
      // a real quote from the paper but not necessarily a byte-match against
      // the markdown the other detectors are grounded on. It is recorded
      // unresolved (offset -1, match null) rather than force-matched: the
      // krt_grounding module runs its own search over the markdown when it
      // needs to confirm a software row, so nothing depends on resolving it
      // here — and this keeps software free of a markdown_convert dependency.
      evidence: { quote: m.context || '', offset: -1, section: '', match: null },
      detectorMeta: {
        // Preserve the unnormalized Softcite name so the UI can show it if the
        // normalized form is less recognizable.
        softciteName: m.name || '',
        normalizedName: m.normalizedName || '',
        version: m.version || '',
        creator: m.creator || '',
        // The Softcite Detection panel reads `context` directly; preserve
        // the raw Softcite context blurb alongside additionalInformation so
        // both consumers (panel + downstream enrichment) have what they need.
        additionalInformation: m.additionalInformation || m.context || '',
        context: m.context || ''
      }
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Software policy (post-processing of Softcite mentions) — requests B1/B3/B4.
// We only control the EXTRACTED mentions here, not Softcite itself, so all of
// this operates on the canonical KrtEntry[] produced by buildKrtItemsSoftware.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Programming languages we treat as author-written "code" (request B4). A
 * mention whose name is exactly one of these is rewritten to "<Lang> code" and
 * marked NEW (the author wrote scripts in it), instead of being listed as a
 * reused tool. Keyed by lowercased name → canonical display label. Keep this to
 * unambiguous languages; general software stays the default (Reuse, B1).
 */
const PROGRAMMING_LANGUAGES = new Map([
  ['r', 'R'],
  ['python', 'Python'],
  ['matlab', 'MATLAB'],
  ['julia', 'Julia'],
  ['perl', 'Perl'],
  ['c', 'C'],
  ['c++', 'C++'],
  ['java', 'Java'],
  ['fortran', 'Fortran'],
  ['bash', 'Bash'],
  ['shell', 'Shell'],
  ['ruby', 'Ruby'],
  ['go', 'Go']
]);

/**
 * Instrument / acquisition software to exclude (request B3). These are control
 * software bundled with lab instruments (microscopes, plate readers, cytometers,
 * sequencers, mass specs) — not analysis tools a curator wants in the KRT.
 * Matched case-insensitively as whole words against the resource name.
 *
 * Curated and intentionally conservative (dropping a real analysis tool is worse
 * than keeping one instrument tool). Add new offenders here as they surface.
 */
const INSTRUMENT_SOFTWARE_PATTERNS = [
  /\bzen\b/i,                       // Zeiss ZEN
  /\bnis[-\s]?elements\b/i,         // Nikon NIS-Elements
  /\blas\s?(?:x|af)\b/i,            // Leica LAS X / LAS AF
  /\bmetamorph\b/i,                 // Molecular Devices MetaMorph
  /\bcellsens\b/i,                  // Olympus cellSens
  /\bsoftmax\s?pro\b/i,             // Molecular Devices SoftMax Pro
  /\bgen5\b/i,                      // BioTek Gen5
  /\bfacs\s?diva\b/i,               // BD FACSDiva
  /\bxcalibur\b/i,                  // Thermo Xcalibur
  /\bslidebook\b/i,                 // 3i Slidebook
  /\bclampex\b/i,                   // Molecular Devices Clampex (acquisition)
  /\bandor\s?solis\b/i,             // Andor Solis
  /\bharmony\b/i                    // PerkinElmer Harmony
];

/**
 * Is this resource name instrument/acquisition software? (request B3)
 * @param {string} name
 * @returns {boolean}
 */
function isInstrumentSoftware(name) {
  const s = String(name || '');
  if (!s.trim()) return false;
  return INSTRUMENT_SOFTWARE_PATTERNS.some((re) => re.test(s));
}

/**
 * If a name is a known programming language, return its canonical label;
 * otherwise null. Matches the whole trimmed name (case-insensitive). (B4)
 * @param {string} name
 * @returns {string|null}
 */
function detectCodeLanguage(name) {
  const key = String(name || '').trim().toLowerCase();
  return PROGRAMMING_LANGUAGES.get(key) || null;
}

/**
 * Apply the software policy to canonical KrtEntry[] (run AFTER buildKrtItems,
 * BEFORE dedupe so renamed languages collapse and excluded items never merge):
 *   - B3: drop instrument/acquisition software.
 *   - B4: a language mention → "<Lang> code", role NEW.
 *   - B1: everything else defaults to REUSE when no new/reuse is set.
 * Existing new/reuse values are preserved (e.g. demo data that already set it).
 *
 * Pure function.
 * @param {object[]} items
 * @returns {object[]}
 */
function applySoftwarePolicy(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const item of items) {
    if (isInstrumentSoftware(item.resourceName)) continue; // B3

    const language = detectCodeLanguage(item.resourceName);
    if (language) {
      // B4: author-written code in a specific language → NEW.
      out.push({
        ...item,
        resourceName: `${language} code`,
        newReuse: item.newReuse || 'new',
        detectorMeta: { ...(item.detectorMeta || {}), codeLanguage: language }
      });
      continue;
    }

    // B1: general software defaults to REUSE unless already set.
    out.push({ ...item, newReuse: item.newReuse || 'reuse' });
  }
  return out;
}

/**
 * Persist helper output's data on the SubmissionJob so downstream suggestion
 * generation can read it via SubmissionJob.getLatest().
 */
async function persistJobData(submissionId, jobType, round, helperResult) {
  const { SubmissionJob } = require('../../models');
  const job = await SubmissionJob.getLatest(submissionId, jobType, round);
  if (job) {
    job.result = { ...(job.result || {}), data: helperResult.data };
    job.changed('result', true);
    await job.save();
  }
}

/**
 * Get software mentions for a submission
 */
async function getSoftwareMentions(submissionId, round) {
  const { Submission, SubmissionJob } = require('../../models');
  if (!round) {
    const submission = await Submission.findByPk(submissionId, { attributes: ['id', 'currentRound'] });
    if (!submission) throw new NotFoundError('Submission');
    round = submission.currentRound || 1;
  }

  const job = await SubmissionJob.getLatest(submissionId, JOB_TYPES.SOFTWARE_DETECTION, round);
  return job?.result?.data || null;
}

module.exports = {
  queueSoftwareDetection,
  processSoftwareDetection,
  getSoftwareMentions,
  // Pipeline steps (pure-ish, exported for benchmarks/tests)
  detectSoftware,
  // Exported for the degradation tests: which engines ran, and what happens
  // when one or both of them do not.
  detectSoftwareForSubmission,
  buildKrtItemsSoftware,
  applySoftwarePolicy,
  isInstrumentSoftware,
  detectCodeLanguage
};
