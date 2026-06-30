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
const { ExternalServiceError } = require('../../utils/errors');
const logger = require('../../utils/logger');

const SCRIPT_PATH = path.join(__dirname, '../../python/datasets/extract-signals.py');
const PROMPTS_DIR = path.join(__dirname, '../../data/prompts');
const PROMPT_FILE = path.join(PROMPTS_DIR, 'datasets-signals-extraction.txt');
const EXAMPLES_FILE = path.join(PROMPTS_DIR, 'datasets-signals-examples.json');

// Default configuration — can be overridden via per-process env vars
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const MAX_WORKERS = parseInt(process.env.DATASETS_LANGEXTRACT_MAX_WORKERS, 10) || 60;
const MAX_CHAR_BUFFER = parseInt(process.env.DATASETS_LANGEXTRACT_MAX_CHAR_BUFFER, 10) || 3000;
const BATCH_LENGTH = parseInt(process.env.DATASETS_LANGEXTRACT_BATCH_LENGTH, 10) || 60;
const EXTRACTION_PASSES = parseInt(process.env.DATASETS_LANGEXTRACT_EXTRACTION_PASSES, 10) || 1;
const GEMINI_MODEL = process.env.DATASETS_DETECTION_GEMINI_MODEL || 'gemini-2.5-flash';

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
 * @returns {Promise<Array<object>>} Array of extraction objects with extraction_class, extracted_text, attributes
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
    '--extraction-passes', String(EXTRACTION_PASSES)
  ];

  try {
    return await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(PYTHON_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    // Set timeout
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
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

    // Write markdown to stdin
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
      text: e.extracted_text || '',
      attributes: e.attributes || {}
    }));
}

module.exports = {
  extractSignals,
  collectDatasetNames,
  buildExtractedRows
};
