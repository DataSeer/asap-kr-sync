/**
 * CSV output helpers shared by the list-export controllers.
 *
 * Beyond RFC-4180 quoting, fields that start with a spreadsheet formula
 * trigger (= + - @ tab CR) are prefixed with a single quote so that opening
 * an export in Excel/Sheets cannot execute injected formulas (e.g. a stored
 * `=HYPERLINK(...)` or `=cmd|...` cell) — the lists are imported from
 * arbitrary CSVs, so cell content is not trusted.
 */

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * Escape a value for CSV output, neutralizing spreadsheet formula triggers.
 * @param {*} val - Raw cell value (null/undefined become '')
 * @returns {string} CSV-safe field
 */
function escapeCsvField(val) {
  if (val == null) return '';
  let str = String(val);
  if (FORMULA_TRIGGER.test(str)) {
    str = "'" + str;
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Reverse of the formula guard for import paths: strips one leading quote
 * when (and only when) it precedes a formula trigger, so that exporting and
 * re-importing a list round-trips values like `-80°C` unchanged.
 * @param {*} val
 * @returns {*} The value with the guard removed (non-strings pass through)
 */
function stripCsvFormulaGuard(val) {
  if (typeof val !== 'string') return val;
  if (val.startsWith("'") && FORMULA_TRIGGER.test(val.slice(1))) {
    return val.slice(1);
  }
  return val;
}

module.exports = { escapeCsvField, stripCsvFormulaGuard };
