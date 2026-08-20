/**
 * DAS Suggestions Service (LM-based)
 *
 * Replaces the old hardcoded, client-side substring rules for the Data/Code
 * Availability Statement (DAS). A Gemini call judges the DAS against the ASAP
 * rulebook — semantically, not by keyword matching — and returns a per-rule
 * verdict. The result is persisted on the DAS_SUGGESTIONS SubmissionJob in the
 * exact shape the /availability view renders.
 *
 * Runs as a background job gated so it starts only once the DAS has been
 * extracted and the KRT is finalized (submission past the review step), and is
 * re-triggerable (e.g. when the author edits the DAS on /availability). When
 * the LM is not configured, the service returns no suggestions and the frontend
 * falls back to its legacy hardcoded rules.
 */

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const dasSuggestionsConfig = require('../../config/das-suggestions-api');
const jobQueue = require('../queue/job-queue.service');
const { JOB_TYPES } = require('../../config/constants');
const { NotFoundError, ExternalServiceError } = require('../../utils/errors');
const { generateContentWithRetry } = require('../../utils/gemini');
const { sanitizeJsonEscapes, extractJsonBlock } = require('../../utils/gemini-json');
const logger = require('../../utils/logger');
const runInputs = require('../queue/run-inputs.service');
const { repoPath } = require('../detection/repo-path');

const PROMPT_FILE = path.join(__dirname, '../../data/prompts/das-suggestions.txt');

/**
 * What `extractAndSaveDAS` persists when the manuscript has no statement.
 *
 * A sentinel rather than an empty column, so the UI can tell "we looked and
 * found nothing" from "nobody has run extraction yet". Named here because two
 * places have to agree on it and they had it spelled out twice.
 */
const NO_DAS_SENTINEL = 'Not found';
let _promptCache = null;

function hasPrompt() {
  return fs.existsSync(PROMPT_FILE);
}
function getPrompt(override) {
  if (override != null && String(override).trim()) return String(override).trim();
  if (!_promptCache) {
    if (!hasPrompt()) {
      throw new Error(`Prompt file not found: ${PROMPT_FILE} — this prompt is version-controlled; restore it from git`);
    }
    _promptCache = fs.readFileSync(PROMPT_FILE, 'utf-8').trim();
  }
  return _promptCache;
}

/**
 * The ASAP DAS rulebook. The LM only decides `applies` + a reason per rule_id;
 * the presentation (severity/title/message/recommendedText) is fixed here so it
 * stays consistent with ASAP guidance and can't be mangled by the model. Ported
 * verbatim from the legacy client-side rules.
 */
const DAS_RULES = [
  {
    id: 'no_new_dataset',
    severity: 'warning',
    title: 'No new dataset in the Key Resources Table',
    message: 'This Key Resources Table does not include any new data. If you did collect data, add a row for the data you collected. If you did not collect data, add the text below to your Data/Code Availability Statement.',
    recommendedText: 'No new primary data were collected in this study.',
    naReason: 'Key Resources Table contains new dataset resources'
  },
  {
    id: 'no_new_code',
    severity: 'warning',
    title: 'No new code in the Key Resources Table',
    message: 'This Key Resources Table does not include any new code. If you did generate code for this study, add a row outlining the code you generated. If you did not generate any code, add the text below to your Data/Code Availability Statement.',
    recommendedText: 'No code was generated for this study; all data cleaning, preprocessing, analysis, and visualization was performed using [insert program name(s)].',
    naReason: 'Key Resources Table contains new Software/code resources'
  },
  {
    id: 'datasets_not_mentioned',
    severity: 'info',
    title: 'Dataset resources not mentioned',
    message: 'Your Key Resources Table includes Dataset resources, but the Availability Statement does not mention them.',
    naReason: 'The Availability Statement already refers to the data'
  },
  {
    id: 'code_not_mentioned',
    severity: 'info',
    title: 'Software/code resources not mentioned',
    message: 'Your Key Resources Table includes Software/code resources, but the Availability Statement does not mention them.',
    naReason: 'The Availability Statement already refers to Software/code'
  },
  {
    id: 'protocols_not_mentioned',
    severity: 'info',
    title: 'Protocol resources not mentioned',
    message: 'Your Key Resources Table includes Protocol resources, but the Availability Statement does not mention them.',
    naReason: 'The Availability Statement already refers to protocols'
  },
  {
    id: 'materials_not_mentioned',
    severity: 'info',
    title: 'Lab Material resources not mentioned',
    message: 'Your Key Resources Table includes Lab Material resources, but the Availability Statement does not mention them.',
    naReason: 'The Availability Statement already refers to materials/reagents'
  },
  {
    id: 'missing_no_data_statement',
    severity: 'warning',
    title: 'Missing explicit no-data statement',
    message: 'The AS should explicitly state that no new data were generated.',
    recommendedText: 'No new primary data were collected in this study.',
    naReason: 'The Availability Statement already states no new data'
  },
  {
    id: 'missing_no_code_statement',
    severity: 'warning',
    title: 'Missing explicit no-code statement',
    message: 'The AS should explicitly state that no new code was generated.',
    recommendedText: 'No code was generated for this study; all data cleaning, preprocessing, analysis, and visualization was performed using [insert program name(s)].',
    naReason: 'The Availability Statement already states no new code'
  },
  {
    id: 'missing_krt_reference',
    severity: 'warning',
    title: 'Missing Key Resources Table reference',
    message: 'The AS must indicate that the Key Resources Table lists all research outputs alongside their identifiers.',
    recommendedText: 'The data, code, protocols, and key lab materials used and generated in this study are listed in a Key Resources Table alongside their persistent identifiers at [enter the Zenodo DOI or Table number].',
    naReason: 'The Availability Statement references the Key Resources Table, Zenodo, DOI, or a table'
  }
];

