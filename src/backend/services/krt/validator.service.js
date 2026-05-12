/**
 * KRT Validator Service
 * Validates KRT data against defined rules
 */

const { ValidationResult, KRTData } = require('../../models');
const { getResourceTypes, getValidationRules, VALIDATION_SEVERITY } = require('../../config/constants');
const identifierExtractor = require('./identifier-extractor');

// Cached resource types for validation
let cachedResourceTypes = null;

/**
 * Load and cache resource types from database
 * @returns {Promise<string[]>}
 */
async function loadResourceTypes() {
  if (!cachedResourceTypes) {
    cachedResourceTypes = await getResourceTypes();
  }
  return cachedResourceTypes;
}

/**
 * Refresh cached resource types (call when config changes)
 */
function refreshResourceTypesCache() {
  cachedResourceTypes = null;
}

/**
 * Validate all rows for a submission
 * @param {string} submissionId
 * @returns {Promise<object>} Validation results summary
 */
async function validateSubmission(submissionId, round) {
  // Clear existing validation results
  await ValidationResult.clearForSubmission(submissionId, round);

  // Load resource types from database
  const resourceTypes = await loadResourceTypes();

  // Get all KRT rows
  const where = { submissionId };
  if (round !== undefined) {
    where.round = round;
  }
  const rows = await KRTData.findAll({
    where,
    order: [['createdAt', 'ASC']]
  });

  let errorCount = 0;
  let warningCount = 0;

  for (const row of rows) {
    const rowErrors = await validateRow(row, submissionId, false, resourceTypes, round);
    errorCount += rowErrors.filter(e => e.severity === VALIDATION_SEVERITY.ERROR).length;
    warningCount += rowErrors.filter(e => e.severity === VALIDATION_SEVERITY.WARNING).length;
  }

  return {
    rowCount: rows.length,
    errorCount,
    warningCount,
    isValid: errorCount === 0
  };
}

/**
 * Validate a single row
 * @param {object} row - KRTData instance
 * @param {string} submissionId
 * @param {boolean} clearExisting - Whether to clear existing errors for this row
 * @param {string[]} resourceTypes - Optional resource types array (loaded from DB if not provided)
 * @returns {Promise<Array>} Array of validation errors
 */
async function validateRow(row, submissionId, clearExisting = true, resourceTypes = null, round) {
  if (clearExisting) {
    const destroyWhere = { submissionId, rowId: row.id };
    if (round !== undefined) {
      destroyWhere.round = round;
    }
    await ValidationResult.destroy({ where: destroyWhere });
  }

  // Load resource types if not provided
  const types = resourceTypes || await loadResourceTypes();

  const errors = [];

  // Validate RESOURCE TYPE
  const resourceTypeErrors = validateResourceType(row.resourceType, row.id, types);
  errors.push(...resourceTypeErrors);

  // Validate RESOURCE NAME
  const resourceNameErrors = validateResourceName(row.resourceName, row.id);
  errors.push(...resourceNameErrors);

  // Validate SOURCE
  const sourceErrors = validateSource(row.source, row.id);
  errors.push(...sourceErrors);

  // Validate IDENTIFIER
  const identifierErrors = await validateIdentifier(row, submissionId);
  errors.push(...identifierErrors);

  // Validate NEW/REUSE
  const newReuseErrors = validateNewReuse(row.newReuse, row.id);
  errors.push(...newReuseErrors);

  // Save errors to database
  for (const error of errors) {
    await ValidationResult.create({
      submissionId,
      round: round !== undefined ? round : 1,
      ...error
    });
  }

  return errors;
}

/**
 * Normalize resource type to match known types
 * Handles common variations (singular/plural, minor spelling differences)
 */
