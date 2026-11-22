/**
 * Social posts are shown, never scored.
 *
 * The index feeds settlement, so every input to it has to be keyless,
 * reproducible and expensive to inflate. Social counts are none of those: they
 * come from an authenticated third-party API, they change after publication,
 * and they can be bought. This panel exists so a reader can see what people are
 * saying beside the number, and it is marked display only everywhere it appears.
 */
export const SOCIAL_PANEL_SCHEMA = 'pulse.social.panel/2';

export interface SocialPost {
  readonly id: string;
  readonly author: string;
  /** Whitespace-collapsed post text, so the panel shows what was said. */
  readonly text: string;
  readonly createdAt: string;
  readonly likes: number;
  /** Null when the API omits the count; unknown is not zero. */
  readonly views: number | null;
  readonly url: string;
}

/**
 * The panel for one page: what people are posting about that topic, not about
 * the basket at large.
 *
 * A page shows the posts its own query returned, so an entity's strip cannot be
 * filled by a word that happens to appear in a post about something else.
 */
export interface SocialTopicPanel {
  /** Label the query was built from, kept so a reader can see what was searched. */
  readonly label: string;
  readonly query: string;
  readonly posts: readonly SocialPost[];
  readonly totals: {
    readonly posts: number;
    readonly likes: number;
    readonly views: number;
  };
}

export interface SocialPanel {
  readonly schema: typeof SOCIAL_PANEL_SCHEMA;
  readonly fetchedAt: string;
  readonly query: string;
  /** Always zero. Present so a consumer cannot mistake the panel for an input. */
  readonly settlementWeight: 0;
  readonly posts: readonly SocialPost[];
  /**
   * Per-page panels keyed by entity id or `g:<topic-slug>`.
   *
   * Absent on a panel fetched before topics existed, which is why every reader
   * treats a missing key as "nothing to show" rather than an error.
   */
  readonly topics?: Readonly<Record<string, SocialTopicPanel>>;
  readonly totals: {
    readonly posts: number;
    readonly likes: number;
    readonly views: number;
  };
  /** True when the page budget ran out before the source did. */
  readonly truncated: boolean;
}

/**
 * Key a topic is filed under: lowercase, everything that is not a letter or a
 * digit becomes one dash.
 *
 * The dashboard slugs a topic the same way to build its route, so the two have
 * to agree. `"Fiona (hippopotamus)"` and `fiona-hippopotamus` both file under
 * `fiona-hippopotamus`.
 */
export function topicSlug(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The text a post has to mention to belong on a topic's page.
 *
 * Article titles carry a disambiguation suffix the posts will not contain, so
 * the parenthetical is dropped before matching.
 */
export function mentionKey(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*/g, ' ').trim().toLowerCase();
}

export interface SocialSummaryInput {
  readonly query: string;
  readonly fetchedAt: string;
  readonly posts: readonly SocialPost[];
  readonly truncated: boolean;
}

/** One page's panel, totalled the same way the whole panel is. */
export function summarizeTopic(input: {
  readonly label: string;
  readonly query: string;
  readonly posts: readonly SocialPost[];
}): SocialTopicPanel {
  return {
    label: input.label,
    query: input.query,
    posts: [...input.posts],
    totals: {
      posts: input.posts.length,
      likes: input.posts.reduce((total, post) => total + post.likes, 0),
      views: input.posts.reduce((total, post) => total + (post.views ?? 0), 0),
    },
  };
}

/**
 * Keeps the source's order and totals the counts that are known.
 *
 * The adapter asks the vendor for its ranked list (queryType=Top), so the order
 * arriving here is the engagement rank; re-sorting by date would discard it and
 * put the newest unread post on top.
 */
export function summarizeSocial(input: SocialSummaryInput): SocialPanel {
  const posts = [...input.posts];
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
