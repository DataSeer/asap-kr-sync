/**
 * ORCID Public API Client Service
 *
 * Optional fallback: searches ORCID by name + affiliation for authors
 * that couldn't be matched via GROBID or OpenAlex.
 */

const axios = require('axios');
const orcidApiConfig = require('../../config/orcid-api');
const logger = require('../../utils/logger');

/**
 * Search ORCID by author name and affiliation.
 * Returns the ORCID ID only if exactly one result is found (confident match).
 *
 * @param {string} firstName
 * @param {string} lastName
 * @param {string|null} affiliation
 * @returns {Promise<string|null>} ORCID ID or null
 */
async function searchByName(firstName, lastName, affiliation) {
  if (!orcidApiConfig.isConfigured()) {
    return null;
  }

  if (!firstName || !lastName) {
    return null;
  }

  try {
    // Build Lucene-style query
    let query = `given-names:${firstName} AND family-name:${lastName}`;
    if (affiliation) {
      query += ` AND affiliation-org-name:${affiliation}`;
    }

    const response = await axios.get(
      `${orcidApiConfig.baseUrl}/search/`,
      {
        params: { q: query },
        headers: { 'Accept': 'application/json' },
        timeout: orcidApiConfig.timeout
      }
    );

    const numFound = response.data?.['num-found'] || 0;

    // Only return if exactly one confident match (or up to 5 with affiliation narrowing)
    if (numFound === 1) {
      const result = response.data?.result?.[0];
      const orcidId = result?.['orcid-identifier']?.path;
      if (orcidId) {
        logger.debug('ORCID API: unique match found', { firstName, lastName, orcidId });
        return orcidId;
      }
    }

    if (numFound === 0) {
      logger.debug('ORCID API: no results', { firstName, lastName, affiliation });
    } else if (numFound > 5) {
      logger.debug('ORCID API: too many results, skipping', { firstName, lastName, numFound });
    }

    return null;
  } catch (error) {
    // ORCID API failures are non-fatal — just log and return null
    logger.warn('ORCID API search failed', {
      firstName,
      lastName,
      error: error.message
    });
    return null;
  }
}

module.exports = {
  searchByName
};