function normalizeResourceType(value) {
  if (!value) return null;

  const normalized = value.trim().toLowerCase();

  // Common mappings for variations (all map to singular/canonical forms)
  const mappings = {
    'antibody': 'Antibody',
    'antibodies': 'Antibody',
    'bacterial strain': 'Bacterial strain',
    'bacterial strains': 'Bacterial strain',
    'biological sample': 'Biological sample',
    'biological samples': 'Biological sample',
    'cdna construct': 'Chemical, peptide, or recombinant protein',
    'cdna constructs': 'Chemical, peptide, or recombinant protein',
    'chemical': 'Chemical, peptide, or recombinant protein',
    'chemicals': 'Chemical, peptide, or recombinant protein',
    'chemical, peptide, or recombinant protein': 'Chemical, peptide, or recombinant protein',
    'critical commercial assay': 'Critical commercial assay',
    'critical commercial assays': 'Critical commercial assay',
    'dataset': 'Dataset',
    'datasets': 'Dataset',
    'experimental model: cell line': 'Experimental model: Cell line',
    'experimental models: cell line': 'Experimental model: Cell line',
    'experimental models: cell lines': 'Experimental model: Cell line',
    'experimental model: organism/strain': 'Experimental model: Organism/strain',
    'experimental models: organism/strain': 'Experimental model: Organism/strain',
    'oligonucleotide': 'Oligonucleotide',
    'oligonucleotides': 'Oligonucleotide',
    'other': 'Other',
    'others': 'Other',
    'protocol': 'Protocol',
    'protocols': 'Protocol',
    'recombinant dna': 'Recombinant DNA',
    'recombinant protein': 'Chemical, peptide, or recombinant protein',
    'recombinant proteins': 'Chemical, peptide, or recombinant protein',
    'software': 'Code/Software',
    'software/code': 'Code/Software',
    'code/software': 'Code/Software',
    'code': 'Code/Software',
    'viral vector': 'Viral vector',
    'viral vectors': 'Viral vector'
  };

  return mappings[normalized] || null;
}

/**
 * Validate RESOURCE TYPE field
 * @param {string} value - The resource type value
 * @param {string} rowId - Row UUID for error reporting
 * @param {string[]} resourceTypes - Valid resource types from database
 */
function validateResourceType(value, rowId, resourceTypes) {
  const errors = [];

  if (!value || value.trim() === '') {
    errors.push({
      rowId,
      columnName: 'RESOURCE TYPE',
      errorType: 'required',
      errorMessage: 'Resource type is required',
      severity: VALIDATION_SEVERITY.ERROR,
      suggestion: `Select one of: ${resourceTypes.slice(0, 3).join(', ')}...`
    });
  } else if (isNAVariation(value)) {
    errors.push({
      rowId,
      columnName: 'RESOURCE TYPE',
      errorType: 'required',
      errorMessage: 'Resource type is required (N/A is not allowed)',
      severity: VALIDATION_SEVERITY.ERROR,
      suggestion: `Select one of: ${resourceTypes.slice(0, 3).join(', ')}...`
    });
  } else if (resourceTypes.includes(value)) {
    // Exact match - no error
  } else {
    // Try case-insensitive exact match first
    const caseMatch = resourceTypes.find(t => t.toLowerCase() === value.trim().toLowerCase());

    if (caseMatch) {
      errors.push({
        rowId,
        columnName: 'RESOURCE TYPE',
        errorType: 'invalid_value',
        errorMessage: `Invalid resource type: "${value}"`,
        severity: VALIDATION_SEVERITY.ERROR,
        suggestion: `Use "${caseMatch}" instead`
      });
    } else {
    // Try to normalize the resource type (plurals, synonyms)
    const normalizedType = normalizeResourceType(value);

    if (normalizedType && resourceTypes.includes(normalizedType)) {
      errors.push({
        rowId,
        columnName: 'RESOURCE TYPE',
        errorType: 'invalid_value',
        errorMessage: `Invalid resource type: "${value}"`,
        severity: VALIDATION_SEVERITY.ERROR,
        suggestion: `Use "${normalizedType}" instead`
      });
    } else {
      // Try to find closest match
      const suggestion = findClosestMatch(value, resourceTypes);
      errors.push({
        rowId,
        columnName: 'RESOURCE TYPE',
        errorType: 'invalid_value',
        errorMessage: `Unrecognized resource type: "${value}"`,
        severity: VALIDATION_SEVERITY.ERROR,
        suggestion: suggestion ? `Did you mean "${suggestion}"?` : `Valid types: ${resourceTypes.join(', ')}`
      });
    }
    }
  }

  return errors;
}

