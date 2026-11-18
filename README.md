# Situation Monitor

A live board of outages and disruptions, scored 0 to 100 for the USA and for Morristown, NJ and the commute into Manhattan.

Site: https://mjgiv93.github.io/situation-monitor/

## How it works

- `fetcher/` runs every 10 minutes in GitHub Actions. Each adapter reads one source and returns a reading. Slower sources refresh hourly.
- `site/score.js` holds the scoring rules. The fetcher and the page both import it, so the score recorded in history is the score shown on screen.
- `site/index.html` is the page. Each run publishes it together with the latest readings.
- The `data` branch holds the fetcher's working state: last good readings, caches, score history and the log.

If a source stops answering, its last reading stays up. The page dims it after 3 hours and stops counting it after 24.

## Layout

| Path | Purpose |
|---|---|
| `fetcher/run.mjs` | One pass: run the adapters that are due, score, record history and the log |
| `fetcher/adapters/` | One file per domain: utilities, travel, internet, money, fuel, hazards, advisories, cyber |
| `fetcher/lib/` | Request helper and shared utilities |
| `fetcher/test/replay.mjs` | Runs every adapter against saved responses instead of the network |
| `fetcher/sample.mjs` | Saves raw responses from each source for adapter development |
| `site/score.js` | Scoring rules and the roll-up into the two dials |
| `site/index.html` | The page |

## Scoring in brief

Every reading is scored 0 to 100 by a fixed rule for its type. A domain takes its worst reading plus a fifth of the next two. Domains stack by weight, so several unrelated problems at once raise a dial far more than one alone. Bands: 0 to 9 quiet, 10 to 24 watch, 25 to 49 elevated, 50 to 74 disrupted, 75 and up severe.

## Run locally

```
npm start
```

Needs Node 20 or newer. Results land in `out/`.
