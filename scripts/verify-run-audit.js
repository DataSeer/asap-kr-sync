#!/usr/bin/env node

/**
 * Check that a run's stored inputs still explain its result.
 *
 * Every module writes an `inputs.json` beside its other artefacts: the
 * documents it read (as id + version + SHA-256), the mutable things it was
 * given (author rows, seeds, candidate pool) copied verbatim, and the prompt as
 * a pair of digests — the template on disk, and the ASSEMBLED prompt actually
 * sent.
 *
 * Storing a digest instead of the prompt text is only defensible if the prompt
 * can be rebuilt from everything else in that file. This script does the
 * rebuild and compares. If it stops matching, the digests have quietly become
 * worthless and the record needs whatever new input the prompt started using —
 * that is the failure this exists to catch.
 *
 * It checks two things per run:
 *   1. every referenced document still hashes to what the run recorded, and
 *   2. the prompt rebuilds byte-exactly from the frozen inputs.
 *
 * Three modules legitimately record no prompt (`markdown_convert`,
 * `orcid_extraction`, `identifier_detection`) because they call no model.
 * `krt_grounding` sends one prompt per batch of rows rather than one prompt, so
 * it records the batch size instead of an assembled digest.
 *
 * SAFETY: read-only. It downloads and hashes; it writes nothing.
 *
 * Usage:
 *   node scripts/verify-run-audit.js --manuscript DA1-000463-013-org-D-3
 *   node scripts/verify-run-audit.js --submission <uuid> [--round 2]
 *   node scripts/verify-run-audit.js --all          # every submission
 *
 * Exit code is 1 when any check fails, so it can gate a release.
 *
 * Environment:
 *   DATABASE_URL and the S3/MinIO settings — read from .env, or the
 *   surrounding environment.
 *
 * Inside the app container (Postgres is NOT containerised by default):
 *   docker compose exec app node scripts/verify-run-audit.js --all
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const fs = require('fs');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
  console.log(fs.readFileSync(__filename, 'utf-8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(0);
}

const { Op } = require('sequelize');
const { Submission, SubmissionJob } = require('../src/backend/models');
const s3 = require('../src/backend/services/storage/s3.service');
const { sha256 } = require('../src/backend/services/queue/run-inputs.service');
const { absolutePath } = require('../src/backend/services/detection/repo-path');
const {
  assembleTextPrompt, assemblePayloadPrompt, SEED_TITLES
} = require('../src/backend/services/detection/prompt-assembly');

/** Modules that call no model, so an absent prompt is correct. */
const NO_PROMPT = new Set(['markdown_convert', 'orcid_extraction', 'identifier_detection']);
/** Modules whose prompt is sent per batch, so there is no single one to digest. */
const BATCHED = new Set(['krt_grounding']);

const load = async (key) => JSON.parse((await s3.downloadFile(key)).toString('utf-8'));

/**
 * Rebuild a module's prompt from its frozen inputs alone.
 *
 * Every branch goes through the same assembly helpers the pipeline uses — a
 * reimplementation here would drift and start passing for the wrong reason.
 *
 * @returns {Promise<string|null>} null when this module is not reconstructible
 */
async function rebuildPrompt(jobType, inputs) {
  const rel = inputs.prompt?.promptFile;
  if (!rel) return null;

  // Loaders trim; a rebuild that reads the file raw differs by a trailing
  // newline. `templateResolvedSha256` records the trimmed form for exactly this
  // reason, and is checked below.
  const template = fs.readFileSync(absolutePath(rel), 'utf-8').trim();
  // Consolidation and the comparison take a JSON payload of frozen rows and no
  // manuscript at all, so they are answered before the markdown is fetched.
  if (jobType === 'pdf_analysis') {
    const { candidateForPrompt } = require('../src/backend/services/pdf-analysis/krt-generation.service');
    const payload = { candidates: (inputs.frozen?.candidates || []).map((c, i) => candidateForPrompt(c, i)) };
    return `${template}\n\n---\n\nINPUT:\n\n${JSON.stringify(payload, null, 2)}`;
  }
  if (jobType === 'suggestion_generation') {
    const {
      authorRowForPrompt, generatedRowForPrompt
    } = require('../src/backend/services/suggestion/kr-comparison.service');
    const payload = {
      author_krt: (inputs.frozen?.authorRows || []).map(authorRowForPrompt),
      generated_krt: (inputs.frozen?.generatedKrt || []).map((g, i) => generatedRowForPrompt(g, i))
    };
    return `${template}\n\n---\n\nINPUT:\n\n${JSON.stringify(payload, null, 2)}`;
  }

  const mdKey = inputs.documents?.markdown?.s3Key;
  if (!mdKey) return null;
  const markdownText = (await s3.downloadFile(mdKey)).toString('utf-8');
  const seeds = inputs.frozen?.seeds || [];

  if (jobType === 'materials_detection' || jobType === 'protocols_detection') {
    return assembleTextPrompt({
      prompt: template,
      seeds,
      seedTitle: seeds.length ? SEED_TITLES[jobType.split('_')[0]] : null,
      markdownText
    });
  }
  if (jobType === 'software_detection') {
    return `${template}\n\n---\n\nARTICLE MARKDOWN:\n\n${markdownText}`;
  }
  if (jobType === 'datasets_detection') {
    return assemblePayloadPrompt({
      systemPrompt: template,
      seeds,
      datasetNames: inputs.frozen?.datasetNames || [],
      extractedRows: inputs.frozen?.extractedRows || [],
      markdownText
    }).prompt;
  }
  if (jobType === 'das_extraction') {
    return `${template}\n\nSection type: ${inputs.meta?.section}\n\nMANUSCRIPT:\n${markdownText}`;
  }
  return null;
}

