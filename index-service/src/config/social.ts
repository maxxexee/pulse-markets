import { topicSlug } from '@pulse/index-core/social.ts';
import type { EntityDefinition } from './entities.ts';

/**
 * The combined query, kept for the site-wide panel.
 *
 * One query for the whole basket costs a fixed number of requests rather than
 * one per entity. It is no longer what a market page reads: a post that matches
 * any label in this OR would land on every page whose word it contained.
 *
 * Retweets are dropped from the results rather than excluded in the query, so the
 * panel does not depend on the vendor supporting that operator. The language
 * filter keeps the panel readable. This query never reaches scoring.
 */
export function socialQuery(basket: readonly EntityDefinition[]): string {
  const terms = basket.map((entity) =>
    entity.label.includes(' ') ? `"${entity.label}"` : entity.label,
  );
  return `(${terms.join(' OR ')}) lang:en`;
}

/** One page's panel query, keyed the way the dashboard routes that page. */
export interface SocialTopicSpec {
  readonly key: string;
  readonly label: string;
  readonly query: string;
  /** Words a post must also carry, where the label alone is too generic. */
  readonly requires?: readonly string[];
}

/**
 * Queries for every page that shows a strip: each constituent, and each topic on
 * the newest published board.
 *
 * Topic titles carry a disambiguation suffix the posts will not use, so the
 * parenthetical is searched without even though the key keeps it. The key has to
 * keep it to match the dashboard's own topic route.
 */
export function socialTopicQueries(
  basket: readonly EntityDefinition[],
  topics: readonly string[],
): readonly SocialTopicSpec[] {
  const seen = new Set<string>();
  const specs: SocialTopicSpec[] = [];
  const add = (key: string, label: string, requires?: readonly string[]): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const search = label.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    specs.push({
      key,
      label,
      query: `"${search}" lang:en`,
      ...(requires === undefined ? {} : { requires }),
    });
  };
  for (const entity of basket) {
    add(entity.id, entity.label, entity.socialTerms);
  }
  for (const topic of topics) {
    add(`g:${topicSlug(topic)}`, topic);
  }
  return specs;
}
