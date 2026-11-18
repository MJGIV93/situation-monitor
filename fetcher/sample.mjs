// Development aid: saves raw responses from each source so adapters can be
// written and tested against real data. Runs only when this file changes.

import { mkdir, writeFile } from "node:fs/promises";
import { get } from "./lib/http.mjs";

const now = Math.floor(Date.now() / 1000);
const daysAgo = (n) => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
const kubra = (sc, view) => `https://kubra.io/stormcenter/api/v1/stormcenters/${sc}/views/${view}/currentState?preview=false`;
const JCPL = ["6c715f0e-bbec-465f-98cc-0b81623744be", "fcd7c23d-de37-4471-8ca3-37c3260f94fa"];
const PSEG = ["79d82478-c10a-4956-a045-89de3cda618c", "bdb7f5be-1c1a-46fa-862e-ebdf21851d2e"];
const fred = (id) => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${daysAgo(400)}`;
const yahoo = (s, range = "1y") => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=${range}`;
const cboe = (s) => `https://cdn.cboe.com/api/global/delayed_quotes/quotes/${s}.json`;
const cboeHist = (s) => `https://cdn.cboe.com/api/global/delayed_quotes/charts/historical/${s}.json`;
const geo = { accept: "application/geo+json" };
const gql = (query) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });

const day = (n) => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
const LIST = [
  ["tfr-list", "https://tfr.faa.gov/tfrapi/exportTfrList"],
  ["gpsjam-manifest", "https://gpsjam.org/data/manifest.csv"],
  ["gpsjam-day", `https://gpsjam.org/data/${day(2)}-h3_4.csv`],
  ["eam-home", "https://eam.watch/"],
  ["state-advisories", "https://travel.state.gov/_res/rss/TAsTWs.xml"],
  ["gdelt-strikes", "https://api.gdeltproject.org/api/v2/doc/doc?query=(airstrike%20OR%20%22missile%20strike%22%20OR%20%22military%20strike%22)&mode=timelinevol&timespan=14d&format=json"],
  ["cboe-ita", "https://cdn.cboe.com/api/global/delayed_quotes/quotes/ITA.json"],
  ["usni-fleet", "https://news.usni.org/category/fleet-tracker/feed"],
  ["squawk-7700", "https://opendata.adsb.fi/api/v2/sqk/7700"],
  ["polymarket-geo", "https://gamma-api.polymarket.com/events?closed=false&tag_slug=geopolitics&limit=30&order=volume24hr&ascending=false"],
];

const OUT = "samples";
await mkdir(OUT, { recursive: true });
const index = [];

async function save(name, url, opts) {
  const res = await get(url, { timeout: 30000, ...(opts ?? {}) });
  const file = `${name}.txt`;
  await writeFile(`${OUT}/${file}`, res.text.slice(0, 3_000_000));
  index.push({ name, url, method: opts?.method ?? "GET", status: res.status, type: res.type, bytes: res.text.length, error: res.error });
  console.log(String(res.status).padStart(4), String(res.text.length).padStart(9), name);
  return res;
}

for (const [name, url, opts] of LIST) await save(name, url, opts);

await writeFile(`${OUT}/index.json`, JSON.stringify(index, null, 1));
