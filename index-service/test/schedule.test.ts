import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missingEpochDays } from '../src/domain/schedule.ts';

const plan = (publishedDays: string[], targetDay: string, limit = 7): readonly string[] =>
  missingEpochDays({ publishedDays, targetDay, limit });

test('a window of one builds only the target day', () => {
  assert.deepEqual(plan([], '2026-11-16', 1), ['2026-11-16']);
});

test('an up-to-date index has nothing to build', () => {
  assert.deepEqual(plan(['2026-11-14', '2026-11-15'], '2026-11-15', 2), []);
});

test('unrelated files in the snapshots directory are ignored as days', () => {
  assert.deepEqual(plan(['latest', 'social.json'], '2026-11-16', 1), ['2026-11-16']);
});

test('a missing tail is filled oldest first', () => {
  assert.deepEqual(plan(['2026-11-09', '2026-11-10'], '2026-11-12', 3), [
    '2026-11-11',
    '2026-11-12',
  ]);
});

test('an interior hole is filled even when the target is published', () => {
  assert.deepEqual(plan(['2026-11-12', '2026-11-14'], '2026-11-14', 3), ['2026-11-13']);
});

test('published days are read as dates, not as directory order', () => {
  assert.deepEqual(plan(['2026-11-15', '2026-11-03'], '2026-11-16', 2), ['2026-11-16']);
});

test('a long outage is capped at the window and keeps the newest days', () => {
  assert.deepEqual(plan(['2026-11-01'], '2026-11-10', 3), [
    '2026-11-08',
    '2026-11-09',
    '2026-11-10',
  ]);
});

test('an invalid target day is refused', () => {
  assert.throws(() => plan([], '2026-13-01'), /invalid target day/);
});

test('a window shorter than a day is refused', () => {
  assert.throws(() => plan([], '2026-11-10', 0), /invalid catch-up window/);
});

test('a fractional window is refused', () => {
  assert.throws(() => plan([], '2026-11-10', 2.5), /invalid catch-up window/);
});
