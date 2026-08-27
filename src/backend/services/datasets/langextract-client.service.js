/**
 * LangExtract Client Service
 *
 * Node.js wrapper around the Python langextract script.
 * Spawns a child process, pipes markdown text via stdin,
 * and parses the JSON output from stdout.
 *
 * Requires Python 3 + langextract installed in the same environment
 * (handled by the Dockerfile).
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const apiConfig = require('../../config/datasets-detection-api');
const { applyGeminiDefaults } = require('../../config/gemini');
const { ExternalServiceError } = require('../../utils/errors');
const logger = require('../../utils/logger');

const SCRIPT_PATH = path.join(__dirname, '../../python/datasets/extract-signals.py');
const PROMPTS_DIR = path.join(__dirname, '../../data/prompts');
const PROMPT_FILE = path.join(PROMPTS_DIR, 'blind', 'datasets-signals-extraction.txt');
const EXAMPLES_FILE = path.join(PROMPTS_DIR, 'datasets-signals-examples.json');

// Default configuration — can be overridden via per-process env vars
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const MAX_WORKERS = parseInt(process.env.DATASETS_LANGEXTRACT_MAX_WORKERS, 10) || 60;
const MAX_CHAR_BUFFER = parseInt(process.env.DATASETS_LANGEXTRACT_MAX_CHAR_BUFFER, 10) || 3000;
const BATCH_LENGTH = parseInt(process.env.DATASETS_LANGEXTRACT_BATCH_LENGTH, 10) || 60;
const EXTRACTION_PASSES = parseInt(process.env.DATASETS_LANGEXTRACT_EXTRACTION_PASSES, 10) || 1;
// Deterministic by default, matching every other LM call in the app (see
// utils/gemini.js). langextract otherwise leaves temperature at the model
// default, which made the same manuscript yield different signal sets per run.
const TEMPERATURE = Number.isFinite(parseFloat(process.env.DATASETS_LANGEXTRACT_TEMPERATURE))
  ? parseFloat(process.env.DATASETS_LANGEXTRACT_TEMPERATURE)
  : 0;
// Read from the config rather than the environment directly: it resolves the
// shared GEMINI_MODEL fallback too, and a client that skipped it would send
// one model while every status line in the app named another.
const GEMINI_MODEL = apiConfig.model;

// Timeout: 10 minutes (langextract processes many chunks in parallel)
const TIMEOUT_MS = parseInt(process.env.DATASETS_LANGEXTRACT_TIMEOUT, 10) || 600000;

/**
 * Extract dataset signals from markdown text using the Python langextract script.
 *
 * @param {string} markdownText - The full manuscript as markdown
 * @param {{ prompt?: string, examples?: string|object }} [options]
 *   `prompt` overrides the default signal-extraction prompt; `examples`
 *   overrides the few-shot examples JSON (a string is written as-is, an
 *   object/array is JSON-stringified). Both default to the committed files.
 *   The Python script reads both from file paths, so any override is written
 *   to a temp file for the duration of the call.
 * @returns {Promise<Array<object>>} Extraction objects with extraction_class,
 *   extraction_text, char_interval, alignment_status, attributes
 */
