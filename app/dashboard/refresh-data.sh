#!/usr/bin/env bash
# Refresh pulse-data.js from the private maxxexee/pulse-markets repo.
# Requires an authenticated gh CLI. Regenerates both data files from signed snapshots.
set -euo pipefail
cd "$(dirname "$0")"
REPO=maxxexee/pulse-markets
# SNAP_DIR points at a local snapshots/ directory (e.g. a clone where `node src/cli.ts
# build` just ran). Without it, the published snapshots are read over gh.
SNAP_DIR=${SNAP_DIR:-}
if [ -z "$SNAP_DIR" ] && [ -d snapshots ]; then SNAP_DIR="$PWD/snapshots"; fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/days" "$TMP/disc" "$TMP/markets"

if [ -n "$SNAP_DIR" ]; then
  if [ -f "$SNAP_DIR/latest.json" ]; then cp "$SNAP_DIR/latest.json" "$TMP/latest.json"
  else cp "$(ls "$SNAP_DIR"/[0-9]*.json | sort | tail -1)" "$TMP/latest.json"; fi
  find "$SNAP_DIR" -maxdepth 1 -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].json' -exec cp {} "$TMP/days/" \;
  cp "$SNAP_DIR"/discovery/*.json "$TMP/disc/"
  cp "$(ls "$SNAP_DIR"/discovery/*.json | sort | tail -1)" "$TMP/disc/latest.json"
  cp markets/*.json "$TMP/markets/" 2>/dev/null || cp "$(dirname "$SNAP_DIR")/../markets"/*.json "$TMP/markets/" 2>/dev/null || true
else
  gh api "repos/$REPO/contents/index-service/snapshots/latest.json" --jq .content | base64 -d > "$TMP/latest.json"
  gh api "repos/$REPO/contents/index-service/snapshots" --jq '.[].name' \
    | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.json$' | sort \
    | while read -r name; do
        gh api "repos/$REPO/contents/index-service/snapshots/$name" --jq .content | base64 -d > "$TMP/days/$name"
      done
  gh api "repos/$REPO/contents/index-service/snapshots/discovery" --jq '.[].name' \
    | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.json$' | sort \
    | while read -r name; do
        gh api "repos/$REPO/contents/index-service/snapshots/discovery/$name" --jq .content | base64 -d > "$TMP/disc/$name"
      done
  cp "$(ls "$TMP"/disc/*.json | sort | tail -1)" "$TMP/disc/latest.json"
  gh api "repos/$REPO/contents/markets" --jq '.[].name' \
    | grep -E '\.json$' | sort \
    | while read -r name; do
        gh api "repos/$REPO/contents/markets/$name" --jq .content | base64 -d > "$TMP/markets/$name"
      done
fi

python3 - "$TMP" <<'PY'
import json, os, re, sys, time, pathlib, urllib.error, urllib.parse, urllib.request
tmp = pathlib.Path(sys.argv[1])

def load(p):
    return json.loads(p.read_text())

def wiki(path):
    # Wikipedia rate-limits parallel hits hard, and a dropped lead summary is a worse page
    # than a slower refresh, so back off and retry instead of skipping the topic.
    for attempt in range(4):
        try:
            req = urllib.request.Request(
                'https://en.wikipedia.org/api/rest_v1/' + path,
                headers={'User-Agent': 'pulse-dashboard/1.0 (local demo)'})
            data = json.load(urllib.request.urlopen(req, timeout=20))
            time.sleep(0.5)
            return data
        except urllib.error.HTTPError as err:
            if err.code != 429 or attempt == 3:
                raise
            time.sleep(3 + attempt * 4)

latest = load(tmp / 'latest.json')
snap = latest['snapshot']
history = []
for f in sorted((tmp / 'days').glob('*.json')):
    s = load(f)['snapshot']
    history.append({'day': s['epochDay'], 'score': s['index']['score'],
                    'definitionId': s['definitionId'],
                    'entities': {e['entityId']: {'value': e['value'], 'baseline': e['baseline'],
                                                 'level': e['level'], 'score': e['score']}
                                 for e in s['series'][0]['entities'] if e.get('status') == 'scored'}})

markets = []
for f in sorted((tmp / 'markets').glob('*.json')):
    spec = load(f)
    same_day = next((h for h in history if h['day'] == spec['epochDay']), None)
    markets.append({
        'spec': spec,
        'epochScore': same_day['score'] if same_day else None,
        'epochDefinition': same_day['definitionId'] if same_day else None,
        'definitionMatches': bool(same_day) and same_day['definitionId'] == spec['definitionId'],
    })

# Every published discovery day, so a topic that drops off the board stays readable.
trend_days = []
for path in sorted((tmp / 'disc').glob('[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].json'), reverse=True):
    day_file = load(path)
    trend_days.append({'day': day_file['day'], 'entries': day_file['entries']})

# A topic whose model summary was dropped still gets its article lead, labelled as such.
disc = load(tmp / 'disc' / 'latest.json')
all_entries = [e for d in trend_days for e in d['entries']]
for entry in all_entries:
    if entry.get('context'):
        continue
    title = entry['link'].rsplit('/', 1)[-1]
    try:
        lead = wiki('page/summary/' + urllib.parse.quote(title))
        if lead.get('extract'):
            entry['leadSummary'] = lead['extract']
            entry['leadSource'] = lead.get('content_urls', {}).get('desktop', {}).get('page', entry['link'])
    except Exception as err:
        print('lead fallback skipped for', entry['topic'], err)

# Pictures come with the snapshot, so a new day's topics arrive with their images.
images = pathlib.Path('images')
images.mkdir(exist_ok=True)
for entry in all_entries:
    slug = ''.join(c if c.isalnum() else '-' for c in entry['topic'].lower()).strip('-')
    while '--' in slug:
        slug = slug.replace('--', '-')
    target = images / f'g-{slug}.jpg'
    url = entry.get('imageUrl')
    if not url or target.exists():
        continue
    try:
        raw = urllib.request.urlopen(
            urllib.request.Request(url, headers={'User-Agent': 'pulse-dashboard/1.0 (local demo)'}),
            timeout=25).read()
        tmpj = images / f'g-{slug}.src'
        tmpj.write_bytes(raw)
        os.system(f'sips -s format jpeg "{tmpj}" --out "{target}" >/dev/null 2>&1')
        tmpj.unlink(missing_ok=True)
        print('image', slug)
    except Exception as err:
        print('image skipped for', entry['topic'], err)

# Snapshot entities carry no picture, and the card logo is not a hero photo. Pull each
# constituent's Wikipedia lead image once, keyed e-<entityId>.jpg, and hand the map to the
# dashboard so a new constituent gets a hero on its first day instead of empty initials.
constituent_images = {}
for entity_id in [c['entityId'] for c in snap['definition']['signals'][0]['constituents']]:
    target = images / f'e-{entity_id}.jpg'
    if target.exists():
        constituent_images[entity_id] = target.name
        continue
    title = entity_id.replace('-', ' ').title().replace(' ', '_')
    try:
        lead = wiki('page/summary/' + urllib.parse.quote(title))
        src = (lead.get('originalimage') or lead.get('thumbnail') or {}).get('source')
        if not src:
            print('no lead image for', entity_id)
            continue
        src = re.sub(r'/\d+px-', '/1280px-', src)
        raw = urllib.request.urlopen(
            urllib.request.Request(src, headers={'User-Agent': 'pulse-dashboard/1.0 (local demo)'}),
            timeout=25).read()
        tmpj = images / f'e-{entity_id}.src'
        tmpj.write_bytes(raw)
        os.system(f'sips -s format jpeg "{tmpj}" --out "{target}" >/dev/null 2>&1')
        tmpj.unlink(missing_ok=True)
        if target.exists():
            constituent_images[entity_id] = target.name
            print('entity image', entity_id)
    except Exception as err:
        print('entity image skipped for', entity_id, err)

header = ('// PULSE data — generated by refresh-data.sh from maxxexee/pulse-markets, do not edit.\n')
body = (
    f'window.PULSE_INDEX = {json.dumps(snap, separators=(",", ":"))};\n'
    f'window.PULSE_INDEX_HISTORY = {json.dumps(history, separators=(",", ":"))};\n'
    f'window.PULSE_MARKETS = {json.dumps(markets, separators=(",", ":"))};\n'
    f'window.PULSE_DISCOVERY = {json.dumps(disc, separators=(",", ":"))};\n'
    f'window.PULSE_TREND_DAYS = {json.dumps(trend_days, separators=(",", ":"))};\n'
    f'window.PULSE_IMGS = {json.dumps(constituent_images, separators=(",", ":"))};\n'
)
pathlib.Path('pulse-data.js').write_text(header + body)

print(f'epoch {snap["epochDay"]} score {snap["index"]["score"]} · '
      f'{len(history)} days · {len(markets)} markets · {len(load(tmp / "disc" / "latest.json")["entries"])} trends · discovery ok')
PY

echo "wrote pulse-data.js"