// Lab-material resource-type keywords (mirrors the legacy client rule).
const LAB_MATERIAL_KEYWORDS = ['antibody', 'bacterial', 'biological', 'chemical', 'critical commercial', 'experimental model', 'oligonucleotide', 'recombinant', 'viral'];

function typeMatches(row, keyword) {
  return (row.resourceType || '').toLowerCase().includes(keyword);
}
function isNewRow(row) {
  return (row.newReuse || '').toLowerCase().trim() === 'new';
}

/**
 * Deterministic KRT signals handed to the LM as ground truth (camelCase
 * KRTData rows).
 * @param {object[]} krtRows
 */
function computeKrtSignals(krtRows) {
  const rows = Array.isArray(krtRows) ? krtRows : [];
  return {
    has_new_dataset: rows.some(r => typeMatches(r, 'dataset') && isNewRow(r)),
    has_new_code: rows.some(r => (typeMatches(r, 'software') || typeMatches(r, 'code')) && isNewRow(r)),
    has_dataset_resources: rows.some(r => typeMatches(r, 'dataset')),
    has_code_resources: rows.some(r => typeMatches(r, 'software') || typeMatches(r, 'code')),
    has_protocol_resources: rows.some(r => typeMatches(r, 'protocol')),
    has_lab_material_resources: rows.some(r => LAB_MATERIAL_KEYWORDS.some(kw => typeMatches(r, kw)))
  };
}

/** Parse the LM response into an array of { rule_id, applies, reason }. */
function parseFindings(text) {
  try {
    const parsed = JSON.parse(sanitizeJsonEscapes(extractJsonBlock(text)));
    const list = Array.isArray(parsed) ? parsed : (parsed.findings || parsed.rules || []);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    logger.error('Failed to parse DAS suggestions JSON', { error: err.message });
    return [];
  }
}

/**
 * Merge the LM per-rule verdicts onto the fixed rulebook, producing the exact
 * suggestion shape the /availability view renders. A rule the LM omitted
 * defaults to not-applicable (the frontend still has its legacy full fallback
 * if the whole run fails). Pure function — exported for tests.
 */
function buildSuggestions(findings, signals = {}, dasText = '') {
  const byId = new Map((Array.isArray(findings) ? findings : [])
    .filter(f => f && f.rule_id)
    .map(f => [String(f.rule_id), f]));

  return DAS_RULES.map(rule => {
    const f = byId.get(rule.id);
    const applies = typeof f?.applies === 'boolean' ? f.applies : false;
    // The LM's per-rule justification. Kept for EVERY rule (applicable or not)
    // so the /availability "more details" view can explain each verdict; the
    // green "check passed" box still reads it via notApplicableReason.
    const lmReason = f?.reason != null && String(f.reason).trim() ? String(f.reason).trim() : null;
    return {
      ruleId: rule.id,
      severity: rule.severity,
      title: rule.title,
      message: rule.message,
      recommendedText: rule.recommendedText || null,
      applies,
      reason: lmReason,
      notApplicableReason: applies ? null : (lmReason || rule.naReason || null)
    };
  });
}

