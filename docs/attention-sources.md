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

Two further properties are required in practice, and they eliminated most of the
candidates below:

4. It is final. A count that grows after the epoch closes cannot settle a market,
   because the same URL returns a different number a week later.
5. It is dense across the basket. The basket mixes two people, three companies
   and a blockchain, so a source that answers zero for people leaves those
   entities permanently unscored.

Social mention counts fail the first and third: they are not reproducible by a
third party, and accounts are cheap. They are not used for settlement.

## Probes, November 2026

Tested with a plain `curl` against the documented public endpoints, no account
and no key.

| Source | Endpoint | Result | Usable |
| --- | --- | --- | --- |
| Hacker News | `hn.algolia.com/api/v1/search` | 200, `nbHits` per day, full history | yes, adopted |
| Wikipedia pageviews | `wikimedia.org/api/rest_v1/metrics/pageviews` | 200, daily, full history | yes, adopted |
| GDELT DOC API | `api.gdeltproject.org/api/v2/doc/doc` | 200 once, then 429 for 20+ minutes | no, throttled |
| GDELT bulk events | `data.gdeltproject.org/gdeltv2/*.export.CSV.zip` | 200, 96 files and 9 MB a day, but no entity actors | no, see below |
| GDELT bulk GKG | `data.gdeltproject.org/gdeltv2/*.gkg.csv.zip` | 200, 6.6 MB per 15 minutes | works, 634 MB a day |
| OpenAlex | `api.openalex.org/works` | 200, per-day counts, but recent days keep growing | no, not final |
| SEC EDGAR full text | `efts.sec.gov/LATEST/search-index` | 200, per-day, but 0 for people and 673 on a filing deadline | no, not dense |
| Wikipedia edits | `wikimedia.org/api/rest_v1/metrics/edits/per-page` | 200, but 7 to 13 of 31 days have any edit | no, not dense |
| Crossref | `api.crossref.org/works` | 200, but totals have no mention semantics | no |
| Stack Exchange | `api.stackexchange.com/2.3/questions` | 200, but 0 questions for any entity on a tested weekday (newest Nvidia question was six weeks old) | no, not dense |
| Guardian | `content.guardianapis.com/search` | 401, the public `test` key is dead | no, needs a key |
| X / Twitter | public API | 401 without auth | no |
| Reddit | `reddit.com` JSON | 403 | no |
| Bluesky | `public.api.bsky.app` `searchPosts` | 403, with and without a descriptive user agent | no |
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

## Why the news signal was removed in v4

Version 3 carried a third signal, `gdelt-articles`, read from the GDELT DOC API.
It is gone, and the measurements are the reason.

**The DOC API cannot support a daily build.** The published limit is one request
every five seconds, and the build needs seven, but the penalty is not an interval
limit. Once an IP is throttled, waiting does not help. Independent measurements
in July and November 2026 agree with this service's own logs: six second spacing
got one request of seven through, 150 second spacing got none of three, seven
requests spread over 35 minutes got none, and a single request after 25 minutes
of silence sometimes succeeded and sometimes did not. Our own run took one 200
for Nvidia and then 429 for every request for the following 20 minutes. More
requests make it worse, and no interval short enough to finish a build makes it
better. Retry and backoff code cannot fix a penalty that outlasts the retry
window.

**The bulk replacements are either unusable or expensive.** GDELT publishes three
static files per 15 minute interval, which have no rate limit at all:

- `export.CSV.zip`, 90 KB, about 9 MB a day. It holds one row per event with the
  two primary actors as CAMEO-coded names. Sampled across all 96 files of one
  day, it returned 61,540 events and 1,464 distinct actor names, and none of the
  seven basket entities appeared as an actor: GDELT codes actors to states,
  groups and a handful of prominent organisations. Recall for people and
  companies is effectively zero.
- `gkg.csv.zip`, 6.6 MB per interval, about 634 MB a day and about 19 GB for one
  30 day baseline. This one does carry extracted persons and organisations, so it
  would work, but the cost contradicts the requirement that the index be cheap
  and low traffic to operate.
- `mentions.CSV.zip`, 138 KB, carries article mentions of events but no entity
  text, so it cannot be counted per entity.

Neither bulk route was adopted. The GKG route stays on the table as an upgrade if
a news signal becomes a requirement.

**Every other news-shaped candidate failed a different bar.** The Guardian's open
platform answers 401 to its documented public `test` key, so it needs a real
key. SEC EDGAR full text is keyless and per-day but returns 673 filings
mentioning Nvidia on a 13F deadline and zero for Jensen Huang and Sam Altman on
the same day, so quarterly seasonality would swamp a 30 day baseline. OpenAlex
counts recent days upward as indexing catches up: Nvidia read 12 for 2026-11-15
and 108 for 2026-11-05 when both were queried on 2026-11-16, which fails the
finality requirement that settlement depends on.

The honest conclusion is that a settlement-grade news count is not available for
free. Two dense, final, keyless signals are worth more than three with one that
cannot run.

## Signals in index version 4

- `wikipedia-pageviews` (`pulse-level-v1`): median baseline, dense data.
- `hacker-news-stories` (`pulse-level-counts-v1`): smoothed mean baseline,
  minimum target volume of three stories.

Both use `clamp(50 + 12.5 * log2(value / baseline), 0, 100)` per entity. Each
signal publishes its own index as the mean of its scored entities. The headline
index is the mean of the signal indices that scored, which weights signals
equally rather than weighting by entity coverage.
