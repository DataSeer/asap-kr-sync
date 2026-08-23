/**
 * Every service source file, for the tests that check a rule structurally.
 *
 * Several properties in this codebase are about the SHAPE of the source, not
 * about behaviour: "no service creates its own job row", "no service stores a
 * result without the cancel guard", "every prompt loader offers the run's own
 * template". None of them can be caught by exercising one service, because the
 * failure is always a service that was never written yet — and a behavioural
 * test per service passes happily while a new one reintroduces the bug.
 *
 * Three test files had grown their own copy of this walk. One copy that drifts
 * is how a rule quietly stops covering half the tree.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SERVICES_DIR = path.join(__dirname, '..', 'services');

/**
 * Every non-test `.js` under `services/`, recursively.
 *
 * @param {string} [dir]
 * @param {string[]} [acc]
 * @returns {string[]} absolute paths
 */
function serviceFiles(dir = SERVICES_DIR, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) serviceFiles(full, acc);
    else if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) acc.push(full);
  }
  return acc;
}

/** A service path as a rule would name it in a failure message. */
const rel = (file) => path.relative(SERVICES_DIR, file);

/** Read one, for a rule that matches on content. */
const read = (file) => fs.readFileSync(file, 'utf8');

/**
 * Services whose source matches, named relative to `services/`.
 *
 * @param {RegExp} pattern
 * @param {object} [opts]
 * @param {string[]} [opts.except] - relative paths allowed to match
 * @returns {string[]}
 */
function servicesMatching(pattern, { except = [] } = {}) {
  const allowed = new Set(except);
  return serviceFiles()
    .map((file) => ({ file, name: rel(file) }))
    .filter(({ name }) => !allowed.has(name))
    .filter(({ file }) => pattern.test(read(file)))
    .map(({ name }) => name);
}

module.exports = { serviceFiles, servicesMatching, rel, read, SERVICES_DIR };
