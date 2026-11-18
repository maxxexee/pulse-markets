import { addDays } from './dates.ts';

/** What the latest snapshot looks like to anyone asking whether the index is alive. */
export interface PublishedSnapshotView {
  readonly epochDay: string;
  readonly indexScore: number | null;
  readonly confidence: number | null;
  /** Share of the headline weight the published index actually represents. */
  readonly weightScored: number | null;
  readonly signer: string;
  readonly payloadSha256: string;
}

export type HealthStatus = 'ok' | 'stale' | 'missing' | 'unverified';

export interface HealthReport {
  /** `ok`, or the first thing wrong: missing, unverified, stale. */
  readonly status: HealthStatus;
  /** UTC day the latest snapshot should describe: the previous UTC day. */
  readonly expectedEpochDay: string;
  readonly epochDay: string | null;
  /** Days the published epoch is behind the expected one, null when there is none. */
  readonly ageDays: number | null;
  readonly maxAgeDays: number;
  readonly indexScore: number | null;
  readonly confidence: number | null;
  readonly weightScored: number | null;
  readonly signer: string | null;
  readonly payloadSha256: string | null;
  /** One line a human or a log can read without parsing the rest. */
  readonly detail: string;
  readonly checkedAt: string;
}

const MS_PER_DAY = 86_400_000;

/** Everything a report knows about a snapshot that exists. */
type Observed = {
  readonly expectedEpochDay: string;
  readonly maxAgeDays: number;
  readonly checkedAt: string;
  readonly epochDay: string;
  readonly ageDays: number;
  readonly indexScore: number | null;
  readonly confidence: number | null;
  readonly weightScored: number | null;
  readonly signer: string;
  readonly payloadSha256: string;
};

/** "1 day" / "2 days", so a log line reads as written English. */
export function describeDays(count: number): string {
  return `${count} ${count === 1 ? 'day' : 'days'}`;
}

function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / MS_PER_DAY);
}

/**
 * Judges whether the published index is still current.
 *
 * A build publishes the previous UTC day, so `maxAgeDays` counts how many days
 * behind that schedule the latest snapshot is allowed to be. The default of one
 * day tolerates the ordinary case where today's build has not run yet and says
 * nothing about whether yesterday's did.
 *
 * A snapshot that does not verify is never `ok`, however fresh it is: a fresh
 * file that no market can trust is worse than an old one that they can.
 */
export function assessHealth(args: {
  readonly latest: PublishedSnapshotView | null;
  readonly signatureValid: boolean;
  readonly today: string;
  readonly maxAgeDays: number;
  readonly now: Date;
}): HealthReport {
  const { latest, signatureValid, today, maxAgeDays, now } = args;
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 0) {
    throw new Error(`invalid max age: ${maxAgeDays}`);
  }
  const expectedEpochDay = addDays(today, -1);
  const base = { expectedEpochDay, maxAgeDays, checkedAt: now.toISOString() };

  if (latest === null) {
    return missingReport(base);
  }

  const observed: Observed = {
    ...base,
    epochDay: latest.epochDay,
    ageDays: daysBetween(latest.epochDay, expectedEpochDay),
    indexScore: latest.indexScore,
    confidence: latest.confidence,
    weightScored: latest.weightScored,
    signer: latest.signer,
    payloadSha256: latest.payloadSha256,
  };
  if (!signatureValid) {
    return {
      ...observed,
      status: 'unverified',
      detail: `latest snapshot ${latest.epochDay} does not verify against its payload hash and signature`,
    };
  }
  return judgeAge(observed, maxAgeDays);
}

/** There is nothing published, so there is nothing measured to report. */
function missingReport(
  base: Pick<HealthReport, 'expectedEpochDay' | 'maxAgeDays' | 'checkedAt'>,
): HealthReport {
  return {
    ...base,
    status: 'missing',
    epochDay: null,
    ageDays: null,
    indexScore: null,
    confidence: null,
    weightScored: null,
    signer: null,
    payloadSha256: null,
    detail: `no published snapshot, expected ${base.expectedEpochDay}`,
  };
}

/** Turns the measured lag into stale or ok, given the tolerance. */
function judgeAge(observed: Observed, maxAgeDays: number): HealthReport {
  const { ageDays, epochDay, expectedEpochDay } = observed;
  if (ageDays > maxAgeDays) {
    return {
      ...observed,
      status: 'stale',
      detail: `latest snapshot is ${epochDay}, ${describeDays(ageDays)} behind ${expectedEpochDay}`,
    };
  }
  const within =
    ageDays <= 0
      ? `latest snapshot ${epochDay} is current`
      : `latest snapshot ${epochDay} is ${describeDays(ageDays)} behind, within the ` +
        `${describeDays(maxAgeDays)} limit`;
  return { ...observed, status: 'ok', detail: within };
}

/** True only when there is nothing to report. A caller that treats warnings as healthy will miss one. */
export function isHealthy(report: HealthReport): boolean {
  return report.status === 'ok';
}
