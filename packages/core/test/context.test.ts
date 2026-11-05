import { describe, expect, it } from 'vitest';
import { describeAction, foldTimeline, renderStatus } from '../src/context/render.js';
import { buildSystemPrompt, DEFAULT_INSTRUCTIONS, statusContext } from '../src/context/status-context.js';
import type { ContextBuilder, TurnRequest } from '../src/context/types.js';
import type { Message } from '../src/model/types.js';
import { createScheduler } from '../src/scheduler/scheduler.js';
import { applyEvent, createSession } from '../src/state/reducer.js';
import type { SessionState, StateEvent } from '../src/state/types.js';
import { fakeModel, reply } from './helpers.js';

const T = Date.UTC(2026, 10, 5, 11, 2, 15); // 11:02:15 UTC

function sessionWith(...events: StateEvent[]): SessionState {
  return events.reduce((state, event) => applyEvent(state, event, { now: () => T }), createSession('s', T));
}

const perception: StateEvent = {
  type: 'perception',
  page: { path: '/datasource/new', title: '新建数据源' },
  timeline: [
    { at: T, kind: 'input', target: '输入框「主机地址」', value: 'http://127.0.0.1:5432' },
    { at: T + 3000, kind: 'click', target: '按钮「测试连接」', result: '出现报错「Invalid Host Format」' },
  ],
  errors: [{ text: 'Invalid Host Format', target: '输入框「主机地址」' }],
};

async function callOnce(builder: ContextBuilder, session: SessionState, transcript?: readonly Message[], request: TurnRequest = { reason: 'user_message' }) {
  const prepared = await builder.prepare({ session, request, getSession: async () => session });
  const appended = (await prepared.beforeModelCall?.({ step: 1, transcript: transcript ?? prepared.messages })) ?? [];
  return { prepared, appended };
}

describe('render', () => {
  it('describes actions in one line each', () => {
    expect(describeAction({ at: T, kind: 'input', target: '输入框「主机地址」', value: 'http://127.0.0.1:5432' }, 'UTC')).toBe(
      '11:02:15 填写 输入框「主机地址」 = "http://127.0.0.1:5432"',
    );
    expect(describeAction({ at: T + 3000, kind: 'click', target: '按钮「测试连接」', result: '出现报错「Invalid Host Format」', repeat: 2 }, 'UTC')).toBe(
      '11:02:18 点击 按钮「测试连接」（连续 2 次） → 出现报错「Invalid Host Format」',
    );
    expect(describeAction({ at: T, kind: 'navigate', page: '/datasource/new' }, 'UTC')).toBe('11:02:15 进入页面 /datasource/new');
    expect(describeAction({ at: T, kind: 'drag', target: '卡片「A」' }, 'UTC')).toBe('11:02:15 drag 卡片「A」');
  });

  it('folds identical consecutive actions and keeps the latest time', () => {
    const click = { kind: 'click', target: '按钮「测试连接」', result: '报错' };
    expect(foldTimeline([{ at: 1, ...click }, { at: 2, ...click }, { at: 3, kind: 'input', target: 'x' }, { at: 4, ...click }])).toEqual([
      { at: 2, ...click, repeat: 2 },
      { at: 3, kind: 'input', target: 'x' },
      { at: 4, ...click },
    ]);
  });

  it('renders the status bar, leaving out lines without data', () => {
    expect(renderStatus(createSession('s'))).toBeUndefined();
    const session = sessionWith(perception, {
      type: 'user_info',
      attributes: { role: '新手', seats: 5 },
      completedTours: ['app_welcome'],
      activeTour: { id: 'datasource_onboarding', step: 2, total: 4 },
    });
    expect(renderStatus(session, { timeZone: 'UTC' })).toBe(
      [
        '页面：新建数据源（/datasource/new）',
        '引导：datasource_onboarding 第 2/4 步',
        '当前报错：Invalid Host Format（输入框「主机地址」）',
        '用户：role=新手，seats=5；已完成引导：app_welcome',
        '最近操作：',
        '11:02:15 填写 输入框「主机地址」 = "http://127.0.0.1:5432"',
        '11:02:18 点击 按钮「测试连接」 → 出现报错「Invalid Host Format」',
      ].join('\n'),
    );
    expect(renderStatus(session, { timeZone: 'UTC', recentActions: 1 })).toContain('最近操作：\n11:02:18 点击');
  });
});