async function extractSignals(markdownText, { prompt, examples } = {}) {
  const startTime = Date.now();

  // Resolve the prompt/examples paths: non-empty overrides are written to a
  // shared temp dir (cleaned up in the finally below); otherwise use the
  // committed defaults.
  let promptPath = PROMPT_FILE;
  let examplesPath = EXAMPLES_FILE;
  let tmpDir = null;
  const ensureTmpDir = () => {
    if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-signals-'));
    return tmpDir;
  };

  if (prompt != null && String(prompt).trim()) {
    promptPath = path.join(ensureTmpDir(), 'prompt.txt');
    fs.writeFileSync(promptPath, String(prompt), 'utf-8');
  }
  if (examples != null) {
    const examplesText = typeof examples === 'string' ? examples : JSON.stringify(examples);
    if (examplesText.trim()) {
      examplesPath = path.join(ensureTmpDir(), 'examples.json');
      fs.writeFileSync(examplesPath, examplesText, 'utf-8');
    }
  }

  logger.info('Starting langextract signal extraction', {
    inputLength: markdownText.length,
    model: GEMINI_MODEL,
    maxWorkers: MAX_WORKERS,
    maxCharBuffer: MAX_CHAR_BUFFER,
    batchLength: BATCH_LENGTH,
    extractionPasses: EXTRACTION_PASSES,
    customPrompt: promptPath !== PROMPT_FILE,
    customExamples: examplesPath !== EXAMPLES_FILE
  });

  const args = [
    SCRIPT_PATH,
    '--prompt', promptPath,
    '--examples', examplesPath,
    '--model', GEMINI_MODEL,
    '--max-workers', String(MAX_WORKERS),
    '--batch-length', String(BATCH_LENGTH),
    '--max-char-buffer', String(MAX_CHAR_BUFFER),
    '--extraction-passes', String(EXTRACTION_PASSES),
    '--temperature', String(TEMPERATURE)
  ];

  try {
    return await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(PYTHON_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildChildEnv()
    });

    // Set timeout. SIGTERM first; escalate to SIGKILL if the process is
    // still alive a few seconds later (a Python process stuck in a C
    // extension or blocked on I/O can ignore SIGTERM indefinitely).
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed || child.exitCode === null) {
            child.kill('SIGKILL');
          }
        }, 5000).unref();
        reject(new ExternalServiceError('langextract', `Script timed out after ${TIMEOUT_MS}ms`));
      }
    }, TIMEOUT_MS);

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      const durationMs = Date.now() - startTime;

      // Log stderr (contains progress/debug info from the Python script)
      if (stderr) {
        logger.debug('langextract stderr', { stderr: stderr.substring(0, 2000) });
      }

      if (code !== 0) {
        // The Python script prints "Error: ..." then exits — that line is at the
        // END of stderr, past the benign absl alignment warnings at the top. Log
        // the actual error line (and the stderr tail) instead of the truncated head.
        const errLines = stderr.match(/Error:[^\n]*/g);
        const reason = errLines ? errLines[errLines.length - 1] : stderr.slice(-500).trim();
        logger.error('langextract script failed', {
          exitCode: code,
          reason,
          stderrTail: stderr.length > 1500 ? '…' + stderr.slice(-1500) : stderr,
          durationMs
        });
        return reject(new ExternalServiceError('langextract', `Script failed (exit ${code}): ${reason}`));
      }

      // Parse JSON output
      try {
        const extractions = JSON.parse(stdout);

        if (!Array.isArray(extractions)) {
          return reject(new ExternalServiceError('langextract', 'Script returned non-array output'));
        }

        logger.info('langextract extraction complete', {
          totalExtractions: extractions.length,
          datasetRows: extractions.filter(e => e.extraction_class === 'DATASET_ROW').length,
          durationMs
        });

        resolve(extractions);
      } catch (parseError) {
        logger.error('Failed to parse langextract output', {
          error: parseError.message,
          stdout: stdout.substring(0, 500)
        });
        reject(new ExternalServiceError('langextract', `Invalid JSON output: ${parseError.message}`));
      }
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      logger.error('Failed to spawn python3', { error: error.message });
      reject(new ExternalServiceError('langextract', `Python not found: ${error.message}. Run the app inside the Docker container.`));
    });

    // Write markdown to stdin. Without an error handler, a child that
    // exits before reading (bad args, import error) makes this write emit
    // an unhandled EPIPE stream error and crash the worker; the 'close'
    // handler already reports the real failure, so just log here.
    child.stdin.on('error', (err) => {
      logger.warn('langextract stdin write failed', { error: err.message });
    });
    child.stdin.write(markdownText);
    child.stdin.end();
    });
  } finally {
    // Clean up the temp prompt file/dir if we wrote a custom prompt.
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (cleanupError) {
        logger.warn('Failed to remove temp signals prompt dir', { tmpDir, error: cleanupError.message });
      }
    }
  }
}

/**
 * Collect dataset names from langextract extractions.
 * Filters to DATASET_ROW entries and extracts the dataset_name attribute.
 *
 * @param {Array<object>} extractions - Raw langextract extractions
 * @returns {Array<string>} Dataset names
 */
function collectDatasetNames(extractions) {
  return extractions
    .filter(e => e.extraction_class === 'DATASET_ROW')
    .map(e => e.attributes?.dataset_name)
    .filter(Boolean);
}

/**
 * Build the extracted rows payload for the consolidation step.
 * Filters to DATASET_ROW entries.
 *
 * @param {Array<object>} extractions - Raw langextract extractions
 * @returns {Array<object>} Extracted rows with text and attributes
 */
function buildExtractedRows(extractions) {
  return extractions
    .filter(e => e.extraction_class === 'DATASET_ROW')
    .map(e => ({
      text: e.extraction_text || '',
      charInterval: e.char_interval || null,
      alignmentStatus: e.alignment_status || null,
      attributes: e.attributes || {}
    }));
}

/**
 * Split extractions into the ones LangExtract aligned to a span of the source
 * text and the ones it could not.
 *
 * An unaligned extraction is not evidence of anything: the model produced text
 * that does not occur in the article. The observed failure mode is the model
 * echoing the few-shot examples out of the prompt when a manuscript is sparse —
 * those arrive looking exactly like real findings (plausible name, real
 * accession) and are only distinguishable by having no span.
 *
 * @param {Array<object>} rows - Rows from buildExtractedRows
 * @returns {{grounded: Array<object>, ungrounded: Array<object>}}
 */
function partitionByGrounding(rows) {
  const grounded = [];
  const ungrounded = [];
  for (const row of rows) {
    if (row.charInterval && Number.isInteger(row.charInterval.start_pos)) {
      grounded.push(row);
    } else {
      ungrounded.push(row);
    }
  }
  return { grounded, ungrounded };
}

/**
 * The environment the LangExtract child runs in.
 *
 * The script reads DATASETS_DETECTION_GEMINI_API_KEY out of its own
 * environment, and a child process inherits variables, not the expression that
 * produced them. `server.js` already normalises the whole environment at
 * startup, so under the app this call has nothing left to do -- but the
 * detection scripts under `scripts/` load their own .env and never run that
 * pass, and the child would inherit an environment with the per-module
 * variable still missing.
 *
 * It applies the SAME function startup applies, rather than a second copy of
 * the rule. One rule, two places it is enforced, no way for them to disagree.
 *
 * @returns {Record<string, string>} env for the child process
 */
function buildChildEnv() {
  const env = { ...process.env };
  applyGeminiDefaults(env);
  return env;
}

module.exports = {
  extractSignals,
  buildChildEnv,
  collectDatasetNames,
  buildExtractedRows,
  partitionByGrounding
};
