import { need, fetchOk, strip, etDay, priceFields } from "../lib/util.mjs";
import { price, yahoo, fred } from "./money.mjs";

const dayLabel = (iso) => etDay(Date.parse(iso + "T12:00:00-05:00"));
const fuel = { tile: "fuel", bad: "high", chg: "pct" };

function weekly(id, base, series) {
  return price(id, { ...fuel, fmt: "usd2", ...base }, async (ctx) => {
    const rows = await fred(ctx, series);
    return { hist: rows.map((r) => r.v), asOf: "week of " + dayLabel(rows.at(-1).date), perWeek: 1 };
  });
}

export default [
  price("crude", {
    ...fuel, name: "Crude oil", label: "Crude oil", fmt: "usd2",
    note: "West Texas Intermediate futures, the nearest contract. Delayed about 10 minutes.",
    source: "https://finance.yahoo.com/quote/CL=F/",
  }, async (ctx) => {
    try {
      return await yahoo(ctx, "CL=F");
    } catch (e) {
      // Daily spot price from the Energy Department, which runs about a week behind.
      const rows = await fred(ctx, "DCOILWTICO");
      return {
        hist: rows.map((r) => r.v), asOf: dayLabel(rows.at(-1).date) + " close",
        extra: { note: "West Texas Intermediate spot price. The live source didn't answer, so this is the backup, which runs about a week behind.", source: "https://fred.stlouisfed.org/series/DCOILWTICO" },
      };
    }
  }),
  price("rbob", {
    ...fuel, name: "Gasoline futures (RBOB)", label: "Gas, wholesale", fmt: "usd2",
    note: "The wholesale price of gasoline, before taxes and delivery. Pump prices tend to follow it within a week or two. Delayed about 10 minutes.",
    source: "https://finance.yahoo.com/quote/RB=F/",
  }, (ctx) => yahoo(ctx, "RB=F")),
  weekly("gas", { name: "Regular gasoline, US average", label: "Gas, US pump", note: "US average for regular, published weekly by the Energy Department." , source: "https://fred.stlouisfed.org/series/GASREGW" }, "GASREGW"),
  weekly("diesel", { name: "Diesel, US average", label: "Diesel", note: "Diesel moves freight, so it's the better supply chain tell. Published weekly.", source: "https://fred.stlouisfed.org/series/GASDESW" }, "GASDESW"),
  {
    id: "gas-nj",
    every: 180,
    async run(ctx) {
      const text = strip(await fetchOk(ctx, "https://gasprices.aaa.com/?state=NJ"));
      const m = text.match(/Current Avg\.\s*\$([\d.]+)[\s\S]{0,80}?Yesterday Avg\.\s*\$([\d.]+)[\s\S]{0,80}?Week Ago Avg\.\s*\$([\d.]+)[\s\S]{0,80}?Month Ago Avg\.\s*\$([\d.]+)[\s\S]{0,80}?Year Ago Avg\.\s*\$([\d.]+)/);
      need(m, "AAA price table not found");
      const [now, yesterday, week, month, year] = m.slice(1).map(Number);
      need(now > 1 && now < 12, "AAA price out of range");
      // What counts as a large move is borrowed from the US weekly series until this one has its own history.
      const us = priceFields((await fred(ctx, "GASREGW")).map((r) => r.v), 1, "pct");
      return {
        name: "Regular gasoline, New Jersey average", label: "Gas, NJ pump", tile: "fuel", scope: "home", kind: "price",
        fmt: "usd2", bad: "high", chg: "pct", wk: 1,
        num: now, refs: { 1: week, 4: month }, series: [],
        bigA: us.bigA, bigB: us.bigB,
        asOf: etDay(ctx.now),
        note: "AAA's daily state average for regular.",
        items: [`Yesterday $${yesterday.toFixed(3)}`, `A year ago $${year.toFixed(3)}`],
        source: "https://gasprices.aaa.com/?state=NJ",
      };
    },
  },
];
