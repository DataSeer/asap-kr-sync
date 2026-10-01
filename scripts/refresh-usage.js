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
 * With `--backfill` it also reconstructs step usage for executions that ran
 * before the `usage` column existed. Those steps recorded their tally inside
 * `result.tokens` in the old flat shape, and the model beside it in
 * `result.data.meta.model`, so the figure is recoverable rather than lost — it
 * just never reached the column the pipeline page reads.
 *
 * Backfill is opt-in, and deliberately: it writes rows describing runs that
 * happened before anyone was counting, and that is a thing to do on purpose
 * rather than as a side effect of asking for a refresh.
 *
 * Usage:
 *   node scripts/refresh-usage.js --submission <id>
 *   node scripts/refresh-usage.js --all
 *   node scripts/refresh-usage.js --all --dry-run
 *   node scripts/refresh-usage.js --all --backfill
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const models = require('../src/backend/models');
const runHistory = require('../src/backend/services/queue/run-history.service');

function parseArgs(argv) {
  const args = { submission: null, all: false, dryRun: false, backfill: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--submission') args.submission = argv[++i];
    else if (argv[i] === '--all') args.all = true;
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--backfill') args.backfill = true;
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

/**
 * Rebuild a step's usage from what the old tally recorded.
 *
 * The pre-column shape was flat — `{ promptTokens, outputTokens, totalTokens,
 * calls }` — with the model recorded separately in `data.meta.model`. Both
 * survive in `result`, so prompt, output, total, calls and the model come back
 * exactly.
 *
 * Two fields cannot: `thoughtTokens` and `cachedTokens` were never read. They
 * are set to NULL rather than 0, because 0 would assert that no thinking
 * happened — and the old tally folded thinking INTO `outputTokens`, so we know
 * for a fact that some of these runs did think. The total is right; only the
 * breakdown is gone.
 *
 * `backfilled: true` marks the record so nothing downstream has to guess why a
 * run has no thinking figure.
 *
 * @param {object} step - a StepExecution row
 * @returns {object|null} a usage record, or null when there is nothing to rebuild
 */
function usageFromLegacy(step) {
  const legacy = step.result?.tokens;
  if (!legacy || !legacy.totalTokens) return null;

  const model = step.result?.data?.meta?.model || 'unknown';
  const bucket = {
    promptTokens: legacy.promptTokens || 0,
    outputTokens: legacy.outputTokens || 0,
    thoughtTokens: null,
    cachedTokens: null,
    totalTokens: legacy.totalTokens || 0,
    calls: legacy.calls || 0
  };

  return {
    byModel: { [model]: bucket },
    promptTokens: bucket.promptTokens,
    outputTokens: bucket.outputTokens,
    thoughtTokens: null,
    cachedTokens: null,
    totalTokens: bucket.totalTokens,
    calls: bucket.calls,
    measuredCalls: bucket.calls,
    unmeasured: [],
    notCounted: [],
    backfilled: true
  };
}

/**
 * Fill in step usage for a run's executions that predate the column.
 *
 * Only ever writes where `usage` is null: a step that recorded its own usage is
 * the authority on itself and is never overwritten by a reconstruction.
 *
 * Returns the rebuilt records as well as the count, so a dry run can show the
 * total it WOULD produce instead of reading a column it has deliberately not
 * written — which would otherwise report "3 steps would be rebuilt" and
 * "nothing recorded" in the same line.
 *
 * @param {object} models
 * @param {string} pipelineRunId
 * @param {boolean} dryRun
 * @returns {Promise<{filled: number, rebuilt: Array<object>}>}
 */
async function backfillSteps(models, pipelineRunId, dryRun) {
  const steps = await models.StepExecution.findAll({
    where: { pipelineRunId, usage: null },
    attributes: ['id', 'jobType', 'usage', 'result']
  });

  const rebuilt = [];
  for (const step of steps) {
    const record = usageFromLegacy(step);
    if (!record) continue;
    rebuilt.push(record);
    if (!dryRun) await step.update({ usage: record });
  }
  return { filled: rebuilt.length, rebuilt };
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

    let filled = 0;
    let rebuilt = [];
    if (args.backfill) {
      ({ filled, rebuilt } = await backfillSteps(models, run.id, args.dryRun));
    }

    if (args.dryRun) {
      // Same read, no write: sum the steps and say what WOULD be stored.
      const steps = await models.StepExecution.findAll({
        where: { pipelineRunId: run.id }, attributes: ['usage']
      });
      // The stored ones plus anything the backfill would have added.
      const records = [...steps.map(s => s.usage).filter(Boolean), ...rebuilt];
      const would = records.length ? runHistory.sumUsage(records) : null;
      const differs = canonical(would ?? null) !== before;
      if (differs) changed++;
      console.log(`${run.submissionId} r${run.round}/run${run.runNumber}`
        + `${differs ? ' WOULD CHANGE' : ' unchanged'}: ${describe(would)}`
        + `${filled ? ` (${filled} step(s) would be rebuilt from the old tally)` : ''}`);
      continue;
    }

    const updated = await runHistory.recomputePipelineRunUsage(run.id);
    const after = canonical(updated?.usage ?? null);
    if (after !== before) changed++;
    console.log(`${run.submissionId} r${run.round}/run${run.runNumber}`
      + `${after !== before ? ' updated' : ' unchanged'}: ${describe(updated?.usage)}`
      + `${filled ? ` (${filled} step(s) rebuilt from the old tally)` : ''}`);
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
