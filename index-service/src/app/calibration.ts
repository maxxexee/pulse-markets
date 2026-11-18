import type { EntityDefinition } from '../config/entities.ts';
import { CALIBRATION_DAYS, CONSTITUENT_WEIGHT_CAP } from '../config/index-definition.ts';
import type { SignalDefinition } from '../config/signals.ts';
import {
  DEFINITION_SCHEMA,
  type ConstituentAnchor,
  type IndexDefinition,
  type PublishedSignal,
} from '../domain/index-definition.ts';
import type { DailyObservation } from '../domain/observation.ts';
import { baselineOf } from '../domain/scoring.ts';
import { capShares, roundWeights, sharesOf } from '../domain/weights.ts';

/** Anchors are published to four decimals so sparse counts are not flattened. */
const ANCHOR_DECIMALS = 4;

export interface CalibrationInput {
  readonly id: string;
  /** Last UTC day of the base period. */
  readonly baseDay: string;
  readonly entities: readonly EntityDefinition[];
  readonly signals: readonly SignalDefinition[];
  /** Observations keyed by `${signalId}/${entityId}`, any date range. */
  readonly observations: ReadonlyMap<string, readonly DailyObservation[]>;
  /** Per-edition article titles keyed by `${signalId}/${entityId}`, when resolved. */
  readonly titles?: ReadonlyMap<string, Readonly<Record<string, string>>>;
  readonly calibrationDays?: number;
  readonly weightCap?: number;
}

function roundAnchor(value: number): number {
  const scale = 10 ** ANCHOR_DECIMALS;
  return Math.round(value * scale) / scale;
}

/** Values inside the base period, oldest first. */
function basePeriodValues(
  observations: readonly DailyObservation[],
  baseDay: string,
  days: number,
): number[] {
  const start = Date.parse(`${baseDay}T00:00:00Z`) - (days - 1) * 86_400_000;
  return observations
    .filter((entry) => entry.day <= baseDay && Date.parse(`${entry.day}T00:00:00Z`) >= start)
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((entry) => entry.value);
}

function anchorsFor(
  input: CalibrationInput,
  signal: SignalDefinition,
  days: number,
): readonly ConstituentAnchor[] {
  const anchors = input.entities.map((entity) => {
    const observations = input.observations.get(`${signal.id}/${entity.id}`);
    if (observations === undefined) {
      throw new Error(`calibration is missing observations for ${signal.id}/${entity.id}`);
    }
    const values = basePeriodValues(observations, input.baseDay, days);
    if (values.length < signal.scoring.minBaselineDays) {
      throw new Error(
        `${signal.id}/${entity.id}: ${values.length} base-period days, ` +
          `need ${signal.scoring.minBaselineDays}`,
      );
    }
    const anchor = baselineOf(values, signal.scoring);
    if (!Number.isFinite(anchor) || anchor <= 0) {
      throw new Error(`${signal.id}/${entity.id}: base-period volume is ${anchor}`);
    }
    return { entityId: entity.id, anchor: roundAnchor(anchor) };
  });
  const weights = roundWeights(
    capShares(
      sharesOf(anchors.map((entry) => entry.anchor)),
      input.weightCap ?? CONSTITUENT_WEIGHT_CAP,
    ),
  );
  return anchors.map((entry, position) => {
    const titles = input.titles?.get(`${signal.id}/${entry.entityId}`);
    return {
      ...entry,
      weight: weights[position] ?? 0,
      ...(titles === undefined ? {} : { titles }),
    };
  });
}

/**
 * Derives a complete index definition from base-period observations.
 *
 * Every anchor is the base-period level for that constituent under its own
 * signal, and every weight is that constituent's share of the signal's volume,
 * capped. Both are frozen into the definition, so publishing a level is a pure
 * function of the day's volumes and the terms a market pinned.
 */
export function buildDefinition(input: CalibrationInput): IndexDefinition {
  const days = input.calibrationDays ?? CALIBRATION_DAYS;
  const signals: PublishedSignal[] = input.signals.map((signal) => ({
    id: signal.id,
    label: signal.label,
    unit: signal.unit,
    weight: signal.weight,
    scoring: { ...signal.scoring, baselineWindowDays: days },
    constituents: anchorsFor(input, signal, days),
  }));

  const totalWeight = signals.reduce((sum, signal) => sum + signal.weight, 0);
  if (Math.abs(totalWeight - 1) > 1e-9) {
    throw new Error(`signal weights must sum to 1, got ${totalWeight}`);
  }

  return {
    schema: DEFINITION_SCHEMA,
    id: input.id,
    baseDay: input.baseDay,
    calibrationDays: days,
    constituentWeightCap: input.weightCap ?? CONSTITUENT_WEIGHT_CAP,
    signals,
  };
}
