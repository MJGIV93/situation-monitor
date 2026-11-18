import { need, fetchOk, strip, etDay, round, priceFields } from "../lib/util.mjs";
import { price, yahoo, fred } from "./money.mjs";

const dayLabel = (iso) => etDay(Date.parse(iso + "T12:00:00-05:00"));
const fuel = { tile: "fuel", bad: "high", chg: "pct" };

function weekly(id, base, series) {
  return price(id, { ...fuel, fmt: "usd2", ...base }, async (ctx) => {
    const rows = await fred(ctx, series);
    return { hist: rows.map((r) => r.v), dates: rows.map((r) => r.date), asOf: "week of " + dayLabel(rows.at(-1).date), perWeek: 1 };
  });
}

// The two futures trade all day, so like the market readings in Money a move has to beat 99% of the past
// year's to count as big. The weekly pump prices have 52 points a year and keep the 95% rule.
const BIG = { bigPct: 99 };

export default [
  price("crude", {
    ...fuel, ...BIG, name: "Crude oil, WTI futures", label: "Crude oil", rowLabel: ["Crude oil", "WTI futures"], order: 1, fmt: "usd2",
    note: "West Texas Intermediate futures, the nearest contract. Delayed about 10 minutes.",
    source: "https://finance.yahoo.com/quote/CL=F/",
  }, async (ctx) => {
    try {
      return await yahoo(ctx, "CL=F");
    } catch (e) {
      // Daily spot price from the Energy Department, which runs about a week behind.
      const rows = await fred(ctx, "DCOILWTICO");
      return {
        hist: rows.map((r) => r.v), dates: rows.map((r) => r.date), asOf: dayLabel(rows.at(-1).date) + " close",
        extra: { note: "West Texas Intermediate spot price. The live source didn't answer, so this is the backup, which runs about a week behind.", source: "https://fred.stlouisfed.org/series/DCOILWTICO" },
      };
    }
  }),
  price("rbob", {
    ...fuel, ...BIG, name: "Wholesale gasoline, RBOB futures", label: "Wholesale gas", rowLabel: ["Wholesale gas", "futures, before tax"], order: 2, fmt: "usd2",
    note: "The wholesale price of gasoline, before taxes and delivery. Pump prices tend to follow it within a week or two. Delayed about 10 minutes.",
    source: "https://finance.yahoo.com/quote/RB=F/",
  }, async (ctx) => {
    try {
      return await yahoo(ctx, "RB=F");
    } catch (e) {
      // Daily New York Harbor spot price from the Energy Department, which runs about a week behind.
      const rows = await fred(ctx, "DGASNYH");
      return {
        hist: rows.map((r) => r.v), dates: rows.map((r) => r.date), asOf: dayLabel(rows.at(-1).date) + " close",
        extra: { note: "New York Harbor spot price for regular gasoline. The live source didn't answer, so this is the backup, which runs about a week behind.", source: "https://fred.stlouisfed.org/series/DGASNYH" },
      };
    }
  }),
  weekly("gas", { name: "Regular gasoline at the pump, US average", label: "Pump gas, US", rowLabel: ["Pump gas", "US average"], order: 3, note: "US average for regular, published weekly by the Energy Department." , source: "https://fred.stlouisfed.org/series/GASREGW" }, "GASREGW"),
  weekly("diesel", { name: "Diesel at the pump, US average", label: "Diesel", rowLabel: ["Diesel", "US average"], order: 4, note: "Diesel moves freight, so it's the better supply chain tell. Published weekly.", source: "https://fred.stlouisfed.org/series/GASDESW" }, "GASDESW"),
  {
    id: "gas-nj",
    every: 180,
    async run(ctx) {
      const text = strip(await fetchOk(ctx, "https://gasprices.aaa.com/?state=NJ"));
      const m = text.match(/Current Avg\.\s*\$([\d.]+)[\s\S]{0,80}?Yesterday Avg\.\s*\$([\d.]+)[\s\S]{0,80}?Week Ago Avg\.\s*\$([\d.]+)[\s\S]{0,80}?Month Ago Avg\.\s*\$([\d.]+)[\s\S]{0,80}?Year Ago Avg\.\s*\$([\d.]+)/);
      need(m, "AAA price table not found");
      const [now, yesterday, week, month, year] = m.slice(1).map(Number);
      need(now > 1 && now < 12, "AAA price out of range");
      // AAA publishes no history, so each day's value is kept here from now on.
      const day = (back) => new Date(ctx.now - back * 86400e3).toISOString().slice(0, 10);
      const days = (ctx.cache.days ??= {});
      days[day(0)] = now;
      for (const [back, v] of [[1, yesterday], [7, week], [30, month], [365, year]]) days[day(back)] ??= v;
      for (const k of Object.keys(days)) if (k < day(800)) delete days[k];
      const own = [], ownDates = [];
      for (let w = 0; w <= 52 && days[day(w * 7)] != null; w++) { own.unshift(days[day(w * 7)]); ownDates.unshift(day(w * 7)); }

      // Until a year of its own history exists, the range and what counts as a large
      // move come from the US weekly series, shifted to New Jersey's price level.
      const usRows = (await fred(ctx, "GASREGW")).map((r) => r.v);
      const us = priceFields(usRows, 1, "pct");
      const mine = own.length >= 53 ? priceFields(own, 1, "pct") : null;
      const shift = now - usRows.at(-1);
      return {
        name: "Regular gasoline at the pump, New Jersey average", label: "Pump gas, NJ", rowLabel: ["Pump gas", "New Jersey average"], tile: "fuel", scope: "home", kind: "price",
        fmt: "usd2", bad: "high", chg: "pct", wk: 1,
        num: now, refs: { 1: week, 4: month }, series: own.length >= 3 ? own : [], dates: own.length >= 3 ? ownDates : undefined,
        lo: mine ? mine.lo : round(us.lo + shift, 3), hi: mine ? mine.hi : round(Math.max(us.hi + shift, now), 3), med: mine ? mine.med : round(us.med + shift, 3),
        bigA: (mine ?? us).bigA, bigB: (mine ?? us).bigB,
        asOf: etDay(ctx.now),
        note: "AAA's daily state average for regular." + (mine ? "" : ` Until a year of New Jersey's own prices is on record (${own.length} of 53 weeks so far), the 12-month range shown is the US range moved ${shift >= 0 ? "up" : "down"} ${Math.round(Math.abs(shift) * 100)} cents to New Jersey's level.`),
        items: [`Yesterday $${yesterday.toFixed(3)}`, `A year ago $${year.toFixed(3)}`],
        source: "https://gasprices.aaa.com/?state=NJ",
      };
    },
  },
];
