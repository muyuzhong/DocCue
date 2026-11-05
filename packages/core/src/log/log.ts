/**
 * Logging and replay (cross-cutting). Each model call is recorded with exactly what was sent,
 * what came back, and how long it took, so a bad answer can be inspected and re-sent later.
 */
import type { TurnEndReason } from '../loop/types.js';
import { ModelError } from '../model/errors.js';
import type { AssistantMessage, Message, ModelAdapter, StopReason, ToolSpec, Usage } from '../model/types.js';
import type { InputEvent } from '../scheduler/types.js';

export interface LoggedError {
  name: string;
  message: string;
  code?: string;
  status?: number;
  retryable?: boolean;
}

export interface ModelCallRecord {
  kind: 'model_call';
  /** When the call started (ms since the epoch). */
  at: number;
  provider: string;
  model: string;
  /** Exactly what the model was sent. */
  request: { system?: string; messages: readonly Message[]; tools?: readonly ToolSpec[] };
  durationMs: number;
  /** Time until the first text or reasoning arrived. */
  firstOutputMs?: number;
  result?: { message: AssistantMessage; stopReason: StopReason; rawStopReason: string | null; usage: Usage; servedBy?: string };
  error?: LoggedError;
}

export type LogRecord =
  | { kind: 'event'; at: number; sessionId: string; event: InputEvent }
  | { kind: 'turn_start'; at: number; sessionId: string; turnId: string; reason: string }
  | (ModelCallRecord & { sessionId?: string; turnId?: string; step?: number })
  | { kind: 'turn_end'; at: number; sessionId: string; turnId: string; reason: TurnEndReason; usage: Usage; error?: LoggedError };

export type Logger = (record: LogRecord) => void;

export function describeError(error: unknown): LoggedError {
  if (error instanceof ModelError) {
    return {
      name: error.name,
      message: error.message,
      retryable: error.retryable,
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}

/** Calls `log` and ignores its failures: logging must never break a turn. */
export function safeLog<T>(log: ((record: T) => void) | undefined, record: T): void {
  try {
    log?.(record);
  } catch {
    // Ignore.
  }
}

/** Wraps a model so every call is reported to `log` when it ends (or fails, or is cut short). */
export function withModelLog(model: ModelAdapter, log: (record: ModelCallRecord) => void, now: () => number = Date.now): ModelAdapter {
  return {
    provider: model.provider,
    model: model.model,
    async *stream(request) {
      const at = now();
      let firstOutputMs: number | undefined;
      let result: ModelCallRecord['result'];
      let error: LoggedError | undefined;
      try {
        for await (const event of model.stream(request)) {
          if (event.type === 'done') {
            result = {
              message: event.message,
              stopReason: event.stopReason,
              rawStopReason: event.rawStopReason,
              usage: event.usage,
              ...(event.servedBy === undefined ? {} : { servedBy: event.servedBy }),
            };
          } else if (firstOutputMs === undefined) {
            firstOutputMs = now() - at;
          }
          yield event;
        }
      } catch (caught) {
        error = describeError(caught);
        throw caught;
      } finally {
        if (!result && !error) error = { name: 'Stopped', message: 'the caller stopped reading before the end' };
        safeLog(log, {
          kind: 'model_call',
          at,
          provider: model.provider,
          model: model.model,
          request: {
            messages: request.messages,
            ...(request.system === undefined ? {} : { system: request.system }),
            ...(request.tools === undefined ? {} : { tools: request.tools }),
          },
          durationMs: now() - at,
          ...(firstOutputMs === undefined ? {} : { firstOutputMs }),
          ...(result ? { result } : {}),
          ...(error ? { error } : {}),
        });
      }
    },
  };
}

/** Keeps the latest records in memory, e.g. for tests or a debug endpoint. */
export function createMemoryLog(limit = 1000): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return {
    records,
    logger: (record) => {
      records.push(record);
      if (records.length > limit) records.splice(0, records.length - limit);
    },
  };
}

/**
 * One JSON line per record. Image data is replaced by its size unless `keepImages` is set
 * (screenshots would make logs huge, but replaying a call with images needs them).
 */
export function toJsonLine(record: LogRecord, options: { keepImages?: boolean } = {}): string {
  return JSON.stringify(record, function (this: unknown, key: string, value: unknown) {
    if (!options.keepImages && key === 'data' && typeof value === 'string' && (this as { type?: unknown }).type === 'image') {
      return `[image: ${value.length} base64 chars]`;
    }
    return value;
  });
}
