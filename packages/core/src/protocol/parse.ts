/**
 * The protocol layer: turns untrusted JSON from a client (the bridge) into input events.
 *
 * Wrong shapes are rejected with errors that name the field (`events[0].timeline[2].kind: ...`).
 * Overlong free text is cut and long lists are trimmed, so one noisy page can't blow up the
 * context. Unknown fields are dropped. Outputs need no conversion: `AgentOutput` is plain JSON.
 */
import type { ImagePart, TextPart, UserContent } from '../model/types.js';
import type { InputEvent } from '../scheduler/types.js';
import type { ActiveError, ActiveTour, PageInfo, TimelineEntry } from '../state/types.js';

export const PROTOCOL_VERSION = 1;

/** What a client sends: events for one session, applied in order. */
export interface InboundMessage {
  sessionId: string;
  events: InputEvent[];
}

export interface ProtocolLimits {
  /** Events per message. */
  maxEvents: number;
  /** Characters of text in one user message (longer is rejected). */
  maxTextChars: number;
  maxImages: number;
  /** Base64 characters per image. */
  maxImageChars: number;
  /** Timeline entries per event (the oldest are dropped). */
  maxTimelineEntries: number;
  /** Characters in short fields: control names, results, page titles, error texts (cut). */
  maxFieldChars: number;
  /** Characters in an input value (cut). */
  maxValueChars: number;
  /** Characters in the screen tree (cut). */
  maxScreenChars: number;
  /** Visible errors per event (the rest are dropped). */
  maxErrors: number;
  /** Serialized size of user attributes. */
  maxAttributesChars: number;
}

