/** The error to throw when work stops because `signal` aborted. */
export function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false;
  const name = (error as { name: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** Waits `ms`, or rejects as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Settles like `promise`, or rejects as soon as `signal` aborts (the promise keeps running). */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The work keeps running; if it fails later, that failure must not go unhandled.
    promise.catch(() => {});
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
