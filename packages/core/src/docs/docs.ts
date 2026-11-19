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
  /**
   * Largest table of contents put into the system prompt, in characters. Over it, deeper
   * headings are left out level by level, then the list is cut; search finds the rest. Defaults
   * to 4000.
   */
  maxTocChars?: number;
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

/**
 * What a docs site's source has for the site, not the reader: YAML front matter (`---` lines at
 * the top), whose `title` names the file, and an MDX file's `import` lines.
 */
function forReaders(file: DocFile): { file: DocFile; title?: string } {
  let content = file.content.replace(/\r\n?/g, '\n');
  let title: string | undefined;
  const front = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(content);
  if (front) {
    const line = /^title:[ \t]*(.+?)[ \t]*$/m.exec(front[1]!);
    if (line) title = line[1]!.replace(/^(["'])(.*)\1$/, '$2');
    content = content.slice(front[0].length);
  }
  if (/\.mdx$/i.test(file.path)) content = content.replace(/^import\s[^\n]*?\sfrom\s+['"][^'"\n]+['"];?[ \t]*\n/gm, '');
  return { file: { path: file.path, content: content.replace(/^\n+/, '') }, ...(title ? { title } : {}) };
}

/** Splits Markdown into sections at its headings (headings in code blocks don't count). */
function sections(file: DocFile, title?: string): Section[] {
  const lines = file.content.split('\n');
  const heads: Array<{ line: number; level: number; title: string }> = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const match = fenced ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) heads.push({ line: index, level: match[1]!.length, title: match[2]! });
  });
  const name = title ?? file.path.replace(/\.(md|mdx|markdown)$/i, '').split('/').pop()!;
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
  // In path order, not the order the files were read in (which differs between machines): the
  // table of contents and the inlined text go into the system prompt and have to be the same
  // everywhere for the prompt cache to hit.
  const prepared = files.map(forReaders).sort((a, b) => a.file.path.localeCompare(b.file.path));
  const sorted = prepared.map((entry) => entry.file);
  const all = prepared.flatMap((entry) => sections(entry.file, entry.title));
  const byId = new Map(all.map((section) => [section.id, section]));
  const indexed = all.map((section) => ({ section, title: terms(section.trail.join(' ')), body: terms(section.own) }));
  const fullText = sorted.map((file) => `<doc path="${file.path}">\n${file.content.trim()}\n</doc>`).join('\n\n');
  const inlineMax = options.inlineMaxChars ?? 12000;
  const maxHits = options.maxHits ?? 5;
  const maxToc = options.maxTocChars ?? 4000;

  /** The table of contents down to `depth` levels of headings. */
  const listed = (depth: number) =>
    all
      // A file's text before its first heading is listed under the file's name, unless there is none.
      .filter((section) => section.level <= depth && (section.level > 0 || section.own.length > 0))
      .map((section) => `${'  '.repeat(Math.max(0, section.level - 1))}- ${section.title} (${section.id})`);

  /** A link to another doc, as the ID read_doc takes; `undefined` for links elsewhere. */
  const linkTarget = (href: string, from: string): string | undefined => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) return undefined;
    const [file = '', anchor] = href.split('#', 2);
    const path = file ? resolvePath(from, decodeURIComponent(file)) : from;
    const sections = all.filter((section) => section.id.startsWith(`${path}#`));
    if (sections.length === 0) return undefined;
    if (!anchor) return sections[0]!.id;
    const wanted = slug(decodeURIComponent(anchor));
    return sections.find((section) => slug(section.title) === wanted)?.id;
  };

  return {
    toc() {
      for (const depth of [3, 2, 1]) {
        const lines = listed(depth);
        if (lines.join('\n').length <= maxToc) return lines.join('\n') + (depth < 3 ? `\n(Deeper sections are not listed: find them with search_docs.)` : '');
      }
      // Too many files even for their top headings: as many as fit.
      const lines = listed(1);
      const kept: string[] = [];
      for (const line of lines) {
        if ([...kept, line].join('\n').length > maxToc) break;
        kept.push(line);
      }
      return `${kept.join('\n')}\n(${lines.length - kept.length} more documents are not listed: find them with search_docs.)`;
    },

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
      if (!section) return undefined;
      const from = id.slice(0, id.indexOf('#'));
      // Links to other docs become IDs the model can read next; links elsewhere stay as they are.
      const text = section.full.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (link, label: string, href: string) => {
        const target = linkTarget(href, from);
        return target ? `${label} [doc: ${target}]` : link;
      });
      return `${section.trail.join(' › ')}\n\n${text}`;
    },

    inline: () => (inlineMax > 0 && fullText.length <= inlineMax ? fullText : undefined),
  };
}

/** `a/b.md` relative to the file `from` (e.g. `datasource/new.md`), with `..` and `.` resolved. */
function resolvePath(from: string, relative: string): string {
  const parts = from.split('/').slice(0, -1);
  for (const part of relative.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.' && part !== '') parts.push(part);
  }
  return parts.join('/');
}

/** A heading as an anchor compares: lower case, spaces as hyphens, punctuation gone (as GitHub does it). */
function slug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
}

/** Splits text into parts of at most `max` characters, at paragraph breaks where it can. */
export function splitText(text: string, max: number): string[] {
  const parts: string[] = [];
  let current = '';
  for (const paragraph of text.split(/(?<=\n\n)/)) {
    for (let rest = paragraph; rest.length > 0; ) {
      if (current.length + rest.length <= max) {
        current += rest;
        rest = '';
      } else if (current) {
        parts.push(current);
        current = '';
      } else {
        parts.push(rest.slice(0, max));
        rest = rest.slice(max);
      }
    }
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : [''];
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

export interface DocsToolOptions {
  /** Longest text read_doc returns at once; longer sections come in parts. Defaults to 6000. */
  maxReadChars?: number;
}

/** `search_docs` and `read_doc`; none when the docs are in the system prompt already. */
export function docsTools(docs: DocsProvider, options: DocsToolOptions = {}): Tool[] {
  const maxRead = options.maxReadChars ?? 6000;
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
      description:
        'Reads one section of the product documentation, with its subsections. Takes an ID from search_docs or the table of contents. A long section comes in parts: the text says so, and `part` reads the next. Links to other docs read "[doc: ID]".',
      parameters: { type: 'object', properties: { id: { type: 'string' }, part: { type: 'integer', minimum: 1 } }, required: ['id'] },
      async execute(args) {
        const { id: raw, part: wanted } = args as { id: unknown; part?: unknown };
        const id = String(raw);
        const text = await docs.read(id);
        if (text === undefined) throw new Error(`no section with ID "${id}". Use an ID from search_docs or the table of contents.`);
        const parts = splitText(text, maxRead);
        // Models sometimes send the number as a string ("2"): read it as the number it spells.
        const part = wanted === undefined ? 1 : Number(wanted);
        if (!Number.isInteger(part) || part < 1 || part > parts.length) throw new Error(`"${id}" has ${parts.length} part(s); there is no part ${String(wanted)}.`);
        if (parts.length === 1) return text;
        const more = part < parts.length ? ` Call read_doc with part ${part + 1} for the next.` : '';
        return `${parts[part - 1]!.trimEnd()}\n\n(Part ${part} of ${parts.length} of "${id}".${more})`;
      },
    },
  ];
}
