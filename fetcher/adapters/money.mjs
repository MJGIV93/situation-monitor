import { json, need, fetchOk, clip, etDay, etStamp, priceFields, fredRows, fredUrl } from "../lib/util.mjs";
import { statuspage } from "./internet.mjs";

/* ---- sources ---- */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Cboe stamps index quotes in Eastern time with no zone marker.
function cboeTime(s) {
  if (/[zZ]|[+-]\d\d:\d\d$/.test(s)) return etStamp(Date.parse(s));
  const m = s.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/);
  if (!m) return s;
  const h = Number(m[4]);
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${h % 12 || 12}:${m[5]} ${h < 12 ? "AM" : "PM"} ET`;
}
// Daily closes from Cboe with the 15-minute delayed quote as the last point.
export async function cboe(ctx, sym, scale = 1) {
  const closes = await ctx.memo("hist-" + sym, 720, async () => {
    const j = json(await fetchOk(ctx, `https://cdn.cboe.com/api/global/delayed_quotes/charts/historical/${sym}.json`, { timeout: 30000 }));
    need(Array.isArray(j.data) && j.data.length > 260, "short Cboe history");
    return j.data.slice(-300).map((d) => [d.date, Number(d.close)]).filter((x) => x[1] > 0);
  });
  const q = json(await fetchOk(ctx, `https://cdn.cboe.com/api/global/delayed_quotes/quotes/${sym}.json`)).data;
  need(q?.current_price > 0, "no Cboe quote");
  const day = String(q.last_trade_time).slice(0, 10);
  return { hist: [...closes.filter(([d]) => d < day).map((x) => x[1] * scale), q.current_price * scale], asOf: cboeTime(String(q.last_trade_time)) };
}
// Daily closes from Coinbase with the live trade as the last point.
async function coinbase(ctx, pair) {
  const api = `https://api.exchange.coinbase.com/products/${pair}`;
  const candles = await ctx.memo("candles-" + pair, 60, async () => {
    const j = json(await fetchOk(ctx, `${api}/candles?granularity=86400`));
    need(Array.isArray(j) && j.length > 200, "short Coinbase history");
    return j.map((c) => [c[0], c[4]]).reverse();
  });
  const t = json(await fetchOk(ctx, `${api}/ticker`));
  need(Number(t.price) > 0, "no Coinbase price");
  const today = Math.floor(Date.parse(t.time) / 86400e3) * 86400;
  return { hist: [...candles.filter(([d]) => d < today).map((x) => x[1]), Number(t.price)], asOf: etStamp(Date.parse(t.time)) };
}
// Daily closes from Yahoo with the delayed futures quote as the last point.
export async function yahoo(ctx, sym) {
  const j = json(await fetchOk(ctx, `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1y`));
  const r = j.chart?.result?.[0], m = r?.meta;
  need(m?.regularMarketPrice > 0 && Array.isArray(r.timestamp), "no Yahoo quote");
  const closes = r.indicators.quote[0].close;
  // The final bar is the live session. Earlier bars with no close are skipped.
  const past = closes.slice(0, -1).filter((x) => typeof x === "number" && x > 0);
  const pctToday = m.regularMarketChangePercent;
  if (typeof pctToday === "number") {
    const prev = m.regularMarketPrice / (1 + pctToday / 100);
    if (Math.abs(prev - past.at(-1)) / prev > 0.0005) past.push(prev);
  }
  return { hist: [...past, m.regularMarketPrice], asOf: etStamp(m.regularMarketTime * 1000) };
}
export async function fred(ctx, id) {
  const rows = await ctx.memo("fred-" + id, 60, async () => fredRows(await fetchOk(ctx, fredUrl(id))));
  need(rows.length > 20, "short FRED series " + id);
  return rows;
}
const dayLabel = (iso) => etDay(Date.parse(iso + "T12:00:00-05:00"));

/* ---- readings ---- */
export function price(id, base, load) {
  return {
    id,
    every: 10,
    async run(ctx) {
      const { hist, asOf, perWeek = 5, extra = {} } = await load(ctx);
      return { tile: "money", scope: "national", kind: "price", ...base, ...priceFields(hist, perWeek, base.chg ?? "pct"), asOf, ...extra };
    },
  };
}

