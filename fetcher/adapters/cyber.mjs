import { json, need, fetchOk, strip, clip, round, etDay } from "../lib/util.mjs";

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// CISA's feeds write dates as "Tue, 17 Nov 26 12:00:00 +0000".
function feedDate(s) {
  const m = String(s).match(/(\d{1,2}) (\w{3}) (\d{2,4}) (\d\d):(\d\d)/);
  if (!m) return NaN;
  const year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
  return Date.UTC(year, MONTHS[m[2]] ?? 0, Number(m[1]), Number(m[4]), Number(m[5]));
}
function feedItems(xml) {
  need(/<rss|<channel/i.test(xml), "not a feed");
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => ({
    title: strip(it.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ""),
    at: feedDate(it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? ""),
  })).filter((i) => i.title && isFinite(i.at));
}
const ROUTINE = /Known Exploited Vulnerabilit|Industrial Control Systems Advisor/i;
const INFRA = /Energy|Utilit|Health|Government|Transport|Financ|Telecom|Water/i;
const days = (ctx, t) => (ctx.now - t) / 86400e3;

export default [
  {
    id: "sans-infocon",
    every: 20,
    async run(ctx) {
      const j = json(await fetchOk(ctx, "https://isc.sans.edu/api/infocon?json"));
      const steps = ["green", "yellow", "orange", "red"], step = steps.indexOf(String(j.status).toLowerCase());
      need(step >= 0, "unknown threat level " + j.status);
      return {
        name: "Internet threat level (SANS Internet Storm Center)", label: "Threat level", tile: "cyber", scope: "national", kind: "level",
        steps: ["Green", "Yellow", "Orange", "Red"], sevs: [0, 30, 60, 90],
        ladder: ["nothing unusual", "a significant new threat is being tracked", "a major disruption is underway or imminent", "connectivity lost across much of the internet"],
        step, short: "set by analysts",
        note: "Set by the volunteer analysts at the SANS Internet Storm Center. It rarely leaves green, so any change is worth a look.",
        source: "https://isc.sans.edu/infocon.html",
        track: { step },
      };
    },
  },
  {
    id: "cisa-alerts",
    every: 30,
    async run(ctx) {
      const alerts = feedItems(await fetchOk(ctx, "https://www.cisa.gov/cybersecurity-advisories/alerts.xml"));
      const recent = alerts.filter((a) => !ROUTINE.test(a.title) && days(ctx, a.at) <= 7);
      let ics = null;
      const res = await ctx.get("https://www.cisa.gov/cybersecurity-advisories/ics-advisories.xml", { timeout: 30000 });
      if (res.ok) ics = feedItems(res.text).filter((a) => days(ctx, a.at) <= 7).length;
      return {
        name: "CISA alerts and emergency directives", label: "CISA alerts", tile: "cyber", scope: "national", kind: "events", rule: "cyberAlert",
        events: recent.map((a) => ({
          event: clip(a.title, 140), at: new Date(a.at).toISOString(), text: etDay(a.at),
          level: /Emergency Directive/i.test(a.title) ? "directive" : /Zero-Day|Exploited|Actively/i.test(a.title) ? "exploited" : "patch",
        })),
        short: recent.length ? "past 7 days" : "none in 7 days",
        note: "Alerts from the federal cyber agency over the past week, leaving out its routine catalog updates." + (ics != null ? ` It also published ${ics} advisories for industrial control systems this week, the equipment that runs grids, water systems and plants.` : ""),
        source: "https://www.cisa.gov/news-events/cybersecurity-advisories",
        track: { alerts: recent.length, ics },
      };
    },
  },
  {
    id: "cisa-kev",
    every: 180,
    async run(ctx) {
      const j = json(await fetchOk(ctx, "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json", { timeout: 40000 }));
      need(Array.isArray(j.vulnerabilities) && j.vulnerabilities.length > 500, "catalog not found");
      const age = (d) => days(ctx, Date.parse(d + "T12:00:00Z"));
      const week = j.vulnerabilities.filter((v) => age(v.dateAdded) <= 7);
      const half = j.vulnerabilities.filter((v) => age(v.dateAdded) <= 182).length;
      const ransom = week.filter((v) => v.knownRansomwareCampaignUse === "Known").length;
      const byDay = new Map();
      for (const v of week) byDay.set(v.dateAdded, [...(byDay.get(v.dateAdded) ?? []), v.vendorProject]);
      const base = round(half / 26, 1);
      return {
        name: "CISA exploited vulnerabilities", label: "Exploited flaws", tile: "cyber", scope: "national", kind: "count",
        num: week.length, base, short: `avg ${Math.round(base)} / wk`,
        note: `Flaws CISA confirmed attackers are using, added in the past 7 days, against the weekly average over six months. ${ransom} of this week's are tied to ransomware.`,
        items: [...byDay].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 4).map(([d, vendors]) => `${etDay(Date.parse(d + "T12:00:00-05:00"))}: ${[...new Set(vendors)].slice(0, 4).join(", ")}`),
        source: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog",
        track: { week: week.length, ransom },
      };
    },
  },
  {
    id: "ransomware-us",
    every: 60,
    async run(ctx) {
      const list = json(await fetchOk(ctx, "https://api.ransomware.live/v2/recentvictims", { timeout: 30000 }));
      need(Array.isArray(list) && list.length > 20, "no victim list");
      const us = list.filter((v) => v.country === "US").map((v) => ({ at: Date.parse(v.discovered ?? v.attackdate), sector: v.activity || "Other" })).filter((v) => isFinite(v.at));
      const today = us.filter((v) => days(ctx, v.at) <= 1);
      // The list holds the latest 100 worldwide, usually two to three days' worth.
      const span = Math.max(1, days(ctx, Math.min(...list.map((v) => Date.parse(v.discovered ?? v.attackdate)).filter(isFinite))));
      const rate = us.length / span;
      // Keep one count per day so the average comes from the monitor's own record once it has two weeks.
      const log = (ctx.cache.daily ??= {});
      log[new Date(ctx.now).toISOString().slice(0, 10)] = today.length;
      for (const k of Object.keys(log).sort().slice(0, -90)) delete log[k];
      const past = Object.values(log);
      const base = round(past.length >= 14 ? past.reduce((a, b) => a + b, 0) / past.length : rate, 1);
      const sectors = new Map();
      for (const v of today) sectors.set(v.sector, (sectors.get(v.sector) ?? 0) + 1);
      const infra = today.filter((v) => INFRA.test(v.sector)).length;
      return {
        name: "Ransomware victims posted, United States", label: "Ransomware", tile: "cyber", scope: "national", kind: "count",
        num: today.length, base, tol: 2, short: `avg ${Math.round(base)} / day`,
        note: `US organizations named on ransomware groups' leak sites in the past 24 hours, as tracked by ransomware.live. ${infra} are in health care, government, energy, finance or transport. These are the criminals' own claims and aren't verified. Postings come in bursts, so this only scores once a day runs at double the usual pace.`,
        items: [...sectors].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, n]) => `${s}: ${n}`),
        source: "https://www.ransomware.live/",
        track: { day: today.length, infra, base },
      };
    },
  },
  {
    id: "nvd-critical",
    every: 180,
    async run(ctx) {
      const stamp = (back) => new Date(ctx.now - back * 86400e3).toISOString().slice(0, 19) + ".000";
      const api = (from, to) => `https://services.nvd.nist.gov/rest/json/cves/2.0?cvssV3Severity=CRITICAL&pubStartDate=${stamp(from)}&pubEndDate=${stamp(to)}&resultsPerPage=1`;
      const week = json(await fetchOk(ctx, api(7, 0), { timeout: 30000 }));
      need(typeof week.totalResults === "number", "no count from the vulnerability database");
      const prior = await ctx.memo("prior", 1440, async () => {
        await new Promise((r) => setTimeout(r, 7000)); // the database asks for a pause between requests
        return json(await fetchOk(ctx, api(97, 7), { timeout: 30000 })).totalResults;
      });
      const base = round((prior / 90) * 7, 1);
      return {
        name: "Critical vulnerabilities published (NIST)", label: "Critical flaws", tile: "cyber", scope: "national", kind: "count",
        num: week.totalResults, base, short: `avg ${Math.round(base)} / wk`,
        note: "New vulnerabilities rated critical in the national database over the past 7 days, against the weekly average for the prior 90 days. A surge means more to patch everywhere at once.",
        source: "https://nvd.nist.gov/vuln/search",
        track: { week: week.totalResults },
      };
    },
  },
];
