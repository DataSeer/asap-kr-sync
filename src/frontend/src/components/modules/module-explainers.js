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
