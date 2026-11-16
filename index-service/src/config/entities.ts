/**
 * One tradable entity in the index basket.
 *
 * The Wikipedia article title and the Hacker News query are canonical anchors.
 * They are part of the published definition, so renaming or re-pointing an
 * entity is a formula change and needs a new index version.
 */
export interface EntityDefinition {
  /** Stable identifier used in snapshots and market metadata. */
  readonly id: string;
  /** Display name. */
  readonly label: string;
  /** Exact Wikipedia article title, including any disambiguation suffix. */
  readonly wikipediaArticle: string;
  /** Hacker News full-text query for story mentions. */
  readonly hackerNewsQuery: string;
}

/** Index basket version 1. Changing membership changes the index, so it is versioned. */
export const ENTITY_BASKET: readonly EntityDefinition[] = [
  {
    id: 'jensen-huang',
    label: 'Jensen Huang',
    wikipediaArticle: 'Jensen_Huang',
    hackerNewsQuery: 'Jensen Huang',
  },
  {
    id: 'nvidia',
    label: 'Nvidia',
    wikipediaArticle: 'Nvidia',
    hackerNewsQuery: 'Nvidia',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    wikipediaArticle: 'OpenAI',
    hackerNewsQuery: 'OpenAI',
  },
  {
    id: 'sam-altman',
    label: 'Sam Altman',
    wikipediaArticle: 'Sam_Altman',
    hackerNewsQuery: 'Sam Altman',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    wikipediaArticle: 'Anthropic',
    hackerNewsQuery: 'Anthropic',
  },
  {
    id: 'elon-musk',
    label: 'Elon Musk',
    wikipediaArticle: 'Elon_Musk',
    hackerNewsQuery: 'Elon Musk',
  },
  {
    id: 'solana',
    label: 'Solana',
    wikipediaArticle: 'Solana_(blockchain_platform)',
    hackerNewsQuery: 'Solana',
  },
];
