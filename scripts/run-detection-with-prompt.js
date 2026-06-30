#!/usr/bin/env node
/**
 * Run a detection module with a CUSTOM prompt (prompt-tuning / experiments).
 *
 * Each GenAI detector now accepts an optional `prompt` parameter that defaults
 * to its committed prompt file. This script reads a prompt from a file and
 * passes it as that override, so you can A/B a new prompt without touching the
 * checked-in default.
 *
 * Usage:
 *   node scripts/run-detection-with-prompt.js <type> <inputFile> [promptFile] [signalsPromptFile] [signalsExamplesFile]
 *
 *   type          das | protocols | datasets | materials
 *   inputFile     manuscript markdown (.md/.txt) for das/protocols/datasets/materials
 *   promptFile    path to the custom prompt text (the primary override)
 *   signalsPromptFile     datasets only, optional — overrides the langextract
 *                         signal-extraction prompt
 *   signalsExamplesFile   datasets only, optional — overrides the langextract
 *                         few-shot examples JSON
 *
 * Examples:
 *   node scripts/run-detection-with-prompt.js protocols ./paper.md ./my-protocols-prompt.txt
 *   node scripts/run-detection-with-prompt.js datasets  ./paper.md ./consolidation.txt ./signals.txt ./examples.json
 *   node scripts/run-detection-with-prompt.js materials ./paper.pdf ./materials-prompt.txt
 *
 * Omit promptFile to run with the committed default (sanity check):
 *   node scripts/run-detection-with-prompt.js protocols ./paper.md
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const protocolsService = require('../src/backend/services/protocols/protocols.service');
const datasetsService = require('../src/backend/services/datasets/datasets.service');
const materialsService = require('../src/backend/services/materials/materials.service');
const dasService = require('../src/backend/services/pdf/das-extraction.service');

function readOrNull(file) {
  if (!file) return undefined; // undefined → detector falls back to its default file
  return fs.readFileSync(path.resolve(file), 'utf-8');
}

async function main() {
  const [type, inputFile, promptFile, signalsPromptFile, signalsExamplesFile] = process.argv.slice(2);

  if (!type || !inputFile) {
    console.error('Usage: node scripts/run-detection-with-prompt.js <das|protocols|datasets|materials> <inputFile> [promptFile] [signalsPromptFile] [signalsExamplesFile]');
    process.exit(1);
  }

  const prompt = readOrNull(promptFile);
  const signalsPrompt = readOrNull(signalsPromptFile);
  const signalsExamples = readOrNull(signalsExamplesFile);
  const inputPath = path.resolve(inputFile);

  if (prompt) {
    console.error(`Using custom prompt from ${promptFile} (${prompt.length} chars)`);
  } else {
    console.error('No prompt file given — using the committed default prompt');
  }

  let result;
  switch (type) {
    case 'das': {
      const markdown = fs.readFileSync(inputPath, 'utf-8');
      result = await dasService.extractDAS(markdown, { prompt });
      break;
    }
    case 'protocols': {
      const markdown = fs.readFileSync(inputPath, 'utf-8');
      result = await protocolsService.detectProtocols(markdown, { prompt });
      break;
    }
    case 'datasets': {
      const markdown = fs.readFileSync(inputPath, 'utf-8');
      result = await datasetsService.detectDatasets(markdown, { prompt, signalsPrompt, signalsExamples });
      break;
    }
    case 'materials': {
      const markdown = fs.readFileSync(inputPath, 'utf-8');
      result = await materialsService.detectMaterials(markdown, { prompt });
      break;
    }
    default:
      console.error(`Unknown type "${type}" — expected das|protocols|datasets|materials`);
      process.exit(1);
  }

  // Structured result to stdout so it can be piped/redirected to a file.
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch((err) => {
  console.error('Detection failed:', err.message);
  process.exit(1);
});
