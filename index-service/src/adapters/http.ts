/** HTTP helpers shared by the source adapters. */

/** Public data sources require a descriptive agent and throttle generic ones. */
export const DEFAULT_USER_AGENT =
  process.env['PULSE_USER_AGENT'] ??
  'pulse-index/0.1 (https://github.com/maxxexee/pulse-markets; index-service)';

const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 1_000;

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GETs a URL as text, retrying throttling and server errors with exponential
 * backoff. Client errors other than 429 are raised immediately: retrying a
 * request the server has rejected on its merits only wastes the quota.
 */
export async function fetchText(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let lastError = new HttpError(0, `no attempt made for ${url}`);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { 'user-agent': DEFAULT_USER_AGENT, accept: 'application/json' },
      });
    } catch (error) {
      // A reset or refused connection is as transient as a 5xx, so it retries.
      // Undici hides the real reason in `cause`, and "fetch failed" alone does
      // not say whether the host refused, reset or timed out.
      const message = error instanceof Error ? error.message : String(error);
      const cause = (error as { cause?: unknown }).cause;
      const causeText =
        cause instanceof Error ? cause.message : cause === undefined ? '' : String(cause);
      const detail = causeText === '' ? message : `${message}: ${causeText}`;
      lastError = new HttpError(0, `network error for ${url}: ${detail}`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
      }
      continue;
    }
    if (response.ok) {
      return response.text();
    }
    lastError = new HttpError(response.status, `HTTP ${response.status} for ${url}`);
    if (response.status !== 429 && response.status < 500) {
      throw lastError;
    }
    if (attempt < MAX_ATTEMPTS) {
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}
