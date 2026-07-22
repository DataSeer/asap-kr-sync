/**
 * KRT Validator Service
 * Validates KRT data against defined rules
 */

const { ValidationResult, KRTData } = require('../../models');
const { getResourceTypes, getValidationRules, VALIDATION_SEVERITY } = require('../../config/constants');
const identifierExtractor = require('./identifier-extractor');

// ── Per-resource-type identifier validation ───────────────────────────────
//
// Map kinds (from identifier-extractor) → resource types where they're
// considered valid. '*' means "valid for any resource type". These are
// proposed defaults — ASAP can refine the allowed list per type without
// changing the validator structure.
const TYPE_ANTIBODY = 'Antibody';
const TYPE_BACTERIAL = 'Bacterial strain';
const TYPE_VIRAL = 'Viral vector';
const TYPE_BIO_SAMPLE = 'Biological sample';
const TYPE_CHEM = 'Chemical, peptide, or recombinant protein';
const TYPE_CCA = 'Critical commercial assay';
const TYPE_CELL_LINE = 'Experimental model: Cell line';
const TYPE_ORGANISM = 'Experimental model: Organism/strain';
const TYPE_OLIGO = 'Oligonucleotide';
const TYPE_RECOMB_DNA = 'Recombinant DNA';
const TYPE_DATASET = 'Dataset';
const TYPE_SOFTWARE = 'Software/code';
const TYPE_PROTOCOL = 'Protocol';
const TYPE_OTHER = 'Other';

const IDENTIFIER_KIND_ALLOWED_TYPES = {
  // Universal — DOIs and URLs are accepted for everything.
  doi: '*',
  url: '*',
  // RRIDs are the strict identifier for most lab materials + software.
  // TYPE_OTHER covers Tools / Instruments, which authors identify with RRIDs.
  rrid: [
    TYPE_ANTIBODY, TYPE_BACTERIAL, TYPE_VIRAL, TYPE_CHEM, TYPE_CCA,
    TYPE_CELL_LINE, TYPE_ORGANISM, TYPE_RECOMB_DNA, TYPE_SOFTWARE, TYPE_OTHER
  ],
  // SCR codes identify software and tools/instruments (mapped to "Other").
  scr:                 [TYPE_SOFTWARE, TYPE_OTHER],
  cellosaurus:         [TYPE_CELL_LINE],
  addgene:             [TYPE_RECOMB_DNA],
  emdb:                [TYPE_DATASET],
  pdb:                 [TYPE_DATASET],
  empiar:              [TYPE_DATASET],
  genbank:             [TYPE_DATASET, TYPE_OLIGO],
  uniprot:             [TYPE_DATASET, TYPE_CHEM],
  pmid:                [TYPE_PROTOCOL],
  // CAS Registry Numbers identify chemicals.
  cas:                 [TYPE_CHEM],
  // Repository accessions (PXD, GSE, …) are never accepted on their own — an
  // empty allowed list means the validator always advises sharing a DOI/URL.
  accession:           [],
  // Catalog numbers are lenient for purchaseable lab materials.
  catalogNumber: [
    TYPE_ANTIBODY, TYPE_BACTERIAL, TYPE_VIRAL, TYPE_BIO_SAMPLE, TYPE_CHEM,
    TYPE_CCA, TYPE_CELL_LINE, TYPE_ORGANISM, TYPE_RECOMB_DNA, TYPE_OTHER
  ],
  // New kinds (#10 + #8 from ASAP team request).
  oligoSequence:       [TYPE_OLIGO],
  biostudiesAccession: [TYPE_DATASET, TYPE_BIO_SAMPLE]
};

// Human labels for warning messages.
const IDENTIFIER_KIND_LABELS = {
  doi: 'DOI', rrid: 'RRID', scr: 'SCR code', url: 'URL',
  cas: 'CAS number', accession: 'Repository accession',
  cellosaurus: 'Cellosaurus ID', addgene: 'Addgene ID',
  emdb: 'EMDB ID', pdb: 'PDB ID', empiar: 'EMPIAR ID',
  genbank: 'GenBank accession', uniprot: 'UniProt ID', pmid: 'PMID',
  catalogNumber: 'Catalog number', oligoSequence: 'Oligonucleotide sequence',
  biostudiesAccession: 'BioStudies accession'
};

