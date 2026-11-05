/**
 * The screen tree: a compact text outline of what is visible, for the model. Headings, groups
 * (dialogs, forms, tables), every control with its current value and state, error messages,
 * notices and short visible text. Controls are numbered so later actions can point at them.
 *
 *   页面「新建数据源」 /datasource/new
 *   标题「新建数据源」
 *   表单「连接信息」
 *     [1] 输入框「主机地址」: "http://127.0.0.1:5432" ⚠
 *     报错「Invalid Host Format」
 *     [2] 按钮「测试连接」
 */
import { clean, clip, isIgnored, isVisible, textOf } from './dom.js';
import { accessibleName, controlRole, dialogTitle, isInteractive } from './naming.js';

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD', 'META', 'LINK', 'OPTION']);
const TEXT_TAGS = new Set(['P', 'LI', 'TD', 'TH', 'SPAN', 'DIV', 'DD', 'DT', 'SMALL', 'STRONG', 'EM', 'B', 'CAPTION', 'FIGCAPTION', 'BLOCKQUOTE', 'PRE', 'CODE']);
const TEXT_FIELD_TYPES = new Set(['text', 'email', 'number', 'search', 'tel', 'url', 'date', 'datetime-local', 'month', 'time', 'week', 'color', '']);

export interface ScreenOptions {
  errorSelectors: readonly string[];
  /** Cut the outline at this many characters. */
  maxChars: number;
  /** Stop walking after this many elements, to stay cheap on huge pages. */
  maxElements?: number;
}

function controlLine(element: Element, index: number): string {
  const name = accessibleName(element);
  let line = `[${index}] ${controlRole(element)}${name ? `「${name}」` : ''}`;
  const tag = element.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const field = element as HTMLInputElement;
    if (field.type === 'checkbox' || field.type === 'radio') line += field.checked ? '（已勾选）' : '（未勾选）';
    else if (field.type === 'password') line += field.value ? '：（已填写）' : '：（空）';
    else if (field.type === 'file') line += field.files?.length ? `：（已选 ${field.files.length} 个文件）` : '：（未选择）';
    else if (TEXT_FIELD_TYPES.has(field.type) || tag === 'TEXTAREA') line += field.value ? `: ${JSON.stringify(clip(field.value, 60))}` : '：（空）';
  } else if (tag === 'SELECT') {
    const select = element as HTMLSelectElement;
    const chosen = Array.from(select.selectedOptions ?? []).map((option) => clean(option.textContent)).filter(Boolean);
    line += chosen.length > 0 ? `: ${JSON.stringify(clip(chosen.join('、'), 60))}` : '：（未选择）';
  } else if (element.getAttribute('role') === 'checkbox' || element.getAttribute('role') === 'switch') {
    line += element.getAttribute('aria-checked') === 'true' ? '（已打开）' : '（已关闭）';
  }
  const states: string[] = [];
  if ((element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true') states.push('不可用');
  if (element.getAttribute('aria-selected') === 'true' || element.hasAttribute('aria-current')) states.push('当前');
  const expanded = element.getAttribute('aria-expanded');
  if (expanded) states.push(expanded === 'true' ? '已展开' : '已收起');
  if (states.length > 0) line += `（${states.join('，')}）`;
  if (element.getAttribute('aria-invalid') === 'true') line += ' ⚠';
  return line;
}

function groupLine(element: Element): string | undefined {
  const tag = element.tagName;
  const role = element.getAttribute('role');
  const label = clean(element.getAttribute('aria-label'));
  if (role === 'dialog' || role === 'alertdialog' || tag === 'DIALOG') return `弹窗「${dialogTitle(element)}」`;
  if (tag === 'FORM') return label ? `表单「${label}」` : '表单';
  if (tag === 'FIELDSET') {
    const legend = element.querySelector('legend');
    return `分组「${legend ? textOf(legend) : label || '未命名'}」`;
  }
  if (tag === 'NAV' || role === 'navigation') return label ? `导航「${label}」` : '导航';
  if (tag === 'TABLE' || role === 'table' || role === 'grid') return label ? `表格「${label}」` : '表格';
  if (tag === 'TR' || role === 'row') return '行';
  if (role === 'tablist') return '标签页组';
  if (role === 'menu' || role === 'menubar') return '菜单';
  return undefined;
}

/** Text directly inside the element (not inside its child elements). */
function ownText(element: Element): string {
  let text = '';
  element.childNodes.forEach((node) => {
    if (node.nodeType === 3) text += node.textContent ?? '';
  });
  return clean(text);
}

export function buildScreen(document: Document, options: ScreenOptions): string {
  const lines: string[] = [`页面「${clip(clean(document.title) || '未命名', 40)}」 ${document.location?.pathname ?? ''}`.trim()];
  const errorSelector = options.errorSelectors.join(', ');
  const maxElements = options.maxElements ?? 5000;
  let visited = 0;
  let controls = 0;
  let size = lines[0]!.length;
  let cut = 0;

  const push = (depth: number, text: string) => {
    const line = `${'  '.repeat(depth)}${text}`;
    if (size + line.length + 1 > options.maxChars) {
      cut++;
      return;
    }
    lines.push(line);
    size += line.length + 1;
  };

  // Inside a <label> the text is the control's name, so only the control itself is listed.
  const walk = (element: Element, depth: number, inLabel = false) => {
    if (++visited > maxElements) return;
    if (SKIP_TAGS.has(element.tagName.toUpperCase()) || isIgnored(element) || !isVisible(element)) return;

    if (/^H[1-6]$/i.test(element.tagName) || element.getAttribute('role') === 'heading') {
      const text = textOf(element);
      if (text) push(depth, `标题「${clip(text, 60)}」`);
      return;
    }
    if (isInteractive(element)) {
      push(depth, controlLine(element, ++controls));
      return;
    }
    if (errorSelector && element.matches(errorSelector)) {
      const text = textOf(element);
      if (text) push(depth, `报错「${clip(text, 100)}」`);
      return;
    }
    if (element.matches('[role="status"], [aria-live="polite"]')) {
      const text = textOf(element);
      if (text) push(depth, `提示「${clip(text, 100)}」`);
      return;
    }

    const group = groupLine(element);
    if (group) push(depth, group);
    const childDepth = group ? depth + 1 : depth;
    const quiet = inLabel || element.tagName.toUpperCase() === 'LABEL';
    if (!quiet && TEXT_TAGS.has(element.tagName.toUpperCase())) {
      const text = ownText(element);
      if (text) push(childDepth, `文字「${clip(text, 80)}」`);
    }
    for (const child of Array.from(element.children)) walk(child, childDepth, quiet);
  };

  if (document.body) for (const child of Array.from(document.body.children)) walk(child, 0);
  if (cut > 0) lines.push(`…（还有 ${cut} 行未显示）`);
  return lines.join('\n');
}
