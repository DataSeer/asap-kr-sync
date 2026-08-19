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

module.exports = { repoPath };
