/**
 * Checks the shape of a request body before it is used. First round: structure only, no size
 * limits or trimming yet.
 */
import { PROTOCOL_VERSION, type TurnRequest } from '@doccue/protocol';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function checkPerception(value: unknown, path: string, errors: string[]): void {
  if (!isObject(value)) return void errors.push(`${path}: expected an object`);
  if (typeof value.at !== 'number') errors.push(`${path}.at: expected a number`);
  if (!Array.isArray(value.actions)) errors.push(`${path}.actions: expected an array`);
  const screen = value.screen;
  if (!isObject(screen) || !isObject(screen.page) || typeof screen.page.path !== 'string' || !Array.isArray(screen.nodes)) {
    errors.push(`${path}.screen: expected { page: { path }, nodes }`);
  }
}

export function parseTurnRequest(raw: unknown): ParseResult<TurnRequest> {
  if (!isObject(raw)) return { ok: false, errors: ['body: expected an object'] };
  const errors: string[] = [];
  if (raw.v !== PROTOCOL_VERSION) errors.push(`v: expected ${PROTOCOL_VERSION}`);
  if (raw.locale !== undefined && typeof raw.locale !== 'string') errors.push('locale: expected a string');
  if (raw.user !== undefined && !isObject(raw.user)) errors.push('user: expected an object');

  const items = raw.conversation;
  if (!Array.isArray(items) || items.length === 0) {
    errors.push('conversation: expected a non-empty array');
    return { ok: false, errors };
  }
  items.forEach((item: unknown, index) => {
    const path = `conversation[${index}]`;
    if (!isObject(item)) return void errors.push(`${path}: expected an object`);
    if (item.type === 'user') {
      if (typeof item.text !== 'string') errors.push(`${path}.text: expected a string`);
      checkPerception(item.perception, `${path}.perception`, errors);
    } else if (item.type === 'model') {
      if (!Array.isArray(item.messages)) errors.push(`${path}.messages: expected an array`);
    } else if (item.type === 'guide_result') {
      if (typeof item.callId !== 'string') errors.push(`${path}.callId: expected a string`);
      if (!isObject(item.result)) errors.push(`${path}.result: expected an object`);
      else checkPerception(item.result.perception, `${path}.result.perception`, errors);
    } else {
      errors.push(`${path}.type: expected "user", "model" or "guide_result"`);
    }
  });
  const last = items[items.length - 1] as { type?: unknown } | undefined;
  if (last?.type === 'model') errors.push('conversation: the last item must be a question or a guide result');

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: raw as unknown as TurnRequest };
}