/** @returns {Promise<{checked: number, failed: number}>} */
async function verifySubmission(submission, round) {
  const jobs = await SubmissionJob.getForSubmission(submission.id, round);
  let checked = 0;
  let failed = 0;

  console.log(`\n=== ${submission.manuscriptId || submission.id} — round ${round}`);

  for (const job of jobs.sort((a, b) => a.jobType.localeCompare(b.jobType))) {
    const key = job.result?.files?.inputs;
    if (!key) {
      const expected = job.status === 'complete';
      if (expected) {
        failed++;
        console.log(`  ${job.jobType.padEnd(22)} NO INPUTS RECORD (the run cannot be audited)`);
      }
      continue;
    }

    const inputs = await load(key);
    const problems = [];

    // 1. the documents still are what the run said they were
    for (const [name, ref] of Object.entries(inputs.documents || {})) {
      if (!ref?.s3Key || !ref.sha256) continue;
      const bytes = await s3.downloadFile(ref.s3Key);
      if (sha256(bytes) !== ref.sha256) problems.push(`${name} digest DIFFERS from the run's`);
    }

    // 2. the prompt template has not moved under the record
    if (inputs.prompt?.promptFile && inputs.prompt.templateResolvedSha256) {
      const onDisk = fs.readFileSync(absolutePath(inputs.prompt.promptFile), 'utf-8').trim();
      if (sha256(onDisk) !== inputs.prompt.templateResolvedSha256) {
        problems.push('prompt template has changed since this run (expected — the digest records which version ran)');
      }
    }

    // 3. the assembled prompt rebuilds
    let promptResult = 'no prompt (calls no model)';
    if (BATCHED.has(job.jobType)) {
      promptResult = `per-batch prompt, batch size ${inputs.meta?.secondLookBatchSize ?? '?'}`;
    } else if (!NO_PROMPT.has(job.jobType)) {
      if (!inputs.prompt?.assembledSha256) {
        promptResult = 'NO ASSEMBLED DIGEST';
        problems.push('no assembled prompt digest to verify against');
      } else {
        const rebuilt = await rebuildPrompt(job.jobType, inputs);
        if (rebuilt === null) {
          promptResult = 'digest recorded; rebuild not implemented here';
        } else if (sha256(rebuilt) === inputs.prompt.assembledSha256) {
          promptResult = 'prompt REBUILT, digest matches';
        } else {
          promptResult = 'prompt rebuilt but digest DIFFERS';
          problems.push('the prompt can no longer be rebuilt from the recorded inputs');
        }
      }
    }

    checked++;
    if (problems.length) failed++;
    const mark = problems.length ? '✗' : '✓';
    console.log(`  ${mark} ${job.jobType.padEnd(22)} ${promptResult}`);
    for (const p of problems) console.log(`      ${p}`);
  }

  return { checked, failed };
}

(async () => {
  const round = flag('--round') ? parseInt(flag('--round'), 10) : null;
  let submissions;

  if (argv.includes('--all')) {
    submissions = await Submission.findAll({ order: [['createdAt', 'DESC']] });
  } else if (flag('--manuscript')) {
    submissions = await Submission.findAll({ where: { manuscriptId: flag('--manuscript') } });
  } else if (flag('--submission')) {
    submissions = await Submission.findAll({ where: { id: { [Op.eq]: flag('--submission') } } });
  } else {
    console.error('Give --manuscript, --submission or --all. See --help.');
    process.exit(2);
  }

  if (!submissions.length) {
    console.error('No matching submission.');
    process.exit(2);
  }

  let checked = 0;
  let failed = 0;
  for (const s of submissions) {
    const r = await verifySubmission(s, round ?? (s.currentRound || 1));
    checked += r.checked;
    failed += r.failed;
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${checked} run(s) checked, ${failed} problem(s)`);
  if (failed) {
    console.log('\nA prompt that no longer rebuilds means the record is missing an input the '
      + 'prompt started using. Add it to that module\'s saveRunInputs call — the digests '
      + 'prove nothing without it.');
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