/**
 * Check if a value is a variation of N/A
 */
function isNAVariation(value) {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return ['n/a', 'na', 'n.a.', 'n.a', 'not available', 'not applicable', 'none', '-', '--'].includes(v);
}

/**
 * Validate RESOURCE NAME field
 */
function validateResourceName(value, rowId) {
  const errors = [];

  if (!value || value.trim() === '') {
    errors.push({
      rowId,
      columnName: 'RESOURCE NAME',
      errorType: 'required',
      errorMessage: 'Resource name is required',
      severity: VALIDATION_SEVERITY.ERROR
    });
  } else if (isNAVariation(value)) {
    errors.push({
      rowId,
      columnName: 'RESOURCE NAME',
      errorType: 'na_not_allowed',
      errorMessage: `"${value.trim()}" is not allowed as a resource name`,
      severity: VALIDATION_SEVERITY.ERROR,
      suggestion: 'Provide an actual resource name'
    });
  } else if (value.length > 500) {
    errors.push({
      rowId,
      columnName: 'RESOURCE NAME',
      errorType: 'max_length',
      errorMessage: 'Resource name exceeds maximum length of 500 characters',
      severity: VALIDATION_SEVERITY.WARNING,
      suggestion: 'Consider shortening the name'
    });
  }

  return errors;
}

/**
 * Validate SOURCE field
 */
function validateSource(value, rowId) {
  const errors = [];

  if (!value || value.trim() === '') {
    errors.push({
      rowId,
      columnName: 'SOURCE',
      errorType: 'required',
      errorMessage: 'Source is required',
      severity: VALIDATION_SEVERITY.ERROR,
      suggestion: 'Examples: Zenodo, GitHub, AddGene, ATCC'
    });
  }

  return errors;
}

/**
 * Validate IDENTIFIER field and extract identifiers
 */
