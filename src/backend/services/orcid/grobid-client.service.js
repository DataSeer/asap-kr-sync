/**
 * GROBID Client Service
 *
 * Calls GROBID's processHeaderDocument endpoint to extract structured metadata
 * (DOI, authors, affiliations, ORCIDs) from PDF manuscript headers.
 * Response is TEI-XML, parsed with fast-xml-parser.
 */

const axios = require('axios');
const FormData = require('form-data');
const { XMLParser } = require('fast-xml-parser');
const grobidConfig = require('../../config/grobid-api');
const { ExternalServiceError } = require('../../utils/errors');
const { retry } = require('../../utils/helpers');
const logger = require('../../utils/logger');

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  isArray: (name) => ['author', 'forename', 'idno', 'orgName', 'affiliation'].includes(name)
});

/**
 * Extract a text value from a parsed XML node.
 * Handles both string values and objects with #text property.
 * @param {*} node
 * @returns {string|null}
 */
function textOf(node) {
  if (!node) return null;
  if (typeof node === 'string') return node.trim();
  if (node['#text']) return String(node['#text']).trim();
  return null;
}

/**
 * Parse TEI-XML response from GROBID into structured author/DOI data.
 * @param {string} teiXml - Raw TEI-XML string
 * @returns {{ doi: string|null, authors: Array<object> }}
 */
function parseTeiHeader(teiXml) {
  const parsed = xmlParser.parse(teiXml);
  const teiHeader = parsed?.TEI?.teiHeader;
  if (!teiHeader) {
    // Log the top-level keys so we can diagnose why TEI/teiHeader wasn't found
    const topKeys = parsed ? Object.keys(parsed) : [];
    const teiKeys = parsed?.TEI ? Object.keys(parsed.TEI) : [];
    logger.warn('GROBID TEI parsing: teiHeader not found', {
      topLevelKeys: topKeys,
      teiKeys,
      xmlLength: teiXml?.length || 0,
      xmlPreview: teiXml?.substring(0, 500) || ''
    });
    return { doi: null, authors: [] };
  }

  const biblStruct = teiHeader?.fileDesc?.sourceDesc?.biblStruct;
  const analytic = biblStruct?.analytic;

  if (!analytic) {
    logger.warn('GROBID TEI parsing: analytic section not found', {
      hasFileDesc: !!teiHeader?.fileDesc,
      hasSourceDesc: !!teiHeader?.fileDesc?.sourceDesc,
      hasBiblStruct: !!biblStruct
    });
  }

  // Extract DOI from <idno type="DOI"> inside <analytic>
  let doi = null;
  const idnos = analytic?.idno || biblStruct?.idno || [];
  const idnoList = Array.isArray(idnos) ? idnos : [idnos];
  for (const idno of idnoList) {
    if (idno?.['@_type'] === 'DOI') {
      doi = textOf(idno) || null;
      break;
    }
  }

  // Extract authors from <author> elements inside <analytic>
  const authorElements = analytic?.author || [];
  const authorList = Array.isArray(authorElements) ? authorElements : [authorElements];

  logger.debug('GROBID TEI parsing: extraction summary', {
    doi,
    authorElementCount: authorList.length,
    idnoCount: idnoList.length,
    idnoTypes: idnoList.map(i => i?.['@_type']).filter(Boolean)
  });

  const authors = [];
  for (const authorEl of authorList) {
    if (!authorEl) continue;

    const persName = authorEl.persName;
    if (!persName) continue;

    // Extract first name
    const forenames = persName.forename || [];
    const forenameList = Array.isArray(forenames) ? forenames : [forenames];
    let firstName = null;
    for (const fn of forenameList) {
      if (fn?.['@_type'] === 'first') {
        firstName = textOf(fn);
        break;
      }
    }

    // Extract last name
    const lastName = textOf(persName.surname);
    if (!lastName) continue;

    // Extract ORCID from <idno type="ORCID"> on the author element
    let orcid = null;
    const authorIdnos = authorEl.idno || [];
    const authorIdnoList = Array.isArray(authorIdnos) ? authorIdnos : [authorIdnos];
    for (const idno of authorIdnoList) {
      if (idno?.['@_type'] === 'ORCID') {
        orcid = textOf(idno);
        break;
      }
    }

    // Extract affiliation (first institution name)
    let affiliation = null;
    const affiliations = authorEl.affiliation || [];
    const affiliationList = Array.isArray(affiliations) ? affiliations : [affiliations];
    for (const aff of affiliationList) {
      const orgNames = aff?.orgName || [];
      const orgNameList = Array.isArray(orgNames) ? orgNames : [orgNames];
      for (const org of orgNameList) {
        if (org?.['@_type'] === 'institution') {
          affiliation = textOf(org);
          break;
        }
      }
      if (affiliation) break;
    }

    authors.push({
      firstName: firstName || null,
      lastName,
      orcid: orcid || null,
      affiliation: affiliation || null
    });
  }

  if (authorList.length > 0 && authors.length === 0) {
    logger.warn('GROBID TEI parsing: author elements found but none parsed successfully', {
      authorElementCount: authorList.length,
      firstAuthorKeys: authorList[0] ? Object.keys(authorList[0]) : [],
      firstAuthorHasPersName: !!authorList[0]?.persName
    });
  }

  logger.debug('GROBID TEI parsing: authors extracted', {
    doi,
    authorCount: authors.length,
    authors: authors.map(a => ({
      name: `${a.firstName || '?'} ${a.lastName}`,
      orcid: a.orcid || null,
      affiliation: a.affiliation || null
    }))
  });

  return { doi, authors };
}