describe('statusContext', () => {
  const builder = statusContext({ timeZone: 'UTC', now: () => T + 5000 });

  it('uses a fixed system prompt and the history unchanged', async () => {
    const session = sessionWith({ type: 'user_message', content: '你好' });
    const { prepared, appended } = await callOnce(statusContext({ instructions: '你是数据平台的助手。' }), session);
    expect(prepared.system).toBe(buildSystemPrompt('你是数据平台的助手。'));
    expect(prepared.system).toContain('<status>');
    expect(buildSystemPrompt()).toContain(DEFAULT_INSTRUCTIONS);
    expect(prepared.messages).toBe(session.history);
    // Nothing known about the page: no status at all.
    expect(appended).toEqual([]);
  });

  it('appends the status and the screen tree after the question', async () => {
    const session = sessionWith(perception, { type: 'perception', screen: '- textbox "主机地址"' }, { type: 'user_message', content: '为什么连不上？' });
    const { appended } = await callOnce(builder, session);
    expect(appended).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: expect.stringMatching(/^<status time="11:02:20">\n页面：新建数据源（\/datasource\/new）\n[\s\S]*\n<\/status>$/) },
          { type: 'text', text: '<screen>\n- textbox "主机地址"\n</screen>' },
        ],
      },
    ]);
  });

  it('appends a new status only when something changed, and the screen only when it changed', async () => {
    const before = sessionWith(perception, { type: 'perception', screen: 'tree' }, { type: 'user_message', content: '一' });
    const first = await callOnce(builder, before);
    const transcript: Message[] = [...before.history, ...first.appended, { role: 'assistant', content: [{ type: 'text', text: '答' }] }, { role: 'user', content: '二' }];

    const unchanged = await callOnce(builder, before, transcript);
    expect(unchanged.appended).toEqual([]);

    const after = applyEvent(before, { type: 'perception', timeline: [{ at: T + 9000, kind: 'click', target: '按钮「保存」' }] });
    const changed = await callOnce(builder, after, transcript);
    expect(changed.appended).toHaveLength(1);
    const parts = (changed.appended[0] as Extract<Message, { role: 'user' }>).content as { text: string }[];
    expect(parts).toHaveLength(1); // screen unchanged: not sent again
    expect(parts[0]!.text).toContain('点击 按钮「保存」');
  });

  it('caps or turns off the screen tree', async () => {
    const session = sessionWith({ type: 'perception', screen: 'x'.repeat(50) });
    const capped = await callOnce(statusContext({ screen: { maxChars: 10 } }), session);
    expect(JSON.stringify(capped.appended)).toContain(`${'x'.repeat(10)}\\n…（已截断）`);
    const off = await callOnce(statusContext({ screen: false }), session);
    expect(off.appended).toEqual([]);
  });

  it('starts a turn the user did not ask for with a status that says why, once', async () => {
    const session = sessionWith(perception);
    const prepared = await builder.prepare({
      session,
      request: { reason: 'offer_help', note: '用户连续两次测试连接都报错' },
      getSession: async () => session,
    });
    const first = (await prepared.beforeModelCall!({ step: 1, transcript: [] })) ?? [];
    expect(JSON.stringify(first)).toContain('（用户没有提问，这一轮由应用发起：用户连续两次测试连接都报错）');
    const second = (await prepared.beforeModelCall!({ step: 2, transcript: [...first] })) ?? [];
    expect(second).toEqual([]);
  });
});

describe('statusContext with the scheduler', () => {
  it('keeps every request an append-only extension of the previous one', async () => {
    const model = fakeModel(
      () => reply('把 http:// 去掉再试'),
      () => reply('也可能是端口不对'),
      () => reply('保存成功了'),
    );
    const scheduler = createScheduler({ model, context: statusContext({ timeZone: 'UTC', now: () => T, screen: false }) });

    await scheduler.push('s', perception);
    await scheduler.push('s', { type: 'user_message', content: '为什么连不上？' });
    await scheduler.idle('s');
    await scheduler.push('s', { type: 'user_message', content: '还有别的原因吗？' });
    await scheduler.idle('s');
    await scheduler.push('s', { type: 'perception', timeline: [{ at: T + 60_000, kind: 'click', target: '按钮「保存」', result: '提示「保存成功」' }], errors: [] });
    await scheduler.push('s', { type: 'user_message', content: '现在呢？' });
    await scheduler.idle('s');

    const [r1, r2, r3] = model.requests.map((r) => r.messages);
    const isStatus = (m: Message | undefined) => JSON.stringify(m).includes('<status');
    // Turn 1: question, then the status.
    expect(r1!.map(isStatus)).toEqual([false, true]);
    // Turn 2: nothing changed, so no new status.
    expect(r2!.slice(0, r1!.length)).toEqual(r1);
    expect(r2!.slice(r1!.length).map(isStatus)).toEqual([false, false]);
    // Turn 3: a new action, so a new status after the question; earlier messages untouched.
    expect(r3!.slice(0, r2!.length)).toEqual(r2);
    expect(isStatus(r3!.at(-1))).toBe(true);
    expect(JSON.stringify(r3!.at(-1))).toContain('提示「保存成功」');
    expect(JSON.stringify(r3!.at(-1))).not.toContain('当前报错');

    const history = (await scheduler.getSession('s'))!.history;
    expect(history.slice(0, r3!.length)).toEqual(r3);
    expect(history).toHaveLength(r3!.length + 1);
  });
});
