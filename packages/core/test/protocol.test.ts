import { describe, expect, it } from 'vitest';
import { parseEvent, parseInbound } from '../src/protocol/parse.js';

describe('parseInbound', () => {
  it('accepts a well-formed message and drops unknown fields', () => {
    const result = parseInbound({
      sessionId: 'tab-1:abc',
      extra: true,
      events: [
        {
          type: 'perception',
          page: { path: '/datasource/new', title: '新建数据源', junk: 1 },
          timeline: [{ at: 1730790000000, kind: 'click', target: '按钮「测试连接」', result: '出现报错', page: '/datasource/new', repeat: 2, junk: 1 }],
          screen: '- button "测试连接"',
          errors: [{ text: 'Invalid Host Format', target: '输入框「主机地址」', source: 'page' }],
        },
        { type: 'user_info', attributes: { role: '新手' }, completedTours: ['app_welcome'], activeTour: null },
        { type: 'user_message', content: '为什么连不上？' },
        { type: 'user_message', content: [{ type: 'text', text: '看图' }, { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }] },
        { type: 'cancel', reason: 'ignored' },
      ],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        sessionId: 'tab-1:abc',
        events: [
          {
            type: 'perception',
            page: { path: '/datasource/new', title: '新建数据源' },
            timeline: [{ at: 1730790000000, kind: 'click', target: '按钮「测试连接」', result: '出现报错', page: '/datasource/new', repeat: 2 }],
            screen: '- button "测试连接"',
            errors: [{ text: 'Invalid Host Format', target: '输入框「主机地址」', source: 'page' }],
          },
          { type: 'user_info', attributes: { role: '新手' }, completedTours: ['app_welcome'], activeTour: null },
          { type: 'user_message', content: '为什么连不上？' },
          { type: 'user_message', content: [{ type: 'text', text: '看图' }, { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }] },
          { type: 'cancel' },
        ],
      },
    });
  });

  it('rejects wrong shapes with errors that name the field', () => {
    const result = parseInbound({
      sessionId: 'has spaces',
      events: [
        { type: 'shout' },
        { type: 'perception', timeline: [{ kind: 'click' }, { at: 1, kind: '' }], errors: [{ text: 'x', source: 'server' }] },
        { type: 'user_message', content: '   ' },
        { type: 'user_message', content: [{ type: 'image', mediaType: 'image/bmp', data: 'data:image/png;base64,AAA' }] },
        { type: 'user_info', activeTour: { id: 't', step: -1 } },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toEqual([
      'sessionId: expected 1-128 characters of A-Z a-z 0-9 _ . : -',
      'events[0].type: expected user_message, perception, user_info or cancel',
      'events[1].timeline[0].at: expected a timestamp in milliseconds',
      'events[1].timeline[1].kind: expected a non-empty string',
      'events[1].errors[0].source: expected page, js or network',
      'events[2].content: must not be empty',
      'events[3].content[0].mediaType: expected image/png, image/jpeg, image/webp or image/gif',
      'events[3].content[0].data: expected base64 without a data: prefix',
      'events[3].content: must not be empty',
      'events[4].activeTour.step: expected an integer ≥ 0',
    ]);
  });

  it('cuts long text, keeps the newest timeline entries and the first errors', () => {
    const result = parseEvent(
      {
        type: 'perception',
        timeline: [1, 2, 3, 4].map((i) => ({ at: i, kind: 'click', target: `按钮${i}`.padEnd(12, '长') })),
        screen: 'x'.repeat(30),
        errors: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
      },
      { maxTimelineEntries: 2, maxFieldChars: 5, maxScreenChars: 10, maxErrors: 2 },
    );
    expect(result).toEqual({
      ok: true,
      value: {
        type: 'perception',
        timeline: [
          { at: 3, kind: 'click', target: '按钮3长长…' },
          { at: 4, kind: 'click', target: '按钮4长长…' },
        ],
        screen: `${'x'.repeat(10)}…`,
        errors: [{ text: 'a' }, { text: 'b' }],
      },
    });
  });

  it('enforces size limits that would otherwise be rejected later', () => {
    const tooMany = parseInbound({ sessionId: 's', events: Array.from({ length: 3 }, () => ({ type: 'cancel' })) }, { maxEvents: 2 });
    expect(tooMany).toEqual({ ok: false, errors: ['events: more than 2 events'] });
    expect(parseEvent({ type: 'user_message', content: 'x'.repeat(11) }, { maxTextChars: 10 })).toEqual({
      ok: false,
      errors: ['event.content: longer than 10 characters'],
    });
    expect(parseEvent({ type: 'user_info', attributes: { note: 'x'.repeat(50) } }, { maxAttributesChars: 20 })).toEqual({
      ok: false,
      errors: ['event.attributes: larger than 20 characters as JSON'],
    });
    expect(parseInbound({ sessionId: 's', events: [] })).toEqual({ ok: false, errors: ['events: must not be empty'] });
    expect(parseInbound('nope')).toEqual({ ok: false, errors: ['body: expected an object'] });
  });
});
