/**
 * Waits until the page has settled after the user did something: no request of the page still on
 * its way and no change to the DOM for a short while. Used before looking at the screen again,
 * so the snapshot shows the result of the action and not a page halfway there.
 */
export interface SettleOptions {
  /** How long the DOM has to stay unchanged. */
  quietMs: number;
  /** Stop waiting after this long, settled or not. */
  maxMs: number;
}

export function whenSettled(document: Document, busy: () => boolean, options: SettleOptions): Promise<void> {
  const view = document.defaultView;
  const started = Date.now();
  let changed = started;
  const observer = view?.MutationObserver && document.body ? new view.MutationObserver(() => (changed = Date.now())) : undefined;
  observer?.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });

  return new Promise((resolve) => {
    const check = () => {
      const now = Date.now();
      if ((!busy() && now - changed >= options.quietMs) || now - started >= options.maxMs) {
        observer?.disconnect();
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}
