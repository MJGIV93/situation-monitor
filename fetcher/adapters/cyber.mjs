import { json, need, fetchOk, round, etDay } from "../lib/util.mjs";

export default [
  {
    id: "cisa-kev",
    every: 180,
    async run(ctx) {
      const j = json(await fetchOk(ctx, "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json", { timeout: 40000 }));
      need(Array.isArray(j.vulnerabilities) && j.vulnerabilities.length > 500, "catalog not found");
      const daysAgo = (d) => (ctx.now - Date.parse(d + "T12:00:00Z")) / 86400e3;
      const week = j.vulnerabilities.filter((v) => daysAgo(v.dateAdded) <= 7);
      const half = j.vulnerabilities.filter((v) => daysAgo(v.dateAdded) <= 182).length;
      const byDay = new Map();
      for (const v of week) byDay.set(v.dateAdded, [...(byDay.get(v.dateAdded) ?? []), v.vendorProject]);
      const base = round(half / 26, 1);
      return {
        name: "CISA exploited vulnerabilities", label: "Exploited flaws", tile: "cyber", scope: "national", kind: "count",
        num: week.length, base, short: `avg ${Math.round(base)} / wk`,
        note: "Vulnerabilities CISA confirmed as exploited, added in the past 7 days, against the weekly average over six months.",
        items: [...byDay].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 4).map(([d, vendors]) => `${etDay(Date.parse(d + "T12:00:00-05:00"))}: ${[...new Set(vendors)].slice(0, 4).join(", ")}`),
        source: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog",
      };
    },
  },
];
