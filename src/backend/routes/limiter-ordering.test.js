'use strict';

/**
 * On a submission-scoped route, authorisation comes before the budget.
 *
 * The daily limiter IS the access policy for re-runs — an author gets ten
 * complete runs a day, a project manager fifty. Counting a request before
 * checking the caller may touch that submission means a 403 spends one of
 * those runs: the user is refused AND charged, and a wrong id typed twice
 * costs two.
 *
 * Read from the source rather than by mounting the app, because what is being
 * pinned is the ORDER the middleware is declared in — the thing an edit
 * reorders by accident.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROUTES_DIR = __dirname;

/** Every `router.<verb>('<path>', a, b, c, …)` call in a file. */
function routeDeclarations(source) {
  const out = [];
  const re = /router\.(get|post|patch|put|delete)\(\s*'([^']+)'([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const [, verb, routePath, body] = m;
    const middleware = body
      .split(',')
      .map((piece) => piece.replace(/\/\/.*$/gm, '').trim())
      .filter(Boolean);
    out.push({ verb, routePath, middleware });
  }
  return out;
}

test('no submission-scoped route rate-limits before it authorises', () => {
  const offenders = [];

  for (const file of fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.routes.js'))) {
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
    for (const { verb, routePath, middleware } of routeDeclarations(source)) {
      const access = middleware.findIndex((m) => m.includes('canAccessSubmission'));
      if (access === -1) continue;   // not submission-scoped, or staff-only

      const limiter = middleware.findIndex((m) => /Limiter\b/.test(m));
      if (limiter !== -1 && limiter < access) {
        offenders.push(`${file} ${verb.toUpperCase()} ${routePath}`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    'these routes charge the caller before checking they may access the submission');
});

test('the check itself finds the routes it is meant to be checking', () => {
  // A guard that silently matches nothing passes forever. There must be
  // submission-scoped, rate-limited routes for the assertion above to mean
  // anything.
  let guarded = 0;
  for (const file of fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.routes.js'))) {
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
    for (const { middleware } of routeDeclarations(source)) {
      const hasAccess = middleware.some((m) => m.includes('canAccessSubmission'));
      const hasLimiter = middleware.some((m) => /Limiter\b/.test(m));
      if (hasAccess && hasLimiter) guarded++;
    }
  }
  assert.ok(guarded >= 4, `expected several rate-limited submission routes, found ${guarded}`);
});

/**
 * The run endpoints expose a step's full history — every past result, every raw
 * response prefix. That is the same material `canViewJobInternals` already
 * withholds from authors, and the module page's run selector is hidden from
 * them for the same reason. If the gate were dropped here, hiding the selector
 * would be decoration: the data would still be one URL away.
 */
test('the run-history endpoints are gated to the same audience as the other internals', () => {
  const source = fs.readFileSync(path.join(ROUTES_DIR, 'submissions.routes.js'), 'utf8')
  const ungated = []

  for (const { verb, routePath, middleware } of routeDeclarations(source)) {
    if (!/\/runs/.test(routePath)) continue
    const access = middleware.findIndex((m) => m.includes('canAccessSubmission'))
    const internals = middleware.findIndex((m) => m.includes('canViewJobInternals'))
    if (access === -1 || internals === -1 || access > internals) {
      ungated.push(`${verb.toUpperCase()} ${routePath}`)
    }
  }

  assert.ok(ungated.length === 0,
    `run routes must be canAccessSubmission then canViewJobInternals: ${ungated.join(', ')}`)
  // A guard that matches nothing passes forever.
  const runRoutes = routeDeclarations(source).filter((r) => /\/runs/.test(r.routePath))
  assert.equal(runRoutes.length, 2, 'expected the list and the single-run routes');
});
