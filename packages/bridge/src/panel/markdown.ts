/**
 * Just enough Markdown for answers: paragraphs, line breaks, **bold**, `code`, fenced code blocks,
 * lists and headings. Everything is escaped first, so nothing in an answer (or in the page text
 * it may quote) can become markup: no links, no images, no HTML.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
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
