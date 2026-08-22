/**
 * Identifier Detection Service
 *
 * Scans the post-conversion markdown for known identifiers (RRID/DOI/PID/URL/
 * catalog) using an in-memory index built from EnrichmentListEntry rows.
 *
 * Two independent sweeps feed one output:
 *   a. enrichment-list sweep — matches identifiers that were curated into an
 *      EnrichmentListEntry. High precision, but blind to anything uncurated.
 *   b. published-protocol sweep — recognizes protocol-publishing VENUES from
 *      the identifier shape alone (no list involved), recovering protocol
 *      DOIs/URLs nobody curated. See published-protocol-scanner.service.js.
 *
 * Four-step pipeline (matches every other detection module):
 *   1. detectIdentifiers(md, index)         → raw scanner matches
 *   2. buildKrtItemsIdentifier(matches, md) → canonical KrtEntry[]
 *      buildKrtItemsPublishedProtocol(…)    → canonical KrtEntry[] (sweep b)
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
const { FILE_TYPES, JOB_TYPES } = require('../../config/constants');
const { NotFoundError } = require('../../utils/errors');
const { runWithDemoFallback } = require('../demo-fallback.service');
const knownIdentifierIndex = require('./known-identifier-index.service');
const knownIdentifierScanner = require('./known-identifier-scanner.service');
const publishedProtocolScanner = require('./published-protocol-scanner.service');
const identifierConfig = require('../../config/identifier-detection-api');
const { dedupeKrtItems } = require('../pdf-analysis/dedupe-krt-items.service');
const { buildEvidenceIndex, attachEvidence } = require('../pdf-analysis/evidence.service');
const inputFreeze = require('../queue/input-freeze.service');
const { canonicalResourceType } = require('../pdf-analysis/identifier-normalize.service');
const logger = require('../../utils/logger');
const runInputs = require('../queue/run-inputs.service');

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
async function queueIdentifierDetection(submissionId, round = 1, userId = null) {
  const orchestrator = require('../queue/orchestrator.service');
  const { SubmissionJob } = require('../../models');

  // Read BEFORE re-queueing. `requeueStep` leaves a re-run at `queued`, so the
  // row it returns cannot tell a caller whether it started this run or found
  // one already going.
  const before = await SubmissionJob.getLatest(submissionId, JOB_TYPES.IDENTIFIER_DETECTION, round);
  const alreadyInFlight = ['queued', 'processing'].includes(before?.status);

  await orchestrator.cascadeRestart(submissionId, JOB_TYPES.IDENTIFIER_DETECTION, round, userId);
  const job = await orchestrator.requeueStep(submissionId, JOB_TYPES.IDENTIFIER_DETECTION, round, userId);

  logger.info('Identifier detection re-queued', {
    submissionId, round, submissionJobId: job.id, status: job.status, alreadyInFlight
  });
  return { job, alreadyInFlight };
}

/**
 * Worker entry point. Same signature as every other detection's processX.
 */
