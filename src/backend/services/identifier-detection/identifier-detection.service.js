/**
 * Identifier Detection Service
 *
 * Scans the post-conversion markdown for known identifiers (RRID/DOI/PID/URL/
 * catalog) using an in-memory index built from EnrichmentListEntry rows.
 *
 * Four-step pipeline (matches every other detection module):
 *   1. detectIdentifiers(md, index)         → raw scanner matches
 *   2. buildKrtItemsIdentifier(matches, md) → canonical KrtEntry[]
 *   3. enrichIdentifiers(items)             → pass-through (the index entries
 *                                              already carry every field the
 *                                              enrichment list could fill in)
 *   4. dedupeKrtItems(items)                → one KrtEntry per logical resource
 *
 * No external API: the scanner is pure JS, and the index lives in process
 * memory once loaded. Demo path is intentionally absent — the workflow can
 * succeed (zero matches when the list is empty) or fail (markdown missing,
 * scanner crash); there's no "fallback to demo data" surface.
 */

// Sequelize models are lazy-loaded inside the worker functions below — see
// the matching comment in protocols.service.js for the rationale.
const s3Service = require('../storage/s3.service');
const jobQueue = require('../queue/job-queue.service');
const { FILE_TYPES, JOB_TYPES } = require('../../config/constants');
const { NotFoundError } = require('../../utils/errors');
const { runWithDemoFallback } = require('../demo-fallback.service');
const knownIdentifierIndex = require('./known-identifier-index.service');
const knownIdentifierScanner = require('./known-identifier-scanner.service');
const { dedupeKrtItems } = require('../pdf-analysis/dedupe-krt-items.service');
const { canonicalResourceType } = require('../pdf-analysis/identifier-normalize.service');
const logger = require('../../utils/logger');

// Confidence floor we hand to merge-detections for tiebreaking. Identifier
// matches are usually high-precision so even MEDIUM is decent.
const RELEVANCE_TO_CONFIDENCE = {
  HIGH: 0.95,
  MEDIUM: 0.7,
  LOW: 0.4
};

// Fallback resourceType when the curated entry's resourceType is empty.
// Strings match the labels used elsewhere in the consolidator (`Software/code`
// is what software.service.js stamps on Softcite output).
const CATEGORY_FALLBACK_TYPE = {
  software:  'Software/code',
  datasets:  'Dataset',
  materials: 'Lab Material',
  protocols: 'Protocol'
};

/**
 * Queue an identifier-detection job for a submission. Same shape as the
 * other queueX functions so the orchestrator's cascade-restart works without
 * special-casing.
 */
async function queueIdentifierDetection(submissionId, round = 1) {
  const { SubmissionJob } = require('../../models');
  const orchestrator = require('../queue/orchestrator.service');
  await orchestrator.cascadeRestart(submissionId, JOB_TYPES.IDENTIFIER_DETECTION, round);

  const submissionJob = await SubmissionJob.create({
    submissionId,
    jobType: JOB_TYPES.IDENTIFIER_DETECTION,
    status: 'queued',
    round
  });

  const jobId = await jobQueue.addJob(
    jobQueue.QUEUES.IDENTIFIER_DETECTION,
    { submissionId, submissionJobId: submissionJob.id }
  );

  submissionJob.pgBossJobId = jobId;
  await submissionJob.save();

  logger.info('Identifier detection queued', { submissionId, submissionJobId: submissionJob.id, jobId });
  return jobId;
}

/**
 * Worker entry point. Same signature as every other detection's processX.
 */
async function processIdentifierDetection(submissionId, jobLogger = null, { isFinalAttempt = true } = {}) {
  const { Submission } = require('../../models');
  const submission = await Submission.findByPk(submissionId);
  if (!submission) throw new NotFoundError('Submission');

  const result = await runWithDemoFallback({
    isExternalEnabled: true,    // always available — pure local scanner
    demoEnabled: false,         // no demo path
    runExternal: () => detectIdentifiersForSubmission(submission, jobLogger),
    getDemoData: async () => null,
    isFinalAttempt,
    jobLogger
  });

  await persistJobData(submissionId, JOB_TYPES.IDENTIFIER_DETECTION, submission.currentRound || 1, result);
  return result;
}

