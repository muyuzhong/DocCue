/**
 * The scheduler: events in, turns out.
 *
 * Each session has one queue and one consumer, so its events are applied in order and its state
 * has a single writer. A turn runs in the background so the queue keeps moving: perception
 * events update the state mid-turn, and `cancel` stops the turn right away. At most one turn
 * runs per session.
 *
 * History stays in the order the model saw it. A user message that arrives mid-turn is not
 * written to history directly: it is handed to the running turn before its next model call, or,
 * if the turn ends first, it starts the next turn.
 */
import type { TurnRequest } from '../context/types.js';
import { describeError, safeLog, withModelLog } from '../log/log.js';
import { runTurn } from '../loop/run-turn.js';
import type { LoopEvent, TurnEnd } from '../loop/types.js';
import { ModelError } from '../model/errors.js';
import { emptyUsage, type Message } from '../model/types.js';
import { applyEvent, createSession } from '../state/reducer.js';
import { createMemoryStore } from '../state/store.js';
import type { SessionState, StateEvent, UserMessageEvent } from '../state/types.js';
import { answerQuestions } from './triggers.js';
import type { AgentOutput, InputEvent, OutputListener, Scheduler, SchedulerOptions } from './types.js';

interface TurnFinished {
  type: 'turn_finished';
  turnId: string;
  end: TurnEnd;
}

type QueuedEvent = InputEvent | TurnFinished;

interface QueueItem {
  event: QueuedEvent;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** Runtime state of one session. Kept in memory, not in the store: none of it can be serialized. */
interface Actor {
  id: string;
  queue: QueueItem[];
  draining: boolean;
  turn?: { id: string; controller: AbortController };
  /** User messages that arrived during the running turn and have not been handed to it yet. */
  pending: UserMessageEvent[];
  idleWaiters: Array<() => void>;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const store = options.store ?? createMemoryStore();
  const triggers = options.triggers ?? [answerQuestions];
  const now = options.reducer?.now ?? Date.now;
  const actors = new Map<string, Actor>();
  const listeners = new Map<string, Set<OutputListener>>();

  function emit(sessionId: string, output: AgentOutput): void {
    for (const listener of [...(listeners.get(sessionId) ?? [])]) {
      try {
        listener(output);
      } catch {
        // A broken listener must not break the session.
      }
    }
    try {
      options.onOutput?.(sessionId, output);
    } catch {
      // Same for the global listener.
    }
  }

  async function load(id: string): Promise<SessionState> {
    return (await store.get(id)) ?? createSession(id, now());
  }

  async function update(id: string, event: StateEvent): Promise<SessionState> {
    const next = applyEvent(await load(id), event, options.reducer);
    await store.set(next);
    return next;
  }

  function actorFor(id: string): Actor {
    let actor = actors.get(id);
    if (!actor) {
      actor = { id, queue: [], draining: false, pending: [], idleWaiters: [] };
      actors.set(id, actor);
    }
    return actor;
  }

  function enqueue(actor: Actor, event: QueuedEvent): Promise<void> {
    return new Promise((resolve, reject) => {
      actor.queue.push({ event, resolve, reject });
      void drain(actor);
    });
  }

  async function drain(actor: Actor): Promise<void> {
    if (actor.draining) return;
    actor.draining = true;
    try {
      for (let item = actor.queue.shift(); item; item = actor.queue.shift()) {
        try {
          await handle(actor, item.event);
          item.resolve();
        } catch (error) {
          emit(actor.id, { type: 'error', message: errorMessage(error) });
          item.reject(error);
        }
      }
    } finally {
      actor.draining = false;
      if (!actor.turn && actor.queue.length === 0) {
        actors.delete(actor.id);
        for (const wake of actor.idleWaiters.splice(0)) wake();
      }
    }
  }

  async function handle(actor: Actor, event: QueuedEvent): Promise<void> {
    if (event.type !== 'turn_finished') safeLog(options.logger, { kind: 'event', at: now(), sessionId: actor.id, event });
    switch (event.type) {
      case 'cancel':
        actor.turn?.controller.abort();
        return;
      case 'turn_finished':
        await finishTurn(actor, event);
        return;
      case 'user_message':
        if (actor.turn) {
          actor.pending.push(event);
          return;
        }
        break;
      default:
        break;
    }
    const session = await update(actor.id, event);
    if (actor.turn) return;
    for (const trigger of triggers) {
      const request = trigger.check(event, session);
      if (request) {
        startTurn(actor, request, session);
        return;
      }
    }
  }

