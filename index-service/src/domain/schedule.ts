import { addDays, isValidDay } from './dates.ts';

/**
 * Chooses which epochs an unattended run should publish.
 *
 * A scheduled build can be skipped (machine asleep, network down) or can arrive
 * after a longer outage, so it fills every day in a trailing window that has no
 * snapshot yet: interior holes matter as much as a missing tail, because
 * momentum is read from the snapshot exactly 7 days earlier. The window caps one
 * recovery run at `limit` days so it cannot turn into hundreds of upstream
 * calls, and it starts at limit - 1, so limit 1 means "the target day only".
 */
export function missingEpochDays(args: {
  readonly publishedDays: readonly string[];
  readonly targetDay: string;
  readonly limit: number;
}): readonly string[] {
  const { publishedDays, targetDay, limit } = args;
  if (!isValidDay(targetDay)) {
    throw new Error(`invalid target day: ${targetDay}`);
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`invalid catch-up window: ${limit}`);
  }
  const published = new Set(publishedDays.filter(isValidDay));
  const days: string[] = [];
  for (let offset = limit - 1; offset >= 0; offset -= 1) {
    const day = addDays(targetDay, -offset);
    if (!published.has(day)) {
      days.push(day);
    }
  }
  return days;
}
