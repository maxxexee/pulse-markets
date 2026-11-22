# app

The PULSE landing page and markets front end, served at `/app/` on the deployed
site. Plain HTML, CSS and two small scripts (`pulse-live.js` for the feed,
`footer-field.js` for the canvas strip above the footer): no build step, no
dependencies.

## Where it came from

Recovered from the live site at <https://pulse-markets.netlify.app/>, because the
saved copy on the desktop was incomplete:

- Its CSS and inline styles had been rewritten to `./images/*.jpg`, but the save
  never downloaded CSS background images, so every card and the hero rendered
  black.
- It carried a `<script src="./scripts/injected.js">` that is not part of the
  site; that file comes from a browser extension and returns 404 on the live
  host.
- It pointed at `./scripts/pulse-live.js`, which is not where the live site keeps
  the file.

The page here started as the live document, with the images and `pulse-live.js`
fetched from the live host and committed beside it. Those images are WebP now,
and the hardcoded cards and ticker values are gone.

## The dashboard

`dashboard/` is the signed-in product surface: portfolio, the index constituents, the
threshold markets and the trending board, every page tradeable with RIDE/FADE. It is
static too — `pulse-data.js` is generated, and `refresh-data.sh` rebuilds it from the
signed snapshots (`gh api`, or a local `SNAP_DIR` when you have one). Sign-up and sign-in
land here (`signup-form.js`), including the Google round trip.

## Run it

```
cd app
python3 -m http.server 8090   # then open http://127.0.0.1:8090/
```

## Known state

`pulse-live.js` fetches `../api/trends` and fills both the ticker and the card
row from it. When the fetch fails the row stays empty and one line says so; there
are no fallback cards with invented numbers. The payload contract is documented
in `docs/operations.md`.
