/**
 * The chat panel. It sits inside `data-cue-ignore`, so the bridge never records typing in it.
 * The debug section shows what the agent gets: the actions waiting to be sent, and the last
 * question as the model reads it.
 */
import type { Bridge, Item, TimelineEntry } from '@doccue/bridge';
import { escapeHtml } from './app.js';

/** Just enough Markdown for chat answers: code blocks, inline code, bold, lists, paragraphs. */
function markdown(source: string): string {
  const blocks = source.split(/```/);
  return blocks
    .map((block, index) => {
      if (index % 2 === 1) return `<pre><code>${escapeHtml(block.replace(/^[a-z]*\n/, ''))}</code></pre>`;
      return escapeHtml(block)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .split(/\n{2,}/)
        .map((paragraph) => {
          const lines = paragraph.trim().split('\n');
          if (lines.every((line) => /^\s*([-*]|\d+\.)\s/.test(line))) {
            const ordered = /^\s*\d+\./.test(lines[0] ?? '');
            const items = lines.map((line) => `<li>${line.replace(/^\s*([-*]|\d+\.)\s/, '')}</li>`).join('');
            return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
          }
          return paragraph.trim() ? `<p>${lines.join('<br>')}</p>` : '';
        })
        .join('');
    })
    .join('');
}

/** A recorded action as one line, for the debug panel. */
function describe(entry: TimelineEntry): string {
  const time = new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false });
  const { action, effects = [] } = entry;
  const what = action ? `${action.type} ${action.target?.role ?? ''} ${JSON.stringify(action.target?.name ?? '')}${action.value === undefined ? '' : ` = ${JSON.stringify(action.value)}`}` : '';
  const caused = effects.map((effect) => ('text' in effect ? `${effect.type} ${JSON.stringify(effect.text)}` : effect.type)).join(', ');
  return `${time} ${what}${what && caused ? ' → ' : ''}${caused}`;
}

/** The text of a model item. Its messages are the backend's business; the demo peeks to redraw the chat after a reload. */
function answerText(item: Extract<Item, { type: 'model' }>): string {
  const messages = item.messages as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
  return messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.content ?? [])
    .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
    .join('');
}

export function startAssistant(bridge: Bridge, user: Record<string, unknown>): void {
  const panel = document.querySelector<HTMLElement>('.assistant')!;
  const messages = panel.querySelector<HTMLElement>('.messages')!;
  const textarea = panel.querySelector<HTMLTextAreaElement>('textarea')!;
  const stop = panel.querySelector<HTMLButtonElement>('.stop')!;
  const recorded = panel.querySelector<HTMLElement>('.recorded')!;
  const context = panel.querySelector<HTMLElement>('.context')!;

  const add = (role: 'user' | 'assistant' | 'system' | 'note', html: string) => {
    const element = document.createElement('div');
    element.className = `message ${role}`;
    element.innerHTML = html;
    messages.append(element);
    messages.scrollTop = messages.scrollHeight;
    return element;
  };

  // One bubble per request: a question can lead to several (an answer, a guide, a follow-up).
  let current: { element: HTMLElement; text: string } | undefined;
  const bubble = () => (current ??= { element: add('assistant', '<span class="thinking">思考中…</span>'), text: '' });
  const finish = (meta: string) => {
    if (!current) return;
    current.element.classList.add('done');
    if (!current.text) current.element.innerHTML = '';
    current.element.insertAdjacentHTML('beforeend', `<div class="meta">${meta}</div>`);
    current = undefined;
  };

  /** Shows what the model was sent last, as it reads it (rendered by the playground server). */
  const showContext = async () => {
    const response = await fetch('/debug/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversation: bridge.conversation(), locale: document.documentElement.lang, user }),
    });
    context.textContent = ((await response.json()) as { text?: string }).text || '（空）';
  };

  bridge.on('status', (event) => {
    const { element, text } = bubble();
    if (!text) element.innerHTML = `<span class="thinking">${event.state === 'tool' ? `正在调用 ${escapeHtml(event.tool ?? '工具')}…` : '思考中…'}</span>`;
  });
  bridge.on('text', (event) => {
    const active = bubble();
    active.text += event.delta;
    active.element.innerHTML = markdown(active.text);
    messages.scrollTop = messages.scrollHeight;
  });
  bridge.on('guide', (event) => add('note', `开始引导（${event.steps.length} 步）：${event.steps.map((step) => `[${String(step.target)}] ${escapeHtml(step.text)}`).join(' → ')}`));
  bridge.on('guide_end', (event) => {
    add('note', `引导结束：${event.outcome}，完成 ${event.completedSteps} 步`);
    void showContext();
  });
  bridge.on('end', (event) => {
    bubble();
    const { inputTokens, outputTokens } = event.usage;
    const tokens = `输入 ${inputTokens} · 输出 ${outputTokens} tokens`;
    if (event.reason === 'completed') finish(tokens);
    else if (event.reason === 'guide') finish(`在页面上引导 · ${tokens}`);
    else finish(`${event.reason}${event.error ? `：${escapeHtml(event.error.message)}` : ''}`);
  });

  panel.querySelector('form')!.addEventListener('submit', async (event) => {
    event.preventDefault();
    const question = textarea.value.trim();
    if (!question) return;
    textarea.value = '';
    finish('已停止');
    add('user', escapeHtml(question));
    try {
      const asked = bridge.ask(question);
      void showContext();
      await asked;
    } catch (error) {
      add('system', escapeHtml(error instanceof Error ? error.message : String(error)));
    }
  });
  // Busy while an answer is on its way or a guide is on screen, also when a reload interrupted one.
  bridge.on('state', (event) => {
    stop.hidden = !event.busy;
    if (!event.busy) finish('已停止');
  });
  stop.hidden = !bridge.busy();

  // After a full page load: redraw what was said so far.
  for (const item of bridge.conversation()) {
    if (item.type === 'user') add('user', escapeHtml(item.text));
    else if (item.type === 'model') answerText(item) && add('assistant', markdown(answerText(item))).classList.add('done');
    else add('note', `引导结束：${item.result.outcome}，完成 ${item.result.completedSteps} 步`);
  }
  if (bridge.conversation().length > 0) void showContext();
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      panel.querySelector('form')!.requestSubmit();
    }
  });
  stop.addEventListener('click', () => bridge.stop());
  panel.querySelector('.reset')!.addEventListener('click', () => {
    bridge.reset();
    messages.innerHTML = '';
    context.textContent = '（还没有提问）';
  });

  setInterval(() => {
    const lines = bridge.recorded().map(describe);
    recorded.textContent = lines.length > 0 ? lines.join('\n') : '（还没有操作）';
  }, 500);
}
