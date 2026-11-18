// Every upstream source the monitor reads, with a check that proves the
// response holds real data and is not a block page.
//
// simple(url, check, opts) covers a single request. Sources that need more
// than one request define probe(get) themselves.

const json = (t) => JSON.parse(t);
const need = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const count = (t, re) => (t.match(re) ?? []).length;

function simple(url, check, opts) {
  return {
    url: typeof url === "function" ? null : url,
    async probe(get) {
      const u = typeof url === "function" ? url() : url;
      const res = await get(u, opts);
      let detail = null;
      let why;
      if (res.ok) {
        try {
          detail = check(res.text, res);
        } catch (e) {
          why = String(e.message).slice(0, 200);
        }
      }
      return { res, url: u, detail, why };
    },
  };
}

// Kubra hosts the outage maps for both utilities. The current data folder
// changes every few minutes, so it is looked up first.
function kubra(stormcenter, view) {
  const state = `https://kubra.io/stormcenter/api/v1/stormcenters/${stormcenter}/views/${view}/currentState?preview=false`;
  return {
    url: state,
    async probe(get) {
      const first = await get(state);
      if (!first.ok) return { res: first, url: state, detail: null };
      const path = json(first.text)?.data?.interval_generation_data;
      need(path, "no data path in currentState");
      for (let n = 1; n <= 6; n++) {
        const u = `https://kubra.io/${path}/public/summary-${n}/data.json`;
        const res = await get(u);
        if (!res.ok) continue;
        const totals = json(res.text)?.summaryFileData?.totals?.[0];
        need(totals, "summary has no totals");
        const out = totals.total_cust_a?.val;
        const served = totals.total_cust_s;
        return { res, url: u, detail: `summary-${n}: ${out} of ${served} customers out` };
      }
      throw new Error("no summary file found under " + path);
    },
  };
}

const statuspage = (host) =>
  simple(`https://${host}/api/v2/summary.json`, (t) => {
    const j = json(t);
    need(j.status?.description, "no status");
    return `${j.status.description}; ${j.components?.length ?? 0} components`;
  });

const cboe = (sym) =>
  simple(`https://cdn.cboe.com/api/global/delayed_quotes/quotes/${sym}.json`, (t) => {
    const j = json(t);
    need(j.data?.current_price != null, "no price");
    return `${j.data.current_price} at ${j.data.last_trade_time}`;
  });

const coinbase = (pair) =>
  simple(`https://api.exchange.coinbase.com/products/${pair}/ticker`, (t) => {
    const j = json(t);
    need(j.price, "no price");
    return `${j.price} at ${j.time}`;
  });

const yahoo = (sym) =>
  simple(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`,
    (t) => {
      const m = json(t).chart?.result?.[0]?.meta;
      need(m?.regularMarketPrice != null, "no price");
      return `${m.regularMarketPrice} at ${new Date(m.regularMarketTime * 1000).toISOString()}`;
    },
  );

const fred = (id) =>
  simple(
    () => {
      const d = new Date(Date.now() - 400 * 86400e3).toISOString().slice(0, 10);
      return `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${d}`;
    },
    (t) => {
      const lines = t.trim().split("\n");
      need(lines.length > 5 && /date/i.test(lines[0]), "not a FRED csv");
      return `${lines.length - 1} rows, last ${lines.at(-1)}`;
    },
  );

const nws = (zone) =>
  simple(
    `https://api.weather.gov/alerts/active?zone=${zone}`,
    (t) => {
      const j = json(t);
      need(Array.isArray(j.features), "no features");
      return `${j.features.length} active alerts`;
    },
    { accept: "application/geo+json" },
  );

const ioda = (asn) =>
  simple(
    () => {
      const now = Math.floor(Date.now() / 1000);
      return `https://api.ioda.inetintel.cc.gatech.edu/v2/signals/raw/asn/${asn}?from=${now - 10800}&until=${now}`;
    },
    (t) => {
      const j = json(t);
      const series = (j.data ?? []).flat();
      need(series.length, "no signals");
      return `${series.length} signals: ${series.map((s) => s.datasource).join(", ")}`;
    },
  );

const html = (url, marker, extra) =>
  simple(url, (t) => {
    need(marker.test(t), `marker ${marker} not found`);
    return `${t.length} chars` + (extra ? "; " + extra(t) : "");
  });