/**
 * Send a PDF to GROBID for header extraction.
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @param {string} fileName - Original file name
 * @returns {Promise<{ doi: string|null, authors: Array, raw: string, durationMs: number }>}
 */
async function extractHeader(pdfBuffer, fileName = 'article.pdf') {
  if (!grobidConfig.isConfigured()) {
    logger.warn('GROBID API not configured, skipping header extraction');
    return { doi: null, authors: [], raw: null, durationMs: 0 };
  }

  const start = Date.now();

  try {
    const teiXml = await retry(
      async () => {
        const form = new FormData();
        // Parameters first, then PDF — matches GROBID demo UI field ordering
        form.append('consolidateHeader', '1');
        form.append('includeRawAffiliations', '1');
        form.append('input', pdfBuffer, {
          filename: fileName,
          contentType: 'application/pdf'
        });

        const response = await axios.post(
          `${grobidConfig.baseUrl}/api/processHeaderDocument`,
          form,
          {
            headers: {
              ...form.getHeaders(),
              'Accept': 'application/xml'
            },
            timeout: grobidConfig.timeout,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            responseType: 'text'
          }
        );

        // Validate we got XML back, not BibTeX or other formats
        const data = response.data;
        if (typeof data === 'string' && !data.trimStart().startsWith('<')) {
          logger.error('GROBID returned non-XML response', {
            responseLength: data.length,
            preview: data.substring(0, 300)
          });
          throw new ExternalServiceError('GROBID', 'Expected TEI-XML but got non-XML response');
        }

        return data;
      },
      {
        maxRetries: grobidConfig.retryConfig.maxRetries,
        delay: grobidConfig.retryConfig.retryDelay,
        multiplier: grobidConfig.retryConfig.retryDelayMultiplier,
        onRetry: (attempt, waitTime, error) => {
          logger.warn(`GROBID API retry attempt ${attempt}`, {
            waitTime,
            error: error.message
          });
        }
      }
    );

    const durationMs = Date.now() - start;

    logger.debug('GROBID raw response received', {
      responseLength: teiXml?.length || 0,
      responseType: typeof teiXml,
      durationMs,
      preview: typeof teiXml === 'string' ? teiXml.substring(0, 300) : '(not a string)'
    });

    const { doi, authors } = parseTeiHeader(teiXml);

    logger.info('GROBID header extraction completed', {
      doi,
      authorCount: authors.length,
      orcidsFromGrobid: authors.filter(a => a.orcid).length,
      durationMs
    });

    return { doi, authors, raw: teiXml, durationMs };
  } catch (error) {
    logger.error('GROBID API error', { error: error.message });

    if (error.response) {
      const status = error.response.status;
      if (status === 503) {
        throw new ExternalServiceError('GROBID', 'Service unavailable (model may still be loading)');
      }
      if (status >= 500) {
        throw new ExternalServiceError('GROBID', 'Service error');
      }
      throw new ExternalServiceError('GROBID', `HTTP ${status}`);
    }

    if (error.code === 'ECONNABORTED') {
      throw new ExternalServiceError('GROBID', 'Request timeout');
    }

    throw new ExternalServiceError('GROBID', error.message);
  }
}

module.exports = {
  extractHeader,
  parseTeiHeader
};
