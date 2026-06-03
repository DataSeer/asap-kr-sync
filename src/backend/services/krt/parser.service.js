/**
 * KRT Parser Service
 * Parses CSV, XLSX, and ODS files into normalized KRT data
 */

const Papa = require('papaparse');
const ExcelJS = require('exceljs');
const { ValidationError } = require('../../utils/errors');
const { KRT_COLUMNS } = require('../../config/constants');
const { normalizeColumnName } = require('../../utils/helpers');
const identifierExtractor = require('./identifier-extractor');
const logger = require('../../utils/logger');

/**
 * Parse KRT file based on file type
 * @param {Buffer} buffer - File buffer
 * @param {string} mimeType - MIME type of the file
 * @param {string} fileName - Original file name
 * @returns {Promise<Array>} Parsed rows
 */
async function parseFile(buffer, mimeType, fileName) {
  const extension = fileName.split('.').pop().toLowerCase();

  switch (extension) {
    case 'csv':
      return parseCSV(buffer);
    case 'xlsx':
      return parseExcel(buffer);
    case 'xls':
    case 'ods':
      // Legacy XLS and OpenDocument formats are no longer supported after the
      // xlsx → exceljs migration (exceljs reads .xlsx only). These formats are
      // rare in practice; ask the user to convert to .xlsx in their editor.
      throw new ValidationError(
        `${extension.toUpperCase()} files are no longer supported — please save the file as .xlsx and re-upload.`
      );
    default:
      throw new ValidationError(`Unsupported file format: ${extension}`);
  }
}

/**
 * Parse CSV file.
 *
 * Two-step strategy:
 *  1. First pass uses Papa's auto-detection so users can upload comma /
 *     semicolon / tab / pipe-separated files without configuration.
 *  2. If auto-detection fails (Papa emits an `UndetectableDelimiter` error),
 *     retry once with `delimiter: ','`. Most KRT exports are comma-separated,
 *     so this recovers cleanly without silently ignoring real parse errors.
 *
 * On the final failure we log a small forensic snapshot (size + first bytes
 * as hex) so we can diagnose transport-level corruption when the same file
 * works locally but fails through the dev nginx proxy.
 *
 * @param {Buffer} buffer
 * @returns {Promise<Array>}
 */
async function parseCSV(buffer) {
  const content = buffer.toString('utf-8');

  // Pass 1: auto-detect.
  const first = await runPapaParse(content);
  if (first.ok) return attachHeaders(normalizeRows(first.data), first.fields);

  const triggeredRetry = first.errors.some(e => e.code === 'UndetectableDelimiter');
  if (!triggeredRetry) {
    logCsvFailure(buffer, content, first.errors, 'auto-detect');
    throw new ValidationError(`CSV parsing error: ${formatErrors(first.errors)}`);
  }

  // Pass 2: explicit comma fallback.
  logger.warn('CSV auto-detect failed, retrying with delimiter=","', {
    bufferLength: buffer.length,
    firstErrors: first.errors.slice(0, 3).map(e => e.code || e.message)
  });
  const second = await runPapaParse(content, { delimiter: ',' });
  if (second.ok) return attachHeaders(normalizeRows(second.data), second.fields);

  logCsvFailure(buffer, content, second.errors, 'comma-fallback');
  throw new ValidationError(`CSV parsing error: ${formatErrors(second.errors)}`);
}

/**
 * Attach the actual parsed header names to the rows array as a non-
 * enumerable property. Lets `validateColumns` accept header-only files
 * (zero data rows but a valid header line) without changing the array
 * return shape that downstream code relies on.
 */
function attachHeaders(rows, headers) {
  Object.defineProperty(rows, 'headers', {
    value: Array.isArray(headers) ? headers : [],
    enumerable: false,
    writable: false
  });
  return rows;
}

/**
 * Wrap Papa.parse in a promise. Returns `{ ok, data, errors, fields }` so
 * we can branch on errors without throwing/catching across two attempts.
 * `fields` is the normalized header names from `meta.fields` — needed so
 * `validateColumns` can recognize a header-only CSV (zero data rows but
 * correct headers) as valid.
 */
function runPapaParse(content, extraOptions = {}) {
  return new Promise((resolve) => {
    Papa.parse(content, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => normalizeColumnName(header),
      ...extraOptions,
      complete: (results) => {
        const errors = results.errors || [];
        const fields = (results.meta && Array.isArray(results.meta.fields))
          ? results.meta.fields
          : [];
        resolve({ ok: errors.length === 0, data: results.data, errors, fields });
      },
      error: (error) => {
        resolve({ ok: false, data: [], errors: [{ message: error.message, code: 'ParserError' }], fields: [] });
      }
    });
  });
}

