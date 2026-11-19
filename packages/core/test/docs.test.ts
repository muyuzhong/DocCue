import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Perception, StreamEvent } from '@doccue/protocol';
import { describe, expect, it } from 'vitest';
import { respond } from '../src/agent/respond.js';
import { createDocs, docsPrompt, docsTools, terms, type DocFile } from '../src/docs/docs.js';
import { markdownDocs } from '../src/docs/node.js';
import { createMemoryLog } from '../src/log/log.js';
import { collect } from './helpers.js';
import { describeWithModel, realModel } from './model.js';

/** Docs with facts the model can't know from elsewhere: a proxy port and a timeout. */
const FILES: DocFile[] = [
  {
    path: 'datasource/new.md',
    content: `# 新建数据源

在「新建数据源」页面填写连接信息，先测试连接，成功后才能保存。

## 主机地址

只填 IP 或域名，例如 10.0.0.8，不要带 http:// 这样的协议头，也不要带端口。

## 端口

MySQL 填 3306，PostgreSQL 填 5432。ClickHouse 比较特殊：数据平台通过自己的代理连接 ClickHouse，端口要填代理端口 8124，不是 ClickHouse 默认的 8123。

### 端口被占用

如果提示端口被占用，请联系管理员。

## 测试连接

点「测试连接」后，平台最多等待 17 秒；超过 17 秒没有响应就按超时处理。

\`\`\`
# 这一行在代码块里，不是标题
\`\`\`
`,
  },
  {
    path: 'datasource/delete.md',
    content: `# 删除数据源

删除后无法恢复，依赖它的报表会失效。

## 端口

（与删除无关的同名小节，用来检查 ID 不重复。）
`,
  },
  { path: 'faq.md', content: 'Questions people ask often.\n\n# Exporting\n\nReports can be exported as CSV from the dashboard.\n' },
];

