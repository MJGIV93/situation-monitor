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
  ["news-bbc-world", "https://feeds.bbci.co.uk/news/world/rss.xml"],
  ["news-bbc-top", "https://feeds.bbci.co.uk/news/rss.xml"],
  ["news-npr", "https://feeds.npr.org/1001/rss.xml"],
  ["news-guardian-world", "https://www.theguardian.com/world/rss"],
  ["news-guardian-us", "https://www.theguardian.com/us-news/rss"],
  ["news-aljazeera", "https://www.aljazeera.com/xml/rss/all.xml"],
  ["news-nyt-home", "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml"],
  ["news-nyt-world", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"],
  ["news-cbs", "https://www.cbsnews.com/latest/rss/main"],
  ["news-abc", "https://abcnews.go.com/abcnews/topstories"],
  ["news-fox", "https://moxie.foxnews.com/google-publisher/latest.xml"],
  ["news-wsj-world", "https://feeds.a.dj.com/rss/RSSWorldNews.xml"],
  ["news-google-top", "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en"],
  ["news-france24", "https://www.france24.com/en/rss"],
  ["news-dw", "https://rss.dw.com/rdf/rss-en-all"],
  ["news-pbs", "https://www.pbs.org/newshour/feeds/rss/headlines"],
  ["news-wapo-world", "https://feeds.washingtonpost.com/rss/world"],
  ["news-nbc", "https://feeds.nbcnews.com/nbcnews/public/news"],
  ["news-sky-world", "https://feeds.skynews.com/feeds/rss/world.xml"],
  ["news-cnn", "http://rss.cnn.com/rss/cnn_topstories.rss"],
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
