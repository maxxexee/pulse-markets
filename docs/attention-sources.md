# Attention sources

What was tested, what is usable behind a verifiable public endpoint, and why the
index only accepts sources that can be recounted by a stranger.

## The bar

A source is admissible only if all three hold:

1. It returns a number that anyone can re-derive from a recorded URL, without an
   account or API key.
2. It exposes history per UTC day, so a trailing baseline can be computed from
   the same public data.
3. The number is expensive to inflate. Otherwise a market that settles on it is
   a market about who can afford the most bots.

Social mention counts fail the first and third: they are not reproducible by a
third party, and accounts are cheap. They are not used for settlement.

## Probes, November 2026

Tested with a plain `curl` against the documented public endpoints.

| Source | Endpoint | Result | Usable |
| --- | --- | --- | --- |
| Hacker News | `hn.algolia.com/api/v1/search` | 200, `nbHits` per day, full history | yes, adopted |
| Wikipedia pageviews | `wikimedia.org/api/rest_v1/metrics/pageviews` | 200, daily, full history | yes, adopted |
| GDELT | `api.gdeltproject.org/api/v2/doc/doc` | 200, daily article counts, full history, but omits days and throttles per IP | yes, adopted with a coverage rule |
| X / Twitter | public API | 401 without auth | no |
| Reddit | `reddit.com` and `old.reddit.com` JSON | 403 | no |
| Bluesky | `public.api.bsky.app` `searchPosts` | 403 without auth | no |
| Truth Social | public endpoint | 403 | no |
| StockTwits | public endpoint | 403 (Cloudflare) | no |
| xcancel | Nitter front end | 451 | no |
| Google Trends | trends endpoint | 404 | no |
| Mastodon | tag timeline | 200, only the latest 20 statuses | no history |
| Telegram | public channel preview | 200, only the latest 20 posts | no history |
| Lobsters | newest stories | 200, tail only, no range query | no history |
| YouTube | search HTML | 200, no total count, markup fragile | no |

## Why Hacker News is the second signal

It is the only additional source that answered with historical per-day counts.
`hitsPerPage=0` asks Algolia for the match total only, and a `created_at_i`
window restricts it to one UTC day, so each day has its own URL and its own
number. Stories only: comments measure discussion, not attention to the entity.

Mention counts are sparse, and many days are zero. A median baseline collapses
to zero for a quiet entity and makes it unscoreable, so this signal uses a
smoothed mean with a prior of one, and refuses to score a day below three
stories where a one unit change is noise.

## Signals in index version 3

- `wikipedia-pageviews` (`pulse-level-v1`): median baseline, dense data.
- `hacker-news-stories` (`pulse-level-counts-v1`): smoothed mean baseline,
  minimum target volume of three stories.
- `gdelt-articles` (`pulse-level-counts-v1`): same baseline and floor, on the
  number of news articles that mention the entity's fixed phrase.

## Why GDELT is the third signal

The DOC API answers without a key, and `mode=timelinevolraw` returns a raw
article count per day, so one URL covers the whole window and anyone can recount
it. A phrase match on news articles is also harder to inflate than a post: it
requires a publisher, not an account.

The catch is that GDELT does not return a contiguous series. For every query
tried, the same six days (2026-10-28 to 2026-11-02) came back missing, so the
parser cannot demand a full window. It requires the epoch day to be present and
at least 70 percent of the window to have come back, and it drops the omitted
days from the baseline instead of counting them as zero, which would drag the
baseline down and inflate the score.

The endpoint also throttles hard per IP: one request per five seconds is
advertised, and bursts earn a 429 with a plain text body. Entities are fetched
concurrently, so requests from this adapter are serialized process wide with six
seconds between them, and 429 responses are retried with backoff.

Both use `clamp(50 + 12.5 * log2(value / baseline), 0, 100)` per entity. Each
signal publishes its own index as the mean of its scored entities. The headline
index is the mean of the signal indices that scored, which weights signals
equally rather than weighting by entity coverage.
