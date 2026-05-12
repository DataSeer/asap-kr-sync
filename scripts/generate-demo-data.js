#!/usr/bin/env node

/**
 * Generate and update demo data for the ASAP KR Sync application.
 *
 * Three modes:
 *
 * 1. STATIC mode — generate demo JSON from a DS1 compliance report:
 *    node scripts/generate-demo-data.js <manuscript-id> <ds1-report.xlsx> [--das "text"] [--description "text"]
 *
 * 2. API mode — fetch DAS + Markdown from external APIs for all demo PDFs:
 *    node scripts/generate-demo-data.js --update-api-data [--dry-run] [--only-missing]
 *
 * 3. REFRESH ALL mode — re-parse all DS1 reports AND fetch API data for all manuscripts:
 *    node scripts/generate-demo-data.js --refresh-all [--dry-run] [--only-missing]
 *
 * --only-missing: skip manuscripts that already have a demo JSON in the backend
 *                 directory. Useful after adding new PDFs to avoid re-processing
 *                 existing ones.
 *
 * Internal files (PDF, DS1 xlsx, KRT xlsx/csv) are read from:
 *   - src/frontend/public/demo-files/
 *
 * Generated JSON and Markdown demo data are written to:
 *   - src/backend/data/demo-findings/
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '../src/backend/data/demo-findings');
const DEMO_FILES_DIR = path.join(__dirname, '../src/frontend/public/demo-files');

// ===================== CLI =====================

const args = process.argv.slice(2);

if (args.includes('--refresh-all')) {
  runRefreshAll().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
} else if (args.includes('--update-api-data')) {
  runApiMode().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
} else {
  runStaticMode();
}

// ===================== STATIC MODE =====================

function printUsage() {
  console.log('Usage:');
  console.log('  Static:      node scripts/generate-demo-data.js <manuscript-id> <ds1-report.xlsx> [--das "text"] [--description "text"]');
  console.log('  API only:    node scripts/generate-demo-data.js --update-api-data [--dry-run] [--only-missing]');
  console.log('  Refresh all: node scripts/generate-demo-data.js --refresh-all [--dry-run] [--only-missing]');
  process.exit(1);
}

/**
 * Check whether a manuscript already has a demo JSON in the backend directory.
 * @param {string} manuscriptId
 * @returns {boolean}
 */
function hasExistingDemoJson(manuscriptId) {
  const jsonPath = path.join(BACKEND_DIR, manuscriptId.toLowerCase() + '-demo.json');
  return fs.existsSync(jsonPath);
}

function runStaticMode() {
  if (args.length < 2) printUsage();

  const manuscriptId = args[0];
  const ds1Path = args[1];
  let dasText = 'N/A';
  let description = '';

  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--das' && args[i + 1]) {
      dasText = args[++i];
    } else if (args[i] === '--description' && args[i + 1]) {
      description = args[++i];
    }
  }

  if (!fs.existsSync(ds1Path)) {
    console.error(`DS1 report not found: ${ds1Path}`);
    process.exit(1);
  }

  console.log(`Generating demo data for ${manuscriptId}...`);

  const ds1Wb = XLSX.readFile(ds1Path);

  const datasetItems = parseDatasets(ds1Wb);
  const softwareItems = parseSoftware(ds1Wb);
  const protocolItems = parseProtocols(ds1Wb);
  const materialItems = parseMaterials(ds1Wb);

  const demoData = buildDemoJson(manuscriptId, description, dasText, datasetItems, softwareItems, protocolItems, materialItems);
  writeDemoJson(manuscriptId, demoData);

  console.log(`\n  Datasets:      ${datasetItems.length} items`);
  console.log(`  Software:      ${softwareItems.length} items`);
  console.log(`  Protocols:     ${protocolItems.length} items`);
  console.log(`  Lab Materials: ${materialItems.length} items`);
}

// ===================== DS1 PARSING =====================

