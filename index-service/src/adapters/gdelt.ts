import type { DailyObservation } from '../domain/observation.ts';
import { addDays, isValidDay } from '../domain/dates.ts';
import { sha256Hex } from '../domain/snapshot.ts';
import { HttpError, fetchText } from './http.ts';

const API_ROOT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const MAX_DAYS = 62;

/**
 * GDELT asks for at most one request every five seconds. Six is used so that
 * clock skew and a slow response do not put two requests inside one window.
 */
const MIN_REQUEST_SPACING_MS = 6_000;

/** GDELT answers a throttled request with this plain text, sometimes with 200. */
const RATE_LIMIT_TEXT = /^\s*Please limit requests/i;

/**
 * Wait before re-requesting a throttled GDELT call, doubled per attempt.
 *
 * GDELT's 429 does not mean "wait five seconds": once an IP is throttled the
 * refusal lasted well over ten minutes in testing, so short backoff spends the
 * quota on requests that cannot succeed. A build runs once a day, so waiting
 * minutes is cheaper than losing the epoch.
 */
const MIN_THROTTLE_WAIT_MS = 60_000;

/**
 * Share of a requested range that must come back before the series is usable.
 *
 * GDELT drops days from its own timeline (six consecutive days were missing in
 * November 2026 for every query tested), so a contiguous series is not
 * obtainable. Seventy percent still forces the target day plus most of the
 * baseline, and a real outage fails rather than scoring an entity on a fragment.
 */
const MIN_COVERAGE = 0.7;

export type GdeltErrorKind = 'request-failed' | 'malformed-response' | 'incomplete-series';

export class GdeltError extends Error {
  readonly kind: GdeltErrorKind;

  constructor(kind: GdeltErrorKind, message: string) {
    super(message);
    this.name = 'GdeltError';
    this.kind = kind;
  }
}