function isKindAllowedFor(kind, resourceType) {
  const rule = IDENTIFIER_KIND_ALLOWED_TYPES[kind];
  if (!rule) return false;
  if (rule === '*') return true;
  return rule.includes(resourceType);
}

function getDetectedKinds(extracted) {
  return Object.entries(extracted)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k]) => k);
}

/** True when the (possibly-synonym) resource type resolves to Chemical. */
function isChemicalType(resourceType) {
  return resourceType === TYPE_CHEM || normalizeResourceType(resourceType) === TYPE_CHEM;
}

/**
 * Per-resource-type lenient identifier rule for Chemicals (ASAP request):
 * vendor catalog codes for chemicals often don't fit the generic catalog-number
 * rule (which needs ≥4 digits) — e.g. letters-only or letters+few-digits codes
 * like "ab290", or a CAS-style value. For the Chemical type we accept any
 * compact single-token code (optionally prefixed with a "Cat#" label) rather
 * than flagging it as unrecognized.
 */
function looksLikeChemicalCatalog(value) {
  let v = (value || '').trim();
  // Drop a leading catalog label: "Cat#", "Cat. No.", "Catalog #", "Cat no:", …
  v = v.replace(/^cat(?:alog)?\.?\s*(?:no\.?|number)?\s*[#:]?\s*/i, '').trim();
  if (!v || v.length > 40) return false;
  // A single compact code token — letters/digits + common catalog punctuation,
  // no whitespace (so prose and multi-word values are still flagged).
  return /^[A-Za-z0-9][A-Za-z0-9._#/-]*$/.test(v);
}

/**
 * Pick the single identifier value to surface as a Quick Fix suggestion
 * when ADDITIONAL INFORMATION contains a recognized identifier but the
 * IDENTIFIER column is empty. Priority follows specificity: RRID and
 * Cellosaurus/PDB-style references first, then DOIs, then URLs, then bare
 * accession/catalog numbers.
 *
 * Only kinds allowed for the row's resource type are considered, so we
 * don't suggest copying e.g. a PMID into an Antibody row that wouldn't
 * accept it.
 */
const QUICK_FIX_PRIORITY = [
  'rrid', 'scr', 'cellosaurus', 'addgene',
  'emdb', 'pdb', 'empiar', 'biostudiesAccession',
  'doi', 'pmid', 'genbank', 'uniprot',
  'url', 'catalogNumber', 'oligoSequence'
];
function pickBestExtractedValue(extracted, resourceType) {
  for (const kind of QUICK_FIX_PRIORITY) {
    const value = extracted[kind];
    if (!value) continue;
    if (!isKindAllowedFor(kind, resourceType)) continue;
    return value;
  }
  return null;
}

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
  const sourceErrors = validateSource(row.source, row.id, { resourceType: row.resourceType, identifier: row.identifier });
  errors.push(...sourceErrors);

  // Validate IDENTIFIER
  const identifierErrors = await validateIdentifier(row, submissionId);
  errors.push(...identifierErrors);

  // Cross-field: protocols.io protocols must carry a DOI/URL (#2)
  errors.push(...validateProtocolsIoIdentifier(row.source, row.identifier, row.id));

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
    'biological reagent': 'Chemical, peptide, or recombinant protein',
    'biological reagents': 'Chemical, peptide, or recombinant protein',
    'peptide': 'Chemical, peptide, or recombinant protein',
    'peptides': 'Chemical, peptide, or recombinant protein',
    'critical commercial assay': 'Critical commercial assay',
    'critical commercial assays': 'Critical commercial assay',
    'commercial assay or kit': 'Critical commercial assay',
    'commercial assay': 'Critical commercial assay',
    'assay or kit': 'Critical commercial assay',
    'assay kit': 'Critical commercial assay',
    'kit': 'Critical commercial assay',
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
    'software': 'Software/code',
    'software/code': 'Software/code',
    'code/software': 'Software/code',
    'code': 'Software/code',
    'viral vector': 'Viral vector',
    'viral vectors': 'Viral vector',
    // Author KRT variants seen in practice that differ from our controlled
    // vocabulary (request E). Organism/strain and viral-vector aliases.
    'mouse strain': 'Experimental model: Organism/strain',
    'mouse strains': 'Experimental model: Organism/strain',
    'mouse line': 'Experimental model: Organism/strain',
    'mouse lines': 'Experimental model: Organism/strain',
    'rat strain': 'Experimental model: Organism/strain',
    'rat strains': 'Experimental model: Organism/strain',
    'animal strain': 'Experimental model: Organism/strain',
    'organism': 'Experimental model: Organism/strain',
    'organism/strain': 'Experimental model: Organism/strain',
    'strain': 'Experimental model: Organism/strain',
    'cell line': 'Experimental model: Cell line',
    'cell lines': 'Experimental model: Cell line',
    'virus strain': 'Viral vector',
    'virus strains': 'Viral vector',
    'virus': 'Viral vector',
    'plasmid': 'Recombinant DNA',
    'plasmids': 'Recombinant DNA',
    'bacteria': 'Bacterial strain',
    // "Genetic reagent (Mus musculus)" and similar author labels denote an
    // organism/strain in the ASAP KRTs reviewed.
    'genetic reagent': 'Experimental model: Organism/strain',
    'genetic reagent (mus musculus)': 'Experimental model: Organism/strain',
    // Tools / Instruments / generic "Resource" have no dedicated canonical type;
    // they map to "Other" (the UI's catch-all for tools and instruments).
    'instrument': 'Other',
    'instruments': 'Other',
    'resource': 'Other',
    'resources': 'Other',
    'tool': 'Other',
    'tools': 'Other'
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
        suggestion: `Use "${caseMatch}" instead`,
        // Machine-actionable fields (request E): the frontend offers a one-click
        // fix and groups equal (columnName, suggestedValue) pairs into a bulk
        // action ("set N rows to <type>"). autoFixable ⇒ high-confidence mapping.
        suggestedValue: caseMatch,
        autoFixable: true
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
        suggestion: `Use "${normalizedType}" instead`,
        suggestedValue: normalizedType,
        autoFixable: true
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
/** A Software/code resource type (the only type the Source-optional rule covers). */
function isSoftwareType(resourceType) {
  const rt = (resourceType || '').toLowerCase();
  return rt.includes('software') || rt.includes('code');
}

/**
 * Accepted "no identifier to give" phrases. Besides the two canonical escape
 * hatches, authors of Software rows often write "no RRID available" (an RRID is
 * the expected identifier for software), which expresses the same intent and is
 * accepted rather than flagged.
 */
function isNoIdentifierPhrase(value) {
  const v = (value || '').trim().toLowerCase().replace(/\.+$/, '');
  return v === 'no identifier exists' ||
         v === 'identifier pending' ||
         v === 'no rrid available' ||
         v === 'no rrid';
}

/**
 * True when the IDENTIFIER cell carries a *real* identifier — i.e. any value
 * that isn't blank, an escape hatch ("No identifier exists" / "Identifier
 * pending" / "No RRID available"), or an N/A variant. Recognized or not, it
 * counts as "provided".
 */
function hasRealIdentifier(identifier) {
  const v = (identifier || '').trim().toLowerCase();
  if (!v) return false;
  if (isNoIdentifierPhrase(v)) return false;
  if (isNAVariation(v)) return false;
  return true;
}

function validateSource(value, rowId, { resourceType = '', identifier = '' } = {}) {
  const errors = [];

  if (!value || value.trim() === '') {
    // Rule: a Software/code row that already carries an identifier (RRID, URL,
    // DOI, …) doesn't need a Source — the identifier already locates it. Emit
    // neither error nor warning so an empty Source never blocks the next step
    // in that case. All other rows still require a Source.
    if (isSoftwareType(resourceType) && hasRealIdentifier(identifier)) {
      return errors;
    }
    errors.push({
      rowId,
      columnName: 'SOURCE',
      errorType: 'required',
      errorMessage: 'Source is required',
      severity: VALIDATION_SEVERITY.ERROR,
      suggestion: 'Source is the repository or vendor name (e.g. Zenodo, GitHub, Addgene, ATCC) — put the DOI/URL in the Identifier column, not here'
    });
  }

  return errors;
}

/**
 * Validate IDENTIFIER field with per-resource-type kind acceptance.
 *
 * The validator detects which identifier kinds (DOI, RRID, catalog number,
 * URL, oligonucleotide sequence, BioStudies accession, etc.) are present in
 * the cell, then checks whether any of those kinds is on the allowed list
 * for the row's RESOURCE TYPE. This replaces the previous "any recognized
 * identifier is valid" rule and matches ASAP's request for per-type strictness.
 *
 * Special cases:
 *   - "No identifier exists" / "Identifier pending" are accepted escape hatches.
 *   - "N/A" variants are still rejected.
 *   - BioStudies accessions (S-BSSTxxx / S-BIADxxx) and their DOI form
 *     (10.6019/S-BSSTxxx) are both accepted as valid — they're two
 *     representations of the same identifier and no DOI-suggestion warning
 *     is emitted.
 */
async function validateIdentifier(row, submissionId) {
  const errors = [];
  const identifierValue = row.identifier || '';
  const additionalInfo = row.additionalInformation || '';
  const resourceType = row.resourceType || '';
  // Rows the curator flagged Optional never require an identifier — an empty or
  // N/A cell is expected, not an issue.
  const isOptional = !!row.isOptional;

  // Accepted escape hatches.
  const trimmedLower = identifierValue.trim().toLowerCase();
  if (trimmedLower === 'identifier pending') {
    row.parsedIdentifiers = { identifierPending: true };
    await row.save();
    return errors;
  }
  if (isNoIdentifierPhrase(identifierValue)) {
    row.parsedIdentifiers = { noIdentifier: true };
    await row.save();
    return errors;
  }

  // Reject N/A variations — they are not allowed (unless the row is Optional).
  if (isNAVariation(identifierValue)) {
    if (isOptional) {
      row.parsedIdentifiers = {};
      await row.save();
      return errors;
    }
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

  // Detect kinds in both columns. Note: BioStudies accessions (S-BSSTxxx /
  // S-BIADxxx) and their DOI form (10.6019/S-BSSTxxx) are BOTH considered
  // valid — they're two representations of the same identifier. The
  // accession is allowed via the `biostudiesAccession` kind in
  // IDENTIFIER_KIND_ALLOWED_TYPES; the DOI form passes through the universal
  // `doi` kind. No warning is emitted: the team explicitly wants either
  // form accepted without nagging.
  const identifierExtracted = identifierExtractor.extractAll(identifierValue);
  const additionalExtracted = identifierExtractor.extractAll(additionalInfo);

  // Required check — empty IDENTIFIER column.
  if (!identifierValue || identifierValue.trim() === '') {
    const additionalKinds = getDetectedKinds(additionalExtracted);
    const allowedInAddl = additionalKinds.some(k => isKindAllowedFor(k, resourceType));
    if (allowedInAddl) {
      // Auto-copy: authors often paste real identifiers (oligonucleotide
      // sequences, RRIDs, DOIs, etc.) into ADDITIONAL INFORMATION because
      // they don't recognize them as "identifiers". When IDENTIFIER is
      // empty and ADDITIONAL INFO has a value of an allowed kind for this
      // resource type, silently move it into IDENTIFIER. We re-extract on
      // the new IDENTIFIER value so the rest of this function sees the
      // post-copy state and doesn't keep complaining.
      const bestValue = pickBestExtractedValue(additionalExtracted, resourceType);
      if (bestValue) {
        row.identifier = bestValue;
        await row.save();
        // Persist parsedIdentifiers consistent with the new value and exit
        // — the next validation cycle (or this caller's outer loop) will
        // re-validate the row against its now-populated IDENTIFIER.
        const reExtracted = identifierExtractor.extractAll(bestValue);
        const merged = {};
        for (const key of Object.keys(reExtracted)) {
          merged[key] = reExtracted[key] || additionalExtracted[key];
        }
        row.parsedIdentifiers = merged;
        await row.save();
        return errors;
      }
      // Fell through — no auto-copyable value despite some additional
      // identifiers existing. Surface as a soft hint.
      errors.push({
        rowId: row.id,
        columnName: 'IDENTIFIER',
        errorType: 'missing_but_found',
        errorMessage: 'Identifier column is empty but identifier found in Additional Information',
        severity: VALIDATION_SEVERITY.WARNING,
        suggestion: 'Move the identifier into the IDENTIFIER column'
      });
    } else if (!isOptional) {
      errors.push({
        rowId: row.id,
        columnName: 'IDENTIFIER',
        errorType: 'required',
        errorMessage: 'Identifier is required',
        severity: VALIDATION_SEVERITY.ERROR,
        suggestion: 'Provide a DOI, RRID, URL, catalog number, "No identifier exists" or "Identifier pending"'
      });
    }
  } else {
    // Identifier present — check which kinds were detected and whether any
    // of them is allowed for the row's resource type.
    const detectedKinds = getDetectedKinds(identifierExtracted);
    const allowedKinds = detectedKinds.filter(k => isKindAllowedFor(k, resourceType));

    if (detectedKinds.length === 0) {
      // Chemicals accept compact vendor catalog codes that the generic rules
      // don't recognize (letters-only, letters+few-digits, CAS-style).
      if (!(isChemicalType(resourceType) && looksLikeChemicalCatalog(identifierValue))) {
        errors.push({
          rowId: row.id,
          columnName: 'IDENTIFIER',
          errorType: 'invalid_format',
          errorMessage: 'Identifier not recognized by the app',
          severity: VALIDATION_SEVERITY.WARNING,
          suggestion: 'Include a DOI (10.xxxx/...), RRID (RRID:...), SCR code, URL, "No identifier exists" or "Identifier pending"'
        });
      }
    } else if (allowedKinds.length === 0) {
      // Kind detected, but not on the allowed list for this resource type.
      const detectedLabel = detectedKinds.map(k => IDENTIFIER_KIND_LABELS[k] || k).join(', ');
      const isAccession = detectedKinds.includes('accession');
      errors.push({
        rowId: row.id,
        columnName: 'IDENTIFIER',
        // Repository accessions (PXD, GSE, …) get their own advisory message:
        // they aren't persistent identifiers on their own, so we ask the author
        // to share the DOI or URL of the record instead of just flagging.
        errorType: isAccession ? 'accession_not_persistent' : 'kind_not_accepted_for_type',
        errorMessage: isAccession
          ? 'Repository accession is not accepted as an identifier on its own'
          : (resourceType
            ? `${detectedLabel} is not a typical identifier for "${resourceType}"`
            : `${detectedLabel} detected, but RESOURCE TYPE is missing`),
        severity: VALIDATION_SEVERITY.WARNING,
        suggestion: isAccession
          ? 'Share the DOI or URL of the repository record (e.g. the dataset landing page) instead of the bare accession'
          : 'Use a DOI, RRID, URL, or other identifier accepted for this resource type'
      });
    }
    // else: at least one detected kind is allowed — silent pass.
  }

  // Merge & persist parsedIdentifiers (prefer IDENTIFIER column, fall back to
  // ADDITIONAL INFORMATION). Downstream code (e.g. report generation) reads
  // these to surface "extra info we found about this resource".
  const mergedExtracted = {};
  for (const key of Object.keys(identifierExtracted)) {
    mergedExtracted[key] = identifierExtracted[key] || additionalExtracted[key];
  }
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

// ── Pure, DB-free validation core (for offline tooling / scripts) ───────────
// The canonical KRT resource types the validator is built around. At runtime
// the app loads types from the DB (config service); this mirrors the seeded set
// so an offline caller (e.g. scripts/check-krt.js) can validate without a DB.
const DEFAULT_RESOURCE_TYPES = [
  TYPE_ANTIBODY, TYPE_BACTERIAL, TYPE_VIRAL, TYPE_BIO_SAMPLE, TYPE_CHEM, TYPE_CCA,
  TYPE_CELL_LINE, TYPE_ORGANISM, TYPE_OLIGO, TYPE_RECOMB_DNA, TYPE_DATASET,
  TYPE_SOFTWARE, TYPE_PROTOCOL, TYPE_OTHER
];

/**
 * Pure IDENTIFIER validation — the same error branches as validateIdentifier
 * but on plain values, with no DB access and no row mutation (so no auto-copy;
 * the empty-but-found case is surfaced as a warning instead). Reuses the same
 * kind-extraction + allowed-per-type helpers as the DB path.
 * @returns {Array} error objects (without rowId)
 */
function validateIdentifierValues({ identifier = '', additionalInformation = '', resourceType = '', isOptional = false } = {}) {
  const errors = [];
  const idVal = String(identifier || '');
  if (isNoIdentifierPhrase(idVal)) return errors;

  if (isNAVariation(idVal)) {
    if (isOptional) return errors;
    errors.push({ columnName: 'IDENTIFIER', errorType: 'na_not_allowed', errorMessage: `"${idVal.trim()}" is not allowed as an identifier`, severity: VALIDATION_SEVERITY.ERROR, suggestion: 'Provide a DOI, RRID, URL, catalog number, "No identifier exists" or "Identifier pending"' });
    return errors;
  }

  const identifierExtracted = identifierExtractor.extractAll(idVal);
  const additionalExtracted = identifierExtractor.extractAll(String(additionalInformation || ''));

  if (!idVal.trim()) {
    const allowedInAddl = getDetectedKinds(additionalExtracted).some(k => isKindAllowedFor(k, resourceType));
    if (allowedInAddl) {
      errors.push({ columnName: 'IDENTIFIER', errorType: 'missing_but_found', errorMessage: 'Identifier column is empty but identifier found in Additional Information', severity: VALIDATION_SEVERITY.WARNING, suggestion: 'Move the identifier into the IDENTIFIER column' });
    } else if (!isOptional) {
      errors.push({ columnName: 'IDENTIFIER', errorType: 'required', errorMessage: 'Identifier is required', severity: VALIDATION_SEVERITY.ERROR, suggestion: 'Provide a DOI, RRID, URL, catalog number, "No identifier exists" or "Identifier pending"' });
    }
  } else {
    const detectedKinds = getDetectedKinds(identifierExtracted);
    const allowedKinds = detectedKinds.filter(k => isKindAllowedFor(k, resourceType));
    if (detectedKinds.length === 0) {
      if (!(isChemicalType(resourceType) && looksLikeChemicalCatalog(idVal))) {
        errors.push({ columnName: 'IDENTIFIER', errorType: 'invalid_format', errorMessage: 'Identifier not recognized by the app', severity: VALIDATION_SEVERITY.WARNING, suggestion: 'Include a DOI (10.xxxx/...), RRID (RRID:...), SCR code, URL, "No identifier exists" or "Identifier pending"' });
      }
    } else if (allowedKinds.length === 0) {
      const detectedLabel = detectedKinds.map(k => IDENTIFIER_KIND_LABELS[k] || k).join(', ');
      const isAccession = detectedKinds.includes('accession');
      errors.push({ columnName: 'IDENTIFIER', errorType: isAccession ? 'accession_not_persistent' : 'kind_not_accepted_for_type', errorMessage: isAccession ? 'Repository accession is not accepted as an identifier on its own' : (resourceType ? `${detectedLabel} is not a typical identifier for "${resourceType}"` : `${detectedLabel} detected, but RESOURCE TYPE is missing`), severity: VALIDATION_SEVERITY.WARNING, suggestion: isAccession ? 'Share the DOI or URL of the repository record (e.g. the dataset landing page) instead of the bare accession' : 'Use a DOI, RRID, URL, or other identifier accepted for this resource type' });
    }
  }
  return errors;
}

/**
 * Validate one KRT row from plain values (no DB). Runs the same field checks as
 * validateRow — resource type / name / source / identifier / new-reuse — and
 * returns the combined error list. Used by offline tooling to diagnose KRT
 * files before they are uploaded.
 * @param {object} values - { resourceType, resourceName, source, identifier, newReuse, additionalInformation, rowId? }
 * @param {string[]} [resourceTypes] - allowed types (defaults to DEFAULT_RESOURCE_TYPES)
 * @returns {Array} error objects, each with rowId
 */
function validateRowValues(values = {}, resourceTypes = DEFAULT_RESOURCE_TYPES) {
  const types = (Array.isArray(resourceTypes) && resourceTypes.length) ? resourceTypes : DEFAULT_RESOURCE_TYPES;
  const rowId = values.rowId ?? null;
  const errors = [];
  errors.push(...validateResourceType(values.resourceType, rowId, types));
  errors.push(...validateResourceName(values.resourceName, rowId));
  errors.push(...validateSource(values.source, rowId, { resourceType: values.resourceType, identifier: values.identifier }));
  errors.push(...validateIdentifierValues({
    identifier: values.identifier, additionalInformation: values.additionalInformation, resourceType: values.resourceType, isOptional: values.isOptional
  }).map(e => ({ rowId, ...e })));
  errors.push(...validateProtocolsIoIdentifier(values.source, values.identifier, rowId));
  errors.push(...validateNewReuse(values.newReuse, rowId));
  return errors;
}

/**
 * protocols.io rule (#2): when SOURCE points to protocols.io, the identifier
 * must be a DOI or URL — not free text. This targets the case where an author
 * replaces the protocol hyperlink with plain text, which used to pass silently.
 *
 * Only fires on a concrete, non-DOI/URL value. Empty identifiers and the
 * accepted escape-hatch phrases ("Identifier pending" / "No identifier exists")
 * are left to the standard identifier rules so we don't double-flag.
 *
 * @param {string} source
 * @param {string} identifier
 * @param {string|null} rowId
 * @returns {Array} error objects (0 or 1)
 */
function validateProtocolsIoIdentifier(source, identifier, rowId = null) {
  if (!String(source || '').toLowerCase().includes('protocols.io')) return [];

  const value = String(identifier || '').trim();
  if (!value) return []; // empty -> handled by the required-identifier rule
  if (isNoIdentifierPhrase(value) || isNAVariation(value)) return [];

  const hasDoiOrUrl = !!identifierExtractor.extractDOI(value) || !!identifierExtractor.extractURL(value);
  if (hasDoiOrUrl) return [];

  return [{
    rowId,
    columnName: 'IDENTIFIER',
    errorType: 'protocols_io_requires_doi_url',
    errorMessage: 'protocols.io protocols require a DOI or URL identifier',
    severity: VALIDATION_SEVERITY.ERROR,
    suggestion: 'Add the protocols.io DOI (e.g. 10.17504/...) or the full protocol URL'
  }];
}

/**
 * Validate an array of KRT rows without a submission (stateless, no DB writes).
 *
 * Backs the standalone KRT-validation page: the caller holds every row
 * client-side and nothing is persisted. Resource types come from the same DB
 * source/cache the submission flow uses (loadResourceTypes), so results match
 * the real editor. Output shape mirrors krt.controller.getData exactly, so the
 * frontend can consume it with no translation.
 *
 * @param {Array<object>} rows - rows keyed by the uppercase KRT columns plus
 *   `id` (and optional `isOptional`)
 * @returns {Promise<{validationErrors: object, totalErrors: number, totalWarnings: number}>}
 */
async function validateKrtRows(rows = []) {
  const resourceTypes = await loadResourceTypes();
  const validationErrors = {};
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const row of rows) {
    const issues = validateRowValues({
      rowId: row.id,
      resourceType: row['RESOURCE TYPE'],
      resourceName: row['RESOURCE NAME'],
      source: row['SOURCE'],
      identifier: row['IDENTIFIER'],
      newReuse: row['NEW/REUSE'],
      additionalInformation: row['ADDITIONAL INFORMATION'],
      isOptional: row.isOptional || false
    }, resourceTypes);

    if (issues.length > 0) {
      validationErrors[row.id] = issues.map(issue => ({
        column: issue.columnName,
        type: issue.errorType,
        message: issue.errorMessage,
        severity: issue.severity,
        suggestion: issue.suggestion,
        suggestedValue: issue.suggestedValue || null,
        autoFixable: !!issue.suggestedValue
      }));
      totalErrors += issues.filter(i => i.severity === 'error').length;
      totalWarnings += issues.filter(i => i.severity === 'warning').length;
    }
  }

  return { validationErrors, totalErrors, totalWarnings };
}

module.exports = {
  validateSubmission,
  validateRow,
  validateResourceType,
  normalizeResourceType,
  validateResourceName,
  validateSource,
  validateIdentifier,
  validateNewReuse,
  refreshResourceTypesCache,
  // Pure, DB-free core for offline tooling (scripts/check-krt.js)
  validateRowValues,
  validateIdentifierValues,
  // Stateless multi-row validation for the standalone validation page
  validateKrtRows,
  DEFAULT_RESOURCE_TYPES
};