/**
 * Parse a DS1 tab: find header row (row with '#' in col A), then extract data rows.
 * Returns an array of objects keyed by header column names.
 * @param {Array} sheetData - 2D array from XLSX
 * @returns {Array<{ headerRow: number, section: string, data: Object }>}
 */
function parseDS1Sections(sheetData) {
  const sections = [];

  // Find all section markers and header rows
  const markers = [];
  for (let i = 0; i < sheetData.length; i++) {
    const cellA = String(sheetData[i][0] || '').trim();
    if (cellA === '#') {
      // This is a header row — find the section label above it
      let sectionLabel = '';
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        const above = String(sheetData[j][0] || '').trim();
        if (above.includes('Action') || above.includes('No research') || above.includes('Re-Use') || above.includes('Code and Newly') || above.includes('Compliance')) {
          sectionLabel = above;
          break;
        }
        // Check col B for section titles like "Code and Newly Generated Software" or "Re-Use of Existing Software"
        const aboveB = String(sheetData[j][1] || '').trim();
        if (aboveB) {
          sectionLabel = aboveB;
          break;
        }
      }
      markers.push({ headerRow: i, sectionLabel });
    }
  }

  for (let m = 0; m < markers.length; m++) {
    const { headerRow, sectionLabel } = markers[m];
    const endRow = m + 1 < markers.length ? markers[m + 1].headerRow : sheetData.length;

    // Build header map
    const headers = {};
    for (let c = 0; c < sheetData[headerRow].length; c++) {
      const val = String(sheetData[headerRow][c] || '').trim();
      if (val && val !== '#') headers[c] = val;
    }

    // Extract data rows (rows where col A is a number)
    const items = [];
    for (let r = headerRow + 1; r < endRow; r++) {
      const rowNum = sheetData[r][0];
      if (rowNum === null || rowNum === undefined || rowNum === '') continue;
      if (typeof rowNum !== 'number' && isNaN(Number(rowNum))) continue;

      const rowData = {};
      for (const [c, h] of Object.entries(headers)) {
        const val = sheetData[r][Number(c)];
        if (val !== null && val !== undefined && val !== '') {
          rowData[h] = val;
        }
      }
      items.push(rowData);
    }

    sections.push({ sectionLabel, items });
  }

  return sections;
}

/**
 * Join multiple identifier values with ';', filtering out empty/null values.
 * @param  {...string} values
 * @returns {string}
 */
function joinIdentifiers(...values) {
  const parts = values
    .map(v => String(v || '').trim())
    .filter(v => v && v !== 'N/A' && v !== 'n/a');
  return parts.join(';') || '';
}

/**
 * Infer repository name from URL/DOI strings.
 * @param {...string} values
 * @returns {string|null}
 */
function inferRepository(...values) {
  const combined = values.join(' ').toLowerCase();
  if (combined.includes('zenodo')) return 'Zenodo';
  if (combined.includes('geo') || combined.includes('ncbi') || combined.includes('sra')) return 'NCBI';
  if (combined.includes('ega')) return 'EGA';
  if (combined.includes('figshare')) return 'Figshare';
  if (combined.includes('dryad')) return 'Dryad';
  if (combined.includes('github')) return 'GitHub';
  if (combined.includes('massive')) return 'MassIVE';
  if (combined.includes('biostudies') || combined.includes('ebi.ac')) return 'BioStudies';
  if (combined.includes('dataverse')) return 'Dataverse';
  if (combined.includes('protocols.io')) return 'protocols.io';
  return null;
}

/**
 * Build a standard demo item.
 * @param {string} canonicalName
 * @param {string} resourceType
 * @param {string|null} source
 * @param {string} identifier
 * @param {string} newReuse
 * @returns {Object}
 */
function makeDemoItem(canonicalName, resourceType, source, identifier, newReuse) {
  return {
    canonical_name: canonicalName,
    resource_type: resourceType,
    source: source || null,
    identifier: identifier || '',
    aliases: [],
    krt_relevance: 'HIGH',
    newReuse: newReuse || 'new'
  };
}

