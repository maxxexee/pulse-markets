# app

The PULSE landing page and markets front end, served at `/app/` on the deployed
site. Plain HTML, CSS and one script: no build step, no dependencies.

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
