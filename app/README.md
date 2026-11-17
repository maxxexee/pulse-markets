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

The page here is the live document verbatim, with the eight JPEGs and
`pulse-live.js` fetched from the live host and committed beside it, so the
relative `url('sample.jpg')` references resolve offline.

## Run it

```
cd app
python3 -m http.server 8090   # then open http://127.0.0.1:8090/
```

## Known state

`pulse-live.js` fetches `{ trends: [...] }` from a Replit deployment URL that
is now gone (`404 This project isn't available right now`). The fetch fails, the
script logs `[Pulse] Could not load live trends` and the page keeps its hardcoded
cards and ticker. That endpoint is the contract the index service will serve
next: see the backend notes in `docs/operations.md` and the market specs in
`markets/`.
