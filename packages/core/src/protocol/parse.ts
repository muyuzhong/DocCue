/**
 * Checks the shape of a request body before it is used: every field that rendering and the model
 * adapters read, all the way down, so a malformed body gets a 400 instead of failing mid-stream.
 * Sizes are capped too (see `ProtocolLimits`): a request over a limit is turned away, never
 * trimmed, because trimming would change history the model has already seen.
 *
 * All of it comes from the browser, `model` items too: the frontend stores them and sends them
 * back. Their shape is checked, their content can't be, so treat the whole conversation like the
 * question itself: as written by the user.
 */
import { PROTOCOL_VERSION, type TurnRequest } from '@doccue/protocol';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export interface ProtocolLimits {
  /** Items in the conversation. */
  maxItems: number;
  /** Characters in one question. */
  maxQuestionChars: number;
  /** Nodes in one screen snapshot, at every depth. The bridge sends 300 at most by default. */
  maxScreenNodes: number;
  /** Actions in one upload. The bridge keeps 100 at most by default. */
  maxActions: number;
}

export const DEFAULT_LIMITS: ProtocolLimits = { maxItems: 400, maxQuestionChars: 4000, maxScreenNodes: 3000, maxActions: 300 };

type Errors = string[];
type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

const LOCALE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/;

/** A language tag such as `zh-CN`: letters, digits and hyphens only. */
export const isLocale = (value: unknown): value is string => typeof value === 'string' && LOCALE.test(value);

/** How deep screen nodes may nest. Real screens stay far below; it keeps the recursion safe. */
const MAX_DEPTH = 64;
/** Errors reported for one request. */
const MAX_ERRORS = 20;

const ACTION_TYPES = ['click', 'input', 'select', 'check', 'uncheck', 'submit'];
const OUTCOMES = ['completed', 'deviated', 'not_found', 'interrupted', 'exited'];

const listOf = (values: readonly string[]) => values.map((value) => `"${value}"`).join(', ');

function object(value: unknown, path: string, errors: Errors): value is Obj {
  if (isObject(value)) return true;
  errors.push(`${path}: expected an object`);
  return false;
}

/** Checks `object[key]`; with `optional` it may also be missing. */
function field(object: Obj, key: string, kind: 'string' | 'number' | 'boolean', path: string, errors: Errors, optional = false): void {
  const value = object[key];
  if (value === undefined && optional) return;
  const ok = kind === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === kind;
  if (!ok) errors.push(`${path}.${key}: expected a ${kind}`);
}

function oneOf(object: Obj, key: string, values: readonly string[], path: string, errors: Errors): void {
  if (!values.includes(object[key] as string)) errors.push(`${path}.${key}: expected one of ${listOf(values)}`);
}

/** Checks that `object[key]` is an array, and each entry with `check`. */
function list(object: Obj, key: string, path: string, errors: Errors, check: (item: unknown, path: string) => void, optional = false): void {
  const value = object[key];
  if (value === undefined && optional) return;
  if (!Array.isArray(value)) return void errors.push(`${path}.${key}: expected an array`);
  value.forEach((item, index) => check(item, `${path}.${key}[${index}]`));
}

const each =
  (kind: 'string' | 'number', errors: Errors) =>
  (value: unknown, path: string): void => {
    if (typeof value !== kind) errors.push(`${path}: expected a ${kind}`);
  };

// --- perception ---------------------------------------------------------------------------------

function checkPage(value: unknown, path: string, errors: Errors): void {
  if (!object(value, path, errors)) return;
  field(value, 'path', 'string', path, errors);
  field(value, 'title', 'string', path, errors, true);
}

function checkLocator(value: unknown, path: string, errors: Errors): void {
  if (!object(value, path, errors)) return;
  field(value, 'role', 'string', path, errors);
  field(value, 'name', 'string', path, errors);
  field(value, 'id', 'string', path, errors, true);
  const region = (item: unknown, at: string) => {
    if (!object(item, at, errors)) return;
    oneOf(item, 'kind', ['dialog', 'row', 'section'], at, errors);
    field(item, 'name', 'string', at, errors);
  };
  list(value, 'within', path, errors, region, true);
}

