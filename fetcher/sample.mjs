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
  ["odin", "https://ornl.opendatasoft.com/api/explore/v2.1/catalog/datasets/odin-real-time-outages-county/records?limit=100&order_by=metersaffected%20desc"],
  ["odin-meta", "https://ornl.opendatasoft.com/api/explore/v2.1/catalog/datasets/odin-real-time-outages-county"],
  ["pjm", "https://emergencyprocedures.pjm.com/ep/pages/dashboard.jsf"],
  ["smcmua", "https://www.smcmua.org/"],
  ["faa", "https://nasstatus.faa.gov/api/airport-status-information"],
  ["njt-board-morristown", "https://www.njtransit.com/dv-to/Morristown"],
  ["njt-graphql-schema", "https://www.njtransit.com/api/graphql/graphql", gql("{ __schema { queryType { fields { name args { name type { name kind ofType { name kind } } } type { name kind ofType { name kind ofType { name kind } } } } } } }")],
  ["njt-rss", "https://www.njtransit.com/rss/RailAdvisories_feed.xml"],
  ["njt-alerts-me", "https://www.njtransit.com/travel-alerts-to?tab=Rail&line=ME"],
  ["mta", "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json"],
  ["path", "https://www.panynj.gov/bin/portauthority/everbridge/incidents?status=All&department=Path"],
  ["claude", "https://status.claude.com/api/v2/summary.json"],
  ["cloudflare", "https://www.cloudflarestatus.com/api/v2/summary.json"],
  ["plaid", "https://status.plaid.com/api/v2/summary.json"],
  ["apple", "https://www.apple.com/support/systemstatus/data/system_status_en_US.js"],
  ["ms-m365", "https://status.cloud.microsoft/api/posts/m365Consumer"],
  ["ms-mac", "https://status.cloud.microsoft/api/posts/mac"],
  ["ms-azure", "https://status.cloud.microsoft/api/posts/azure"],
  ["ioda-6128", `https://api.ioda.inetintel.cc.gatech.edu/v2/signals/raw/asn/6128?from=${now - 86400}&until=${now}`],
  ["ioda-6167", `https://api.ioda.inetintel.cc.gatech.edu/v2/signals/raw/asn/6167?from=${now - 86400}&until=${now}`],
  ["ioda-alerts-6128", `https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts?entityType=asn&entityCode=6128&from=${now - 7 * 86400}&until=${now}`],
  ["ioda-events-6128", `https://api.ioda.inetintel.cc.gatech.edu/v2/outages/events?entityType=asn&entityCode=6128&from=${now - 30 * 86400}&until=${now}`],
  ["cboe-spx", cboe("_SPX")], ["cboe-vix", cboe("_VIX")], ["cboe-tnx", cboe("_TNX")], ["cboe-uso", cboe("USO")],
  ["cboe-hist-spx", cboeHist("_SPX")], ["cboe-hist-vix", cboeHist("_VIX")], ["cboe-hist-tnx", cboeHist("_TNX")],
  ["coinbase-btc", "https://api.exchange.coinbase.com/products/BTC-USD/ticker"],
  ["coinbase-btc-candles", "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400"],
  ["coinbase-paxg", "https://api.exchange.coinbase.com/products/PAXG-USD/ticker"],
  ["coinbase-paxg-candles", "https://api.exchange.coinbase.com/products/PAXG-USD/candles?granularity=86400"],
  ["yahoo-crude", yahoo("CL=F")], ["yahoo-rbob", yahoo("RB=F")], ["yahoo-gold", yahoo("GC=F")],
  ["yahoo-spx", yahoo("^GSPC")], ["yahoo-vix", yahoo("^VIX")], ["yahoo-tnx", yahoo("^TNX")],
  ["yahoo-crude-5d", yahoo("CL=F", "5d")],
  ...["VIXCLS", "SP500", "CBBTCUSD", "DGS10", "BAMLH0A0HYM2", "STLFSI4", "GASREGW", "GASDESW", "DCOILWTICO"].map((id) => ["fred-" + id, fred(id)]),
  ["fed", "https://app.frbservices.org/app/status/serviceStatus.do"],
  ["paypal-components", "https://www.paypal-status.com/api/v1/components"],
  ["paypal-events", "https://www.paypal-status.com/api/v1/events"],
  ["aaa-nj", "https://gasprices.aaa.com/?state=NJ"],
  ["aaa-us", "https://gasprices.aaa.com/"],
  ["nws-NJZ008", "https://api.weather.gov/alerts/active?zone=NJZ008", geo],
  ["nws-NYZ072", "https://api.weather.gov/alerts/active?zone=NYZ072", geo],
  ["nws-sample-active", "https://api.weather.gov/alerts/active?status=actual&message_type=alert&limit=40", geo],
  ["swpc", "https://services.swpc.noaa.gov/products/noaa-scales.json"],
  ["usgs-day", "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson"],
  ["usgs-local", `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=40.797&longitude=-74.481&maxradiuskm=300&minmagnitude=2&starttime=${daysAgo(30)}`],
  ["usgs-us-week", "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson"],
  ["fema", `https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?$filter=declarationDate%20ge%20%27${daysAgo(30)}T00:00:00.000z%27&$orderby=declarationDate%20desc&$top=200`],
  ["ntas", "https://www.dhs.gov/ntas/1.1/alerts.xml"],
  ["nrc-status", "https://www.nrc.gov/reading-rm/doc-collections/event-status/reactor-status/ps.html"],
  ["nrc-events", "https://www.nrc.gov/reading-rm/doc-collections/event-status/event/en.html"],
  ["nixle", "https://nixle.us/city/nj/morristown/"],
  ["cisa", "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"],
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

// Kubra: follow the pointer to the current data folder and save every summary and config file.
for (const [label, [sc, view]] of [["jcpl", JCPL], ["pseg", PSEG]]) {
  const state = await save(`kubra-${label}-state`, kubra(sc, view));
  if (!state.ok) continue;
  const j = JSON.parse(state.text);
  const path = j?.data?.interval_generation_data;
  for (let n = 1; n <= 6; n++) await save(`kubra-${label}-summary-${n}`, `https://kubra.io/${path}/public/summary-${n}/data.json`);
  const dep = j?.stormcenterDeploymentId;
  if (dep) await save(`kubra-${label}-config`, `https://kubra.io/stormcenter/api/v1/stormcenters/${sc}/views/${view}/configuration/${dep}?preview=false`);
}

await writeFile(`${OUT}/index.json`, JSON.stringify(index, null, 1));
