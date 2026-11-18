import {
  DEFINITION_SCHEMA,
  definitionDigest,
  type IndexDefinition,
} from '../src/index-definition.ts';
import { PULSE_SCORING_V1 } from '../src/scoring.ts';

/**
 * Definition used by snapshot fixtures.
 *
 * Fixtures are about the snapshot envelope, not about scoring, so this one
 * carries a single signal with two constituents and fixed anchors.
 */
export const TEST_DEFINITION: IndexDefinition = {
  schema: DEFINITION_SCHEMA,
  id: 'pulse-attention-v5',
  baseDay: '2026-10-31',
  calibrationDays: 180,
  constituentWeightCap: 0.25,
  signals: [
    {
      id: 'wikipedia-pageviews',
      label: 'Wikipedia pageviews',
      unit: 'views',
      weight: 1,
      scoring: PULSE_SCORING_V1,
      constituents: [
        { entityId: 'nvidia', anchor: 5000, weight: 0.5 },
        { entityId: 'openai', anchor: 8000, weight: 0.5 },
      ],
    },
  ],
};

export const TEST_DEFINITION_SHA256 = definitionDigest(TEST_DEFINITION);
