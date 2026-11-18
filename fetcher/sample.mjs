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

const census = (address, format = "json") => `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=${format}`;
const LIST = [
  ["nws-morris-zones", "https://api.weather.gov/alerts/active?zone=NJZ008,NJC027", geo],
  ["nws-morris-point", "https://api.weather.gov/alerts/active?point=40.797,-74.481", geo],
  ["nws-nyc-zones", "https://api.weather.gov/alerts/active?zone=NYZ072,NYC061", geo],
  ["nws-shapes", "https://api.weather.gov/alerts/active?event=Special%20Weather%20Statement,Flood%20Warning,Flood%20Advisory,Severe%20Thunderstorm%20Warning&limit=6", geo],
  ["census-lake", census("208 Lake Road, Morris Township, NJ")],
  ["census-lake-short", census("208 Lake Rd, Morristown, NJ")],
  ["census-jsonp", census("208 Lake Road, Morris Township, NJ", "jsonp") + "&callback=cb"],
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

const state = await save("kubra-jcpl-state", kubra(...JCPL));
const path = JSON.parse(state.text).data.interval_generation_data;
await save("kubra-jcpl-townships", `https://kubra.io/${path}/public/thematic-17/thematic_areas.json`);
await save("kubra-jcpl-report", `https://kubra.io/${path}/public/reports/10ecc9a7-094a-46e3-a733-cbebe39cf407_report.json`);

await writeFile(`${OUT}/index.json`, JSON.stringify(index, null, 1));
