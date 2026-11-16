import type { DailyObservation } from '../domain/observation.ts';
import { addDays } from '../domain/dates.ts';
import { sha256Hex } from '../domain/snapshot.ts';
import { HttpError, fetchText } from './http.ts';

const API_ROOT = 'https://hn.algolia.com/api/v1/search';
const MAX_DAYS = 62;

export type HackerNewsErrorKind = 'request-failed' | 'malformed-response';

export class HackerNewsError extends Error {
  readonly kind: HackerNewsErrorKind;

  constructor(kind: HackerNewsErrorKind, message: string) {
    super(message);
    this.name = 'HackerNewsError';
    this.kind = kind;
  }
}

/** One query's daily counts, with the provenance needed to audit them. */
export interface MentionsFetch {
  readonly urls: readonly string[];
  readonly retrievedAt: string;
  readonly payloadSha256: string;
  readonly observations: readonly DailyObservation[];
}

function epochSeconds(day: string, deltaDays = 0): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + deltaDays * 86_400;
}

/**
 * Builds the public query URL for one UTC day.
 *
 * `hitsPerPage=0` asks Algolia for the match count only, which keeps the
 * response small and makes the number for each day independently verifiable
 * from its own URL. Stories only: comments mentioning an entity measure
 * discussion threads, not attention to the entity.
 */
export function mentionsUrl(query: string, day: string): string {
  if (Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    throw new HackerNewsError('request-failed', `invalid day: ${day}`);
  }
  const filters = `created_at_i>=${epochSeconds(day)},created_at_i<${epochSeconds(day, 1)}`;
  return (
    `${API_ROOT}?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=0` +
    `&numericFilters=${encodeURIComponent(filters)}`
  );
}

/** Reads the total match count out of an Algolia response. */
export function parseMentionCount(payload: unknown): number {
  const nbHits = (payload as { nbHits?: unknown } | null)?.nbHits;
  if (typeof nbHits !== 'number' || !Number.isFinite(nbHits) || nbHits < 0) {
    throw new HackerNewsError('malformed-response', 'response has no usable nbHits');
  }
  return nbHits;
}

/**
 * Fetches daily story counts for one query over an inclusive day range.
 *
 * One request per day rather than one request per range: the range endpoint
 * caps pagination, so a busy day could silently truncate, and a per-day URL
 * lets a skeptic check a single number without trusting the total.
 */
export async function fetchMentions(
  query: string,
  startDay: string,
  endDay: string,
  options: { fetchImpl?: typeof fetch; now?: () => Date } = {},
): Promise<MentionsFetch> {
  const start = Date.parse(`${startDay}T00:00:00Z`);
  const end = Date.parse(`${endDay}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    throw new HackerNewsError('request-failed', `invalid range: ${startDay} to ${endDay}`);
  }
  const span = Math.round((end - start) / 86_400_000) + 1;
  if (span > MAX_DAYS) {
    throw new HackerNewsError('request-failed', `range of ${span} days exceeds ${MAX_DAYS}`);
  }

  const urls: string[] = [];
  const bodies: string[] = [];
  const observations: DailyObservation[] = [];
  for (let offset = 0; offset < span; offset += 1) {
    const day = addDays(startDay, offset);
    const url = mentionsUrl(query, day);
    let text: string;
    try {
      text = await fetchText(url, options.fetchImpl);
    } catch (error) {
      if (error instanceof HttpError) {
        throw new HackerNewsError('request-failed', error.message);
      }
      throw error;
    }
    urls.push(url);
    bodies.push(text);
    observations.push({ day, value: parseMentionCount(JSON.parse(text)) });
  }

  const now = options.now?.() ?? new Date();
  return {
    urls,
    retrievedAt: now.toISOString(),
    payloadSha256: sha256Hex(bodies.join('\n')),
    observations,
  };
}
