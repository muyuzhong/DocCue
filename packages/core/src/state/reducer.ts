import type { SessionState, StateEvent } from './types.js';

export interface ReducerOptions {
  /** Timeline entries kept per session. Defaults to 200. */
  timelineLimit?: number;
  /** Clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export function createSession(id: string, now: number = Date.now()): SessionState {
  return {
    id,
    createdAt: now,
    updatedAt: now,
    history: [],
    perception: { timeline: [], errors: [] },
    user: { attributes: {}, completedTours: [] },
  };
}

/** Returns the state after `event`. Pure: the input state is never modified. */
export function applyEvent(state: SessionState, event: StateEvent, options: ReducerOptions = {}): SessionState {
  const now = (options.now ?? Date.now)();
  const timelineLimit = options.timelineLimit ?? 200;

  switch (event.type) {
    case 'user_message':
      return { ...state, updatedAt: now, history: [...state.history, { role: 'user', content: event.content }] };

    case 'turn_messages':
      if (event.messages.length === 0) return state;
      return { ...state, updatedAt: now, history: [...state.history, ...event.messages] };

    case 'perception': {
      const perception = { ...state.perception };
      if (event.timeline && event.timeline.length > 0) {
        perception.timeline = [...perception.timeline, ...event.timeline].slice(-timelineLimit);
      }
      if (event.page) perception.page = event.page;
      if (event.screen !== undefined) perception.screen = { text: event.screen, at: now };
      if (event.errors) perception.errors = event.errors;
      return { ...state, updatedAt: now, perception };
    }

    case 'user_info': {
      const user = { ...state.user };
      if (event.attributes) user.attributes = { ...user.attributes, ...event.attributes };
      if (event.completedTours) user.completedTours = [...new Set([...user.completedTours, ...event.completedTours])];
      if (event.activeTour === null) delete user.activeTour;
      else if (event.activeTour) user.activeTour = event.activeTour;
      return { ...state, updatedAt: now, user };
    }
  }
}
