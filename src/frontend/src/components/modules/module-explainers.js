/**
 * What each module does, in the words a curator needs.
 *
 * Kept as data rather than markup so the same text can appear on the module
 * page, in a tooltip, or anywhere else without being rewritten — and so a
 * correction lands in one place.
 *
 * The rule for writing these: answer the question the reader actually has
 * ("why does this say my row is missing when it is right there?"), not the
 * question the code would ask. Name the limits explicitly; a module that
 * quietly cannot do something is worse than one that says so.
 */

export const MODULE_EXPLAINERS = {
  suggestion_generation: {
    title: 'AI Suggestions',
    doc: '310-suggestion_generation--ai-suggestions-krt-comparison',
    summary: 'Compares your KRT with the Generated one row by row and proposes changes. It only '
      + 'proposes — every decision here waits for you, and nothing in your table has been touched.',
    points: [
      {
        q: 'The four decisions',
        a: '"Add" — found in the manuscript, absent from your table. "Update" — matched to one of '
          + 'your rows, with a differing field. "Remove" — your row could not be supported. '
          + '"Skip" — matched and already correct, which is the outcome you want most of the time.'
      },
      {
        q: 'Reading an Update',
        a: 'Two lines: your row, then the generated one. Only the fields that differ are marked — '
          + 'struck through on yours, highlighted on the proposal. Everything else is identical and '
          + 'is shown so the row still reads as a row.'
      },
      {
        q: 'The "Detected by" column',
        a: 'Which detectors backed the proposal. A decision resting on one module is weaker than '
          + 'one several found independently, and this is where to see the difference.'
      },
      {
        q: 'What it is not',
        a: 'It is not a verdict on your table, and a "Remove" is not proof the resource is absent — '
          + 'it means the pipeline could not support it from the converted text. Check KRT '
          + 'Grounding for that row before acting on it.'
      }
    ]
  },

  pdf_analysis: {
    title: 'PDF Analysis',
    doc: '39-pdf_analysis--the-generated-krt-lm-primary-rule-based-fallback',
    summary: 'Merges every detection into one Generated KRT — the table the app would propose if '
      + 'it were writing your KRT from scratch. Nothing here touches your own KRT.',
    points: [
      {
        q: 'Why one row appears several times',
        a: 'It does not. Lines sharing a KRT # are one row, shown once per detection module that '
          + 'found it, each with the values THAT module produced. It is the only place you can see '
          + 'two modules disagreeing about a name or an identifier before the merge picked one.'
      },
      {
        q: 'How rows get merged',
        a: 'By an exact key, never by similarity: resource type + new/reuse + a normalised '
          + 'identifier token — or, when neither detection carries an identifier, the normalised '
          + 'name. So the same name filed under two different types stays two rows, which is '
          + 'usually a classification disagreement worth seeing. Hover "N detections → 1 row" '
          + 'for the key.'
      },
      {
        q: 'Dropped candidates',
        a: 'Detections that were NOT kept, with a reason each. Worth reading when something you '
          + 'expected is missing: it usually means the item was judged out of scope or its quote '
          + 'could not be verified in the manuscript, not that no module saw it.'
      },
      {
        q: 'Its relationship to your KRT',
        a: 'None, directly. The Generated KRT is an independent proposal; AI Suggestions is the '
          + 'step that compares the two and proposes changes. Your rows are never edited here.'
      }
    ]
  },

  markdown_convert: {
    title: 'Markdown Convert',
    doc: '31-markdown_convert--pdf--markdown',
    summary: 'Turns the manuscript PDF into plain text. Almost everything downstream reads that '
      + 'text and nothing else, so whatever is lost here is invisible to those modules.',
    points: [
      {
        q: 'Why it matters more than it looks',
        a: 'Nearly every module reads this text rather than the PDF. If a resource is only named '
          + 'inside a figure image, a scanned page or a table the converter mangled, those modules '
          + 'cannot find it — the word is simply not in the text they are given. Two exceptions '
          + 'read the PDF itself: Softcite, the name-recogniser half of Software Detection, and '
          + 'ORCID Extraction, which parses the front matter. So a tool named in a mangled table '
          + 'can still surface through Softcite.'
      },
      {
        q: 'What tends to be lost',
        a: 'Text baked into figures, some table layouts, and occasionally a supplementary section. '
          + 'Ligatures and hyphenation across line breaks are usually preserved but can split a '
          + 'name in two, which is why matching elsewhere ignores spacing and hyphens.'
      },
      {
        q: 'Reading the converted text yourself',
        a: 'The converted markdown is downloadable under Technical detail. When a row you know is '
          + 'in the paper comes back "not found", searching that file is the fastest way to tell a '
          + 'detection failure from a conversion one.'
      }
    ]
  },

  orcid_extraction: {
    title: 'ORCID Extraction',
    doc: '38-orcid_extraction--authors--orcids',
    summary: 'Reads the author list off the front matter of the manuscript and pairs each name with '
      + 'an ORCID identifier where the paper prints one.',
    points: [
      {
        q: 'Three sources, in order of trust',
        a: 'GROBID parses the PDF header for authors, the DOI and any ORCIDs printed in the '
          + 'paper. If a DOI was found, OpenAlex supplies verified author↔ORCID pairs. Anything '
          + 'still missing falls back to a capped ORCID public-API lookup that accepts only a '
          + 'unique match.'
      },
      {
        q: 'The Source column',
        a: 'Which of those supplied the row, and therefore how much to trust it. '
          + '"GROBID + OpenAlex" means two sources agreed and is the strongest; a single source '
          + 'is weaker. It is the fastest way to spot an ORCID that came from a lookup rather '
          + 'than from the manuscript.'
      },
      {
        q: 'What it cannot do',
        a: 'The ORCID API fallback matches on name, so two researchers who publish under the '
          + 'same name cannot be told apart — that is why it is capped and restricted to unique '
          + 'matches. Affiliations come out as printed, superscript markers and all.'
      }
    ]
  },

  das_extraction: {
    title: 'DAS Extraction',
    doc: '32-das_extraction--data-availability-statement',
    summary: 'Locates the Data Availability Statement — the paragraph where the authors say where '
      + 'their data and code can be found — and extracts it verbatim.',
    points: [
      {
        q: 'Why the pipeline wants it',
        a: 'It is the densest source of accessions and repository links in most papers, and it is '
          + 'written by the authors as a promise about where things live. Datasets detection reads '
          + 'it alongside the rest of the text.'
      },
      {
        q: 'It is copied, not summarised',
        a: 'The statement is extracted as written. If it is vague ("available on reasonable '
          + 'request"), that vagueness is preserved rather than resolved — which is itself worth '
          + 'seeing.'
      },
      {
        q: 'When nothing is found',
        a: 'Many manuscripts have no such section, and some hide it in the acknowledgements or the '
          + 'supplementary material. An empty result means no statement was located in the '
          + 'converted text, not that the authors made no data available.'
      }
    ]
  },

  krt_grounding: {
    title: 'KRT Grounding',
    doc: '37b-krt_grounding--author-krt--manuscript-reconciliation',
    summary: 'Checks every row of your Key Resources Table against the manuscript, '
      + 'and never changes a row. It answers two separate questions per row: is this resource '
      + 'mentioned in the paper at all, and did our detection modules independently find it?',
    points: [
      {
        q: 'Where "Found" comes from',
        a: 'A direct search of the converted manuscript for the row\'s own RESOURCE NAME and '
          + 'IDENTIFIER. It does not depend on any detection module, so it means the same thing '
          + 'whatever the rest of the pipeline did.'
      },
      {
        q: 'Yes / Yes - id / Yes - name',
        a: 'Which of the two fields was located. "Yes" means both, which is the strongest result. '
          + '"Yes - id" means the paper cites the identifier but writes the name differently; '
          + '"Yes - name" the reverse.'
      },
      {
        q: 'Punctuation is ignored',
        a: 'The manuscript often breaks words around hyphens and spaces — it may print '
          + '"anti -TagFP" where your row says "anti-TagFP", or "ImageJ" where your row says '
          + '"Image J". Those count as found. The match is still exact once spacing and hyphens '
          + 'are set aside; nothing is guessed.'
      },
      {
        q: '"Partial match"',
        a: 'Something related was located but not the row itself — part of the name, or a match '
          + 'only our targeted LM search could make. Worth a glance: it is weaker evidence than '
          + 'a direct hit, and occasionally the LM attaches a nearby sentence to the wrong row.'
      },
      {
        q: '"No"',
        a: 'Neither the name nor the identifier occurs in the manuscript. That usually means a '
          + 'citation gap worth checking — but it can also mean the paper describes the resource '
          + 'in words rather than naming it. Your row is kept exactly as written.'
      },
      {
        q: '"Incoherence"',
        a: 'A value in your row disagrees with what the manuscript states — most often an '
          + 'identifier. One of the two is wrong, and only a human can say which. Your row is '
          + 'never altered; the differing characters are highlighted so you can see what changed.'
      },
      {
        q: 'What it cannot do',
        a: 'It reads the converted text of the PDF, so anything lost in conversion (an image, a '
          + 'malformed table) is invisible to it. A resource described without naming it will '
          + 'read as "No". It never edits, removes or reorders your rows.'
      }
    ]
  },

  software_detection: {
    title: 'Software Detection',
    doc: '33-software_detection--software--code',
    summary: 'Finds the software and code this study used, by two methods at once: a name '
      + 'recogniser trained on scientific prose, and a language model reading the manuscript.',
    points: [
      {
        q: 'When it runs',
        a: 'After the manuscript is converted AND you have validated your Key Resources Table. '
          + 'This module reads no KRT itself, but the whole detection stage starts together so the results '
          + 'arrive as one set rather than trickling in while you are still editing.'
      },
      {
        q: 'Why two engines',
        a: 'They miss different things. Softcite recognises tool names written in ordinary '
          + 'sentences; the LM pass is better at identifiers, repository links and code written '
          + 'for this paper. A row found by both is stronger evidence than either alone, and the '
          + 'badges say which found it.'
      },
      {
        q: 'The "Softcite" and "LM" badges',
        a: 'Which engine found the row. Two badges means both did, independently — the row was '
          + 'merged rather than counted twice.'
      },
      {
        q: 'What it will miss',
        a: 'Software mentioned only in a figure, in an image, or in words that never name it. The '
          + 'LM half reads the converted text, so anything lost in conversion is invisible to it; '
          + 'Softcite reads the PDF directly and is not limited that way.'
      },
      {
        q: 'Instrument software is removed on purpose',
        a: 'Software that only drives an instrument — ZEN, NIS-Elements, LAS X, MetaMorph, '
          + 'cellSens, SoftMax Pro, Gen5, FACSDiva and others — is dropped even when the '
          + 'manuscript names it plainly. It is acquisition machinery rather than a key resource. '
          + 'If you expected one of these and it is absent, that is why, and nothing is wrong with '
          + 'the detection.'
      }
    ]
  },

  datasets_detection: {
    title: 'Datasets Detection',
    doc: '34-datasets_detection--datasets-two-pass',
    summary: 'Finds the datasets this study generated or reused, and the repositories they live '
      + 'in — accessions, DOIs and repository links.',
    points: [
      {
        q: 'When it runs',
        a: 'After the manuscript is converted AND you have validated your Key Resources Table — '
          + 'your dataset rows are given to the model as a starting point, so it waits until you have '
          + 'finished editing them.'
      },
      {
        q: 'How a dataset is recognised',
        a: 'A first pass pulls candidate mentions from the manuscript with their exact position '
          + 'in the text. A second pass consolidates those into one row per dataset, merging the '
          + 'same dataset mentioned several ways.'
      },
      {
        q: 'Why some mentions do not appear',
        a: 'A candidate whose span cannot be located in the manuscript is dropped before you see '
          + 'it. That guard exists because the model once padded a sparse paper with examples '
          + 'from its own instructions — real-looking accessions for datasets the paper never '
          + 'mentions.'
      },
      {
        q: 'Generated or reused',
        a: 'NEW/REUSE reflects what the manuscript says about the dataset, not where it is '
          + 'stored. A dataset deposited by this study is new; one downloaded from a public '
          + 'repository is reuse.'
      }
    ]
  },

  protocols_detection: {
    title: 'Protocols Detection',
    doc: '36-protocols_detection--protocols',
    summary: 'Finds the experimental protocols and methods this study used, including protocols '
      + 'published on dedicated venues.',
    points: [
      {
        q: 'When it runs',
        a: 'After the manuscript is converted AND you have validated your Key Resources Table — '
          + 'your protocol rows are given to the model as a starting point.'
      },
      {
        q: 'What counts as a protocol',
        a: 'A repeatable procedure describing HOW something was done — usually one per Methods '
          + 'sub-section. A single software invocation is not a protocol; a multi-step '
          + 'bespoke workflow can be.'
      },
      {
        q: 'Published protocols',
        a: 'The model is told to treat a protocols.io DOI or another protocol-repository link as '
          + 'the protocol\'s identifier, so a cited protocol can be picked up even where the '
          + 'manuscript does not describe its steps. It is an instruction, not a guaranteed '
          + 'scan — Identifiers Detection is the module that matches identifiers literally.'
      },
      {
        q: 'What it will miss',
        a: 'A method described only in supplementary material that was not converted, and '
          + 'procedures referred to purely by citation with no description.'
      }
    ]
  },

  identifier_detection: {
    title: 'Identifiers Detection',
    doc: '37-identifier_detection--known-identifier-scan-local-enabled-by-default',
    summary: 'Scans the manuscript for identifiers it already knows — RRIDs, DOIs, accessions and '
      + 'catalogue numbers — and reports what each one refers to.',
    points: [
      {
        q: 'When it runs',
        a: 'After the manuscript is converted AND you have validated your Key Resources Table. '
          + 'The scan itself never reads your table; it waits so the whole detection stage starts at one '
          + 'moment.'
      },
      {
        q: 'How this differs from the other detectors',
        a: 'No language model is involved. It matches identifiers in the text against a curated '
          + 'list, so a result here means the identifier is literally in the manuscript. That '
          + 'also makes it the only detector whose output is identical on every run.'
      },
      {
        q: 'Why it spans every resource type',
        a: 'An identifier says what a thing IS, so one scan produces software, datasets, '
          + 'materials and protocols together. It is the only module whose table fills more '
          + 'than one type tab — the others each produce a single kind.'
      },
      {
        q: 'What it will miss',
        a: 'Any identifier not on the list, and any resource the manuscript names without '
          + 'citing an identifier for it.'
      }
    ]
  },

  materials_detection: {
    title: 'Materials Detection',
    doc: '35-materials_detection--lab-materials-cue-driven',
    summary: 'Reads the manuscript and reports the lab materials it can evidence — antibodies, '
      + 'plasmids, cell lines, organisms and the rest — each with the sentence that supports it.',
    points: [
      {
        q: 'When it runs',
        a: 'After the manuscript is converted AND you have validated your Key Resources Table — '
          + 'your material rows seed the prompt. With no materials in your table it still runs, using the '
          + 'discovery prompt instead.'
      },
      {
        q: 'Where the rows come from',
        a: 'A language model reading the converted manuscript. Every row it returns must carry a '
          + 'quote; the app then checks that quote against the text itself.'
      },
      {
        q: 'The "KRT" tag',
        a: 'This resource is also a row in your Key Resources Table. The model was shown your '
          + 'table, so a tagged row may be one it found in the paper or one it simply copied '
          + 'back — the evidence column tells you which.'
      },
      {
        q: '"not verbatim"',
        a: 'The resource is in the manuscript, but the exact sentence the model quoted is not. '
          + 'The paragraph shown underneath is where the resource actually appears. Nothing is '
          + 'presented as a quotation unless it was found word for word.'
      },
      {
        q: 'What was discarded',
        a: 'Anything whose quote AND whose resource were both absent from the manuscript is '
          + 'dropped before you see it, rather than shown with a caveat.'
      }
    ]
  },

  das_suggestions: {
    title: 'DAS Suggestions',
    doc: '311-das_suggestions--availability-statement-check-das-suggestions',
    summary: 'Checks your Data/Code Availability Statement against the ASAP rulebook, using what '
      + 'your Key Resources Table says. It proposes wording; it never edits your statement.',
    points: [
      {
        q: 'Why it waits until the Availability step',
        a: 'It is part of the pipeline, but held back rather than run as soon as the statement is '
          + 'extracted. Two things release it: your submission reaching the Availability step, and '
          + 'you confirming the statement is the right passage. Until you confirm, it sits waiting '
          + 'and spends nothing — a check of the wrong paragraph is worse than no check, and it '
          + 'would be reported as yours. Once you confirm, it runs on its own; you do not have to '
          + 'ask for it.'
      },
      {
        q: 'Re-running it',
        a: 'Editing your statement clears the confirmation, so an edited statement is confirmed '
          + 'again rather than silently re-checked against the old text. You can also ask for a '
          + 'fresh check at any time from the Availability step.'
      },
      {
        q: 'What the model actually decides',
        a: 'Only whether each rule applies to your submission, and why. The rules themselves — '
          + 'their wording, their severity and the text they recommend — are fixed on the server, '
          + 'so the advice cannot drift from ASAP guidance run to run.'
      },
      {
        q: 'Why passed checks are shown too',
        a: 'A rule that did not fire is a check that passed, and it is listed for that reason: '
          + 'otherwise a clean statement and a statement nobody checked look identical.'
      },
      {
        q: 'The suggested wording',
        a: 'Where the rulebook has a sentence for a situation, it is offered verbatim to paste '
          + 'into your statement — with the placeholders left in for you to fill.'
      }
    ]
  }
}

/** @param {string} jobType @returns {object|null} */
export function explainerFor(jobType) {
  return MODULE_EXPLAINERS[jobType] || null
}
