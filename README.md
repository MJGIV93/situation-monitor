# Situation Monitor

A live board of outages and disruptions, scored for the USA and for Morristown, NJ and the commute into Manhattan.

Site: https://mjgiv93.github.io/situation-monitor/

## How it works

- `fetcher/` runs on a schedule in GitHub Actions. It requests each source, and saves the results to the `data` branch.
- `site/` is the page. It is published with the latest data on every run.
- `.github/workflows/monitor.yml` is the schedule: every 10 minutes.

## Layout

| Path | Purpose |
|---|---|
| `fetcher/sources.mjs` | Every upstream source and the check that proves it returned real data |
| `fetcher/probe.mjs` | Requests every source once and records which ones answer |
| `fetcher/lib/http.mjs` | Shared request helper |
| `site/index.html` | The page |

## Run locally

```
npm run probe
```

Needs Node 20 or newer. Results land in `out/`.

## Status

Step 1 of the build: confirming which sources answer requests from GitHub's servers. The dashboard page replaces the source check page next.
