/**
 * Social posts are shown, never scored.
 *
 * The index feeds settlement, so every input to it has to be keyless,
 * reproducible and expensive to inflate. Social counts are none of those: they
 * come from an authenticated third-party API, they change after publication,
 * and they can be bought. This panel exists so a reader can see what people are
 * saying beside the number, and it is marked display only everywhere it appears.
 */
export const SOCIAL_PANEL_SCHEMA = 'pulse.social.panel/1';

export interface SocialPost {
  readonly id: string;
  readonly author: string;
  readonly createdAt: string;
  readonly likes: number;
  /** Null when the API omits the count; unknown is not zero. */
  readonly views: number | null;
  readonly url: string;
}

export interface SocialPanel {
  readonly schema: typeof SOCIAL_PANEL_SCHEMA;
  readonly fetchedAt: string;
  readonly query: string;
  /** Always zero. Present so a consumer cannot mistake the panel for an input. */
  readonly settlementWeight: 0;
  readonly posts: readonly SocialPost[];
  readonly totals: {
    readonly posts: number;
    readonly likes: number;
    readonly views: number;
  };
  /** True when the page budget ran out before the source did. */
  readonly truncated: boolean;
}

export interface SocialSummaryInput {
  readonly query: string;
  readonly fetchedAt: string;
  readonly posts: readonly SocialPost[];
  readonly truncated: boolean;
}

/** Sorts newest first and totals the counts that are known. */
export function summarizeSocial(input: SocialSummaryInput): SocialPanel {
  const posts = [...input.posts].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return {
    schema: SOCIAL_PANEL_SCHEMA,
    fetchedAt: input.fetchedAt,
    query: input.query,
    settlementWeight: 0,
    posts,
    totals: {
      posts: posts.length,
      likes: posts.reduce((total, post) => total + post.likes, 0),
      views: posts.reduce((total, post) => total + (post.views ?? 0), 0),
    },
    truncated: input.truncated,
  };
}
