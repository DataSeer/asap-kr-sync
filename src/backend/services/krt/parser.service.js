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
  if (first.ok) return normalizeRows(first.data);

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
  if (second.ok) return normalizeRows(second.data);

  logCsvFailure(buffer, content, second.errors, 'comma-fallback');
  throw new ValidationError(`CSV parsing error: ${formatErrors(second.errors)}`);
}

/**
 * Wrap Papa.parse in a promise. Returns `{ ok, data, errors }` so we can
 * branch on errors without throwing/catching across two attempts.
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
        resolve({ ok: errors.length === 0, data: results.data, errors });
      },
      error: (error) => {
        resolve({ ok: false, data: [], errors: [{ message: error.message, code: 'ParserError' }] });
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

    return normalizeRows(data);
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

  // Try to detect and populate identifier from various sources
  const identifierValue = row['IDENTIFIER'] || '';
  const additionalInfo = row['ADDITIONAL INFORMATION'] || '';

  // Check if identifier column is empty or only has a catalog number
  const identifierExtracted = identifierExtractor.extractAll(identifierValue);
  const hasStrongIdentifier = identifierExtracted.doi || identifierExtracted.rrid ||
    identifierExtracted.scr || identifierExtracted.emdb || identifierExtracted.pdb ||
    identifierExtracted.empiar || identifierExtracted.cellosaurus || identifierExtracted.url;

  // If no strong identifier in IDENTIFIER column, check ADDITIONAL INFORMATION
  if (!hasStrongIdentifier && additionalInfo) {
    const additionalExtracted = identifierExtractor.extractAll(additionalInfo);

    // Priority: RRID > DOI > SCR > EMDB/PDB > URL > other
    if (additionalExtracted.rrid) {
      // Move RRID to identifier if identifier is empty or just a catalog number
      if (!identifierValue || identifierExtracted.catalogNumber) {
        row['IDENTIFIER'] = additionalExtracted.rrid;
      }
    } else if (additionalExtracted.doi) {
      if (!identifierValue) {
        row['IDENTIFIER'] = additionalExtracted.doi;
      }
    } else if (additionalExtracted.scr) {
      if (!identifierValue) {
        row['IDENTIFIER'] = additionalExtracted.scr;
      }
    } else if (additionalExtracted.emdb || additionalExtracted.pdb) {
      if (!identifierValue) {
        // Combine EMDB and PDB if both present
        const parts = [];
        if (additionalExtracted.emdb) parts.push(additionalExtracted.emdb);
        if (additionalExtracted.pdb) parts.push(additionalExtracted.pdb);
        row['IDENTIFIER'] = parts.join(' ');
      }
    } else if (additionalExtracted.empiar) {
      if (!identifierValue) {
        row['IDENTIFIER'] = additionalExtracted.empiar;
      }
    } else if (additionalExtracted.cellosaurus) {
      if (!identifierValue) {
        row['IDENTIFIER'] = additionalExtracted.cellosaurus;
      }
    } else if (additionalExtracted.url) {
      if (!identifierValue) {
        row['IDENTIFIER'] = additionalExtracted.url;
      }
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
 * Validate that file has required columns
 * @param {Array} rows - Parsed rows
 * @returns {object} { valid: boolean, missingColumns: string[] }
 */
function validateColumns(rows) {
  if (!rows || rows.length === 0) {
    return { valid: false, missingColumns: KRT_COLUMNS };
  }

  const firstRow = rows[0];
  const presentColumns = Object.keys(firstRow);
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
