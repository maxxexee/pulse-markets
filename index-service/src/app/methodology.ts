import { readFile } from 'node:fs/promises';
import { sha256Hex } from '@pulse/index-core/snapshot.ts';
import {
  TREND_DEFINITION_ID,
  TREND_EPOCH_SCHEMA,
  trendDefinitionDigest,
} from '@pulse/index-core/trend-epoch.ts';
import type { DiscoverySettings } from '@pulse/index-core/discovery.ts';

/** Published so a reader can hash the rules a day was settled under. */
export interface MethodologyDocument {
  readonly schema: 'pulse-methodology/1';
  readonly definitionId: typeof TREND_DEFINITION_ID;
  readonly epochSchema: typeof TREND_EPOCH_SCHEMA;
  readonly digest: string;
  readonly settings: DiscoverySettings;
  /** The bars a topic has to clear, as sentences, in the order they apply. */
  readonly bars: readonly string[];
  /** Hash of the changelog this document is published with. */
  readonly changelogSha256: string;
  readonly changelogUrl: string;
}

const CHANGELOG_URL = 'api/methodology-changelog';

/**
 * The rule as a document, not a paragraph.
 *
 * A market pins `digest`. The prose is there so a reader can see what the digest
 * means, and the changelog hash so the prose cannot be edited under a digest that
 * stayed the same.
 */
export function methodologyFor(
  settings: DiscoverySettings,
  changelogMarkdown: string,
): MethodologyDocument {
  const n = (value: number): string => value.toLocaleString('en-US');
  return {
    schema: 'pulse-methodology/1',
    definitionId: TREND_DEFINITION_ID,
    epochSchema: TREND_EPOCH_SCHEMA,
    digest: trendDefinitionDigest('wikipedia-top-v1', settings),
    settings,
    bars: [
      `the article is in the day's top ${n(settings.candidateLimit)} by views, outside the signed basket`,
      `page titles matching ${settings.excludedTopicPrefixes.join(', ')} are not topics`,
      `views on the day are at least ${n(settings.minViews)}`,
      `at least ${n(settings.minBaselineDays)} of the preceding ${n(settings.baselineWindowDays)} days have a figure`,
      `the baseline is at least ${n(settings.minBaselineViews)} views a day`,
      `views are at least ${settings.minMomentum}% above the baseline`,
      `pages telling one story collapse to the most read, then the top ${settings.maxResults} by momentum remain`,
    ],
    changelogSha256: sha256Hex(Buffer.from(changelogMarkdown, 'utf8')),
    changelogUrl: CHANGELOG_URL,
  };
}

/** Reads the published changelog from disk and returns both artifacts. */
export async function methodologyPayloads(
  settings: DiscoverySettings,
  changelogPath: string,
): Promise<{ readonly document: MethodologyDocument; readonly changelog: string }> {
  const changelog = await readFile(changelogPath, 'utf8');
  return { document: methodologyFor(settings, changelog), changelog };
}
