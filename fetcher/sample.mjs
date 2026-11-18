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

const LIST = [
  ["news2-bbc-1", "https://feeds.bbci.co.uk/news/rss.xml"],
  ["news2-bbc-2", "https://feeds.bbci.co.uk/news/world/rss.xml"],
  ["news2-npr-1", "https://feeds.npr.org/1001/rss.xml"],
  ["news2-pbs-1", "https://www.pbs.org/newshour/feeds/rss/headlines"],
  ["news2-cbs-1", "https://www.cbsnews.com/latest/rss/main"],
  ["news2-nbc-1", "https://feeds.nbcnews.com/nbcnews/public/news"],
  ["news2-abc-1", "https://abcnews.go.com/abcnews/topstories"],
  ["news2-ny-times-1", "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml"],
  ["news2-ny-times-2", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"],
  ["news2-washington-post-1", "https://feeds.washingtonpost.com/rss/world"],
  ["news2-fox-news-1", "https://moxie.foxnews.com/google-publisher/latest.xml"],
  ["news2-guardian-1", "https://www.theguardian.com/world/rss"],
  ["news2-guardian-2", "https://www.theguardian.com/us-news/rss"],
  ["news2-al-jazeera-1", "https://www.aljazeera.com/xml/rss/all.xml"],
  ["news2-france-24-1", "https://www.france24.com/en/rss"],
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
