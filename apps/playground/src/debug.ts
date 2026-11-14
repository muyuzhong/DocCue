/**
 * The debug column: what the agent gets. The actions recorded and not sent yet, and the last
 * thing the model was sent (a question or a guide's result) as it reads it. Not part of an
 * integration: the chat itself is the bridge's built-in panel.
 */
import type { Bridge, TimelineEntry } from '@doccue/bridge';

/** A recorded action as one line. */
function describe(entry: TimelineEntry): string {
  const time = new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false });
  const { action, effects = [] } = entry;
  const what = action ? `${action.type} ${action.target?.role ?? ''} ${JSON.stringify(action.target?.name ?? '')}${action.value === undefined ? '' : ` = ${JSON.stringify(action.value)}`}` : '';
  const caused = effects.map((effect) => ('text' in effect ? `${effect.type} ${JSON.stringify(effect.text)}` : effect.type)).join(', ');
  return `${time} ${what}${what && caused ? ' → ' : ''}${caused}`;
}

export function startDebug(bridge: Bridge, user: Record<string, unknown>): void {
  const recorded = document.querySelector<HTMLElement>('.debug .recorded')!;
  const context = document.querySelector<HTMLElement>('.debug .context')!;

  /** Rendered by the playground server, the same way the backend renders it for the model. */
  const showContext = async () => {
    if (bridge.conversation().length === 0) {
      context.textContent = '（还没有提问）';
      return;
    }
    const response = await fetch('/debug/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversation: bridge.conversation(), locale: document.documentElement.lang, user }),
    });
    context.textContent = ((await response.json()) as { text?: string }).text || '（空）';
  };

  // A question or a guide result goes up when the bridge gets busy, and when a guide ends.
  bridge.on('state', (event) => event.busy && void showContext());
  bridge.on('guide_end', () => void showContext());
  bridge.on('reset', () => void showContext());
  void showContext();

  setInterval(() => {
    const lines = bridge.recorded().map(describe);
    recorded.textContent = lines.length > 0 ? lines.join('\n') : '（还没有操作）';
  }, 500);
}
