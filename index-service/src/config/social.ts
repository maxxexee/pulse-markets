import type { EntityDefinition } from './entities.ts';

/**
 * One query for the whole basket, so the panel costs a fixed number of requests
 * rather than one per entity.
 *
 * Retweets are excluded because they are the cheapest thing to inflate, and the
 * language filter keeps the panel readable. This query never reaches scoring.
 */
export function socialQuery(basket: readonly EntityDefinition[]): string {
  const terms = basket.map((entity) =>
    entity.label.includes(' ') ? `"${entity.label}"` : entity.label,
  );
  return `(${terms.join(' OR ')}) -filter:retweets lang:en`;
}
