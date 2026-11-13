/**
 * The bridge in the playground, with the real model: what it records and sends, the guides it
 * runs, and what happens when the user interrupts, exits, stops or reloads the page.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enterWrongHost, guideResults, openPage, openPlayground, userItems, type Playground } from './page.js';

let playground: Playground;
beforeAll(async () => {
  playground = await openPlayground();
});
afterAll(() => playground?.close());

const TEXT_ONLY = '只用文字回答，不要在页面上指。';

describe('asking', () => {
  it('keeps actions in the browser until a question, then sends them once with the screen', async () => {
    const user = await openPage(playground, '/datasource/new');
    await enterWrongHost(user.page);
    expect(user.posts).toEqual([]); // nothing leaves the browser before a question

    await user.ask(`主机地址这一栏有什么要求？${TEXT_ONLY}`);
    await user.finishGuides();
    const [first] = userItems(user.posts[0]!.conversation);
    expect(first!.perception.actions.map((entry) => entry.action)).toEqual([
      { type: 'input', target: { role: 'textbox', name: '主机地址' }, value: 'http://127.0.0.1:5432' },
      { type: 'input', target: { role: 'textbox', name: '端口' }, value: '5432' },
      { type: 'click', target: { role: 'button', name: '测试连接' } },
    ]);
    expect(first!.perception.actions.at(-1)!.effects).toContainEqual({ type: 'error', text: 'Invalid Host Format', target: { role: 'textbox', name: '主机地址' } });
    expect(JSON.stringify(first!.perception.screen)).toContain('"name":"主机地址","value":"http://127.0.0.1:5432","states":["invalid"]');
    expect(user.posts[0]).toMatchObject({ v: 1, locale: 'zh-CN', user: { role: '新用户', plan: '试用版' } });

    // The next question carries the whole conversation; actions already sent don't go again.
    await user.ask(`端口应该填多少？${TEXT_ONLY}`);
    await user.finishGuides();
    const second = user.posts.at(-1)!.conversation;
    expect(second[0]).toEqual(first);
    expect(second[1]!.type).toBe('model');
    expect(userItems(second).at(-1)!.perception.actions).toEqual([]);
    expect((await user.conversation()).at(-1)!.type).toBe('model');
  });

  it('stops the answer in progress and keeps nothing of it', async () => {
    const user = await openPage(playground, '/dashboard');
    // Press Stop the moment the first words of the answer arrive.
    await user.page.evaluate(() => {
      const off = window.doccue.on('text', () => {
        off();
        document.querySelector<HTMLButtonElement>('.assistant .stop')!.click();
      });
    });
    await user.ask(`逐个字段详细说明新建数据源页面怎么填，每个字段写一段。${TEXT_ONLY}`);
    await user.idle();
    expect(await user.page.locator('.message.assistant .meta').last().innerText()).toBe('已停止');
    expect((await user.conversation()).map((item) => item.type)).toEqual(['user']);
  });

  it('keeps the conversation and unsent actions across a reload, until a new conversation', async () => {
    const user = await openPage(playground, '/dashboard');
    await user.ask(`数据平台是做什么的？一句话。${TEXT_ONLY}`);
    await user.finishGuides();
    await user.page.getByRole('link', { name: '数据源', exact: true }).click();
    await user.page.waitForTimeout(1200);

    await user.page.reload();
    await user.page.waitForFunction(() => window.doccue !== undefined);
    expect((await user.conversation()).map((item) => item.type)).toEqual(['user', 'model']);
    expect(await user.page.evaluate(() => window.doccue.recorded().map((entry) => entry.action?.target?.name))).toEqual(['数据源']);
    expect(await user.page.locator('.message.user').count()).toBe(1); // the chat is drawn again

    await user.page.getByRole('button', { name: '新对话' }).click();
    expect(await user.conversation()).toEqual([]);
  });
});

describe('guiding', () => {
  it('points at the field in error, follows the user, and sends what they did as the result', async () => {
    const user = await openPage(playground, '/datasource/new');
    await enterWrongHost(user.page);
    await user.ask('为什么连不上？');
    await user.bubble();
    expect(await user.highlighted()).toBe('input#host');
    expect(user.posts).toHaveLength(1);

    // The user fixes the host and tests again; later steps they skip with Next.
    await user.page.getByLabel('主机地址').fill('127.0.0.1');
    await user.page.getByLabel('主机地址').press('Tab');
    await user.page.getByRole('button', { name: '测试连接' }).click();
    await user.finishGuides();

    const result = guideResults(user.posts[1]!.conversation)[0]!;
    expect(result.result.outcome).toBe('completed');
    const actions = result.result.perception.actions.map((entry) => entry.action);
    expect(actions).toContainEqual({ type: 'input', target: { role: 'textbox', name: '主机地址' }, value: '127.0.0.1' });
    expect(actions).toContainEqual({ type: 'click', target: { role: 'button', name: '测试连接' } });
    expect(JSON.stringify(result.result.perception.screen)).toContain('连接成功');
    expect((await user.conversation()).at(-1)!.type).toBe('model');
  });

  it('ends the guide as interrupted when the user asks something else', async () => {
    const user = await openPage(playground, '/datasource/new');
    await enterWrongHost(user.page);
    await user.ask('为什么连不上？');
    await user.bubble();
    await user.ask(`端口应该填多少？${TEXT_ONLY}`);
    await user.finishGuides();
    const conversation = user.posts[1]!.conversation;
    expect(conversation.map((item) => item.type).slice(0, 4)).toEqual(['user', 'model', 'guide_result', 'user']);
    expect(guideResults(conversation)[0]!.result).toMatchObject({ outcome: 'interrupted', completedSteps: 0 });
  });

  it('closes the guide on Exit and asks nothing more', async () => {
    const user = await openPage(playground, '/datasource/new');
    await enterWrongHost(user.page);
    await user.ask('为什么连不上？');
    await user.bubble();
    await user.page.locator('[data-doccue-guide] .exit').click();
    await user.idle();
    await user.page.waitForTimeout(1000);
    expect(user.posts).toHaveLength(1);
    expect((await user.conversation()).at(-1)).toMatchObject({ type: 'guide_result', result: { outcome: 'exited' } });
  });

  it('carries on with the same step after a full page reload', async () => {
    const user = await openPage(playground, '/datasource/new');
    await enterWrongHost(user.page);
    await user.ask('为什么连不上？');
    const before = await user.bubble();

    await user.page.reload();
    await user.page.waitForFunction(() => window.doccue !== undefined);
    // The form came back empty, but the step points at the same field again.
    expect(await user.bubble()).toEqual(before);
    expect(await user.highlighted()).toBe('input#host');
    expect(await user.busy()).toBe(true);

    // Closing it now ends the guide that started before the reload: one result, no new request.
    await user.page.locator('[data-doccue-guide] .exit').click();
    await user.idle();
    expect((await user.conversation()).map((item) => item.type)).toEqual(['user', 'model', 'guide_result']);
    expect(guideResults(await user.conversation())[0]!.result).toMatchObject({ outcome: 'exited', completedSteps: 0 });
    expect(user.posts).toHaveLength(1);
  });

  it('asks again after a reload when the answer had not come yet', async () => {
    const user = await openPage(playground, '/dashboard');
    await user.ask(`数据平台能接入哪些数据库？${TEXT_ONLY}`);
    await user.page.reload();
    await user.page.waitForFunction(() => window.doccue !== undefined);
    await user.finishGuides();
    expect(user.posts.length).toBeGreaterThanOrEqual(2);
    expect(user.posts[1]!.conversation).toEqual(user.posts[0]!.conversation);
    expect((await user.conversation()).map((item) => item.type)).toEqual(['user', 'model']);
  });
});