export default [
  price("vix", {
    name: "VIX (market fear gauge)", label: "VIX", fmt: "num2", bad: "high", chg: "abs",
    abs: { x: [15, 20, 30, 40, 60], s: [0, 15, 50, 80, 100] },
    note: "How much traders expect stocks to swing over the next month. Delayed 15 minutes.",
    source: "https://www.cboe.com/tradable_products/vix/",
  }, (ctx) => cboe(ctx, "_VIX")),
  price("sp500", {
    name: "S&P 500", label: "S&P 500", fmt: "num0", bad: "low", chg: "pct",
    note: "Delayed 15 minutes during market hours.",
    source: "https://www.cboe.com/us/indices/dashboard/spx/",
  }, (ctx) => cboe(ctx, "_SPX")),
  price("ust10", {
    name: "10-year Treasury yield", label: "10-yr Treasury", fmt: "pct2", bad: "high", chg: "abs", cap: 30,
    note: "Rising yields squeeze bank balance sheets and raise borrowing costs. Delayed 15 minutes.",
    source: "https://www.cboe.com/us/indices/dashboard/tnx/",
  }, (ctx) => cboe(ctx, "_TNX", 0.1)),
  price("bitcoin", {
    name: "Bitcoin", label: "Bitcoin", fmt: "usdk", bad: "low", chg: "pct", cap: 30,
    note: "Counted as a gauge of risk appetite. Live from Coinbase.",
    source: "https://www.coinbase.com/price/bitcoin",
  }, async (ctx) => ({ ...(await coinbase(ctx, "BTC-USD")), perWeek: 7 })),
  price("gold", {
    name: "Gold", label: "Gold", fmt: "usd0", bad: "both", chg: "pct", cap: 30,
    note: "A spike means a flight to safety. A deep slide while stocks and Bitcoin also fall can mean investors are selling everything to raise cash. Priced from PAXG, a token backed by one ounce of gold that trades around the clock and tracks spot within about half a percent.",
    source: "https://www.coinbase.com/price/pax-gold",
  }, async (ctx) => ({ ...(await coinbase(ctx, "PAXG-USD")), perWeek: 7 })),
  price("hy-spread", {
    name: "High-yield credit spread", label: "Junk spread", fmt: "pct2", bad: "high", chg: "abs",
    abs: { x: [3, 4, 5, 7, 10], s: [0, 10, 35, 65, 90] },
    note: "What risky companies pay to borrow, over the government's rate. Published daily, one day behind.",
    source: "https://fred.stlouisfed.org/series/BAMLH0A0HYM2",
  }, async (ctx) => {
    const rows = await fred(ctx, "BAMLH0A0HYM2");
    return { hist: rows.map((r) => r.v), asOf: dayLabel(rows.at(-1).date) + " close" };
  }),
  price("stlfsi", {
    name: "St. Louis Fed Financial Stress Index", label: "Fed stress", fmt: "num2", bad: "high", chg: "abs",
    abs: { x: [0, 1, 2, 4], s: [0, 30, 60, 90] },
    note: "One number combining 18 market measures. Below zero means less stress than average. Published weekly.",
    source: "https://fred.stlouisfed.org/series/STLFSI4",
  }, async (ctx) => {
    const rows = await fred(ctx, "STLFSI4");
    return { hist: rows.map((r) => r.v), asOf: "week of " + dayLabel(rows.at(-1).date), perWeek: 1 };
  }),
  {
    id: "fed-services",
    every: 10,
    async run(ctx) {
      const html = await fetchOk(ctx, "https://app.frbservices.org/app/status/serviceStatus.do");
      need(/Fedwire/i.test(html), "not the Fed status page");
      // The last three icons are the legend.
      const icons = [...html.matchAll(/alt="([^"]*)"/g)].map((m) => m[1]).filter((a) => /Normal|Issue|Disruption/i.test(a)).slice(0, -3);
      need(icons.length >= 10, "Fed status icons not found");
      const disrupted = icons.filter((a) => /Disruption/i.test(a)).length, issues = icons.filter((a) => /Issue/i.test(a)).length;
      return {
        name: "Fed payment services", label: "Fed payments", tile: "money", scope: "national", kind: "status",
        state: disrupted >= 3 ? "critical" : disrupted ? "major" : issues ? "minor" : "ok",
        short: `${icons.length - disrupted - issues} of ${icons.length}`,
        note: disrupted || issues ? `${disrupted} services disrupted and ${issues} with an issue, out of ${icons.length} including Fedwire, FedACH and FedNow.` : "Fedwire, FedACH, FedNow, Check 21 and the rest are all at normal operations.",
        source: "https://www.frbservices.org/service-status/",
      };
    },
  },
  {
    id: "pay-rails",
    every: 10,
    async run(ctx) {
      const rank = ["ok", "minor", "major", "critical"];
      const plaid = await statuspage(ctx, "status.plaid.com");
      const pp = json(await fetchOk(ctx, "https://www.paypal-status.com/api/v1/components")).result;
      need(Array.isArray(pp), "unexpected PayPal response");
      const down = pp.filter((c) => c.status?.production && !/operational/i.test(c.status.production));
      const paypal = down.length >= 5 ? "major" : down.length ? "minor" : "ok";
      const items = [...plaid.incidents.map((i) => "Plaid: " + clip(i.name, 100)), ...down.slice(0, 3).map((c) => `PayPal ${c.name}: ${c.status.production}`)];
      return {
        name: "Payment rails (Plaid and PayPal)", label: "Payment rails", tile: "money", scope: "national", kind: "status",
        state: rank[Math.max(rank.indexOf(plaid.state), rank.indexOf(paypal))],
        short: items.length ? `${items.length} flagged` : "Plaid, PayPal",
        note: "One merged reading. Plaid connects apps to most US banks, so a bank-wide login problem tends to show here.",
        items: items.slice(0, 4),
        source: "https://status.plaid.com/",
      };
    },
  },
];
