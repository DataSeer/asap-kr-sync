/**
 * Identifier Extractor Service
 * Extracts DOIs, RRIDs, URLs, and catalog numbers from text
 */

// Regular expressions for different identifier types
const patterns = {
  // DOI patterns (e.g., 10.1234/something)
  doi: /\b(10\.\d{4,}\/[^\s,;)\]]+)/gi,

  // RRID patterns (e.g., RRID:AB_123456)
  rrid: /\bRRID:\s*([A-Za-z]+_[A-Za-z0-9]+)/gi,

  // SCR codes (SciCrunch Research Resource Identifiers, e.g., SCR_016499)
  scr: /\b(SCR_\d+)\b/gi,

  // EMDB IDs (e.g., EMDB: 55203 or EMDB:55203)
  emdb: /\bEMDB:\s*(\d+)/gi,

  // PDB IDs (e.g., PDB: 9SHG or PDB:9SHG)
  pdb: /\bPDB:\s*([A-Z0-9]{4})/gi,

  // EMPIAR IDs (e.g., EMPIAR-13145 or EMPIAR: 13145)
  empiar: /\bEMPIAR[-:\s]*(\d+)/gi,

  // Cellosaurus IDs (e.g., Cellosaurus: CVCL_F1H5)
  cellosaurus: /\bCellosaurus:\s*([A-Z0-9_]+)/gi,

  // Addgene (e.g., Addgene: 12345 or Addgene: Submitted)
  addgene: /\bAddgene:\s*(\d+|Submitted[^,;)]*)/gi,

  // URL patterns
  url: /https?:\/\/[^\s,;)\]<>"]+/gi,

  // Catalog numbers (common formats like HY-102007, 62802, 6946S, sc-32233)
  catalogNumber: /\b([A-Za-z]{0,3}[-#]?\d{4,}[A-Za-z]?)\b/gi,

  // PubMed IDs
  pmid: /\bPMID:\s*(\d+)/gi,

  // GenBank accessions
  genbank: /\b([A-Z]{1,2}\d{5,6}(\.\d+)?)\b/gi,

  // UniProt IDs
  uniprot: /\b([OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9]([A-Z][A-Z0-9]{2}[0-9]){1,2})\b/gi
};

/**
 * Extract all identifiers from text
 * @param {string} text
 * @returns {object} Object with arrays of found identifiers
 */
function extractAll(text) {
  if (!text || typeof text !== 'string') {
    return {
      doi: null,
      rrid: null,
      scr: null,
      emdb: null,
      pdb: null,
      empiar: null,
      cellosaurus: null,
      addgene: null,
      url: null,
      catalogNumber: null,
      pmid: null,
      genbank: null,
      uniprot: null
    };
  }

  return {
    doi: extractDOI(text),
    rrid: extractRRID(text),
    scr: extractSCR(text),
    emdb: extractEMDB(text),
    pdb: extractPDB(text),
    empiar: extractEMPIAR(text),
    cellosaurus: extractCellosaurus(text),
    addgene: extractAddgene(text),
    url: extractURL(text),
    catalogNumber: extractCatalogNumber(text),
    pmid: extractPMID(text),
    genbank: extractGenBank(text),
    uniprot: extractUniProt(text)
  };
}

/**
 * Check if text contains any valid identifier
 * @param {string} text
 * @returns {boolean}
 */
function hasValidIdentifier(text) {
  const extracted = extractAll(text);
  return Object.values(extracted).some(v => v !== null);
}

/**
 * Extract DOI from text
 * @param {string} text
 * @returns {string|null} First DOI found or null
 */
function extractDOI(text) {
  const matches = text.match(patterns.doi);
  if (matches && matches.length > 0) {
    // Clean up the DOI (remove trailing punctuation)
    return matches[0].replace(/[.,;)\]]+$/, '');
  }
  return null;
}

/**
 * Extract RRID from text
 * @param {string} text
 * @returns {string|null} First RRID found or null
 */
function extractRRID(text) {
  const match = patterns.rrid.exec(text);
  patterns.rrid.lastIndex = 0; // Reset regex state
  if (match) {
    return `RRID:${match[1]}`;
  }
  return null;
}

/**
 * Extract URL from text
 * @param {string} text
 * @returns {string|null} First URL found or null
 */
function extractURL(text) {
  const matches = text.match(patterns.url);
  if (matches && matches.length > 0) {
    // Clean up URL (remove trailing punctuation)
    return matches[0].replace(/[.,;)\]>]+$/, '');
  }
  return null;
}