async function processIdentifierDetection(submissionId, jobLogger = null, { isFinalAttempt = true } = {}) {
  const { Submission } = require('../../models');
  const submission = await Submission.findByPk(submissionId);
  if (!submission) throw new NotFoundError('Submission');

  const result = await runWithDemoFallback({
    // Pure local scanner — "external" just means "produce real data". Enabled
    // by default; IDENTIFIER_DETECTION_ENABLED=false turns the module Off.
    isExternalEnabled: identifierConfig.isEnabled(),
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
 * @param {object} [opts] - scanner options (e.g. { cutAtReferences })
 * @returns {{ matches: object[], referencesCutoff: number, scannedLength: number }}
 */
function detectIdentifiers(markdownText, index, opts = {}) {
  return knownIdentifierScanner.scan(markdownText, index, opts);
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
      // Grounded by construction: the scanner matched this identifier at a
      // known offset in the markdown, so the evidence is already resolved and
      // attachEvidence only fills in the section.
      evidence: {
        quote: snippetAt(markdownText, m.position, 80),
        offset: m.position,
        section: '',
        match: 'exact'
      },
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
 * Step 2b: published-protocol scanner matches → canonical KrtEntry[].
 *
 * These rows come from the venue catalog, not the enrichment list, so they
 * carry an identifier and a SOURCE but no name and no new/reuse — see the
 * module header of published-protocol-scanner.service.js for why neither is
 * inferable from an identifier.
 *
 * Pure function.
 *
 * @param {object[]} matches - from publishedProtocolScanner.scanPublishedProtocols
 * @param {string} markdownText
 * @returns {object[]} KrtEntry[]
 */
function buildKrtItemsPublishedProtocol(matches, markdownText) {
  if (!Array.isArray(matches)) return [];
  return matches.map(m => ({
    resourceType: 'Protocol',
    resourceName: '',
    identifier: m.identifier,
    source: m.source,
    newReuse: '',
    origin: 'protocol-venue-scan',
    // Allowlist-only venue match — as high-precision as an enrichment-list hit.
    confidence: RELEVANCE_TO_CONFIDENCE.HIGH,
    additionalInformation: '',
    evidence: {
      quote: snippetAt(markdownText, m.position, 80),
      offset: m.position,
      section: '',
      match: 'exact'
    },
    detectorMeta: {
      relevance: 'HIGH',
      matchedTypes: [m.type],
      position: m.position,
      catalogContext: null,
      category: 'protocols',
      venue: m.source,
      context: snippetAt(markdownText, m.position, 80)
    }
  }));
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
  // The document this ROUND is reading, not whatever is newest right now.
  // The first step to ask freezes it; every later reader in the round is
  // handed the same one, so a file replaced mid-run cannot split the round.
  const mdFile = await inputFreeze.resolveFile(
    submissionId, round, inputFreeze.INPUT_KINDS.MARKDOWN, { jobType: JOB_TYPES.IDENTIFIER_DETECTION }
  );
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

  // 3. Pipeline: detect → buildKrtItems → dedupe
  const scanStart = Date.now();
  const { matches, referencesCutoff, scannedLength } = detectIdentifiers(markdownText, index, {
    cutAtReferences: identifierConfig.cutAtReferences()
  });
  const scanMs = Date.now() - scanStart;
  jobLogger?.log('scan_done', 'Identifier scan complete', {
    matchCount: matches.length,
    scannedBytes: scannedLength,
    referencesCutoff,
    durationMs: scanMs
  });

  // No model here, so the curated list is the whole variable input — it is
  // edited between runs, and a match that appears or vanishes is explained by
  // its size and digest rather than by anything in the manuscript.
  await runInputs.saveRunInputs(jobLogger, {
    documents: { markdown: runInputs.fileRef(mdFile, markdownText) },
    // The index is three maps, not one — `index.size` was always undefined, so
    // the audit record stored null for the very thing it says it is recording.
    frozen: {
      enrichmentIndex: {
        byIdentifier: index?.byIdentifier?.size ?? null,
        byCatalog: index?.byCatalog?.size ?? null,
        catalogTokens: index?.catalogTokens?.size ?? null
      }
    },
    meta: { engine: 'local-scan', scannedLength, referencesCutoff }
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

  // 3b. Published-protocol sweep. List-free: recognizes protocol-publishing
  // venues from the identifier shape alone, so it recovers protocol DOIs/URLs
  // that were never curated into an enrichment list. Shares the references
  // cutoff so both sweeps see exactly the same body text.
  const protocolMatches = publishedProtocolScanner.scanPublishedProtocols(markdownText, {
    cutoff: referencesCutoff
  }).matches;
  jobLogger?.log('protocol_venue_scan_done', 'Published-protocol scan complete', {
    matchCount: protocolMatches.length,
    venues: [...new Set(protocolMatches.map(p => p.source))]
  });
  await jobLogger?.saveRawResponse('published-protocol-scan', {
    matchCount: protocolMatches.length,
    matches: protocolMatches
  });

  const krtItems = buildKrtItemsIdentifier(matches, markdownText);
  const { enriched } = enrichIdentifiers(krtItems);
  const protocolItems = buildKrtItemsPublishedProtocol(protocolMatches, markdownText);

  // These items are grounded by construction (the scanner matched at a real
  // offset), so nothing can be dropped here — the pass only resolves the
  // heading path for each hit, which downstream uses to tell an authors' own
  // accession in Methods/Data-Availability from one cited in the Discussion.
  const evidenceIndex = buildEvidenceIndex(markdownText);
  const { items: groundedItems } = attachEvidence([...enriched, ...protocolItems], evidenceIndex, {
    drop: false,
    label: 'identifier-scan'
  });
  const items = dedupeKrtItems(groundedItems, 'identifier-scan');

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
      publishedProtocolCount: protocolMatches.length,
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
    await job.persistData(helperResult.data);
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
  buildKrtItemsPublishedProtocol,
  enrichIdentifiers
};
