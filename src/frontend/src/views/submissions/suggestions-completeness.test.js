/**
 * "All processes finished" must ignore steps belonging to a later stage.
 *
 * The Availability check is the twelfth step and is gated to the Availability
 * page. On the Manuscript step it sits `waiting` for ever, so a page that
 * counts it as outstanding work can never conclude the analysis is done. The
 * observed symptom: a submission whose other eleven steps had all completed,
 * with no suggestions to show, sat under "Analyzing the manuscript… Background
 * processes are still running" indefinitely, while the panel directly above it
 * read "All processes complete".
 *
 * `isFutureStepJob` existed, was tested, and was even imported by the page --
 * and never called. So the helper being correct proves nothing here; what has
 * to be pinned is that the page ASKS it. This reads the source for that reason:
 * a behavioural test would have to mount a 1700-line view and stub a poller,
 * and would still pass if someone re-inlined the raw loop somewhere new.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, 'PDFView.vue'), 'utf8')

/** The body of a top-level `const <name> = computed(...)` declaration. */
function computedBody(src, name) {
  const start = src.indexOf(`const ${name} = computed(`)
  if (start === -1) return null
  let depth = 0
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(start, i + 1)
  }
  return null
}

describe('the Manuscript step scopes completeness to its own work', () => {
  it('derives it from processesForThisStep, not the raw job map', () => {
    for (const name of ['allProcessesFinished', 'anyProcessFinished']) {
      const body = computedBody(SOURCE, name)
      expect(body, `${name} should exist`).toBeTruthy()
      expect(
        body.includes('processesForThisStep'),
        `${name} must read processesForThisStep so a later-step job is not counted`
      ).toBe(true)
      expect(
        /Object\.values\(\s*jobs\.value/.test(body),
        `${name} must not iterate the raw job map -- that is what counted the `
        + 'gated Availability check as outstanding work'
      ).toBe(false)
    }
  })

  it('builds that list with the shared helper rather than its own rule', () => {
    const body = computedBody(SOURCE, 'processesForThisStep')
    expect(body).toBeTruthy()
    expect(body.includes('isFutureStepJob')).toBe(true)
    expect(SOURCE.includes("import { isFutureStepJob } from '@/composables'")).toBe(true)
    // A second, hand-rolled copy of the rule is how the two would drift apart.
    expect(/waitingReason\s*===\s*'availability_step'/.test(body)).toBe(false)
  })
})
