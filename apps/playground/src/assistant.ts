/**
 * The chat panel. It sits inside `data-cue-ignore`, so the bridge never records typing in it.
 * The debug section shows what the agent gets: the actions waiting to be sent, and the status
 * bar and screen tree from the last question.
 */
import type { Bridge } from '@doccue/bridge';
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

export function startAssistant(bridge: Bridge): void {
  const panel = document.querySelector<HTMLElement>('.assistant')!;
  const messages = panel.querySelector<HTMLElement>('.messages')!;
  const textarea = panel.querySelector<HTMLTextAreaElement>('textarea')!;
  const stop = panel.querySelector<HTMLButtonElement>('.stop')!;
  const recorded = panel.querySelector<HTMLElement>('.recorded')!;
  const status = panel.querySelector<HTMLElement>('.status')!;
  const screen = panel.querySelector<HTMLElement>('.screen')!;
  panel.querySelector('.session')!.textContent = `会话 ${bridge.sessionId.slice(0, 8)}`;

  const add = (role: 'user' | 'assistant' | 'system', html: string) => {
    const element = document.createElement('div');
    element.className = `message ${role}`;
    element.innerHTML = html;
    messages.append(element);
    messages.scrollTop = messages.scrollHeight;
    return element;
  };

  let current: { element: HTMLElement; text: string } | undefined;

  bridge.onOutput((output) => {
    switch (output.type) {
      case 'turn_start':
        current = { element: add('assistant', '<span class="thinking">思考中…</span>'), text: '' };
        stop.hidden = false;
        break;
      case 'status':
        if (current && !current.text) {
          current.element.innerHTML = `<span class="thinking">${output.state === 'tool' ? `正在调用 ${escapeHtml(output.tool ?? '工具')}…` : '思考中…'}</span>`;
        }
        break;
      case 'text':
        if (!current) break;
        current.text += output.delta;
        current.element.innerHTML = markdown(current.text);
        messages.scrollTop = messages.scrollHeight;
        break;
      case 'turn_end':
        if (current) {
          current.element.classList.add('done');
          if (!current.text) current.element.innerHTML = '<span class="muted">（没有回答）</span>';
          const usage = output.usage;
          const meta = output.reason === 'completed' ? `输入 ${usage.inputTokens} · 输出 ${usage.outputTokens} tokens` : `${output.reason}${output.error ? `：${escapeHtml(output.error.message)}` : ''}`;
          current.element.insertAdjacentHTML('beforeend', `<div class="meta">${meta}</div>`);
        }
        current = undefined;
        stop.hidden = true;
        break;
      case 'error':
        add('system', escapeHtml(output.message));
        break;
      default:
        break;
    }
  });

  const showDebug = async () => {
    const body = (await (await fetch(`/doccue/debug?sessionId=${encodeURIComponent(bridge.sessionId)}`)).json()) as { status?: string | null; screen?: string | null };
    status.textContent = body.status ?? '（空）';
    screen.textContent = body.screen ?? '（空）';
  };

  panel.querySelector('form')!.addEventListener('submit', async (event) => {
    event.preventDefault();
    const question = textarea.value.trim();
    if (!question) return;
    textarea.value = '';
    add('user', escapeHtml(question));
    try {
      await bridge.ask(question);
      await showDebug();
    } catch (error) {
      add('system', escapeHtml(error instanceof Error ? error.message : String(error)));
    }
  });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      panel.querySelector('form')!.requestSubmit();
    }
  });
  stop.addEventListener('click', () => void bridge.cancel());

  setInterval(() => {
    const lines = bridge.recorded().map((entry) => {
      const time = new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `${time} ${entry.kind} ${entry.target ?? ''}${entry.value !== undefined ? ` = ${JSON.stringify(entry.value)}` : ''}${entry.result ? ` → ${entry.result}` : ''}`;
    });
    recorded.textContent = lines.length > 0 ? lines.join('\n') : '（还没有操作）';
  }, 500);
}
