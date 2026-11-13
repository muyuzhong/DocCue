/** The agent answers from the playground's product docs (docs/), looking them up with its tools. */
import type { Item } from '@doccue/bridge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPage, openPlayground, type Playground } from './page.js';

let playground: Playground;
beforeAll(async () => {
  playground = await openPlayground();
});
afterAll(() => playground?.close());

/** Names of the backend tools the model called, from the conversation the bridge keeps. */
const toolsCalled = (conversation: readonly Item[]) =>
  conversation.flatMap((item) => (item.type === 'model' ? (item.messages as Array<{ role: string; content?: Array<{ type: string; name?: string }> }>) : []))
    .flatMap((message) => (message.role === 'assistant' ? (message.content ?? []) : []))
    .flatMap((part) => (part.type === 'tool_call' && part.name ? [part.name] : []));

describe('answering from the docs', () => {
  it('looks up what the screen does not say', async () => {
    const user = await openPage(playground, '/datasource');
    await user.ask('删除数据源以后还能恢复吗？只用文字回答，不要在页面上指。');
    await user.finishGuides();
    const conversation = await user.conversation();
    expect(toolsCalled(conversation).some((name) => name === 'search_docs' || name === 'read_doc')).toBe(true);
    const answer = await user.page.locator('.message.assistant').last().innerText();
    expect(answer).toMatch(/无法恢复|不能恢复|不可恢复/);
  });

  it('explains an error with the cause the docs give', async () => {
    const user = await openPage(playground, '/datasource/new');
    await user.page.getByLabel('主机地址').fill('127.0.0.1');
    await user.page.getByLabel('端口').fill('5433');
    await user.page.getByRole('button', { name: '测试连接' }).click();
    await user.page.getByText('连接失败').first().waitFor();
    await user.page.waitForTimeout(1200);
    await user.ask('连接失败是什么原因？只用文字回答，不要在页面上指。');
    await user.finishGuides();
    const answer = await user.page.locator('.message.assistant').last().innerText();
    expect(answer).toContain('5432');
  });
});
