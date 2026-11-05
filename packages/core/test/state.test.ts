import { describe, expect, it } from 'vitest';
import { applyEvent, createSession } from '../src/state/reducer.js';
import { createMemoryStore } from '../src/state/store.js';

const clock = (start = 1000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe('applyEvent', () => {
  it('appends user messages and turn messages to history without touching the input', () => {
    const s0 = createSession('s', 1);
    const s1 = applyEvent(s0, { type: 'user_message', content: '你好' }, { now: () => 2 });
    const s2 = applyEvent(s1, { type: 'turn_messages', messages: [{ role: 'assistant', content: [{ type: 'text', text: '在' }] }] }, { now: () => 3 });
    expect(s0.history).toEqual([]);
    expect(s1.history).toEqual([{ role: 'user', content: '你好' }]);
    expect(s2.history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(s2.updatedAt).toBe(3);
    expect(applyEvent(s2, { type: 'turn_messages', messages: [] })).toBe(s2);
  });

  it('appends timeline entries up to the limit and replaces page, screen and errors', () => {
    let s = createSession('s');
    s = applyEvent(s, { type: 'perception', timeline: [1, 2, 3].map((i) => ({ at: i, kind: 'click', target: `b${i}` })), errors: [{ text: 'x' }] }, { timelineLimit: 4 });
    s = applyEvent(
      s,
      {
        type: 'perception',
        timeline: [4, 5].map((i) => ({ at: i, kind: 'click', target: `b${i}` })),
        page: { path: '/datasource/new', title: '新建数据源' },
        screen: '- button "测试连接"',
        errors: [],
      },
      { timelineLimit: 4, now: () => 99 },
    );
    expect(s.perception.timeline.map((e) => e.at)).toEqual([2, 3, 4, 5]);
    expect(s.perception.page).toEqual({ path: '/datasource/new', title: '新建数据源' });
    expect(s.perception.screen).toEqual({ text: '- button "测试连接"', at: 99 });
    expect(s.perception.errors).toEqual([]);
  });

  it('merges user attributes, adds completed tours and clears the active tour with null', () => {
    let s = createSession('s');
    s = applyEvent(s, { type: 'user_info', attributes: { role: '新手' }, completedTours: ['app_welcome'], activeTour: { id: 'ds', step: 2, total: 4 } });
    s = applyEvent(s, { type: 'user_info', attributes: { plan: 'pro' }, completedTours: ['app_welcome', 'ds'], activeTour: null });
    expect(s.user).toEqual({ attributes: { role: '新手', plan: 'pro' }, completedTours: ['app_welcome', 'ds'] });
  });
});

describe('createMemoryStore', () => {
  it('stores sessions and drops them after the idle TTL', async () => {
    const time = clock();
    const store = createMemoryStore({ ttlMs: 100, now: time.now });
    await store.set(createSession('a'));
    time.advance(60);
    expect(await store.get('a')).toBeDefined(); // reading counts as activity
    time.advance(60);
    expect(await store.get('a')).toBeDefined();
    time.advance(101);
    expect(await store.get('a')).toBeUndefined();
    await store.set(createSession('b'));
    await store.delete('b');
    expect(await store.get('b')).toBeUndefined();
  });
});