async function validateIdentifier(row, submissionId) {
  const errors = [];
  const identifierValue = row.identifier || '';
  const additionalInfo = row.additionalInformation || '';

  // Check if identifier is "No identifier exists" or "Identifier pending" (accepted non-identifier values)
  const trimmedLower = identifierValue.trim().toLowerCase();
  const isNoIdentifier = trimmedLower === 'no identifier exists';
  const isIdentifierPending = trimmedLower === 'identifier pending';

  if (isNoIdentifier) {
    row.parsedIdentifiers = { noIdentifier: true };
    await row.save();
    return errors;
  }

  if (isIdentifierPending) {
    row.parsedIdentifiers = { identifierPending: true };
    await row.save();
    return errors;
  }

  // Reject N/A variations — they are not allowed
  if (isNAVariation(identifierValue)) {
    errors.push({
      rowId: row.id,
      columnName: 'IDENTIFIER',
      errorType: 'na_not_allowed',
      errorMessage: `"${identifierValue.trim()}" is not allowed as an identifier`,
      severity: VALIDATION_SEVERITY.ERROR,
      suggestion: 'Provide a DOI, RRID, URL, catalog number, "No identifier exists" or "Identifier pending"'
    });
    return errors;
  }

  // Extract identifiers from both columns
  const identifierExtracted = identifierExtractor.extractAll(identifierValue);
  const additionalExtracted = identifierExtractor.extractAll(additionalInfo);

  // Check if we have any valid identifier in either column
  const hasValidId = (
    identifierExtracted.doi || identifierExtracted.rrid || identifierExtracted.scr ||
    identifierExtracted.emdb || identifierExtracted.pdb || identifierExtracted.empiar ||
    identifierExtracted.cellosaurus || identifierExtracted.addgene ||
    identifierExtracted.url || identifierExtracted.catalogNumber ||
    additionalExtracted.doi || additionalExtracted.rrid || additionalExtracted.scr ||
    additionalExtracted.emdb || additionalExtracted.pdb || additionalExtracted.empiar ||
    additionalExtracted.cellosaurus || additionalExtracted.addgene || additionalExtracted.url
  );

  if (!identifierValue || identifierValue.trim() === '') {
    // If identifier column is empty but we found one in additional info, just warn
    if (hasValidId) {
      errors.push({
        rowId: row.id,
        columnName: 'IDENTIFIER',
        errorType: 'missing_but_found',
        errorMessage: 'Identifier column is empty but identifier found in Additional Information',
        severity: VALIDATION_SEVERITY.WARNING,
        suggestion: 'Consider moving the identifier to the IDENTIFIER column'
      });
    } else {
      errors.push({
        rowId: row.id,
        columnName: 'IDENTIFIER',
        errorType: 'required',
        errorMessage: 'Identifier is required',
        severity: VALIDATION_SEVERITY.ERROR,
        suggestion: 'Provide a DOI, RRID, URL, catalog number, "No identifier exists" or "Identifier pending"'
      });
    }
  } else if (!hasValidId) {
    // Identifier column has value but no recognized identifier format
    errors.push({
      rowId: row.id,
      columnName: 'IDENTIFIER',
      errorType: 'invalid_format',
      errorMessage: 'Identifier not recognized',
      severity: VALIDATION_SEVERITY.WARNING,
      suggestion: 'Include a DOI (10.xxxx/...), RRID (RRID:...), SCR code, URL, "No identifier exists" or "Identifier pending"'
    });
  }

  // Merge extracted identifiers (prefer identifier column, fallback to additional info)
  const mergedExtracted = {};
  for (const key of Object.keys(identifierExtracted)) {
    mergedExtracted[key] = identifierExtracted[key] || additionalExtracted[key];
  }

  // Update the row with parsed identifiers
  row.parsedIdentifiers = mergedExtracted;
  await row.save();

  return errors;
}

/**
 * Validate NEW/REUSE field
 * This field is required and must be "new" or "reuse"
 */
function validateNewReuse(value, rowId) {
  const errors = [];

  if (!value || value.trim() === '') {
    errors.push({
      rowId,
      columnName: 'NEW/REUSE',
      errorType: 'required',
      errorMessage: 'NEW/REUSE is required',
      severity: VALIDATION_SEVERITY.ERROR,
      suggestion: 'Must be "new" or "reuse"'
    });
  } else if (isNAVariation(value)) {
    errors.push({
      rowId,
      columnName: 'NEW/REUSE',
      errorType: 'na_not_allowed',
      errorMessage: `"${value.trim()}" is not allowed`,
      severity: VALIDATION_SEVERITY.ERROR,
      suggestion: 'Must be "new" or "reuse"'
    });
  } else {
    const normalized = value.toLowerCase().trim();
    if (!['new', 'reuse'].includes(normalized)) {
      errors.push({
        rowId,
        columnName: 'NEW/REUSE',
        errorType: 'invalid_value',
        errorMessage: `Invalid value: "${value}"`,
        severity: VALIDATION_SEVERITY.ERROR,
        suggestion: 'Must be "new" or "reuse"'
      });
    }
  }

  return errors;
}

/**
 * Find closest matching string using Levenshtein distance
 */
function findClosestMatch(input, candidates) {
  let closest = null;
  let minDistance = Infinity;

  const inputLower = input.toLowerCase();

  for (const candidate of candidates) {
    const candidateLower = candidate.toLowerCase();
    const distance = levenshteinDistance(inputLower, candidateLower);

    if (distance < minDistance && distance <= 3) {
      minDistance = distance;
      closest = candidate;
    }
  }

  return closest;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(s1, s2) {
  const m = s1.length;
  const n = s2.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[m][n];
}

module.exports = {
  validateSubmission,
  validateRow,
  validateResourceType,
  validateResourceName,
  validateSource,
  validateIdentifier,
  validateNewReuse,
  refreshResourceTypesCache
};
