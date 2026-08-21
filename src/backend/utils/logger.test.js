/**
 * Which log records actually get out.
 *
 * winston's npm levels are ordered `error(0) < warn(1) < info(2) < http(3) <
 * verbose(4) < debug(5)`, and a level only lets through what is numerically at
 * or below it. That ordering is not intuitive — `http` READS like something
 * less important than `info` — and it cost the app every request log in
 * production: `info` was the documented default, Morgan writes at `http`, and
 * nothing anywhere reported that the records were being dropped.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

/** Load a fresh logger with a given LOG_LEVEL. */
function loggerWith(level) {
  const before = process.env.LOG_LEVEL;
  if (level === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = level;
  delete require.cache[require.resolve('./logger')];
  const logger = require('./logger');
  if (before === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = before;
  delete require.cache[require.resolve('./logger')];
  return logger;
}

test('request logs are on by default', () => {
  // The defect this pins: production had none, and the default is what caused it.
  const logger = loggerWith(undefined);

  assert.equal(logger.isLevelEnabled('http'), true, 'this is where Morgan writes');
});

test('the default keeps error, warn and info too', () => {
  const logger = loggerWith(undefined);

  for (const level of ['error', 'warn', 'info']) {
    assert.equal(logger.isLevelEnabled(level), true, `${level} must still be emitted`);
  }
});

test('the default does NOT turn on debug', () => {
  // debug is deliberately noisy — the reconciler logs a line per gated job per
  // sweep there precisely to stay out of the way. Turning it on by default
  // would trade one bad default for another.
  const logger = loggerWith(undefined);

  assert.equal(logger.isLevelEnabled('debug'), false);
  assert.equal(logger.isLevelEnabled('verbose'), false);
});

test('LOG_LEVEL still overrides, in both directions', () => {
  assert.equal(loggerWith('debug').isLevelEnabled('debug'), true);
  assert.equal(loggerWith('error').isLevelEnabled('warn'), false);
});

test('setting info drops request logs — the trap, stated', () => {
  // Kept as a test rather than a comment: someone will reach for `info`
  // expecting "normal logging", and this says what that costs.
  const logger = loggerWith('info');

  assert.equal(logger.isLevelEnabled('info'), true);
  assert.equal(logger.isLevelEnabled('http'), false);
});

test('the Morgan stream writes at http, not info', () => {
  // If this ever became logger.info, the level default above would stop
  // mattering and the two would drift apart silently.
  const logger = loggerWith(undefined);
  const seen = [];
  const original = logger.http;
  logger.http = (msg) => { seen.push(msg); };

  logger.stream.write('GET /api/health 200 3ms\n');
  logger.http = original;

  assert.deepEqual(seen, ['GET /api/health 200 3ms'], 'and it is trimmed');
});
