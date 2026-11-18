const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** Formats a Date as a UTC day, YYYY-MM-DD. */
export function toDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Returns true for a syntactically valid YYYY-MM-DD string. */
export function isValidDay(day: string): boolean {
  return DAY_PATTERN.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`));
}

/** Shifts a YYYY-MM-DD day by a whole number of days. */
export function addDays(day: string, delta: number): string {
  if (!isValidDay(day)) {
    throw new Error(`invalid day: ${day}`);
  }
  const base = Date.parse(`${day}T00:00:00Z`);
  return toDay(new Date(base + delta * MS_PER_DAY));
}

/** Converts YYYY-MM-DD to the YYYYMMDD form the Wikimedia API expects. */
export function toCompact(day: string): string {
  if (!isValidDay(day)) {
    throw new Error(`invalid day: ${day}`);
  }
  return day.replaceAll('-', '');
}
