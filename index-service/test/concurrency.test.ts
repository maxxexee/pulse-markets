import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapWithConcurrency } from '../src/domain/concurrency.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrency', () => {
  it('keeps results in input order when work finishes out of order', async () => {
    const results = await mapWithConcurrency([30, 10, 20], 3, async (delay) => {
      await sleep(delay);
      return delay;
    });
    assert.deepEqual(results, [30, 10, 20]);
  });

  it('passes the input index to the worker', async () => {
    const seen: number[] = [];
    await mapWithConcurrency(['a', 'b', 'c'], 2, async (_item, index) => {
      seen.push(index);
      return index;
    });
    assert.deepEqual(seen.sort((a, b) => a - b), [0, 1, 2]);
  });

  it('never runs more than the limit at once', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight -= 1;
    });
    assert.equal(peak, 3);
  });

  it('handles an empty list and a limit above the item count', async () => {
    assert.deepEqual(await mapWithConcurrency([], 4, async () => 'x'), []);
    assert.deepEqual(await mapWithConcurrency([1, 2], 8, async (n) => n * 2), [2, 4]);
  });

  it('rejects on the first failure without starting the rest', async () => {
    let started = 0;
    await assert.rejects(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 1, async (n) => {
        started += 1;
        if (n === 2) {
          throw new Error('boom');
        }
        return n;
      }),
      /boom/,
    );
    assert.equal(started, 2);
  });

  it('rejects a limit that is not a positive integer', async () => {
    await assert.rejects(mapWithConcurrency([1], 0, async () => 1), RangeError);
    await assert.rejects(mapWithConcurrency([1], 1.5, async () => 1), RangeError);
  });
});
