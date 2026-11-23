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
  /**
   * Words a social post must also carry to be shown on this entity's page.
   *
   * Only needed where the label is an ordinary word too: "Solana" is a person's
   * name, and without this the page shows posts about a dog.
   */
  readonly socialTerms?: readonly string[];
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
    // Not the ticker: "sol" is also the Croatian and Spanish word for sun and
    // salt, which put a salt-field post on the page.
    socialTerms: ['blockchain', 'crypto', 'defi', 'wallet', 'token', 'chain', 'web3'],
  },
];
