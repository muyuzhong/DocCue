/**
 * The chat panel. It sits inside `data-cue-ignore`, so the bridge never records typing in it.
 * The debug section shows what the agent gets: the actions waiting to be sent, and the last
 * question as the model reads it.
 */
import type { Bridge, TimelineEntry } from '@doccue/bridge';
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

export function startAssistant(bridge: Bridge, user: Record<string, unknown>): void {
  const panel = document.querySelector<HTMLElement>('.assistant')!;
  const messages = panel.querySelector<HTMLElement>('.messages')!;
  const textarea = panel.querySelector<HTMLTextAreaElement>('textarea')!;
  const stop = panel.querySelector<HTMLButtonElement>('.stop')!;
  const recorded = panel.querySelector<HTMLElement>('.recorded')!;
  const context = panel.querySelector<HTMLElement>('.context')!;

  const add = (role: 'user' | 'assistant' | 'system', html: string) => {
    const element = document.createElement('div');
    element.className = `message ${role}`;
    element.innerHTML = html;
    messages.append(element);
    messages.scrollTop = messages.scrollHeight;
    return element;
  };

  let current: { element: HTMLElement; text: string } | undefined;
  const finish = (meta: string) => {
    if (!current) return;
    current.element.classList.add('done');
    if (!current.text) current.element.innerHTML = '<span class="muted">（没有回答）</span>';
    current.element.insertAdjacentHTML('beforeend', `<div class="meta">${meta}</div>`);
    current = undefined;
    stop.hidden = true;
  };

  bridge.on('status', (event) => {
    if (current && !current.text) {
      current.element.innerHTML = `<span class="thinking">${event.state === 'tool' ? `正在调用 ${escapeHtml(event.tool ?? '工具')}…` : '思考中…'}</span>`;
    }
  });
  bridge.on('text', (event) => {
    if (!current) return;
    current.text += event.delta;
    current.element.innerHTML = markdown(current.text);
    messages.scrollTop = messages.scrollHeight;
  });
  bridge.on('end', (event) => {
    const { inputTokens, outputTokens } = event.usage;
    finish(event.reason === 'completed' ? `输入 ${inputTokens} · 输出 ${outputTokens} tokens` : `${event.reason}${event.error ? `：${escapeHtml(event.error.message)}` : ''}`);
  });

  /** Shows the last question as the model reads it (rendered by the playground server). */
  const showContext = async () => {
    const response = await fetch('/debug/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversation: bridge.conversation(), locale: document.documentElement.lang, user }),
    });
    context.textContent = ((await response.json()) as { text?: string }).text || '（空）';
  };

  panel.querySelector('form')!.addEventListener('submit', async (event) => {
    event.preventDefault();
    const question = textarea.value.trim();
    if (!question) return;
    textarea.value = '';
    finish('已停止');
    add('user', escapeHtml(question));
    const mine = (current = { element: add('assistant', '<span class="thinking">思考中…</span>'), text: '' });
    stop.hidden = false;
    try {
      const asked = bridge.ask(question);
      void showContext();
      await asked;
    } catch (error) {
      add('system', escapeHtml(error instanceof Error ? error.message : String(error)));
    }
    // No end event arrived for this question: it was stopped or it failed.
    if (current === mine) finish('已停止');
  });
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