// ---- DATASETS ----
function parseDatasets(wb) {
  if (!wb.SheetNames.includes('Datasets')) return [];
  const sheetData = XLSX.utils.sheet_to_json(wb.Sheets['Datasets'], { header: 1, defval: '' });
  const sections = parseDS1Sections(sheetData);
  const items = [];

  for (const section of sections) {
    for (const row of section.items) {
      const name = String(row['Dataset Name'] || '').trim();
      if (!name) continue;

      const url = String(row['URL'] || '').trim();
      const doi = String(row['DOI/Identifier'] || '').trim();
      const isReuse = String(row['Re-Use'] || '').toLowerCase() === 'true';
      const source = inferRepository(url, doi);
      const identifier = joinIdentifiers(doi, url);

      items.push(makeDemoItem(name, 'Dataset', source, identifier, isReuse ? 'reuse' : 'new'));
    }
  }

  return items;
}

// ---- CODE AND SOFTWARE ----
function parseSoftware(wb) {
  if (!wb.SheetNames.includes('Code and Software')) return [];
  const sheetData = XLSX.utils.sheet_to_json(wb.Sheets['Code and Software'], { header: 1, defval: '' });
  const sections = parseDS1Sections(sheetData);
  const items = [];

  for (const section of sections) {
    // Detect whether this is the "new code" or "re-use" section by checking header columns
    const hasObjectName = section.items.some(row => row['Object Name'] !== undefined);
    const hasSoftwareName = section.items.some(row => row['Software Name'] !== undefined);

    for (const row of section.items) {
      if (hasObjectName && !hasSoftwareName) {
        // New code section
        const name = String(row['Object Name'] || '').trim();
        if (!name) continue;

        const url = String(row['URL'] || '').trim();
        const doi = String(row['DOI'] || '').trim();
        // Use first URL as source, combine DOI + URL as identifier
        const firstUrl = url.split(/\s*;\s*/)[0] || null;
        const identifier = joinIdentifiers(doi, url);

        items.push(makeDemoItem(name, 'Code/Software', firstUrl, identifier, 'new'));
      } else {
        // Re-use section
        const name = String(row['Software Name'] || '').trim();
        if (!name) continue;

        const url = String(row['URL'] || '').trim();
        const rrid = String(row['RRID (if applicable)'] || '').trim();
        const suggestedRRID = String(row['Suggested RRID Citation'] || '').trim();
        const suggestedURL = String(row['Suggested URL'] || '').trim();
        // Use suggested URL or original URL as source
        const source = suggestedURL || url || null;
        const identifier = joinIdentifiers(rrid, suggestedRRID, suggestedURL);

        items.push(makeDemoItem(name, 'Code/Software', source, identifier, 'reuse'));
      }
    }
  }

  return items;
}

// ---- PROTOCOLS ----
function parseProtocols(wb) {
  if (!wb.SheetNames.includes('Protocols')) return [];
  const sheetData = XLSX.utils.sheet_to_json(wb.Sheets['Protocols'], { header: 1, defval: '' });
  const sections = parseDS1Sections(sheetData);
  const items = [];

  for (const section of sections) {
    for (const row of section.items) {
      const name = String(row['Methods Section Heading'] || '').trim();
      if (!name) continue;

      const url = String(row['URL'] || '').trim();
      const doi = String(row['DOI/Citation'] || '').trim();
      const isReuse = String(row['Re-Use'] || '').toLowerCase() === 'true';
      const identifier = joinIdentifiers(url, doi);

      items.push(makeDemoItem(name, 'Protocol', '', identifier, isReuse ? 'reuse' : 'new'));
    }
  }

  return items;
}

