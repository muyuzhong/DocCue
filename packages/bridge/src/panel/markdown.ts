/**
 * Just enough Markdown for answers: paragraphs, line breaks, **bold**, `code`, fenced code blocks,
 * lists, headings and links. Everything is escaped first, so nothing in an answer (or in the page
 * text it may quote) can become markup: no images, no HTML. Links are only http(s), open in a new
 * tab, and show their site when the text says something else, so a link can't pass for another.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/** A link to an http(s) address, or `undefined` for anything else. */
function link(label: string, href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const site = label === href || label === url.host ? '' : `<span class="site"> · ${escapeHtml(url.host)}</span>`;
  return `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(label)}</a>${site}`;
}

/** Inline formatting of one line: `code` spans as they are, then links, then bold, in the rest. */
function inline(text: string): string {
  return text
    .split(/(`[^`]+`)/)
    .map((part, index) => (index % 2 === 1 ? `<code>${escapeHtml(part.slice(1, -1))}</code>` : links(part)))
    .join('');
}

/** Links in text outside code: `[label](href)` and bare http(s) addresses. */
function links(text: string): string {
  const out: string[] = [];
  let rest = text;
  const pattern = /\[([^\]]+)\]\((\S+?)\)|(https?:\/\/[^\s<>()\]`]+[^\s<>()\]`.,;:!?。，；：！？）、])/;
  for (let match = pattern.exec(rest); match; match = pattern.exec(rest)) {
    out.push(bold(rest.slice(0, match.index)));
    const label = match[1] ?? match[3]!;
    const href = match[2] ?? match[3]!;
    out.push(link(label, href) ?? bold(match[0]));
    rest = rest.slice(match.index + match[0].length);
  }
  out.push(bold(rest));
  return out.join('');
}

function bold(text: string): string {
  return escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

export function renderMarkdown(source: string): string {
  return source
    .split(/^```[^\n]*\n?/m)
    .map((block, index) => {
      if (index % 2 === 1) return `<pre><code>${escapeHtml(block.replace(/\n$/, ''))}</code></pre>`;
      return block
        .split(/\n{2,}/)
        .map((paragraph) => {
          const lines = paragraph.split('\n').filter((line) => line.trim());
          if (lines.length === 0) return '';
          if (lines.every((line) => /^\s*([-*]|\d+[.)])\s/.test(line))) {
            const ordered = /^\s*\d/.test(lines[0]!);
            const items = lines.map((line) => `<li>${inline(line.replace(/^\s*([-*]|\d+[.)])\s+/, ''))}</li>`).join('');
            return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
          }
          // Other lines: text joined with line breaks; a heading line becomes a bold paragraph of its own.
          const out: string[] = [];
          let text: string[] = [];
          const flush = () => {
            if (text.length > 0) out.push(`<p>${text.join('<br>')}</p>`);
            text = [];
          };
          for (const line of lines) {
            const heading = /^#{1,6}\s+(.*)$/.exec(line);
            if (heading) {
              flush();
              out.push(`<p><strong>${inline(heading[1]!)}</strong></p>`);
            } else {
              text.push(inline(line));
            }
          }
          flush();
          return out.join('');
        })
        .join('');
    })
    .join('');
}
