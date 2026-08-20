/**
 * Display names and one-line purposes for each pipeline step.
 *
 * Presentation only — the STRUCTURE (which steps exist, what they wait for,
 * which stage they sit in) comes from the server's pipeline graph. Keeping the
 * two apart is deliberate: a new step appears in the graph automatically, and
 * the worst that happens here is it shows under its raw job type until someone
 * writes it a sentence.
 */

export const MODULE_META = {
  markdown_convert: { label: 'Markdown Convert', purpose: 'Turns the manuscript PDF into text everything else reads.' },
  orcid_extraction: { label: 'ORCID Extraction', purpose: 'Finds the authors and their ORCID identifiers.' },
  das_extraction: { label: 'DAS Extraction', purpose: 'Locates the Data Availability Statement.' },
  software_detection: { label: 'Software Detection', purpose: 'Finds software and code, by name recognition and an LM pass.' },
  datasets_detection: { label: 'Datasets Detection', purpose: 'Finds datasets and the repositories they live in.' },
  materials_detection: { label: 'Materials Detection', purpose: 'Finds lab materials — antibodies, plasmids, cell lines, organisms.' },
  protocols_detection: { label: 'Protocols Detection', purpose: 'Finds experimental protocols and methods.' },
  identifier_detection: { label: 'Identifiers Detection', purpose: 'Scans for known identifiers — RRIDs, DOIs, accessions.' },
  krt_grounding: { label: 'KRT Grounding', purpose: 'Checks each row of your KRT against the manuscript. Never edits a row.' },
  pdf_analysis: { label: 'PDF Analysis', purpose: 'Merges every detection into one Generated KRT.' },
  suggestion_generation: { label: 'AI Suggestions', purpose: 'Compares your KRT with the generated one and proposes changes.' }
}

/**
 * Stage names, by depth in the graph.
 *
 * The depths are computed server-side; these only name them. An unnamed depth
 * falls back to "Stage N", which is how a newly added stage behaves until it
 * gets a word.
 */
export const STAGE_LABELS = ['Ingest', 'Detect', 'Reconcile', 'Consolidate', 'Suggest']


/**
 * Every module, in the order the panel lays them out.
 *
 * Derived from MODULE_META rather than repeated: the panel, the pipeline page
 * and the module page each kept their own copy of these eleven strings, and
 * they had already drifted — the pipeline page's comment still said "only
 * krt_grounding has a page so far" while listing all eleven.
 */
export const ALL_JOB_TYPES = Object.entries(MODULE_META).map(([type, m]) => ({ type, label: m.label }))

/**
 * Modules with a dedicated results page. Currently every module has one, but a
 * new step appears in the server's graph before its page exists, and a tab or a
 * tile linking to an empty page is worse than one that does not link at all —
 * so this stays an explicit set rather than "all of them".
 */
export const MODULE_PAGE_TYPES = new Set(Object.keys(MODULE_META))

export const hasModulePage = (jobType) => MODULE_PAGE_TYPES.has(jobType)

export const labelFor = (jobType) => MODULE_META[jobType]?.label || jobType
export const purposeFor = (jobType) => MODULE_META[jobType]?.purpose || ''
export const stageLabel = (i) => STAGE_LABELS[i] || `Stage ${i + 1}`
