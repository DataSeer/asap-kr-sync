/**
 * What a run was given, frozen so it can be audited later.
 *
 * A result is only auditable if you can still see what produced it, and most of
 * a module's input is mutable: the author edits their KRT, a detector is
 * re-run, a PDF is replaced. Six months later "why did it say that?" has no
 * answer unless the input was kept.
 *
 * The rule here is **freeze what can change, reference what cannot**:
 *
 *   - The author's rows, the seeds, the candidate pool — copied verbatim. They
 *     are small (a whole 16-manuscript corpus is a few hundred KB) and they are
 *     exactly what changes underneath you.
 *   - The markdown and the PDF — recorded as an id, version and SHA-256 rather
 *     than copied. `File` rows are immutable and versioned already, so a
 *     reference plus a digest proves which bytes were read without storing a
 *     second copy of the manuscript for every detector on every run.
 *   - The prompt — copied VERBATIM, plus its digest and the digest of the
 *     assembled prompt actually sent. The template used to be stored by digest
 *     alone, on the reasoning that it lives in git and can be looked up. That
 *     reasoning does not survive contact with a deployment: the running app is
 *     not always at the head of the branch, prompt files get edited, renamed
 *     and deleted, and a link to GitHub therefore showed a reader a prompt that
 *     may not be the one that ran — silently, and with no way to tell. A
 *     template is a few kilobytes; the manuscript-sized thing is the ASSEMBLED
 *     prompt, and that one is still kept by digest only, which is enough to
 *     prove a reconstruction from the rest of this file is what was sent.
 *
 * Written through the job logger, so it lands beside the run's other artefacts
 * under that run's own key.
 */

const crypto = require('crypto');
const fs = require('fs');

const { absolutePath } = require('../detection/repo-path');

/** @returns {string} lowercase hex SHA-256 */
function sha256(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'utf-8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * A stored file, by reference.
 *
 * @param {object|null} file a `File` model instance
 * @param {Buffer|string} [content] the bytes as read, when the caller has them
 * @returns {object|null}
 */
function fileRef(file, content = null) {
  if (!file) return null;
  return {
    fileId: file.id,
    fileName: file.fileName,
    type: file.type,
    version: file.version,
    s3Key: file.s3Key,
    // `size` is the model's attribute; `fileSize` never existed, so this
    // recorded null whenever a caller had no bytes to hand.
    bytes: content ? Buffer.byteLength(content) : (file.size ?? null),
    sha256: content ? sha256(content) : null
  };
}

/**
 * The prompt, by identity rather than by copy.
 *
 * @param {string} repoRelative the template, repo-relative — the form a run
 *   records and a reader can follow. Resolved back to disk here for the digest.
 * @param {string|{sha256: string, bytes: number}} [assembled] the full prompt as
 *   sent to the model, or its digest when the caller hashed it in place rather
 *   than carrying a manuscript-sized string back up the stack
 * @param {string[]} [attachments] repo-relative files the prompt cannot work
 *   without — LangExtract's few-shot examples JSON is one. Recorded as part of
 *   the prompt rather than beside it, because that is what they are: editing
 *   the examples changes the output exactly as editing the prompt does, and a
 *   record that kept one and not the other would say the run was reproducible
 *   when it was not.
 */
function promptRef(repoRelative, assembled = null, attachments = []) {
  let templateSha = null;
  let templateBytes = null;
  let resolvedTemplate = '';
  try {
    const buf = fs.readFileSync(absolutePath(repoRelative));
    templateSha = sha256(buf);
    templateBytes = buf.length;
    resolvedTemplate = buf.toString('utf-8').trim();
  } catch {
    // A prompt that cannot be read is a bigger problem than a missing digest,
    // and the caller has already failed by the time it matters.
  }
  return {
    promptFile: repoRelative,
    // The prompt itself, as the module resolved it. This is what the UI shows,
    // so what a reader sees is the run's own copy rather than whatever the file
    // says today.
    templateText: resolvedTemplate || null,
    templateSha256: templateSha,
    templateBytes,
    // The text as the module USES it. Every prompt loader trims, so a rebuilder
    // reading the file raw differs by a trailing newline and the digests miss —
    // which is what happened the first time this was checked. Recording the
    // resolved form removes the guess.
    templateResolvedSha256: templateSha === null ? null : sha256(resolvedTemplate),
    // The proof: rebuild the prompt from the rest of this file, hash it, and
    // compare. Equal means the reconstruction is the prompt that was sent.
    assembledSha256: typeof assembled === 'string' ? sha256(assembled) : (assembled?.sha256 || null),
    assembledBytes: typeof assembled === 'string' ? Buffer.byteLength(assembled) : (assembled?.bytes || null),
    attachments: (attachments || []).filter(Boolean).map(attachmentRef)
  };
}

/**
 * A file the prompt is given alongside itself, copied verbatim.
 *
 * Same treatment as the template and for the same reason: it lives in the repo,
 * it can be edited, and a link to where it lives today does not describe what
 * this run was given.
 *
 * @param {string} repoRelative
 * @returns {{file: string, text: string|null, sha256: string|null, bytes: number|null}}
 */
function attachmentRef(repoRelative) {
  try {
    const buf = fs.readFileSync(absolutePath(repoRelative));
    return {
      file: repoRelative,
      text: buf.toString('utf-8'),
      sha256: sha256(buf),
      bytes: buf.length
    };
  } catch {
    // Same fail-soft rule as the template: a file that cannot be read is
    // recorded as unreadable rather than failing a run that already succeeded.
    return { file: repoRelative, text: null, sha256: null, bytes: null };
  }
}

/**
 * Which runs produced the items this run consumed.
 *
 * @param {Array<{source: string, jobId?: string, items?: Array}>} contributions
 */
const upstreamRefs = (contributions = []) => contributions.map((c) => ({
  source: c.source,
  jobId: c.jobId || null,
  itemCount: c.items?.length ?? c.count ?? null
}));

/**
 * Assemble the record and hand it to the logger.
 *
 * Deliberately fail-soft, like every other artefact write: a run that produced
 * a good result must not be failed because its audit copy could not be stored.
 * The failure is logged by the logger itself.
 *
 * @param {object|null} jobLogger
 * @param {object} parts { documents, frozen, upstream, prompt, meta }
 */
async function saveRunInputs(jobLogger, parts = {}) {
  if (!jobLogger) return;
  await jobLogger.saveRawResponse('inputs', {
    capturedAt: new Date().toISOString(),
    // How to read this file, for whoever opens it without the code to hand.
    _note: 'Frozen inputs for this run. Documents are references + digests '
      + '(their stored copies are immutable); everything under `frozen` is a '
      + 'verbatim copy because it can change afterwards. Each prompt template '
      + 'is copied in full under `templateText`; the assembled prompt is kept '
      + 'by digest only — rebuild it from these inputs and compare.',
    ...parts
  });
}

module.exports = { sha256, fileRef, promptRef, attachmentRef, upstreamRefs, saveRunInputs };