export const DEFAULT_LIMITS: ProtocolLimits = {
  maxEvents: 50,
  maxTextChars: 8000,
  maxImages: 4,
  maxImageChars: 7_000_000,
  maxTimelineEntries: 100,
  maxFieldChars: 500,
  maxValueChars: 2000,
  maxScreenChars: 100_000,
  maxErrors: 20,
  maxAttributesChars: 4000,
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ERROR_SOURCES = new Set(['page', 'js', 'network']);

class Reader {
  readonly errors: string[] = [];
  constructor(readonly limits: ProtocolLimits) {}

  fail(path: string, message: string): undefined {
    this.errors.push(`${path}: ${message}`);
    return undefined;
  }

  object(value: unknown, path: string): Record<string, unknown> | undefined {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    return this.fail(path, 'expected an object');
  }

  array(value: unknown, path: string): unknown[] | undefined {
    return Array.isArray(value) ? value : this.fail(path, 'expected an array');
  }

  /** A required string; cut to `max` characters, or rejected when `reject` is set. */
  string(value: unknown, path: string, max: number, reject = false): string | undefined {
    if (typeof value !== 'string') return this.fail(path, 'expected a string');
    if (value.length <= max) return value;
    return reject ? this.fail(path, `longer than ${max} characters`) : `${value.slice(0, max)}…`;
  }

  /** An optional string: `undefined` and `null` mean absent. */
  optionalString(value: unknown, path: string, max: number): string | undefined {
    return value === undefined || value === null ? undefined : this.string(value, path, max);
  }

  integer(value: unknown, path: string, min: number): number | undefined {
    if (typeof value === 'number' && Number.isInteger(value) && value >= min) return value;
    return this.fail(path, `expected an integer ≥ ${min}`);
  }
}

/** Parses `{ sessionId, events }` from a client. */
export function parseInbound(raw: unknown, limits: Partial<ProtocolLimits> = {}): ParseResult<InboundMessage> {
  const reader = new Reader({ ...DEFAULT_LIMITS, ...limits });
  const body = reader.object(raw, 'body');
  if (!body) return { ok: false, errors: reader.errors };
  const sessionId = isValidSessionId(body.sessionId) ? body.sessionId : undefined;
  if (!sessionId) reader.fail('sessionId', 'expected 1-128 characters of A-Z a-z 0-9 _ . : -');
  const list = reader.array(body.events, 'events');
  const events: InputEvent[] = [];
  if (list) {
    if (list.length === 0) reader.fail('events', 'must not be empty');
    if (list.length > reader.limits.maxEvents) reader.fail('events', `more than ${reader.limits.maxEvents} events`);
    else list.forEach((item, i) => {
      const event = readEvent(reader, item, `events[${i}]`);
      if (event) events.push(event);
    });
  }
  return reader.errors.length > 0 || !sessionId ? { ok: false, errors: reader.errors } : { ok: true, value: { sessionId, events } };
}

/** Parses one input event. */
export function parseEvent(raw: unknown, limits: Partial<ProtocolLimits> = {}): ParseResult<InputEvent> {
  const reader = new Reader({ ...DEFAULT_LIMITS, ...limits });
  const event = readEvent(reader, raw, 'event');
  return event && reader.errors.length === 0 ? { ok: true, value: event } : { ok: false, errors: reader.errors };
}

function readEvent(reader: Reader, raw: unknown, path: string): InputEvent | undefined {
  const value = reader.object(raw, path);
  if (!value) return undefined;
  switch (value.type) {
    case 'user_message': {
      const content = readUserContent(reader, value.content, `${path}.content`);
      return content === undefined ? undefined : { type: 'user_message', content };
    }
    case 'perception':
      return readPerception(reader, value, path);
    case 'user_info':
      return readUserInfo(reader, value, path);
    case 'cancel':
      return { type: 'cancel' };
    default:
      return reader.fail(`${path}.type`, 'expected user_message, perception, user_info or cancel');
  }
}

function readUserContent(reader: Reader, raw: unknown, path: string): string | UserContent[] | undefined {
  const { maxTextChars, maxImages, maxImageChars } = reader.limits;
  if (typeof raw === 'string') {
    if (!raw.trim()) return reader.fail(path, 'must not be empty');
    return reader.string(raw, path, maxTextChars, true);
  }
  const list = reader.array(raw, path);
  if (!list) return undefined;
  const parts: UserContent[] = [];
  let textChars = 0;
  let images = 0;
  list.forEach((item, i) => {
    const part = reader.object(item, `${path}[${i}]`);
    if (!part) return;
    if (part.type === 'text') {
      const text = reader.string(part.text, `${path}[${i}].text`, maxTextChars, true);
      if (text === undefined) return;
      textChars += text.length;
      if (text) parts.push({ type: 'text', text } satisfies TextPart);
    } else if (part.type === 'image') {
      images += 1;
      const mediaType = typeof part.mediaType === 'string' && IMAGE_TYPES.has(part.mediaType) ? part.mediaType : undefined;
      if (!mediaType) reader.fail(`${path}[${i}].mediaType`, 'expected image/png, image/jpeg, image/webp or image/gif');
      const data = reader.string(part.data, `${path}[${i}].data`, maxImageChars, true);
      if (data !== undefined && !BASE64.test(data)) reader.fail(`${path}[${i}].data`, 'expected base64 without a data: prefix');
      else if (mediaType && data !== undefined) parts.push({ type: 'image', mediaType, data } satisfies ImagePart);
    } else {
      reader.fail(`${path}[${i}].type`, 'expected text or image');
    }
  });
  if (textChars > maxTextChars) reader.fail(path, `more than ${maxTextChars} characters of text`);
  if (images > maxImages) reader.fail(path, `more than ${maxImages} images`);
  if (parts.length === 0) return reader.fail(path, 'must not be empty');
  return parts;
}

function readPerception(reader: Reader, value: Record<string, unknown>, path: string): InputEvent | undefined {
  const { maxTimelineEntries, maxFieldChars, maxScreenChars, maxErrors } = reader.limits;
  const event: Extract<InputEvent, { type: 'perception' }> = { type: 'perception' };

  if (value.timeline !== undefined) {
    const list = reader.array(value.timeline, `${path}.timeline`);
    if (list) {
      const start = Math.max(0, list.length - maxTimelineEntries);
      const entries: TimelineEntry[] = [];
      for (let i = start; i < list.length; i++) {
        const entry = readTimelineEntry(reader, list[i], `${path}.timeline[${i}]`);
        if (entry) entries.push(entry);
      }
      event.timeline = entries;
    }
  }
  if (value.page !== undefined) {
    const page = reader.object(value.page, `${path}.page`);
    const pagePath = page ? reader.string(page.path, `${path}.page.path`, maxFieldChars) : undefined;
    if (page && pagePath !== undefined) {
      const title = reader.optionalString(page.title, `${path}.page.title`, maxFieldChars);
      event.page = { path: pagePath, ...(title === undefined ? {} : { title }) } satisfies PageInfo;
    }
  }
  if (value.screen !== undefined) {
    const screen = reader.string(value.screen, `${path}.screen`, maxScreenChars);
    if (screen !== undefined) event.screen = screen;
  }
  if (value.errors !== undefined) {
    const list = reader.array(value.errors, `${path}.errors`);
    if (list) {
      const errors: ActiveError[] = [];
      list.slice(0, maxErrors).forEach((item, i) => {
        const at = `${path}.errors[${i}]`;
        const error = reader.object(item, at);
        const text = error ? reader.string(error.text, `${at}.text`, maxFieldChars) : undefined;
        if (!error || text === undefined) return;
        const target = reader.optionalString(error.target, `${at}.target`, maxFieldChars);
        let source: ActiveError['source'];
        if (error.source !== undefined && error.source !== null) {
          if (typeof error.source === 'string' && ERROR_SOURCES.has(error.source)) source = error.source as ActiveError['source'];
          else reader.fail(`${at}.source`, 'expected page, js or network');
        }
        errors.push({ text, ...(target === undefined ? {} : { target }), ...(source === undefined ? {} : { source }) });
      });
      event.errors = errors;
    }
  }
  return event;
}

function readTimelineEntry(reader: Reader, raw: unknown, path: string): TimelineEntry | undefined {
  const { maxFieldChars, maxValueChars } = reader.limits;
  const value = reader.object(raw, path);
  if (!value) return undefined;
  const at = typeof value.at === 'number' && Number.isFinite(value.at) && value.at > 0 ? value.at : reader.fail(`${path}.at`, 'expected a timestamp in milliseconds');
  const kind = typeof value.kind === 'string' && value.kind.trim() ? reader.string(value.kind, `${path}.kind`, 50) : reader.fail(`${path}.kind`, 'expected a non-empty string');
  if (at === undefined || kind === undefined) return undefined;
  const entry: TimelineEntry = { at, kind };
  const target = reader.optionalString(value.target, `${path}.target`, maxFieldChars);
  const result = reader.optionalString(value.result, `${path}.result`, maxFieldChars);
  const page = reader.optionalString(value.page, `${path}.page`, maxFieldChars);
  const text = reader.optionalString(value.value, `${path}.value`, maxValueChars);
  if (target !== undefined) entry.target = target;
  if (text !== undefined) entry.value = text;
  if (result !== undefined) entry.result = result;
  if (page !== undefined) entry.page = page;
  if (value.repeat !== undefined && value.repeat !== null) {
    const repeat = reader.integer(value.repeat, `${path}.repeat`, 1);
    if (repeat !== undefined) entry.repeat = repeat;
  }
  return entry;
}

function readUserInfo(reader: Reader, value: Record<string, unknown>, path: string): InputEvent | undefined {
  const { maxFieldChars, maxAttributesChars } = reader.limits;
  const event: Extract<InputEvent, { type: 'user_info' }> = { type: 'user_info' };
  if (value.attributes !== undefined) {
    const attributes = reader.object(value.attributes, `${path}.attributes`);
    if (attributes) {
      if (JSON.stringify(attributes).length > maxAttributesChars) reader.fail(`${path}.attributes`, `larger than ${maxAttributesChars} characters as JSON`);
      else event.attributes = attributes;
    }
  }
  if (value.completedTours !== undefined) {
    const list = reader.array(value.completedTours, `${path}.completedTours`);
    if (list) {
      const tours = list.map((item, i) => reader.string(item, `${path}.completedTours[${i}]`, maxFieldChars));
      event.completedTours = tours.filter((tour): tour is string => tour !== undefined);
    }
  }
  if (value.activeTour === null) {
    event.activeTour = null;
  } else if (value.activeTour !== undefined) {
    const tour = reader.object(value.activeTour, `${path}.activeTour`);
    if (tour) {
      const id = reader.string(tour.id, `${path}.activeTour.id`, maxFieldChars);
      const step = reader.integer(tour.step, `${path}.activeTour.step`, 0);
      const total = tour.total === undefined || tour.total === null ? undefined : reader.integer(tour.total, `${path}.activeTour.total`, 1);
      if (id !== undefined && step !== undefined) event.activeTour = { id, step, ...(total === undefined ? {} : { total }) } satisfies ActiveTour;
    }
  }
  return event;
}
