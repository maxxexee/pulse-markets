/**
 * Runs `worker` over `items` with at most `limit` calls in flight.
 *
 * Results come back in input order whatever order they finish in, so a caller
 * can run independent I/O concurrently and still build a deterministic
 * snapshot. The first failure stops new work from starting and rejects, so a
 * broken source does not keep hammering an API that is already unhappy.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`concurrency limit must be a positive integer, got ${limit}`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;

  const runLane = async (): Promise<void> => {
    while (!failed) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) {
        return;
      }
      try {
        results[index] = await worker(item, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };

  const lanes = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: lanes }, runLane));
  return results;
}