/**
 * Build a snippet around `position` for the additionalInformation field —
 * trimmed and whitespace-collapsed so the consolidator can show it inline.
 */
function snippetAt(text, position, radius = 80) {
  const start = Math.max(0, position - radius);
  const end = Math.min(text.length, position + radius);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline steps (pure, exported)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Step 1: run the scanner against the given markdown using a pre-built index.
 *
 * Pure pass-through to `knownIdentifierScanner.scan` — the indirection exists
 * so the four-step contract is named consistently across modules.
 *
 * @param {string} markdownText
 * @param {object} index - result of knownIdentifierIndex.buildIndex(entries)
 * @returns {{ matches: object[], referencesCutoff: number, scannedLength: number }}
 */
function detectIdentifiers(markdownText, index) {
  return knownIdentifierScanner.scan(markdownText, index);
}

/**
 * Step 2: scanner matches → canonical KrtEntry[].
 *
 * One item per match (the scanner aggregator already deduped on entry.id).
 * Detector-private fields (relevance, position, matched types, catalog
 * context, category) live on `detectorMeta` so the top-level shape is uniform
 * across all five detection modules.
 *
 * Pure function.
 *
 * @param {object[]} matches
 * @param {string} markdownText
 * @returns {object[]} KrtEntry[]
 */
function buildKrtItemsIdentifier(matches, markdownText) {
  if (!Array.isArray(matches)) return [];
  return matches.map(m => {
    const entry = m.entry;
    // EnrichmentListEntry rows can still carry the historic "Code/Software"
    // label; canonicalResourceType maps it to the current "Software/code"
    // spelling so detected items don't trip the KRT validator's
    // resource-type check downstream.
    const resourceType = canonicalResourceType(
      entry.resourceType || CATEGORY_FALLBACK_TYPE[entry.category] || 'Resource'
    );
    return {
      resourceType,
      resourceName: entry.resourceName || '',
      identifier: entry.identifier || '',
      source: entry.source || '',
      newReuse: entry.newReuse || '',
      origin: 'identifier-scan',
      confidence: RELEVANCE_TO_CONFIDENCE[m.relevance] ?? 0.4,
      // Per ASAP request: don't put the manuscript snippet in user-facing
      // ADDITIONAL INFORMATION. It's stored on detectorMeta.context for
      // internal review only.
      additionalInformation: '',
      detectorMeta: {
        relevance: m.relevance,
        matchedTypes: m.types,
        position: m.position,
        catalogContext: m.catalogContext,
        category: entry.category,
        context: snippetAt(markdownText, m.position, 80)
      }
    };
  });
}

/**
 * Step 3: enrichment pass-through.
 *
 * Identifier-scan's index is built directly from EnrichmentListEntry rows, so
 * every match already carries its enrichment payload (source, identifier,
 * newReuse) on the item. There's nothing left for an enrichment step to fill
 * in. The function exists for pipeline symmetry — if we ever add a fallback
 * enrichment (e.g. token-based lookup for partial hits), it goes here.
 *
 * @param {object[]} items
 * @returns {{ enriched: object[], durationMs: number }}
 */
function enrichIdentifiers(items) {
  return { enriched: items, durationMs: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker orchestrator (S3 + DB)
// ─────────────────────────────────────────────────────────────────────────────

async function detectIdentifiersForSubmission(submission, jobLogger) {
  const { File } = require('../../models');
  const submissionId = submission.id;
  const round = submission.currentRound || 1;
  const startTime = Date.now();

  // 1. Latest markdown for this round.
  const mdFile = await File.findOne({
    where: { submissionId, type: FILE_TYPES.MARKDOWN, round },
    order: [['version', 'DESC']]
  });
  if (!mdFile) throw new Error('No markdown file found for identifier detection');

  jobLogger?.log('download_markdown', 'Downloading markdown from S3', {
    fileName: mdFile.fileName, s3Key: mdFile.s3Key
  });
  const mdBuffer = await s3Service.downloadFile(mdFile.s3Key);
  const markdownText = mdBuffer.toString('utf-8');
  jobLogger?.log('download_markdown_done', 'Markdown downloaded', { markdownLength: markdownText.length });

  // 2. Index from the enrichment list (cached after first call).
  const indexStart = Date.now();
  const index = await knownIdentifierIndex.loadIndex();
  const indexMs = Date.now() - indexStart;
  jobLogger?.log('index_ready', 'Identifier index ready', {
    durationMs: indexMs,
    byIdentifier: index.byIdentifier.size,
    byCatalog: index.byCatalog.size,
    catalogTokens: index.catalogTokens.size
  });

  // 3. Pipeline: detect → buildKrtItems → enrich (no-op) → dedupe
  const scanStart = Date.now();
  const { matches, referencesCutoff, scannedLength } = detectIdentifiers(markdownText, index);
  const scanMs = Date.now() - scanStart;
  jobLogger?.log('scan_done', 'Identifier scan complete', {
    matchCount: matches.length,
    scannedBytes: scannedLength,
    referencesCutoff,
    durationMs: scanMs
  });

  // Persist raw scan output for forensics.
  await jobLogger?.saveRawResponse('identifier-scan', {
    matchCount: matches.length,
    referencesCutoff,
    scannedLength,
    matches: matches.map(m => ({
      relevance: m.relevance,
      types: m.types,
      position: m.position,
      catalogContext: m.catalogContext,
      entry: {
        id: m.entry.id,
        category: m.entry.category,
        resourceType: m.entry.resourceType,
        resourceName: m.entry.resourceName,
        identifier: m.entry.identifier,
        source: m.entry.source
      }
    }))
  });

  const krtItems = buildKrtItemsIdentifier(matches, markdownText);
  const { enriched } = enrichIdentifiers(krtItems);
  const items = dedupeKrtItems(enriched, 'identifier-scan');

  // Stats by relevance + category for the worker's job-summary panel.
  // Read from detectorMeta (canonical shape).
  const byRelevance = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  const byCategory = { software: 0, materials: 0, datasets: 0, protocols: 0 };
  for (const it of items) {
    const relevance = it.detectorMeta?.relevance;
    const category = it.detectorMeta?.category;
    if (relevance && relevance in byRelevance) byRelevance[relevance]++;
    if (category && category in byCategory) byCategory[category]++;
  }

  return {
    items,
    meta: {
      totalCount: items.length,
      uniqueCount: items.length,
      highRelevanceCount: byRelevance.HIGH,
      byRelevance,
      byCategory,
      indexStats: {
        byIdentifier: index.byIdentifier.size,
        byCatalog: index.byCatalog.size,
        catalogTokens: index.catalogTokens.size
      },
      referencesCutoff,
      scannedLength,
      indexMs,
      scanMs,
      totalMs: Date.now() - startTime
    }
  };
}

async function persistJobData(submissionId, jobType, round, helperResult) {
  const { SubmissionJob } = require('../../models');
  const job = await SubmissionJob.getLatest(submissionId, jobType, round);
  if (job) {
    job.result = { ...(job.result || {}), data: helperResult.data };
    job.changed('result', true);
    await job.save();
  }
}

async function getIdentifierMentions(submissionId, round) {
  const { Submission, SubmissionJob } = require('../../models');
  if (!round) {
    const submission = await Submission.findByPk(submissionId, { attributes: ['id', 'currentRound'] });
    if (!submission) throw new NotFoundError('Submission');
    round = submission.currentRound || 1;
  }
  const job = await SubmissionJob.getLatest(submissionId, JOB_TYPES.IDENTIFIER_DETECTION, round);
  return job?.result?.data || null;
}

module.exports = {
  queueIdentifierDetection,
  processIdentifierDetection,
  getIdentifierMentions,
  // Pipeline steps (pure, exported for benchmarks/tests)
  detectIdentifiers,
  buildKrtItemsIdentifier,
  enrichIdentifiers
};
