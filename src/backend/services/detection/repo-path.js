/**
 * A repository-relative path for a file on disk.
 *
 * Used to name the prompt a run actually used, so the UI can link to it on
 * GitHub. Relative, not absolute: an absolute path leaks the deployment's
 * directory layout to every reader, and means nothing to someone following the
 * link.
 */

const path = require('path');

/** Repo root — four levels up from services/detection. */
const ROOT = path.resolve(__dirname, '../../../..');

/**
 * @param {string} absolutePath
 * @returns {string} e.g. "src/backend/data/prompts/seeded/materials-detection.txt"
 */
function repoPath(absolutePath) {
  return path.relative(ROOT, absolutePath).split(path.sep).join('/');
}

/**
 * The inverse: a repository-relative path back to a path on disk.
 *
 * A run records its prompt relatively, because that is what a reader can
 * follow. Hashing the template later needs the file itself, and re-deriving the
 * absolute path here keeps every caller from carrying both forms around.
 *
 * @param {string} relative
 * @returns {string|null} null when given nothing
 */
function absolutePath(relative) {
  return relative ? path.join(ROOT, relative) : null;
}

module.exports = { repoPath, absolutePath };
