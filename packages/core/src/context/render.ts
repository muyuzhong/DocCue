/**
 * Renders session state as short text for the model: the status bar and the action timeline.
 */
import type { ActiveError, SessionState, TimelineEntry, UserState } from '../state/types.js';

export interface RenderOptions {
  /** Time zone for clock times, e.g. `Asia/Shanghai`. Defaults to the server's. */
  timeZone?: string;
  /** Recent actions listed in the status bar. Defaults to 6. */
  recentActions?: number;
}

const VERBS: Record<string, string> = {
  click: '点击',
  input: '填写',
  change: '修改',
  select: '选择',
  check: '勾选',
  uncheck: '取消勾选',
  toggle: '切换',
  submit: '提交',
  navigate: '进入页面',
  dialog: '弹窗',
  open: '打开',
  close: '关闭',
  error: '报错',
};

const clockFormats = new Map<string, Intl.DateTimeFormat>();

/** `19:08:32` in the given time zone. */
export function formatClock(at: number, timeZone?: string): string {
  const key = timeZone ?? '';
  let format = clockFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      ...(timeZone ? { timeZone } : {}),
    });
    clockFormats.set(key, format);
  }
  return format.format(at);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sameAction(a: TimelineEntry, b: TimelineEntry): boolean {
  return a.kind === b.kind && a.target === b.target && a.value === b.value && a.result === b.result && a.page === b.page;
}

/** Merges identical consecutive actions into one entry with a repeat count (keeping the latest time). */
export function foldTimeline(entries: readonly TimelineEntry[]): TimelineEntry[] {
  const folded: TimelineEntry[] = [];
  for (const entry of entries) {
    const last = folded[folded.length - 1];
    if (last && sameAction(last, entry)) {
      folded[folded.length - 1] = { ...last, at: entry.at, repeat: (last.repeat ?? 1) + (entry.repeat ?? 1) };
    } else {
      folded.push(entry);
    }
  }
  return folded;
}

/** One timeline line, e.g. `19:02:18 点击 按钮「测试连接」 → 出现报错「Invalid Host Format」`. */
export function describeAction(entry: TimelineEntry, timeZone?: string): string {
  const parts = [formatClock(entry.at, timeZone), VERBS[entry.kind] ?? entry.kind];
  const target = entry.kind === 'navigate' ? (entry.target ?? entry.page) : entry.target;
  if (target) parts.push(target);
  let line = parts.join(' ');
  if (entry.value !== undefined) line += ` = ${JSON.stringify(clip(entry.value, 200))}`;
  if (entry.repeat !== undefined && entry.repeat > 1) line += `（连续 ${entry.repeat} 次）`;
  if (entry.result) line += ` → ${entry.result}`;
  return line;
}

function describeError(error: ActiveError): string {
  const source = error.source === 'network' ? '[接口] ' : error.source === 'js' ? '[脚本] ' : '';
  return `${source}${error.text}${error.target ? `（${error.target}）` : ''}`;
}

function describeUser(user: UserState): string | undefined {
  const parts: string[] = [];
  const attributes = Object.entries(user.attributes).map(
    ([key, value]) => `${key}=${clip(typeof value === 'string' ? value : JSON.stringify(value), 80)}`,
  );
  if (attributes.length > 0) parts.push(attributes.join('，'));
  if (user.completedTours.length > 0) parts.push(`已完成引导：${user.completedTours.join('、')}`);
  return parts.length > 0 ? parts.join('；') : undefined;
}

/**
 * The status bar body: page, onboarding step, visible errors, user details and recent actions.
 * Lines without data are left out; returns `undefined` when there is nothing to say.
 */
export function renderStatus(session: SessionState, options: RenderOptions = {}): string | undefined {
  const lines: string[] = [];
  const { page, errors, timeline } = session.perception;
  if (page) lines.push(`页面：${page.title ? `${page.title}（${page.path}）` : page.path}`);
  const tour = session.user.activeTour;
  if (tour) lines.push(`引导：${tour.id} 第 ${tour.step}${tour.total ? `/${tour.total}` : ''} 步`);
  if (errors.length > 0) lines.push(`当前报错：${errors.map(describeError).join('；')}`);
  const user = describeUser(session.user);
  if (user) lines.push(`用户：${user}`);
  const recent = foldTimeline(timeline).slice(-(options.recentActions ?? 6));
  if (recent.length > 0) lines.push('最近操作：', ...recent.map((entry) => describeAction(entry, options.timeZone)));
  return lines.length > 0 ? lines.join('\n') : undefined;
}
