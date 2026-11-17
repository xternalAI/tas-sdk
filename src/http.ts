/**
 * One retry policy for every outbound call that is safe to repeat: model calls and trace export.
 * Kept free of any knowledge about who is calling, so it can be tested on its own.
 */

export interface RetryOptions {
  /** Extra attempts after the first. 0 disables retrying. */
  retries: number;
  /** First wait; doubles each attempt, with jitter. Default 500. */
  baseDelayMs?: number;
  /** Longest single wait, including one the server asks for with Retry-After. Default 8000. */
  maxDelayMs?: number;
  signal?: AbortSignal;
}

/** Statuses that mean "try again": timeouts, rate limits, and server-side failures. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** How long the server asked us to wait, from a Retry-After header in seconds or as a date. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * `fetch`, repeated on network errors and retryable statuses. Returns the last response whatever
 * its status (the caller decides what a failure means); throws only when no response was ever
 * received, or the caller aborted.
 */
export async function fetchWithRetry(doFetch: typeof fetch, url: string | URL, init: RequestInit, options: RetryOptions): Promise<Response> {
  const base = options.baseDelayMs ?? 500;
  const max = options.maxDelayMs ?? 8000;
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= options.retries;
    let asked: number | undefined;
    try {
      const response = await doFetch(url, init);
      if (last || !RETRYABLE.has(response.status)) return response;
      asked = retryAfterMs(response);
      await response.body?.cancel().catch(() => undefined); // free the connection before waiting
    } catch (error) {
      if (last || isAbort(error) || options.signal?.aborted) throw error;
    }
    // Exponential backoff with jitter, unless the server said exactly how long to wait.
    const backoff = base * 2 ** attempt * (0.5 + Math.random() * 0.5);
    await wait(Math.min(asked ?? backoff, max), options.signal);
  }
}
