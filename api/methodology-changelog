# Methodology changelog

Every change to the rules trend markets settle under, dated. A market pins the
`definitionSha256` of the day it was created, so a reader can hash this file
(published at `api/methodology-changelog`) and see what that digest meant.

Rule changes take effect on the next epoch and never edit a published one. Format
changes that leave every published number untouched are labelled so a reader can
tell the two apart at a glance.

## 2026-11-19

### Epochs commit to their predecessor

`pulse-trends/1` documents now carry `prevDigest`, the payload hash of the most
recent earlier epoch, or `genesis` for the first chained day. This is additive:
epochs signed before today carry no field and still verify on their own. It
changes no published number and no threshold. What it does change is what can be
hidden: an epoch can no longer be inserted, reordered or backfilled without
breaking a link that any reader can check with `node src/cli.ts verify-chain`.

The chain begins at the first epoch published after this entry, which points back
at the last legacy epoch so the record is continuous from genesis instead of
restarting.

### The negative record is published

Discovery now writes `api/trend-rejections/<day>`, listing every topic that was
measured and dropped by a threshold, with its views, baseline and momentum. A NO
resolution on a topic becomes checkable: the file says what the topic was holding
when it failed. Topics dropped by the result cap are not listed, because they
qualified and did not make the page; that is not a rule failure and must not be
settled as one.

### The rule is published as a document

`api/methodology` states the thresholds, the order they apply in, the definition
digest, and the hash of this file. `api/trend-coverage` lists the topics that
already have an attested day.

## 2026-11-11

### Momentum is measured, never asserted

The X trend list is a discovery source only. Its rank is never published as a
number and never settles anything. Every resolved topic is measured on Wikipedia
pageviews like the rest of discovery.

## 2026-11-09

### Thresholds and baseline

A topic enters the day's list only if it was in the top 24 articles by views,
outside the signed basket, with at least 20,000 views on the day, at least 3 of
the preceding 7 days on record, a baseline of at least 1,000 views a day, and at
least 100% above that baseline. Pages telling one story collapse to the most read,
and the top 6 by momentum remain.

Reason: the ranking alone says what was read, not what changed. Without the
baseline bar an evergreen page is on the list every day; without the view floor a
one-day blip with no reach is.
