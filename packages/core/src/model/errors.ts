export interface ModelErrorOptions {
  provider: string;
  status?: number;
  /** Provider error type or code, e.g. `overloaded_error`, `rate_limit_exceeded`. */
  code?: string;
  /** Whether sending the same request again may succeed. */
  retryable?: boolean;
  /** How long the provider asked us to wait before retrying. */
  retryAfterMs?: number;
  cause?: unknown;
}

/** An API or network failure from a model provider. */
export class ModelError extends Error {
  readonly provider: string;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: ModelErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ModelError';
    this.provider = options.provider;
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function parseRetryAfter(headers: Headers): number | undefined {
  const ms = Number(headers.get('retry-after-ms'));
  if (headers.has('retry-after-ms') && Number.isFinite(ms)) return ms;
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Builds a `ModelError` from a non-2xx response, reading the provider's JSON error body. */
export async function errorFromResponse(provider: string, response: Response): Promise<ModelError> {
  const text = await response.text().catch(() => '');
  let message = text.trim() || response.statusText || 'request failed';
  let code: string | undefined;
  try {
    const body = JSON.parse(text) as { error?: unknown };
    const error = (typeof body.error === 'object' && body.error !== null ? body.error : body) as {
      message?: unknown;
      type?: unknown;
      code?: unknown;
    };
    if (typeof error.message === 'string') message = error.message;
    if (typeof error.code === 'string') code = error.code;
    else if (typeof error.type === 'string') code = error.type;
  } catch {
    // Not JSON: keep the raw text.
  }
  const retryAfterMs = parseRetryAfter(response.headers);
  return new ModelError(`${provider} ${response.status}: ${message}`, {
    provider,
    status: response.status,
    retryable: isRetryableStatus(response.status),
    ...(code === undefined ? {} : { code }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/** Wraps a connection failure (DNS, reset, dropped stream). These are always retryable. */
export function networkError(provider: string, cause: unknown): ModelError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new ModelError(`${provider}: network error: ${detail}`, { provider, retryable: true, cause });
}
