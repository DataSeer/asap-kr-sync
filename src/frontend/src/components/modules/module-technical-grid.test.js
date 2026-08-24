/**
 * The Technical detail panel is three rows, and each block is on the right one.
 *
 * This used to be one grid with a fixed track count and a span per block, and
 * it broke twice. First when a fourth short list was added and the spans were
 * left alone, so a block could not fit in the tracks that remained and wrapped,
 * leaving the row above ragged. Then, once the spans were fixed, because equal
 * shares are the wrong model for this content: Metadata reserved a third of the
 * width for six short values while Configuration wrapped a sentence beside it.
 *
 * So the rows are declared in the template now and the blocks size to their own
 * content, and they are grouped by the question they answer rather than by
 * where the value came from: three boxes that read the same on every module,
 * then the one box that does not, then the files.
 *
 * What can still go wrong is a block being added to the wrong row, or a row
 * losing its container — neither of which shows up until someone opens the
 * section on a wide screen. That is what this checks.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(import.meta.dirname, 'ModuleTechnical.vue'), 'utf8')

/** Just the `<style>` block, so template text cannot be mistaken for CSS. */
const STYLE = SOURCE.slice(SOURCE.indexOf('<style'))

/** Just the `<template>`, so a CSS selector cannot be mistaken for markup. */
const TEMPLATE = SOURCE.slice(SOURCE.indexOf('<template>'), SOURCE.indexOf('<style'))

/** The markup of one row container, by its modifier class. */
function row(name) {
  const open = TEMPLATE.indexOf(`class="mt-row mt-row-${name}"`)
  expect(open, `the ${name} row must exist`).toBeGreaterThan(-1)
  // Its blocks are everything up to the next row, or to the end.
  const rest = TEMPLATE.slice(open + 1)
  const next = rest.indexOf('class="mt-row mt-row-')
  return next === -1 ? rest : rest.slice(0, next)
}

/** The span classes of the blocks inside a chunk of markup. */
const blocksIn = (markup) => [...markup.matchAll(/class="mt-block (mt-[a-z]+)"/g)].map((m) => m[1])

/** Every block in the whole template. */
const allBlocks = () => [...TEMPLATE.matchAll(/class="mt-block (mt-[a-z]+)"/g)].map((m) => m[1])

describe('the Technical detail panel', () => {
  it('is the six blocks the headings promise, and no more', () => {
    // The run, Configuration, Cost, Results, Module inputs, Module outputs. A
    // seventh has to be put on a row deliberately, which the next checks pin.
    expect(allBlocks()).toHaveLength(6)
  })

  it('puts the three always-the-same lists on the summary row', () => {
    // The run, Configuration, Cost. These ask the same questions on every
    // module page, which is the whole point of them being first and fixed.
    expect(blocksIn(row('summary'))).toEqual(['mt-narrow', 'mt-narrow', 'mt-narrow'])
  })

  it('gives the module-specific numbers a row of their own', () => {
    // The one box that differs between modules. Alone on its row so a reader
    // knows the rest is boilerplate and this is the part to read.
    expect(blocksIn(row('results'))).toEqual(['mt-results'])
  })

  it('puts the two link lists on the files row', () => {
    expect(blocksIn(row('files'))).toEqual(['mt-wide', 'mt-wide'])
  })

  it('leaves every block inside one of the three rows', () => {
    // A block added outside them would render full-width above everything,
    // which reads as a heading rather than a column.
    const inRows = ['summary', 'results', 'files']
      .reduce((sum, name) => sum + blocksIn(row(name)).length, 0)

    expect(inRows).toBe(allBlocks().length)
  })

  it('keeps each result label with its own number', () => {
    // Loose dt/dd in a wrapping flex row break between the two, which files a
    // count under the wrong name. Each pair is wrapped for that reason.
    expect(TEMPLATE).toMatch(/class="mt-result"[\s\S]{0,400}?<dt[\s\S]*?<dd/)
    expect(STYLE).toMatch(/\.mt-result\s*\{[^}]*white-space:\s*nowrap/)
  })

  it('sizes the summary blocks to their content rather than equal shares', () => {
    // The failure this replaced: equal thirds put a gap wider than the block
    // itself between Metadata and Configuration.
    expect(STYLE).toMatch(/\.mt-row-summary\s*\{[^}]*display:\s*flex/)
    expect(STYLE).toMatch(/\.mt-row-summary \.mt-block\s*\{[^}]*flex:\s*0 1 auto/)
  })

  it('gives the two link lists half the width each, and a row on narrow screens', () => {
    expect(STYLE).toMatch(/\.mt-row-files\s*\{[^}]*grid-template-columns:\s*repeat\(2,/)
    expect(STYLE).toMatch(/@media \(max-width: 900px\)[\s\S]*?grid-template-columns: minmax/)
  })
})