export const SOURCES = [
  // Utilities
  { id: "odin", group: "Utilities", name: "DOE outage counts by county", ...simple(
      "https://ornl.opendatasoft.com/api/explore/v2.1/catalog/datasets/odin-real-time-outages-county/records?limit=1",
      (t) => { const j = json(t); need(j.total_count != null, "no total_count"); return `${j.total_count} county rows`; }) },
  { id: "jcpl", group: "Utilities", name: "JCP&L outage map", ...kubra("6c715f0e-bbec-465f-98cc-0b81623744be", "fcd7c23d-de37-4471-8ca3-37c3260f94fa") },
  { id: "pseg", group: "Utilities", name: "PSE&G outage map", ...kubra("79d82478-c10a-4956-a045-89de3cda618c", "bdb7f5be-1c1a-46fa-862e-ebdf21851d2e") },
  { id: "pjm", group: "Utilities", name: "PJM emergency procedures", ...html(
      "https://emergencyprocedures.pjm.com/ep/pages/dashboard.jsf", /Emergency Procedures/i, (t) => `${count(t, /<tr/g)} table rows`) },
  { id: "smcmua", group: "Utilities", name: "SMCMUA water", ...html("https://www.smcmua.org/", /SMCMUA|Southeast Morris/i) },

  // Travel
  { id: "faa", group: "Travel", name: "FAA airport status", ...simple(
      "https://nasstatus.faa.gov/api/airport-status-information",
      (t) => { need(/AIRPORT_STATUS_INFORMATION/.test(t), "not FAA xml"); return `${count(t, /<Delay_type>/g)} delay types listed`; }) },
  { id: "njt-board", group: "Travel", name: "NJ Transit departure board", ...html(
      "https://www.njtransit.com/dv-to/Morristown", /Morristown/i, (t) => (/__NEXT_DATA__/.test(t) ? "has page data" : "no embedded page data")) },
  { id: "njt-graphql", group: "Travel", name: "NJ Transit data endpoint", ...simple(
      "https://www.njtransit.com/api/graphql/graphql",
      (t) => { json(t); return t.slice(0, 120); },
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "{ __typename }" }) }) },
  { id: "njt-rss", group: "Travel", name: "NJ Transit rail advisories", ...simple(
      "https://www.njtransit.com/rss/RailAdvisories_feed.xml",
      (t) => { need(/<rss|<feed/i.test(t), "not a feed"); return `${count(t, /<item>/g)} items`; }) },
  { id: "mta", group: "Travel", name: "MTA subway alerts", ...simple(
      "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json",
      (t) => { const j = json(t); need(Array.isArray(j.entity), "no entity list"); return `${j.entity.length} alerts`; }) },
  { id: "path", group: "Travel", name: "PATH incidents", ...simple(
      "https://www.panynj.gov/bin/portauthority/everbridge/incidents?status=All&department=Path",
      (t) => { const j = json(t); const list = Array.isArray(j) ? j : j.data ?? j.incidents ?? []; return `${list.length} incidents; keys ${Object.keys(Array.isArray(j) ? j[0] ?? {} : j).slice(0, 6).join(",")}`; }) },

  // Internet
  { id: "claude", group: "Internet", name: "Claude status", ...statuspage("status.claude.com") },
  { id: "cloudflare", group: "Internet", name: "Cloudflare status", ...statuspage("www.cloudflarestatus.com") },
  { id: "apple", group: "Internet", name: "Apple system status", ...simple(
      "https://www.apple.com/support/systemstatus/data/system_status_en_US.js",
      (t) => { need(/"services"/.test(t), "no services list"); return `${count(t, /"serviceName"/g)} services`; }) },
  { id: "m365", group: "Internet", name: "Microsoft 365 status", ...simple(
      "https://status.cloud.microsoft/api/posts/m365Consumer",
      (t) => { const j = json(t); return Array.isArray(j) ? `${j.length} posts` : `keys ${Object.keys(j).slice(0, 6).join(",")}`; }) },
  { id: "ioda-optimum", group: "Internet", name: "Optimum network signals", ...ioda(6128) },
  { id: "ioda-verizon", group: "Internet", name: "Verizon Wireless network signals", ...ioda(6167) },

  // Money
  { id: "cboe-spx", group: "Money", name: "S&P 500 (Cboe, 15 min)", ...cboe("_SPX") },
  { id: "cboe-vix", group: "Money", name: "VIX (Cboe, 15 min)", ...cboe("_VIX") },
  { id: "cboe-tnx", group: "Money", name: "10-yr Treasury (Cboe, 15 min)", ...cboe("_TNX") },
  { id: "cboe-uso", group: "Money", name: "Oil fund USO (Cboe, crude fallback)", ...cboe("USO") },
  { id: "coinbase-btc", group: "Money", name: "Bitcoin (Coinbase, live)", ...coinbase("BTC-USD") },
  { id: "coinbase-gold", group: "Money", name: "Gold token PAXG (Coinbase, live)", ...coinbase("PAXG-USD") },
  { id: "coinbase-candles", group: "Money", name: "Coinbase daily history", ...simple(
      "https://api.exchange.coinbase.com/products/PAXG-USD/candles?granularity=86400",
      (t) => { const j = json(t); need(Array.isArray(j) && j.length > 100, "short history"); return `${j.length} daily candles`; }) },
  { id: "yahoo-crude", group: "Money", name: "WTI crude futures (Yahoo)", ...yahoo("CL=F") },
  { id: "yahoo-rbob", group: "Money", name: "Gasoline futures (Yahoo)", ...yahoo("RB=F") },
  { id: "fred-vix", group: "Money", name: "FRED history (VIX)", ...fred("VIXCLS") },
  { id: "fred-hy", group: "Money", name: "FRED junk spread", ...fred("BAMLH0A0HYM2") },
  { id: "fred-stress", group: "Money", name: "FRED Fed stress index", ...fred("STLFSI4") },
  { id: "fed", group: "Money", name: "Fed payment services", ...html(
      "https://app.frbservices.org/app/status/serviceStatus.do", /Fedwire/i, (t) => `${count(t, /alt="/g)} status icons`) },
  { id: "plaid", group: "Money", name: "Plaid status", ...statuspage("status.plaid.com") },
  { id: "paypal", group: "Money", name: "PayPal status", ...simple(
      "https://www.paypal-status.com/api/v1/components",
      (t) => { const j = json(t); const list = j.result ?? j.components ?? j; return `${Array.isArray(list) ? list.length : Object.keys(list).length} components`; }) },

  // Fuel
  { id: "fred-gas", group: "Fuel", name: "FRED weekly gas price", ...fred("GASREGW") },
  { id: "fred-diesel", group: "Fuel", name: "FRED weekly diesel price", ...fred("GASDESW") },
  { id: "fred-crude", group: "Fuel", name: "FRED daily crude history", ...fred("DCOILWTICO") },
  { id: "aaa-nj", group: "Fuel", name: "AAA New Jersey gas price", ...html(
      "https://gasprices.aaa.com/?state=NJ", /Current Avg/i, (t) => (t.match(/Current Avg\.[\s\S]{0,200}?\$([0-9.]+)/)?.[1] ?? "price not parsed")) },

  // Hazards
  { id: "nws-morris", group: "Hazards", name: "NWS alerts, Morris County", ...nws("NJZ008") },
  { id: "nws-manhattan", group: "Hazards", name: "NWS alerts, Manhattan", ...nws("NYZ072") },
  { id: "swpc", group: "Hazards", name: "NOAA space weather scales", ...simple(
      "https://services.swpc.noaa.gov/products/noaa-scales.json",
      (t) => { const j = json(t); need(j["0"], "no current scales"); return `G${j["0"].G.Scale} S${j["0"].S.Scale} R${j["0"].R.Scale}`; }) },
  { id: "usgs-us", group: "Hazards", name: "USGS significant quakes", ...simple(
      "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson",
      (t) => `${json(t).features.length} quakes of 4.5+ in the past day`) },
  { id: "usgs-local", group: "Hazards", name: "USGS quakes near Morristown", ...simple(
      () => {
        const d = new Date(Date.now() - 3 * 86400e3).toISOString().slice(0, 19);
        return `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=40.797&longitude=-74.481&maxradiuskm=300&minmagnitude=2&starttime=${d}`;
      },
      (t) => `${json(t).features.length} quakes of 2+ within 300 km in 3 days`) },

  // Advisories
  { id: "fema", group: "Advisories", name: "FEMA disaster declarations", ...simple(
      "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?$top=3&$orderby=declarationDate%20desc",
      (t) => { const list = json(t).DisasterDeclarationsSummaries; need(list?.length, "no declarations"); return `latest ${list[0].declarationDate?.slice(0, 10)} ${list[0].state} ${list[0].declarationType}`; }) },
  { id: "ntas", group: "Advisories", name: "DHS terrorism advisories", ...simple(
      "https://www.dhs.gov/ntas/1.1/alerts.xml",
      (t) => { need(/<alerts/i.test(t), "not NTAS xml"); return `${count(t, /<alert[ >]/g)} active alerts`; }) },
  { id: "nrc-status", group: "Advisories", name: "NRC reactor status", ...html(
      "https://www.nrc.gov/reading-rm/doc-collections/event-status/reactor-status/ps.html", /Power Reactor Status/i) },
  { id: "nixle", group: "Advisories", name: "Morristown alerts (Nixle)", ...html(
      "https://nixle.us/city/nj/morristown/", /Morristown/i) },

  // Cyber
  { id: "cisa", group: "Cyber", name: "CISA exploited flaws", ...simple(
      "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
      (t) => { const j = json(t); need(j.vulnerabilities?.length, "no list"); return `${j.vulnerabilities.length} entries, catalog ${j.catalogVersion}`; }) },
];
