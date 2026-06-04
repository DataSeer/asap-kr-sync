/**
 * Tests for helpers.
 * Run with: node --test src/backend/utils/helpers.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildReportFilename } = require('./helpers');

test('buildReportFilename: uses manuscript ID, preserving hyphens', () => {
  assert.equal(buildReportFilename('WH1-000282-012-org-t-2', 'paper.pdf'), 'WH1-000282-012-org-t-2.xlsx');
});

test('buildReportFilename: falls back to PDF filename (sans extension) when no manuscript ID', () => {
  assert.equal(buildReportFilename(null, 'My Manuscript.pdf'), 'My_Manuscript.xlsx');
  assert.equal(buildReportFilename('', 'final.v2.pdf'), 'final.v2.xlsx');
});

test('buildReportFilename: final fallback to "report"', () => {
  assert.equal(buildReportFilename(null, null), 'report.xlsx');
  assert.equal(buildReportFilename('   ', ''), 'report.xlsx');
});

test('buildReportFilename: strips unsafe characters', () => {
  assert.equal(buildReportFilename('a/b\\c:"*?<>|', null), 'abc.xlsx');
  assert.equal(buildReportFilename(null, 'weird name*?.pdf'), 'weird_name.xlsx');
});

test('buildReportFilename: custom extension', () => {
  assert.equal(buildReportFilename('AB1-000-001-org-x-1', null, 'csv'), 'AB1-000-001-org-x-1.csv');
});
