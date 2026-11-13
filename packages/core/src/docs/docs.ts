/**
 * Product documentation for the model. No vector store: Markdown is split into sections by its
 * headings, the model sees the table of contents, and finds what it needs with two tools:
 * `search_docs` (keyword search) and `read_doc` (one section in full). Docs small enough are put
 * into the system prompt whole instead, which works best of all.
 *
 * Bring your own search service by implementing `DocsProvider`.
 */
import type { Tool } from '../loop/types.js';

export interface DocHit {
  /** Pass to `read`. */
  id: string;
  /** Where the section sits, e.g. `新建数据源 › 主机地址`. */
  title: string;
  /** The text around the best match. */
  snippet: string;
}

export interface DocsProvider {
  /** What the docs cover, listed in the system prompt. Keep it the same between requests. */
  toc(): string;
  search(query: string): Promise<DocHit[]>;
  /** A section by its ID, or `undefined` if there is none. */
  read(id: string): Promise<string | undefined>;
  /** The full text, when it is small enough to go into the system prompt instead of the tools. */
  inline?(): string | undefined;
}

export interface DocFile {
  /** e.g. `datasource/new.md`. */
  path: string;
  content: string;
}

export interface DocsOptions {
  /** Docs up to this many characters go into the system prompt whole. Defaults to 12000; 0 never. */
  inlineMaxChars?: number;
  /** Hits returned by a search. Defaults to 5. */
  maxHits?: number;
}

interface Section {
  id: string;
  level: number;
  title: string;
  /** Titles from the top of the file down to this one. */
  trail: string[];
  /** The heading line and the text up to the next heading. */
  own: string;
  /** The text up to the next heading of the same or a higher level: the section with its subsections. */
  full: string;
}

/** Splits Markdown into sections at its headings (headings in code blocks don't count). */
function sections(file: DocFile): Section[] {
  const lines = file.content.replace(/\r\n?/g, '\n').split('\n');
  const heads: Array<{ line: number; level: number; title: string }> = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const match = fenced ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) heads.push({ line: index, level: match[1]!.length, title: match[2]! });
  });
  const name = file.path.replace(/\.(md|mdx|markdown)$/i, '').split('/').pop()!;
  // Text before the first heading belongs to the file itself.
  if (heads[0]?.line !== 0) heads.unshift({ line: 0, level: 0, title: name });

  const taken = new Set<string>();
  const trail: string[] = [];
  return heads.map((head, index) => {
    const nextAny = heads[index + 1]?.line ?? lines.length;
    const nextPeer = heads.slice(index + 1).find((other) => other.level <= head.level)?.line ?? lines.length;
    trail.length = Math.max(0, head.level - 1);
    const path = [...trail.filter(Boolean), head.title];
    trail[head.level - 1] = head.title;
    let id = `${file.path}#${head.title}`;
    for (let n = 2; taken.has(id); n++) id = `${file.path}#${head.title}-${n}`;
    taken.add(id);
    return {
      id,
      level: head.level,
      title: head.title,
      trail: path,
      own: lines.slice(head.line, nextAny).join('\n').trim(),
      full: lines.slice(head.line, nextPeer).join('\n').trim(),
    };
  });
}

const CJK = /[぀-ヿ㐀-鿿가-힯]/;

/** Search terms: Latin words and numbers, and overlapping pairs of characters for Chinese, Japanese and Korean. */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const run of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let latin = '';
    let cjk = '';
    const flush = () => {
      if (latin.length >= 2 || /\d/.test(latin)) out.push(latin);
      if (cjk.length === 1) out.push(cjk);
      for (let i = 0; i + 1 < cjk.length; i++) out.push(cjk.slice(i, i + 2));
      latin = '';
      cjk = '';
    };
    for (const char of run) {
      if (CJK.test(char)) {
        if (latin) flush();
        cjk += char;
      } else {
        if (cjk) flush();
        latin += char;
      }
    }
    flush();
  }
  return out;
}

function count(haystack: readonly string[], term: string): number {
  let n = 0;
  for (const item of haystack) if (item === term) n++;
  return n;
}