function formatErrors(errors) {
  return errors.map(e => e.message).join(', ');
}

/**
 * Log a forensic snapshot of a failing CSV upload — first 200 bytes as hex,
 * total length, and the detected line ending. Helps explain why the same
 * file parses cleanly locally but fails behind a proxy.
 */
function logCsvFailure(buffer, content, errors, stage) {
  const head = buffer.slice(0, 200);
  const eol = content.includes('\r\n') ? 'CRLF' : (content.includes('\r') ? 'CR' : 'LF');
  logger.warn('CSV parse failed', {
    stage,
    bufferLength: buffer.length,
    firstBytesHex: head.toString('hex'),
    firstBytesAscii: head.toString('utf-8').slice(0, 80),
    lineEnding: eol,
    errors: errors.slice(0, 5).map(e => ({ code: e.code, message: e.message, row: e.row }))
  });
}

/**
 * Parse XLSX file via ExcelJS. Reads the first worksheet, treats row 1 as
 * the header, and emits objects keyed by normalized column name.
 *
 * @param {Buffer} buffer
 * @returns {Promise<Array>}
 */
async function parseExcel(buffer) {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      throw new ValidationError('Excel file contains no worksheets');
    }

    // Header row = first non-empty row
    const headerRow = worksheet.getRow(1);
    const headers = [];
    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      headers[colNumber - 1] = normalizeColumnName(String(cell.value ?? '').trim());
    });

    const data = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return; // skip header
      const obj = {};
      headers.forEach((key, idx) => {
        if (!key) return;
        const cell = row.getCell(idx + 1);
        // Normalize cell value to string (matching xlsx's `raw: false` behavior).
        // Hyperlinks come through as { text, hyperlink } — pick `text`.
        let value = cell.value;
        if (value && typeof value === 'object') {
          if ('text' in value) value = value.text;
          else if ('result' in value) value = value.result; // formula result
          else if (value instanceof Date) value = value.toISOString();
          else value = String(value);
        }
        obj[key] = value == null ? '' : String(value);
      });
      data.push(obj);
    });

    return attachHeaders(normalizeRows(data), headers.filter(Boolean));
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`Excel parsing error: ${error.message}`);
  }
}

/**
 * Normalize rows to standard KRT format
 * @param {Array} rows - Parsed rows
 * @returns {Array} Normalized rows
 */
function normalizeRows(rows) {
  // Map common column name variations to standard names
  const columnMappings = {
    'RESOURCE TYPE': ['RESOURCE TYPE', 'TYPE', 'RESOURCETYPE'],
    'RESOURCE NAME': ['RESOURCE NAME', 'NAME', 'RESOURCENAME'],
    'SOURCE': ['SOURCE', 'PROVIDER', 'REPOSITORY'],
    'IDENTIFIER': ['IDENTIFIER', 'ID', 'DOI', 'RRID', 'URL'],
    'NEW/REUSE': ['NEW/REUSE', 'NEW REUSE', 'NEWREUSE', 'STATUS'],
    'ADDITIONAL INFORMATION': ['ADDITIONAL INFORMATION', 'ADDITIONAL INFO', 'NOTES', 'COMMENTS']
  };

  const normalizedRows = [];

  for (const row of rows) {
    const normalized = {};

    for (const [standard, variations] of Object.entries(columnMappings)) {
      for (const variation of variations) {
        if (row[variation] !== undefined) {
          normalized[standard] = String(row[variation] || '').trim();
          break;
        }
      }
      // Set default empty string if not found
      if (normalized[standard] === undefined) {
        normalized[standard] = '';
      }
    }

    // Skip empty rows (all data columns are empty)
    if (isEmptyRow(normalized)) {
      continue;
    }

    // Preprocess the row
    preprocessRow(normalized);

    normalizedRows.push(normalized);
  }

  return normalizedRows;
}

/**
 * Check if a row is effectively empty (all data columns are empty/whitespace)
 * @param {object} row - Normalized row
 * @returns {boolean}
 */
function isEmptyRow(row) {
  const dataColumns = ['RESOURCE TYPE', 'RESOURCE NAME', 'SOURCE', 'IDENTIFIER', 'ADDITIONAL INFORMATION'];
  return dataColumns.every(col => !row[col] || row[col].trim() === '');
}

/**
 * Preprocess a row to clean up data and extract identifiers
 * @param {object} row - Normalized row (modified in place)
 */
