/**
 * Candidate curation — the corrections we are certain of, applied before dedup.
 *
 * Detectors sometimes hand back a row that is simply the wrong KIND of thing,
 * and the rest of the pipeline cannot recover from it: `mergeDetections` only
 * merges rows that agree on the resource type, so a protocol typed as software
 * survives as a SECOND row next to the protocol row for the same DOI, and the
 * author is asked to add their own protocol to their KRT as a piece of code
 * (ASAP feedback, 2026-09).
 *
 * Observed on the two manuscripts the ASAP PM tested, all from the software LM
 * pass against its own prompt exclusions:
 *
 *   Software/code | protocols.io                        | https://www.protocols.io
 *   Software/code | Custom IP … preparation protocol    | 10.17504/protocols.io.3byl4wrj8vo5/v1
 *   Software/code | Custom FIJI macro                   | 10.17504/protocols.io.5jyl8xjzdv2w/v1
 *   Software/code | DNeasy Blood and Tissue kit         | (none)
 *   Software/code | ChemiDoc MP Imaging system          | (none)
 *   Chemical…     | 4% paraformaldehyde (PFA) in PBS    | (no source, no identifier)
 *
 * ── What belongs here, and what does not ────────────────────────────────────
 *
 * ONLY corrections that are true by the shape of the data, never by guessing
 * at meaning. Each rule below can be stated as a fact a curator would agree
 * with on sight, and each one is reversible by the user afterwards: a curated
 * row is retyped or dropped as a CANDIDATE, nothing in the author's own KRT is
 * touched. A rule that would need to weigh evidence belongs in the prompt or in
 * the LM consolidation, not here.
 *
 * ── Why here rather than in each detector ───────────────────────────────────
 *
 * `dedupeKrtItems` is the one call every detector already makes (it is stage 4
 * of the documented four-stage pipeline), so curating from inside it means the
 * next detector added cannot silently skip curation — the failure would be an
 * absence, which is the kind nobody notices.
 *
 * Every action is recorded on the returned `curationLog` so a run can say what
 * it changed and why, and so the tests can assert on reasons rather than on
 * row counts.
 */
'use strict';

const {
  canonicalResourceType,
  inferSourceFromIdentifier,
  isProtocolVenueSource
} = require('./identifier-normalize.service');

/**
 * Platforms that host other people's resources. A row whose NAME is the
 * platform, with no identifier of a record ON it, describes the website rather
 * than a resource used in the study — "methods are available in protocols.io"
 * is not a tool the authors used. The same row WITH a record identifier is a
 * real resource and is kept (and retyped by the protocol-venue rule when the
 * identifier says protocol).
 */
const PLATFORM_NAMES = new Set([
  'protocols.io', 'protocols io', 'protocolsio',
  'github', 'github.com', 'gitlab', 'gitlab.com', 'bitbucket', 'bitbucket.org',
  'zenodo', 'zenodo.org', 'figshare', 'figshare.com', 'dryad', 'datadryad',
  'open science framework', 'osf', 'osf.io',
  'addgene', 'addgene.org',
  'biorxiv', 'medrxiv', 'pubmed', 'ncbi', 'scicrunch', 'rrid'
]);

/**
 * A platform row is only dropped when its identifier points at the platform's
 * HOME rather than at a record: `https://www.protocols.io` yes,
 * `https://www.protocols.io/view/…` no.
 */
