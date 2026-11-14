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
import { realModel } from './model.js';

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
  });

  it('lists a short file without headings, and gives the same prompt whatever order the files come in', () => {
    const note: DocFile = { path: 'notes.md', content: '重启试试。' };
    const shuffled = createDocs([note, ...[...FILES].reverse()]);
    const sorted = createDocs([...FILES, note]);
    expect(shuffled.toc().split('\n')).toContain('- notes (notes.md#notes)');
    expect(shuffled.toc()).toBe(sorted.toc());
    expect(shuffled.inline?.()).toBe(sorted.inline?.());
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

describe('answering from the docs, with the real model', () => {
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
