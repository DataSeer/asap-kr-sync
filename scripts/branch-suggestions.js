#!/usr/bin/env node
/**
 * Generate the branch's AI suggestions from an existing batch run's artifacts.
 *
 * The batch runner stops at the Generated KRT, so the suggestions — the thing a
 * curator actually acts on — were never produced. Everything they need is
 * already saved (author rows, Generated KRT, grounding outcomes), so this costs
 * one LM call per document and no re-detection.
 *
 * Uses buildSuggestionsFromLM with the grounding outcomes, NOT the plain
 * compareKrts path: grounding-derived updates are a suggestion class the
 * redesign adds, and omitting them would under-represent the branch.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const B = path.join(__dirname, '../src/backend');
const IN = path.join(__dirname, '../tmp/batch-check');
const krComparison = require(path.join(B, 'services/suggestion/kr-comparison.service'));

(async () => {
  const files = fs.readdirSync(IN).filter((f) => f.endsWith('-artifacts.json')).sort();
  for (const f of files) {
    const a = JSON.parse(fs.readFileSync(path.join(IN, f), 'utf-8'));
    if (!a.hasAuthorKrt) continue;              // suggestions need an author table
    if (Array.isArray(a.suggestions)) {
      process.stderr.write(`  ${a.name}  (already has suggestions, skipping)\n`);
      continue;
    }

    const started = Date.now();
    try {
      const { lmDecisions } = await krComparison.callGeminiForComparison(a.authorKrt, a.generatedKrt);
      const { suggestions } = krComparison.buildSuggestionsFromLM(
        a.authorKrt, a.generatedKrt, lmDecisions, a.outcomes || []
      );

      a.suggestions = suggestions;
      fs.writeFileSync(path.join(IN, f), JSON.stringify(a, null, 1));
      process.stderr.write(
        `  ${a.name.padEnd(26)} ${String(suggestions.length).padStart(4)} suggestions`
        + `  [${Math.round((Date.now() - started) / 1000)}s]\n`
      );
    } catch (error) {
      process.stderr.write(`  ${a.name.padEnd(26)}   ERROR ${error.message}\n`);
    }
  }
  process.stderr.write('\ndone\n');
  try { require(path.join(B, 'models')).sequelize.close(); } catch { /* not connected */ }
  process.exit(0);
})();