// ---- LAB MATERIALS ----
function parseMaterials(wb) {
  if (!wb.SheetNames.includes('Lab Materials')) return [];
  const sheetData = XLSX.utils.sheet_to_json(wb.Sheets['Lab Materials'], { header: 1, defval: '' });
  const sections = parseDS1Sections(sheetData);
  const items = [];

  for (const section of sections) {
    for (const row of section.items) {
      const name = String(row['Material Name'] || '').trim();
      if (!name) continue;

      const vendor = String(row['Source'] || '').trim();
      const catalog = String(row['Catalog Number'] || '').trim();
      const rrid = String(row['RRID'] || '').trim();
      const suggestedRRID = String(row['Suggested RRID Citation'] || '').trim();
      const isReuse = String(row['Re-Use'] || '').toLowerCase() === 'true';
      const identifier = joinIdentifiers(catalog, rrid, suggestedRRID);

      items.push(makeDemoItem(name, 'Other', vendor || null, identifier, isReuse ? 'reuse' : 'new'));
    }
  }

  return items;
}

// ===================== JSON BUILDER =====================

function buildDemoJson(manuscriptId, description, das, datasets, software, protocols, materials) {
  return {
    manuscriptId,
    description,
    das,
    datasetMentions: {
      items: datasets,
      meta: {
        totalCount: datasets.length,
        uniqueCount: datasets.length,
        highRelevanceCount: datasets.filter(i => i.krt_relevance === 'HIGH').length
      }
    },
    softwareMentions: {
      items: software,
      meta: {
        rawMentionCount: software.length,
        uniqueCount: software.length,
        enrichedCount: software.filter(i => i.newReuse === 'reuse').length,
        softciteOnlyCount: software.filter(i => i.newReuse === 'new').length
      }
    },
    protocolMentions: {
      items: protocols,
      meta: {
        totalCount: protocols.length,
        uniqueCount: protocols.length,
        highRelevanceCount: protocols.filter(i => i.krt_relevance === 'HIGH').length
      }
    },
    labMaterialMentions: {
      items: materials,
      meta: {
        totalCount: materials.length,
        uniqueCount: materials.length,
        highRelevanceCount: materials.filter(i => i.krt_relevance === 'HIGH').length
      }
    }
  };
}

/**
 * Write demo JSON to the backend demo-findings directory.
 * @param {string} manuscriptId
 * @param {Object} demoData
 */
function writeDemoJson(manuscriptId, demoData) {
  const fileName = manuscriptId.toLowerCase() + '-demo.json';
  fs.mkdirSync(BACKEND_DIR, { recursive: true });
  const outPath = path.join(BACKEND_DIR, fileName);
  fs.writeFileSync(outPath, JSON.stringify(demoData, null, 2));
  console.log(`Written: ${outPath}`);
}

/**
 * Write demo Markdown to the backend demo-findings directory.
 * @param {string} manuscriptId
 * @param {string} markdown
 */
function writeDemoMarkdown(manuscriptId, markdown) {
  const mdFileName = manuscriptId.toLowerCase() + '-demo.md';
  fs.mkdirSync(BACKEND_DIR, { recursive: true });
  fs.writeFileSync(path.join(BACKEND_DIR, mdFileName), markdown);
}

// ===================== API MODE =====================

