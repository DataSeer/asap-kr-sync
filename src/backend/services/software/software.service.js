/**
 * Software Detection Service
 *
 * Detects software/code mentions using Softcite.
 *
 * Three-step pipeline:
 *   1. detectSoftware(pdfBuffer, fileName) → raw Softcite mentions
 *   2. buildKrtItemsSoftware(mentions)     → canonical KrtEntry[]
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
const jobQueue = require('../queue/job-queue.service');
const { FILE_TYPES, JOB_TYPES } = require('../../config/constants');
const { NotFoundError } = require('../../utils/errors');
const demoDataService = require('../demo-data.service');
const { runWithDemoFallback } = require('../demo-fallback.service');
const logger = require('../../utils/logger');

/** Default when Softcite doesn't return a confidence value. */
const DEFAULT_CONFIDENCE = 0.7;

/**
 * Queue software detection as a background job
 */
async function queueSoftwareDetection(submissionId, round = 1) {
  const { SubmissionJob } = require('../../models');
  const orchestrator = require('../queue/orchestrator.service');
  await orchestrator.cascadeRestart(submissionId, JOB_TYPES.SOFTWARE_DETECTION, round);

  const submissionJob = await SubmissionJob.create({
    submissionId,
    jobType: JOB_TYPES.SOFTWARE_DETECTION,
    status: 'queued',
    round
  });

  const jobId = await jobQueue.addJob(
    jobQueue.QUEUES.SOFTWARE_DETECTION,
    { submissionId, submissionJobId: submissionJob.id }
  );

  submissionJob.pgBossJobId = jobId;
  await submissionJob.save();

  logger.info('Software detection queued', { submissionId, submissionJobId: submissionJob.id, jobId });
  return jobId;
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
  jobLogger?.log('softcite_start', 'Sending PDF to Softcite API');
  const { resources: rawMentions, softciteMs } = await detectSoftware(pdfBuffer, pdfFile.fileName);
  jobLogger?.log('softcite_done', 'Softcite detection complete', {
    rawMentionCount: rawMentions.length, durationMs: softciteMs
  });
  await jobLogger?.saveRawResponse('softcite-response', rawMentions);

  // ── Step 2: buildKrtItems + policy (B1 default reuse, B3 drop instrument
  //    software, B4 language → "<Lang> code" NEW)
  const krtItems = applySoftwarePolicy(buildKrtItemsSoftware(rawMentions));

  // ── Step 3: dedupe
  const items = dedupeKrtItems(krtItems, 'software-softcite');

  return {
    items,
    meta: {
      rawMentionCount: rawMentions.length,
      uniqueCount: items.length,
      softciteMs,
      totalMs: Date.now() - startTime
    }
  };
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
  buildKrtItemsSoftware,
  applySoftwarePolicy,
  isInstrumentSoftware,
  detectCodeLanguage
};