function isBarePlatformIdentifier(identifier) {
  const raw = String(identifier || '').trim();
  if (!raw) return true;
  const url = /^https?:\/\/([^/?#]+)(\/[^?#]*)?/i.exec(raw);
  if (!url) return false; // a DOI or accession is a record, not a home page
  const path = (url[2] || '').replace(/\/+$/, '');
  return path === '' || path === '/';
}

/** Assay kits and reagent packs: "… kit", "… assay", "… reagent pack". */
const KIT_RE = /\b(kit|assay kit|reagent pack|reagent kit)\b\s*(v?\d+(\.\d+)?)?$/i;

/**
 * Instruments and their bundled acquisition software. These are equipment, not
 * a shared research resource; the KRT has no dedicated type, so they land in
 * "Other" (the app's catch-all for tools and instruments).
 */
const INSTRUMENT_RE = /\b(imaging system|imager|scanner|microscope|spectrometer|cytometer|sequencer|centrifuge|ultracentrifuge|thermocycler|plate reader|workstation|concentrator|homogenizer|homogeniser|sonicator)\b/i;

/**
 * Solutions made at the bench: a recipe ("4% PFA in PBS", "PBS containing 2%
 * FBS"), or a generic buffer/medium name. These are not orderable resources —
 * and with neither a source nor an identifier such a row cannot pass KRT
 * validation anyway (SOURCE is required), so proposing it only creates work.
 * A buffer WITH a supplier or a catalog number is a purchased reagent and is
 * kept.
 */
const RECIPE_RE = /\d\s*(%|mm|mM|µm|um|ng|µg|ug|mg|m\b|x\b)|\b(\d+\s*(%|mM|mg\/ml))/;
const SOLUTION_BASE_RE = /\b(pbs|kpbs|dpbs|tbs-?t|tbst|tbs|saline|milk|buffer|medium|media|solution)\b/i;

/**
 * Generic solution names, matched against the WHOLE name (after dropping a
 * leading "1x" and any trailing "buffer"/"solution"), never as a prefix:
 * "PBS" is bench-made, "PBS-based antibody diluent kit from Vendor X" is a
 * product someone sells.
 */
const GENERIC_SOLUTION_NAMES = new Set([
  'pbs', 'kpbs', 'dpbs', 'tbs', 'tbst', 'tbs-t', 'pbst', 'pbs-t',
  'saline', 'milk', 'water', 'ddh2o', 'dh2o', 'ethanol', 'methanol', 'dmso', 'glycerol',
  'lysis', 'blocking', 'washing', 'wash', 'running', 'transfer', 'sample', 'loading',
  'elution', 'storage', 'reaction', 'binding'
]);

/** Types whose rows the solution rule may consider. */
const SOLUTION_TYPES = new Set(['chemical, peptide, or recombinant protein', 'other', '']);

const clean = (value) => String(value ?? '').trim();
const lower = (value) => clean(value).toLowerCase();

/**
 * True when a name describes something mixed at the bench rather than bought.
 * Either a generic solution name on its own, or a recipe (a concentration)
 * over a solution base.
 */
function isLabMadeSolution(name) {
  const n = clean(name);
  if (!n || n.length > 120) return false;

  // The whole name is a generic solution: "PBS", "1x TBS-T", "lysis buffer".
  const bare = lower(n)
    .replace(/^1\s*x\s+/, '')
    .replace(/\s*\((tbst|tbs-?t|pbs|pbst)\)$/, '')
    .replace(/\s+(buffer|solution)$/, '')
    .trim();
  if (GENERIC_SOLUTION_NAMES.has(bare)) return true;

  // Or it is a recipe over one: "4% PFA in PBS", "PBS containing 2% FBS".
  return RECIPE_RE.test(n) && SOLUTION_BASE_RE.test(n);
}

/**
 * Apply the certain corrections to one item.
 *
 * @param {object} item - KrtEntry
 * @returns {{ item: object|null, action: object|null }} `item: null` = drop
 */
function curateOne(item) {
  const type = canonicalResourceType(item.resourceType);
  const typeKey = lower(type);
  const name = clean(item.resourceName);
  const identifier = clean(item.identifier);
  const source = clean(item.source);

  // 1. A protocol-venue identifier IS a published protocol, whatever the
  //    detector called the row. protocols.io hosts methods, not code: the
  //    authors of both test manuscripts filed their FIJI-macro and
  //    CellProfiler-pipeline records as Protocol rows themselves, and listed
  //    the tools separately with their RRIDs.
  if (identifier && typeKey !== 'protocol') {
    const inferred = inferSourceFromIdentifier(identifier);
    if (isProtocolVenueSource(inferred)) {
      return {
        item: { ...item, resourceType: 'Protocol' },
        action: { rule: 'protocol-venue-identifier', outcome: 'retyped', from: type, to: 'Protocol', resourceName: name, identifier, detail: `identifier resolves to ${inferred}` }
      };
    }
  }

  // 2. The platform itself is not a resource the study used.
  if (PLATFORM_NAMES.has(lower(name)) && isBarePlatformIdentifier(identifier)) {
    return {
      item: null,
      action: { rule: 'platform-not-a-resource', outcome: 'dropped', from: type, resourceName: name, identifier, detail: 'the hosting platform, with no record identifier' }
    };
  }

  // 3. Kits and instruments the software pass picked up. Only from a
  //    Software/code row: a detector that already typed these correctly needs
  //    no help, and "kit" in another type's name is that detector's business.
  if (typeKey === 'software/code') {
    if (KIT_RE.test(name)) {
      return {
        item: { ...item, resourceType: 'Critical commercial assay' },
        action: { rule: 'kit-is-not-software', outcome: 'retyped', from: type, to: 'Critical commercial assay', resourceName: name, identifier }
      };
    }
    if (INSTRUMENT_RE.test(name)) {
      return {
        item: { ...item, resourceType: 'Other' },
        action: { rule: 'instrument-is-not-software', outcome: 'retyped', from: type, to: 'Other', resourceName: name, identifier, detail: 'instrument or its bundled acquisition software' }
      };
    }
  }

  // 4. Bench-made solutions with nothing to order them by. Kept when a
  //    supplier or a catalog number is present — that is a purchased reagent.
  if (SOLUTION_TYPES.has(typeKey) && !identifier && !source && isLabMadeSolution(name)) {
    return {
      item: null,
      action: { rule: 'lab-made-solution', outcome: 'dropped', from: type, resourceName: name, detail: 'no source and no identifier — cannot pass KRT validation' }
    };
  }

  return { item, action: null };
}

/**
 * Curate a detector's candidates.
 *
 * Pure: returns new items, never mutates the input.
 *
 * @param {object[]} items - KrtEntry[]
 * @param {string} [origin] - detector label, recorded on each log entry
 * @returns {{ items: object[], curationLog: object[] }}
 */
function curateCandidates(items = [], origin = '') {
  if (!Array.isArray(items) || items.length === 0) return { items: [], curationLog: [] };

  const kept = [];
  const curationLog = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const { item: curated, action } = curateOne(item);
    if (action) curationLog.push(origin ? { ...action, origin } : action);
    if (curated) kept.push(curated);
  }
  return { items: kept, curationLog };
}

module.exports = {
  curateCandidates,
  // Exposed for tests and for callers that want one item's verdict.
  curateOne,
  isLabMadeSolution,
  isBarePlatformIdentifier
};