async function callGeminiForDas(dasText, signals) {
  const ai = new GoogleGenAI({ apiKey: dasSuggestionsConfig.apiKey });
  const prompt = getPrompt();
  const payload = { data_availability_statement: dasText || '', krt_summary: signals };
  const fullPrompt = prompt + '\n\n---\n\nINPUT:\n\n' + JSON.stringify(payload, null, 2);
  // The digest of what was actually sent, so the audit record can prove the
  // prompt rebuilt from the frozen inputs is the one that ran.
  const promptDigest = { sha256: runInputs.sha256(fullPrompt), bytes: Buffer.byteLength(fullPrompt) };

  try {
    const response = await generateContentWithRetry(ai, {
      model: dasSuggestionsConfig.model,
      contents: [{ role: 'user', parts: [{ text: fullPrompt }] }]
    }, {
      label: 'das-suggestions',
      // A healthy response parses to at least one verdict; empty/unparseable →
      // retry rather than silently showing nothing.
      validate: (res) => parseFindings(res?.text || '').length > 0
    });
    const text = response.text || '';
    return { findings: parseFindings(text), rawResponse: text, promptDigest };
  } catch (error) {
    logger.error('Gemini API call failed for DAS suggestions', { error: error.message });
    throw new ExternalServiceError('Gemini', error.message);
  }
}

/**
 * Generate DAS suggestions for a submission/round. Returns the helper result
 * shape persisted on the SubmissionJob: { data: { suggestions }, meta }.
 */
async function generateDasSuggestions(submissionId, round, jobLogger = null) {
  const { Submission, KRTData } = require('../../models');
  const start = Date.now();

  if (!dasSuggestionsConfig.isConfigured() || !hasPrompt()) {
    jobLogger?.log('das_suggestions_skipped', 'DAS suggestions LM not configured — frontend falls back to legacy rules');
    return { data: { suggestions: [] }, status: 'done', source: null, meta: { skipped: true, reason: 'lm_not_configured', totalMs: Date.now() - start } };
  }

  const submission = await Submission.findByPk(submissionId);
  const rawDas = submission?.dataAvailabilityStatement || '';
  const dasText = rawDas === NO_DAS_SENTINEL ? '' : rawDas;
  const krtRows = await KRTData.findAll({ where: { submissionId, round } });
  const signals = computeKrtSignals(krtRows);

  jobLogger?.log('das_suggestions_start', 'Checking DAS against the rulebook', {
    dasLength: dasText.length, krtRows: krtRows.length
  });
  const { findings, rawResponse, promptDigest } = await callGeminiForDas(dasText, signals);
  await jobLogger?.saveRawResponse('das-suggestions', rawResponse || findings);

  // Freeze what this run was given. Both of its inputs are mutable — the author
  // edits their statement on the very step that triggers this check, and their
  // KRT keeps changing — so a later reader has no way to tell what the model
  // actually saw unless the run records it. Every other LM module writes one of
  // these; this one was missed.
  await runInputs.saveRunInputs(jobLogger, {
    frozen: {
      dataAvailabilityStatement: dasText,
      krtSignals: signals
    },
    prompt: runInputs.promptRef(repoPath(PROMPT_FILE), promptDigest),
    meta: {
      model: dasSuggestionsConfig.model,
      dasLength: dasText.length,
      krtRowCount: krtRows.length
    }
  });

  const suggestions = buildSuggestions(findings, signals, dasText);
  const applicable = suggestions.filter(s => s.applies).length;
  jobLogger?.log('das_suggestions_done', `DAS check complete: ${applicable} applicable`, {
    total: suggestions.length, applicable
  });

  return {
    data: { suggestions, signals },
    status: 'done',
    source: 'external',
    // dasLength/krtRowCount are also in the frozen inputs record; repeated here
    // because the Technical detail panel reads the job's own meta, and "what
    // this run was given" belongs beside "what it produced".
    meta: {
      total: suggestions.length,
      applicable,
      totalMs: Date.now() - start,
      model: dasSuggestionsConfig.model,
      dasLength: dasText.length,
      krtRowCount: krtRows.length
    }
  };
}

