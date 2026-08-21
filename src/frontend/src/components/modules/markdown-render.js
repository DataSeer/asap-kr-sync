/**
 * A small, escape-first markdown renderer.
 *
 * Deliberately not a markdown library. This text comes out of an automated
 * conversion of a file a user uploaded, so it is untrusted: everything is HTML-
 * escaped BEFORE any rule runs, and the only tags in the output are the ones
 * emitted here. There is no raw-HTML passthrough to sanitise, because there is
 * no passthrough at all.
 *
 * It covers what PDF conversion actually produces — headings, paragraphs,
 * lists, tables, code blocks, images, links, emphasis — and leaves anything
 * else as text. A construct rendered as its own source is a small blemish; a
 * renderer that executes it is a vulnerability.
 */

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

/** Only http(s), mailto and same-document links survive. */
function safeUrl(url) {
  const u = String(url || '').trim()
  return /^(https?:\/\/|mailto:|#|\/)/i.test(u) ? escapeHtml(u) : ''
}

/** Inline rules, applied to text that is ALREADY escaped. */
function inline(text) {
  let s = text
  // Code spans are lifted out first so the emphasis rules cannot reach inside
  // them; the sentinel is deliberately unlikely to occur in a manuscript.
  const codes = []
  s = s.replace(/`([^`]+)`/g, (_, c) => `@@CODE${codes.push(c) - 1}@@`)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, alt, src) => {
    const u = safeUrl(src)
    // A rejected URL leaves the source visible rather than a half-eaten
    // fragment; it is escaped text either way.
    return u ? `<img src="${u}" alt="${alt}">` : m
  })
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (m, label, href) => {
    const u = safeUrl(href)
    return u ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${label}</a>` : m
  })
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/(^|\s)_([^_\n]+)_/g, '$1<em>$2</em>')
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  // Backslash escapes, last: the converter emits "RRID:AB\_2313584" and
  // "SCR\_003070" all through a manuscript, and a reader should see the name,
  // not the escape. The raw view still shows them — that is what it is for,
  // and those escapes are precisely what makes a name fail to match.
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, '$1')
  return s.replace(/@@CODE(\d+)@@/g, (_, i) => `<code>${codes[Number(i)]}</code>`)
}

const isTableSeparator = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
const splitRow = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())

/**
 * @param {string} md raw markdown
 * @returns {string} HTML built only from the tags above
 */
export function renderMarkdown(md) {
  const lines = escapeHtml(md || '').split('\n')
  const out = []
  let i = 0
  let listType = null

  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null }
  }

  while (i < lines.length) {
    const line = lines[i]

    // fenced code — taken verbatim, no inline rules
    const fence = line.match(/^\s*```(\w*)\s*$/)
    if (fence) {
      closeList()
      const body = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++])
      i++
      out.push(`<pre><code>${body.join('\n')}</code></pre>`)
      continue
    }

    // table: a header row followed by a separator row
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      closeList()
      const head = splitRow(line)
      i += 2
      const rows = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]))
      out.push('<table><thead><tr>'
        + head.map((c) => `<th>${inline(c)}</th>`).join('')
        + '</tr></thead><tbody>'
        + rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')
        + '</tbody></table>')
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      closeList()
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`)
      i++
      continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeList()
      out.push('<hr>')
      i++
      continue
    }

    // "&gt;" because the text was escaped before any rule ran
    const quote = line.match(/^\s*&gt;\s?(.*)$/)
    if (quote) {
      closeList()
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`)
      i++
      continue
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/)
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (bullet || numbered) {
      const want = bullet ? 'ul' : 'ol'
      if (listType !== want) { closeList(); out.push(`<${want}>`); listType = want }
      out.push(`<li>${inline((bullet || numbered)[1])}</li>`)
      i++
      continue
    }

    if (!line.trim()) {
      closeList()
      i++
      continue
    }

    // paragraph: consecutive non-blank lines that start no other block
    const para = []
    while (i < lines.length && lines[i].trim()
      && !/^\s*(#{1,6}\s|```|[-*+]\s|\d+[.)]\s|&gt;\s?)/.test(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))) {
      para.push(lines[i++])
    }
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
    else i++
  }
  closeList()
  return out.join('\n')
}
