/**
 * Run the tests the way CI runs them: on a machine with no `.env`.
 *
 * Preload with `node --require scripts/dev/no-dotenv.js --test …`, or use
 * `npm run test:backend:noenv`.
 *
 * The failure this exists to catch: `config/database.js` calls
 * `dotenv.config()`, so requiring the models quietly loads the developer's
 * `.env` into the process. Any module that validates a secret at load —
 * `services/auth/jwt.service.js` throws without `JWT_SECRET` — then works
 * locally and dies on a runner that has no such file. Two test suites passed
 * here and failed in CI for exactly that reason.
 *
 * This stubs `dotenv` to a no-op and clears app variables a parent shell may
 * have exported. It never reads or writes `.env` itself.
 */

const Module = require('module');

const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'dotenv') return { config: () => ({ parsed: {} }) };
  return realRequire.apply(this, arguments);
};

for (const key of Object.keys(process.env)) {
  // The second alternative is not anchored on purpose: the nine per-module
  // Gemini names are PREFIXED (DATASETS_DETECTION_GEMINI_API_KEY), so a `^`
  // pattern cleared the shared key and left every module's copy behind --
  // in the very run that now covers config/, whose whole subject they are.
  if (/^(JWT_|DATABASE_|DB_|S3_|AWS_|SOFTCITE_|GEMINI_|AUTH0_|MODAL_)|_GEMINI_/.test(key)) {
    delete process.env[key];
  }
}