/** Worker entry point. Persists the suggestion list on the SubmissionJob. */
async function processDasSuggestions(submissionId, jobLogger = null /*, opts */) {
  const { Submission, SubmissionJob } = require('../../models');
  const submission = await Submission.findByPk(submissionId);
  if (!submission) throw new NotFoundError('Submission');
  const round = submission.currentRound || 1;

  const result = await generateDasSuggestions(submissionId, round, jobLogger);

  const job = await SubmissionJob.getLatest(submissionId, JOB_TYPES.DAS_SUGGESTIONS, round);
  if (job) {
    job.result = { ...(job.result || {}), data: result.data, meta: result.meta };
    job.changed('result', true);
    await job.save();
  }
  return result;
}

/**
 * Ask for the DAS check to run.
 *
 * A pipeline step now, so this goes through the orchestrator: the round's row is
 * reused rather than duplicated, and the gate decides whether it starts now or
 * waits for the Availability step.
 *
 * Three outcomes, and they must stay distinguishable — a bare job id could not
 * tell "there is nothing to check" apart from "accepted, waiting for the right
 * step", and the caller reported the second as the first.
 *
 * @param {string} submissionId
 * @param {number} round
 * @returns {Promise<{queued: boolean, reason: 'no_statement'|'gated'|null,
 *   status?: string, jobId?: string|null, submissionJobId?: string}>}
 */
async function queueDasSuggestions(submissionId, round = 1) {
  const { SubmissionJob, Submission } = require('../../models');

  // Nothing to check without a Data Availability Statement — this happens when
  // the author never provided one or DAS extraction was cancelled. Don't queue
  // the job; the caller reports "not queued" so the UI can explain why.
  const submission = await Submission.findByPk(submissionId, {
    attributes: ['dataAvailabilityStatement']
  });
  const das = (submission?.dataAvailabilityStatement || '').trim();
  // NO_DAS_SENTINEL, not just empty: extraction always persists something, and
  // writes this literal when it found no statement. Testing only for empty let
  // the sentinel through, so the job was queued and generateDasSuggestions then
  // mapped it back to '' and called the model against an empty statement —
  // exactly the case this guard exists to skip, one wasted LM call per run.
  if (!das || das === NO_DAS_SENTINEL) {
    logger.info('DAS suggestions skipped — no DAS provided', { submissionId, round, das: das || '(empty)' });
    return { queued: false, reason: 'no_statement' };
  }

  // Through the orchestrator, not around it: this is a pipeline step now, so
  // re-running it must reuse the round's row rather than insert a rival one.
  // (Inserting a second row is exactly what made PDF Analysis report a finished
  // run whose result had been consolidated from nothing — getForSubmission
  // keeps only the newest row per type, and the pipeline's real one was left
  // stranded behind it.)
  const orchestrator = require('../queue/orchestrator.service');
  const job = await orchestrator.requeueStep(
    submissionId, JOB_TYPES.DAS_SUGGESTIONS, round, null
  );
  logger.info('DAS suggestions re-queued', {
    submissionId, submissionJobId: job.id, status: job.status
  });

  // The step is gated to the Availability step, so asking for it earlier leaves
  // it `waiting` — accepted, and it will run when the submission gets there.
  // Reported distinctly from "there is nothing to check": a bare job id made
  // those two indistinguishable, and the caller told an author with a perfectly
  // good statement that they had not provided one.
  return {
    queued: job.status === 'queued',
    reason: job.status === 'waiting' ? 'gated' : null,
    status: job.status,
    jobId: job.pgBossJobId || null,
    submissionJobId: job.id
  };
}

/** Read the persisted DAS suggestions + job status for a submission/round. */
async function getPersistedDasSuggestions(submissionId, round) {
  const { SubmissionJob } = require('../../models');
  const job = await SubmissionJob.getLatest(submissionId, JOB_TYPES.DAS_SUGGESTIONS, round);
  return {
    status: job?.status || 'none',
    suggestions: job?.result?.data?.suggestions || [],
    signals: job?.result?.data?.signals || null,
    meta: job?.result?.meta || null
  };
}

module.exports = {
  NO_DAS_SENTINEL,
  generateDasSuggestions,
  processDasSuggestions,
  queueDasSuggestions,
  getPersistedDasSuggestions,
  computeKrtSignals,
  buildSuggestions,
  DAS_RULES
};
