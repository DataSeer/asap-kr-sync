#!/usr/bin/env node

/**
 * Re-sum what each pipeline run spent, from the steps that spent it.
 *
 * The live path already refreshes a run's usage as each module finishes, so
 * this is a repair tool, not part of normal operation. It exists because the
 * figure is derived: anything that edits history — a migration, a restored
 * backup, a step whose usage was recorded before this column existed — leaves
 * a run total that no longer matches its steps, and nothing else would notice.
 *
 * It calls the SAME function as the live path
 * (`run-history.recomputePipelineRunUsage`), deliberately. A second
 * implementation here would be a second opinion about what a run cost, and the
 * two would disagree eventually.
 *
 * Reads and rewrites `pipeline_runs.usage` only. It never touches step usage,
 * job rows, or anything a person entered.
 *
 * Usage:
 *   node scripts/refresh-usage.js --submission <id>
 *   node scripts/refresh-usage.js --all
 *   node scripts/refresh-usage.js --all --dry-run
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const models = require('../src/backend/models');
const runHistory = require('../src/backend/services/queue/run-history.service');

function parseArgs(argv) {
  const args = { submission: null, all: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--submission') args.submission = argv[++i];
    else if (argv[i] === '--all') args.all = true;
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

/**
 * A comparable string for a usage record.
 *
 * Plain JSON.stringify is not usable here: the object Postgres hands back and
 * the one just computed carry the same numbers with their keys in a different
 * order, so every run would report "updated" and every refresh would look like
 * drift. Sorting the keys makes "changed" mean changed.
 *
 * @param {object|null} value
 * @returns {string}
 */
function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** A compact one-line summary of a usage record. */
function describe(usage) {
  if (!usage) return 'nothing recorded';
  const models_ = Object.keys(usage.byModel || {}).join(', ') || 'no model';
  const gaps = [];
  if (usage.unmeasured?.length) gaps.push(`${usage.unmeasured.length} unmeasured`);
  if (usage.notCounted?.length) gaps.push(`excludes ${usage.notCounted.join(', ')}`);
  return `${usage.totalTokens.toLocaleString()} tokens over ${usage.calls} call(s)`
    + ` [${models_}]${gaps.length ? ' — ' + gaps.join('; ') : ''}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.all && !args.submission) {
    console.error('Nothing to do. Pass --submission <id> or --all.');
    process.exitCode = 1;
    return;
  }

  const { PipelineRun } = models;
  const where = args.submission ? { submissionId: args.submission } : {};
  const runs = await PipelineRun.findAll({
    where,
    attributes: ['id', 'submissionId', 'round', 'runNumber', 'usage'],
    order: [['submissionId', 'ASC'], ['round', 'ASC'], ['runNumber', 'ASC']]
  });

  if (runs.length === 0) {
    console.log(args.submission ? `No runs for submission ${args.submission}.` : 'No runs found.');
    return;
  }

  console.log(`${runs.length} run(s)${args.dryRun ? ' — dry run, nothing will be written' : ''}\n`);

  let changed = 0;
  for (const run of runs) {
    const before = canonical(run.usage ?? null);

    if (args.dryRun) {
      // Same read, no write: sum the steps and say what WOULD be stored.
      const steps = await models.StepExecution.findAll({
        where: { pipelineRunId: run.id }, attributes: ['usage']
      });
      const records = steps.map(s => s.usage).filter(Boolean);
      const would = records.length ? runHistory.sumUsage(records) : null;
      const differs = canonical(would ?? null) !== before;
      if (differs) changed++;
      console.log(`${run.submissionId} r${run.round}/run${run.runNumber}`
        + `${differs ? ' WOULD CHANGE' : ' unchanged'}: ${describe(would)}`);
      continue;
    }

    const updated = await runHistory.recomputePipelineRunUsage(run.id);
    const after = canonical(updated?.usage ?? null);
    if (after !== before) changed++;
    console.log(`${run.submissionId} r${run.round}/run${run.runNumber}`
      + `${after !== before ? ' updated' : ' unchanged'}: ${describe(updated?.usage)}`);
  }

  console.log(`\n${changed} of ${runs.length} run(s) ${args.dryRun ? 'would change' : 'changed'}.`);
}

main()
  .catch((error) => {
    console.error('Refresh failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await models.sequelize.close();
  });
