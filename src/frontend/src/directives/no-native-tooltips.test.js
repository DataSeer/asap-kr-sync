/**
 * No native `title` tooltips anywhere in the app.
 *
 * The browser's own tooltip cannot be styled, appears after a delay the app
 * does not control, never fires on keyboard focus, and looks like a different
 * application. The app has `v-tooltip` instead, and this fails if a native one
 * reappears — 192 of them were removed at once, and the way that work gets
 * undone is one attribute at a time.
 *
 * `title` is legitimate in three places, all excluded below:
 *   - a declared PROP on a component that happens to be called `title`;
 *   - `step-title` and similar props whose name merely ends in "title";
 *   - the SVG `<title>` ELEMENT, which is an accessible name, not a tooltip
 *     (and is not an attribute, so it never matches here).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Components that declare `title` as a real prop. */
const PROP_COMPONENTS = ['LoadError', 'ModuleExplainer']

const SRC = join(import.meta.dirname, '..')

function vueFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...vueFiles(full))
    else if (entry.endsWith('.vue')) out.push(full)
  }
  return out
}

const TAG = /<([A-Za-z][\w.-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)\/?>/gs
const TITLE_ATTR = /(^|\s)(:|v-bind:)?title\s*=/

describe('native tooltips', () => {
  it('do not exist outside components that declare `title` as a prop', () => {
    const offenders = []

    for (const file of vueFiles(SRC)) {
      const source = readFileSync(file, 'utf8')
      const template = source.match(/<template>(.*)<\/template>/s)
      if (!template) continue

      for (const m of template[1].matchAll(TAG)) {
        const [, name, attrs] = m
        if (PROP_COMPONENTS.includes(name)) continue
        if (TITLE_ATTR.test(attrs)) {
          offenders.push(`${file.replace(SRC, '')} → <${name}>`)
        }
      }
    }

    expect(offenders, 'use v-tooltip="…" instead of a native title').toEqual([])
  })

  it('checks enough files to be meaningful', () => {
    // A guard that silently matches nothing passes forever.
    expect(vueFiles(SRC).length).toBeGreaterThan(20)
  })
})