function checkNode(value: unknown, path: string, errors: Errors, depth: number): void {
  if (!object(value, path, errors)) return;
  if (depth > MAX_DEPTH) return void errors.push(`${path}: nested more than ${MAX_DEPTH} levels deep`);
  field(value, 'role', 'string', path, errors);
  field(value, 'ref', 'number', path, errors, true);
  field(value, 'name', 'string', path, errors, true);
  field(value, 'value', 'string', path, errors, true);
  list(value, 'states', path, errors, each('string', errors), true);
  list(value, 'children', path, errors, (child, at) => checkNode(child, at, errors, depth + 1), true);
}

const EFFECTS: Record<string, (effect: Obj, path: string, errors: Errors) => void> = {
  error: (effect, path, errors) => {
    field(effect, 'text', 'string', path, errors);
    if (effect.target !== undefined) checkLocator(effect.target, `${path}.target`, errors);
  },
  notice: (effect, path, errors) => field(effect, 'text', 'string', path, errors),
  dialog: (effect, path, errors) => {
    oneOf(effect, 'state', ['opened', 'closed'], path, errors);
    field(effect, 'name', 'string', path, errors);
  },
  navigate: (effect, path, errors) => checkPage(effect.page, `${path}.page`, errors),
  request_failed: (effect, path, errors) => {
    field(effect, 'method', 'string', path, errors);
    field(effect, 'path', 'string', path, errors);
    field(effect, 'status', 'number', path, errors, true);
    field(effect, 'message', 'string', path, errors, true);
  },
  script_error: (effect, path, errors) => field(effect, 'message', 'string', path, errors),
};

function checkEntry(value: unknown, path: string, errors: Errors): void {
  if (!object(value, path, errors)) return;
  field(value, 'at', 'number', path, errors);
  const action = value.action;
  if (action !== undefined && object(action, `${path}.action`, errors)) {
    oneOf(action, 'type', ACTION_TYPES, `${path}.action`, errors);
    if (action.target !== undefined) checkLocator(action.target, `${path}.action.target`, errors);
    field(action, 'value', 'string', `${path}.action`, errors, true);
  }
  const effect = (item: unknown, at: string) => {
    if (!object(item, at, errors)) return;
    const check = typeof item.type === 'string' && Object.hasOwn(EFFECTS, item.type) ? EFFECTS[item.type] : undefined;
    if (check) check(item, at, errors);
    else errors.push(`${at}.type: expected one of ${listOf(Object.keys(EFFECTS))}`);
  };
  list(value, 'effects', path, errors, effect, true);
}

/** Nodes in a (well-formed) tree, at every depth. */
function countNodes(nodes: unknown): number {
  if (!Array.isArray(nodes)) return 0;
  return nodes.reduce<number>((sum, node) => sum + 1 + (isObject(node) ? countNodes(node.children) : 0), 0);
}

function checkPerception(value: unknown, path: string, errors: Errors, limits: ProtocolLimits): void {
  if (!object(value, path, errors)) return;
  field(value, 'at', 'number', path, errors);
  if (Array.isArray(value.actions) && value.actions.length > limits.maxActions) {
    return void errors.push(`${path}.actions: more than ${limits.maxActions} actions`);
  }
  list(value, 'actions', path, errors, (entry, at) => checkEntry(entry, at, errors));
  const screen = value.screen;
  if (!object(screen, `${path}.screen`, errors)) return;
  checkPage(screen.page, `${path}.screen.page`, errors);
  const before = errors.length;
  list(screen, 'nodes', `${path}.screen`, errors, (node, at) => checkNode(node, at, errors, 1));
  if (errors.length === before && countNodes(screen.nodes) > limits.maxScreenNodes) {
    errors.push(`${path}.screen.nodes: more than ${limits.maxScreenNodes} nodes`);
  }
  field(screen, 'truncated', 'number', `${path}.screen`, errors, true);
}

// --- model messages -----------------------------------------------------------------------------

/** A string, or text and image parts. */
function checkUserContent(value: unknown, path: string, errors: Errors): void {
  if (typeof value === 'string') return;
  if (!Array.isArray(value)) return void errors.push(`${path}: expected a string or an array`);
  value.forEach((part: unknown, index) => {
    const at = `${path}[${index}]`;
    if (!object(part, at, errors)) return;
    if (part.type === 'text') field(part, 'text', 'string', at, errors);
    else if (part.type === 'image') {
      field(part, 'mediaType', 'string', at, errors);
      field(part, 'data', 'string', at, errors);
    } else errors.push(`${at}.type: expected "text" or "image"`);
  });
}