/** One query's daily article counts, with the provenance needed to audit them. */
export interface ArticlesFetch {
  readonly urls: readonly string[];
  readonly retrievedAt: string;
  readonly payloadSha256: string;
  readonly observations: readonly DailyObservation[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serialises every GDELT request in the process, spaced out.
 *
 * The quota is per IP, not per query, and the builder fetches entities
 * concurrently, so spacing inside one call would still let two entities collide.
 * A single queue keeps the whole run inside the published rate limit.
 */
let requestChain: Promise<unknown> = Promise.resolve();
let lastRequestStartedAt = 0;

function serialized<T>(task: () => Promise<T>, spacingMs: number): Promise<T> {
  const run = requestChain.then(async () => {
    const waitMs = lastRequestStartedAt + spacingMs - Date.now();
    if (spacingMs > 0 && waitMs > 0) {
      await sleep(waitMs);
    }
    lastRequestStartedAt = Date.now();
    return task();
  });
  requestChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Builds the public URL for one query over an inclusive day range.
 *
 * `timelinevolraw` returns raw article counts per day, and one request covers
 * the whole baseline window rather than one request per day. The query is
 * quoted so GDELT matches the phrase, not the words separately.
 */
export function gdeltUrl(query: string, startDay: string, endDay: string): string {
  if (!isValidDay(startDay) || !isValidDay(endDay) || endDay < startDay) {
    throw new GdeltError('request-failed', `invalid range: ${startDay} to ${endDay}`);
  }
  const params = [
    `query=${encodeURIComponent(`"${query}"`)}`,
    'mode=timelinevolraw',
    'format=json',
    `startdatetime=${startDay.replaceAll('-', '')}000000`,
    `enddatetime=${endDay.replaceAll('-', '')}235959`,
  ];
  return `${API_ROOT}?${params.join('&')}`;
}

/**
 * Converts a GDELT timeline into daily observations.
 *
 * GDELT silently omits days, and a missing day is not the same as a day with
 * no articles: the true count is unknown. Missing days are therefore dropped
 * rather than filled with zero, which would depress the baseline and inflate
 * every score. The target day must be present and coverage must clear
 * `MIN_COVERAGE`, so an outage fails instead of producing a number from a
 * fragment of the window.
 */
export function parseTimeline(
  payload: unknown,
  startDay: string,
  endDay: string,
): DailyObservation[] {
  const timeline = (payload as { timeline?: unknown } | null)?.timeline;
  if (!Array.isArray(timeline) || timeline.length === 0) {
    throw new GdeltError('malformed-response', 'response has no timeline');
  }
  const data = (timeline[0] as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) {
    throw new GdeltError('malformed-response', 'timeline has no data array');
  }

  const byDay = new Map<string, number>();
  for (const point of data) {
    const record = point as { date?: unknown; value?: unknown };
    if (typeof record.date !== 'string' || !/^\d{8}T\d{6}Z$/.test(record.date)) {
      throw new GdeltError('malformed-response', 'timeline point has no usable date');
    }
    if (
      typeof record.value !== 'number' ||
      !Number.isFinite(record.value) ||
      record.value < 0
    ) {
      throw new GdeltError('malformed-response', 'timeline point has no usable value');
    }
    const day = `${record.date.slice(0, 4)}-${record.date.slice(4, 6)}-${record.date.slice(6, 8)}`;
    if (byDay.has(day)) {
      throw new GdeltError('malformed-response', `timeline repeats ${day}`);
    }
    byDay.set(day, record.value);
  }

  const span =
    Math.round((Date.parse(`${endDay}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`)) / 86_400_000) +
    1;
  const expected = Array.from({ length: span }, (_, offset) => addDays(startDay, offset));
  const outside = [...byDay.keys()].filter((day) => day < startDay || day > endDay);
  if (outside.length > 0) {
    throw new GdeltError(
      'incomplete-series',
      `GDELT returned ${outside.length} day(s) outside the requested range`,
    );
  }
  if (!byDay.has(endDay)) {
    throw new GdeltError('incomplete-series', `GDELT has no count for ${endDay}`);
  }
  const present = expected.filter((day) => byDay.has(day));
  if (present.length / span < MIN_COVERAGE) {
    throw new GdeltError(
      'incomplete-series',
      `GDELT covered ${present.length} of ${span} days, below ${Math.round(MIN_COVERAGE * 100)} percent`,
    );
  }

  return present.map((day) => ({ day, value: byDay.get(day) ?? 0 }));
}

/**
 * GETs one timeline, waiting out a throttle.
 *
 * A throttled GDELT call arrives as an HTTP 429, a dropped connection, or a 200
 * carrying plain text, and all three clear on the same timescale, so one loop
 * owns the wait and the HTTP helper is asked for a single attempt. Errors the
 * server will not reconsider (a 404, a bad query) are raised at once.
 */
async function requestTimeline(
  url: string,
  fetchImpl: typeof fetch,
  throttleWaitMs: number,
): Promise<string> {
  const attempts = 3;
  let lastError = `throttled after ${attempts} attempts: ${url}`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const text = await fetchText(url, fetchImpl, { attempts: 1 });
      if (!RATE_LIMIT_TEXT.test(text)) {
        return text;
      }
      lastError = `GDELT answered the throttle as plain text: ${url}`;
    } catch (error) {
      const retriable =
        error instanceof HttpError &&
        (error.status === 0 || error.status === 429 || error.status >= 500);
      if (!retriable) {
        if (error instanceof HttpError) {
          throw new GdeltError('request-failed', error.message);
        }
        throw error;
      }
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) {
      await sleep(throttleWaitMs * attempt);
    }
  }
  throw new GdeltError('request-failed', lastError);
}

/**
 * Fetches daily news article counts for one query over an inclusive day range.
 *
 * One request per range here, unlike Hacker News: GDELT's timeline endpoint is
 * the timestamped series, and it is the only form of the data that does not cap
 * pagination or silently truncate a busy day.
 */
export async function fetchArticles(
  query: string,
  startDay: string,
  endDay: string,
  options: {
    fetchImpl?: typeof fetch;
    now?: () => Date;
    spacingMs?: number;
    throttleWaitMs?: number;
  } = {},
): Promise<ArticlesFetch> {
  const url = gdeltUrl(query, startDay, endDay);
  const span =
    Math.round((Date.parse(`${endDay}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`)) / 86_400_000) +
    1;
  if (span > MAX_DAYS) {
    throw new GdeltError('request-failed', `range of ${span} days exceeds ${MAX_DAYS}`);
  }

  const spacingMs = options.spacingMs ?? MIN_REQUEST_SPACING_MS;
  const throttleWaitMs = options.throttleWaitMs ?? MIN_THROTTLE_WAIT_MS;
  const text = await serialized(
    () => requestTimeline(url, options.fetchImpl ?? fetch, throttleWaitMs),
    spacingMs,
  );

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new GdeltError('malformed-response', `response is not JSON: ${text.slice(0, 80)}`);
  }

  const now = options.now?.() ?? new Date();
  return {
    urls: [url],
    retrievedAt: now.toISOString(),
    payloadSha256: sha256Hex(text),
    observations: parseTimeline(payload, startDay, endDay),
  };
}