describe('createDocs', () => {
  const docs = createDocs(FILES);

  it('splits the files at their headings and lists them as a table of contents', () => {
    expect(docs.toc().split('\n')).toEqual([
      '- 删除数据源 (datasource/delete.md#删除数据源)',
      '  - 端口 (datasource/delete.md#端口)',
      '- 新建数据源 (datasource/new.md#新建数据源)',
      '  - 主机地址 (datasource/new.md#主机地址)',
      '  - 端口 (datasource/new.md#端口)',
      '    - 端口被占用 (datasource/new.md#端口被占用)',
      '  - 测试连接 (datasource/new.md#测试连接)',
      // Text before the first heading belongs to the file.
      '- faq (faq.md#faq)',
      '- Exporting (faq.md#Exporting)',
    ]);
  });

  it('cuts Chinese into pairs of characters and the rest into words', () => {
    expect(terms('ClickHouse 端口填多少？')).toEqual(['clickhouse', '端口', '口填', '填多', '多少']);
    expect(terms('Invalid Host Format 8124')).toEqual(['invalid', 'host', 'format', '8124']);
  });

  it('finds the section that answers a question, in either language', async () => {
    expect((await docs.search('ClickHouse 的端口应该填多少'))[0]).toMatchObject({ id: 'datasource/new.md#端口', title: '新建数据源 › 端口' });
    expect((await docs.search('测试连接超时'))[0]?.id).toBe('datasource/new.md#测试连接');
    expect((await docs.search('export csv'))[0]?.id).toBe('faq.md#Exporting');
    expect((await docs.search('ClickHouse'))[0]?.snippet).toContain('8124');
    expect(await docs.search('kubernetes')).toEqual([]);
  });

  it('reads a section with its subsections, and nothing for an unknown ID', async () => {
    const text = await docs.read('datasource/new.md#端口');
    expect(text).toMatch(/^新建数据源 › 端口\n\n## 端口\n/);
    expect(text).toContain('### 端口被占用');
    expect(text).not.toContain('测试连接');
    expect(await docs.read('datasource/new.md#测试连接')).toContain('# 这一行在代码块里，不是标题');
    expect(await docs.read('nope.md#x')).toBeUndefined();
    // A file's path, as models send it: the whole file.
    const whole = await docs.read('datasource/new.md');
    expect(whole).toContain('## 端口');
    expect(whole).toContain('测试连接');
    expect(await docs.read('./datasource/new.md')).toBe(whole);
    expect(await docs.read('nope.md')).toBeUndefined();
  });

  it('lists a short file without headings, and gives the same prompt whatever order the files come in', () => {
    const note: DocFile = { path: 'notes.md', content: '重启试试。' };
    const shuffled = createDocs([note, ...[...FILES].reverse()]);
    const sorted = createDocs([...FILES, note]);
    expect(shuffled.toc().split('\n')).toContain('- notes (notes.md#notes)');
    expect(shuffled.toc()).toBe(sorted.toc());
    expect(shuffled.inline?.()).toBe(sorted.inline?.());
  });

  it("titles a file by its front matter and leaves out what is only for the docs site", async () => {
    const page: DocFile = {
      path: 'user-guide/items.mdx',
      content: '---\ntitle: "Items"\nsidebar:\n  order: 2\n---\nimport { Steps } from "@astrojs/starlight/components";\n\nItems are what you track.\n\n## Adding an Item\n\n<Steps>\n1. Click "Create".\n</Steps>\n',
    };
    const docs = createDocs([page]);
    expect(docs.toc().split('\n')).toEqual(['- Items (user-guide/items.mdx#Items)', '  - Adding an Item (user-guide/items.mdx#Adding an Item)']);
    const text = await docs.read('user-guide/items.mdx#Items');
    expect(text).toContain('Items are what you track.');
    expect(text).not.toMatch(/sidebar|import \{/);
    expect(docs.inline?.()).not.toContain('title:');
  });

  it('goes into the system prompt whole when small, and through tools otherwise', () => {
    expect(docs.inline?.()).toContain('<doc path="datasource/new.md">');
    expect(docsPrompt(docs)).toContain('<docs>');
    expect(docsTools(docs)).toEqual([]);

    const big = createDocs(FILES, { inlineMaxChars: 100 });
    expect(big.inline?.()).toBeUndefined();
    expect(docsPrompt(big)).toContain('<docs-toc>\n- 删除数据源 (datasource/delete.md#删除数据源)');
    expect(docsTools(big).map((tool) => tool.name)).toEqual(['search_docs', 'read_doc']);
  });
});

describe('markdownDocs', () => {
  it('reads every Markdown file under a folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doccue-docs-'));
    try {
      mkdirSync(join(dir, 'datasource'));
      for (const file of FILES) writeFileSync(join(dir, file.path), file.content);
      writeFileSync(join(dir, 'notes.txt'), 'not docs');
      const docs = await markdownDocs(dir);
      expect(docs.toc()).toBe(createDocs(FILES).toc());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describeWithModel('answering from the docs, with the real model', () => {
  const page: Perception = {
    at: Date.now(),
    screen: {
      page: { path: '/datasource/new', title: '新建数据源' },
      nodes: [
        { ref: 1, role: 'heading', name: '新建数据源' },
        { ref: 2, role: 'combobox', name: '数据库类型', value: 'ClickHouse' },
        { ref: 3, role: 'textbox', name: '端口', value: '' },
      ],
    },
    actions: [],
  };
  const ask = (text: string) => ({ v: 1, locale: 'zh-CN', conversation: [{ type: 'user' as const, text, perception: page }] });
  const textOf = (events: StreamEvent[]) => events.map((event) => (event.type === 'text' ? event.delta : '')).join('');
  const toolsUsed = (events: StreamEvent[]) => events.flatMap((event) => (event.type === 'status' && event.tool ? [event.tool] : []));

  it('looks things up with the tools when the docs are large', async () => {
    const events = await collect(respond(ask('ClickHouse 的端口填多少？只用文字回答，不要在页面上指。'), { model: realModel(), docs: createDocs(FILES, { inlineMaxChars: 0 }) }));
    expect(toolsUsed(events).some((tool) => tool === 'search_docs' || tool === 'read_doc')).toBe(true);
    expect(textOf(events)).toContain('8124');
  });

  it('answers from the system prompt when the docs are small', async () => {
    const { logger, records } = createMemoryLog();
    const events = await collect(respond(ask('点测试连接以后最多等多久？只用文字回答，不要在页面上指。'), { model: realModel(), docs: createDocs(FILES), logger }));
    const call = records.find((record) => record.kind === 'model_call')!;
    expect(call.request.system).toContain('平台最多等待 17 秒');
    expect(call.request.tools?.map((tool) => tool.name)).toEqual(['guide']);
    expect(textOf(events)).toContain('17');
  });
});

describe('big docs', () => {
  it('shrinks a long table of contents level by level, then cuts it', () => {
    const files = Array.from({ length: 30 }, (_, i) => ({ path: `guide/${i}.md`, content: `# 指南 ${i}\n\n## 第一节\n\n### 细节\n\n正文。` }));
    const full = createDocs(files, { maxTocChars: 100_000 }).toc();
    expect(full).toContain('    - 细节 (guide/0.md#细节)');

    const shallow = createDocs(files, { maxTocChars: 2000 }).toc();
    expect(shallow).not.toContain('细节');
    expect(shallow).toContain('(Deeper sections are not listed: find them with search_docs.)');
    expect(shallow.length).toBeLessThanOrEqual(2000 + 80);

    const cut = createDocs(files, { maxTocChars: 300 }).toc().split('\n');
    expect(cut.at(-1)).toMatch(/^\(\d+ more documents are not listed: find them with search_docs\.\)$/);
    expect(cut.slice(0, -1).every((line) => /^- 指南 \d+ \(guide\/\d+\.md#指南 \d+\)$/.test(line))).toBe(true);
  });

  it('turns links to other docs into IDs read_doc takes, and leaves other links alone', async () => {
    const docs = createDocs([
      { path: 'datasource/new.md', content: '# 新建数据源\n\n失败时看[连接问题排查](../troubleshooting.md)，端口见[端口说明](#端口)，或者[官网](https://example.com/docs)。\n\n## 端口\n\n5432。' },
      { path: 'troubleshooting.md', content: '# 连接问题排查\n\n## Invalid Host Format\n\n去掉 http://。' },
    ]);
    const text = await docs.read('datasource/new.md#新建数据源');
    expect(text).toContain('失败时看连接问题排查 [doc: troubleshooting.md#连接问题排查]');
    expect(text).toContain('端口见端口说明 [doc: datasource/new.md#端口]');
    expect(text).toContain('[官网](https://example.com/docs)');
    const anchored = createDocs([
      { path: 'a.md', content: '# A\n\n见 [报错](b.md#invalid-host-format)。' },
      { path: 'b.md', content: '# B\n\n## Invalid Host Format\n\n去掉 http://。' },
    ]);
    expect(await anchored.read('a.md#A')).toContain('报错 [doc: b.md#Invalid Host Format]');
  });

  it('reads a long section in parts, at paragraph breaks', async () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 段。${'内容'.repeat(400)}`);
    const docs = createDocs([{ path: 'long.md', content: `# 长文\n\n${paragraphs.join('\n\n')}` }], { inlineMaxChars: 0 });
    const read = docsTools(docs, { maxReadChars: 2000 }).find((tool) => tool.name === 'read_doc')!;
    const first = String(await read.execute!({ id: 'long.md#长文' }, { callId: 'c', signal: new AbortController().signal }));
    expect(first).toMatch(/^长文\n\n# 长文\n\n第 1 段。/);
    expect(first).toMatch(/\(Part 1 of \d+ of "long\.md#长文"\. Call read_doc with part 2 for the next\.\)$/);
    const parts = Number(/of (\d+) of/.exec(first)![1]);
    const last = String(await read.execute!({ id: 'long.md#长文', part: parts }, { callId: 'c', signal: new AbortController().signal }));
    expect(last).toContain('第 6 段。');
    expect(last).toMatch(new RegExp(`\\(Part ${parts} of ${parts} of "long\\.md#长文"\\.\\)$`));
    await expect(read.execute!({ id: 'long.md#长文', part: parts + 1 }, { callId: 'c', signal: new AbortController().signal })).rejects.toThrow(`has ${parts} part(s)`);
    // Models sometimes send the part as a string.
    expect(await read.execute!({ id: 'long.md#长文', part: String(parts) }, { callId: 'c', signal: new AbortController().signal })).toBe(last);
  });
});

describeWithModel('big docs, with the real model', () => {
  it('lets the real model read on to a later part when the answer is there', async () => {
    // The only place the fact appears is the end of a long section, past the first part.
    const filler = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 条：这一段介绍报表的配色、字体和导出格式，与数据源无关。${'说明文字'.repeat(120)}`);
    const docs = createDocs([{ path: 'handbook.md', content: `# 平台手册\n\n${filler.join('\n\n')}\n\n最后一条：数据源的连接测试最多等待 23 秒。` }], { inlineMaxChars: 0 });
    const page: Perception = { at: Date.now(), screen: { page: { path: '/dashboard', title: '仪表盘' }, nodes: [{ ref: 1, role: 'heading', name: '仪表盘' }] }, actions: [] };
    const { logger, records } = createMemoryLog();
    const events = await collect(
      respond({ v: 1, locale: 'zh-CN', conversation: [{ type: 'user', text: '平台手册里说数据源的连接测试最多等多久？请把手册读完再回答，只用文字回答。', perception: page }] }, { model: realModel(), docs, logger }),
    );
    expect(events.map((event) => (event.type === 'text' ? event.delta : '')).join('')).toContain('23');
    const parts = records.flatMap((record) => (record.kind === 'model_call' ? (record.result?.message.content ?? []) : [])).filter((part) => part.type === 'tool_call' && part.name === 'read_doc');
    expect(parts.some((call) => (call as { args: { part?: number } }).args.part !== undefined && (call as { args: { part?: number } }).args.part! > 1)).toBe(true);
  });
});
