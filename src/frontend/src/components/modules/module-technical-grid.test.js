/**
 * The Technical detail rows have to add up.
 *
 * The section is a CSS grid with a fixed track count, and each block declares
 * its own span — deliberately, because any block can be absent (a module with
 * no prompt or no stored artefacts simply omits one). The cost of that is that
 * nothing checks the totals.
 *
 * It stopped adding up once before, when Metadata was added as a fourth short
 * list and the spans were left alone: a block could not fit in the tracks that
 * remained and wrapped, leaving the row above ragged and half empty. Invisible
 * until someone opens the section on a wide screen.
 *
 * The layout is now two rows — three short label/value lists, then the two
 * lists of links — because five abreast made every track narrower than its
 * content. Both rows have to fill the width, so the arithmetic is done here
 * instead of by eye, and over the blocks that are actually in the template
 * rather than a remembered list of them.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(import.meta.dirname, 'ModuleTechnical.vue'), 'utf8')

/** Just the `<style>` block, so template text cannot be mistaken for CSS. */
const STYLE = SOURCE.slice(SOURCE.indexOf('<style'))

/** The grid's track count, from the first (widest) definition. */
function trackCount() {
  const match = STYLE.match(/\.mt-body\s*\{[^}]*grid-template-columns:\s*repeat\((\d+),/)
  expect(match, 'the grid must declare a fixed track count').toBeTruthy()
  return Number(match[1])
}

/** The span a class declares, from the first (widest) rule for it. */
function spanOf(className) {
  const match = STYLE.match(new RegExp(`\\.${className}\\s*\\{\\s*grid-column:\\s*span\\s*(\\d+)`))
  expect(match, `.${className} must declare a span`).toBeTruthy()
  return Number(match[1])
}

/**
 * Every block in the template, with the span class it carries.
 *
 * Read from the template rather than listed here: a block added without a span
 * class, or with a new one, has to show up in the total — that is the whole
 * point of checking.
 */
function blocks() {
  return [...SOURCE.matchAll(/class="mt-block (mt-[a-z]+)"/g)].map((m) => m[1])
}

describe('the Technical detail grid', () => {
  it('fills each row exactly — no empty track, nothing forced to wrap', () => {
    const tracks = trackCount()
    const totalOf = (className) =>
      blocks().filter((c) => c === className).length * spanOf(className)

    // Row 1: Metadata, Configuration, Statistics. Row 2: inputs, outputs.
    expect(totalOf('mt-narrow'), 'the short lists must fill their row').toBe(tracks)
    expect(totalOf('mt-wide'), 'the link lists must fill theirs').toBe(tracks)
  })

  it('puts the link lists on a row of their own, below the short lists', () => {
    // Auto-placement is what makes the two rows, so DOM order is load-bearing:
    // a wide block moved above a narrow one would drag it up into row 1.
    const order = blocks()
    const lastNarrow = order.lastIndexOf('mt-narrow')
    const firstWide = order.indexOf('mt-wide')

    expect(firstWide).toBeGreaterThan(lastNarrow)
  })

  it('is the five columns the headings promise', () => {
    // Metadata, Configuration, Statistics, Module inputs, Module outputs. If a
    // sixth block appears, the check above starts failing and this says why.
    expect(blocks()).toHaveLength(5)
  })

  it('gives the short label/value lists a third of the width each', () => {
    const narrow = blocks().filter((c) => c === 'mt-narrow')

    expect(narrow).toHaveLength(3)
    expect(spanOf('mt-narrow') * 3).toBe(trackCount())
  })

  it('gives the two link lists half the width each', () => {
    // They carry file names and an explanatory note, so they need more room
    // than a label/value list — half a row rather than a third.
    expect(blocks().filter((c) => c === 'mt-wide')).toHaveLength(2)
    expect(spanOf('mt-wide') * 2).toBe(trackCount())
    expect(spanOf('mt-wide')).toBeGreaterThan(spanOf('mt-narrow'))
  })

  it('every block carries a span class the stylesheet defines', () => {
    // A block with a class that has no rule silently gets span 1 and throws the
    // total off by however many tracks it should have taken.
    for (const className of new Set(blocks())) {
      expect(STYLE, `.${className} is used but never defined`).toMatch(
        new RegExp(`\\.${className}\\s*\\{`)
      )
    }
  })

  it('collapses to tracks the content fits in on narrower screens', () => {
    // Three short lists abreast is too tight below this width.
    expect(STYLE).toMatch(/@media \(max-width: 1099px\)[\s\S]*?grid-template-columns: repeat\(2,/)
    expect(STYLE).toMatch(/@media \(max-width: 640px\)[\s\S]*?grid-template-columns: minmax/)
  })

  it('keeps the two-track row adding up too', () => {
    // At the middle breakpoint the narrow blocks pair off and each wide block
    // takes a row: 1 + 1 = 2, and .mt-wide is re-declared to span 2.
    const middle = STYLE.match(/@media \(max-width: 1099px\)\s*\{([\s\S]*?)\n\}/)
    expect(middle).toBeTruthy()
    expect(middle[1]).toMatch(/\.mt-wide\s*\{\s*grid-column:\s*span\s*2/)
  })
})