/** Documentation from Markdown files, held in memory. Works in any runtime; `markdownDocs` in `@doccue/core/node` reads a folder. */
export function createDocs(files: readonly DocFile[], options: DocsOptions = {}): DocsProvider {
  const all = [...files].sort((a, b) => a.path.localeCompare(b.path)).flatMap(sections);
  const byId = new Map(all.map((section) => [section.id, section]));
  const indexed = all.map((section) => ({ section, title: terms(section.trail.join(' ')), body: terms(section.own) }));
  const fullText = files.map((file) => `<doc path="${file.path}">\n${file.content.trim()}\n</doc>`).join('\n\n');
  const inlineMax = options.inlineMaxChars ?? 12000;
  const maxHits = options.maxHits ?? 5;

  return {
    toc: () =>
      all
        .filter((section) => section.level <= 3 && (section.level > 0 || section.own.length > section.title.length))
        .map((section) => `${'  '.repeat(Math.max(0, section.level - 1))}- ${section.title} (${section.id})`)
        .join('\n'),

    async search(query) {
      const wanted = [...new Set(terms(query))];
      if (wanted.length === 0) return [];
      // Rarer terms say more about what is being looked for.
      const weight = new Map(wanted.map((term) => [term, Math.log(1 + indexed.length / (1 + indexed.filter((entry) => entry.body.includes(term) || entry.title.includes(term)).length))]));
      return indexed
        .map(({ section, title, body }) => ({
          section,
          score: wanted.reduce((sum, term) => sum + weight.get(term)! * (3 * count(title, term) + Math.min(5, count(body, term))), 0),
        }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxHits)
        .map(({ section }) => ({ id: section.id, title: section.trail.join(' › '), snippet: snippet(section.own, wanted) }));
    },

    async read(id) {
      const section = byId.get(id);
      return section && `${section.trail.join(' › ')}\n\n${section.full}`;
    },

    inline: () => (inlineMax > 0 && fullText.length <= inlineMax ? fullText : undefined),
  };
}

/** About 200 characters of the section around the first place a search term appears. */
function snippet(text: string, wanted: readonly string[]): string {
  const flat = text.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  const at = Math.min(...wanted.map((term) => lower.indexOf(term)).filter((index) => index >= 0), flat.length);
  const start = Math.max(0, at - 60);
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + 200)}${start + 200 < flat.length ? '…' : ''}`;
}

/** The part of the system prompt about the docs. */
export function docsPrompt(docs: DocsProvider): string {
  const inline = docs.inline?.();
  if (inline) {
    return `The product documentation, written by the app's makers, is below. Answer questions about how the product works from it rather than from general knowledge; when it and the screen disagree, the screen is what the user sees now.\n<docs>\n${inline}\n</docs>`;
  }
  return `The product has documentation, written by the app's makers; its table of contents is below. When a question touches how the product works (what a field means, rules and limits, how to do something, what an error means), look it up before answering instead of guessing: search_docs finds sections, read_doc reads one in full. Don't mention the tools to the user.\n<docs-toc>\n${docs.toc()}\n</docs-toc>`;
}

/** `search_docs` and `read_doc`; none when the docs are in the system prompt already. */
export function docsTools(docs: DocsProvider): Tool[] {
  if (docs.inline?.()) return [];
  return [
    {
      name: 'search_docs',
      description: 'Searches the product documentation. Returns matching sections with their ID, where they sit and a snippet. Use words the docs would use, in their language.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      async execute(args) {
        const hits = await docs.search(String((args as { query: unknown }).query));
        if (hits.length === 0) return 'No matches. Try other words, or pick a section from the table of contents.';
        return hits.map((hit) => `[${hit.id}] ${hit.title}\n${hit.snippet}`).join('\n\n');
      },
    },
    {
      name: 'read_doc',
      description: 'Reads one section of the product documentation in full, with its subsections. Takes an ID from search_docs or the table of contents.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async execute(args) {
        const id = String((args as { id: unknown }).id);
        const text = await docs.read(id);
        if (text === undefined) throw new Error(`no section with ID "${id}". Use an ID from search_docs or the table of contents.`);
        return text;
      },
    },
  ];
}