/**
 * Extract SCR code from text
 * @param {string} text
 * @returns {string|null}
 */
function extractSCR(text) {
  const matches = text.match(patterns.scr);
  if (matches && matches.length > 0) {
    return matches[0];
  }
  return null;
}

/**
 * Extract EMDB ID from text
 * @param {string} text
 * @returns {string|null}
 */
function extractEMDB(text) {
  const match = patterns.emdb.exec(text);
  patterns.emdb.lastIndex = 0;
  if (match) {
    return `EMDB:${match[1]}`;
  }
  return null;
}

/**
 * Extract PDB ID from text
 * @param {string} text
 * @returns {string|null}
 */
function extractPDB(text) {
  const match = patterns.pdb.exec(text);
  patterns.pdb.lastIndex = 0;
  if (match) {
    return `PDB:${match[1]}`;
  }
  return null;
}

/**
 * Extract EMPIAR ID from text
 * @param {string} text
 * @returns {string|null}
 */
function extractEMPIAR(text) {
  const match = patterns.empiar.exec(text);
  patterns.empiar.lastIndex = 0;
  if (match) {
    return `EMPIAR-${match[1]}`;
  }
  return null;
}

/**
 * Extract Cellosaurus ID from text
 * @param {string} text
 * @returns {string|null}
 */
function extractCellosaurus(text) {
  const match = patterns.cellosaurus.exec(text);
  patterns.cellosaurus.lastIndex = 0;
  if (match) {
    return `Cellosaurus:${match[1]}`;
  }
  return null;
}

/**
 * Extract Addgene reference from text
 * @param {string} text
 * @returns {string|null}
 */
function extractAddgene(text) {
  const match = patterns.addgene.exec(text);
  patterns.addgene.lastIndex = 0;
  if (match) {
    return `Addgene:${match[1].trim()}`;
  }
  return null;
}

/**
 * Extract catalog number from text
 * @param {string} text
 * @returns {string|null} First catalog number found or null
 */
function extractCatalogNumber(text) {
  // Skip if we already found a more specific identifier
  if (extractDOI(text) || extractRRID(text) || extractSCR(text) ||
      extractEMDB(text) || extractPDB(text) || extractEMPIAR(text)) {
    return null;
  }

  const matches = text.match(patterns.catalogNumber);
  if (matches && matches.length > 0) {
    return matches[0];
  }
  return null;
}

/**
 * Extract PubMed ID from text
 * @param {string} text
 * @returns {string|null}
 */
function extractPMID(text) {
  const match = patterns.pmid.exec(text);
  patterns.pmid.lastIndex = 0;
  if (match) {
    return `PMID:${match[1]}`;
  }
  return null;
}

/**
 * Extract GenBank accession from text
 * @param {string} text
 * @returns {string|null}
 */
function extractGenBank(text) {
  const matches = text.match(patterns.genbank);
  if (matches && matches.length > 0) {
    return matches[0];
  }
  return null;
}

/**
 * Extract UniProt ID from text
 * @param {string} text
 * @returns {string|null}
 */
function extractUniProt(text) {
  const matches = text.match(patterns.uniprot);
  if (matches && matches.length > 0) {
    return matches[0];
  }
  return null;
}

/**
 * Validate a DOI format
 * @param {string} doi
 * @returns {boolean}
 */
function isValidDOI(doi) {
  return /^10\.\d{4,}\/[^\s]+$/.test(doi);
}

/**
 * Validate an RRID format
 * @param {string} rrid
 * @returns {boolean}
 */
function isValidRRID(rrid) {
  return /^RRID:[A-Za-z]+_[A-Za-z0-9]+$/.test(rrid);
}

/**
 * Validate a URL format
 * @param {string} url
 * @returns {boolean}
 */
function isValidURL(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format DOI as URL
 * @param {string} doi
 * @returns {string}
 */
function formatDOIAsURL(doi) {
  if (doi.startsWith('http')) {
    return doi;
  }
  return `https://doi.org/${doi}`;
}

module.exports = {
  extractAll,
  hasValidIdentifier,
  extractDOI,
  extractRRID,
  extractSCR,
  extractEMDB,
  extractPDB,
  extractEMPIAR,
  extractCellosaurus,
  extractAddgene,
  extractURL,
  extractCatalogNumber,
  extractPMID,
  extractGenBank,
  extractUniProt,
  isValidDOI,
  isValidRRID,
  isValidURL,
  formatDOIAsURL
};
