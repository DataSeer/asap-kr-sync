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
        q: 'The Modules column',
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
        a: 'By a dedup key built from the name and identifier, not by similarity — two detections '
          + 'merge when they resolve to the same resource, and stay apart when they do not. Hover '
          + 'the "N detections → 1 row" label to see the key.'
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
    summary: 'Turns the manuscript PDF into plain text. Everything downstream reads that text and '
      + 'nothing else, so whatever is lost here is invisible to every other module.',
    points: [
      {
        q: 'Why it matters more than it looks',
        a: 'No module reads the PDF. If a resource is only named inside a figure image, a scanned '
          + 'page or a table the converter mangled, no amount of detection will find it — the word '
          + 'is simply not in the text the models are given.'
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
    summary: 'Reads the author list off the front matter of the manuscript and pairs each name with '
      + 'an ORCID identifier where the paper prints one.',
    points: [
      {
        q: 'Where the ORCIDs come from',
        a: 'Only from the manuscript itself. Nothing is looked up in an external registry, so an '
          + 'author whose ORCID is not printed in the paper will appear without one rather than '
          + 'with a guessed match.'
      },
      {
        q: 'The Source column',
        a: 'Which part of the document a row came from — the byline, a footnote, or the '
          + 'corresponding-author block. It is there so a surprising row can be traced back.'
      },
      {
        q: 'What it cannot do',
        a: 'It cannot tell two researchers with the same name apart, and it does not resolve an '
          + 'ORCID to check the name matches. Affiliations come out as printed, superscript '
          + 'markers and all.'
      }
    ]
  },

  das_extraction: {
    title: 'DAS Extraction',
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
    summary: 'Finds the software and code this study used, by two methods at once: a name '
      + 'recogniser trained on scientific prose, and a language model reading the manuscript.',
    points: [
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
        a: 'Software mentioned only in a figure, in an image, or in words that never name it. '
          + 'It reads the converted text of the PDF, so anything lost in conversion is invisible.'
      }
    ]
  },

  datasets_detection: {
    title: 'Datasets Detection',
    summary: 'Finds the datasets this study generated or reused, and the repositories they live '
      + 'in — accessions, DOIs and repository links.',
    points: [
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
    summary: 'Finds the experimental protocols and methods this study used, including protocols '
      + 'published on dedicated venues.',
    points: [
      {
        q: 'What counts as a protocol',
        a: 'A repeatable procedure describing HOW something was done — usually one per Methods '
          + 'sub-section. A single software invocation is not a protocol; a multi-step '
          + 'bespoke workflow can be.'
      },
      {
        q: 'Published protocols',
        a: 'A DOI from a protocol-publishing venue is recognised on sight, so a cited protocol '
          + 'is found even where the manuscript does not describe its steps.'
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
    summary: 'Scans the manuscript for identifiers it already knows — RRIDs, DOIs, accessions and '
      + 'catalogue numbers — and reports what each one refers to.',
    points: [
      {
        q: 'How this differs from the other detectors',
        a: 'No language model is involved. It matches identifiers in the text against a curated '
          + 'list, so a result here means the identifier is literally in the manuscript. That '
          + 'also makes it the only detector whose output is identical on every run.'
      },
      {
        q: 'Why it spans every resource type',
        a: 'An identifier says what a thing IS, so one scan produces software, datasets, '
          + 'materials and protocols together — which is why this table has type tabs and the '
          + 'others do not.'
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
    summary: 'Reads the manuscript and reports the lab materials it can evidence — antibodies, '
      + 'plasmids, cell lines, organisms and the rest — each with the sentence that supports it.',
    points: [
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
  }
}

/** @param {string} jobType @returns {object|null} */
export function explainerFor(jobType) {
  return MODULE_EXPLAINERS[jobType] || null
}
