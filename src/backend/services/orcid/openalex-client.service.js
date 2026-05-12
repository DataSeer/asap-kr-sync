/**
 * OpenAlex Client Service
 *
 * Looks up works by DOI to retrieve verified author-ORCID pairs.
 * Free API — no key needed, but mailto gets higher rate limits.
 */

const axios = require('axios');
const openalexConfig = require('../../config/openalex-api');
const { ExternalServiceError } = require('../../utils/errors');
const logger = require('../../utils/logger');

/**
 * Strip the ORCID URL prefix to get the bare ID.
 * @param {string|null} orcidUrl - e.g. "https://orcid.org/0000-0001-2345-6789"
 * @returns {string|null} - e.g. "0000-0001-2345-6789"
 */
function stripOrcidPrefix(orcidUrl) {
  if (!orcidUrl) return null;
  return orcidUrl.replace(/^https?:\/\/orcid\.org\//, '');
}

/**
 * Split a display name into first/last name parts.
 * OpenAlex provides "display_name" like "Jane A. Doe".
 * @param {string} displayName
 * @returns {{ firstName: string, lastName: string }}
 */
function splitDisplayName(displayName) {
  if (!displayName) return { firstName: '', lastName: '' };
  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: '', lastName: parts[0] };
  return {
    firstName: parts[0],
    lastName: parts[parts.length - 1]
  };
}

/**
 * Look up a work by DOI and extract author-ORCID pairs.
 * @param {string} doi - e.g. "10.1234/example"
 * @returns {Promise<{ authors: Array<object>, raw: object|null, durationMs: number }>}
 */
async function lookupByDoi(doi) {
  if (!openalexConfig.isConfigured()) {
    logger.warn('OpenAlex API disabled, skipping ORCID enrichment');
    return { authors: [], raw: null, durationMs: 0 };
  }

  if (!doi) {
    return { authors: [], raw: null, durationMs: 0 };
  }

  const start = Date.now();

  try {
    const params = {};
    if (openalexConfig.mailto) {
      params.mailto = openalexConfig.mailto;
    }

    const response = await axios.get(
      `${openalexConfig.baseUrl}/works/doi:${doi}`,
      {
        params,
        timeout: openalexConfig.timeout,
        headers: { 'Accept': 'application/json' }
      }
    );

    const durationMs = Date.now() - start;
    const authorships = response.data?.authorships || [];

    const authors = authorships.map(authorship => {
      const displayName = authorship.author?.display_name || '';
      const { firstName, lastName } = splitDisplayName(displayName);

      return {
        displayName,
        firstName,
        lastName,
        orcid: stripOrcidPrefix(authorship.author?.orcid),
        affiliations: authorship.raw_affiliation_strings || []
      };
    });

    logger.info('OpenAlex lookup completed', {
      doi,
      authorCount: authors.length,
      orcidCount: authors.filter(a => a.orcid).length,
      durationMs
    });

    return { authors, raw: response.data, durationMs };
  } catch (error) {
    const durationMs = Date.now() - start;

    // 404 = DOI not found in OpenAlex — graceful fallback
    if (error.response?.status === 404) {
      logger.info('OpenAlex DOI not found', { doi, durationMs });
      return { authors: [], raw: null, durationMs };
    }

    logger.error('OpenAlex API error', { doi, error: error.message });

    if (error.code === 'ECONNABORTED') {
      throw new ExternalServiceError('OpenAlex', 'Request timeout');
    }

    throw new ExternalServiceError('OpenAlex', error.message);
  }
}

module.exports = {
  lookupByDoi,
  stripOrcidPrefix,
  splitDisplayName
};