function preprocessRow(row) {
  // Trim all values
  for (const key of Object.keys(row)) {
    if (typeof row[key] === 'string') {
      row[key] = row[key].trim();
    }
  }

  // Try to detect and populate identifier from various sources. Authors
  // frequently paste real identifiers (oligonucleotide sequences, RRIDs,
  // DOIs, BioStudies accessions, etc.) into ADDITIONAL INFORMATION because
  // they don't think of them as "identifiers". When the IDENTIFIER column
  // is empty (or only has a catalog number) and ADDITIONAL INFORMATION has
  // a recognized identifier of any supported kind, we silently move it on
  // ingest so the validator and downstream consumers see the right shape.
  const identifierValue = row['IDENTIFIER'] || '';
  const additionalInfo = row['ADDITIONAL INFORMATION'] || '';

  const identifierExtracted = identifierExtractor.extractAll(identifierValue);
  const hasStrongIdentifier =
    identifierExtracted.doi ||
    identifierExtracted.rrid ||
    identifierExtracted.scr ||
    identifierExtracted.emdb ||
    identifierExtracted.pdb ||
    identifierExtracted.empiar ||
    identifierExtracted.cellosaurus ||
    identifierExtracted.addgene ||
    identifierExtracted.biostudiesAccession ||
    identifierExtracted.oligoSequence ||
    identifierExtracted.pmid ||
    identifierExtracted.genbank ||
    identifierExtracted.uniprot ||
    identifierExtracted.url;

  // Only auto-copy when IDENTIFIER is entirely empty — never overwrite a
  // value the author put there explicitly. Same rule applied at runtime by
  // validator.service.js so upload-time and edit-time behaviours match.
  if (!hasStrongIdentifier && !identifierValue && additionalInfo) {
    const additionalExtracted = identifierExtractor.extractAll(additionalInfo);

    // Priority list — first match wins. Specific repository identifiers
    // first (RRID etc.), then DOIs, then identifier-without-namespace
    // patterns (oligo sequence, biostudies accession), then catch-alls
    // (URL, PMID, GenBank, UniProt). Catalog numbers are intentionally
    // last because they're the most ambiguous.
    const priority = [
      'rrid', 'scr', 'cellosaurus', 'addgene',
      'emdb', 'pdb', 'empiar', 'biostudiesAccession',
      'doi', 'oligoSequence',
      'pmid', 'genbank', 'uniprot', 'url'
    ];
    for (const kind of priority) {
      const value = additionalExtracted[kind];
      if (!value) continue;
      // EMDB + PDB get joined if both present — historical behaviour the
      // downstream consumers (suggestion service) rely on.
      if (kind === 'emdb' && additionalExtracted.pdb) {
        row['IDENTIFIER'] = `${additionalExtracted.emdb} ${additionalExtracted.pdb}`;
      } else {
        row['IDENTIFIER'] = value;
      }
      break;
    }
  }

  // Normalize NEW/REUSE values
  if (row['NEW/REUSE']) {
    const value = row['NEW/REUSE'].toLowerCase().trim();
    if (value === 'new' || value === 'n') {
      row['NEW/REUSE'] = 'new';
    } else if (value === 'reuse' || value === 'r' || value === 'reused') {
      row['NEW/REUSE'] = 'reuse';
    }
  }
}

/**
 * Validate that file has required columns. Inspects the parsed header line
 * (attached as `rows.headers` by the parser) when available — that way a
 * header-only file (zero data rows but the correct header line) is still
 * accepted as a valid empty KRT. Falls back to the first row's keys for
 * older call sites that don't go through the parser.
 *
 * @param {Array} rows - Parsed rows. May carry a non-enumerable `.headers`
 *                       property with the actual parsed header names.
 * @returns {object} { valid: boolean, missingColumns: string[] }
 */
function validateColumns(rows) {
  let presentColumns;
  if (rows && Array.isArray(rows.headers) && rows.headers.length > 0) {
    presentColumns = rows.headers;
  } else if (rows && rows.length > 0) {
    presentColumns = Object.keys(rows[0]);
  } else {
    return { valid: false, missingColumns: KRT_COLUMNS };
  }

  const requiredColumns = KRT_COLUMNS.filter(col => col !== 'ADDITIONAL INFORMATION');
  const missingColumns = requiredColumns.filter(col =>
    !presentColumns.some(present =>
      normalizeColumnName(present) === col ||
      present === col
    )
  );

  return {
    valid: missingColumns.length === 0,
    missingColumns
  };
}

module.exports = {
  parseFile,
  parseCSV,
  parseExcel,
  normalizeRows,
  validateColumns
};
