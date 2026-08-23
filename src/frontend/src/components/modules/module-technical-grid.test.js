/**
 * The Technical detail row has to add up.
 *
 * The section is a CSS grid with a fixed track count, and each block declares
 * its own span — deliberately, because any block can be absent (a module with
 * no prompt or no stored artefacts simply omits one). The cost of that is that
 * nothing checks the total.
 *
 * It stopped adding up when Metadata was added as a fourth short list and the
 * spans were left alone: 1 + 1 + 1 + 2 + 2 = 7 in a six-track grid, so Module
 * outputs could not fit in the one track that remained and wrapped to a row of
 * its own, leaving the row above ragged and half empty. Invisible until someone
 * opens the section on a wide screen.
 *
 * So the arithmetic is done here instead of by eye, and over the blocks that
 * are actually in the template rather than a remembered list of them.
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
  it('fills its row exactly — no empty track, nothing forced to wrap', () => {
    const total = blocks().reduce((sum, className) => sum + spanOf(className), 0)

    expect(total).toBe(trackCount())
  })

  it('is the five columns the headings promise', () => {
    // Metadata, Configuration, Statistics, Module inputs, Module outputs. If a
    // sixth block appears, the check above starts failing and this says why.
    expect(blocks()).toHaveLength(5)
  })

  it('gives the short label/value lists one track each', () => {
    const narrow = blocks().filter((c) => c === 'mt-narrow')

    expect(narrow).toHaveLength(3)
    expect(spanOf('mt-narrow')).toBe(1)
  })

  it('gives the two link lists more room than a label/value list', () => {
    // They carry file names and an explanatory note, and they were what wrapped
    // awkwardly while the short lists sat half empty.
    expect(blocks().filter((c) => c === 'mt-wide')).toHaveLength(2)
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
    // A seven-track grid puts each block in something narrower than a file name.
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
