/**
 * Demo Data Service
 *
 * Centralized loader for demo/fallback data used when external APIs are disabled.
 * Reads *-demo.json files from the frontend demo-findings directory at startup
 * and provides per-type getters by manuscript ID (case-insensitive).
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const DEMO_DIR = path.join(__dirname, '../data/demo-findings');
const DEMO_FILES_DIR = path.join(__dirname, '../../frontend/public/demo-files');

// Cache: manuscript ID (uppercase) → demo data object
let _cache = null;
// Cache: discovered demos list (built from demo-files/ + demo-findings/)
let _demosListCache = null;

/**
 * Load all demo data files into cache.
 * Called lazily on first access.
 */
function loadCache() {
  if (_cache) return;
  _cache = new Map();

  try {
    if (!fs.existsSync(DEMO_DIR)) {
      logger.debug('Demo data directory not found, skipping', { dir: DEMO_DIR });
      return;
    }

    const files = fs.readdirSync(DEMO_DIR).filter(f => f.endsWith('-demo.json'));

    for (const file of files) {
      try {
        const filePath = path.join(DEMO_DIR, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const msId = (data.manuscriptId || '').toUpperCase();

        if (msId) {
          _cache.set(msId, data);
        }
      } catch (err) {
        logger.warn('Failed to load demo data file', { file, error: err.message });
      }
    }

    logger.info('Demo data loaded', { count: _cache.size, dir: DEMO_DIR });
  } catch (err) {
    logger.warn('Failed to read demo data directory', { error: err.message });
  }
}

/**
 * Find demo data for a manuscript ID (case-insensitive).
 * @param {string} manuscriptId
 * @returns {object|null}
 */
function findByManuscriptId(manuscriptId) {
  loadCache();
  if (!manuscriptId) return null;
  return _cache.get(manuscriptId.toUpperCase()) || null;
}

/**
 * Get demo dataset mentions for a manuscript.
 * @param {string} manuscriptId
 * @returns {{ items: Array, meta: object }|null}
 */
function getDemoDatasetMentions(manuscriptId) {
  const data = findByManuscriptId(manuscriptId);
  return data?.datasetMentions || null;
}

/**
 * Get demo software mentions for a manuscript.
 * @param {string} manuscriptId
 * @returns {{ items: Array, meta: object }|null}
 */
function getDemoSoftwareMentions(manuscriptId) {
  const data = findByManuscriptId(manuscriptId);
  return data?.softwareMentions || null;
}

/**
 * Get demo protocol mentions for a manuscript.
 * @param {string} manuscriptId
 * @returns {{ items: Array, meta: object }|null}
 */
function getDemoProtocolMentions(manuscriptId) {
  const data = findByManuscriptId(manuscriptId);
  return data?.protocolMentions || null;
}

/**
 * Get demo lab material mentions for a manuscript.
 * @param {string} manuscriptId
 * @returns {{ items: Array, meta: object }|null}
 */
function getDemoLabMaterialMentions(manuscriptId) {
  const data = findByManuscriptId(manuscriptId);
  return data?.labMaterialMentions || null;
}

/**
 * Get demo Data Availability Statement for a manuscript.
 * @param {string} manuscriptId
 * @returns {string|null}
 */
function getDemoDAS(manuscriptId) {
  const data = findByManuscriptId(manuscriptId);
  if (data?.das && data.das !== 'N/A') return data.das;
  return null;
}

/**
 * Get demo Markdown content for a manuscript.
 * Reads the corresponding .md file from the demo-findings directory.
 * @param {string} manuscriptId
 * @returns {string|null}
 */
function getDemoMarkdown(manuscriptId) {
  if (!manuscriptId) return null;

  const mdFileName = manuscriptId.toLowerCase() + '-demo.md';
  const mdPath = path.join(DEMO_DIR, mdFileName);

  try {
    if (!fs.existsSync(mdPath)) return null;
    const content = fs.readFileSync(mdPath, 'utf-8');
    return content.trim() || null;
  } catch (err) {
    logger.warn('Failed to read demo markdown file', { file: mdFileName, error: err.message });
    return null;
  }
}

/**
 * Check if demo data is available for a manuscript.
 * @param {string} manuscriptId
 * @returns {boolean}
 */
function hasDemoData(manuscriptId) {
  return findByManuscriptId(manuscriptId) !== null;
}

/**
 * Discover available demos by scanning the public demo-files directory.
 *
 * For every `<id>.pdf` in demo-files/, builds an entry with:
 *   - id, name (defaults to id)
 *   - description (short label, from <id>-demo.json if any)
 *   - title (full manuscript title, from <id>-demo.json if any)
 *   - pdf: the PDF filename
 *   - krt: matching `<id>.{xlsx|csv|xls|ods}` if present (the -DS1 audit
 *     report is excluded — it shares the manuscript id but is not a KRT)
 *
 * Cached after first scan; the demo dirs are mounted read-only on prod and
 * picked up on container start, so a process-lifetime cache is fine.
 *
 * @returns {Array<{id: string, name: string, description: string, pdf: string, krt: string|null}>}
 */
function listAvailableDemos() {
  if (_demosListCache) return _demosListCache;

  const list = [];
  try {
    if (!fs.existsSync(DEMO_FILES_DIR)) {
      logger.debug('Demo files directory not found, returning empty list', { dir: DEMO_FILES_DIR });
      _demosListCache = [];
      return _demosListCache;
    }

    const allFiles = fs.readdirSync(DEMO_FILES_DIR);
    const pdfFiles = allFiles.filter(f => f.toLowerCase().endsWith('.pdf')).sort();

    for (const pdf of pdfFiles) {
      const id = pdf.replace(/\.pdf$/i, '');
      // KRT = same base name, xlsx/csv/xls/ods, NOT the -DS1 audit report
      const krt = allFiles.find(f => {
        if (!/\.(xlsx|csv|xls|ods)$/i.test(f)) return false;
        const base = f.replace(/\.(xlsx|csv|xls|ods)$/i, '');
        return base === id;
      }) || null;

      const finding = findByManuscriptId(id);
      const description = finding?.description?.trim() || '';
      const title = finding?.title?.trim() || '';

      list.push({
        id,
        name: id,
        description,
        title,
        pdf,
        krt
      });
    }

    logger.info('Demo files discovered', { count: list.length, dir: DEMO_FILES_DIR });
  } catch (err) {
    logger.warn('Failed to read demo files directory', { error: err.message });
  }

  _demosListCache = list;
  return list;
}

module.exports = {
  getDemoDatasetMentions,
  getDemoSoftwareMentions,
  getDemoProtocolMentions,
  getDemoLabMaterialMentions,
  getDemoDAS,
  getDemoMarkdown,
  hasDemoData,
  listAvailableDemos
};