function checkAssistantPart(part: unknown, path: string, errors: Errors): void {
  if (!object(part, path, errors)) return;
  if (part.type === 'text') field(part, 'text', 'string', path, errors);
  else if (part.type === 'tool_call') {
    field(part, 'id', 'string', path, errors);
    field(part, 'name', 'string', path, errors);
    field(part, 'rawArgs', 'string', path, errors);
  } else if (part.type === 'raw') {
    field(part, 'provider', 'string', path, errors);
    if (!isObject(part.block) || typeof part.block.type !== 'string') errors.push(`${path}.block: expected an object with a type`);
  } else errors.push(`${path}.type: expected "text", "tool_call" or "raw"`);
}

function checkMessage(value: unknown, path: string, errors: Errors): void {
  if (!object(value, path, errors)) return;
  if (value.role === 'user') checkUserContent(value.content, `${path}.content`, errors);
  else if (value.role === 'assistant') list(value, 'content', path, errors, (part, at) => checkAssistantPart(part, at, errors));
  else if (value.role === 'tool') {
    list(value, 'results', path, errors, (result, at) => {
      if (!object(result, at, errors)) return;
      field(result, 'callId', 'string', at, errors);
      checkUserContent(result.content, `${at}.content`, errors);
      field(result, 'isError', 'boolean', at, errors, true);
    });
  } else errors.push(`${path}.role: expected "user", "assistant" or "tool"`);
}

// --- the request --------------------------------------------------------------------------------

function checkItem(item: unknown, path: string, errors: Errors, limits: ProtocolLimits): void {
  if (!object(item, path, errors)) return;
  if (item.type === 'user') {
    field(item, 'text', 'string', path, errors);
    if (typeof item.text === 'string' && item.text.length > limits.maxQuestionChars) errors.push(`${path}.text: longer than ${limits.maxQuestionChars} characters`);
    checkPerception(item.perception, `${path}.perception`, errors, limits);
  } else if (item.type === 'model') {
    list(item, 'messages', path, errors, (message, at) => checkMessage(message, at, errors));
  } else if (item.type === 'guide_result') {
    field(item, 'callId', 'string', path, errors);
    const result = item.result;
    if (!object(result, `${path}.result`, errors)) return;
    oneOf(result, 'outcome', OUTCOMES, `${path}.result`, errors);
    field(result, 'completedSteps', 'number', `${path}.result`, errors);
    list(result, 'skippedSteps', `${path}.result`, errors, each('number', errors), true);
    checkPerception(result.perception, `${path}.result.perception`, errors, limits);
  } else {
    errors.push(`${path}.type: expected "user", "model" or "guide_result"`);
  }
}

export function parseTurnRequest(raw: unknown, overrides: Partial<ProtocolLimits> = {}): ParseResult<TurnRequest> {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  if (!isObject(raw)) return { ok: false, errors: ['body: expected an object'] };
  const errors: string[] = [];
  if (raw.v !== PROTOCOL_VERSION) errors.push(`v: expected ${PROTOCOL_VERSION}`);
  if (raw.locale !== undefined && !isLocale(raw.locale)) errors.push('locale: expected a language tag such as "zh-CN"');
  if (raw.user !== undefined && !isObject(raw.user)) errors.push('user: expected an object');

  const items = raw.conversation;
  if (!Array.isArray(items) || items.length === 0) {
    errors.push('conversation: expected a non-empty array');
    return { ok: false, errors };
  }
  if (items.length > limits.maxItems) return { ok: false, errors: [`conversation: more than ${limits.maxItems} items`] };
  items.forEach((item: unknown, index) => checkItem(item, `conversation[${index}]`, errors, limits));
  const last = items[items.length - 1] as { type?: unknown } | undefined;
  if (last?.type === 'model') errors.push('conversation: the last item must be a question or a guide result');

  return errors.length > 0 ? { ok: false, errors: errors.slice(0, MAX_ERRORS) } : { ok: true, value: raw as unknown as TurnRequest };
}
