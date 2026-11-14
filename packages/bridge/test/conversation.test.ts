import type { Item } from '@doccue/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBridge, fitConversation, type Bridge, type BridgeEvent } from '../src/bridge.js';

const perception = { at: 1, screen: { page: { path: '/' }, nodes: [] }, actions: [] };
const question = (text: string): Item => ({ type: 'user', text, perception });
const answer = (text: string): Item => ({ type: 'model', messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] });
const guided: Item = { type: 'model', messages: [{ role: 'assistant', content: [{ type: 'tool_call', id: 'g1', name: 'guide', args: {}, rawArgs: '{}' }] }] };
const result: Item = { type: 'guide_result', callId: 'g1', result: { outcome: 'completed', completedSteps: 1, perception } };

describe('fitConversation', () => {
  const items = [question('一'.repeat(300)), answer('a'), question('二'), guided, result, answer('b'), question('三'), answer('c')];

  it('leaves a conversation that fits as it is', () => {
    expect(fitConversation(items, 100_000)).toBe(items);
  });

  it('drops the oldest exchanges first, whole, so a guide call keeps its result', () => {
    const fitted = fitConversation(items, JSON.stringify(items.slice(2)).length);
    expect(fitted).toEqual(items.slice(2));
    expect(fitted[0]).toEqual(question('二'));
    expect(fitConversation(items, JSON.stringify(items.slice(2)).length - 1)).toEqual(items.slice(6));
  });

  it('always keeps the latest exchange', () => {
    expect(fitConversation(items, 10)).toEqual([question('三'), answer('c')]);
  });
});

describe('failures', () => {
  let bridge: Bridge;
  let errors: Array<Extract<BridgeEvent, { type: 'error' }>>;

  beforeEach(() => {
    sessionStorage.clear();
    document.body.innerHTML = '<h1>仪表盘</h1>';
  });
  afterEach(() => bridge.destroy());

  const create = (endpoint: string) => {
    bridge = createBridge({ endpoint, maxQuestionChars: 10 });
    errors = [];
    bridge.on('error', (event) => errors.push(event));
  };

  it('turns away a question that is too long, before sending anything', async () => {
    create('/doccue');
    await expect(bridge.ask('这个问题超过了十个字的上限')).rejects.toThrow('longer than 10 characters');
    expect(errors).toEqual([{ type: 'error', message: 'DocCue: the question is longer than 10 characters' }]);
    expect(bridge.conversation()).toEqual([]);
    expect(bridge.busy()).toBe(false);
  });

  it('reports a backend it cannot reach', async () => {
    // Nothing listens on port 9 of this machine.
    create('http://127.0.0.1:9/doccue');
    const states: boolean[] = [];
    bridge.on('state', (event) => states.push(event.busy));
    await expect(bridge.ask('你好')).rejects.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.status).toBeUndefined();
    expect(states).toEqual([true, false]);
  });
});
