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

/** Key names whose value must never reach an artefact. */
const SECRET_KEY = /key|token|secret|password|passwd|auth|credential|bearer|cookie/i;

/**
 * Strings longer than this become a reference instead of a copy.
 *
 * By SIZE, not by key name, and that is the point: you cannot enumerate the
 * keys that might one day hold a document. A rule keyed on names is a rule
 * somebody has to remember to extend, which is exactly how four modules came to
 * record no model at all.
 *
 * 2 KB is comfortably above any parameter worth reading inline (a model name, a
 * converter, a temperature) and far below any document.
 */
const INLINE_LIMIT = 2048;

/** Where a sanitised record lists what it left out, and why. */
const OMITTED = '_omitted';

/**
 * Make an arbitrary parameter object safe to freeze — and safe to merge back.
 *
 * The inversion this exists for: recording the call parameters used to mean
 * hand-picking them per module, and a hand-picked list drifts — four of twelve
 * modules never recorded which model they called. Capturing everything and
 * stripping what must not be kept cannot be forgotten in the same way.
 *
 * ── Why omitted, and not `[redacted]` ───────────────────────────────────────
 *
 * Because this record is not only read — it is MERGED BACK when a run is
 * restarted with frozen parameters. A placeholder is not a redaction at that
 * point, it is a poisoned value: the merge would send the literal string
 * `[redacted]` as the API key, and the call would fail. Same for a document
 * replaced by `{ omitted, sha256 }` — merged over the live `contents` it
 * replaces a manuscript with a small object.
 *
 * So anything unsafe or too large is REMOVED from the body, and named under
 * `_omitted` beside it. A merge skips that key and falls through to the live
 * value; a reader still sees that a secret existed and was deliberately not
 * kept, which plain absence could not tell apart from "this parameter did not
 * exist in that version".
 *
 * @param {*} value
 * @param {object} [state] - internal: accumulates the omissions
 * @param {string} [prefix] - internal: dotted path of the current key
 * @param {number} [depth] - guards against a cyclic or absurdly nested object
 * @returns {*} a structure safe to serialise, carrying `_omitted` at the root
 */
function sanitise(value, state = { omitted: {} }, prefix = '', depth = 0) {
  const walk = (v, path, d) => {
    if (v === null || v === undefined) return v ?? null;
    if (d > 8) return '[too deep]';

    if (typeof v === 'string') {
      if (v.length <= INLINE_LIMIT) return v;
      state.omitted[path] = { reason: 'too large to inline', bytes: Buffer.byteLength(v), sha256: sha256(v) };
      return undefined;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    // A method on a config module is a code fact, not a parameter. Dropped
    // without a note: it was never a value to restore.
    if (typeof v === 'function') return undefined;
    if (typeof v !== 'object') return `[${typeof v}]`;

    if (Buffer.isBuffer(v)) {
      state.omitted[path] = { reason: 'binary', bytes: v.length, sha256: sha256(v) };
      return undefined;
    }
    if (Array.isArray(v)) {
      // Long arrays are summarised: a 117-item candidate list is a count, not a
      // parameter, and the items themselves are in the result.
      if (v.length > 50) {
        state.omitted[path] = { reason: 'long array', length: v.length };
        return undefined;
      }
      return v.map((item, i) => walk(item, path ? `${path}.${i}` : String(i), d + 1));
    }

    const out = {};
    for (const [k, child] of Object.entries(v)) {
      const childPath = path ? `${path}.${k}` : k;
      if (SECRET_KEY.test(k)) {
        state.omitted[childPath] = { reason: 'secret' };
        continue;
      }
      const kept = walk(child, childPath, d + 1);
      if (kept !== undefined) out[k] = kept;
    }
    return out;
  };

  const body = walk(value, prefix, depth);
  if (body && typeof body === 'object' && !Array.isArray(body) && Object.keys(state.omitted).length) {
    return { ...body, [OMITTED]: state.omitted };
  }
  return body;
}

/**
 * The parameters to call with, when a restart is asked to use a run's own.
 *
 * Frozen wins, live fills the gaps — which is what makes omitting a secret
 * correct rather than merely safe: the key was never in the record, so the
 * merge falls through to the one configured now.
 *
 * ── Restricted to what the live config still knows ──────────────────────────
 *
 * A frozen parameter the current code no longer has cannot be honoured — the
 * client would reject it, or ignore it and leave the caller believing the run
 * was reproduced. Those are REPORTED instead, so "this run used a setting this
 * version does not have" is something a user reads rather than something that
 * silently does not happen.
 *
 * @param {object} live - the config as it stands now
 * @param {object} frozen - a `call` record from a run's frozen inputs
 * @returns {{params: object, ignored: string[], restored: string[]}}
 */
function mergeFrozen(live, frozen) {
  const ignored = [];
  const restored = [];

  const merge = (base, over, path = '') => {
    const out = { ...base };
    for (const [k, v] of Object.entries(over || {})) {
      if (k === OMITTED) continue;
      const here = path ? `${path}.${k}` : k;
      if (!(k in (base || {}))) { ignored.push(here); continue; }
      if (v && typeof v === 'object' && !Array.isArray(v)
        && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        out[k] = merge(base[k], v, here);
      } else {
        if (JSON.stringify(base[k]) !== JSON.stringify(v)) restored.push(here);
        out[k] = v;
      }
    }
    return out;
  };

  return { params: merge(live || {}, frozen || {}), ignored, restored };
}

/**
 * Assemble the record and hand it to the logger.
 *
 * Deliberately fail-soft, like every other artefact write: a run that produced
 * a good result must not be failed because its audit copy could not be stored.
 * The failure is logged by the logger itself.
 *
 * @param {object|null} jobLogger
 * @param {object} parts { documents, frozen, upstream, prompt, meta, call }
 *   `call` is whatever was handed to the external client — model, generation
 *   config, endpoint, module knobs. Passed whole and sanitised here, rather
 *   than picked apart at the call site.
 */
async function saveRunInputs(jobLogger, parts = {}) {
  if (!jobLogger) return;
  const { call, ...rest } = parts;
  await jobLogger.saveRawResponse('inputs', {
    capturedAt: new Date().toISOString(),
    // How to read this file, for whoever opens it without the code to hand.
    _note: 'Frozen inputs for this run. Documents are references + digests '
      + '(their stored copies are immutable); everything under `frozen` is a '
      + 'verbatim copy because it can change afterwards. Each prompt template '
      + 'is copied in full under `templateText`; the assembled prompt is kept '
      + 'by digest only — rebuild it from these inputs and compare. `call` is '
      + 'what was asked of the external service; anything secret or too large '
      + 'is REMOVED and named under `call._omitted`, so these parameters can be '
      + 'merged back over the live config without poisoning it.',
    ...rest,
    ...(call ? { call: sanitise(call) } : {})
  });
}

module.exports = {
  sha256, fileRef, promptRef, attachmentRef, upstreamRefs, saveRunInputs,
  sanitise, mergeFrozen, INLINE_LIMIT, OMITTED
};
