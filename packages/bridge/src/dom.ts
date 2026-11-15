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

/**
 * Text only screen readers get: the usual "visually hidden" styles, clipped to nothing or squeezed
 * into a pixel (e.g. react-select's announcements, "1 result available…").
 */
export function isScreenReaderOnly(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(element);
  const clip = /^rect\(([^)]*)\)$/.exec(style.clip ?? '');
  if (clip) {
    const [top, right, bottom, left] = clip[1]!.split(/[\s,]+/).map((part) => parseFloat(part));
    if (top === bottom || right === left) return true;
  }
  if (/^inset\(\s*50%\s*\)$/.test(style.clipPath ?? '')) return true;
  const rect = element.getBoundingClientRect();
  // Without layout (a test DOM) every box is 0 by 0: that alone says nothing.
  const pixel = rect.width + rect.height > 0 && rect.width <= 1 && rect.height <= 1;
  return pixel && (style.position === 'absolute' || style.position === 'fixed') && style.overflow === 'hidden';
}

/** Visible text of an element, whitespace collapsed. */
export function textOf(element: Element): string {
  const html = element as HTMLElement;
  return clean(typeof html.innerText === 'string' ? html.innerText : element.textContent);
}
