/**
 * The Technical detail row has to add up.
 *
 * The section is a CSS grid with a fixed track count, and each block declares
 * its own span — deliberately, because any block can be absent (a module with
 * no prompt or no stored artefacts simply omits one). The cost of that is that
 * nothing checks the total.
 *
 * It stopped adding up when Metadata was added as a fourth short list and the
 * spans were left alone: 1 + 1 + 1 + 2 = 5 in a six-track grid, so the row
 * ended with an empty track, and Module outputs — 2 wide — could not fit in the
 * 1 that remained and wrapped to a row of its own. The result read as a ragged
 * half-empty row rather than a layout, and it is invisible until somebody opens
 * the section on a wide screen.
 *
 * So the arithmetic is done here instead of by eye.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(import.meta.dirname, 'ModuleTechnical.vue'), 'utf8')

/** The grid's track count, from the first (widest) definition. */
function trackCount() {
  const match = SOURCE.match(/\.mt-body\s*\{[^}]*grid-template-columns:\s*repeat\((\d+),/)
  expect(match, 'the grid must declare a fixed track count').toBeTruthy()
  return Number(match[1])
}

/** The span a class declares, from the first (widest) rule for it. */
function spanOf(className) {
  const match = SOURCE.match(new RegExp(`\\.${className}\\s*\\{\\s*grid-column:\\s*span\\s*(\\d+)`))
  expect(match, `.${className} must declare a span`).toBeTruthy()
  return Number(match[1])
}

/** How many blocks in the template carry a class. */
function blocksWith(className) {
  return SOURCE.split('\n').filter((line) =>
    line.includes('mt-block') && line.includes(className)
  ).length
    // The inputs block spreads its attributes over several lines, so its class
    // sits on a line of its own.
    || SOURCE.split('\n').filter((line) => line.trim() === `class="mt-block ${className}"`).length
}

describe('the Technical detail grid', () => {
  it('fills its first row exactly — no empty track, nothing forced to wrap', () => {
    const tracks = trackCount()
    const narrowBlocks = blocksWith('mt-narrow')
    const firstRow = narrowBlocks * spanOf('mt-narrow') + spanOf('mt-wide')

    expect(firstRow).toBe(tracks)
  })

  it('has the short lists it thinks it has', () => {
    // If a fourth short list is added, the check above starts failing and this
    // says why: the count changed, so `.mt-wide` has to give a track back.
    expect(blocksWith('mt-narrow')).toBe(3)
  })

  it('gives Module outputs a full row rather than a span that must fit', () => {
    // It is the record of what the run produced, not a column of the run's
    // description — and a full-width row is what lets the row above add up on
    // its own, whichever blocks are present.
    expect(SOURCE).toMatch(/\.mt-full\s*\{\s*grid-column:\s*1\s*\/\s*-1/)
    expect(SOURCE).toMatch(/class="mt-block mt-full"/)
  })

  it('collapses to tracks the content fits in on narrower screens', () => {
    // A six-track grid puts each block in something narrower than a file name.
    expect(SOURCE).toMatch(/@media \(max-width: 1099px\)[\s\S]*?grid-template-columns: repeat\(2,/)
    expect(SOURCE).toMatch(/@media \(max-width: 640px\)[\s\S]*?grid-template-columns: minmax/)
  })

  it('keeps the two-track row adding up too', () => {
    // At the middle breakpoint the narrow blocks pair off and each wide block
    // takes a row: 1 + 1 = 2, and .mt-wide is re-declared to span 2.
    const middle = SOURCE.match(/@media \(max-width: 1099px\)\s*\{([\s\S]*?)\n\}/)
    expect(middle).toBeTruthy()
    expect(middle[1]).toMatch(/\.mt-wide\s*\{\s*grid-column:\s*span\s*2/)
  })
})