async function runApiMode() {
  const dryRun = args.includes('--dry-run');
  const onlyMissing = args.includes('--only-missing');

  // Load env vars from .env if dotenv is available
  try {
    require('dotenv').config({ path: path.join(__dirname, '../.env') });
  } catch {
    // dotenv not required
  }

  // Import API clients and configs
  const dasExtractorConfig = require('../src/backend/config/pdf-das-extractor-api');
  const markdownConfig = require('../src/backend/config/pdf-markdown-api');
  const dasExtractorClient = require('../src/backend/services/pdf/pdf-das-extractor-client.service');
  const pdfMarkdownClient = require('../src/backend/services/pdf/pdf-markdown-client.service');

  // Discover PDFs
  let pdfFiles = fs.readdirSync(DEMO_FILES_DIR).filter(f => f.toLowerCase().endsWith('.pdf')).sort();

  if (pdfFiles.length === 0) {
    console.error(`No PDF files found in ${DEMO_FILES_DIR}`);
    process.exit(1);
  }

  const totalPdfCount = pdfFiles.length;
  let skippedCount = 0;
  if (onlyMissing) {
    pdfFiles = pdfFiles.filter(pdfFile => {
      const manuscriptId = pdfFile.replace(/\.pdf$/i, '');
      return !hasExistingDemoJson(manuscriptId);
    });
    skippedCount = totalPdfCount - pdfFiles.length;
  }

  const dasConfigured = dasExtractorConfig.isConfigured();
  const markdownConfigured = markdownConfig.isConfigured();

  console.log(`\n=== Update API Data${dryRun ? ' (DRY RUN)' : ''}${onlyMissing ? ' (ONLY MISSING)' : ''} ===`);
  console.log(`PDFs found: ${totalPdfCount}${onlyMissing ? ` (${pdfFiles.length} missing, ${skippedCount} already have demo JSON)` : ''}`);
  console.log(`DAS Extractor API: ${dasConfigured ? 'configured' : 'NOT configured (skipping)'}`);
  console.log(`Markdown API: ${markdownConfigured ? `configured (${markdownConfig.provider})` : 'NOT configured (skipping)'}`);
  console.log('');

  if (pdfFiles.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (!dasConfigured && !markdownConfigured) {
    console.error('Neither API is configured. Set the required environment variables and try again.');
    process.exit(1);
  }

  for (const pdfFile of pdfFiles) {
    const manuscriptId = pdfFile.replace(/\.pdf$/i, '');
    const jsonFileName = manuscriptId.toLowerCase() + '-demo.json';
    const mdFileName = manuscriptId.toLowerCase() + '-demo.md';

    console.log(`\n--- ${manuscriptId} ---`);

    // Load or create demo JSON
    let demoData = null;
    const backendJsonPath = path.join(BACKEND_DIR, jsonFileName);
    if (fs.existsSync(backendJsonPath)) {
      demoData = JSON.parse(fs.readFileSync(backendJsonPath, 'utf-8'));
    } else {
      console.log(`  No existing demo JSON found, creating minimal one`);
      demoData = buildDemoJson(manuscriptId, '', 'N/A', [], [], [], []);
    }

    if (dryRun) {
      if (dasConfigured) console.log(`  [DRY RUN] Would call DAS Extractor API for ${pdfFile}`);
      if (markdownConfigured) console.log(`  [DRY RUN] Would call Markdown API (${markdownConfig.provider}) for ${pdfFile}`);
      console.log(`  [DRY RUN] Would update ${jsonFileName}`);
      if (markdownConfigured) console.log(`  [DRY RUN] Would write ${mdFileName}`);
      continue;
    }

    const pdfBuffer = fs.readFileSync(path.join(DEMO_FILES_DIR, pdfFile));

    // --- DAS Extraction ---
    if (dasConfigured) {
      try {
        console.log(`  Calling DAS Extractor API...`);
        const extractedDas = await dasExtractorClient.extractDAS(pdfBuffer, pdfFile);
        if (extractedDas && extractedDas.trim()) {
          demoData.das = extractedDas.trim();
          console.log(`  DAS extracted (${demoData.das.length} chars)`);
        } else {
          demoData.das = 'N/A';
          console.log(`  DAS not found, set to N/A`);
        }
      } catch (err) {
        console.error(`  DAS extraction failed: ${err.message}`);
        demoData.das = 'N/A';
      }
    }

    // --- Markdown Conversion ---
    if (markdownConfigured) {
      try {
        console.log(`  Calling Markdown API (${markdownConfig.provider})...`);
        const markdown = await pdfMarkdownClient.convertToMarkdown(pdfBuffer, pdfFile);
        if (markdown && markdown.trim()) {
          writeDemoMarkdown(manuscriptId, markdown);
          console.log(`  Markdown converted (${markdown.length} chars)`);
        } else {
          writeDemoMarkdown(manuscriptId, '');
          console.log(`  Markdown empty, wrote empty file`);
        }
      } catch (err) {
        console.error(`  Markdown conversion failed: ${err.message}`);
        writeDemoMarkdown(manuscriptId, '');
      }
    }

    // Write updated demo JSON
    writeDemoJson(manuscriptId, demoData);
  }

  console.log('\n=== Done ===');
}

// ===================== REFRESH ALL MODE =====================

/**
 * Discover all manuscripts from demo-files directory.
 * Returns an array of { manuscriptId, pdfFile, ds1File, krtFile } objects.
 * @returns {Array<Object>}
 */
function discoverManuscripts() {
  const files = fs.readdirSync(DEMO_FILES_DIR);
  const pdfFiles = files.filter(f => f.toLowerCase().endsWith('.pdf')).sort();

  return pdfFiles.map(pdfFile => {
    const manuscriptId = pdfFile.replace(/\.pdf$/i, '');
    const ds1File = files.find(f => f === `${manuscriptId}-DS1.xlsx`) || null;
    // KRT file: same manuscript ID, xlsx/csv/xls/ods, but NOT the -DS1 report
    const krtFile = files.find(f => {
      if (f === pdfFile || f === ds1File) return false;
      const base = f.replace(/\.(xlsx|csv|xls|ods)$/i, '');
      return base === manuscriptId && /\.(xlsx|csv|xls|ods)$/i.test(f);
    }) || null;

    return { manuscriptId, pdfFile, ds1File, krtFile };
  });
}

/**
 * Refresh all demo data: re-parse DS1 reports (internal) + call DAS/Markdown APIs.
 */
async function runRefreshAll() {
  const dryRun = args.includes('--dry-run');
  const onlyMissing = args.includes('--only-missing');

  // Load env vars from .env if dotenv is available
  try {
    require('dotenv').config({ path: path.join(__dirname, '../.env') });
  } catch {
    // dotenv not required
  }

  let manuscripts = discoverManuscripts();

  if (manuscripts.length === 0) {
    console.error(`No PDF files found in ${DEMO_FILES_DIR}`);
    process.exit(1);
  }

  const totalManuscriptCount = manuscripts.length;
  let skippedCount = 0;
  if (onlyMissing) {
    manuscripts = manuscripts.filter(m => !hasExistingDemoJson(m.manuscriptId));
    skippedCount = totalManuscriptCount - manuscripts.length;
  }

  // Import API clients and configs
  const dasExtractorConfig = require('../src/backend/config/pdf-das-extractor-api');
  const markdownConfig = require('../src/backend/config/pdf-markdown-api');
  const dasExtractorClient = require('../src/backend/services/pdf/pdf-das-extractor-client.service');
  const pdfMarkdownClient = require('../src/backend/services/pdf/pdf-markdown-client.service');

  const dasConfigured = dasExtractorConfig.isConfigured();
  const markdownConfigured = markdownConfig.isConfigured();

  console.log(`\n=== Refresh All Demo Data${dryRun ? ' (DRY RUN)' : ''}${onlyMissing ? ' (ONLY MISSING)' : ''} ===`);
  console.log(`Manuscripts found: ${totalManuscriptCount}${onlyMissing ? ` (${manuscripts.length} missing, ${skippedCount} already have demo JSON)` : ''}`);
  console.log(`  With DS1 reports: ${manuscripts.filter(m => m.ds1File).length}`);
  console.log(`  With KRT files:   ${manuscripts.filter(m => m.krtFile).length}`);
  console.log(`DAS Extractor API:  ${dasConfigured ? 'configured' : 'NOT configured (skipping)'}`);
  console.log(`Markdown API:       ${markdownConfigured ? `configured (${markdownConfig.provider})` : 'NOT configured (skipping)'}`);
  console.log('');

  if (manuscripts.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  for (const { manuscriptId, pdfFile, ds1File } of manuscripts) {
    console.log(`\n--- ${manuscriptId} ---`);

    // Step 1: Parse DS1 report (internal data)
    let demoData;
    if (ds1File) {
      const ds1Path = path.join(DEMO_FILES_DIR, ds1File);
      if (dryRun) {
        console.log(`  [DRY RUN] Would parse DS1 report: ${ds1File}`);
        // Load existing data for dry-run display
        const existingPath = path.join(BACKEND_DIR, manuscriptId.toLowerCase() + '-demo.json');
        demoData = fs.existsSync(existingPath)
          ? JSON.parse(fs.readFileSync(existingPath, 'utf-8'))
          : buildDemoJson(manuscriptId, '', 'N/A', [], [], [], []);
      } else {
        console.log(`  Parsing DS1 report: ${ds1File}`);
        const ds1Wb = XLSX.readFile(ds1Path);

        const datasetItems = parseDatasets(ds1Wb);
        const softwareItems = parseSoftware(ds1Wb);
        const protocolItems = parseProtocols(ds1Wb);
        const materialItems = parseMaterials(ds1Wb);

        // Preserve existing description and DAS if present
        const existingPath = path.join(BACKEND_DIR, manuscriptId.toLowerCase() + '-demo.json');
        let existingDescription = '';
        let existingDas = 'N/A';
        if (fs.existsSync(existingPath)) {
          const existing = JSON.parse(fs.readFileSync(existingPath, 'utf-8'));
          existingDescription = existing.description || '';
          existingDas = existing.das || 'N/A';
        }

        demoData = buildDemoJson(manuscriptId, existingDescription, existingDas, datasetItems, softwareItems, protocolItems, materialItems);

        console.log(`    Datasets: ${datasetItems.length}, Software: ${softwareItems.length}, Protocols: ${protocolItems.length}, Materials: ${materialItems.length}`);
      }
    } else {
      console.log(`  No DS1 report found, loading existing demo JSON`);
      const existingPath = path.join(BACKEND_DIR, manuscriptId.toLowerCase() + '-demo.json');
      demoData = fs.existsSync(existingPath)
        ? JSON.parse(fs.readFileSync(existingPath, 'utf-8'))
        : buildDemoJson(manuscriptId, '', 'N/A', [], [], [], []);
    }

    // Step 2: Call APIs (DAS + Markdown)
    if (dryRun) {
      if (dasConfigured) console.log(`  [DRY RUN] Would call DAS Extractor API for ${pdfFile}`);
      if (markdownConfigured) console.log(`  [DRY RUN] Would call Markdown API (${markdownConfig.provider}) for ${pdfFile}`);
      console.log(`  [DRY RUN] Would write ${manuscriptId.toLowerCase()}-demo.json`);
      if (markdownConfigured) console.log(`  [DRY RUN] Would write ${manuscriptId.toLowerCase()}-demo.md`);
      continue;
    }

    const pdfBuffer = fs.readFileSync(path.join(DEMO_FILES_DIR, pdfFile));

    // --- DAS Extraction ---
    if (dasConfigured) {
      try {
        console.log(`  Calling DAS Extractor API...`);
        const extractedDas = await dasExtractorClient.extractDAS(pdfBuffer, pdfFile);
        if (extractedDas && extractedDas.trim()) {
          demoData.das = extractedDas.trim();
          console.log(`  DAS extracted (${demoData.das.length} chars)`);
        } else {
          demoData.das = 'N/A';
          console.log(`  DAS not found, set to N/A`);
        }
      } catch (err) {
        console.error(`  DAS extraction failed: ${err.message}`);
        demoData.das = 'N/A';
      }
    }

    // --- Markdown Conversion ---
    if (markdownConfigured) {
      try {
        console.log(`  Calling Markdown API (${markdownConfig.provider})...`);
        const markdown = await pdfMarkdownClient.convertToMarkdown(pdfBuffer, pdfFile);
        if (markdown && markdown.trim()) {
          writeDemoMarkdown(manuscriptId, markdown);
          console.log(`  Markdown converted (${markdown.length} chars)`);
        } else {
          writeDemoMarkdown(manuscriptId, '');
          console.log(`  Markdown empty, wrote empty file`);
        }
      } catch (err) {
        console.error(`  Markdown conversion failed: ${err.message}`);
        writeDemoMarkdown(manuscriptId, '');
      }
    }

    // Write updated demo JSON
    writeDemoJson(manuscriptId, demoData);
  }

  console.log('\n=== Refresh All Done ===');
}
