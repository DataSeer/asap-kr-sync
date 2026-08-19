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
