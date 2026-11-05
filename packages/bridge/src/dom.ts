/** Small DOM helpers shared by the bridge modules. */

export const IGNORE_ATTRIBUTE = 'data-cue-ignore';

/** Collapses whitespace and trims. */
export function clean(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function isElement(node: unknown): node is Element {
  return typeof node === 'object' && node !== null && (node as Node).nodeType === 1;
}

/** Inside a `data-cue-ignore` region (e.g. the assistant's own chat panel). */
export function isIgnored(element: Element): boolean {
  return element.closest(`[${IGNORE_ATTRIBUTE}]`) !== null;
}

/** Whether the element is rendered and not hidden from users. */
export function isVisible(element: Element): boolean {
  if (!element.isConnected) return false;
  if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
  const withCheck = element as Element & { checkVisibility?: (options?: Record<string, boolean>) => boolean };
  if (typeof withCheck.checkVisibility === 'function') return withCheck.checkVisibility({ checkVisibilityCSS: true });
  // Fallback for environments without checkVisibility (older browsers, test DOMs).
  const view = element.ownerDocument.defaultView;
  if (!view) return true;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.display === 'none') return false;
    if (node === element && (style.visibility === 'hidden' || style.visibility === 'collapse')) return false;
  }
  return true;
}

/** Visible text of an element, whitespace collapsed. */
export function textOf(element: Element): string {
  const html = element as HTMLElement;
  return clean(typeof html.innerText === 'string' ? html.innerText : element.textContent);
}
