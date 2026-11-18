import { verifySignedSnapshot, type SignedSnapshot } from './attestation.ts';
import type { IndexSnapshot } from './snapshot.ts';

/**
 * Reads the published index from a site that serves the `/api/index` payloads.
 *
 * The client does not trust the host: every reading carries the signature check
 * it performed locally, so a caller can refuse an unsigned or altered snapshot
 * before using its level for anything.
 */
export interface IndexClientOptions {
  /** Site root, with or without a trailing slash. */
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  /** Milliseconds before a read is abandoned. */
  readonly timeoutMs?: number;
}

export type IndexClientErrorKind = 'network' | 'http' | 'shape';

export class IndexClientError extends Error {
  readonly kind: IndexClientErrorKind;
  readonly status: number | null;

  constructor(kind: IndexClientErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'IndexClientError';
    this.kind = kind;
    this.status = status;
  }
}

/** One published day, as the history payload reports it. */
export interface HistoryDay {
  readonly day: string;
  /** Index level, null when no series scored that day. */
  readonly index: number | null;
  readonly definitionId: string;
  readonly definitionSha256: string;
  readonly momentum: number | null;
  readonly coverageRatio: number | null;
  readonly seriesScored: number;
  readonly seriesExpected: number;
}

/** A latest-snapshot read, with the local signature check beside it. */
export interface LatestReading {
  readonly snapshot: IndexSnapshot;
  /** True when the payload hash and the Ed25519 signature both verify. */
  readonly verified: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function endpoint(options: IndexClientOptions, path: string): string {
  return `${options.baseUrl.replace(/\/+$/, '')}${path}`;
}

async function readJson(options: IndexClientOptions, path: string): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(endpoint(options, path), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new IndexClientError('network', `${path}: ${message}`);
  }
  if (!response.ok) {
    throw new IndexClientError('http', `${path}: HTTP ${response.status}`, response.status);
  }
  try {
    return await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new IndexClientError('shape', `${path}: response is not JSON (${message})`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Latest signed snapshot, or a typed error naming what arrived instead. */
export async function readLatest(options: IndexClientOptions): Promise<LatestReading> {
  const payload = await readJson(options, '/api/index/latest');
  if (!isRecord(payload) || !isRecord(payload['snapshot']) || !isRecord(payload['attestation'])) {
    throw new IndexClientError('shape', '/api/index/latest: no snapshot and attestation');
  }
  const snapshot = payload['snapshot'];
  const level = isRecord(snapshot) && isRecord(snapshot['index']) ? snapshot['index']['score'] : undefined;
  if (
    !isRecord(snapshot) ||
    typeof snapshot['epochDay'] !== 'string' ||
    (typeof level !== 'number' && level !== null)
  ) {
    throw new IndexClientError('shape', '/api/index/latest: snapshot has no epoch day or level');
  }
  const signed = payload as unknown as SignedSnapshot;
  return { snapshot: signed.snapshot, verified: verifySignedSnapshot(signed) };
}

/** Published history, oldest first, exactly as the site serves it. */
export async function readHistory(options: IndexClientOptions): Promise<readonly HistoryDay[]> {
  const payload = await readJson(options, '/api/index/history');
  if (!isRecord(payload) || !Array.isArray(payload['days'])) {
    throw new IndexClientError('shape', '/api/index/history: no days array');
  }
  return payload['days'].map((entry: unknown, position: number) => {
    if (!isRecord(entry) || typeof entry['day'] !== 'string') {
      throw new IndexClientError('shape', `/api/index/history: day ${position} has no date`);
    }
    return entry as unknown as HistoryDay;
  });
}
