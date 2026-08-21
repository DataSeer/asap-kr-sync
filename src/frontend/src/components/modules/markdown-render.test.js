/**
 * The markdown renderer, and above all what it must NEVER emit.
 *
 * Its output goes straight to `v-html`, and its input is an automated
 * conversion of a file a user uploaded. The escaping is the only thing standing
 * between the two, so these tests are less about rendering nicely than about
 * proving that nothing executable survives.
 */

import { describe, it, expect } from 'vitest'
import { renderMarkdown } from './markdown-render'

describe('renderMarkdown — safety', () => {
  it('escapes raw HTML instead of passing it through', () => {
    const out = renderMarkdown('<script>alert(1)</script>')
    expect(out).not.toContain('<script')
    expect(out).toContain('&lt;script&gt;')
  })

  it('escapes an img with an event handler', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)>')
    expect(out).not.toMatch(/<img[^>]*onerror/i)
    expect(out).toContain('&lt;img')
  })

  it('refuses a javascript: link and leaves the source visible', () => {
    const out = renderMarkdown('[click](javascript:alert(1))')
    // No anchor is emitted at all. The text remains, escaped — a reader should
    // see what the document actually said rather than a silently blank line.
    expect(out).not.toContain('<a ')
    expect(out).toContain('[click]')
  })

  it('refuses a data: URL in an image', () => {
    const out = renderMarkdown('![x](data:text/html;base64,PHNjcmlwdD4=)')
    expect(out).not.toContain('<img')
  })

  it('cannot be broken out of an attribute by a quote in a URL', () => {
    const out = renderMarkdown('[x](https://example.com/"onmouseover="alert(1))')
    // The quote is escaped before any rule runs, so the attribute cannot be
    // closed early. What matters is that no TAG carries an event handler — the
    // characters themselves may survive inertly inside the href value.
    expect(out).not.toMatch(/<[a-z]+[^>]*\son\w+\s*=/i)
    expect(out).not.toContain('"onmouseover')
  })

  it('escapes quotes and ampersands in ordinary text', () => {
    const out = renderMarkdown('a "quoted" & ampersand')
    expect(out).toContain('&quot;')
    expect(out).toContain('&amp;')
  })

  it('does not execute anything hidden in a table cell', () => {
    const out = renderMarkdown('| a |\n| --- |\n| <script>x</script> |')
    expect(out).not.toContain('<script')
    expect(out).toContain('<td>')
  })

  it('keeps a code fence verbatim without interpreting it', () => {
    const out = renderMarkdown('```\n<b>not bold</b>\n```')
    expect(out).toContain('<pre><code>')
    expect(out).toContain('&lt;b&gt;')
  })
})

describe('renderMarkdown — output', () => {
  it('renders headings, emphasis and code spans', () => {
    expect(renderMarkdown('# Title')).toBe('<h1>Title</h1>')
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>')
    expect(renderMarkdown('*italic*')).toContain('<em>italic</em>')
    expect(renderMarkdown('`code`')).toContain('<code>code</code>')
  })

  it('renders a pipe table with its header', () => {
    const out = renderMarkdown('| Reagent | Source |\n| --- | --- |\n| anti-TagFP | Evrogen |')
    expect(out).toContain('<th>Reagent</th>')
    expect(out).toContain('<td>anti-TagFP</td>')
  })

  it('renders both kinds of list', () => {
    expect(renderMarkdown('- one\n- two')).toContain('<ul>')
    expect(renderMarkdown('1. one\n2. two')).toContain('<ol>')
  })

  it('keeps an http link, opening it safely', () => {
    const out = renderMarkdown('[site](https://example.com)')
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  it('unescapes the backslashes PDF conversion sprinkles through identifiers', () => {
    // "RRID:AB\_2313584" is what the converter emits; a reader wants the name.
    expect(renderMarkdown('RRID:AB\\_2313584')).toContain('RRID:AB_2313584')
  })

  it('does not treat a code span as emphasis', () => {
    const out = renderMarkdown('`a_b_c`')
    expect(out).toContain('<code>a_b_c</code>')
    expect(out).not.toContain('<em>')
  })

  it('survives being handed nothing', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown(null)).toBe('')
    expect(renderMarkdown(undefined)).toBe('')
  })
})