  function startTurn(actor: Actor, request: TurnRequest, session: SessionState): void {
    const turnId = crypto.randomUUID();
    const controller = new AbortController();
    actor.turn = { id: turnId, controller };
    emit(actor.id, { type: 'turn_start', turnId, reason: request.reason });
    safeLog(options.logger, { kind: 'turn_start', at: now(), sessionId: actor.id, turnId, reason: request.reason });
    void runInBackground(actor, turnId, request, session, controller.signal)
      .then((end) => enqueue(actor, { type: 'turn_finished', turnId, end }))
      // A failure here was already reported as an `error` output by `drain`.
      .catch(() => {});
  }

  async function runInBackground(
    actor: Actor,
    turnId: string,
    request: TurnRequest,
    session: SessionState,
    signal: AbortSignal,
  ): Promise<TurnEnd> {
    try {
      const prepared = await options.context.prepare({ session, request, getSession: () => load(actor.id) });
      const takePending = (): Message[] =>
        actor.pending.splice(0).map((event): Message => ({ role: 'user', content: event.content }));
      let step = 0;
      const logger = options.logger;
      const model = logger
        ? withModelLog(options.model, (record) => logger({ ...record, sessionId: actor.id, turnId, step: ++step }), now)
        : options.model;
      const events = runTurn({
        model,
        messages: prepared.messages,
        signal,
        ...(prepared.system ? { system: prepared.system } : {}),
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
        ...(options.turnTimeoutMs === undefined ? {} : { timeoutMs: options.turnTimeoutMs }),
        // Mid-turn questions first, then whatever the context layer appends (e.g. a status bar).
        beforeModelCall: async (context) => [...takePending(), ...((await prepared.beforeModelCall?.(context)) ?? [])],
      });
      return await forward(actor.id, turnId, events);
    } catch (error) {
      return {
        type: 'turn_end',
        reason: signal.aborted ? 'aborted' : 'error',
        messages: [],
        usage: emptyUsage(),
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  async function forward(sessionId: string, turnId: string, events: AsyncIterable<LoopEvent>): Promise<TurnEnd> {
    for await (const event of events) {
      switch (event.type) {
        case 'step_start':
          emit(sessionId, { type: 'status', turnId, state: 'thinking' });
          break;
        case 'text':
          emit(sessionId, { type: 'text', turnId, delta: event.delta });
          break;
        case 'reasoning':
          emit(sessionId, { type: 'reasoning', turnId, delta: event.delta });
          break;
        case 'tool_call':
          emit(sessionId, { type: 'status', turnId, state: 'tool', tool: event.call.name });
          break;
        case 'turn_end':
          return event;
        default:
          break;
      }
    }
    throw new Error('the turn ended without a turn_end event');
  }

  async function finishTurn(actor: Actor, { turnId, end }: TurnFinished): Promise<void> {
    actor.turn = undefined;
    let saveError: unknown;
    try {
      await update(actor.id, { type: 'turn_messages', messages: end.messages });
    } catch (error) {
      saveError = error;
    }
    const error = end.error
      ? { message: end.error.message, ...(end.error instanceof ModelError && end.error.code ? { code: end.error.code } : {}) }
      : undefined;
    emit(actor.id, { type: 'turn_end', turnId, reason: end.reason, usage: end.usage, ...(error ? { error } : {}) });
    safeLog(options.logger, {
      kind: 'turn_end',
      at: now(),
      sessionId: actor.id,
      turnId,
      reason: end.reason,
      usage: end.usage,
      ...(end.error ? { error: describeError(end.error) } : {}),
    });
    // Questions asked during the turn that it never saw: apply them now (the first one starts
    // the next turn; any after it are handed to that turn).
    for (const message of actor.pending.splice(0)) await handle(actor, message);
    if (saveError !== undefined) throw saveError;
  }

  return {
    push(sessionId, event) {
      return enqueue(actorFor(sessionId), event);
    },
    subscribe(sessionId, listener) {
      let set = listeners.get(sessionId);
      if (!set) {
        set = new Set();
        listeners.set(sessionId, set);
      }
      const own = set;
      own.add(listener);
      return () => {
        own.delete(listener);
        if (own.size === 0 && listeners.get(sessionId) === own) listeners.delete(sessionId);
      };
    },
    idle(sessionId) {
      const actor = actors.get(sessionId);
      if (!actor) return Promise.resolve();
      return new Promise((resolve) => actor.idleWaiters.push(resolve));
    },
    getSession(sessionId) {
      return store.get(sessionId);
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
